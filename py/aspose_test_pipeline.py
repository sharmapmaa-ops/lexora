"""
Lexora - ASPOSE CLOUD TEST PIPELINE (isolated, experimental)
==============================================================

Same isolation guarantee as py/syncfusion_test_pipeline.py - this does
NOT touch translate_pipeline.py, lease_engine.py's real translation
flow, or js/translation-offline.js. Only reachable via its own
admin-only test route.

UNLIKE Syncfusion, Aspose Cloud needs NO self-hosting - Aspose runs the
actual service, we just call it with a Client Id/Secret. Genuinely just
`pip install aspose-words-cloud asposepdfcloud pycryptodome` (all three
now in requirements.txt) and two environment variables.

TWO TEST MODES, both useful for different questions:

  1. run_structure_only_test() - PDF -> DOCX via Aspose.Words Cloud's
     own native conversion, NO translation involved at all. This is the
     fastest way to answer "does Aspose's own table/format detection
     actually look better than ours" - zero LLM cost, zero extra
     moving parts, pure format-fidelity comparison.

  2. run_full_test() - extract text (Aspose.PDF Cloud, or our own
     pdfplumber extractor as a fallback), translate via Lexora's
     existing LLM call, then rebuild via Aspose.Words Cloud. This tests
     the REAL end-to-end scenario (translated content, not source-
     language content) but costs one real LLM call per run.

SETUP NEEDED (env vars - never hardcode these, never paste them in chat)
---------------------------------------------------------------------
  ASPOSE_CLIENT_ID
  ASPOSE_CLIENT_SECRET
Get both from https://dashboard.aspose.cloud -> Applications -> (create
an app) -> Client Id / Client Secret. Free tier: 150 API calls/month.
"""

import os
import io
import re
import time

import lease_engine as le

try:
    from asposewordscloud import WordsApi
    from asposewordscloud.models.requests import ConvertDocumentRequest
    _WORDS_SDK_AVAILABLE = True
except ImportError:
    _WORDS_SDK_AVAILABLE = False

try:
    from asposepdfcloud import PdfApi
    from asposepdfcloud.api_client import ApiClient as _PdfApiClient
    _PDF_SDK_AVAILABLE = True
except ImportError:
    _PDF_SDK_AVAILABLE = False

try:
    import pdfplumber
    import pypdfium2 as pdfium
    _SIGNATURE_EXTRACT_AVAILABLE = True
except ImportError:
    _SIGNATURE_EXTRACT_AVAILABLE = False


ASPOSE_CLIENT_ID = os.environ.get("ASPOSE_CLIENT_ID", "")
ASPOSE_CLIENT_SECRET = os.environ.get("ASPOSE_CLIENT_SECRET", "")


class AsposeNotConfiguredError(Exception):
    """Distinct from a real API failure, so the test UI can show 'you
    still need to set these env vars' instead of a generic error."""
    pass


def is_configured():
    return bool(ASPOSE_CLIENT_ID and ASPOSE_CLIENT_SECRET and _WORDS_SDK_AVAILABLE)


def _require_configured():
    if not _WORDS_SDK_AVAILABLE:
        raise AsposeNotConfiguredError(
            "aspose-words-cloud (and pycryptodome, a dependency it needs) aren't "
            "installed yet - check requirements.txt was actually installed on this deploy."
        )
    if not (ASPOSE_CLIENT_ID and ASPOSE_CLIENT_SECRET):
        raise AsposeNotConfiguredError(
            "Aspose test pipeline isn't configured yet - set ASPOSE_CLIENT_ID and "
            "ASPOSE_CLIENT_SECRET as environment variables (get them from "
            "https://dashboard.aspose.cloud -> Applications), then restart the server."
        )


def _words_api():
    _require_configured()
    return WordsApi(client_id=ASPOSE_CLIENT_ID, client_secret=ASPOSE_CLIENT_SECRET)


