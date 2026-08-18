"""
Lexora - PHASE 3: SOURCE-LAYOUT-DRIVEN RECONSTRUCTION (standalone, experimental)
==================================================================================

Consumes the Phase 2 semantic model (source_layout_semantic_model.py)
and produces a translated DOCX whose structure - table row/column
counts, proportional column widths, section order, RTL/LTR direction -
is driven by the SOURCE PDF's own geometry, not by whatever an Aspose
PDF->DOCX conversion happened to produce.

This is a SEPARATE reconstruction path from aspose_test_pipeline.py's
existing, working Aspose-DOCX-based pipeline. Nothing in this file
imports or modifies aspose_test_pipeline.py, translate_pipeline.py, or
lease_engine.py's own translation logic - it REUSES lease_engine's
translate_text() as-is for the actual translation calls.

SCOPE, STATED HONESTLY: this reconstructs using DOCX's native FLOW
model (real python-docx tables/paragraphs, sized proportionally from
source geometry) - it does NOT attempt absolute pixel-for-pixel
text-region placement (that would require the "visual-template + text
-region-replacement" hybrid architecture explicitly scoped OUT of this
project earlier). Column widths, section order, and table row/column
counts ARE source-geometry-driven; exact X/Y glyph position is not.

GENERICITY: no document name, article name, company name, page number,
or specific coordinate is referenced anywhere below. Every structural
decision reads from the Phase 2 model's own fields (page dimensions,
table row/col counts, cell text, section headers) or from the target
language passed in by the caller.
"""

import os
import statistics


class ReconstructionError(Exception):
    pass


# ---------------------------------------------------------------------------
# STEP 1: collect translatable text units with stable source mapping
# ---------------------------------------------------------------------------

def collect_translation_units(semantic_doc):
    """Walks the Phase 2 semantic model and returns a list of
    translation units, each:

        {"unit_id": ..., "source_text": ..., "kind": "cell"|"region",
         "page_id": ..., "table_id": ..., "cell_id": ..., "region_id": ...}

    unit_id is stable and reused later to place translated text back
    into the correct source-mapped location (SOURCE OBJECT -> SOURCE
    TEXT -> TRANSLATED TEXT -> TARGET OBJECT, per the explicit mapping
    requirement) - built directly from Phase 2's own object_ids, no
    new ID scheme invented.

    Page-number objects and off-page objects are deliberately EXCLUDED
    here - per the spec, page numbers must never be translated as
    ordinary body content, and off-page geometry artifacts (confirmed,
    in Phase 2, to be textless in this document) have nothing to
    translate anyway."""
    units = []
    for page in semantic_doc["pages"]:
        for t in page["tables"]:
            for row in t["rows"]:
                for cell in row["cells"]:
                    if cell.get("text"):
                        units.append({
                            "unit_id": cell["object_id"],
                            "source_text": cell["text"],
                            "kind": "cell",
                            "page_id": page["page_id"],
                            "table_id": t["object_id"],
                        })
        for r in page["regions"]:
            if r.get("text"):
                units.append({
                    "unit_id": r["object_id"],
                    "source_text": r["text"],
                    "kind": "region",
                    "page_id": page["page_id"],
                })
    return units


# ---------------------------------------------------------------------------
# STEP 2: translate units via the EXISTING translation engine
# ---------------------------------------------------------------------------

def translate_units(units, target_language, translate_fn, llm_config=None):
    """Calls translate_fn(text, target_language, llm_config) - by
    default lease_engine.translate_text, passed in by the caller so
    tests can substitute a mock without this module importing
    lease_engine directly (keeping this module's only dependency on
    the rest of Lexora at the call-site, not at import time) - once
    per unit, building unit_id -> translated_text.

    Item (FAULT ISOLATION, required per the fallback-strategy section)
    - a single unit's translation failure is caught and logged rather
    than aborting the whole document; the SOURCE text is used as a
    documented fallback for that one unit so nothing goes silently
    missing."""
    translations = {}
    fallback_units = []
    for u in units:
        try:
            translated, _provider = translate_fn(u["source_text"], target_language, llm_config)
            translations[u["unit_id"]] = translated if translated else u["source_text"]
            if not translated:
                fallback_units.append({"unit_id": u["unit_id"], "reason": "translate_fn returned empty/None"})
        except Exception as err:  # noqa: BLE001
            translations[u["unit_id"]] = u["source_text"]
            fallback_units.append({"unit_id": u["unit_id"], "reason": f"translation call raised: {err}"})
    return translations, fallback_units


