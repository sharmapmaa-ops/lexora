#!/usr/bin/env python3
"""
Backend for the Lexora / TechCorp Solutions menu system (Python version).

What this is for:
Opening index.html as a plain static file (or serving it with a plain
static server like `python3 -m http.server`) means the browser can
fetch() the json/ files, but it can never write back to them - browsers
are not allowed to touch the server's filesystem. This server adds the
things a plain static server can't do:
  - a couple of small JSON API routes that persist changes (payments,
    profile edits, contact submissions, uploaded files, API keys, ...)
    back to the real json/*.json files, so they survive a reload/restart
  - profile photo upload (saved for real under Users/<id>/ProfilePhoto/)
  - the real Lease Abstraction processing pipeline (text extraction,
    field analysis, validation, Output.json/Output.pdf generation) - see
    lease_engine.py
  - sending the Contact Us acknowledgement email over SMTP

Dependencies: see requirements.txt (pdfplumber, python-docx, reportlab).
The JSON-persistence and photo-upload routes only need the standard
library; only the Lease Abstraction pipeline routes need those packages.

Run it with:
    python3 py/server.py
Then open:
    http://localhost:8000/          (serves index.html directly)

(PORT=3000 python3 py/server.py to use a different port.)
"""

import base64
import datetime
import json
import mimetypes
import os
import re
import secrets
import shutil
import smtplib
import ssl
import sys
import threading
import uuid
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lease_engine  # noqa: E402  (needs the sys.path tweak above)
import auth_store  # noqa: E402

PORT = int(os.environ.get("PORT", 8000))

# server.py lives in py/, but it still needs to serve/read the project root
# (index.html, css/, json/, Pictures/, Users/) - so ROOT_DIR is one level up
# from this file, not the py/ folder itself.
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JSON_DIR = os.path.join(ROOT_DIR, "json")
USERS_DIR = os.path.join(ROOT_DIR, "Users")
TEMPLATE_DIR = os.path.join(ROOT_DIR, "Template", "LeaseAbstraction")
DEFAULT_TEMPLATE_PATH = os.path.join(TEMPLATE_DIR, "Default.pdf")


def _load_dotenv(path):
    """Minimal .env loader (KEY=VALUE per line, '#' comments, optional
    quotes around the value) - avoids adding python-dotenv as a real pip
    dependency just for this. Real secrets (API keys, SMTP password) live
    in .env (gitignored, never committed) instead of a tracked json/ file,
    since committing real keys in JSON got git pushes blocked by GitHub's
    secret-scanning push protection."""
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


class AuthError(Exception):
    """Raised for any authentication/authorization failure - mapped to
    HTTP 401 in do_GET/do_POST's error handling (see below), distinct
    from ValueError's 400 (a plain bad-request) so the frontend can tell
    "you typed something wrong" apart from "you're not logged in /
    allowed to do that"."""
    pass


# ============================================================
# Real sessions. Every endpoint that used to just trust a client-supplied
# "userId" field (readable/editable by anyone via devtools or localStorage)
# now requires a valid session token instead - the server decides who you
# are, the client no longer gets to assert it. Tokens are opaque random
# strings (not JWTs - there's no need to encode/verify claims client-side
# for a same-origin app like this, and an opaque token can be revoked
# server-side on logout, which a self-contained JWT can't be without an
# extra blocklist anyway).
#
# In-memory only (not persisted to disk) - a server restart naturally logs
# everyone out, which is a perfectly reasonable default for a token store
# this simple (no separate revocation-list bookkeeping needed) and avoids
# ever having live session tokens sitting in a file on disk.
# ============================================================
_sessions = {}
_sessions_lock = threading.Lock()
SESSION_TTL_HOURS = 24 * 7  # 7 days


def _create_session(user_id):
    token = secrets.token_urlsafe(32)
    with _sessions_lock:
        _sessions[token] = {
            "userId": user_id,
            "expiresAt": datetime.datetime.now() + datetime.timedelta(hours=SESSION_TTL_HOURS),
        }
    return token


def _get_session(token):
    with _sessions_lock:
        session = _sessions.get(token)
        if not session:
            return None
        if datetime.datetime.now() > session["expiresAt"]:
            del _sessions[token]
            return None
        return session


def _destroy_session(token):
    with _sessions_lock:
        _sessions.pop(token, None)


# Only these json/ files can be read/written through the /api/data/<name>
# API - this is a hard allowlist so that route can never be used to read or
# overwrite anything else on disk (app.js, server.py, users.json,
# the Users/ folder, etc).
# NOTE: "users" is intentionally NOT in this list. Now that real login
# exists, users.json holds plaintext passwords and verification codes for
# every account - it must never be readable/writable wholesale by an
# unauthenticated visitor. All user data access goes through the
# purpose-built /api/auth/* and /api/profile/* routes below instead, which
# only ever touch one user record at a time.
ALLOWED_RESOURCES = {
    "payment-history",
    "payment-methods",
    "contact-submissions",
    "api-keys",
    "lease-files",
    "translation-files",
    "lease-activity-log",
    "translation-activity-log",
    "notifications",
}

# json files that must never be served as static files (contain secrets).
# smtp-config.json / llm-config.json no longer exist (real secrets moved
# to .env - see _load_dotenv above) - only users.json (plaintext
# passwords) still needs this.
PROTECTED_JSON_FILES = {"users.json"}

# Relative paths (from ROOT_DIR, forward slashes) the Admin File Manager
# will never let you *view, edit, or download* the raw contents of, even
# though it's still visible/manageable (e.g. deletable) in the listing.
# users.json is viewable/editable through this (Developer/Admin-only,
# authenticated) panel per explicit request, and is still blocked from
# *direct* unauthenticated static-file access (PROTECTED_JSON_FILES,
# above). .env holds real secrets and is blocked from this panel entirely
# - there's no JSON-table view for it anyway (it's not JSON), and it
# should never be readable through the browser regardless of role.
ADMIN_DOWNLOAD_BLOCKLIST = {".env"}

MAX_BODY_BYTES = 30 * 1024 * 1024  # generous - lease PDFs / photos are base64

# ============================================================
# Background job store for /api/lease/extract-start + extract-status.
# Text extraction (especially the OCR fallback for scanned PDFs) can take
# well over a minute for a long document - long enough that a reverse
# proxy/gateway in front of this server (e.g. a Codespace's forwarded-port
# proxy) can kill the connection with a 504 before a single blocking HTTP
# request finishes. Running it in a background thread and having the
# client poll a few-KB status endpoint every couple of seconds means no
# single request ever takes more than an instant, regardless of how long
# the actual extraction takes server-side.
# ============================================================
_extract_jobs = {}
_extract_jobs_lock = threading.Lock()
_EXTRACT_JOB_MAX_AGE_SECONDS = 30 * 60  # stale-job cleanup


def _set_job(job_id, **fields):
    with _extract_jobs_lock:
        job = _extract_jobs.setdefault(job_id, {})
        job.update(fields)
        job["updatedAt"] = datetime.datetime.now()


def _get_job(job_id):
    with _extract_jobs_lock:
        return dict(_extract_jobs.get(job_id) or {})


def _cleanup_stale_jobs():
    cutoff = datetime.datetime.now() - datetime.timedelta(seconds=_EXTRACT_JOB_MAX_AGE_SECONDS)
    with _extract_jobs_lock:
        stale = [jid for jid, job in _extract_jobs.items() if job.get("updatedAt", cutoff) < cutoff]
        for jid in stale:
            _extract_jobs.pop(jid, None)


def _run_extract_job(job_id, abs_path):
    try:
        def on_progress(done, total):
            _set_job(job_id, status="running", pagesDone=done, pagesTotal=total)

        text = lease_engine.extract_text(abs_path, on_progress=on_progress)
        _set_job(job_id, status="done", text=text[:40000], textLength=len(text))
    except Exception as err:
        print(f"Extraction job {job_id} failed: {err}")
        _set_job(job_id, status="error", error=str(err))


# ============================================================
# Async verification-email sending. SMTP can be slow (or just
# unreachable, in which case it eats the full connection timeout before
# failing) - sending it in a background thread means /api/auth/login,
# /register, /forgot-password and /resend-code all respond immediately
# so the verification card shows up right away, instead of the UI
# sitting on a loading spinner for however long the email attempt takes.
# The frontend polls /api/auth/email-status right after showing the
# card; if the send ends up failing, that's when the fallback code
# appears - "immediately" in wall-clock terms, just not blocking the
# initial screen.
# ============================================================
_email_jobs = {}
_email_jobs_lock = threading.Lock()


def _set_email_job(user_id, **fields):
    with _email_jobs_lock:
        job = _email_jobs.setdefault(user_id, {})
        job.update(fields)
        job["updatedAt"] = datetime.datetime.now()


def _get_email_job(user_id):
    with _email_jobs_lock:
        return dict(_email_jobs.get(user_id) or {})


def _send_verification_email_async(user_id, to_email, user_name, code, purpose, expiry_minutes):
    _set_email_job(user_id, status="sending")
    # Always visible in the server's own console/terminal, regardless of
    # whether the email itself succeeds - handy for local dev/testing
    # without needing working SMTP or access to the inbox at all.
    print(f"🔑 Verification code for {to_email} ({purpose}): {code}  (expires in {expiry_minutes} min)")

    def _worker():
        try:
            _send_verification_email(to_email, user_name, code, purpose, expiry_minutes)
            _set_email_job(user_id, status="sent")
        except Exception as err:
            print(f"Verification email to {to_email} could not be sent (code is still valid - see above): {err}")
            _set_email_job(user_id, status="failed", code=code)

    threading.Thread(target=_worker, daemon=True).start()