def _fix_incomplete_header_bar_shading(doc):
    """Item (HEADER-BAR-BACKGROUND-GAP) - Aspose's PDF->DOCX conversion
    sometimes reconstructs a table's colored 'header bar' row as a
    STANDALONE paragraph sitting directly in the document body (NOT
    inside the table at all - confirmed by walking a real converted
    document's XML and finding the header text's ancestor chain was
    document->body->p->r->t, no enclosing w:tc whatsoever), with
    per-character green shading (w:rPr/w:shd on each run) and a huge
    artificial letter-spacing value (a single trailing space run with
    w:spacing val="5100" - about 3.5 inches) apparently trying to fake a
    full-width colored bar by stretching that one space out.

    DOCX renderers don't extend background shading through that
    artificial letter-spacing gap (confirmed by rendering a real
    affected document both before and after this fix, via LibreOffice)
    - only the actual glyphs get shaded, so the bar visibly stops short
    of the real table that follows it, leaving a white gap.
    Paragraph-level shading (w:pPr/w:shd) was tried first and also
    doesn't reliably close the gap for the same reason (still bounded by
    where the line's actual rendered content - including that huge
    spacing hack - ends, not the paragraph's nominal indent box).

    The fix that actually closes the gap 100%, with zero magic numbers
    or font-metric guessing: convert the standalone paragraph into a
    real single-cell, single-row table, sized and positioned to EXACTLY
    match the width and left-indent of the next real table in the
    document (read dynamically from that table's own tblGrid/tblInd),
    with cell-level shading - which this document's OTHER header rows
    already use and which reliably fills its whole cell regardless of
    font or renderer. Verified against a real 10-page Aspose-converted
    document: 12 such standalone header-bar paragraphs found and fixed,
    every one rendering as a clean full-width bar afterward with no
    regressions to surrounding content or reading order.

    Also handles the case where MORE than just the header row was left
    standalone (confirmed in the same real document: a section's first
    data row, e.g. "Name", was ALSO a standalone paragraph between the
    header and the real w:tbl) - looks a few siblings ahead for the
    first actual table, skipping over plain (non-shaded) paragraphs, and
    bails out without guessing if it hits another shaded paragraph
    first (a different header's own bar) or doesn't find a table nearby.

    Returns the count of paragraphs fixed, for the caller's log."""
    from docx.oxml.ns import qn
    from docx.oxml import OxmlElement
    from docx.text.paragraph import Paragraph

    body = doc.element.body
    children = list(body.iterchildren())
    fixed = 0

    for i, child in enumerate(children):
        if child.tag != qn("w:p"):
            continue
        p = Paragraph(child, doc)
        runs_with_text = [r for r in p.runs if (r.text or "").strip()]
        if not runs_with_text:
            continue

        fills = set()
        ok = True
        for r in runs_with_text:
            rpr = r._element.find(qn("w:rPr"))
            if rpr is None:
                ok = False
                break
            shd = rpr.find(qn("w:shd"))
            if shd is None:
                ok = False
                break
            fill = shd.get(qn("w:fill"))
            if not fill or fill.lower() in ("auto", "ffffff"):
                ok = False
                break
            fills.add(fill)
        if not ok or len(fills) != 1:
            continue
        fill_color = fills.pop()

        # Find the next TABLE among the following siblings to borrow its
        # exact width/indent - skip over plain (non-shaded) paragraphs
        # in between, bail out (skip, never guess) on hitting another
        # shaded paragraph or running past a small lookahead.
        next_table_el = None
        for sib in children[i + 1:i + 6]:
            if sib.tag == qn("w:tbl"):
                next_table_el = sib
                break
            if sib.tag == qn("w:p"):
                sib_runs_with_text = [r for r in Paragraph(sib, doc).runs if (r.text or "").strip()]
                sib_has_shading = False
                for r in sib_runs_with_text:
                    rpr = r._element.find(qn("w:rPr"))
                    if rpr is None:
                        continue
                    shd = rpr.find(qn("w:shd"))
                    if shd is None:
                        continue
                    if (shd.get(qn("w:fill")) or "").lower() not in ("", "auto", "ffffff"):
                        sib_has_shading = True
                        break
                if sib_has_shading:
                    break  # a different header's own bar - don't borrow its table
                continue  # plain paragraph (e.g. a data row Aspose also left standalone) - keep looking
            break  # anything else unexpected - don't guess past it
        if next_table_el is None:
            continue

        tblPr = next_table_el.find(qn("w:tblPr"))
        tblInd_el = tblPr.find(qn("w:tblInd")) if tblPr is not None else None
        indent = tblInd_el.get(qn("w:w")) if tblInd_el is not None else None
        grid = next_table_el.find(qn("w:tblGrid"))
        if grid is None:
            continue
        cols = grid.findall(qn("w:gridCol"))
        if not cols:
            continue
        total_width = sum(int(c.get(qn("w:w"))) for c in cols)
        if not total_width:
            continue

        new_tbl = OxmlElement("w:tbl")
        tblPr_new = OxmlElement("w:tblPr")
        tblW_new = OxmlElement("w:tblW")
        tblW_new.set(qn("w:w"), str(total_width))
        tblW_new.set(qn("w:type"), "dxa")
        tblPr_new.append(tblW_new)
        if indent:
            tblInd_new = OxmlElement("w:tblInd")
            tblInd_new.set(qn("w:w"), indent)
            tblInd_new.set(qn("w:type"), "dxa")
            tblPr_new.append(tblInd_new)
        tblBorders = OxmlElement("w:tblBorders")
        for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
            b = OxmlElement(f"w:{edge}")
            b.set(qn("w:val"), "none")
            tblBorders.append(b)
        tblPr_new.append(tblBorders)
        new_tbl.append(tblPr_new)

        tblGrid_new = OxmlElement("w:tblGrid")
        gridCol = OxmlElement("w:gridCol")
        gridCol.set(qn("w:w"), str(total_width))
        tblGrid_new.append(gridCol)
        new_tbl.append(tblGrid_new)

        tr = OxmlElement("w:tr")
        tc = OxmlElement("w:tc")
        tcPr = OxmlElement("w:tcPr")
        tcW = OxmlElement("w:tcW")
        tcW.set(qn("w:w"), str(total_width))
        tcW.set(qn("w:type"), "dxa")
        tcPr.append(tcW)
        shd_el = OxmlElement("w:shd")
        shd_el.set(qn("w:val"), "clear")
        shd_el.set(qn("w:color"), "auto")
        shd_el.set(qn("w:fill"), fill_color)
        tcPr.append(shd_el)
        tc.append(tcPr)

        body.remove(child)
        pPr_orig = child.find(qn("w:pPr"))
        if pPr_orig is not None:
            ind_orig = pPr_orig.find(qn("w:ind"))
            if ind_orig is not None:
                pPr_orig.remove(ind_orig)
        tc.append(child)
        tr.append(tc)
        new_tbl.append(tr)

        # Insert new_tbl at the header paragraph's OWN original position
        # (right before whichever sibling immediately followed it,
        # tracked from the pre-removal children list) - NOT right before
        # next_table_el, which can be several siblings further down
        # (past other standalone paragraphs like a "Name" row found
        # above) and would silently reorder that in-between content to
        # come BEFORE this header instead of after it - confirmed by
        # testing: inserting before next_table_el moved a real data row
        # to appear above its own section's header bar, a regression
        # caught by re-rendering and comparing against the original.
        insertion_anchor = children[i + 1]
        insertion_anchor.addprevious(new_tbl)
        fixed += 1

    return fixed


