// Test for the width-from-source-pixel change (still true) and the
// justify-condition history: originally applied unconditionally per
// direct instruction, then made conditional on word count after a
// CONFIRMED REAL bug (single-word "distribute" lines character-spread
// in real MS Word - see single_word_distribute_fix_test.js for that
// specific regression test). This file keeps checking the parts that
// are still accurate.

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'engine-ocr.js'), 'utf8');

function assert(cond, label) { if (!cond) { console.log('FAIL:', label); process.exitCode = 1; } else console.log('PASS:', label); }

assert(src.includes('const cx = Math.max(1, Math.round(line.wPt * EMU));'), 'Box width still comes directly from line.wPt (the real captured source width, unchanged)');
assert(src.includes("wordCount >= 2 ? 'distribute' : 'left'"), 'jc is "distribute" only for 2+ word lines, "left" for single words (see single_word_distribute_fix_test.js)');
assert(!src.includes('_markJustifiedLines'), 'The old per-line detection heuristic is fully removed, not just unused');
assert(!/line\.justify/.test(src.replace(/\/\/.*$/gm, '')), 'No code (outside comments) references a per-line justify FLAG anymore - the decision is a direct word-count check, not a stored per-line property');

console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
