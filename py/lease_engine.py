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
                                   prompt) when the .env file has an
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
in .env, call_llm_extraction() sends the extracted lease
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

import base64
import difflib
import hashlib
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
    from PIL import Image as PILImage, ImageDraw, ImageFont
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
    from reportlab.lib.enums import TA_LEFT, TA_RIGHT
    from reportlab.platypus import (
        SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable, Image
    )
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.utils import ImageReader
    REPORTLAB_OK = True
except ImportError:
    REPORTLAB_OK = False

try:
    # Item 6 - reportlab (like most PDF libraries) only ever lays text out
    # left-to-right, character-by-character, in Unicode logical order. For
    # RTL scripts (Arabic, Hebrew, etc.) that's wrong twice over: Arabic
    # letters need CONTEXTUAL reshaping (a letter's glyph changes depending
    # on its neighbors, e.g. isolated-vs-initial-vs-medial-vs-final forms),
    # and the whole line needs its visual character order reversed
    # (logical-to-visual bidi reordering). arabic_reshaper handles the
    # first, python-bidi's get_display() handles the second - together
    # they're the standard fix for rendering Arabic/Hebrew correctly in a
    # bidi-unaware renderer like reportlab.
    import arabic_reshaper
    from bidi.algorithm import get_display as _bidi_get_display
    RTL_SHAPING_OK = True
except ImportError:
    RTL_SHAPING_OK = False


# ISO-ish language names (as they'd appear in the app's language dropdown)
# that read right-to-left. Kept as a name-based list (rather than ISO
# codes) since translate_text()/generate_translation_pdf() both work with
# the plain language name the user picked in the UI, not a code.
_RTL_LANGUAGES = {"arabic", "hebrew", "urdu", "persian", "farsi", "pashto", "sindhi", "dhivehi", "yiddish"}


def is_rtl_language(language_name):
    return (language_name or "").strip().lower() in _RTL_LANGUAGES


def shape_rtl_text(text):
    """Reshapes+reorders a string of Arabic/Hebrew/etc text so it renders
    correctly in reportlab. Safe to call on already-LTR or mixed text -
    arabic_reshaper only touches RTL-script characters, so any English
    words/numbers embedded in an other-wise-RTL sentence keep their own
    correct (LTR) internal order after the bidi pass. Falls back to the
    original text untouched if the shaping libraries aren't installed,
    rather than failing the whole PDF generation over a missing optional
    dependency."""
    if not RTL_SHAPING_OK or not text:
        return text
    try:
        reshaped = arabic_reshaper.reshape(text)
        return _bidi_get_display(reshaped)
    except Exception:
        return text


class LeaseEngineError(Exception):
    pass


# lease_engine.py lives in py/, json/ is a sibling of py/ under the project root.
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JSON_DIR = os.path.join(ROOT_DIR, "json")
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


def _load_dotenv(path):
    """Same minimal .env loader as server.py (duplicated, not imported,
    so this module still works standalone/under a different entry point).
    See server.py's copy for the full rationale."""
    if not os.path.isfile(path):
        return
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
                value = value[1:-1]
            os.environ.setdefault(key, value)


_load_dotenv(os.path.join(ROOT_DIR, ".env"))


def load_llm_config():
    """LLM provider/key config comes from environment variables (.env)
    now - json/llm-config.json was removed because committing real API
    keys in a tracked JSON file got git pushes blocked by GitHub's
    secret-scanning push protection.

    Item 5 (speed) - the validation/QC pass (call_llm_validation, a
    SEPARATE sequential LLM call after the main extraction) doesn't need
    the same heavyweight model the extraction itself does - it's just
    checking/scoring fields that already exist. Defaulting it to a
    smaller, faster model (matching the reference project's tiered
    validation/scoring/quick models) cuts real wall-clock time off every
    single lease/translation processed, without touching extraction
    quality at all. Override with LLM_VALIDATION_MODEL / OPENROUTER_
    VALIDATION_MODEL in .env if a different model is preferred."""
    return {
        "provider": os.environ.get("LLM_PROVIDER", "openai"),
        "openai": {
            "apiKey": os.environ.get("OPENAI_API_KEY"),
            "model": os.environ.get("OPENAI_MODEL", "gpt-4o"),
            "validationModel": os.environ.get("OPENAI_VALIDATION_MODEL", "gpt-4o-mini"),
            "baseUrl": "https://api.openai.com/v1/chat/completions",
        },
        "openrouter": {
            "apiKey": os.environ.get("OPENROUTER_API_KEY"),
            "model": os.environ.get("OPENROUTER_MODEL", "openai/gpt-4o"),
            "validationModel": os.environ.get("OPENROUTER_VALIDATION_MODEL", "openai/gpt-4o-mini"),
            "baseUrl": "https://openrouter.ai/api/v1/chat/completions",
        },
    }


def _resolve_provider_cfg(llm_config, provider):
    return llm_config.get(provider, {}) or {}


def load_extraction_prompt():
    try:
        with open(EXTRACTION_PROMPT_PATH, "r", encoding="utf-8") as f:
            base_prompt = f.read()
    except OSError:
        return None
    return base_prompt + _load_extra_approved_rules_supplement()