def run_structure_only_test(pdf_path, output_path):
    """PDF -> DOCX via Aspose.Words Cloud's own native conversion,
    source-language text (no translation). Answers "does Aspose's own
    table/format detection look better than ours" with zero LLM cost."""
    words_api = _words_api()
    with open(pdf_path, "rb") as f:
        request = ConvertDocumentRequest(document=f, format="docx")
        # Item - confirmed bug (verified by reading the SDK's own
        # deserialize_file() source, not guessed): convert_document()
        # returns the converted file's RAW BYTES directly, not a path
        # to a temp file on disk despite what its docstring's "return:
        # file" phrasing suggests. Treating that return value as if it
        # were a path and calling open(result, "rb") on it was the
        # actual root cause of the "'bytes' object has no attribute
        # 'seek'" error - Python's open() was being handed the docx's
        # raw content instead of a filename.
        result_bytes = words_api.convert_document(request)

    from docx import Document
    from io import BytesIO
    doc = Document(BytesIO(result_bytes))
    headers_fixed = 0
    try:
        headers_fixed = _fix_incomplete_header_bar_shading(doc)
    except Exception:
        pass  # non-fatal - test pipeline still produces its output even if this cosmetic pass fails
    doc.save(output_path)
    return {"output_path": output_path, "mode": "structure_only", "header_bars_fixed": headers_fixed}


