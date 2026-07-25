"""Ek baar chalane wala migration: json/payment-history.json -> Postgres.

CHALANE SE PEHLE
----------------
1. Render par Postgres bana lein aur DATABASE_URL copy kar lein.
2. requirements install: pip install "psycopg[binary]"
3. json/payment-history.json ka backup rakh lein.

CHALAO
------
    DATABASE_URL="postgres://..." python3 py/migrate_json_to_pg.py

    # sirf dekhna hai kya hoga, likhna nahi:
    DATABASE_URL="postgres://..." python3 py/migrate_json_to_pg.py --dry-run

Ye script SAFE hai:
  * table pehle se ho to bhi chalti hai (CREATE TABLE IF NOT EXISTS)
  * dobara chala dein to duplicate rows nahi bante (ON CONFLICT DO NOTHING
    on txn_id), isliye adhoori migration bina dar ke dobara chala sakte hain
  * JSON file ko haath nahi lagati - kuch delete nahi hota

Migration ke baad JSON file wahin rehti hai. Kuch din dono rakhein, aur
tab hi hataayein jab Postgres par bharosa ho jaye.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import db  # noqa: E402

JSON_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "json", "payment-history.json",
)


def load_rows():
    try:
        with open(JSON_PATH, "r", encoding="utf-8") as f:
            rows = json.load(f)
    except FileNotFoundError:
        print(f"! {JSON_PATH} nahi mili - kuch migrate karne ko nahi hai.")
        return []
    except json.JSONDecodeError as err:
        print(f"! {JSON_PATH} padhi nahi ja saki: {err}")
        return []

    if not isinstance(rows, list):
        print("! payment-history.json me list honi chahiye thi.")
        return []
    return rows


def main():
    dry_run = "--dry-run" in sys.argv

    if not db.is_enabled():
        print("! Database configured nahi hai:", db.why_disabled())
        print("  DATABASE_URL set karke dobara chalayein.")
        return 1

    rows = load_rows()
    print(f"payment-history.json me {len(rows)} row(s) mili.")
    if not rows:
        return 0

    # Bina id wali rows ko skip nahi karte - unhe ek stable id de dete hain,
    # warna wo migrate hi nahi hongi aur balance galat ho jayega.
    fixed = 0
    for i, r in enumerate(rows):
        if not r.get("id"):
            r["id"] = f"LEGACY-{i + 1:05d}"
            fixed += 1
    if fixed:
        print(f"  {fixed} row(s) ki id khaali thi - unhe LEGACY-xxxxx id di gayi.")

    missing_user = [r["id"] for r in rows if not r.get("userId")]
    if missing_user:
        print(f"! {len(missing_user)} row(s) me userId nahi hai, ye skip hongi:")
        for t in missing_user[:5]:
            print("   ", t)
        rows = [r for r in rows if r.get("userId")]

    if dry_run:
        print(f"\n[dry-run] {len(rows)} row(s) insert hoti. Kuch likha nahi gaya.")
        return 0

    created = db.init_schema()
    print("schema:", "banaya gaya" if created else "pehle se maujood tha")

    inserted = skipped = 0
    with db.connect() as conn:
        with conn.cursor() as cur:
            for r in rows:
                cur.execute(db.INSERT_SQL, db.entry_to_params(r))
                if cur.fetchone():
                    inserted += 1
                else:
                    skipped += 1  # ye txn_id pehle se tha
        conn.commit()

    print(f"\nHo gaya: {inserted} insert, {skipped} pehle se maujood.")

    total = len(db.list_transactions())
    print(f"transactions table me ab {total} row(s) hain.")

    users = {r.get("userId") for r in rows}
    print("\nPer-user balance (Postgres se):")
    for u in sorted(users):
        print(f"  {u}: {db.get_balance(u):.2f}")

    print("\nIn balances ko app me dikhne wale numbers se milaa lein.")
    print("Match ho jayein to server.py me DATABASE_URL set karke restart karein.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