def get_rules_applied_count():
    """Item 1 - how many extraction rules (73 built-in + any extra
    Developer-approved ones) were actually included in the prompt for
    this extraction, for the activity log's 'Applying Rules > X/Y' line.
    Every currently-approved rule is always injected on every call (no
    per-document conditional skipping), so X and Y are the same number -
    this reports how many rules were active, not a partial-match score."""
    try:
        with open(os.path.join(JSON_DIR, "rules.json"), "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return 0, 0
    total = len(data.get("approved", []))
    return total, total


def _load_extra_approved_rules_supplement():
    """Renders any approved rule that ISN'T one of the 73 original
    built-in ones (those are already baked into extraction_prompt.txt's
    own prose - re-injecting them here would just double token usage for
    no benefit) as an extra prompt section. This is what makes a rule
    approved through the Update Rules UI actually take effect on the next
    extraction call, with no manual prompt editing needed."""
    try:
        with open(os.path.join(JSON_DIR, "rules.json"), "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return ""

    extra_rules = [r for r in data.get("approved", []) if not r.get("builtin")]
    if not extra_rules:
        return ""

    lines = [
        "\n\n---\nADDITIONAL FIELD-EXTRACTION RULES (approved by the Developer after the "
        "rules above were written - apply these too, on top of everything else in this prompt):"
    ]
    for rule in extra_rules:
        field_id = rule.get("fieldId", "")
        rule_type = rule.get("ruleType", "")
        rule_text = rule.get("ruleText", "")
        if field_id and rule_text:
            lines.append(f"- [{field_id}] ({rule_type}): {rule_text}")
    return "\n".join(lines)


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


def _call_chat_completion(provider, provider_cfg, system_prompt, user_content, max_tokens=16000, use_validation_model=False, extra_messages=None):
    """Shared OpenAI/OpenRouter chat-completions call. Returns the raw
    response text (the caller decides how to parse it) or raises
    LeaseEngineError. No response_format is sent - not every OpenRouter
    model supports it, so (matching the reference project) we rely on the
    prompt's own "return ONLY JSON" instruction plus robust_json_parse on
    the way out instead.

    extra_messages (optional) - prior turns (user/assistant pairs) to
    insert between the system prompt and this call's new user message,
    so several calls can share one running conversation instead of each
    being a fresh, context-less call - see compare_extraction_quality's
    use of this for Test & Compare, which keeps ONE conversation going
    across every lease in a batch rather than starting over each time."""
    api_key = (provider_cfg.get("apiKey") or "").strip()
    if not api_key:
        return None

    # Item 5 (speed) - the QC/validation pass just re-checks fields that
    # already exist, a much lighter task than the original extraction, so
    # it uses the smaller/faster validationModel (see load_llm_config)
    # instead of the same heavyweight model extraction needs. This was
    # already configured (OPENAI_VALIDATION_MODEL / OPENROUTER_VALIDATION_
    # MODEL in .env) but never actually wired up - _call_chat_completion
    # always used the main model regardless.
    model = (provider_cfg.get("validationModel") if use_validation_model else provider_cfg.get("model")) or "gpt-4o"
    url = provider_cfg.get("baseUrl") or (
        "https://openrouter.ai/api/v1/chat/completions" if provider == "openrouter"
        else "https://api.openai.com/v1/chat/completions"
    )

    messages = [{"role": "system", "content": system_prompt}]
    messages.extend(extra_messages or [])
    messages.append({"role": "user", "content": user_content})

    payload = {
        "model": model,
        "messages": messages,
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


def _call_chat_completion_with_failover(llm_config, system_prompt, user_content, max_tokens=16000, use_validation_model=False, extra_messages=None):
    """Tries the configured primary provider first; if it's configured but
    the call itself fails (auth error, network error, bad response),
    automatically tries the OTHER provider too (if it has a key
    configured) before giving up - previously a single OpenAI hiccup fell
    straight through to the heuristic engine even though a working
    OpenRouter key was sitting right there in .env unused. Returns
    (content, provider_used) - content is None if neither provider has a
    key configured at all (caller falls back to heuristic silently);
    raises LeaseEngineError only if at least one provider was actually
    tried and every attempt failed."""
    primary_provider = llm_config.get("provider", "openai")
    fallback_provider = "openrouter" if primary_provider == "openai" else "openai"

    last_error = None
    tried_any = False
    for provider in (primary_provider, fallback_provider):
        provider_cfg = _resolve_provider_cfg(llm_config, provider)
        if not provider_cfg.get("apiKey"):
            continue  # this provider isn't configured at all - just skip it
        tried_any = True
        try:
            content = _call_chat_completion(provider, provider_cfg, system_prompt, user_content, max_tokens=max_tokens, use_validation_model=use_validation_model, extra_messages=extra_messages)
        except LeaseEngineError as err:
            print(f"{provider} call failed{' - trying ' + fallback_provider + ' next' if provider == primary_provider else ''}: {err}")
            last_error = err
            continue
        if content is not None:
            return content, provider

    if tried_any and last_error:
        raise last_error
    return None, None


def discover_new_rules(text, existing_rule_texts, llm_config=None):
    """Item 7 - the reference project's LMS auto-proposed new rules from
    patterns the AI noticed; this is our equivalent. Asks a lightweight
    LLM call to look at THIS lease's text and suggest 0-3 NEW
    field-extraction rules that existing rules (built-in + already
    approved/pending) don't already cover - never edits extraction_prompt
    directly, just proposes candidates for a human to approve. Returns a
    list of {fieldId, ruleType, ruleText, confidence} dicts, or [] on any
    failure or when there's nothing new. Never raises - this always runs
    as a background, best-effort call that must not affect the main
    extraction pipeline."""
    llm_config = llm_config if llm_config is not None else load_llm_config()
    existing_block = "\n".join(f"- {t}" for t in existing_rule_texts[:80] if t)
    system_prompt = (
        "You are reviewing a commercial lease document to find NEW field-extraction rules "
        "worth adding to a shared rules library for an AI lease-abstraction tool, based on "
        "patterns in THIS specific lease that the EXISTING rules below don't already cover.\n\n"
        f"EXISTING RULES (do not propose a duplicate of any of these):\n{existing_block}\n\n"
        "Return ONLY a JSON array (no markdown fences, no commentary) of 0 to 3 objects, each shaped as:\n"
        '{ "fieldId": string, "ruleType": "mapping" | "style" | "logic", '
        '"ruleText": string, "confidence": number 0.0-1.0 }\n'
        "Only propose a rule if it is genuinely new and useful (e.g. an unusual clause "
        "location, a wording pattern, a formatting convention this lease uses). "
        "Return an empty array [] if this lease doesn't reveal anything new."
    )
    try:
        content, _provider = _call_chat_completion_with_failover(
            llm_config, system_prompt, text[:60000], max_tokens=1000
        )
    except LeaseEngineError as err:
        print(f"Rule auto-discovery LLM call failed, skipping: {err}")
        return []
    if not content:
        return []

    parsed = robust_json_parse(content)
    if not isinstance(parsed, list):
        return []

    cleaned = []
    for r in parsed[:3]:
        if not isinstance(r, dict):
            continue
        field_id = str(r.get("fieldId") or "").strip()[:60]
        rule_text = str(r.get("ruleText") or "").strip()[:500]
        if not field_id or not rule_text:
            continue
        rule_type = r.get("ruleType") if r.get("ruleType") in ("mapping", "style", "logic") else "mapping"
        try:
            confidence = max(0.0, min(1.0, float(r.get("confidence", 0.5))))
        except (TypeError, ValueError):
            confidence = 0.5
        cleaned.append({"fieldId": field_id, "ruleType": rule_type, "ruleText": rule_text, "confidence": confidence})
    return cleaned


def compare_extraction_quality(original_text, human_output_text, current_output_text, existing_rule_texts, llm_config=None, conversation_history=None):
    """Item 4 (Test & Compare admin tool) - the core comparison behind the
    Test & Compare card: how closely does our system's own extraction
    (current_output_text) match a human expert's extraction
    (human_output_text) of the SAME original lease? Returns a dict with:
      - similarity: a 0-100 text-similarity score (difflib) between the
        human and current outputs - a rough, fast "how close are we"
        number, not a substitute for the LLM's own read below.
      - proposedRules: 0-3 rule proposals (same shape as
        discover_new_rules) an LLM derived specifically from where our
        output diverges from the human's, given the original text as
        context - these still land in rules.json's pending queue for
        Developer approval, same governance as every other rule source.
      - conversationHistory: the updated message list (pass this back in
        as `conversation_history` for the NEXT lease in the same Test &
        Compare batch) - every lease in one batch run shares a single
        growing conversation rather than each being an isolated, fresh
        call, so the model retains context across the whole batch (e.g.
        it won't propose near-duplicate rules for two leases that show
        the same gap, and can build a cumulative read of this batch's
        common failure patterns).
    Never raises - a failure in the LLM step just means proposedRules
    comes back empty; the similarity score (pure Python, no LLM needed)
    always still gets computed and returned."""
    import difflib
    similarity = round(difflib.SequenceMatcher(
        None, (human_output_text or "").strip().lower(), (current_output_text or "").strip().lower()
    ).ratio() * 100, 1)

    proposed_rules = []
    history = list(conversation_history or [])
    llm_config = llm_config if llm_config is not None else load_llm_config()
    existing_block = "\n".join(f"- {t}" for t in existing_rule_texts[:80] if t)
    system_prompt = (
        "You are comparing several leases' extractions across one Test & Compare batch, one lease at a "
        "time in this same conversation: for each lease, one extraction was produced by a human "
        "lease-abstraction expert (treat as the ground truth), one by an AI extraction system. Identify "
        "specific, genuine gaps where the AI's extraction missed or got wrong something the human correctly "
        "captured, then propose 0-3 NEW field-extraction rules per lease that would help the AI system close "
        "those specific gaps next time. Use your memory of earlier leases in this same conversation to avoid "
        "proposing a near-duplicate of a rule you already proposed for an earlier lease in this batch.\n\n"
        f"EXISTING RULES (do not propose a duplicate of any of these):\n{existing_block}\n\n"
        "Return ONLY a JSON array (no markdown fences, no commentary) of 0 to 3 objects, each shaped as:\n"
        '{ "fieldId": string, "ruleType": "mapping" | "validation" | "logic", '
        '"ruleText": string, "confidence": number 0.0-1.0 }\n'
        "Only propose a rule if the gap is real and a rule could plausibly fix it. Return [] if the AI's "
        "extraction already matches the human's closely enough that there's nothing meaningful to add."
    )
    user_content = (
        f"ORIGINAL LEASE (excerpt):\n{(original_text or '')[:40000]}\n\n"
        f"HUMAN EXPERT OUTPUT (ground truth):\n{(human_output_text or '')[:15000]}\n\n"
        f"AI SYSTEM OUTPUT (to evaluate):\n{(current_output_text or '')[:15000]}"
    )
    try:
        content, _provider = _call_chat_completion_with_failover(
            llm_config, system_prompt, user_content, max_tokens=1200, extra_messages=history
        )
        if content:
            history.append({"role": "user", "content": user_content})
            history.append({"role": "assistant", "content": content})
            # Item 4 safety - each user turn can carry ~70K chars of
            # document text; keeping every prior turn in a 10-lease batch
            # would balloon context size fast. Keeping only the most
            # recent 2 exchanges still gives the model useful "what did I
            # just see" continuity without unbounded growth.
            history = history[-4:]
            parsed = robust_json_parse(content)
            if isinstance(parsed, list):
                for r in parsed[:3]:
                    if not isinstance(r, dict):
                        continue
                    field_id = str(r.get("fieldId") or "").strip()[:60]
                    rule_text = str(r.get("ruleText") or "").strip()[:500]
                    if not field_id or not rule_text:
                        continue
                    rule_type = r.get("ruleType") if r.get("ruleType") in ("mapping", "validation", "logic", "style") else "mapping"
                    try:
                        confidence = max(0.0, min(1.0, float(r.get("confidence", 0.6))))
                    except (TypeError, ValueError):
                        confidence = 0.6
                    proposed_rules.append({"fieldId": field_id, "ruleType": rule_type, "ruleText": rule_text, "confidence": confidence})
    except LeaseEngineError as err:
        print(f"Test & Compare rule proposal LLM call failed (similarity score is still valid): {err}")

    return {"similarity": similarity, "proposedRules": proposed_rules, "conversationHistory": history}


def call_llm_extraction(text, llm_config=None):
    """Calls OpenAI or OpenRouter (whichever LLM_PROVIDER is set to in
    .env, with automatic failover to the other one if it's also
    configured - see _call_chat_completion_with_failover) using
    json/extraction_prompt.txt as the system prompt. Returns
    (parsed_fields_dict, provider_used) on success, or (None, None) if no
    API key is configured at all (caller falls back to the heuristic
    engine). Raises LeaseEngineError if every configured provider's call
    failed."""
    llm_config = llm_config if llm_config is not None else load_llm_config()

    system_prompt = load_extraction_prompt()
    if not system_prompt:
        return None, None  # no prompt file - caller falls back to heuristic

    content, provider = _call_chat_completion_with_failover(
        llm_config, system_prompt,
        "LEASE DOCUMENT TEXT:\n\n" + text[:120000],
        max_tokens=16000,
    )
    if content is None:
        return None, None  # no API key configured anywhere - caller falls back to heuristic

    parsed = robust_json_parse(content)
    if parsed is None:
        raise LeaseEngineError(f"{provider} returned a response that isn't valid JSON")
    return parsed, provider


VALIDATION_SYSTEM_PROMPT = "You are a lease abstraction QC validator. Return ONLY valid JSON."


def call_llm_validation(fields, llm_config=None):
    """Second pass over the extracted fields - same shape as the reference
    project's /api/validate route. Returns a dict with confidence_score
    (0.0-1.0), missing_fields, low_confidence_fields, and a one-line
    summary, or None if no LLM is configured (caller falls back to a
    heuristic completeness score)."""
    llm_config = llm_config if llm_config is not None else load_llm_config()

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

    content, provider = _call_chat_completion_with_failover(
        llm_config, VALIDATION_SYSTEM_PROMPT, prompt, max_tokens=2000, use_validation_model=True
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


def _find_after_label(text, labels, max_lines=3):
    """Looks for 'Label: value' or 'Label - value' style lines and returns
    the value - allows the value to continue onto a couple of wrapped
    continuation lines (common in PDF table cells, e.g. a long landlord
    name that wraps across 2-3 lines) but stops at a blank line or what
    looks like the start of the next label, so it doesn't run on into
    unrelated content."""
    for label in labels:
        pattern = re.compile(re.escape(label) + r"\s*[:\-]\s*(.+)", re.IGNORECASE)
        m = pattern.search(text)
        if not m:
            continue
        start = m.start(1)
        chunk = text[start:start + 600]
        lines = chunk.split("\n")
        value_lines = [lines[0].strip()] if lines and lines[0].strip() else []
        for line in lines[1:max_lines]:
            stripped = line.strip()
            if not stripped:
                break  # blank line - value block ended
            if re.match(r"^[A-Z][A-Z \-'\u2019/]{2,40}[:\-]", stripped):
                break  # looks like the start of the next label
            value_lines.append(stripped)
        value = " ".join(value_lines).strip()
        if value:
            return value[:200]
    return None


def _find_date_near_label(text, labels):
    """Looks for a label like 'Expiration Date' and extracts the nearest
    date-shaped value on the same line/nearby - far more reliable than
    grabbing "the Nth date found anywhere in the document" (which has no
    idea which date means what, and easily picks up an unrelated date
    like an "Estimated Commencement Date" instead of the real
    expiration date)."""
    for label in labels:
        pattern = re.compile(re.escape(label) + r"\s*[:\-]?\s*(.{0,80})", re.IGNORECASE)
        for m in pattern.finditer(text):
            date_match = _DATE_RE.search(m.group(1))
            if date_match:
                return date_match.group(0)
    return None


def _find_money_near_label(text, labels):
    """Same idea as _find_date_near_label but for dollar amounts - avoids
    grabbing "the first dollar figure anywhere in the document" (which
    could be a phone number, an unrelated fee, or a table header amount
    rather than the actual rent)."""
    for label in labels:
        pattern = re.compile(re.escape(label) + r"\s*[:\-]?\s*(.{0,120})", re.IGNORECASE)
        for m in pattern.finditer(text):
            money_match = _MONEY_RE.search(m.group(1))
            if money_match:
                return money_match.group(0)
    return None


def heuristic_analyze_lease(text, fallback_name="Lease Document"):
    """Deterministic regex/keyword field extraction - used when no LLM key
    is configured in .env (see analyze_lease below)."""
    doc_type = classify_document(text)

    tenant = _find_party_name(text, ["Tenant", "Lessee"])
    landlord = _find_party_name(text, ["Landlord", "Lessor"])
    property_address = _find_after_label(
        text, ["Premises", "Property Address", "Leased Premises", "Address"]
    )

    all_dates = [m.group(0) for m in _DATE_RE.finditer(text)]
    money_matches = _MONEY_RE.findall(text)

    lease_start = (
        _find_date_near_label(text, ["Commencement Date", "Date of Lease", "Lease Commencement", "Effective Date"])
        or (all_dates[0] if len(all_dates) > 0 else None)
    )
    lease_end = (
        _find_date_near_label(text, ["Expiration Date", "Lease Expiration", "Termination Date", "End Date"])
        or (all_dates[1] if len(all_dates) > 1 else None)
    )
    base_rent = (
        _find_money_near_label(text, ["Monthly Base Rent", "Base Rent", "Monthly Rent", "Minimum Monthly Rent"])
        or (money_matches[0] if money_matches else None)
    )

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


def translate_text(text, target_language, llm_config=None):
    """Real translation via OpenAI/OpenRouter, with automatic failover to
    whichever of the two is configured if the primary one's call fails
    (see _call_chat_completion_with_failover). Returns
    (translated_text, provider_used), or (None, None) if no LLM key is
    configured at all (caller falls back to a clear heuristic message
    rather than pretending to translate). Raises LeaseEngineError if
    every configured provider's call failed."""
    llm_config = llm_config if llm_config is not None else load_llm_config()

    system_prompt = (
        f"You are a professional document translator. Translate the user's text into "
        f"{target_language}. Preserve the original meaning, tone, register, and structure as "
        f"closely as the target language allows. Write naturally in {target_language}'s own "
        f"normal script and word order - the document renderer handles right-to-left vs "
        f"left-to-right layout separately, so just focus on an accurate, natural translation.\n\n"
        f"Mark up the structure you detect using these plain-text conventions, so the "
        f"translated document can be auto-formatted afterward:\n"
        f"- Separate distinct paragraphs with a single BLANK LINE between them.\n"
        f"- Bullet list items: start the line with '- '.\n"
        f"- Numbered list items: start the line with '1. ', '2. ', etc. (keep the original numbering).\n"
        f"- Section headings / titles: start the line with '## '.\n"
        f"- Bold or otherwise emphasized text (e.g. defined terms, warnings, key figures the "
        f"source visually emphasized): wrap it in **double asterisks**.\n"
        f"- Do NOT invent structure that isn't in the source - only mark what's genuinely a "
        f"list, heading, or emphasis there.\n\n"
        f"Return ONLY the translated, marked-up text - no preamble, no notes, no commentary "
        f"about the translation itself."
    )
    content, provider = _call_chat_completion_with_failover(llm_config, system_prompt, text[:100000], max_tokens=8000)
    if content is None:
        return None, None  # no API key configured anywhere - caller falls back
    return content.strip(), provider


_BOLD_MARKUP_RE = re.compile(r"\*\*(.+?)\*\*")


def _escape_and_apply_bold(text, rtl=False):
    """Escapes HTML-special characters for safe use in a reportlab
    Paragraph, then converts **bold** markers (see the markup convention
    translate_text() asks the LLM to use) into <b> tags - reportlab
    Paragraphs support this small tag set natively.

    For RTL text (item 6), each segment is bidi-reshaped BEFORE the <b>
    tags get added, never after - running arabic_reshaper/get_display on
    a string that already contains '<b>...</b>' scrambles the tag
    characters themselves (they get treated as just more RTL-adjacent
    text and reordered), which breaks reportlab's mini-XML parser. Doing
    it in this order (shape first, wrap second) keeps the tags intact."""
    parts = _BOLD_MARKUP_RE.split(text)  # alternates [plain, bold, plain, bold, ...]
    out = []
    for i, part in enumerate(parts):
        escaped = part.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        if rtl:
            escaped = shape_rtl_text(escaped)
        out.append(f"<b>{escaped}</b>" if i % 2 == 1 else escaped)
    return "".join(out)


def _parse_translation_blocks(text):
    """Item 6 - splits the LLM's markdown-lite translated text (see the
    system prompt in translate_text()) into typed blocks so the output
    document auto-formats instead of being one flat wall of paragraphs:
    a blank line starts a new block; '- ' lines become a bullet list,
    '1. '/'2. ' lines become a numbered list, a lone '## ' line becomes a
    heading, and everything else is a regular paragraph."""
    blocks = []
    for raw in re.split(r"\n\s*\n", (text or "").strip()):
        lines = [ln.strip() for ln in raw.split("\n") if ln.strip()]
        if not lines:
            continue
        if all(ln.startswith("- ") for ln in lines):
            blocks.append(("bullet", [ln[2:].strip() for ln in lines]))
        elif all(re.match(r"^\d+\.\s", ln) for ln in lines):
            blocks.append(("numbered", [re.sub(r"^\d+\.\s*", "", ln) for ln in lines]))
        elif len(lines) == 1 and lines[0].startswith("## "):
            blocks.append(("heading", lines[0][3:].strip()))
        else:
            blocks.append(("paragraph", " ".join(lines)))
    return blocks


def _group_chars_into_lines(chars, y_tolerance=2.5):
    """Groups pdfplumber's per-character data into text lines, using Y
    (top) proximity - characters within y_tolerance points of each other
    are the same line, matching how a PDF's text is actually laid out
    (each line's characters share close to the same baseline)."""
    if not chars:
        return []
    buckets = {}
    for c in chars:
        key = round(c["top"] / y_tolerance)
        buckets.setdefault(key, []).append(c)
    # Merge adjacent buckets that are still within tolerance of each other
    # (a line can straddle two rounding buckets right at the boundary).
    sorted_keys = sorted(buckets.keys())
    merged = []
    current = []
    last_key = None
    for k in sorted_keys:
        if last_key is not None and k - last_key > 1:
            merged.append(current)
            current = []
        current.extend(buckets[k])
        last_key = k
    if current:
        merged.append(current)
    return [sorted(line, key=lambda c: c["x0"]) for line in merged if line]


def _line_to_region(line_chars):
    """Reduces one line's raw characters down to what's needed to mask +
    re-render it: its exact bounding box (so the translated text lands in
    the same place) and its dominant font/size/color (so it looks as
    close to the original as this renderer can manage)."""
    text = "".join(c["text"] for c in line_chars)
    if not text.strip():
        return None
    x0 = min(c["x0"] for c in line_chars)
    x1 = max(c["x1"] for c in line_chars)
    top = min(c["top"] for c in line_chars)
    bottom = max(c["bottom"] for c in line_chars)
    sizes = [c.get("size", 10) for c in line_chars]
    dominant_size = sorted(sizes)[len(sizes) // 2] if sizes else 10
    fontnames = [c.get("fontname", "") for c in line_chars]
    dominant_font = max(set(fontnames), key=fontnames.count) if fontnames else ""
    is_bold = "bold" in dominant_font.lower()
    is_italic = "italic" in dominant_font.lower() or "oblique" in dominant_font.lower()
    color_hex = _color_tuple_to_hex(line_chars[0].get("non_stroking_color")) or "#000000"
    return {
        "text": text, "x0": x0, "x1": x1, "top": top, "bottom": bottom,
        "size": dominant_size, "bold": is_bold, "italic": is_italic, "color": color_hex,
    }


def _translate_lines_batch(lines, target_language, llm_config=None, chunk_size=70):
    """Translates a list of short text lines while preserving strict 1:1
    correspondence (line 5 in must come back as line 5 out) - sent to the
    LLM as a numbered list rather than one flowing translation, since the
    layout-preserving renderer needs to put each translated line back in
    its own original bounding box. Chunks long documents (chunk_size
    lines per call) to stay well within a safe response size. Falls back
    to returning the original lines unchanged for any chunk where the LLM
    isn't configured or the call fails, rather than losing that whole
    chunk's text."""
    llm_config = llm_config if llm_config is not None else load_llm_config()
    results = []
    for start in range(0, len(lines), chunk_size):
        chunk = lines[start:start + chunk_size]
        numbered_input = "\n".join(f"{i+1}. {line}" for i, line in enumerate(chunk))
        system_prompt = (
            f"Translate each numbered line below into {target_language}. This is raw text extracted "
            f"line-by-line from fixed positions on a PDF page, so lines may be sentence fragments, "
            f"table cells, or labels rather than full sentences - translate each one independently and "
            f"naturally, using surrounding lines only for context, not to merge them together.\n\n"
            f"Return ONLY a numbered list with EXACTLY the same number of lines, in the exact same "
            f"order (line N in must be line N out) - no extra commentary, no merged/split lines, no "
            f"markdown formatting, no ## or ** markers."
        )
        try:
            content, _provider = _call_chat_completion_with_failover(llm_config, system_prompt, numbered_input, max_tokens=4000)
        except LeaseEngineError:
            content = None
        if not content:
            results.extend(chunk)
            continue
        translated_chunk = [None] * len(chunk)
        for line in content.strip().split("\n"):
            m = re.match(r"^\s*(\d+)[.):]\s*(.*)$", line)
            if m:
                idx = int(m.group(1)) - 1
                if 0 <= idx < len(chunk):
                    translated_chunk[idx] = m.group(2).strip()
        results.extend(t if t else original for t, original in zip(translated_chunk, chunk))
    return results


def llm_is_configured(llm_config=None):
    """True if at least one provider (OpenAI/OpenRouter) has an API key -
    used to decide whether the vision-based translation paths are even
    possible, before promising them."""
    llm_config = llm_config if llm_config is not None else load_llm_config()
    return bool((llm_config.get("openai", {}) or {}).get("apiKey") or
                (llm_config.get("openrouter", {}) or {}).get("apiKey"))


def pdf_has_text_layer(pdf_path):
    """True if any page of the PDF has real extractable characters (a
    digitally-authored PDF), False for scanned/photo/image-only PDFs.
    Errs on the side of False if the file can't be inspected."""
    if not pdfplumber:
        return False
    try:
        with pdfplumber.open(pdf_path) as pdf:
            return any(p.chars for p in pdf.pages)
    except Exception:
        return False


def _pil_image_to_jpeg_b64(pil_image, max_dim=2000, quality=80):
    """Downscales (never upscales) a PIL page render to max_dim on its
    longest side and returns base64 JPEG - keeps the vision API payload
    reasonable (a raw 300 DPI A4 PNG is ~2500x3500 and several MB;
    JPEG at 2000px is a fraction of that with no meaningful loss for
    text reading)."""
    img = pil_image
    longest = max(img.width, img.height)
    if longest > max_dim:
        scale = max_dim / float(longest)
        img = img.resize((max(1, int(img.width * scale)), max(1, int(img.height * scale))), PILImage.LANCZOS)
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=quality)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _call_vision_with_failover(llm_config, system_prompt, text_prompt, image_b64, max_tokens=8000):
    """Sends ONE page image + a text prompt to the configured chat model
    using the OpenAI multimodal content format (identical on OpenRouter,
    which proxies the same schema). Reuses the existing failover plumbing
    - the multimodal content list rides through _call_chat_completion's
    `user_content` untouched, since that function just drops it into the
    user message as-is. Returns (content, provider) or (None, None) if no
    key is configured. NOTE: requires a vision-capable model in .env
    (gpt-4o / gpt-4o-mini and most OpenRouter frontier models are)."""
    user_content = [
        {"type": "text", "text": text_prompt},
        {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
    ]
    return _call_chat_completion_with_failover(llm_config, system_prompt, user_content, max_tokens=max_tokens)


def _translate_lines_batch_vision(page_image, lines, target_language, llm_config=None, chunk_size=60):
    """Hybrid mode's translator: same 1:1 numbered-lines contract as
    _translate_lines_batch, but the page IMAGE is sent along with the
    OCR'd lines so the model can use the actual pixels as ground truth to
    FIX Tesseract's misreads before translating - this is the piece that
    makes the layout-preserving path usable on photographed documents,
    where raw OCR text alone is too corrupted to translate meaningfully.
    Falls back to the text-only _translate_lines_batch for any chunk
    where no key is configured or the vision call fails."""
    llm_config = llm_config if llm_config is not None else load_llm_config()
    if not llm_is_configured(llm_config):
        return _translate_lines_batch(lines, target_language, llm_config)

    image_b64 = _pil_image_to_jpeg_b64(page_image)
    results = []
    for start in range(0, len(lines), chunk_size):
        chunk = lines[start:start + chunk_size]
        numbered_input = "\n".join(f"{i+1}. {line}" for i, line in enumerate(chunk))
        system_prompt = (
            f"You are a professional document translator. You are given an IMAGE of a document "
            f"page, plus a numbered list of text lines that OCR software extracted from that same "
            f"page. The OCR text contains recognition errors - misread characters, wrong words, "
            f"garbled fragments. Use the IMAGE as the ground truth: for each numbered line, find "
            f"the corresponding text in the image, read what it ACTUALLY says, and translate that "
            f"into {target_language}.\n\n"
            f"Rules:\n"
            f"- Keep company names, trademarks, product names and personal names unchanged.\n"
            f"- Preserve dates, numbers, currencies, amounts and identifiers exactly as shown in the image.\n"
            f"- Lines may be labels, table cells or fragments - translate each independently.\n"
            f"- If a line can't be located in the image, translate the OCR text as-is.\n\n"
            f"Return ONLY a numbered list with EXACTLY {len(chunk)} lines, in the exact same order "
            f"(line N in = line N out) - no commentary, no merged or split lines, no markdown."
        )
        try:
            content, _provider = _call_vision_with_failover(llm_config, system_prompt, numbered_input, image_b64, max_tokens=4000)
        except LeaseEngineError as err:
            print(f"Vision line-translation failed for chunk starting at {start}: {err} - falling back to text-only translation for this chunk.")
            content = None
        if not content:
            results.extend(_translate_lines_batch(chunk, target_language, llm_config))
            continue
        translated_chunk = [None] * len(chunk)
        for line in content.strip().split("\n"):
            m = re.match(r"^\s*(\d+)[.):]\s*(.*)$", line)
            if m:
                idx = int(m.group(1)) - 1
                if 0 <= idx < len(chunk):
                    translated_chunk[idx] = m.group(2).strip()
        results.extend(t if t else original for t, original in zip(translated_chunk, chunk))
    return results


def _closest_builtin_font(bold, italic):
    if bold and italic:
        return "Helvetica-BoldOblique"
    if bold:
        return "Helvetica-Bold"
    if italic:
        return "Helvetica-Oblique"
    return "Helvetica"


_FONTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts")


def _load_pil_font(size, bold=False, script="latin"):
    """Loads a bundled TrueType font (shipped in py/fonts/ rather than
    relying on whatever happens to be installed system-wide, since a
    slim Docker base image often has zero fonts at all) sized for PIL's
    ImageDraw. Arabic script gets Noto Sans Arabic (needed for the
    glyphs to render as anything other than empty boxes); everything
    else gets Noto Sans. Falls back to PIL's built-in bitmap font (fixed
    size, better than crashing) if the bundled files are ever missing."""
    try:
        if script == "arabic":
            path = os.path.join(_FONTS_DIR, "NotoSansArabic-Bold.ttf" if bold else "NotoSansArabic-Regular.ttf")
        else:
            path = os.path.join(_FONTS_DIR, "NotoSans-Regular.ttf")
        return ImageFont.truetype(path, max(8, int(size)))
    except Exception:
        return ImageFont.load_default()


def _group_ocr_words_into_lines(ocr_data, conf_threshold=8):
    """Groups pytesseract's word-level image_to_data() output back into
    lines, using its own (block_num, par_num, line_num) grouping rather
    than re-deriving Y-proximity - Tesseract has already done that
    analysis during OCR. The confidence floor here is intentionally low
    (Tesseract can score even correct words at conf<25 on stylized/large
    title text or busy backgrounds) - the priority is catching real text
    so it actually gets masked+translated rather than silently left
    untouched; only clearly invalid readings (conf<0, which Tesseract
    uses for structural/non-text placeholders, not real words) are
    dropped."""
    n = len(ocr_data["text"])
    lines = {}
    for i in range(n):
        text = ocr_data["text"][i].strip()
        try:
            conf = float(ocr_data["conf"][i])
        except (ValueError, TypeError):
            conf = -1
        if not text or conf < conf_threshold:
            continue
        key = (ocr_data["block_num"][i], ocr_data["par_num"][i], ocr_data["line_num"][i])
        lines.setdefault(key, []).append({
            "text": text, "left": ocr_data["left"][i], "top": ocr_data["top"][i],
            "width": ocr_data["width"][i], "height": ocr_data["height"][i],
        })

    regions = []
    for key in sorted(lines.keys()):
        words = lines[key]
        text = " ".join(w["text"] for w in words)
        left = min(w["left"] for w in words)
        top = min(w["top"] for w in words)
        right = max(w["left"] + w["width"] for w in words)
        bottom = max(w["top"] + w["height"] for w in words)
        regions.append({"text": text, "left": left, "top": top, "right": right, "bottom": bottom, "height": bottom - top})
    return regions


def _resolve_available_ocr_langs(requested_langs):
    """Item 2 - Tesseract raises (or on some builds, silently returns
    nothing) if asked for a language pack that isn't actually installed
    (e.g. this server hasn't been redeployed yet with the Dockerfile's
    tesseract-ocr-ara line). Filters the requested '+'-joined language
    string down to whatever's ACTUALLY available, so a missing language
    pack degrades to "still OCR in whichever languages ARE present"
    rather than silently extracting zero text for the whole page."""
    try:
        installed = set(pytesseract.get_languages(config=""))
    except Exception:
        installed = {"eng"}
    requested = [l for l in requested_langs.split("+") if l]
    available = [l for l in requested if l in installed]
    if not available:
        print(f"None of the requested OCR languages {requested} are installed (have: {sorted(installed)}) - falling back to English only.")
        available = ["eng"] if "eng" in installed else (sorted(installed)[:1] or ["eng"])
    missing = set(requested) - set(available)
    if missing:
        print(f"OCR language(s) {sorted(missing)} not installed on this server (needs a redeploy with the updated Dockerfile) - continuing with {available}.")
    return "+".join(available)


def generate_ocr_based_translation_pdf(original_pdf_path, output_pdf_path, target_language, llm_config=None, ocr_lang="eng+ara", diagnostics=None, vision_assist=False):
    """Item 6 - the scanned/image-only counterpart to
    generate_layout_preserving_translation_pdf(): when a page has no real
    text layer at all (the whole page is one embedded/scanned image,
    common for posters, faxes, and scanned contracts), there's no text
    object to surgically edit - so this renders the page to a
    high-resolution image, uses Tesseract's word-level bounding boxes
    (image_to_data, not just image_to_string) to find where the text
    actually sits, masks each detected line with a rectangle (sampling
    the source image's own nearby background color, not assuming white)
    drawn directly onto the image, and draws the translated line back at
    that same position with a bundled Unicode font - everything else in
    the image (icons, photos, background colors, decorative graphics) is
    untouched pixel data, since only the specific masked rectangles get
    overwritten.

    OCR language defaults to English+Arabic (ocr_lang="eng+ara") since
    that covers this feature's most common real case; pass a different
    `ocr_lang` for other source scripts (matching Tesseract's language
    codes, e.g. "eng+hin" for Hindi) - see the Dockerfile for which
    tesseract-ocr-<lang> packages are installed. Whatever's requested
    here is filtered down to whatever's actually installed on this
    server (see _resolve_available_ocr_langs) rather than failing
    outright if one language pack is missing.

    diagnostics (optional, a dict) - filled in with what actually
    happened (pdfium/tesseract versions, regions detected per page,
    translation call outcome, any errors) so the CALLER can surface this
    somewhere visible (the Activity Log) - added specifically because a
    production server's own console isn't something we can see directly,
    only what the app itself reports back."""
    if diagnostics is None:
        diagnostics = {}
    diagnostics["ocrLibsOk"] = OCR_LIBS_OK
    diagnostics["pdfplumberAvailable"] = bool(pdfplumber)
    try:
        import importlib.metadata as _importlib_metadata
        diagnostics["pypdfium2Version"] = _importlib_metadata.version("pypdfium2")
    except Exception as err:
        diagnostics["pypdfium2Version"] = f"unavailable: {err}"
    try:
        diagnostics["tesseractVersion"] = str(pytesseract.get_tesseract_version()) if OCR_LIBS_OK else "n/a"
    except Exception as err:
        diagnostics["tesseractVersion"] = f"unavailable: {err}"
    diagnostics["pages"] = []

    if not OCR_LIBS_OK:
        raise LeaseEngineError("pytesseract/Pillow are not installed - run: pip install -r requirements.txt")
    if not pdfplumber:
        raise LeaseEngineError("pdfplumber is not installed - run: pip install -r requirements.txt")

    from reportlab.pdfgen import canvas as pdfcanvas

    rtl = is_rtl_language(target_language)
    # 300 (not 200) matters a lot for photographed/low-res source scans:
    # on a real photographed Arabic utility bill, 200 DPI yielded ~20 OCR
    # words while 300 DPI yielded 127+ - Tesseract's recognizer is tuned
    # for roughly 300 DPI text height, so under-rendering the page image
    # starves it even when the right language pack IS installed.
    render_dpi = 300
    ocr_lang = _resolve_available_ocr_langs(ocr_lang)
    diagnostics["ocrLangUsed"] = ocr_lang

    story_pages = []
    with pdfplumber.open(original_pdf_path) as pdf:
        for page_num, page in enumerate(pdf.pages):
            page_diag = {"page": page_num + 1, "regionsDetected": 0, "regionsDrawn": 0, "error": None}
            page_image = page.to_image(resolution=render_dpi).original.convert("RGB")
            try:
                try:
                    ocr_data = pytesseract.image_to_data(page_image, lang=ocr_lang, output_type=pytesseract.Output.DICT)
                except Exception as err:
                    print(f"OCR failed on page {page_num + 1} (lang={ocr_lang}): {err} - this page will be left as the original image.")
                    page_diag["error"] = f"OCR call failed: {err}"
                    ocr_data = {"text": [], "conf": [], "left": [], "top": [], "width": [], "height": [], "block_num": [], "par_num": [], "line_num": []}
                regions = _group_ocr_words_into_lines(ocr_data)
                # Retry with --psm 6 ("assume a single uniform block of
                # text") when the default auto page segmentation (--psm 3)
                # found suspiciously little. Auto segmentation frequently
                # under-detects photographed documents with busy layouts
                # (bills, forms, tables) - on a real photographed Arabic
                # bill it found 34 line regions where psm 6 found 100+.
                # Whichever pass detects MORE regions wins.
                if len(regions) < 60:
                    try:
                        ocr_data_psm6 = pytesseract.image_to_data(page_image, lang=ocr_lang, config="--psm 6", output_type=pytesseract.Output.DICT)
                        regions_psm6 = _group_ocr_words_into_lines(ocr_data_psm6)
                        if len(regions_psm6) > len(regions):
                            print(f"OCR page {page_num + 1}: psm 6 retry found {len(regions_psm6)} regions vs {len(regions)} with auto segmentation - using psm 6 result.")
                            regions = regions_psm6
                            page_diag["psm6RetryUsed"] = True
                    except Exception as retry_err:
                        print(f"psm 6 OCR retry failed on page {page_num + 1}: {retry_err} - keeping the auto-segmentation result.")
                page_diag["regionsDetected"] = len(regions)
                print(f"OCR page {page_num + 1}: {len(regions)} text region(s) detected (lang={ocr_lang}).")

                if regions and vision_assist:
                    # Hybrid mode: send the page image along with the OCR
                    # lines so the model corrects Tesseract's misreads
                    # against the actual pixels before translating.
                    translated_texts = _translate_lines_batch_vision(page_image, [r["text"] for r in regions], target_language, llm_config)
                    page_diag["visionAssist"] = True
                elif regions:
                    translated_texts = _translate_lines_batch([r["text"] for r in regions], target_language, llm_config)
                else:
                    translated_texts = []
                page_diag["translatedCount"] = len(translated_texts)
                page_diag["sampleOriginal"] = regions[0]["text"] if regions else None
                page_diag["sampleTranslated"] = translated_texts[0] if translated_texts else None

                draw = ImageDraw.Draw(page_image)
                for region, translated in zip(regions, translated_texts):
                    try:
                        box_w = max(1, region["right"] - region["left"])
                        box_h = max(1, region["bottom"] - region["top"])
                        try:
                            bg = page_image.getpixel((region["left"], max(0, region["top"] - 3)))
                        except Exception:
                            bg = (255, 255, 255)
                        draw.rectangle([region["left"] - 2, region["top"] - 2, region["right"] + 2, region["bottom"] + 2], fill=bg)

                        script = "arabic" if rtl else "latin"
                        render_text = shape_rtl_text(translated) if rtl else translated
                        font_size = box_h
                        font = _load_pil_font(font_size, script=script)
                        while font_size > 6:
                            bbox = draw.textbbox((0, 0), render_text, font=font)
                            if (bbox[2] - bbox[0]) <= box_w or font_size <= 6:
                                break
                            font_size -= 1
                            font = _load_pil_font(font_size, script=script)

                        text_color = (0, 0, 0)
                        if rtl:
                            bbox = draw.textbbox((0, 0), render_text, font=font)
                            draw.text((region["right"] - (bbox[2] - bbox[0]), region["top"]), render_text, font=font, fill=text_color)
                        else:
                            draw.text((region["left"], region["top"]), render_text, font=font, fill=text_color)
                        page_diag["regionsDrawn"] += 1
                    except Exception as region_err:
                        # One region failing to mask/redraw (a font glitch,
                        # an unusual bbox) shouldn't sacrifice every OTHER
                        # region on the page - that region's original text
                        # just stays as-is and the rest continue normally.
                        print(f"Could not mask/redraw region {region.get('text','')!r} on page {page_num + 1}: {region_err}")
            except Exception as page_err:
                # Same principle one level up: a full page failing
                # (a genuinely broken image, an OCR crash that isn't
                # caught above) leaves that ONE page as the original
                # image rather than failing the entire document.
                print(f"Page {page_num + 1} could not be processed for translation, leaving it as the original image: {page_err}")
                page_diag["error"] = page_diag["error"] or str(page_err)
            diagnostics["pages"].append(page_diag)

            story_pages.append((page_image, float(page.width), float(page.height)))

    buf = io.BytesIO()
    c = None
    for page_image, page_w_pt, page_h_pt in story_pages:
        if c is None:
            c = pdfcanvas.Canvas(buf, pagesize=(page_w_pt, page_h_pt))
        else:
            c.showPage()
            c.setPageSize((page_w_pt, page_h_pt))
        img_buf = io.BytesIO()
        page_image.save(img_buf, format="PNG")
        img_buf.seek(0)
        c.drawImage(ImageReader(img_buf), 0, 0, width=page_w_pt, height=page_h_pt)
    if c is not None:
        c.save()
    buf.seek(0)
    with open(output_pdf_path, "wb") as f:
        f.write(buf.read())


def generate_layout_preserving_translation_pdf(original_pdf_path, output_pdf_path, target_language, llm_config=None, diagnostics=None, vision_assist=False):
    """Item 6 (per the uploaded 'Document Translation Instructions' spec)
    - rather than extracting the document's text and rebuilding a brand
    new, generically-formatted PDF from scratch (the old approach), this
    surgically edits the ORIGINAL PDF in place: for each page, every
    detected line of text gets masked with a white rectangle and the
    translated line drawn back in the exact same position/font
    size/color - everything else on the page (images, logos, signatures,
    stamps, tables' borders/shading, vector graphics) is the ORIGINAL
    PDF's own content, completely untouched, because this never redraws
    the page - it only overlays on top of it.

    Font MATCHING is approximate (built-in Helvetica + bold/italic
    variants, not the original's exact embedded font - true font
    substitution would need font-metrics analysis this renderer doesn't
    have), and very long translated lines get their font size shrunk down
    (never enlarged) to stay inside the original line's width, per the
    spec's 'minimal adjustments, never overflow' rule. Routes to the
    OCR-based image-overlay approach (generate_ocr_based_translation_pdf)
    if the source has no real text layer at all (a scanned/image-only
    PDF - there's no text OBJECT to surgically edit, but OCR can still
    find where the visible text sits on the rendered page and mask/redraw
    it the same way)."""
    if not REPORTLAB_OK:
        raise LeaseEngineError("reportlab is not installed - run: pip install -r requirements.txt")
    if not pdfplumber or not PdfReader:
        raise LeaseEngineError("pdfplumber/pypdf are not installed - run: pip install -r requirements.txt")

    from pypdf import PdfWriter
    from reportlab.pdfgen import canvas as pdfcanvas
    from reportlab.pdfbase.pdfmetrics import stringWidth

    rtl = is_rtl_language(target_language)
    reader = PdfReader(original_pdf_path)
    writer = PdfWriter()

    with pdfplumber.open(original_pdf_path) as pdf:
        any_real_text = any(p.chars for p in pdf.pages)
        if diagnostics is not None:
            diagnostics["pathUsed"] = "ocr-image-based" if not any_real_text else "text-layer-based"
        if not any_real_text:
            return generate_ocr_based_translation_pdf(original_pdf_path, output_pdf_path, target_language, llm_config, diagnostics=diagnostics, vision_assist=vision_assist)

        for page_index, page in enumerate(pdf.pages):
            lines = _group_chars_into_lines(page.chars)
            regions = [r for r in (_line_to_region(l) for l in lines) if r]

            translated_texts = _translate_lines_batch([r["text"] for r in regions], target_language, llm_config) if regions else []

            page_width, page_height = float(page.width), float(page.height)
            buf = io.BytesIO()
            c = pdfcanvas.Canvas(buf, pagesize=(page_width, page_height))

            for region, translated in zip(regions, translated_texts):
                box_w = max(1.0, region["x1"] - region["x0"])
                box_h = max(1.0, region["bottom"] - region["top"])
                # Mask the original line - white covers the overwhelming
                # majority of real-world documents; per-region background
                # color detection is a possible future refinement.
                c.setFillColorRGB(1, 1, 1)
                c.rect(region["x0"] - 1, page_height - region["bottom"] - 1, box_w + 2, box_h + 2, fill=1, stroke=0)

                font_name = _closest_builtin_font(region["bold"], region["italic"])
                render_text = shape_rtl_text(translated) if rtl else translated
                font_size = region["size"]
                while font_size > 5 and stringWidth(render_text, font_name, font_size) > box_w:
                    font_size -= 0.5

                try:
                    hexc = region["color"].lstrip("#")
                    r, g, b = (int(hexc[0:2], 16) / 255, int(hexc[2:4], 16) / 255, int(hexc[4:6], 16) / 255)
                except (ValueError, IndexError, TypeError):
                    r, g, b = 0, 0, 0
                c.setFillColorRGB(r, g, b)
                c.setFont(font_name, font_size)
                baseline_y = page_height - region["bottom"] + 1.5
                if rtl:
                    c.drawRightString(region["x1"], baseline_y, render_text)
                else:
                    c.drawString(region["x0"], baseline_y, render_text)

            c.save()
            buf.seek(0)
            overlay_reader = PdfReader(buf)
            overlay_page = overlay_reader.pages[0]
            original_page = reader.pages[page_index]
            # The overlay (white masks + translated text, just built above)
            # must end up as the TOP layer with the original page's content
            # underneath it - merging the original INTO the overlay with
            # over=False (rather than merging the overlay into the
            # original) is what actually achieves that; doing it the other
            # way around left the original text still on top, showing
            # through the "masking" rectangles.
            overlay_page.merge_page(original_page, over=False)
            writer.add_page(overlay_page)

    with open(output_pdf_path, "wb") as f:
        writer.write(f)


def generate_translation_pdf(output_json_path, pdf_out_path):
    """Builds Output.pdf for a translation job. Item 6 - auto-detects the
    translated text's structure (paragraphs, bullet lists, numbered
    lists, headings, bold emphasis - all marked up by translate_text()'s
    prompt) and renders each as the appropriate PDF element, rather than
    dumping everything as flat paragraphs. No metadata table - just a
    one-line header, then the formatted document itself.

    Also handles text direction (item 6): right-to-left languages
    (Arabic, Hebrew, ...) get right-aligned paragraphs and their text run
    through arabic_reshaper + python-bidi so RTL glyphs join correctly and
    read in the right visual order - translating INTO English (or another
    LTR language) always renders left-to-right regardless of what
    direction the source document used, and vice versa: direction follows
    the OUTPUT language, never the source."""
    if not REPORTLAB_OK:
        raise LeaseEngineError(
            "reportlab is not installed - run: pip install -r requirements.txt"
        )

    with open(output_json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    _render_reflowed_translation_pdf(
        data.get("docName", "Document"),
        data.get("targetLanguage", ""),
        data.get("translatedText", ""),
        pdf_out_path,
    )


def _render_reflowed_translation_pdf(doc_name, target_language, translated_text, pdf_out_path):
    """The reflow renderer factored out of generate_translation_pdf so
    the Simple-mode vision path can reuse it - takes marked-up translated
    text (translate_text() / vision conventions: blank-line paragraphs,
    '- ' bullets, numbered lists, '## ' headings, **bold**) and renders a
    clean formatted document."""
    if not REPORTLAB_OK:
        raise LeaseEngineError(
            "reportlab is not installed - run: pip install -r requirements.txt"
        )

    rtl = is_rtl_language(target_language)
    align = TA_RIGHT if rtl else TA_LEFT

    doc = SimpleDocTemplate(
        pdf_out_path, pagesize=LETTER,
        topMargin=0.6 * inch, bottomMargin=0.6 * inch,
        leftMargin=0.6 * inch, rightMargin=0.6 * inch,
    )
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "TranslationTitle", parent=styles["Heading1"], textColor=colors.black, fontSize=16, spaceAfter=2
    )
    normal = ParagraphStyle("TranslationNormal", parent=styles["Normal"], fontSize=8.5, alignment=align)
    body_style = ParagraphStyle("TranslationBody", parent=normal, fontSize=10.5, spaceAfter=10, leading=16, alignment=align)
    heading_style = ParagraphStyle("TranslationHeading", parent=normal, fontSize=13, spaceBefore=12, spaceAfter=8, fontName="Helvetica-Bold", alignment=align)
    # Bullets/numbers visually belong on the side text flows TOWARD in
    # each direction (left indent for LTR, right indent mirrored for RTL).
    bullet_style = ParagraphStyle("TranslationBullet", parent=body_style,
                                   leftIndent=0 if rtl else 18, rightIndent=18 if rtl else 0, spaceAfter=4)
    numbered_style = ParagraphStyle("TranslationNumbered", parent=body_style,
                                     leftIndent=0 if rtl else 20, rightIndent=20 if rtl else 0, spaceAfter=4)

    def _render(text):
        return _escape_and_apply_bold(text, rtl=rtl)

    story = [
        Paragraph("Translation Report", title_style),
        Paragraph(f"Document : {doc_name}  \u00b7  Translated to {target_language}", normal),
        Spacer(1, 14),
    ]

    for block_type, content in _parse_translation_blocks(translated_text):
        if block_type == "heading":
            story.append(Paragraph(_render(content), heading_style))
        elif block_type == "bullet":
            for item in content:
                text = f"{_render(item)}&nbsp;&nbsp;\u2022" if rtl else f"&bull;&nbsp;&nbsp;{_render(item)}"
                story.append(Paragraph(text, bullet_style))
        elif block_type == "numbered":
            for i, item in enumerate(content, 1):
                text = f"{_render(item)}&nbsp;&nbsp;.{i}" if rtl else f"{i}.&nbsp;&nbsp;{_render(item)}"
                story.append(Paragraph(text, numbered_style))
        else:
            story.append(Paragraph(_render(content), body_style))

    if not story[3:]:
        story.append(Paragraph("(No translated content)", body_style))

    doc.build(story)


def generate_vision_translation_pdf(original_pdf_path, output_pdf_path, target_language, doc_name="Document", llm_config=None, diagnostics=None):
    """Simple mode for scanned/photo PDFs - completely bypasses Tesseract:
    each page is rendered to an image and sent to the vision-capable chat
    model, which reads the page like Google Lens does (deep-learning
    vision handles photos, skew, low contrast far better than classical
    OCR) and returns the full translation directly, marked up with the
    same structure conventions translate_text() uses. Output is a clean
    reflowed document - accurate text, but NOT the original layout (that
    trade-off is exactly what the Hybrid checkbox toggles).

    Raises LeaseEngineError if no LLM key is configured or every page's
    vision call failed - the caller decides what to fall back to."""
    if diagnostics is None:
        diagnostics = {}
    llm_config = llm_config if llm_config is not None else load_llm_config()
    if not llm_is_configured(llm_config):
        raise LeaseEngineError("Vision translation needs an OpenAI/OpenRouter API key in .env")
    if not pdfplumber:
        raise LeaseEngineError("pdfplumber is not installed - run: pip install -r requirements.txt")

    system_prompt = (
        f"You are a professional document translator. You are given an IMAGE of one page of a "
        f"document. First carefully read ALL visible text in the image, in its natural reading "
        f"order. Then translate everything into {target_language}.\n\n"
        f"Requirements:\n"
        f"- Translate only the textual content; preserve the original meaning.\n"
        f"- Preserve legal, medical, technical and business terminology.\n"
        f"- Keep company names, trademarks, product names and personal names unchanged unless a "
        f"standard translation exists.\n"
        f"- Preserve dates, numbers, currencies, amounts, meter readings and identifiers exactly.\n"
        f"- Do not summarize, do not explain, do not add or remove content.\n\n"
        f"Mark up the structure you see using these plain-text conventions (the renderer "
        f"auto-formats from them):\n"
        f"- Separate distinct paragraphs/sections with a single BLANK LINE.\n"
        f"- Bullet items: start the line with '- '. Numbered items: '1. ', '2. ', ...\n"
        f"- Section headings/titles: start the line with '## '.\n"
        f"- Visually emphasized text (key figures, totals, warnings): wrap in **double asterisks**.\n"
        f"- For tables, render each row as 'Label: value' lines.\n\n"
        f"Return ONLY the translated, marked-up text - no preamble, no notes."
    )

    page_texts = []
    diagnostics["pathUsed"] = "vision-full-page"
    diagnostics["pages"] = []
    with pdfplumber.open(original_pdf_path) as pdf:
        total = len(pdf.pages)
        for page_num, page in enumerate(pdf.pages):
            page_diag = {"page": page_num + 1, "error": None}
            try:
                page_image = page.to_image(resolution=300).original.convert("RGB")
                image_b64 = _pil_image_to_jpeg_b64(page_image)
                content, provider = _call_vision_with_failover(
                    llm_config, system_prompt,
                    f"Translate this page ({page_num + 1} of {total}) into {target_language}.",
                    image_b64, max_tokens=8000,
                )
                if content:
                    page_texts.append(content.strip())
                    page_diag["provider"] = provider
                    page_diag["chars"] = len(content)
                else:
                    page_diag["error"] = "no LLM key configured"
            except LeaseEngineError as err:
                print(f"Vision translation failed on page {page_num + 1}: {err}")
                page_diag["error"] = str(err)
            diagnostics["pages"].append(page_diag)

    if not page_texts:
        raise LeaseEngineError("Vision translation produced no text for any page")

    translated_text = "\n\n".join(page_texts)
    diagnostics["translatedChars"] = len(translated_text)
    _render_reflowed_translation_pdf(doc_name, target_language, translated_text, output_pdf_path)
    return translated_text


def analyze_lease(text, fallback_name="Lease Document"):
    """Section 14.3 (40%) - 'data analyzed and interpreted using GPT
    prompts'. Tries a real LLM call (OpenAI/OpenRouter, key from .env
    + json/extraction_prompt.txt) first; falls back to the heuristic engine
    if no key is configured or the call fails. Either way, also runs a
    second lightweight pass (call_llm_validation, or a heuristic
    completeness check without an LLM) to produce an accuracy/confidence
    score - same two-stage extract-then-validate shape as the reference
    project's /api/extract + /api/validate routes."""
    doc_type = classify_document(text)
    llm_config = load_llm_config()

    try:
        llm_fields, used_provider = call_llm_extraction(text, llm_config=llm_config)
    except LeaseEngineError as err:
        # Every configured provider's call failed - fall back rather than
        # aborting the whole pipeline, but keep the error visible.
        print(f"LLM extraction failed on every configured provider, falling back to heuristic engine: {err}")
        llm_fields, used_provider = None, None

    if llm_fields is not None:
        lease_name = sanitize_lease_name(_lease_name_source_from_fields(llm_fields, fallback_name))
        result = {
            "docType": doc_type,
            "leaseName": lease_name,
            "fields": llm_fields,
            "extractionMethod": f"llm-{used_provider}",
        }
    else:
        result = heuristic_analyze_lease(text, fallback_name=fallback_name)
        result["docType"] = doc_type  # keep a single source of truth for classification

    result.update(_run_accuracy_check(result["fields"], llm_config))
    rules_applied, rules_total = get_rules_applied_count()
    result["rulesApplied"] = rules_applied
    result["rulesTotal"] = rules_total
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


def _build_kv_table(rows, col_widths=None):
    from xml.sax.saxutils import escape as _esc

    cell_style = ParagraphStyle("KVCell", fontSize=8.5, leading=11, fontName=_active_font())
    header_style = ParagraphStyle(
        "KVHeader", fontSize=8.5, leading=11, textColor=_active_header_text(), fontName=_active_font_bold()
    )
    table_data = [[Paragraph("Field", header_style), Paragraph("Value", header_style)]]
    for label, value in rows:
        table_data.append([
            Paragraph(_esc(str(label)), cell_style),
            Paragraph(_esc(str(value)).replace("\n", "<br/>"), cell_style),
        ])

    table = Table(table_data, colWidths=list(col_widths) if col_widths else _normalize_widths([2.3, 3.7]))
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), _active_header_bg()),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#AAAAAA")),
        ("BOX", (0, 0), (-1, -1), 0.5, _NAVY),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, _STRIPE]),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    return table


# ============================================================
# Template-matching PDF sections (item 6 - mirrors the structure of the
# real "Lease Abstract" output format: Lease Information grid, Charge
# Schedules table, Amendments table, Late Fee, a per-clause Other Lease
# Provisions/Clauses table, and a Contacts table). Only used when `fields`
# has the rich nested LLM schema shape (see json/extraction_prompt.txt) -
# the flat heuristic-engine schema still falls back to the older generic
# key/value renderer below it, since it doesn't carry per-clause data.
# ============================================================
_CURRENCY_ARTIFACT_RE = re.compile(r"\${2,}")
_COMMA_ARTIFACT_RE = re.compile(r",{2,}")
_WHITESPACE_ARTIFACT_RE = re.compile(r"[ \t]{2,}")


def _sanitize_leaf_string(value):
    """Item 1 - self-QA pass that catches common LLM/formatting artifacts
    before they reach Output.json or the PDF, instead of just hoping the
    extraction got it right. Fixes things like the extraction prompt
    saying 'format as $X' while the PDF builder ALSO prepends its own $,
    producing '$$10,479.88' - collapses doubled currency symbols,
    doubled commas, and doubled internal whitespace. Deliberately
    conservative: only touches unambiguous duplication artifacts, never
    rewrites the actual content/meaning of a value."""
    if not isinstance(value, str) or not value:
        return value
    cleaned = _CURRENCY_ARTIFACT_RE.sub("$", value)
    cleaned = _COMMA_ARTIFACT_RE.sub(",", cleaned)
    cleaned = _WHITESPACE_ARTIFACT_RE.sub(" ", cleaned).strip()
    return cleaned


def sanitize_fields_recursively(value):
    """Applies _sanitize_leaf_string to every string leaf in a nested
    fields dict/list (the rich LLM extraction schema), leaving numbers,
    dicts, and list structure untouched. Called once right when a lease's
    Output.json is first saved (see save-output in server.py), so both
    the Human Review screen and the final PDF see the cleaned values."""
    if isinstance(value, dict):
        return {k: sanitize_fields_recursively(v) for k, v in value.items()}
    if isinstance(value, list):
        return [sanitize_fields_recursively(v) for v in value]
    if isinstance(value, str):
        return _sanitize_leaf_string(value)
    return value


def _get_path(d, path, default=""):
    cur = d
    for part in path.split("."):
        if not isinstance(cur, dict):
            return default
        cur = cur.get(part)
    return cur if cur not in (None, "") else default


def compute_lease_fingerprint(fields):
    """Item 6 - a content-level duplicate check, not just 'same lease
    name'. Builds a canonical string from the handful of fields that
    genuinely identify a unique lease (tenant, landlord, property address,
    commencement/expiration dates) - normalized (lowercased, whitespace
    collapsed) so trivial OCR/formatting differences between two scans of
    the SAME lease don't produce different fingerprints - and hashes it.
    Two documents with the same fingerprint are almost certainly the same
    underlying lease (or a reference/exhibit document whose extracted
    'lease' details are identical to one already on file), even if their
    filenames or auto-generated lease names differ."""
    if not isinstance(fields, dict):
        return None
    parts = [
        _get_path(fields, "parties.tenant_legal_name"),
        _get_path(fields, "parties.landlord_legal_name"),
        _get_path(fields, "premises.property_address"),
        _get_path(fields, "term.lease_commencement_date"),
        _get_path(fields, "term.lease_expiration_date"),
    ]
    normalized = "|".join(re.sub(r"\s+", " ", str(p).strip().lower()) for p in parts if p)
    if not normalized or normalized.count("|") < 2:
        return None  # not enough identifying data to fingerprint reliably
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:24]