def _pdf_api():
    """PdfApi (unlike WordsApi) takes an ApiClient instance, not
    client_id/client_secret kwargs directly - confirmed by inspecting
    asposepdfcloud.apis.pdf_api.PdfApi.__init__'s actual signature
    (self, api_client=None), which is different from WordsApi's. Doesn't
    reuse _require_configured() since that also checks
    _WORDS_SDK_AVAILABLE (a different SDK/package) - callers here have
    already checked _PDF_SDK_AVAILABLE and the credentials themselves."""
    return PdfApi(_PdfApiClient(client_secret=ASPOSE_CLIENT_SECRET, client_id=ASPOSE_CLIENT_ID))


def extract_text_via_aspose(pdf_path):
    """Extracts text via Aspose.PDF Cloud if configured, otherwise falls
    back to Lexora's own pdfplumber-based extractor (le.extract_text) so
    the rest of this pipeline is still testable. The fallback is always
    clearly labeled in the result, never silently substituted.

    Item (ASPOSE.PDF-CLOUD-WIRING) - two things were actually broken here,
    confirmed by inspecting the installed asposepdfcloud SDK's real code
    (currently pinned >=25.0 in requirements.txt, which pip resolves to
    26.7.0 - a newer SDK generation than whatever version this file's
    original `from asposepdfcloud.models.requests import
    GetPdfInStorageToTextRequest` import was written against):

    1. That import itself FAILS on the installed SDK - there is no
       `asposepdfcloud.models.requests` module at all in 26.7.0 (the
       newer SDK generation takes plain kwargs instead of request
       objects). That ImportError was being silently caught by the
       try/except at the top of this file, setting _PDF_SDK_AVAILABLE =
       False - which is the actual reason "Aspose.PDF Cloud not
       configured" kept showing even with both env vars correctly set;
       the SDK "not being available" had nothing to do with the
       credentials.
    2. Real text extraction was never wired up at all - Aspose.PDF
       Cloud's text-extraction endpoint (get_pdf_in_storage_to_text)
       only operates on files already sitting in Aspose's own cloud
       storage, so it needs an upload_file() call first. That upload
       step is added below.

    Storage note: get_pdf_in_storage_to_text's response is a real file
    Aspose's SDK saves to a local temp path and returns the PATH to
    (confirmed by reading ApiClient.__deserialize_file's source) - this
    is DIFFERENT from asposewordscloud's convert_document(), which hands
    back raw bytes directly despite an identically-worded "return: file"
    docstring. Don't assume the two SDKs behave the same just because
    their docstrings read the same."""
    if not (_PDF_SDK_AVAILABLE and ASPOSE_CLIENT_ID and ASPOSE_CLIENT_SECRET):
        return {"text": le.extract_text(pdf_path), "source": "fallback:pdfplumber (Aspose.PDF Cloud not configured)"}

    pdf_api = _pdf_api()
    folder = "lexora-aspose-test"
    filename = os.path.basename(pdf_path)
    storage_path = f"{folder}/{filename}"
    result_path = None
    try:
        with open(pdf_path, "rb") as f:
            pdf_api.upload_file(storage_path, f)

        result_path = pdf_api.get_pdf_in_storage_to_text(filename, folder=folder)
        with open(result_path, "rb") as rf:
            text = rf.read().decode("utf-8", errors="replace")

        return {"text": text, "source": "aspose_pdf_cloud"}
    except Exception as err:  # noqa: BLE001
        return {
            "text": le.extract_text(pdf_path),
            "source": f"fallback:pdfplumber (Aspose.PDF Cloud call failed: {err})",
        }
    finally:
        if result_path:
            try:
                os.remove(result_path)
            except OSError:
                pass  # local temp file cleanup - non-fatal if it's already gone
        try:
            pdf_api.delete_file(storage_path)
        except Exception:
            pass  # cleanup best-effort - don't fail extraction over a leftover file in Aspose's cloud storage


_SIGNATURE_PLACEHOLDER_RE = re.compile(r"^_{3,}$")


