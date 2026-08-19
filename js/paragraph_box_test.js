// Test for paragraphBoxXml - built during an intermediate iteration of
// Solution 9 (per-paragraph wrapping boxes, fixing a real overflow bug
// in the original per-line non-wrapping boxes).
//
// CURRENT STATUS: after further discussion, the user asked to revert
// Solution 9 to the box+image state that was confirmed working well
// (per-line boxes, textBoxXml + floatingImageXml), and fix justify via
// a targeted, standalone per-line detection layered on top of THAT
// (see justify_detection_test.js / _markJustifiedLines) rather than
// restructuring into paragraph-wrapping boxes. paragraphBoxXml is KEPT
// as working, independently-tested infrastructure (not deleted) in
// case real wrapping + absolute positioning is wanted again for some
// other reason later - this file still verifies its own XML-generation
// correctness even though no current strategy calls it.
//
// BACKGROUND (for the XML-generation checks below, still relevant):
// the original Solution 9 (textBoxXml, one box per LINE, wrap="none",
// fixed width from pdf.js's own font measurement) had a structural
// overflow risk - Word renders with its own font metrics, which can
// measure the same text as wider than pdf.js did, and wrap="none"
// gives the text nowhere to go but past the box edge. paragraphBoxXml
// fixed this (real wrapping + spAutoFit), confirmed via an actual
// end-to-end render (real buildDocx + paragraphBoxXml, real JSZip,
// real LibreOffice render) at the time, before the revert above.

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
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// eslint-disable-next-line no-eval
eval(extractFn('paragraphBoxXml').replace('function paragraphBoxXml', 'var paragraphBoxXml = function'));

function assert(cond, label) { if (!cond) { console.log('FAIL:', label); process.exitCode = 1; } else console.log('PASS:', label); }

// Structural checks: after two iterations, the user explicitly asked
// to revert to the box+image state that was confirmed working well,
// and layer the justify fix on top via _markJustifiedLines' new
// standalone per-line detection (see justify_detection_test.js)
// instead of restructuring into wrapping paragraph boxes. Solution 9 is
// back to a real early-return into buildDocx's default per-line
// rendering (textBoxXml + floatingImageXml).
assert(src.includes('function buildDocx(pages, includeBg, renderPageExtra)'), 'buildDocx still accepts an optional renderPageExtra hook (kept for future use, currently unused)');
assert(src.includes("if (_ocrPageBreakStrategy() === 'absolute-position')"), "Solution 9's early-return branch exists again");
const solution9BranchIdx = src.indexOf("if (_ocrPageBreakStrategy() === 'absolute-position')");
const solution9BranchSrc = src.slice(solution9BranchIdx, solution9BranchIdx + 300);
assert(solution9BranchSrc.includes('return buildDocx(pages, false);'), "Solution 9 calls buildDocx's default (per-line box) rendering, not paragraphBoxXml");
assert(src.includes("s === 'forced-nobudget' || s === 'natural' || s === 'absolute-position' || s === 'feedback-loop'"), "applyPageHeightBudget again treats 'absolute-position' as its own separate (no-compaction) case");
assert(src.includes("return s !== 'natural' && s !== 'absolute-position';"), "_ocrShouldForceBreak again excludes 'absolute-position' (buildDocx handles its own page breaks, unconditionally)");

// XML-generation checks: real paragraph -> real XML, confirm wrap and
// autofit are correctly set (the two properties that fix the overflow).
const testPara = {
  leftPt: 56.6, rightPt: 538.7, topPt: 117.3, bottomPt: 240,
  align: 'justify', rtl: false, lineTwips: 276,
  segments: [{ text: 'A sample paragraph with enough text to require wrapping across several lines when rendered.', sizePt: 10.5, bold: false, italic: false, color: '000000', family: 'Cambria' }],
};
const xml = paragraphBoxXml(testPara, 538.7);

assert(xml.includes('wrap="square"'), 'Generated box uses wrap="square" (real wrapping), not wrap="none"');
assert(xml.includes('<a:spAutoFit/>'), 'Generated box uses spAutoFit (native auto-grow height), not a fixed guessed height');
assert(xml.includes('w:jc w:val="both"'), 'justify paragraph maps to jc="both" (correct for a real multi-line wrapped paragraph)');
assert(xml.includes('relativeFrom="paragraph"'), 'Vertical position is still paragraph-relative (multi-page correctness preserved)');
assert(!xml.includes('wrap="none"'), 'Old wrap="none" is NOT present');

// Width check: box width should reach the given container boundary, not
// just this paragraph's own (possibly narrower) rightPt - this is what
// gives justify real room to distribute AND gives wrapping a correct
// column width to wrap against.
const expectedCx = Math.round((538.7 - 56.6) * EMU);
assert(xml.includes('cx="' + expectedCx + '"'), 'Box width extends to the real content-column boundary (' + expectedCx + ')');

// Left-aligned paragraph should map to jc="left", not "both".
const leftPara = Object.assign({}, testPara, { align: 'left' });
const leftXml = paragraphBoxXml(leftPara, 538.7);
assert(leftXml.includes('w:jc w:val="left"'), 'left-aligned paragraph maps to jc="left"');

console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
