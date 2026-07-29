"""Inspect what's actually in the database - a read-only diagnostic.

This never changes anything, it only reads. Run it whenever you want to
confirm data is actually landing in Postgres:

    DATABASE_URL="<External URL>" python3 py/db_check.py

    # for a single user:
    DATABASE_URL="..." python3 py/db_check.py U0000001

It reports:
  * whether the connection succeeds
  * whether the transactions table exists, and how many rows it has
  * the last 10 transactions
  * each user's balance
  * the difference between the JSON file and the DB (should match after migration)
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
        print("The app is running on JSON files (that's fine - the DB just isn't in use).")
        print(f"\njson/payment-history.json has {len(json_rows())} row(s).")
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
        print(f"\n! Could not connect: {err}")
        print("  Check the URL, network, and SSL settings.")
        return 1

    print("connected   : yes")
    print("server      :", version.split(",")[0])

    if not has_table:
        print("\n! The 'transactions' table does not exist yet.")
        print("  Run db.migrate_from_json() (Admin > Database > Run Migration in the app),")
        print("  or just start the app with DATABASE_URL set - the schema is created automatically.")
        return 1

    rows = db.list_transactions(only_user)
    print(f"\ntransactions: {len(rows)} row(s)" + (f" (user {only_user})" if only_user else ""))

    if rows:
        print("\nLast 10:")
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

    # Cross-check against the JSON file - both should match after migration.
    jrows = json_rows()
    print(f"\njson/payment-history.json : {len(jrows)} row(s)")
    if jrows:
        db_ids = {r["id"] for r in db.list_transactions()}
        missing = [r.get("id") for r in jrows if r.get("id") and r.get("id") not in db_ids]
        if missing:
            print(f"! {len(missing)} row(s) are in the JSON file but not in the DB:")
            for t in missing[:5]:
                print("   ", t)
            print("  Run db.migrate_from_json() again (it's safe - no duplicates are created).")
        else:
            print("  All rows from the JSON file are present in the DB.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
