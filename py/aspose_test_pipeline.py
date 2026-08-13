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
    from asposepdfcloud.models.requests import GetPdfInStorageToTextRequest
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
    with open(output_path, "wb") as out:
        out.write(result_bytes)
    return {"output_path": output_path, "mode": "structure_only"}


def extract_text_via_aspose(pdf_path):
    """Extracts text via Aspose.PDF Cloud if configured, otherwise falls
    back to Lexora's own pdfplumber-based extractor (le.extract_text) so
    the rest of this pipeline is still testable. The fallback is always
    clearly labeled in the result, never silently substituted."""
    if not (_PDF_SDK_AVAILABLE and ASPOSE_CLIENT_ID and ASPOSE_CLIENT_SECRET):
        return {"text": le.extract_text(pdf_path), "source": "fallback:pdfplumber (Aspose.PDF Cloud not configured)"}
    # Aspose.PDF Cloud's text-extraction API works against files already
    # uploaded to Aspose's own cloud storage, not a direct local-file
    # convert-and-return like Aspose.Words - that's a genuinely separate
    # upload step this test pipeline doesn't implement yet (the
    # structure-only and full-pipeline-with-our-own-extractor modes
    # above cover the two most useful comparisons without needing it).
    return {"text": le.extract_text(pdf_path), "source": "fallback:pdfplumber (Aspose.PDF Cloud storage upload step not yet wired up)"}


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


def rebuild_docx_with_translated_text(pdf_path, translated_text, output_path):
    """Converts the source PDF to DOCX via Aspose (preserving its native
    structure/table detection), THEN does a plain find-and-replace-style
    rebuild isn't attempted here - Aspose's Words Cloud API doesn't have
    a single "swap all body text for this translated version, keep
    structure" call, and building one properly (per-paragraph mapping)
    is real, non-trivial follow-up work once the structure-only test
    above confirms Aspose's OWN conversion quality is actually worth
    building that on top of. For now, this mode produces the structure-
    converted (untranslated) docx WITH the translated text appended as
    a clearly-labeled reference page, so a reviewer can compare
    Aspose's table/format handling against the translated content side
    by side without the (larger) engineering investment of a true
    in-place text replacement yet."""
    words_api = _words_api()
    with open(pdf_path, "rb") as f:
        request = ConvertDocumentRequest(document=f, format="docx")
        # Same confirmed fix as run_structure_only_test above -
        # convert_document() returns raw bytes, not a file path.
        result_bytes = words_api.convert_document(request)

    from docx import Document
    from docx.shared import Pt
    from io import BytesIO
    doc = Document(BytesIO(result_bytes))
    doc.add_page_break()
    # Item - confirmed bug: add_heading(text, level=2) looks up a style
    # named "Heading 2" in the document's style gallery - this document
    # is NOT a fresh python-docx template, it's Aspose's OWN PDF->DOCX
    # conversion output, which apparently doesn't define that built-in
    # style at all, so the lookup failed ("no style with name 'Heading
    # 2'"). A plain paragraph with manual bold+size formatting achieves
    # the same visual result without depending on any assumption about
    # which named styles happen to exist in whatever document Aspose
    # hands back.
    heading_para = doc.add_paragraph()
    heading_run = heading_para.add_run("Translated text (reference - not yet merged into the structure above)")
    heading_run.bold = True
    heading_run.font.size = Pt(14)
    _append_markdown_lite_to_docx(doc, translated_text)

    # Item 2 (SIGNATURE-PRESERVATION) - runs on the structure part of the
    # doc (before the translated-reference page appended above), since
    # that's the part built from Aspose's conversion and is where the
    # blank-underline placeholders actually are.
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
        "mode": "structure_plus_translated_reference",
        "signatures_placed": sig_placed,
        "signatures_leftover": sig_leftover,
    }


def _add_bold_marked_runs(paragraph, text):
    """Splits `text` on le._BOLD_MARKUP_RE (the same '**bold**' convention
    translate_text() asks the LLM to use - see lease_engine.py's system
    prompt) and adds each segment as its own docx run, bold or not, so
    inline emphasis survives instead of the raw '**' characters leaking
    into the output as literal text."""
    parts = le._BOLD_MARKUP_RE.split(text)  # alternates [plain, bold, plain, bold, ...]
    for i, part in enumerate(parts):
        if part == "":
            continue
        run = paragraph.add_run(part)
        run.bold = (i % 2 == 1)


def _append_markdown_lite_to_docx(doc, translated_text):
    """Item 1 (MARKDOWN-FIX) - was previously just doc.add_paragraph(para)
    for each raw line, so the LLM's markdown-lite markup ('## ' headings,
    '- '/'1. ' lists, '**bold**') showed up as literal text instead of
    real docx formatting. Reuses le._parse_translation_blocks() (the same
    block-typing already used for the PDF translation renderer) so this
    reference page follows the exact same markup convention, then renders
    each block as proper docx elements without depending on named styles
    that may not exist in Aspose's own conversion output (see the
    Heading-2 bug note above - same root cause class, avoided the same
    way: manual bold+size formatting instead of style lookups)."""
    from docx.shared import Pt

    for block_type, content in le._parse_translation_blocks(translated_text):
        if block_type == "heading":
            para = doc.add_paragraph()
            run = para.add_run(content)
            run.bold = True
            run.font.size = Pt(13)
        elif block_type == "bullet":
            for item in content:
                para = doc.add_paragraph(style=None)
                para.paragraph_format.left_indent = Pt(18)
                para.add_run("\u2022  ")
                _add_bold_marked_runs(para, item)
        elif block_type == "numbered":
            for idx, item in enumerate(content, start=1):
                para = doc.add_paragraph(style=None)
                para.paragraph_format.left_indent = Pt(18)
                para.add_run(f"{idx}.  ")
                _add_bold_marked_runs(para, item)
        else:  # "paragraph"
            para = doc.add_paragraph()
            _add_bold_marked_runs(para, content)


def run_full_test(pdf_path, target_language, output_path):
    log = []
    t0 = time.time()
    log.append(f"Configured: {is_configured()}")

    extraction = extract_text_via_aspose(pdf_path)
    log.append(f"Text extracted via {extraction['source']} ({len(extraction['text'])} chars)")

    t1 = time.time()
    llm_config = le.load_llm_config()
    translated, provider = le.translate_text(extraction["text"], target_language, llm_config=llm_config)
    log.append(f"Translated via {provider} in {time.time()-t1:.1f}s")

    t2 = time.time()
    rebuild_result = rebuild_docx_with_translated_text(pdf_path, translated, output_path)
    log.append(f"Structure converted + translated reference page added via Aspose in {time.time()-t2:.1f}s")
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
        "translation_provider": provider,
        "signatures_placed": sig_placed,
        "signatures_leftover": sig_leftover,
        "total_seconds": round(time.time() - t0, 1),
    }