def _flatten_leaves(d, prefix=""):
    """Yields (dotted.path, value) for every leaf (non-dict, non-list-of-
    dicts) value in a nested dict - used by compare_extraction_accuracy
    below to line up two field dicts leaf-by-leaf even if one has extra
    sections the other doesn't."""
    if isinstance(d, dict):
        for k, v in d.items():
            yield from _flatten_leaves(v, f"{prefix}.{k}" if prefix else k)
    elif isinstance(d, list):
        for i, v in enumerate(d):
            yield from _flatten_leaves(v, f"{prefix}[{i}]")
    else:
        yield (prefix, d)


def _leaf_similarity(a, b):
    """1.0 for an exact match (after trimming/lowercasing so formatting
    differences like extra whitespace don't count against a match), down
    to 0.0 for completely different text - uses difflib's ratio for a
    fuzzy partial-credit score in between, since 'Lease is silent.' vs
    'Lease is silent' should score high, not zero."""
    sa, sb = str(a or "").strip().lower(), str(b or "").strip().lower()
    if sa == sb:
        return 1.0
    if not sa or not sb:
        return 0.0
    return difflib.SequenceMatcher(None, sa, sb).ratio()


def extract_lease_pdf_as_dict(pdf_path):
    """Item (Test & Compare with PDF files, not JSON) - reverse-parses a
    Lease Abstract-style PDF (ours, or a human-produced one in the same
    general layout) back into a flat {label: value} dict, so two PDFs -
    a human-reviewed reference and our own generated Output.pdf - can be
    diffed field-by-field via compare_extraction_accuracy() without
    either side needing to be JSON. Works off whatever tables pdfplumber
    can detect on each page: a 2-column table becomes {label: value} rows
    directly; a wider data table (Charge Schedules, Amendments, ...) uses
    its own header row as column names and keys each cell as
    'table{N}_row{R}_{ColumnHeader}' - matching by the ACTUAL label/header
    text rather than assuming an identical internal schema is what makes
    this robust to a human's PDF looking slightly different from ours
    structurally, as long as the labels themselves read the same."""
    if not pdfplumber:
        raise LeaseEngineError("pdfplumber is not installed - run: pip install -r requirements.txt")

    result = {}
    with pdfplumber.open(pdf_path) as pdf:
        table_counter = 0
        for page in pdf.pages:
            tables = page.extract_tables()
            for table in tables:
                if not table or not table[0]:
                    continue
                table_counter += 1
                # 2-column table => straightforward label:value rows.
                if all(len(row) == 2 for row in table):
                    for row in table:
                        label = (row[0] or "").strip()
                        value = (row[1] or "").strip()
                        if label:
                            result[label] = value
                    continue
                # 4-column table => our own Lease Information grid layout
                # (label, value, label, value per row).
                if all(len(row) == 4 for row in table):
                    for row in table:
                        for label, value in ((row[0], row[1]), (row[2], row[3])):
                            label = (label or "").strip()
                            value = (value or "").strip()
                            if label:
                                result[label] = value
                    continue
                # Any other width => a data table (Charge Schedules,
                # Amendments, ...); first row is the header/column names,
                # every following row's cells key off that header plus a
                # row index (so repeated rows don't collide with each
                # other).
                header = [(h or "").strip() or f"col{i}" for i, h in enumerate(table[0])]
                for row_idx, row in enumerate(table[1:]):
                    for col_idx, cell in enumerate(row):
                        if col_idx >= len(header):
                            continue
                        key = f"table{table_counter}_row{row_idx}_{header[col_idx]}"
                        result[key] = (cell or "").strip()
    return result


