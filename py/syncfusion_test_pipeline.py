"""
Lexora - SYNCFUSION TEST PIPELINE (isolated, experimental, do-not-touch-anything-else)
========================================================================

WHY THIS FILE EXISTS
---------------------
This is a completely separate, standalone module for testing whether
Syncfusion's Document Processing SDK can produce a better layout-
preserving translated document than our existing CV-based pipeline
(translate_pipeline.py + lease_engine.py).

It does NOT touch, import, or affect:
  - translate_pipeline.py / lease_engine.py (the existing layout-
    preserving pipeline)
  - js/translation-offline.js (the client-side "Text-based" flowing
    translation pipeline that regular users go through today)

Nothing in the main app calls into this file. It is only reachable via
its own explicitly-separate admin-only test route (see server.py's
"/api/test/syncfusion-translate" handler, added alongside - not inside
- the real translation routes), so there is zero risk of this
experiment affecting real user-facing translation jobs while it's
being evaluated.

WHAT THIS ACTUALLY DOES
------------------------
Syncfusion's Document Processing SDK converts and manipulates document
FORMATS (PDF <-> Word <-> Excel, extracting/rebuilding structure) - it
does not translate text itself. So the flow here is:

  1. Extract text + structure from the source PDF - EITHER by calling
     Syncfusion's own Document Processing API (if reachable, see
     SYNCFUSION_API_BASE_URL below) for its PDF-to-Word conversion and
     table/text extraction, OR (until that's configured) by reusing our
     existing pdfplumber-based extraction as a stand-in so the rest of
     this pipeline can be exercised/tested even before Syncfusion's own
     service is wired up.
  2. Translate the extracted text via the SAME LLM call mechanism the
     rest of Lexora already uses (lease_engine.translate_text) - no new
     translation logic, so quality is comparable apples-to-apples
     against the existing pipelines.
  3. Feed the translated text back into Syncfusion's Word-generation
     API to rebuild the .docx with (per Syncfusion's own formatting-
     fidelity claims) better table/border/shading preservation than our
     hand-rolled DOCX XML building.

WHAT'S STILL NEEDED BEFORE THIS PRODUCES REAL RESULTS
--------------------------------------------------------
Syncfusion's Document Processing SDK has no native Python package - the
practical integration path for our Python backend is their self-hosted
Docker-based Document Processing API (a language-agnostic HTTP service:
https://github.com/syncfusion/document-processing-apis). That container
needs to actually be DEPLOYED somewhere reachable from this server, and
activated with your Community License key. Until both of those exist:
  - SYNCFUSION_API_BASE_URL (env var) is unset
  - SYNCFUSION_LICENSE_KEY (env var) is unset
  - every function below returns a clear "not configured yet" error
    instead of silently failing or producing fake output.
"""

import os
import json
import time
import uuid
import urllib.request
import urllib.error

import lease_engine as le


SYNCFUSION_API_BASE_URL = os.environ.get("SYNCFUSION_API_BASE_URL", "").rstrip("/")
SYNCFUSION_LICENSE_KEY = os.environ.get("SYNCFUSION_LICENSE_KEY", "")


class SyncfusionNotConfiguredError(Exception):
    """Raised whenever the Docker API URL or license key isn't set yet -
    distinct from a real API failure, so the test UI can show a clear
    "you still need to deploy/configure this" message instead of a
    generic error."""
    pass


def is_configured():
    return bool(SYNCFUSION_API_BASE_URL and SYNCFUSION_LICENSE_KEY)


def _require_configured():
    if not is_configured():
        missing = []
        if not SYNCFUSION_API_BASE_URL:
            missing.append("SYNCFUSION_API_BASE_URL")
        if not SYNCFUSION_LICENSE_KEY:
            missing.append("SYNCFUSION_LICENSE_KEY")
        raise SyncfusionNotConfiguredError(
            "Syncfusion test pipeline isn't configured yet - missing: " + ", ".join(missing) +
            ". Deploy the Syncfusion Document Processing API Docker container "
            "(https://github.com/syncfusion/document-processing-apis), then set "
            "these as environment variables and restart the server."
        )


