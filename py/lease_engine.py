#!/usr/bin/env python3
"""
Lease Abstraction processing engine.

Implements the real (non-simulated) steps behind the Lease Abstraction
workflow described in the project requirements (section 14):

  1. extract_text(path)        -> raw text pulled out of the uploaded PDF/DOCX.
                                   Tries pdfplumber, then pypdf, then falls
                                   back to real OCR (pytesseract) if both
                                   extract almost nothing - handles PDFs
                                   that are actually scanned page images
                                   with no usable text layer.
  2. analyze_lease(text, name) -> document-type classification + extracted
                                   lease fields + an accuracy/confidence
                                   score. Uses a real OpenAI/OpenRouter call
                                   (json/extraction_prompt.txt as the system
                                   prompt) when json/llm-config.json has an
                                   API key configured; otherwise falls back
                                   to a deterministic regex/keyword engine.
  3. generate_output_pdf(...)  -> builds Output.pdf from Output.json, laid
                                   out the same way as the default template

ABOUT THE LLM EXTRACTION:
json/extraction_prompt.txt is a detailed system prompt (attorney-grade
commercial lease abstraction rules) and json/rules.json is the same rule
set in structured form (used for reference/governance - its rules are
already folded into extraction_prompt.txt, so it isn't re-injected into
the prompt verbatim to avoid doubling token usage). When a key is present
in json/llm-config.json, call_llm_extraction() sends the extracted lease
text to OpenAI or OpenRouter (chat completions) and returns the rich
structured JSON described in extraction_prompt.txt's OUTPUT FORMAT
section. Without a key, analyze_lease() falls back to the simpler
heuristic engine below. A second, lighter LLM call (call_llm_validation)
then reviews that JSON for completeness and returns a confidence/accuracy
score - the same two-pass extract-then-validate shape used by the
reference project, just condensed into one pipeline step (section 14.3's
40% checkpoint) instead of two separate API routes.

Uses pdfplumber (PDF text + page rendering), pypdf (secondary text
extraction), pytesseract (OCR for scanned/image-only PDFs), python-docx
(DOCX text) and reportlab (PDF generation) - see requirements.txt. All are
optional at import time so the server still runs (with reduced
functionality / clear errors) if one hasn't been installed yet. The LLM
call itself only needs the standard library (urllib) - no extra HTTP
client dependency. OCR also needs the `tesseract-ocr` system package
(not a pip package) - see requirements.txt / devcontainer.json.
"""

import io
import json
import os
import re
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

try:
    import pdfplumber
except ImportError:
    pdfplumber = None

try:
    from pypdf import PdfReader
except ImportError:
    PdfReader = None

try:
    import pytesseract
    from PIL import Image
    OCR_LIBS_OK = True
except ImportError:
    OCR_LIBS_OK = False

try:
    import docx as docx_lib
except ImportError:
    docx_lib = None

try:
    from reportlab.lib.pagesizes import LETTER
    from reportlab.lib.units import inch
    from reportlab.lib import colors
    from reportlab.platypus import (
        SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable
    )
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    REPORTLAB_OK = True
except ImportError:
    REPORTLAB_OK = False


class LeaseEngineError(Exception):
    pass


# lease_engine.py lives in py/, json/ is a sibling of py/ under the project root.
JSON_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "json")
LLM_CONFIG_PATH = os.path.join(JSON_DIR, "llm-config.json")
EXTRACTION_PROMPT_PATH = os.path.join(JSON_DIR, "extraction_prompt.txt")

# Below this many extracted characters, the text is almost certainly just
# an artifact (e.g. a DocuSign "Envelope ID" stamp) rather than real body
# text - matches the threshold the reference project uses to decide when
# to fall back to a second extraction method. Applied both as a flat
# minimum and per-page (a multi-page doc where every page contributes
# only a tiny stamp can otherwise still clear a flat total threshold).
MIN_USABLE_TEXT_CHARS = 200
MIN_CHARS_PER_PAGE = 150
# Cap on parallel OCR workers - actual worker count is also capped by
# os.cpu_count() and the page count at call time, this is just an upper
# bound so a huge document doesn't spawn an unreasonable number of
# tesseract subprocesses at once.
OCR_MAX_WORKERS = 6


