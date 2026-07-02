#!/usr/bin/env python3
"""
User store + verification-code helpers for the login/registration/2FA system.

Keeps all direct users.json reads/writes and OTP-code logic in one place
so server.py's HTTP handlers stay focused on request/response plumbing.
"""

import datetime
import json
import os
import random
import re
import string

JSON_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "json")
USERS_PATH = os.path.join(JSON_DIR, "users.json")


def load_users():
    with open(USERS_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def save_users(users):
    with open(USERS_PATH, "w", encoding="utf-8") as f:
        json.dump(users, f, indent=4, ensure_ascii=False)
        f.write("\n")


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
SENSITIVE_FIELDS = ("password", "verificationCode", "verificationCodeExpiresAt", "verificationPurpose")


def public_user_view(user):
    """Strips every sensitive field - used nowhere sensitive is needed."""
    return {k: v for k, v in user.items() if k not in SENSITIVE_FIELDS}
