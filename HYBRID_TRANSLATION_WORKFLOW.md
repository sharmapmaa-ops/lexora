# Lexora Hybrid Translation — Process Workflow

This document explains, step by step and with examples, exactly how a scanned
PDF page becomes a layout-preserving translated DOCX/PDF in **Hybrid mode**.
It covers the CURRENT pipeline, where each of your requested changes fits, and
the two options for background reconstruction (CV inpainting vs. AI fill).

---

## The core idea (your model, restated)

> Every **visual line** in the original is its own **block**.
> A sentence that wraps across 3 lines = **3 line-blocks grouped together**.
> The translation is then **flowed across those grouped line-boxes at one
> uniform font size**, and if any box would overflow, the font size is
> reduced until it fits.

Everything below serves that idea.

---

## End-to-end pipeline (per page)

### STEP 1 — Render the page to an image
The PDF page is rasterized at 300 DPI to a clean RGB image. This is the single
source of truth for everything that follows (works for scanned pages where
there is no digital text layer).

### STEP 2 — Detect the "furniture" of the page (OpenCV, no AI)
We find three kinds of things purely from pixels:

1. **Coloured illustrations / figures** — a green foliage / vivid-colour blob
   pass finds pictures (e.g. the botanical plant on page 2). These are marked
   `is_graphic` and will be preserved as images, never translated.
   *Example:* the plant drawing → one graphic region.

2. **Text lines** — adaptive threshold + morphology finds ink, frame lines are
   removed, and shards of one line are glued. Then:
   - **Big merged blobs are split back into lines** using a smoothed
     horizontal ink-projection ("valley detection"), which works even for
     connected Arabic script where the gap between lines is only a few pixels.
   - *Example:* the certificate body "In recognition of her efforts … Asbouha
     180" is detected as **3 separate line-boxes**.

3. **Everything else** (logos, badges, signatures) will be classified in the
   next step.

### STEP 3 — Group line-boxes into paragraph blocks
Consecutive lines that are vertically close, horizontally overlapping and
similar in height are grouped into ONE block that **keeps its per-line boxes**.

*Example output for the certificate body:*
```
Block (paragraph, 3 line-boxes):
    line 1:  y=1763–1854   x=441–2019
    line 2:  y=1857–1944   x=561–1995
    line 3:  y=1961–2037   x=419–2019
```
A single heading or label becomes a 1-line block. Graphic regions never group.

