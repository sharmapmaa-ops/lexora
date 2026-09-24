# Translation background-job system (Phase 4a)

## Why this exists

Before this, the entire pdf.js text-layer translation pipeline
(`buildPdfjsTranslatedDocxBlob`) ran in the browser. If the user closed
the tab, refreshed, or the connection dropped mid-translation, the work
was lost. This system moves the actual processing to a server-side
background job that keeps running regardless of what the browser does.

## How it works

1. **Start** (`POST /api/translation/job/start`): the browser uploads
   the file; the server saves it to
   `backend/Users/<userId>/Translation/_jobs/<jobId>/input.pdf`, writes
   a `job.json` record, and spawns
   `node backend/worker/translation_worker.js <jobDir>` as a **detached**
   process (its own session, not a child of the HTTP request) - then
   returns `{jobId}` immediately.

2. **The worker** (`backend/worker/translation_worker.js`) is a Node
   port of the exact same pipeline used in the browser
   (`frontend/js/engine-translation.js`) - it extracts and evaluates the
   same function bodies at startup rather than duplicating them, so a
   fix to the browser file's functions is picked up here too. It calls
   back into this same server's own `/api/data/translation-domains`,
   `/api/data/translation-rules`, and `/api/translation/vision-proxy`
   routes - exactly as the browser itself would - for the domain-expert
   glossary, learned rules, and the actual OpenRouter call.

3. **Status** (`GET /api/translation/job/status?jobId=...`): the
   browser polls this every few seconds; it just reads `job.json` and
   returns it (minus the session token). `progressLog` is an
   append-only list the worker writes to as it goes.

4. **Result** (`GET /api/translation/job/result?jobId=...`): once
   `status` is `"done"`, this returns the finished `.docx` as base64.

5. **Active** (`GET /api/translation/job/active?userId=...`): lists
   this user's jobs that are `queued`, `processing`, or `done` (not yet
   downloaded/dismissed) - not `failed`, since a failed job isn't
   something to "resume". This is what lets the frontend detect an
   in-progress or finished job when the Translation service loads,
   instead of showing a blank upload screen.

## What is NOT changed

Billing/wallet logic stays exactly as it was - entirely client-side,
driven by `paymentHistory`/`addActivity` once the browser sees the job
finish and downloads the result. This system only moves the heavy
PDF-processing step; it does not touch how charges are calculated or
recorded.

## Known limitations (see delivery notes)

- The resume notice (on app load, via `checkForActiveTranslationJobs` in
  `frontend/js/app.js`) is informational only: it tells the user a job
  is processing or finished, but does not yet let them download/bill a
  "done" job directly from that notice - they still complete it through
  the normal Translation service flow. Wiring a "claim" action into the
  notice itself, reusing the exact one-time billing path, is the next
  step.
- Only the Translation service uses this background-job approach so
  far (Phase 4a). OCR, Data Extraction, Calculators, and BAI2 still run
  entirely in-browser.
