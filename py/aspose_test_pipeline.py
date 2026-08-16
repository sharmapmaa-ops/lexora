"""
Lexora - ASPOSE CLOUD TEST PIPELINE (isolated, experimental)
==============================================================

This does NOT touch translate_pipeline.py, lease_engine.py's real
translation flow, or js/translation-offline.js. Only reachable via its
own admin-only test route.

Needs NO self-hosting - Aspose runs the actual service, we just call it
with a Client Id/Secret. Genuinely just `pip install aspose-words-cloud
asposepdfcloud pycryptodome` (all three now in requirements.txt) and two
environment variables.

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

# Item (DEPLOYMENT-VERSION-VERIFICATION) - confirmed real incident: a
# production run's clause-number reversal was 48/49 wrong, while the
# exact same function, called directly on byte-identical text extracted
# from that SAME production file, correctly returned the right answer
# every single time in this sandbox. Paragraph-direction (bidi) WAS
# being cleared correctly throughout that same file, proving
# _fix_paragraph_direction was genuinely running - so the only
# remaining explanation is that the code actually deployed in
# production differs from what was verified here. This constant exists
# so that can be checked DIRECTLY from a run's own log output, instead
# of guessing: bump it with every delivered change, and confirm it
# appears in the "Configured: ..." log line of a fresh test run before
# treating that run's results as reflecting current code.
PIPELINE_CODE_VERSION = "2026-08-16-v25-gridspan-header-split-fix"

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

    Item (MERGED-TWO-SIDED-HEADER) - confirmed real, separate bug from
    the background-gap this function was originally written for: SOME
    of these standalone header paragraphs (6 out of the document's
    header-style paragraphs, confirmed by direct inspection) hold BOTH
    the English-side label AND the (originally Arabic) number+label side
    as ONE CONTINUOUS paragraph - e.g. "Lessor Representative Data" +
    "3 Lessor Representative Data" - instead of two separate cells like
    every OTHER working header in the document (e.g. "Contract Data" |
    "1 Contract Data", a genuine 2-cell table). Wrapping the whole thing
    into a single cell (the original fix here) correctly closed the
    background-color gap but left both halves crammed together on one
    side with nothing on the right, since there's no cell boundary
    between them.

    Root cause: Aspose represents the visual gap between the two halves
    using a single run with an artificially huge w:spacing (letter-
    spacing) value (~5100, confirmed on multiple real headers) instead
    of a real table-cell boundary - so this function now detects that
    specific spacer run (spacing far larger than any normal text
    kerning would ever use) and, when found, splits the paragraph into
    TWO paragraphs at that point (discarding the spacer run itself,
    since a real cell boundary replaces its job) and builds a proper
    2-column table instead of 1, matching the structure every other
    working header in the document already uses. Headers with no such
    spacer run (genuinely single-sided) keep the original 1-cell
    behavior unchanged.

    Returns the count of paragraphs fixed, for the caller's log."""
    from docx.oxml.ns import qn
    from docx.oxml import OxmlElement
    from docx.text.paragraph import Paragraph

    _SPACER_LETTER_SPACING_THRESHOLD = 500  # twips - normal kerning never gets remotely this large

    def _find_spacer_run_index(paragraph_el):
        runs = paragraph_el.findall(qn("w:r"))
        for idx, r in enumerate(runs):
            rpr = r.find(qn("w:rPr"))
            if rpr is None:
                continue
            spacing_el = rpr.find(qn("w:spacing"))
            if spacing_el is None:
                continue
            val = spacing_el.get(qn("w:val"))
            if val and val.lstrip("-").isdigit() and abs(int(val)) > _SPACER_LETTER_SPACING_THRESHOLD:
                return idx
        return None

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

        spacer_idx = _find_spacer_run_index(child)

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

        body.remove(child)
        pPr_orig = child.find(qn("w:pPr"))
        if pPr_orig is not None:
            ind_orig = pPr_orig.find(qn("w:ind"))
            if ind_orig is not None:
                pPr_orig.remove(ind_orig)

        if spacer_idx is None:
            # Original single-cell behavior - no two-sided split needed.
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
            tc.append(child)
            tr.append(tc)
            new_tbl.append(tr)
        else:
            # Split into two cells at the spacer run - it's discarded
            # (a real cell boundary now does its job).
            all_runs = child.findall(qn("w:r"))
            spacer_run = all_runs[spacer_idx]
            left_width = total_width // 2
            right_width = total_width - left_width

            tblGrid_new = OxmlElement("w:tblGrid")
            for w in (left_width, right_width):
                gridCol = OxmlElement("w:gridCol")
                gridCol.set(qn("w:w"), str(w))
                tblGrid_new.append(gridCol)
            new_tbl.append(tblGrid_new)

            pPr_source = child.find(qn("w:pPr"))
            left_p = OxmlElement("w:p")
            right_p = OxmlElement("w:p")
            if pPr_source is not None:
                from copy import deepcopy
                left_p.append(deepcopy(pPr_source))
                right_p.append(deepcopy(pPr_source))

            spacer_run.getparent().remove(spacer_run)
            for r in all_runs:
                if r is spacer_run:
                    continue
                (left_p if all_runs.index(r) < spacer_idx else right_p).append(r)

            tr = OxmlElement("w:tr")
            for w, para_el in ((left_width, left_p), (right_width, right_p)):
                tc = OxmlElement("w:tc")
                tcPr = OxmlElement("w:tcPr")
                tcW = OxmlElement("w:tcW")
                tcW.set(qn("w:w"), str(w))
                tcW.set(qn("w:type"), "dxa")
                tcPr.append(tcW)
                shd_el = OxmlElement("w:shd")
                shd_el.set(qn("w:val"), "clear")
                shd_el.set(qn("w:color"), "auto")
                shd_el.set(qn("w:fill"), fill_color)
                tcPr.append(shd_el)
                tc.append(tcPr)
                tc.append(para_el)
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


