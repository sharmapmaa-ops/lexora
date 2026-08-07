"""PostgreSQL data layer - Step 1: the transactions table.

WHY THIS EXISTS
---------------
payment-history.json is read-modify-write:

    rows = json.load(f)      # 1. padho
    rows.append(entry)       # 2. badlo
    json.dump(rows, f)       # 3. likho

Do requests ek saath aayein to dono step 1 par same list padhte hain aur
step 3 par ek doosre ko overwrite kar dete hain - ek transaction chup-chaap
gum ho jata hai. Ek file lock ek process ke andar bachata hai, par Render
par jab do worker chalenge to wo bhi kaam nahi karega. Paise ke data ke
liye ye theek nahi hai.

Postgres me `INSERT` khud atomic hai aur balance ek hi SQL se nikalta hai,
to ye race condition hi khatam ho jati hai.

SAFE BY DEFAULT
---------------
DATABASE_URL set nahi hai to ye module "disabled" mode me rehta hai aur
server.py pehle jaisa hi JSON par chalta hai. Matlab ye file add karne se
aaj kuch nahi tootta - Postgres tab chalu hoga jab aap DATABASE_URL denge.

USAGE
-----
    import db
    db.init_schema()                 # startup par ek baar (no-op if disabled)
    if db.is_enabled():
        db.append_transaction(entry)
    else:
        ... purana JSON path ...
"""

import datetime
import decimal
import json
import os
import threading
import time
from urllib.parse import urlparse, parse_qsl, urlencode, urlunparse

# psycopg optional hai: requirements me hai, par agar install na ho (ya
# DATABASE_URL na ho) to app JSON par chalta rehna chahiye, crash nahi.
try:
    import psycopg
    from psycopg.rows import dict_row
    _PSYCOPG_ERROR = None
except Exception as err:  # noqa: BLE001
    psycopg = None
    dict_row = None
    _PSYCOPG_ERROR = err


DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()

_schema_lock = threading.Lock()
_schema_ready = False


def _effective_database_url():
    """DATABASE_URL with sslmode guaranteed to be set explicitly.

    This used to just trust the URL as-is because Render's own connection
    strings already include sslmode. That's a Render-specific assumption -
    AWS RDS/Aurora Postgres connection strings do NOT include it by
    default, so moving DATABASE_URL to an AWS endpoint without this would
    silently connect without SSL (or fail, depending on the instance's
    "Require SSL" setting). Local/loopback hosts are left alone since a
    local Postgres for dev usually isn't configured for SSL at all.
    """
    url = DATABASE_URL
    if not url:
        return url
    try:
        parsed = urlparse(url)
    except ValueError:
        return url
    if parsed.hostname in ("localhost", "127.0.0.1", "::1"):
        return url
    query = dict(parse_qsl(parsed.query))
    if "sslmode" not in query:
        query["sslmode"] = "require"
        parsed = parsed._replace(query=urlencode(query))
        url = urlunparse(parsed)
    return url


def is_enabled():
    """True tabhi jab DATABASE_URL bhi ho aur psycopg bhi import ho saka ho."""
    return bool(DATABASE_URL) and psycopg is not None


def why_disabled():
    """Insaani bhasha me wajah - startup log ke liye."""
    if not DATABASE_URL:
        return "DATABASE_URL is not set"
    if psycopg is None:
        return f"psycopg could not be imported ({_PSYCOPG_ERROR})"
    return ""


def connect():
    """Ek nayi connection. Caller `with` me use kare taaki commit/close ho.

    Works against any standard Postgres-compatible DATABASE_URL - Render,
    AWS RDS/Aurora, or a local instance - not just Render. SSL is ensured
    explicitly (see _effective_database_url) rather than assumed to
    already be in the URL.

    Ek retry (short backoff ke baad) hai kyunki managed Postgres
    (Render/AWS/etc) kabhi-kabhi ek connection attempt ko transiently
    reset/refuse kar deta hai (idle wake-up, brief network blip) - agla
    attempt usually turant successful hota hai. Bina isके, ye ek real
    intermittent connection hiccup poore page load ko "Unable to load
    data" dikha deta tha jab asal me sirf ek retry chahiye tha.
    """
    if not is_enabled():
        raise RuntimeError("Database is not configured: " + why_disabled())
    url = _effective_database_url()
    last_err = None
    for attempt in range(2):
        try:
            return psycopg.connect(url, row_factory=dict_row, connect_timeout=8)
        except Exception as err:  # noqa: BLE001 - retry once, then let the real error surface
            last_err = err
            if attempt == 0:
                time.sleep(0.4)
    raise last_err


# ============================================================
# Schema
# ============================================================
SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS transactions (
    -- txn_id wahi "TXN001" / "TXN-RZP-xxxx" hai jo UI dikhata hai.
    -- Primary key isi par hai, isliye ek hi Razorpay payment do baar
    -- verify ho jaye to bhi doosri baar row nahi banegi.
    txn_id              TEXT PRIMARY KEY,
    user_id             TEXT        NOT NULL,
    txn_date            DATE        NOT NULL,
    txn_time            TEXT        NOT NULL DEFAULT '',
    payment_type        TEXT        NOT NULL DEFAULT '',
    payment_mode        TEXT        NOT NULL DEFAULT '',
    description         TEXT        NOT NULL DEFAULT '',
    -- Paise NUMERIC me, FLOAT me nahi. Float me 0.1 + 0.2 != 0.3 hota
    -- hai aur balance dheere-dheere galat ho jata hai.
    credit              NUMERIC(14, 2) NOT NULL DEFAULT 0,
    debit               NUMERIC(14, 2) NOT NULL DEFAULT 0,
    status              TEXT        NOT NULL DEFAULT 'approved',
    razorpay_order_id   TEXT,
    razorpay_payment_id TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT credit_not_negative CHECK (credit >= 0),
    CONSTRAINT debit_not_negative  CHECK (debit  >= 0)
);

-- Har user ki history date ke hisab se nikalti hai - yahi sabse common query.
CREATE INDEX IF NOT EXISTS transactions_user_date_idx
    ON transactions (user_id, txn_date DESC, created_at DESC);

-- Ek Razorpay payment ke against sirf ek hi row bane. NULLs ignore hote
-- hain, isliye non-Razorpay rows par koi asar nahi.
CREATE UNIQUE INDEX IF NOT EXISTS transactions_rzp_payment_idx
    ON transactions (razorpay_payment_id)
    WHERE razorpay_payment_id IS NOT NULL;