# ============================================================
# small shared helpers
# ============================================================
def _safe_id(raw, default="unknown"):
    """Strips a value down to a safe path component (letters/digits/_/-)."""
    cleaned = re.sub(r"[^A-Za-z0-9_\-]", "", str(raw or ""))
    return cleaned or default


def _safe_filename(raw, default="file"):
    """Strips a value down to a safe file name (basename, no traversal)."""
    name = os.path.basename(str(raw or "").strip())
    name = re.sub(r"[^A-Za-z0-9_.\- ]", "_", name)
    name = name.strip() or default
    return name


def _within(base_dir, path):
    """True if the realpath of `path` is inside (or equal to) base_dir."""
    base_real = os.path.realpath(base_dir)
    target_real = os.path.realpath(path)
    return target_real == base_real or target_real.startswith(base_real + os.sep)


def _user_dir(user_id, *parts):
    user_id = _safe_id(user_id)
    path = os.path.join(USERS_DIR, user_id, *parts)
    if not _within(USERS_DIR, path):
        raise ValueError("Invalid path")
    return path


def _rel_to_root(abs_path):
    return os.path.relpath(abs_path, ROOT_DIR).replace(os.sep, "/")


# Folders the Admin File Manager should never touch - not because a
# Developer/Admin can't be trusted with their own project, but because
# deleting/replacing these while the server is running out of them tends
# to just crash the running server instead of doing anything useful.
ADMIN_HIDDEN_TOP_LEVEL = {".git"}


def _safe_admin_path(rel_path):
    """Resolves a client-supplied relative path (e.g. 'json/agents.json' or
    '' for root) against ROOT_DIR, rejecting any attempt to escape it."""
    rel_path = (rel_path or "").strip().strip("/")
    if rel_path in ("", "."):
        return ROOT_DIR
    abs_path = os.path.normpath(os.path.join(ROOT_DIR, rel_path))
    if not _within(ROOT_DIR, abs_path):
        raise ValueError("Invalid path")
    return abs_path


def _human_size(num_bytes):
    if num_bytes is None:
        return None
    step = 1024.0
    for unit in ("B", "KB", "MB", "GB"):
        if num_bytes < step:
            return f"{num_bytes:.0f} {unit}" if unit == "B" else f"{num_bytes:.1f} {unit}"
        num_bytes /= step
    return f"{num_bytes:.1f} TB"


def _primary_smtp_account():
    """SMTP credentials come from environment variables (.env) now -
    json/smtp-config.json was removed for the same reason as
    llm-config.json (see _load_dotenv's docstring above)."""
    host = os.environ.get("SMTP_HOST")
    if not host:
        raise ValueError(
            "SMTP is not configured - set SMTP_HOST, SMTP_USERNAME, SMTP_PASSWORD etc. "
            "in your .env file (see .env.example)."
        )
    username = os.environ.get("SMTP_USERNAME")
    return {
        "host": host,
        "port": int(os.environ.get("SMTP_PORT", "465") or 465),
        "username": username,
        "password": os.environ.get("SMTP_PASSWORD"),
        "sender_email": os.environ.get("SMTP_SENDER_EMAIL") or username,
        "use_tls": (os.environ.get("SMTP_USE_TLS", "false") or "false").strip().lower() in ("1", "true", "yes"),
    }


def _load_smtp_expiry_minutes():
    try:
        return int(os.environ.get("SMTP_EXPIRY_MINUTES", "10") or 10)
    except (ValueError, TypeError):
        return 10


def _send_email(to_email, subject, body, html_body=None):
    """Generic SMTP sender shared by the contact-us acknowledgement email
    and every verification-code email (register/login/reset). Uses
    the SMTP account configured in .env. When html_body is
    given, sends a real multipart/alternative message (plain text
    fallback + a styled HTML version) instead of plain text only."""
    account = _primary_smtp_account()
    host = account["host"]
    port = int(account.get("port", 465))
    username = account.get("username")
    password = account.get("password")
    sender = account.get("sender_email", username)
    use_tls = bool(account.get("use_tls", False))

    if html_body:
        mime_msg = MIMEMultipart("alternative")
        mime_msg.attach(MIMEText(body, "plain", "utf-8"))
        mime_msg.attach(MIMEText(html_body, "html", "utf-8"))
    else:
        mime_msg = MIMEText(body, "plain", "utf-8")
    mime_msg["Subject"] = subject
    mime_msg["From"] = sender
    mime_msg["To"] = to_email

    if port == 465:
        context = ssl.create_default_context()
        with smtplib.SMTP_SSL(host, port, context=context, timeout=6) as server:
            if username and password:
                server.login(username, password)
            server.sendmail(sender, [to_email], mime_msg.as_string())
    else:
        with smtplib.SMTP(host, port, timeout=6) as server:
            if use_tls:
                server.starttls(context=ssl.create_default_context())
            if username and password:
                server.login(username, password)
            server.sendmail(sender, [to_email], mime_msg.as_string())


def _html_email_wrapper(company_name, preheader, body_html):
    """Shared branded HTML shell (dark navy header matching the app's own
    theme, card body, muted footer) - both email types below drop their
    specific content into this."""
    return f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f5fa;font-family:'Segoe UI',Arial,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">{preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5fa;padding:32px 12px;">
<tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 4px 24px rgba(10,15,44,0.1);">
<tr><td style="background:linear-gradient(135deg,#0a0f2c 0%,#131b3f 55%,#1a2352 100%);padding:22px 30px;">
<span style="color:#ffffff;font-size:1.15rem;font-weight:700;letter-spacing:0.3px;">{company_name}</span>
</td></tr>
<tr><td style="padding:32px 30px;">
{body_html}
</td></tr>
<tr><td style="padding:16px 30px;background:#f9fafc;border-top:1px solid #eee;">
<span style="color:#9aa0b0;font-size:0.72rem;">This is an automated message from {company_name}. Please don't reply directly to this email.</span>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>"""


def _send_acknowledgement_email(to_email, user_name, ticket_id, msg_type, subject, message):
    company_name = _load_company_name()
    plain_body = (
        f"Hi {user_name},\n\n"
        f"Thanks for reaching out. We've received your {msg_type.lower()} and "
        f"our team will resolve it as soon as possible.\n\n"
        f"Ticket ID: {ticket_id}\n"
        f"Subject: {subject}\n"
        f"Your message:\n{message}\n\n"
        f"— Support Team, {company_name}"
    )
    body_html = f"""
<p style="font-size:0.95rem;color:#23263a;margin:0 0 14px 0;">Hi {user_name},</p>
<p style="font-size:0.95rem;color:#23263a;line-height:1.6;margin:0 0 20px 0;">
Thanks for reaching out. We've received your <strong>{msg_type.lower()}</strong> and our support team will get back to you as soon as possible.
</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5fa;border-radius:8px;margin-bottom:20px;">
<tr><td style="padding:16px 18px;">
<p style="margin:0 0 6px 0;font-size:0.72rem;font-weight:700;color:#8890a5;text-transform:uppercase;letter-spacing:0.5px;">Ticket ID</p>
<p style="margin:0 0 14px 0;font-size:0.95rem;color:#0a0f2c;font-weight:700;font-family:'Courier New',monospace;">{ticket_id}</p>
<p style="margin:0 0 6px 0;font-size:0.72rem;font-weight:700;color:#8890a5;text-transform:uppercase;letter-spacing:0.5px;">Subject</p>
<p style="margin:0 0 14px 0;font-size:0.88rem;color:#23263a;font-weight:600;">{subject}</p>
<p style="margin:0 0 6px 0;font-size:0.72rem;font-weight:700;color:#8890a5;text-transform:uppercase;letter-spacing:0.5px;">Your Message</p>
<p style="margin:0;font-size:0.85rem;color:#4a5066;line-height:1.6;white-space:pre-wrap;">{message}</p>
</td></tr>
</table>
<p style="font-size:0.85rem;color:#555;line-height:1.6;margin:0;">— Support Team, {company_name}</p>
"""
    html = _html_email_wrapper(company_name, f"We've received your {msg_type.lower()}: {subject}", body_html)
    _send_email(to_email, f"[Ticket {ticket_id}] We've received your {msg_type.lower()}: {subject}", plain_body, html_body=html)


def _send_ticket_update_email(to_email, user_name, ticket_id, status, response, subject):
    company_name = _load_company_name()
    plain_body = (
        f"Hi {user_name},\n\n"
        f"Your support ticket has been updated.\n\n"
        f"Ticket ID: {ticket_id}\n"
        f"Subject: {subject}\n"
        f"Status: {status}\n"
        f"Response:\n{response}\n\n"
        f"— Support Team, {company_name}"
    )
    body_html = f"""
<p style="font-size:0.95rem;color:#23263a;margin:0 0 14px 0;">Hi {user_name},</p>
<p style="font-size:0.95rem;color:#23263a;line-height:1.6;margin:0 0 20px 0;">Your support ticket has been updated:</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5fa;border-radius:8px;margin-bottom:20px;">
<tr><td style="padding:16px 18px;">
<p style="margin:0 0 6px 0;font-size:0.72rem;font-weight:700;color:#8890a5;text-transform:uppercase;letter-spacing:0.5px;">Ticket ID</p>
<p style="margin:0 0 14px 0;font-size:0.95rem;color:#0a0f2c;font-weight:700;font-family:'Courier New',monospace;">{ticket_id}</p>
<p style="margin:0 0 6px 0;font-size:0.72rem;font-weight:700;color:#8890a5;text-transform:uppercase;letter-spacing:0.5px;">Status</p>
<p style="margin:0 0 14px 0;font-size:0.88rem;color:#23263a;font-weight:600;">{status}</p>
<p style="margin:0 0 6px 0;font-size:0.72rem;font-weight:700;color:#8890a5;text-transform:uppercase;letter-spacing:0.5px;">Response</p>
<p style="margin:0;font-size:0.85rem;color:#4a5066;line-height:1.6;white-space:pre-wrap;">{response}</p>
</td></tr>
</table>
<p style="font-size:0.85rem;color:#555;line-height:1.6;margin:0;">— Support Team, {company_name}</p>
"""
    html = _html_email_wrapper(company_name, f"Your ticket {ticket_id} was updated", body_html)
    _send_email(to_email, f"[Ticket {ticket_id}] Update: {status}", plain_body, html_body=html)


