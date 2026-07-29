#!/usr/bin/env python3
"""
User store + verification-code helpers for the login/registration/2FA system.

Keeps all direct users.json reads/writes and OTP-code logic in one place
so server.py's HTTP handlers stay focused on request/response plumbing.
"""

import base64
import datetime
import hashlib
import hmac
import json
import os
import random
import re
import secrets
import string

JSON_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "json")
USERS_PATH = os.path.join(JSON_DIR, "users.json")


# ============================================================
# Password hashing (PBKDF2-HMAC-SHA256, stdlib hashlib only - no bcrypt/
# argon2 dependency to install, works the same on every deployment target
# this project runs on: Codespaces, Docker/Render, a plain VPS). 600,000
# iterations matches OWASP's current PBKDF2-SHA256 recommendation.
# Stored as "pbkdf2_sha256$<iterations>$<salt_b64>$<hash_b64>" so the
# iteration count can be bumped later without breaking existing hashes.
# ============================================================
PBKDF2_ITERATIONS = 600_000


def hash_password(password):
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return "pbkdf2_sha256${}${}${}".format(
        PBKDF2_ITERATIONS,
        base64.b64encode(salt).decode("ascii"),
        base64.b64encode(digest).decode("ascii"),
    )


def verify_password(password, stored):
    """Returns True if password matches the stored hash. Also transparently
    accepts old plaintext values (pre-hashing migration / any record that
    somehow still has one) by falling back to a direct compare - so a
    half-migrated users.json never locks anyone out."""
    if not stored:
        return False
    if not stored.startswith("pbkdf2_sha256$"):
        # Legacy plaintext password - compare directly (constant-time).
        return hmac.compare_digest(password, stored)
    try:
        _, iterations, salt_b64, hash_b64 = stored.split("$", 3)
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(hash_b64)
    except (ValueError, TypeError):
        return False
    actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, int(iterations))
    return hmac.compare_digest(actual, expected)


def is_hashed(stored):
    return bool(stored) and stored.startswith("pbkdf2_sha256$")


# Postgres optional hai. DATABASE_URL na ho to sab kuch pehle jaisa
# users.json par chalta hai.
try:
    import db as _db
except Exception:  # noqa: BLE001
    _db = None


def _db_on():
    return _db is not None and _db.is_enabled()


def load_users():
    """Users padho - Postgres se agar configured hai, warna users.json se.

    server.py me load_users()/save_users() ke 27 call sites hain. Un sab ko
    badalne ki jagah sirf ye do functions badle gaye - isliye koi call site
    chhootne ka sawaal hi nahi, aur aadhi migration wala bug (write DB me,
    read file se) yahan ho hi nahi sakta.
    """
    if _db_on():
        try:
            return _db.list_users()
        except Exception as err:  # noqa: BLE001
            print(f"[db] users read failed, falling back to users.json: {err}")
    with open(USERS_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def save_users(users):
    if _db_on():
        try:
            _db.replace_users(users)
            return
        except Exception as err:  # noqa: BLE001
            print(f"[db] users save failed, falling back to users.json: {err}")
    with open(USERS_PATH, "w", encoding="utf-8") as f:
        json.dump(users, f, indent=4, ensure_ascii=False)
        f.write("\n")


def update_user_fields(user_id, fields):
    """Sirf kuch fields badlo, poori list nahi.

    DB par ye ek UPDATE hai - do requests ek saath aayein to dono apni
    field likhti hain aur koi doosre ka change nahi udata. JSON par wahi
    purana load-all/save-all hi hota hai (usme ye guarantee mumkin nahi).
    """
    if _db_on():
        try:
            return _db.update_user(user_id, fields)
        except Exception as err:  # noqa: BLE001
            print(f"[db] user update failed, falling back to file: {err}")

    users = load_users()
    user = find_user_by_id(users, user_id)
    if not user:
        return False
    user.update(fields)
    save_users(users)
    return True


def find_user_by_email(users, email):
    email = (email or "").strip().lower()
    if not email:
        return None
    for u in users:
        if (u.get("email") or "").strip().lower() == email:
            return u
    return None


def find_user_by_id(users, user_id):
    for u in users:
        if u.get("id") == user_id:
            return u
    return None


def next_user_id(users):
    nums = []
    for u in users:
        m = re.match(r"^U0*(\d+)$", u.get("id", ""))
        if m:
            nums.append(int(m.group(1)))
    n = (max(nums) + 1) if nums else 1
    return f"U{n:07d}"


def generate_code():
    return "".join(random.choices(string.digits, k=6))


def make_expiry(minutes):
    return (datetime.datetime.now() + datetime.timedelta(minutes=minutes)).isoformat(timespec="seconds")


def is_expired(expires_at_iso):
    if not expires_at_iso:
        return True
    try:
        return datetime.datetime.now() > datetime.datetime.fromisoformat(expires_at_iso)
    except ValueError:
        return True


def password_policy_issues(password):
    """Same rule set as the Profile page's client-side check (Section 13):
    8+ chars, 1 upper, 1 lower, 1 digit, 1 special char."""
    issues = []
    password = password or ""
    if len(password) < 8:
        issues.append("at least 8 characters")
    if not re.search(r"[A-Z]", password):
        issues.append("1 uppercase letter")
    if not re.search(r"[a-z]", password):
        issues.append("1 lowercase letter")
    if not re.search(r"[0-9]", password):
        issues.append("1 numeric digit")
    if not re.search(r"[^A-Za-z0-9]", password):
        issues.append("1 special character")
    return issues


# Fields that must NEVER be sent to the browser for anyone other than the
# account owner looking at their own record right after authenticating.
SENSITIVE_FIELDS = ("password", "verificationCode", "verificationCodeExpiresAt", "verificationPurpose",
                    "mobileOtpCode", "mobileOtpExpiresAt", "mobileOtpPendingNumber")


def public_user_view(user):
    """Strips every sensitive field - used nowhere sensitive is needed."""
    return {k: v for k, v in user.items() if k not in SENSITIVE_FIELDS}