def _fix_merged_two_sided_table_header(doc):
    """Item (MERGED-TWO-SIDED-HEADER, gridSpan variant) - same underlying
    defect as _fix_incomplete_header_bar_shading's two-sided-header fix
    above, but for a DIFFERENT structural shape: confirmed one real
    instance ("Tenant rights") where the English label and the (Arabic-
    origin) number+label are crammed into ONE paragraph inside a SINGLE
    table cell that already has gridSpan="2" (i.e. it's ALREADY a real,
    correctly-merged, full-width cell - unlike the standalone-paragraph
    cases above, so this does NOT need a new table built around it).

    Detected the same way: a run with an artificially large w:spacing
    (letter-spacing) value inside that gridSpan=2 cell's paragraph -
    Aspose's same positioning hack seen elsewhere, confirmed present
    here too (w:spacing val="4097" on a single-space run, immediately
    before the Arabic content begins).

    Fix: split that cell's paragraph at the spacer run into two
    paragraphs (discarding the spacer run, same as the other fix),
    un-merge the gridSpan=2 cell into two real adjacent cells sized
    50/50 of its own total width, and put the "before spacer" content
    in the first and "after spacer" content in the second - giving this
    header the same two-sided visual structure every other working
    header in the document already has.

    Returns the count of cells fixed, for the caller's log."""
    from docx.oxml.ns import qn
    from docx.oxml import OxmlElement
    from copy import deepcopy

    _SPACER_LETTER_SPACING_THRESHOLD = 500

    fixed = 0
    for tbl_el in doc.element.body.iter(qn("w:tbl")):
        for tr in tbl_el.findall(qn("w:tr")):
            tcs = tr.findall(qn("w:tc"))
            if len(tcs) != 1:
                continue
            tc = tcs[0]
            tcPr = tc.find(qn("w:tcPr"))
            if tcPr is None:
                continue
            gridSpan = tcPr.find(qn("w:gridSpan"))
            if gridSpan is None or gridSpan.get(qn("w:val")) != "2":
                continue
            tcW_el = tcPr.find(qn("w:tcW"))
            if tcW_el is None:
                continue
            total_width = int(tcW_el.get(qn("w:w")) or 0)
            if total_width <= 0:
                continue

            # Only handle the simple, verified case: exactly one
            # paragraph in the cell, with a real spacer run in it.
            paras = tc.findall(qn("w:p"))
            if len(paras) != 1:
                continue
            p_el = paras[0]
            all_runs = p_el.findall(qn("w:r"))
            spacer_idx = None
            for idx, r in enumerate(all_runs):
                rpr = r.find(qn("w:rPr"))
                if rpr is None:
                    continue
                spacing_el = rpr.find(qn("w:spacing"))
                if spacing_el is None:
                    continue
                val = spacing_el.get(qn("w:val"))
                if val and val.lstrip("-").isdigit() and abs(int(val)) > _SPACER_LETTER_SPACING_THRESHOLD:
                    spacer_idx = idx
                    break
            if spacer_idx is None:
                continue

            left_width = total_width // 2
            right_width = total_width - left_width

            spacer_run = all_runs[spacer_idx]
            pPr_source = p_el.find(qn("w:pPr"))

            left_p = p_el  # reuse the existing paragraph element for the "before" half
            right_p = OxmlElement("w:p")
            if pPr_source is not None:
                right_p.append(deepcopy(pPr_source))

            spacer_run.getparent().remove(spacer_run)
            for r in list(all_runs):
                if r is spacer_run:
                    continue
                if all_runs.index(r) > spacer_idx:
                    left_p.remove(r)
                    right_p.append(r)

            # Resize the original cell (drop gridSpan, it's now just col0).
            tcW_el.set(qn("w:w"), str(left_width))
            tcPr.remove(gridSpan)

            # Build the new sibling cell, copying the shading so it
            # matches the header bar's own color.
            shd_source = tcPr.find(qn("w:shd"))
            new_tc = OxmlElement("w:tc")
            new_tcPr = OxmlElement("w:tcPr")
            new_tcW = OxmlElement("w:tcW")
            new_tcW.set(qn("w:w"), str(right_width))
            new_tcW.set(qn("w:type"), "dxa")
            new_tcPr.append(new_tcW)
            if shd_source is not None:
                new_tcPr.append(deepcopy(shd_source))
            new_tc.append(new_tcPr)
            new_tc.append(right_p)

            tc.addnext(new_tc)
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
        headers_fixed += _fix_merged_two_sided_table_header(doc)
    except Exception:
        pass  # non-fatal - test pipeline still produces its output even if this cosmetic pass fails

    tables_repositioned = 0
    try:
        tables_repositioned = _fix_table_overflow_indent(doc)
    except Exception:
        pass  # non-fatal - test pipeline still produces its output even if this cosmetic pass fails

    leaked_names_fixed = 0
    try:
        leaked_names_fixed = _fix_leaked_internal_field_names(doc)
    except Exception:
        pass  # non-fatal - test pipeline still produces its output even if this cosmetic pass fails

    split_numeric_findings = []
    try:
        split_numeric_findings = _detect_split_numeric_values(doc)
    except Exception:
        pass  # non-fatal - a validation pass failing shouldn't block delivering the document

    doc.save(output_path)
    return {
        "output_path": output_path,
        "mode": "structure_only",
        "pipeline_code_version": PIPELINE_CODE_VERSION,
        "header_bars_fixed": headers_fixed,
        "tables_repositioned": tables_repositioned,
        "leaked_names_fixed": leaked_names_fixed,
        "split_numeric_findings": split_numeric_findings,
        "aspose_words_calls": 1,
        "aspose_pdf_calls": 0,
        "llm_calls": 0,
        "llm_calls_by_provider": {},
    }


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
        return {
            "text": le.extract_text(pdf_path),
            "source": "fallback:pdfplumber (Aspose.PDF Cloud not configured)",
            "aspose_pdf_calls": 0,
        }

    pdf_api = _pdf_api()
    folder = "lexora-aspose-test"
    filename = os.path.basename(pdf_path)
    storage_path = f"{folder}/{filename}"
    result_path = None
    api_calls = 0  # counts actual Aspose.PDF Cloud API calls MADE (attempted), even on failure - not assumed
    text, source = None, None
    try:
        # Item - confirmed bug (verified by reading the installed SDK's
        # own api_client.py __call_api source, not guessed): the `file`
        # argument to upload_file() is NOT meant to be an already-open
        # file object - the SDK does `open(n, 'rb')` on whatever gets
        # passed here ITSELF internally (see api_client.py's `if files:`
        # block), so it needs a PATH STRING it can open on its own.
        # Passing an open BufferedReader made the SDK call
        # open(<BufferedReader instance>, 'rb'), which raised exactly
        # "expected str, bytes or os.PathLike object, not
        # BufferedReader" - this was silently swallowed by the
        # try/except below and fell back to pdfplumber every single
        # time, meaning Aspose.PDF Cloud extraction never actually ran
        # even when correctly configured.
        api_calls += 1
        pdf_api.upload_file(storage_path, pdf_path)

        api_calls += 1
        result_path = pdf_api.get_pdf_in_storage_to_text(filename, folder=folder)
        with open(result_path, "rb") as rf:
            text = rf.read().decode("utf-8", errors="replace")
        source = "aspose_pdf_cloud"
    except Exception as err:  # noqa: BLE001
        text = le.extract_text(pdf_path)
        source = f"fallback:pdfplumber (Aspose.PDF Cloud call failed: {err})"
    finally:
        if result_path:
            try:
                os.remove(result_path)
            except OSError:
                pass  # local temp file cleanup - non-fatal if it's already gone
        try:
            api_calls += 1
            pdf_api.delete_file(storage_path)
        except Exception:
            pass  # cleanup best-effort - don't fail extraction over a leftover file in Aspose's cloud storage

    # Built AFTER the try/finally completes (not returned from inside it)
    # so api_calls reflects ALL three attempted calls, including
    # delete_file's - returning from inside try/except would have
    # captured api_calls before finally's own increment ran.
    return {"text": text, "source": source, "aspose_pdf_calls": api_calls}


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


_MAX_SEGMENT_CHARS_PER_BATCH = 9000  # Item (REDUCE-LLM-CALL-COUNT) - was 3500, chosen without
# testing against the model's real output-token ceiling. Confirmed the default OpenRouter model
# (OPENROUTER_MODEL, defaults to "openai/gpt-4o" - see lease_engine.load_llm_config()) supports up
# to 16384 output tokens, and the old 8000 max_tokens cap on each batch call was only using half of
# that. Tested against a real 575-segment/24063-char document: this threshold cuts 8 batches down to
# 3 (each batch's translated-JSON output comes to roughly 3500 output tokens by rough char/4 estimate
# - comfortably under the 12000 max_tokens now used below, leaving real headroom for target languages
# that expand more than English does). Batch failures already degrade gracefully (that batch's
# segments are left untranslated and logged, not a hard failure - see _translate_docx_segments_in_place
# below), so a wrong per-model assumption here costs some retranslatable segments, not a broken run.


