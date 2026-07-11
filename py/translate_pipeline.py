"""
Lexora layout-preserving translation pipeline (v2).

Implements the user's finalized 12-step flow, one page at a time:

  1.  Render each PDF page to a 300-DPI image (named by page number).
  2.  Build a blank DOCX: margins/header/footer = 0, one page per input
      page, each page sized to the input page's width/height.
  3.  Place the page's "Main" background image full-size on the page.
  4.  Detect LOGO / SIGNATURE / ILLUSTRATION first and reserve their boxes.
  5.  Detect TEXT line-by-line; drop any text inside a reserved element.
  6.  De-overlap: guarantee no two text boxes overlap.
  7.  Erase text + elements from Main to get a clean background.
  8.  Fill the background: CV inpaint for simple areas, OpenAI for ornate.
  9.  Put logo/signature back as transparent PNGs (Layer 2).
  10. Draw translated text boxes (LTR/RTL, justify, shrink-to-fit, colour,
      style, rotation, per-run colour). If it can't fit at the readable
      minimum, restore that box's ORIGINAL crop instead of printing tiny.
  11. Emit an English activity-log line for every step, per page.
  12. Next page … then convert to PDF if requested, and return the path.

The heavy CV / vision helpers live in lease_engine; this module only
orchestrates them into the above order and owns the DOCX assembly.
"""

import io
import os
import json
import math
import zipfile

import numpy as np
from PIL import Image as PILImage, ImageDraw

import lease_engine as le


EMU_PER_PT = 12700
MIN_READABLE_PT = 7.0            # below this we do NOT print translated text


# ─────────────────────────────────────────────────────────────────────
# Geometry helpers
# ─────────────────────────────────────────────────────────────────────
def _box_overlap(a, b):
    ix = min(a["right"], b["right"]) - max(a["left"], b["left"])
    iy = min(a["bottom"], b["bottom"]) - max(a["top"], b["top"])
    if ix <= 0 or iy <= 0:
        return 0.0
    inter = ix * iy
    area_a = max(1, (a["right"] - a["left"]) * (a["bottom"] - a["top"]))
    area_b = max(1, (b["right"] - b["left"]) * (b["bottom"] - b["top"]))
    return inter / float(min(area_a, area_b))


def _inside(inner, outer, tol=4):
    cx = (inner["left"] + inner["right"]) / 2.0
    cy = (inner["top"] + inner["bottom"]) / 2.0
    return (outer["left"] - tol <= cx <= outer["right"] + tol and
            outer["top"] - tol <= cy <= outer["bottom"] + tol)


def _ink_density(text_mask, box):
    sub = text_mask[max(0, box["top"]):box["bottom"], max(0, box["left"]):box["right"]]
    if sub.size == 0:
        return 0.0
    return float(np.count_nonzero(sub)) / sub.size


# ─────────────────────────────────────────────────────────────────────
# STEP 4/5 — element (logo/signature/illustration) detection
# ─────────────────────────────────────────────────────────────────────
def detect_elements(page_image, regions, meta):
    """From the vision metadata, collect the non-translatable elements
    (logo / signature / stamp / QR / illustration). Two safety layers
    protect against the vision model wrongly tagging a TEXT block as an
    element (which would leave that text un-translated in the background):

      • CV `is_graphic` blobs are always trusted (real coloured pictures).
      • A vision "nontranslatable" block is only accepted as an element
        when it actually looks like a compact mark / picture - NOT a big
        text-shaped block. A wide, non-graphic block the model calls
        "signature"/"logo" is treated as text instead.

    Overlapping element boxes are then merged so one illustration becomes
    ONE png (fixes the plant being split into several elements)."""
    W, H = page_image.size
    page_area = float(W * H)
    elements = []
    for region, m in zip(regions, meta):
        if region.get("is_graphic"):
            elements.append(dict(region, kind="illustration"))
            continue
        if not m:
            continue
        if str(m.get("class", "")).lower() != "nontranslatable":
            continue
        kind = str(m.get("kind", "element")).lower()
        w = region["right"] - region["left"]
        h = region["bottom"] - region["top"]
        area_frac = (w * h) / page_area
        aspect = w / max(1.0, h)
        # A genuine logo/seal/signature/qr is compact; an illustration was
        # already caught by is_graphic. If the model tags a LARGE, wide,
        # text-shaped block as nontranslatable, distrust it and let it be
        # treated as text (so its words get translated, not baked in).
        looks_like_mark = (area_frac < 0.06 and aspect < 6.0) or kind in (
            "qr", "barcode", "stamp", "seal")
        if looks_like_mark:
            elements.append(dict(region, kind=kind))
        # else: drop from elements -> it stays a text candidate.
    return _merge_overlapping_elements(elements)


