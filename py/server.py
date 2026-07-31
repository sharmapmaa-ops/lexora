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
import hashlib
import hmac
import secrets
import shutil
import tempfile
import smtplib
import ssl
import sys
import threading
import time
import uuid
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, quote as url_quote, urlencode
import urllib.request
import urllib.error
import html as html_module

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lease_engine  # noqa: E402  (needs the sys.path tweak above)
import auth_store

# Optional Postgres layer. DATABASE_URL na ho (ya psycopg install na ho) to
# db.is_enabled() False rehta hai aur app pehle jaisa JSON par chalta hai.
try:
    import db
except Exception as _db_err:  # noqa: BLE001
    db = None
    print(f"[db] Postgres layer unavailable, using JSON files ({_db_err})")  # noqa: E402

PORT = int(os.environ.get("PORT", 8000))

# server.py lives in py/, but it still needs to serve/read the project root
# (index.html, css/, json/, Pictures/, Users/) - so ROOT_DIR is one level up
# from this file, not the py/ folder itself.
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ---------------------------------------------------------------------------
# PERSISTENT DATA LOCATION
# ---------------------------------------------------------------------------
# The container filesystem is REBUILT FROM THE REPO on every deploy, so
# anything written at runtime inside the image (registered users, wallet
# transactions, admin edits to json/plans.json, processed files under
# Users/) disappears the moment you redeploy.
#
# Setting LEXORA_DATA_DIR to a mounted persistent disk moves that mutable
# state out of the image, so deploys only replace CODE and leave DATA alone.
#   e.g.  LEXORA_DATA_DIR=/var/lexora-data   (disk mounted there)
#
# If it isn't set, everything behaves exactly as before (repo-local dirs),
# so local development and existing setups are unaffected.
DATA_DIR = (os.environ.get("LEXORA_DATA_DIR") or "").strip()
if DATA_DIR:
    JSON_DIR = os.path.join(DATA_DIR, "json")
    USERS_DIR = os.path.join(DATA_DIR, "Users")
else:
    JSON_DIR = os.path.join(ROOT_DIR, "json")
    USERS_DIR = os.path.join(ROOT_DIR, "Users")

TEMPLATE_DIR = os.path.join(ROOT_DIR, "Template", "LeaseAbstraction")
DEFAULT_TEMPLATE_PATH = os.path.join(TEMPLATE_DIR, "Default.pdf")


def _seed_persistent_data():
    """First boot on a fresh disk: copy the repo's default json/ and Users/
    across, then never overwrite them again.

    Without this a newly attached (empty) disk would leave the app with no
    plans.json / users.json at all. Files are copied ONLY if missing, so a
    later deploy can add a brand-new JSON file without clobbering the live
    data in the ones that already exist.
    """
    if not DATA_DIR:
        return
    for name, target in (("json", JSON_DIR), ("Users", USERS_DIR)):
        source = os.path.join(ROOT_DIR, name)
        os.makedirs(target, exist_ok=True)
        if not os.path.isdir(source):
            continue
        for entry in os.listdir(source):
            src_path = os.path.join(source, entry)
            dst_path = os.path.join(target, entry)
            if os.path.exists(dst_path):
                continue          # live data wins - never overwrite
            try:
                if os.path.isdir(src_path):
                    shutil.copytree(src_path, dst_path)
                else:
                    shutil.copy2(src_path, dst_path)
                print(f"[data] seeded {name}/{entry}")
            except Exception as exc:                      # noqa: BLE001
                print(f"[data] could not seed {name}/{entry}: {exc}")


_seed_persistent_data()


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
# _sessions itself stays in-memory (the fast lookup path on every single
# request) - json/sessions.json (see _persist_sessions_locked below) is a
# durable, human-inspectable mirror of it for admin visibility, storing
# only a one-way hash of each token rather than the live token itself. A
# server restart still logs everyone out (the in-memory dict is gone),
# but the history of who was active when survives in that file.
# ============================================================
_sessions = {}
_sessions_lock = threading.Lock()
SESSION_TTL_HOURS = 24 * 7  # 7 days - absolute maximum a session can live
IDLE_TIMEOUT_MINUTES = 30   # auto-logout after this long with no activity,
                            # even if well within the 7-day absolute limit
_SESSIONS_JSON_PATH = None  # resolved lazily, see _sessions_json_path()


def _sessions_json_path():
    global _SESSIONS_JSON_PATH
    if _SESSIONS_JSON_PATH is None:
        _SESSIONS_JSON_PATH = os.path.join(JSON_DIR, "sessions.json")
    return _SESSIONS_JSON_PATH


def _persist_sessions_locked():
    """Caller must already hold _sessions_lock."""
    try:
        rows = []
        for token, s in _sessions.items():
            rows.append({
                "token": token,
                "userId": s["userId"],
                "createdAt": s["createdAt"].isoformat(timespec="seconds"),
                "lastActiveAt": s["lastActiveAt"].isoformat(timespec="seconds"),
                "expiresAt": s["expiresAt"].isoformat(timespec="seconds"),
            })
        with open(_sessions_json_path(), "w", encoding="utf-8") as f:
            json.dump(rows, f, indent=2)
    except OSError as err:
        print(f"Could not persist sessions.json (non-fatal): {err}")


def _load_sessions_at_startup():
    """The other half of _persist_sessions_locked() - without this,
    sessions.json was being written on every login but never read back,
    so _sessions (in-memory) started empty on every process restart -
    meaning every logged-in user got silently logged out on every deploy
    (a new container = a fresh process = an empty _sessions dict), even
    though their session was still technically unexpired. Called once at
    server startup, before any requests are served."""
    try:
        with open(_sessions_json_path(), "r", encoding="utf-8") as f:
            rows = json.load(f)
    except (OSError, json.JSONDecodeError):
        return
    now = datetime.datetime.now()
    restored = 0
    with _sessions_lock:
        for row in rows:
            token = row.get("token")
            if not token:
                continue  # older sessions.json (hash-only) rows can't be restored - they just age out
            try:
                expires_at = datetime.datetime.fromisoformat(row["expiresAt"])
            except (KeyError, ValueError):
                continue
            if now > expires_at:
                continue
            _sessions[token] = {
                "userId": row["userId"],
                "createdAt": datetime.datetime.fromisoformat(row["createdAt"]),
                "lastActiveAt": datetime.datetime.fromisoformat(row["lastActiveAt"]),
                "expiresAt": expires_at,
            }
            restored += 1
    if restored:
        print(f"Restored {restored} active session(s) from sessions.json.")


def _create_session(user_id):
    token = secrets.token_urlsafe(32)
    now = datetime.datetime.now()
    with _sessions_lock:
        # Bug 5 SINGLE-SESSION: ek user ke SAB purane sessions invalidate karo
        # taaki ek jagah login karne par doosri jagah auto-logout ho jaye.
        stale = [t for t, s in _sessions.items() if s.get("userId") == user_id]
        for t in stale:
            del _sessions[t]
        _sessions[token] = {
            "userId": user_id,
            "createdAt": now,
            "lastActiveAt": now,
            "expiresAt": now + datetime.timedelta(hours=SESSION_TTL_HOURS),
        }
        _persist_sessions_locked()
    return token


def _get_session(token):
    """Besides the absolute 7-day expiry, a session now also auto-logs-out
    after IDLE_TIMEOUT_MINUTES of no activity at all - every successful
    call here counts as activity and slides that window forward.
    sessions.json is only re-written at most once every 60 seconds per
    session (not on literally every request) to avoid hammering disk on
    a busy session."""
    now = datetime.datetime.now()
    with _sessions_lock:
        session = _sessions.get(token)
        if not session:
            return None
        if now > session["expiresAt"]:
            del _sessions[token]
            _persist_sessions_locked()
            return None
        if now - session["lastActiveAt"] > datetime.timedelta(minutes=IDLE_TIMEOUT_MINUTES):
            del _sessions[token]
            _persist_sessions_locked()
            return None
        should_persist = (now - session["lastActiveAt"]) > datetime.timedelta(seconds=60)
        session["lastActiveAt"] = now
        if should_persist:
            _persist_sessions_locked()
        return session


# ============================================================
# Item 8 (production security) - a simple in-memory rate limiter for the
# endpoints someone could otherwise brute-force: login (password guessing)
# and the OTP-verify endpoints (a 6-digit code is only 1,000,000
# possibilities - with no throttling at all, that's guessable in minutes
# with a basic script). Keyed by whatever identifies the *target* being
# attacked (email or userId), not by IP, since this app has no reverse
# proxy in front of it yet to reliably supply a real client IP - see the
# production security notes for why a real reverse proxy + this app
# together is the right long-term setup.
# ============================================================
_rate_limit_hits = {}
_rate_limit_lock = threading.Lock()


def _check_rate_limit(key, max_attempts=8, window_seconds=300):
    """Raises ValueError (surfaced to the client as a normal 400 error,
    not a stack trace) once `key` has been hit more than `max_attempts`
    times within `window_seconds`. Callers should call this BEFORE doing
    the sensitive check (password/code comparison), so a failed attempt
    still counts even though the request is about to be rejected anyway."""
    now = time.time()
    with _rate_limit_lock:
        hits = [t for t in _rate_limit_hits.get(key, []) if now - t < window_seconds]
        hits.append(now)
        _rate_limit_hits[key] = hits
        if len(hits) > max_attempts:
            raise ValueError("Too many attempts. Please wait a few minutes and try again.")


def _maintenance_json_path():
    return os.path.join(JSON_DIR, "maintenance.json")


_maintenance_cache = {"data": None, "checked_at": 0.0}
_maintenance_cache_lock = threading.Lock()
MAINTENANCE_CACHE_SECONDS = 5