def load_llm_config():
    try:
        with open(LLM_CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def _get_primary(items):
    """Returns the item flagged primary=true, or the first item if none is
    flagged, or None if the list is empty - lets an admin add several
    OpenAI/OpenRouter keys in json/llm-config.json and mark which one is
    actually used."""
    if not items:
        return None
    for item in items:
        if item.get("primary"):
            return item
    return items[0]



# API keys are intentionally NOT stored in json/llm-config.json (that file
# is committed to git). Instead each provider's key is read from an
# environment variable - set these as Codespace/deployment secrets, or in
# a local, git-ignored .env file loaded by start-server.sh. If a "keys"
# entry in llm-config.json still carries a literal, non-empty apiKey
# (e.g. an older config), it's used as a last-resort fallback so nothing
# breaks - but new/edited configs should leave apiKey empty ("") and rely
# on the environment variable instead.
_PROVIDER_ENV_VARS = {
    "openai": "OPENAI_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
}


def _resolve_provider_cfg(llm_config, provider):
    """Flattens json/llm-config.json's {baseUrl, keys: [...]} shape into
    the single {apiKey, model, baseUrl} dict _call_chat_completion expects,
    using whichever key is flagged primary. The actual secret comes from
    the provider's environment variable first, falling back to a literal
    apiKey in the JSON only if the env var isn't set."""
    provider_section = llm_config.get(provider, {}) or {}
    primary_key = _get_primary(provider_section.get("keys") or [])
    if not primary_key:
        return {}
    env_var = _PROVIDER_ENV_VARS.get(provider)
    api_key = (os.environ.get(env_var) if env_var else None) or primary_key.get("apiKey") or ""
    return {
        "apiKey": api_key,
        "model": primary_key.get("model"),
        "baseUrl": provider_section.get("baseUrl"),
    }


def load_extraction_prompt():
    try:
        with open(EXTRACTION_PROMPT_PATH, "r", encoding="utf-8") as f:
            return f.read()
    except OSError:
        return None


def robust_json_parse(raw):
    """Same multi-pass strategy as the reference project's robust_json_parse:
    try a direct parse, then strip markdown fences, then pull out the first
    balanced {...} block. Returns None if nothing works so the caller can
    decide how to fall back."""
    if not raw:
        return None
    raw = raw.strip()

    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        pass

    cleaned = re.sub(r"```(?:json)?", "", raw).strip()
    try:
        return json.loads(cleaned)
    except (json.JSONDecodeError, TypeError):
        pass

    m = re.search(r"(\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})", cleaned, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(1))
        except (json.JSONDecodeError, TypeError):
            pass

    return None


def _call_chat_completion(provider, provider_cfg, system_prompt, user_content, max_tokens=16000):
    """Shared OpenAI/OpenRouter chat-completions call. Returns the raw
    response text (the caller decides how to parse it) or raises
    LeaseEngineError. No response_format is sent - not every OpenRouter
    model supports it, so (matching the reference project) we rely on the
    prompt's own "return ONLY JSON" instruction plus robust_json_parse on
    the way out instead."""
    api_key = (provider_cfg.get("apiKey") or "").strip()
    if not api_key:
        return None

    model = provider_cfg.get("model") or "gpt-4o"
    url = provider_cfg.get("baseUrl") or (
        "https://openrouter.ai/api/v1/chat/completions" if provider == "openrouter"
        else "https://api.openai.com/v1/chat/completions"
    )

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        "temperature": 0,
        "max_tokens": max_tokens,
    }
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }
    if provider == "openrouter":
        # OpenRouter asks for these but doesn't require them - harmless if generic.
        headers["HTTP-Referer"] = "https://lexora.ai"
        headers["X-Title"] = "Lexora Lease Abstraction"

    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", errors="ignore")[:500]
        raise LeaseEngineError(f"{provider} API error {err.code}: {detail}")
    except urllib.error.URLError as err:
        raise LeaseEngineError(f"Could not reach {provider} API: {err.reason}")

    try:
        return data["choices"][0]["message"]["content"]
    except (KeyError, IndexError) as err:
        raise LeaseEngineError(f"{provider} returned an unexpected response shape: {err}")