def _merge_overlapping_elements(elements):
    """Merge element boxes that overlap or are near-duplicates so a single
    picture/logo is represented by ONE box (union), not several."""
    if not elements:
        return []
    boxes = [dict(e) for e in elements]
    changed = True
    while changed:
        changed = False
        out = []
        while boxes:
            a = boxes.pop()
            merged = True
            while merged:
                merged = False
                rest = []
                for b in boxes:
                    if _box_overlap(a, b) > 0.15 or _boxes_touch(a, b):
                        a = {"left": min(a["left"], b["left"]),
                             "top": min(a["top"], b["top"]),
                             "right": max(a["right"], b["right"]),
                             "bottom": max(a["bottom"], b["bottom"]),
                             "kind": a.get("kind", b.get("kind", "element"))}
                        merged = True
                        changed = True
                    else:
                        rest.append(b)
                boxes = rest
            out.append(a)
        boxes = out
    return boxes


def _boxes_touch(a, b, gap=6):
    """True if two boxes are within `gap` px (adjacent fragments of one
    illustration)."""
    ix = min(a["right"], b["right"]) - max(a["left"], b["left"])
    iy = min(a["bottom"], b["bottom"]) - max(a["top"], b["top"])
    return ix > -gap and iy > -gap


# ─────────────────────────────────────────────────────────────────────
# STEP 6 — de-overlap the text boxes
# ─────────────────────────────────────────────────────────────────────
def deoverlap(text_items, text_mask):
    """Guarantee no two text boxes overlap materially. When two collide,
    keep the one with denser ink (the real text) and drop the other; if
    a small box is largely inside a bigger one, drop the small box."""
    items = sorted(text_items,
                   key=lambda it: (it["right"] - it["left"]) * (it["bottom"] - it["top"]),
                   reverse=True)
    kept = []
    for it in items:
        drop = False
        for k in kept:
            ov = _box_overlap(it, k)
            if ov > 0.35:
                di = _ink_density(text_mask, it)
                dk = _ink_density(text_mask, k)
                if di <= dk:
                    drop = True
                    break
        if not drop:
            kept.append(it)
    kept.sort(key=lambda it: (it["top"], it["left"]))
    return kept


# ─────────────────────────────────────────────────────────────────────
# STEP 8 — background complexity decision
# ─────────────────────────────────────────────────────────────────────
def background_is_complex(page_image, erase_boxes):
    """Objective rule for choosing AI fill vs CV inpaint: measure the
    texture (local colour variance) of the ring just outside each erased
    box. Ornate backgrounds (guilloche, patterns) have high variance and
    benefit from AI fill; flat parchment/paper is fine with CV inpaint."""
    arr = np.array(page_image)
    H, W = arr.shape[:2]
    variances = []
    for b in erase_boxes[:40]:
        pad = 10
        t = max(0, b["top"] - pad); bot = min(H, b["bottom"] + pad)
        l = max(0, b["left"] - pad); r = min(W, b["right"] + pad)
        ring = arr[t:bot, l:r]
        if ring.size:
            variances.append(float(ring.reshape(-1, 3).std()))
    if not variances:
        return False
    return (sum(variances) / len(variances)) > 42.0


# ─────────────────────────────────────────────────────────────────────
# STEP 7+8 — clean background
# ─────────────────────────────────────────────────────────────────────
def build_clean_background(page_image, erase_boxes, protect_boxes,
                           llm_config, log):
    """Erase text ink and reconstruct the background. Prefers AI
    generative fill (OpenRouter image model - the approach the user
    validated) when an OpenRouter key is available and AI fill is not
    disabled; otherwise fast CV inpainting."""
    if not erase_boxes:
        return page_image
    ai_disabled = os.environ.get("LEXORA_AI_FILL", "1").lower() in ("0", "false", "no", "off")
    cfg = (llm_config or {}).get("openrouter") or {}
    have_key = bool(cfg.get("apiKey") or os.environ.get("OPENROUTER_API_KEY"))
    if have_key and not ai_disabled:
        log("reconstructing background via AI image fill (OpenRouter)")
        filled = le._ai_fill_background(page_image, erase_boxes,
                                        protect_boxes, llm_config)
        if filled is not None:
            return filled
        log("AI fill unavailable -> CV inpaint fallback")
    else:
        log("reconstructing background via CV inpaint")
    return le._inpaint_regions_cv(page_image, erase_boxes, protect_boxes)


# ─────────────────────────────────────────────────────────────────────
# XML helpers for DOCX
# ─────────────────────────────────────────────────────────────────────
def _esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def _rotation_xml(rot):
    # OOXML rotation is in 60000ths of a degree, clockwise.
    if not rot:
        return ""
    return f' rot="{int(round(rot % 360 * 60000))}"'


