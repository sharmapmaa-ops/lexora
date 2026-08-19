# Lexora — OCR + Translation Injection Pipeline (Master Spec, Corrected)

This is the user's original master spec, kept in the SAME phase/step order,
with exactly three things changed — no restructuring beyond what was asked:

1. **STEP 7.5-A (number reversal) — corrected.** The original rule
   ("52-25-20" → "20-25-52") is not just a stylistic choice, it's factually
   wrong per the Unicode Bidi Algorithm (UAX #9): digit sequences are
   directionally NEUTRAL/NUMBER-class, never reversed, in RTL or LTR. This
   was verified empirically this session against a real Arabic PDF —
   Arabic-Indic digits report bidirectional category `AN` (Arabic Number),
   not `AL` (Arabic Letter), and reversing a real date/contract-number
   corrupts its value, not just its display order. Manually reversing digits
   would turn "2024-12-31" into "31-12-2024" — a different, wrong date, not
   a formatting change. Visual RTL positioning is the *rendering engine's*
   job (via `w:bidi` / the Bidi algorithm itself), not something to
   pre-compute by string-reversing.

2. **PHASE 4 (translation) — batched, not one giant call.** The original
   spec sends the *entire* document's JSON in a single OpenRouter call. For
   any document with more than a handful of boxes this risks truncation —
   this project has hit exactly this failure mode before (32k-token
   truncation on a lease document, fixed then with paragraph-level
   grouping). Replaced with token-budget batching: pack boxes into a batch
   until a token ceiling is reached, send that batch, continue — bounded
   request size (no truncation risk) while still packing efficiently
   (not one box per call either, which would multiply API calls
   unnecessarily).

3. **Retry policy — capped at 1, not open-ended.** Per explicit
   instruction: a failed batch call retries at most ONCE, then falls back
   to leaving that batch's boxes untranslated (original text kept, flagged
   for review) rather than retrying repeatedly.

Everything else — phase order, box/JSON structure, table handling, spacing
preservation, font-resize fallback — is the user's original design, kept
as specified.

---

## 🎯 OBJECTIVE

Transform a scanned PDF document into a translated version while preserving
the exact original layout, margins, alignments, font properties, table
structures, and mixed formatting, with intelligent handling of LTR/RTL
language pairs, dynamic text resizing/expansion, and word-to-number
conversion.

## 📥 INPUT REQUIREMENTS

- Source PDF (scanned/image-based)
- Source language (name)
- Target language (name)
- Aspose.PDF API credentials (for OCR)
- OpenRouter API credentials (for translation)
- (Optional) Glossary / custom term dictionary
- (Optional) Font mapping rules

## 🔄 COMPLETE WORKFLOW OVERVIEW

```
PHASE 1: OCR EXTRACTION (Aspose.PDF)
    ↓
PHASE 2: LAYOUT ANALYSIS & ELEMENT DETECTION
    ↓
PHASE 3: GRANULAR BOX CREATION (with formatting)
    ↓
PHASE 4: JSON STRUCTURE CREATION
    ↓
PHASE 5: BATCHED TRANSLATION (OpenRouter API)   ← CHANGED (was: single call)
    ↓
PHASE 6: TRANSLATION INJECTION (with all rules)
    ↓
PHASE 7: FINAL DOCUMENT GENERATION
```

---

## PHASE 1: OCR EXTRACTION

### STEP A: Document Preparation
**Input:** PDF Document (scanned/image-based)

**Process:**
- Send PDF to Aspose.PDF API for OCR processing
- Request output as Word Document (DOCX) with recognized text
- Extract all text elements with: text content, page number, coordinates
  (x, y, width, height), font properties (name, size, style, color),
  paragraph/line breaks

**Output:** OCR Data with complete formatting information

> **Verify before relying on this, don't assume:** whether Aspose's OCR
> output actually carries per-character font family/color/style at this
> granularity for a genuinely *scanned* (not text-layer) page needs
> confirming against real Aspose output before Phase 2/3 below are built
> against it — OCR engines commonly return text + approximate size only,
> not exact color/family, for scanned input. Test with a real scanned
> sample first.

---

## PHASE 2: LAYOUT ANALYSIS & ELEMENT DETECTION