def call_llm_extraction(text, llm_config=None):
    """Calls OpenAI or OpenRouter (whichever is set as "provider" in
    json/llm-config.json) using json/extraction_prompt.txt as the system
    prompt. Returns the parsed JSON dict on success, or None if no API key
    is configured / the prompt file is missing (caller should fall back to
    the heuristic engine). Raises LeaseEngineError on a real call failure
    (key present but request/parse failed) so the caller can decide whether
    to fall back or surface the error."""
    llm_config = llm_config if llm_config is not None else load_llm_config()
    provider = llm_config.get("provider", "openai")
    provider_cfg = _resolve_provider_cfg(llm_config, provider)

    system_prompt = load_extraction_prompt()
    if not system_prompt:
        return None  # no prompt file - caller falls back to heuristic

    content = _call_chat_completion(
        provider, provider_cfg, system_prompt,
        "LEASE DOCUMENT TEXT:\n\n" + text[:120000],
        max_tokens=16000,
    )
    if content is None:
        return None  # no API key configured - caller falls back to heuristic

    parsed = robust_json_parse(content)
    if parsed is None:
        raise LeaseEngineError(f"{provider} returned a response that isn't valid JSON")
    return parsed


VALIDATION_SYSTEM_PROMPT = "You are a lease abstraction QC validator. Return ONLY valid JSON."


def call_llm_validation(fields, llm_config=None):
    """Second pass over the extracted fields - same shape as the reference
    project's /api/validate route. Returns a dict with confidence_score
    (0.0-1.0), missing_fields, low_confidence_fields, and a one-line
    summary, or None if no LLM is configured (caller falls back to a
    heuristic completeness score)."""
    llm_config = llm_config if llm_config is not None else load_llm_config()
    provider = llm_config.get("provider", "openai")
    provider_cfg = _resolve_provider_cfg(llm_config, provider)

    prompt = (
        "Analyze this lease extraction for completeness and accuracy.\n"
        "Return ONLY valid JSON - no markdown, no code fences:\n"
        "{\n"
        '  "is_valid": true or false,\n'
        '  "confidence_score": 0.0-1.0,\n'
        '  "missing_fields": ["field1", "field2"],\n'
        '  "low_confidence_fields": ["field1"],\n'
        '  "summary": "one sentence QC summary"\n'
        "}\n\n"
        "Extracted lease data:\n" + json.dumps(fields, indent=2)[:8000]
    )

    content = _call_chat_completion(
        provider, provider_cfg, VALIDATION_SYSTEM_PROMPT, prompt, max_tokens=2000
    )
    if content is None:
        return None

    parsed = robust_json_parse(content)
    if parsed is None:
        raise LeaseEngineError(f"{provider} validation response wasn't valid JSON")
    return parsed


def heuristic_accuracy(fields):
    """Fallback 'accuracy' when no LLM is configured: percentage of leaf
    values that aren't a placeholder like 'Not found in document' /
    'Lease is silent.' - a rough completeness proxy, not a real QC pass."""
    placeholders = {"not found in document", "lease is silent.", "", None}
    leaves = []

    def walk(v):
        if isinstance(v, dict):
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)
        else:
            leaves.append(v)

    walk(fields)
    if not leaves:
        return {"confidence_score": 0.0, "summary": "No fields extracted.", "missing_fields": [], "low_confidence_fields": []}

    filled = sum(1 for v in leaves if str(v).strip().lower() not in placeholders)
    score = filled / len(leaves)
    return {
        "confidence_score": round(score, 2),
        "summary": f"{filled}/{len(leaves)} fields populated (heuristic completeness check, no LLM configured).",
        "missing_fields": [],
        "low_confidence_fields": [],
    }


# ============================================================
# 1. TEXT EXTRACTION (pdfplumber -> pypdf -> real OCR fallback)
# ============================================================
def _extract_text_pdfplumber(file_path):
    if not pdfplumber:
        return ""
    text_parts = []
    with pdfplumber.open(file_path) as pdf:
        for page in pdf.pages:
            try:
                text_parts.append(page.extract_text() or "")
            except Exception:
                text_parts.append("")
    return "\n\n".join(text_parts).strip()


def _extract_text_pypdf(file_path):
    if not PdfReader:
        return ""
    reader = PdfReader(file_path)
    text_parts = []
    for page in reader.pages:
        try:
            text_parts.append(page.extract_text() or "")
        except Exception:
            text_parts.append("")
    return "\n\n".join(text_parts).strip()


def _ocr_one_page(page, page_index):
    try:
        # 150 DPI + LSTM-only engine is meaningfully faster than the
        # 200 DPI / default-engine combo with no real accuracy loss on
        # typical scanned lease pages, and matters a lot here: OCR-ing a
        # long document one page at a time inside a single HTTP request
        # can otherwise run long enough to hit a proxy/gateway timeout
        # (this is what was causing "/api/lease/extract failed" on a
        # large scanned PDF during testing).
        image = page.to_image(resolution=150).original
        text = pytesseract.image_to_string(image, config="--oem 1 --psm 6") or ""
    except Exception:
        text = ""
    return page_index, text