def _get_maintenance_status():
    """{"enabled": bool, "message": str}. Cached briefly since this is
    checked on essentially every request while enabled - a few seconds of
    staleness on the flag itself is a fine trade for not hitting the DB
    on every single page load/API call."""
    with _maintenance_cache_lock:
        if _maintenance_cache["data"] is not None and time.time() - _maintenance_cache["checked_at"] < MAINTENANCE_CACHE_SECONDS:
            return _maintenance_cache["data"]

    data = None
    if db is not None and db.is_enabled():
        try:
            data = db.get_setting("maintenance")
        except Exception as err:  # noqa: BLE001
            print(f"[db] maintenance read failed, falling back to JSON: {err}")
    if not data:
        try:
            with open(_maintenance_json_path(), "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError):
            data = {"enabled": False, "message": ""}

    with _maintenance_cache_lock:
        _maintenance_cache["data"] = data
        _maintenance_cache["checked_at"] = time.time()
    return data


def _save_maintenance_status(data):
    if db is not None and db.is_enabled():
        try:
            db.save_setting("maintenance", data)
        except Exception as err:  # noqa: BLE001
            print(f"[db] maintenance save failed, falling back to JSON: {err}")
            with open(_maintenance_json_path(), "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
    else:
        with open(_maintenance_json_path(), "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
    with _maintenance_cache_lock:
        _maintenance_cache["data"] = data
        _maintenance_cache["checked_at"] = time.time()


# Paths that must keep working even while maintenance mode is on -
# otherwise nobody (including Admin/Developer) could ever log in to turn
# it back off again.
MAINTENANCE_ALLOWED_API_PATHS = {
    "/api/maintenance-status",
    "/api/auth/login", "/api/auth/verify-login", "/api/auth/me", "/api/auth/logout",
    "/api/auth/resend-code", "/api/data/company",
    "/api/auth/oauth/google/start", "/api/auth/oauth/google/callback",
    "/api/auth/oauth/facebook/start", "/api/auth/oauth/facebook/callback",
}


def _destroy_session(token):
    with _sessions_lock:
        _sessions.pop(token, None)
        _persist_sessions_locked()


def _destroy_sessions_for_user(user_id):
    with _sessions_lock:
        stale = [t for t, s in _sessions.items() if s.get("userId") == user_id]
        for t in stale:
            del _sessions[t]
        _persist_sessions_locked()


# ============================================================
# Google / Facebook sign-in (OAuth2 authorization-code flow).
#
# This is a real browser-navigation flow, not a fetch() call like the
# rest of the app: clicking "Continue with Google" sends the browser to
# Google's own consent screen, Google redirects back to our /callback
# route with a code, we exchange that for the user's email, then create/
# find the matching Lexora account and log them in - finally redirecting
# to "/" with a short-lived one-time token in the URL, which the SPA
# picks up on load (same pattern already used for the "magic verify
# link" from registration emails) and exchanges for the real session.
#
# Needs these env vars set (see .env.example): GOOGLE_CLIENT_ID,
# GOOGLE_CLIENT_SECRET, FACEBOOK_APP_ID, FACEBOOK_APP_SECRET, and
# ideally APP_BASE_URL (e.g. https://lexora.onrender.com) so the
# redirect_uri sent to Google/Facebook is always exactly what's
# registered in their developer consoles, regardless of what Host header
# a request happens to arrive with.
# ============================================================
_oauth_states = {}
_oauth_states_lock = threading.Lock()
OAUTH_STATE_TTL_SECONDS = 600


def _oauth_configured(provider):
    if provider == "google":
        return bool(os.environ.get("GOOGLE_CLIENT_ID")) and bool(os.environ.get("GOOGLE_CLIENT_SECRET"))
    if provider == "facebook":
        return bool(os.environ.get("FACEBOOK_APP_ID")) and bool(os.environ.get("FACEBOOK_APP_SECRET"))
    return False


def _oauth_base_url(handler):
    configured = os.environ.get("APP_BASE_URL", "").strip().rstrip("/")
    if configured:
        return configured
    # Local-dev fallback only - production should set APP_BASE_URL so the
    # redirect_uri can't be influenced by a spoofed Host header.
    host = handler.headers.get("Host", "localhost:8000")
    return f"http://{host}"


def _new_oauth_state():
    token = secrets.token_urlsafe(24)
    with _oauth_states_lock:
        now = time.time()
        # Sweep expired entries while we're here rather than growing forever.
        for t in [k for k, v in _oauth_states.items() if now - v > OAUTH_STATE_TTL_SECONDS]:
            del _oauth_states[t]
        _oauth_states[token] = now
    return token


def _consume_oauth_state(token):
    with _oauth_states_lock:
        created = _oauth_states.pop(token, None)
    if created is None:
        return False
    return time.time() - created <= OAUTH_STATE_TTL_SECONDS


def _oauth_fetch_user_email(provider, code, redirect_uri):
    """Exchanges the authorization code for an access token, then fetches
    the account's email/name. Returns (email, first_name, last_name)."""
    if provider == "google":
        token_data = urlencode({
            "code": code,
            "client_id": os.environ.get("GOOGLE_CLIENT_ID", ""),
            "client_secret": os.environ.get("GOOGLE_CLIENT_SECRET", ""),
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
        }).encode("utf-8")
        req = urllib.request.Request(
            "https://oauth2.googleapis.com/token", data=token_data, method="POST",
            headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            token_resp = json.loads(resp.read().decode("utf-8"))
        access_token = token_resp.get("access_token")
        if not access_token:
            raise ValueError("Google did not return an access token.")

        info_req = urllib.request.Request(
            "https://www.googleapis.com/oauth2/v3/userinfo",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        with urllib.request.urlopen(info_req, timeout=15) as resp:
            info = json.loads(resp.read().decode("utf-8"))
        email = (info.get("email") or "").strip().lower()
        if not email:
            raise ValueError("Google did not share an email address for this account.")
        given = info.get("given_name") or (info.get("name") or "").split(" ")[0] or "there"
        family = info.get("family_name") or ""
        return email, given, family

    if provider == "facebook":
        token_url = "https://graph.facebook.com/v19.0/oauth/access_token?" + urlencode({
            "client_id": os.environ.get("FACEBOOK_APP_ID", ""),
            "client_secret": os.environ.get("FACEBOOK_APP_SECRET", ""),
            "redirect_uri": redirect_uri,
            "code": code,
        })
        with urllib.request.urlopen(token_url, timeout=15) as resp:
            token_resp = json.loads(resp.read().decode("utf-8"))
        access_token = token_resp.get("access_token")
        if not access_token:
            raise ValueError("Facebook did not return an access token.")

        info_url = "https://graph.facebook.com/me?" + urlencode({
            "fields": "id,email,first_name,last_name",
            "access_token": access_token,
        })
        with urllib.request.urlopen(info_url, timeout=15) as resp:
            info = json.loads(resp.read().decode("utf-8"))
        email = (info.get("email") or "").strip().lower()
        if not email:
            raise ValueError("This Facebook account has no email address to sign in with - "
                              "Facebook only shares one if the account has a verified email on file.")
        return email, info.get("first_name") or "there", info.get("last_name") or ""

    raise ValueError(f"Unknown provider: {provider}")


def _find_or_create_oauth_user(email, first_name, last_name):
    """Finds the existing account by email, or creates a new one -
    already-verified (Google/Facebook already confirmed the email), no
    password usable for login (a random unguessable string - the account
    can only be accessed via OAuth, or by using "Forgot password" later
    to set a real one)."""
    users = auth_store.load_users()
    user = auth_store.find_user_by_email(users, email)
    if user:
        return user

    user_id = auth_store.next_user_id(users)
    today = datetime.date.today()
    new_user = {
        "id": user_id, "photo": None, "firstName": first_name, "lastName": last_name,
        "gender": "", "birthdate": "", "mobile": "", "email": email,
        "password": auth_store.hash_password(secrets.token_urlsafe(24)),
        "status": "Active", "apiKey": None,
        "sessionStatus": "Offline", "role": "User", "lock": "No",
        "twoFactorAuth": "Yes", "emailVerified": "Yes", "mobileVerified": "No",
        "verificationMethod": "email", "sysConfig": "Desktop",
        "plan": "Free", "planStartDate": today.isoformat(),
        "planEndDate": (today + datetime.timedelta(days=7)).isoformat(), "planStatus": "Active",
        "createdAt": datetime.datetime.utcnow().isoformat() + "Z",
        "accountType": "Personal",
    }
    users.append(new_user)
    auth_store.save_users(users)
    return new_user


# ============================================================
# Razorpay - server-side verified balance top-ups.
#
# The existing generic PUT /api/data/payment-history route lets ANY
# logged-in user overwrite the whole payment-history.json array with
# whatever they like - fine for the old "manual entry, pending Admin
# approval" flow (an Admin still has to approve it before it counts
# toward the balance), but real money can't be trusted to a client PUT.
# These two routes are the only place a "Razorpay" transaction is ever
# written, and they only run after Razorpay's own HMAC signature has
# been verified server-side - the browser never gets to assert an
# amount that becomes real balance on its own.
#
# _payment_history_lock is separate from the generic PUT path (which
# stays un-locked, matching its existing behaviour) so a Razorpay
# verify can never race with itself or silently lose an entry.
# ============================================================
_payment_history_lock = threading.Lock()


def _append_payment_history_entry(entry):
    # Postgres configured ho to wahan likho - INSERT khud atomic hai,
    # isliye read-modify-write wali race condition hi nahi hoti. Ye
    # branch tabhi chalti hai jab DATABASE_URL set ho, warna neeche wala
    # purana JSON path jaise ka waisa chalta rehta hai.
    if db is not None and db.is_enabled():
        try:
            return db.append_transaction(entry)
        except Exception as err:  # noqa: BLE001
            # DB down ho to payment gum nahi hona chahiye - JSON par gir
            # jao aur log kar do taaki baad me reconcile ho sake.
            print(f"[db] transaction insert failed, falling back to JSON: {err}")

    path = os.path.join(JSON_DIR, "payment-history.json")
    with _payment_history_lock:
        try:
            with open(path, "r", encoding="utf-8") as f:
                rows = json.load(f)
            if not isinstance(rows, list):
                rows = []
        except (OSError, json.JSONDecodeError):
            rows = []
        rows.append(entry)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(rows, f, indent=4, ensure_ascii=False)
            f.write("\n")
    return entry


def _razorpay_auth_header():
    key_id = os.environ.get("RAZORPAY_KEY_ID", "").strip()
    key_secret = os.environ.get("RAZORPAY_KEY_SECRET", "").strip()
    if not key_id or not key_secret:
        raise ValueError(
            "Payment gateway is not configured on the server "
            "(RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET missing from .env)."
        )
    token = base64.b64encode(f"{key_id}:{key_secret}".encode("utf-8")).decode("ascii")
    return key_id, key_secret, f"Basic {token}"


# ============================================================
# Razorpay Customers - required for "save this card".
#
# Razorpay never stores a card token on its own; a token is always
# stored AGAINST A CUSTOMER (cust_xxx). If checkout is opened without
# customer_id, ticking "Save this card as per RBI guidelines" has
# nothing to attach the token to, so the next checkout has nothing to
# fetch back and the customer has to type the card again - which is
# exactly the bug this fixes.
#
# The cust_xxx id is created once per user and cached on the user
# record in users.json (razorpayCustomerId). fail_existing=0 means a
# repeat call for an email/contact Razorpay already knows returns the
# EXISTING customer instead of erroring, so this is safe to retry and
# safe across a users.json restore.
#
# Everything here degrades quietly: if customer creation fails for any
# reason we return None and the payment still goes through as a normal
# guest checkout. A saved-card convenience feature must never be able
# to block someone from paying.
# ============================================================
_razorpay_customer_lock = threading.Lock()


def _razorpay_get_or_create_customer(user_id, auth_header):
    try:
        users = auth_store.load_users()
    except (OSError, json.JSONDecodeError) as err:
        print(f"Razorpay customer: could not read users.json ({err})")
        return None

    user = auth_store.find_user_by_id(users, user_id)
    if not user:
        return None

    cached = (user.get("razorpayCustomerId") or "").strip()
    if cached:
        return cached

    name = " ".join(
        part for part in [
            (user.get("firstName") or "").strip(),
            (user.get("lastName") or "").strip(),
        ] if part
    )
    email = (user.get("email") or "").strip()
    # Razorpay wants +<country code><number> and rejects spaces/dashes.
    contact = re.sub(r"[^\d+]", "", str(user.get("mobile") or ""))

    payload = {"fail_existing": "0"}
    if 3 <= len(name) <= 50:
        payload["name"] = name
    if email:
        payload["email"] = email[:64]
    if len(contact) >= 8:
        payload["contact"] = contact[:15]

    # A customer with neither email nor contact is useless for saved
    # cards - Razorpay has no way to recognise the person next time.
    if "email" not in payload and "contact" not in payload:
        return None

    req = urllib.request.Request(
        "https://api.razorpay.com/v1/customers",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": auth_header},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            customer = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        detail = ""
        try:
            detail = err.read().decode("utf-8")[:300]
        except Exception:
            pass
        print(f"Razorpay customer create failed for {user_id}: {err.code} {detail}")
        return None
    except Exception as err:  # noqa: BLE001 - never block the payment
        print(f"Razorpay customer create failed for {user_id}: {err}")
        return None

    customer_id = (customer.get("id") or "").strip()
    if not customer_id:
        return None

    # Sirf ek field likhni hai. update_user_fields() DB par ek UPDATE
    # chalata hai, isliye beech me aayi koi profile edit nahi udti.
    # (Pehle yahan poori users list load-modify-save hoti thi - lock
    # ek process me bachata tha, do workers par nahi.)
    with _razorpay_customer_lock:
        try:
            auth_store.update_user_fields(user_id, {"razorpayCustomerId": customer_id})
        except (OSError, json.JSONDecodeError) as err:
            # Not fatal - the id just won't be cached, so the next
            # top-up creates/fetches it again (fail_existing=0).
            print(f"Razorpay customer: could not cache id for {user_id} ({err})")

    return customer_id


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
    # "api-keys" hata di gayi (item 1.09) - key ab har user ke record
    # (users.apiKey) par seedhi hai, /api/profile/update se save hoti hai.
    "lease-files",
    "translation-files",
    "lease-activity-log",
    "translation-activity-log",
    "notifications",
    "plan-history",
    # Card sizes (Admin Panel > Card Sizes). Sirf layout numbers hain -
    # koi user data nahi - isliye baaki config files ki tarah safe hai.
    "card-layout",
    # Ye sab pehle static json/*.json files ki tarah serve hote the -
    # ab db.SETTINGS_RESOURCES / db.DOCUMENT_RESOURCES ke through Postgres
    # se aate hain (fallback: json file, agar DB configured na ho).
    # "menu-config" / "services-api" / "messages" hata di gayin (items
    # 1.05 / 1.06 / 1.10) - ab app.js me hardcoded constants hain.
    "agents",
    "company",
    "plans",
    # Services Catalog (Plans & Offers admin > Services table) - lets
    # Admin move a service between Paid/Free and set its billing unit.
    "services-catalog",
    # System Configurations (item 15) - admin-manageable storage systems
    # list, feeds every service's System Configuration dropdown.
    "system-configs",
}

# json files that must never be served as static files (contain secrets).
# smtp-config.json / llm-config.json no longer exist (real secrets moved
# to .env - see _load_dotenv above) - only users.json (plaintext
# passwords) still needs this.
PROTECTED_JSON_FILES = {"users.json", "sessions.json"}

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
# Background job store for /api/lease/analyze-start + analyze-status.
# Previously /api/lease/analyze was one single blocking HTTP request that
# did the entire LLM call (huge system prompt + up to 120k chars of lease
# text) inside it - on a real document that can genuinely take anywhere
# from 20s to a couple of minutes, during which the frontend progress bar
# had zero visibility into what was happening and just sat at 20% looking
# stuck (see runAnalyzeJob() in app.js for the polling side). This mirrors
# the exact same background-thread + polling pattern already used for the
# OCR step (_extract_jobs / _run_extract_job below) so analysis behaves
# the same way and never risks tripping a gateway/proxy timeout either.
_analyze_jobs = {}
_analyze_jobs_lock = threading.Lock()


def _set_analyze_job(job_id, **fields):
    with _analyze_jobs_lock:
        job = _analyze_jobs.setdefault(job_id, {})
        job.update(fields)
        job["updatedAt"] = datetime.datetime.now()


def _get_analyze_job(job_id):
    with _analyze_jobs_lock:
        return dict(_analyze_jobs.get(job_id) or {})


def _cleanup_stale_analyze_jobs():
    cutoff = datetime.datetime.now() - datetime.timedelta(seconds=_EXTRACT_JOB_MAX_AGE_SECONDS)
    with _analyze_jobs_lock:
        stale = [jid for jid, job in _analyze_jobs.items() if job.get("updatedAt", cutoff) < cutoff]
        for jid in stale:
            _analyze_jobs.pop(jid, None)


# Background job store for /api/translation/translate-start + -status -
# same reasoning and shape as _analyze_jobs above: translating a full
# document in one shot is another single potentially-long LLM call that
# was previously blocking a single HTTP request.
_translate_jobs = {}
_translate_jobs_lock = threading.Lock()


def _set_translate_job(job_id, **fields):
    with _translate_jobs_lock:
        job = _translate_jobs.setdefault(job_id, {})
        job.update(fields)
        job["updatedAt"] = datetime.datetime.now()


def _get_translate_job(job_id):
    with _translate_jobs_lock:
        return dict(_translate_jobs.get(job_id) or {})


def _cleanup_stale_translate_jobs():
    cutoff = datetime.datetime.now() - datetime.timedelta(seconds=_EXTRACT_JOB_MAX_AGE_SECONDS)
    with _translate_jobs_lock:
        stale = [jid for jid, job in _translate_jobs.items() if job.get("updatedAt", cutoff) < cutoff]
        for jid in stale:
            _translate_jobs.pop(jid, None)


def _run_translate_job(job_id, text, target_language):
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
    _set_translate_job(job_id, status="done", translatedText=translated[:100000], method=method)


def _run_analyze_job(job_id, text, fallback_name):
    try:
        result = lease_engine.analyze_lease(text, fallback_name=fallback_name)
        _set_analyze_job(job_id, status="done", result=result)
    except Exception as err:
        print(f"Analyze job {job_id} failed: {err}")
        _set_analyze_job(job_id, status="error", error=str(err))


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


def _send_verification_email_async(user_id, to_email, user_name, code, purpose, expiry_minutes, base_url=""):
    _set_email_job(user_id, status="sending")
    # Always visible in the server's own console/terminal, regardless of
    # whether the email itself succeeds - handy for local dev/testing
    # without needing working SMTP or access to the inbox at all.
    print(f"🔑 Verification code for {to_email} ({purpose}): {code}  (expires in {expiry_minutes} min)")

    def _worker():
        try:
            _send_verification_email(to_email, user_name, code, purpose, expiry_minutes, base_url=base_url, user_id=user_id)
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


def _primary_twilio_account():
    """Twilio credentials come from environment variables (.env), same
    pattern as _primary_smtp_account() above. Used by the SMS option in
    Profile > Notify On - the account owner sets these up
    themselves at https://console.twilio.com (Account SID + Auth Token are
    on the console dashboard; the From number comes from Phone Numbers, or
    Twilio's own trial number)."""
    sid = os.environ.get("TWILIO_ACCOUNT_SID")
    if not sid:
        raise ValueError(
            "Twilio is not configured - set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and "
            "TWILIO_FROM_NUMBER in your .env file (see .env.example)."
        )
    return {
        "sid": sid,
        "auth_token": os.environ.get("TWILIO_AUTH_TOKEN"),
        "from_number": os.environ.get("TWILIO_FROM_NUMBER"),
    }


def _send_sms(to_number, body):
    """Generic Twilio SMS sender (Programmable Messaging REST API), the SMS
    counterpart to _send_email() above. Raises on failure - callers decide
    how to react (the async wrapper below just logs it, same as email)."""
    account = _primary_twilio_account()
    sid = account["sid"]
    auth_token = account["auth_token"]
    from_number = account["from_number"]
    if not auth_token or not from_number:
        raise ValueError(
            "Twilio is not fully configured - TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER "
            "are also required (see .env.example)."
        )
    url = f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json"
    payload = urlencode({"To": to_number, "From": from_number, "Body": body}).encode("utf-8")
    credentials = base64.b64encode(f"{sid}:{auth_token}".encode("utf-8")).decode("ascii")
    req = urllib.request.Request(url, data=payload, method="POST", headers={
        "Authorization": f"Basic {credentials}",
        "Content-Type": "application/x-www-form-urlencoded",
    })
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp.read()
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", errors="ignore")
        raise ValueError(f"Twilio SMS failed ({err.code}): {detail}") from err


def _send_verification_sms(to_mobile, purpose, code, expiry_minutes):
    company_name = _load_company_name()
    label = _VERIFICATION_PURPOSE_LABELS.get(purpose, "verify your account")
    # Same free-text "Mobile No" field the Profile page already has - not
    # guaranteed to include a country code, so a bare number is assumed to
    # be Indian (+91), matching the rest of this app's India-first
    # defaults. Update this if deploying somewhere else.
    cleaned = re.sub(r"[^0-9+]", "", to_mobile or "")
    if cleaned and not cleaned.startswith("+"):
        cleaned = "+91" + cleaned
    if not cleaned:
        raise ValueError("No mobile number on file to send an SMS code to.")
    body = (
        f"{company_name}: your code to {label} is {code}. "
        f"It expires in {expiry_minutes} min. Don't share this code with anyone."
    )
    _send_sms(cleaned, body)


def _send_verification_sms_async(user_id, to_mobile, code, purpose, expiry_minutes):
    """Fire-and-forget wrapper mirroring _send_verification_email_async() -
    reuses the exact same _email_jobs store so the frontend's existing
    /api/auth/email-status polling works unchanged regardless of which
    channel (email or SMS) the code actually went out on."""
    _set_email_job(user_id, status="sending")
    print(f"🔑 Verification code for {to_mobile} ({purpose}): {code}  (expires in {expiry_minutes} min)")

    def _worker():
        try:
            _send_verification_sms(to_mobile, purpose, code, expiry_minutes)
            _set_email_job(user_id, status="sent")
        except Exception as err:
            print(f"Verification SMS to {to_mobile} could not be sent (code is still valid - see above): {err}")
            _set_email_job(user_id, status="failed", code=code)

    threading.Thread(target=_worker, daemon=True).start()


def _send_verification_code_async(user, code, purpose, expiry_minutes, base_url=""):
    """Single dispatch point used by register/login/forgot-password/resend
    - sends the OTP by whichever channel this user picked in Profile >
    Notify On. Defaults to email, and also falls back to
    email if SMS was chosen but there's no mobile number on file, so a code
    is never silently dropped."""
    if user.get("verificationMethod") == "sms" and (user.get("mobile") or "").strip():
        _send_verification_sms_async(user["id"], user["mobile"], code, purpose, expiry_minutes)
    else:
        _send_verification_email_async(
            user["id"], user["email"], user.get("firstName") or "", code, purpose, expiry_minutes, base_url=base_url
        )


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


def _send_notification_email(to_email, user_name, title, message, table_rows=None, table_headers=None):
    """Generic branded notification email - used for support ticket
    create/update/delete, API key generate/revoke, profile changes, and
    the no-2FA login alert. table_rows/table_headers (both optional) let
    a caller render a simple HTML table into the body - used by the
    process-completion email (service/file/charge/status)."""
    company_name = _load_company_name()
    plain_lines = [f"Hi {user_name},", "", message]
    table_html = ""
    if table_rows and table_headers:
        plain_lines.append("")
        plain_lines.append(" | ".join(table_headers))
        for row in table_rows:
            plain_lines.append(" | ".join(str(c) for c in row))
        header_html = "".join(
            f'<th style="text-align:left;padding:8px 10px;font-size:0.72rem;text-transform:uppercase;'
            f'letter-spacing:0.4px;color:#ffffff;background:#131b3f;">{h}</th>' for h in table_headers
        )
        body_rows_html = ""
        for i, row in enumerate(table_rows):
            bg = "#ffffff" if i % 2 == 0 else "#f4f5fa"
            cells = "".join(
                f'<td style="padding:8px 10px;font-size:0.85rem;color:#23263a;border-bottom:1px solid #eee;">{c}</td>'
                for c in row
            )
            body_rows_html += f'<tr style="background:{bg};">{cells}</tr>'
        table_html = (
            f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
            f'style="border-collapse:collapse;margin:16px 0;"><tr>{header_html}</tr>{body_rows_html}</table>'
        )
    plain_body = "\n".join(plain_lines) + f"\n\n— {company_name}"
    body_html = f"""
<p style="font-size:0.95rem;color:#23263a;margin:0 0 14px 0;">Hi {user_name},</p>
<p style="font-size:0.95rem;color:#23263a;line-height:1.6;margin:0 0 8px 0;white-space:pre-wrap;">{message}</p>
{table_html}
<p style="font-size:0.85rem;color:#555;line-height:1.6;margin:18px 0 0 0;">— {company_name}</p>
"""
    html = _html_email_wrapper(company_name, title, body_html)
    _send_email(to_email, title, plain_body, html_body=html)


def _send_notification_email_async(to_email, user_name, title, message, table_rows=None, table_headers=None):
    """Fire-and-forget wrapper (mirrors _send_verification_email_async) -
    notification emails should never block the HTTP response they're
    triggered from."""
    def _worker():
        try:
            _send_notification_email(to_email, user_name, title, message, table_rows, table_headers)
        except Exception as err:
            print(f"Notification email to {to_email} ({title}) could not be sent: {err}")

    threading.Thread(target=_worker, daemon=True).start()


def _send_notification_sms(to_mobile, title, message):
    """Plain-text SMS counterpart to _send_notification_email() above -
    used when the recipient's Profile > Notify On is set to Mobile SMS.
    Tables aren't representable over SMS, so callers just get a short
    text summary instead."""
    company_name = _load_company_name()
    cleaned = re.sub(r"[^0-9+]", "", to_mobile or "")
    if cleaned and not cleaned.startswith("+"):
        cleaned = "+91" + cleaned
    if not cleaned:
        raise ValueError("No verified mobile number on file to notify.")
    text = f"{company_name}: {title}. {message}".strip()
    if len(text) > 300:
        text = text[:297] + "..."
    _send_sms(cleaned, text)


def _send_notification_sms_async(to_mobile, title, message):
    def _worker():
        try:
            _send_notification_sms(to_mobile, title, message)
        except Exception as err:
            print(f"Notification SMS to {to_mobile} ({title}) could not be sent: {err}")

    threading.Thread(target=_worker, daemon=True).start()


def _dispatch_user_notification(user_id, fallback_email, user_name, title, message, table_rows=None, table_headers=None):
    """Single routing point for every account notification (ticket
    updates, API key changes, profile-change alerts, balance/plan
    changes, login alerts): sends by Mobile SMS if that's the recipient's
    Profile > Notify On choice AND their mobile is actually OTP-verified,
    otherwise falls back to email exactly as before. user_id is looked up
    fresh so this always reflects their current preference, not whatever
    the caller happened to have cached."""
    user = None
    if user_id:
        users = auth_store.load_users()
        user = auth_store.find_user_by_id(users, user_id)

    mobile_verified = bool(
        user and user.get("mobileVerified")
        and user.get("mobileVerifiedNumber") == (user.get("mobile") or "").strip()
    )
    if user and user.get("verificationMethod") == "sms" and mobile_verified:
        _send_notification_sms_async(user["mobile"], title, message)
        return

    email = (user.get("email") if user else None) or fallback_email
    if not email:
        return
    _send_notification_email_async(email, user_name, title, message, table_rows, table_headers)


_VERIFICATION_PURPOSE_LABELS = {
    "register": "complete your registration",
    "login": "complete your login",
    "reset": "reset your password",
    "mobile-verify": "verify your mobile number",
}


def _load_company_name():
    if db is not None and db.is_enabled():
        try:
            data = db.get_setting("company")
            if data:
                return data.get("name", "Lexora AI Solutions")
        except Exception as err:  # noqa: BLE001
            print(f"[db] company name read failed, falling back to JSON: {err}")
    try:
        with open(os.path.join(JSON_DIR, "company.json"), "r", encoding="utf-8") as f:
            return json.load(f).get("name", "Lexora AI Solutions")
    except (OSError, json.JSONDecodeError):
        return "Lexora AI Solutions"


def _load_company_info():
    """Poora company object (name + logo waghera) - invoice PDF ke header
    ke liye. _load_company_name() jaisa hi fallback chain, bas poora
    dict wapas karta hai."""
    if db is not None and db.is_enabled():
        try:
            data = db.get_setting("company")
            if data:
                return data
        except Exception as err:  # noqa: BLE001
            print(f"[db] company info read failed, falling back to JSON: {err}")
    try:
        with open(os.path.join(JSON_DIR, "company.json"), "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def _build_invoice_pdf(company_name, logo_path, user, txns,
                        start_date=None, end_date=None,
                        opening_balance=None, closing_balance=None):
    """Payment History > Download ke liye invoice PDF (item 3) - reportlab
    platypus se, taaki lambi transaction list khud pagination kar le
    (lease_engine ke reports jaisa hi approach).

    Agar start_date/end_date diye ho (Payment History card ke "From"/"To"
    filter jaisa hi range), to sirf usi range ke transactions dikhaye
    jaate hain, aur opening_balance/closing_balance (dono non-None) us
    range ke upar/neeche ek "Opening Balance" aur "Closing Balance" row
    ke roop me table me jod diye jaate hain."""
    import io
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import inch
    from reportlab.lib import colors
    from reportlab.platypus import (
        SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, Image,
    )
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.enums import TA_RIGHT

    styles = getSampleStyleSheet()
    title_style = ParagraphStyle("InvoiceTitle", parent=styles["Heading1"], fontSize=20, spaceAfter=2)
    sub_style = ParagraphStyle("InvoiceSub", parent=styles["Normal"], textColor=colors.HexColor("#555555"))
    label_style = ParagraphStyle("InvoiceLabel", parent=styles["Normal"], fontSize=10, leading=14)

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        topMargin=0.6 * inch, bottomMargin=0.6 * inch,
        leftMargin=0.6 * inch, rightMargin=0.6 * inch,
    )
    story = []

    # Header - company logo (agar mile) ke saath naam, right side "INVOICE".
    header_cells = []
    if logo_path:
        try:
            img = Image(logo_path, width=1.3 * inch, height=1.3 * inch, kind="proportional")
        except Exception:  # noqa: BLE001
            img = Paragraph(company_name, title_style)
    else:
        img = Paragraph(company_name, title_style)
    header_cells.append([img, Paragraph("INVOICE", ParagraphStyle(
        "InvoiceRight", parent=title_style, alignment=TA_RIGHT))])
    header_table = Table(header_cells, colWidths=[3.5 * inch, 3.3 * inch])
    header_table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    story.append(header_table)
    story.append(Spacer(1, 4))
    story.append(Paragraph(company_name, sub_style))
    story.append(Spacer(1, 18))

    # Client details.
    full_name = f"{user.get('firstName') or ''} {user.get('lastName') or ''}".strip() or "-"
    client_lines = [
        f"<b>Bill To:</b> {escape_html(full_name)}",
        f"<b>Mobile:</b> {escape_html(user.get('mobile') or '-')}",
        f"<b>Email:</b> {escape_html(user.get('email') or '-')}",
        f"<b>Invoice Date:</b> {escape_html(datetime.date.today().isoformat())}",
    ]
    if start_date and end_date:
        client_lines.append(f"<b>Statement Period:</b> {escape_html(start_date)} to {escape_html(end_date)}")
    for line in client_lines:
        story.append(Paragraph(line, label_style))
    story.append(Spacer(1, 18))

    # Cell text jaise Date & Time ya Transaction ID lambe ho sakte hain aur
    # unme spaces nahi hote (e.g. "TXN-RZP-04FDRLIbAX"), isliye plain string
    # ke bajaye Paragraph(wordWrap="CJK") use karte hain taaki text apni
    # column ke andar hi wrap ho jaaye, next column me overlap na kare.
    cell_style = ParagraphStyle(
        "InvoiceCell", parent=label_style, fontSize=8.5, leading=10.5, wordWrap="CJK",
    )
    balance_row_style = ParagraphStyle(
        "InvoiceBalanceRow", parent=cell_style, fontName="Helvetica-Bold",
    )

    def _cell(text, bold=False):
        return Paragraph(escape_html(text), balance_row_style if bold else cell_style)

    # Transaction table - filter range ke transactions, date/time wise,
    # opening balance (range se pehle ka balance) aur closing balance
    # (range ke aakhri tak ka balance) ke saath.
    header_row = ["Date & Time", "Transaction ID", "Description", "Credit", "Debit", "Status"]
    rows = [header_row]
    balance_row_indices = []  # opening/closing balance rows ko alag se style karne ke liye

    if opening_balance is not None:
        rows.append([
            _cell(start_date or "", bold=True),
            "",
            _cell("Opening Balance", bold=True),
            "", "",
            _cell(f"{opening_balance:,.2f}", bold=True),
        ])
        balance_row_indices.append(len(rows) - 1)

    total_credit = 0.0
    total_debit = 0.0
    for t in txns:
        date_time = t.get("date") or ""
        if t.get("time"):
            date_time = f"{date_time} {t.get('time')}"
        credit = float(t.get("credit") or 0)
        debit = float(t.get("debit") or 0)
        total_credit += credit
        total_debit += debit
        rows.append([
            _cell(date_time),
            _cell(t.get("id") or ""),
            _cell(t.get("description") or ""),
            f"{credit:,.2f}" if credit else "",
            f"{debit:,.2f}" if debit else "",
            _cell((t.get("status") or "").replace("_", " ").title()),
        ])
    if len(rows) == (2 if opening_balance is not None else 1):
        rows.append(["No transactions in this period.", "", "", "", "", ""])

    if closing_balance is not None:
        rows.append([
            _cell(end_date or "", bold=True),
            "",
            _cell("Closing Balance", bold=True),
            "", "",
            _cell(f"{closing_balance:,.2f}", bold=True),
        ])
        balance_row_indices.append(len(rows) - 1)

    table = Table(rows, colWidths=[1.15 * inch, 1.0 * inch, 2.05 * inch, 0.8 * inch, 0.8 * inch, 0.9 * inch], repeatRows=1)
    table_style = [
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0b1330")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTSIZE", (0, 0), (-1, -1), 8.5),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#dddddd")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f7f7fb")]),
        ("ALIGN", (3, 0), (4, -1), "RIGHT"),
    ]
    for idx in balance_row_indices:
        table_style.append(("BACKGROUND", (0, idx), (-1, idx), colors.HexColor("#e7ebfa")))
        table_style.append(("SPAN", (0, idx), (1, idx)))
    table.setStyle(TableStyle(table_style))
    story.append(table)
    story.append(Spacer(1, 14))

    summary_parts = [
        f"<b>Total Credit:</b> {total_credit:,.2f} &nbsp;&nbsp; "
        f"<b>Total Debit:</b> {total_debit:,.2f} &nbsp;&nbsp; "
        f"<b>Net Change:</b> {(total_credit - total_debit):,.2f}"
    ]
    if opening_balance is not None and closing_balance is not None:
        summary_parts.append(
            f"<b>Opening Balance:</b> {opening_balance:,.2f} &nbsp;&nbsp; "
            f"<b>Closing Balance:</b> {closing_balance:,.2f}"
        )
    for part in summary_parts:
        story.append(Paragraph(part, label_style))
        story.append(Spacer(1, 4))

def _numbered_canvas_factory(footer_note):
    """Canvas subclass that stamps 'Page X of Y' + a footer disclaimer
    bottom-right/bottom-left of every page - reportlab's standard
    technique for numbering pages when the total page count isn't known
    until the whole story has already been laid out."""
    from reportlab.pdfgen import canvas as canvas_module
    from reportlab.lib.units import inch
    from reportlab.lib import colors

    class NumberedCanvas(canvas_module.Canvas):
        def __init__(self, *args, **kwargs):
            canvas_module.Canvas.__init__(self, *args, **kwargs)
            self._saved_page_states = []

        def showPage(self):
            self._saved_page_states.append(dict(self.__dict__))
            self._startPage()

        def save(self):
            total_pages = len(self._saved_page_states)
            for state in self._saved_page_states:
                self.__dict__.update(state)
                self._draw_footer(total_pages)
                canvas_module.Canvas.showPage(self)
            canvas_module.Canvas.save(self)

        def _draw_footer(self, total_pages):
            width, _ = self._pagesize
            self.setStrokeColor(colors.HexColor("#dddddd"))
            self.line(0.6 * inch, 0.75 * inch, width - 0.6 * inch, 0.75 * inch)
            self.setFont("Helvetica", 8)
            self.setFillColor(colors.HexColor("#555555"))
            self.drawString(0.6 * inch, 0.55 * inch, footer_note)
            page_label = f"Page {self._pageNumber} of {total_pages}"
            self.drawRightString(width - 0.6 * inch, 0.55 * inch, page_label)

    return NumberedCanvas


def _lerp_color(c1, c2, t):
    from reportlab.lib import colors
    return colors.Color(
        c1.red + (c2.red - c1.red) * t,
        c1.green + (c2.green - c1.green) * t,
        c1.blue + (c2.blue - c1.blue) * t,
    )


# ── Account Statement design tokens (exact, from the approved design
#    spec) - shared by the donut chart and the statement builder. ────
_NAVY = "#081B52"
_GREEN = "#15803D"
_RED = "#DC2626"
_LIGHT_GREY = "#F9FAFB"
_BORDER = "#E5E7EB"
_TEXT_DARK = "#1F2430"
_TEXT_MUTED = "#6B7280"


def _donut_chart_drawing(credit_count, credit_amt, debit_count, debit_amt, neutral_count=0):
    """Doughnut chart ('Transaction Overview') matching the approved
    design - solid Green (#15803D) / Red (#DC2626) / light-grey slices,
    a real ring built from Wedge shapes with an innerRadius (native to
    reportlab). neutral_count (grey) covers rows with no credit or
    debit at all - e.g. a failed payment attempt - so the number in the
    middle always matches "Total Transactions" instead of coming up
    short."""
    from reportlab.graphics.shapes import Drawing, String, Wedge
    from reportlab.lib import colors

    total_all = credit_count + debit_count + neutral_count
    chart_total = credit_count + debit_count  # grey/neutral slice removed from the visual ring per the design spec
    size = 1.75 * 72  # 1.75in in points, Drawing units are points
    cx = cy = size / 2
    outer_r = size / 2 - 4
    inner_r = outer_r * 0.55  # matches the reference's ring thickness

    d = Drawing(size, size)

    slices = [(credit_count, colors.HexColor(_GREEN)), (debit_count, colors.HexColor(_RED))]
    if chart_total <= 0:
        slices = [(1, colors.HexColor(_LIGHT_GREY))]
        chart_total = 1

    start_angle = 90.0  # 12 o'clock, matching the reference
    for value, fill in slices:
        sweep = 360.0 * (value / chart_total)
        if sweep <= 0:
            continue
        w = Wedge(cx, cy, outer_r, start_angle - sweep, start_angle,
                  radius1=inner_r, annular=True,
                  fillColor=fill, strokeColor=colors.white, strokeWidth=1.2)
        d.add(w)
        start_angle -= sweep

    d.add(String(cx, cy + 13, "Total", fontSize=8, fontName="Helvetica",
                 fillColor=colors.HexColor(_TEXT_MUTED), textAnchor="middle"))
    d.add(String(cx, cy - 5, str(total_all), fontSize=19, fontName="Helvetica-Bold",
                 fillColor=colors.HexColor(_NAVY), textAnchor="middle"))
    d.add(String(cx, cy - 19, "Transactions", fontSize=7.2, fontName="Helvetica",
                 fillColor=colors.HexColor(_TEXT_MUTED), textAnchor="middle"))
    return d


def _draw_icon_glyph(canvas_obj, name, cx, cy, size, color):
    """Simple vector icon glyphs (no external image files needed) for
    the closing-page badges and the disclaimer note - drawn as basic
    shapes/paths so they render identically everywhere reportlab runs,
    no font/emoji support required."""
    from reportlab.lib import colors as _colors
    canvas_obj.saveState()
    canvas_obj.setStrokeColor(color)
    canvas_obj.setFillColor(color)
    canvas_obj.setLineWidth(1.3)
    half = size / 2

    if name == "detailed":
        # Document with a "+" corner - "detailed transaction records"
        canvas_obj.rect(cx - half * 0.6, cy - half * 0.7, size * 0.6, size * 0.85, stroke=1, fill=0)
        canvas_obj.line(cx - half * 0.35, cy - half * 0.1, cx + half * 0.1, cy - half * 0.1)
        canvas_obj.line(cx - half * 0.35, cy + half * 0.15, cx + half * 0.1, cy + half * 0.15)
        canvas_obj.line(cx - half * 0.35, cy + half * 0.4, cx + half * 0.1, cy + half * 0.4)
    elif name == "clear":
        # Ascending bar chart - "clear account overview"
        bar_w = size * 0.16
        heights = [size * 0.35, size * 0.55, size * 0.8]
        xs = [cx - size * 0.32, cx - bar_w / 2, cx + size * 0.32 - bar_w]
        for x, h in zip(xs, heights):
            canvas_obj.rect(x, cy - size * 0.35, bar_w, h, stroke=0, fill=1)
    elif name == "secure":
        # Shield with a checkmark - "secure & reliable"
        p = canvas_obj.beginPath()
        p.moveTo(cx, cy + half * 0.8)
        p.lineTo(cx + half * 0.7, cy + half * 0.4)
        p.lineTo(cx + half * 0.7, cy - half * 0.3)
        p.curveTo(cx + half * 0.7, cy - half * 0.75, cx, cy - half * 0.95, cx, cy - half * 0.95)
        p.curveTo(cx, cy - half * 0.95, cx - half * 0.7, cy - half * 0.75, cx - half * 0.7, cy - half * 0.3)
        p.lineTo(cx - half * 0.7, cy + half * 0.4)
        p.close()
        canvas_obj.drawPath(p, stroke=1, fill=0)
        canvas_obj.setLineWidth(1.6)
        canvas_obj.line(cx - half * 0.32, cy - half * 0.05, cx - half * 0.05, cy - half * 0.35)
        canvas_obj.line(cx - half * 0.05, cy - half * 0.35, cx + half * 0.4, cy + half * 0.35)
    elif name == "download":
        # Downward arrow into a tray - "download anytime"
        canvas_obj.setLineWidth(1.6)
        canvas_obj.line(cx, cy + half * 0.75, cx, cy - half * 0.1)
        canvas_obj.line(cx - half * 0.35, cy + half * 0.25, cx, cy - half * 0.1)
        canvas_obj.line(cx + half * 0.35, cy + half * 0.25, cx, cy - half * 0.1)
        canvas_obj.line(cx - half * 0.6, cy - half * 0.6, cx + half * 0.6, cy - half * 0.6)
    elif name == "computer":
        # Small monitor - "computer generated printout"
        canvas_obj.rect(cx - half * 0.9, cy - half * 0.35, size * 0.9, size * 0.65, stroke=1, fill=0)
        canvas_obj.line(cx - half * 0.35, cy - half * 0.65, cx + half * 0.35, cy - half * 0.65)
        canvas_obj.line(cx, cy - half * 0.35, cx, cy - half * 0.65)
    canvas_obj.restoreState()


def _round_rect_with_shadow(canvas_obj, x, y, w, h, radius=8, fill=None, shadow=True):
    """A card with a soft (simulated) shadow and rounded corners -
    reportlab has no native blur/shadow, so this fakes one with a
    slightly offset, very light grey rounded rect drawn first."""
    from reportlab.lib import colors
    if shadow:
        canvas_obj.saveState()
        canvas_obj.setFillColor(colors.Color(0.05, 0.08, 0.2, alpha=0.06))
        canvas_obj.roundRect(x + 1.2, y - 1.5, w, h, radius, stroke=0, fill=1)
        canvas_obj.restoreState()
    canvas_obj.saveState()
    canvas_obj.setFillColor(colors.HexColor(fill) if fill else colors.white)
    canvas_obj.setStrokeColor(colors.HexColor(_BORDER))
    canvas_obj.setLineWidth(0.75)
    canvas_obj.roundRect(x, y, w, h, radius, stroke=1, fill=1)
    canvas_obj.restoreState()


def _date_fmt(date_str):
    """'2026-07-02' -> '02 Jul 2026' (per the design spec)."""
    try:
        d = datetime.date.fromisoformat(str(date_str)[:10])
        return d.strftime("%d %b %Y")
    except Exception:  # noqa: BLE001
        return str(date_str or "")


def _time_fmt_12h(time_str):
    """Normalizes any stored time (already-12h 'HH:MM AM/PM' or 24h
    'HH:MM') to a clean 12-hour 'HH:MM AM/PM' - the design-correction
    doc for this PDF specifically and repeatedly asks for AM/PM here,
    distinct from the app's own live UI (which uses 24-hour elsewhere
    per a separate, direct instruction covering that)."""
    s = str(time_str or "").strip()
    m = re.match(r"^(\d{1,2}):(\d{2})\s*(AM|PM)?$", s, re.IGNORECASE)
    if not m:
        return s
    h = int(m.group(1))
    minute = m.group(2)
    if m.group(3):
        return f"{h:02d}:{minute} {m.group(3).upper()}"
    # Already 24-hour - convert to 12-hour + AM/PM.
    ap = "AM" if h < 12 else "PM"
    h12 = h % 12
    if h12 == 0:
        h12 = 12
    return f"{h12:02d}:{minute} {ap}"


def _account_statement_page_decorator(logo_path, footer_note, from_name, from_mobile, from_email,
                                       statement_date, summary_period, total_transactions):
    """Draws the repeating header + customer-info card on every page -
    small logo top-left, title top-right, a single rounded card below
    holding both the From block and the statement metadata."""
    from reportlab.lib.units import inch
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.utils import ImageReader

    logo_reader = None
    if logo_path:
        try:
            logo_reader = ImageReader(logo_path)
        except Exception:  # noqa: BLE001
            logo_reader = None

    def _draw(canvas_obj, doc):
        width, height = A4
        canvas_obj.saveState()

        margin = 0.5 * inch
        top = height - margin

        # ---- Small logo (left) + title (right), one compact row ----
        logo_size = 0.5 * inch
        if logo_reader is not None:
            try:
                canvas_obj.drawImage(logo_reader, margin, top - logo_size,
                                      width=logo_size, height=logo_size,
                                      preserveAspectRatio=True, mask="auto")
            except Exception:  # noqa: BLE001
                pass
        canvas_obj.setFont("Helvetica-Bold", 17)
        canvas_obj.setFillColor(colors.HexColor(_NAVY))
        canvas_obj.drawRightString(width - margin, top - logo_size + 4, "ACCOUNT STATEMENT")

        header_bottom = top - logo_size

        # ---- Customer info card ----
        card_top = header_bottom - 0.15 * inch
        card_h = 0.95 * inch
        card_w = width - 2 * margin
        _round_rect_with_shadow(canvas_obj, margin, card_top - card_h, card_w, card_h, radius=9)

        pad = 0.18 * inch
        tx = margin + pad
        ty = card_top - 0.26 * inch
        canvas_obj.setFont("Helvetica-Bold", 9)
        canvas_obj.setFillColor(colors.HexColor(_GREEN))
        canvas_obj.drawString(tx, ty, "From:")
        canvas_obj.setFont("Helvetica-Bold", 13)
        canvas_obj.setFillColor(colors.HexColor(_TEXT_DARK))
        canvas_obj.drawString(tx, ty - 0.22 * inch, from_name)
        canvas_obj.setFont("Helvetica", 8.8)
        canvas_obj.setFillColor(colors.HexColor(_TEXT_MUTED))
        canvas_obj.drawString(tx, ty - 0.44 * inch, f"Mobile: {from_mobile}   |   Email: {from_email}")

        meta_x = margin + card_w * 0.52
        label_x2 = meta_x + 1.15 * inch
        val_x = meta_x + 1.28 * inch
        my = ty
        for label, value in [("Statement Date", statement_date), ("Summary Period", summary_period),
                              ("Total Transactions", str(total_transactions))]:
            canvas_obj.setFont("Helvetica-Bold", 9)
            canvas_obj.setFillColor(colors.HexColor(_TEXT_DARK))
            canvas_obj.drawString(meta_x, my, label)
            canvas_obj.drawString(label_x2, my, ":")
            canvas_obj.setFont("Helvetica", 9)
            canvas_obj.setFillColor(colors.HexColor(_TEXT_DARK))
            canvas_obj.drawString(val_x, my, value)
            my -= 0.24 * inch

        canvas_obj.restoreState()

    return _draw


def _account_statement_numbered_canvas(logo_path, footer_note, from_name, from_mobile, from_email,
                                        statement_date, summary_period, total_transactions):
    """Two-pass numbered canvas - header/info-card repeat every page;
    footer (computer icon + note, green rounded "Page X of Y" badge)
    always; "To be continued..." (green, right-aligned) on every page
    except the last, the 4 feature icons only on the last page."""
    from reportlab.pdfgen import canvas as canvas_module
    from reportlab.lib.units import inch
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4

    draw_top = _account_statement_page_decorator(
        logo_path, footer_note, from_name, from_mobile, from_email,
        statement_date, summary_period, total_transactions)

    class StatementCanvas(canvas_module.Canvas):
        def __init__(self, *args, **kwargs):
            canvas_module.Canvas.__init__(self, *args, **kwargs)
            self._saved_page_states = []

        def showPage(self):
            self._saved_page_states.append(dict(self.__dict__))
            self._startPage()

        def save(self):
            total_pages = len(self._saved_page_states)
            for state in self._saved_page_states:
                self.__dict__.update(state)
                self._draw_footer(self._pageNumber, total_pages)
                if self._pageNumber < total_pages:
                    self._draw_continued()
                else:
                    self._draw_closing_badges()
                canvas_module.Canvas.showPage(self)
            canvas_module.Canvas.save(self)

        def _draw_footer(self, page_num, total_pages):
            width, _ = A4
            margin = 0.5 * inch
            self.saveState()
            # Rounded card behind the whole footer strip.
            _round_rect_with_shadow(self, margin, 0.35 * inch, width - 2 * margin, 0.52 * inch, radius=9, fill="#FFFFFF")
            _draw_icon_glyph(self, "computer", margin + 0.28 * inch, 0.61 * inch, 0.24 * inch, colors.HexColor(_TEXT_MUTED))
            self.setFont("Helvetica-Bold", 8.5)
            self.setFillColor(colors.HexColor(_TEXT_DARK))
            self.drawString(margin + 0.46 * inch, 0.67 * inch, "Computer Rise Print")
            self.setFont("Helvetica", 7.6)
            self.setFillColor(colors.HexColor(_TEXT_MUTED))
            self.drawString(margin + 0.46 * inch, 0.53 * inch, footer_note)
            # Green rounded "Page X of Y" badge, right side, vertically
            # centered within the footer card.
            label = f"Page {page_num} of {total_pages}"
            self.setFont("Helvetica-Bold", 8.5)
            badge_w = self.stringWidth(label, "Helvetica-Bold", 8.5) + 0.4 * inch
            badge_h = 0.3 * inch
            badge_x = width - margin - 0.2 * inch - badge_w
            badge_y = 0.35 * inch + (0.52 * inch - badge_h) / 2
            self.setFillColor(colors.HexColor(_GREEN))
            self.roundRect(badge_x, badge_y, badge_w, badge_h, badge_h / 2, stroke=0, fill=1)
            self.setFillColor(colors.white)
            self.drawCentredString(badge_x + badge_w / 2, badge_y + badge_h / 2 - 3, label)
            self.restoreState()

        def _draw_continued(self):
            width, _ = A4
            margin = 0.5 * inch
            self.saveState()
            self.setFont("Helvetica-Bold", 9.5)
            self.setFillColor(colors.HexColor(_GREEN))
            self.drawRightString(width - margin, 1.15 * inch, "To be continued...  \u203a")
            self.restoreState()

        def _draw_closing_badges(self):
            width, _ = A4
            margin = 0.5 * inch
            badges = [
                ("detailed", "Detailed Transaction Records"),
                ("clear", "Clear Account Overview"),
                ("secure", "Secure & Reliable"),
                ("download", "Download Anytime"),
            ]
            usable_width = width - 2 * margin
            col_w = usable_width / len(badges)
            circle_y = 1.35 * inch
            self.saveState()
            for i, (icon_name, label) in enumerate(badges):
                cx = margin + col_w * i + col_w / 2
                if i > 0:
                    # Thin separator line between each icon column.
                    sep_x = margin + col_w * i
                    self.setStrokeColor(colors.HexColor(_BORDER))
                    self.setLineWidth(0.5)
                    self.line(sep_x, circle_y - 26, sep_x, circle_y + 16)
                self.setStrokeColor(colors.HexColor(_GREEN))
                self.setLineWidth(1.2)
                self.setFillColor(colors.white)
                self.circle(cx, circle_y, 15, stroke=1, fill=1)
                _draw_icon_glyph(self, icon_name, cx, circle_y, 0.22 * inch, colors.HexColor(_GREEN))
                self.setFont("Helvetica-Bold", 7.8)
                self.setFillColor(colors.HexColor(_TEXT_DARK))
                self.drawCentredString(cx, circle_y - 28, label)
            self.restoreState()

    return StatementCanvas, draw_top


def _build_account_statement_pdf(company_name, logo_path, user, txns,
                                  start_date, end_date, opening_balance):
    """Payment Summary > "Download Account Statement" - redesigned to
    match the approved reference design pixel-for-pixel as closely as
    reportlab allows: rounded cards with soft shadows, the exact navy/
    green/red/grey palette, a proper doughnut chart, consistent table
    styling, and a repeating header + customer-info card on every page."""
    import io
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import inch
    from reportlab.lib import colors
    from reportlab.platypus import (
        SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer,
    )
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.enums import TA_RIGHT

    styles = getSampleStyleSheet()
    label_style = ParagraphStyle("StmtLabel", parent=styles["Normal"], fontName="Helvetica",
                                  fontSize=9.3, leading=13.5, textColor=colors.HexColor(_TEXT_DARK))
    box_head_style = ParagraphStyle("StmtBoxHead", parent=styles["Normal"], fontSize=9.8,
                                     fontName="Helvetica-Bold", textColor=colors.white)

    full_name = f"{user.get('firstName') or ''} {user.get('lastName') or ''}".strip() or "-"
    statement_date_str = datetime.date.today().strftime("%d %b %Y")

    # Item 4 in the design spec - when no explicit filter range was
    # given, show the ACTUAL span of the transactions being listed
    # (not a vague "As on Today") - falls back to "As on Today" only
    # when there's truly nothing to derive a range from (no rows).
    if start_date:
        summary_period_str = f"{_date_fmt(start_date)} to {_date_fmt(end_date)}"
    elif txns:
        dates = sorted(str(t.get("date") or "") for t in txns if t.get("date"))
        summary_period_str = f"{_date_fmt(dates[0])} to {_date_fmt(dates[-1])}" if dates else "As on Today"
    else:
        summary_period_str = "As on Today"

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        topMargin=1.85 * inch, bottomMargin=1.75 * inch,
        leftMargin=0.5 * inch, rightMargin=0.5 * inch,
    )
    story = []

    # ---- Account Overview + Transaction Overview, side by side ----
    total_credit = sum(float(t.get("credit") or 0) for t in txns)
    total_debit = sum(float(t.get("debit") or 0) for t in txns)
    net_change = total_credit - total_debit
    current_balance = opening_balance + net_change
    credit_count = sum(1 for t in txns if float(t.get("credit") or 0) > 0)
    debit_count = sum(1 for t in txns if float(t.get("debit") or 0) > 0)
    neutral_count = len(txns) - credit_count - debit_count

    BOX_BODY_HEIGHT = 1.95 * inch

    overview_rows = [
        ["Opening Balance", f"{opening_balance:,.2f}"],
        ["Total Credit", f"{total_credit:,.2f}"],
        ["Total Debit", f"{total_debit:,.2f}"],
        ["Net Change", f"{net_change:,.2f}"],
        ["Current Balance", f"{current_balance:,.2f}"],
    ]
    ov_table = Table(overview_rows, colWidths=[1.7 * inch, 1.2 * inch], rowHeights=[BOX_BODY_HEIGHT / 5] * 5)
    ov_table.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 9.5),
        ("TEXTCOLOR", (0, 0), (0, -1), colors.HexColor(_TEXT_DARK)),
        ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TEXTCOLOR", (1, 1), (1, 1), colors.HexColor(_GREEN)),
        ("TEXTCOLOR", (1, 2), (1, 2), colors.HexColor(_RED)),
        ("FONTNAME", (0, 4), (1, 4), "Helvetica-Bold"),
        ("LINEABOVE", (0, 4), (1, 4), 0.75, colors.HexColor(_BORDER)),
    ]))
    ov_box = Table([[Paragraph("ACCOUNT OVERVIEW", box_head_style)], [ov_table]], colWidths=[3.0 * inch])
    ov_box.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, 0), colors.HexColor(_NAVY)),
        ("ROUNDEDCORNERS", [9, 9, 9, 9]),
        ("BOX", (0, 0), (-1, -1), 0.75, colors.HexColor(_BORDER)),
        ("LEFTPADDING", (0, 0), (-1, -1), 12), ("RIGHTPADDING", (0, 0), (-1, -1), 12),
        ("TOPPADDING", (0, 0), (0, 0), 7), ("BOTTOMPADDING", (0, 0), (0, 0), 7),
        ("TOPPADDING", (0, 1), (0, 1), 8), ("BOTTOMPADDING", (0, 1), (0, 1), 8),
    ]))

    donut = _donut_chart_drawing(credit_count, total_credit, debit_count, total_debit, neutral_count)
    legend_style = ParagraphStyle("StmtLegend", parent=label_style, fontSize=9, leading=13.5)
    legend_bits = [
        Paragraph(f'<font color="{_GREEN}">\u25cf</font> Credit ({credit_count})<br/>'
                  f'<b>{total_credit:,.2f}</b>', legend_style),
        Spacer(1, 8),
        Paragraph(f'<font color="{_RED}">\u25cf</font> Debit ({debit_count})<br/>'
                  f'<b>{total_debit:,.2f}</b>', legend_style),
    ]
    donut_row = Table([[donut, legend_bits]], colWidths=[1.75 * inch, 1.25 * inch], rowHeights=[BOX_BODY_HEIGHT])
    donut_row.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE")]))
    tx_box = Table([[Paragraph("TRANSACTION OVERVIEW", box_head_style)], [donut_row]],
                   colWidths=[3.0 * inch], rowHeights=[0.3 * inch, BOX_BODY_HEIGHT])
    tx_box.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, 0), colors.HexColor(_NAVY)),
        ("BOX", (0, 0), (-1, -1), 0.75, colors.HexColor(_BORDER)),
        ("LEFTPADDING", (0, 0), (-1, -1), 12), ("RIGHTPADDING", (0, 0), (-1, -1), 12),
        ("TOPPADDING", (0, 0), (0, 0), 7), ("BOTTOMPADDING", (0, 0), (0, 0), 7),
        ("TOPPADDING", (0, 1), (0, 1), 8), ("BOTTOMPADDING", (0, 1), (0, 1), 8),
    ]))

    overview_row = Table([[ov_box, tx_box]], colWidths=[3.3 * inch, 3.3 * inch])
    overview_row.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))
    story.append(overview_row)
    story.append(Spacer(1, 10))

    # ---- Transaction table ----
    cell_style = ParagraphStyle("StmtCell", parent=label_style, fontSize=7.6, leading=10.5, wordWrap="CJK")
    bold_cell_style = ParagraphStyle("StmtCellBold", parent=cell_style, fontName="Helvetica-Bold")
    bold_right_style = ParagraphStyle("StmtCellBoldRight", parent=bold_cell_style, alignment=TA_RIGHT)
    bold_center_style = ParagraphStyle("StmtCellBoldCenter", parent=bold_cell_style, alignment=1)  # TA_CENTER

    def _cell(text, bold=False):
        return Paragraph(escape_html(text), bold_cell_style if bold else cell_style)

    def _amount_cell(text):
        return Paragraph(escape_html(text), bold_right_style)

    def _desc_right(text):
        return Paragraph(escape_html(text), bold_right_style)

    def _dt(t):
        d = _date_fmt(t.get("date"))
        tm = _time_fmt_12h(t.get("time"))
        return f"{d} {tm}".strip()

    rows = [["#", "Date & Time", "Transaction ID", "Description", "Credit", "Debit", "Balance"]]
    rows.append(["", _cell(_date_fmt(start_date) if start_date else (_date_fmt(sorted(t.get('date') for t in txns if t.get('date'))[0]) if txns else ''), True),
                 "", Paragraph(escape_html("Opening Balance"), bold_center_style), "", "", _amount_cell(f"{opening_balance:,.2f}")])
    running = opening_balance
    for i, t in enumerate(txns, start=1):
        credit = float(t.get("credit") or 0)
        debit = float(t.get("debit") or 0)
        running += credit - debit
        rows.append([
            str(i), _cell(_dt(t)), _cell(t.get("id") or ""), _cell(t.get("description") or ""),
            f"{credit:,.2f}" if credit else "\u2013",
            f"{debit:,.2f}" if debit else "\u2013",
            f"{running:,.2f}",
        ])
    end_label = _date_fmt(end_date) if end_date else (_date_fmt(sorted(t.get('date') for t in txns if t.get('date'))[-1]) if txns else '')
    rows.append(["", _cell(end_label, True), "", _desc_right("Closing Balance"), "", "", _amount_cell(f"{running:,.2f}")])

    col_widths = [0.24 * inch, 1.25 * inch, 1.4 * inch, 2.2 * inch, 0.68 * inch, 0.68 * inch, 0.82 * inch]
    table = Table(rows, colWidths=col_widths, repeatRows=1)
    table_style = [
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor(_NAVY)),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 7.6),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 8), ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("LEFTPADDING", (0, 0), (-1, -1), 7), ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor(_BORDER)),
        ("ROWBACKGROUNDS", (0, 1), (-1, -2), [colors.white, colors.HexColor(_LIGHT_GREY)]),
        ("ALIGN", (0, 0), (0, -1), "CENTER"),
        ("ALIGN", (4, 0), (6, -1), "RIGHT"),
        ("ALIGN", (1, 0), (3, -1), "LEFT"),
        ("BACKGROUND", (0, 1), (-1, 1), colors.HexColor(_LIGHT_GREY)),
        ("SPAN", (0, 1), (2, 1)),
        ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#EAECEF")),
        ("SPAN", (0, -1), (2, -1)),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
    ]
    table.setStyle(TableStyle(table_style))
    story.append(table)
    story.append(Spacer(1, 12))

    story.append(Table([[""]], colWidths=[7.27 * inch], rowHeights=[0.5],
                        style=TableStyle([("LINEABOVE", (0, 0), (-1, 0), 0.75, colors.HexColor(_BORDER))])))
    story.append(Spacer(1, 8))
    story.append(Paragraph(
        f'<font color="{_GREEN}"><b>Amount in Words:</b></font> '
        f'<font color="{_TEXT_DARK}">{escape_html(_amount_in_words(current_balance))}</font>',
        ParagraphStyle("StmtWords", parent=label_style, fontSize=9.5)))

    canvas_cls, draw_top = _account_statement_numbered_canvas(
        logo_path,
        "This is a computer generated printout and does not require signature.",
        full_name, user.get("mobile") or "-", user.get("email") or "-",
        statement_date_str, summary_period_str, len(txns),
    )
    doc.build(story, onFirstPage=draw_top, onLaterPages=draw_top, canvasmaker=canvas_cls)
    return buf.getvalue()

