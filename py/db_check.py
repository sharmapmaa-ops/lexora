"""Database ke andar kya hai - dekhne ke liye.

Ye kuch badalta nahi, sirf padhta hai. Jab shak ho ki data DB me ja raha
hai ya nahi, ye chalayein:

    DATABASE_URL="<External URL>" python3 py/db_check.py

    # kisi ek user ka:
    DATABASE_URL="..." python3 py/db_check.py U0000001

Ye batata hai:
  * connection ban rahi hai ya nahi
  * transactions table hai ya nahi, usme kitni rows hain
  * aakhri 10 transactions
  * har user ka balance
  * JSON file aur DB ka farak (migration ke baad match hona chahiye)
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


def json_rows():
    try:
        with open(JSON_PATH, "r", encoding="utf-8") as f:
            rows = json.load(f)
        return rows if isinstance(rows, list) else []
    except (OSError, json.JSONDecodeError):
        return []


def main():
    only_user = sys.argv[1] if len(sys.argv) > 1 else None

    print("=" * 62)
    print("LEXORA - database check")
    print("=" * 62)

    if not db.is_enabled():
        print("\nPostgres OFF:", db.why_disabled())
        print("App JSON files par chal rahi hai (ye theek hai, bas DB use nahi ho raha).")
        print(f"\njson/payment-history.json me {len(json_rows())} row(s).")
        return 0

    masked = db.DATABASE_URL
    if "@" in masked:
        masked = masked.split("@", 1)[0].rsplit(":", 1)[0] + ":****@" + masked.split("@", 1)[1]
    print(f"\nDATABASE_URL : {masked}")

    try:
        with db.connect() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT version()")
                version = cur.fetchone()["version"]
                cur.execute(
                    "SELECT to_regclass('public.transactions') IS NOT NULL AS present"
                )
                has_table = cur.fetchone()["present"]
    except Exception as err:  # noqa: BLE001
        print(f"\n! Connect nahi ho paya: {err}")
        print("  URL, network aur SSL settings check karein.")
        return 1

    print("connected   : yes")
    print("server      :", version.split(",")[0])

    if not has_table:
        print("\n! 'transactions' table abhi bani nahi hai.")
        print("  py/migrate_json_to_pg.py chalayein, ya app ko ek baar")
        print("  DATABASE_URL ke saath start karein (schema apne aap ban jata hai).")
        return 1

    rows = db.list_transactions(only_user)
    print(f"\ntransactions: {len(rows)} row(s)" + (f" (user {only_user})" if only_user else ""))

    if rows:
        print("\nAakhri 10:")
        print(f"  {'txn id':<26} {'date':<12} {'user':<10} {'credit':>10} {'debit':>10}")
        print("  " + "-" * 70)
        for r in rows[:10]:
            print(f"  {r['id']:<26} {r['date']:<12} {r['userId']:<10} "
                  f"{r['credit']:>10.2f} {r['debit']:>10.2f}")

    users = sorted({r["userId"] for r in rows})
    if users:
        print("\nBalance (Postgres):")
        for u in users:
            print(f"  {u:<12} {db.get_balance(u):>12.2f}")

    # JSON se milaan - migration ke baad dono barabar hone chahiye
    jrows = json_rows()
    print(f"\njson/payment-history.json : {len(jrows)} row(s)")
    if jrows:
        db_ids = {r["id"] for r in db.list_transactions()}
        missing = [r.get("id") for r in jrows if r.get("id") and r.get("id") not in db_ids]
        if missing:
            print(f"! {len(missing)} row(s) JSON me hain par DB me nahi:")
            for t in missing[:5]:
                print("   ", t)
            print("  py/migrate_json_to_pg.py dobara chalayein (duplicate nahi banenge).")
        else:
            print("  JSON ki saari rows DB me maujood hain.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
