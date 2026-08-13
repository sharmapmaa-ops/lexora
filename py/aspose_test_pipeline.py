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
    doc.save(output_path)
    return {"output_path": output_path, "mode": "structure_plus_translated_reference"}


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
    rebuild_docx_with_translated_text(pdf_path, translated, output_path)
    log.append(f"Structure converted + translated reference page added via Aspose in {time.time()-t2:.1f}s")

    return {
        "output_path": output_path,
        "log": log,
        "extraction_source": extraction["source"],
        "translation_provider": provider,
        "total_seconds": round(time.time() - t0, 1),
    }
