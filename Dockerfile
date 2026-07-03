# Dockerfile for deploying this app anywhere that runs containers
# (Render, Railway, Fly.io, a plain VPS, etc). A Dockerfile is used
# specifically because the OCR fallback needs the `tesseract-ocr` SYSTEM
# package (not a pip package), and most platforms' native "detect a
# Python app and pip install" build path has no way to run apt-get - a
# container image is the reliable way to guarantee it's present.
FROM python:3.12-slim

# tesseract-ocr: OCR fallback for scanned PDFs (see py/lease_engine.py).
# The -ara/-hin/-fra/-spa/-deu language packs are needed so OCR can
# actually READ text in those scripts/languages on a scanned/image-only
# source document (item 6 - translating a scanned Arabic/Hindi/etc.
# poster or lease requires OCR to recognize that script first, not just
# English) - add more `tesseract-ocr-<lang>` packages here if a language
# your documents use isn't in this list (see `apt list tesseract-ocr-*`
# in the container, or https://github.com/tesseract-ocr/tessdata for the
# full set of 3-letter codes).
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    tesseract-ocr-ara \
    tesseract-ocr-hin \
    tesseract-ocr-fra \
    tesseract-ocr-spa \
    tesseract-ocr-deu \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Render (and most platforms) inject PORT at runtime - py/server.py already
# reads it via os.environ.get("PORT", 8000) and binds 0.0.0.0.
EXPOSE 8000
CMD ["python3", "-u", "py/server.py"]
