// Test for the Translation service's CURRENT real flow, per explicit
// direction to simplify step by step:
//   Step 1: send the PDF to Aspose, get back the converted Word doc
//           (/api/translation/aspose-convert)
//   Step 2: inject the actual translation into that docx
//           (/api/translation/inject-translation)
//   Step 3: document reviewer - identifies every line/object in the
//           original vs translated document, finds real issues
//           (formatting, style, background, ordering, LTR/RTL
//           direction), builds an issue+solution list, and applies
//           every fix (/api/translation/review)
// Table-column-order reversal and left/right margin-mirroring remain
// deliberately NOT wired in (excluded per direction, to be added only
// later as their own step) - the reviewer DOES fix the bidi/direction
// FLAG itself when it doesn't match the target language, since that is
// squarely a real issue the reviewer is responsible for (the user's
// own worked example 2), distinct from margin/column-order changes.
// The earlier table/background routing (analyze-strategy/process-
// aspose) and the client-side pdf.js/vision-OCR fallback are NOT part
// of the current reachable flow.

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function assert(cond, label) { if (!cond) { console.log('FAIL:', label); process.exitCode = 1; } else console.log('PASS:', label); }

// Step 1: Aspose conversion.
assert(src.includes("fetch('/api/translation/aspose-convert'"), 'Step 1: calls /api/translation/aspose-convert');

// Step 2: translation injection, fed from step 1's own output.
assert(src.includes("fetch('/api/translation/inject-translation'"), 'Step 2: calls /api/translation/inject-translation');

// Step 3: document reviewer, fed BOTH step 1's original output and step 2's translated output.
assert(src.includes("fetch('/api/translation/review'"), 'Step 3: calls /api/translation/review');
assert(src.includes('originalDocxBase64: step1DocxBase64'), "Step 3 is given step 1's original (untranslated) docx as the review baseline");
assert(src.includes('translatedDocxBase64: translatedDocxBase64'), "Step 3 is given step 2's translated docx to review and fix");

// The three steps run in the right order.
const step1Idx = src.indexOf("fetch('/api/translation/aspose-convert'");
const step2Idx = src.indexOf("fetch('/api/translation/inject-translation'");
const step3Idx = src.indexOf("fetch('/api/translation/review'");
assert(step1Idx !== -1 && step2Idx !== -1 && step3Idx !== -1 && step1Idx < step2Idx && step2Idx < step3Idx,
  'Step 1 -> Step 2 -> Step 3 run in the correct real order in the source');

// The old table/background routing and client-side fallback path are
// genuinely not part of the reachable flow right now.
const reachableFlow = src.split('const browserBuild = true;')[1].split('} catch (offErr)')[0];
assert(!reachableFlow.includes("fetch('/api/translation/analyze-strategy'"), 'The old table/background analyze-strategy call is not in the reachable flow');
assert(!reachableFlow.includes("fetch('/api/translation/process-aspose'"), 'The old process-aspose (structure+translate in one call) is not in the reachable flow');
assert(!reachableFlow.includes('buildOfflineDocxBlob(blob'), 'The client-side pdf.js path is not called in the reachable flow right now');
assert(!reachableFlow.includes('buildHybridDocxBlob('), 'The client-side vision-OCR fallback is not called in the reachable flow right now');

// The reviewer's found issues are actually surfaced to the activity log,
// not silently discarded after the fix is applied.
assert(reachableFlow.includes('reviewData.issues'), "The reviewer's issue list is used (surfaced in the activity log), not discarded");

console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