### STEP 1: Language Direction Identification
Identify LTR or RTL property for both:
- Source language → `source_direction`
- Target language → `target_direction`
- Flag: `is_direction_same = (source_direction == target_direction)`

### STEP 2: Margin Detection (Document-level)
For each page, detect: left margin, right margin, top margin, bottom margin.

### STEP 3: Element Detection & Alignment Recording
For every textual element (sentence, line, word, paragraph), detect and record:

| Attribute | Description |
|---|---|
| `element_type` | sentence / line / word / paragraph |
| `vertical_alignment` | top / middle / bottom |
| `horizontal_alignment` | left / center / right / justified |
| `start_x`, `end_x`, `start_y`, `end_y` | element bounding coordinates |
| `is_within_table` | TRUE / FALSE |
| `table_id` (if applicable) | Unique table identifier |
| `cell_id` (if applicable) | Unique cell identifier |

**Special check for font properties:** scan each element for mixed
formatting (different font sizes/styles/colors within the same
line/paragraph). If mixed formatting detected → split into smaller elements
(see STEP 5.6).

### STEP 4: Alignment-Specific Margin Space Calculation
If horizontal alignment is NOT center:
- If element starts from left → measure space between left margin and `start_x`
- If element starts from right → measure space between right margin and `end_x`
- Store as `leading_space`

### STEP 5: Table Structure Detection & Cell Splitting
- Identify all table areas
- For each table, detect individual cells as separate bounding boxes
- If a cell contains extra internal spacing (multiple text blocks with
  gaps) → split into multiple sub-boxes, each an independent translation
  container
- Assign a unique `box_id` to every container (table cells and non-table
  text boxes alike)

### STEP 5.5: Non-Table Text Splitting
**Condition:** non-table text with extra spacing (more than 2 spaces
between words, tab characters, multiple spaces used for alignment).

**Process:** split into multiple sub-boxes at each spacing transition;
each segment keeps its own coordinates, font properties, and alignment.

```
Original Line: "Name:    John    Doe"
Splitting:
  Box 1: "Name:"  (font: bold, size: 12)
  Box 2: "John"   (font: normal, size: 10)
  Box 3: "Doe"    (font: normal, size: 10)
```

### STEP 5.6: Mixed Formatting Detection & Splitting
**Condition:** text with mixed font properties within the same
line/paragraph.

**Process:** scan for font property transition points (size, style, color,
family) and split into separate boxes at each transition, each preserving
its own formatting.

```
Original: "This is a **BOLD** and *italic* text"
Splitting into 5 boxes:
  Box 1: "This is a "  (normal, 12pt, black)
  Box 2: "BOLD"        (bold, 14pt, red)
  Box 3: " and "        (normal, 12pt, black)
  Box 4: "italic"       (italic, 12pt, blue)
  Box 5: " text"        (normal, 12pt, black)
```

### STEP 6: Text Box Creation
Create a bounding box for each line/paragraph (non-table, after splitting),
each table cell/sub-cell, each mixed-formatting segment, and each
spacing-based segment. For each box, store:

`box_id`, `page`, `coordinates`, `alignment`, `font_properties`, `is_table`,
`table_id`, `cell_id`, `parent_box_id` (if split from a larger element),
`leading_spaces`, `trailing_spaces`, `original_text`, `detected_language`,
`direction`, `translated_text` (empty initially), `injection_parameters`
(populated during injection).

---

## PHASE 3: JSON STRUCTURE CREATION

### STEP 6.5: JSON Serialization

```json
{
  "document_info": {
    "source_language": "Arabic",
    "target_language": "English",
    "source_direction": "RTL",
    "target_direction": "LTR",
    "total_pages": 10,
    "total_boxes": 45,
    "ocr_tool": "Aspose.PDF",
    "translation_tool": "OpenRouter"
  },
  "page_margins": {
    "page_1": { "left": 50, "right": 750, "top": 50, "bottom": 800 }
  },
  "boxes": [
    {
      "box_id": "P1_B1",
      "page": 1,
      "parent_box_id": null,
      "coordinates": { "x": 50, "y": 100, "width": 700, "height": 30 },
      "alignment": "left",
      "font_properties": { "family": "Arial", "style": "normal", "size": 12, "color": "#000000", "background": null },
      "is_table": false,
      "table_id": null,
      "cell_id": null,
      "leading_spaces": 0,
      "trailing_spaces": 0,
      "original_text": "النص العربي الأصلي",
      "detected_language": "Arabic",
      "direction": "RTL",
      "translated_text": "",
      "injection_parameters": {
        "resized_font_size": null,
        "expanded_width": null,
        "expanded_direction": null,
        "final_text": null,
        "final_font_properties": null
      }
    }
  ]
}
```