def _extract_signature_images(pdf_path):
    """Item 2 (SIGNATURE-PRESERVATION) - Aspose's own PDF->DOCX conversion
    doesn't carry over digital-signature/annotation appearance content,
    it only leaves the blank underline that was drawn next to the
    signature widget in the original PDF - confirmed by testing against
    a real signed PDF (Agreement_-_Original.pdf), where a plain page
    render (no forms/annotations) produced just the underline, while
    rendering with pdfium's form environment initialized produced the
    actual "Firmato digitalmente da: ..." signature stamp.

    This mirrors js/translation-offline.js's extractOfflineImages ->
    signatureRects detection (Widget/Sig annotations, skip ones with no
    appearance content i.e. hasAppearance === False / no 'AP' entry) but
    in Python: pdfplumber gives the annotation rects, pypdfium2 (with
    init_forms() + draw_annots=True + may_draw_forms=True - all THREE
    are required, confirmed by testing; render() without them silently
    renders only the blank underline, no error) does the actual pixel
    rendering the crop is taken from.

    Returns a list of (page_index, top_pt, png_bytes) tuples, sorted in
    reading order (page, then top-to-bottom), so callers can match them
    to placeholder text in that same order."""
    if not _SIGNATURE_EXTRACT_AVAILABLE:
        return []
    from PIL import Image  # noqa: F401 (import kept local; pdfium.to_pil() needs Pillow installed, this just fails loudly and early if it's missing)

    found = []
    pdf_doc = pdfium.PdfDocument(pdf_path)
    pdf_doc.init_forms()
    with pdfplumber.open(pdf_path) as pl_pdf:
        for page_idx, pl_page in enumerate(pl_pdf.pages):
            widget_rects = []
            for a in (pl_page.annots or []):
                data = a.get("data") or {}
                # pdfminer resolves these to PSLiteral objects whose
                # repr is "/'Widget'" (confirmed by testing against the
                # real annotation dict) - strip both '/' and "'" to get
                # the plain name.
                subtype = str(data.get("Subtype", "")).strip("/'")
                ft = str(data.get("FT", "")).strip("/'")
                if subtype != "Widget" and ft != "Sig":
                    continue
                if "AP" not in data:
                    continue  # no appearance stream - blank/unsigned field, nothing to crop
                x0, x1 = a["x0"], a["x1"]
                top, bottom = a["top"], a["bottom"]
                if (x1 - x0) < 10 or (bottom - top) < 10:
                    continue
                widget_rects.append((min(x0, x1), min(top, bottom), max(x0, x1), max(top, bottom)))
            if not widget_rects:
                continue

            fpage = pdf_doc[page_idx]
            scale = min(3.0, 2000 / max(pl_page.width, pl_page.height))
            bitmap = fpage.render(scale=scale, draw_annots=True, may_draw_forms=True)
            pil_img = bitmap.to_pil()

            for (x0, top, x1, bottom) in sorted(widget_rects, key=lambda r: (r[1], r[0])):
                px0, py0 = int(x0 * scale), int(top * scale)
                px1, py1 = int(x1 * scale), int(bottom * scale)
                crop = pil_img.crop((px0, py0, px1, py1))
                buf = io.BytesIO()
                crop.save(buf, format="PNG")
                found.append((page_idx, top, buf.getvalue()))
    return found


def _inject_signature_images(doc, signature_images):
    """Best-effort in-place placement: Aspose's converted docx leaves a
    paragraph containing just a run of underscores wherever the source
    PDF had a signature widget. Walk the document's paragraphs in order
    and swap each such placeholder for the matching extracted signature
    image, consuming signature_images in the same page/top-to-bottom
    order _extract_signature_images returned them in - this is a
    positional match (Nth placeholder <-> Nth signature found), not a
    coordinate-verified one, since Aspose's converted docx doesn't carry
    forward the original PDF coordinates to check against.

    Any signatures left over (more detected than placeholder paragraphs
    found - e.g. a placeholder Aspose rendered as something other than
    plain underscores) are appended as a clearly-labeled section at the
    end rather than silently dropped, same "don't lose real content"
    principle as the reference-page fallback below.

    Returns (placed_count, leftover_count) for the caller's log."""
    from docx.shared import Pt
    from io import BytesIO

    remaining = list(signature_images)
    placed = 0
    for para in doc.paragraphs:
        if not remaining:
            break
        if _SIGNATURE_PLACEHOLDER_RE.match((para.text or "").strip()):
            for run in list(para.runs):
                run.text = ""
            _page_idx, _top, img_bytes = remaining.pop(0)
            para.add_run().add_picture(BytesIO(img_bytes), height=Pt(50))
            placed += 1

    if remaining:
        doc.add_page_break()
        note = doc.add_paragraph()
        note_run = note.add_run(
            f"Signature image(s) detected in source PDF but not matched to a "
            f"placeholder line in Aspose's converted structure ({len(remaining)}):"
        )
        note_run.bold = True
        for _page_idx, _top, img_bytes in remaining:
            doc.add_paragraph().add_run().add_picture(BytesIO(img_bytes), height=Pt(50))

    return placed, len(remaining)


