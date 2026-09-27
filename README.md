# Lexora AI Solutions — Company Menu System

## Folder Structure
```
main/
├── index.html              ← open this in the browser (served at "/" automatically)
├── .devcontainer/
│   ├── devcontainer.json   ← Codespaces config - auto pip install + auto server start
│   └── start-server.sh     ← idempotent "start the backend if it isn't already running"
├── requirements.txt         ← pdfplumber, python-docx, reportlab (Lease Abstraction pipeline)
├── css/
│   └── style.css
├── js/
│   └── app.js
├── py/
│   ├── server.py            ← backend (serves the site + JSON persistence + APIs below)
│   └── lease_engine.py      ← text extraction / field analysis / PDF generation
├── json/
│   ├── menu-config.json
│   ├── payment-methods.json     (each method tagged with a userId)
│   ├── payment-history.json     (each transaction tagged with a userId)
│   ├── services-api.json
│   ├── contact-submissions.json (each submission tagged with a userId)
│   ├── users.json               (5 users: Developer / Admin / User x3)
│   ├── api-keys.json
│   ├── messages.json
│   ├── company.json
│   ├── agents.json
│   ├── lease-files.json
│   ├── translation-files.json
│   ├── lease-activity-log.json       (entries tagged with a userId)
│   ├── translation-activity-log.json (entries tagged with a userId)
│   └── smtp-config.json         ← SMTP credentials - server-side only, never
│                                   served as a static file (blocked with 403)
├── Template/
│   └── LeaseAbstraction/
│       └── Default.pdf      ← the default Lease Abstraction output template
├── Pictures/
│   └── logo.png
└── Users/                   ← real per-user storage (created at runtime)
    └── <UserID>/
        ├── ProfilePhoto/                     (profile.png/.jpg)
        └── LeaseAbstraction/
            ├── _staging/                     (files mid-upload, temporary)
            ├── _templates/                   (custom output templates, if selected)
            └── <LeaseName>/
                ├── <original uploaded document>
                ├── Output.json
                ├── Output.pdf
                └── LeaseDocuments.json
```

## Authentication (login / register / 2FA / forgot password)
The app now opens on a **login screen** first - there's no more
walk-straight-into-the-dashboard. Everything is backed by `/api/auth/*`
routes in `py/server.py` + `py/auth_store.py`:

- **Login** - email + password. If the account has `twoFactorAuth: "Yes"`,
  a 6-digit code is emailed and a verification screen follows before
  access is granted.
- **Create Account** - collects the same fields as the Profile page, then
  requires email verification before the account can log in. **Every
  newly self-registered account gets `twoFactorAuth: "Yes"` automatically.**
- **Forgot Password** - email → 6-digit code → set a new password (this
  last step isn't in the reference screenshots but is obviously required
  to actually finish a "reset" flow, so it's included).
- **One shared verification card** handles all three flows (registration,
  login 2FA, password reset) - same 6-digit OTP UI, different title/next
  step depending on why it's showing.
- **Email delivery failure fallback**: if the SMTP send fails for any
  reason (bad credentials, no internet, etc.), the code is shown directly
  in an amber warning box on the verification screen instead of silently
  failing - login/registration/reset are never blocked by a broken mail
  server.
- **Code expiry** comes from `json/smtp-config.json`'s `"expiry_minutes"`
  field (currently 4) - shown as a live countdown, with a Resend button.
- Session is just the logged-in `userId` kept in `localStorage`
  (`lexora_session_user_id`) so a page refresh doesn't force a re-login.
  Logout (Profile menu) clears it and returns to the login screen.

### Important security notes
`users.json` holds a hash of every account's password (see "Production-
readiness upgrades" above) plus verification codes - it can't be handed
to every visitor wholesale the way the original demo's sample data was:
- `users.json` is blocked from *unauthenticated* static serving
  (`GET /json/users.json` → 403).
- `"users"` was removed from the generic `/api/data/<name>` allowlist
  entirely - there is no more "fetch/overwrite the whole file" route for
  it, and that route now requires a valid session token regardless
  (see "Real sessions" above).
- The browser only ever receives **one** user record at a time, and never
  the password field at all (hashed or not) - either the
  currently-authenticated account's own data (`GET /api/auth/me`, session-
  derived, used right after login), or a sanitized directory entry
  (`GET /api/auth/directory` - id/email/name/role only, for Developer/
  Admin filters). Profile edits go through `POST /api/profile/update`,
  which patches only that one account's fields server-side (`role`,
  `lock`, `emailVerified`/`status`, and the verification-code bookkeeping
  fields can't be changed this way - only the auth routes above touch
  those).
- The Admin File Manager (below) *does* allow Developer/Admin to view/
  edit `users.json` as a table (per explicit request) - each row still
  shows a password **hash**, never a real password, so there's nothing
  usable to leak even there.

## Logged-in user
`CURRENT_USER_ID` is no longer hardcoded - it's set the moment someone
logs in (or restored from `localStorage` on page load). Profile, balance,
payment methods, Payment History, Support submissions, and the System
Configuration default are all scoped to whichever account is currently
authenticated.

