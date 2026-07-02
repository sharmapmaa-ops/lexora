#!/usr/bin/env python3
"""
Backend for the Lexora / TechCorp Solutions menu system (Python version).

What this is for:
Opening main.html as a plain static file (or serving it with a plain
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
    http://localhost:8000/          (redirects to /main.html)

(PORT=3000 python3 py/server.py to use a different port.)
"""

import base64
import datetime
import json
import mimetypes
import os
import re
import shutil
import smtplib
import ssl
import sys
import threading
import uuid
from email.mime.text import MIMEText
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lease_engine  # noqa: E402  (needs the sys.path tweak above)
import auth_store  # noqa: E402

PORT = int(os.environ.get("PORT", 8000))

# server.py lives in py/, but it still needs to serve/read the project root
# (main.html, css/, json/, Pictures/, Users/) - so ROOT_DIR is one level up
# from this file, not the py/ folder itself.
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JSON_DIR = os.path.join(ROOT_DIR, "json")
USERS_DIR = os.path.join(ROOT_DIR, "Users")
TEMPLATE_DIR = os.path.join(ROOT_DIR, "Template", "LeaseAbstraction")
DEFAULT_TEMPLATE_PATH = os.path.join(TEMPLATE_DIR, "Default.pdf")

# Only these json/ files can be read/written through the /api/data/<name>
# API - this is a hard allowlist so that route can never be used to read or
# overwrite anything else on disk (app.js, server.py, smtp-config.json,
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
}

# json files that must never be served as static files (contain secrets).
PROTECTED_JSON_FILES = {"smtp-config.json", "llm-config.json", "users.json"}

# Relative paths (from ROOT_DIR, forward slashes) the Admin File Manager
# will never let you *view, edit, or download* the raw contents of, even
# though it's still visible/manageable (e.g. deletable) in the listing.
# Currently empty - users.json, smtp-config.json and llm-config.json are
# all viewable/editable through this (Developer/Admin-only, authenticated)
# panel per explicit request; they're still blocked from *direct*
# unauthenticated static-file access (PROTECTED_JSON_FILES, below).
ADMIN_DOWNLOAD_BLOCKLIST = set()

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


def _get_primary(items):
    """Returns the item flagged primary=true, or the first item if none is
    flagged, or None if the list is empty - shared logic for picking which
    SMTP account / LLM API key to actually use by default."""
    if not items:
        return None
    for item in items:
        if item.get("primary"):
            return item
    return items[0]


def _read_smtp_config():
    path = os.path.join(JSON_DIR, "smtp-config.json")
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _primary_smtp_account():
    cfg = _read_smtp_config()
    account = _get_primary(cfg.get("accounts") or [])
    if not account:
        raise ValueError("No SMTP account is configured in json/smtp-config.json")
    return account


def _load_smtp_expiry_minutes():
    try:
        cfg = _read_smtp_config()
        return int(cfg.get("expiry_minutes", 10))
    except (OSError, json.JSONDecodeError, ValueError, TypeError):
        return 10


def _send_email(to_email, subject, body):
    """Generic SMTP sender shared by the contact-us acknowledgement email
    and every verification-code email (register/login/reset). Uses
    whichever account in json/smtp-config.json's "accounts" list is
    flagged primary (falls back to the first one). The account's password
    is never required to live in the committed JSON file - SMTP_PASSWORD
    (an env var / Codespace secret / git-ignored .env entry) takes
    priority, and a literal "password" in the JSON is only used as a
    last-resort fallback."""
    account = _primary_smtp_account()
    host = account["host"]
    port = int(account.get("port", 465))
    username = account.get("username")
    password = os.environ.get("SMTP_PASSWORD") or account.get("password")
    sender = account.get("sender_email", username)
    use_tls = bool(account.get("use_tls", False))

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


def _send_acknowledgement_email(to_email, user_name, msg_type, subject, message):
    body = (
        f"Hi {user_name},\n\n"
        f"Thanks for reaching out. We've received your {msg_type.lower()} and "
        f"our team will resolve it as soon as possible.\n\n"
        f"Subject: {subject}\n"
        f"Your message:\n{message}\n\n"
        f"— Support Team"
    )
    _send_email(to_email, f"We've received your {msg_type.lower()}: {subject}", body)


_VERIFICATION_PURPOSE_LABELS = {
    "register": "complete your registration",
    "login": "complete your login",
    "reset": "reset your password",
}


def _send_verification_email(to_email, user_name, code, purpose, expiry_minutes):
    label = _VERIFICATION_PURPOSE_LABELS.get(purpose, "verify your account")
    body = (
        f"Hi {user_name},\n\n"
        f"Use this code to {label}:\n\n"
        f"    {code}\n\n"
        f"This code expires in {expiry_minutes} minute(s).\n\n"
        f"If you didn't request this, you can safely ignore this email.\n\n"
        f"— Lexora AI Solutions"
    )
    _send_email(to_email, f"Your verification code: {code}", body)