def _extract_text_ocr(file_path, on_progress=None):
    """Renders every page to an image and runs Tesseract OCR on it - the
    real fallback for PDFs that are actually scanned page images with no
    usable text layer at all (pdfplumber/pypdf both come back nearly
    empty on these, even when the filename says "_ocr"). Needs pdfplumber
    (for page rendering - already a dependency) plus pytesseract and the
    tesseract-ocr system package. Pages are OCR'd in parallel (tesseract
    runs as a real subprocess per call, so this isn't GIL-limited) - a
    meaningful speedup on multi-core machines. This is called from a
    background thread (see server.py's /api/lease/extract-start), not
    inline in an HTTP request, specifically so a slow multi-page OCR run
    never risks tripping a reverse-proxy/gateway timeout - on_progress(done,
    total) lets the caller report live status while it works."""
    if not pdfplumber or not OCR_LIBS_OK:
        return ""

    with pdfplumber.open(file_path) as pdf:
        pages = list(pdf.pages)
        total = len(pages)
        worker_count = min(OCR_MAX_WORKERS, max(1, os.cpu_count() or 1), total) or 1
        results = [""] * total
        done_count = 0

        if on_progress:
            on_progress(0, total)

        if worker_count <= 1:
            for i, page in enumerate(pages):
                _, text = _ocr_one_page(page, i)
                results[i] = text
                done_count += 1
                if on_progress:
                    on_progress(done_count, total)
        else:
            with ThreadPoolExecutor(max_workers=worker_count) as executor:
                futures = [executor.submit(_ocr_one_page, page, i) for i, page in enumerate(pages)]
                for future in as_completed(futures):
                    i, text = future.result()
                    results[i] = text
                    done_count += 1
                    if on_progress:
                        on_progress(done_count, total)

    return "\n\n".join(results).strip()


def extract_text(file_path, on_progress=None):
    """Returns the raw text content of a PDF or DOCX file. For PDFs, tries
    pdfplumber first, then pypdf, and - only if both come back with almost
    nothing PER PAGE ON AVERAGE (a strong sign the PDF is actually scanned
    page images with no real text layer, as opposed to a text-based PDF -
    e.g. a multi-page document where every page only contributes a tiny
    "DocuSign Envelope ID" stamp can still add up past a flat character
    threshold in aggregate, which is why this is a per-page average, not a
    total) - falls back to real OCR via Tesseract. Whichever method
    returns the most text wins."""
    ext = os.path.splitext(file_path)[1].lower()

    if ext == ".pdf":
        if not pdfplumber and not PdfReader:
            raise LeaseEngineError(
                "pdfplumber/pypdf are not installed - run: pip install -r requirements.txt"
            )

        page_count = 1
        if pdfplumber:
            try:
                with pdfplumber.open(file_path) as pdf:
                    page_count = max(len(pdf.pages), 1)
            except Exception:
                pass

        min_chars_needed = max(MIN_USABLE_TEXT_CHARS, page_count * MIN_CHARS_PER_PAGE)

        best_text = ""
        best_method = None

        try:
            plumber_text = _extract_text_pdfplumber(file_path)
        except Exception:
            plumber_text = ""
        if len(plumber_text) > len(best_text):
            best_text, best_method = plumber_text, "pdfplumber"

        if len(best_text) < min_chars_needed:
            try:
                pypdf_text = _extract_text_pypdf(file_path)
            except Exception:
                pypdf_text = ""
            if len(pypdf_text) > len(best_text):
                best_text, best_method = pypdf_text, "pypdf"

        if len(best_text) < min_chars_needed:
            if not OCR_LIBS_OK:
                # Nothing more we can do without OCR libraries - return
                # whatever little text was found (e.g. just a DocuSign
                # envelope stamp on every page) rather than hard-failing,
                # and let the caller's classification logic report
                # "Invalid Document" with a clear reason instead of
                # crashing outright.
                print(
                    f"WARNING: {os.path.basename(file_path)} looks like a scanned/image-only PDF "
                    f"(only {len(best_text)} chars across {page_count} pages from text layers) and "
                    f"pytesseract/Pillow aren't installed, so OCR couldn't run. Install tesseract-ocr "
                    f"+ pytesseract - see requirements.txt."
                )
            else:
                try:
                    ocr_text = _extract_text_ocr(file_path, on_progress=on_progress)
                except Exception as err:
                    ocr_text = ""
                    print(f"OCR fallback failed for {os.path.basename(file_path)}: {err}")
                if len(ocr_text) > len(best_text):
                    best_text, best_method = ocr_text, "ocr"

        return best_text

    if ext == ".docx":
        if not docx_lib:
            raise LeaseEngineError(
                "python-docx is not installed - run: pip install -r requirements.txt"
            )
        document = docx_lib.Document(file_path)
        return "\n".join(p.text for p in document.paragraphs).strip()

    raise LeaseEngineError(f"Unsupported file type for text extraction: {ext}")


