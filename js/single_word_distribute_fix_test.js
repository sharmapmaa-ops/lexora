// Regression test for a CONFIRMED REAL bug (via an actual MS Word
// screenshot, not LibreOffice - LibreOffice does not reproduce this):
// jc="distribute" applied unconditionally to every line caused real
// Word to spread individual CHARACTERS across the box width for any
// single-word line ("MARR" -> "M A R R", "Tra" -> "T"..."r" stretched
// across the whole line, etc.) - because a single word has no inter-
// WORD gap for Word to distribute, so it falls back to inter-CHARACTER
// spacing instead. LibreOffice leaves single-word "distribute" lines
// alone, which is exactly why this wasn't caught by LibreOffice-based
// testing earlier - a real, now-documented gap in that verification
// method (see CLAUDE_INSTRUCTIONS.md).
//
// Fix: only 2+-word lines get jc="distribute"; single-word lines get
// plain "left" (there's no meaningful word-gap to justify in a single
// word regardless of box width).
//
// This test exercises the REAL textBoxXml function (extracted verbatim
// from translation-offline.js) directly against the EXACT words from
// the reported screenshot.

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

let drawId = 500;
const EMU = 12700;
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

// eslint-disable-next-line no-eval
eval(extractFn('textBoxXml').replace('function textBoxXml', 'var textBoxXml = function'));

function assert(cond, label) { if (!cond) { console.log('FAIL:', label); process.exitCode = 1; } else console.log('PASS:', label); }
function getJc(xml) { const m = xml.match(/w:jc w:val="([a-z]*)"/); return m ? m[1] : null; }

// The EXACT single words that broke in the real reported screenshot.
['Tra', 'e', 'MARR', 'seguito,', 'Parte', 'Premesso'].forEach(function (word) {
  const line = { xPt: 60, yPt: 60, wPt: 400, hPt: 14, rtl: false, runs: [{ text: word, sizePt: 11 }] };
  assert(getJc(textBoxXml(line)) === 'left', 'Single word "' + word + '" -> jc="left" (was the real reported bug case)');
});

// Multi-word lines must be unaffected - still get distribute.
['KRYALOS Società di Gestione del Risparmio', 'This is a longer test line with several words'].forEach(function (text) {
  const line = { xPt: 60, yPt: 60, wPt: 400, hPt: 14, rtl: false, runs: [{ text: text, sizePt: 11 }] };
  assert(getJc(textBoxXml(line)) === 'distribute', 'Multi-word line "' + text.slice(0, 20) + '..." -> jc="distribute" unaffected');
});

// Edge case: exactly 2 words (the minimum for distribute to make sense).
const twoWordLine = { xPt: 60, yPt: 60, wPt: 200, hPt: 14, rtl: false, runs: [{ text: 'Two words', sizePt: 11 }] };
assert(getJc(textBoxXml(twoWordLine)) === 'distribute', 'Exactly 2 words -> jc="distribute" (boundary case)');

// Edge case: a single word split across multiple styled runs (e.g.
// bold "MARR" as its own run) must still be treated as ONE word.
const splitRunLine = { xPt: 60, yPt: 60, wPt: 200, hPt: 14, rtl: false, runs: [{ text: 'MARR', sizePt: 11, bold: true }] };
assert(getJc(textBoxXml(splitRunLine)) === 'left', 'Single word in its own styled run -> still jc="left"');

console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
