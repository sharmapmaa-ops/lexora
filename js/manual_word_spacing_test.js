// Test for the REAL fix to the character-spreading bug, replacing the
// earlier "word count >= 2 -> distribute" attempt entirely.
//
// ROOT CAUSE (confirmed via Microsoft's own OpenXML SDK documentation,
// not assumed): w:jc="distribute" is literally defined as "Distribute
// ALL CHARACTERS Equally" - a CJK/Thai-style character-level
// justification by design, not a Latin-script word-level one. The
// earlier word-count fix correctly handled single-word lines (no
// "distribute" applied) but STILL used "distribute" for 2+-word lines -
// and a real reported screenshot showed a 6-word title STILL
// character-spread ("A C C O R D O...") despite that fix, because
// "distribute" spreads every character regardless of word count.
//
// jc="both" was also already tried and confirmed broken separately:
// Word exempts a paragraph's only/last line from "both"-style
// stretching, and every line in this architecture IS its own one-line
// paragraph.
//
// FIX: jc is now unconditionally "left". Justify-looking spacing is
// achieved by manually computing the gap between the box's real width
// (line.wPt, from the source PDF's real glyph positions) and the
// natural (unstretched) width the same words need, then distributing
// that gap via w:spacing (character tracking) applied ONLY to the
// space character between words - never within a word, and never at
// all when there's no real inter-word gap (single-word lines) or no
// real slack (the box already matches natural width).

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

let drawId = 500;
const EMU = 12700;
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
// Deterministic stand-in for measureTextPt (real one needs browser Canvas).
function measureTextPt(text, sizePt, family, bold, italic) {
  const perCharPt = (sizePt || 11) * (bold ? 0.6 : 0.55);
  return String(text || '').length * perCharPt;
}

// eslint-disable-next-line no-eval
eval(extractFn('textBoxXml').replace('function textBoxXml', 'var textBoxXml = function'));

function assert(cond, label) { if (!cond) { console.log('FAIL:', label); process.exitCode = 1; } else console.log('PASS:', label); }
function countSpacingRuns(xml) { return (xml.match(/<w:spacing w:val="\d+"\/>/g) || []).length; }
function naturalWidth(text, sizePt) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const spaceW = measureTextPt(' ', sizePt);
  let w = 0;
  words.forEach(function (word, i) { w += measureTextPt(word, sizePt); if (i > 0) w += spaceW; });
  return w;
}

const textBoxXmlSrc = extractFn('textBoxXml');
assert(textBoxXmlSrc.includes('const cx = Math.max(1, Math.round(line.wPt * EMU));'), 'Box width still comes directly from line.wPt (the real captured source last-character pixel, unchanged by this fix)');
assert(src.includes("const jc = 'left';"), 'jc is unconditionally "left" in the real source - never distribute, never both');
assert(!textBoxXmlSrc.includes("'distribute'"), 'textBoxXml itself never uses the string "distribute" as a value anymore (a separate, unrelated table-alignment code path elsewhere in the file legitimately still does, and is out of scope here)');

// Case 1: single word - structurally cannot get any w:spacing (gapCount=0).
const line1 = { xPt: 60, yPt: 60, wPt: 400, hPt: 14, rtl: false, runs: [{ text: 'MARR', sizePt: 11, family: 'Arial' }] };
const xml1 = textBoxXml(line1);
assert(countSpacingRuns(xml1) === 0, 'Single word "MARR" (the real reported case), wide box -> ZERO w:spacing runs');
assert(xml1.includes('>MARR<'), 'Single word text emitted intact');

// Case 2: the EXACT real 6-word title that was still broken after the
// word-count fix.
const titleText = 'ACCORDO MODIFICATIVO DEL CONTRATTO DI LOCAZIONE';
const naturalW = naturalWidth(titleText, 12);
const line2 = { xPt: 136.7, yPt: 60, wPt: naturalW * 1.2, hPt: 16, rtl: false, runs: [{ text: titleText, sizePt: 12, bold: true, family: 'Arial' }] };
const xml2 = textBoxXml(line2);
assert(countSpacingRuns(xml2) === 5, 'Real reported title (6 words, wide box) -> exactly 5 w:spacing runs (one per inter-word gap)');
assert(xml2.includes('>ACCORDO<') && xml2.includes('>LOCAZIONE<'), 'Words stay intact, not split into letters');
assert(!/>[A-Z]<\/w:t>/.test(xml2), 'No single-letter runs exist anywhere in the title output');

// Case 3: box already matches natural width (normal line) -> zero extra spacing.
const normalText = 'Tutto ciò premesso';
const line3 = { xPt: 60, yPt: 60, wPt: naturalWidth(normalText, 11), hPt: 14, rtl: false, runs: [{ text: normalText, sizePt: 11, family: 'Arial' }] };
assert(countSpacingRuns(textBoxXml(line3)) === 0, 'Line whose box already matches natural width -> zero extra spacing (no false-positive stretch)');

console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
