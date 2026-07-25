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

SELECT_SQL = """
SELECT * FROM transactions
 WHERE (%(user_id)s IS NULL OR user_id = %(user_id)s)
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
            cur.execute(SELECT_SQL, {"user_id": user_id})
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
            cur.execute("SELECT pg_advisory_xact_lock(hashtext(%(user_id)s))",
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
