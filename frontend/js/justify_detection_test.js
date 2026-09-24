// Test for _markJustifiedLines (Solution 9's justify detection),
// REDESIGNED per explicit user direction: standalone per-line detection,
// no comparison to any OTHER line on the page (the earlier version
// compared each line's right edge against a page-wide "shared boundary"
// computed across many lines - the user explicitly called that a
// "bounding box" approach and asked for pure line-by-line detection
// using only that line's own data instead).
//
// SIGNAL: a justified line's REAL captured width (from actual glyph
// positions in the source PDF) is wider than the NATURAL width the same
// words would need at normal (single-space) spacing. Computed entirely
// from one line's own text + its own captured width - nothing else.
//
// (Background on WHY jc="distribute" is used rather than jc="both" for
// these single-line boxes is unchanged from before - see the earlier
// investigation: OOXML/Word convention exempts a paragraph's only/last
// line from "both"-style justify, and every line here is its own
// one-line paragraph; "distribute" has no such exemption, confirmed via
// a real isolated LibreOffice render test.)

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'translation-offline.js'), 'utf8');
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

// Deterministic stand-in for measureTextPt (which uses Canvas, browser-
// only) - same approach used elsewhere in this project's Node-side
// tests (e.g. the earlier page-height-budget test): a fixed per-
// character width model. This proves the DETECTION ALGORITHM's logic
// is correct given consistent measurements, not that any specific
// real-world font measures exactly this way.
function measureTextPt(text, sizePt, family, bold, italic) {
  const perCharPt = (sizePt || 11) * (bold ? 0.6 : 0.55);
  return String(text || '').length * perCharPt;
}

// eslint-disable-next-line no-eval
eval(extractFn('_markJustifiedLines').replace('function _markJustifiedLines', 'var _markJustifiedLines = function'));

function assert(cond, label) { if (!cond) { console.log('FAIL:', label); process.exitCode = 1; } else console.log('PASS:', label); }

function naturalWidth(text, sizePt) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const spaceW = measureTextPt(' ', sizePt);
  let w = 0;
  words.forEach(function (word, i) {
    w += measureTextPt(word, sizePt);
    if (i > 0) w += spaceW;
  });
  return w;
}

// Case 1: real captured width is meaningfully wider than natural ->
// justified (this line's OWN data only).
const text1 = 'KRYALOS Società di Gestione del Risparmio S.p.A. con sede legale';
const natural1 = naturalWidth(text1, 10.5);
const stretchedLine = { xPt: 56.6, wPt: natural1 * 1.15, runs: [{ text: text1, sizePt: 10.5, family: 'Cambria' }] };
const pgA = { lines: [stretchedLine] };
_markJustifiedLines(pgA);
assert(pgA.lines[0].justify === true, 'Case 1: real width 15% wider than natural -> marked justified (standalone)');

// Case 2: real captured width matches natural width closely -> NOT
// justified (normal ragged-right line).
const text2 = 'Tutto ciò premesso';
const natural2 = naturalWidth(text2, 10.5);
const normalLine = { xPt: 92.7, wPt: natural2 * 1.01, runs: [{ text: text2, sizePt: 10.5, family: 'Cambria' }] };
const pgB = { lines: [normalLine] };
_markJustifiedLines(pgB);
assert(pgB.lines[0].justify !== true, 'Case 2: real width matches natural width -> NOT marked justified');

// Case 3: single word - no inter-word gap exists to judge, must never
// be marked justified regardless of its width.
const singleWordLine = { xPt: 287.8, wPt: 500, runs: [{ text: 'Tra', sizePt: 10.5, family: 'Cambria' }] };
const pgC = { lines: [singleWordLine] };
_markJustifiedLines(pgC);
assert(pgC.lines[0].justify !== true, 'Case 3: single word never marked justified (no gap to measure)');

// Case 4: STANDALONE guarantee - detection for one line must not
// depend on any other line being present. Feed the SAME stretched line
// alone vs alongside other very different lines and confirm identical
// result both times.
const pgD1 = { lines: [Object.assign({}, stretchedLine)] };
const pgD2 = { lines: [
  { xPt: 136.7, wPt: 40, runs: [{ text: 'Tra', sizePt: 10.5, family: 'Cambria' }] },
  Object.assign({}, stretchedLine),
  { xPt: 92.7, wPt: 20, runs: [{ text: 'e', sizePt: 10.5, family: 'Cambria' }] },
] };
_markJustifiedLines(pgD1);
_markJustifiedLines(pgD2);
assert(pgD1.lines[0].justify === pgD2.lines[1].justify, 'Case 4: same line gets the SAME verdict whether alone or surrounded by unrelated lines (truly standalone, not page-boundary-based)');

// Case 5: a page with only ONE line total (the old heuristic required
// >=3 substantial lines on the page to trust a "shared boundary" -
// that requirement no longer applies at all, since there's no boundary
// being computed anymore).
const pgE = { lines: [Object.assign({}, stretchedLine)] };
_markJustifiedLines(pgE);
assert(pgE.lines[0].justify === true, 'Case 5: works correctly even with only one line total on the page (no minimum-line-count requirement anymore)');

// Case 6: THE REAL REPORTED FALSE POSITIVE - a short (6-word) CENTERED
// TITLE, artificially stretched in this test to exceed the ratio
// threshold, must still NOT be marked justified purely because it has
// too few words for the ratio signal to be trustworthy (real word
// counts checked directly against the reported document: the title
// has 6 words, "Tra"/"e" connector lines have 1, every genuine
// justified body line checked has 10-21 - MIN_WORDS=8 sits cleanly
// between the false-positive case and the real cases).
const titleText = 'ACCORDO  MODIFICATIVO DEL CONTRATTO DI LOCAZIONE';
const titleNatural = naturalWidth(titleText, 12);
const titleLine = { xPt: 136.7, wPt: titleNatural * 1.15, runs: [{ text: titleText, sizePt: 12, family: 'Cambria' }] };
const pgF = { lines: [titleLine] };
_markJustifiedLines(pgF);
assert(pgF.lines[0].justify !== true, 'Case 6: short centered title (6 words) NOT marked justified even when its width ratio alone would cross the threshold');

console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