def _iter_paragraphs_in_order(container):
    """Yields every Paragraph inside `container` (a Document or a table
    _Cell) in true document order, descending into tables (and any
    tables nested inside table cells) recursively.

    python-docx's own doc.paragraphs and doc.tables are two SEPARATE flat
    lists - doc.paragraphs skips everything inside a table cell entirely,
    and neither list reflects where a table actually sits relative to
    surrounding paragraphs. That matters a lot here: Aspose's PDF->DOCX
    conversion of a table-heavy contract (e.g. the REGA-format Arabic
    lease contracts Lexora also handles, which are almost entirely
    bordered field/value tables) puts nearly all of its real content
    inside table cells, so a translation pass that only walked
    doc.paragraphs would silently skip almost the whole document.

    Standard recipe for this (walking the underlying XML body's direct
    children, matching each one back to a CT_P paragraph or CT_Tbl
    table) - verified against a real python-docx-built table (a plain
    doc.paragraphs/doc.tables walk would have returned the table's cell
    text in a completely different, disconnected list; this returns
    everything in one correctly-ordered stream)."""
    from docx.oxml.table import CT_Tbl
    from docx.oxml.text.paragraph import CT_P
    from docx.table import Table, _Cell
    from docx.text.paragraph import Paragraph
    from docx.document import Document as _DocxDocument

    if isinstance(container, _DocxDocument):
        parent_elm = container.element.body
    elif isinstance(container, _Cell):
        parent_elm = container._tc
    else:
        raise TypeError(f"unsupported container type: {type(container)}")

    for child in parent_elm.iterchildren():
        if isinstance(child, CT_P):
            yield Paragraph(child, container)
        elif isinstance(child, CT_Tbl):
            table = Table(child, container)
            for row in table.rows:
                for cell in row.cells:
                    yield from _iter_paragraphs_in_order(cell)


def _replace_paragraph_text(paragraph, new_text):
    """Puts `new_text` into a paragraph's FIRST run (keeping that run's
    own formatting - bold/italic/font/size/color - so a paragraph that
    was entirely bold, or in a particular font, stays that way) and
    blanks out any other runs in the paragraph rather than removing them
    (simpler and safer than XML surgery to delete run elements, and an
    empty run is harmless/invisible in the saved docx).

    Known, explicitly-accepted trade-off: if the ORIGINAL paragraph had
    MIXED formatting across multiple runs (e.g. "The rent is **500
    EUR**" where only "500 EUR" was bold within one paragraph), that
    finer-grained split is lost - the whole translated paragraph ends up
    under the first run's formatting only. Preserving per-run formatting
    across a translation (where word order and phrase boundaries change
    completely between languages) is a much harder alignment problem;
    paragraph-level formatting fidelity was judged the right scope for
    this pass."""
    runs = paragraph.runs
    if not runs:
        paragraph.add_run(new_text)
        return
    runs[0].text = new_text
    for extra in runs[1:]:
        extra.text = ""


_MAX_SEGMENT_CHARS_PER_BATCH = 3500  # conservative - translated output commonly runs longer than the source, plus JSON-wrapping overhead