def compare_extraction_accuracy(reference_fields, current_fields):
    """Item 4 (Test & Compare) - scores how closely `current_fields` (this
    system's own extraction) matches `reference_fields` (a human-reviewed
    "ideal" answer key for the same lease), field by field. Returns
    {overallAccuracy, fieldResults: [{path, referenceValue, currentValue,
    similarity}]} sorted worst-match-first, so the biggest discrepancies -
    the ones most worth turning into a new/updated rule - surface at the
    top."""
    reference_leaves = dict(_flatten_leaves(reference_fields or {}))
    current_leaves = dict(_flatten_leaves(current_fields or {}))

    field_results = []
    total_similarity = 0.0
    for path, ref_value in reference_leaves.items():
        cur_value = current_leaves.get(path, "")
        sim = _leaf_similarity(ref_value, cur_value)
        total_similarity += sim
        field_results.append({
            "path": path, "referenceValue": ref_value, "currentValue": cur_value,
            "similarity": round(sim, 3),
        })

    field_results.sort(key=lambda r: r["similarity"])
    overall = round((total_similarity / len(reference_leaves)) * 100, 1) if reference_leaves else 0.0
    return {"overallAccuracy": overall, "fieldResults": field_results, "fieldCount": len(reference_leaves)}


# (template clause id, display name, dotted path into `fields`) - covers
# every clause the extraction prompt (json/extraction_prompt.txt) already
# asks the LLM to extract per-field, in the same order the reference
# "Other Lease Provisions / Clauses" table uses.
_CLAUSE_FIELD_MAP = [
    ("assign", "Assignment & Sublease", "assignment_subletting.with_consent"),
    ("rent", "Rent", "term.rental_term"),
    ("cotenanc", "Co-Tenancy", "use.go_dark"),
    ("default", "Default", "default.monetary_default"),
    ("estoppel", "Estoppel", "estoppel"),
    ("conuse", "Continuous Use or Go Dark", "use.failure_to_open"),
    ("guaranty", "Guaranty", "parties.guarantor"),
    ("holdover", "Holdover", "rent.holdover"),
    ("late fee", "Late Fee", "rent.late_fee"),
    ("opex/cam", "OpEx/CAM", "cam_opex.cam_detail"),
    ("insreimb", "Insurance Reimbursement", "insurance"),
    ("brokers", "Brokers", "brokers.landlord_broker"),
    ("taxes", "Real Estate Taxes", "cam_opex.real_property_taxes_pro_rata_share"),
    ("permit", "Permitted Use", "use.permitted_use"),
    ("percent", "Percentage Rent", "rent.percentage_rent"),
    ("tt ins", "Tenant Insurance", "insurance"),
    ("utility", "Utilities", "utilities"),
    ("security", "Security Deposit", "rent.security_deposit"),
    ("ti allow", "TI Allowance", "ti_allowance"),
    ("llrepair", "LL's Repair", "repairs.roof_repair"),
    ("ttrep", "TT's Repair", "repairs.tenant_repair"),
    ("misc", "Miscellaneous", "miscellaneous"),
    ("reloc", "Relocation Option", "options.renewal_options"),
    ("roof", "Roof Repairs", "repairs.roof_repair"),
    ("alter", "Alterations", "alterations"),
    ("snda", "Subordination", "subordination"),
    ("prohib", "Prohibited Use", "use.prohibited_use"),
]