---

## PHASE 4: BATCHED TRANSLATION *(changed — see note at top)*

### STEP 7: Translation Execution (token-budget batched)

**Tool:** OpenRouter API

**Why batched, not one call for the whole document:** a single-call design
has no upper bound on request size — a document with hundreds of boxes (this
project has seen 50+ tables and 300+ boxes on real documents) risks hitting
the model's context/output limit mid-response, producing truncated,
unparseable JSON. A per-box design (one API call per box) avoids that but
multiplies API calls unnecessarily, which the user explicitly wants avoided.
Token-budget batching is the middle ground: bounded per-call size (no
truncation risk) while still packing as many boxes as reasonably fit into
each call (not tiny one-box calls either).

**Process:**

1. **Build batches, not one blob.** Walk `boxes` in document order (page by
   page). Accumulate boxes into the current batch while the running
   estimated token count (rough: `len(original_text) / 4` per box, plus a
   fixed overhead per box for its JSON scaffolding — page/coordinates/font
   fields are compact, so overhead is small and can be treated as roughly
   constant) stays under a ceiling (e.g. **6,000 input tokens per batch** —
   conservative enough to leave headroom for the model's own output on
   *any* target model, not tuned to one specific model's max context).
   When the next box would push the batch over the ceiling, close the
   current batch and start a new one.
   - A single box whose own text alone exceeds the ceiling (rare — would
     mean one extremely long paragraph) becomes its own one-box batch
     rather than being split arbitrarily mid-sentence.
   - This naturally keeps batch count roughly proportional to document
     size (dense pages may need 2 batches, sparse pages may combine
     several pages into one batch) rather than a fixed "one call per page"
     rule that doesn't adapt to actual density.

2. **Per batch, send only what's needed** — not the full document JSON,
   just this batch's boxes (`box_id` + `original_text` + enough context to
   translate correctly, e.g. `element_type`, `is_table`, `table_id` so the
   model knows if it's translating a table-cell fragment vs. a full
   sentence):

```json
{
  "model": "openrouter/translation-model",
  "messages": [
    {
      "role": "system",
      "content": "You are a translation expert. Translate 'original_text' in each box from [SOURCE_LANG] to [TARGET_LANG]. Return ONLY a JSON array of {box_id, translated_text}, one entry per box, in the same order. Do not translate box IDs, numbers-only content, or symbols-only content — copy those through unchanged. For number words in translated text (e.g. 'Fifteen' -> '15'), convert to digits UNLESS the number word is part of a proper noun, legal term name, or idiomatic expression, or listed in the provided glossary — in those cases keep the word form. Never reverse the digit order of any number, date, phone number, or ID — digit sequences are never reversed for RTL/LTR, only the surrounding text direction changes."
    },
    {
      "role": "user",
      "content": "[BATCH_BOXES_JSON_HERE — box_id + original_text + element_type + is_table/table_id only, not the full document]"
    }
  ],
  "temperature": 0.3
}
```

3. **Merge results back** into the full `boxes` array by `box_id` as each
   batch completes — batches can be sent sequentially (safer, predictable
   load) or in parallel with a small concurrency cap (e.g. 3 at a time) if
   speed matters more than simplicity; sequential is the simpler default
   and is what's specified here unless throughput becomes a real problem.

4. **Retry policy — capped at 1:** if a batch call fails (network error,
   malformed/unparseable response, non-200 status), retry that SAME batch
   **at most once**. If the retry also fails, do NOT retry again — fall
   back to leaving every box in that batch untranslated (`translated_text`
   = `original_text`, unchanged) and flag those `box_id`s for manual
   review (per the existing "If translation same as original → keep
   original, skip injection" fallback rule already in this spec's rules
   table). This bounds worst-case API calls to `2 × batch_count`, never
   open-ended retrying.