## Users & roles
`json/users.json` ships 5 users:
| ID | Role |
|---|---|
| U0000001 | Developer |
| U0000002 | Admin |
| U0000003 | User |
| U0000004 | User |
| U0000005 | User |

**U0000001** is `himmat4f1@gmail.com` / `Admin@123456` (Himmat Parmar,
DOB 1983-05-24, mobile 9904143278), 2FA on, with a starting balance of
$100,000 (one `payment-history.json` credit entry + one
`payment-methods.json` card, both tagged to this account).

## Real persistence (py/server.py)
`GET /api/data/:name` / `PUT /api/data/:name` read/write `json/<name>.json`
(allowlisted resources only - see `ALLOWED_RESOURCES` in `py/server.py`).
`app.js`'s `saveJSON()` / `persist*()` helpers call this whenever something
changes. If the server isn't running, saves fail quietly with one warning.

## Profile photos
Uploading a photo (Profile page) sends it to `POST /api/upload-photo`,
which saves the actual image file to `Users/<UserID>/ProfilePhoto/` and
returns that path - `users.json`'s `photo` field stores the **path**, not
a base64 blob.

## Lease Abstraction — the full workflow, step by step
Starting a batch runs a real, multi-step backend pipeline (not a
front-end simulation) via `py/lease_engine.py` and `py/server.py`. Every
step below is a real HTTP call, and every step after upload only ever
touches the current user's own files/log entries.

1. **Output template scan** (once per batch, not counted in any file's
   Progress column) — `POST /api/lease/scan-template`. If a custom
   template was selected it's uploaded to
   `Users/<UserID>/LeaseAbstraction/_templates/`; otherwise the shipped
   `Template/LeaseAbstraction/Default.pdf` is used as the report layout.
2. **Input File Scanning** — the file is actually uploaded
   (`POST /api/lease/upload`) with real upload-progress driving the Scan
   Result column, into a `_staging/` folder.
3. **Checking Balance** — the real per-user balance (own
   `payment-history.json` entries only) is checked against the $1 minimum
   before processing starts.
4. **20% - text extraction** — `POST /api/lease/extract-start` kicks off
   a **background job** and the client polls
   `GET /api/lease/extract-status?jobId=...` every 2s until it's done.
   This is deliberately async (not one blocking call) because OCR on a
   long scanned PDF can take well over a minute - see below for exactly
   what happens inside this step.
5. **40% - data analyzed and interpreted** — `POST /api/lease/analyze`.
   Tries a real LLM call (OpenAI/OpenRouter, whichever key in
   `json/llm-config.json` is marked `"primary"`) using
   `json/extraction_prompt.txt` as the system prompt; falls back to a
   local heuristic regex/keyword engine if no key is configured or the
   call fails. Either way, a second lightweight call
   (`call_llm_validation()`, or a heuristic completeness check without an
   LLM) produces the accuracy/confidence score logged right after this
   step ("Accuracy: NN% (...)").
6. **60% - validation** — `POST /api/lease/validate`: classifies the
   document as Lease/Amendment/Other and checks it isn't a duplicate of
   an already-processed lease. Invalid documents show **"Invalid
   Document"** and already-processed ones show **"Already Processed"**
   directly in the Scan Result column, and the pipeline moves on to the
   next file immediately.
7. **80% - save output** — `POST /api/lease/save-output`: `Output.json`
   is written and the original document is moved from staging to
   `Users/<UserID>/LeaseAbstraction/<LeaseName>/`, with
   `LeaseDocuments.json` updated to list it.
8. **100% - generate PDF** — `POST /api/lease/generate-pdf`: `Output.pdf`
   (the human-readable report) is built from `Output.json`.
9. **Deduct balance** — `$1` is deducted from the user's balance and
   recorded as a new `payment-history.json` entry for that same file.

**PDF text extraction, in more detail** (this is what step 4 actually
does): tries pdfplumber, then pypdf if that comes back too thin
(average characters/page below a threshold - not a flat total, since a
multi-page document where every page only has a tiny stamp can otherwise
still clear a flat total by accident), and only falls back to **real
OCR** (Tesseract, pages rendered via pdfplumber and OCR'd in parallel
across a thread pool) if neither text-layer method found enough - this is
what actually recovers text from a scanned/image-only PDF with no real
text layer, at the cost of being slow (which is why step 4 runs as a
background job rather than one blocking call).

