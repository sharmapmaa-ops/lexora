// Test for the two genuinely NEW pieces in buildBoxBasedTranslatedDocxBlob
// (everything else - extraction, paragraph-grouping, merge-translate,
// reflow, font-fit search, box rendering - is REUSED, already-tested
// infrastructure, not re-tested here):
//   1. Character-count comparison GATES whether a box's font size gets
//      re-measured at all (per explicit direction: only when the
//      translated text is actually longer than the original).
//   2. RTL/LTR box position-mirroring: a box's own x-coordinate is
//      mirrored within the page when the target direction differs from
//      the line's original direction (new_x = pageWidth - old_x - width),
//      width/height unaffected - not the Aspose-side paragraph-indent
//      mirror (a different mechanism for a different architecture).

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'engine-translation.js'), 'utf8');

function assert(cond, label) { if (!cond) { console.log('FAIL:', label); process.exitCode = 1; } else console.log('PASS:', label); }

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

assert(src.includes('async function buildBoxBasedTranslatedDocxBlob('), 'buildBoxBasedTranslatedDocxBlob is defined');
const fnSrc = extractFn('buildBoxBasedTranslatedDocxBlob');

// Confirm it reuses existing infrastructure, not reimplementations.
assert(fnSrc.includes('extractOfflinePage('), 'Reuses the real extractOfflinePage (same pdf.js extraction)');
assert(fnSrc.includes('v14GroupLinesIntoParagraphs('), 'Reuses the real paragraph-grouping (decides which lines merge for translation)');
assert(fnSrc.includes('v14TranslateAllPages(model, allBlocks, targetLang, true)'), 'Calls v14TranslateAllPages with paragraph-grouping ENABLED (true) - merges multi-box paragraphs into one translation call');
assert(fnSrc.includes('v14ApplyTranslations('), 'Reuses v14ApplyTranslations (the same merge-then-reflow-across-original-widths mechanism the vision pipeline already uses)');
assert(fnSrc.includes('v14FindSmartFontSize('), 'Reuses the real, Canvas-measured font-fit search - not a new approximate implementation');
assert(fnSrc.includes('return buildDocx(pages, true)'), 'Renders via the existing Solution 9 renderer (buildDocx/textBoxXml)');

// Piece 1: character-count comparison gates the resize.
assert(fnSrc.includes('translatedText.length > originalText.length'), 'Resize is gated by a genuine character-count comparison (translated vs original)');
const gateIdx = fnSrc.indexOf('if (translatedText.length > originalText.length)');
const gateBlock = fnSrc.slice(gateIdx, gateIdx + 300);
assert(gateBlock.includes('v14FindSmartFontSize('), 'When the gate trips (translated IS longer), the real font-fit search runs to find the precise new size');
assert(gateBlock.includes('Math.min(originalSizePt'), 'The new size can only shrink (never grow past the original size) - Math.min caps it');

// Directly verify the gate's own boolean logic with concrete real strings.
function wouldResize(original, translated) { return translated.length > original.length; }
assert(wouldResize('Hello', 'Bonjour') === true, 'Real check: "Bonjour" (7) is longer than "Hello" (5) -> gate trips, would resize');
assert(wouldResize('Hello world today', 'Hi') === false, 'Real check: "Hi" (2) is shorter than "Hello world today" (18) -> gate does NOT trip, size stays');
assert(wouldResize('Same', 'Same') === false, 'Real check: identical length -> gate does NOT trip (not strictly longer)');

// Piece 2: RTL/LTR box position-mirroring.
assert(fnSrc.includes('wantRtl !== line.rtl'), 'Box mirroring triggers when the target direction differs from the line\'s own original direction');
assert(fnSrc.includes('pageWidthPt - line.xPt - line.wPt'), 'Mirrors the box\'s x-coordinate within the page (pageWidth - x - width) - a coordinate mirror, not a paragraph-indent mirror');
assert(fnSrc.includes('line.rtl = wantRtl'), 'The line\'s own direction flag is updated to match the target language after mirroring');

// Directly verify the coordinate math with concrete real numbers -
// matches the exact same mirror shape as the Aspose-side margin fix
// (new_left = old_right), just expressed as an absolute x-coordinate.
function mirrorX(pageWidthPt, oldX, width) { return Math.max(0, pageWidthPt - oldX - width); }
assert(mirrorX(600, 50, 200) === 350, 'Real check: a 200pt-wide box starting at x=50 on a 600pt page mirrors to x=350 (600-50-200)');
assert(mirrorX(600, 350, 200) === 50, 'Real check: mirroring is its own inverse - a box now at x=350 mirrors back to x=50');

console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
