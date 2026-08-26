// Test for the Translation service's CURRENT real flow, per explicit
// direction: on Start, a confirmation dialog asks "Use Aspose?" (once
// per batch, not per file). If YES, the Aspose 3-step pipeline runs:
//   Step 1: send the PDF to Aspose, get back the converted Word doc
//           (/api/translation/aspose-convert)
//   Step 2: inject the actual translation into that docx
//           (/api/translation/inject-translation)
//   Step 3: document reviewer - identifies every line/object in the
//           original vs translated document, finds real issues
//           (formatting, style, background, ordering, LTR/RTL
//           direction), builds an issue+solution list, and applies
//           every fix (/api/translation/review)
// If NO, the NEW real per-line bounding-box (Solution 9 style) pipeline
// runs (window.__translationEngine.buildBoxBasedTranslatedDocxBlob) -
// extracts each line into a real x/y/w/h box, merges multi-box
// paragraphs for translation (v14TranslateAllPages with paragraph
// grouping), gates font-resize on a genuine character-count
// comparison, and mirrors box position for RTL/LTR - falling back to
// the existing vision-OCR pipeline (buildHybridDocxBlob) for
// genuinely scanned PDFs, same fallback shape as before.
// Table-column-order reversal and left/right margin-mirroring remain
// deliberately NOT wired into the reviewer (excluded per direction) -
// the reviewer DOES fix the bidi/direction FLAG itself when it doesn't
// match the target language (the user's own worked example 2).

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function assert(cond, label) { if (!cond) { console.log('FAIL:', label); process.exitCode = 1; } else console.log('PASS:', label); }

// The confirmation dialog: asked once per batch (inside startProcess),
// not once per file, and its answer is stored where the per-file
// processing code can read it.
assert(src.includes("window.startProcess = async function(serviceId)"), 'startProcess is async (required to await the confirmation dialog)');
const startProcessIdx = src.indexOf("window.startProcess = async function(serviceId)");
const perFileLoopIdx = src.indexOf("if (browserBuild) {");
const startProcessBody = src.slice(startProcessIdx, perFileLoopIdx);
assert(startProcessBody.includes("showConfirm('Use Aspose?'"), 'Asks "Use Aspose?" via the existing showConfirm dialog, inside startProcess (once per batch)');
assert(startProcessBody.includes('processState.translationUseAspose = useAspose'), 'Stores the user\'s choice on processState, readable later by the per-file processing code');

// Per-file branching: the SAME processState flag decides Aspose vs the
// existing OCR-style pipeline, for EVERY file in the batch (not asked
// again per file).
assert(src.includes('if (processState.translationUseAspose) {'), 'Per-file processing branches on the SAME per-batch flag, not asking again per file');

// The Aspose branch: all 3 steps present, in the right order, wired correctly.
const asposeBranchStart = src.indexOf('if (processState.translationUseAspose) {');
const asposeBranchEnd = src.indexOf('} else {', asposeBranchStart);
const asposeBranch = src.slice(asposeBranchStart, asposeBranchEnd);
assert(asposeBranch.includes("fetch('/api/translation/aspose-convert'"), 'Aspose branch, Step 1: calls /api/translation/aspose-convert');
assert(asposeBranch.includes("fetch('/api/translation/inject-translation'"), 'Aspose branch, Step 2: calls /api/translation/inject-translation');
assert(asposeBranch.includes("fetch('/api/translation/review'"), 'Aspose branch, Step 3: calls /api/translation/review');
const s1 = asposeBranch.indexOf("fetch('/api/translation/aspose-convert'");
const s2 = asposeBranch.indexOf("fetch('/api/translation/inject-translation'");
const s3 = asposeBranch.indexOf("fetch('/api/translation/review'");
assert(s1 < s2 && s2 < s3, 'Aspose branch: Step 1 -> Step 2 -> Step 3 run in the correct real order');
assert(asposeBranch.includes('reviewIssues = reviewData.issues'), "The reviewer's issue list is captured, not discarded");

// The non-Aspose ("No") branch: uses the NEW box-based pipeline.
const nonAsposeBranch = src.slice(asposeBranchEnd, src.indexOf("file.progress = '65';", asposeBranchEnd) + 200);
assert(nonAsposeBranch.includes('buildBoxBasedTranslatedDocxBlob(blob'), 'Non-Aspose branch: calls the new real per-line box-based pipeline');
assert(nonAsposeBranch.includes('buildHybridDocxBlob('), 'Non-Aspose branch: still falls back to the existing vision-OCR pipeline for genuinely scanned PDFs');
assert(!nonAsposeBranch.includes("fetch('/api/translation/aspose-convert'"), 'Non-Aspose branch does NOT call any Aspose endpoint');

// The old table/background routing is genuinely gone (replaced by the
// explicit user confirmation dialog instead).
assert(!src.includes("fetch('/api/translation/analyze-strategy'"), 'The old table/background analyze-strategy call is fully removed');
assert(!src.includes("fetch('/api/translation/process-aspose'"), 'The old process-aspose (structure+translate in one call) is fully removed');

console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