# ─────────────────────────────────────────────────────────────────────
# Per-page processing (Steps 3-10)
# ─────────────────────────────────────────────────────────────────────
def process_page(page_image, page_w_pt, page_h_pt, target_language,
                 llm_config, page_no, total_pages, log, debug=None):
    """Run steps 3-10 for one page and return a page-plan dict:
        {background: PIL, elements: [...], texts: [...], layout_json: [...]}
    all in image pixels. When `debug` is provided, saves the exact prompt,
    the raw model response and the image sent to the model."""
    rtl = le.is_rtl_language(target_language)

    # RAASTA A: no OpenCV box detection. Give the WHOLE page to the vision
    # model; it segments + reads + translates + styles every block itself
    # (this is what works when done by hand in ChatGPT). Coordinates come
    # back in the pixel space of the image the model was shown; we scale
    # them to this page-image's pixels.
    log(f"STEP 4-5: Page {page_no}/{total_pages}: sending whole page to the model to read, segment & translate")
    blocks, iw, ih, dbg = le.extract_page_layout_vision(
        page_image, target_language, llm_config, return_debug=True)
    if debug:
        debug["save_text"](f"page_{page_no}_prompt.txt", dbg.get("prompt", ""))
        debug["save_text"](f"page_{page_no}_model_response.txt", dbg.get("response", ""))
        if dbg.get("image") is not None:
            debug["save_image"](f"page_{page_no}_sent_to_model.png", dbg["image"])
    if not blocks:
        log(f"STEP 4-5: Page {page_no}/{total_pages}: no usable result; retrying once")
        blocks, iw, ih, dbg = le.extract_page_layout_vision(
            page_image, target_language, llm_config, return_debug=True)
        if debug and dbg.get("response"):
            debug["save_text"](f"page_{page_no}_model_response_retry.txt", dbg.get("response", ""))
    if not blocks:
        log(f"STEP 4-5: Page {page_no}/{total_pages}: vision unavailable/declined; keeping original page unchanged")
        return {"background": page_image, "elements": [], "texts": [],
                "regions_detected": 0, "layout_json": [], "skipped_small": 0}
    layout_json = blocks

    # Scale factor from the model's coordinate space to page-image pixels.
    sx = page_image.width / float(iw or page_image.width)
    sy = page_image.height / float(ih or page_image.height)
    W, H = page_image.width, page_image.height

    def _scaled_box(d):
        l = max(0, min(W, int(round(float(d.get("left", 0)) * sx))))
        t = max(0, min(H, int(round(float(d.get("top", 0)) * sy))))
        r = max(0, min(W, int(round(float(d.get("right", 0)) * sx))))
        b = max(0, min(H, int(round(float(d.get("bottom", 0)) * sy))))
        if r <= l:
            r = min(W, l + 1)
        if b <= t:
            b = min(H, t + 1)
        return {"left": l, "top": t, "right": r, "bottom": b}

    log(f"Page {page_no}/{total_pages}: {len(blocks)} block(s) returned by vision")

    # Split blocks into elements (logo/signature/illustration) and text.
    elements = []
    raw_text_blocks = []
    for d in blocks:
        if not isinstance(d, dict):
            continue
        cls = str(d.get("class", "text")).lower()
        box = _scaled_box(d)
        if cls == "element":
            elements.append(dict(box, kind=str(d.get("kind", "element"))))
        elif cls == "decoration":
            continue                      # erased into the background, no text
        else:
            raw_text_blocks.append((d, box))
    elements = _merge_overlapping_elements(elements)
    log(f"Page {page_no}/{total_pages}: {len(elements)} element(s) (logo/signature/illustration), "
        f"{len(raw_text_blocks)} text block(s)")

    np_img = np.array(page_image)
    text_items = []
    for d, box in raw_text_blocks:
        # Drop text that falls inside a reserved element (e.g. words baked
        # into a logo/badge).
        if any(_inside(box, el) for el in elements):
            continue
        translation = (d.get("translation") or d.get("text") or "").strip()
        if not translation:
            continue
        # Per-line boxes from the model, scaled; fall back to the block box.
        line_boxes = []
        for lb in (d.get("lines") or []):
            if isinstance(lb, dict):
                line_boxes.append(_scaled_box(lb))
        if not line_boxes:
            line_boxes = [box]
        color = le._normalize_hex_color(
            d.get("color"), default=le._region_stroke_color(np_img, box))
        align = str(d.get("align", "")).lower()
        is_para = len(line_boxes) > 1
        if align not in ("left", "center", "right"):
            align = "center" if not is_para else "natural"
        if align == "right":
            align = "natural"
        runs = d.get("runs")
        clean_runs = None
        if isinstance(runs, list) and len(runs) > 1:
            clean_runs = []
            for rn in runs:
                if isinstance(rn, dict) and str(rn.get("text", "")):
                    clean_runs.append({
                        "text": str(rn["text"]),
                        "color": le._normalize_hex_color(rn.get("color"), default=color),
                        "bold": bool(rn.get("bold", d.get("bold"))),
                        "italic": bool(rn.get("italic", d.get("italic")))})
            if len(clean_runs) < 2:
                clean_runs = None
        try:
            rot = float(d.get("rotation", 0) or 0)
        except (TypeError, ValueError):
            rot = 0.0
        text_items.append({
            "left": box["left"], "top": box["top"],
            "right": box["right"], "bottom": box["bottom"],
            "line_boxes": line_boxes, "text": translation, "runs": clean_runs,
            "color": color, "bold": bool(d.get("bold")),
            "italic": bool(d.get("italic")), "underline": bool(d.get("underline")),
            "align": align, "rtl": rtl,
            "is_paragraph": is_para,
            "rotation": rot, "kind": str(d.get("kind", ""))})

    # STEP 6 — de-overlap. Work on the FINAL rectangles that will be
    # drawn: for each item decide now whether its translation fits (text
    # line-boxes) or not (single fallback crop box), then keep items
    # greedily so no two drawn rectangles overlap.
    scale_pt = page_w_pt / float(page_image.width)
    for it in text_items:
        _s, _mapped, _f, ok = _flow_or_fallback(it, scale_pt, log)
        it["_fits"] = ok
        # The rectangles this item will occupy (in image px):
        if ok:
            it["_draw_boxes"] = it["line_boxes"]
        else:
            it["_draw_boxes"] = [{"left": it["left"], "top": it["top"],
                                  "right": it["right"], "bottom": it["bottom"]}]

    g = np.array(page_image.convert("L"))
    text_mask = (g < 128).astype(np.uint8)
    before = len(text_items)
    # Prefer denser (real text) items when two collide.
    ordered = sorted(text_items,
                     key=lambda t: _ink_density(text_mask, t), reverse=True)
    kept = []
    occupied = []
    for it in ordered:
        collide = any(_box_overlap(db, ob) > 0.2
                      for db in it["_draw_boxes"] for ob in occupied)
        if collide:
            continue
        kept.append(it)
        occupied.extend(it["_draw_boxes"])
    text_items = sorted(kept, key=lambda t: (t["top"], t["left"]))
    if before != len(text_items):
        log(f"Page {page_no}/{total_pages}: removed {before - len(text_items)} overlapping text box(es)")

    # STEP 7 — collect erase boxes (text lines + elements' ink) & protects.
    # The model's boxes tend to run a little tight around the glyphs, so we
    # PAD each erase box outward a few pixels; otherwise the top/bottom of
    # tall calligraphy is left behind in the background under the new text.
    def _pad(box, px, py):
        return {"left": max(0, box["left"] - px), "top": max(0, box["top"] - py),
                "right": min(page_image.width, box["right"] + px),
                "bottom": min(page_image.height, box["bottom"] + py)}
    erase_boxes = []
    for it in text_items:
        for lb in it["line_boxes"]:
            h = lb["bottom"] - lb["top"]
            pad_y = max(3, int(h * 0.18))
            pad_x = max(3, int(h * 0.10))
            erase_boxes.append(_pad(lb, pad_x, pad_y))
    protect_boxes = [{"left": e["left"], "top": e["top"],
                      "right": e["right"], "bottom": e["bottom"]} for e in elements]

    # STEP 8 — clean background.
    background = build_clean_background(page_image, erase_boxes, protect_boxes,
                                        llm_config, lambda msg: log(f"Page {page_no}/{total_pages}: {msg}"))

    # STEP 9 — elements to transparent PNGs.
    element_pngs = []
    for e in elements:
        png = le._crop_element_png(page_image, e)
        if png is not None:
            element_pngs.append({"png": png, "left": e["left"], "top": e["top"],
                                 "right": e["right"], "bottom": e["bottom"],
                                 "kind": e.get("kind", "element")})
    log(f"Page {page_no}/{total_pages}: background reconstructed, {len(element_pngs)} element image(s) restored")

    # STEP 10 — attach the original crop to each text item (used as a
    # fallback if the translation cannot fit at the readable minimum).
    for it in text_items:
        it["_orig_crop"] = page_image.crop((it["left"], it["top"], it["right"], it["bottom"])).convert("RGB")

    log(f"STEP 10: Page {page_no}/{total_pages}: {len(text_items)} text box(es) ready to place")
    return {"background": background, "elements": element_pngs, "texts": text_items,
            "regions_detected": len(blocks), "layout_json": layout_json,
            "skipped_small": 0}


