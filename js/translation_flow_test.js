// Test for the Translation service's CURRENT real flow, per explicit
// direction to simplify step by step:
//   Step 1: send the PDF to Aspose, get back the converted Word doc
//           (/api/translation/aspose-convert)
//   Step 2: inject the actual translation into that docx
//           (/api/translation/inject-translation)
// RTL/LTR direction fixing is deliberately NOT wired in yet (excluded
// per direction, to be added only later as its own step). The earlier
// table/background routing (analyze-strategy/process-aspose) and the
// client-side pdf.js/vision-OCR fallback are NOT part of the current
// reachable flow - this replaces an earlier version of this test file
// that kept asserting on that removed design and had been silently
// failing since that simplification (a real gap - this file should
// have been updated in that same pass and wasn't).

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function assert(cond, label) { if (!cond) { console.log('FAIL:', label); process.exitCode = 1; } else console.log('PASS:', label); }

// Step 1: Aspose conversion.
assert(src.includes("fetch('/api/translation/aspose-convert'"), 'Step 1: calls /api/translation/aspose-convert');

// Step 2: translation injection, fed from step 1's own output.
assert(src.includes("fetch('/api/translation/inject-translation'"), 'Step 2: calls /api/translation/inject-translation');
assert(src.includes('readAsDataURL(offlineBlob)'), "Step 2 is fed step 1's own output blob (converted to base64), not the original source file again");

// The two steps run in the right order: aspose-convert's response is
// consumed (offlineBlob set) BEFORE inject-translation is called.
const step1Idx = src.indexOf("fetch('/api/translation/aspose-convert'");
const step2Idx = src.indexOf("fetch('/api/translation/inject-translation'");
assert(step1Idx !== -1 && step2Idx !== -1 && step1Idx < step2Idx, 'Step 1 (conversion) happens before Step 2 (translation injection) in the real source');

// The old table/background routing and client-side fallback path are
// genuinely not part of the reachable flow right now.
const reachableFlow = src.split('const browserBuild = true;')[1].split('} catch (offErr)')[0];
assert(!reachableFlow.includes("fetch('/api/translation/analyze-strategy'"), 'The old table/background analyze-strategy call is not in the reachable flow');
assert(!reachableFlow.includes("fetch('/api/translation/process-aspose'"), 'The old process-aspose (structure+translate in one call) is not in the reachable flow');
assert(!reachableFlow.includes('buildOfflineDocxBlob(blob'), 'The client-side pdf.js path is not called in the reachable flow right now');
assert(!reachableFlow.includes('buildHybridDocxBlob('), 'The client-side vision-OCR fallback is not called in the reachable flow right now');

// RTL/LTR direction fixing is explicitly not wired into either step yet.
assert(!src.includes('rtlDirection') && !src.includes('mirrorMargin'), 'No RTL/LTR direction-fixing wiring exists in app.js yet - correctly excluded per direction');

console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
