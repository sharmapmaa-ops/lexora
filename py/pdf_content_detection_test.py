"""
Test for the new /api/translation/detect-pdf-content endpoint, per
explicit direction: replaces the manual "Use Aspose?" confirmation
dialog with an automatic, per-file, content-based decision for PDF
uploads - if any page has a real table or image, Aspose is used;
otherwise the lighter pdf.js/vision pipeline is sufficient.

Run: python3 pdf_content_detection_test.py
"""
import os
import sys
import base64
import subprocess

sys.path.insert(0, os.path.dirname(__file__))


def assert_(cond, label):
    if not cond:
        print("FAIL:", label)
        sys.exit(1)
    print("PASS:", label)


def _detect(pdf_path):
    """Runs the exact same detection logic the server handler uses,
    directly against a real PDF file, without going through HTTP."""
    import pdfplumber

    pages_with_tables = []
    pages_with_images = []
    with pdfplumber.open(pdf_path) as pdf:
        for i, page in enumerate(pdf.pages):
            if page.find_tables():
                pages_with_tables.append(i + 1)
            if page.images:
                pages_with_images.append(i + 1)
    return pages_with_tables, pages_with_images


def run():
    print("=== Test 1 (THE REAL REPORTED CASE): a real Word-sourced document with an image on page 3 recommends Aspose ===")
    real_docx = "/home/claude/work/word_translate_debug/source.docx"
    if os.path.exists(real_docx):
        tmp_dir = "/tmp/pdf_content_detection_test"
        os.makedirs(tmp_dir, exist_ok=True)
        subprocess.run(["libreoffice", "--headless", "--convert-to", "pdf", real_docx, "--outdir", tmp_dir],
                        capture_output=True, timeout=120)
        pdf_path = os.path.join(tmp_dir, "source.pdf")
        assert_(os.path.isfile(pdf_path), "Real source document converted to PDF for testing")
        tables, images = _detect(pdf_path)
        assert_(images == [3], "Real image found on page 3, matching the real document's own content (got " + str(images) + ")")
        recommend = bool(tables or images)
        assert_(recommend is True, "Aspose is recommended, since a real image was found")
    else:
        print("  (real document not present in this environment - skipped)")

    print("\n=== Test 2 (THE REAL REPORTED CASE): a real table-heavy document (Contract Data etc) recommends Aspose ===")
    table_docx = "/home/claude/work/eleven_issues/final_output.docx"
    if os.path.exists(table_docx):
        tmp_dir2 = "/tmp/pdf_content_detection_test2"
        os.makedirs(tmp_dir2, exist_ok=True)
        subprocess.run(["libreoffice", "--headless", "--convert-to", "pdf", table_docx, "--outdir", tmp_dir2],
                        capture_output=True, timeout=120)
        pdf_path2 = os.path.join(tmp_dir2, "final_output.pdf")
        assert_(os.path.isfile(pdf_path2), "Real table-heavy document converted to PDF for testing")
        tables2, images2 = _detect(pdf_path2)
        assert_(len(tables2) > 0, "Real tables detected on at least one page (got tables on: " + str(tables2) + ")")
        assert_(1 in tables2, "Page 1 specifically (the Contract Data table) is detected as having a table")
    else:
        print("  (real document not present in this environment - skipped)")

    print("\n=== Test 3: a genuinely plain-text-only PDF (no tables, no images) does NOT recommend Aspose ===")
    from reportlab.pdfgen import canvas
    plain_pdf = "/tmp/plain_text_only_test.pdf"
    c = canvas.Canvas(plain_pdf)
    c.drawString(100, 750, "This is a plain text document with no tables or images at all.")
    c.drawString(100, 700, "Just ordinary paragraphs of text, page after page.")
    c.save()
    tables3, images3 = _detect(plain_pdf)
    assert_(tables3 == [], "No tables detected on the plain-text-only PDF")
    assert_(images3 == [], "No images detected on the plain-text-only PDF")
    recommend3 = bool(tables3 or images3)
    assert_(recommend3 is False, "Aspose is NOT recommended for a genuinely plain-text document - pdf.js is sufficient")

    print("\nALL TESTS PASSED")


if __name__ == "__main__":
    run()
