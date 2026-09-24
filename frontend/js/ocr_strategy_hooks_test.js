// Isolated test for the strategy-hook functions added to
// translation-offline.js for the admin "🤖 Claude" tab live-switchable
// OCR page-break/compaction strategies.
global.window = global; // so `window.__ocrPageBreakStrategy` works under plain Node

function _ocrPageBreakStrategy() { return window.__ocrPageBreakStrategy || 'forced-budget'; }
function _ocrBudgetRatioFloor() {
  const s = _ocrPageBreakStrategy();
  if (s === 'forced-budget-aggressive') return 0.60;
  if (s === 'forced-nobudget' || s === 'natural') return 1.0;
  return 0.75;
}
function _ocrShouldForceBreak() {
  return _ocrPageBreakStrategy() !== 'natural';
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) { console.log('FAIL:', label, '- expected', expected, 'got', actual); process.exitCode = 1; }
  else console.log('PASS:', label);
}

// Default (nothing set) -> Solution 1 behavior.
delete window.__ocrPageBreakStrategy;
assertEqual(_ocrPageBreakStrategy(), 'forced-budget', 'Default strategy is forced-budget');
assertEqual(_ocrBudgetRatioFloor(), 0.75, 'Default floor ratio is 0.75');
assertEqual(_ocrShouldForceBreak(), true, 'Default forces page breaks');

// Solution 2: aggressive compaction.
window.__ocrPageBreakStrategy = 'forced-budget-aggressive';
assertEqual(_ocrBudgetRatioFloor(), 0.60, 'Aggressive strategy floor is 0.60');
assertEqual(_ocrShouldForceBreak(), true, 'Aggressive strategy still forces breaks');

// Solution 3: forced break, no compaction.
window.__ocrPageBreakStrategy = 'forced-nobudget';
assertEqual(_ocrBudgetRatioFloor(), 1.0, 'No-budget strategy disables compaction (floor=1.0)');
assertEqual(_ocrShouldForceBreak(), true, 'No-budget strategy still forces breaks');

// Solution 4: natural pagination, no forced break, no compaction.
window.__ocrPageBreakStrategy = 'natural';
assertEqual(_ocrBudgetRatioFloor(), 1.0, 'Natural strategy disables compaction');
assertEqual(_ocrShouldForceBreak(), false, 'Natural strategy does NOT force page breaks');

console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
