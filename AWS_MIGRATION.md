# Moving the database from Render Postgres to AWS

Lexora's database layer (`py/db.py`) talks to Postgres purely through the
standard `DATABASE_URL` connection string via `psycopg` - there is **no
Render-specific code anywhere**. That means AWS RDS (or Aurora
PostgreSQL-compatible) works as a drop-in replacement; you don't need any
code changes to migrate, just the steps below.

## 1. Provision the AWS database

- **RDS for PostgreSQL** is the simplest match for what you have today (same
  engine, same SQL). Aurora PostgreSQL also works if you want more
  headroom/read-replicas later - both speak the same wire protocol.
- Recommended starting point: `db.t3.micro`/`db.t4g.micro` (or your
  Aurora Serverless v2 equivalent) - resize later, no code changes needed.
- Enable **"Require SSL"** (or leave it optional but keep the client
  requesting SSL - see step 4, this app now always asks for
  `sslmode=require` unless the host is localhost).
- Put it in a VPC with a security group that allows inbound Postgres
  (5432) **only** from wherever the app server actually runs (its EC2/ECS/
  Fargate/App Runner security group, or your IP while migrating data).

## 2. Copy the data over (Render -> AWS)

From any machine that can reach both databases (your laptop is fine for a
few-GB dataset):

```bash
# 1. Dump everything from the current Render Postgres
pg_dump "$RENDER_DATABASE_URL" --format=custom --file=lexora_dump.pgdump

# 2. Restore into the new AWS RDS instance (schema gets created fresh here;
#    Lexora also auto-creates any missing tables itself on first request
#    via init_schema(), so a restore isn't even strictly required for a
#    brand-new AWS DB - only needed if you want to carry over real data).
pg_restore --no-owner --no-acl -d "$AWS_DATABASE_URL" lexora_dump.pgdump
```

Both `pg_dump`/`pg_restore` ship with the `postgresql-client` package
(`apt install postgresql-client` / `brew install libpq`).

If you'd rather start clean on AWS instead of copying data: just point
`DATABASE_URL` at the new instance and deploy - `init_schema()` creates
every table automatically on first use, and `db.migrate_from_json()` (the
same one-time importer used for the original JSON -> Postgres move) can
seed it from your `json_backup_pre_postgres/` files if you still have them.

## 3. Swap the connection string

Update the `DATABASE_URL` environment variable wherever the app actually
runs (Render env vars today; wherever you host the app on AWS later) to
the new RDS/Aurora endpoint:

```
DATABASE_URL=postgresql://<user>:<password>@<your-instance>.rds.amazonaws.com:5432/<dbname>
```

That's the only required change - `py/db.py` reads `DATABASE_URL` the
same way regardless of which provider issued it.

## 4. SSL - already handled

`db.connect()` now explicitly adds `sslmode=require` to the connection
string if it isn't already present (skipped for `localhost`/`127.0.0.1`
for local dev). This used to silently rely on Render's URLs already
including `sslmode` - AWS RDS connection strings do **not** include it by
default, so this was the one real gotcha and it's already patched.

## 5. Zero-downtime cutover (optional, for a live system with real users)

1. Stand up the AWS RDS instance and restore a fresh `pg_dump` onto it.
2. Put the app briefly into maintenance / pause writes.
3. Take one more `pg_dump` (catches anything written since step 1) and
   restore just the delta, or just re-run the full restore since the gap
   should be small.
4. Flip `DATABASE_URL` to the AWS endpoint and restart the app.
5. Verify via **Profile > Overview** and **Admin > Database** (row counts,
   connection status) that everything matches before decommissioning the
   old Render database.

## 6. If you also move the app server itself to AWS later

None of the above requires it, but if/when you move off Render entirely:
`py/server.py` has no Render-specific code either (checked - no hardcoded
Render hostnames/env vars anywhere in the app). It runs the same way on
any host that can run Python 3 + the packages in `requirements.txt`
(EC2, ECS/Fargate, Elastic Beanstalk, App Runner, etc.) - same Docker
image/force-push workflow you already use would just point at a
different deploy target.