def _is_rich_lease_schema(fields):
    return isinstance(fields, dict) and isinstance(fields.get("parties"), dict)


# (template clause id, display name, dotted path into `fields`) - covers
# every clause the extraction prompt (json/extraction_prompt.txt) already
# asks the LLM to extract per-field, in the same order the reference
# "Other Lease Provisions / Clauses" table uses.
_CLAUSE_FIELD_MAP = [
    ("assign", "Assignment & Sublease", "assignment_subletting.with_consent"),
    ("rent", "Rent", "term.rental_term"),
    ("cotenanc", "Co-Tenancy", "use.go_dark"),
    ("default", "Default", "default.monetary_default"),
    ("estoppel", "Estoppel", "estoppel"),
    ("conuse", "Continuous Use or Go Dark", "use.failure_to_open"),
    ("guaranty", "Guaranty", "parties.guarantor"),
    ("holdover", "Holdover", "rent.holdover"),
    ("late fee", "Late Fee", "rent.late_fee"),
    ("opex/cam", "OpEx/CAM", "cam_opex.cam_detail"),
    ("insreimb", "Insurance Reimbursement", "insurance"),
    ("brokers", "Brokers", "brokers.landlord_broker"),
    ("taxes", "Real Estate Taxes", "cam_opex.real_property_taxes_pro_rata_share"),
    ("permit", "Permitted Use", "use.permitted_use"),
    ("percent", "Percentage Rent", "rent.percentage_rent"),
    ("tt ins", "Tenant Insurance", "insurance"),
    ("utility", "Utilities", "utilities"),
    ("security", "Security Deposit", "rent.security_deposit"),
    ("ti allow", "TI Allowance", "ti_allowance"),
    ("llrepair", "LL's Repair", "repairs.roof_repair"),
    ("ttrep", "TT's Repair", "repairs.tenant_repair"),
    ("misc", "Miscellaneous", "miscellaneous"),
    ("reloc", "Relocation Option", "options.renewal_options"),
    ("roof", "Roof Repairs", "repairs.roof_repair"),
    ("alter", "Alterations", "alterations"),
    ("snda", "Subordination", "subordination"),
    ("prohib", "Prohibited Use", "use.prohibited_use"),
]