def _unused_detect_marker():
    pass


# ─────────────────────────────────────────────────────────────────────
# STEP 2/3/8/10 — assemble the DOCX
# ─────────────────────────────────────────────────────────────────────
def _flow_or_fallback(item, scale, log_overflow):
    """Flow the translation across the item's line-boxes at a uniform
    size. Returns (size_pt, [(line, box_pt)], font, ok). ok=False when
    the text cannot fit the boxes at the readable minimum -> caller
    restores the original crop instead of printing tiny/overflowing text."""
    from reportlab.pdfbase.pdfmetrics import stringWidth
    raw_boxes = item["line_boxes"]
    boxes_pt = [{"left": b["left"] * scale, "top": b["top"] * scale,
                 "right": b["right"] * scale, "bottom": b["bottom"] * scale}
                for b in raw_boxes]
    font = le._pdf_font_for(item["text"], item["bold"], item["italic"], item["rtl"])
    size, mapped = le._flow_text_across_lineboxes(
        item["text"], boxes_pt, font, item["rtl"], min_size=MIN_READABLE_PT)
    # Verify the result truly fits. IMPORTANT: we measure with reportlab
    # fonts but Word/LibreOffice renders in Arial, which is a little wider,
    # so we require the text to fit within ~93% of the box width. This
    # safety margin prevents the overflow seen in real Word output.
    SAFE = 0.93
    ok = size >= MIN_READABLE_PT - 0.01
    if ok:
        for ln, box in mapped:
            bw = box["right"] - box["left"]
            if stringWidth(ln, font, size) > bw * SAFE:
                ok = False
                break
    return size, mapped, font, ok