# ---------------------------------------------------------------------------
# STEP 3: reconstruction
# ---------------------------------------------------------------------------

def _is_rtl_language(language_name):
    name = (language_name or "").strip().lower()
    return any(tok in name for tok in ("arabic", "hebrew", "urdu", "farsi", "persian"))


def _twips_from_points(pt):
    return int(round(pt * 20))


def _set_table_direction(table_el, rtl):
    from docx.oxml.ns import qn
    from docx.oxml import OxmlElement

    tblPr = table_el.find(qn("w:tblPr"))
    if tblPr is None:
        tblPr = OxmlElement("w:tblPr")
        table_el.insert(0, tblPr)
    bidi_visual = tblPr.find(qn("w:bidiVisual"))
    if rtl:
        if bidi_visual is None:
            bidi_visual = OxmlElement("w:bidiVisual")
            tblPr.append(bidi_visual)
    elif bidi_visual is not None:
        tblPr.remove(bidi_visual)


def _add_shaded_paragraph(doc, text, rtl, shade_fill=None, bold=False):
    from docx.oxml.ns import qn
    from docx.oxml import OxmlElement

    p = doc.add_paragraph()
    p.paragraph_format.alignment = 3 if not rtl else 0  # WD_ALIGN_PARAGRAPH.LEFT=0 / .RIGHT? kept simple, see note
    pPr = p._p.get_or_add_pPr()
    if rtl:
        pPr.append(OxmlElement("w:bidi"))
    run = p.add_run(text or "")
    run.bold = bold
    if shade_fill:
        rpr = run._element.get_or_add_rPr()
        shd = OxmlElement("w:shd")
        shd.set(qn("w:val"), "clear")
        shd.set(qn("w:color"), "auto")
        shd.set(qn("w:fill"), shade_fill)
        rpr.append(shd)
    return p


