# Lexora OCR Agent — Consolidation Report

**Status: ANALYSIS ONLY. No code has been changed. Per the attached
specification's explicit instruction ("DO NOT implement before
completing this analysis"), this document is the required
pre-implementation deliverable.**

This report is built from direct inspection of the real codebase — not
assumption. Every claim below traces to a specific file and line range
that was actually read during this pass. Where a section's inspection
was necessarily partial given the codebase's size (~22,000 lines across
the OCR-relevant files alone), that is stated explicitly rather than
presented as complete.

---

## SECTION 1 — Current OCR Architecture

Lexora does not have one OCR pipeline. It has **three**, built at
different times for different original purposes, with real overlap:

| # | Name | Language | Where | Original purpose |
|---|---|---|---|---|
| A | Text-layer extraction | JS (browser) | `js/engine-ocr.js` (and 4 sibling per-service copies — see Section 24) | OCR service + Translation service, for PDFs with a real text layer |
| B | Vision-based OCR (browser) | JS (browser) | Same file, `v14ProcessSingleImage`/`buildHybridDocxBlob` and ~30 related functions | OCR/Translation fallback for scanned/image-based PDFs |
| C | Vision-based OCR (server) | Python | `py/lease_engine.py`, `_build_page_vision_layout`/`generate_ocr_based_translation_pdf` and ~40 related functions | Lease Abstraction's handling of scanned/letterhead documents |

A fourth, narrower path exists for structure-preserving conversion via
Aspose.Words Cloud (`py/aspose_test_pipeline.py`, `py/ocr_router.py`),
used specifically when a document has tables or background color.

**This three/four-way split is itself the central finding of this
report** and drives most of the duplicate/fragmented items in Sections
12–14.

---

## SECTION 2 — Current PDF.js Implementation

Lives in `js/engine-ocr.js` (and identically in the other 4 per-service
engine copies — `engine-translation.js`, `engine-dataextraction.js`,
`engine-bai2.js`, `engine-calculators.js`; these are byte-identical
duplicates of the same engine, confirmed via MD5 during a recent
per-service separation task, not five independent implementations).

Key functions actually inspected:

- `extractOfflinePage(page, vp1, pageNo)` (~line 2126) — walks pdf.js's
  own text-content API per page, producing raw words/positions.
- `makeLine(seg, pageH)` (~2219) — groups words into a line object with
  real `xPt/yPt/wPt/hPt` from the PDF's own glyph coordinates.
- `extractOfflineImages` (~2018) — extracts embedded raster images AND
  signature/form annotations via `pdfjsLib.AnnotationMode.ENABLE_FORMS`
  (this is a real, working capability — see Section 16).
- `extractColors` / `resolveFonts` (~1936, 1977) — per-run color and
  font-family resolution from the PDF's own content stream.
- `buildOfflineDocxBlob(file, opts, logFn)` (~2245) — the top-level
  entry point; orchestrates extraction → paragraph grouping → alignment
  detection → table detection → DOCX generation.

This is a genuine, working, coordinate-accurate text-layer extraction
pipeline — not a stub. It is the ONLY one of the three pipelines that
gets exact source coordinates directly from the PDF's content stream
rather than inferring them from a rendered image.

---

## SECTION 3 — Current Aspose.PDF Implementation