**Rules**: `json/extraction_prompt.txt` is the system prompt sent to the
LLM; `json/rules.json` is the same rule set in structured form (each rule
tagged with the userId of whoever proposed it - see "Lease Abstraction
rules workflow" above for how new rules get added/approved). The
structured rules aren't currently re-injected into the prompt verbatim
(the prompt file already encodes the same rules in prose, and doubling
both would waste tokens) - `rules.json` is there for governance/tracking
and to drive the Update Rules UI.

Translation keeps its original, purely simulated pipeline - it's out of
scope for the real backend work described above.

## Contact Us / Support emails
`json/smtp-config.json` holds the SMTP credentials used by
`POST /api/send-acknowledgement`. Emails (both this one and every
verification-code email) are sent as real HTML (with a plaintext
fallback for clients that don't render HTML) - a branded header, a big
easy-to-select/copy verification code block, and a clean layout instead
of a raw plaintext dump. Note that a real "click to copy" button isn't
possible inside an email itself - virtually every email client (Gmail,
Outlook, Apple Mail, ...) strips `<script>` entirely for security, so
there's no way to run JS inside the email. The code is styled to be easy
to double-click-to-select and copy manually instead. When the email
itself fails to send, the verification card in the app shows the code
directly with a real, working **📋 Copy** button (that one's just a
normal in-app button, so it works properly).

Every message submitted from the Support page's "Send us a Message"
form (moved there from Contact Us) triggers an acknowledgement email to
the logged-in user's own address, sent server-side over SMTP (stdlib
`smtplib`, no extra dependency). `smtp-config.json` is blocked from ever
being served as a static file (`GET /json/smtp-config.json` returns 403)
so the credentials can't leak through the browser.

Every submission gets an auto-generated ID (`SUP001`, `SUP002`, ...).
Clicking a row in the **Supports: Log** table shows that submission's
full details in the "Send us a Message" card - ID, Type, Subject,
Message, Response, and Status are all shown read-only there (Response and
Status are meant to be updated by an admin directly on
`contact-submissions.json` via the Admin File Manager's table editor, not
through this card). Composing a new message shows the same layout with
ID = "New" and blank Response/Status. The log table has row checkboxes +
a header "select all", with Delete (removes the checked submissions) and
Download Excel underneath it. The From/To date filter no longer
pre-fills a default range - every submission shows until a range is
explicitly applied.

## Admin File Manager (Developer/Admin roles only)
Users with role `Developer` or `Admin` see an extra **🗂️ Admin** item in
the profile dropdown (between "My Profile" and "Logout"). It opens a full
file manager over the real project folder - browse, create folders,
upload files, delete, and download - backed entirely by `py/server.py`'s
`/api/admin/*` routes (no external API needed; it's the same local
backend, just new endpoints). Path-traversal is blocked server-side.
`json/users.json`, `smtp-config.json`, and `llm-config.json` are all
viewable/editable through this panel (per explicit request - nothing is
blocked from the authenticated Admin File Manager); they're still blocked
from *direct* unauthenticated static-file access
(`GET /json/users.json` → 403) for anyone not going through this route.

**Clicking a file name** opens it:
- A `.json` file whose root is an **array of flat objects** (e.g.
  `users.json`, `payment-methods.json`, `contact-submissions.json`) opens
  as an editable multi-column table - Add Row / Delete Selected / Select
  All / Save / Cancel. An **empty array** still opens as a table (no
  columns to infer yet) - "+ Add Row" adds a row where you type the JSON
  object directly.
- A `.json` file whose root is an **object** gets smart multi-table
  treatment instead of one flat blob:
  - If it's "a dict of same-shaped sub-objects" (e.g. `messages.json`'s
    `success`/`warning`/`error`/`confirm`/`info`), each top-level key
    becomes one row of a single table (with a `_key` column identifying
    which key it came from).
  - Otherwise, any array-of-objects found at the top level *or* nested
    one level deep (e.g. `rules.json`'s 73-item `approved` list,
    `smtp-config.json`'s `accounts`, `llm-config.json`'s
    `openai.keys`/`openrouter.keys`, `agents.json`'s
    `lease-abstraction`/`translation`, `menu-config.json`'s
    `mainMenu`/`profileMenu`) gets pulled out into its **own** titled
    table, each with its own Add Row/Delete Selected/Select All. Any
    remaining plain scalars (and anything not an extracted array) show in
    a small "General" key/value table at the top. Save reconstructs the
    whole file from all of these pieces at once. A cell whose value is
    itself an object/array shows as editable JSON text; typing valid JSON
    back into it is parsed into the real nested structure on save.
- Genuinely non-JSON text files (`.txt`, `.md`, `.py`, `.js`, `.css`,
  `.html`, `.csv`, ...) open in a dark code-editor-style modal instead,
  also with Save/Cancel and server-side JSON-validity checks where
  relevant.
- Binary/unsupported files (images, PDFs, etc.) can't be previewed - use
  the row's download icon instead.

## Lease Abstraction — LLM-based extraction (OpenAI / OpenRouter)
`json/extraction_prompt.txt` (system prompt) and `json/rules.json` (the
same rules, structured, kept for reference/governance) drive a real LLM
call for the 40% "analyze" step when a key is configured in
`json/llm-config.json` (blocked from static serving, same as
`smtp-config.json` — though now editable through the Admin File Manager,
see above). `py/lease_engine.py`'s `call_llm_extraction()` calls it
directly over `urllib` (no extra dependency), and a second lightweight
call (`call_llm_validation()`) reviews the result for completeness and
returns an accuracy/confidence score - this is logged into the Activity
Log ("Accuracy: NN% (QC validated)") and stored in `Output.json`,
mirroring the reference project's extract → validate two-pass shape.
Both calls use a robust multi-pass JSON parser (`robust_json_parse()`)
rather than relying on the `response_format` API parameter, since not
every OpenRouter model supports it — same approach the reference project
uses. Without a key, both the extraction and the accuracy check fall back
to a local heuristic (regex engine / completeness-based score) - nothing
breaks either way.