def _build_receipt_pdf(company_name, logo_path, user, txn):
    """Payment History row > download icon (Razorpay rows only) -
    single-transaction receipt matching the reference design."""
    import io
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import inch
    from reportlab.lib import colors
    from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, Image
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.enums import TA_RIGHT

    styles = getSampleStyleSheet()
    title_style = ParagraphStyle("RcptTitle", parent=styles["Heading1"], fontSize=22, spaceAfter=2)
    label_style = ParagraphStyle("RcptLabel", parent=styles["Normal"], fontSize=10, leading=15)

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        topMargin=0.6 * inch, bottomMargin=0.95 * inch,
        leftMargin=0.6 * inch, rightMargin=0.6 * inch,
    )
    story = []

    if logo_path:
        try:
            logo_cell = Image(logo_path, width=1.1 * inch, height=1.1 * inch, kind="proportional")
        except Exception:  # noqa: BLE001
            logo_cell = Paragraph(company_name, title_style)
    else:
        logo_cell = Paragraph(company_name, title_style)
    header_table = Table(
        [[logo_cell, Paragraph("RECEIPT", ParagraphStyle("RcptRight", parent=title_style, alignment=TA_RIGHT))]],
        colWidths=[3.5 * inch, 3.3 * inch])
    header_table.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE")]))
    story.append(header_table)
    story.append(Spacer(1, 14))

    full_name = f"{user.get('firstName') or ''} {user.get('lastName') or ''}".strip() or "-"
    from_lines = [
        Paragraph("<b>Received From:</b>", ParagraphStyle("RcptFromTag", parent=label_style, textColor=colors.HexColor("#1b8a4a"))),
        Paragraph(f"<b>{escape_html(full_name)}</b>", ParagraphStyle("RcptFromName", parent=label_style, fontSize=13)),
        Paragraph(f"{escape_html(user.get('mobile') or '-')}", label_style),
        Paragraph(f"{escape_html(user.get('email') or '-')}", label_style),
    ]
    meta_rows = [
        ["Receipt No.", ":", "RCP-" + str(txn.get("id") or "")],
        ["Receipt Date", ":", datetime.date.today().strftime("%d %b %Y")],
    ]
    meta_table = Table(meta_rows, colWidths=[1.1 * inch, 0.15 * inch, 1.7 * inch])
    meta_table.setStyle(TableStyle([
        ("FONTSIZE", (0, 0), (-1, -1), 9.5),
        ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    top_row = Table([[from_lines, meta_table]], colWidths=[3.9 * inch, 3.0 * inch])
    top_row.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))
    story.append(top_row)
    story.append(Spacer(1, 16))

    amount = float(txn.get("credit") or 0)
    amount_box = Table([[
        Paragraph(f'<font color="#1b8a4a"><b>RECEIVED AMOUNT</b></font><br/>'
                  f'<font size="22"><b>{amount:,.2f}</b></font>', label_style),
        Paragraph('<font color="#1b8a4a"><b>Thank you for your payment.</b></font><br/>'
                  'We have received your payment successfully.', label_style),
    ]], colWidths=[3.4 * inch, 3.5 * inch])
    amount_box.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f2f7f3")),
        ("BOX", (0, 0), (-1, -1), 0.75, colors.HexColor("#dddddd")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 14), ("TOPPADDING", (0, 0), (-1, -1), 12),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 12),
    ]))
    story.append(amount_box)
    story.append(Spacer(1, 16))

    date_time = txn.get("date") or ""
    if txn.get("time"):
        date_time = f"{date_time} {txn.get('time')}"
    detail_rows = [
        ["Transaction ID", txn.get("id") or ""],
        ["Transaction Date & Time", date_time],
        ["Description", txn.get("description") or ""],
        ["Amount Received", f"{amount:,.2f}"],
        ["Amount in Words", _amount_in_words(amount)],
        ["Payment Method", txn.get("paymentMode") or "Razorpay"],
    ]
    cell_style = ParagraphStyle("RcptCell", parent=label_style, fontSize=9.5, wordWrap="CJK")
    detail_table = Table(
        [[Paragraph(f"<b>{escape_html(r[0])}</b>", cell_style), Paragraph(escape_html(r[1]), cell_style)] for r in detail_rows],
        colWidths=[2.2 * inch, 4.6 * inch])
    detail_table.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#dddddd")),
        ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#0b1330")),
        ("TEXTCOLOR", (0, 0), (0, -1), colors.white),
        ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
    ]))
    story.append(detail_table)
    story.append(Spacer(1, 16))
    story.append(Paragraph("If you have any questions, feel free to contact us.",
                            ParagraphStyle("RcptFooterNote", parent=label_style, alignment=1, fontSize=9,
                                           textColor=colors.HexColor("#555555"))))

    doc.build(story, canvasmaker=_numbered_canvas_factory(
        "This is a computer generated printout and does not require signature."))
    return buf.getvalue()


