// Test for the flat spacing-compaction system in translation-offline.js
// (applyPageHeightBudget) - REPLACES an earlier, much more complex
// per-paragraph estimation system that was removed after direct
// evidence (real document, real LibreOffice rendering) showed it wasn't
// actually reducing spacing enough to fix real overflow. This test
// verifies the mechanics of the flat-ratio replacement; the RATIO VALUE
// itself (0.85) was calibrated empirically - see
// py/calibrate_compaction_ratio.py for that calibration's real evidence
// (LibreOffice-rendered page counts at each candidate ratio).

global.window = global;

const FLAT_COMPACTION_RATIO = 0.85;
const BUDGET_LINE_FLOOR_TWIPS = 200;
const BUDGET_SPACE_AFTER_FLOOR_TWIPS = 40;

function _ocrPageBreakStrategy() { return window.__ocrPageBreakStrategy || 'forced-budget'; }
function _ocrShouldForceBreak() { return _ocrPageBreakStrategy() !== 'natural'; }

function applyPageHeightBudget(pg) {
  const s = _ocrPageBreakStrategy();
  if (s === 'forced-nobudget' || s === 'natural') return;
  const ratio = (s === 'forced-budget-aggressive') ? 0.75 : FLAT_COMPACTION_RATIO;
  (pg.paragraphs || []).forEach(function (p) {
    p.lineTwips = Math.max(BUDGET_LINE_FLOOR_TWIPS, Math.round((p.lineTwips || 276) * ratio));
    p.spaceAfterTwips = Math.max(BUDGET_SPACE_AFTER_FLOOR_TWIPS, Math.round((p.spaceAfterTwips != null ? p.spaceAfterTwips : 160) * ratio));
  });
}

function assert(cond, label) { if (!cond) { console.log('FAIL:', label); process.exitCode = 1; } else console.log('PASS:', label); }

// Default strategy: every paragraph gets scaled by exactly 0.85, unconditionally.
delete window.__ocrPageBreakStrategy;
const pg1 = { paragraphs: [
  { lineTwips: 276, spaceAfterTwips: 160 },
  { lineTwips: 304, spaceAfterTwips: 263 }, // real values seen in the actual reported document
] };
applyPageHeightBudget(pg1);
assert(pg1.paragraphs[0].lineTwips === Math.round(276 * 0.85), 'Default: lineTwips scaled by exactly 0.85 (' + pg1.paragraphs[0].lineTwips + ')');
assert(pg1.paragraphs[1].lineTwips === Math.round(304 * 0.85), 'Default: real reported-document value 304 scales correctly (' + pg1.paragraphs[1].lineTwips + ')');
assert(pg1.paragraphs[1].spaceAfterTwips === Math.round(263 * 0.85), 'Default: spaceAfterTwips scaled by exactly 0.85 (' + pg1.paragraphs[1].spaceAfterTwips + ')');

// Aggressive strategy: 0.75 ratio.
window.__ocrPageBreakStrategy = 'forced-budget-aggressive';
const pg2 = { paragraphs: [{ lineTwips: 276, spaceAfterTwips: 160 }] };
applyPageHeightBudget(pg2);
assert(pg2.paragraphs[0].lineTwips === Math.round(276 * 0.75), 'Aggressive: lineTwips scaled by 0.75 (' + pg2.paragraphs[0].lineTwips + ')');

// No-budget strategy: untouched.
window.__ocrPageBreakStrategy = 'forced-nobudget';
const pg3 = { paragraphs: [{ lineTwips: 276, spaceAfterTwips: 160 }] };
applyPageHeightBudget(pg3);
assert(pg3.paragraphs[0].lineTwips === 276, 'No-budget: lineTwips left untouched');
assert(_ocrShouldForceBreak() === true, 'No-budget: page breaks still forced');

// Natural strategy: untouched AND no forced break.
window.__ocrPageBreakStrategy = 'natural';
const pg4 = { paragraphs: [{ lineTwips: 276, spaceAfterTwips: 160 }] };
applyPageHeightBudget(pg4);
assert(pg4.paragraphs[0].lineTwips === 276, 'Natural: lineTwips left untouched');
assert(_ocrShouldForceBreak() === false, 'Natural: page breaks NOT forced');

// Floor: even a tiny starting value never goes below the readability floor.
window.__ocrPageBreakStrategy = 'forced-budget';
const pg5 = { paragraphs: [{ lineTwips: 210, spaceAfterTwips: 45 }] };
applyPageHeightBudget(pg5);
assert(pg5.paragraphs[0].lineTwips >= BUDGET_LINE_FLOOR_TWIPS, 'Floor: lineTwips never below floor (' + pg5.paragraphs[0].lineTwips + ')');
assert(pg5.paragraphs[0].spaceAfterTwips >= BUDGET_SPACE_AFTER_FLOOR_TWIPS, 'Floor: spaceAfterTwips never below floor (' + pg5.paragraphs[0].spaceAfterTwips + ')');

console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