# ============================================================
# 2. HEURISTIC "GPT PROMPT" STAND-IN - document classification +
#    lease field extraction (see module docstring)
# ============================================================
LEASE_KEYWORDS = [
    "lease agreement", "this lease", "landlord", "tenant", "lessor", "lessee",
    "premises", "rent shall", "commencement date", "term of this lease",
    "leased premises", "monthly rent", "security deposit"
]
# STRONG phrases only show up in documents that ARE actually an amendment
# (they announce themselves as one). WEAK words like "amendment"/"amended"
# on their own are extremely common even inside a plain, original lease -
# e.g. "...including all amendments thereto..." (a document list clause) or
# "...altered, amended, or revoked only by an instrument in writing..." (a
# boilerplate entire-agreement clause) - so a couple of incidental
# occurrences must never be enough by themselves to override overwhelming
# lease-document evidence (this is exactly what caused a real, 26-page
# original lease to get misclassified as "Amendment" during testing).
STRONG_AMENDMENT_KEYWORDS = [
    "first amendment", "second amendment", "third amendment", "fourth amendment",
    "this amendment", "hereby amends", "amendment to lease", "amendment to that certain lease",
    "amendment no.", "lease amendment agreement",
]
WEAK_AMENDMENT_KEYWORDS = ["amendment", "amended", "addendum", "modification of lease"]


def classify_document(text):
    """Returns 'Lease', 'Amendment', or 'Other' based on keyword scoring."""
    lower = text.lower()
    lease_score = sum(1 for kw in LEASE_KEYWORDS if kw in lower)
    has_strong_amendment = any(kw in lower for kw in STRONG_AMENDMENT_KEYWORDS)
    weak_amendment_hits = sum(lower.count(kw) for kw in WEAK_AMENDMENT_KEYWORDS)

    if has_strong_amendment:
        return "Amendment"
    # Several incidental mentions AND weak overall lease evidence - more
    # likely a genuine (if informally worded) amendment than a full lease.
    if weak_amendment_hits >= 3 and lease_score < 2:
        return "Amendment"
    if lease_score >= 2:
        return "Lease"
    return "Other"


_MONEY_RE = re.compile(r"\$\s?([\d,]+(?:\.\d{2})?)")
_DATE_RE = re.compile(
    r"(January|February|March|April|May|June|July|August|September|October|"
    r"November|December)\s+\d{1,2},?\s+\d{4}|\d{1,2}/\d{1,2}/\d{2,4}|\d{4}-\d{2}-\d{2}"
)


def _find_party_name(text, role_words):
    """Looks for two common lease phrasings:
       1) 'Landlord: Acme Holdings LLC'                (label form)
       2) 'Acme Holdings LLC ("Landlord")' / '(Landlord)' (parenthetical form)
    """
    label_value = _find_after_label(text, role_words)
    if label_value:
        return label_value

    for role in role_words:
        pattern = re.compile(
            r'((?:[A-Z][A-Za-z0-9&\.\-\']*\s+){0,5}[A-Z][A-Za-z0-9&\.\-\']*)\s*\(\s*["\u201c]?'
            r'(?i:' + re.escape(role) + r')["\u201d]?\s*\)'
        )
        m = pattern.search(text)
        if m:
            value = re.sub(r"\s+", " ", m.group(1)).strip().rstrip(',')
            return value
    return None


def _find_after_label(text, labels):
    """Looks for 'Label: value' or 'Label - value' style lines and returns the value."""
    for label in labels:
        pattern = re.compile(re.escape(label) + r"\s*[:\-]\s*(.+)", re.IGNORECASE)
        m = pattern.search(text)
        if m:
            value = m.group(1).strip()
            value = re.split(r"[\n\r]", value)[0].strip()
            if value:
                return value[:120]
    return None