_NAVY = colors.HexColor("#00008B")
_SECTION_BG = colors.HexColor("#D9D9D9")  # gray section-title bar, matches the reference template
_STRIPE = colors.HexColor("#F5F5FF")

# Letter page (8.5in) minus the 0.6in left/right margins set on the
# SimpleDocTemplate below - every table in this file is normalized to sum
# to exactly this, so every section (Lease Information, Charge Schedules,
# Amendments, ...) spans the full page width consistently instead of each
# one being some arbitrary, visually-inconsistent width.
_CONTENT_WIDTH = LETTER[0] - 1.2 * inch


def _normalize_widths(relative_widths):
    """Scales a list of relative column-width numbers so they sum to
    exactly _CONTENT_WIDTH, in points. Lets each table describe its
    columns' widths *relative to each other* (which one should be wider)
    without needing to hand-compute exact inch values that add up right -
    every table ends up the same total width regardless."""
    total = sum(relative_widths)
    return [w / total * _CONTENT_WIDTH for w in relative_widths]


# Item 6 - when a custom Output Template's style was detected
# (extract_template_style / save_template_style_profile above),
# generate_output_pdf sets this once before building the story, and every
# _build_* table/header helper below reads from it instead of the
# hardcoded gray/Helvetica defaults - so a template's header color, text
# color, and font family carry through to the generated report.
_ACTIVE_STYLE = {"headerBgColor": None, "headerTextColor": None, "fontFamily": None}


def _active_header_bg():
    if _ACTIVE_STYLE.get("headerBgColor"):
        try:
            return colors.HexColor(_ACTIVE_STYLE["headerBgColor"])
        except Exception:
            pass
    return _SECTION_BG


def _active_header_text():
    if _ACTIVE_STYLE.get("headerTextColor"):
        try:
            return colors.HexColor(_ACTIVE_STYLE["headerTextColor"])
        except Exception:
            pass
    return colors.black


def _active_font():
    return _ACTIVE_STYLE.get("fontFamily") or "Helvetica"


def _active_font_bold():
    base = _active_font()
    return {"Times-Roman": "Times-Bold", "Courier": "Courier-Bold"}.get(base, "Helvetica-Bold")


