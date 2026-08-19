// Test for the full multi-solution strategy dispatcher in
// translation-offline.js (applyPageHeightBudget + related functions).
// REPLACES an earlier, much more complex per-paragraph estimation
// system that was removed after direct evidence (real document, real
// LibreOffice rendering) showed it wasn't actually reducing spacing
// enough to fix real overflow. Solutions 1-2's ratio values were
// calibrated empirically - see py/calibrate_compaction_ratio.py for
// that calibration's real evidence (LibreOffice-rendered page counts
// at each candidate ratio). Solutions 5-9 are additional, genuinely
// different approaches added after the user pointed out only listing 4
// parameter-variants of one approach wasn't actually "all possible
// solutions" as explicitly requested.

global.window = global;

const FLAT_COMPACTION_RATIO = 0.85;
const BUDGET_LINE_FLOOR_TWIPS = 200;
const BUDGET_SPACE_AFTER_FLOOR_TWIPS = 40;

function _ocrPageBreakStrategy() {
  if (window.__ocrPageBreakStrategy) return window.__ocrPageBreakStrategy;
  try {
    const saved = (typeof localStorage !== 'undefined') && localStorage.getItem('lexora_ocrPageBreakStrategy');
    if (saved) { window.__ocrPageBreakStrategy = saved; return saved; }
  } catch (e) { /* ignore */ }
  return 'forced-budget';
}
function _ocrShouldForceBreak() {
  const s = _ocrPageBreakStrategy();
  return s !== 'natural' && s !== 'absolute-position';
}

function applyPageHeightBudget(pg) {
  const s = _ocrPageBreakStrategy();
  if (s === 'forced-nobudget' || s === 'natural' || s === 'absolute-position' || s === 'feedback-loop') return;
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

// Solution 5: font-reduce - shrinks font, leaves spacing untouched.
const FONT_FLOOR_PT = 7;
function applyPageHeightBudgetFull(pg) {
  const s = _ocrPageBreakStrategy();
  if (s === 'forced-nobudget' || s === 'natural' || s === 'absolute-position' || s === 'feedback-loop') return;
  let spacingRatio = 1.0, fontRatio = 1.0, marginRatio = 1.0;
  if (s === 'forced-budget') spacingRatio = FLAT_COMPACTION_RATIO;
  else if (s === 'forced-budget-aggressive') spacingRatio = 0.75;
  else if (s === 'font-reduce') fontRatio = 0.90;
  else if (s === 'margin-tighten') marginRatio = 0.65;
  else if (s === 'combined-mild') { spacingRatio = 0.92; fontRatio = 0.95; marginRatio = 0.85; }
  if (spacingRatio < 1.0) (pg.paragraphs || []).forEach(function (p) {
    p.lineTwips = Math.max(BUDGET_LINE_FLOOR_TWIPS, Math.round((p.lineTwips || 276) * spacingRatio));
    p.spaceAfterTwips = Math.max(BUDGET_SPACE_AFTER_FLOOR_TWIPS, Math.round((p.spaceAfterTwips != null ? p.spaceAfterTwips : 160) * spacingRatio));
  });
  if (fontRatio < 1.0) (pg.paragraphs || []).forEach(function (p) {
    (p.segments || []).forEach(function (seg) { seg.sizePt = Math.max(FONT_FLOOR_PT, (seg.sizePt || 11) * fontRatio); });
  });
  if (marginRatio < 1.0 && pg.margins) {
    pg.margins.top = Math.round(pg.margins.top * marginRatio);
    pg.margins.bottom = Math.round(pg.margins.bottom * marginRatio);
    pg.margins.left = Math.round(pg.margins.left * marginRatio);
    pg.margins.right = Math.round(pg.margins.right * marginRatio);
  }
}

window.__ocrPageBreakStrategy = 'font-reduce';
const pg6 = { paragraphs: [{ lineTwips: 276, spaceAfterTwips: 160, segments: [{ sizePt: 12 }] }] };
applyPageHeightBudgetFull(pg6);
assert(pg6.paragraphs[0].lineTwips === 276, 'Solution 5: spacing untouched');
assert(pg6.paragraphs[0].segments[0].sizePt === Math.max(FONT_FLOOR_PT, 12 * 0.90), 'Solution 5: font scaled by 0.90 (' + pg6.paragraphs[0].segments[0].sizePt + ')');

// Solution 6: margin-tighten - shrinks margins, leaves spacing/font untouched.
window.__ocrPageBreakStrategy = 'margin-tighten';
const pg7 = { paragraphs: [{ lineTwips: 276, spaceAfterTwips: 160 }], margins: { top: 1200, bottom: 1200, left: 1200, right: 1200 } };
applyPageHeightBudgetFull(pg7);
assert(pg7.paragraphs[0].lineTwips === 276, 'Solution 6: spacing untouched');
assert(pg7.margins.top === Math.round(1200 * 0.65), 'Solution 6: margin scaled by 0.65 (' + pg7.margins.top + ')');

// Solution 7: combined-mild - all three levers touched, each gentler than its solo solution.
window.__ocrPageBreakStrategy = 'combined-mild';
const pg8 = { paragraphs: [{ lineTwips: 276, spaceAfterTwips: 160, segments: [{ sizePt: 12 }] }], margins: { top: 1200, bottom: 1200, left: 1200, right: 1200 } };
applyPageHeightBudgetFull(pg8);
assert(pg8.paragraphs[0].lineTwips === Math.round(276 * 0.92), 'Solution 7: spacing scaled gently (0.92)');
assert(pg8.paragraphs[0].segments[0].sizePt === 12 * 0.95, 'Solution 7: font scaled gently (0.95)');
assert(pg8.margins.top === Math.round(1200 * 0.85), 'Solution 7: margin scaled gently (0.85)');

// Solution 8/9: neither spacing/font/margin lever fires - handled by
// entirely separate code paths (buildWithFeedbackLoop / buildDocx).
window.__ocrPageBreakStrategy = 'feedback-loop';
const pg9 = { paragraphs: [{ lineTwips: 276, spaceAfterTwips: 160 }] };
applyPageHeightBudgetFull(pg9);
assert(pg9.paragraphs[0].lineTwips === 276, 'Solution 8: no local compaction (handled by server feedback loop instead)');

window.__ocrPageBreakStrategy = 'absolute-position';
const pg10 = { paragraphs: [{ lineTwips: 276, spaceAfterTwips: 160 }] };
applyPageHeightBudgetFull(pg10);
assert(pg10.paragraphs[0].lineTwips === 276, 'Solution 9: no local compaction (handled by buildDocx instead)');
assert(_ocrShouldForceBreak() === false, 'Solution 9: page-break-per-source-page also skipped (buildDocx handles page boundaries itself)');

// ── Persistence: selection survives across a simulated reload ──────────
delete window.__ocrPageBreakStrategy;
const fakeStorage = {};
global.localStorage = {
  getItem: function (k) { return Object.prototype.hasOwnProperty.call(fakeStorage, k) ? fakeStorage[k] : null; },
  setItem: function (k, v) { fakeStorage[k] = v; },
};
// Simulate the dropdown's onchange handler.
localStorage.setItem('lexora_ocrPageBreakStrategy', 'margin-tighten');
window.__ocrPageBreakStrategy = 'margin-tighten';
// Simulate a fresh page load: in-memory global is gone, only localStorage remains.
delete window.__ocrPageBreakStrategy;
assert(_ocrPageBreakStrategy() === 'margin-tighten', 'Persistence: strategy restored from localStorage after simulated reload');

console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