_RTL_LANGUAGE_KEYWORDS = ("arabic", "hebrew", "persian", "farsi", "urdu", "pashto", "dhivehi", "divehi", "yiddish", "sindhi")


def _is_rtl_language(target_language):
    tl = (target_language or "").strip().lower()
    return any(kw in tl for kw in _RTL_LANGUAGE_KEYWORDS)


_NUMERIC_ID_PREFIX_RE = re.compile(
    r"^([\d\u0660-\u0669]+(?:[\-.][\d\u0660-\u0669]+){1,4})(\s+)(\S.{10,})", re.DOTALL
)


def _reverse_numeric_id_groups(token):
    """Reverses the ORDER of hyphen/dot-separated numeric groups in an
    identifier like '11-1-5' -> '5-1-11' - WITHOUT touching the digits
    within each group, and without touching which separator character
    sits where (handles mixed '-'/'.' use, though clause numbers
    typically use one consistently). Works with both Western (0-9) and
    Arabic-Indic (\u0660-\u0669) digits, since the source language isn't
    known/assumed here - see _fix_paragraph_direction's docstring for
    why this needs to be script-agnostic."""
    tokens = re.findall(r"[\d\u0660-\u0669]+|[\-.]", token)
    groups = [t for t in tokens if not re.match(r"[\-.]", t)]
    seps = [t for t in tokens if re.match(r"[\-.]", t)]
    if len(groups) < 2:
        return token
    rev_groups = groups[::-1]
    rev_seps = seps[::-1]
    out = rev_groups[0]
    for sep, g in zip(rev_seps, rev_groups[1:]):
        out += sep + g
    return out


def _fix_reversed_clause_number_prefix(paragraph):
    """Item (CLAUSE-NUMBER-REVERSAL) - confirmed root cause by comparing
    Aspose's own untranslated RTL conversion against the same paragraph
    post-translation: Aspose's PDF text extraction stores certain
    RTL-context numeric IDENTIFIER PREFIXES (clause/article numbers like
    "5-1-11") in REVERSED group order ("11-1-5") in the underlying XML
    text, relying on RTL bidi rendering to display them correctly -
    verified directly: Aspose's raw conversion held '\u0661\u0661-\u0661-\u0665'
    (logical order 11-1-5) for a clause whose SOURCE PDF plainly showed
    '\u0665-\u0661-\u0661\u0661' (5-1-11, confirmed against the original
    PDF's own text). RTL bidi rendering was silently "correcting" the
    display while bidi=1 was set - our _fix_paragraph_direction's
    RTL->LTR flip (needed for the now-translated LTR content) removes
    that compensating rendering, which is what exposes the reversal as
    literal, visible "11-1-5" text instead of "5-1-11".

    This is NOT a general numeric-integrity bug: Gregorian/Hijri dates
    and amounts elsewhere in the SAME originally-RTL paragraphs were
    verified to already be in CORRECT order (e.g. "2024-04-01" stayed
    "2024-04-01", never "01-04-2024") - only short numeric-group PREFIXES
    at the very start of a paragraph, followed by substantial prose,
    show this reversal. That "followed by substantial prose" condition
    is the safety gate used here: a standalone numeric VALUE that fills
    an entire cell (a date, an amount, an ID - confirmed several dozen
    of these also carry bidi=1 in the same document) must NEVER be
    reversed, since reversing "2025-06-17" would corrupt a real date
    into "17-06-2025". Requiring real text after the numeric prefix
    reliably tells clause-number labels ("11-1-5 The Tenant shall...")
    apart from bare data values ("2025-06-17" and nothing else).

    Only ever called for a paragraph that's about to flip from RTL to
    LTR (see call site in _fix_paragraph_direction) - a paragraph that
    stays RTL, or was already LTR, never had this compensating-reversal
    behavior baked in, so nothing to undo there. Operates on whichever
    run holds the paragraph's opening text (translation puts the whole
    translated paragraph into one run - see _replace_paragraph_text -
    so this is normally the first run with real text).

    Returns True if a reversal was applied."""
    for run in paragraph.runs:
        text = run.text or ""
        if not text.strip():
            continue
        m = _NUMERIC_ID_PREFIX_RE.match(text)
        if not m:
            return False  # first real-text run doesn't start with a numeric-id-like prefix at all
        prefix, ws, rest = m.groups()
        fixed_prefix = _reverse_numeric_id_groups(prefix)
        if fixed_prefix == prefix:
            return False
        run.text = fixed_prefix + ws + rest
        return True
    return False