def _section_bar(text, col_span, styles):
    """The gray full-width "Lease Information" / "Charge Schedules" / etc
    bar the reference template uses as a section title - built as a
    single-row, single-cell table so it lines up exactly with the section
    body table beneath it (a Paragraph heading alone won't align)."""
    style = ParagraphStyle("SectionBar", fontName=_active_font_bold(), fontSize=9, textColor=_active_header_text())
    t = Table([[Paragraph(text, style)]], colWidths=[sum(col_span)])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), _active_header_bg()),
        ("BOX", (0, 0), (-1, -1), 0.5, _NAVY),
        ("LEFTPADDING", (0, 0), (-1, -1), 6), ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return t


def _parse_date_loose(s):
    for fmt in ("%m/%d/%Y", "%m/%d/%y", "%B %d, %Y", "%b %d, %Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(s.strip(), fmt)
        except (ValueError, AttributeError):
            continue
    return None


def _term_months(start, end):
    d1, d2 = _parse_date_loose(start), _parse_date_loose(end)
    if not d1 or not d2:
        return ""
    months = (d2.year - d1.year) * 12 + (d2.month - d1.month)
    return str(max(months, 0))


def _digits_only(s):
    m = re.search(r"[\d,]+", s or "")
    return m.group(0) if m else ""


def _ensure_dollar_prefix(value):
    """Guarantees exactly one leading '$' on a currency string, regardless
    of whether the source (LLM extraction) already included one - safer
    than either assuming it's always there or always prepending one."""
    s = _stringify_leaf(value)
    if s in ("-", ""):
        return s
    return s if s.startswith("$") else f"${s}"


def _build_lease_information_grid(fields, lease_name):
    """A single 4-column (label/value/label/value) grid matching the
    reference template's "Lease Information" layout exactly. A handful of
    fields shown there (Status, ICS Code, Property code, Sales Category,
    Office Phone, FAX) are internal property-management-system metadata
    that simply isn't present in a lease document's text - those cells
    show the template's own apparent constant/blank convention rather than
    fabricated data."""
    lbl = ParagraphStyle("GridLabel", fontName=_active_font_bold(), fontSize=8.5, leading=11)
    val = ParagraphStyle("GridVal", fontName=_active_font(), fontSize=8.5, leading=11)

    def L(text):
        return Paragraph(text, lbl)

    def V(text):
        return Paragraph(_stringify_leaf(text) or "-", val)

    tenant = _get_path(fields, "parties.tenant_legal_name") or lease_name
    premises_size = _get_path(fields, "premises.premises_size")
    security_deposit = _get_path(fields, "rent.security_deposit")
    start = _get_path(fields, "term.lease_commencement_date")
    end = _get_path(fields, "term.lease_expiration_date")

    rows = [
        [L("Name"), V(tenant), L("Status"), V("Future")],
        [L("DBA"), V(_get_path(fields, "parties.tenant_dba")), L("ICS Code"), V("-")],
        [L("Property"), V(_get_path(fields, "premises.property_address")), L("Lease Type"), V(_get_path(fields, "premises.lease_type"))],
        [L("Landlord"), V(_get_path(fields, "parties.landlord_legal_name")), L("Sales Category"), V("General")],
        [L("Guarantor"), V(_get_path(fields, "parties.guarantor_name") or _get_path(fields, "parties.guarantor")),
         L("Contract Area"), Paragraph(f"{_stringify_leaf(premises_size) or '0.00'} (Rentable)", val)],
        [L(""), V(""), L("Area"), Paragraph("0.00 (Rentable)", val)],
        [Paragraph("Primary Contact", lbl), Paragraph("", val), Paragraph("Monthly Rent", lbl), Paragraph("", val)],
        [L("Name"), V(tenant), L("Annual Rent"), V("0.00")],
        [L("Office Phone"), V("-"), L("Rent Per Area"), V("0.00")],
        [L("FAX"), V("-"), L("Deposit"), Paragraph(_ensure_dollar_prefix(security_deposit) if security_deposit else "0.00", val)],
        [L("E-Mail"), V("-"), L("Lease Term"), Paragraph(f"{start} To {end}", val)],
    ]
    col_widths = _normalize_widths([0.95, 2.55, 1.15, 2.35])
    table = Table(rows, colWidths=col_widths)
    table.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.5, _NAVY),
        ("INNERGRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#CCCCCC")),
        ("SPAN", (1, 5), (1, 5)), ("SPAN", (3, 5), (3, 5)),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    return _section_bar("Lease Information", col_widths, getSampleStyleSheet()), table


def _build_charge_schedule_table(fields):
    """rent.rent_schedule (see [RENT_SCHEDULE] in extraction_prompt.txt) -
    charge_code/charge_desc are only shown on the first row of each
    consecutive run (blank on repeats), matching the reference template's
    "merged cell" look for a multi-period charge like Base Rent."""
    schedule = _get_path(fields, "rent.rent_schedule", [])
    if not isinstance(schedule, list) or not schedule:
        return None

    def pick(row, *keys):
        for k in keys:
            if isinstance(row, dict) and row.get(k) not in (None, ""):
                return _stringify_leaf(row.get(k))
        return ""

    header_style = ParagraphStyle("ChargeHeader", fontSize=7.5, leading=9, textColor=_active_header_text(), fontName=_active_font_bold())
    cell_style = ParagraphStyle("ChargeCell", fontSize=7.5, leading=9, fontName=_active_font())
    headers = ["Charge Code", "Charge Desc", "Date From", "Date To", "Monthly Amt", "Annual Amt", "Amt Per Area", "Mgmt Fees", "Amendment Type", "Units"]
    table_data = [[Paragraph(h, header_style) for h in headers]]

    last_code = None
    for row in schedule:
        code = pick(row, "charge_code", "chargeCode", "unit", "Unit")
        desc = pick(row, "charge_desc", "chargeDesc")
        show_code_desc = code != last_code
        last_code = code
        table_data.append([
            Paragraph(code if show_code_desc else "", cell_style),
            Paragraph(desc if show_code_desc else "", cell_style),
            Paragraph(pick(row, "from_date", "fromDate", "From Date", "from"), cell_style),
            Paragraph(pick(row, "to_date", "toDate", "To Date", "to"), cell_style),
            Paragraph(pick(row, "monthly_amount", "monthlyAmount", "Monthly Amount", "monthly"), cell_style),
            Paragraph(pick(row, "annual_amount", "annualAmount", "Annual Amount", "annual"), cell_style),
            Paragraph(pick(row, "amt_per_area", "annual_per_sf", "Annual Per SF"), cell_style),
            Paragraph("0.00", cell_style),
            Paragraph("Original Lease", cell_style),
            Paragraph(pick(row, "units", "Units"), cell_style),
        ])
    col_widths = _normalize_widths([0.55, 0.65, 0.6, 0.6, 0.65, 0.65, 0.65, 0.5, 0.75, 0.4])
    table = Table(table_data, colWidths=col_widths)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), _active_header_bg()),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#AAAAAA")),
        ("BOX", (0, 0), (-1, -1), 0.5, _NAVY),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, _STRIPE]),
        ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    return col_widths, table


def _build_indexation_table():
    """The reference template always shows this section with just headers
    (no rows) unless the lease has an actual indexation/escalation-index
    clause - our schema doesn't extract structured indexation data, so
    this mirrors that same header-only convention rather than guessing."""
    header_style = ParagraphStyle("IdxHeader", fontSize=7, leading=9, textColor=_active_header_text(), fontName=_active_font_bold())
    headers = ["Charge Code", "Charge Desc", "Date From", "Date To", "Indexation Method", "Index", "Month", "Factor", "Min", "Max", "Amendment Type", "Units"]
    relative = [1] * len(headers)
    relative[4] = 1.7  # "Indexation Method" needs more room
    col_widths = _normalize_widths(relative)
    table = Table([[Paragraph(h, header_style) for h in headers]], colWidths=col_widths)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), _active_header_bg()),
        ("BOX", (0, 0), (-1, -1), 0.5, _NAVY),
        ("LEFTPADDING", (0, 0), (-1, -1), 3), ("RIGHTPADDING", (0, 0), (-1, -1), 3),
        ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    return col_widths, table


def _build_amendments_table(fields, lease_name):
    start = _get_path(fields, "term.lease_commencement_date")
    end = _get_path(fields, "term.lease_expiration_date")
    if not start and not end:
        return None
    notes = _get_path(fields, "amendment_notes") or "Original Lease"

    header_style = ParagraphStyle("AmendHeader", fontSize=7.5, leading=9, textColor=_active_header_text(), fontName=_active_font_bold())
    cell_style = ParagraphStyle("AmendCell", fontSize=7.5, leading=9, fontName=_active_font())
    headers = ["Type", "Description", "Status", "Term (Months)", "Date From", "Date To", "Units"]
    table_data = [[Paragraph(h, header_style) for h in headers]]
    table_data.append([
        Paragraph("Original Lease", cell_style), Paragraph(notes, cell_style), Paragraph("In Process", cell_style),
        Paragraph(_term_months(start, end), cell_style), Paragraph(start, cell_style), Paragraph(end, cell_style),
        Paragraph("-", cell_style),
    ])
    col_widths = _normalize_widths([0.9, 2.3, 0.7, 0.85, 0.75, 0.75, 0.55])
    table = Table(table_data, colWidths=col_widths)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), _active_header_bg()),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#AAAAAA")),
        ("BOX", (0, 0), (-1, -1), 0.5, _NAVY),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    return col_widths, table


def _build_late_fee_table(fields):
    lf = fields.get("rent", {}).get("late_fee_table") if isinstance(fields.get("rent"), dict) else None
    if not isinstance(lf, dict) or not any(lf.values()):
        return None
    header_style = ParagraphStyle("LateHeader", fontSize=7.5, leading=9, textColor=_active_header_text(), fontName=_active_font_bold())
    cell_style = ParagraphStyle("LateCell", fontSize=7.5, leading=9, fontName=_active_font())
    headers = ["Calculation Type", "Grace Period", "Percent", "2nd Fee Calc Type", "2nd Fee Grace Period", "2nd Fee Percent", "Per Day Fee"]
    table_data = [[Paragraph(h, header_style) for h in headers]]
    table_data.append([
        Paragraph(_stringify_leaf(lf.get("calc_type")) or "% Owed-Total", cell_style),
        Paragraph(_stringify_leaf(lf.get("grace_period")) or "0", cell_style),
        Paragraph(_stringify_leaf(lf.get("percent")) or "-", cell_style),
        Paragraph(_stringify_leaf(lf.get("second_fee_calc_type")), cell_style),
        Paragraph(_stringify_leaf(lf.get("second_fee_grace_period")), cell_style),
        Paragraph(_stringify_leaf(lf.get("second_fee_percent")), cell_style),
        Paragraph(_stringify_leaf(lf.get("per_day_fee")) or "0.00", cell_style),
    ])
    col_widths = _normalize_widths([1] * 7)
    table = Table(table_data, colWidths=col_widths)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), _active_header_bg()),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#AAAAAA")),
        ("BOX", (0, 0), (-1, -1), 0.5, _NAVY),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    return col_widths, table


def _build_clauses_table(fields):
    """The reference template's "Other Lease Provisions / Clauses" table -
    Id / Name / Description / Amendment Type, one row per clause the
    extraction prompt already asks for. Missing/empty fields show "Lease
    is silent." which matches the SILENT CLAUSE RULE the prompt itself
    instructs the LLM to use."""
    header_style = ParagraphStyle("ClauseHeader", fontSize=8, leading=10, textColor=_active_header_text(), fontName=_active_font_bold())
    id_style = ParagraphStyle("ClauseId", fontSize=8, leading=11, fontName=_active_font_bold())
    cell_style = ParagraphStyle("ClauseCell", fontSize=8, leading=11, fontName=_active_font())
    headers = ["Id", "Name", "Description", "Amendment Type"]
    table_data = [[Paragraph(h, header_style) for h in headers]]
    for clause_id, name, path in _CLAUSE_FIELD_MAP:
        value = _get_path(fields, path) or "Lease is silent."
        table_data.append([
            Paragraph(clause_id, id_style), Paragraph(name, cell_style),
            Paragraph(_stringify_leaf(value).replace("\n", "<br/>"), cell_style),
            Paragraph("Original Lease", cell_style),
        ])
    col_widths = _normalize_widths([0.6, 1.3, 3.9, 0.8])
    table = Table(table_data, colWidths=col_widths)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), _active_header_bg()),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#AAAAAA")),
        ("BOX", (0, 0), (-1, -1), 0.5, _NAVY),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, _STRIPE]),
        ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return col_widths, table


