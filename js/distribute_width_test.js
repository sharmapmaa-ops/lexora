// Test for the exact change directed by the user: box width = the
// real, source-captured last-character pixel position (line.wPt,
// unchanged - already what this was), and jc="distribute" applied
// UNCONDITIONALLY (no per-line detection/heuristic) - Word's own
// rendering naturally does nothing when the box already matches the
// text's natural width, and naturally stretches to fill when the box
// is wider than the text needs. Replaces the earlier ratio/threshold-
// based detection heuristic entirely (removed per explicit direction,
// not because it was proven wrong).

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'translation-offline.js'), 'utf8');

function assert(cond, label) { if (!cond) { console.log('FAIL:', label); process.exitCode = 1; } else console.log('PASS:', label); }

assert(src.includes('const cx = Math.max(1, Math.round(line.wPt * EMU));'), 'Box width still comes directly from line.wPt (the real captured source width, unchanged)');
assert(src.includes("'<w:jc w:val=\"distribute\"/></w:pPr>'"), 'jc is set to "distribute" (not "both", not conditional)');
assert(!src.includes('_markJustifiedLines'), 'The old per-line detection heuristic is fully removed, not just unused');
assert(!/line\.justify/.test(src.replace(/\/\/.*$/gm, '')), 'No code (outside comments) references a per-line justify flag anymore - distribute is unconditional');

console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