_VERIFICATION_PURPOSE_LABELS = {
    "register": "complete your registration",
    "login": "complete your login",
    "reset": "reset your password",
}


def _load_company_name():
    try:
        with open(os.path.join(JSON_DIR, "company.json"), "r", encoding="utf-8") as f:
            return json.load(f).get("name", "Lexora AI Solutions")
    except (OSError, json.JSONDecodeError):
        return "Lexora AI Solutions"


def _send_verification_email(to_email, user_name, code, purpose, expiry_minutes):
    company_name = _load_company_name()
    label = _VERIFICATION_PURPOSE_LABELS.get(purpose, "verify your account")
    plain_body = (
        f"Hi {user_name},\n\n"
        f"Use this code to {label}:\n\n"
        f"    {code}\n\n"
        f"This code expires in {expiry_minutes} minute(s).\n\n"
        f"If you didn't request this, you can safely ignore this email.\n\n"
        f"— {company_name}"
    )
    body_html = f"""
<p style="font-size:0.95rem;color:#23263a;margin:0 0 14px 0;">Hi {user_name},</p>
<p style="font-size:0.95rem;color:#23263a;line-height:1.6;margin:0 0 22px 0;">Use the verification code below to {label}:</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<div style="display:inline-block;background:#f4f5fa;border:2px dashed #131b3f;border-radius:10px;padding:18px 30px;">
<span style="font-family:'Courier New',Courier,monospace;font-size:2rem;font-weight:700;letter-spacing:8px;color:#0a0f2c;user-select:all;">{code}</span>
</div>
</td></tr></table>
<p style="font-size:0.75rem;color:#9aa0b0;text-align:center;margin:10px 0 24px 0;">Tap or double-click the code above to select it, then copy (Ctrl/Cmd+C)</p>
<p style="font-size:0.85rem;color:#4a5066;line-height:1.6;margin:0 0 4px 0;">This code expires in <strong>{expiry_minutes} minute(s)</strong>.</p>
<p style="font-size:0.8rem;color:#9aa0b0;line-height:1.6;margin:0;">If you didn't request this, you can safely ignore this email — your account is still secure.</p>
"""
    html = _html_email_wrapper(company_name, f"Your verification code is {code}", body_html)
    _send_email(to_email, f"Your verification code: {code}", plain_body, html_body=html)