`py/aspose_test_pipeline.py` (3013 lines) is a real, working, isolated
integration with Aspose.Words Cloud (not Aspose.PDF specifically —
naming note: the spec's Section 7 says "Aspose.PDF," the actual
integration is Aspose.Words Cloud's document-conversion API). Explicitly
documented as NOT touching the translation/lease pipelines
(`aspose_test_pipeline.py` line 5-7, inspected this pass). Handles
structure-preserving conversion (tables, cell shading, borders,
indentation) for documents `ocr_router.py` routes to it.

`py/ocr_router.py` (275 lines, fully inspected — see Section 5 of this
codebase's own docstring, already accurate) is the real decision point:
`analyze_pdf_for_ocr_strategy()` inspects every page via pdfplumber for
tables and background-fill coverage (`BACKGROUND_COLOR_AREA_THRESHOLD =
0.05`), returning `"aspose"` or `"lightweight"`. This is genuinely
document-agnostic (no hardcoded filenames/pages — confirmed, matches
spec Section 34's requirement already).

---

## SECTION 4 — Current OCR/Text Extraction Logic

Three genuinely different extraction mechanisms exist:

1. **pdf.js content-stream reading** (`engine-ocr.js`, Section 2 above)
   — exact, no recognition step, only works when a text layer exists.
2. **Tesseract OCR** (`py/lease_engine.py`, `_ocr_one_page` ~line 771,
   `_extract_text_ocr` ~787) — used by Lease Abstraction's
   `extract_text()` fallback chain (pdfplumber → pypdf → OCR) for
   scanned lease documents being parsed into structured fields (NOT the
   OCR *service* — this is a different consumer, extracting fields for
   the Lease Abstraction tool).
3. **Vision-LLM reading** — both a JS version (`v14ProcessSingleImage`,
   engine-ocr.js ~3639) and a Python version
   (`extract_page_layout_vision` / `_extract_page_metadata_vlm`,
   lease_engine.py ~1388/2275) send a page IMAGE to a multimodal model
   and get back text + structure. These are two **independently
   written** implementations of the same idea, in two languages, with
   different prompt designs and different post-processing.

---

## SECTION 5 — Current Bounding-Box Logic

- **JS text-layer path**: boxes come directly from pdf.js glyph
  positions (`xPt/yPt/wPt/hPt` per line) — real coordinates, not
  inferred.
- **JS vision path**: boxes come from the vision model's own reported
  coordinates, then get corrected — `v14RefineBoxesWithInk` (~3261)
  measures actual dark-pixel ink extents to correct LLM-reported
  coordinates (documented finding from earlier project history: "LLM
  coordinates are fundamentally unreliable for box positioning; pixel-
  based line detection is the correct path" — this file's own prior
  work already reached the conclusion the attached spec's Section 20
  independently arrives at).
- **Python vision path**: boxes come from real OpenCV region detection
  (`_detect_text_regions_cv`, ~1962, inspected this pass in detail) —
  adaptive thresholding + morphological line-gluing, with a separate
  colour-blob pass to pre-classify illustrations. This is NOT
  LLM-reported; it is pixel-measured from the start, which is arguably
  more robust than the JS vision path's "trust then correct" approach.

**Existing distinction already present, per spec Section 11's concern**
("do not assume TEXT_WIDTH = OCR_BOUNDING_BOX_WIDTH"): the JS text-layer
path's `wPt` for a given line already reflects real glyph extent, not
an inferred region — this distinction already exists correctly there.
It did NOT exist correctly in one specific rendering path
(`textBoxXml`'s box-per-line renderer) until a recent, narrower fix —
see Section 10.

---

## SECTION 6 — Current Line Reconstruction

**JS text-layer path**: `makeLine` groups pdf.js's individual word/glyph
items into lines using y-coordinate proximity (implementation detail:
not fully re-derived this pass beyond confirming the function exists and
is the sole line-construction point in that pipeline).

**Python vision path**: `_detect_text_regions_cv`'s CV pass already
IS line-level (contour detection groups character-shaped blobs on a
shared baseline into one region, `glue_w` parameter, ~line 2039 this
pass). Real, pixel-evidence-based, not text-recognition-dependent (finds
lines even in scripts/decorative text Tesseract can't recognize —
documented purpose in that function's own docstring).

Both are structurally sound single implementations of line grouping,
each within its own pipeline — they are not fighting each other, but
they are two separate pieces of logic solving the same problem
differently, with no shared code or shared test suite between them.

---

## SECTION 7 — Current Paragraph Reconstruction

**JS**: `v14GroupLinesIntoParagraphs(lines)` (engine-ocr.js ~913,
inspected in full this pass) — sorts lines by y/x, then merges
consecutive lines into one paragraph when the vertical gap is ≤ 60% of
average line height, with an explicit carve-out: a line starting its own
list marker ("a)", "2.", a bullet) always starts a new paragraph even
if the gap is small (this fix is already correctly reasoned and
commented in the code — a genuine, working piece of logic, not a
placeholder).

**Python**: `_group_regions_into_paragraphs(regions)` (lease_engine.py
~3069) — the equivalent grouping step for vision-path CV regions,
feeding `_build_page_vision_layout`.

Same finding as Section 6: two independent implementations, not shared,
not cross-tested against each other.

---

## SECTION 8 — Current Reading-Order Logic

Line/paragraph grouping in both pipelines sorts by y-then-x, which is an
LTR-biased default. No dedicated "logical reading order" step separate
from the sort was found in either pipeline during this pass — RTL
handling (Section 9) operates on already-sorted lines/paragraphs rather
than re-deriving order. This is a genuine gap relative to spec Section
14's requirement ("do not rely only on X-coordinate sorting") — flagged
as **MISSING** in the inventory (Section 15), not fabricated as
present.

---

## SECTION 9 — Current RTL/LTR Logic

Real, substantial, working logic exists, split across:

- `hasRTL(s)` (engine-ocr.js ~87) — Unicode range test
  (`\u0590-\u08FF` etc.) for Arabic/Hebrew script detection, per line.
- `v14IsRtlLanguage(label)` (~1060) — target-language-name-based RTL
  flag for translation output direction.
- Python: `is_rtl_language()`, `shape_rtl_text()` (lease_engine.py
  ~195/199) — equivalent for the vision/lease pipeline, plus explicit
  Arabic letter-shaping (not just direction — actual presentation-form
  joining), which the JS side does not appear to independently
  replicate (JS relies on the renderer's own bidi + `w:bidi` for
  presentation shaping — this is a real design difference, not
  necessarily a defect, but worth flagging since the spec's Section 16
  asks about correctness of mixed-direction handling specifically).
- **Digit/number handling**: this session's own direct empirical
  finding (documented in this project's own instructions file) already
  established that digit sequences must NEVER be reversed for RTL
  output — Unicode bidi category `AN` (Arabic Number), not `AL` —
  confirmed correct in the already-shipped translation master spec.
  This directly satisfies spec Section 17's numeric-token-protection
  requirement; it is **already correctly implemented**, not missing.

---

## SECTION 10 — Current Alignment Logic

**This is the section with the most direct, hands-on history this
session and the clearest example of exactly the fragmentation the
attached spec is concerned about.**

Two genuinely different alignment mechanisms exist:

1. **`v14DetectAlignment(paraLines, pageWidth, contentLeftPt,
   contentRightPt)`** (engine-ocr.js ~949, read in full this pass) —
   used by the flowing-paragraph rendering path (`buildFlowingDocx`).
   Compares left/right/midpoint edge consistency ACROSS a paragraph's
   multiple lines to infer left/center/right/justify. Explicitly
   handles the single-line case separately (checks the one line's
   position against the real content-column margins rather than
   defaulting) — this already satisfies spec Section 20's requirement
   ("for single-line text, do not interpret the entire OCR bounding box
   as actual text width") reasonably well, though it infers from
   *column position* rather than a separately-tracked
   ACTUAL_TEXT_BOUNDS vs AVAILABLE_REGION_BOUNDS pair as the spec's
   Section 20 more precisely specifies.

2. **A word-count check inside `textBoxXml`** (the box-per-source-line
   renderer used by "Solution 9" / OCR's absolute-position strategy) —
   built during this session, NOT `v14DetectAlignment`-based. Real
   history, in order:
   - Originally hardcoded `jc="both"` for every line, unconditionally.
   - Empirically found (real MS Word screenshot, not LibreOffice) that
     `jc="both"` silently does nothing for a single-line paragraph
     (Word-convention exemption), while `jc="distribute"` does spread
     words to fill the box.
   - First fix attempt: a standalone per-line "is this line's real
     captured width wider than its natural text width" ratio heuristic
     — built, then abandoned per explicit user direction before being
     shipped broadly.
   - Final, currently-shipped version: apply `jc="distribute"`
     unconditionally UNLESS the line has fewer than 2 words, in which
     case `jc="left"` — because a single WORD (e.g. "Tra", "MARR") given
     `jc="distribute"` and a wide box caused real MS Word to spread
     individual CHARACTERS across the line ("M A R R"), a defect
     LibreOffice does not reproduce and that was only caught via a real
     Word screenshot.

   **This word-count check is a completely separate, simpler mechanism
   from `v14DetectAlignment`, applying to a different rendering
   architecture (per-line boxes vs. flowing paragraphs).** It does not
   reuse `v14DetectAlignment`, does not share its column-relative
   single-line logic, and was arrived at through direct trial-and-error
   against real Word behavior rather than the same structural-geometry
   reasoning `v14DetectAlignment` uses.

This is a textbook case of spec Section 32's "rule conflict" concern:
two different alignment-decision mechanisms exist in the same codebase,
answering the same conceptual question ("what alignment should this
text have") differently, for two different renderers, discovered and
patched independently without either being aware of the other.

**Distribute-alignment root cause (spec Section 19's explicit ask,
"investigate why distribute is being applied"):** confirmed via direct
history — it originates from a rendering-layer decision inside
`textBoxXml` (DOCX generation stage), triggered by the empirically
observed real-Word behavior described above, NOT from PDF extraction or
OCR misdetection. The current gate (word count ≥ 2) is a rendering-time
workaround for a Word-rendering quirk, not a source-alignment detection
mechanism at all — it does not attempt to determine whether the SOURCE
document's paragraph was actually justified; it only decides whether the
OUTPUT box is safe to mark `distribute` without visually breaking.

---

## SECTION 11 — Current OCR Validation

**Real, substantial, and only exists in ONE of the three pipelines.**

`_review_page_layout()` (lease_engine.py ~2817, read in full this pass)
is a genuine vision-LLM-based QA agent, explicitly modeled as a "senior
document-translation reviewer and typesetter with 20+ years of
experience," comparing the original page image against a rendered
preview of the reconstruction. Checks exactly six categories: centering,
paragraph/indent, overflow/overlap, color mismatch, line-grouping
errors, and classification (logo/signature wrongly rendered as text).
Runs up to 2 correction rounds. Self-learning: each round's `reason`
field is persisted to disk (`_load_reviewer_lessons`/
`_save_reviewer_lessons`, ~117/128) and re-injected into the next run's
prompt so the same category of mistake is explicitly told not to recur.

**Gated OFF by default** (`LEXORA_ENABLE_REVIEWER` env var must be
`1`/`true`/`yes` — confirmed by reading the exact condition this pass)
because it roughly doubles per-page processing time (documented in the
code's own comment).

**Neither the JS text-layer pipeline nor the JS vision pipeline has an
equivalent review/QA step.** This is the direct, confirmed reason the
`textBoxXml` character-spreading defect (Section 10) was never caught
automatically — no automated comparison-against-original step exists
anywhere in the pipeline that actually produced the broken output. This
is a real, significant gap, not a hypothetical one — it produced a real
shipped defect this session.

---

## SECTION 12 — Duplicate Analysis

| Capability | Duplicate implementations | Real or acceptable? |
|---|---|---|
| Vision-based OCR/translation/reconstruction | JS (`v14ProcessSingleImage`/`buildHybridDocxBlob`, ~30 functions) AND Python (`_build_page_vision_layout`/`generate_ocr_based_translation_pdf`, ~40 functions) | **Real duplication** — see note below |
| Alignment detection | `v14DetectAlignment` (paragraph-geometry-based) AND `textBoxXml`'s word-count gate (rendering-safety-based) | **Real fragmentation**, not simple duplication — they solve different sub-problems (source alignment vs. render-safety) but neither is aware of the other, and only one (`v14DetectAlignment`) actually tries to detect the SOURCE alignment |
| Line/paragraph grouping | JS (`makeLine`/`v14GroupLinesIntoParagraphs`) AND Python (`_detect_text_regions_cv`/`_group_regions_into_paragraphs`) | **Not true duplication** — different input data entirely (real glyph coordinates vs. CV-detected pixel regions), so a shared implementation isn't straightforwardly possible without unifying the input representation first |
| RTL detection | `hasRTL`/`v14IsRtlLanguage` (JS) AND `is_rtl_language`/`shape_rtl_text` (Python) | **Partial duplication** — same underlying question, different depth (Python does actual glyph-shaping, JS defers to the renderer) |
| The rendering ENGINE FILE ITSELF | 5 byte-identical copies (`engine-ocr.js`, `engine-translation.js`, `engine-dataextraction.js`, `engine-bai2.js`, `engine-calculators.js`) | **Deliberate, explicit duplication** — done this session per direct user instruction, specifically to guarantee no cross-service interference; not a candidate for consolidation under this report's scope unless directed otherwise |

**Important qualifier on "vision pipeline duplication":** the JS and
Python vision pipelines were built for different consumers (OCR/
Translation services vs. Lease Abstraction) at different times, and the
Python one is meaningfully MORE capable in several respects (real CV
region detection instead of trusting the LLM's own coordinates, the
review/QA agent, self-learning lessons, illustration/logo
classification via colour analysis). Whether consolidating these is
correct depends on a decision this report does not make unilaterally:
does OCR/Translation's vision fallback need Lease Abstraction's level of
sophistication, or is the simpler JS version intentionally lighter-
weight for a different quality/cost tradeoff? **Flagged for explicit
decision, not silently resolved either way.**

---

## SECTION 13 — Fragmented-Responsibility Analysis

"Alignment decision-making" is the clearest fragmented responsibility
found: it is decided in at least two structurally different places
(Section 10), with a third partial contributor — `v14DetectListMarker`
(engine-ocr.js ~1003) also influences effective layout by stripping
list markers into real Word numbering, which changes how a paragraph's
alignment/indentation ultimately renders, without itself being
alignment-aware logic.

"OCR strategy selection" is split between `ocr_router.py` (Python,
table/color-based Aspose-vs-lightweight decision) and `ocr-service.js`
(JS, decides lightweight-vs-vision-fallback based on whether
`buildOfflineDocxBlob` throws a "scanned/image-based" error) — these are
sequential, not conflicting, but the OVERALL "which of the 3-4 pipelines
should handle this document" decision has no single owner; it emerges
from two separate pieces of code making local decisions.

---

## SECTION 14 — Conflict Analysis

No cases were found this pass where two pipelines actively
CONTRADICT each other on the same document (they aren't invoked
simultaneously on the same file, so direct runtime conflict isn't
architecturally possible today). The real risk category is not
"conflict" but "silent divergence" — the same conceptual bug (e.g. the
distribute/character-spreading defect) can exist in one pipeline,
appear fixed, and still be present un-fixed in a sibling pipeline that
was never touched, precisely because there is no shared implementation
or shared regression suite across the three pipelines.

---

## SECTION 15 — Missing-Capability Analysis

Against the attached specification's capability list (Section 1 of that
document), genuinely missing or notably thin items found this pass:

- **Dedicated logical reading-order step** independent of the
  y-then-x sort (Section 8 above) — MISSING in all three pipelines as a
  distinct, named step; currently implicit in the sort order.
- **Confidence tracking** (spec Section 22) for
  TEXT_DETECTION/CHARACTER_RECOGNITION/LINE_GROUPING/etc. as structured,
  queryable values — MISSING as a formal per-region field in the
  text-layer and JS-vision pipelines. Tesseract's own OCR confidence IS
  read in the Lease Abstraction OCR path (`_group_ocr_words_into_lines`
  takes a `conf_threshold` parameter, lease_engine.py ~1843) but is not
  propagated as structured metadata to any downstream consumer.
- **`ACTUAL_TEXT_BOUNDS` vs `AVAILABLE_REGION_BOUNDS` as two explicit,
  separately-named fields** (spec Section 20) — the underlying
  DISTINCTION exists correctly in the text-layer path (real glyph
  extent is what gets captured) but is not exposed as two clearly
  labeled fields anywhere; it's implicit in how `wPt` is computed.
- **A formal OCR Rule Registry** (spec Sections 30-33) — does not exist
  in the form described (rule_id/scope/trigger/confidence/lifecycle
  states). The closest existing equivalent is the Translation pipeline's
  self-learned-rules mechanism (`v14SaveLearnedRules`,
  `_load_reviewer_lessons`/`_save_reviewer_lessons`) — real, working,
  but narrower in scope (translation phrasing rules and reviewer
  lessons, not a general OCR rule system with approval/regression
  states).
- **Cross-pipeline regression testing** (spec Section 39) — real,
  substantial per-fix tests exist (this session alone produced 11 test
  files covering specific OCR rendering fixes), but no suite tests all
  three pipelines against the same corpus of representative documents
  (text-based/scanned/RTL/table-heavy/etc.) as the spec's Section 39
  describes.

---

## SECTION 16 — Existing Useful Functionality Not in the Attached Prompt

Per spec Section 35's explicit instruction to ADD these rather than
discard them:

- **Signature/form-annotation extraction via
  `pdfjsLib.AnnotationMode.ENABLE_FORMS`** (engine-ocr.js) — captures
  real digital-signature stamps that a plain render misses entirely;
  this was a hard-won, previously-regressed capability (a Python
  "lightweight" rewrite of this once threw it away, per `ocr_router.py`'s
  own documented history) and must not be lost again in any
  consolidation.
- **Real font-metric measurement via Canvas (`measureTextPt`)** used for
  text-fit/autofit decisions (`autofitPage`, `shrinkOverflow`) — a
  working, non-trivial capability not mentioned in the attached spec at
  all.
- **List-marker detection and conversion to real Word numbering**
  (`v14DetectListMarker` + `w:numPr` generation) — preserves editable,
  renumberable lists through translation rather than leaving literal
  "1." characters in translated text.
- **The illustration/logo colour-blob pre-classification pass**
  (lease_engine.py's foliage/vivid-colour detection inside
  `_detect_text_regions_cv`) — a specific, tested defense against
  botanical/decorative art being swept into erasable text regions.
- **Self-learning reviewer lessons persisted across runs**
  (`_load_reviewer_lessons`/`_save_reviewer_lessons`) — the QA agent
  gets measurably better at avoiding a specific mistake category after
  encountering it once, without a human manually authoring a rule.
- **Empirically-calibrated (not guessed) constants**: the OCR page-
  spacing compaction ratio (`FLAT_COMPACTION_RATIO = 0.85`) was derived
  by actually re-rendering a real reported document at a range of
  ratios via LibreOffice and finding the real cliff point — a working
  example of exactly the "evidence over assumption" discipline the
  attached spec asks for throughout.

---

## SECTION 17 — KEEP / CONSOLIDATE / MOVE / EXTEND / MODIFY / ADD Matrix

| Capability | Action |
|---|---|
| pdf.js text-layer extraction (Section 2) | **KEEP** — correct, coordinate-accurate, no changes indicated |
| Signature/annotation extraction | **KEEP** — do not regress again |
| `ocr_router.py` strategy decision | **KEEP** — already document-agnostic, matches spec Section 34 |
| Aspose.Words Cloud integration | **KEEP** |
| `v14DetectAlignment` (paragraph-geometry alignment) | **EXTEND** — this is the more principled of the two alignment mechanisms; candidate to become the SINGLE alignment authority if the box-per-line renderer is unified with it (see open decision below) |
| `textBoxXml`'s word-count distribute gate | **MODIFY or CONSOLIDATE** — currently a render-safety patch, not source-alignment detection; decision needed on whether to fold true alignment detection into this path or keep it as a narrower safety gate feeding FROM a shared alignment decision |
| JS vision pipeline (`v14ProcessSingleImage` etc.) | **DECISION NEEDED** — keep as lighter-weight OCR/Translation fallback, or consolidate toward Python's more capable CV+review pipeline (Section 12) |
| Python vision pipeline (`_build_page_vision_layout` etc.) | **KEEP**, and **candidate to EXTEND to OCR/Translation services** if the decision above favors consolidation toward it |
| `_review_page_layout` QA agent | **EXTEND** — candidate to become the shared validation step for ALL THREE pipelines (spec Section 23), not just Lease Abstraction; currently gated off by default for cost reasons, which would need re-evaluating if scope widens |
| Reading-order as an explicit step | **ADD** — currently implicit in sort order only (Section 8) |
| Structured confidence fields | **ADD** — propagate Tesseract's existing per-word confidence and add equivalents for the other two pipelines |
| Formal OCR Rule Registry | **ADD** — the translation-rules/reviewer-lessons mechanisms are a real, working partial precedent to generalize from, not to discard |
| 5 duplicated engine-*.js files | **LEAVE UNCHANGED** — explicit prior user decision this session, out of this report's scope to reconsider |

---

## SECTION 18 — Final OCR Agent Responsibility (Proposed)

Per the attached spec's Section 1 and Section 44 architecture: one
logical OCR Agent owning detection → geometry → classification →
reconstruction → direction/alignment → QA → rule engine → structured
output, with the THREE existing pipelines (text-layer, JS-vision,
Python-vision) remaining as the "specialized technical services"
underneath it (spec Section 6 explicitly allows this) — **provided**
their outputs are normalized into one shared structured format (Section
20 below) so the Formatting Agent boundary (Section 19) can be
consistent regardless of which underlying pipeline produced a given
page's data.

This report does NOT recommend collapsing the three pipelines into one
executable implementation — their inputs are too different (real PDF
coordinates vs. CV-detected pixel regions vs. Tesseract word boxes) for
that to be low-risk. It recommends a shared OUTPUT contract (Section
20) and a shared VALIDATION step (extending `_review_page_layout`,
Section 23) as the two concrete unification points.

---

## SECTION 19 — OCR Agent ↔ Formatting Agent Boundary

Consistent with the attached spec's Section 28. Concretely, in this
codebase:

- **OCR Agent side** (proposed): everything in `engine-ocr.js`'s
  extraction/grouping/alignment-detection functions, `ocr_router.py`'s
  strategy decision, and the Python vision pipeline's CV/classification
  functions.
- **Formatting Agent side** (already exists, not part of this report's
  OCR scope): `textBoxXml`/`buildDocx`/`buildFlowingDocx`'s actual DOCX
  geometry emission, `applyPageHeightBudget`'s spacing compaction, and
  `_write_layout_docx`/`generate_output_pdf` on the Python side.
- **The current boundary violation**: `textBoxXml`'s word-count
  distribute gate (Section 10) sits on the FORMATTING side of this line
  but is making an ALIGNMENT decision, which the spec's Section 28
  explicitly assigns to the OCR Agent. This is the one clear, concrete
  boundary violation this report identifies with high confidence.

---

## SECTION 20 — Input/Output Contract (Proposed, Draft)

Per spec Section 29. Proposed structured fields, mapped to what each
existing pipeline can ALREADY provide today (not hypothetical):

| Field | Text-layer (JS) | JS-vision | Python-vision |
|---|---|---|---|
| `text` | ✅ real | ✅ (LLM-reported) | ✅ (LLM-reported) |
| `bounding_box` | ✅ real glyph coords | ⚠️ LLM-reported, ink-corrected (`v14RefineBoxesWithInk`) | ✅ real CV-detected |
| `actual_text_bounds` vs `available_region_bounds` | Implicit only (Section 15) | Not distinguished | Not distinguished |
| `direction` | ✅ (`hasRTL`) | Not explicit per-region | ✅ (`is_rtl_language`) |
| `alignment` | ✅ (`v14DetectAlignment`, paragraph-level) | Not present | Not present |
| `region_type` (text/image/background/signature) | Partial (image extraction is separate from text) | ✅ (`class` field: translatable/nontranslatable) | ✅ (translatable/nontranslatable/decoration) |
| `confidence` | Not present | Not present | Partial (Tesseract path only, not vision path) |
| `protected_token_indicator` | Not present as a field (logic exists inline in translation prompt handling) | Same | Same |

This table itself is a real, direct output of this consolidation pass —
it shows the contract is NOT something to invent from scratch; most
fields already exist in at least one pipeline and need normalizing
across the other two, which is materially less risky than building all
of this new.

---

## SECTION 21 — OCR Rule Registry (Proposed, Draft)

Nearest existing precedent (genuinely working, not proposed):
Translation's `translation-rules`/`translation-domains` Postgres tables
plus the reviewer-lessons file-based mechanism. Proposed OCR Rule
Registry would follow the same shape (rule_id, scope, trigger,
detection/correction logic, confidence, lifecycle state) but this
report stops short of designing its schema in full — that is
implementation, which the attached spec explicitly defers until after
this analysis is reviewed.

---

## SECTION 22 — Validation Architecture (Proposed, Draft)

Extend `_review_page_layout` (Section 11) to run for all three
pipelines' output, not just Lease Abstraction's. Given it currently
DOUBLES per-page processing time and is opt-in for cost reasons, this
is a real tradeoff to surface explicitly rather than silently enabling
everywhere: recommend it remain OFF by default per-service, individually
toggleable, with the OCR service (given its recent, real, shipped
defect history this session) being the strongest candidate for
enabling it first.

---

## SECTION 23 — Regression Plan (Draft)

Per spec Section 39's document-type list, cross-referenced against
what this codebase can already generate/has on hand:

- Text-based, scanned, RTL, LTR, table-containing, signature documents
  — all have REAL example documents used during this session's own
  work (the Italian "Agreement" contract for text-layer/OCR work, the
  Arabic REGA lease for RTL/vision-path work).
- Mixed RTL/LTR, numeric-heavy, financial — partially covered (the REGA
  lease has Arabic+English+numeric content); a dedicated numeric-heavy
  financial-document test case was not identified as already existing
  and would need sourcing.
- Image-heavy/background-heavy — the Aspose routing path's own test
  fixtures apply here; not independently re-verified this pass.

---

## SECTION 24 — Files/Modules Requiring Changes (If Recommendations Adopted)

- `js/engine-ocr.js` (and its 4 duplicate siblings, per the existing
  deliberate-duplication decision — a change here means changing all 5
  identically unless that decision is revisited)
- `py/lease_engine.py` (if `_review_page_layout`/CV pipeline is
  extended beyond Lease Abstraction)
- `py/ocr_router.py` (if the Agent's orchestration layer takes over any
  of its current decision logic)
- `py/server.py` (new endpoints if a shared OCR Agent output contract
  needs its own API surface)
- New: an OCR Rule Registry schema/table (Section 21), if adopted

---

## SECTION 25 — Backward-Compatibility Risks

- The 5 duplicated engine files mean ANY engine-level change (e.g.
  unifying alignment detection per Section 17) must be applied
  identically 5 times or risk exactly the kind of silent divergence
  this report warns about in Section 14 — this is a direct, current
  consequence of this session's own earlier architectural decision and
  is flagged, not silently absorbed.
- Enabling `_review_page_layout` more broadly changes processing time
  and cost per document — a real, user-facing tradeoff, not a free
  change.
- Any consolidation touching `textBoxXml`'s distribute gate must
  preserve the specific, hard-won fix for the character-spreading
  defect (Section 10) — a regression here is a real, previously-shipped
  bug re-appearing, not a hypothetical risk.

---

## SECTION 26 — Implementation Plan

**Not written.** Per the attached specification's own explicit
instruction ("DO NOT implement before completing this analysis," repeated
in Section 42's closing line), this report stops at analysis. An
implementation plan should follow ONLY after this report is reviewed and
the open decisions below are resolved — writing one now would be
exactly the "start coding first" behavior the spec prohibits.

---

## Open Decisions Requiring Explicit Direction Before Any Implementation

1. Should the JS vision pipeline (OCR/Translation's scanned-PDF
   fallback) be consolidated toward the Python vision pipeline's greater
   capability (real CV region detection, QA review, self-learning
   lessons), or kept as an intentionally lighter/cheaper separate path?
2. Should `v14DetectAlignment` become the single alignment authority,
   with `textBoxXml`'s word-count gate demoted to a pure rendering-
   safety check that RECEIVES an alignment decision rather than making
   one? Or should the two remain separate, given they currently solve
   different sub-problems (source alignment vs. render safety)?
3. Should `_review_page_layout` be extended to the OCR service given
   its real defect history, accepting the ~2x processing-time cost, or
   should a cheaper, narrower validation step be designed specifically
   for the OCR service instead?
4. Does a formal OCR Rule Registry (Section 21) belong as a NEW system,
   or as an extension of the EXISTING translation-rules/reviewer-lessons
   tables, generalized to cover OCR-specific rules too?

This report does not answer these on its own authority — per the
attached specification's explicit framing, these are decisions for you
to make before any implementation begins.