def build_docx(docx_path, pages_plan, page_sizes_pt, target_language, log):
    """pages_plan: list per page of {background, elements, texts}.
       page_sizes_pt: list of (w_pt, h_pt) per page."""
    rtl = le.is_rtl_language(target_language)
    media = []                    # (name, bytes)
    doc_rels = []
    body_parts = []
    draw_id = 100

    for pi, (plan, (pw_pt, ph_pt)) in enumerate(zip(pages_plan, page_sizes_pt)):
        bg = plan["background"]
        scale = pw_pt / float(bg.width)          # px -> pt
        pw_emu = int(pw_pt * EMU_PER_PT)
        ph_emu = int(ph_pt * EMU_PER_PT)

        # STEP 3 — full-page background image ("Main").
        bbuf = io.BytesIO(); bg.convert("RGB").save(bbuf, format="PNG")
        media.append((f"Main_{pi+1}.png", bbuf.getvalue()))
        bg_rel = f"rIdMain{pi+1}"
        doc_rels.append(f'<Relationship Id="{bg_rel}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/Main_{pi+1}.png"/>')

        anchors = []
        draw_id += 1
        anchors.append(
            f'<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" '
            f'simplePos="0" relativeHeight="1" behindDoc="1" locked="0" '
            f'layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/>'
            f'<wp:positionH relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionH>'
            f'<wp:positionV relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionV>'
            f'<wp:extent cx="{pw_emu}" cy="{ph_emu}"/><wp:wrapNone/>'
            f'<wp:docPr id="{draw_id}" name="Main_{pi+1}"/>'
            f'<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
            f'<pic:pic><pic:nvPicPr><pic:cNvPr id="{draw_id}" name="Main_{pi+1}"/><pic:cNvPicPr/></pic:nvPicPr>'
            f'<pic:blipFill><a:blip r:embed="{bg_rel}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
            f'<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{pw_emu}" cy="{ph_emu}"/></a:xfrm>'
            f'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>'
            f'</a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>')

        # STEP 9 — element PNGs (Layer 2, in front of background).
        for el in plan["elements"]:
            draw_id += 1
            pbuf = io.BytesIO(); el["png"].save(pbuf, format="PNG")
            nm = f"elem{pi+1}_{draw_id}.png"
            media.append((nm, pbuf.getvalue()))
            er = f"rIdE{pi+1}_{draw_id}"
            doc_rels.append(f'<Relationship Id="{er}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/{nm}"/>')
            ex = int(el["left"] * scale * EMU_PER_PT)
            ey = int(el["top"] * scale * EMU_PER_PT)
            ecx = int(max(1.0, (el["right"] - el["left"]) * scale) * EMU_PER_PT)
            ecy = int(max(1.0, (el["bottom"] - el["top"]) * scale) * EMU_PER_PT)
            anchors.append(
                f'<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" '
                f'simplePos="0" relativeHeight="{draw_id}" behindDoc="0" locked="0" '
                f'layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/>'
                f'<wp:positionH relativeFrom="page"><wp:posOffset>{ex}</wp:posOffset></wp:positionH>'
                f'<wp:positionV relativeFrom="page"><wp:posOffset>{ey}</wp:posOffset></wp:positionV>'
                f'<wp:extent cx="{ecx}" cy="{ecy}"/><wp:wrapNone/>'
                f'<wp:docPr id="{draw_id}" name="{_esc(el.get("kind","element"))}{draw_id}"/>'
                f'<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
                f'<pic:pic><pic:nvPicPr><pic:cNvPr id="{draw_id}" name="{nm}"/><pic:cNvPicPr/></pic:nvPicPr>'
                f'<pic:blipFill><a:blip r:embed="{er}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
                f'<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{ecx}" cy="{ecy}"/></a:xfrm>'
                f'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>'
                f'</a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>')

        # STEP 10 — translated text boxes (Layer 3), or original-crop fallback.
        skipped = 0
        for it in plan["texts"]:
            size, mapped, font, ok = _flow_or_fallback(it, scale, log)
            if not ok:
                # Can't fit at readable minimum -> restore the ORIGINAL crop
                # image for this box (never print unreadable tiny text).
                skipped += 1
                draw_id += 1
                cbuf = io.BytesIO(); it["_orig_crop"].save(cbuf, format="PNG")
                nm = f"orig{pi+1}_{draw_id}.png"
                media.append((nm, cbuf.getvalue()))
                cr = f"rIdO{pi+1}_{draw_id}"
                doc_rels.append(f'<Relationship Id="{cr}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/{nm}"/>')
                ex = int(it["left"] * scale * EMU_PER_PT); ey = int(it["top"] * scale * EMU_PER_PT)
                ecx = int(max(1.0, (it["right"] - it["left"]) * scale) * EMU_PER_PT)
                ecy = int(max(1.0, (it["bottom"] - it["top"]) * scale) * EMU_PER_PT)
                anchors.append(
                    f'<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" '
                    f'relativeHeight="{draw_id}" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">'
                    f'<wp:simplePos x="0" y="0"/>'
                    f'<wp:positionH relativeFrom="page"><wp:posOffset>{ex}</wp:posOffset></wp:positionH>'
                    f'<wp:positionV relativeFrom="page"><wp:posOffset>{ey}</wp:posOffset></wp:positionV>'
                    f'<wp:extent cx="{ecx}" cy="{ecy}"/><wp:wrapNone/>'
                    f'<wp:docPr id="{draw_id}" name="orig{draw_id}"/>'
                    f'<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
                    f'<pic:pic><pic:nvPicPr><pic:cNvPr id="{draw_id}" name="{nm}"/><pic:cNvPicPr/></pic:nvPicPr>'
                    f'<pic:blipFill><a:blip r:embed="{cr}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
                    f'<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{ecx}" cy="{ecy}"/></a:xfrm>'
                    f'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>'
                    f'</a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>')
                continue

            # Normal path: one transparent text box PER produced line.
            for ln, box in mapped:
                if not ln.strip():
                    continue
                draw_id += 1
                bx = int(box["left"] * EMU_PER_PT); by = int(box["top"] * EMU_PER_PT)
                bcx = int(max(1.0, box["right"] - box["left"]) * EMU_PER_PT)
                bcy = int(max(1.0, box["bottom"] - box["top"]) * EMU_PER_PT)
                half = max(2, int(round(size * 2)))
                jc = ("center" if it["align"] == "center"
                      else ("both" if it.get("is_paragraph") else ("right" if it["rtl"] else "left")))
                runs_xml = _runs_xml(it, ln, half)
                ppr = ('<w:pPr>' + ('<w:bidi/>' if it["rtl"] else '') +
                       '<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>'
                       f'<w:jc w:val="{jc}"/></w:pPr>')
                txbx = (f'<w:txbxContent><w:p>{ppr}{runs_xml}</w:p></w:txbxContent>')
                anchors.append(
                    f'<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" '
                    f'relativeHeight="{draw_id}" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">'
                    f'<wp:simplePos x="0" y="0"/>'
                    f'<wp:positionH relativeFrom="page"><wp:posOffset>{bx}</wp:posOffset></wp:positionH>'
                    f'<wp:positionV relativeFrom="page"><wp:posOffset>{by}</wp:posOffset></wp:positionV>'
                    f'<wp:extent cx="{bcx}" cy="{bcy}"/><wp:wrapNone/>'
                    f'<wp:docPr id="{draw_id}" name="t{draw_id}"/>'
                    f'<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">'
                    f'<wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr{_rotation_xml(it.get("rotation",0))}>'
                    f'<a:xfrm><a:off x="0" y="0"/><a:ext cx="{bcx}" cy="{bcy}"/></a:xfrm>'
                    f'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></wps:spPr>'
                    f'<wps:txbx>{txbx}</wps:txbx>'
                    f'<wps:bodyPr rot="0" wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr"/>'
                    f'</wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>')
        if skipped:
            log(f"Page {pi+1}: {skipped} box(es) too small for readable text -> kept original crop")

        # Assemble the page paragraph (+ page break between pages).
        sect = _sect_xml(pw_pt, ph_pt)
        para = f'<w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr>{"".join(anchors)}</w:p>'
        if pi < len(pages_plan) - 1:
            body_parts.append(para)
            body_parts.append(f'<w:p><w:pPr>{sect}</w:pPr></w:p>')
        else:
            body_parts.append(para)
            body_parts.append(sect_final := sect)   # final sectPr goes in body

    _write_docx_zip(docx_path, body_parts, media, doc_rels, page_sizes_pt)