# ============================================================
# HTTP handler
# ============================================================
class Handler(SimpleHTTPRequestHandler):
    """Serves main.html, css/, js/, json/, Pictures/, Users/ exactly like a
    normal static file server would (except protected json files), plus
    the /api/... routes below."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT_DIR, **kwargs)

    def log_message(self, fmt, *args):
        # Keep the console readable - default logging is very chatty.
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

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

        # Section 3: opening the bare forwarded port loads main.html
        # automatically - no more typing "/main.html" every time.
        if path == "/" or path == "":
            self.send_response(302)
            self.send_header("Location", "/main.html")
            self.end_headers()
            return

        if path == "/api/admin/list":
            return self._handle_admin_list(parse_qs(parsed.query))
        if path == "/api/admin/download":
            return self._handle_admin_download(parse_qs(parsed.query))
        if path == "/api/admin/read":
            return self._handle_admin_read(parse_qs(parsed.query))
        if path == "/api/auth/me":
            return self._handle_auth_me(parse_qs(parsed.query))
        if path == "/api/lease/extract-status":
            return self._handle_lease_extract_status(parse_qs(parsed.query))

        # Never let smtp-config.json (SMTP credentials) be downloaded as a
        # static file - it's only ever read server-side.
        basename = os.path.basename(path)
        if basename in PROTECTED_JSON_FILES:
            return self._send_json(403, {"error": "Forbidden"})

        name = self._resource_name()
        if name is None:
            return super().do_GET()

        if name not in ALLOWED_RESOURCES:
            return self._send_json(404, {"error": f'Unknown resource "{name}"'})

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
            "/api/lease/scan-template": self._handle_lease_scan_template,
            "/api/lease/upload-template": self._handle_lease_upload_template,
            "/api/lease/upload": self._handle_lease_upload,
            "/api/lease/extract-start": self._handle_lease_extract_start,
            "/api/lease/analyze": self._handle_lease_analyze,
            "/api/lease/validate": self._handle_lease_validate,
            "/api/lease/save-output": self._handle_lease_save_output,
            "/api/lease/generate-pdf": self._handle_lease_generate_pdf,
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
        user_id = _safe_id(body.get("userId"))
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
            body.get("type") or "Query",
            body.get("subject") or "(no subject)",
            body.get("message") or "",
        )
        return 200, {"ok": True}

    # ---- Section 14.1: output template scan (batch-level, not per file) ----
    def _handle_lease_scan_template(self, body):
        user_id = _safe_id(body.get("userId"))
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
        user_id = _safe_id(body.get("userId"))
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
        user_id = _safe_id(body.get("userId"))
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
        user_id = _safe_id(body.get("userId"))
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
        user_id = _safe_id(body.get("userId"))
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
        user_id = _safe_id(body.get("userId"))
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
    # Admin File Manager - POST routes
    # ------------------------------------------------------------------
    def _handle_admin_mkdir(self, body):
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
        user_id = (query.get("userId", [""])[0])
        users = auth_store.load_users()
        user = auth_store.find_user_by_id(users, user_id)
        if not user:
            return self._send_json(404, {"error": "Account not found"})
        return self._send_json(200, {"ok": True, "user": user})

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
                existing["password"] = password
            auth_store.save_users(users)

            resp = {"ok": True, "userId": existing["id"], "email": email, "expiresInMinutes": expiry_minutes}
            try:
                _send_verification_email(email, existing["firstName"], code, "register", expiry_minutes)
            except Exception as err:
                print(f"Could not resend registration verification email: {err}")
                resp["emailFailed"] = True
                resp["code"] = code
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
            "password": password, "status": "InActive", "apiKey": None,
            "verificationCode": code, "verificationCodeExpiresAt": expires_at,
            "verificationPurpose": "register",
            "sessionStatus": "Offline", "role": "User", "lock": "No",
            "twoFactorAuth": "Yes", "emailVerified": "No", "mobileVerified": "No",
            "sysConfig": "Desktop",
        }
        users.append(new_user)
        auth_store.save_users(users)

        resp = {"ok": True, "userId": user_id, "email": email, "expiresInMinutes": expiry_minutes}
        try:
            _send_verification_email(email, first, code, "register", expiry_minutes)
        except Exception as err:
            print(f"Could not send registration verification email: {err}")
            resp["emailFailed"] = True
            resp["code"] = code
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
        if not user or user.get("password") != password:
            raise ValueError("Invalid email or password.")
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
            try:
                _send_verification_email(user["email"], user["firstName"], code, "login", expiry_minutes)
            except Exception as err:
                print(f"Could not send login verification email: {err}")
                resp["emailFailed"] = True
                resp["code"] = code
            return 200, resp

        user["sessionStatus"] = "Online"
        auth_store.save_users(users)
        return 200, {"ok": True, "requires2FA": False, "userId": user["id"]}

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
        return 200, {"ok": True, "userId": user_id}

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
        try:
            _send_verification_email(user["email"], user["firstName"], code, "reset", expiry_minutes)
        except Exception as err:
            print(f"Could not send password reset email: {err}")
            resp["emailFailed"] = True
            resp["code"] = code
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

        user["password"] = new_password
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
        try:
            _send_verification_email(user["email"], user["firstName"], code, purpose, expiry_minutes)
        except Exception as err:
            print(f"Could not resend verification email: {err}")
            resp["emailFailed"] = True
            resp["code"] = code
        return 200, resp

    # ------------------------------------------------------------------
    # Profile - patches exactly one user's own record (replaces the old
    # blanket PUT /api/data/users, which is no longer exposed at all).
    # ------------------------------------------------------------------
    def _handle_profile_update(self, body):
        user_id = body.get("userId")
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

        # Never let a profile-update request touch auth/security bookkeeping
        # fields - those are only ever written by the auth handlers above.
        for blocked in ("id", "role", "lock", "verificationCode", "verificationCodeExpiresAt",
                         "verificationPurpose", "emailVerified", "status"):
            fields.pop(blocked, None)

        user.update(fields)
        auth_store.save_users(users)
        return 200, {"ok": True, "user": user}


def main():
    os.makedirs(USERS_DIR, exist_ok=True)
    os.makedirs(TEMPLATE_DIR, exist_ok=True)
    if not os.path.isfile(DEFAULT_TEMPLATE_PATH) and lease_engine.REPORTLAB_OK:
        lease_engine.build_default_template_pdf(DEFAULT_TEMPLATE_PATH)

    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"✅ Server running — open http://localhost:{PORT}/  (auto-redirects to main.html)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
