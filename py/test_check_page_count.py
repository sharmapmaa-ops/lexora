"""
Test for the core logic behind server.py's _handle_ocr_check_page_count
(the endpoint backing Solution 8's real feedback loop). Exercises the
exact LibreOffice-conversion + pdfplumber-page-count sequence the real
handler runs, against a real docx, rather than mocking it.

Run: python3 test_check_page_count.py path/to/some.docx
"""
import sys
import os
import subprocess
import tempfile


def check_page_count(docx_path):
    tmp_dir = tempfile.mkdtemp(prefix="test_pagecount_")
    try:
        result = subprocess.run(
            ["libreoffice", "--headless", "--convert-to", "pdf", docx_path, "--outdir", tmp_dir],
            capture_output=True, timeout=120,
        )
        pdf_name = os.path.splitext(os.path.basename(docx_path))[0] + ".pdf"
        pdf_path = os.path.join(tmp_dir, pdf_name)
        if not os.path.isfile(pdf_path):
            return None, result.stderr.decode(errors="replace")[:300]

        import pdfplumber
        with pdfplumber.open(pdf_path) as pdf:
            return len(pdf.pages), None
    finally:
        import shutil
        shutil.rmtree(tmp_dir, ignore_errors=True)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    pages, error = check_page_count(sys.argv[1])
    if error:
        print("FAIL:", error)
        sys.exit(1)
    print(f"PASS: real page count = {pages}")