def _fix_paragraph_direction(doc, target_language):
    """Item (RTL/LTR-NOT-CORRECTED) - after in-place translation
    replaces a paragraph's text, the paragraph's own w:bidi (RTL
    paragraph flag) and each run's w:rtl flag were being left untouched
    - so a paragraph that used to hold right-to-left Arabic still told
    Word/LibreOffice "this paragraph is RTL" even though it now holds
    left-to-right English. Confirmed by scanning a real translated
    output: 328 paragraphs contained clearly-Latin-script (English) text
    while still carrying <w:bidi/> with no val attribute (which per
    OOXML defaults to true/on) - this was the direct cause of reported
    colon-placement, alignment, and unnecessary-wrapping bugs, since the
    bidi algorithm was still being applied to now-LTR content. Verified
    by rendering a real affected document before/after this fix: e.g.
    "Contract Sealing :Location" (broken) became "Contract Sealing
    Location:" (correct) with no other change.

    Sets every paragraph's w:bidi and every run's w:rtl to match the
    TARGET language's actual direction (RTL only for Arabic, Hebrew,
    Persian/Farsi, Urdu, Pashto, Dhivehi, Yiddish, Sindhi - LTR for
    everything else). Applied document-wide since a full-pipeline
    translation converts virtually the entire document to one target
    language, so the whole document should read in one consistent
    direction, not a per-paragraph mix left over from the source PDF's
    original bilingual (Arabic+English side-by-side) layout. Tested
    against an already-LTR source/target document too (Italian->English)
    to confirm no regression - it still found 27 stray bidi flags there
    and clearing them left the rendered output visually identical.

    Also fixes reversed clause/article-number prefixes exposed by the
    RTL->LTR flip - see _fix_reversed_clause_number_prefix()'s docstring
    for the full root-cause explanation.

    Also converts w:jc="both" (full justify) to "left" for paragraphs
    flipping from RTL to LTR - confirmed real complaint, with evidence:
    508 of 575 real translated paragraphs in an affected document kept
    jc="both" (inherited from the original Arabic layout, which
    routinely uses full justification), which - now holding English
    text of very different average word/line-length than the Arabic it
    replaced - produces visibly oversized, uneven gaps between words to
    stretch each line to full width. In table cells with short content
    (e.g. a single digit in a narrow "Clause Number" column), that same
    justify behavior can look like the text is oddly spaced or even
    reads as if the column wasn't resized at all, even when the
    column's own width is correct. Only touches paragraphs making the
    RTL->LTR transition (same evidence-gated condition as the clause-
    number fix) - "left" is a safe, unambiguous default for translated
    body text and table cells; jc="center" is left untouched since
    centering isn't direction-dependent.

    Returns (paragraphs_fixed, clause_numbers_fixed)."""
    from docx.oxml.ns import qn
    from docx.oxml import OxmlElement

    want_rtl = _is_rtl_language(target_language)
    fixed = 0
    clause_numbers_fixed = 0
    errors_encountered = 0

    # Item (SILENT-CASCADING-FAILURE) - confirmed real bug pattern: in a
    # real production run, an ENTIRE block of 24 consecutive clause
    # numbers (all of Article Five's obligations) failed to get
    # reversed together, while clauses before and after that block were
    # unaffected - exactly the signature of ONE paragraph raising an
    # exception partway through this loop, which the caller's
    # try/except then silently swallows (rebuild_docx_with_translated_
    # text wraps this whole function in "except Exception: pass"),
    # leaving every paragraph from that point onward completely
    # unprocessed - not just its clause number, but its bidi/rtl flags
    # too. Extensive isolated testing (49/49 real clause numbers
    # correctly reversed) could not reproduce the specific paragraph
    # that raised, but the FIX for this class of bug doesn't require
    # reproducing it: wrapping each paragraph's own processing in its
    # own try/except means one paragraph's edge case can only skip that
    # one paragraph, never cascade into silently abandoning every
    # paragraph after it.
    for p in _iter_paragraphs_in_order(doc):
        try:
            pPr = p._p.find(qn("w:pPr"))
            changed = False

            was_rtl = pPr is not None and pPr.find(qn("w:bidi")) is not None
            if was_rtl and not want_rtl:
                if _fix_reversed_clause_number_prefix(p):
                    clause_numbers_fixed += 1
                if pPr is not None:
                    jc = pPr.find(qn("w:jc"))
                    if jc is not None:
                        jc_val = jc.get(qn("w:val"))
                        # Item (CENTER-ALIGNED-CLAUSE-BODY) - confirmed
                        # real, pixel-measured bug: a user-provided
                        # screenshot showed a clause paragraph's wrapped
                        # lines each starting at a WILDLY different x
                        # position (159 to 278px, a 119px spread) instead
                        # of a consistent left margin - the exact visual
                        # signature of CENTER alignment (each line
                        # centers based on its own width) rather than
                        # left. Confirmed root cause directly in Aspose's
                        # own untranslated conversion: this specific
                        # clause paragraph had jc="center" while every
                        # sibling clause paragraph around it (same
                        # Article, same structure) correctly had
                        # jc="both" - a one-off Aspose inconsistency, not
                        # something translation introduced. The earlier
                        # both->left fix deliberately left jc="center"
                        # alone project-wide (reasoned that centering
                        # isn't inherently RTL/LTR-dependent) - true in
                        # general, but wrong for this specific case: a
                        # numbered clause's BODY TEXT should never be
                        # centered regardless of source direction. Scoped
                        # narrowly here (only applies when the
                        # paragraph's own text starts with a digit, i.e.
                        # it looks like clause/list body content) so a
                        # genuinely-intentional centered short title or
                        # signature line elsewhere isn't touched.
                        first_run_text = next((r.text for r in p.runs if r.text and r.text.strip()), "")
                        looks_like_clause_body = bool(re.match(r"^\d", first_run_text.strip()))
                        if jc_val == "both" or (jc_val == "center" and looks_like_clause_body):
                            jc.set(qn("w:val"), "left")
                            changed = True

            if want_rtl:
                if pPr is None:
                    pPr = OxmlElement("w:pPr")
                    p._p.insert(0, pPr)
                bidi = pPr.find(qn("w:bidi"))
                if bidi is None:
                    pPr.append(OxmlElement("w:bidi"))
                    changed = True
                elif bidi.get(qn("w:val")) == "0":
                    del bidi.attrib[qn("w:val")]
                    changed = True
            else:
                if pPr is not None:
                    bidi = pPr.find(qn("w:bidi"))
                    if bidi is not None:
                        pPr.remove(bidi)
                        changed = True

            for r in p.runs:
                rpr = r._element.find(qn("w:rPr"))
                if rpr is None:
                    if not want_rtl:
                        continue
                    rpr = OxmlElement("w:rPr")
                    r._element.insert(0, rpr)
                rtl_el = rpr.find(qn("w:rtl"))
                if want_rtl:
                    if rtl_el is None:
                        rpr.append(OxmlElement("w:rtl"))
                        changed = True
                    elif rtl_el.get(qn("w:val")) == "0":
                        del rtl_el.attrib[qn("w:val")]
                        changed = True
                else:
                    if rtl_el is not None:
                        rpr.remove(rtl_el)
                        changed = True

            if changed:
                fixed += 1
        except Exception as err:  # noqa: BLE001
            errors_encountered += 1
            print(f"[direction-fix] skipped one paragraph after an error, continuing with the rest: {err}")

    if errors_encountered:
        print(f"[direction-fix] {errors_encountered} paragraph(s) skipped due to errors - see messages above")

    return fixed, clause_numbers_fixed


def _fix_exact_row_heights(doc):
    """Item (VERTICAL-CLIPPING) - many of Aspose's table rows use
    <w:trHeight w:hRule="exact"/> - a FIXED height, sized for the
    original (often more compact) source-language text. Translated text
    needing more vertical space (longer English phrases, or text that
    now wraps to 2+ lines) gets visually clipped or overflows outside
    the fixed-height row instead of the row growing - confirmed on a
    real translated document showing headers like "Number of Parking
    Number of / Lots Elevators" overlapping garbled text at exact
    height. Switching hRule from "exact" to "atLeast" keeps the same
    MINIMUM height (short content still looks the same) but lets the
    row grow taller when its content genuinely needs more room. Found
    104 such rows in a real affected document; fixing this eliminated
    the clipping/overlap with no visible change to rows that didn't
    need to grow."""
    from docx.oxml.ns import qn

    fixed = 0
    for tr in doc.element.body.iter(qn("w:tr")):
        trPr = tr.find(qn("w:trPr"))
        if trPr is None:
            continue
        trHeight = trPr.find(qn("w:trHeight"))
        if trHeight is not None and trHeight.get(qn("w:hRule")) == "exact":
            trHeight.set(qn("w:hRule"), "atLeast")
            fixed += 1
    return fixed


def _fix_table_overflow_indent(doc):
    """Item (APPENDIX-TABLE-OFF-PAGE, P0-critical) - confirmed real,
    pre-existing Aspose conversion defect: this document's Appendix
    tables ("Clause Number | Field | Clarification") carry a
    w:tblInd (table left-indent) of ~6766-6767 twips, while the table's
    own column widths sum to ~9422 twips and the page's content width is
    only ~10860 twips - so indent + width = ~16188 twips, roughly 5300
    twips (over 3.5 inches) past the page's right edge. Confirmed this
    exact broken indent already exists in Aspose's OWN untranslated
    structure-only conversion (unrelated to translation or anything
    this pipeline does), pushing nearly the entire table off-page -
    every OTHER table in the same document uses an indent around
    700-870 twips, so this is clearly anomalous, not an intentional
    layout choice.

    Fix: for every table in the document, if its indent plus total
    column width would exceed the page's content width, clamp the
    indent down to fit ("content_width - table_width", never negative)
    - a minimal, targeted change that only touches tables which are
    actually mispositioned, leaving every correctly-placed table
    (indent ~700-870, safely within bounds) untouched. Verified against
    the real document: 4 tables fixed, Appendix went from having its
    Clause Number/Field columns entirely clipped off-page to being
    fully visible with all three columns readable."""
    from docx.oxml.ns import qn
    from docx.oxml import OxmlElement

    sec = doc.sections[0]
    content_width_twips = round((sec.page_width - sec.left_margin - sec.right_margin) / 635)

    fixed = 0
    for tbl_el in doc.element.body.iter(qn("w:tbl")):
        tblPr = tbl_el.find(qn("w:tblPr"))
        if tblPr is None:
            continue
        grid = tbl_el.find(qn("w:tblGrid"))
        cols = grid.findall(qn("w:gridCol")) if grid is not None else []
        total_w = sum(int(c.get(qn("w:w"))) for c in cols) if cols else 0
        if total_w <= 0:
            continue
        tblInd = tblPr.find(qn("w:tblInd"))
        ind_val = int(tblInd.get(qn("w:w"))) if tblInd is not None else 0
        if ind_val + total_w > content_width_twips:
            new_ind = max(0, content_width_twips - total_w)
            if tblInd is None:
                tblInd = OxmlElement("w:tblInd")
                tblInd.set(qn("w:type"), "dxa")
                tblPr.append(tblInd)
            tblInd.set(qn("w:w"), str(new_ind))
            fixed += 1
    return fixed