# ============================================================
# HTTP handler
# ============================================================
class Handler(SimpleHTTPRequestHandler):
    """Serves index.html, css/, js/, json/, Pictures/, Users/ exactly like a
    normal static file server would (except protected json files), plus
    the /api/... routes below."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT_DIR, **kwargs)

    def log_message(self, fmt, *args):
        # Keep the console readable - default logging is very chatty.
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def end_headers(self):
        # No caching for the app's own static files - CSS/JS/HTML edits
        # should always show up on the next reload, not sit stale in a
        # browser or proxy cache (this is a small local dev tool, not a
        # CDN-fronted production site, so there's no real perf cost).
        path = urlparse(self.path).path
        if path == "/" or path.endswith((".html", ".css", ".js")):
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        super().end_headers()

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ------------------------------------------------------------------
    # Session-based auth. Every protected route calls _resolve_user_id()
    # (POST, body-based) or _resolve_user_id_query() (GET, query-string
    # based) instead of reading body.get("userId")/query.get("userId")
    # directly - the session token (not the client-supplied field) is now
    # what actually determines who's making the request. The requested
    # userId is still accepted and still used (most of this app's routes
    # are written around "act on this userId"), but it's cross-checked
    # against the session: it either has to match the logged-in user, or
    # the logged-in user has to be Admin/Developer (who legitimately act
    # across users in a few places - Admin File Manager, rules approval).
    # ------------------------------------------------------------------
    def _authenticated_user_id(self):
        auth_header = self.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            raise AuthError("Not authenticated - please log in again.")
        token = auth_header[7:].strip()
        session = _get_session(token)
        if not session:
            raise AuthError("Your session has expired - please log in again.")
        return session["userId"]

    def _session_user_role(self, session_user_id):
        users = auth_store.load_users()
        user = auth_store.find_user_by_id(users, session_user_id)
        return user.get("role") if user else None

    def _authorize_user(self, requested_user_id):
        """Returns the session's real userId if it's allowed to act as
        requested_user_id (either it IS that user, or it's Admin/
        Developer) - raises AuthError otherwise."""
        session_user_id = self._authenticated_user_id()
        if not requested_user_id or session_user_id == requested_user_id:
            return session_user_id
        if self._session_user_role(session_user_id) in ("Admin", "Developer"):
            return session_user_id
        raise AuthError("You are not authorized to access this account's data.")

    def _resolve_user_id(self, body):
        return self._authorize_user(body.get("userId"))

    def _resolve_user_id_query(self, query):
        return self._authorize_user((query.get("userId", [""])[0]))

    def _require_role(self, roles):
        """For routes that are inherently privileged (Admin File Manager,
        rule approval) rather than "acting as a specific user" - just
        requires the session to belong to one of the given roles."""
        session_user_id = self._authenticated_user_id()
        if self._session_user_role(session_user_id) not in roles:
            raise AuthError("You don't have permission to do that.")
        return session_user_id

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length == 0:
            return {}
        if length > MAX_BODY_BYTES:
            raise ValueError("Body too large")
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def _resource_name(self):
        """Returns <name> if the request path is /api/data/<name>, else None."""
        parts = urlparse(self.path).path.strip("/").split("/")
        if len(parts) == 3 and parts[0] == "api" and parts[1] == "data" and parts[2]:
            return parts[2]
        return None

    # ------------------------------------------------------------------
    # GET
    # ------------------------------------------------------------------
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        # No custom redirect needed here anymore - the file is named
        # index.html (see Section 3 notes above), and SimpleHTTPRequestHandler
        # already serves index.html automatically for "/" on its own.

        get_routes = {
            "/api/admin/list": self._handle_admin_list,
            "/api/admin/download": self._handle_admin_download,
            "/api/admin/read": self._handle_admin_read,
            "/api/auth/me": self._handle_auth_me,
            "/api/auth/directory": self._handle_auth_directory,
            "/api/auth/email-status": self._handle_auth_email_status,
            "/api/lease/extract-status": self._handle_lease_extract_status,
            "/api/lease/list": self._handle_lease_list,
            "/api/lease/documents": self._handle_lease_documents,
            "/api/rules/list": self._handle_rules_list,
            "/api/lease/download": self._handle_lease_download,
            "/api/translation/list": self._handle_translation_list,
            "/api/translation/download": self._handle_translation_download,
        }
        get_handler = get_routes.get(path)
        if get_handler:
            try:
                return get_handler(parse_qs(parsed.query))
            except AuthError as err:
                return self._send_json(401, {"error": str(err)})
            except lease_engine.LeaseEngineError as err:
                return self._send_json(500, {"error": str(err)})
            except ValueError as err:
                return self._send_json(400, {"error": str(err)})
            except Exception as err:  # noqa: BLE001 - always answer the client
                print(f"Unhandled error on {path}: {err}")
                return self._send_json(500, {"error": "Internal server error"})

        # Never let users.json or .env (real secrets) be downloaded as a
        # static file - they're only ever read server-side. (.env.example
        # is fine to serve - it has no real values in it.)
        basename = os.path.basename(path)
        if basename in PROTECTED_JSON_FILES or basename == ".env":
            return self._send_json(403, {"error": "Forbidden"})

        name = self._resource_name()
        if name is None:
            return super().do_GET()

        if name not in ALLOWED_RESOURCES:
            return self._send_json(404, {"error": f'Unknown resource "{name}"'})

        try:
            self._authenticated_user_id()
        except AuthError as err:
            return self._send_json(401, {"error": str(err)})

        file_path = os.path.join(JSON_DIR, f"{name}.json")
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                raw = f.read()
        except OSError:
            return self._send_json(404, {"error": "Not found"})

        body = raw.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ------------------------------------------------------------------
    # PUT  (JSON persistence - /api/data/<name>)
    # ------------------------------------------------------------------
    def do_PUT(self):
        name = self._resource_name()
        if name is None:
            return self._send_json(404, {"error": "Not found"})
        if name not in ALLOWED_RESOURCES:
            return self._send_json(404, {"error": f'Unknown resource "{name}"'})

        try:
            self._authenticated_user_id()
        except AuthError as err:
            return self._send_json(401, {"error": str(err)})

        length = int(self.headers.get("Content-Length") or 0)
        if length == 0:
            return self._send_json(400, {"error": "Missing JSON body"})
        if length > MAX_BODY_BYTES:
            return self._send_json(413, {"error": "Body too large"})

        raw_body = self.rfile.read(length)
        try:
            data = json.loads(raw_body.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return self._send_json(400, {"error": "Missing JSON body"})

        file_path = os.path.join(JSON_DIR, f"{name}.json")
        try:
            with open(file_path, "w", encoding="utf-8") as f:
                f.write(json.dumps(data, indent=4, ensure_ascii=False) + "\n")
        except OSError as err:
            print(f"Failed to write json/{name}.json: {err}")
            return self._send_json(500, {"error": "Failed to save"})

        self._send_json(200, {"ok": True})

    # ------------------------------------------------------------------
    # Admin File Manager - GET routes
    # ------------------------------------------------------------------
    def _handle_admin_list(self, query):
        self._require_role(("Admin", "Developer"))
        rel_path = (query.get("path", [""])[0])
        try:
            abs_path = _safe_admin_path(rel_path)
        except ValueError:
            return self._send_json(400, {"error": "Invalid path"})

        if not os.path.isdir(abs_path):
            return self._send_json(404, {"error": "Not a directory"})

        entries = []
        try:
            names = sorted(os.listdir(abs_path), key=lambda n: n.lower())
        except OSError as err:
            return self._send_json(500, {"error": str(err)})

        for name in names:
            if name in ADMIN_HIDDEN_TOP_LEVEL and _rel_to_root(abs_path) == ".":
                continue
            full = os.path.join(abs_path, name)
            is_dir = os.path.isdir(full)
            try:
                stat = os.stat(full)
                modified = datetime.datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M")
                size = None if is_dir else stat.st_size
            except OSError:
                modified, size = None, None

            rel = _rel_to_root(full)
            entries.append({
                "name": name,
                "path": rel,
                "type": "dir" if is_dir else "file",
                "typeLabel": "DIR" if is_dir else (os.path.splitext(name)[1][1:].upper() or "FILE"),
                "size": size,
                "sizeLabel": None if is_dir else _human_size(size),
                "modified": modified,
                "downloadBlocked": rel in ADMIN_DOWNLOAD_BLOCKLIST,
            })

        # Directories first, then files, both alphabetical.
        entries.sort(key=lambda e: (e["type"] != "dir", e["name"].lower()))

        current_rel = _rel_to_root(abs_path)
        current_rel = "" if current_rel == "." else current_rel
        return self._send_json(200, {"ok": True, "path": current_rel, "entries": entries})

    def _handle_admin_download(self, query):
        self._require_role(("Admin", "Developer"))
        rel_path = (query.get("path", [""])[0])
        try:
            abs_path = _safe_admin_path(rel_path)
        except ValueError:
            return self._send_json(400, {"error": "Invalid path"})

        rel = _rel_to_root(abs_path)
        if rel in ADMIN_DOWNLOAD_BLOCKLIST:
            return self._send_json(403, {"error": "This file is protected and cannot be downloaded."})
        if not os.path.isfile(abs_path):
            return self._send_json(404, {"error": "File not found"})

        try:
            with open(abs_path, "rb") as f:
                data = f.read()
        except OSError as err:
            return self._send_json(500, {"error": str(err)})

        mime_type = mimetypes.guess_type(abs_path)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", mime_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Disposition", f'attachment; filename="{os.path.basename(abs_path)}"')
        self.end_headers()
        self.wfile.write(data)

    # ------------------------------------------------------------------
    # POST  (photo upload, SMTP email, lease-abstraction pipeline)
    # ------------------------------------------------------------------
    def do_POST(self):
        path = urlparse(self.path).path

        routes = {
            "/api/upload-photo": self._handle_upload_photo,
            "/api/send-acknowledgement": self._handle_send_acknowledgement,
            "/api/send-ticket-update": self._handle_send_ticket_update,
            "/api/lease/scan-template": self._handle_lease_scan_template,
            "/api/lease/upload-template": self._handle_lease_upload_template,
            "/api/lease/upload": self._handle_lease_upload,
            "/api/lease/extract-start": self._handle_lease_extract_start,
            "/api/lease/analyze": self._handle_lease_analyze,
            "/api/lease/validate": self._handle_lease_validate,
            "/api/lease/save-output": self._handle_lease_save_output,
            "/api/rules/propose": self._handle_rules_propose,
            "/api/rules/approve": self._handle_rules_approve,
            "/api/rules/reject": self._handle_rules_reject,
            "/api/lease/generate-pdf": self._handle_lease_generate_pdf,
            "/api/translation/upload": self._handle_translation_upload,
            "/api/translation/translate": self._handle_translation_translate,
            "/api/translation/save-output": self._handle_translation_save_output,
            "/api/translation/generate-pdf": self._handle_translation_generate_pdf,
            "/api/admin/mkdir": self._handle_admin_mkdir,
            "/api/admin/upload": self._handle_admin_upload,
            "/api/admin/delete": self._handle_admin_delete,
            "/api/admin/write": self._handle_admin_write,
            "/api/auth/register": self._handle_auth_register,
            "/api/auth/verify-register": self._handle_auth_verify_register,
            "/api/auth/login": self._handle_auth_login,
            "/api/auth/verify-login": self._handle_auth_verify_login,
            "/api/auth/forgot-password": self._handle_auth_forgot_password,
            "/api/auth/verify-reset-code": self._handle_auth_verify_reset_code,
            "/api/auth/reset-password": self._handle_auth_reset_password,
            "/api/auth/resend-code": self._handle_auth_resend_code,
            "/api/profile/update": self._handle_profile_update,
            "/api/auth/logout": self._handle_auth_logout,
        }

        handler = routes.get(path)
        if not handler:
            return self._send_json(404, {"error": "Not found"})

        try:
            body = self._read_json_body()
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as err:
            return self._send_json(400, {"error": f"Invalid request body: {err}"})

        try:
            status, payload = handler(body)
        except AuthError as err:
            status, payload = 401, {"error": str(err)}
        except lease_engine.LeaseEngineError as err:
            status, payload = 500, {"error": str(err)}
        except ValueError as err:
            status, payload = 400, {"error": str(err)}
        except Exception as err:  # noqa: BLE001 - always answer the client
            print(f"Unhandled error on {path}: {err}")
            status, payload = 500, {"error": "Internal server error"}

        self._send_json(status, payload)

    # ---- Section 2: profile photo storage ----
    def _handle_upload_photo(self, body):
        user_id = _safe_id(self._resolve_user_id(body))
        data_url = body.get("dataUrl") or ""
        file_name = _safe_filename(body.get("fileName"), "photo")

        m = re.match(r"^data:(image/[a-zA-Z0-9.+-]+);base64,(.+)$", data_url, re.DOTALL)
        if not m:
            raise ValueError("dataUrl must be a base64 image data URL")
        mime_type, b64data = m.group(1), m.group(2)

        ext = mimetypes.guess_extension(mime_type) or os.path.splitext(file_name)[1] or ".png"
        if ext == ".jpe":
            ext = ".jpg"
        final_name = f"profile{ext}"

        folder = _user_dir(user_id, "ProfilePhoto")
        os.makedirs(folder, exist_ok=True)
        # Remove any previous profile photo (different extension) so old
        # files don't pile up.
        for existing in os.listdir(folder):
            if existing.startswith("profile."):
                try:
                    os.remove(os.path.join(folder, existing))
                except OSError:
                    pass

        out_path = os.path.join(folder, final_name)
        with open(out_path, "wb") as f:
            f.write(base64.b64decode(b64data))

        return 200, {"ok": True, "path": _rel_to_root(out_path)}

    # ---- Section 9: contact-us acknowledgement email ----
    def _handle_send_acknowledgement(self, body):
        to_email = body.get("toEmail")
        if not to_email:
            raise ValueError("toEmail is required")
        _send_acknowledgement_email(
            to_email,
            body.get("userName") or "there",
            body.get("ticketId") or "-",
            body.get("type") or "Query",
            body.get("subject") or "(no subject)",
            body.get("message") or "",
        )
        return 200, {"ok": True}

    def _handle_send_ticket_update(self, body):
        to_email = body.get("toEmail")
        if not to_email:
            raise ValueError("toEmail is required")
        _send_ticket_update_email(
            to_email,
            body.get("userName") or "there",
            body.get("ticketId") or "-",
            body.get("status") or "Pending",
            body.get("response") or "",
            body.get("subject") or "(no subject)",
        )
        return 200, {"ok": True}

    # ---- Section 14.1: output template scan (batch-level, not per file) ----
    def _handle_lease_scan_template(self, body):
        user_id = _safe_id(self._resolve_user_id(body))
        template_name = body.get("templateName")

        if template_name:
            template_path = _user_dir(user_id, "LeaseAbstraction", "_templates",
                                       _safe_filename(template_name))
            if not os.path.isfile(template_path):
                template_path = DEFAULT_TEMPLATE_PATH
                template_name = "Default.pdf"
        else:
            template_path = DEFAULT_TEMPLATE_PATH
            template_name = "Default.pdf"

        pages = None
        if lease_engine.pdfplumber and template_path.lower().endswith(".pdf"):
            try:
                with lease_engine.pdfplumber.open(template_path) as pdf:
                    pages = len(pdf.pages)
            except Exception:
                pages = None

        return 200, {"ok": True, "template": template_name, "pages": pages}

    def _handle_lease_upload_template(self, body):
        user_id = _safe_id(self._resolve_user_id(body))
        file_name = _safe_filename(body.get("fileName"), "template.pdf")
        data_b64 = body.get("dataBase64")
        if not data_b64:
            raise ValueError("dataBase64 is required")

        folder = _user_dir(user_id, "LeaseAbstraction", "_templates")
        os.makedirs(folder, exist_ok=True)
        out_path = os.path.join(folder, file_name)
        with open(out_path, "wb") as f:
            f.write(base64.b64decode(data_b64))

        return 200, {"ok": True, "templateName": file_name, "path": _rel_to_root(out_path)}

    # ---- Section 14.2: input file upload/scanning ----
    def _handle_lease_upload(self, body):
        user_id = _safe_id(self._resolve_user_id(body))
        original_name = _safe_filename(body.get("fileName"), "document.pdf")
        data_b64 = body.get("dataBase64")
        if not data_b64:
            raise ValueError("dataBase64 is required")

        folder = _user_dir(user_id, "LeaseAbstraction", "_staging")
        os.makedirs(folder, exist_ok=True)
        staged_name = f"{uuid.uuid4().hex}_{original_name}"
        out_path = os.path.join(folder, staged_name)
        with open(out_path, "wb") as f:
            f.write(base64.b64decode(data_b64))

        return 200, {
            "ok": True,
            "stagingPath": _rel_to_root(out_path),
            "originalFileName": original_name,
        }

    def _resolve_staging_path(self, staging_path):
        abs_path = os.path.join(ROOT_DIR, staging_path)
        if not _within(USERS_DIR, abs_path) or not os.path.isfile(abs_path):
            raise ValueError("Invalid or missing staged file")
        return abs_path

    # ---- Section 14.3 (20%): data extraction - runs in a background
    # thread (see _run_extract_job) so a slow OCR pass never blocks a
    # single HTTP request long enough to trip a gateway timeout. ----
    def _handle_lease_extract_start(self, body):
        staging_path = body.get("stagingPath")
        abs_path = self._resolve_staging_path(staging_path)

        _cleanup_stale_jobs()
        job_id = uuid.uuid4().hex
        _set_job(job_id, status="running", pagesDone=0, pagesTotal=None)
        thread = threading.Thread(target=_run_extract_job, args=(job_id, abs_path), daemon=True)
        thread.start()

        return 200, {"ok": True, "jobId": job_id}

    def _handle_lease_extract_status(self, query):
        job_id = (query.get("jobId", [""])[0])
        job = _get_job(job_id)
        if not job:
            return self._send_json(404, {"error": "Unknown or expired job"})
        payload = {"ok": True, "status": job.get("status", "running")}
        if job.get("status") == "running":
            payload["pagesDone"] = job.get("pagesDone")
            payload["pagesTotal"] = job.get("pagesTotal")
        elif job.get("status") == "done":
            payload["text"] = job.get("text", "")
            payload["textLength"] = job.get("textLength", 0)
        elif job.get("status") == "error":
            payload["error"] = job.get("error", "Extraction failed")
        return self._send_json(200, payload)

    # ---- Section 14.3 (40%): "GPT prompt" analysis stand-in ----
    def _handle_lease_analyze(self, body):
        text = body.get("text") or ""
        fallback_name = body.get("fallbackName") or "Lease"
        result = lease_engine.analyze_lease(text, fallback_name=fallback_name)
        return 200, {"ok": True, **result}

    # ---- Section 14.3 (60%): document-type + duplicate validation ----
    def _handle_lease_validate(self, body):
        user_id = _safe_id(self._resolve_user_id(body))
        doc_type = body.get("docType")
        lease_name = lease_engine.sanitize_lease_name(body.get("leaseName"))

        if doc_type == "Other":
            return 200, {"ok": True, "valid": False, "reason": "invalid", "leaseName": lease_name}

        output_json_path = _user_dir(user_id, "LeaseAbstraction", lease_name, "Output.json")
        if os.path.isfile(output_json_path):
            return 200, {"ok": True, "valid": False, "reason": "duplicate", "leaseName": lease_name}

        return 200, {"ok": True, "valid": True, "leaseName": lease_name}

    # ---- Section 14.3 (80%): Output.json + saved document + LeaseDocuments.json ----
    def _handle_lease_save_output(self, body):
        user_id = _safe_id(self._resolve_user_id(body))
        lease_name = lease_engine.sanitize_lease_name(body.get("leaseName"))
        doc_type = body.get("docType") or "Lease"
        fields = body.get("fields") or {}
        extraction_method = body.get("extractionMethod") or "heuristic"
        accuracy = body.get("accuracy")
        accuracy_method = body.get("accuracyMethod")
        accuracy_summary = body.get("accuracySummary")
        missing_fields = body.get("missingFields") or []
        low_confidence_fields = body.get("lowConfidenceFields") or []
        staging_path = body.get("stagingPath")
        original_file_name = _safe_filename(body.get("originalFileName"), "document.pdf")

        staged_abs = self._resolve_staging_path(staging_path)

        lease_folder = _user_dir(user_id, "LeaseAbstraction", lease_name)
        os.makedirs(lease_folder, exist_ok=True)

        final_name = original_file_name
        final_path = os.path.join(lease_folder, final_name)
        if os.path.exists(final_path):
            stem, ext = os.path.splitext(final_name)
            final_name = f"{stem}_{uuid.uuid4().hex[:6]}{ext}"
            final_path = os.path.join(lease_folder, final_name)
        shutil.move(staged_abs, final_path)

        now_iso = datetime.datetime.now().isoformat(timespec="seconds")

        output_json_path = os.path.join(lease_folder, "Output.json")
        source_docs_rel = _rel_to_root(final_path)
        output_data = {
            "leaseName": lease_name,
            "userId": user_id,
            "docType": doc_type,
            "extractionMethod": extraction_method,
            "accuracy": accuracy,
            "accuracyMethod": accuracy_method,
            "accuracySummary": accuracy_summary,
            "missingFields": missing_fields,
            "lowConfidenceFields": low_confidence_fields,
            "fields": fields,
            "createdAt": now_iso,
            "updatedAt": now_iso,
            "sourceDocuments": [source_docs_rel],
        }
        if os.path.isfile(output_json_path):
            try:
                with open(output_json_path, "r", encoding="utf-8") as f:
                    existing = json.load(f)
                existing_docs = existing.get("sourceDocuments", [])
                if source_docs_rel not in existing_docs:
                    existing_docs.append(source_docs_rel)
                existing.update({
                    "docType": doc_type, "fields": fields, "extractionMethod": extraction_method,
                    "accuracy": accuracy, "accuracyMethod": accuracy_method,
                    "accuracySummary": accuracy_summary, "missingFields": missing_fields,
                    "lowConfidenceFields": low_confidence_fields,
                    "updatedAt": now_iso, "sourceDocuments": existing_docs,
                })
                output_data = existing
            except (OSError, json.JSONDecodeError):
                pass

        with open(output_json_path, "w", encoding="utf-8") as f:
            json.dump(output_data, f, indent=4, ensure_ascii=False)

        lease_docs_path = os.path.join(lease_folder, "LeaseDocuments.json")
        docs_list = []
        if os.path.isfile(lease_docs_path):
            try:
                with open(lease_docs_path, "r", encoding="utf-8") as f:
                    docs_list = json.load(f)
            except (OSError, json.JSONDecodeError):
                docs_list = []
        docs_list.append({
            "fileName": final_name,
            "path": source_docs_rel,
            "uploadedAt": now_iso,
        })
        with open(lease_docs_path, "w", encoding="utf-8") as f:
            json.dump(docs_list, f, indent=4, ensure_ascii=False)

        return 200, {
            "ok": True,
            "leaseFolder": _rel_to_root(lease_folder),
            "savedDocument": source_docs_rel,
        }

    # ---- Section 14.3 (100%): Output.pdf generation ----
    def _handle_lease_generate_pdf(self, body):
        user_id = _safe_id(self._resolve_user_id(body))
        lease_name = lease_engine.sanitize_lease_name(body.get("leaseName"))
        template_name = body.get("templateName") or "Default.pdf"

        lease_folder = _user_dir(user_id, "LeaseAbstraction", lease_name)
        output_json_path = os.path.join(lease_folder, "Output.json")
        if not os.path.isfile(output_json_path):
            raise ValueError("Output.json not found - run save-output first")

        pdf_path = os.path.join(lease_folder, "Output.pdf")
        lease_engine.generate_output_pdf(output_json_path, pdf_path, template_name=template_name)

        return 200, {"ok": True, "outputPdf": _rel_to_root(pdf_path)}

    # ------------------------------------------------------------------
    # Translation - a real pipeline now (used to be entirely simulated
    # with setTimeout on the frontend). Text extraction is generic (not
    # lease-specific) so this reuses /api/lease/extract-start/-status -
    # only upload/translate/save/download/list are Translation-specific.
    # ------------------------------------------------------------------
    def _handle_translation_upload(self, body):
        user_id = _safe_id(self._resolve_user_id(body))
        original_name = _safe_filename(body.get("fileName"), "document.pdf")
        data_b64 = body.get("dataBase64")
        if not data_b64:
            raise ValueError("dataBase64 is required")

        folder = _user_dir(user_id, "Translation", "_staging")
        os.makedirs(folder, exist_ok=True)
        staged_name = f"{uuid.uuid4().hex}_{original_name}"
        out_path = os.path.join(folder, staged_name)
        with open(out_path, "wb") as f:
            f.write(base64.b64decode(data_b64))

        return 200, {"ok": True, "stagingPath": _rel_to_root(out_path), "originalFileName": original_name}

    def _handle_translation_translate(self, body):
        text = body.get("text") or ""
        target_language = body.get("targetLanguage") or "English"
        llm_config = lease_engine.load_llm_config()

        try:
            translated, used_provider = lease_engine.translate_text(text, target_language, llm_config=llm_config)
        except lease_engine.LeaseEngineError as err:
            print(f"Translation LLM call failed on every configured provider, falling back: {err}")
            translated, used_provider = None, None

        if translated is not None:
            method = f"llm-{used_provider}"
        else:
            method = "heuristic"
            translated = (
                f"[No LLM is configured, so this is the original text unchanged - "
                f"set OPENAI_API_KEY/OPENROUTER_API_KEY in .env for a real translation "
                f"into {target_language}.]\n\n{text[:4000]}"
            )

        return 200, {"ok": True, "translatedText": translated[:100000], "method": method}

    def _handle_translation_save_output(self, body):
        user_id = _safe_id(self._resolve_user_id(body))
        doc_name = lease_engine.sanitize_lease_name(body.get("docName"))
        original_text = body.get("originalText") or ""
        translated_text = body.get("translatedText") or ""
        target_language = body.get("targetLanguage") or ""
        translation_method = body.get("translationMethod") or "heuristic"
        staging_path = body.get("stagingPath")
        original_file_name = _safe_filename(body.get("originalFileName"), "document.pdf")

        staged_abs = self._resolve_staging_path(staging_path)
        folder = _user_dir(user_id, "Translation", doc_name)
        os.makedirs(folder, exist_ok=True)

        final_name = original_file_name
        final_path = os.path.join(folder, final_name)
        if os.path.exists(final_path):
            stem, ext = os.path.splitext(final_name)
            final_name = f"{stem}_{uuid.uuid4().hex[:6]}{ext}"
            final_path = os.path.join(folder, final_name)
        shutil.move(staged_abs, final_path)

        translated_txt_path = os.path.join(folder, "Translated.txt")
        with open(translated_txt_path, "w", encoding="utf-8") as f:
            f.write(translated_text)

        now_iso = datetime.datetime.now().isoformat(timespec="seconds")
        output_json_path = os.path.join(folder, "Output.json")
        with open(output_json_path, "w", encoding="utf-8") as f:
            json.dump({
                "docName": doc_name,
                "userId": user_id,
                "targetLanguage": target_language,
                "translationMethod": translation_method,
                "originalText": original_text[:20000],
                "translatedText": translated_text[:20000],
                "sourceDocument": _rel_to_root(final_path),
                "createdAt": now_iso,
            }, f, indent=2, ensure_ascii=False)

        return 200, {"ok": True, "docFolder": _rel_to_root(folder)}

    def _handle_translation_generate_pdf(self, body):
        user_id = _safe_id(self._resolve_user_id(body))
        doc_name = lease_engine.sanitize_lease_name(body.get("docName"))

        folder = _user_dir(user_id, "Translation", doc_name)
        output_json_path = os.path.join(folder, "Output.json")
        if not os.path.isfile(output_json_path):
            raise ValueError("Output.json not found - run save-output first")

        pdf_path = os.path.join(folder, "Output.pdf")
        lease_engine.generate_translation_pdf(output_json_path, pdf_path)

        return 200, {"ok": True, "outputPdf": _rel_to_root(pdf_path)}

    def _handle_translation_list(self, query):
        user_id = _safe_id(self._resolve_user_id_query(query))
        try:
            base = _user_dir(user_id, "Translation")
        except ValueError:
            return self._send_json(400, {"error": "Invalid path"})

        docs = []
        if os.path.isdir(base):
            for name in sorted(os.listdir(base)):
                if name.startswith("_"):
                    continue
                folder = os.path.join(base, name)
                output_json_path = os.path.join(folder, "Output.json")
                if not os.path.isdir(folder) or not os.path.isfile(output_json_path):
                    continue
                try:
                    with open(output_json_path, "r", encoding="utf-8") as f:
                        data = json.load(f)
                except (OSError, json.JSONDecodeError):
                    data = {}
                docs.append({
                    "docName": name,
                    "targetLanguage": data.get("targetLanguage"),
                    "createdAt": data.get("createdAt"),
                    "hasOutputPdf": os.path.isfile(os.path.join(folder, "Output.pdf")),
                })

        docs.sort(key=lambda d: d.get("createdAt") or "", reverse=True)
        return self._send_json(200, {"ok": True, "documents": docs})

    def _handle_translation_download(self, query):
        user_id = _safe_id(self._resolve_user_id_query(query))
        doc_name = lease_engine.sanitize_lease_name((query.get("docName", [""])[0]))
        file_name = _safe_filename((query.get("fileName", [""])[0]))

        try:
            folder = _user_dir(user_id, "Translation", doc_name)
        except ValueError:
            return self._send_json(400, {"error": "Invalid path"})

        abs_path = os.path.join(folder, file_name)
        if not _within(folder, abs_path) or not os.path.isfile(abs_path):
            return self._send_json(404, {"error": "File not found"})

        with open(abs_path, "rb") as f:
            data = f.read()

        mime_type = mimetypes.guess_type(abs_path)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", mime_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Disposition", f'attachment; filename="{os.path.basename(abs_path)}"')
        self.end_headers()
        self.wfile.write(data)

    # ---- Dashboard "My Processed Leases" card: list + drill-down + download ----
    def _handle_lease_list(self, query):
        user_id = _safe_id(self._resolve_user_id_query(query))
        try:
            base = _user_dir(user_id, "LeaseAbstraction")
        except ValueError:
            return self._send_json(400, {"error": "Invalid path"})

        leases = []
        if os.path.isdir(base):
            for name in sorted(os.listdir(base)):
                if name.startswith("_"):
                    continue  # skip _staging / _templates internal folders
                folder = os.path.join(base, name)
                output_json_path = os.path.join(folder, "Output.json")
                if not os.path.isdir(folder) or not os.path.isfile(output_json_path):
                    continue
                try:
                    with open(output_json_path, "r", encoding="utf-8") as f:
                        data = json.load(f)
                except (OSError, json.JSONDecodeError):
                    data = {}
                leases.append({
                    "leaseName": name,
                    "docType": data.get("docType"),
                    "accuracy": data.get("accuracy"),
                    "createdAt": data.get("createdAt"),
                    "hasOutputPdf": os.path.isfile(os.path.join(folder, "Output.pdf")),
                })

        leases.sort(key=lambda l: l.get("createdAt") or "", reverse=True)
        return self._send_json(200, {"ok": True, "leases": leases})

    def _handle_lease_documents(self, query):
        user_id = _safe_id(self._resolve_user_id_query(query))
        lease_name = lease_engine.sanitize_lease_name((query.get("leaseName", [""])[0]))
        try:
            folder = _user_dir(user_id, "LeaseAbstraction", lease_name)
        except ValueError:
            return self._send_json(400, {"error": "Invalid path"})

        if not os.path.isdir(folder):
            return self._send_json(404, {"error": "Lease not found"})

        docs_path = os.path.join(folder, "LeaseDocuments.json")
        docs = []
        if os.path.isfile(docs_path):
            try:
                with open(docs_path, "r", encoding="utf-8") as f:
                    docs = json.load(f)
            except (OSError, json.JSONDecodeError):
                docs = []

        has_output_pdf = os.path.isfile(os.path.join(folder, "Output.pdf"))
        return self._send_json(200, {"ok": True, "leaseName": lease_name, "documents": docs, "hasOutputPdf": has_output_pdf})

    def _handle_lease_download(self, query):
        user_id = _safe_id(self._resolve_user_id_query(query))
        lease_name = lease_engine.sanitize_lease_name((query.get("leaseName", [""])[0]))
        file_name = _safe_filename((query.get("fileName", [""])[0]))

        try:
            folder = _user_dir(user_id, "LeaseAbstraction", lease_name)
        except ValueError:
            return self._send_json(400, {"error": "Invalid path"})

        abs_path = os.path.join(folder, file_name)
        if not _within(folder, abs_path) or not os.path.isfile(abs_path):
            return self._send_json(404, {"error": "File not found"})

        try:
            with open(abs_path, "rb") as f:
                data = f.read()
        except OSError as err:
            return self._send_json(500, {"error": str(err)})

        mime_type = mimetypes.guess_type(abs_path)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", mime_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Disposition", f'attachment; filename="{os.path.basename(abs_path)}"')
        self.end_headers()
        self.wfile.write(data)

    # ------------------------------------------------------------------
    # Admin File Manager - POST routes
    # ------------------------------------------------------------------
    def _handle_admin_mkdir(self, body):
        self._require_role(("Admin", "Developer"))
        rel_path = body.get("path", "")
        folder_name = _safe_filename(body.get("name"), "New Folder")
        try:
            parent = _safe_admin_path(rel_path)
        except ValueError:
            raise ValueError("Invalid path")

        new_dir = os.path.join(parent, folder_name)
        if not _within(ROOT_DIR, new_dir):
            raise ValueError("Invalid path")
        if os.path.exists(new_dir):
            raise ValueError(f'"{folder_name}" already exists here')

        os.makedirs(new_dir)
        return 200, {"ok": True, "path": _rel_to_root(new_dir)}

    def _handle_admin_upload(self, body):
        self._require_role(("Admin", "Developer"))
        rel_path = body.get("path", "")
        file_name = _safe_filename(body.get("fileName"), "file")
        data_b64 = body.get("dataBase64")
        if not data_b64:
            raise ValueError("dataBase64 is required")

        try:
            parent = _safe_admin_path(rel_path)
        except ValueError:
            raise ValueError("Invalid path")
        if not os.path.isdir(parent):
            raise ValueError("Target folder does not exist")

        out_path = os.path.join(parent, file_name)
        if not _within(ROOT_DIR, out_path):
            raise ValueError("Invalid path")

        with open(out_path, "wb") as f:
            f.write(base64.b64decode(data_b64))

        return 200, {"ok": True, "path": _rel_to_root(out_path)}

    def _handle_admin_delete(self, body):
        self._require_role(("Admin", "Developer"))
        paths = body.get("paths") or []
        if not isinstance(paths, list) or not paths:
            raise ValueError("paths must be a non-empty list")

        deleted, failed = [], []
        for rel_path in paths:
            try:
                abs_path = _safe_admin_path(rel_path)
            except ValueError:
                failed.append({"path": rel_path, "error": "Invalid path"})
                continue

            if abs_path == ROOT_DIR:
                failed.append({"path": rel_path, "error": "Cannot delete the project root"})
                continue
            if _rel_to_root(abs_path) in ADMIN_DOWNLOAD_BLOCKLIST:
                failed.append({"path": rel_path, "error": "This file is protected"})
                continue

            try:
                if os.path.isdir(abs_path):
                    shutil.rmtree(abs_path)
                elif os.path.isfile(abs_path):
                    os.remove(abs_path)
                else:
                    failed.append({"path": rel_path, "error": "Not found"})
                    continue
                deleted.append(rel_path)
            except OSError as err:
                failed.append({"path": rel_path, "error": str(err)})

        return 200, {"ok": True, "deleted": deleted, "failed": failed}

    # ------------------------------------------------------------------
    # Admin File Manager - view/edit a single file's content
    # ------------------------------------------------------------------
    def _handle_admin_read(self, query):
        self._require_role(("Admin", "Developer"))
        rel_path = (query.get("path", [""])[0])
        try:
            abs_path = _safe_admin_path(rel_path)
        except ValueError:
            return self._send_json(400, {"error": "Invalid path"})

        rel = _rel_to_root(abs_path)
        if rel in ADMIN_DOWNLOAD_BLOCKLIST:
            return self._send_json(403, {"error": "This file is protected and cannot be viewed here."})
        if not os.path.isfile(abs_path):
            return self._send_json(404, {"error": "File not found"})

        ext = os.path.splitext(abs_path)[1].lower()
        text_extensions = {
            ".txt", ".md", ".json", ".js", ".css", ".html", ".htm", ".py",
            ".csv", ".log", ".yml", ".yaml", ".xml", ".ini", ".cfg", ".sh",
        }
        if ext not in text_extensions:
            return self._send_json(415, {"error": "This file type can't be previewed - use Download instead."})

        try:
            with open(abs_path, "r", encoding="utf-8") as f:
                content = f.read()
        except UnicodeDecodeError:
            return self._send_json(415, {"error": "This file isn't plain text - use Download instead."})
        except OSError as err:
            return self._send_json(500, {"error": str(err)})

        is_json = False
        json_kind = None
        if ext == ".json":
            try:
                parsed = json.loads(content)
                is_json = True
                json_kind = "array" if isinstance(parsed, list) else "object"
            except json.JSONDecodeError:
                is_json = False

        return self._send_json(200, {"ok": True, "path": rel, "content": content, "isJson": is_json, "jsonKind": json_kind})

    def _handle_admin_write(self, body):
        self._require_role(("Admin", "Developer"))
        rel_path = body.get("path", "")
        content = body.get("content")
        if content is None:
            raise ValueError("content is required")

        try:
            abs_path = _safe_admin_path(rel_path)
        except ValueError:
            raise ValueError("Invalid path")

        rel = _rel_to_root(abs_path)
        if rel in ADMIN_DOWNLOAD_BLOCKLIST:
            raise ValueError("This file is protected and cannot be edited here.")
        if not os.path.isfile(abs_path):
            raise ValueError("File not found")

        if abs_path.lower().endswith(".json"):
            try:
                json.loads(content)
            except json.JSONDecodeError as err:
                raise ValueError(f"Not valid JSON: {err}")

        with open(abs_path, "w", encoding="utf-8") as f:
            f.write(content)

        return 200, {"ok": True}

    # ------------------------------------------------------------------
    # Authentication - registration / login / 2FA / password reset
    # All of these touch exactly one users.json record at a time; nothing
    # here ever sends another account's password/verification code back
    # to the browser (see auth_store.SENSITIVE_FIELDS).
    # ------------------------------------------------------------------
    def _handle_auth_me(self, query):
        user_id = self._authenticated_user_id()
        users = auth_store.load_users()
        user = auth_store.find_user_by_id(users, user_id)
        if not user:
            return self._send_json(404, {"error": "Account not found"})
        return self._send_json(200, {"ok": True, "user": auth_store.public_user_view(user)})

    # Sanitized (no password/verification-code fields) user list - used by
    # Developer/Admin UI features that need to show "which user" something
    # belongs to (Payment History, Support requests) or filter by user id/
    # email, without ever sending anyone's password to the browser.
    def _handle_auth_directory(self, query):
        self._authenticated_user_id()  # any logged-in user, no role needed
        users = auth_store.load_users()
        directory = [auth_store.public_user_view(u) for u in users]
        return self._send_json(200, {"ok": True, "users": directory})

    def _handle_auth_email_status(self, query):
        user_id = (query.get("userId", [""])[0])
        job = _get_email_job(user_id)
        if not job:
            return self._send_json(200, {"ok": True, "status": "unknown"})
        payload = {"ok": True, "status": job.get("status", "unknown")}
        if job.get("status") == "failed":
            payload["code"] = job.get("code")
        return self._send_json(200, payload)

    # ------------------------------------------------------------------
    # Lease Abstraction rules workflow (json/rules.json).
    # Any user can propose a new extraction rule - it lands in "pending"
    # tagged with their own userId. Only an approved rule (userId defaults
    # to whichever account originally owns it - the Developer, for the
    # built-in rule set) actually affects extraction; approving/rejecting
    # is meant for the Developer role, though - consistent with the rest
    # of this app's trust model - that's enforced by the UI only hiding
    # the buttons from non-Developer users, not by a real server-side
    # permission check.
    # ------------------------------------------------------------------
    def _rules_path(self):
        return os.path.join(JSON_DIR, "rules.json")

    def _load_rules(self):
        try:
            with open(self._rules_path(), "r", encoding="utf-8") as f:
                return json.load(f)
        except (OSError, json.JSONDecodeError):
            return {"version": 1, "schema": "lexora_master_rules", "approved": [], "pending": []}

    def _save_rules(self, data):
        data["totalRules"] = len(data.get("approved", [])) + len(data.get("pending", []))
        with open(self._rules_path(), "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")

    def _handle_rules_list(self, query):
        self._authenticated_user_id()
        return self._send_json(200, {"ok": True, **self._load_rules()})

    def _handle_rules_propose(self, body):
        user_id = _safe_id(self._resolve_user_id(body))
        field_id = (body.get("fieldId") or "").strip()
        rule_type = (body.get("ruleType") or "mapping").strip()
        rule_text = (body.get("ruleText") or "").strip()

        if not field_id or not rule_text:
            raise ValueError("Please fill in both Field ID and Rule Text.")

        now_iso = datetime.datetime.now().isoformat(timespec="seconds")
        new_rule = {
            "id": f"user_rule_{uuid.uuid4().hex[:10]}",
            "fieldId": field_id,
            "ruleType": rule_type,
            "ruleText": rule_text,
            "confidence": 0.7,
            "usageCount": 0,
            "successCount": 0,
            "status": "pending",
            "createdAt": now_iso,
            "approvedAt": None,
            "appliedCount": 0,
            "auditLog": [],
            "userId": user_id,
        }

        data = self._load_rules()
        data.setdefault("pending", []).append(new_rule)
        self._save_rules(data)
        return 200, {"ok": True, "rule": new_rule}

    def _handle_rules_approve(self, body):
        self._require_role(("Developer",))
        rule_id = body.get("ruleId")
        data = self._load_rules()
        pending = data.get("pending", [])
        match = next((r for r in pending if r.get("id") == rule_id), None)
        if not match:
            raise ValueError("That pending rule was not found - it may have already been handled.")

        match["status"] = "approved"
        match["approvedAt"] = datetime.datetime.now().isoformat(timespec="seconds")
        data["pending"] = [r for r in pending if r.get("id") != rule_id]
        data.setdefault("approved", []).append(match)
        self._save_rules(data)
        return 200, {"ok": True}

    def _handle_rules_reject(self, body):
        self._require_role(("Developer",))
        rule_id = body.get("ruleId")
        data = self._load_rules()
        pending = data.get("pending", [])
        if not any(r.get("id") == rule_id for r in pending):
            raise ValueError("That pending rule was not found - it may have already been handled.")
        data["pending"] = [r for r in pending if r.get("id") != rule_id]
        self._save_rules(data)
        return 200, {"ok": True}

    def _handle_auth_register(self, body):
        first = (body.get("firstName") or "").strip()
        last = (body.get("lastName") or "").strip()
        gender = body.get("gender") or ""
        birthdate = body.get("birthdate") or ""
        mobile = (body.get("mobile") or "").strip()
        email = (body.get("email") or "").strip().lower()
        password = body.get("password") or ""

        if not first or not last or not email or not password:
            raise ValueError("Please fill in all required fields.")

        users = auth_store.load_users()
        expiry_minutes = _load_smtp_expiry_minutes()
        existing = auth_store.find_user_by_email(users, email)

        if existing:
            if existing.get("emailVerified") == "Yes":
                # A real, already-verified account owns this email - no
                # second account allowed.
                raise ValueError("An account with this email already exists.")

            # Same email tried to register again before ever verifying the
            # first attempt - don't create a second account for it. Just
            # identify the existing pending account and resend its code.
            code = auth_store.generate_code()
            expires_at = auth_store.make_expiry(expiry_minutes)
            existing["verificationCode"] = code
            existing["verificationCodeExpiresAt"] = expires_at
            existing["verificationPurpose"] = "register"
            # Let a resend also pick up any edited details from this attempt.
            existing["firstName"] = first or existing.get("firstName")
            existing["lastName"] = last or existing.get("lastName")
            existing["gender"] = gender or existing.get("gender")
            existing["birthdate"] = birthdate or existing.get("birthdate")
            existing["mobile"] = mobile or existing.get("mobile")
            if password:
                issues = auth_store.password_policy_issues(password)
                if issues:
                    raise ValueError("Password must contain " + ", ".join(issues) + ".")
                existing["password"] = auth_store.hash_password(password)
            auth_store.save_users(users)

            resp = {"ok": True, "userId": existing["id"], "email": email, "expiresInMinutes": expiry_minutes}
            _send_verification_email_async(existing["id"], email, existing["firstName"], code, "register", expiry_minutes)
            return 200, resp

        issues = auth_store.password_policy_issues(password)
        if issues:
            raise ValueError("Password must contain " + ", ".join(issues) + ".")

        user_id = auth_store.next_user_id(users)
        code = auth_store.generate_code()
        expires_at = auth_store.make_expiry(expiry_minutes)

        # Every newly self-registered account has 2FA on by default, and
        # stays "InActive" (can't log in yet) until the email is verified.
        new_user = {
            "id": user_id, "photo": None, "firstName": first, "lastName": last,
            "gender": gender, "birthdate": birthdate, "mobile": mobile, "email": email,
            "password": auth_store.hash_password(password), "status": "InActive", "apiKey": None,
            "verificationCode": code, "verificationCodeExpiresAt": expires_at,
            "verificationPurpose": "register",
            "sessionStatus": "Offline", "role": "User", "lock": "No",
            "twoFactorAuth": "Yes", "emailVerified": "No", "mobileVerified": "No",
            "sysConfig": "Desktop",
        }
        users.append(new_user)
        auth_store.save_users(users)

        resp = {"ok": True, "userId": user_id, "email": email, "expiresInMinutes": expiry_minutes}
        _send_verification_email_async(user_id, email, first, code, "register", expiry_minutes)
        return 200, resp

    def _handle_auth_verify_register(self, body):
        user_id = body.get("userId")
        code = (body.get("code") or "").strip()
        users = auth_store.load_users()
        user = auth_store.find_user_by_id(users, user_id)
        if not user:
            raise ValueError("Account not found.")
        if user.get("verificationPurpose") != "register":
            raise ValueError("No pending registration verification for this account.")
        if auth_store.is_expired(user.get("verificationCodeExpiresAt")):
            raise ValueError("This code has expired. Please request a new one.")
        if code != str(user.get("verificationCode") or ""):
            raise ValueError("Incorrect verification code.")

        user["emailVerified"] = "Yes"
        user["status"] = "Active"
        user["verificationCode"] = None
        user["verificationCodeExpiresAt"] = None
        user["verificationPurpose"] = None
        auth_store.save_users(users)
        return 200, {"ok": True}

    def _handle_auth_login(self, body):
        email = (body.get("email") or "").strip().lower()
        password = body.get("password") or ""
        if not email or not password:
            raise ValueError("Please enter both email and password.")

        users = auth_store.load_users()
        user = auth_store.find_user_by_email(users, email)
        if not user or not auth_store.verify_password(password, user.get("password")):
            raise ValueError("Invalid email or password.")
        if not auth_store.is_hashed(user.get("password")):
            # Transparent migration: the first successful login with a
            # still-plaintext password upgrades it to a real hash.
            user["password"] = auth_store.hash_password(password)
        if user.get("lock") == "Yes":
            raise ValueError("This account is locked. Please contact support.")
        if user.get("emailVerified") == "No" or user.get("status") == "InActive":
            raise ValueError("Please verify your account first - check your email for the verification code, or use Create Account again to get a new one.")

        if user.get("twoFactorAuth") == "Yes":
            code = auth_store.generate_code()
            expiry_minutes = _load_smtp_expiry_minutes()
            expires_at = auth_store.make_expiry(expiry_minutes)
            user["verificationCode"] = code
            user["verificationCodeExpiresAt"] = expires_at
            user["verificationPurpose"] = "login"
            auth_store.save_users(users)

            resp = {
                "ok": True, "requires2FA": True, "userId": user["id"],
                "email": user["email"], "expiresInMinutes": expiry_minutes,
            }
            _send_verification_email_async(user["id"], user["email"], user["firstName"], code, "login", expiry_minutes)
            return 200, resp

        user["sessionStatus"] = "Online"
        auth_store.save_users(users)
        token = _create_session(user["id"])
        return 200, {"ok": True, "requires2FA": False, "userId": user["id"], "token": token}

    def _handle_auth_verify_login(self, body):
        user_id = body.get("userId")
        code = (body.get("code") or "").strip()
        users = auth_store.load_users()
        user = auth_store.find_user_by_id(users, user_id)
        if not user:
            raise ValueError("Account not found.")
        if user.get("verificationPurpose") != "login":
            raise ValueError("No pending login verification for this account.")
        if auth_store.is_expired(user.get("verificationCodeExpiresAt")):
            raise ValueError("This code has expired. Please request a new one.")
        if code != str(user.get("verificationCode") or ""):
            raise ValueError("Incorrect verification code.")

        user["verificationCode"] = None
        user["verificationCodeExpiresAt"] = None
        user["verificationPurpose"] = None
        user["sessionStatus"] = "Online"
        auth_store.save_users(users)
        token = _create_session(user_id)
        return 200, {"ok": True, "userId": user_id, "token": token}

    def _handle_auth_logout(self, body):
        auth_header = self.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            _destroy_session(auth_header[7:].strip())
        return 200, {"ok": True}

    def _handle_auth_forgot_password(self, body):
        email = (body.get("email") or "").strip().lower()
        if not email:
            raise ValueError("Please enter your email address.")

        users = auth_store.load_users()
        user = auth_store.find_user_by_email(users, email)
        if not user:
            raise ValueError("No account found with this email.")

        code = auth_store.generate_code()
        expiry_minutes = _load_smtp_expiry_minutes()
        expires_at = auth_store.make_expiry(expiry_minutes)
        user["verificationCode"] = code
        user["verificationCodeExpiresAt"] = expires_at
        user["verificationPurpose"] = "reset"
        auth_store.save_users(users)

        resp = {
            "ok": True, "userId": user["id"], "email": user["email"],
            "expiresInMinutes": expiry_minutes,
        }
        _send_verification_email_async(user["id"], user["email"], user["firstName"], code, "reset", expiry_minutes)
        return 200, resp

    def _handle_auth_verify_reset_code(self, body):
        # Checks validity without consuming the code - lets the frontend
        # move on to the "set new password" step. reset-password below
        # re-validates it for real before actually changing anything.
        user_id = body.get("userId")
        code = (body.get("code") or "").strip()
        users = auth_store.load_users()
        user = auth_store.find_user_by_id(users, user_id)
        if not user:
            raise ValueError("Account not found.")
        if user.get("verificationPurpose") != "reset":
            raise ValueError("No pending password reset for this account.")
        if auth_store.is_expired(user.get("verificationCodeExpiresAt")):
            raise ValueError("This code has expired. Please request a new one.")
        if code != str(user.get("verificationCode") or ""):
            raise ValueError("Incorrect verification code.")
        return 200, {"ok": True}

    def _handle_auth_reset_password(self, body):
        user_id = body.get("userId")
        code = (body.get("code") or "").strip()
        new_password = body.get("newPassword") or ""
        users = auth_store.load_users()
        user = auth_store.find_user_by_id(users, user_id)
        if not user:
            raise ValueError("Account not found.")
        if user.get("verificationPurpose") != "reset":
            raise ValueError("No pending password reset for this account.")
        if auth_store.is_expired(user.get("verificationCodeExpiresAt")):
            raise ValueError("This code has expired. Please request a new one.")
        if code != str(user.get("verificationCode") or ""):
            raise ValueError("Incorrect verification code.")

        issues = auth_store.password_policy_issues(new_password)
        if issues:
            raise ValueError("Password must contain " + ", ".join(issues) + ".")

        user["password"] = auth_store.hash_password(new_password)
        user["verificationCode"] = None
        user["verificationCodeExpiresAt"] = None
        user["verificationPurpose"] = None
        auth_store.save_users(users)
        return 200, {"ok": True}

    def _handle_auth_resend_code(self, body):
        user_id = body.get("userId")
        users = auth_store.load_users()
        user = auth_store.find_user_by_id(users, user_id)
        if not user:
            raise ValueError("Account not found.")
        purpose = user.get("verificationPurpose")
        if not purpose:
            raise ValueError("No pending verification for this account.")

        code = auth_store.generate_code()
        expiry_minutes = _load_smtp_expiry_minutes()
        expires_at = auth_store.make_expiry(expiry_minutes)
        user["verificationCode"] = code
        user["verificationCodeExpiresAt"] = expires_at
        auth_store.save_users(users)

        resp = {"ok": True, "expiresInMinutes": expiry_minutes}
        _send_verification_email_async(user["id"], user["email"], user["firstName"], code, purpose, expiry_minutes)
        return 200, resp

    # ------------------------------------------------------------------
    # Profile - patches exactly one user's own record (replaces the old
    # blanket PUT /api/data/users, which is no longer exposed at all).
    # ------------------------------------------------------------------
    def _handle_profile_update(self, body):
        user_id = self._resolve_user_id(body)
        fields = body.get("fields") or {}
        if not user_id:
            raise ValueError("userId is required")

        users = auth_store.load_users()
        user = auth_store.find_user_by_id(users, user_id)
        if not user:
            raise ValueError("Account not found.")

        if "password" in fields and fields["password"]:
            issues = auth_store.password_policy_issues(fields["password"])
            if issues:
                raise ValueError("Password must contain " + ", ".join(issues) + ".")
            fields["password"] = auth_store.hash_password(fields["password"])
        else:
            # Blank/missing means "don't change it" - never let an empty
            # string overwrite the real hash.
            fields.pop("password", None)

        # Never let a profile-update request touch auth/security bookkeeping
        # fields - those are only ever written by the auth handlers above.
        for blocked in ("id", "role", "lock", "verificationCode", "verificationCodeExpiresAt",
                         "verificationPurpose", "emailVerified", "status"):
            fields.pop(blocked, None)

        user.update(fields)
        auth_store.save_users(users)
        return 200, {"ok": True, "user": auth_store.public_user_view(user)}


def main():
    os.makedirs(USERS_DIR, exist_ok=True)
    os.makedirs(TEMPLATE_DIR, exist_ok=True)
    if not os.path.isfile(DEFAULT_TEMPLATE_PATH) and lease_engine.REPORTLAB_OK:
        lease_engine.build_default_template_pdf(DEFAULT_TEMPLATE_PATH)

    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"✅ Server running — open http://localhost:{PORT}/  (serves index.html)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