def _runs_xml(item, line_text, half_pt):
    """Build the run(s) for one line. If the item has per-run colours and
    they all appear in this line, split accordingly; otherwise one run."""
    def run(text, color, bold, italic, underline):
        rpr = ('<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>'
               + ('<w:b/><w:bCs/>' if bold else '')
               + ('<w:i/><w:iCs/>' if italic else '')
               + ('<w:u w:val="single"/>' if underline else '')
               + ('<w:rtl/>' if item["rtl"] else '')
               + f'<w:color w:val="{"%02X%02X%02X" % color}"/>'
               + f'<w:sz w:val="{half_pt}"/><w:szCs w:val="{half_pt}"/></w:rPr>')
        return f'<w:r>{rpr}<w:t xml:space="preserve">{_esc(text)}</w:t></w:r>'

    runs = item.get("runs")
    if runs:
        # Greedy: walk the line, emitting each run's slice that appears here.
        out = []
        remaining = line_text
        for rn in runs:
            piece = rn["text"]
            idx = remaining.find(piece)
            if idx == -1:
                continue
            if idx > 0:
                out.append(run(remaining[:idx], item["color"], item["bold"],
                               item["italic"], item["underline"]))
            out.append(run(piece, rn["color"], rn["bold"], rn["italic"], item["underline"]))
            remaining = remaining[idx + len(piece):]
        if remaining:
            out.append(run(remaining, item["color"], item["bold"],
                           item["italic"], item["underline"]))
        if out:
            return "".join(out)
    return run(line_text, item["color"], item["bold"], item["italic"], item["underline"])