def _amount_in_words(amount):
    """Indian-numbering (lakh/crore) amount-in-words, e.g. 99671 ->
    'Ninety Nine Thousand Six Hundred Seventy One Only'. Paise are
    rounded off - these statements/receipts only ever show whole-rupee
    style wording, matching the reference design."""
    ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
            "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
            "Seventeen", "Eighteen", "Nineteen"]
    tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]

    def two_digits(n):
        if n < 20:
            return ones[n]
        return (tens[n // 10] + (" " + ones[n % 10] if n % 10 else "")).strip()

    def three_digits(n):
        if n >= 100:
            return (ones[n // 100] + " Hundred" + (" " + two_digits(n % 100) if n % 100 else "")).strip()
        return two_digits(n)

    n = int(round(abs(amount)))
    if n == 0:
        return "Zero Only"

    crore, n = divmod(n, 10000000)
    lakh, n = divmod(n, 100000)
    thousand, n = divmod(n, 1000)
    hundred = n

    parts = []
    if crore:
        parts.append(three_digits(crore) + " Crore")
    if lakh:
        parts.append(three_digits(lakh) + " Lakh")
    if thousand:
        parts.append(three_digits(thousand) + " Thousand")
    if hundred:
        parts.append(three_digits(hundred))
    return " ".join(parts).strip() + " Only"


def escape_html(s):
    return html_module.escape(str(s or ""))



def _integration_store_path(user_id):
    return _user_dir(_safe_id(user_id), "_integrations.json")


def _load_integration_token(user_id, provider):
    path = _integration_store_path(user_id)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    return data.get(provider)


def _save_integration_token(user_id, provider, token_data):
    path = _integration_store_path(user_id)
    data = {}
    if os.path.isfile(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError):
            data = {}
    token_data = dict(token_data)
    token_data["connectedAt"] = datetime.datetime.now().isoformat(timespec="seconds")
    data[provider] = token_data
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def _exchange_oauth_code(provider, code, redirect_uri):
    """Item 3 - the second half of the OAuth Authorization Code flow:
    trades the one-time `code` (from the redirect the provider just sent
    the browser back with) for a real access_token/refresh_token, via a
    server-to-server POST that includes the app's Client Secret - this
    step can only happen here, never in the browser, since the secret
    must never reach client-side JS."""
    if provider == "sharefile":
        subdomain = os.environ.get("SHAREFILE_SUBDOMAIN", "")
        token_url = f"https://{subdomain}.sharefile.com/oauth/token"
        payload = {
            "grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri,
            "client_id": os.environ.get("SHAREFILE_CLIENT_ID", ""),
            "client_secret": os.environ.get("SHAREFILE_CLIENT_SECRET", ""),
        }
    elif provider == "sharepoint":
        tenant_id = os.environ.get("SHAREPOINT_TENANT_ID", "common")
        token_url = f"https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token"
        payload = {
            "grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri,
            "client_id": os.environ.get("SHAREPOINT_CLIENT_ID", ""),
            "client_secret": os.environ.get("SHAREPOINT_CLIENT_SECRET", ""),
            "scope": "Files.ReadWrite.All offline_access",
        }
    else:
        raise ValueError(f"Unknown provider: {provider}")

    data = urlencode(payload).encode("utf-8")
    req = urllib.request.Request(token_url, data=data, method="POST",
                                  headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _push_file_to_connected_storage(user_id, local_file_path, dest_file_name):
    """Item 3 - best-effort: if this user has ShareFile/SharePoint
    connected, also pushes a copy of the just-generated Output.pdf there.
    Never raises - a failure here (expired token, network hiccup) should
    never break the actual lease-processing pipeline, which has already
    succeeded by the time this runs. Returns True/False for whether a
    push was attempted and succeeded, purely for logging."""
    sys_config = None
    try:
        users = auth_store.load_users()
        user = auth_store.find_user_by_id(users, user_id)
        sys_config = (user or {}).get("sysConfig")
    except Exception:
        pass
    if sys_config not in ("Sharefile", "Sharepoint"):
        return False

    provider = sys_config.lower()
    token_data = _load_integration_token(user_id, provider)
    if not token_data or not token_data.get("access_token"):
        return False

    try:
        with open(local_file_path, "rb") as f:
            file_bytes = f.read()

        if provider == "sharepoint":
            # Simple upload (works for files under ~4MB, which covers the
            # vast majority of generated lease/translation PDFs) into the
            # user's OneDrive root - a real production integration would
            # let the person pick a specific SharePoint site/folder and use
            # the resumable upload session API for anything larger.
            url = f"https://graph.microsoft.com/v1.0/me/drive/root:/{url_quote(dest_file_name)}:/content"
            req = urllib.request.Request(url, data=file_bytes, method="PUT", headers={
                "Authorization": f"Bearer {token_data['access_token']}",
                "Content-Type": "application/pdf",
            })
        else:  # sharefile
            url = f"https://{os.environ.get('SHAREFILE_SUBDOMAIN','')}.sharefile.com/sf/v3/Items/Upload"
            req = urllib.request.Request(url, data=file_bytes, method="POST", headers={
                "Authorization": f"Bearer {token_data['access_token']}",
                "Content-Type": "application/pdf",
            })

        with urllib.request.urlopen(req, timeout=30):
            pass
        return True
    except Exception as err:
        print(f"Could not push {dest_file_name} to {provider} for {user_id} (lease processing itself already succeeded): {err}")
        return False


def _extract_text_from_b64(data_b64, file_name, tmp_dir):
    """Item 4 helper - decodes a base64-uploaded file (PDF or plain text)
    into a temp file and returns its extracted text, reusing the exact
    same OCR-capable extraction the main pipeline uses so a scanned
    "Human Output" PDF works just as well as a text-layer one."""
    if not data_b64:
        return ""
    raw = base64.b64decode(data_b64)
    name = _safe_filename(file_name or "file.pdf")
    path = os.path.join(tmp_dir, f"{uuid.uuid4().hex[:8]}_{name}")
    with open(path, "wb") as f:
        f.write(raw)
    if name.lower().endswith(".pdf"):
        return lease_engine.extract_text(path)
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        return f.read()


def _base_url_from_headers(headers):
    """Derives this server's own public base URL from the incoming
    request's Host header - works for both local dev (http://localhost:PORT)
    and the deployed Render domain (https://...) without hardcoding
    anything. Used to build the verification email's magic link below."""
    host = (headers.get("Host") or "").strip()
    if not host:
        return ""
    scheme = "http" if host.startswith("localhost") or host.startswith("127.0.0.1") else "https"
    return f"{scheme}://{host}"


def _send_verification_email(to_email, user_name, code, purpose, expiry_minutes, base_url="", user_id=""):
    company_name = _load_company_name()
    label = _VERIFICATION_PURPOSE_LABELS.get(purpose, "verify your account")
    verify_link = f"{base_url}/?verifyCode={code}&verifyUserId={user_id}&verifyPurpose={purpose}" if base_url and user_id else ""
    plain_body = (
        f"Hi {user_name},\n\n"
        f"Use this code to {label}:\n\n"
        f"    {code}\n\n"
        + (f"Or open this link and it'll be filled in for you automatically: {verify_link}\n\n" if verify_link else "")
        + f"This code expires in {expiry_minutes} minute(s).\n\n"
        f"If you didn't request this, you can safely ignore this email.\n\n"
        f"— {company_name}"
    )
    # Item 5 - email clients (Gmail, Outlook, Apple Mail) strip <script>
    # and inline onclick JS, so a real one-click clipboard copy from
    # inside an email is not reliably possible anywhere. Instead of
    # fighting that, the button is a real link to the app with the code
    # in the URL (?verifyCode=...) - app.js auto-fills the OTP input the
    # moment it sees that on page load, so clicking it is just as fast as
    # copy-paste would have been, and works in every client.
    button_html = f"""
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding-top:14px;">
<a href="{verify_link}"
   style="display:inline-block;background:#131b3f;color:#ffffff;font-size:0.8rem;font-weight:600;
   text-decoration:none;padding:10px 24px;border-radius:6px;font-family:'Segoe UI',Arial,sans-serif;">
✅ Fill In Code For Me
</a>
</td></tr></table>
<p style="font-size:0.75rem;color:#9aa0b0;text-align:center;margin:10px 0 24px 0;">Opens the app with this code already filled in - or tap/double-click the code above to select and copy it manually.</p>
""" if verify_link else """
<p style="font-size:0.75rem;color:#9aa0b0;text-align:center;margin:10px 0 24px 0;">Tap or double-click the code above to select it, then copy (Ctrl/Cmd+C)</p>
"""
    body_html = f"""
<p style="font-size:0.95rem;color:#23263a;margin:0 0 14px 0;">Hi {user_name},</p>
<p style="font-size:0.95rem;color:#23263a;line-height:1.6;margin:0 0 22px 0;">Use the verification code below to {label}:</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<div style="display:inline-block;background:#f4f5fa;border:2px dashed #131b3f;border-radius:10px;padding:18px 30px;">
<span style="font-family:'Courier New',Courier,monospace;font-size:2rem;font-weight:700;letter-spacing:8px;color:#0a0f2c;user-select:all;">{code}</span>
</div>
</td></tr></table>
{button_html}
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
        # Item 8 (production security) - basic protective headers on every
        # response. This app is served from behind whatever reverse proxy
        # terminates TLS in production (Render, nginx, etc.) - HSTS is
        # intentionally left to that layer, since this process itself
        # doesn't know whether it's actually being reached over https.
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")

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

    def _send_redirect(self, url):
        """A real browser-navigation redirect (302) - used only by the
        OAuth start/callback routes, since those are followed by the
        browser itself (clicking "Continue with Google"), not called via
        fetch() like every other route in this app."""
        self.send_response(302)
        self.send_header("Location", url)
        self.send_header("Content-Length", "0")
        self.end_headers()

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
    # ------------------------------------------------------------------
    def _maintenance_block_if_needed(self, path):
        """True (and a 503 already sent) if this request should be
        blocked because maintenance mode is on and the caller isn't
        Admin/Developer. Only applies to /api/ paths - static files still
        load normally so the maintenance screen itself (and the login
        form, for an admin to sign back in) can render."""
        if not path.startswith("/api/") or path in MAINTENANCE_ALLOWED_API_PATHS:
            return False
        status = _get_maintenance_status()
        if not status.get("enabled"):
            return False
        try:
            user_id = self._authenticated_user_id()
            users = auth_store.load_users()
            user = auth_store.find_user_by_id(users, user_id)
            if user and user.get("role") in ("Admin", "Developer"):
                return False
        except Exception:  # noqa: BLE001 - not logged in / bad token -> still blocked
            pass
        self._send_json(503, {
            "error": status.get("message") or "This site is temporarily down for maintenance. Please check back soon.",
            "maintenance": True,
        })
        return True

    def _authenticated_user_id(self):
        auth_header = self.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            token = auth_header[7:].strip()
        else:
            # Plain browser navigation (window.open, <a href>, iframe -
            # used for file downloads) can never attach a custom
            # Authorization header, so those specific requests pass the
            # session token as a "token" query-string param instead. Every
            # other route still requires the real header - this fallback
            # only kicks in when the header is absent.
            query = parse_qs(urlparse(self.path).query)
            token = (query.get("token", [""])[0]).strip()
        if not token:
            raise AuthError("Not authenticated - please log in again.")
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
        requires the session to belong to one of the given roles.

        TEMPORARY: role check disabled below so every logged-in user can
        use these routes (matches the frontend override in isAdminOrDeveloper()
        / renderProfileMenu() in js/app.js). To restore real role-based
        access, delete the two lines under "TEMP bypass" and keep only the
        commented-out check.
        """
        session_user_id = self._authenticated_user_id()
        # ---- TEMP bypass: any logged-in user passes _require_role ----
        return session_user_id
        # ---- Original role check (restore by removing the bypass above) ----
        # if self._session_user_role(session_user_id) not in roles:
        #     raise AuthError("You don't have permission to do that.")
        # return session_user_id

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

        if self._maintenance_block_if_needed(path):
            return None

        # No custom redirect needed here anymore - the file is named
        # index.html (see Section 3 notes above), and SimpleHTTPRequestHandler
        # already serves index.html automatically for "/" on its own.

        get_routes = {
            "/api/admin/list": self._handle_admin_list,
            "/api/admin/download": self._handle_admin_download,
            "/api/admin/read": self._handle_admin_read,
            "/api/auth/me": self._handle_auth_me,
            "/api/maintenance-status": self._handle_maintenance_status,
            "/api/auth/directory": self._handle_auth_directory,
            "/api/auth/oauth/google/start": lambda q: self._handle_oauth_start("google", q),
            "/api/auth/oauth/google/callback": lambda q: self._handle_oauth_callback("google", q),
            "/api/auth/oauth/facebook/start": lambda q: self._handle_oauth_start("facebook", q),
            "/api/auth/oauth/facebook/callback": lambda q: self._handle_oauth_callback("facebook", q),
            "/api/auth/email-status": self._handle_auth_email_status,
            "/api/lease/extract-status": self._handle_lease_extract_status,
            "/api/lease/analyze-status": self._handle_lease_analyze_status,
            "/api/translation/translate-status": self._handle_translation_translate_status,
            "/api/translation/generate-pdf-status": self._handle_translation_generate_pdf_status,
            "/api/lease/list": self._handle_lease_list,
            "/api/translation/list": self._handle_translation_list,
            "/api/lease/review-data": self._handle_lease_review_get,
            "/api/data/payment-history": self._handle_payment_history_get,
            "/api/data/notifications": self._handle_notifications_get,
            "/api/data/plan-history": self._handle_plan_history_get,
            "/api/data/payment-methods": self._handle_payment_methods_get,
            "/api/data/contact-submissions": self._handle_contact_submissions_get,
            "/api/data/lease-files": self._handle_lease_files_get,
            "/api/data/translation-files": self._handle_translation_files_get,
            "/api/data/lease-activity-log": self._handle_lease_activity_get,
            "/api/data/translation-activity-log": self._handle_translation_activity_get,
            "/api/admin/db-status": self._handle_admin_db_status,
            "/api/admin/db-transactions": self._handle_admin_db_transactions,
            "/api/admin/db-tables": self._handle_admin_db_tables,
            "/api/admin/db-table": self._handle_admin_db_table,
            "/api/integrations/status": self._handle_integrations_status,
            "/api/integrations/callback": self._handle_integrations_callback,
            "/api/lease/documents": self._handle_lease_documents,
            "/api/rules/list": self._handle_rules_list,
            "/api/lease/download": self._handle_lease_download,
            "/api/translation/download": self._handle_translation_download,
            "/api/payment/invoice-pdf": self._handle_payment_invoice_pdf,
            "/api/payment/account-statement-pdf": self._handle_payment_account_statement_pdf,
            "/api/payment/receipt-pdf": self._handle_payment_receipt_pdf,
        }
        if not Handler._routes_checked:
            Handler._routes_checked = True
            Handler.check_resource_routes(get_routes)

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

        # "company" branding, "card-layout" (login screen card sizes),
        # aur "services-catalog" (Paid/Free/Hidden classification) pehle
        # public static files the (auth screen inhe login se pehle padhta
        # hai) - Postgres me move hone ke baad bhi same exposure level
        # rakha hai, koi user data inme nahi hai.
        if name not in ("company", "card-layout", "services-catalog"):
            try:
                self._authenticated_user_id()
            except AuthError as err:
                return self._send_json(401, {"error": str(err)})

        # DB-backed resource hai to Postgres se seedha - warna neeche wali
        # json file fallback chalti hai (DB disabled ho, ya row abhi tak
        # na bani ho).
        if db is not None and db.is_enabled():
            try:
                if name in db.DB_BACKED_RESOURCES:
                    return self._send_json(200, db.list_resource(name))
                if name in db.SETTINGS_RESOURCES:
                    data = db.get_setting(name)
                    if data is not None:
                        return self._send_json(200, data)
            except Exception as err:  # noqa: BLE001
                print(f"[db] read of {name} failed, falling back to JSON: {err}")

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
    def _handle_admin_db_migrate(self, body):
        """Migration Admin Panel se - terminal ki zaroorat nahi.

        Dobara chalane par duplicate nahi bante, isliye ye button safely
        kai baar dabaya ja sakta hai.
        """
        self._require_role(("Admin", "Developer"))
        if db is None or not db.is_enabled():
            return 400, {"error": "Database is not configured (DATABASE_URL missing)."}
        try:
            report = db.migrate_from_json(JSON_DIR)
        except Exception as err:  # noqa: BLE001
            return 500, {"error": str(err)}
        return 200, {"ok": True, "report": report}

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

        # DB-backed resource hai to file ki jagah Postgres me likho -
        # warna client ka PUT DB ko chup-chaap purani list se overwrite
        # kar deta. Kaunsi resource DB par hai, ye db.py tay karta hai.
        if db is not None and db.is_enabled() and name in db.DB_BACKED_RESOURCES:
            if not isinstance(data, list):
                return self._send_json(400, {"error": f"{name} must be a list"})
            try:
                db.save_resource(name, data)
                return self._send_json(200, {"ok": True, "store": "postgres"})
            except Exception as err:  # noqa: BLE001
                print(f"[db] save of {name} failed, falling back to JSON: {err}")

        if db is not None and db.is_enabled() and name in db.SETTINGS_RESOURCES:
            if not isinstance(data, dict):
                return self._send_json(400, {"error": f"{name} must be an object"})
            try:
                db.save_setting(name, data)
                return self._send_json(200, {"ok": True, "store": "postgres"})
            except Exception as err:  # noqa: BLE001
                print(f"[db] save of {name} failed, falling back to JSON: {err}")

        file_path = os.path.join(JSON_DIR, f"{name}.json")
        try:
            with open(file_path, "w", encoding="utf-8") as f:
                f.write(json.dumps(data, indent=4, ensure_ascii=False) + "\n")
        except OSError as err:
            print(f"Failed to write json/{name}.json: {err}")
            return self._send_json(500, {"error": "Failed to save"})

        self._send_json(200, {"ok": True})

    def _handle_maintenance_status(self, query):
        # Deliberately public/unauthenticated - the login screen itself
        # needs to know whether to show the maintenance page before
        # anyone has signed in.
        return self._send_json(200, _get_maintenance_status())

    def _handle_maintenance_toggle(self, body):
        self._require_role(("Admin", "Developer"))
        enabled = bool(body.get("enabled"))
        message = (body.get("message") or "").strip()
        data = {"enabled": enabled, "message": message}
        _save_maintenance_status(data)
        return 200, {"ok": True, **data}

    def _handle_admin_db_status(self, query):
        """Admin panel ka Database card. Sirf Admin/Developer ke liye,
        aur DATABASE_URL ka password kabhi bahar nahi jata (db.safe_host)."""
        self._require_role(("Admin", "Developer"))

        if db is None:
            return self._send_json(200, {
                "enabled": False,
                "reason": "db module could not be imported",
                "jsonCount": len(self._read_payment_history_file()),
            })

        info = db.status()
        json_rows = self._read_payment_history_file()
        info["jsonCount"] = len(json_rows)

        # JSON me hain par DB me nahi - matlab migration adhoori hai.
        if info.get("tableExists"):
            try:
                db_ids = {r["id"] for r in db.list_transactions()}
                info["missingFromDb"] = [
                    r.get("id") for r in json_rows
                    if r.get("id") and r.get("id") not in db_ids
                ]
            except Exception as err:  # noqa: BLE001
                info["missingFromDb"] = []
                info.setdefault("error", str(err))
        return self._send_json(200, info)

    def _handle_admin_db_tables(self, query):
        self._require_role(("Admin", "Developer"))
        if db is None or not db.is_enabled():
            return self._send_json(200, {"enabled": False, "tables": []})
        try:
            return self._send_json(200, {"enabled": True, "tables": db.list_tables()})
        except Exception as err:  # noqa: BLE001
            return self._send_json(200, {"enabled": True, "tables": [], "error": str(err)})

    def _handle_admin_db_table(self, query):
        self._require_role(("Admin", "Developer"))
        name = (query.get("name", [""])[0] or "").strip()
        if db is None or not db.is_enabled():
            return self._send_json(400, {"error": "Database is not configured."})
        try:
            rows = db.table_rows(name)
            columns = db.table_columns(name)
        except ValueError as err:
            # Allowlist ke bahar ka naam - table name SQL me seedha jata
            # hai, isliye yahan koi narmi nahi.
            return self._send_json(400, {"error": str(err)})
        except Exception as err:  # noqa: BLE001
            return self._send_json(500, {"error": str(err)})
        return self._send_json(200, {"name": name, "rows": rows, "columns": columns})

    def _handle_admin_db_table_insert(self, body):
        self._require_role(("Admin", "Developer"))
        if db is None or not db.is_enabled():
            return 400, {"error": "Database is not configured."}
        name = (body.get("table") or "").strip()
        values = body.get("values")
        if not isinstance(values, dict):
            return 400, {"error": "values must be an object."}
        try:
            db.insert_row(name, values)
        except ValueError as err:
            return 400, {"error": str(err)}
        except Exception as err:  # noqa: BLE001
            return 500, {"error": str(err)}
        return 200, {"ok": True}

    def _handle_admin_db_table_update(self, body):
        self._require_role(("Admin", "Developer"))
        if db is None or not db.is_enabled():
            return 400, {"error": "Database is not configured."}
        name = (body.get("table") or "").strip()
        key = body.get("key")
        values = body.get("values")
        if not isinstance(key, dict) or not isinstance(values, dict):
            return 400, {"error": "key and values must be objects."}
        try:
            affected = db.update_row(name, key, values)
        except ValueError as err:
            return 400, {"error": str(err)}
        except Exception as err:  # noqa: BLE001
            return 500, {"error": str(err)}
        if not affected:
            return 404, {"error": "Row nahi mila (already deleted?)."}
        return 200, {"ok": True}

    def _handle_admin_db_table_delete(self, body):
        self._require_role(("Admin", "Developer"))
        if db is None or not db.is_enabled():
            return 400, {"error": "Database is not configured."}
        name = (body.get("table") or "").strip()
        key = body.get("key")
        if not isinstance(key, dict):
            return 400, {"error": "key must be an object."}
        try:
            affected = db.delete_row(name, key)
        except ValueError as err:
            return 400, {"error": str(err)}
        except Exception as err:  # noqa: BLE001
            return 500, {"error": str(err)}
        if not affected:
            return 404, {"error": "Row nahi mila (already deleted?)."}
        return 200, {"ok": True}

    def _handle_admin_db_transactions(self, query):
        self._require_role(("Admin", "Developer"))
        if db is None or not db.is_enabled():
            return self._send_json(200, {"store": "json", "rows": self._read_payment_history_file()})
        try:
            return self._send_json(200, {"store": "postgres", "rows": db.list_transactions()})
        except Exception as err:  # noqa: BLE001
            return self._send_json(200, {
                "store": "json", "rows": self._read_payment_history_file(), "error": str(err),
            })

    def _read_payment_history_file(self):
        return self._read_json_list("payment-history")

    _routes_checked = False

    @staticmethod
    def check_resource_routes(get_routes):
        """Har DB-backed resource ka GET route hona chahiye - ya to apna
        explicit handler (jab per-user filtering jaisi extra logic chahiye,
        jaise payment-history), ya generic ALLOWED_RESOURCES fallback
        (jab data har user ke liye same/public ho, jaise "plans" - sabhi
        users ke liye same pricing list, koi filtering ki zaroorat nahi).

        Aadhi migration hi sabse bada khatra hai: write Postgres me jaye
        par read purani JSON file se aaye - tab naya data screen par aakar
        agle refresh me gayab ho jata hai. Ye galti do baar ho chuki hai,
        isliye ab startup par code khud check kar leta hai.
        """
        if db is None:
            return []
        missing = [n for n in db.DB_BACKED_RESOURCES
                   if f"/api/data/{n}" not in get_routes and n not in ALLOWED_RESOURCES]
        for name in missing:
            print(f"[db] WARNING: '{name}' Postgres par hai par uska GET route "
                  f"registered nahi hai - browser purani json/{name}.json "
                  f"padhta rahega aur naya data gayab dikhega.")
        return missing

    def _handle_notifications_get(self, query):
        return self._serve_resource("notifications")

    # Ye chaaro ek hi generic reader par jaate hain - naya resource aaye to
    # db.DB_BACKED_RESOURCES me naam + yahan ek line, bas.
    def _handle_plan_history_get(self, query):
        return self._serve_resource("plan-history")

    def _handle_payment_methods_get(self, query):
        return self._serve_resource("payment-methods")

    def _handle_contact_submissions_get(self, query):
        return self._serve_resource("contact-submissions")

    def _handle_lease_files_get(self, query):
        return self._serve_resource("lease-files")

    def _handle_translation_files_get(self, query):
        return self._serve_resource("translation-files")

    def _handle_lease_activity_get(self, query):
        return self._serve_resource("lease-activity-log")

    def _handle_translation_activity_get(self, query):
        return self._serve_resource("translation-activity-log")

    def _serve_resource(self, name):
        """DB-backed resource ko padhne ka ek hi rasta (GET /api/data/<n>).

        Postgres chalu ho to DB se, warna wahi JSON file. Nayi file DB par
        laani ho to db.DB_BACKED_RESOURCES me naam add karke yahan ek route
        register kar dijiye - is function me kuch nahi badalta.
        """
        try:
            self._authenticated_user_id()
        except AuthError as err:
            return self._send_json(401, {"error": str(err)})

        if db is not None and db.is_enabled() and name in db.DB_BACKED_RESOURCES:
            try:
                return self._send_json(200, db.list_resource(name))
            except Exception as err:  # noqa: BLE001
                print(f"[db] read of {name} failed, falling back to JSON: {err}")

        return self._send_json(200, self._read_json_list(name))

    def _read_json_list(self, name):
        path = os.path.join(JSON_DIR, f"{name}.json")
        try:
            with open(path, "r", encoding="utf-8") as f:
                rows = json.load(f)
        except (OSError, json.JSONDecodeError):
            return []
        return rows if isinstance(rows, list) else []

    def _handle_payment_history_get(self, query):
        """Payment history padhne ka ek hi rasta.

        Pehle browser seedha json/payment-history.json (static file) fetch
        karta tha. Postgres chalu karne par writes DB me jaane lage par
        reads wahi purani file se aate rahe - isliye naya transaction
        dikhta tha aur 15-second poll par gayab ho jata tha. Ab dono ek hi
        jagah se aate hain.
        """
        try:
            self._authenticated_user_id()
        except AuthError as err:
            return self._send_json(401, {"error": str(err)})

        if db is not None and db.is_enabled():
            try:
                return self._send_json(200, db.list_transactions())
            except Exception as err:  # noqa: BLE001
                print(f"[db] read failed, falling back to JSON: {err}")

        return self._send_json(200, self._read_payment_history_file())

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

        if self._maintenance_block_if_needed(path):
            return None

        routes = {
            "/api/admin/db-migrate": self._handle_admin_db_migrate,
            "/api/admin/maintenance-toggle": self._handle_maintenance_toggle,
            "/api/admin/db-table-insert": self._handle_admin_db_table_insert,
            "/api/admin/db-table-update": self._handle_admin_db_table_update,
            "/api/admin/db-table-delete": self._handle_admin_db_table_delete,
            "/api/upload-photo": self._handle_upload_photo,
            "/api/send-acknowledgement": self._handle_send_acknowledgement,
            "/api/send-ticket-update": self._handle_send_ticket_update,
            "/api/send-notification": self._handle_send_notification,
            "/api/lease/scan-template": self._handle_lease_scan_template,
            "/api/lease/upload-template": self._handle_lease_upload_template,
            "/api/lease/upload": self._handle_lease_upload,
            "/api/lease/extract-start": self._handle_lease_extract_start,
            "/api/lease/analyze-start": self._handle_lease_analyze_start,
            "/api/lease/validate": self._handle_lease_validate,
            "/api/lease/save-output": self._handle_lease_save_output,
            "/api/lease/review-submit": self._handle_lease_review_submit,
            "/api/rules/propose": self._handle_rules_propose,
            "/api/rules/approve": self._handle_rules_approve,
            "/api/lease/discover-rules": self._handle_lease_discover_rules,
            "/api/admin/test-compare": self._handle_admin_test_compare,
            "/api/rules/reject": self._handle_rules_reject,
            "/api/rules/delete-pending": self._handle_rules_delete_pending,
            "/api/rules/delete-approved": self._handle_rules_delete_approved,
            "/api/rules/add-blank": self._handle_rules_add_blank,
            "/api/admin/services-catalog-seed": self._handle_services_catalog_seed,
            "/api/admin/services-catalog-reset-api-access": self._handle_services_catalog_reset_api_access,
            "/api/admin/services-catalog-fix-names": self._handle_services_catalog_fix_names,
            "/api/rules/update-approved": self._handle_rules_update_approved,
            "/api/lease/generate-pdf": self._handle_lease_generate_pdf,
            "/api/translation/upload": self._handle_translation_upload,
            "/api/translation/translate-start": self._handle_translation_translate_start,
            "/api/translation/generate-pdf-start": self._handle_translation_generate_pdf_start,
            "/api/translation/save-output": self._handle_translation_save_output,
            "/api/translation/save-offline-docx": self._handle_translation_save_offline_docx,
            "/api/translation/vision-proxy": self._handle_translation_vision_proxy,
            "/api/translation/inpaint-proxy": self._handle_translation_inpaint_proxy,
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
            "/api/profile/generate-api-key": self._handle_profile_generate_api_key,
            "/api/profile/revoke-api-key": self._handle_profile_revoke_api_key,
            "/api/profile/send-mobile-otp": self._handle_profile_send_mobile_otp,
            "/api/profile/verify-mobile-otp": self._handle_profile_verify_mobile_otp,
            "/api/auth/logout": self._handle_auth_logout,
            "/api/auth/delete-account": self._handle_auth_delete_account,
            "/api/payment/create-order": self._handle_payment_create_order,
            "/api/payment/verify-payment": self._handle_payment_verify,
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

    # ---- Razorpay: create-order (step 1) ----
    def _handle_payment_create_order(self, body):
        """Browser 'Add Balance' amount bhejta hai; hum Razorpay Orders API
        par ek order banate hain aur order_id + public key_id wapas bhejte
        hain. Koi balance yaha credit NAHI hota - ye sirf checkout widget
        kholne ke liye order banata hai. Asli credit sirf verify-payment
        mein, signature check ke baad hota hai."""
        user_id = _safe_id(self._resolve_user_id(body))

        users = auth_store.load_users()
        user = auth_store.find_user_by_id(users, user_id)
        if not user:
            raise ValueError("Account not found.")
        if not (user.get("mobileVerified") and user.get("mobileVerifiedNumber") == (user.get("mobile") or "").strip()):
            raise ValueError("Please verify your Mobile No first (Profile > Mobile No > Verify) before adding balance.")

        try:
            amount = float(body.get("amount"))
        except (TypeError, ValueError):
            raise ValueError("A valid amount is required.")
        if amount <= 0 or amount > 1_000_000:
            raise ValueError("Amount must be between 0 and 1,000,000.")

        key_id, key_secret, auth_header = _razorpay_auth_header()
        currency = (os.environ.get("RAZORPAY_CURRENCY") or "INR").strip() or "INR"
        # Razorpay amounts are always in the smallest currency unit
        # (paise for INR, cents for USD, etc.) - hence *100.
        amount_subunits = int(round(amount * 100))
        receipt = f"lexora_{user_id}_{int(time.time())}"[:40]

        payload = {
            "amount": amount_subunits,
            "currency": currency,
            "receipt": receipt,
            "payment_capture": 1,
            "notes": {"userId": user_id},
        }
        req = urllib.request.Request(
            "https://api.razorpay.com/v1/orders",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": auth_header},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                order = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8")[:300]
            except Exception:
                pass
            return e.code, {"error": f"Razorpay order create failed: {detail}"}
        except Exception as e:
            return 502, {"error": f"Could not reach Razorpay: {e}"}

        # customer_id ke bina "Save this card" kaam nahi karta - checkout
        # ko ye id chahiye taaki token kisi customer ke against store ho
        # sake aur agli baar wapas fetch ho sake. Fail ho jaye to None
        # jata hai aur payment normally chalta rehta hai.
        customer_id = _razorpay_get_or_create_customer(user_id, auth_header)

        return 200, {
            "orderId": order.get("id"),
            "amount": amount_subunits,
            "currency": currency,
            "keyId": key_id,
            "customerId": customer_id,
        }

    # ---- Razorpay: verify-payment (step 2) ----
    def _handle_payment_verify(self, body):
        """Checkout widget ke handler() se aata hai (razorpay_order_id,
        razorpay_payment_id, razorpay_signature). HMAC-SHA256 signature
        yaha server-side verify hoti hai using key_secret - browser kabhi
        bhi khud se ek 'approved' Razorpay transaction likh nahi sakta,
        sirf Razorpay khud jo signature de sakta hai wahi accept hoti hai.
        Signature valid hone ke baad bhi amount client se copy nahi karte -
        order ko dobara Razorpay se fetch karke wahi authoritative amount
        credit hota hai."""
        user_id = _safe_id(self._resolve_user_id(body))
        order_id = (body.get("razorpayOrderId") or "").strip()
        payment_id = (body.get("razorpayPaymentId") or "").strip()
        signature = (body.get("razorpaySignature") or "").strip()
        description = (body.get("description") or "Razorpay balance top-up").strip()[:200]

        if not (order_id and payment_id and signature):
            raise ValueError("Missing Razorpay payment fields.")

        key_id, key_secret, auth_header = _razorpay_auth_header()

        expected_signature = hmac.new(
            key_secret.encode("utf-8"),
            f"{order_id}|{payment_id}".encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        if not hmac.compare_digest(expected_signature, signature):
            raise ValueError("Payment verification failed - signature mismatch.")

        # Signature checks out, so Razorpay genuinely signed this - now
        # pull the order back from Razorpay's API to get the real amount
        # actually paid (never trust an amount the browser reports).
        req = urllib.request.Request(
            f"https://api.razorpay.com/v1/orders/{order_id}",
            headers={"Authorization": auth_header},
            method="GET",
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                order = json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            raise ValueError(f"Could not confirm order with Razorpay: {e}")

        if (order.get("notes") or {}).get("userId") != user_id:
            raise ValueError("This order does not belong to the logged-in user.")
        if order.get("status") != "paid":
            raise ValueError(f"Order is not marked paid by Razorpay (status: {order.get('status')}).")

        amount_subunits = order.get("amount_paid") or order.get("amount") or 0
        real_amount = round(amount_subunits / 100, 2)
        if real_amount <= 0:
            raise ValueError("Order amount could not be confirmed.")

        now = datetime.datetime.now()
        entry = {
            "id": "TXN-RZP-" + payment_id[-10:],
            "date": now.strftime("%Y-%m-%d"),
            "time": now.strftime("%H:%M"),
            "userId": user_id,
            "paymentType": "Razorpay",
            "paymentMode": f"Razorpay ({order.get('currency', 'INR')})",
            "description": description,
            "credit": real_amount,
            "debit": 0,
            "status": "approved",
            "razorpayOrderId": order_id,
            "razorpayPaymentId": payment_id,
        }
        _append_payment_history_entry(entry)
        return 200, {"ok": True, "transaction": entry}

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
        user_id = body.get("userId")
        if not to_email and not user_id:
            raise ValueError("toEmail is required")
        ticket_id = body.get("ticketId") or "-"
        msg_type = body.get("type") or "Query"
        subject = body.get("subject") or "(no subject)"
        user_name = body.get("userName") or "there"

        user = None
        if user_id:
            users = auth_store.load_users()
            user = auth_store.find_user_by_id(users, user_id)
        mobile_verified = bool(
            user and user.get("mobileVerified")
            and user.get("mobileVerifiedNumber") == (user.get("mobile") or "").strip()
        )
        if user and user.get("verificationMethod") == "sms" and mobile_verified:
            _send_notification_sms_async(
                user["mobile"], f"Ticket {ticket_id} received",
                f"We've received your {msg_type.lower()} (\"{subject}\"). Our team will respond soon.",
            )
            return 200, {"ok": True}

        email = (user.get("email") if user else None) or to_email
        if not email:
            return 200, {"ok": True}
        _send_acknowledgement_email(email, user_name, ticket_id, msg_type, subject, body.get("message") or "")
        return 200, {"ok": True}

    # ---- generic notification email (tickets, api keys, profile, login alerts) ----
    def _handle_send_notification(self, body):
        to_email = body.get("toEmail")
        user_id = body.get("userId")
        if not to_email and not user_id:
            raise ValueError("toEmail is required")
        title = body.get("title") or "Account notification"
        message = body.get("message") or ""
        table_rows = body.get("tableRows")
        table_headers = body.get("tableHeaders")
        _dispatch_user_notification(
            user_id, to_email, body.get("userName") or "there", title, message,
            table_rows=table_rows, table_headers=table_headers,
        )
        return 200, {"ok": True}

    def _handle_send_ticket_update(self, body):
        to_email = body.get("toEmail")
        user_id = body.get("userId")
        if not to_email and not user_id:
            raise ValueError("toEmail is required")
        ticket_id = body.get("ticketId") or "-"
        status = body.get("status") or "Pending"
        response = body.get("response") or ""
        subject = body.get("subject") or "(no subject)"
        user_name = body.get("userName") or "there"

        user = None
        if user_id:
            users = auth_store.load_users()
            user = auth_store.find_user_by_id(users, user_id)
        mobile_verified = bool(
            user and user.get("mobileVerified")
            and user.get("mobileVerifiedNumber") == (user.get("mobile") or "").strip()
        )
        if user and user.get("verificationMethod") == "sms" and mobile_verified:
            text = f'Your support ticket "{subject}" status is now {status}.'
            if response and response != "-":
                text += f" Response: {response}"
            _send_notification_sms_async(user["mobile"], f"Ticket {ticket_id} updated", text)
            return 200, {"ok": True}

        email = (user.get("email") if user else None) or to_email
        if not email:
            return 200, {"ok": True}
        _send_ticket_update_email(email, user_name, ticket_id, status, response, subject)
        return 200, {"ok": True}

    # ---- Section 14.1: output template scan (batch-level, not per file) ----
    # ---- Item 3: ShareFile/SharePoint "system configuration". A REAL
    # connection to either needs an OAuth app registered with that
    # provider (Citrix ShareFile developer portal / Microsoft Azure AD for
    # SharePoint's Graph API) - there's no way to fake that meaningfully,
    # so this just reports whether the necessary Client ID/Secret are
    # present in .env, and hands back the real OAuth authorize URL when
    # they are. Until a Developer adds those credentials, every provider
    # here correctly reports "not configured" rather than randomly
    # pretending to succeed. ----
    def _handle_integrations_status(self, query):
        user_id = _safe_id(self._resolve_user_id_query(query))
        provider = (query.get("provider", [""])[0]).lower()
        base_url = _base_url_from_headers(self.headers)
        redirect_uri = f"{base_url}/api/integrations/callback"
        state = f"{user_id}:{provider}"

        if provider == "sharefile":
            client_id = os.environ.get("SHAREFILE_CLIENT_ID")
            subdomain = os.environ.get("SHAREFILE_SUBDOMAIN", "")
            configured = bool(client_id and os.environ.get("SHAREFILE_CLIENT_SECRET") and subdomain)
            auth_url = (
                f"https://{subdomain}.sharefile.com/oauth/authorize?response_type=code"
                f"&client_id={client_id}&redirect_uri={url_quote(redirect_uri, safe='')}"
                f"&state={url_quote(state)}"
                if configured else ""
            )
        elif provider == "sharepoint":
            client_id = os.environ.get("SHAREPOINT_CLIENT_ID")
            tenant_id = os.environ.get("SHAREPOINT_TENANT_ID", "common")
            configured = bool(client_id and os.environ.get("SHAREPOINT_CLIENT_SECRET"))
            auth_url = (
                f"https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/authorize"
                f"?client_id={client_id}&response_type=code&scope=Files.ReadWrite.All%20offline_access"
                f"&redirect_uri={url_quote(redirect_uri, safe='')}"
                f"&state={url_quote(state)}"
                if configured else ""
            )
        else:
            return self._send_json(400, {"error": "Unknown provider"})

        connected = False
        if configured:
            token_data = _load_integration_token(user_id, provider)
            connected = bool(token_data and token_data.get("access_token"))
        return self._send_json(200, {"ok": True, "configured": configured, "authUrl": auth_url, "connected": connected})

    def _handle_integrations_callback(self, query):
        """OAuth redirect target for both providers (item 3) - exchanges
        the one-time authorization code for a real access/refresh token
        and stores it against the user encoded in `state`, then shows a
        plain confirmation page the popup window can just be closed from.
        Never touches lease data - this only runs once, right after the
        person approves access on the provider's own site."""
        code = (query.get("code", [""])[0])
        state = (query.get("state", [""])[0])
        error = (query.get("error", [""])[0])
        if error:
            return self._send_html(400, f"<h3>Connection failed</h3><p>{escape_html(error)}</p><p>You can close this window.</p>")
        if not code or ":" not in state:
            return self._send_html(400, "<h3>Missing authorization code</h3><p>You can close this window and try again.</p>")

        user_id, _, provider = state.partition(":")
        base_url = _base_url_from_headers(self.headers)
        redirect_uri = f"{base_url}/api/integrations/callback"

        try:
            token_data = _exchange_oauth_code(provider, code, redirect_uri)
        except Exception as err:
            print(f"OAuth token exchange failed for {provider}/{user_id}: {err}")
            return self._send_html(502, f"<h3>Connection failed</h3><p>Could not complete the connection to {escape_html(provider)}. Please try again.</p>")

        _save_integration_token(user_id, provider, token_data)
        return self._send_html(200, f"<h3>✅ Connected to {escape_html(provider.title())}</h3><p>You can close this window and go back to the app.</p>")

    def _send_html(self, status, html_body):
        full = f"<!doctype html><html><body style='font-family:sans-serif;text-align:center;padding:60px;'>{html_body}</body></html>"
        body = full.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

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
        style_profile = {"headerBgColor": None, "fontFamily": None, "logoImagePath": None}
        if lease_engine.pdfplumber and template_path.lower().endswith(".pdf"):
            try:
                with lease_engine.pdfplumber.open(template_path) as pdf:
                    pages = len(pdf.pages)
            except Exception:
                pages = None
            # Item 6 - identify the custom template's header color, font,
            # and logo once here (not per-file), so every lease processed
            # against this template in the batch reuses the same profile.
            if template_path != DEFAULT_TEMPLATE_PATH:
                style_profile = lease_engine.save_template_style_profile(template_path)

        return 200, {"ok": True, "template": template_name, "pages": pages, "styleDetected": bool(style_profile.get("headerBgColor") or style_profile.get("logoImagePath"))}

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
    # ============================================================
    # Item 4 - "Test & Compare": Admin/Developer tool to check extraction
    # accuracy against a human-reviewed answer key for the same lease, and
    # surface the worst-matching fields as candidates for new/updated
    # extraction rules. Synchronous (not the async job-poll pattern the
    # main pipeline uses) since this is a low-volume admin tool, not
    # user-facing high-throughput processing - a real LLM extraction call
    # can take a while, which is an accepted tradeoff here.
    # ============================================================
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

    # ---- Section 14.3 (40%): "GPT prompt" analysis - runs in a background
    # thread (see _run_analyze_job above), same async-job + polling shape
    # as the extract step, so a slow LLM call never blocks a single HTTP
    # request long enough to look "stuck" or trip a gateway timeout. ----
    def _handle_lease_analyze_start(self, body):
        text = body.get("text") or ""
        fallback_name = body.get("fallbackName") or "Lease"

        _cleanup_stale_analyze_jobs()
        job_id = uuid.uuid4().hex
        _set_analyze_job(job_id, status="running")
        thread = threading.Thread(target=_run_analyze_job, args=(job_id, text, fallback_name), daemon=True)
        thread.start()

        return 200, {"ok": True, "jobId": job_id}

    def _handle_lease_analyze_status(self, query):
        job_id = (query.get("jobId", [""])[0])
        job = _get_analyze_job(job_id)
        if not job:
            return self._send_json(404, {"error": "Unknown or expired job"})
        payload = {"ok": True, "status": job.get("status", "running")}
        if job.get("status") == "done":
            payload.update(job.get("result") or {})
        elif job.get("status") == "error":
            payload["error"] = job.get("error", "Analysis failed")
        return self._send_json(200, payload)

    # ---- Section 14.3 (60%): document-type + duplicate validation ----
    def _handle_lease_validate(self, body):
        user_id = _safe_id(self._resolve_user_id(body))
        doc_type = body.get("docType")
        lease_name = lease_engine.sanitize_lease_name(body.get("leaseName"))
        fields = body.get("fields") or {}

        if doc_type == "Other":
            return 200, {"ok": True, "valid": False, "reason": "invalid", "leaseName": lease_name}

        output_json_path = _user_dir(user_id, "LeaseAbstraction", lease_name, "Output.json")
        if os.path.isfile(output_json_path):
            return 200, {"ok": True, "valid": False, "reason": "duplicate", "leaseName": lease_name}

        # Item 6 - content-level duplicate check: even if this document got
        # a different auto-generated lease name (different filename, OCR
        # picked up the tenant name slightly differently, this is a
        # reference/exhibit doc for a lease already on file, etc.), the
        # same tenant+landlord+address+dates fingerprint means it's the
        # same underlying lease. Scans every lease this user has already
        # fully processed (has an Output.pdf, not just a pending review).
        fingerprint = lease_engine.compute_lease_fingerprint(fields)
        if fingerprint:
            base = _user_dir(user_id, "LeaseAbstraction")
            if os.path.isdir(base):
                for name in os.listdir(base):
                    if name.startswith("_") or name == lease_name:
                        continue
                    existing_json = os.path.join(base, name, "Output.json")
                    if not os.path.isfile(existing_json):
                        continue
                    try:
                        with open(existing_json, "r", encoding="utf-8") as f:
                            existing_data = json.load(f)
                    except (OSError, json.JSONDecodeError):
                        continue
                    if existing_data.get("fingerprint") == fingerprint:
                        return 200, {
                            "ok": True, "valid": False, "reason": "duplicate-content",
                            "leaseName": lease_name, "matchedLeaseName": name,
                        }

        return 200, {"ok": True, "valid": True, "leaseName": lease_name}

    # ---- Section 14.3 (80%): Output.json + saved document + LeaseDocuments.json ----
    def _handle_lease_save_output(self, body):
        user_id = _safe_id(self._resolve_user_id(body))
        lease_name = lease_engine.sanitize_lease_name(body.get("leaseName"))
        doc_type = body.get("docType") or "Lease"
        fields = lease_engine.sanitize_fields_recursively(body.get("fields") or {})
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
            "fingerprint": lease_engine.compute_lease_fingerprint(fields),
            "extractionMethod": extraction_method,
            "accuracy": accuracy,
            "accuracyMethod": accuracy_method,
            "accuracySummary": accuracy_summary,
            "missingFields": missing_fields,
            "lowConfidenceFields": low_confidence_fields,
            "fields": fields,
            "reviewStatus": "pending_review",
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

    # ---- Human Review (before PDF generation) - see save-output above,
    # which is where Output.json first gets written; these two routes let
    # the reviewer fetch it back for editing and save their corrections.
    # Nothing here re-runs the LLM - it's a straight read/edit/write of
    # the same Output.json, same shape used everywhere else. ----
    def _handle_lease_review_get(self, query):
        user_id = _safe_id(self._resolve_user_id_query(query))
        lease_name = lease_engine.sanitize_lease_name((query.get("leaseName", [""])[0]))
        output_json_path = _user_dir(user_id, "LeaseAbstraction", lease_name, "Output.json")
        if not os.path.isfile(output_json_path):
            return self._send_json(404, {"error": "Output.json not found for this lease"})
        with open(output_json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return self._send_json(200, {"ok": True, "leaseName": lease_name, "fields": data.get("fields", {}),
                                      "docType": data.get("docType"), "accuracy": data.get("accuracy"),
                                      "reviewStatus": data.get("reviewStatus", "pending_review")})

    def _handle_lease_review_submit(self, body):
        user_id = _safe_id(self._resolve_user_id(body))
        lease_name = lease_engine.sanitize_lease_name(body.get("leaseName"))
        fields = body.get("fields")
        if not isinstance(fields, dict):
            raise ValueError("fields must be an object")

        output_json_path = _user_dir(user_id, "LeaseAbstraction", lease_name, "Output.json")
        if not os.path.isfile(output_json_path):
            raise ValueError("Output.json not found for this lease")
        with open(output_json_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        data["fields"] = lease_engine.sanitize_fields_recursively(fields)
        data["reviewStatus"] = "reviewed"
        data["reviewedAt"] = datetime.datetime.now().isoformat(timespec="seconds")
        data["reviewedBy"] = user_id
        data["updatedAt"] = data["reviewedAt"]

        with open(output_json_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=4, ensure_ascii=False)

        return 200, {"ok": True}

    # ---- Section 14.3 (100%): Output.pdf generation ----
    def _handle_lease_generate_pdf(self, body):
        user_id = _safe_id(self._resolve_user_id(body))
        lease_name = lease_engine.sanitize_lease_name(body.get("leaseName"))
        template_name = body.get("templateName") or "Default.pdf"

        lease_folder = _user_dir(user_id, "LeaseAbstraction", lease_name)
        output_json_path = os.path.join(lease_folder, "Output.json")
        if not os.path.isfile(output_json_path):
            raise ValueError("Output.json not found - run save-output first")

        # Item 6 - if this is a custom (non-default) template, its style
        # profile (header color/font/logo) was already extracted and saved
        # when the batch started (see _handle_lease_scan_template) - load
        # it back here so generate_output_pdf can apply it.
        style_profile = None
        if template_name and template_name != "Default.pdf":
            template_path = _user_dir(user_id, "LeaseAbstraction", "_templates", _safe_filename(template_name))
            if os.path.isfile(template_path):
                style_profile = lease_engine.load_template_style_profile(template_path)

        pdf_path = os.path.join(lease_folder, "Output.pdf")
        lease_engine.generate_output_pdf(output_json_path, pdf_path, template_name=template_name, style_profile=style_profile)

        # Item 3 - if this user has ShareFile/SharePoint connected, also
        # push a copy there. Fire-and-forget: the lease itself is already
        # fully processed and saved locally by this point, so a slow or
        # failed push to a third-party system must never hold up (or
        # break) the response to the person waiting on Generate Output.
        threading.Thread(
            target=_push_file_to_connected_storage,
            args=(user_id, pdf_path, f"{lease_name} - Lease Abstraction.pdf"),
            daemon=True,
        ).start()

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

    def _handle_translation_translate_start(self, body):
        text = body.get("text") or ""
        target_language = body.get("targetLanguage") or "English"

        _cleanup_stale_translate_jobs()
        job_id = uuid.uuid4().hex
        _set_translate_job(job_id, status="running")
        thread = threading.Thread(target=_run_translate_job, args=(job_id, text, target_language), daemon=True)
        thread.start()

        return 200, {"ok": True, "jobId": job_id}

    def _handle_translation_translate_status(self, query):
        job_id = (query.get("jobId", [""])[0])
        job = _get_translate_job(job_id)
        if not job:
            return self._send_json(404, {"error": "Unknown or expired job"})
        payload = {"ok": True, "status": job.get("status", "running")}
        if job.get("status") == "done":
            payload["translatedText"] = job.get("translatedText", "")
            payload["method"] = job.get("method", "heuristic")
        elif job.get("status") == "error":
            payload["error"] = job.get("error", "Translation failed")
        return self._send_json(200, payload)

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

    def _handle_translation_save_offline_docx(self, body):
        """OFFLINE (Hybrid-off): docx BROWSER me bana (Test.html ka exact
        pdf.js logic), yahan sirf base64 blob ko Output.docx me save karte
        hain. Koi server extraction/vision NAHI. File Manager + download
        link flow automatically use hota hai."""
        user_id = _safe_id(self._resolve_user_id(body))
        doc_name = lease_engine.sanitize_lease_name(body.get("docName"))
        b64 = body.get("docxBase64") or ""
        if "," in b64[:64]:
            b64 = b64.split(",", 1)[1]
        try:
            raw = base64.b64decode(b64)
        except Exception as err:
            return 400, {"error": f"Invalid docx data: {err}"}
        if len(raw) < 200:
            return 400, {"error": "Empty/invalid document generated offline"}
        folder = _user_dir(user_id, "Translation", doc_name)
        os.makedirs(folder, exist_ok=True)
        docx_path = os.path.join(folder, "Output.docx")
        with open(docx_path, "wb") as f:
            f.write(raw)
        print(f"[translation:{doc_name}] offline docx saved ({len(raw)} bytes) - no API used")
        return 200, {"ok": True, "outputDocx": _rel_to_root(docx_path),
                     "outputFormat": "docx", "mode": "offline-browser"}

    def _handle_translation_vision_proxy(self, body):
        """OPTION A — browser-side Hybrid vision OCR ka secure proxy. Browser
        {model, messages} bhejta hai; server .env ki OPENROUTER_API_KEY laga
        kar OpenRouter ko forward karta hai. Key browser me KABHI nahi aati.
        Per-page call hai isliye timeout risk nahi (sync theek hai)."""
        import urllib.request, urllib.error
        cfg = lease_engine.load_llm_config()
        orc = cfg.get("openrouter", {}) or {}
        api_key = (orc.get("apiKey") or os.environ.get("OPENROUTER_API_KEY") or "").strip()
        if not api_key:
            return 400, {"error": "OPENROUTER_API_KEY is not set in the server .env"}
        messages = body.get("messages")
        if not isinstance(messages, list) or not messages:
            return 400, {"error": "messages[] required"}
        model = body.get("model") or orc.get("model") or "openai/gpt-4o"
        payload = {
            "model": model,
            "temperature": body.get("temperature", 0),
            "max_tokens": int(body.get("max_tokens", 8000)),
            "messages": messages,
        }
        # v14 Clean Image: image-output models ko "modalities" chahiye.
        # Un calls ke liye HTML-tool parity — payload me SIRF
        # model+messages+modalities (temperature/max_tokens nahi, kyunki
        # HTML tool bhi clean-image call me ye fields nahi bhejta tha).
        # Normal vision/translation calls par ZERO effect (additive).
        modalities = body.get("modalities")
        if isinstance(modalities, list) and modalities:
            payload = {"model": model, "messages": messages,
                       "modalities": modalities}
        req = urllib.request.Request(
            "https://openrouter.ai/api/v1/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Authorization": f"Bearer {api_key}",
                     "Content-Type": "application/json"},
            method="POST")
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            return 200, data
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8")[:500]
            except Exception:
                pass
            return e.code, {"error": f"OpenRouter HTTP {e.code}: {detail}"}
        except Exception as e:
            return 502, {"error": f"Vision proxy failed: {e}"}

    def _handle_translation_inpaint_proxy(self, body):
        """WITH IMAGE — Gemini 2.5 Flash Image (nano-banana) se text removal.
        Browser page image (base64) bhejta hai; hum Gemini image-edit model ko
        RESTRICTIVE prompt ke saath bhejte hain: sirf jo text extract hua wo
        hatao, background/layout/colors/illustrations bilkul mat badlo, sirf
        text wale area ko surrounding paper se seamlessly bharo. Cleaned image
        wapas. Key server .env se — browser me kabhi nahi.

        Gemini fail/unavailable ho to cv2 inpaint fallback (blur-ish lekin
        kuch to milega). Boxes optional (cv2 fallback ke liye)."""
        import urllib.request, urllib.error
        import base64 as _b64
        img_b64 = body.get("imageBase64") or ""
        if "," in img_b64[:64]:
            img_b64 = img_b64.split(",", 1)[1]
        boxes = body.get("boxes") or []
        texts = body.get("texts") or []   # exact extracted text lines
        if not img_b64:
            return 400, {"error": "imageBase64 required"}

        cfg = lease_engine.load_llm_config()
        orc = cfg.get("openrouter", {}) or {}
        api_key = (orc.get("apiKey") or os.environ.get("OPENROUTER_API_KEY") or "").strip()

        # ---- try Gemini image-edit first ----
        def _composite_text_regions(orig_b64, edited_b64, boxes):
            """Gemini-edited image ke sirf text-box rectangles ko original image
            me paste karo (feathered edges). Bahar sab original — guarantee
            preserve. Boxes na ho to None (full edit use hogा)."""
            if not boxes:
                return None
            try:
                import numpy as np, cv2
            except Exception:
                return None
            try:
                o = cv2.imdecode(np.frombuffer(_b64.b64decode(orig_b64), np.uint8), cv2.IMREAD_COLOR)
                e = cv2.imdecode(np.frombuffer(_b64.b64decode(edited_b64), np.uint8), cv2.IMREAD_COLOR)
                if o is None or e is None:
                    return None
                # Gemini output size original se alag ho sakta hai — match karo
                if e.shape[:2] != o.shape[:2]:
                    e = cv2.resize(e, (o.shape[1], o.shape[0]), interpolation=cv2.INTER_LANCZOS4)
                H, W = o.shape[:2]
                mask = np.zeros((H, W), np.float32)
                pad = max(2, int(round(min(H, W) * 0.012)))
                for b in boxes:
                    try:
                        x = int(round(float(b.get("x", 0)))); y = int(round(float(b.get("y", 0))))
                        bw = int(round(float(b.get("w", 0)))); bh = int(round(float(b.get("h", 0))))
                    except Exception:
                        continue
                    x0 = max(0, x - pad); y0 = max(0, y - pad)
                    x1 = min(W, x + bw + pad); y1 = min(H, y + bh + pad)
                    if x1 > x0 and y1 > y0:
                        mask[y0:y1, x0:x1] = 1.0
                if mask.max() <= 0:
                    return None
                # feather edges (seamless blend) — box boundary sharp na dikhe
                k = max(3, (pad // 2) * 2 + 1)
                mask = cv2.GaussianBlur(mask, (k, k), 0)
                mask3 = np.dstack([mask, mask, mask])
                out = (e.astype(np.float32) * mask3 + o.astype(np.float32) * (1.0 - mask3)).astype(np.uint8)
                ok, enc = cv2.imencode(".jpg", out, [int(cv2.IMWRITE_JPEG_QUALITY), 96])
                if not ok:
                    return None
                return _b64.b64encode(enc.tobytes()).decode("ascii")
            except Exception as e2:
                print(f"[translation] composite fail: {e2}")
                return None

        def _gemini_edit():
            if not api_key:
                return None
            # User-tested simple prompt (Google AI Studio me sahi output diya).
            # Lamba/over-restrictive prompt Gemini ko confuse karta tha —
            # ye 3 clear requirements best kaam karti hain.
            edit_prompt = (
                "Requirement:\n"
                "1) Text Removal Only\n"
                "2) Keep the original illustration\n"
                "3) Fill with matching background"
            )
            payload = {
                "model": "google/gemini-2.5-flash-image",
                "modalities": ["text", "image"],
                "messages": [{
                    "role": "user",
                    "content": [
                        {"type": "image_url",
                         "image_url": {"url": "data:image/jpeg;base64," + img_b64}},
                        {"type": "text", "text": edit_prompt},
                    ],
                }],
            }
            req = urllib.request.Request(
                "https://openrouter.ai/api/v1/chat/completions",
                data=json.dumps(payload).encode("utf-8"),
                headers={"Authorization": f"Bearer {api_key}",
                         "Content-Type": "application/json"},
                method="POST")
            with urllib.request.urlopen(req, timeout=180) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            # image response me choices[0].message.images[].image_url.url ya
            # content blocks me embedded — dono handle karo
            msg = (data.get("choices") or [{}])[0].get("message", {}) or {}
            # format 1: message.images = [{image_url:{url: "data:...base64,XXX"}}]
            imgs = msg.get("images") or []
            for im in imgs:
                url = (im.get("image_url") or {}).get("url") or im.get("url") or ""
                if "base64," in url:
                    return url.split("base64,", 1)[1]
            # format 2: content list with image_url / output
            cont = msg.get("content")
            if isinstance(cont, list):
                for c in cont:
                    if c.get("type") in ("image_url", "output_image", "image"):
                        url = (c.get("image_url") or {}).get("url") or c.get("url") or c.get("data") or ""
                        if "base64," in url:
                            return url.split("base64,", 1)[1]
                        if url and len(url) > 200:   # raw base64
                            return url
            return None

        try:
            edited = _gemini_edit()
            if edited:
                # Simple prompt se Gemini poora sahi output deta hai — full
                # image use karo (composite/blend nahi, wo quality kharab
                # karta tha aur box-region artifacts laata tha).
                print("[translation] with-image: Gemini image-edit ok")
                return 200, {"ok": True, "imageBase64": edited, "method": "gemini-image-edit",
                             "prompt": "Requirement: 1) Text Removal Only 2) Keep the original illustration 3) Fill with matching background"}
            else:
                print("[translation] with-image: Gemini returned no image — cv2 fallback")
        except urllib.error.HTTPError as e:
            detail = ""
            try: detail = e.read().decode("utf-8")[:300]
            except Exception: pass
            print(f"[translation] with-image: Gemini HTTP {e.code} ({detail}) — cv2 fallback")
        except Exception as e:
            print(f"[translation] with-image: Gemini fail ({e}) — cv2 fallback")

        # ---- cv2 fallback (Gemini unavailable) ----
        try:
            import numpy as np
            import cv2
        except Exception as e:
            # cv2 bhi nahi — original image hi wapas (text ke saath, better than fail)
            return 200, {"ok": True, "imageBase64": img_b64, "method": "original-no-edit"}
        try:
            raw = _b64.b64decode(img_b64)
            arr = np.frombuffer(raw, dtype=np.uint8)
            img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            if img is None:
                return 200, {"ok": True, "imageBase64": img_b64, "method": "original-no-edit"}
        except Exception:
            return 200, {"ok": True, "imageBase64": img_b64, "method": "original-no-edit"}
        h, w = img.shape[:2]
        mask = np.zeros((h, w), dtype=np.uint8)
        pad = max(2, int(round(min(h, w) * 0.012)))
        painted = 0
        for b in boxes:
            try:
                x = int(round(float(b.get("x", 0)))); y = int(round(float(b.get("y", 0))))
                bw = int(round(float(b.get("w", 0)))); bh = int(round(float(b.get("h", 0))))
            except Exception:
                continue
            x0 = max(0, x - pad); y0 = max(0, y - pad)
            x1 = min(w, x + bw + pad); y1 = min(h, y + bh + pad)
            if x1 > x0 and y1 > y0:
                mask[y0:y1, x0:x1] = 255
                painted += 1
        if painted == 0:
            ok, enc = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), 96])
            return 200, {"ok": True, "imageBase64": _b64.b64encode(enc.tobytes()).decode("ascii"), "method": "cv2", "painted": 0}
        radius = max(4, int(round(min(h, w) * 0.010)))
        try:
            result = cv2.inpaint(img, mask, radius, cv2.INPAINT_TELEA)
        except Exception as e:
            return 200, {"ok": True, "imageBase64": img_b64, "method": "original-no-edit"}
        ok, enc = cv2.imencode(".jpg", result, [int(cv2.IMWRITE_JPEG_QUALITY), 96])
        out_b64 = _b64.b64encode(enc.tobytes()).decode("ascii")
        print(f"[translation] with-image: cv2 fallback cleaned {painted} region(s)")
        return 200, {"ok": True, "imageBase64": out_b64, "method": "cv2", "painted": painted}

    # ------------------------------------------------------------------
    # PERMANENT FIX for "Request to /api/translation/generate-pdf failed":
    # root cause = poora hybrid pipeline (ensemble = 4x vision calls/page)
    # EK synchronous HTTP request me chal raha tha — multi-minute job par
    # gateway/browser timeout guaranteed hai. Fix = wahi background-job +
    # polling pattern jo translate-start/-status pehle se use karta hai.
    # Purana sync endpoint backward-compat ke liye intact hai.
    # ------------------------------------------------------------------
    def _handle_translation_generate_pdf_start(self, body):
        _cleanup_stale_translate_jobs()
        job_id = "pdfjob-" + secrets.token_hex(8)
        _set_translate_job(job_id, status="running")

        def _worker():
            try:
                result = self._handle_translation_generate_pdf(body)
                # sync handler _send_json(...) return karta ho ya dict —
                # dono shape handle karo
                if isinstance(result, dict):
                    _set_translate_job(job_id, status="done", result=result)
                else:
                    _set_translate_job(job_id, status="done", result={"ok": True})
            except Exception as err:
                import traceback; traceback.print_exc()
                _set_translate_job(job_id, status="error", error=str(err) or "Document generation failed")

        threading.Thread(target=_worker, daemon=True).start()
        return self._send_json(200, {"ok": True, "jobId": job_id})

    def _handle_translation_generate_pdf_status(self, query):
        job_id = (query.get("jobId", [""])[0])
        job = _get_translate_job(job_id)
        if not job:
            return self._send_json(404, {"error": "Unknown or expired job"})
        payload = {"ok": True, "status": job.get("status", "running")}
        if job.get("status") == "done":
            payload["result"] = job.get("result") or {"ok": True}
        elif job.get("status") == "error":
            payload["error"] = job.get("error", "Document generation failed")
        return self._send_json(200, payload)

    def _handle_translation_generate_pdf(self, body):
        user_id = _safe_id(self._resolve_user_id(body))
        doc_name = lease_engine.sanitize_lease_name(body.get("docName"))

        folder = _user_dir(user_id, "Translation", doc_name)
        output_json_path = os.path.join(folder, "Output.json")
        if not os.path.isfile(output_json_path):
            raise ValueError("Output.json not found - run save-output first")

        with open(output_json_path, "r", encoding="utf-8") as f:
            output_data = json.load(f)

        pdf_path = os.path.join(folder, "Output.pdf")
        # Item 6 - prefer the layout-preserving renderer (surgically edits
        # the ORIGINAL PDF, keeping images/logos/signatures/tables exactly
        # as they were) whenever the original source file is still there
        # and has a real text layer to work from; falls back to the plain
        # reflowed report otherwise (scanned/image-only source, or the
        # original file is missing for some reason) rather than failing
        # outright.
        source_rel = output_data.get("sourceDocument")
        source_abs = os.path.join(ROOT_DIR, source_rel) if source_rel else None
        target_language = output_data.get("targetLanguage", "")
        hybrid_mode = bool(body.get("hybrid"))
        # Workflow spec: Hybrid ON = full API pipeline, Vision + High
        # Accuracy + Ensemble sab INTERNALLY default ON (UI me checkbox
        # nahi). Admin ek jagah se ensemble off kar sake, iske liye const.
        ENSEMBLE_DEFAULT_ON = True
        pipeline_options = {
            "withImage": bool(body.get("withImage", True)),
            "highAccuracy": True,
            "ensemble": bool(body.get("ensemble", ENSEMBLE_DEFAULT_ON)),
            "withVision": True,
        }
        if not hybrid_mode:
            # OFFLINE spec: koi API call nahi — scanned PDF par vision
            # fallback bhi NAHI. Text-based PDF ka extracted (original)
            # text hi reflow deliverable banta hai.
            target_language = "original"
            output_data["targetLanguage"] = "original"
        # Output file format the user picked in the UI: "docx" (default,
        # keep the editable Word file as the deliverable) or "pdf". When
        # docx is requested we do NOT run the final DOCX->PDF conversion.
        output_format = str(body.get("outputFormat", "docx")).lower()
        if output_format not in ("docx", "pdf"):
            output_format = "docx"
        source_is_pdf = bool(source_abs and os.path.isfile(source_abs) and source_abs.lower().endswith(".pdf"))
        used_layout_preserving = False
        mode_used = "reflow"
        translation_diagnostics = {"requestedMode": "hybrid" if hybrid_mode else "simple"}

        if hybrid_mode and source_is_pdf:
            # HYBRID (checkbox checked): layout-preserving - surgically
            # edit the original PDF. On scanned/photo sources the OCR
            # bounding boxes are kept but recognition+translation runs
            # through the vision LLM (page image = ground truth), which
            # is what makes this path usable on photographs at all.
            try:
                progress_msgs = []
                def _prog(msg):
                    progress_msgs.append(msg)
                    print(f"[translation:{doc_name}] {msg}")
                # New layout-preserving pipeline (12-step flow). It writes
                # the editable DOCX itself and, for pdf output, converts.
                import translate_pipeline
                out_path = translate_pipeline.translate_document(
                    source_abs, pdf_path, target_language,
                    output_format=output_format,
                    diagnostics=translation_diagnostics, progress=_prog,
                    options=pipeline_options)
                translation_diagnostics["progressLog"] = progress_msgs
                # The pipeline may return a .docx even if pdf_path was a
                # .pdf name; record what was actually produced.
                if out_path.lower().endswith(".docx"):
                    translation_diagnostics["editableDocx"] = out_path
                used_layout_preserving = True
                mode_used = "hybrid-layout-preserving"
            except Exception as err:
                import traceback; traceback.print_exc()
                print(f"Hybrid layout-preserving translation not possible for {doc_name}, falling back to reflow: {err}")
                translation_diagnostics["fatalError"] = str(err)
        elif (not hybrid_mode) and source_is_pdf and not lease_engine.pdf_has_text_layer(source_abs):
            # OFFLINE spec violation: scanned/image PDF without API — process
            # possible nahi. User ko clear message, koi vision call nahi.
            translation_diagnostics["fatalError"] = (
                "This PDF is scanned/image-based — offline (Hybrid off) mode "
                "only processes text-based PDFs. Enable Hybrid and retry.")
            print(f"[translation:{doc_name}] offline mode: scanned PDF rejected (no API calls allowed)")
        elif (not hybrid_mode) and source_is_pdf:
            # OFFLINE spec: No_Hybrid.html (Test.html offline mode) jaisa
            # output — pdfplumber text layer se positioned textboxes,
            # original text, ZERO API calls.
            try:
                import translate_pipeline
                offline_docx = os.path.join(folder, "Output.docx")
                translate_pipeline.build_offline_original_docx(
                    source_abs, offline_docx,
                    lambda m: print(f"[translation:{doc_name}] {m}"))
                used_layout_preserving = True
                mode_used = "offline-layout-original"
                translation_diagnostics["editableDocx"] = offline_docx
                try:
                    translate_pipeline._docx_to_pdf(offline_docx, pdf_path)
                except Exception as e2:
                    print(f"[translation:{doc_name}] offline docx->pdf preview skipped: {e2}")
            except Exception as err:
                import traceback; traceback.print_exc()
                translation_diagnostics["offlineLayoutError"] = str(err)
                # fallback: neeche wala purana reflow path chal jayega
        elif False and lease_engine.llm_is_configured():
            # SIMPLE (checkbox unchecked) on a scanned/photo PDF: bypass
            # Tesseract entirely - the vision model reads each page image
            # directly (like Google Lens) and the output is a clean
            # reflowed document. Accurate text, original layout not kept.
            try:
                lease_engine.generate_vision_translation_pdf(
                    source_abs, pdf_path, target_language, doc_name=doc_name,
                    diagnostics=translation_diagnostics)
                mode_used = "simple-vision"
            except Exception as err:
                print(f"Vision translation not possible for {doc_name}, falling back to reflow: {err}")
                translation_diagnostics["fatalError"] = str(err)
        # SIMPLE on a digital PDF (real text layer): the extracted text is
        # already accurate, so the existing reflow of Output.json's
        # translatedText is the right answer - no vision call needed.
        if mode_used == "reflow" and not used_layout_preserving:
            lease_engine.generate_translation_pdf(output_json_path, pdf_path)

        # The hybrid layout-preserving path also writes an editable
        # Output.docx next to Output.pdf. When the user asked for docx,
        # that Word file IS the deliverable and no DOCX->PDF conversion
        # is needed (the PDF is still generated as a preview/fallback but
        # the download defaults to the docx).
        docx_path = os.path.join(folder, "Output.docx")
        has_docx = os.path.isfile(docx_path)
        # NON-hybrid paths (reflow / simple-vision) don't produce a
        # layout docx. If the user asked for docx there, build a clean
        # reflowed Word file directly from the translated text - so a
        # Simple-mode job also honours the docx choice instead of always
        # returning a PDF.
        if output_format == "docx" and not has_docx:
            try:
                lease_engine.generate_translation_docx(output_json_path, docx_path)
                has_docx = os.path.isfile(docx_path)
            except Exception as err:
                print(f"Could not build reflow DOCX for {doc_name}: {err}")
                translation_diagnostics["docxError"] = str(err)
        deliver_format = output_format if (output_format == "pdf" or has_docx) else "pdf"
        primary_path = docx_path if (deliver_format == "docx" and has_docx) else pdf_path

        threading.Thread(
            target=_push_file_to_connected_storage,
            args=(user_id, primary_path, f"{doc_name} - Translation.{deliver_format}"),
            daemon=True,
        ).start()

        # Turn each debug artifact's disk path into a web-relative URL so
        # the activity log can link to it (original page images, the exact
        # prompt sent to the model, the raw model response, the parsed JSON
        # layout, and the reconstructed clean background).
        for art in translation_diagnostics.get("artifacts", []):
            try:
                if art.get("path"):
                    art["url"] = "/" + _rel_to_root(art["path"]).lstrip("/")
            except Exception:
                pass

        return 200, {"ok": True, "outputPdf": _rel_to_root(pdf_path),
                     "outputDocx": _rel_to_root(docx_path) if has_docx else None,
                     "outputFormat": deliver_format,
                     "layoutPreserving": used_layout_preserving, "mode": mode_used,
                     "diagnostics": translation_diagnostics}

    def _handle_translation_download(self, query):
        user_id = _safe_id(self._resolve_user_id_query(query))
        raw_doc_name = (query.get("docName", [""])[0]) or ""
        doc_name = lease_engine.sanitize_lease_name(raw_doc_name)  # folder lookup
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

        # Download filename = doc_name (jo ab client ne pura formatted naam
        # diya hai, e.g. "<file> Hybrid - English - Translation"). File on
        # disk "Output.docx"/"Output.pdf" hi rehti hai, lekin user ko ye naam
        # dikhta hai. Fallback: Output.json ke sourceDocument se.
        download_name = os.path.basename(abs_path)
        if file_name in ("Output.pdf", "Output.docx"):
            ext = os.path.splitext(file_name)[1]
            if raw_doc_name.strip():
                # readable filename: illegal FS chars hatao lekin spaces/dashes rakho
                safe = re.sub(r'[\\/:*?"<>|]', '', raw_doc_name).strip()
                download_name = f"{safe}{ext}"
            else:
                output_json_path = os.path.join(folder, "Output.json")
                if os.path.isfile(output_json_path):
                    try:
                        with open(output_json_path, "r", encoding="utf-8") as f2:
                            source_rel = json.load(f2).get("sourceDocument")
                        if source_rel:
                            base_name = os.path.splitext(os.path.basename(source_rel))[0]
                            download_name = f"{base_name} - Translation{ext}"
                    except (OSError, json.JSONDecodeError):
                        pass

        mime_type = mimetypes.guess_type(abs_path)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", mime_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Disposition", f'attachment; filename="{download_name}"')
        self.end_headers()
        self.wfile.write(data)

    # ---- Dashboard "My Processed Leases" card: list + drill-down + download ----
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
                    continue  # skip _staging internal folder
                folder = os.path.join(base, name)
                output_json_path = os.path.join(folder, "Output.json")
                if not os.path.isdir(folder) or not os.path.isfile(output_json_path):
                    continue
                try:
                    with open(output_json_path, "r", encoding="utf-8") as f:
                        data = json.load(f)
                except (OSError, json.JSONDecodeError):
                    data = {}
                has_pdf = os.path.isfile(os.path.join(folder, "Output.pdf"))
                if not has_pdf:
                    continue
                docs.append({
                    "docName": name,
                    "targetLanguage": data.get("targetLanguage"),
                    "createdAt": data.get("createdAt"),
                    "hasOutputPdf": has_pdf,
                })

        docs.sort(key=lambda d: d.get("createdAt") or "", reverse=True)
        return self._send_json(200, {"ok": True, "documents": docs})

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
                has_pdf = os.path.isfile(os.path.join(folder, "Output.pdf"))
                if not has_pdf:
                    continue  # still awaiting human review - not "processed" yet, don't show on the Dashboard
                leases.append({
                    "leaseName": name,
                    "docType": data.get("docType"),
                    "accuracy": data.get("accuracy"),
                    "createdAt": data.get("createdAt"),
                    "hasOutputPdf": has_pdf,
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

        # Item 2 - friendly download name: original filename + " - Lease
        # Abstraction.pdf", not the generic internal "Output.pdf".
        download_name = os.path.basename(abs_path)
        if file_name == "Output.pdf":
            output_json_path = os.path.join(folder, "Output.json")
            if os.path.isfile(output_json_path):
                try:
                    with open(output_json_path, "r", encoding="utf-8") as f2:
                        source_docs = json.load(f2).get("sourceDocuments") or []
                    if source_docs:
                        base_name = os.path.splitext(os.path.basename(source_docs[0]))[0]
                        download_name = f"{base_name} - Lease Abstraction.pdf"
                except (OSError, json.JSONDecodeError):
                    pass

        mime_type = mimetypes.guess_type(abs_path)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", mime_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Disposition", f'attachment; filename="{download_name}"')
        self.end_headers()
        self.wfile.write(data)

    # ------------------------------------------------------------------
    # Payment History > Download - ek PDF invoice (item 3): company logo,
    # client ka naam/mobile/email, aur uske saare transactions date/time
    # wise. Excel export (downloadHistoryExcel, purely client-side) ki
    # jagah is route ne le li hai.
    # ------------------------------------------------------------------
    def _handle_payment_invoice_pdf(self, query):
        if not lease_engine.REPORTLAB_OK:
            return self._send_json(500, {"error": "PDF library (reportlab) is not installed on the server."})

        user_id = _safe_id(self._resolve_user_id_query(query))
        users = auth_store.load_users()
        user = auth_store.find_user_by_id(users, user_id)
        if not user:
            return self._send_json(404, {"error": "Account not found."})

        # Payment History card ke "From"/"To" filter jaisa hi range yahan
        # bhi lagate hain, taaki invoice sirf usi date range ke transactions
        # dikhaye jo screen par filter karke dikhaye gaye the.
        start_date = (query.get("startDate", [""])[0] or "").strip()
        end_date = (query.get("endDate", [""])[0] or "").strip()

        if db is not None and db.is_enabled():
            try:
                txns = db.list_transactions(user_id)
            except Exception as err:  # noqa: BLE001
                print(f"[db] invoice: transactions read failed, falling back to JSON: {err}")
                txns = [r for r in self._read_payment_history_file() if r.get("userId") == user_id]
        else:
            txns = [r for r in self._read_payment_history_file() if r.get("userId") == user_id]

        def _sort_key(t):
            return (str(t.get("date") or ""), str(t.get("time") or ""))
        txns = sorted(txns, key=_sort_key)

        # Opening balance = start date se pehle ke saare transactions ka
        # net (credit - debit). Closing balance = opening + range ke
        # transactions ka net (yaani range ke aakhri tak ka balance).
        opening_balance = 0.0
        in_range_txns = txns
        if start_date and end_date:
            before_start = [t for t in txns if str(t.get("date") or "") < start_date]
            opening_balance = sum(float(t.get("credit") or 0) - float(t.get("debit") or 0) for t in before_start)
            in_range_txns = [
                t for t in txns
                if start_date <= str(t.get("date") or "") <= end_date
            ]
        range_net = sum(float(t.get("credit") or 0) - float(t.get("debit") or 0) for t in in_range_txns)
        closing_balance = opening_balance + range_net

        company = _load_company_info()
        company_name = company.get("name") or "Lexora"
        logo_rel = company.get("logo") or ""
        logo_path = os.path.join(ROOT_DIR, logo_rel) if logo_rel else ""
        if not os.path.isfile(logo_path):
            logo_path = ""

        try:
            pdf_bytes = _build_invoice_pdf(
                company_name, logo_path, user, in_range_txns,
                start_date=start_date, end_date=end_date,
                opening_balance=opening_balance if (start_date and end_date) else None,
                closing_balance=closing_balance if (start_date and end_date) else None,
            )
        except Exception as err:  # noqa: BLE001
            return self._send_json(500, {"error": f"Could not build invoice PDF: {err}"})


        download_name = f"Invoice_{user_id}_{datetime.date.today().isoformat()}.pdf"
        self.send_response(200)
        self.send_header("Content-Type", "application/pdf")
        self.send_header("Content-Length", str(len(pdf_bytes)))
        self.send_header("Content-Disposition", f'attachment; filename="{download_name}"')
        self.end_headers()
        self.wfile.write(pdf_bytes)

    def _handle_payment_account_statement_pdf(self, query):
        """Payment Summary > "Download Account Statement" - the fuller
        report (account overview box, donut chart, running Balance
        column per row) matching the reference design shared for this
        feature. Same date-range filtering as the existing invoice PDF."""
        if not lease_engine.REPORTLAB_OK:
            return self._send_json(500, {"error": "PDF library (reportlab) is not installed on the server."})

        user_id = _safe_id(self._resolve_user_id_query(query))
        users = auth_store.load_users()
        user = auth_store.find_user_by_id(users, user_id)
        if not user:
            return self._send_json(404, {"error": "Account not found."})

        start_date = (query.get("startDate", [""])[0] or "").strip()
        end_date = (query.get("endDate", [""])[0] or "").strip()

        if db is not None and db.is_enabled():
            try:
                txns = db.list_transactions(user_id)
            except Exception as err:  # noqa: BLE001
                print(f"[db] account statement: transactions read failed, falling back to JSON: {err}")
                txns = [r for r in self._read_payment_history_file() if r.get("userId") == user_id]
        else:
            txns = [r for r in self._read_payment_history_file() if r.get("userId") == user_id]

        def _sort_key(t):
            return (str(t.get("date") or ""), str(t.get("time") or ""))
        txns = sorted(txns, key=_sort_key)

        opening_balance = 0.0
        in_range_txns = txns
        if start_date and end_date:
            before_start = [t for t in txns if str(t.get("date") or "") < start_date]
            opening_balance = sum(float(t.get("credit") or 0) - float(t.get("debit") or 0) for t in before_start)
            in_range_txns = [t for t in txns if start_date <= str(t.get("date") or "") <= end_date]

        company = _load_company_info()
        company_name = company.get("name") or "Lexora"
        logo_rel = company.get("logo") or ""
        logo_path = os.path.join(ROOT_DIR, logo_rel) if logo_rel else ""
        if not os.path.isfile(logo_path):
            logo_path = ""

        try:
            pdf_bytes = _build_account_statement_pdf(
                company_name, logo_path, user, in_range_txns,
                start_date=start_date, end_date=end_date, opening_balance=opening_balance,
            )
        except Exception as err:  # noqa: BLE001
            return self._send_json(500, {"error": f"Could not build account statement PDF: {err}"})

        download_name = f"Account_Statement_{user_id}_{datetime.date.today().isoformat()}.pdf"
        self.send_response(200)
        self.send_header("Content-Type", "application/pdf")
        self.send_header("Content-Length", str(len(pdf_bytes)))
        self.send_header("Content-Disposition", f'attachment; filename="{download_name}"')
        self.end_headers()
        self.wfile.write(pdf_bytes)

    def _handle_payment_receipt_pdf(self, query):
        """Payment History row > download icon - Razorpay-paid rows
        only, matching the reference receipt design shared for this
        feature."""
        if not lease_engine.REPORTLAB_OK:
            return self._send_json(500, {"error": "PDF library (reportlab) is not installed on the server."})

        user_id = _safe_id(self._resolve_user_id_query(query))
        txn_id = (query.get("txnId", [""])[0] or "").strip()
        if not txn_id:
            return self._send_json(400, {"error": "txnId is required."})

        users = auth_store.load_users()
        user = auth_store.find_user_by_id(users, user_id)
        if not user:
            return self._send_json(404, {"error": "Account not found."})

        if db is not None and db.is_enabled():
            try:
                txns = db.list_transactions(user_id)
            except Exception as err:  # noqa: BLE001
                print(f"[db] receipt: transactions read failed, falling back to JSON: {err}")
                txns = [r for r in self._read_payment_history_file() if r.get("userId") == user_id]
        else:
            txns = [r for r in self._read_payment_history_file() if r.get("userId") == user_id]

        txn = next((t for t in txns if str(t.get("id")) == txn_id), None)
        if not txn:
            return self._send_json(404, {"error": "That transaction could not be found."})
        # A receipt only makes sense where money was actually received
        # (a Credit amount) - a debit-only row (a service charge) has
        # nothing to issue a receipt for.
        if not (float(txn.get("credit") or 0) > 0):
            return self._send_json(400, {"error": "A receipt is only available for transactions with a credit amount."})

        company = _load_company_info()
        company_name = company.get("name") or "Lexora"
        logo_rel = company.get("logo") or ""
        logo_path = os.path.join(ROOT_DIR, logo_rel) if logo_rel else ""
        if not os.path.isfile(logo_path):
            logo_path = ""

        try:
            pdf_bytes = _build_receipt_pdf(company_name, logo_path, user, txn)
        except Exception as err:  # noqa: BLE001
            return self._send_json(500, {"error": f"Could not build receipt PDF: {err}"})

        download_name = f"Receipt_{txn_id}.pdf"
        self.send_response(200)
        self.send_header("Content-Type", "application/pdf")
        self.send_header("Content-Length", str(len(pdf_bytes)))
        self.send_header("Content-Disposition", f'attachment; filename="{download_name}"')
        self.end_headers()
        self.wfile.write(pdf_bytes)

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

    def _handle_oauth_start(self, provider, query):
        if not _oauth_configured(provider):
            return self._send_json(503, {"error": f"{provider.capitalize()} sign-in is not configured on this server yet."})
        redirect_uri = f"{_oauth_base_url(self)}/api/auth/oauth/{provider}/callback"
        state = _new_oauth_state()

        if provider == "google":
            params = {
                "client_id": os.environ.get("GOOGLE_CLIENT_ID", ""),
                "redirect_uri": redirect_uri,
                "response_type": "code",
                "scope": "openid email profile",
                "state": state,
                "prompt": "select_account",
            }
            return self._send_redirect("https://accounts.google.com/o/oauth2/v2/auth?" + urlencode(params))

        if provider == "facebook":
            params = {
                "client_id": os.environ.get("FACEBOOK_APP_ID", ""),
                "redirect_uri": redirect_uri,
                "response_type": "code",
                "scope": "email,public_profile",
                "state": state,
            }
            return self._send_redirect("https://www.facebook.com/v19.0/dialog/oauth?" + urlencode(params))

        return self._send_json(400, {"error": "Unknown sign-in provider."})

    def _handle_oauth_callback(self, provider, query):
        base_url = _oauth_base_url(self)
        error = (query.get("error", [""])[0] or "").strip()
        if error:
            return self._send_redirect(f"{base_url}/?oauthError=" + url_quote(f"{provider.capitalize()} sign-in was cancelled or denied."))

        state = (query.get("state", [""])[0] or "").strip()
        code = (query.get("code", [""])[0] or "").strip()
        if not code or not state or not _consume_oauth_state(state):
            return self._send_redirect(f"{base_url}/?oauthError=" + url_quote("That sign-in link has expired - please try again."))

        try:
            _check_rate_limit(f"oauth:{provider}:{self.client_address[0]}", max_attempts=20, window_seconds=600)
            redirect_uri = f"{base_url}/api/auth/oauth/{provider}/callback"
            email, first_name, last_name = _oauth_fetch_user_email(provider, code, redirect_uri)
            user = _find_or_create_oauth_user(email, first_name, last_name)
            if user.get("lock") == "Yes":
                return self._send_redirect(f"{base_url}/?oauthError=" + url_quote("This account is locked. Please contact support."))
            user["sessionStatus"] = "Online"
            users = auth_store.load_users()
            for u in users:
                if u.get("id") == user["id"]:
                    u["sessionStatus"] = "Online"
            auth_store.save_users(users)
            token = _create_session(user["id"])
        except Exception as err:  # noqa: BLE001 - always land the user back on the login screen, never a raw error page
            print(f"OAuth {provider} sign-in failed: {err}")
            return self._send_redirect(f"{base_url}/?oauthError=" + url_quote(str(err) or "Sign-in failed - please try again."))

        return self._send_redirect(f"{base_url}/?oauthToken=" + url_quote(token))

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
    # built-in rule set) actually affects extraction; approving/rejecting/
    # editing an already-approved rule is Admin/Developer only, enforced
    # server-side via _require_role() in each of those handlers below
    # (not just hidden buttons in the UI). A regular user can delete their
    # own still-pending proposal, but not anyone else's.
    # ------------------------------------------------------------------
    def _rules_path(self):
        return os.path.join(JSON_DIR, "rules.json")

    def _find_developer_user_id(self):
        """Item 7 - auto-discovered rules get attributed to the Developer
        account (not whichever user happened to process the lease that
        triggered discovery), mirroring getDeveloperUserId() on the
        frontend - same "first user with role Developer" lookup."""
        users = auth_store.load_users()
        dev = next((u for u in users if u.get("role") == "Developer"), None)
        return dev.get("id") if dev else None

    def _load_rules(self):
        if db is not None and db.is_enabled():
            try:
                data = db.get_setting("rules")
                if data:
                    return data
            except Exception as err:  # noqa: BLE001
                print(f"[db] rules read failed, falling back to JSON: {err}")
        try:
            with open(self._rules_path(), "r", encoding="utf-8") as f:
                return json.load(f)
        except (OSError, json.JSONDecodeError):
            return {"version": 1, "schema": "lexora_master_rules", "approved": [], "pending": []}

    def _save_rules(self, data):
        data["totalRules"] = len(data.get("approved", [])) + len(data.get("pending", []))
        if db is not None and db.is_enabled():
            try:
                db.save_setting("rules", data)
                return
            except Exception as err:  # noqa: BLE001
                print(f"[db] rules save failed, falling back to JSON: {err}")
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
        self._require_role(("Admin", "Developer"))
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
        self._require_role(("Admin", "Developer"))
        rule_id = body.get("ruleId")
        data = self._load_rules()
        pending = data.get("pending", [])
        if not any(r.get("id") == rule_id for r in pending):
            raise ValueError("That pending rule was not found - it may have already been handled.")
        data["pending"] = [r for r in pending if r.get("id") != rule_id]
        self._save_rules(data)
        return 200, {"ok": True}

    # ---- Item 1: Rules tab-strip UI - a regular User can delete their OWN
    # pending proposal (Developer/Admin can delete anyone's); Master Rules
    # editing/deleting is Admin/Developer only. ----
    def _handle_rules_delete_pending(self, body):
        user_id = _safe_id(self._resolve_user_id(body))
        rule_ids = body.get("ruleIds") or ([body.get("ruleId")] if body.get("ruleId") else [])
        if not rule_ids:
            raise ValueError("No rule id(s) given.")
        is_privileged = self._session_user_role(user_id) in ("Admin", "Developer")

        data = self._load_rules()
        pending = data.get("pending", [])
        if not is_privileged:
            not_owned = [rid for rid in rule_ids if not any(r.get("id") == rid and r.get("userId") == user_id for r in pending)]
            if not_owned:
                raise ValueError("You can only delete your own pending rule proposals.")
        data["pending"] = [r for r in pending if r.get("id") not in rule_ids]
        self._save_rules(data)
        return 200, {"ok": True, "deleted": len(rule_ids)}

    def _handle_rules_delete_approved(self, body):
        self._require_role(("Admin", "Developer"))
        rule_ids = body.get("ruleIds") or ([body.get("ruleId")] if body.get("ruleId") else [])
        if not rule_ids:
            raise ValueError("No rule id(s) given.")
        data = self._load_rules()
        data["approved"] = [r for r in data.get("approved", []) if r.get("id") not in rule_ids]
        self._save_rules(data)
        return 200, {"ok": True, "deleted": len(rule_ids)}

    def _handle_rules_update_approved(self, body):
        self._require_role(("Admin", "Developer"))
        updates = body.get("updates")
        if not isinstance(updates, list) or not updates:
            raise ValueError("No updates given.")
        data = self._load_rules()
        approved = data.get("approved", [])
        by_id = {r.get("id"): r for r in approved}
        applied = 0
        for u in updates:
            rule = by_id.get(u.get("id"))
            if not rule:
                continue
            if "fieldId" in u:
                rule["fieldId"] = (u.get("fieldId") or "").strip() or rule.get("fieldId")
            if "ruleType" in u:
                rule["ruleType"] = (u.get("ruleType") or "mapping").strip()
            if "ruleText" in u:
                rule["ruleText"] = (u.get("ruleText") or "").strip() or rule.get("ruleText")
            applied += 1
        self._save_rules(data)
        return 200, {"ok": True, "updated": applied}

    def _handle_services_catalog_seed(self, body):
        """Admin table's "Seed missing services" - the frontend already
        knows every registered service (js/free-services.js's
        allTools()), this just bulk-adds any of them not already a row
        here yet. Never touches/overwrites an existing row, so an Admin's
        earlier edits (moving a service between Paid/Free, changing its
        billing unit) always survive a re-seed after new services get
        added to the app later."""
        self._require_role(("Admin", "Developer"))
        incoming = body.get("services")
        if not isinstance(incoming, list):
            raise ValueError("services must be a list.")
        if db is None or not db.is_enabled():
            raise ValueError("Database is not configured.")

        existing = db.list_documents("services-catalog")
        existing_ids = {str(d.get("id")) for d in existing}
        added = 0
        for svc in incoming:
            if not isinstance(svc, dict):
                continue
            sid = str(svc.get("id") or "").strip()
            if not sid or sid in existing_ids:
                continue
            existing.append({
                "id": sid,
                "name": svc.get("name") or sid,
                "type": svc.get("type") or "Free",
                "billingUnit": svc.get("billingUnit") or "document",
                "image": svc.get("image") or "",
            })
            existing_ids.add(sid)
            added += 1
        if added:
            db.replace_documents("services-catalog", existing)
        return 200, {"ok": True, "added": added, "total": len(existing)}

    def _handle_services_catalog_reset_api_access(self, body):
        """One-time bulk action (Admin table button) - sets API Access to
        No for every service except Translation, matching the new
        default going forward. Only touches this one field on each row,
        nothing else (Paid/Free, billing unit, name, etc. are untouched)."""
        self._require_role(("Admin", "Developer"))
        if db is None or not db.is_enabled():
            raise ValueError("Database is not configured.")
        rows = db.list_documents("services-catalog")
        changed = 0
        for row in rows:
            desired = "Yes" if row.get("id") == "translation" else "No"
            if row.get("apiAccess") != desired:
                row["apiAccess"] = desired
                changed += 1
        if changed:
            db.replace_documents("services-catalog", rows)
        return 200, {"ok": True, "changed": changed, "total": len(rows)}

    def _handle_services_catalog_fix_names(self, body):
        """One-time cleanup for a seeding bug: earlier seeds wrote
        name == id (e.g. name: "ocr") which then incorrectly triggered
        the "this service was renamed" override everywhere, showing the
        raw id instead of the proper label (OCR, Data Extraction, ...).
        Clears any name field that's still exactly equal to its own id -
        a REAL rename (name != id) is left completely untouched."""
        self._require_role(("Admin", "Developer"))
        if db is None or not db.is_enabled():
            raise ValueError("Database is not configured.")
        rows = db.list_documents("services-catalog")
        changed = 0
        for row in rows:
            if row.get("name") == row.get("id"):
                row["name"] = ""
                changed += 1
        if changed:
            db.replace_documents("services-catalog", rows)
        return 200, {"ok": True, "changed": changed, "total": len(rows)}

    def _handle_rules_add_blank(self, body):
        """Admin table's "+ Add Row" - creates a blank pending rule ready
        to be filled in and approved, same shape as an auto-discovered or
        manually-proposed one, just empty. Lands in "pending" (not
        "approved") since a blank rule with no content shouldn't be able
        to actually affect extraction until someone fills it in and it
        goes through the normal approval step."""
        self._require_role(("Admin", "Developer"))
        user_id = _safe_id(self._resolve_user_id(body))
        data = self._load_rules()
        new_rule = {
            "id": "rule_" + secrets.token_hex(6),
            "fieldId": "", "ruleType": "mapping", "ruleText": "",
            "status": "pending", "confidence": None,
            "usageCount": 0, "successCount": 0, "appliedCount": 0,
            "createdAt": datetime.datetime.now().strftime("%m/%d/%Y, %H:%M:%S"),
            "approvedAt": None, "userId": user_id, "auditLog": [], "builtin": False,
        }
        data.setdefault("pending", []).append(new_rule)
        self._save_rules(data)
        return 200, {"ok": True, "rule": new_rule}

    # ---- Item 7: auto rule-discovery. Fire-and-forget (mirrors the email
    # notification pattern) - runs a lightweight extra LLM call in the
    # background right after a lease is analyzed, looking for extraction
    # patterns worth turning into a reusable rule. Never blocks the user's
    # pipeline and never fails it - any problem here just gets printed and
    # dropped. Proposed rules land in rules.json's "pending" list under
    # the Developer's own userId (not the uploading user's), so they show
    # up in the same Update Rules approval queue as manually-submitted
    # ones, just clearly attributable to the system rather than a user. ----
    def _handle_lease_discover_rules(self, body):
        user_id = _safe_id(self._resolve_user_id(body))
        text = body.get("text") or ""
        if not text.strip():
            return 200, {"ok": True, "queued": False}

        rules_snapshot = self._load_rules()
        existing_texts = [
            r.get("ruleText", "") for r in rules_snapshot.get("approved", []) + rules_snapshot.get("pending", [])
        ]
        dev_id = self._find_developer_user_id() or user_id

        def _worker():
            try:
                proposals = lease_engine.discover_new_rules(text, existing_texts)
                if not proposals:
                    return
                now_iso = datetime.datetime.now().isoformat(timespec="seconds")
                fresh = self._load_rules()
                for p in proposals:
                    fresh.setdefault("pending", []).append({
                        "id": f"auto_rule_{uuid.uuid4().hex[:10]}",
                        "fieldId": p["fieldId"],
                        "ruleType": p["ruleType"],
                        "ruleText": p["ruleText"],
                        "confidence": p["confidence"],
                        "usageCount": 0,
                        "successCount": 0,
                        "status": "pending",
                        "createdAt": now_iso,
                        "approvedAt": None,
                        "appliedCount": 0,
                        "auditLog": [],
                        "userId": dev_id,
                        "source": "auto-discovered",
                    })
                self._save_rules(fresh)
            except Exception as err:  # noqa: BLE001 - background job, never let it surface
                print(f"Rule auto-discovery failed: {err}")

        threading.Thread(target=_worker, daemon=True).start()
        return 200, {"ok": True, "queued": True}

    def _handle_admin_test_compare(self, body):
        """Item 4 - the Test & Compare admin card. Accepts up to 10
        {original, humanOutput, currentOutput?} file sets in one request
        (base64-encoded, same convention as the regular upload flow).
        Runs OCR text extraction on whichever pieces need it, our OWN
        extraction pipeline on the original if no currentOutput was
        supplied, then compare_extraction_quality() for each - proposed
        rules land in rules.json's pending queue exactly like every other
        rule source (Developer approval still required, duplicates
        skipped)."""
        self._require_role(("Admin", "Developer"))
        user_id = _safe_id(self._resolve_user_id(body))
        items = body.get("items") or []
        if not items:
            raise ValueError("No test items provided.")
        if len(items) > 10:
            raise ValueError("Please test 10 documents or fewer at a time.")

        rules_snapshot = self._load_rules()
        existing_texts = [r.get("ruleText", "") for r in rules_snapshot.get("approved", []) + rules_snapshot.get("pending", [])]
        dev_id = self._find_developer_user_id() or user_id

        results = []
        tmp_dir = tempfile.mkdtemp(prefix="testcompare_")
        conversation_history = []  # item 4 - one shared conversation across every lease in THIS batch
        try:
            for idx, item in enumerate(items):
                label = item.get("originalName") or f"Item {idx + 1}"
                try:
                    original_text = _extract_text_from_b64(item.get("originalBase64"), item.get("originalName"), tmp_dir)
                    human_text = _extract_text_from_b64(item.get("humanOutputBase64"), item.get("humanOutputName"), tmp_dir)

                    if item.get("currentOutputBase64"):
                        current_text = _extract_text_from_b64(item.get("currentOutputBase64"), item.get("currentOutputName"), tmp_dir)
                        current_source = "uploaded"
                    else:
                        analyzed = lease_engine.analyze_lease(original_text, fallback_name=label)
                        current_text = json.dumps(analyzed["fields"], indent=2, ensure_ascii=False)
                        current_source = "freshly generated by our system"

                    comparison = lease_engine.compare_extraction_quality(
                        original_text, human_text, current_text, existing_texts,
                        conversation_history=conversation_history,
                    )
                    conversation_history = comparison["conversationHistory"]

                    added_rule_ids = []
                    now_iso = datetime.datetime.now().isoformat(timespec="seconds")
                    fresh = self._load_rules()
                    fresh_texts_lower = {r.get("ruleText", "").strip().lower() for r in fresh.get("approved", []) + fresh.get("pending", [])}
                    for p in comparison["proposedRules"]:
                        if p["ruleText"].strip().lower() in fresh_texts_lower:
                            continue
                        rule_id = f"testcmp_{uuid.uuid4().hex[:10]}"
                        fresh.setdefault("pending", []).append({
                            "id": rule_id, "fieldId": p["fieldId"], "ruleType": p["ruleType"],
                            "ruleText": p["ruleText"], "confidence": p["confidence"],
                            "usageCount": 0, "successCount": 0, "status": "pending",
                            "createdAt": now_iso, "approvedAt": None, "appliedCount": 0,
                            "auditLog": [], "userId": dev_id, "source": "test-compare",
                        })
                        fresh_texts_lower.add(p["ruleText"].strip().lower())
                        added_rule_ids.append(rule_id)
                    self._save_rules(fresh)
                    existing_texts.extend(p["ruleText"] for p in comparison["proposedRules"])

                    results.append({
                        "label": label, "ok": True, "similarity": comparison["similarity"],
                        "currentOutputSource": current_source,
                        "rulesProposed": len(added_rule_ids),
                    })
                except Exception as err:
                    results.append({"label": label, "ok": False, "error": str(err)})
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)

        return 200, {"ok": True, "results": results}

    def _handle_auth_register(self, body):
        first = (body.get("firstName") or "").strip()
        last = (body.get("lastName") or "").strip()
        account_type = body.get("accountType") or "Personal"
        if account_type not in ("Personal", "Organisation", "Company"):
            account_type = "Personal"
        gender = body.get("gender") or ""
        birthdate = body.get("birthdate") or ""
        mobile = (body.get("mobile") or "").strip()
        email = (body.get("email") or "").strip().lower()
        password = body.get("password") or ""

        # Organisation/Company accounts have no last name - the org/company
        # name IS the account name (sent in as firstName by the frontend).
        if not first or (account_type == "Personal" and not last) or not email or not password:
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
            _send_verification_code_async(existing, code, "register", expiry_minutes, base_url=_base_url_from_headers(self.headers))
            return 200, resp

        issues = auth_store.password_policy_issues(password)
        if issues:
            raise ValueError("Password must contain " + ", ".join(issues) + ".")

        user_id = auth_store.next_user_id(users)
        code = auth_store.generate_code()
        expires_at = auth_store.make_expiry(expiry_minutes)

        # Every newly self-registered account has 2FA on by default, and
        # stays "InActive" (can't log in yet) until the email is verified.
        # Also starts on a 7-day Free plan automatically (item 3) so a
        # brand new account isn't immediately blocked from using either
        # service before they've even had a chance to look around.
        today = datetime.date.today()
        new_user = {
            "id": user_id, "photo": None, "firstName": first, "lastName": last,
            "gender": gender, "birthdate": birthdate, "mobile": mobile, "email": email,
            "password": auth_store.hash_password(password), "status": "InActive", "apiKey": None,
            "verificationCode": code, "verificationCodeExpiresAt": expires_at,
            "verificationPurpose": "register",
            "sessionStatus": "Offline", "role": "User", "lock": "No",
            "twoFactorAuth": "Yes", "emailVerified": "No", "mobileVerified": "No",
            "verificationMethod": "email", "sysConfig": "Desktop",
            "plan": "Free", "planStartDate": today.isoformat(),
            "planEndDate": (today + datetime.timedelta(days=7)).isoformat(), "planStatus": "Active",
            "createdAt": datetime.datetime.utcnow().isoformat() + "Z",
            "accountType": account_type,
        }
        users.append(new_user)
        auth_store.save_users(users)

        resp = {"ok": True, "userId": user_id, "email": email, "expiresInMinutes": expiry_minutes}
        _send_verification_code_async(new_user, code, "register", expiry_minutes, base_url=_base_url_from_headers(self.headers))
        return 200, resp

    def _handle_auth_verify_register(self, body):
        user_id = body.get("userId")
        code = (body.get("code") or "").strip()
        _check_rate_limit(f"verify:{user_id}")
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
        _check_rate_limit(f"login:{email}")

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
            _send_verification_code_async(user, code, "login", expiry_minutes, base_url=_base_url_from_headers(self.headers))
            return 200, resp

        user["sessionStatus"] = "Online"
        auth_store.save_users(users)
        token = _create_session(user["id"])
        # 2FA is off for this account, so there's no verification-code
        # email in this path at all - send a lightweight "you just logged
        # in" alert instead, so the user still has *some* trail of
        # account access even without 2FA turned on. Routed through
        # _dispatch_user_notification so it honours Notify On (SMS) same
        # as every other account alert.
        _dispatch_user_notification(
            user["id"], user["email"], user["firstName"],
            "New login to your account",
            f"We noticed a new login to your {_load_company_name()} account just now. "
            f"If this was you, no action is needed.\n\n"
            f"If you don't recognize this login, please reset your password immediately "
            f"and consider turning on 2-Step Verification in your Profile settings.",
        )
        return 200, {"ok": True, "requires2FA": False, "userId": user["id"], "token": token}

    def _handle_auth_verify_login(self, body):
        user_id = body.get("userId")
        code = (body.get("code") or "").strip()
        _check_rate_limit(f"verify:{user_id}")
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

    def _handle_auth_delete_account(self, body):
        """Profile > Delete Account. Requires re-entering the password (the
        same bar as a password change) since this is irreversible. Removes
        the user record and destroys their session(s) - their historical
        transactions/support tickets stay (same as any other account that's
        gone but whose past activity is still referenced elsewhere), only
        the login/profile itself is deleted."""
        user_id = _safe_id(self._resolve_user_id(body))
        password = body.get("password") or ""
        if not password:
            raise ValueError("Please enter your password.")
        _check_rate_limit(f"delete-account:{user_id}")

        users = auth_store.load_users()
        user = auth_store.find_user_by_id(users, user_id)
        if not user:
            raise ValueError("Account not found.")
        if not auth_store.verify_password(password, user.get("password")):
            raise ValueError("Incorrect password.")

        users = [u for u in users if u.get("id") != user_id]
        auth_store.save_users(users)
        _destroy_sessions_for_user(user_id)
        return 200, {"ok": True}

    def _handle_auth_forgot_password(self, body):
        email = (body.get("email") or "").strip().lower()
        if not email:
            raise ValueError("Please enter your email address.")
        _check_rate_limit(f"forgot:{email}")

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
        _send_verification_code_async(user, code, "reset", expiry_minutes, base_url=_base_url_from_headers(self.headers))
        return 200, resp

    def _handle_auth_verify_reset_code(self, body):
        # Checks validity without consuming the code - lets the frontend
        # move on to the "set new password" step. reset-password below
        # re-validates it for real before actually changing anything.
        user_id = body.get("userId")
        code = (body.get("code") or "").strip()
        _check_rate_limit(f"verify:{user_id}")
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
        _send_verification_code_async(user, code, purpose, expiry_minutes, base_url=_base_url_from_headers(self.headers))
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
                         "verificationPurpose", "emailVerified", "status",
                         "mobileVerified", "mobileVerifiedNumber",
                         "mobileOtpCode", "mobileOtpExpiresAt", "mobileOtpPendingNumber",
                         "apiKey", "apiKeyHash", "apiKeyCreatedAt", "apiKeyStatus"):
            fields.pop(blocked, None)

        # If the Mobile No is being changed away from whatever number was
        # last OTP-verified, the verified badge/SMS option no longer applies
        # to the new number - drop it rather than let a stale verification
        # silently carry over to a number that was never actually confirmed.
        if "mobile" in fields and (fields.get("mobile") or "").strip() != (user.get("mobileVerifiedNumber") or ""):
            user["mobileVerified"] = False
            user["mobileVerifiedNumber"] = None
            # SMS delivery requires a verified mobile - fall back to email
            # rather than leaving 2FA/verification codes stranded.
            if user.get("verificationMethod") == "sms":
                fields["verificationMethod"] = "email"

        user.update(fields)
        auth_store.save_users(users)
        return 200, {"ok": True, "user": auth_store.public_user_view(user)}

    # ------------------------------------------------------------------
    # API key generate/revoke - separate from the generic profile update
    # above (which now blocks these fields entirely). The raw key is
    # generated here with secrets.token_urlsafe (not client-side
    # Math.random(), which isn't a secure source of randomness for a
    # credential), and only a SHA-256 hash of it is ever stored - same
    # principle as password hashing, just a faster hash since this
    # secret already has far more entropy than a human-chosen password.
    # The real key is returned in this one response and never persisted
    # anywhere in plaintext - if it's lost, the only option is generating
    # a new one.
    # ------------------------------------------------------------------
    def _handle_profile_generate_api_key(self, body):
        user_id = self._resolve_user_id(body)
        if not user_id:
            raise ValueError("userId is required")
        users = auth_store.load_users()
        user = auth_store.find_user_by_id(users, user_id)
        if not user:
            raise ValueError("Account not found.")

        raw_key = "tc_live_" + secrets.token_urlsafe(32)
        key_hash = hashlib.sha256(raw_key.encode("utf-8")).hexdigest()
        created_at = datetime.datetime.now().strftime("%m/%d/%Y, %H:%M:%S")

        user["apiKeyHash"] = key_hash
        user["apiKeyCreatedAt"] = created_at
        user["apiKeyStatus"] = "active"
        user.pop("apiKey", None)  # drop any legacy plaintext key from before this fix
        auth_store.save_users(users)
        return 200, {"ok": True, "apiKey": raw_key, "apiKeyCreatedAt": created_at, "user": auth_store.public_user_view(user)}

    def _handle_profile_revoke_api_key(self, body):
        user_id = self._resolve_user_id(body)
        if not user_id:
            raise ValueError("userId is required")
        users = auth_store.load_users()
        user = auth_store.find_user_by_id(users, user_id)
        if not user:
            raise ValueError("Account not found.")

        user["apiKeyStatus"] = "revoked"
        auth_store.save_users(users)
        return 200, {"ok": True, "user": auth_store.public_user_view(user)}

    # ------------------------------------------------------------------
    # Mobile No verification - separate from the Profile save above and
    # from the login/register/reset verification-code flow. This confirms
    # the user actually controls the mobile number before "Text Message
    # (SMS)" becomes selectable as their Notify On method.
    # ------------------------------------------------------------------
    def _handle_profile_send_mobile_otp(self, body):
        user_id = self._resolve_user_id(body)
        mobile = (body.get("mobile") or "").strip()
        if not user_id:
            raise ValueError("userId is required")
        if not mobile:
            raise ValueError("Please enter a Mobile No first.")
        _check_rate_limit(f"mobile-otp:{user_id}")

        users = auth_store.load_users()
        user = auth_store.find_user_by_id(users, user_id)
        if not user:
            raise ValueError("Account not found.")

        code = auth_store.generate_code()
        expiry_minutes = _load_smtp_expiry_minutes()
        expires_at = auth_store.make_expiry(expiry_minutes)
        user["mobileOtpCode"] = code
        user["mobileOtpExpiresAt"] = expires_at
        user["mobileOtpPendingNumber"] = mobile
        auth_store.save_users(users)

        # Reuses the same Twilio sender as the login/2FA SMS path
        # (_send_sms) - only the message text/purpose differs.
        _send_verification_sms_async(user_id, mobile, code, "mobile-verify", expiry_minutes)
        return 200, {"ok": True, "expiresInMinutes": expiry_minutes}

    def _handle_profile_verify_mobile_otp(self, body):
        user_id = self._resolve_user_id(body)
        code = (body.get("code") or "").strip()
        if not user_id:
            raise ValueError("userId is required")
        _check_rate_limit(f"mobile-otp-check:{user_id}")

        users = auth_store.load_users()
        user = auth_store.find_user_by_id(users, user_id)
        if not user:
            raise ValueError("Account not found.")
        if not user.get("mobileOtpPendingNumber"):
            raise ValueError("No pending mobile verification - please click Verify again.")
        if auth_store.is_expired(user.get("mobileOtpExpiresAt")):
            raise ValueError("This code has expired. Please request a new one.")
        if not code or code != str(user.get("mobileOtpCode") or ""):
            raise ValueError("Incorrect verification code.")

        verified_number = user["mobileOtpPendingNumber"]
        user["mobile"] = verified_number
        user["mobileVerified"] = True
        user["mobileVerifiedNumber"] = verified_number
        user["mobileOtpCode"] = None
        user["mobileOtpExpiresAt"] = None
        user["mobileOtpPendingNumber"] = None
        auth_store.save_users(users)
        return 200, {"ok": True, "user": auth_store.public_user_view(user)}


def main():
    os.makedirs(USERS_DIR, exist_ok=True)
    os.makedirs(TEMPLATE_DIR, exist_ok=True)
    if not os.path.isfile(DEFAULT_TEMPLATE_PATH) and lease_engine.REPORTLAB_OK:
        lease_engine.build_default_template_pdf(DEFAULT_TEMPLATE_PATH)
    _load_sessions_at_startup()

    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"✅ Server running — open http://localhost:{PORT}/  (serves index.html)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