def _build_multipart_body(fields, files):
    """Minimal multipart/form-data encoder using only the standard
    library - matches this project's existing convention (lease_engine.py
    uses urllib.request throughout, not the external `requests` package,
    which isn't in requirements.txt) rather than adding a new dependency
    just for this one experimental test module."""
    boundary = uuid.uuid4().hex
    parts = []
    for name, value in (fields or {}).items():
        parts.append(f"--{boundary}\r\n".encode())
        parts.append(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
        parts.append(str(value).encode() + b"\r\n")
    for name, (filename, filedata) in (files or {}).items():
        parts.append(f"--{boundary}\r\n".encode())
        parts.append(
            f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
            f'Content-Type: application/octet-stream\r\n\r\n'.encode()
        )
        parts.append(filedata + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    body = b"".join(parts)
    content_type = f"multipart/form-data; boundary={boundary}"
    return body, content_type


def _syncfusion_request(endpoint, files=None, data=None, timeout=120):
    """Thin wrapper around a call to the self-hosted Syncfusion Document
    Processing API. `endpoint` is the specific operation path (e.g.
    "pdf-to-word", "word-to-pdf") - exact paths depend on which image/
    version gets deployed, so this is intentionally generic rather than
    hardcoding assumptions about a container that isn't running yet."""
    _require_configured()
    url = f"{SYNCFUSION_API_BASE_URL}/{endpoint.lstrip('/')}"
    body, content_type = _build_multipart_body(data, files)
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", content_type)
    req.add_header("Authorization", f"Bearer {SYNCFUSION_LICENSE_KEY}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read(), dict(resp.headers)
    except urllib.error.HTTPError as err:
        raise RuntimeError(f"Syncfusion API call to '{endpoint}' failed: HTTP {err.code} - {err.read().decode(errors='replace')[:500]}")
    except urllib.error.URLError as err:
        raise RuntimeError(f"Syncfusion API call to '{endpoint}' failed to connect: {err.reason}")


def extract_text_via_syncfusion(pdf_path):
    """Extract page text/structure from the source PDF using Syncfusion's
    own PDF library, via the Docker API's extraction endpoint. Falls
    back to our existing pdfplumber-based extraction (lease_engine) if
    Syncfusion isn't configured yet, so this pipeline is still testable
    end-to-end (translation + Word-rebuild) even before the Docker
    container is deployed - the fallback is clearly logged, not silent,
    so test results are never mistaken for "this is what Syncfusion
    produced" when it's actually our own extractor underneath."""
    if not is_configured():
        text = le.extract_text(pdf_path)
        return {"text": text, "source": "fallback:pdfplumber (Syncfusion not configured)"}
    with open(pdf_path, "rb") as f:
        filedata = f.read()
    body, _headers = _syncfusion_request("pdf/extract-text", files={"file": (os.path.basename(pdf_path), filedata)})
    return {"text": body.decode(errors="replace"), "source": "syncfusion"}


def translate_via_existing_pipeline(text, target_language):
    """Reuses Lexora's own, already-tuned LLM translation call - the
    point of this test is to compare Syncfusion's DOCUMENT
    RECONSTRUCTION quality against our existing pipelines, not to test
    a different translation prompt/model. Same translation logic, only
    the document-rebuilding step changes between pipelines being
    compared."""
    llm_config = le.load_llm_config()
    translated, used_provider = le.translate_text(text, target_language, llm_config=llm_config)
    return {"translated_text": translated, "provider": used_provider}


def rebuild_docx_via_syncfusion(pdf_path, translated_text, output_path):
    """Feeds the translated text back through Syncfusion's Word-
    generation API to rebuild the .docx with the source PDF's structure
    (tables, formatting) as the template. Requires the Docker API to be
    configured - there is no meaningful fallback for this specific step
    (a fallback here would just be re-testing our EXISTING docx-builder,
    which defeats the point of the comparison), so this raises clearly
    if Syncfusion isn't set up yet rather than quietly producing
    misleading output."""
    _require_configured()
    with open(pdf_path, "rb") as f:
        filedata = f.read()
    body, _headers = _syncfusion_request(
        "pdf/rebuild-as-word",
        files={"file": (os.path.basename(pdf_path), filedata)},
        data={"translated_text": translated_text},
    )
    with open(output_path, "wb") as out:
        out.write(body)
    return output_path


def run_syncfusion_test(pdf_path, target_language, output_path):
    """Full test-pipeline run: extract -> translate -> rebuild. Returns a
    structured result (including which steps used a fallback vs the
    real Syncfusion API) so the test UI can show exactly what was and
    wasn't actually testing Syncfusion - important since some steps can
    run in fallback mode even while the Docker API isn't deployed yet,
    and it should never be ambiguous which parts of a given test run are
    real Syncfusion output."""
    log = []
    t0 = time.time()

    log.append(f"Configured: {is_configured()} (SYNCFUSION_API_BASE_URL set: {bool(SYNCFUSION_API_BASE_URL)}, SYNCFUSION_LICENSE_KEY set: {bool(SYNCFUSION_LICENSE_KEY)})")

    extraction = extract_text_via_syncfusion(pdf_path)
    log.append(f"Text extracted via {extraction['source']} ({len(extraction['text'])} chars) in {time.time()-t0:.1f}s")

    t1 = time.time()
    translation = translate_via_existing_pipeline(extraction["text"], target_language)
    log.append(f"Translated via {translation['provider']} in {time.time()-t1:.1f}s")

    t2 = time.time()
    rebuild_docx_via_syncfusion(pdf_path, translation["translated_text"], output_path)
    log.append(f"Word document rebuilt via Syncfusion in {time.time()-t2:.1f}s")

    return {
        "output_path": output_path,
        "log": log,
        "extraction_source": extraction["source"],
        "translation_provider": translation["provider"],
        "total_seconds": round(time.time() - t0, 1),
    }
