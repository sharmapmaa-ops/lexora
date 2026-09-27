"""
Empirical calibration for js/engine-ocr.js's FLAT_COMPACTION_RATIO.

This is NOT a guess - it's how the 0.85 value actually got chosen. Given
a real OCR-generated .docx (produced by the actual pipeline) that Word
was reported to render with more pages than the source PDF (5 pages for
a 3-page source), this script:

  1. Takes the real .docx's word/document.xml
  2. Uniformly scales every w:line and w:after value by a range of
     candidate ratios (1.00 down to 0.70)
  3. Rebuilds a valid .docx for each ratio
  4. Actually renders each one with LibreOffice (--headless --convert-to
     pdf) and reads the REAL resulting page count

No estimation, no simulation - direct measurement of what Word-family
rendering actually produces at each spacing level. Use this whenever
the compaction ratio needs recalibrating against a new reported case
(a different document's real density may need a different ratio).

Usage:
    python3 calibrate_compaction_ratio.py path/to/real_ocr_output.docx

Requires: libreoffice, pdfinfo (poppler-utils) on PATH.
"""
import sys
import os
import re
import zipfile
import shutil
import subprocess
import tempfile


def scale_docx_spacing(src_docx, ratio, out_docx):
    with zipfile.ZipFile(src_docx, "r") as z:
        doc_xml = z.read("word/document.xml").decode("utf-8")
        others = {n: z.read(n) for n in z.namelist() if n != "word/document.xml"}

    def scale_line(m):
        return f'w:line="{max(200, round(int(m.group(1)) * ratio))}"'

    def scale_after(m):
        return f'w:after="{max(0, round(int(m.group(1)) * ratio))}"'

    new_xml = re.sub(r'w:line="(\d+)"', scale_line, doc_xml)
    new_xml = re.sub(r'w:after="(\d+)"', scale_after, new_xml)

    with zipfile.ZipFile(out_docx, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("word/document.xml", new_xml)
        for name, data in others.items():
            z.writestr(name, data)


def render_page_count(docx_path, out_dir):
    subprocess.run(
        ["libreoffice", "--headless", "--convert-to", "pdf", docx_path, "--outdir", out_dir],
        capture_output=True, timeout=120,
    )
    pdf_path = os.path.join(out_dir, os.path.splitext(os.path.basename(docx_path))[0] + ".pdf")
    if not os.path.isfile(pdf_path):
        return None
    result = subprocess.run(["pdfinfo", pdf_path], capture_output=True, text=True)
    for line in result.stdout.splitlines():
        if line.startswith("Pages:"):
            return int(line.split(":")[1].strip())
    return None


def calibrate(src_docx, ratios=(1.00, 0.95, 0.90, 0.85, 0.80, 0.75, 0.70)):
    with tempfile.TemporaryDirectory() as tmp:
        print(f"Calibrating against: {src_docx}\n")
        results = {}
        for ratio in ratios:
            candidate = os.path.join(tmp, f"test_{ratio}.docx")
            scale_docx_spacing(src_docx, ratio, candidate)
            pages = render_page_count(candidate, tmp)
            results[ratio] = pages
            print(f"  ratio {ratio:.2f} -> {pages} pages")
        print("\nUse the lowest ratio that reaches the target page count, then apply")
        print("a small additional safety margin below it (real MS Word can render")
        print("slightly differently than LibreOffice).")
        return results


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    calibrate(sys.argv[1])