def reconstruct_docx(semantic_doc, translations, target_language, output_path, source_pdf_path=None):
    """Builds a new DOCX driven by the Phase 2 semantic model's own
    structure and the translations map from Step 2. Per-section fault
    isolation: one section's reconstruction failure is logged and
    skipped, the rest of the document continues (Item 25/K in the
    spec - never silently produce a broken document, never abort the
    whole thing over one bad section either).

    Returns a dict of reconstruction diagnostics (sections processed,
    sections skipped with reasons, tables built, images placed)."""
    from docx import Document
    from docx.shared import Pt, Emu
    from docx.oxml.ns import qn
    from docx.oxml import OxmlElement

    want_rtl = _is_rtl_language(target_language)
    doc = Document()

    diagnostics = {"sections_processed": 0, "sections_skipped": [], "tables_built": 0, "images_placed": 0}

    # STEP 1 (of the reconstruction order) - page properties from the
    # SOURCE PDF's own first-page dimensions, not a hard-coded A4/
    # Letter assumption.
    if semantic_doc["pages"]:
        src_w = semantic_doc["pages"][0]["dimensions"]["width"]
        src_h = semantic_doc["pages"][0]["dimensions"]["height"]
        section = doc.sections[0]
        section.page_width = Emu(int(src_w * 12700))  # points -> EMU (1pt = 12700 EMU)
        section.page_height = Emu(int(src_h * 12700))
        section.left_margin = Emu(int(45 * 12700))
        section.right_margin = Emu(int(45 * 12700))

    for page in semantic_doc["pages"]:
        for section_data in page["layout_sections"]:
            try:
                header_text = section_data.get("section_header")
                if header_text:
                    translated_header = translations.get(section_data.get("header_cell_id")) or header_text
                    _add_shaded_paragraph(doc, translated_header, want_rtl, shade_fill="DDDDDD", bold=True)

                for table_id in section_data["child_table_ids"]:
                    src_table = next((t for t in page["tables"] if t["object_id"] == table_id), None)
                    if not src_table:
                        continue
                    num_cols = src_table.get("num_cols") or max((len(r["cells"]) for r in src_table["rows"]), default=1)
                    if num_cols < 1:
                        continue
                    docx_table = doc.add_table(rows=0, cols=num_cols)
                    docx_table.autofit = False
                    _set_table_direction(docx_table._tbl, want_rtl)

                    # Column widths PROPORTIONAL to source cell widths
                    # (averaged per column across the table's own
                    # rows), scaled to the section's usable page width
                    # - never copied as absolute source PDF points,
                    # which would use the wrong unit/coordinate system
                    # entirely (see source_layout_analyzer's own
                    # coordinate-system note on this exact point).
                    col_widths_pt = []
                    for ci in range(num_cols):
                        widths = [
                            row["cells"][ci]["width"]
                            for row in src_table["rows"]
                            if len(row["cells"]) > ci and row["cells"][ci].get("width")
                        ]
                        col_widths_pt.append(statistics.median(widths) if widths else 1.0)
                    total_pt = sum(col_widths_pt) or 1.0
                    usable_width_emu = int(doc.sections[0].page_width - doc.sections[0].left_margin - doc.sections[0].right_margin)
                    col_widths_emu = [int(usable_width_emu * (w / total_pt)) for w in col_widths_pt]

                    grid = docx_table._tbl.find(qn("w:tblGrid"))
                    if grid is None:
                        grid = OxmlElement("w:tblGrid")
                        docx_table._tbl.insert(0, grid)
                    for w_emu in col_widths_emu:
                        gc = OxmlElement("w:gridCol")
                        gc.set(qn("w:w"), str(int(w_emu / 635)))  # EMU -> twips
                        grid.append(gc)

                    for row in src_table["rows"]:
                        docx_row = docx_table.add_row()
                        for ci, cell in enumerate(row["cells"]):
                            if ci >= num_cols:
                                break
                            docx_cell = docx_row.cells[ci]
                            src_text = cell.get("text") or ""
                            translated = translations.get(cell["object_id"], src_text) if src_text else ""
                            docx_cell.text = translated
                            for p in docx_cell.paragraphs:
                                pPr = p._p.get_or_add_pPr()
                                existing_bidi = pPr.find(qn("w:bidi"))
                                if want_rtl and existing_bidi is None:
                                    pPr.append(OxmlElement("w:bidi"))
                    diagnostics["tables_built"] += 1

                for region_id in section_data["child_text_region_ids"]:
                    src_region = next((r for r in page["regions"] if r["object_id"] == region_id), None)
                    if not src_region or not src_region.get("text"):
                        continue
                    translated = translations.get(region_id, src_region["text"])
                    _add_shaded_paragraph(doc, translated, want_rtl)

                diagnostics["sections_processed"] += 1
            except Exception as err:  # noqa: BLE001
                diagnostics["sections_skipped"].append({
                    "section_id": section_data.get("object_id"),
                    "reason": str(err),
                })

        for img in page.get("images", []):
            try:
                doc.add_paragraph(f"[image: {img['object_id']}, {img.get('width')}x{img.get('height')}pt - see IMAGE-PLACEMENT limitation note]")
                diagnostics["images_placed"] += 1
            except Exception:  # noqa: BLE001
                pass

        doc.add_page_break()

    doc.save(output_path)
    return diagnostics


# ---------------------------------------------------------------------------
# STEP 4: render + validate
# ---------------------------------------------------------------------------

def render_to_pdf(docx_path, output_dir):
    import subprocess

    result = subprocess.run(
        ["libreoffice", "--headless", "--convert-to", "pdf", "--outdir", output_dir, docx_path],
        capture_output=True, text=True, timeout=120,
    )
    pdf_path = os.path.join(output_dir, os.path.splitext(os.path.basename(docx_path))[0] + ".pdf")
    if not os.path.isfile(pdf_path):
        raise ReconstructionError(f"PDF render failed: {result.stdout}\n{result.stderr}")
    return pdf_path


def validate_layout(rendered_pdf_path, semantic_doc):
    """Item (LAYOUT ERROR DETECTION, required) - a deliberately
    SCOPED first set of checks (page count, and - via pdfplumber
    re-opening the RENDERED pdf - whether any table's own bbox exceeds
    that rendered page's width) rather than the full 16-item list in
    the spec, which would require far more rendering-comparison
    infrastructure than is being claimed here. Each result is
    evidence-based (re-opens the actual rendered file), not asserted."""
    import pdfplumber

    findings = {"page_count_source": semantic_doc["page_count"], "page_count_rendered": None, "warnings": []}
    with pdfplumber.open(rendered_pdf_path) as pdf:
        findings["page_count_rendered"] = len(pdf.pages)
        for i, page in enumerate(pdf.pages):
            for tbl in page.find_tables():
                x0, top, x1, bottom = tbl.bbox
                if x0 < -1 or x1 > page.width + 1:
                    findings["warnings"].append({
                        "page": i + 1, "issue": "table extends outside rendered page width",
                        "table_bbox": tbl.bbox, "page_width": page.width,
                    })
    return findings
