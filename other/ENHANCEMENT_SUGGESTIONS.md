# Enhancement Suggestions

A candid list of things in the current codebase that work, but could be
done more robustly. Nothing here is urgent - these are opportunities, not
bugs, unless marked otherwise. Roughly ordered by impact.

## Database / data model

1. **No `created_at` on most tables except `updated_at`.** Users now have
   `createdAt` (added recently for the Overview page's "New Users" stat),
   but `transactions`, `notifications`, and the document tables don't
   consistently track a true creation timestamp separate from
   `updated_at`. Worth adding uniformly - it's the kind of field you only
   miss once you need it for an audit or a support ticket ("when did this
   actually happen").

2. **`extra` JSONB column is doing a lot of quiet work.** Both `users` and
   the document tables have a catch-all `extra JSONB` for any field not
   in the explicit column list. This is a good safety net (nothing gets
   silently dropped), but it also means the actual schema is partly
   invisible from `\d users` in psql - some fields only exist inside JSON
   blobs. Worth periodically "promoting" frequently-queried `extra` fields
   into real columns (accountType, planReminderSentFor, mobileVerified,
   etc. are candidates already) so they're indexable and visible in the
   schema.

3. **No foreign keys.** `transactions.user_id`, `notifications.user_id`
   etc. are plain TEXT columns with no `REFERENCES users(user_id)`
   constraint. Right now the app enforces referential integrity in
   Python, which works but means a bad write (e.g. a typo'd user ID from
   a bug) fails silently instead of erroring loudly. Adding FKs would
   catch that class of bug immediately in dev instead of showing up as a
   confusing missing-data report later.

4. **`payment-history`/`notifications`/etc. read-modify-write pattern
   partially remains for non-Postgres paths.** The transactions table is
   now properly atomic in Postgres, but several *other* JSON-backed
   resources (`contact-submissions.json`, `rules.json`, `sessions.json`)
   still use the same "load whole file, mutate, save whole file" pattern
   `db.py`'s own docstring warns about. Low risk today (single instance,
   moderate traffic) but worth migrating the same way transactions were,
   if you ever run more than one server process/worker.

5. **No pagination at the DB layer.** `list_transactions()`,
   `list_users()`, etc. always fetch everything and paginate in the
   browser. Fine at current data volume; will need real `LIMIT`/`OFFSET`
   (or keyset pagination) once any single user's transaction history or
   the admin's user list grows into the thousands.

## Billing / service logic

6. **Wallet balance is computed by summing all transactions every time**
   (`SUM(credit) - SUM(debit) WHERE user_id = ...`), not stored as a
   running balance column. Correct and safe (no drift possible), but as
   transaction history grows per user this gets slower. A cached
   `balance` column on `users`, updated transactionally alongside each
   insert, would keep it fast at scale while keeping the ledger as the
   source of truth for reconciliation.

7. **Per-file billing (recently fixed for Translation/OCR/BAI2/Data
   Extraction) still has a small race window:** balance is checked once
   before a batch starts, but if a user runs two browser tabs/services in
   parallel, both could pass the pre-check and then both charge, taking
   the balance negative. Postgres could enforce this properly with a
   `CHECK (balance >= 0)` style constraint or a transactional
   check-and-debit stored procedure, closing the race entirely.

8. **Plan expiry/downgrade logic runs client-side only**, on whichever
   browser session happens to load the app. A user who doesn't log back
   in after their plan expires stays on the "expired" plan indefinitely
   from the DB's point of view (their local UI would show it, but nothing
   server-side ever flips them to Free). A small periodic server-side job
   (even a simple thread that wakes up every few hours, similar to the
   idea sketched for plan reminders) would make this exact and audit-able
   regardless of login activity.

## Security-adjacent (see SECURITY_REVIEW.md for the full list)

9. **Sessions are opaque tokens in a JSON/DB table with no expiry
   sweep** - old sessions accumulate rather than being pruned. A
   scheduled cleanup (delete sessions older than N days) keeps the table
   small and reduces the number of long-lived valid tokens sitting
   around.

10. **API keys are stored as plain strings**, not hashed. If the
    `users` table were ever exposed, every API key would be usable
    immediately. Worth hashing them the same way passwords are (store a
    hash, show the real key to the user only once at creation time) -
    see SECURITY_REVIEW.md, item 3.

## Frontend architecture

11. **Several services (OCR, BAI2, Data Extraction) each maintain their
    own separate `STATE`/`rerender()` implementation** that duplicates
    the same file-table/activity-log/progress pattern already
    generalized once in `service-runner.js`. They can't use it directly
    today because they need billing/notification hooks ServiceRunner
    doesn't have - but now that per-file billing and
    `notifyProcessCompletion` are consistent across all of them, it may
    be worth extending `service-runner.js` itself to support billing
    hooks, and migrating these three onto it. Less duplicated code, one
    place to fix future UI bugs instead of four.

12. **No automated tests anywhere in the project.** Understandable for
    how this was built (fast iteration, one active developer), but the
    billing/plan-expiry/notification logic in particular has enough
    branches (per-file vs per-page, SMS vs email, mobile verified vs not)
    that a handful of targeted unit tests around `getServicePrice()`,
    `_dispatch_user_notification()`, and the plan-expiry check would
    catch regressions cheaply before they reach production.

## Nice-to-haves, low priority

13. Rate limiting (`_check_rate_limit`) is in-memory only - it resets on
    every server restart/deploy. Fine for a single instance; would need a
    shared store (Postgres table or Redis) if you ever run more than one
    app instance behind a load balancer.

14. Company branding, plan pricing, and menu config are all editable
    JSON/DB-backed settings already - consider adding simple admin-side
    versioning/audit log ("who changed the Standard plan price and
    when") since these directly affect billing.