### STEP 4 — One structured vision call for the whole page
The page image, with every block drawn as a **numbered red box**, is sent to
the vision model **once**. For each box it returns JSON:
```json
{ "n": 5, "class": "translatable",
  "text": "…the original…", "translation": "In recognition of her efforts …",
  "color": "1B4D3E", "bold": false, "italic": false, "underline": false,
  "align": "center", "is_paragraph": true }
```
- `class` = translatable | nontranslatable (logo/signature/QR/**illustration**)
  | decoration (watermark, empty).
- Direction is **not** asked for — it is set later by the OUTPUT language.

**This is the ONLY AI call per page in the fast path.** (See "Speed" below.)

### STEP 5 — Classify each block into the 3 output layers
- **translatable** → its ink is added to the erase-mask (Step 6) and it becomes
  an editable **Layer-3 text item** carrying its `line_boxes`, colour, style,
  alignment, and `is_paragraph`.
- **nontranslatable** (logo, signature, QR, illustration, or any `is_graphic`
  blob) → cropped to a **transparent PNG** and kept as a floating **Layer-2**
  object at its exact position. Its pixels are **protected** from erasure.
  *Example:* plant → `elem2_xxx.png`; signature → its own PNG.
- **decoration / empty** → added to the erase-mask, never re-added.

Nested boxes are handled: text printed *inside* a logo/badge is treated as part
of that one logo PNG (so the logo is never gouged with a hole).

### STEP 6 — Reconstruct the clean background (Layer 1)
The erase-mask (translatable ink + decorations) is removed and the hole is
filled so the page's own paper/pattern flows back in. **Two options:**

- **(A) CURRENT — CV inpainting** (`cv2.inpaint`, Navier-Stokes). Fast, free,
  offline. Good on flat/parchment backgrounds; on very ornate patterns it can
  leave a faint smudge.
- **(B) PROPOSED — AI generative fill** (your point 1). The masked page is sent
  to an image-editing model (e.g. OpenAI `images/edits`) which paints the
  removed areas to match the surrounding design. Best quality on ornate
  backgrounds, but adds one image API call (cost + a few seconds) per page.

Both produce **Layer 1**: the page with all translatable text and decorations
gone, but logos/signatures/illustrations still in place.

### STEP 7 — Compose the three layers
1. **Layer 1**: reconstructed background image, full page.
2. **Layer 2**: each non-translatable PNG placed at its original box.
3. **Layer 3**: translated text. For each block, the translation is **flowed
   across its line-boxes** by `_flow_text_across_lineboxes` at a single uniform
   font size; if the text is too long for the boxes, the font size is reduced
   until it fits (**your point 2 — no overflow**). Direction follows the target
   language (LTR target → all left-to-right; RTL target → all right-to-left).

*Example (English target):*
```
line 1: In recognition of her efforts in the weekly team challenge,
line 2: wishing her all success and guidance
line 3: continued brilliance in the sky of Asbouha 180
```
All three at the same font size, each on its own original line.

### STEP 8 — Emit the deliverable
- **DOCX (default):** background as a behind-text full-page picture, each
  Layer-2 element as a floating image, each produced text line as its own
  transparent Word text box. Real, editable, selectable.
- **PDF (optional):** same layers drawn with real selectable text.
- When DOCX is chosen, there is **no DOCX→PDF conversion** step.

---

## Speed (your point 4)

The 5-minutes-per-file came from **too many vision round-trips**:
- metadata call (1× per page) — necessary.
- reviewer agent (1× per page, sometimes 2 rounds) — **a second+ round-trip**.

Changes made:
- **Reviewer is now OFF by default** (opt-in via `LEXORA_ENABLE_REVIEWER=1`).
  This removes ~half the vision calls → roughly halves the time.
- **Background reconstruction is faster** (fewer inpaint passes, and the mask is
  built once). If AI fill (Step 6B) is enabled it is 1 extra image call.

**Fast path now = exactly ONE vision call per page.** For a 2-page file that is
2 calls total instead of 4–6.

Further speedups available if you want them:
- Process the 2 pages **in parallel** (threads) — halves wall-clock again.
- Cache identical pages / regions by content hash.
- Lower render DPI to 200 for detection, keep 300 only for the final crop.

---

## Per-letter colour & style (your point 3)

Today we read ONE colour/style per line from the vision model. Your point is
that a single line can have letters of **different colours/styles** (e.g. a red
word inside black text, as on the manuscript). Planned handling:
- Ask the vision model to return, per line, a list of **runs**:
  `[{ "text": "…", "color": "C00000", "bold": true }, { "text": "…",
  "color": "000000" }]`.
- Render each run as its own styled span inside the same text box, so colour
  and style change mid-line exactly like the original.
This is additive to the current structure (a line becomes a sequence of styled
runs instead of one run).

---

## Where each of your points lands

| # | Your point | Where it is handled |
|---|------------|--------------------|
| 1 | Remove text+images first, then AI-fill the background | Step 6, option B |
| 2 | No text overflow; shrink font if needed | Step 7, `_flow_text_across_lineboxes` |
| 3 | Capture per-letter colour/style | Step 4/7, "runs" (planned) |
| 4 | 5 min/file is too slow | Speed section: reviewer off + fewer passes |
| 5 | Send the workflow | this document |
| 6 | Drop the reviewer if slow | done — off by default |
| 7 | Optimisation ideas | Speed section + Suggestions below |

---

## Suggestions to make it faster / better (your point 7)

1. **Parallelise pages** — each page is independent; run them on a thread pool.
   Biggest easy win on multi-page files.
2. **Two-tier vision** — a cheap/fast model for classification + a strong model
   only for the actual translation text. Cuts cost and latency.
3. **Batch all blocks in one call** (already done) and **avoid the reviewer**
   on the fast path (done). Turn the reviewer on only for a final "QA pass"
   the user explicitly requests.
4. **AI-fill only where needed** — run CV inpaint everywhere, then AI-fill only
   the few boxes where CV left a measurable smudge (detected automatically).
   Keeps cost low while fixing the ornate cases.
5. **Content-hash cache** — identical scanned templates (same certificate,
   different name) reuse the previous background + layout, translating only the
   changed text.
6. **Down-res detection** — detect regions at 200 DPI (fast), crop/fill at 300
   DPI (quality). ~2× faster detection with no visible quality loss.
