// Test for the explicit new rule: "agar output file me koi bhi page
// blank he to usko delete karna he" (if any output page is blank,
// delete it).
//
// The mechanism that already exists in buildFlowingDocx (Solution 2,
// now the sole finalized strategy) is: a forced page-break is only
// emitted for a source page when that page has real content
// (flow.length > 0). A source page with ZERO content never gets its
// own forced break, so it never produces a dedicated blank page in the
// output - its "slot" simply contributes nothing, and the surrounding
// pages' content flows together naturally.
//
// This test verifies the exact real conditional from buildFlowingDocx
// (not a reimplementation) against realistic scenarios, and confirms
// this protection is identical across all 5 per-service engine copies
// (per the earlier full-separation work - a fix in one must be
// mirrored in all five, or the same blank-page bug could silently
// persist in whichever service's copy was missed).

const fs = require('fs');
const path = require('path');

function assert(cond, label) { if (!cond) { console.log('FAIL:', label); process.exitCode = 1; } else console.log('PASS:', label); }

const files = ['engine-ocr.js', 'engine-translation.js', 'engine-dataextraction.js', 'engine-bai2.js', 'engine-calculators.js'];
const EXPECTED_LINE = 'if (pIdx > 0 && flow.length > 0 && _ocrShouldForceBreak()) {';

files.forEach(function (f) {
  const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
  assert(src.includes(EXPECTED_LINE), f + ': the exact real break-decision line is present unchanged');
});

// Directly evaluate the real conditional expression (extracted
// verbatim, not rewritten) against realistic (pIdx, flow.length)
// combinations, using engine-ocr.js as the canonical copy (already
// confirmed byte-identical to the other 4 for this logic).
function _ocrShouldForceBreak() { return true; } // Solution 2 is always forcing (finalized)
function evalBreakCondition(pIdx, flowLength) {
  const flow = { length: flowLength };
  // eslint-disable-next-line no-eval
  return eval(EXPECTED_LINE.replace(/^if \(/, '').replace(/\) \{$/, ''));
}

assert(evalBreakCondition(0, 5) === false, 'First source page (pIdx=0) never gets a forced break, regardless of content - correct, nothing should precede it');
assert(evalBreakCondition(1, 0) === false, 'A later source page with ZERO content (flow.length=0) does NOT get a forced break - this is what prevents a dedicated blank page from ever being created for an empty source page');
assert(evalBreakCondition(1, 3) === true, 'A later source page WITH real content (flow.length>0) DOES get its forced break - normal case unaffected');
assert(evalBreakCondition(4, 0) === false, 'An empty page even at the very END of the document (e.g. pIdx=4, last page) still gets no break - prevents a trailing blank page too');

console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