def heuristic_analyze_lease(text, fallback_name="Lease Document"):
    """Deterministic regex/keyword field extraction - used when no LLM key
    is configured in json/llm-config.json (see analyze_lease below)."""
    doc_type = classify_document(text)

    tenant = _find_party_name(text, ["Tenant", "Lessee"])
    landlord = _find_party_name(text, ["Landlord", "Lessor"])
    property_address = _find_after_label(
        text, ["Premises", "Property Address", "Leased Premises", "Address"]
    )

    all_dates = [m.group(0) for m in _DATE_RE.finditer(text)]

    lease_start = all_dates[0] if len(all_dates) > 0 else None
    lease_end = all_dates[1] if len(all_dates) > 1 else None

    money_matches = _MONEY_RE.findall(text)
    base_rent = money_matches[0] if money_matches else None

    lease_name_source = tenant or property_address or fallback_name
    lease_name = sanitize_lease_name(lease_name_source)

    fields = {
        "documentType": doc_type,
        "tenant": tenant or "Not found in document",
        "landlord": landlord or "Not found in document",
        "propertyAddress": property_address or "Not found in document",
        "leaseStart": lease_start or "Not found in document",
        "leaseEnd": lease_end or "Not found in document",
        "baseRent": base_rent or "Not found in document",
        "currency": "USD",
    }

    return {
        "docType": doc_type,
        "leaseName": lease_name,
        "fields": fields,
        "extractionMethod": "heuristic",
    }


def _lease_name_source_from_fields(fields, fallback_name):
    """Works with either the rich LLM schema (fields.parties.tenant_legal_name,
    fields.premises.property_address, ...) or the flat heuristic schema
    (fields.tenant, fields.propertyAddress, ...)."""
    parties = fields.get("parties")
    if isinstance(parties, dict):
        name = parties.get("tenant_legal_name") or parties.get("landlord_legal_name")
        if name:
            return name
    premises = fields.get("premises")
    if isinstance(premises, dict) and premises.get("property_address"):
        return premises["property_address"]

    if fields.get("tenant") and fields["tenant"] != "Not found in document":
        return fields["tenant"]
    if fields.get("propertyAddress") and fields["propertyAddress"] != "Not found in document":
        return fields["propertyAddress"]

    return fallback_name


def _run_accuracy_check(fields, llm_config):
    """Runs the validation/accuracy pass and normalizes it into
    {accuracy: 0-100 int, accuracySummary: str, missingFields: [...],
    lowConfidenceFields: [...]}. Never raises - a failed/unavailable
    accuracy check shouldn't take down an otherwise-successful extraction."""
    try:
        validation = call_llm_validation(fields, llm_config=llm_config)
    except LeaseEngineError as err:
        print(f"Accuracy validation call failed, using heuristic completeness instead: {err}")
        validation = None

    used_llm = validation is not None
    if validation is None:
        validation = heuristic_accuracy(fields)

    try:
        score = float(validation.get("confidence_score", 0))
    except (TypeError, ValueError):
        score = 0.0
    score = max(0.0, min(1.0, score))

    return {
        "accuracy": round(score * 100),
        "accuracyMethod": "llm-validation" if used_llm else "heuristic-completeness",
        "accuracySummary": validation.get("summary") or "",
        "missingFields": validation.get("missing_fields") or [],
        "lowConfidenceFields": validation.get("low_confidence_fields") or [],
    }


def analyze_lease(text, fallback_name="Lease Document"):
    """Section 14.3 (40%) - 'data analyzed and interpreted using GPT
    prompts'. Tries a real LLM call (OpenAI/OpenRouter, json/llm-config.json
    + json/extraction_prompt.txt) first; falls back to the heuristic engine
    if no key is configured or the call fails. Either way, also runs a
    second lightweight pass (call_llm_validation, or a heuristic
    completeness check without an LLM) to produce an accuracy/confidence
    score - same two-stage extract-then-validate shape as the reference
    project's /api/extract + /api/validate routes."""
    doc_type = classify_document(text)
    llm_config = load_llm_config()

    try:
        llm_fields = call_llm_extraction(text, llm_config=llm_config)
    except LeaseEngineError as err:
        # Key was present but the call failed - fall back rather than
        # aborting the whole pipeline, but keep the error visible.
        print(f"LLM extraction failed, falling back to heuristic engine: {err}")
        llm_fields = None

    if llm_fields is not None:
        provider = llm_config.get("provider", "openai")
        lease_name = sanitize_lease_name(_lease_name_source_from_fields(llm_fields, fallback_name))
        result = {
            "docType": doc_type,
            "leaseName": lease_name,
            "fields": llm_fields,
            "extractionMethod": f"llm-{provider}",
        }
    else:
        result = heuristic_analyze_lease(text, fallback_name=fallback_name)
        result["docType"] = doc_type  # keep a single source of truth for classification

    result.update(_run_accuracy_check(result["fields"], llm_config))
    return result