def _build_contacts_table(fields):
    contacts = fields.get("contacts")
    if not isinstance(contacts, dict):
        return None
    tenant = _get_path(fields, "parties.tenant_legal_name")
    landlord = _get_path(fields, "parties.landlord_legal_name")
    role_map = [
        ("Tenant Notice", tenant, contacts.get("tenant_notice")),
        ("Tenant Billing", tenant, contacts.get("tenant_billing")),
        ("Landlord Notice", landlord, contacts.get("landlord_notice")),
        ("Guarantor", _get_path(fields, "parties.guarantor_name"), contacts.get("guarantor_contact")),
    ]
    rows = [(role, company, addr) for role, company, addr in role_map if addr and addr != "N/A"]
    if not rows:
        return None

    header_style = ParagraphStyle("ContactHeader", fontSize=8, leading=10, textColor=_active_header_text(), fontName=_active_font_bold())
    cell_style = ParagraphStyle("ContactCell", fontSize=8, leading=11, fontName=_active_font())
    headers = ["Role", "Company Name", "Address"]
    table_data = [[Paragraph(h, header_style) for h in headers]]
    for role, company, addr in rows:
        table_data.append([Paragraph(role, cell_style), Paragraph(_stringify_leaf(company) or "-", cell_style), Paragraph(_stringify_leaf(addr), cell_style)])
    col_widths = _normalize_widths([1.1, 1.8, 3.7])
    table = Table(table_data, colWidths=col_widths)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), _active_header_bg()),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#AAAAAA")),
        ("BOX", (0, 0), (-1, -1), 0.5, _NAVY),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, _STRIPE]),
        ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return col_widths, table


def generate_output_pdf(output_json_path, pdf_out_path, template_name="Default.pdf", style_profile=None):
    """Builds Output.pdf from Output.json. When `fields` has the rich
    nested LLM extraction schema (see json/extraction_prompt.txt), this
    mirrors the reference "Lease Abstract" template's exact grid/table
    layout section-by-section: Lease Information, Charge Schedules,
    Indexation, Amendments, Late Fee, Other Lease Provisions/Clauses, then
    Contacts. Falls back to a generic key/value dump for the flat
    heuristic-engine schema, which doesn't carry per-clause data.

    style_profile (item 6, optional) - a dict from
    extract_template_style()/load_template_style_profile() with the
    uploaded Output Template's detected headerBgColor, headerTextColor,
    fontFamily, and logoImagePath. When given, every section header and
    table in this report reuses that color/font instead of the built-in
    gray/Helvetica default, and the template's logo (if one was found) is
    placed at the top of the page."""
    if not REPORTLAB_OK:
        raise LeaseEngineError(
            "reportlab is not installed - run: pip install -r requirements.txt"
        )

    # Reset to defaults each call, then apply whatever this specific
    # template's profile provides - _build_* helpers below all read these
    # via _active_header_bg()/_active_header_text()/_active_font().
    _ACTIVE_STYLE["headerBgColor"] = (style_profile or {}).get("headerBgColor")
    _ACTIVE_STYLE["headerTextColor"] = (style_profile or {}).get("headerTextColor")
    _ACTIVE_STYLE["fontFamily"] = (style_profile or {}).get("fontFamily")
    logo_path = (style_profile or {}).get("logoImagePath")

    with open(output_json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    fields = data.get("fields", {}) or {}
    lease_name = data.get("leaseName", "Lease")
    extraction_method = data.get("extractionMethod", "heuristic")
    accuracy = data.get("accuracy")
    accuracy_summary = data.get("accuracySummary") or ""

    doc = SimpleDocTemplate(
        pdf_out_path, pagesize=LETTER,
        topMargin=0.6 * inch, bottomMargin=0.6 * inch,
        leftMargin=0.6 * inch, rightMargin=0.6 * inch,
    )
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "LeaseTitle", parent=styles["Heading1"], textColor=colors.black, fontSize=16, spaceAfter=2, fontName=_active_font_bold()
    )
    normal = ParagraphStyle("LeaseNormal", parent=styles["Normal"], fontSize=8.5, fontName=_active_font())

    story = []
    if logo_path and os.path.isfile(logo_path):
        try:
            img = Image(logo_path)
            max_w, max_h = 1.6 * inch, 0.7 * inch
            scale = min(max_w / img.imageWidth, max_h / img.imageHeight, 1.0)
            img.drawWidth = img.imageWidth * scale
            img.drawHeight = img.imageHeight * scale
            story.append(img)
            story.append(Spacer(1, 6))
        except Exception as err:
            print(f"Could not embed template logo in Output.pdf: {err}")

    story += [
        Paragraph("Lease Abstract", title_style),
        Paragraph(f"Lease : {lease_name}", normal),
        Spacer(1, 10),
    ]

    if _is_rich_lease_schema(fields):
        bar, grid = _build_lease_information_grid(fields, lease_name)
        story += [bar, grid, Spacer(1, 10)]

        charge = _build_charge_schedule_table(fields)
        if charge:
            col_widths, table = charge
            story += [_section_bar("Charge Schedules", col_widths, styles), table, Spacer(1, 10)]

        idx_widths, idx_table = _build_indexation_table()
        story += [_section_bar("Indexation", idx_widths, styles), idx_table, Spacer(1, 10)]

        amend = _build_amendments_table(fields, lease_name)
        if amend:
            col_widths, table = amend
            story += [_section_bar("Amendments", col_widths, styles), table, Spacer(1, 10)]

        late_fee = _build_late_fee_table(fields)
        if late_fee:
            col_widths, table = late_fee
            story += [_section_bar("Late Fee", col_widths, styles), table, Spacer(1, 10)]

        clauses_widths, clauses_table = _build_clauses_table(fields)
        story += [_section_bar("Other Lease Provisions / Clauses", clauses_widths, styles), clauses_table, Spacer(1, 10)]

        contacts = _build_contacts_table(fields)
        if contacts:
            col_widths, table = contacts
            story += [_section_bar("Contacts", col_widths, styles), table, Spacer(1, 10)]

        if accuracy is not None:
            story.append(Paragraph(
                f"<i>Accuracy: {accuracy}%" + (f" — {accuracy_summary}" if accuracy_summary else "") + "</i>",
                normal
            ))
        if fields.get("queries_assumptions"):
            story.append(Spacer(1, 6))
            story.append(Paragraph("<b>Queries / Assumptions</b>", normal))
            for q in fields["queries_assumptions"]:
                story.append(Paragraph(f"• {_stringify_leaf(q)}", normal))
    else:
        # Flat heuristic-engine schema - generic key/value dump (no
        # per-clause data available to build the real template layout).
        heading_style = ParagraphStyle("LeaseHeading", parent=styles["Heading2"], textColor=_NAVY, spaceBefore=14, spaceAfter=6)
        if accuracy is not None:
            story.append(Paragraph(f"Extraction method: {extraction_method} · Accuracy: {accuracy}%" + (f" — {accuracy_summary}" if accuracy_summary else ""), normal))
        story.append(Paragraph("Lease Summary", heading_style))
        simple_rows = [
            (_humanize_key(k), _stringify_leaf(v))
            for k, v in fields.items() if not isinstance(v, (dict, list))
        ]
        if simple_rows:
            story.append(_build_kv_table(simple_rows))
        for key, value in fields.items():
            if not isinstance(value, (dict, list)):
                continue
            section_rows = _flatten_to_rows(value)
            if not section_rows:
                continue
            story.append(Spacer(1, 10))
            story.append(Paragraph(_humanize_key(key), heading_style))
            story.append(_build_kv_table(section_rows))

    story.append(Spacer(1, 10))
    story.append(HRFlowable(width="100%", color=_NAVY))
    story.append(Spacer(1, 4))
    story.append(Paragraph("<b>Source Document(s)</b>", normal))
    for doc_path in data.get("sourceDocuments", []):
        # Only the filename - sourceDocuments stores the full internal
        # Users/{userId}/LeaseAbstraction/{leaseName}/... path, which is
        # our own server's folder structure and shouldn't leak into a
        # document the user downloads and shares externally.
        story.append(Paragraph(os.path.basename(doc_path), normal))

    doc.build(story)
    return pdf_out_path



def _color_tuple_to_hex(c):
    """pdfplumber gives fill colors as a float (grayscale 0-1), a 3-tuple
    (RGB 0-1), or a 4-tuple (CMYK 0-1) depending on the PDF's color space -
    normalizes any of those to a '#RRGGBB' hex string."""
    try:
        if isinstance(c, (int, float)):
            v = int(round(c * 255))
            return "#%02X%02X%02X" % (v, v, v)
        if isinstance(c, (list, tuple)):
            if len(c) == 3:
                r, g, b = c
                return "#%02X%02X%02X" % (int(round(r * 255)), int(round(g * 255)), int(round(b * 255)))
            if len(c) == 4:
                cy, m, y, k = c
                r = 255 * (1 - cy) * (1 - k)
                g = 255 * (1 - m) * (1 - k)
                b = 255 * (1 - y) * (1 - k)
                return "#%02X%02X%02X" % (int(round(r)), int(round(g)), int(round(b)))
    except (TypeError, ValueError):
        pass
    return None


_FONT_FAMILY_MAP = [
    ("times", "Times-Roman"), ("serif", "Times-Roman"), ("georgia", "Times-Roman"),
    ("courier", "Courier"), ("mono", "Courier"),
    ("arial", "Helvetica"), ("helvetica", "Helvetica"), ("calibri", "Helvetica"), ("verdana", "Helvetica"),
]


def extract_template_style(template_path):
    """Item 6 - inspects an uploaded Output Template PDF (first page) and
    identifies: the dominant header/accent fill color, the primary font
    family in use, and any logo/image near the top of the page. Returns a
    style profile dict that generate_output_pdf() applies to the actual
    report, so a custom template's look carries over instead of always
    using the hardcoded default gray/Helvetica style. Best-effort and
    silent on failure - a template we can't parse just falls back to
    defaults, it never breaks the pipeline."""
    profile = {"headerBgColor": None, "headerTextColor": None, "fontFamily": None, "logoImagePath": None}
    if not pdfplumber or not os.path.isfile(template_path):
        return profile

    try:
        with pdfplumber.open(template_path) as pdf:
            if not pdf.pages:
                return profile
            page = pdf.pages[0]

            # ---- Dominant fill color (header/accent bars) - most common
            # non-white, non-black rect fill on the page. ----
            color_counts = {}
            for rect in (page.rects or []):
                hexcolor = _color_tuple_to_hex(rect.get("non_stroking_color"))
                if hexcolor and hexcolor not in ("#FFFFFF", "#000000"):
                    color_counts[hexcolor] = color_counts.get(hexcolor, 0) + 1
            if color_counts:
                profile["headerBgColor"] = max(color_counts, key=color_counts.get)
                # Pick a readable text color against that fill - light fill
                # gets dark text, dark fill gets white text.
                hexc = profile["headerBgColor"].lstrip("#")
                r, g, b = int(hexc[0:2], 16), int(hexc[2:4], 16), int(hexc[4:6], 16)
                brightness = (r * 299 + g * 587 + b * 114) / 1000
                profile["headerTextColor"] = "#000000" if brightness > 150 else "#FFFFFF"

            # ---- Dominant font family ----
            font_counts = {}
            for ch in (page.chars or [])[:2000]:  # cap - just need a representative sample
                name = (ch.get("fontname") or "").lower()
                if name:
                    font_counts[name] = font_counts.get(name, 0) + 1
            if font_counts:
                top_font = max(font_counts, key=font_counts.get)
                for keyword, mapped in _FONT_FAMILY_MAP:
                    if keyword in top_font:
                        profile["fontFamily"] = mapped
                        break

            # ---- Logo/image near the top of the first page. PDFs often
            # embed tiny 1x1 "spacer" pixels as a rendering artifact -
            # those aren't a logo, so anything smaller than a plausible
            # logo size gets skipped. ----
            images = [
                im for im in (page.images or [])
                if im.get("top", 999) < page.height * 0.35
                and (im.get("x1", 0) - im.get("x0", 0)) >= 20
                and (im.get("bottom", 0) - im.get("top", 0)) >= 20
            ]
            if images:
                im = images[0]
                try:
                    bbox = (max(0, im["x0"]), max(0, im["top"]), min(page.width, im["x1"]), min(page.height, im["bottom"]))
                    if bbox[2] > bbox[0] and bbox[3] > bbox[1]:
                        cropped = page.crop(bbox)
                        logo_path = os.path.join(os.path.dirname(template_path), "_extracted_logo.png")
                        cropped.to_image(resolution=150).save(logo_path, format="PNG")
                        with PILImage.open(logo_path) as saved_img:
                            if saved_img.width < 20 or saved_img.height < 20:
                                os.remove(logo_path)
                                logo_path = None
                        profile["logoImagePath"] = logo_path
                except Exception as err:
                    print(f"Template logo extraction skipped: {err}")
    except Exception as err:
        print(f"Template style extraction failed, using defaults: {err}")

    return profile


def save_template_style_profile(template_path):
    """Extracts and persists the style profile next to the template file,
    so generate_output_pdf can look it up later by template name without
    re-parsing the PDF on every single lease processed with it."""
    profile = extract_template_style(template_path)
    profile_path = template_path + ".style.json"
    try:
        with open(profile_path, "w", encoding="utf-8") as f:
            json.dump(profile, f)
    except OSError:
        pass
    return profile


def load_template_style_profile(template_path):
    profile_path = template_path + ".style.json"
    if os.path.isfile(profile_path):
        try:
            with open(profile_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (OSError, json.JSONDecodeError):
            pass
    return {"headerBgColor": None, "headerTextColor": None, "fontFamily": None, "logoImagePath": None}


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