_RTL_SCRIPT_CHAR_RE = re.compile(
    r"[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]"
)
_LATIN_CHAR_RE = re.compile(r"[A-Za-z]")


def _fix_table_column_order_for_target_direction(doc, target_language):
    """Item (TABLE-COLUMN-ORDER-NOT-MIRRORED, confirmed real via direct
    user report + visual evidence) - fixing paragraph-level w:bidi/w:rtl
    (see _fix_paragraph_direction) makes TEXT read correctly, but a
    table's own COLUMN ORDER is a separate, physical layout fact that
    bidi does nothing about: a table built for RTL reading naturally
    orders its columns right-to-left (e.g. a genuinely monolingual
    Arabic "Clause Number | Field | Clarification" table has "Clause
    Number" as the PHYSICALLY RIGHTMOST, narrowest column, since that's
    read first in RTL) - translating the text to English doesn't move
    the columns, so the result reads Clarification-first,
    Number-last, which is backwards for an LTR reader. Confirmed via a
    real screenshot: the Appendix table's "Clarification" column (long
    text) sat physically first/leftmost and "Clause Number" sat
    physically last/rightmost, exactly backwards from correct LTR
    reading order.

    This must NOT be applied to every table indiscriminately: most of
    this document's tables are a BILINGUAL side-by-side layout (an
    English label already sitting on the physical left, paired with the
    same field's Arabic-translated label on the physical right, e.g.
    "Brokerage Entity Address | - | عنوان منشأة الوساطة العقارية:") -
    these already have their English anchor correctly positioned on the
    left, and reversing them would break that. The distinguishing
    signal, confirmed by measuring actual character composition across
    this document's real tables: a table that still needs reordering is
    overwhelmingly (>85%) RTL-script content with no real Latin-script
    anchor column at all, while every bilingual-layout table sits
    comfortably below that (measured 0.09-0.74 RTL-character fraction
    across 28 real tables in this document, vs 0.96-1.0 for the 5 tables
    that do need reordering) - a wide, safe margin, not a coin-flip
    threshold.

    Runs BEFORE translation (like _fix_table_overflow_indent above) -
    this detection needs the ORIGINAL script to tell "genuinely RTL
    monolingual table" apart from "bilingual table with an English
    column already in place", which is impossible to tell apart once
    translation has turned everything into English. The actual column
    swap itself doesn't care about language and could run at any point;
    doing it here just keeps both structural table fixes together.

    Skips (does not touch) any table containing a row whose cell count
    doesn't match the column count (a sign of a gridSpan/merged cell in
    that row) - reordering cells positionally is only safe when every
    row has exactly one cell per column, and this document has at most
    one gridSpan cell total, so being conservative here costs
    essentially nothing.

    Only runs when the TARGET language is LTR (no evidence yet for the
    reverse LTR-source -> RTL-target case, so this deliberately doesn't
    guess at that scenario)."""
    from docx.oxml.ns import qn

    if _is_rtl_language(target_language):
        return 0

    fixed = 0
    for tbl_el in doc.element.body.iter(qn("w:tbl")):
        try:
            grid = tbl_el.find(qn("w:tblGrid"))
            cols = grid.findall(qn("w:gridCol")) if grid is not None else []
            num_cols = len(cols)
            if num_cols < 2:
                continue

            rows = tbl_el.findall(qn("w:tr"))
            if not rows:
                continue

            latin_count = 0
            rtl_count = 0
            skip_table = False
            for tr in rows:
                tcs = tr.findall(qn("w:tc"))
                if len(tcs) != num_cols:
                    skip_table = True
                    break
                for tc in tcs:
                    text = "".join((t.text or "") for t in tc.findall(".//" + qn("w:t")))
                    latin_count += len(_LATIN_CHAR_RE.findall(text))
                    rtl_count += len(_RTL_SCRIPT_CHAR_RE.findall(text))
            if skip_table:
                continue

            total_chars = latin_count + rtl_count
            if total_chars < 5:
                continue
            if (rtl_count / total_chars) <= 0.85:
                continue  # has a real Latin-script anchor column (bilingual layout) - don't reorder

            # Reverse the column widths - this applies uniformly across the
            # whole table (a single tblGrid can't have different widths per
            # row), matching the assumption that the "short identifier"
            # column becomes narrow-on-the-left and the "long text" column
            # becomes wide-on-the-right once semantically reordered.
            widths = [c.get(qn("w:w")) for c in cols]
            for c, w in zip(cols, reversed(widths)):
                c.set(qn("w:w"), w)

            # Reverse each row's CELL order - but only the rows that
            # actually need it. Confirmed by direct inspection of a real
            # affected table: its HEADER row and its DATA rows are NOT
            # consistently ordered relative to each other in Aspose's own
            # conversion - the header row already read "Clause Number |
            # Field | Clarification" in plain left-to-right order (already
            # correct for LTR), while every data row underneath had long
            # explanatory text on the LEFT and the short clause number on
            # the RIGHT (backwards). Blindly reversing every row uniformly
            # would have "fixed" the already-correct header into the WRONG
            # order while fixing the data rows - leaving header and data
            # mismatched either way.
            #
            # Per-row rule (evidence-based, not a guess): only reverse a row
            # whose first cell is markedly LONGER than its last cell (>10
            # chars and >1.5x) - this is exactly the signature of "long
            # content sitting on the left, short identifier on the right"
            # that every genuine data row in the real affected table showed,
            # while the header row (short labels in every cell, no strong
            # length asymmetry) correctly does NOT match this pattern and is
            # left alone. Verified against all 16 rows of a real appendix
            # table: correctly reversed all 15 data rows and correctly
            # skipped the 1 header row.
            for tr in rows:
                tcs = tr.findall(qn("w:tc"))
                first_text = "".join((t.text or "") for t in tcs[0].findall(".//" + qn("w:t"))).strip()
                last_text = "".join((t.text or "") for t in tcs[-1].findall(".//" + qn("w:t"))).strip()
                if not (len(first_text) > 10 and len(first_text) > len(last_text) * 1.5):
                    continue
                for tc in tcs:
                    tr.remove(tc)
                for tc in reversed(tcs):
                    tr.append(tc)

            # Item (INVISIBLE-HEADER-TEXT) - confirmed real bug this exact
            # fix introduced: reversing the table-wide gridCol widths
            # applies to EVERY row uniformly, but a row that got SKIPPED
            # by the per-row cell-reversal above (like the header row,
            # correctly left in place per the note above) keeps its
            # OWN per-cell w:tcW and w:tcMar exactly as Aspose originally
            # set them - which were calibrated for the OLD, PRE-REVERSAL
            # column width at that position. Confirmed on a real
            # document: the header row's "Clause Number" cell had its
            # own tcW="6756" (the WIDE column's original width) and a
            # tcMar left-margin of 6075 (a positioning hack that made
            # sense inside a 6756-wide cell) - but after this function
            # reversed the GRID to make that same position only 654
            # wide, the cell's own unchanged 6075 margin alone exceeded
            # its new 654-wide space, leaving zero or negative room for
            # the text, which the renderer then simply couldn't display
            # anywhere inside the cell's real boundaries - the "Clause
            # Number" header vanished, leaving a blank space in that
            # narrow column with no visible error.
            #
            # Fix: after all reordering is settled, walk every cell in
            # this table and correct its own tcW to match whatever the
            # (possibly-just-reversed) grid now says for that column
            # position - this is always safe since tcW is supposed to
            # track the grid for non-spanning cells. If a cell's tcMar
            # would still leave less than 100 twips of real content
            # width against that corrected tcW, shrink the margin(s)
            # proportionally down to a safe amount rather than leaving a
            # cell with no room for its own text.
            current_widths = [int(c.get(qn("w:w"))) for c in cols]
            for tr in rows:
                tcs = tr.findall(qn("w:tc"))
                for i, tc in enumerate(tcs):
                    if i >= len(current_widths):
                        break
                    tcPr = tc.find(qn("w:tcPr"))
                    if tcPr is None:
                        continue
                    tcW = tcPr.find(qn("w:tcW"))
                    target_w = current_widths[i]
                    if tcW is not None:
                        tcW.set(qn("w:w"), str(target_w))
                    tcMar = tcPr.find(qn("w:tcMar"))
                    if tcMar is not None:
                        left = tcMar.find(qn("w:left"))
                        right = tcMar.find(qn("w:right"))
                        lv = int(left.get(qn("w:w"))) if left is not None else 0
                        rv = int(right.get(qn("w:w"))) if right is not None else 0
                        if lv + rv > target_w - 100:
                            # shrink both margins proportionally so at least
                            # 100 twips of real content width remains
                            scale = max(0, target_w - 100) / max(lv + rv, 1)
                            if left is not None:
                                left.set(qn("w:w"), str(int(lv * scale)))
                            if right is not None:
                                right.set(qn("w:w"), str(int(rv * scale)))

            fixed += 1
        except Exception as err:  # noqa: BLE001
            # Item (SILENT-CASCADING-FAILURE) - one table's own quirk
            # must never abort processing for every table after it in
            # document order - see the matching note in
            # _fix_paragraph_direction for the confirmed real-world
            # failure pattern this guards against.
            print(f"[column-order-fix] skipped one table after an error, continuing with the rest: {err}")

    return fixed