def _sect_xml(pw_pt, ph_pt):
    w = int(pw_pt * 20); h = int(ph_pt * 20)      # twips
    return (f'<w:sectPr><w:pgSz w:w="{w}" w:h="{h}"/>'
            f'<w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" '
            f'w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>')


def _write_docx_zip(docx_path, body_parts, media, doc_rels, page_sizes_pt):
    ns = ('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
          'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
          'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
          'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
          'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" '
          'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"')
    document = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                f'<w:document {ns}><w:body>{"".join(body_parts)}</w:body></w:document>')
    content_types = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                     '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                     '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                     '<Default Extension="xml" ContentType="application/xml"/>'
                     '<Default Extension="png" ContentType="image/png"/>'
                     '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
                     '</Types>')
    root_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                 '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                 '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
                 '</Relationships>')
    doc_rels_xml = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                    + "".join(doc_rels) + '</Relationships>')
    with zipfile.ZipFile(docx_path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", root_rels)
        z.writestr("word/document.xml", document)
        z.writestr("word/_rels/document.xml.rels", doc_rels_xml)
        for name, data in media:
            z.writestr(f"word/media/{name}", data)


# ─────────────────────────────────────────────────────────────────────
# STEP 1-12 — top-level entry
# ─────────────────────────────────────────────────────────────────────
def translate_document(input_pdf_path, output_path, target_language,
                       output_format="docx", llm_config=None,
                       diagnostics=None, progress=None, render_dpi=300):
    """Run the full 12-step flow for one file and write the deliverable.

    output_format: "docx" (default) or "pdf".
    Returns the path to the file actually written.

    Saves every intermediate artifact (page images, the exact prompt sent
    to the model, the raw model response, the parsed JSON layout, and the
    reconstructed clean background) into a 'debug' folder next to the
    output, and records their paths in diagnostics['artifacts'] so the
    activity log can link to them."""
    import pdfplumber
    llm_config = llm_config if llm_config is not None else le.load_llm_config()
    diagnostics = diagnostics if diagnostics is not None else {}
    diagnostics.setdefault("pages", [])
    diagnostics.setdefault("artifacts", [])
    logs = []

    def log(msg):
        logs.append(msg)
        if progress:
            progress(msg)
        print(f"[translate] {msg}")

    # Debug folder next to the output file.
    out_dir = os.path.dirname(os.path.abspath(output_path)) or "."
    debug_dir = os.path.join(out_dir, "debug")
    try:
        os.makedirs(debug_dir, exist_ok=True)
    except Exception:
        debug_dir = None

    def artifact(name, kind):
        """Record a saved debug file as a link for the activity log."""
        if debug_dir:
            diagnostics["artifacts"].append({
                "name": name, "kind": kind,
                "path": os.path.join(debug_dir, name)})

    def save_text(name, content):
        if not debug_dir:
            return
        try:
            with open(os.path.join(debug_dir, name), "w", encoding="utf-8") as f:
                f.write(content or "")
            artifact(name, "text")
        except Exception as e:
            log(f"(could not save {name}: {e})")

    def save_image(name, img):
        if not debug_dir:
            return
        try:
            img.convert("RGB").save(os.path.join(debug_dir, name))
            artifact(name, "image")
        except Exception as e:
            log(f"(could not save {name}: {e})")

    # STEP 1 — render every page to an image, and SAVE each one.
    log("STEP 1: Rendering each input page to an image")
    pages_img = []
    page_sizes_pt = []
    with pdfplumber.open(input_pdf_path) as pdf:
        total = len(pdf.pages)
        for i, page in enumerate(pdf.pages):
            log(f"STEP 1: Page {i+1}/{total} rendered at {render_dpi} DPI")
            img = page.to_image(resolution=render_dpi).original.convert("RGB")
            pages_img.append(img)
            page_sizes_pt.append((float(page.width), float(page.height)))
            save_image(f"page_{i+1}_original.png", img)

    # STEP 3-10 — process each page.
    pages_plan = []
    for i, img in enumerate(pages_img):
        pw_pt, ph_pt = page_sizes_pt[i]
        debug = {"page_no": i + 1, "save_text": save_text, "save_image": save_image}
        plan = process_page(img, pw_pt, ph_pt, target_language, llm_config,
                            i + 1, total, log, debug=debug)
        pages_plan.append(plan)
        # Save the clean reconstructed background and the parsed JSON layout.
        if plan.get("background") is not None:
            save_image(f"page_{i+1}_clean_background.png", plan["background"])
        save_text(f"page_{i+1}_layout.json",
                  json.dumps(plan.get("layout_json", []), ensure_ascii=False, indent=2))
        diagnostics["pages"].append({
            "page": i + 1,
            "cvRegionsDetected": plan.get("regions_detected", len(plan["texts"]) + len(plan["elements"])),
            "cvTranslatable": len(plan["texts"]),
            "cvNonTranslatable": len(plan["elements"]),
            "pathUsed": "translate-pipeline-v2-fullpage-vision",
            "elements": len(plan["elements"]),
            "textBoxes": len(plan["texts"]),
            "skippedTooSmall": plan.get("skipped_small", 0),
        })
    diagnostics["pathUsed"] = "translate-pipeline-v2-fullpage-vision"

    # STEP 2 + assemble DOCX.
    log("STEP 2/9: Assembling Word document (zero margins, page sizes matched to input)")
    docx_path = output_path if output_path.lower().endswith(".docx") else \
        os.path.splitext(output_path)[0] + ".docx"
    build_docx(docx_path, pages_plan, page_sizes_pt, target_language, log)
    diagnostics["editableDocx"] = docx_path
    diagnostics["progressLog"] = logs

    # STEP 10/11 — convert to PDF only if requested.
    if output_format == "pdf":
        log("Converting to PDF")
        pdf_out = os.path.splitext(output_path)[0] + ".pdf"
        if _docx_to_pdf(docx_path, pdf_out):
            diagnostics["outputFormat"] = "pdf"
            return pdf_out
        log("PDF conversion unavailable; returning DOCX")
    diagnostics["outputFormat"] = "docx"
    return docx_path


def _docx_to_pdf(docx_path, pdf_path):
    """Convert DOCX to PDF via LibreOffice if present."""
    import subprocess, shutil
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice:
        return False
    try:
        outdir = os.path.dirname(os.path.abspath(pdf_path)) or "."
        subprocess.run([soffice, "--headless", "--convert-to", "pdf",
                        "--outdir", outdir, docx_path],
                       check=True, timeout=180,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        produced = os.path.join(outdir, os.path.splitext(os.path.basename(docx_path))[0] + ".pdf")
        if os.path.isfile(produced):
            if os.path.abspath(produced) != os.path.abspath(pdf_path):
                shutil.move(produced, pdf_path)
            return True
    except Exception as err:
        print(f"docx->pdf failed: {err}")
    return False