⚠️ **The provided API keys' formats look non-standard**
(`chatgpt-sk-proj-...` and `cloude-sk-or-v1-...`); real OpenAI keys start
with `sk-proj-` and real OpenRouter keys start with `sk-or-v1-` (no
`chatgpt-`/`cloude-` prefix). If these were pasted with an extra label
attached by mistake, extraction calls will fail with an auth error - but
that's non-fatal, since the pipeline automatically falls back to the
heuristic engine on any LLM failure. You can view/fix them directly now
through **Admin → llm-config.json** (opens as an editable table, see
above) instead of editing the raw file.

## Lease Abstraction — PDF text extraction (pdfplumber → pypdf → OCR)
Some PDFs (this came up with a real DocuSign-signed lease during testing)
have almost no real text layer despite looking like a normal document -
every page is actually a scanned/flattened image, and the only real text
on the page is a tiny "Docusign Envelope ID: ..." stamp. `extract_text()`
now:
1. Tries pdfplumber.
2. If the **average characters per page** is too low (a flat total-length
   check is fooled by many pages each contributing just a small stamp -
   this is what caused a real 26-page lease to extract only ~300 chars
   total and get misclassified as "Invalid Document"), tries pypdf too
   and keeps whichever gives more text.
3. If still too little, falls back to **real OCR** (renders each page to
   an image via pdfplumber, runs Tesseract via `pytesseract`) - this is
   the only thing that actually works for genuinely scanned pages, and
   it's what recovered the full 63,000+ characters of real lease text
   from that test document. OCR is slow (several seconds per page - the
   26-page test document took ~110s total) but only kicks in when the
   faster text-layer methods clearly aren't working.