def sanitize_lease_name(raw):
    """Turns extracted text into a filesystem-safe folder name."""
    raw = raw or "Lease"
    cleaned = re.sub(r"[^A-Za-z0-9 _\-]", "", raw).strip()
    cleaned = re.sub(r"\s+", "_", cleaned)
    return cleaned[:60] or "Lease"


# ============================================================
# 3. OUTPUT PDF GENERATION
# ============================================================
def _humanize_key(key):
    return str(key).replace("_", " ").strip().title()


def _stringify_leaf(value):
    if value is None or value == "":
        return "-"
    return str(value)


def _flatten_to_rows(value, prefix=""):
    """Recursively flattens a dict/list into (label, value) row pairs -
    used so the PDF can render either the flat heuristic fields dict or
    the rich nested LLM schema (parties/premises/term/rent/... sections,
    each of which may itself contain lists like rent_schedule or
    queries_assumptions) without hardcoding every possible field name."""
    rows = []
    if isinstance(value, dict):
        if not value:
            rows.append((prefix.rstrip(" -") or "Value", "-"))
        for k, v in value.items():
            label = (prefix + _humanize_key(k)) if prefix else _humanize_key(k)
            if isinstance(v, (dict, list)):
                rows.extend(_flatten_to_rows(v, label + " - "))
            else:
                rows.append((label, _stringify_leaf(v)))
    elif isinstance(value, list):
        if not value:
            rows.append((prefix.rstrip(" -") or "Value", "-"))
        for i, item in enumerate(value):
            item_prefix = f"{prefix}#{i + 1} "
            if isinstance(item, (dict, list)):
                rows.extend(_flatten_to_rows(item, item_prefix))
            else:
                rows.append((item_prefix.strip(), _stringify_leaf(item)))
    else:
        rows.append((prefix.rstrip(" -") or "Value", _stringify_leaf(value)))
    return rows


def _build_kv_table(rows, col_widths=(2.3 * inch, 3.7 * inch)):
    from xml.sax.saxutils import escape as _esc

    cell_style = ParagraphStyle("KVCell", fontSize=8.5, leading=11)
    header_style = ParagraphStyle(
        "KVHeader", fontSize=8.5, leading=11, textColor=colors.white, fontName="Helvetica-Bold"
    )
    table_data = [[Paragraph("Field", header_style), Paragraph("Value", header_style)]]
    for label, value in rows:
        table_data.append([
            Paragraph(_esc(str(label)), cell_style),
            Paragraph(_esc(str(value)).replace("\n", "<br/>"), cell_style),
        ])

    table = Table(table_data, colWidths=list(col_widths))
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#00008B")),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#00008B")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F5F5FF")]),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    return table