def _translate_docx_segments_in_place(doc, target_language, llm_config):
    """Item (IN-PLACE-MERGE) - replaces the old approach of translating
    the PDF's extracted text as one big blob and appending it as a
    separate reference page (see the removed docstring note that used to
    be on rebuild_docx_with_translated_text - Aspose's Words Cloud API
    has no "swap all body text for this translated version, keep
    structure" call, so a real per-paragraph mapping had to be built by
    hand).

    Works directly on the ALREADY-Aspose-converted docx's own paragraphs
    (via _iter_paragraphs_in_order above, so table cells are included) -
    this sidesteps the harder problem of mapping PDF-extracted text back
    onto Aspose's converted structure entirely, since we're translating
    and replacing the very same paragraph objects Aspose already built,
    not reconciling two independently-extracted versions of the text.

    Batches segments into multiple LLM calls (id-keyed JSON in, JSON
    out) rather than one call for the whole document, since a long
    contract's full paragraph list can exceed a single call's practical
    output-token budget; each batch still gets the same Translation
    Rules block (le._fetch_translation_rules_block()) that translate_text()
    uses, so a saved rule applies identically here as it does in the
    single-call path.

    Returns (translated_count, skipped_count, failed_batch_count) for
    the caller's log. A batch whose JSON response fails to parse, or is
    missing some ids, is logged and its paragraphs are simply left in
    the source language rather than aborting the whole run - a partial
    translation is far more useful to a reviewer than no output at all."""
    import json

    segments = []  # list of (id, paragraph, original_text)
    next_id = 1
    for para in _iter_paragraphs_in_order(doc):
        text = (para.text or "").strip()
        if not text or _SIGNATURE_PLACEHOLDER_RE.match(text):
            continue  # empty paragraphs and signature-placeholder underline lines aren't translatable content
        segments.append((next_id, para, text))
        next_id += 1

    if not segments:
        return 0, 0, 0, []

    rules_block = le._fetch_translation_rules_block()
    system_prompt = (
        f"You are a professional document translator. Translate each text segment below into "
        f"{target_language}, preserving meaning, tone, and register. Each segment is a single "
        f"paragraph or table cell from a legal document, already correctly structured - do NOT "
        f"add markdown, bullets, or numbering, just translate the text of each segment as-is.\n\n"
        f"Input is a JSON array of {{\"id\": <int>, \"text\": <string>}} objects. Respond with "
        f"ONLY a JSON array of {{\"id\": <int>, \"text\": <translated string>}} objects, one per "
        f"input segment, same ids, no other text, no markdown code fences."
    ) + rules_block

    translated_by_id = {}
    failed_batches = 0
    providers_used = set()

    batch, batch_chars = [], 0
    batches = []
    for seg in segments:
        seg_len = len(seg[2])
        if batch and batch_chars + seg_len > _MAX_SEGMENT_CHARS_PER_BATCH:
            batches.append(batch)
            batch, batch_chars = [], 0
        batch.append(seg)
        batch_chars += seg_len
    if batch:
        batches.append(batch)

    for batch in batches:
        user_content = json.dumps([{"id": sid, "text": text} for sid, _para, text in batch], ensure_ascii=False)
        try:
            content, provider = le._call_chat_completion_with_failover(
                llm_config, system_prompt, user_content, max_tokens=8000
            )
            if content is None:
                failed_batches += 1
                continue
            providers_used.add(provider)
            cleaned = content.strip()
            if cleaned.startswith("```"):
                cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned.strip())
            parsed = json.loads(cleaned)
            for item in parsed:
                translated_by_id[item["id"]] = item["text"]
        except Exception as err:  # noqa: BLE001
            print(f"[in-place-merge] batch translation failed, leaving {len(batch)} segment(s) untranslated: {err}")
            failed_batches += 1

    translated_count = 0
    skipped_count = 0
    for sid, para, _original_text in segments:
        if sid in translated_by_id:
            _replace_paragraph_text(para, translated_by_id[sid])
            translated_count += 1
        else:
            skipped_count += 1  # left in source language - batch failed or id missing from response

    return translated_count, skipped_count, failed_batches, sorted(providers_used)


