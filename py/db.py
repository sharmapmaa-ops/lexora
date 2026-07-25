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
import json
import os
import threading

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


# ============================================================
# Connection
# ============================================================
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

    Render ka Postgres SSL maangta hai; agar URL me sslmode nahi hai to
    hum add nahi karte - Render apne URL me pehle se deta hai. Local dev
    me sslmode ki zaroorat nahi hoti.
    """
    if not is_enabled():
        raise RuntimeError("Database is not configured: " + why_disabled())
    return psycopg.connect(DATABASE_URL, row_factory=dict_row)


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
                cur.execute(DOCUMENTS_SCHEMA_SQL)
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
# GENERIC DOCUMENT TABLE - chhoti list-type resources ke liye
#
# transactions ke liye maine asli columns banaye - wahan paise hain,
# NUMERIC chahiye, CHECK constraints chahiye, aur SUM() query karni hai.
#
# Ye chaar (plan-history, api-keys, payment-methods, contact-submissions)
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
DOCUMENTS_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS app_documents (
    resource   TEXT        NOT NULL,
    doc_id     TEXT        NOT NULL,
    position   INTEGER     NOT NULL DEFAULT 0,
    user_id    TEXT,
    data       JSONB       NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (resource, doc_id)
);

CREATE INDEX IF NOT EXISTS app_documents_resource_idx
    ON app_documents (resource, position);
"""

DOC_SELECT_SQL = """
SELECT data FROM app_documents
 WHERE resource = %(resource)s
 ORDER BY position, doc_id
"""

DOC_INSERT_SQL = """
INSERT INTO app_documents (resource, doc_id, position, user_id, data)
VALUES (%(resource)s, %(doc_id)s, %(position)s, %(user_id)s, %(data)s::jsonb)
ON CONFLICT (resource, doc_id) DO UPDATE SET
    position   = EXCLUDED.position,
    user_id    = EXCLUDED.user_id,
    data       = EXCLUDED.data,
    updated_at = now()
"""


def _doc_id(entry, index):
    """id / key / _id me se jo mile. Kuch na mile to position se bana do -
    warna bina id wali rows chup-chaap gum ho jaengi."""
    for field in ("id", "key", "_id"):
        value = entry.get(field)
        if value not in (None, ""):
            return str(value)
    return f"row-{index + 1:05d}"


def list_documents(resource):
    init_schema()
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(DOC_SELECT_SQL, {"resource": resource})
            rows = cur.fetchall()
    return [r["data"] for r in rows]


def replace_documents(resource, rows):
    """Poori list ek transaction me. JSON array ka order `position` se
    bacha rehta hai - warna list har reload par phir se shuffle ho jati."""
    init_schema()
    clean = [r for r in rows if isinstance(r, dict)]
    with connect() as conn:
        with conn.cursor() as cur:
            ids = [_doc_id(r, i) for i, r in enumerate(clean)]
            if ids:
                cur.execute(
                    "DELETE FROM app_documents"
                    " WHERE resource = %(resource)s AND doc_id <> ALL(%(ids)s)",
                    {"resource": resource, "ids": ids},
                )
            else:
                cur.execute("DELETE FROM app_documents WHERE resource = %(resource)s",
                            {"resource": resource})
            for i, entry in enumerate(clean):
                cur.execute(DOC_INSERT_SQL, {
                    "resource": resource,
                    "doc_id": ids[i],
                    "position": i,
                    "user_id": entry.get("userId") or None,
                    "data": json.dumps(entry),
                })
        conn.commit()
    return len(clean)


# ============================================================
# Resource registry
#
# server.py sirf ye do function call karta hai. Nayi JSON file DB par
# laani ho to yahan ek line add karni hai, server.py chhedna nahi padta.
# ============================================================
# JSONB document table par chalne wali resources.
DOCUMENT_RESOURCES = ("plan-history", "api-keys", "payment-methods", "contact-submissions")

DB_BACKED_RESOURCES = ("payment-history", "notifications") + DOCUMENT_RESOURCES


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

                    cur.execute("SELECT to_regclass('public.app_documents') IS NOT NULL AS present")
                    if cur.fetchone()["present"]:
                        cur.execute(
                            "SELECT resource, COUNT(*) AS n FROM app_documents"
                            " GROUP BY resource ORDER BY resource"
                        )
                        info["documentCounts"] = [
                            {"resource": r["resource"], "count": int(r["n"])}
                            for r in cur.fetchall()
                        ]
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