"""


def init_schema():
    """Tables bana do (idempotent). Disabled ho to chup-chaap return."""
    global _schema_ready
    if not is_enabled() or _schema_ready:
        return False
    with _schema_lock:
        if _schema_ready:
            return False
        with connect() as conn:
            with conn.cursor() as cur:
                cur.execute(SCHEMA_SQL)
                cur.execute(NOTIFICATIONS_SCHEMA_SQL)
                cur.execute(USERS_SCHEMA_SQL)
                for resource in DOCUMENT_RESOURCES:
                    cur.execute(DOCUMENTS_SCHEMA_TEMPLATE.format(table=_doc_table(resource)))
                for name in SETTINGS_RESOURCES:
                    cur.execute(SETTINGS_SCHEMA_TEMPLATE.format(table=_settings_table(name)))
            conn.commit()
        _schema_ready = True
    return True


# ============================================================
# Row <-> JSON shape
#
# Frontend ka shape nahi badla ja sakta (app.js usi par chalta hai), to
# mapping yahin ek jagah rehti hai.
# ============================================================
def _to_number(value):
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def row_to_entry(row):
    entry = {
        "id": row["txn_id"],
        "date": row["txn_date"].isoformat() if row["txn_date"] else "",
        "time": row["txn_time"] or "",
        "userId": row["user_id"],
        "paymentType": row["payment_type"] or "",
        "paymentMode": row["payment_mode"] or "",
        "description": row["description"] or "",
        "credit": _to_number(row["credit"]),
        "debit": _to_number(row["debit"]),
    }
    # Ye fields sirf tab bhejte hain jab hain - JSON me bhi aise hi tha,
    # aur UI `status` na hone par "Success" maan leta hai.
    if row.get("status"):
        entry["status"] = row["status"]
    if row.get("razorpay_order_id"):
        entry["razorpayOrderId"] = row["razorpay_order_id"]
    if row.get("razorpay_payment_id"):
        entry["razorpayPaymentId"] = row["razorpay_payment_id"]
    return entry


def entry_to_params(entry):
    return {
        "txn_id": entry.get("id") or entry.get("txnId") or "",
        "user_id": entry.get("userId") or "",
        # txn_date NOT NULL hai, isliye khaali hone par aaj ki date.
        "txn_date": entry.get("date") or datetime.date.today().isoformat(),
        "txn_time": entry.get("time") or "",
        "payment_type": entry.get("paymentType") or "",
        "payment_mode": entry.get("paymentMode") or "",
        "description": entry.get("description") or "",
        "credit": _to_number(entry.get("credit")),
        "debit": _to_number(entry.get("debit")),
        "status": entry.get("status") or "approved",
        "razorpay_order_id": entry.get("razorpayOrderId") or None,
        "razorpay_payment_id": entry.get("razorpayPaymentId") or None,
    }


INSERT_SQL = """
INSERT INTO transactions (
    txn_id, user_id, txn_date, txn_time, payment_type, payment_mode,
    description, credit, debit, status, razorpay_order_id, razorpay_payment_id
) VALUES (
    %(txn_id)s, %(user_id)s, %(txn_date)s, %(txn_time)s, %(payment_type)s,
    %(payment_mode)s, %(description)s, %(credit)s, %(debit)s, %(status)s,
    %(razorpay_order_id)s, %(razorpay_payment_id)s
)
ON CONFLICT (txn_id) DO NOTHING
RETURNING *
"""

# Pehle yahan ek hi query thi:
#     WHERE (%(user_id)s IS NULL OR user_id = %(user_id)s)
# Postgres us par fail karta hai - "could not determine data type of
# parameter $1". Jab parameter sirf NULL se compare hota hai to usse type
# ka koi hint nahi milta. Do alag queries clear bhi hain aur is problem
# se bachti bhi hain.
SELECT_ALL_SQL = """
SELECT * FROM transactions
 ORDER BY txn_date DESC, created_at DESC
"""

SELECT_BY_USER_SQL = """
SELECT * FROM transactions
 WHERE user_id = %(user_id)s
 ORDER BY txn_date DESC, created_at DESC
"""

BALANCE_SQL = """
SELECT COALESCE(SUM(credit), 0) - COALESCE(SUM(debit), 0) AS balance
  FROM transactions
 WHERE user_id = %(user_id)s
"""


# ============================================================
# Public operations
# ============================================================
def append_transaction(entry):
    """Ek transaction likho. Dobara wahi txn_id aaye to kuch nahi hota.

    Lauta hua dict wahi shape hai jo frontend expect karta hai.
    """
    init_schema()
    params = entry_to_params(entry)
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(INSERT_SQL, params)
            row = cur.fetchone()
        conn.commit()
    # row None matlab ye txn_id pehle se tha (duplicate verify call).
    return row_to_entry(row) if row else dict(entry)


def list_transactions(user_id=None):
    init_schema()
    with connect() as conn:
        with conn.cursor() as cur:
            if user_id:
                cur.execute(SELECT_BY_USER_SQL, {"user_id": user_id})
            else:
                cur.execute(SELECT_ALL_SQL)
            rows = cur.fetchall()
    return [row_to_entry(r) for r in rows]


def get_balance(user_id):
    """Balance ek hi SQL se - poori history browser me bhejne ki zaroorat nahi."""
    init_schema()
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(BALANCE_SQL, {"user_id": user_id})
            row = cur.fetchone()
    return _to_number(row["balance"]) if row else 0.0


# ============================================================
# NOTIFICATIONS
#
# Shape: {id, userId, date, time, description, read} + optional meta
# ({type, transactionId, handledResult, ...}). Meta khula-dhula hai,
# isliye wo JSONB column me jata hai - naya field aaye to schema badalna
# nahi padega.
# ============================================================
NOTIFICATIONS_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS notifications (
    notif_id    TEXT PRIMARY KEY,
    user_id     TEXT        NOT NULL,
    notif_date  DATE        NOT NULL,
    notif_time  TEXT        NOT NULL DEFAULT '',
    description TEXT        NOT NULL DEFAULT '',
    is_read     BOOLEAN     NOT NULL DEFAULT FALSE,
    meta        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_user_idx
    ON notifications (user_id, notif_date DESC, created_at DESC);
"""

# Ye keys column me jaati hain; baaki sab meta JSONB me chali jaati hain.
_NOTIF_CORE = {"id", "userId", "date", "time", "description", "read"}


def notif_row_to_entry(row):
    entry = {
        "id": row["notif_id"],
        "userId": row["user_id"],
        "date": row["notif_date"].isoformat() if row["notif_date"] else "",
        "time": row["notif_time"] or "",
        "description": row["description"] or "",
        "read": bool(row["is_read"]),
    }
    meta = row.get("meta") or {}
    if isinstance(meta, dict):
        entry.update(meta)
    return entry


def notif_entry_to_params(entry):
    meta = {k: v for k, v in entry.items() if k not in _NOTIF_CORE}
    return {
        "notif_id": entry.get("id") or "",
        "user_id": entry.get("userId") or "",
        "notif_date": entry.get("date") or datetime.date.today().isoformat(),
        "notif_time": entry.get("time") or "",
        "description": entry.get("description") or "",
        "is_read": bool(entry.get("read")),
        "meta": json.dumps(meta),
    }


NOTIF_INSERT_SQL = """
INSERT INTO notifications (
    notif_id, user_id, notif_date, notif_time, description, is_read, meta
) VALUES (
    %(notif_id)s, %(user_id)s, %(notif_date)s, %(notif_time)s,
    %(description)s, %(is_read)s, %(meta)s::jsonb
)
ON CONFLICT (notif_id) DO UPDATE SET
    is_read     = EXCLUDED.is_read,
    description = EXCLUDED.description,
    meta        = EXCLUDED.meta
"""

NOTIF_SELECT_SQL = """
SELECT * FROM notifications ORDER BY notif_date DESC, created_at DESC
"""


def list_notifications():
    init_schema()
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(NOTIF_SELECT_SQL)
            rows = cur.fetchall()
    return [notif_row_to_entry(r) for r in rows]


def replace_notifications(rows):
    """Poori list save karo - browser hamesha poora array bhejta hai.

    Sab kuch EK transaction me: purani rows hatti hain aur nayi aati hain,
    ya kuch nahi hota. Beech me koi aadhi list nahi dekh sakta - JSON file
    me yahi sabse bada khatra tha.
    """
    init_schema()
    keep = [r for r in rows if isinstance(r, dict) and r.get("id")]
    with connect() as conn:
        with conn.cursor() as cur:
            ids = [r["id"] for r in keep]
            if ids:
                cur.execute(
                    "DELETE FROM notifications WHERE notif_id <> ALL(%(ids)s)",
                    {"ids": ids},
                )
            else:
                cur.execute("DELETE FROM notifications")
            for entry in keep:
                cur.execute(NOTIF_INSERT_SQL, notif_entry_to_params(entry))
        conn.commit()
    return len(keep)