5. **Validate** every box in every batch got a `translated_text` entry
   back (by `box_id`) before moving to Phase 5 — any box missing from a
   batch's response (model skipped it) is treated the same as a failed
   batch for that box: keep original text, flag for review.

6. Save the merged translated JSON as backup.

---

## PHASE 5: TRANSLATION INJECTION

### STEP 7.5: Number Handling *(STEP 7.5-A corrected — see note at top)*

#### A. Number sequences — NEVER reversed *(corrected)*

Digit sequences (dates, phone numbers, IDs, any `\d[\d\-/.\s]*\d` pattern)
are **left exactly as translated/as extracted — never manually reversed**,
regardless of `source_direction`/`target_direction`. This includes
separators (`-`, `/`, `.`, space) and prefixes (`+91`, `$`, `₹`) — the
entire numeric token is copied through unchanged.

Visual left-to-right/right-to-left positioning of a number embedded in RTL
text is the renderer's job (Unicode Bidi Algorithm, applied via `w:bidi` /
equivalent paragraph/run direction properties at injection time in Phase
6) — not something to pre-compute by reversing the digit string. Reversing
the string would silently corrupt the actual value (a date becomes a
different date, a contract number becomes a different number), which is a
correctness bug, not a formatting choice.

```
"52-25-20"        -> "52-25-20"   (unchanged — direction handled by the renderer)
"2024-12-31"      -> "2024-12-31" (unchanged, NOT "31-12-2024")
"+91-123-456-789" -> "+91-123-456-789" (unchanged)
```

#### B. Word Number Conversion
(Unchanged from original spec.)

**Process:** scan translated text for number words, convert to numeric
format, maintain original context/capitalization.

```
"Article Fifteen"    -> "Article 15"
"Section Twenty Five" -> "Section 25"
"Chapter One Hundred" -> "Chapter 100"
"Fifty Thousand"      -> "50000"
```

#### C. Exceptions (do NOT convert)
Proper nouns, legal term names, idiomatic expressions, user-provided
glossary terms, numbers already inside code/serial-number tokens (e.g.
`ID-1234`).

### STEP 8: Non-Table Text Injection
(Unchanged from original spec.)

**Condition:** box is NOT part of any table.

- **Preserve font properties** per sub-box (mixed-formatting sub-boxes
  keep their own style/size/color/family).
- **Font resizing (if needed):** insert into the same box, do NOT grow box
  width/height; if translated text is longer, gradually reduce font size
  until it fits, floor at **6pt minimum**, applied per-box (not globally).
- **Alignment preservation:** left/center/right stays as original;
  center position = `(left_margin + right_margin) / 2`.
- **Space preservation:** keep original `leading_spaces`/`trailing_spaces`
  counts exactly.

### STEP 9: Table Cell Injection
(Unchanged from original spec.)

**Condition:** box is part of a table cell.

**A. Expansion direction:** target = RTL → expand left; target = LTR →
expand right.

**B. Expansion stop conditions (priority order):**
1. Translated text fully fits within cell width
2. Cell reaches page margin
3. Cell width exceeds 1.5× original width
4. Fallback: reduce font size (min 6pt, per STEP 8 logic)

**C. Adjacent cell handling:** shift adjacent cells on expansion, maintain
grid/alignment, prevent overlap.

**D. Font properties:** each sub-cell preserves its own font properties.

> **Verify before relying on this, don't assume:** cell-expansion +
> adjacent-cell-shifting is exactly the class of layout problem this
> project has repeatedly found needs *empirical* verification (real
> render, not just logic review) to get right — see this session's own
> page-overflow work. Before treating STEP 9 as done, generate a real
> sample table injection and actually render it (LibreOffice or
> equivalent) to confirm cells don't overlap and text doesn't clip,
> rather than trusting the stop-condition logic alone.

### STEP 10: Column Reversal (Table Level)
(Unchanged from original spec — reverse column order when table's primary
language direction differs from target direction; reverse nested column
data too; maintain proportional widths; update headers.)

