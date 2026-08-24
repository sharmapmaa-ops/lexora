"""
Regression test for _fix_table_overflow_indent's real bug fix: the
original correction formula ("content_width - total_w") was a NO-OP
for a table whose indent already landed EXACTLY at that boundary
(indent + width == content_width) - confirmed against a real reported
document where 4 Appendix tables had indent=1437/1438 (roughly double
every other table's 691-867 range), and the original fix reported
"4 fixed" while the visible indent never actually changed.

This test uses a synthetic docx built to reproduce the EXACT real
numbers found in that document (41 normal tables at indent 691-867,
4 anomalous tables at indent 1437-1438, all with the same real column
widths), rather than requiring the actual uploaded file to be present,
so it can run standalone and keep catching this regression.

Run: python3 table_indent_fix_test.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from docx import Document
from docx.shared import Twips
from docx.oxml.ns import qn
from docx.oxml import OxmlElement
import aspose_test_pipeline as asp


def assert_(cond, label):
    if not cond:
        print("FAIL:", label)
        sys.exit(1)
    print("PASS:", label)


def _make_table(doc, indent_twips, col_widths_twips):
    tbl = doc.add_table(rows=1, cols=len(col_widths_twips))
    tbl_el = tbl._tbl
    tblPr = tbl_el.find(qn("w:tblPr"))
    tblInd = OxmlElement("w:tblInd")
    tblInd.set(qn("w:type"), "dxa")
    tblInd.set(qn("w:w"), str(indent_twips))
    tblPr.append(tblInd)
    grid = tbl_el.find(qn("w:tblGrid"))
    for gc, w in zip(grid.findall(qn("w:gridCol")), col_widths_twips):
        gc.set(qn("w:w"), str(w))
    return tbl_el


def run():
    doc = Document()
    sec = doc.sections[0]
    # Match the real document's geometry closely enough that
    # content_width_twips comes out to the same real value (10860).
    sec.page_width = Twips(11900)
    sec.page_height = Twips(16840)
    sec.left_margin = Twips(540)
    sec.right_margin = Twips(500)

    # 41 normal tables (real widths/indents from the actual document,
    # a representative sample of the observed 691/771/867 values).
    normal_indents = [867, 771, 867, 867, 771, 691, 691, 691, 867, 771,
                       691, 691, 771, 771, 691, 691, 867, 867, 771, 771,
                       771, 771, 771, 771, 771, 771, 867, 867, 771, 771,
                       861, 867, 771, 771, 771, 691, 771, 691, 691, 830, 830]
    for ind in normal_indents:
        _make_table(doc, ind, [940, 1986, 6497])  # sums to 9423, same shape as the real anomalous tables

    # 4 real anomalous tables (the exact reported case).
    anomalous_els = []
    for ind in (1437, 1437, 1438, 1438):
        anomalous_els.append(_make_table(doc, ind, [940, 1986, 6497]))

    print("=== Test 1: content width matches the real document's real value ===")
    content_width_twips = round((sec.page_width - sec.left_margin - sec.right_margin) / 635)
    assert_(content_width_twips == 10860, "content_width_twips is 10860, matching the real reported document")

    print("\n=== Test 2: the fix reports exactly 4 tables fixed ===")
    fixed = asp._fix_table_overflow_indent(doc)
    assert_(fixed == 4, "Exactly 4 tables reported as fixed (got " + str(fixed) + ")")

    print("\n=== Test 3: the fix produces a REAL, visible change (not the no-op from the original bug) ===")
    for i, tbl_el in enumerate(anomalous_els):
        tblPr = tbl_el.find(qn("w:tblPr"))
        tblInd = tblPr.find(qn("w:tblInd"))
        new_val = int(tblInd.get(qn("w:w")))
        assert_(new_val != 1437 and new_val != 1438, "Anomalous table " + str(i) + "'s indent genuinely changed (is now " + str(new_val) + ", was 1437/1438)")

    print("\n=== Test 4: anomalous tables now match their siblings' real median indent ===")
    for i, tbl_el in enumerate(anomalous_els):
        tblPr = tbl_el.find(qn("w:tblPr"))
        tblInd = tblPr.find(qn("w:tblInd"))
        new_val = int(tblInd.get(qn("w:w")))
        assert_(new_val == 771, "Anomalous table " + str(i) + "'s indent is now 771 (the real median of the 41 normal tables) - got " + str(new_val))

    print("\n=== Test 5: normal tables are completely untouched ===")
    all_tbls = list(doc.element.body.iter(qn("w:tbl")))
    normal_tbl_els = all_tbls[:41]
    all_unchanged = True
    for i, (tbl_el, expected) in enumerate(zip(normal_tbl_els, normal_indents)):
        tblPr = tbl_el.find(qn("w:tblPr"))
        tblInd = tblPr.find(qn("w:tblInd"))
        actual = int(tblInd.get(qn("w:w")))
        if actual != expected:
            all_unchanged = False
            print("  unexpected change at table", i, ":", expected, "->", actual)
    assert_(all_unchanged, "All 41 normal tables retain their original indent exactly")

    print("\nALL TESTS PASSED")


if __name__ == "__main__":
    run()