# ============================================================
# USERS - proper columns
#
# EK ZAROORI BAAT: is app me "boolean" fields sach me STRING hain -
# emailVerified/lock/mobileVerified/twoFactorAuth me "Yes"/"No" aata hai,
# True/False nahi. Poora Python aur JS code `== "Yes"` check karta hai.
# Isliye ye columns BOOLEAN nahi, TEXT hain aur value bilkul waisi ki
# waisi rehti hai. Type badalna alag refactor hai - usse yahan mila dena
# chhupe hue bugs paida karta.
#
# None (JSON ka null) NULL banta hai aur wapas None hi milta hai, taaki
# round-trip exact rahe.
# ============================================================
USERS_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS users (
    user_id                      TEXT PRIMARY KEY,
    email                        TEXT NOT NULL,
    password                     TEXT NOT NULL DEFAULT '',
    first_name                   TEXT,
    last_name                    TEXT,
    gender                       TEXT,
    birthdate                    TEXT,
    mobile                       TEXT,
    photo                        TEXT,
    role                         TEXT NOT NULL DEFAULT 'User',
    status                       TEXT NOT NULL DEFAULT 'Active',
    is_locked                    TEXT,
    email_verified               TEXT,
    mobile_verified              TEXT,
    two_factor_auth              TEXT,
    session_status               TEXT,
    plan                         TEXT,
    plan_status                  TEXT,
    plan_start_date              TEXT,
    plan_end_date                TEXT,
    api_key                      TEXT,
    verification_code            TEXT,
    verification_code_expires_at TEXT,
    verification_purpose         TEXT,
    razorpay_customer_id         TEXT,
    sys_config                   TEXT,
    -- Koi bhi field jo upar column me nahi hai, taaki naya field add
    -- karne par data chup-chaap gum na ho.
    extra                        JSONB NOT NULL DEFAULT '{}'::jsonb,
    position                     INTEGER NOT NULL DEFAULT 0,
    updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Duplicate email ab DB hi rok dega. Pehle sirf Python code rokta tha,
-- aur do register requests ek saath aa jayein to wo bach nikalti thi.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (LOWER(email));
"""

# JSON field  <->  column
_USER_COLUMNS = (
    ("id", "user_id"),
    ("email", "email"),
    ("password", "password"),
    ("firstName", "first_name"),
    ("lastName", "last_name"),
    ("gender", "gender"),
    ("birthdate", "birthdate"),
    ("mobile", "mobile"),
    ("photo", "photo"),
    ("role", "role"),
    ("status", "status"),
    ("lock", "is_locked"),
    ("emailVerified", "email_verified"),
    ("mobileVerified", "mobile_verified"),
    ("twoFactorAuth", "two_factor_auth"),
    ("sessionStatus", "session_status"),
    ("plan", "plan"),
    ("planStatus", "plan_status"),
    ("planStartDate", "plan_start_date"),
    ("planEndDate", "plan_end_date"),
    ("apiKey", "api_key"),
    ("verificationCode", "verification_code"),
    ("verificationCodeExpiresAt", "verification_code_expires_at"),
    ("verificationPurpose", "verification_purpose"),
    ("razorpayCustomerId", "razorpay_customer_id"),
    ("sysConfig", "sys_config"),
)

_USER_JSON_KEYS = {j for j, _ in _USER_COLUMNS}


def user_row_to_entry(row):
    entry = {}
    for json_key, col in _USER_COLUMNS:
        entry[json_key] = row.get(col)
    extra = row.get("extra") or {}
    if isinstance(extra, dict):
        entry.update(extra)
    # Jo fields JSON me the hi nahi, unhe wapas mat bhejo - warna
    # public_user_view aur frontend ko naye null fields dikhne lagenge.
    return {k: v for k, v in entry.items() if v is not None or k in ("photo",
            "verificationCode", "verificationCodeExpiresAt", "verificationPurpose")}


def user_entry_to_params(entry, position=0):
    params = {"position": position}
    for json_key, col in _USER_COLUMNS:
        params[col] = entry.get(json_key)
    params["email"] = params["email"] or ""
    params["password"] = params["password"] or ""
    params["role"] = params["role"] or "User"
    params["status"] = params["status"] or "Active"
    params["extra"] = json.dumps(
        {k: v for k, v in entry.items() if k not in _USER_JSON_KEYS}
    )
    return params


_USER_COLS = [c for _, c in _USER_COLUMNS]

USER_UPSERT_SQL = """
INSERT INTO users ({cols}, extra, position)
VALUES ({vals}, %(extra)s::jsonb, %(position)s)
ON CONFLICT (user_id) DO UPDATE SET
    {updates},
    extra = EXCLUDED.extra,
    position = EXCLUDED.position,
    updated_at = now()
""".format(
    cols=", ".join(_USER_COLS),
    vals=", ".join(f"%({c})s" for c in _USER_COLS),
    updates=",\n    ".join(f"{c} = EXCLUDED.{c}" for c in _USER_COLS if c != "user_id"),
)

USERS_SELECT_SQL = "SELECT * FROM users ORDER BY position, user_id"


def list_users():
    init_schema()
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(USERS_SELECT_SQL)
            rows = cur.fetchall()
    return [user_row_to_entry(r) for r in rows]


def replace_users(rows):
    """Poori list save karo - auth_store.save_users() ka seedha replacement.

    Sab kuch EK transaction me, isliye beech me koi aadhi user list nahi
    dekh sakta.
    """
    init_schema()
    clean = [r for r in rows if isinstance(r, dict) and r.get("id")]
    with connect() as conn:
        with conn.cursor() as cur:
            ids = [r["id"] for r in clean]
            if ids:
                cur.execute("DELETE FROM users WHERE user_id <> ALL(%(ids)s)", {"ids": ids})
            else:
                cur.execute("DELETE FROM users")
            for i, entry in enumerate(clean):
                cur.execute(USER_UPSERT_SQL, user_entry_to_params(entry, i))
        conn.commit()
    return len(clean)


def update_user(user_id, fields):
    """Sirf di hui fields badlo - ek row, ek UPDATE.

    Ye load-all/save-all se behtar hai: do requests ek saath aayein to
    dono apni-apni field likhti hain, koi doosre ka change nahi udata.
    Login (sessionStatus) aur profile update jaise hot paths ke liye.
    """
    init_schema()
    mapping = dict(_USER_COLUMNS)
    sets, params = [], {"user_id": user_id}
    extra = {}
    for key, value in (fields or {}).items():
        col = mapping.get(key)
        if col and col != "user_id":
            sets.append(f"{col} = %({col})s")
            params[col] = value
        elif not col:
            extra[key] = value

    if extra:
        sets.append("extra = extra || %(extra_patch)s::jsonb")
        params["extra_patch"] = json.dumps(extra)
    if not sets:
        return False

    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE users SET {', '.join(sets)}, updated_at = now()"
                " WHERE user_id = %(user_id)s",
                params,
            )
            changed = cur.rowcount
        conn.commit()
    return changed > 0


# ============================================================
# GENERIC DOCUMENT TABLE - chhoti list-type resources ke liye
#
# transactions ke liye maine asli columns banaye - wahan paise hain,
# NUMERIC chahiye, CHECK constraints chahiye, aur SUM() query karni hai.
#
# Ye teen (plan-history, payment-methods, contact-submissions)
# alag maamla hain:
#   * chhoti aur kam-likhi jaane wali hain
#   * do to abhi bilkul khaali hain - unka schema maine guess karna padta
#   * inpar koi column-wise query nahi chalti, poori list load hoti hai
# Inhe JSONB me rakhna imaandari hai: jo faayda chahiye (ek source of
# truth + atomic write) wo poora milta hai, aur galat guess kiya hua
# schema baad me badalna nahi padta.
#
# TRADE-OFF (jaan-bujh kar): column-level CHECK constraints nahi milte
# aur SQL me `WHERE data->>'status' = 'active'` likhna padta hai. Kabhi
# kisi resource par asli query zaroorat bane, tab uske liye transactions
# jaisa proper table bana lena - registry ki wajah se wo change chhota hai.
# ============================================================
DOCUMENTS_SCHEMA_TEMPLATE = """
CREATE TABLE IF NOT EXISTS {table} (
    doc_id     TEXT        PRIMARY KEY,
    position   INTEGER     NOT NULL DEFAULT 0,
    user_id    TEXT,
    data       JSONB       NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
"""


def _doc_table(resource):
    """json/plan-history.json -> table doc_plan_history, waghera - har
    JSON resource ki apni table (naam fixed registry se aata hai, kabhi
    user input se nahi, isliye seedha SQL me daalna safe hai)."""
    return "doc_" + resource.replace("-", "_")


def _doc_id(entry, index):
    """id / key / _id me se jo mile. Kuch na mile to position se bana do -
    warna bina id wali rows chup-chaap gum ho jaengi."""
    for field in ("id", "key", "_id"):
        value = entry.get(field)
        if value not in (None, ""):
            return str(value)
    return f"row-{index + 1:05d}"


def list_documents(resource):
    table = _doc_table(resource)
    init_schema()
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(f"SELECT data FROM {table} ORDER BY position, doc_id")
            rows = cur.fetchall()
    return [r["data"] for r in rows]


def replace_documents(resource, rows):
    """Poori list ek transaction me. JSON array ka order `position` se
    bacha rehta hai - warna list har reload par phir se shuffle ho jati."""
    table = _doc_table(resource)
    init_schema()
    clean = [r for r in rows if isinstance(r, dict)]
    with connect() as conn:
        with conn.cursor() as cur:
            ids = [_doc_id(r, i) for i, r in enumerate(clean)]
            if ids:
                cur.execute(
                    f"DELETE FROM {table} WHERE doc_id <> ALL(%(ids)s)",
                    {"ids": ids},
                )
            else:
                cur.execute(f"DELETE FROM {table}")
            for i, entry in enumerate(clean):
                cur.execute(
                    f"INSERT INTO {table} (doc_id, position, user_id, data)"
                    f" VALUES (%(doc_id)s, %(position)s, %(user_id)s, %(data)s::jsonb)"
                    f" ON CONFLICT (doc_id) DO UPDATE SET"
                    f"     position = EXCLUDED.position,"
                    f"     user_id  = EXCLUDED.user_id,"
                    f"     data     = EXCLUDED.data,"
                    f"     updated_at = now()",
                    {
                        "doc_id": ids[i],
                        "position": i,
                        "user_id": entry.get("userId") or None,
                        "data": json.dumps(entry),
                    },
                )
        conn.commit()
    return len(clean)


# ============================================================
# Singleton/object JSON files (menu-config.json, company.json, waghera) -
# har ek ki apni table, ek hi row (id=1), poora object JSONB me.
# ============================================================
SETTINGS_SCHEMA_TEMPLATE = """
CREATE TABLE IF NOT EXISTS {table} (
    id         SMALLINT PRIMARY KEY DEFAULT 1,
    data       JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (id = 1)
);
"""


def _settings_table(name):
    return "cfg_" + name.replace("-", "_")


def get_setting(name):
    """Ek settings object wapas karta hai, ya None agar abhi tak save nahi hui."""
    if name not in SETTINGS_RESOURCES:
        raise ValueError(f"Unknown setting: {name}")
    table = _settings_table(name)
    init_schema()
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(f"SELECT data FROM {table} WHERE id = 1")
            row = cur.fetchone()
    return row["data"] if row else None


def save_setting(name, data):
    """Poora object upsert karta hai (delete + insert nahi, seedha replace)."""
    if name not in SETTINGS_RESOURCES:
        raise ValueError(f"Unknown setting: {name}")
    table = _settings_table(name)
    init_schema()
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"INSERT INTO {table} (id, data) VALUES (1, %(data)s::jsonb)"
                f" ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()",
                {"data": json.dumps(data)},
            )
        conn.commit()
    return True


# ============================================================
# Resource registry
#
# server.py sirf ye do function call karta hai. Nayi JSON file DB par
# laani ho to yahan ek line add karni hai, server.py chhedna nahi padta.
# ============================================================
# JSONB document table par chalne wali resources.
#
# "api-keys" yahan se hata di gayi hai (item 1.09) - key ab har user ke
# apne record par (users.api_key) rehti hai, alag table ki zaroorat nahi.
DOCUMENT_RESOURCES = (
    "plan-history", "payment-methods", "contact-submissions",
    # Job state. Inme sirf metadata hai - asli PDF blobs browser ki memory
    # me rehte hain (translationFileBlobs / leaseFileBlobs) aur kabhi save
    # nahi hote, isliye rows chhoti hi rehti hain.
    "lease-files", "translation-files",
    "lease-activity-log", "translation-activity-log",
    # Plans list (json/plans.json tha) - array of plan objects, id field
    # hi document pattern ke liye kaafi hai.
    "plans",
    # Services catalog (item 3, Plans & Offers admin) - one row per
    # service (paid + free, ~60 total), lets Admin move a service between
    # Free/Paid and set its billing unit from the Admin table instead of
    # that being hardcoded in js/free-services.js's GROUPS list. Frontend
    # reads this at boot (js/app.js loadAppData -> SERVICES_CATALOG) and
    # falls back to the old hardcoded classification for any service not
    # yet present here, so an empty/partial table never hides a service.
    "services-catalog",
    # System Configurations (item 15) - the list of storage systems
    # (Dropbox, Google Drive, ...) offered in any service's "System
    # Configuration" dropdown, admin-manageable instead of a hardcoded
    # list. The dropdown itself only shows on a service at all when
    # that service's Services Catalog row has systemConfig=Yes.
    "system-configs",
    # Messaging Settings (item 1) - per-event Yes/No toggle controlling
    # whether that email/SMS actually gets sent. Checked via
    # _messaging_enabled() right before each real send.
    "messaging-settings",
    # AI Prompts (item 2) - every AI prompt used anywhere in the app,
    # admin-editable instead of hardcoded in Python source.
    "ai-prompts",
)

DB_BACKED_RESOURCES = ("payment-history", "notifications") + DOCUMENT_RESOURCES

# Ye JSON files list nahi, ek hi object/dict thi (menu-config.json,
# company.json waghera) - inke liye alag "cfg_*" tables (ek row, poora
# object JSONB me), kyunki document pattern (id ke saath rows) inpar
# fit nahi baithta.
#
# "menu-config", "services-api", aur "messages" yahan se hata di gayi
# hain (items 1.05 / 1.06 / 1.10) - ab teeno seedhe project me (app.js
# ke andar constants ke roop me) hardcoded hain, DB/JSON resource nahi.
SETTINGS_RESOURCES = (
    "card-layout", "agents", "company", "rules", "maintenance",
)


def list_resource(name):
    if name == "payment-history":
        return list_transactions()
    if name == "notifications":
        return list_notifications()
    if name in DOCUMENT_RESOURCES:
        return list_documents(name)
    raise KeyError(name)


def save_resource(name, rows):
    if name == "payment-history":
        # Transactions kabhi delete nahi hote - sirf upsert. Client ki
        # purani list DB se rows uda na de.
        saved = 0
        for entry in rows:
            if isinstance(entry, dict) and entry.get("id"):
                append_transaction(entry)
                saved += 1
        return saved
    if name == "notifications":
        return replace_notifications(rows)
    if name in DOCUMENT_RESOURCES:
        return replace_documents(name, rows)
    raise KeyError(name)


# ============================================================
# TABLE BROWSER + MIGRATION (Admin Panel ke liye)
# ============================================================
# Sirf ye tables dikhayi/padhi ja sakti hain. Table ka naam SQL me
# seedha jata hai (usko parameter nahi banaya ja sakta), isliye
# allowlist hi ekmatra suraksha hai - koi bhi naam accept karna SQL
# injection ka darwaza khol dega.
#
# Har JSON resource ki apni physical table hai (doc_* / cfg_*) - ek
# shared "app_documents"/"app_settings" table nahi, jaisa pehle tha.
KNOWN_TABLES = (
    ("users", "transactions", "notifications")
    + tuple(_doc_table(n) for n in DOCUMENT_RESOURCES)
    + tuple(_settings_table(n) for n in SETTINGS_RESOURCES)
)

# Ye tables Admin Panel ke table-browser tabs me nahi dikhti (item 1.01,
# 1.07, 1.08) - Activity Log sirf us waqt dikhna chahiye jab koi user
# ki file process ho rahi ho (wo alag, per-service panel already hai),
# aur Payment Method / Plan History ab standalone admin tables ke roop
# me manage nahi hote. Resource khud abhi bhi kaam karta hai (list/save
# API), sirf is generic browser se hata hai.
ADMIN_HIDDEN_TABLES = {
    _doc_table("lease-activity-log"),
    _doc_table("translation-activity-log"),
    _doc_table("plan-history"),
    _doc_table("payment-methods"),
    _doc_table("translation-files"),
    _doc_table("lease-files"),
    _settings_table("card-layout"),
    _settings_table("agents"),
    _settings_table("maintenance"),
}

# Company aur Plans (items 1.02 / 1.03) ka poora record ek hi JSONB
# column me hota hai ("data") - generic viewer isko ek "key"/"value" jodi
# ke roop me dikhata, jabki chahiye tha ki ANDAR KE SAARE fields (phone,
# address, pricing, features, ...) apne-apne alag, sahi se aligned
# column headers ban jayein - ek bhi field chhoote nahi.
#
# "types" me sirf wahi fields likhe hain jo nested object/array hain
# (jaise company.social, plans.features) - unhe textarea (multi-line
# JSON) ke roop me edit karna behtar hai; baaki sab plain text hai.
VIRTUAL_TABLES = {
    "cfg_company": {
        "kind": "settings",
        "resource": "company",
        "fields": [
            "name", "address", "workingHours", "workingDays", "location",
            "email", "phone", "logo", "mapFallbackImage",
            "youtube", "facebook", "linkedin", "instagram",
            "shareEnabled", "currency", "twoFactorAvailable", "autoRenewAvailable", "homeImage", "copyright",
            "imageCleaningModel", "textExtractionModel",
        ],
        "types": {},
        "jsonb_defaults": {},
        "select_options": {
            "shareEnabled": ["Yes", "No"],
            "currency": ["INR", "USD", "AED"],
            "twoFactorAvailable": ["Yes", "No"],
            "autoRenewAvailable": ["Yes", "No"],
        },
        "field_defaults": {"twoFactorAvailable": "Yes", "autoRenewAvailable": "Yes", "imageCleaningModel": "google/gemini-3.1-flash-image", "textExtractionModel": "google/gemini-2.5-flash"},
        "readonly_fields": set(),
    },
    "doc_plans": {
        "kind": "document",
        "resource": "plans",
        "fields": [
            "id", "name", "icon", "frequency", "monthlyPrice",
            "pricePerTranslation", "billingUnit",
            "paidFeature", "freeFeature", "supportFeature", "apiFeature",
        ],
        "types": {},
        "jsonb_defaults": {},
        # A brand-new field with no value yet on an EXISTING record reads
        # back as "" (missing key) - a <select> with no matching option
        # then just shows whatever option happens to be listed first,
        # which looks like a real (wrong) value even though nothing was
        # ever actually set. These give every plan a sensible real
        # default instead of that cosmetic accident, the first time this
        # runs after the fields were added.
        "field_defaults": {
            "frequency": "Monthly",
            "paidFeature": "Yes", "freeFeature": "Yes", "supportFeature": "Yes", "apiFeature": "No",
        },
        "select_options": {
            "frequency": ["Daily", "Monthly", "Yearly"],
            # (value, label) pairs - the billing logic elsewhere in the
            # app checks the lowercase VALUE ('page'/'document'), so only
            # the DISPLAY label changes here, not what's actually stored.
            "billingUnit": [["page", "Per Page"], ["document", "Per Document"], ["process", "Per Process"]],
            "paidFeature": ["Yes", "No"],
            "freeFeature": ["Yes", "No"],
            "supportFeature": ["Yes", "No"],
            "apiFeature": ["Yes", "No"],
        },
        # 'id' rename allow nahi karte - baaki app me plan id se hi
        # lookup hota hai (billing, plan switch, waghera); rename se
        # references toot jayenge.
        "readonly_fields": {"id"},
    },
    "doc_contact_submissions": {
        "kind": "document",
        "resource": "contact-submissions",
        "fields": [
            "userId", "id", "subject", "message", "status", "response",
            "date", "updatedAt",
        ],
        "types": {},
        "jsonb_defaults": {},
        "select_options": {
            "status": ["Pending", "WIP", "Resolved"],
        },
        # 'id' (ticket number) rename allow nahi - yehi doc_id bhi hai.
        # 'updatedAt' real DB column se aata hai (JSONB me nahi), isliye
        # edit karne layak nahi - wo apne aap update hoti hai.
        "readonly_fields": {"id", "updatedAt"},
    },
    "doc_services_catalog": {
        "kind": "document",
        "resource": "services-catalog",
        "fields": ["id", "name", "type", "amount", "billingUnit", "apiAccess", "visibility", "systemConfig", "image"],
        "types": {},
        "jsonb_defaults": {},
        "field_defaults": {"type": "Free", "amount": "", "billingUnit": "document", "apiAccess": "No", "visibility": "Visible", "systemConfig": "No"},
        "select_options": {
            "type": ["Paid", "Free"],
            "billingUnit": [["page", "Per Page"], ["document", "Per Document"], ["process", "Per Process"]],
            "apiAccess": ["Yes", "No"],
            "visibility": [["Visible", "Unhide"], ["Hidden", "Hide"]],
            "systemConfig": ["Yes", "No"],
        },
        # 'id' rename allow nahi - baaki app isi id se service ko
        # dhoondhta/render karta hai (catalogue placement, billing
        # lookup); rename se wo service "gayab" ho jayegi. 'name' rename
        # IS allowed (item 2 ka poora point yehi hai) - display label
        # frontend me is field se override hoti hai, id se nahi.
        "readonly_fields": {"id"},
    },
    "doc_system_configs": {
        "kind": "document",
        "resource": "system-configs",
        "fields": ["id", "name"],
        "types": {},
        "jsonb_defaults": {},
        "field_defaults": {},
        "select_options": {},
        "readonly_fields": set(),
    },
    "doc_messaging_settings": {
        "kind": "document",
        "resource": "messaging-settings",
        "fields": ["id", "event", "enabled"],
        "types": {},
        "jsonb_defaults": {},
        "field_defaults": {"enabled": "Yes"},
        "select_options": {"enabled": ["Yes", "No"]},
        # 'id' is the fixed event key (e.g. "login-otp") that
        # _messaging_enabled() looks up by - renaming it would silently
        # disconnect this row from the actual send-code that checks it.
        "readonly_fields": {"id"},
    },
    "doc_ai_prompts": {
        "kind": "document",
        "resource": "ai-prompts",
        "fields": ["id", "serviceName", "promptNumber", "fileLocation", "description"],
        "types": {},
        "jsonb_defaults": {},
        "field_defaults": {},
        "select_options": {},
        "readonly_fields": set(),
    },
}

# Human-readable column headers for the Admin Database table viewer -
# only needed where the underlying field name (kept as-is everywhere
# else in the app, so nothing else has to change) doesn't already read
# naturally as a column header.
VIRTUAL_TABLE_LABELS = {
    "cfg_company": {"workingHours": "Working Hours", "workingDays": "Working Days",
                     "youtube": "Youtube", "facebook": "Facebook", "linkedin": "Linkedin",
                     "instagram": "Instagram", "shareEnabled": "Share",
                     "mapFallbackImage": "Map Fallback Image (file path, shown when there's no address)",
                     "twoFactorAvailable": "2FA Available",
                     "autoRenewAvailable": "Auto Renewal",
                     "homeImage": "Home Image (file path, background of the pre-login Home content card)",
                     "copyright": "Copyright (footer text, e.g. \u00a9 2026 Lexora. All rights reserved. | Version 1.0.0)",
                     "imageCleaningModel": "Image Cleaning Model (OpenRouter model id used to remove text from a page's background image, e.g. google/gemini-3.1-flash-image)",
                     "textExtractionModel": "Text Extraction Model (OpenRouter model id used to read/OCR text from a page image, e.g. google/gemini-2.5-flash)"},
    "doc_plans": {"id": "Plan ID", "name": "Plan Name", "icon": "Plan Icon",
                  "monthlyPrice": "Plan Price", "pricePerTranslation": "Paid Services Price",
                  "billingUnit": "Paid Billing Unit", "paidFeature": "Paid Feature",
                  "freeFeature": "Free Feature", "supportFeature": "Support Feature",
                  "apiFeature": "API Feature"},
    "doc_contact_submissions": {"userId": "User ID", "id": "Ticket ID",
                                 "date": "Created At", "updatedAt": "Updated At"},
    "doc_services_catalog": {"id": "Service ID", "name": "Name", "type": "Paid/Free", "amount": "Amount",
                              "billingUnit": "Paid Billing Unit", "apiAccess": "API Access",
                              "visibility": "Visibility", "systemConfig": "System Configuration", "image": "Image"},
    "doc_system_configs": {"id": "ID", "name": "System Name"},
    "doc_messaging_settings": {"id": "Event Key", "event": "Event", "enabled": "Send Email/SMS"},
    "doc_ai_prompts": {"id": "ID", "serviceName": "Service Name", "promptNumber": "Prompt #",
                        "fileLocation": "File Location", "description": "Description"},
}


# Admin ko bhi password hash ya OTP dekhne ki zaroorat nahi. Screenshot
# ya screen-share me leak hona asaan hai, isliye server hi mask karta
# hai - browser tak asli value jati hi nahi.
MASKED_COLUMNS = {"password", "verification_code", "api_key", "apiKey"}

# Har table ka primary key - update/delete WHERE clause banane ke liye.
# Row identify karne ka yahi ekmatra tareeka hai. doc_* tables ka PK
# doc_id hai, cfg_* tables ka PK hamesha id=1 (ek hi row).
PRIMARY_KEYS = {
    "users": ("user_id",),
    "transactions": ("txn_id",),
    "notifications": ("notif_id",),
}
PRIMARY_KEYS.update({_doc_table(n): ("doc_id",) for n in DOCUMENT_RESOURCES})
PRIMARY_KEYS.update({_settings_table(n): ("id",) for n in SETTINGS_RESOURCES})


def table_columns(name):
    """Table ke columns: naam, Postgres type, primary-key hai ya nahi,
    edit karne layak hai ya nahi (password jaisi masked columns nahi)."""
    if name not in KNOWN_TABLES:
        raise ValueError(f"Unknown table: {name}")
    if name in VIRTUAL_TABLES:
        spec = VIRTUAL_TABLES[name]
        readonly = spec["readonly_fields"]
        types = spec.get("types", {})
        select_options = spec.get("select_options", {})
        labels = VIRTUAL_TABLE_LABELS.get(name, {})
        return [
            {
                "name": f,
                "label": labels.get(f, f[:1].upper() + f[1:]),
                "type": types.get(f, "text"),
                "nullable": True,
                "primaryKey": spec["kind"] == "document" and f == "id",
                "editable": f not in readonly,
                "options": select_options.get(f),
            }
            for f in spec["fields"]
        ]
    init_schema()
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT column_name, data_type, is_nullable"
                " FROM information_schema.columns"
                " WHERE table_schema = 'public' AND table_name = %(t)s"
                " ORDER BY ordinal_position",
                {"t": name},
            )
            cols = cur.fetchall()
    pk = set(PRIMARY_KEYS.get(name, ()))
    return [
        {
            "name": c["column_name"],
            "type": c["data_type"],
            "nullable": c["is_nullable"] == "YES",
            "primaryKey": c["column_name"] in pk,
            "editable": c["column_name"] not in MASKED_COLUMNS,
        }
        for c in cols
    ]


def _prepare_value(col_type, value):
    """Frontend se text/JSON string ke roop me aaya value ko column ke
    Postgres type ke hisaab se DB me bhejne layak banata hai."""
    if value is None or value == "":
        return None
    if col_type in ("jsonb", "json"):
        if isinstance(value, (dict, list)):
            return json.dumps(value)
        json.loads(value)  # invalid JSON ho to yahin turant fail ho jaye
        return value
    return value


# ------------------------------------------------------------
# VIRTUAL_TABLES helpers (company / plans) - values yahan hamesha
# flat fields hain (logo/name/email ya id/icon/name), asli JSONB
# "data" column ke andar purane fields ke saath merge hoke save hote
# hain, taaki koi field khoya na jaye.
# ------------------------------------------------------------
def _virtual_clean_values(spec, values):
    """Frontend se saare fields text/string ke roop me aate hain - jo
    fields nested object/array hain (spec['types'] me 'jsonb'), unhe
    yahan JSON se decode karte hain, taaki data me phir se asli
    object/array ban jaye, string nahi. Khaali textarea ka matlab "isko
    mat badlo" - taaki galti se poora field (jaise 'features' list) mit
    na jaye."""
    fields = spec["fields"]
    types = spec.get("types", {})
    clean = {}
    for f in fields:
        if f not in values:
            continue
        v = values.get(f, "")
        if types.get(f) == "jsonb":
            if isinstance(v, (dict, list)):
                clean[f] = v
            elif isinstance(v, str) and v.strip():
                clean[f] = json.loads(v)
            # empty/blank -> skip, don't overwrite existing value
        else:
            clean[f] = v
    return clean


def _virtual_insert_row(name, values):
    spec = VIRTUAL_TABLES[name]
    clean = _virtual_clean_values(spec, values)
    if spec["kind"] == "settings":
        current = get_setting(spec["resource"]) or {}
        current.update(clean)
        save_setting(spec["resource"], current)
        return True
    # kind == "document": naya plan/document row - id zaroor chahiye.
    new_id = str(clean.get("id") or "").strip()
    if not new_id:
        raise ValueError("'id' is required to add a new row.")
    docs = list_documents(spec["resource"])
    if any(str(d.get("id")) == new_id for d in docs):
        raise ValueError(f"'{new_id}' already exists.")
    for f, default in spec.get("jsonb_defaults", {}).items():
        clean.setdefault(f, default)
    docs.append(clean)
    replace_documents(spec["resource"], docs)
    return True


def _virtual_update_row(name, key, values):
    spec = VIRTUAL_TABLES[name]
    readonly = spec["readonly_fields"]
    values = {k: v for k, v in values.items() if k not in readonly}
    clean = _virtual_clean_values(spec, values)
    if spec["kind"] == "settings":
        current = get_setting(spec["resource"]) or {}
        current.update(clean)
        save_setting(spec["resource"], current)
        return 1
    # kind == "document": key['id'] se original doc dhoondo, editable
    # fields us par merge karo, baaki (monthlyPrice, features, ...) waisa
    # hi rahega.
    target_id = str(key.get("id") or "").strip()
    if not target_id:
        raise ValueError("Row identify nahi ho payi (id missing).")
    docs = list_documents(spec["resource"])
    affected = 0
    for d in docs:
        if str(d.get("id")) == target_id:
            d.update(clean)
            affected += 1
    if affected:
        replace_documents(spec["resource"], docs)
    return affected


def _virtual_delete_row(name, key):
    spec = VIRTUAL_TABLES[name]
    if spec["kind"] == "settings":
        raise ValueError("Ye row delete nahi ho sakti.")
    target_id = str(key.get("id") or "").strip()
    if not target_id:
        raise ValueError("Row identify nahi ho payi (id missing).")
    docs = list_documents(spec["resource"])
    remaining = [d for d in docs if str(d.get("id")) != target_id]
    affected = len(docs) - len(remaining)
    if affected:
        replace_documents(spec["resource"], remaining)
    return affected


def insert_row(name, values):
    """Naya row insert karta hai. Sirf wahi columns jo table me sach me
    maujood hain aur masked nahi hain - baaki keys chup-chaap ignore."""
    if name in VIRTUAL_TABLES:
        return _virtual_insert_row(name, values)
    cols_info = {c["name"]: c for c in table_columns(name)}
    known = {
        k: v for k, v in values.items()
        if k in cols_info and cols_info[k]["editable"]
    }
    if not known:
        raise ValueError("Koi valid column nahi mila.")
    init_schema()
    col_names = list(known.keys())
    placeholders = []
    params = {}
    for c in col_names:
        col_type = cols_info[c]["type"]
        params[c] = _prepare_value(col_type, known[c])
        placeholders.append(f"%({c})s::jsonb" if col_type in ("jsonb", "json") else f"%({c})s")
    sql = f"INSERT INTO {name} ({', '.join(col_names)}) VALUES ({', '.join(placeholders)})"
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
        conn.commit()
    return True


def update_row(name, key, values):
    """Primary key se match hone wala ek hi row update karta hai."""
    if name in VIRTUAL_TABLES:
        return _virtual_update_row(name, key, values)
    pk_cols = PRIMARY_KEYS.get(name, ())
    if not pk_cols or set(key.keys()) != set(pk_cols):
        raise ValueError("Row identify nahi ho payi (primary key missing).")
    cols_info = {c["name"]: c for c in table_columns(name)}
    known = {
        k: v for k, v in values.items()
        if k in cols_info and cols_info[k]["editable"] and k not in pk_cols
    }
    if not known:
        raise ValueError("Update karne layak koi column nahi mila.")
    init_schema()
    params = {}
    set_parts = []
    for c, v in known.items():
        col_type = cols_info[c]["type"]
        params[c] = _prepare_value(col_type, v)
        set_parts.append(f"{c} = %({c})s::jsonb" if col_type in ("jsonb", "json") else f"{c} = %({c})s")
    where_parts = []
    for i, (k, v) in enumerate(key.items()):
        pname = f"key_{i}"
        params[pname] = v
        where_parts.append(f"{k} = %({pname})s")
    sql = f"UPDATE {name} SET {', '.join(set_parts)} WHERE {' AND '.join(where_parts)}"
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            affected = cur.rowcount
        conn.commit()
    return affected


def delete_row(name, key):
    """Primary key se match hone wala ek hi row delete karta hai."""
    if name not in KNOWN_TABLES:
        raise ValueError(f"Unknown table: {name}")
    if name in VIRTUAL_TABLES:
        return _virtual_delete_row(name, key)
    pk_cols = PRIMARY_KEYS.get(name, ())
    if not pk_cols or set(key.keys()) != set(pk_cols):
        raise ValueError("Row identify nahi ho payi (primary key missing).")
    init_schema()
    params = {}
    where_parts = []
    for i, (k, v) in enumerate(key.items()):
        pname = f"key_{i}"
        params[pname] = v
        where_parts.append(f"{k} = %({pname})s")
    sql = f"DELETE FROM {name} WHERE {' AND '.join(where_parts)}"
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            affected = cur.rowcount
        conn.commit()
    return affected


def _mask(value):
    text = str(value or "")
    if not text:
        return ""
    return (text[:4] + "\u2022" * 8 + text[-2:]) if len(text) > 10 else "\u2022" * 8


def list_tables():
    """Har table ka naam + row count (ADMIN_HIDDEN_TABLES chhod kar)."""
    init_schema()
    out = []
    with connect() as conn:
        with conn.cursor() as cur:
            for name in KNOWN_TABLES:
                if name in ADMIN_HIDDEN_TABLES:
                    continue
                cur.execute("SELECT to_regclass(%(t)s) IS NOT NULL AS present",
                            {"t": "public." + name})
                if not cur.fetchone()["present"]:
                    out.append({"name": name, "rows": None, "exists": False})
                    continue
                cur.execute(f"SELECT COUNT(*) AS n FROM {name}")
                out.append({"name": name, "rows": int(cur.fetchone()["n"] or 0), "exists": True})
    return out


def table_rows(name, limit=500):
    """Ek table ka raw data (masked). name allowlist se hi aata hai."""
    if name not in KNOWN_TABLES:
        raise ValueError(f"Unknown table: {name}")
    if name in VIRTUAL_TABLES:
        spec = VIRTUAL_TABLES[name]
        fields = spec["fields"]
        defaults = spec.get("field_defaults", {})
        if spec["kind"] == "settings":
            data = get_setting(spec["resource"]) or {}
            return [{f: (data[f] if f in data and data[f] not in (None, "") else defaults.get(f, "")) for f in fields}]
        # kind == "document": har row ka apna data JSONB, plus - agar
        # fields me "updatedAt" mangi gayi ho - real updated_at column bhi
        # (list_documents() sirf data column deta hai, isliye yahan seedha
        # query karte hain jab wo extra column chahiye ho).
        needs_updated_at = "updatedAt" in fields
        table = _doc_table(spec["resource"])
        init_schema()
        with connect() as conn:
            with conn.cursor() as cur:
                cur.execute(f"SELECT data, updated_at FROM {table} ORDER BY position, doc_id")
                db_rows = cur.fetchall()
        out = []
        for r in db_rows:
            d = r["data"] or {}
            row = {f: (d[f] if f in d and d[f] not in (None, "") else defaults.get(f, "")) for f in fields if f != "updatedAt"}
            if needs_updated_at:
                ua = r.get("updated_at")
                row["updatedAt"] = ua.isoformat(sep=" ", timespec="seconds") if ua else ""
            out.append(row)
        return out
    init_schema()
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(f"SELECT * FROM {name} LIMIT %(limit)s", {"limit": int(limit)})
            rows = cur.fetchall()

    out = []
    for row in rows:
        clean = {}
        for key, value in row.items():
            if key in MASKED_COLUMNS:
                clean[key] = _mask(value)
            elif isinstance(value, decimal.Decimal):
                # credit/debit waghera NUMERIC hain - Decimal object seedha
                # JSON me nahi jaata (TypeError -> 500), isliye number bana do.
                clean[key] = _to_number(value)
            elif hasattr(value, "isoformat"):
                clean[key] = value.isoformat(sep=" ", timespec="seconds") \
                    if hasattr(value, "hour") else value.isoformat()
            elif isinstance(value, (dict, list)):
                clean[key] = json.dumps(value)
            else:
                clean[key] = value
        out.append(clean)
    return out


def migrate_from_json(json_dir, fallback_dir=None):
    """json/ se Postgres - CLI script aur Admin Panel dono isi ko call karte hain.

    fallback_dir: agar file json_dir me na mile, wahan bhi dhoondhta hai -
    koi extra pre-migration backup folder ho to us par point kar sakte hain.
    Aaj kal kisi caller ko iski zaroorat nahi (Postgres hi authoritative
    hai), parameter sirf backward-compatible/reusable rakha hai.

    Dobara chalane par duplicate nahi bante (sab upsert hai), isliye
    adhoori migration bina dar ke phir se chalayi ja sakti hai.
    """
    init_schema()
    report = []

    def _find(name):
        path = os.path.join(json_dir, f"{name}.json")
        if os.path.exists(path):
            return path
        if fallback_dir:
            alt = os.path.join(fallback_dir, f"{name}.json")
            if os.path.exists(alt):
                return alt
        return path  # not found anywhere - open() will just fail below

    def read(name):
        try:
            with open(_find(name), "r", encoding="utf-8") as f:
                rows = json.load(f)
            return rows if isinstance(rows, list) else []
        except (OSError, json.JSONDecodeError):
            return []

    def read_obj(name):
        try:
            with open(_find(name), "r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else None
        except (OSError, json.JSONDecodeError):
            return None

    users = read("users")
    if users:
        try:
            report.append({"resource": "users", "rows": replace_users(users), "ok": True})
        except Exception as err:  # noqa: BLE001
            report.append({"resource": "users", "error": str(err), "ok": False})

    txns = read("payment-history")
    if txns:
        inserted = 0
        try:
            for i, entry in enumerate(txns):
                if not entry.get("id"):
                    entry["id"] = f"LEGACY-{i + 1:05d}"
                if entry.get("userId"):
                    append_transaction(entry)
                    inserted += 1
            report.append({"resource": "payment-history", "rows": inserted, "ok": True})
        except Exception as err:  # noqa: BLE001
            report.append({"resource": "payment-history", "error": str(err), "ok": False})

    for name in DB_BACKED_RESOURCES:
        if name == "payment-history":
            continue
        rows = read(name)
        if not rows:
            continue
        try:
            report.append({"resource": name, "rows": save_resource(name, rows), "ok": True})
        except Exception as err:  # noqa: BLE001
            report.append({"resource": name, "error": str(err), "ok": False})

    for name in SETTINGS_RESOURCES:
        data = read_obj(name)
        if data is None:
            continue
        try:
            save_setting(name, data)
            report.append({"resource": name, "rows": 1, "ok": True})
        except Exception as err:  # noqa: BLE001
            report.append({"resource": name, "error": str(err), "ok": False})

    return report


def safe_host():
    """URL ka sirf host hissa - password kabhi bahar nahi jana chahiye."""
    url = DATABASE_URL
    if not url:
        return ""
    tail = url.split("@", 1)[1] if "@" in url else url
    return tail.split("?", 1)[0]


def status():
    """Admin panel ke liye ek nazar me haalat. Kabhi throw nahi karta."""
    info = {
        "enabled": is_enabled(),
        "reason": why_disabled(),
        "host": safe_host(),
        "connected": False,
        "server": "",
        "tableExists": False,
        "rowCount": 0,
        "balances": [],
    }
    if not is_enabled():
        return info

    try:
        with connect() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT version() AS v")
                info["server"] = (cur.fetchone()["v"] or "").split(",")[0]
                info["connected"] = True

                cur.execute("SELECT to_regclass('public.transactions') IS NOT NULL AS present")
                info["tableExists"] = bool(cur.fetchone()["present"])

                if info["tableExists"]:
                    cur.execute("SELECT COUNT(*) AS n FROM transactions")
                    info["rowCount"] = int(cur.fetchone()["n"] or 0)
                    cur.execute("SELECT to_regclass('public.notifications') IS NOT NULL AS present")
                    if cur.fetchone()["present"]:
                        cur.execute("SELECT COUNT(*) AS n FROM notifications")
                        info["notificationCount"] = int(cur.fetchone()["n"] or 0)

                    cur.execute("SELECT to_regclass('public.users') IS NOT NULL AS present")
                    if cur.fetchone()["present"]:
                        cur.execute("SELECT COUNT(*) AS n FROM users")
                        info["userCount"] = int(cur.fetchone()["n"] or 0)

                    cur.execute(
                        "SELECT user_id,"
                        "       COALESCE(SUM(credit), 0) - COALESCE(SUM(debit), 0) AS balance"
                        "  FROM transactions GROUP BY user_id ORDER BY user_id"
                    )
                    info["balances"] = [
                        {"userId": r["user_id"], "balance": _to_number(r["balance"])}
                        for r in cur.fetchall()
                    ]
    except Exception as err:  # noqa: BLE001
        info["error"] = str(err)
    return info


def charge_if_sufficient(user_id, amount, description, txn_id,
                         payment_type="Service", payment_mode="Wallet"):
    """Balance check aur debit EK hi transaction me.

    Isi ke liye Postgres laaye hain. JSON me check aur write ke beech ek
    doosri request ghus sakti hai aur balance negative ho sakta hai.
    Yahan dono ek hi BEGIN/COMMIT me hain, to ya dono hote hain ya koi nahi.

    Returns (ok, balance_after_or_current).
    """
    init_schema()
    amount = _to_number(amount)
    with connect() as conn:
        with conn.cursor() as cur:
            # Postgres SELECT ... FOR UPDATE ko aggregate ke saath allow
            # nahi karta ("FOR UPDATE is not allowed with aggregate
            # functions"), aur waise bhi yahan kisi ek row ka lock nahi,
            # is USER ka lock chahiye. Advisory lock exactly yahi karta hai
            # aur COMMIT/ROLLBACK par apne aap chhoot jata hai.
            # ::text isliye ki parameter ka type Postgres ko saaf pata rahe
            # (upar wali SELECT_SQL wali galti dobara na ho).
            cur.execute("SELECT pg_advisory_xact_lock(hashtext(%(user_id)s::text))",
                        {"user_id": user_id})
            cur.execute(
                "SELECT COALESCE(SUM(credit), 0) - COALESCE(SUM(debit), 0) AS balance"
                "  FROM transactions WHERE user_id = %(user_id)s",
                {"user_id": user_id},
            )
            row = cur.fetchone()
            balance = _to_number(row["balance"]) if row else 0.0

            if balance < amount:
                conn.rollback()
                return False, balance

            cur.execute(INSERT_SQL, entry_to_params({
                "id": txn_id,
                "userId": user_id,
                "date": None,  # entry_to_params aaj ki date bhar dega
                "time": "",
                "paymentType": payment_type,
                "paymentMode": payment_mode,
                "description": description,
                "credit": 0,
                "debit": amount,
                "status": "approved",
            }))
        conn.commit()
    return True, balance - amount