**Requires the `tesseract-ocr` system package** (not just the `pytesseract`
pip package) - `.devcontainer/devcontainer.json`'s `postCreateCommand` now
installs it automatically via `apt-get`. If you're not using the
devcontainer, install it manually (e.g. `sudo apt-get install tesseract-ocr`
on Debian/Ubuntu) or OCR will be skipped with a console warning (falls
back to whatever the text layer had, which may correctly be flagged
"Invalid Document" if that's genuinely too little to classify).

Document-type classification (`classify_document()`) was also too
trigger-happy about calling something an "Amendment": a real, original
26-page lease got misclassified because it incidentally mentions the word
"amendment" a couple of times in ordinary boilerplate (e.g. "...including
all amendments thereto...", "...amended... only by an instrument in
writing..."). It now requires either a **strong, title-like** amendment
phrase ("first amendment", "this amendment", "hereby amends", ...) or
several incidental mentions **combined with weak lease evidence**, so a
couple of stray mentions inside an obviously-complete lease document no
longer overrides the overwhelming lease-document signal.

## Secrets live in .env now, not json/ files
`json/llm-config.json` and `json/smtp-config.json` are gone -
**committing real API keys/passwords in a tracked JSON file got git
pushes blocked by GitHub's secret-scanning push protection.** All of
that now lives in `.env` (already filled in with working values,
gitignored, never committed) - see `.env.example` for the full list of
variables and what each does. `.env` is also blocked from the Admin File
Manager and from direct static access, same as `users.json`.

If you ever need to change the API key, SMTP password, etc., edit `.env`
directly and restart the server (`python3 py/server.py`) - environment
variables are only read at startup. For a Render deployment, set these
under the service's **Environment** tab in the Render dashboard instead
(see `render.yaml`) - `.env` itself never reaches Render since it isn't
in the repo.

## Registration rules
- One email = one account. Trying to register an email that's already a
  **verified** account is rejected.
- Trying to register an email that has an account but was **never
  verified** doesn't create a second account or reject the request -
  it looks up that same pending account and resends its verification
  code (picking up any edited name/mobile/password from the new attempt).
- A brand-new account is `status: "InActive"` / `emailVerified: "No"`
  until the code is verified, and login is blocked until then. Verifying
  flips it to `status: "Active"` / `emailVerified: "Yes"`.
- `mobileVerified` stays `"No"` for everyone - there's no real mobile OTP
  flow yet, so nothing ever sets it to `"Yes"`.

- **Footer position and the center content area's internal scrollbar**
  were broken by the `#appShell` wrapper div added for the login gate -
  `body`'s old `display:flex; flex-direction:column` (which made the
  footer stick to the bottom and let `.center-content` scroll internally)
  needed to move onto `#appShell` instead, since that's the flex column
  now (the auth screen sits outside it so it can cover the full viewport
  on its own before login). Fixed in `css/style.css`.
- **Lease Abstraction "Request to /api/lease/extract failed"** on a large
  scanned PDF - OCR-ing every page in one HTTP request/response cycle was
  slow enough (~110s for the 26-page test document) to plausibly exceed a
  proxy/gateway timeout somewhere in the request path. OCR now runs pages
  in parallel across a thread pool (tesseract runs as a real subprocess
  per page, so this isn't GIL-limited) at a slightly lower, still-accurate
  resolution - a meaningful speedup, especially on a multi-core Codespace.
- **Uploaded Files card** height increased (now comfortably shows 5+ rows
  before scrolling) and **Files and Folder (Admin)** card height reduced.
- Every card across the app now gets a "hero" hover/focus highlight
  (border color + shadow lift) for consistency.
- The 📍 pin symbol was removed from the page header breadcrumb.
- The message box (`showMessage`/`showWarning`/`showConfirm`) now uses
  the app's actual brand gradient for its title bar instead of a flat
  navy color, with a cleaner body background.
- Top menu bar and footer now use the same dark navy gradient background
  as the login screen (previously transparent/white), with all text/icon
  colors in that area adjusted for contrast.

## Deploying on Render (or any Docker host)
`Dockerfile` + `render.yaml` are included. A Dockerfile is used
specifically because Render's native "detect Python, pip install" build
path has no way to run `apt-get` - and the OCR fallback needs the real
`tesseract-ocr` **system** package, not just the `pytesseract` pip
package. In the Render dashboard: **New → Blueprint**, point it at this
repo, and `render.yaml` is picked up automatically. Works the same way on
Railway/Fly.io/any other platform that deploys a Dockerfile, or a plain
VPS (`docker build -t lexora . && docker run -p 8000:8000 lexora`).

⚠️ Render's free tier has an **ephemeral filesystem** - anything written
to `Users/` (profile photos, processed leases) is lost on redeploy/restart
unless you add a paid-plan persistent disk mounted at `/app/Users`.

- **Support Log row click not showing details** - the *actual* root
  cause (found by scripting a real headless-DOM test of the click path,
  not just re-reading the code): `json/contact-submissions.json` still
  had its original 4 sample entries from the very first revision, and
  they predate the `id` field entirely - so `selectSupportRow('undefined')`
  never matched anything. Cleared the stale sample data, and
  `renderSupportRows` now also self-heals by backfilling an id for any
  record that's ever missing one (e.g. hand-edited via the Admin File
  Manager), so this class of bug can't silently recur.
- **"Request to /api/lease/extract failed" / 504** - confirmed as a
  reverse-proxy/gateway timeout (the browser console showed an actual 504
  status). Extraction now runs as a **background job**
  (`POST /api/lease/extract-start` returns instantly with a job id,
  `GET /api/lease/extract-status?jobId=...` is polled every 2s) instead of
  one long blocking request - no single HTTP request ever takes more than
  an instant now, regardless of how long OCR takes server-side. Verified
  end-to-end against the real 26-page scanned test document: every
  request (start + all ~49 polls) completed in under 0.02s each, with the
  full 63,000-character extraction finishing in the background in ~90s.
- Support page: log table is now **full width**; "Send us a Message" is a
  **popup** (✕ close button, top right) opened by clicking a row or the
  new "➕ Create New" link next to the Delete button, instead of a
  permanently-visible side panel.
- Login screen now shows the actual `Pictures/logo.png` (was a generic
  ⚖️ emoji) on a white background, matching the top bar's logo box.

## Per-user data isolation (Lease/Translation files + activity log)
`json/lease-files.json`, `translation-files.json`, `lease-activity-log.json`
and `translation-activity-log.json` all hold **every user's** data in one
shared file (same pattern as payments/support). Every file/log entry now
carries a `userId`, and the frontend always reads through
`getMyLeaseFiles()` / `getMyTranslationFiles()` / `getMyLeaseActivityLog()`
/ `getMyTranslationActivityLog()` instead of the raw arrays - this was
missing before, so one user's uploads/processing history could show up in
another user's session. Clear Files now only clears the current user's
own entries.

## Dashboard
"Total Lease Abstraction" / "Total Translation" are real counts now
(previously hardcoded placeholder numbers) - Lease Abstraction counts
actual `Users/<id>/LeaseAbstraction/*` folders on disk (via
`GET /api/lease/list`), Translation counts `completed` entries in
`translation-files.json` for the current user (translation is still a
simulated pipeline, so there's no real output folder to count on disk
for it). A new **My Processed Leases** card lists every lease you've
processed as a link - clicking one opens a popup showing everything in
its `LeaseDocuments.json` plus `Output.pdf`, each with a real download
link (`GET /api/lease/download`). The file table's own "Download" action
was also fixed - it was still the original demo's placeholder
(`showMessage('Downloading...')`, no real download ever happened) and now
actually downloads `Output.pdf` via that same endpoint.

## Balance centralization + Developer/Admin-wide visibility
Whoever adds balance (User/Admin/Developer), that top-up also books a
second "Balance Received" entry on the **Developer's** own account
(revenue), separate from the entry that makes the adding user's own
spendable balance go up (`getCurrentBalance()` always uses only a
user's own entries, regardless of role). On the Payment History and
Support pages, Developer/Admin see **everyone's** entries (with a User ID
column) plus a User ID/email filter next to Clear/Reset; a plain User
still only ever sees their own. A new sanitized `GET /api/auth/directory`
endpoint (id/email/name/role only, never a password) backs the email
part of that filter and the balance-centralization lookup.

## Notifications
New **🔔 Notification** item in the profile dropdown (My Profile / Admin
/ Notification / Logout), with an unread-count badge on the avatar.
Adding balance generates one automatically. The page is a table (Date &
Time / Description / Status / Read-Unread + Remove actions); clicking the
description opens a detail popup and marks it Read. Backed by
`json/notifications.json`.

## Lease Abstraction rules workflow ("📐 Update Rules")
New button in the Lease Abstraction Setup card, left of System
Configuration. All 73 built-in rules in `json/rules.json` now carry a
`userId` (set to the Developer account). Any user can propose a new rule
from the popup - it's saved into `rules.json`'s `"pending"` array tagged
with their own userId and has no effect on extraction until approved.
Only when logged in as the Developer role does the popup show
Approve/Reject actions on pending rules (moving one to `"approved"` is
what actually makes it apply) - `POST /api/rules/propose` /
`/api/rules/approve` / `/api/rules/reject`, `GET /api/rules/list`.

## Verification emails send in the background now
Login/register/forgot-password/resend all respond **immediately** (confirmed
under 0.1s in testing, vs. up to 6s before) instead of waiting on the SMTP
connection - the email itself sends in a background thread
(`_send_verification_email_async` in `py/server.py`). The verify card
shows up right away; the frontend then polls `GET /api/auth/email-status`
a few times a second apart, and if the send turns out to have failed, the
fallback code + copy button appear in the (already-visible) card at that
point instead of blocking the initial screen on it.

## Support tickets
Ticket IDs are `YYMMDD` + a 5-digit daily sequence (e.g. `26070200001` for
the first ticket on 2026-07-02), so they sort by date and are sequential
within a day. **Create New** only ever shows Type/Subject/Message (no
ID/Status/Response at all) - submitting emails the user an acknowledgement
with their new ticket ID. Opening an existing ticket shows "🎫 Ticket
Details": a plain User sees everything read-only with no buttons;
Developer/Admin can change Status (a real Pending/WIP/Resolved dropdown)
and write a Response, then Submit - which emails the ticket's original
owner with the update. Developer/Admin can never edit what the user
actually wrote (Type/Subject/Message stay read-only for everyone).

## Reliability: server auto-start in Codespaces
If the Codespace kept needing `python3 py/server.py` typed by hand: the
background-process detachment now uses `setsid` (not just
`nohup & disown`, which could still get killed when postStartCommand's
own shell was torn down in some Codespaces execution contexts), and
`.devcontainer/devcontainer.json` also runs the start script on
`postAttachCommand` (every reconnect) as a second safety net, not just
`postStartCommand` (codespace start/resume only). Static files
(HTML/CSS/JS) are also now served with `Cache-Control: no-cache` so a
browser/proxy never serves a stale cached copy after an update.

## Production-readiness upgrades
Four things flagged as prototype-only gaps are now real:

**Passwords are hashed** - PBKDF2-HMAC-SHA256, 600,000 iterations (stdlib
`hashlib` only, no bcrypt/argon2 dependency to install - works the same on
every deployment target this project runs on). All 5 seed users'
passwords in `json/users.json` are already hashed; any account that
somehow still had a plaintext password gets transparently upgraded to a
real hash on its next successful login. `/api/auth/me` and
`/api/profile/update` never send a password (hashed or not) to the
browser anymore, and the Profile page's password field is blank by
default (not pre-filled with the real password) - leave it blank to keep
the current password.

**Real sessions, not a trusted client-supplied userId** - login (direct or
after 2FA) now returns a real opaque session token
(`secrets.token_urlsafe`), which the frontend attaches as
`Authorization: Bearer <token>` on every request after that (see
`authFetch()` in `js/app.js`). The server derives *who you are* from that
token now, not from a `userId` field the client could previously just
edit in localStorage to act as someone else - every route that acts on a
specific user's data cross-checks the session against the requested
userId (matching account, or Admin/Developer). Sessions are in-memory
only (a server restart naturally logs everyone out - no separate
revocation-list bookkeeping needed) with a 7-day expiry. Logout now
actually revokes the token server-side (`POST /api/auth/logout`), not
just locally.

**Translation has a real pipeline now** - previously entirely
`setTimeout`-simulated. Real upload → real (OCR-capable, same async job
as Lease Abstraction) text extraction → real LLM translation
(`lease_engine.translate_text()`, same OpenAI/OpenRouter key from `.env`)
→ real saved output (`Users/<id>/Translation/<docName>/`, `Output.json` +
`Translated.txt` + `Output.pdf`) → real download
(`GET /api/translation/download`). Falls back to returning the original
text with a clear "no LLM configured" note if no key is set, same
convention as lease extraction's heuristic fallback.

**Newly-approved rules apply immediately, not just after editing
`extraction_prompt.txt` by hand** - the original 73 rules are marked
`"builtin": true` (already baked into `extraction_prompt.txt`'s prose, so
they're never re-injected - that would just double token usage for no
benefit). Anything approved through the 📐 Update Rules UI after that
doesn't have that flag, and `lease_engine.load_extraction_prompt()` now
appends those as an extra prompt section on every call, live - approve a
rule as Developer and the very next extraction already uses it.

## LLM provider failover + heuristic accuracy fixes
Found via a real test document (a dense 26-page industrial lease) that
was falling all the way back to the heuristic engine: `call_llm_extraction()`
/ `call_llm_validation()` / `translate_text()` now all try the *other*
configured provider (OpenAI ↔ OpenRouter) if the primary one's call
itself fails, instead of giving up straight to the heuristic engine the
moment the first provider has a hiccup - verified with a mocked
primary-fails/fallback-succeeds test. The default OpenRouter model was
also switched to `anthropic/claude-sonnet-4` (was pointed at another
OpenAI model) - a fallback to "a different route to the same underlying
API" doesn't help if that API itself is the problem.

Also fixed two real accuracy bugs in the **heuristic** fallback engine
(used whenever neither provider is configured or both fail) - verified
against the actual reference lease document:
- Lease End Date used to just grab "the 2nd date found anywhere in the
  document", which easily picked up an unrelated date (e.g. an
  "Estimated Commencement Date") instead of the real expiration date.
  Now looks for a date specifically near an "Expiration Date"/"Lease
  Expiration"/"Termination Date" label first.
