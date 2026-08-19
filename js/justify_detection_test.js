// Test for _markJustifiedLines (Solution 9's justify fix).
//
// BACKGROUND: Solution 9 (absolute-positioned text boxes) reported
// "very good, just missing justify" - source PDF had justified
// paragraphs, output didn't. Investigation found jc="both" was ALREADY
// present on every line, but empirically verified (via a minimal
// isolated LibreOffice render test) to have NO visible effect on a
// single-line, wrap="none" textbox - word-processor convention exempts
// a paragraph's only/last line from "both"-style justify, and every
// line in Solution 9 IS its own one-line paragraph. jc="distribute"
// does not have that exemption and was confirmed, in the same real
// render test, to actually spread words across the box width.
//
// This test runs the REAL _markJustifiedLines function (extracted
// verbatim from translation-offline.js) against REAL line geometry
// extracted from the actual reported document's own generated output
// (see /tmp/real_lines.json in that investigation - reproduced here as
// a fixture) to confirm the detection heuristic correctly separates
// genuinely-justified body lines from titles/short lines/last-lines-of-
// paragraph, without needing to re-run the full browser pipeline.

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

// eslint-disable-next-line no-eval
eval(extractFn('_markJustifiedLines').replace('function _markJustifiedLines', 'var _markJustifiedLines = function'));

function assert(cond, label) { if (!cond) { console.log('FAIL:', label); process.exitCode = 1; } else console.log('PASS:', label); }
function wc(text) { return text.trim().split(/\s+/).filter(Boolean).length; }

// Fixture: a representative slice of real lines from the reported
// document (positions/text taken directly from its actual generated
// output - not invented). Right margin for this page's body text is
// ~538pt; title and short lines intentionally don't reach it.
const fixtureLines = [
  { xPt: 136.7, wPt: 321.6, text: 'ACCORDO MODIFICATIVO DEL CONTRATTO DI LOCAZIONE' }, // centered title
  { xPt: 287.8, wPt: 19.6, text: 'Tra' }, // short standalone line
  { xPt: 56.6, wPt: 482.1, text: 'KRYALOS Società di Gestione del Risparmio S.p.A., con sede legale' },
  { xPt: 56.6, wPt: 481.7, text: '1, capitale sociale di Euro 1.000.000,00 interamente versato codice' },
  { xPt: 56.6, wPt: 482.0, text: 'numero di iscrizione presso il Registro delle Imprese di Milano' },
  { xPt: 56.6, wPt: 482.1, text: '05083780964 iscritta al numero 88 albo delle SGR tenuto presso' },
  { xPt: 56.6, wPt: 482.0, text: 'interviene alla presente scrittura privata quale societa di gestione' },
  { xPt: 56.6, wPt: 232.3 - 56.6, text: 'Parte e, congiuntamente, le Parti' }, // last line of a paragraph, short
];
const pg = { lines: fixtureLines.map(function (l) { return { xPt: l.xPt, yPt: 0, wPt: l.wPt, hPt: 14, runs: [{ text: l.text }] }; }) };

_markJustifiedLines(pg);

assert(pg.lines[0].justify !== true, 'Centered title is NOT marked justified');
assert(pg.lines[1].justify !== true, 'Short standalone line ("Tra") is NOT marked justified');
assert(pg.lines[2].justify === true, 'Body line 1 (reaches shared right margin) IS marked justified');
assert(pg.lines[3].justify === true, 'Body line 2 (reaches shared right margin) IS marked justified');
assert(pg.lines[4].justify === true, 'Body line 3 (reaches shared right margin) IS marked justified');
assert(pg.lines[5].justify === true, 'Body line 4 (reaches shared right margin) IS marked justified');
assert(pg.lines[6].justify === true, 'Body line 5 (reaches shared right margin) IS marked justified');
assert(pg.lines[7].justify !== true, 'Last line of paragraph (short, does not reach margin) is NOT marked justified');

// Edge case: a page with too little data should not guess.
const sparsePg = { lines: [
  { xPt: 56, yPt: 0, wPt: 300, hPt: 14, runs: [{ text: 'Only one substantial line on this page' }] },
] };
_markJustifiedLines(sparsePg);
assert(sparsePg.lines.every(function (L) { return L.justify !== true; }), 'A page with too few substantial lines marks nothing (avoids guessing on weak evidence)');

console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