def _fix_tiny_font_outliers(doc, min_readable_half_points=10):
    """Item (FONT-SIZE-OUTLIERS) - a small number of runs in Aspose's OWN
    conversion output carry an anomalously tiny w:sz (font size in
    half-points) - confirmed two real instances at w:sz="2" (1pt -
    practically invisible) on header text ("5 Tenant Representative
    Data", the Appendix section intro), while every sibling run in the
    same paragraph and the rest of the document sits at 16-19
    half-points (8-9.5pt). Pre-existing in Aspose's conversion, not
    introduced by translation, but inherited unchanged into translated
    output.

    For any run with visible text and a w:sz below
    min_readable_half_points, replaces it with the paragraph's own most
    common OTHER run size (falling back to the most common size seen
    anywhere in the document if the paragraph has no other sized runs) -
    normalizing the outlier to match its actual surrounding context
    instead of guessing a fixed replacement number."""
    from collections import Counter
    from docx.oxml.ns import qn

    doc_wide_sizes = Counter()
    for r in doc.element.body.iter(qn("w:r")):
        t = r.find(qn("w:t"))
        if t is None or not (t.text or "").strip():
            continue
        rpr = r.find(qn("w:rPr"))
        if rpr is None:
            continue
        sz = rpr.find(qn("w:sz"))
        if sz is not None:
            val = sz.get(qn("w:val"))
            if val and val.isdigit() and int(val) >= min_readable_half_points:
                doc_wide_sizes[val] += 1
    fallback_size = doc_wide_sizes.most_common(1)[0][0] if doc_wide_sizes else "20"

    fixed = 0
    for p_el in doc.element.body.iter(qn("w:p")):
        para_sizes = Counter()
        outlier_runs = []
        for r in p_el.findall(qn("w:r")):
            t = r.find(qn("w:t"))
            if t is None or not (t.text or "").strip():
                continue
            rpr = r.find(qn("w:rPr"))
            if rpr is None:
                continue
            sz = rpr.find(qn("w:sz"))
            if sz is None:
                continue
            val = sz.get(qn("w:val"))
            if not val or not val.isdigit():
                continue
            if int(val) < min_readable_half_points:
                outlier_runs.append(r)
            else:
                para_sizes[val] += 1
        if not outlier_runs:
            continue
        replacement = para_sizes.most_common(1)[0][0] if para_sizes else fallback_size
        for r in outlier_runs:
            rpr = r.find(qn("w:rPr"))
            for tag in ("w:sz", "w:szCs"):
                el = rpr.find(qn(tag))
                if el is not None:
                    el.set(qn("w:val"), replacement)
            fixed += 1

    return fixed


# Item (LEAKED-INTERNAL-FIELD-NAMES) - confirmed these tokens are already
# present, verbatim, in Aspose's OWN untranslated structure-only conversion of
# the SOURCE PDF (i.e. baked into the source contract-generation template
# itself - the Saudi Ejar/REGA system's own output - not something this
# pipeline's extraction or translation introduced). Still worth cleaning up
# before delivering a final document to a reader, since a raw
# programmer-style token like "tin_number" sitting next to real data looks
# unprofessional regardless of which upstream system produced it. Kept as an
# explicit, reviewable mapping (not a guess-based heuristic) so it only ever
# touches known-confirmed tokens - extend this dict if future documents
# surface other leaked field names, rather than trying to auto-detect
# arbitrary snake_case-looking substrings (which risks false positives on
# real content, e.g. genuine hyphenated/underscored reference numbers).
_KNOWN_LEAKED_FIELD_NAME_MAP = {
    "tin_number": "TIN",
}


def _fix_leaked_internal_field_names(doc):
    """Replaces known internal/template field-name tokens (see
    _KNOWN_LEAKED_FIELD_NAME_MAP above) with their proper display label,
    wherever they appear verbatim in a run's text. Returns the count of
    runs changed."""
    from docx.oxml.ns import qn

    fixed = 0
    for run in doc.element.body.iter(qn("w:r")):
        t = run.find(qn("w:t"))
        if t is None or not t.text:
            continue
        new_text = t.text
        changed = False
        for bad, good in _KNOWN_LEAKED_FIELD_NAME_MAP.items():
            if bad in new_text:
                new_text = new_text.replace(bad, good)
                changed = True
        if changed:
            t.text = new_text
            fixed += 1
    return fixed