def rebuild_docx_with_translated_text(pdf_path, target_language, output_path, llm_config=None):
    """Converts the source PDF to DOCX via Aspose (preserving its native
    structure/table detection), then translates and replaces every
    paragraph's (and table cell's) text IN PLACE via
    _translate_docx_segments_in_place() above - the translated document
    keeps Aspose's own structure/formatting, no separate reference page."""
    words_api = _words_api()
    with open(pdf_path, "rb") as f:
        request = ConvertDocumentRequest(document=f, format="docx")
        # Item - confirmed bug: add_heading(text, level=2) looks up a style
        # named "Heading 2" in the document's style gallery - this document
        # is NOT a fresh python-docx template, it's Aspose's OWN PDF->DOCX
        # conversion output, which apparently doesn't define that built-in
        # style at all, so the lookup failed ("no style with name 'Heading
        # 2'"). A plain paragraph with manual bold+size formatting achieves
        # the same visual result without depending on any assumption about
        # which named styles happen to exist in whatever document Aspose
        # hands back. (This note is kept for context even though the
        # in-place merge below no longer adds a heading of its own - the
        # same "don't assume named styles exist in Aspose's output" lesson
        # still applies anywhere this module touches doc styles.)
        result_bytes = words_api.convert_document(request)

    from docx import Document
    from io import BytesIO
    doc = Document(BytesIO(result_bytes))

    # Item (HEADER-BAR-BACKGROUND-GAP) - see
    # _fix_incomplete_header_bar_shading()'s docstring above. Runs BEFORE
    # translation: it wraps certain standalone paragraphs into a new
    # single-cell table, and _translate_docx_segments_in_place's
    # _iter_paragraphs_in_order() already knows how to walk into ANY
    # table (including this newly-created one) to find and translate
    # that paragraph's text, so running this first doesn't lose or skip
    # anything - it just gives translation a cleaner, table-consistent
    # structure to work from.
    headers_fixed = 0
    try:
        headers_fixed = _fix_incomplete_header_bar_shading(doc)
    except Exception:
        pass  # non-fatal - test pipeline still produces its output even if this cosmetic pass fails

    llm_config = llm_config if llm_config is not None else le.load_llm_config()
    translated_count, skipped_count, failed_batches, providers_used = _translate_docx_segments_in_place(
        doc, target_language, llm_config
    )

    # Item 2 (SIGNATURE-PRESERVATION) - runs after translation, on the
    # same doc object, so it's placing signature images into the
    # now-translated paragraphs (the underscore placeholder text itself
    # was never sent for translation - see the skip in
    # _translate_docx_segments_in_place above - so it's still there for
    # this to match against).
    sig_placed, sig_leftover = 0, 0
    try:
        signature_images = _extract_signature_images(pdf_path)
        if signature_images:
            sig_placed, sig_leftover = _inject_signature_images(doc, signature_images)
    except Exception:
        pass  # non-fatal - test pipeline still produces its output even if signature extraction fails

    doc.save(output_path)
    return {
        "output_path": output_path,
        "mode": "in_place_translation",
        "segments_translated": translated_count,
        "segments_skipped": skipped_count,
        "translation_batches_failed": failed_batches,
        "translation_providers": providers_used,
        "signatures_placed": sig_placed,
        "signatures_leftover": sig_leftover,
        "header_bars_fixed": headers_fixed,
    }


def run_full_test(pdf_path, target_language, output_path):
    log = []
    t0 = time.time()
    log.append(f"Configured: {is_configured()}")

    # Item (ASPOSE.PDF-CLOUD-WIRING) - kept as a standalone check here,
    # NOT used to build the translated output below. The in-place merge
    # (rebuild_docx_with_translated_text) translates Aspose's own
    # converted-docx paragraphs directly, which is a more reliable
    # source of truth than reconciling two independently-extracted
    # versions of the same text would be (see that function's docstring)
    # - so this call's only purpose here is to confirm, in the log, that
    # the Aspose.PDF Cloud wiring itself actually works end to end
    # (upload + convert-to-text + cleanup), independent of the merge.
    extraction = extract_text_via_aspose(pdf_path)
    log.append(
        f"Text extraction check via {extraction['source']} ({len(extraction['text'])} chars) "
        f"- informational only, not used for the translation below"
    )

    t1 = time.time()
    llm_config = le.load_llm_config()
    rebuild_result = rebuild_docx_with_translated_text(pdf_path, target_language, output_path, llm_config=llm_config)
    providers = ", ".join(rebuild_result["translation_providers"]) or "n/a"
    log.append(
        f"Structure converted via Aspose + {rebuild_result['segments_translated']} segment(s) "
        f"translated in-place via {providers} in {time.time()-t1:.1f}s"
    )
    if rebuild_result["segments_skipped"]:
        log.append(
            f"{rebuild_result['segments_skipped']} segment(s) left untranslated "
            f"({rebuild_result['translation_batches_failed']} batch(es) failed)"
        )
    if rebuild_result.get("header_bars_fixed"):
        log.append(f"Header-bar background gaps fixed: {rebuild_result['header_bars_fixed']}")

    sig_placed = rebuild_result.get("signatures_placed", 0)
    sig_leftover = rebuild_result.get("signatures_leftover", 0)
    if sig_placed or sig_leftover:
        log.append(
            f"Signatures: {sig_placed} placed in-line at placeholder line(s)"
            + (f", {sig_leftover} appended as a labeled section (no placeholder match)" if sig_leftover else "")
        )

    return {
        "output_path": output_path,
        "log": log,
        "extraction_source": extraction["source"],
        "translation_providers": rebuild_result["translation_providers"],
        "segments_translated": rebuild_result["segments_translated"],
        "segments_skipped": rebuild_result["segments_skipped"],
        "signatures_placed": sig_placed,
        "signatures_leftover": sig_leftover,
        "total_seconds": round(time.time() - t0, 1),
    }
