# Security Review

Concrete findings from reading the actual code, not generic checklist
advice. Ordered by severity - the first two are real, exploitable gaps
worth fixing soon; the rest are lower-risk hardening items.

---

## 1. HIGH - Payment history and support tickets are readable by any logged-in user, not just their own

`/api/data/payment-history` and `/api/data/contact-submissions` (and, by
the same code path, `/api/data/lease-files`, `/api/data/translation-files`,
`/api/data/lease-activity-log`, `/api/data/translation-activity-log`) all
go through `_serve_resource()` in `py/server.py`, which only checks that
*some* valid user is logged in:

```python
def _serve_resource(self, name):
    try:
        self._authenticated_user_id()   # <- any logged-in user, any role
    except AuthError as err:
        return self._send_json(401, {"error": str(err)})
    ...
    return self._send_json(200, db.list_resource(name))   # <- ALL rows, every user
```

The "Admin/Developer sees everyone's data, regular users see only their
own" split is done entirely in the browser
(`isAdminOrDeveloper() ? paymentHistory.slice() : getMyPaymentHistory()`
in `js/app.js`). That's a UI filter, not a security boundary - any
authenticated regular user can call these endpoints directly (browser
devtools, curl with their own valid Bearer token) and get back every
other user's full transaction history and every support ticket on the
platform, including message contents.

**Fix:** filter server-side. `_serve_resource` and
`_handle_payment_history_get` should check the caller's role and, for
non-Admin/Developer users, filter to `user_id == caller` before
returning - the same logic that already exists in `js/app.js`, just moved
to the side that can't be bypassed. This is a contained fix (a handful of
functions in `py/server.py`) and worth prioritizing over everything else
in this document.

## 2. HIGH - API keys: weak generation + plaintext storage

`generateRandomKey()` in `js/app.js` builds the API key using
`Math.random()`, in the browser:

```javascript
function generateRandomKey() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let key = 'tc_live_';
    for (let i = 0; i < 32; i++) { key += chars.charAt(Math.floor(Math.random() * chars.length)); }
    return key;
}
```

Two separate problems here:

- `Math.random()` is not a cryptographically secure random source. It's
  fine for UI/animation randomness, not for anything security-sensitive
  like an API key - some JS engines' implementations are statistically
  distinguishable/predictable enough that this shouldn't be trusted for
  a credential.
- The key is also stored as a plain string on the user record
  (`profileData.apiKey`), same as it's shown to the user - so if the
  `users` table/JSON were ever exposed (a DB leak, a misconfigured
  backup, etc.), every live API key is immediately usable by whoever has
  it. Passwords in this same table are properly hashed
  (`pbkdf2_sha256`, see `auth_store.py`) - API keys should get the same
  treatment.

**Fix:**
- Generate the key **server-side** with `secrets.token_urlsafe(32)`
  (already used for session tokens in `_create_session` - same pattern,
  just reused here).
- Store only a hash of the key (e.g. SHA-256) in the user record; show
  the real key to the user once, at creation time, the same way most
  API platforms do (Stripe, GitHub, etc.) - after that, only the hash is
  ever compared against, never the plaintext.

## 3. MEDIUM - Sessions never expire or get cleaned up

`_create_session()` issues a `secrets.token_urlsafe(32)` token (good -
this part is solid) but there's no expiry timestamp on it and no
scheduled cleanup. A session is valid indefinitely until the user
explicitly logs out. Combined with tokens being stored in
`json/sessions.json` (or the DB), this means the longer the app runs,
the more permanently-valid tokens accumulate.

**Fix:** add an `expiresAt` to each session (e.g. 30 days of inactivity,
refreshed on each authenticated request) and a periodic sweep that
deletes expired ones - similar in spirit to the OTP `is_expired()` check
that already exists for verification codes.

## 4. MEDIUM - Rules approve/reject has no server-side role check

Documented candidly in the code's own comment
(`py/server.py`, near `_rules_path`):

> "approving/rejecting is meant for the Developer role, though...
> that's enforced by the UI only hiding the buttons from non-Developer
> users, not by a real server-side permission check."

Any authenticated user could call the approve/reject endpoint directly
and approve their own proposed extraction rule, bypassing the intended
review step.

**Fix:** add the same `_require_role(("Developer",))` check already used
consistently for `/api/admin/*` routes.

## 5. MEDIUM - Third-party credentials/tokens stored in plaintext

Twilio, SMTP, Razorpay credentials are (correctly) kept in environment
variables, not in the database - good. But per-user integration tokens
(if `EXTERNAL_STORAGE_INTEGRATION.md`'s SharePoint/Dropbox/ShareFile plan
is built) and any similar future per-user secret should be encrypted at
rest, not just relying on database access control. A simple approach:
encrypt with a server-held key (e.g. `cryptography.fernet`) before
writing to the `extra` JSONB / integrations table, decrypt only when
actually making the API call.

## 6. LOW - Rate limiting is in-memory only

`_check_rate_limit()` correctly protects login, OTP verification,
forgot-password, and mobile-OTP endpoints from brute-force - but the
counters live in a Python dict in the running process. A restart/deploy
resets everyone's rate-limit window, and if the app ever runs as more
than one process/worker (e.g. behind a load balancer with multiple
instances), each instance has its own independent counter, effectively
multiplying the allowed attempt rate. Not exploitable today (single
instance on Render), but worth moving to a shared store (a Postgres
table, or Redis) before scaling horizontally.

## 7. LOW - No account lockout after repeated failed logins

Rate limiting slows down brute-force attempts but there's no lockout
(e.g. "locked for 15 minutes after 5 failed attempts") independent of
the rate limiter - once the rate-limit window passes, attempts can
resume immediately. Consider combining the existing rate limit with an
explicit lockout flag on the user record after N consecutive failures,
requiring either a time-out or a password-reset to clear it.

## 8. LOW - Path traversal protections exist and look sound, worth a second pair of eyes

`_safe_filename()`, `_safe_admin_path()`, and `ADMIN_DOWNLOAD_BLOCKLIST`
are already in place for the Admin File Manager and file uploads
(profile photo, lease templates, staged documents) - this is good
practice already followed consistently. Not a finding so much as a note:
whenever a new file-accepting endpoint is added, make sure it routes
through `_safe_filename()`/`_user_dir()` the same way, rather than
building a path from user input directly.

## What's already solid (worth stating explicitly)

- Passwords: PBKDF2-SHA256 with a real salt, not plaintext or a fast
  hash (`auth_store.py`).
- Session tokens and OTP-adjacent job IDs: generated with `secrets`,
  not `random`/`Math.random()`.
- Sensitive fields (`password`, verification codes, mobile OTP codes)
  are consistently stripped before any user object reaches the browser,
  via a single `public_user_view()` used everywhere - a good pattern
  that avoids each endpoint having to remember to scrub fields itself.
- Rate limiting on the auth-sensitive endpoints (login, OTP checks,
  forgot-password) - just needs a shared backing store to survive
  multi-instance deployment (see item 6).
- No CORS headers are set, which is the safe default for a same-origin
  SPA (no accidental cross-origin exposure) - only relevant to revisit
  if/when the documented REST API needs to be called from a different
  origin.
