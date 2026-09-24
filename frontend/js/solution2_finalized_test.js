// Test for applyPageHeightBudget as FINALIZED (Solution 2: forced page
// break per source page + 25% flat spacing reduction). Replaces an
// earlier test file that covered all 9 originally-explored strategies
// via its own hand-written reimplementation - disconnected from the
// real source, so it kept "passing" even after the real function was
// simplified down to just Solution 2. This test extracts and exercises
// the REAL, current function instead.

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'engine-ocr.js'), 'utf8');
function extractFn(name) {
  const marker = 'function ' + name + '(';
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(name + ' not found');
  let depth = 0, end = -1;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return src.slice(start, end);
}

const BUDGET_LINE_FLOOR_TWIPS = 200;
const BUDGET_SPACE_AFTER_FLOOR_TWIPS = 40;
// eslint-disable-next-line no-eval
eval(extractFn('applyPageHeightBudget').replace('function applyPageHeightBudget', 'var applyPageHeightBudget = function'));

function assert(cond, label) { if (!cond) { console.log('FAIL:', label); process.exitCode = 1; } else console.log('PASS:', label); }

// Real behavior: 25% flat reduction on line spacing and space-after.
const pg1 = { paragraphs: [{ lineTwips: 276, spaceAfterTwips: 160 }] };
applyPageHeightBudget(pg1);
assert(pg1.paragraphs[0].lineTwips === Math.round(276 * 0.75), 'lineTwips reduced by exactly 25% (Solution 2\'s ratio)');
assert(pg1.paragraphs[0].spaceAfterTwips === Math.round(160 * 0.75), 'spaceAfterTwips reduced by exactly 25%');

// Floors are respected even for already-tight paragraphs.
const pg2 = { paragraphs: [{ lineTwips: 210, spaceAfterTwips: 50 }] };
applyPageHeightBudget(pg2);
assert(pg2.paragraphs[0].lineTwips >= BUDGET_LINE_FLOOR_TWIPS, 'lineTwips never goes below the floor even after reduction');
assert(pg2.paragraphs[0].spaceAfterTwips >= BUDGET_SPACE_AFTER_FLOOR_TWIPS, 'spaceAfterTwips never goes below the floor even after reduction');

// Multiple paragraphs on one page all get compacted, independently.
const pg3 = { paragraphs: [{ lineTwips: 400, spaceAfterTwips: 200 }, { lineTwips: 320, spaceAfterTwips: 100 }] };
applyPageHeightBudget(pg3);
assert(pg3.paragraphs[0].lineTwips === Math.round(400 * 0.75), 'First paragraph on a multi-paragraph page compacted correctly');
assert(pg3.paragraphs[1].lineTwips === Math.round(320 * 0.75), 'Second paragraph on the same page also compacted correctly');

// Font size and margins are NOT touched (Solution 2 is spacing-only,
// unlike the removed font-reduce/margin-tighten/combined-mild strategies).
const pg4 = { paragraphs: [{ lineTwips: 276, spaceAfterTwips: 160, segments: [{ sizePt: 11 }] }], margins: { top: 1440, bottom: 1440, left: 1440, right: 1440 } };
applyPageHeightBudget(pg4);
assert(pg4.paragraphs[0].segments[0].sizePt === 11, 'Font size is untouched - Solution 2 is spacing-only');
assert(pg4.margins.top === 1440, 'Margins are untouched - Solution 2 is spacing-only');

// A page with no paragraphs at all doesn't throw.
assert((function () { applyPageHeightBudget({ paragraphs: [] }); return true; })(), 'A page with zero paragraphs does not throw');

console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
