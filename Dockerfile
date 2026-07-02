# Dockerfile for deploying this app anywhere that runs containers
# (Render, Railway, Fly.io, a plain VPS, etc). A Dockerfile is used
# specifically because the OCR fallback needs the `tesseract-ocr` SYSTEM
# package (not a pip package), and most platforms' native "detect a
# Python app and pip install" build path has no way to run apt-get - a
# container image is the reliable way to guarantee it's present.
FROM python:3.12-slim

# tesseract-ocr: OCR fallback for scanned PDFs (see py/lease_engine.py)
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Render (and most platforms) inject PORT at runtime - py/server.py already
# reads it via os.environ.get("PORT", 8000) and binds 0.0.0.0.
EXPOSE 8000
CMD ["python3", "py/server.py"]
