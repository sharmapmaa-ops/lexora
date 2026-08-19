// Isolated reproduction of applyPageHeightBudget / estimateParagraphHeightPt
// from js/translation-offline.js, using a simple deterministic width model
// instead of Canvas.measureText (which needs a DOM) - the compaction MATH
// being tested is identical; only the text-measurement primitive is swapped
// for something runnable in plain Node.

// Simple deterministic "measureTextPt": avg glyph width ~0.55x font size,
// close enough to a real sans-serif metric for this test's purpose.
function measureTextPt(text, sizePt, family, bold, italic) {
  const perCharPt = sizePt * (bold ? 0.6 : 0.55);
  return String(text || '').length * perCharPt;
}

const BUDGET_MIN_COMPACTION_RATIO = 0.75;
const BUDGET_LINE_FLOOR_TWIPS = 200;
const BUDGET_SPACE_AFTER_FLOOR_TWIPS = 40;

function estimateParagraphHeightPt(p, usableWidthPt) {
  const indentPt = p.listInfo ? (p.listInfo.level + 1) * 28 : 0;
  const availWidthPt = Math.max(50, usableWidthPt - indentPt);
  let totalTextWidthPt = 0;
  (p.segments || []).forEach(function (seg) {
    totalTextWidthPt += measureTextPt(seg.text || '', seg.sizePt || 11, seg.family, seg.bold, seg.italic);
  });
  const estimatedLines = totalTextWidthPt > 0 ? Math.max(1, Math.ceil(totalTextWidthPt / availWidthPt)) : 1;
  const lineHeightPt = (p.lineTwips || 276) / 20;
  const spaceAfterPt = (p.spaceAfterTwips != null ? p.spaceAfterTwips : 160) / 20;
  return estimatedLines * lineHeightPt + spaceAfterPt;
}

function applyPageHeightBudget(pg) {
  const usableWidthPt = pg.wPt - (pg.margins.left + pg.margins.right) / 20;
  const usableHeightPt = pg.hPt - (pg.margins.top + pg.margins.bottom) / 20;
  if (!(usableWidthPt > 0) || !(usableHeightPt > 0)) return;

  let totalPt = 0;
  (pg.paragraphs || []).forEach(function (p) { totalPt += estimateParagraphHeightPt(p, usableWidthPt); });
  (pg.images || []).forEach(function (im) { totalPt += im.hPt || 0; });
  (pg.tables || []).forEach(function (t) { totalPt += Math.max(0, (t.bottomPt || 0) - (t.topPt || 0)); });

  if (totalPt <= usableHeightPt || totalPt <= 0) return { compacted: false, totalPt: totalPt, usableHeightPt: usableHeightPt };

  const ratio = Math.max(BUDGET_MIN_COMPACTION_RATIO, usableHeightPt / totalPt);
  (pg.paragraphs || []).forEach(function (p) {
    p.lineTwips = Math.max(BUDGET_LINE_FLOOR_TWIPS, Math.round((p.lineTwips || 276) * ratio));
    p.spaceAfterTwips = Math.max(BUDGET_SPACE_AFTER_FLOOR_TWIPS, Math.round((p.spaceAfterTwips != null ? p.spaceAfterTwips : 160) * ratio));
  });
  return { compacted: true, ratio: ratio, totalPt: totalPt, usableHeightPt: usableHeightPt };
}

function assert(cond, label) {
  if (!cond) { console.log('FAIL:', label); process.exitCode = 1; }
  else console.log('PASS:', label);
}

// Test 1: a page that comfortably fits -> budget should NOT touch spacing.
const fitsPage = {
  wPt: 595, hPt: 842,
  margins: { left: 60 * 20, right: 60 * 20, top: 60 * 20, bottom: 60 * 20 },
  paragraphs: [
    { segments: [{ text: 'Short paragraph.', sizePt: 11, family: 'Arial' }], lineTwips: 276, spaceAfterTwips: 160 }
  ],
  images: [], tables: []
};
const before = JSON.stringify(fitsPage.paragraphs[0]);
const r1 = applyPageHeightBudget(fitsPage);
assert(r1.compacted === false, 'Test 1: page that fits is left untouched');
assert(JSON.stringify(fitsPage.paragraphs[0]) === before, 'Test 1b: spacing values unchanged when it fits');

// Test 2: a page whose estimated content clearly overflows -> should compact
// (mirrors the real reported case: dense final page with a lot of text).
function longParagraph(n) {
  return { segments: [{ text: 'Lorem ipsum dolor sit amet consectetur adipiscing elit. '.repeat(n), sizePt: 11, family: 'Arial' }], lineTwips: 276, spaceAfterTwips: 160 };
}
const denseParagraphs = [];
for (let i = 0; i < 15; i++) denseParagraphs.push(longParagraph(3));
const densePage = {
  wPt: 595, hPt: 842,
  margins: { left: 60 * 20, right: 60 * 20, top: 60 * 20, bottom: 60 * 20 },
  paragraphs: denseParagraphs,
  images: [], tables: []
};
const totalBefore = denseParagraphs.reduce(function (s, p) {
  return s + estimateParagraphHeightPt(p, (595 - 120));
}, 0);
const r2 = applyPageHeightBudget(densePage);
assert(r2.compacted === true, 'Test 2: overflowing page triggers compaction');
assert(r2.ratio < 1 && r2.ratio >= BUDGET_MIN_COMPACTION_RATIO, 'Test 2b: ratio within [0.75, 1) - ' + r2.ratio.toFixed(3));
assert(densePage.paragraphs[0].lineTwips < 276, 'Test 2c: lineTwips actually reduced (' + densePage.paragraphs[0].lineTwips + ' < 276)');
assert(densePage.paragraphs[0].lineTwips >= BUDGET_LINE_FLOOR_TWIPS, 'Test 2d: lineTwips never below floor');

// Test 3: pathologically dense page -> ratio clamps at floor, never goes lower.
const extremeParagraphs = [];
for (let i = 0; i < 60; i++) extremeParagraphs.push(longParagraph(5));
const extremePage = {
  wPt: 595, hPt: 842,
  margins: { left: 60 * 20, right: 60 * 20, top: 60 * 20, bottom: 60 * 20 },
  paragraphs: extremeParagraphs,
  images: [], tables: []
};
const r3 = applyPageHeightBudget(extremePage);
assert(r3.compacted === true, 'Test 3: pathological page still triggers compaction');
assert(r3.ratio === BUDGET_MIN_COMPACTION_RATIO, 'Test 3b: ratio clamps exactly at the 0.75 floor - got ' + r3.ratio);
assert(extremePage.paragraphs[0].lineTwips === Math.max(BUDGET_LINE_FLOOR_TWIPS, Math.round(276 * BUDGET_MIN_COMPACTION_RATIO)), 'Test 3c: lineTwips reflects exact floor-ratio math');

// Test 4: content is never deleted - paragraph count identical before/after.
assert(extremePage.paragraphs.length === 60, 'Test 4: no paragraphs dropped despite heavy compaction');

console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