- Party names (Landlord/Tenant) used to cut off at the very first line
  break, truncating any name that wraps across a PDF table cell's
  multiple lines (a real one was missing a whole "AND ... LLC" clause).
  Now captures a few continuation lines and stops at a blank line or the
  next label - including labels using a curly apostrophe ("LANDLORD'S
  ADDRESS"), which was silently failing to match as a boundary before
  and let the value run on into unrelated text.

## Fixed: "Maximum call stack size exceeded"
`processLeaseFileAt`/`processTranslationFileAt` used to recurse via
`return processLeaseFileAt(fileIndex + 1)` - harmless most of the time,
but the fast-path for an already-`'completed'` file hit that recursive
call with **no `await` before it**, so a batch with many already-completed
files in a row could build up real JS call-stack frames synchronously
before ever yielding to the event loop, eventually overflowing the
stack. Both are now plain iterative `for`/`continue` loops instead of
recursion - there's no longer any call depth that scales with file count
at all.

## Major additions: Account Statement, System Configuration, Messaging Settings, AI Prompts

### Account Statement & Receipt PDFs
- New "Download Account Statement" button (Payment Summary) and a per-row
  receipt download icon (Payment History, any row with a Credit amount) -
  both server-side reportlab PDFs (`_build_account_statement_pdf` /
  `_build_receipt_pdf` in `py/server.py`).
- Rounded cards with a simulated soft shadow, a real doughnut chart (built
  from `Wedge(..., radius1=inner_r, annular=True)` - note `innerRadius=`
  is **not** a real Wedge parameter and is silently ignored; `radius1` +
  `annular=True` is the actual API), navy/green/red/grey exact palette,
  repeating header + customer-info card on every page, "To be
  continued..." / 4 closing feature-badges, and a green rounded
  page-number badge.
- Dates print as `DD Mon YYYY`, times as 24-hour `HH:MM` (no AM/PM)
  throughout this PDF.
- Summary Period falls back to the actual min→max date span of the listed
  transactions when no explicit filter range was given, instead of a
  vague "As on Today".

### System Configuration (per-service storage destination)
- **Services Catalog** table gained a `systemConfig` Yes/No column - only
  services with this set to `Yes` show a "System Configuration" dropdown
  in their Setup card at all.
- **System Configurations** table (`doc_system_configs`) is the
  admin-managed list of systems offered in that dropdown. `Desktop` is
  the only hardcoded/always-present entry - everything else (Google
  Drive, Dropbox, Sharefile, a plain "Email" label, etc.) comes purely
  from this table; don't hardcode more names into `SYSTEM_CONFIG_BASE`
  in `js/app.js`.
- Selecting a browser-managed provider (Google Drive/Dropbox/Box/
  OneDrive/WebDAV/SFTP - matched by name in `KNOWN_BROWSER_PROVIDERS`)
  opens `StorageDestinations.openConfig()` for a pasted-credential setup;
  anything else falls through to the server-managed OAuth check
  (Sharefile/Sharepoint's real registered app).
- When System Configuration is present on a service, a finished file
  shows a **download link** to click (`showDownloadLinkModal`) instead
  of auto-downloading; without it, direct download is unchanged. Wired
  into Lease Abstraction (`downloadSessionBlob`) and every ServiceRunner
  free tool (`smartDownload` in `js/service-runner.js`).

### Messaging Settings (per-event notification on/off)
- New **Messaging Settings** table (`doc_messaging_settings`) - 13 fixed
  events (Password Change, Login OTP Verification, New Login
  Notification, Incorrect OTP, Registration, Password Change
  Verification, Plan Change, Account Delete OTP, Account Delete, Create
  Ticket, Update Ticket, Payment Received, Payment Rejected), each a
  Yes/No row. `_messaging_enabled(event_key)` in `py/server.py` is the
  gate every real send checks first; defaults to `True` (sends) if the
  table's empty or the event isn't in it yet, so a blank table never
  silently mutes everything.
- Several of these events didn't have a real send-path before and were
  added: Password Change confirmation, Plan Change notice, Payment
  Received/Rejected, and a proper 2-step Account Delete flow
  (`/api/auth/delete-account-request` then `/api/auth/delete-account`,
  the OTP step only appearing when Account Delete OTP is turned on).
  Incorrect OTP is checked at all 5 places a code gets verified
  (register/login/reset/reset-password/mobile).

### AI Prompts (admin-editable prompt text)
- New **AI Prompts** table (`doc_ai_prompts`): Service Name, Prompt #,
  Prompt Text, File Location. `window.getAiPrompt(serviceName,
  promptNumber, defaultText)` in `js/app.js` is the lookup every wired
  service calls - DB text wins only if it's actually non-empty, so an
  unedited/empty table changes nothing.
- **Wired so far:** BAI2 (2 prompts), Data Extraction (2 prompts, split
  into an editable intro/rules portion and a code-generated
  fields-list portion that must stay dynamic).
- **Not yet wired** (still hardcoded in Python/JS, seeded as empty
  placeholder rows pointing at the real file so the next pass knows
  where to look): Translation (`js/engine-translation.js`), OCR
  (`js/ocr-service.js` + `js/engine-ocr.js`), Content Writing Tool, Humanize Document Tool.
  Lease Abstraction's prompt is a special case - its real text lives in
  `json/extraction_prompt.txt` and gets read into the AI Prompts row at
  migration time so it's visible/editable there, but `lease_engine.py`
  itself still reads the `.txt` file directly rather than the DB row.

### Run Migration (one button, reused going forward)
- A single **"⤴ Run Migration"** button above the Admin PostgreSQL tab
  strip, calling `_handle_run_migration` in `py/server.py`. Seeds
  Messaging Settings' 12 fixed events and AI Prompts' placeholder/real
  rows in one click; safe to run repeatedly since it only ever appends
  what's missing, never touches an existing (possibly admin-edited) row.
  **Any future one-time setup/seed step should be added as another block
  inside this same function, not a new button.**

### Notable bugs found and fixed along the way
- The Account Overview / Transaction Overview cards had a real asymmetry
  bug - `ov_box` was missing the `rowHeights=` that `tx_box` had, and
  `tx_box` was missing the `ROUNDEDCORNERS` that `ov_box` had - so they
  could render at slightly different heights despite the shared
  `BOX_BODY_HEIGHT` constant. Both Tables now specify identical
  `rowHeights` and style commands.
- ServiceRunner's drag-and-drop zone (`.drop-zone`, "Drag & drop files
  here") had no `ondragover`/`ondrop` handlers wired to it at all - the
  text invited dragging but nothing happened. Fixed in
  `js/service-runner.js` (`onDrop`/`onDragOver`/`onDragLeave`).

## Known fixes in this revision
- **Clear Files** no longer writes an "All files ... cleared" activity
  log entry — the log is simply emptied.
- **Uploading a file** no longer writes a "Saved to ..." activity log
  entry — only real processing steps (Start → 0/20/40/60/80/100%) are
  logged now.
- The Contact Us page's leftover `resetContactForm()` call (now dead
  code since the form moved to Support) was removed from the page-load
  dispatcher in `updateContent()`.
- **Logout** now actually clears the session and returns to the login
  screen, instead of just showing a static "you're logged out" message
  while staying logged in underneath.
- **Footer position and the center content area's internal scrollbar**
  were broken by the `#appShell` wrapper div added for the login gate -
  `body`'s old `display:flex; flex-direction:column` (which made the
  footer stick to the bottom and let `.center-content` scroll internally)
  needed to move onto `#appShell` instead, since that's the flex column
  now (the auth screen sits outside it so it can cover the full viewport
  on its own before login). Fixed in `css/style.css`.

## ⚠️ Important — How to run it
### In GitHub Codespaces
Opening this repo in a Codespace now does everything automatically:
- `postCreateCommand` installs the `tesseract-ocr` system package (for
  scanned-PDF OCR fallback) and `requirements.txt`
- `postStartCommand` starts `py/server.py` in the background if it isn't
  already running
- opening the forwarded port's base URL serves `index.html` directly (it's
  literally named `index.html`, so no redirect is even needed anymore)

If you ever need to (re)start it by hand:
```bash
python3 py/server.py
```

### Running locally
```bash
sudo apt-get install tesseract-ocr   # needed for scanned-PDF OCR fallback
cd main
pip install -r requirements.txt
python3 py/server.py
```
Then visit **http://localhost:8000/**.

(`PORT=3000 python3 py/server.py` to use a different port.)
