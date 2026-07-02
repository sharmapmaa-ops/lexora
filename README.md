# Lexora AI Solutions — Company Menu System

## Folder Structure
```
main/
├── main.html               ← open this in the browser (auto-loads, see below)
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

### Important security change this required
Now that login is real, `users.json` holds live plaintext passwords and
verification codes for every account - so it can no longer be handed to
every visitor wholesale the way it was before:
- `users.json` is blocked from static serving (`GET /json/users.json` →
  403), same as `smtp-config.json` / `llm-config.json`.
- `"users"` was removed from the generic `/api/data/<name>` allowlist
  entirely - there is no more "fetch/overwrite the whole file" route for
  it.
- The browser only ever receives **one** user record at a time - either
  the currently-authenticated account's own data
  (`GET /api/auth/me?userId=...`, used right after login), or nothing.
  Profile edits go through `POST /api/profile/update`, which patches only
  that one account's fields server-side (`role`, `lock`,
  `emailVerified`/`status`, and the verification-code bookkeeping fields
  can't be changed this way - only the auth routes above touch those).
- The Admin File Manager (below) also specifically blocks viewing,
  editing, or downloading `json/users.json`'s raw contents, even though
  Developer/Admin can browse/delete it like any other file.

Passwords are still stored in **plaintext** (consistent with the rest of
this prototype's simple JSON-file architecture, and because there's no
password hashing anywhere else in the project either) - worth hardening
(e.g. bcrypt) before this ever goes anywhere near production.

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

## Lease Abstraction — real processing pipeline
Starting a batch now runs a real, multi-step backend pipeline (not a pure
front-end simulation) via `py/lease_engine.py`:

1. **Output template scan** (once per batch, not counted in any file's
   Progress column) — `POST /api/lease/scan-template`
2. **Input File Scanning** — the file is actually uploaded
   (`POST /api/lease/upload`) with real upload-progress driving the Scan
   Result column
3. **20%** — real text extraction from the PDF/DOCX — `POST /api/lease/extract`
4. **40%** — lease-field analysis — `POST /api/lease/analyze`
5. **60%** — document-type + duplicate validation — `POST /api/lease/validate`
6. **80%** — `Output.json` written, document saved to
   `Users/<UserID>/LeaseAbstraction/<LeaseName>/`, `LeaseDocuments.json`
   updated — `POST /api/lease/save-output`
7. **100%** — `Output.pdf` generated from `Output.json` — `POST /api/lease/generate-pdf`

Invalid documents show **"Invalid Document"** and already-processed leases
show **"Already Processed"** directly in the Scan Result column, and move
on to the next file immediately, per spec.

**About the "GPT prompts" step:** no LLM API key was provided anywhere in
this project (`agents.json` ships every agent with `"apiKey": null`), so
step 4 is a deterministic regex/keyword extraction engine instead of a
live GPT call - it's intentionally isolated in
`lease_engine.analyze_lease()` as a single drop-in point to swap in a real
prompt-based call later if a key is added.

**About custom templates:** selecting a template file now really uploads
it to `Users/<UserID>/LeaseAbstraction/_templates/`, and `Output.pdf` is
still generated using the same built-in report layout (Field/Value table)
for every lease — genuinely re-creating an arbitrary uploaded PDF/DOCX's
exact visual layout automatically isn't feasible without a template
engine, so the custom file is stored and referenced by name in the
generated report rather than used as a pixel-for-pixel layout source.

The **Default.pdf** shipped in `Template/LeaseAbstraction/` didn't exist
anywhere in the original project (nothing was ever actually configured as
a "default output template" — it was just a text label in the UI), so a
default template was generated using the same report layout `Output.pdf`
uses.

Translation keeps its original, purely simulated pipeline — section 14 of
the spec only covers Lease Abstraction.

## Contact Us / Support emails
`json/smtp-config.json` holds the SMTP credentials used by
`POST /api/send-acknowledgement`. Every message submitted from the
Support page's "Send us a Message" form (moved there from Contact Us)
triggers an acknowledgement email to the logged-in user's own address,
sent server-side over SMTP (stdlib `smtplib`, no extra dependency).
`smtp-config.json` is blocked from ever being served as a static file
(`GET /json/smtp-config.json` returns 403) so the credentials can't leak
through the browser.

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

## Multiple SMTP accounts / LLM keys, with a primary
`json/smtp-config.json` now holds an `"accounts"` array (each with its own
host/port/username/password/sender_email) and `json/llm-config.json` holds
a `"keys"` array per provider (`openai`/`openrouter`), each entry with its
own `apiKey`/`model`. Mark exactly one entry `"primary": true` in each
list - that's the one actually used (falls back to the first entry if
none is marked). Both are editable as ordinary tables now through the
Admin File Manager. The provided OpenAI/OpenRouter keys are already in
place as the primary entry for each provider, in the correct format this
time (`sk-proj-...` / `sk-or-v1-...`).

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
- opening the forwarded port's base URL (no `/main.html` needed) redirects
  straight to `main.html`

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
Then visit **http://localhost:8000/** (redirects to `/main.html`).

(`PORT=3000 python3 py/server.py` to use a different port.)