### STEP 10.5: Post-Column-Reversal Number Correction
Re-scan translated table content after column reversal; re-apply STEP
7.5-A (now a no-op / pass-through, since numbers are never reversed) and
7.5-B (word-number conversion) if any content changed position in a way
that affects word-number detection context.

### STEP 11: Leading/Trailing Space Preservation
(Unchanged.) Inject exactly the original count of leading/trailing spaces;
each mixed-formatting sub-box preserves its own spacing.

### STEP 11.5: Mixed Formatting Preservation
(Unchanged.) Sub-boxes from the same parent keep relative positioning; each
gets its own translation while preserving its own font properties,
alignment, and inter-box spacing.

---

## PHASE 6: FINAL DOCUMENT GENERATION

### STEP 12: Output Generation
(Unchanged from original spec.)

- Compile all pages with injected translations, maintaining original page
  dimensions
- Apply all formatting: font properties per box/sub-box, alignments,
  spacing, table structures, column ordering
- Output format: PDF (editable/searchable) or Word
- File naming: per user preference

**Quality checks:**
- ✅ All boxes have translations (or are explicitly flagged as fallback/untranslated)
- ✅ Font properties preserved
- ✅ Alignments preserved
- ✅ Tables correctly structured
- ✅ Numbers unchanged in value (never reversed)
- ✅ Mixed formatting preserved
- ✅ Spaces preserved

---

## ✅ ADDITIONAL RULES & FALLBACKS

| Rule | Action |
|---|---|
| If translation same as original | Keep original, skip injection |
| If box contains only numbers/symbols | Do not translate |
| If font size reduces below 6pt | Flag for manual review |
| If table expansion affects page boundary | Scale down entire table proportionally |
| If no table detected | Skip table-related steps |
| If OCR confidence < 80% | Mark text for manual verification |
| If mixed formatting detected | Split and process each segment separately |
| If extra spacing detected | Split into sub-boxes |
| If number word conversion ambiguous | Keep original, flag for review |
| **If a translation batch call fails** | **Retry that batch at most ONCE. If the retry also fails, keep original text for every box in that batch and flag for manual review — never retry more than once.** *(new)* |
| **If a box is missing from its batch's response** | **Treat the same as a failed batch for that box: keep original text, flag for review.** *(new)* |

---

## 🛠 TECHNICAL REQUIREMENTS

| Component | Tool/API |
|---|---|
| OCR | Aspose.PDF API |
| Translation | OpenRouter API |
| Layout Analysis | PyMuPDF / pdfplumber |
| JSON Processing | Python `json` module |
| PDF Generation | ReportLab / iText / PyPDF2 |
| LTR/RTL Handling | Unicode BiDi algorithm (UAX #9) |
| Language Detection | langdetect / cld2 |

---

## 📊 COMPLETE COVERAGE CHECKLIST

| Feature | Status | Reference |
|---|---|---|
| Language direction detection | ✅ | STEP 1 |
| Margin detection | ✅ | STEP 2 |
| Alignment detection | ✅ | STEP 3 |
| Table detection | ✅ | STEP 5 |
| Extra spacing splitting (table) | ✅ | STEP 5 |
| Extra spacing splitting (non-table) | ✅ | STEP 5.5 |
| Mixed formatting detection/splitting | ✅ | STEP 5.6 |
| Box creation | ✅ | STEP 6 |
| JSON structure | ✅ | Phase 3 |
| **Batched translation (truncation-safe)** | ✅ *(changed)* | Phase 4 |
| **Retry capped at 1** | ✅ *(new)* | Phase 4, Rules table |
| **Number reversal — corrected to never-reverse** | ✅ *(changed)* | STEP 7.5-A |
| Word number conversion | ✅ | STEP 7.5-B |
| Number exceptions | ✅ | STEP 7.5-C |
| Non-table injection | ✅ | STEP 8 |
| Font resizing | ✅ | STEP 8 |
| Table cell expansion | ✅ | STEP 9 |
| Column reversal | ✅ | STEP 10 |
| Post-reversal number correction | ✅ | STEP 10.5 |
| Leading/trailing space preservation | ✅ | STEP 11 |
| Mixed formatting preservation | ✅ | STEP 11.5 |
| Final document generation | ✅ | STEP 12 |