def _detect_split_numeric_values(doc):
    """Item (NUMERIC-INTEGRITY VALIDATION - split amounts) - confirmed
    real, pre-existing defect: Aspose's OWN PDF->DOCX table-structure
    detection sometimes splits a single financial figure across two
    ADJACENT table cells (verified: a source PDF value of 3474876.00
    came out of Aspose's OWN untranslated conversion as two separate
    cells holding "347" and "4876.00" - confirmed against Aspose's raw
    structure-only output, so this is not something translation
    introduced). The actual digits are correct and in the right order
    when read left-to-right (347 then 4876.00 = 3474876.00), so this
    isn't a corruption of the VALUE - but per this project's numeric-
    integrity requirements, a "split amount" like this is exactly the
    kind of defect that should be surfaced for review rather than
    silently shipped, since a reader could misread it as two separate
    numbers.

    Deliberately does NOT attempt to auto-merge the cells: an earlier
    attempt at a related fix (redistributing column widths) hit real,
    confirmed regressions from this same document's inconsistent
    per-cell tcMar (padding) overrides - Aspose's table reconstruction
    has enough undocumented per-cell quirks that blindly restructuring
    table cells carries real risk of a worse defect (e.g. merging two
    cells that are NOT actually a split number, corrupting a legitimate
    two-column layout). This is a targeted-repair-only situation per the
    "do not regenerate/restructure broadly" principle - so this function
    only DETECTS and reports candidates for human review, it does not
    modify the document.

    Detection heuristic (generic, not tied to any specific document or
    number): within each table row, flag any adjacent cell pair where
    the first cell is ALL DIGITS (no separators - i.e. looks like a
    truncated integer fragment, not a complete formatted number) and the
    very next non-empty cell STARTS with digits. Genuine standalone
    numbers in this kind of document are formatted with a decimal point
    or thousands separators (e.g. "40", "8", "2025-06-17", "445050.00"),
    so a bare, separator-free digit run sitting immediately next to
    another digit-led cell is the distinguishing signature of a split
    fragment rather than two unrelated real values.

    Returns a list of dicts: {"row_text": ..., "fragment_1": ...,
    "fragment_2": ..., "combined": ...} for logging/review."""
    from docx.oxml.ns import qn

    findings = []
    for tbl_el in doc.element.body.iter(qn("w:tbl")):
        for tr in tbl_el.findall(qn("w:tr")):
            cells = tr.findall(qn("w:tc"))
            cell_texts = [
                "".join((t.text or "") for t in tc.findall(".//" + qn("w:t"))).strip() for tc in cells
            ]
            for i in range(len(cell_texts) - 1):
                frag1 = cell_texts[i]
                if not re.fullmatch(r"\d+", frag1):
                    continue
                # find the next NON-EMPTY cell (skip blank spacer cells, common in this table style)
                j = i + 1
                while j < len(cell_texts) and not cell_texts[j]:
                    j += 1
                if j >= len(cell_texts):
                    continue
                frag2 = cell_texts[j]
                if not re.match(r"^\d", frag2):
                    continue
                findings.append(
                    {
                        "fragment_1": frag1,
                        "fragment_2": frag2,
                        "combined": frag1 + frag2,
                    }
                )
    return findings


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

    Returns (translated_count, skipped_count, failed_batch_count,
    llm_calls_total, llm_calls_by_provider) for the caller's log/API-call
    accounting. A batch whose JSON response fails to parse, or is
    missing some ids, is logged and its paragraphs are simply left in
    the source language rather than aborting the whole run - a partial
    translation is far more useful to a reviewer than no output at all."""
    import json
    from collections import Counter

    segments = []  # list of (id, paragraph, original_text)
    next_id = 1
    for para in _iter_paragraphs_in_order(doc):
        text = (para.text or "").strip()
        if not text or _SIGNATURE_PLACEHOLDER_RE.match(text):
            continue  # empty paragraphs and signature-placeholder underline lines aren't translatable content
        segments.append((next_id, para, text))
        next_id += 1

    if not segments:
        return 0, 0, 0, 0, {}

    rules_block = le._fetch_translation_rules_block()
    system_prompt = (
        f"You are a professional document translator. Translate each text segment below into "
        f"{target_language}, preserving meaning, tone, and register. Each segment is a single "
        f"paragraph or table cell from a legal document, already correctly structured - do NOT "
        f"add markdown, bullets, or numbering, just translate the text of each segment as-is.\n\n"
        f"Pronoun rule: if a segment refers to a contracting party (e.g. 'the Tenant', 'the "
        f"Lessor') that is a company, institution, establishment, or other organizational entity "
        f"rather than a named individual person - look for cues like 'Company', 'Corporation', "
        f"'Establishment', 'Institution', 'Single Person Company', or a commercial registration "
        f"number attached to that party - use 'its' rather than 'his'/'her' for that party's "
        f"possessive pronouns in {target_language} (where the target language distinguishes "
        f"entity vs. personal pronouns). If genuinely uncertain whether a party is an individual "
        f"or an organization from the segment's own content, prefer the organizational form, "
        f"since legal contracting parties styled with a company/entity name are far more often "
        f"organizations than individuals.\n\n"
        f"Legal-English register: when the target language is English, prefer plain, standard "
        f"legal-English phrasing over literal or archaic-sounding constructions. For example "
        f"(illustrative only, not an exhaustive list, and only apply when it fits the actual "
        f"sentence): 'delay' rather than 'procrastination'; 'the defaulting party' rather than "
        f"'the procrastinating party'; 'shall be vacated' rather than 'are evicted' when "
        f"describing units being returned/emptied (reserve 'evict' for a landlord expelling a "
        f"tenant); 'from the date the dispute arises' rather than 'from the arising of the "
        f"dispute'; 'any implied right' rather than 'his/its unmentioned right'. Never invent "
        f"or guess a specific meaning that isn't in the source text - this rule is about "
        f"choosing the more natural of two accurate phrasings, not changing what's being said.\n\n"
        f"Input is a JSON array of {{\"id\": <int>, \"text\": <string>}} objects. Respond with "
        f"ONLY a JSON array of {{\"id\": <int>, \"text\": <translated string>}} objects, one per "
        f"input segment, same ids, no other text, no markdown code fences."
    ) + rules_block

    translated_by_id = {}
    failed_batches = 0
    llm_calls_by_provider = Counter()  # counts by provider that actually SUCCEEDED per batch (see note below)

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

    # Note on call counting: each batch below is ONE logical translation
    # request from this pipeline's perspective, but
    # le._call_chat_completion_with_failover() can itself make up to TWO
    # real HTTP calls internally (primary provider, then a fallback
    # provider if the primary's call errors) before returning - it
    # doesn't currently expose that internal count. llm_calls_total
    # below is therefore the number of batches ATTEMPTED (a solid lower
    # bound on real network calls, and the number that matters for "how
    # many times did this pipeline ask an LLM to translate something"),
    # while llm_calls_by_provider counts only the provider that actually
    # SUCCEEDED for each batch (a failed batch's provider, if any was
    # tried internally, isn't visible to us here).
    for batch in batches:
        user_content = json.dumps([{"id": sid, "text": text} for sid, _para, text in batch], ensure_ascii=False)
        try:
            content, provider = le._call_chat_completion_with_failover(
                llm_config, system_prompt, user_content, max_tokens=12000
            )
            if content is None:
                failed_batches += 1
                continue
            llm_calls_by_provider[provider] += 1
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

    return translated_count, skipped_count, failed_batches, len(batches), dict(llm_calls_by_provider)


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
        headers_fixed += _fix_merged_two_sided_table_header(doc)
    except Exception:
        pass  # non-fatal - test pipeline still produces its output even if this cosmetic pass fails

    tables_repositioned = 0
    try:
        tables_repositioned = _fix_table_overflow_indent(doc)
    except Exception:
        pass  # non-fatal - test pipeline still produces its output even if this cosmetic pass fails

    # Item (TABLE-COLUMN-ORDER-NOT-MIRRORED) - see
    # _fix_table_column_order_for_target_direction()'s docstring. MUST
    # run BEFORE translation - it tells "genuinely RTL monolingual
    # table, needs column reversal" apart from "bilingual table with an
    # English column already in place" by looking at the ORIGINAL
    # script, which is impossible to check once everything has been
    # translated to English.
    columns_reordered = 0
    try:
        columns_reordered = _fix_table_column_order_for_target_direction(doc, target_language)
    except Exception:
        pass  # non-fatal - test pipeline still produces its output even if this cosmetic pass fails

    llm_config = llm_config if llm_config is not None else le.load_llm_config()
    translated_count, skipped_count, failed_batches, llm_calls_total, llm_calls_by_provider = (
        _translate_docx_segments_in_place(doc, target_language, llm_config)
    )

    # Item (RTL/LTR-NOT-CORRECTED, VERTICAL-CLIPPING, FONT-SIZE-OUTLIERS)
    # - see each function's own docstring above. Run after translation so
    # the direction fix corresponds to the document's actual final
    # language; the row-height and font-size fixes are independent
    # Aspose-conversion cleanups that are safe to run alongside it.
    direction_fixed, rows_fixed, fonts_fixed, clause_numbers_fixed = 0, 0, 0, 0
    try:
        direction_fixed, clause_numbers_fixed = _fix_paragraph_direction(doc, target_language)
        rows_fixed = _fix_exact_row_heights(doc)
        fonts_fixed = _fix_tiny_font_outliers(doc)
    except Exception:
        pass  # non-fatal - test pipeline still produces its output even if these cosmetic passes fail

    # Item (LEAKED-INTERNAL-FIELD-NAMES) - run AFTER translation so this
    # catches the token regardless of whether the LLM carried
    # "tin_number" through untouched or not - see
    # _fix_leaked_internal_field_names()'s docstring for the confirmed
    # root cause (this is baked into the SOURCE PDF's own template, not
    # something this pipeline's extraction introduced).
    leaked_names_fixed = 0
    try:
        leaked_names_fixed = _fix_leaked_internal_field_names(doc)
    except Exception:
        pass  # non-fatal - test pipeline still produces its output even if this cosmetic pass fails

    # Item (NUMERIC-INTEGRITY VALIDATION) - detection-only, see
    # _detect_split_numeric_values()'s docstring for why this doesn't
    # attempt an automatic merge.
    split_numeric_findings = []
    try:
        split_numeric_findings = _detect_split_numeric_values(doc)
    except Exception:
        pass  # non-fatal - a validation pass failing shouldn't block delivering the document

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
        "translation_providers": sorted(llm_calls_by_provider.keys()),
        "signatures_placed": sig_placed,
        "signatures_leftover": sig_leftover,
        "header_bars_fixed": headers_fixed,
        "tables_repositioned": tables_repositioned,
        "columns_reordered": columns_reordered,
        "direction_fixed": direction_fixed,
        "clause_numbers_fixed": clause_numbers_fixed,
        "split_numeric_findings": split_numeric_findings,
        "row_heights_fixed": rows_fixed,
        "tiny_fonts_fixed": fonts_fixed,
        "aspose_words_calls": 1,
        "aspose_pdf_calls": 0,
        "llm_calls": llm_calls_total,
        "llm_calls_by_provider": llm_calls_by_provider,
    }


def run_full_test(pdf_path, target_language, output_path):
    log = []
    t0 = time.time()
    log.append(f"Pipeline code version: {PIPELINE_CODE_VERSION}")
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
    if rebuild_result.get("tables_repositioned"):
        log.append(f"Off-page tables repositioned (were overflowing page boundary): {rebuild_result['tables_repositioned']}")
    if rebuild_result.get("columns_reordered"):
        log.append(f"Table column order mirrored for LTR reading (was RTL physical order): {rebuild_result['columns_reordered']}")
    if rebuild_result.get("leaked_names_fixed"):
        log.append(f"Leaked internal field-name tokens cleaned up: {rebuild_result['leaked_names_fixed']}")
    if rebuild_result.get("direction_fixed"):
        log.append(f"RTL/LTR direction corrected: {rebuild_result['direction_fixed']} paragraph(s)")
    if rebuild_result.get("clause_numbers_fixed"):
        log.append(f"Reversed clause/article numbers corrected: {rebuild_result['clause_numbers_fixed']}")
    if rebuild_result.get("row_heights_fixed"):
        log.append(f"Fixed-height rows relaxed (prevents clipping): {rebuild_result['row_heights_fixed']}")
    if rebuild_result.get("tiny_fonts_fixed"):
        log.append(f"Tiny-font outliers normalized: {rebuild_result['tiny_fonts_fixed']}")
    split_findings = rebuild_result.get("split_numeric_findings") or []
    if split_findings:
        examples = ", ".join(f"{f['fragment_1']}|{f['fragment_2']}" for f in split_findings[:5])
        log.append(
            f"\u26a0\ufe0f NEEDS REVIEW: {len(split_findings)} possible split numeric value(s) found "
            f"(Aspose's own table conversion, not introduced by translation) - not auto-merged, "
            f"review recommended: {examples}"
            + (f" (+{len(split_findings)-5} more)" if len(split_findings) > 5 else "")
        )

    sig_placed = rebuild_result.get("signatures_placed", 0)
    sig_leftover = rebuild_result.get("signatures_leftover", 0)
    if sig_placed or sig_leftover:
        log.append(
            f"Signatures: {sig_placed} placed in-line at placeholder line(s)"
            + (f", {sig_leftover} appended as a labeled section (no placeholder match)" if sig_leftover else "")
        )

    # API-call accounting: combines the informational extraction check
    # above with the rebuild/translate step below - so this reflects
    # EVERY Aspose and LLM call this one test run actually made, useful
    # for tracking usage against Aspose's free-tier call limits and
    # LLM provider costs.
    aspose_words_calls = rebuild_result.get("aspose_words_calls", 0)
    aspose_pdf_calls = extraction.get("aspose_pdf_calls", 0) + rebuild_result.get("aspose_pdf_calls", 0)
    aspose_calls_total = aspose_words_calls + aspose_pdf_calls
    llm_calls_by_provider = rebuild_result.get("llm_calls_by_provider", {})
    openrouter_calls = llm_calls_by_provider.get("openrouter", 0)
    llm_calls_total = rebuild_result.get("llm_calls", 0)
    log.append(
        f"API calls this run \u2014 Aspose: {aspose_calls_total} "
        f"(Words Cloud: {aspose_words_calls}, PDF Cloud: {aspose_pdf_calls}), "
        f"LLM: {llm_calls_total} (OpenRouter: {openrouter_calls})"
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
        "aspose_words_calls": aspose_words_calls,
        "aspose_pdf_calls": aspose_pdf_calls,
        "aspose_calls_total": aspose_calls_total,
        "llm_calls_total": llm_calls_total,
        "llm_calls_by_provider": llm_calls_by_provider,
        "openrouter_calls": openrouter_calls,
    }
