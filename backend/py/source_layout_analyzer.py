"""
Lexora - SOURCE LAYOUT ANALYZER (Phase 1, standalone, experimental)
=====================================================================

Does NOT touch translate_pipeline.py, lease_engine.py's real pipeline,
aspose_test_pipeline.py, or any part of Lexora's existing translation
or document-reconstruction flow. This module is a pure, read-only
ANALYSIS pass over a source PDF: it produces a structured description
of the PDF's own visual geometry (page dimensions, text word/character
positions, table/cell regions, images, lines, rectangles, curves) and
returns/serializes it as JSON. Nothing here writes to or modifies any
document.

Purpose (per the Phase-1 scope this was commissioned under): prove
that Lexora CAN accurately capture a source document's visual layout
model directly from the PDF, independent of whatever the Aspose
PDF-to-DOCX conversion does or loses - as groundwork for a possible
future "Source Visual Layout Template + Text Region Replacement"
reconstruction mode. This module does not decide how or whether that
data gets used; it only proves the data is obtainable and describes
exactly what is and isn't captured.

GENERICITY - none of this is document-, language-, page-, coordinate-,
filename-, or table-specific. Every object is discovered purely from
what pdfplumber reports for whatever PDF is passed in; there is no
per-document branching anywhere in this file.

Coordinate system: pdfplumber's native top-left-origin system is used
throughout (x0/top/x1/bottom, matching PDF's own points, 1/72 inch) -
this is NOT the same origin as DOCX twips (which measure down-and-right
from the page's top-left too, but in different units and with margins
handled separately) - any future reconstruction layer consuming this
JSON will need its own unit/origin conversion step, which is
explicitly out of scope for this analyzer.

Dependency: pdfplumber only - already an existing Lexora dependency
(see lease_engine.py's _extract_text_pdfplumber), not a new one.
"""

import os
import json

try:
    import pdfplumber
except ImportError:  # pragma: no cover - mirrors lease_engine.py's own guard
    pdfplumber = None


class SourceLayoutAnalyzerError(Exception):
    pass


def _round2(value):
    """Rounds a pdfplumber coordinate to 2 decimal places for a clean,
    stable JSON representation - pdfplumber's raw floats commonly carry
    10+ meaningless decimal digits from internal PDF-matrix math."""
    if value is None:
        return None
    return round(float(value), 2)


def _bbox_dict(x0, top, x1, bottom):
    return {
        "x0": _round2(x0),
        "top": _round2(top),
        "x1": _round2(x1),
        "bottom": _round2(bottom),
        "width": _round2(x1 - x0) if x0 is not None and x1 is not None else None,
        "height": _round2(bottom - top) if top is not None and bottom is not None else None,
    }


def _extract_words(page, page_id):
    """Every word on the page with its bounding box, direction, and -
    where pdfplumber can determine it from the underlying PDF content
    stream - font name, font size, and fill color. These are the same
    raw per-word records the eventual "text region" concept in a
    reconstruction layer would be built from; this function doesn't
    group them into lines/paragraphs/regions - that's a layout-
    inference decision deliberately left for a later phase, not
    something to guess at here."""
    words = []
    raw_words = page.extract_words(
        extra_attrs=["fontname", "size", "non_stroking_color"],
        use_text_flow=False,
    )
    for i, w in enumerate(raw_words, start=1):
        entry = {
            "object_id": f"{page_id}_TEXT_{i:04d}",
            "type": "text_word",
            "text": w.get("text"),
            "direction": w.get("direction"),
            "font_name": w.get("fontname"),
            "font_size": _round2(w.get("size")),
            "fill_color": w.get("non_stroking_color"),
        }
        entry.update(_bbox_dict(w.get("x0"), w.get("top"), w.get("x1"), w.get("bottom")))
        words.append(entry)
    return words


def _extract_tables(page, page_id):
    """Every table pdfplumber's own ruling-line/whitespace-based table
    detector finds, with row and cell-level bounding boxes. A cell's
    bbox can be None (pdfplumber reports this for a spanned/merged
    region with no independent boundary of its own) - passed through
    as null rather than guessing a synthetic box for it, since
    fabricating one would misrepresent what the source actually
    contains."""
    tables = []
    try:
        raw_tables = page.find_tables()
    except Exception as err:  # noqa: BLE001
        return [], str(err)

    for ti, tbl in enumerate(raw_tables, start=1):
        table_id = f"{page_id}_TABLE_{ti:03d}"
        x0, top, x1, bottom = tbl.bbox
        table_entry = {
            "object_id": table_id,
            "type": "table",
            "num_rows": len(tbl.rows),
            "num_cols": max((len(r.cells) for r in tbl.rows), default=0),
            "rows": [],
        }
        table_entry.update(_bbox_dict(x0, top, x1, bottom))

        for ri, row in enumerate(tbl.rows, start=1):
            row_id = f"{table_id}_ROW_{ri:03d}"
            row_entry = {"object_id": row_id, "type": "table_row", "cells": []}
            for ci, cell_bbox in enumerate(row.cells, start=1):
                cell_id = f"{row_id}_CELL_{ci:03d}"
                if cell_bbox is None:
                    row_entry["cells"].append({
                        "object_id": cell_id,
                        "type": "table_cell",
                        "x0": None, "top": None, "x1": None, "bottom": None,
                        "width": None, "height": None,
                        "note": "no independent bounding box reported (likely a merged/spanned region)",
                    })
                    continue
                cx0, ctop, cx1, cbottom = cell_bbox
                cell_entry = {"object_id": cell_id, "type": "table_cell"}
                cell_entry.update(_bbox_dict(cx0, ctop, cx1, cbottom))
                row_entry["cells"].append(cell_entry)
            table_entry["rows"].append(row_entry)
        tables.append(table_entry)
    return tables, None