def generate_output_pdf(output_json_path, pdf_out_path, template_name="Default.pdf"):
    """Builds Output.pdf from Output.json - same section layout/formatting
    every time, mirroring the structure of the default output template
    (see build_default_template_pdf below, which uses the same layout).
    Handles both the flat heuristic fields dict and the rich nested LLM
    extraction schema (see _flatten_to_rows)."""
    if not REPORTLAB_OK:
        raise LeaseEngineError(
            "reportlab is not installed - run: pip install -r requirements.txt"
        )

    with open(output_json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    fields = data.get("fields", {}) or {}
    lease_name = data.get("leaseName", "Lease")
    extraction_method = data.get("extractionMethod", "heuristic")
    accuracy = data.get("accuracy")
    accuracy_summary = data.get("accuracySummary") or ""

    doc = SimpleDocTemplate(
        pdf_out_path, pagesize=LETTER,
        topMargin=0.75 * inch, bottomMargin=0.75 * inch,
        leftMargin=0.75 * inch, rightMargin=0.75 * inch,
    )
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "LeaseTitle", parent=styles["Title"], textColor=colors.HexColor("#00008B")
    )
    heading_style = ParagraphStyle(
        "LeaseHeading", parent=styles["Heading2"], textColor=colors.HexColor("#00008B"),
        spaceBefore=14, spaceAfter=6
    )
    normal = styles["Normal"]

    story = [
        Paragraph("Lease Abstraction Report", title_style),
        Paragraph(f"Generated from template: {template_name}", normal),
        Paragraph(f"Generated on: {datetime.now().strftime('%Y-%m-%d %H:%M')}", normal),
        Paragraph(f"Extraction method: {extraction_method}", normal),
    ]
    if accuracy is not None:
        story.append(Paragraph(f"Accuracy: {accuracy}%" + (f" — {accuracy_summary}" if accuracy_summary else ""), normal))
    story += [
        Spacer(1, 12),
        HRFlowable(width="100%", color=colors.HexColor("#00008B")),
        Spacer(1, 12),
        Paragraph("Lease Summary", heading_style),
    ]

    # Top-level scalar fields (the flat heuristic schema, or any top-level
    # scalars mixed into a rich schema) go into one General table first.
    simple_rows = [
        (_humanize_key(k), _stringify_leaf(v))
        for k, v in fields.items() if not isinstance(v, (dict, list))
    ]
    if simple_rows:
        story.append(_build_kv_table(simple_rows))

    # Each nested top-level section (parties, premises, term, rent,
    # cam_opex, options, ... per extraction_prompt.txt) becomes its own
    # titled sub-table.
    for key, value in fields.items():
        if not isinstance(value, (dict, list)):
            continue
        section_rows = _flatten_to_rows(value)
        if not section_rows:
            continue
        story.append(Spacer(1, 10))
        story.append(Paragraph(_humanize_key(key), heading_style))
        story.append(_build_kv_table(section_rows))

    story.append(Spacer(1, 18))
    story.append(Paragraph("Source Document(s)", heading_style))
    for doc_path in data.get("sourceDocuments", []):
        story.append(Paragraph(doc_path, normal))

    story.append(Spacer(1, 18))
    story.append(HRFlowable(width="100%", color=colors.HexColor("#00008B")))
    story.append(Spacer(1, 6))
    story.append(Paragraph(
        f"Lease folder: Users/{data.get('userId', '')}/LeaseAbstraction/{lease_name}/",
        normal
    ))

    doc.build(story)
    return pdf_out_path


def build_default_template_pdf(pdf_out_path):
    """Generates the placeholder Default.pdf that ships in
    Template/LeaseAbstraction/ - the same layout generate_output_pdf()
    produces, but with blank/sample placeholder values, since this is the
    template shown to the user before any lease has been processed."""
    if not REPORTLAB_OK:
        raise LeaseEngineError(
            "reportlab is not installed - run: pip install -r requirements.txt"
        )

    doc = SimpleDocTemplate(
        pdf_out_path, pagesize=LETTER,
        topMargin=0.75 * inch, bottomMargin=0.75 * inch,
        leftMargin=0.75 * inch, rightMargin=0.75 * inch,
    )
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "LeaseTitle", parent=styles["Title"], textColor=colors.HexColor("#00008B")
    )
    heading_style = ParagraphStyle(
        "LeaseHeading", parent=styles["Heading2"], textColor=colors.HexColor("#00008B"),
        spaceBefore=14, spaceAfter=6
    )
    normal = styles["Normal"]

    story = [
        Paragraph("Lease Abstraction Report", title_style),
        Paragraph("Default Output Template", normal),
        Spacer(1, 12),
        HRFlowable(width="100%", color=colors.HexColor("#00008B")),
        Spacer(1, 12),
        Paragraph("Lease Summary", heading_style),
    ]

    table_data = [["Field", "Value"]]
    placeholders = [
        ("Document Type", "{{documentType}}"),
        ("Tenant", "{{tenant}}"),
        ("Landlord", "{{landlord}}"),
        ("Property Address", "{{propertyAddress}}"),
        ("Lease Start", "{{leaseStart}}"),
        ("Lease End", "{{leaseEnd}}"),
        ("Base Rent", "{{baseRent}}"),
        ("Currency", "{{currency}}"),
    ]
    for label, value in placeholders:
        table_data.append([label, value])

    table = Table(table_data, colWidths=[2.2 * inch, 3.8 * inch])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#00008B")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#00008B")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F5F5FF")]),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(table)
    story.append(Spacer(1, 18))
    story.append(Paragraph(
        "This is the default output layout used to generate Output.pdf for "
        "every processed lease when no custom template has been selected.",
        normal
    ))

    doc.build(story)
    return pdf_out_path
