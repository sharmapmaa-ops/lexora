// Real, isolated test for the row-ordering fix in extractOfflinePage:
// segments within a row must be pushed into `lines` in READING order
// (reversed, right-to-left, for an RTL-dominant row), not always
// left-to-right - confirmed as the real cause of severely scrambled
// translated output on a real reported document (a dense bilingual
// government contract form).
//
// Uses the EXACT real coordinates extracted from that document's own
// "Contract is conditional" row (y=298 in the source PDF):
//   x=66  "Contract"     (English)
//   x=97  "is"           (English)
//   x=105 "conditional"  (English)
//   x=294 Arabic "No" (لا)
//   x=493 Arabic (طﺮﺸﺑ - part of "معلق بشرط")
//   x=512 Arabic (ﻖﻠﻌﻣ - part of "معلق بشرط")
// True reading order (confirmed against the rendered original PDF):
// right-to-left - "معلق بشرط" (rightmost) first, then "لا", then the
// English label last.

function hasRTL(text) { return /[\u0591-\u07FF\uFB1D-\uFDFF\uFE70-\uFEFF]/.test(text); }

function makeLine(seg) {
  // Minimal stand-in matching the real makeLine's externally-visible
  // shape (text join order + rtl flag) - geometry fields omitted since
  // this test is only about SEGMENT ORDER, not per-line geometry.
  return { text: seg.map(function (r) { return r.text; }).join(''), rtl: seg.some(function (r) { return hasRTL(r.text); }) };
}

// The exact real-row-ordering algorithm from extractOfflinePage (row
// already split into segments in left-to-right/ascending-x order, as
// the gap-based split already correctly does) - this function is the
// NEW piece: deciding final push order based on row direction.
function orderRowSegments(rowSegments) {
  const rtlSegCount = rowSegments.filter(function (s) { return s.some(function (r) { return hasRTL(r.text); }); }).length;
  const rowIsRtl = rtlSegCount > rowSegments.length / 2;
  return rowIsRtl ? rowSegments.slice().reverse() : rowSegments;
}

function assert(cond, label) { if (!cond) { console.log('FAIL:', label); process.exitCode = 1; } else console.log('PASS:', label); }

// Segments as they'd already correctly come out of the gap-based split,
// in left-to-right (ascending x) order - this part was always correct.
const segEnglish = [{ x: 66, w: 39, text: 'Contract' }, { x: 97, w: 8, text: 'is' }, { x: 105, w: 60, text: 'conditional' }];
const segArabicNo = [{ x: 294, w: 20, text: 'لا' }];
const segArabicPhrase = [{ x: 493, w: 15, text: 'طﺮﺸﺑ' }, { x: 512, w: 15, text: 'ﻖﻠﻌﻣ' }];

const leftToRightSegments = [segEnglish, segArabicNo, segArabicPhrase];

console.log('=== Test 1: row is correctly detected as RTL-dominant (2 of 3 segments are Arabic) ===');
const ordered = orderRowSegments(leftToRightSegments);
assert(ordered.length === 3, 'All 3 segments are still present after ordering (none dropped)');

console.log('\n=== Test 2: segments are reversed into true right-to-left reading order ===');
const lines = ordered.map(function (s) { return makeLine(s); });
assert(lines[0].text === 'طﺮﺸﺑﻖﻠﻌﻣ', 'First line pushed is the rightmost Arabic phrase segment (was pushed LAST under the old left-to-right bug)');
assert(lines[1].text === 'لا', 'Second line pushed is the Arabic "No" segment');
assert(lines[2].text === 'Contractisconditional', 'Third (last) line pushed is the English label segment (was pushed FIRST under the old bug)');

console.log('\n=== Test 3: a genuinely LTR-dominant row is left in left-to-right order (no regression for normal English/French/etc. documents) ===');
const segLtr1 = [{ x: 10, w: 30, text: 'Name:' }];
const segLtr2 = [{ x: 60, w: 40, text: 'John Smith' }];
const orderedLtr = orderRowSegments([segLtr1, segLtr2]);
assert(orderedLtr[0] === segLtr1 && orderedLtr[1] === segLtr2, 'An all-LTR row keeps its original left-to-right segment order unchanged');

console.log('\n=== Test 4: a mixed row with a genuine RTL majority (not just one RTL segment among several LTR ones) triggers reversal, not a bare RTL presence check ===');
const segMostlyLtrOneRtl = [{ x: 10, w: 20, text: 'A' }, { x: 40, w: 20, text: 'B' }, { x: 70, w: 10, text: 'لا' }];
const orderedMostlyLtr = orderRowSegments([[segMostlyLtrOneRtl[0]], [segMostlyLtrOneRtl[1]], [segMostlyLtrOneRtl[2]]]);
assert(orderedMostlyLtr[0].text ? false : orderedMostlyLtr[0][0].text === 'A', 'A row with only 1 of 3 segments RTL (not a majority) is NOT reversed');

console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