def _extract_images(page, page_id):
    images = []
    for i, img in enumerate(page.images, start=1):
        entry = {
            "object_id": f"{page_id}_IMAGE_{i:03d}",
            "type": "image",
            "declared_width": _round2(img.get("width")),
            "declared_height": _round2(img.get("height")),
            "source_pixel_size": img.get("srcsize"),
            "color_space": img.get("colorspace"),
        }
        entry.update(_bbox_dict(img.get("x0"), img.get("top"), img.get("x1"), img.get("bottom")))
        images.append(entry)
    return images


def _extract_lines(page, page_id):
    lines = []
    for i, ln in enumerate(page.lines, start=1):
        entry = {
            "object_id": f"{page_id}_LINE_{i:03d}",
            "type": "line",
            "stroke_color": ln.get("stroking_color"),
            "line_width": _round2(ln.get("linewidth")),
        }
        entry.update(_bbox_dict(ln.get("x0"), ln.get("top"), ln.get("x1"), ln.get("bottom")))
        lines.append(entry)
    return lines


def _extract_rects(page, page_id):
    """Rectangles are frequently how a source PDF represents cell
    shading / colored bars / decorative blocks (confirmed pattern in
    Lexora's existing Aspose-conversion work - the same visual role as
    the w:shd-based header bars found throughout the DOCX side of this
    project) - captured with fill/stroke color and paint-order (via
    object index) preserved, so a later layering/z-order decision has
    the data it would need."""
    rects = []
    for i, r in enumerate(page.rects, start=1):
        entry = {
            "object_id": f"{page_id}_RECT_{i:03d}",
            "type": "rect",
            "fill": bool(r.get("fill")),
            "stroke": bool(r.get("stroke")),
            "fill_color": r.get("non_stroking_color"),
            "stroke_color": r.get("stroking_color"),
        }
        entry.update(_bbox_dict(r.get("x0"), r.get("top"), r.get("x1"), r.get("bottom")))
        rects.append(entry)
    return rects


def _extract_curves(page, page_id):
    curves = []
    for i, c in enumerate(page.curves, start=1):
        entry = {
            "object_id": f"{page_id}_CURVE_{i:03d}",
            "type": "curve",
            "fill": bool(c.get("fill")),
            "stroke": bool(c.get("stroke")),
            "num_points": len(c.get("pts") or []),
        }
        entry.update(_bbox_dict(c.get("x0"), c.get("top"), c.get("x1"), c.get("bottom")))
        curves.append(entry)
    return curves


def _json_safe(value):
    """Recursively converts any pdfplumber/pdfminer-internal value
    (e.g. PSLiteral color-space markers, tuples) into a plain,
    JSON-serializable form - confirmed necessary: some color/colorspace
    fields come back as pdfminer PSLiteral objects, not plain strings,
    which json.dump can't serialize on its own. Falls back to str()
    for anything still unrecognized, rather than crashing the whole
    analysis over one non-critical descriptive field."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    try:
        return str(value)
    except Exception:
        return None


def analyze_source_layout(pdf_path):
    """Runs the full Phase-1 layout analysis over every page of
    `pdf_path` and returns a plain-dict structural model (JSON-
    serializable as-is). Raises SourceLayoutAnalyzerError if
    pdfplumber isn't available or the file can't be opened - this
    deliberately does NOT fall back to a different extraction method
    the way lease_engine.py's text-only extract_text() does, since a
    silent fallback here could quietly produce a geometry model from a
    different (and differently-calibrated) source, which would defeat
    the purpose of proving what pdfplumber itself can see.

    No filename/page/coordinate/table/language-specific branching
    anywhere below - every object list is built purely from whatever
    pdfplumber reports for the actual file passed in."""
    if pdfplumber is None:
        raise SourceLayoutAnalyzerError("pdfplumber is not installed - run: pip install pdfplumber")
    if not os.path.isfile(pdf_path):
        raise SourceLayoutAnalyzerError(f"File not found: {pdf_path}")

    result = {
        "source_file": os.path.basename(pdf_path),
        "analyzer": "pdfplumber",
        "coordinate_system": "top-left origin, PDF points (1/72 inch), per-page - see module docstring",
        "page_count": 0,
        "pages": [],
    }

    with pdfplumber.open(pdf_path) as pdf:
        result["page_count"] = len(pdf.pages)
        for page_index, page in enumerate(pdf.pages):
            page_number = page_index + 1
            page_id = f"PAGE_{page_number:03d}"

            tables, table_error = _extract_tables(page, page_id)

            page_entry = {
                "page_id": page_id,
                "page_number": page_number,
                "width": _round2(page.width),
                "height": _round2(page.height),
                "rotation": getattr(page, "rotation", 0),
                "objects": {
                    "text_words": _extract_words(page, page_id),
                    "tables": tables,
                    "images": _extract_images(page, page_id),
                    "lines": _extract_lines(page, page_id),
                    "rects": _extract_rects(page, page_id),
                    "curves": _extract_curves(page, page_id),
                },
            }
            if table_error:
                page_entry["table_extraction_error"] = table_error
            result["pages"].append(page_entry)

    return _json_safe(result)


def analyze_source_layout_to_json_file(pdf_path, output_path, indent=2):
    """Convenience wrapper: runs analyze_source_layout and writes the
    result to output_path as JSON. Returns the same dict that was
    written, so a caller can inspect it without re-reading the file."""
    layout = analyze_source_layout(pdf_path)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(layout, f, indent=indent, ensure_ascii=False)
    return layout
