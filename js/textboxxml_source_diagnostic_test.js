// Test for the real-function-source diagnostic (window.__ocrTextBoxXmlSource
// + admin panel display), added after a genuinely confusing real report:
// the top-of-file version marker (window.__ocrEngineBuildTag) correctly
// showed the NEW value, yet the actual OCR output still showed OLD
// behavior - from the SAME script file. Since a separate marker string
// can apparently drift out of sync with the function it's meant to
// represent (exact cause not yet diagnosed - could not be reproduced in
// this sandbox), this exposes the REAL function's own literal source so
// there's no separate claim to trust - what's displayed IS what's
// executing.

const fs = require('fs');
const path = require('path');

const offlineSrc = fs.readFileSync(path.join(__dirname, 'engine-ocr.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function assert(cond, label) { if (!cond) { console.log('FAIL:', label); process.exitCode = 1; } else console.log('PASS:', label); }

assert(offlineSrc.includes('window.__ocrTextBoxXmlSource = textBoxXml.toString();'), 'engine-ocr.js exports the REAL textBoxXml function\'s own source (not a separate hand-written marker)');

// Confirm the export happens AFTER textBoxXml is fully defined (so
// .toString() captures the complete, real function body, not a
// partial/hoisted reference).
const defIdx = offlineSrc.indexOf('function textBoxXml(line){');
const exportIdx = offlineSrc.indexOf('window.__ocrTextBoxXmlSource = textBoxXml.toString();');
assert(defIdx !== -1 && exportIdx !== -1 && exportIdx > defIdx, 'The export happens after textBoxXml\'s definition, capturing its complete real body');

assert(appSrc.includes("getElementById('ocrTextBoxXmlFixCheck')"), 'app.js displays a clear yes/no verdict on whether the real function has the fix');
assert(appSrc.includes("getElementById('ocrTextBoxXmlSourceDisplay')"), 'app.js can show the full real source on demand for manual inspection');
assert(appSrc.includes("_src.indexOf('wordCount >= 2')"), 'The admin panel checks for the exact real fix string (wordCount >= 2), not an HTML-escaped or approximate variant');

// Directly exercise the real function + the exact same check expression
// used in the admin panel, end to end.
function extractFn(name) {
  const marker = 'function ' + name + '(';
  const start = offlineSrc.indexOf(marker);
  let depth = 0, end = -1;
  for (let i = start; i < offlineSrc.length; i++) {
    if (offlineSrc[i] === '{') depth++;
    else if (offlineSrc[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return offlineSrc.slice(start, end);
}
let drawId = 500;
const EMU = 12700;
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
// eslint-disable-next-line no-eval
eval(extractFn('textBoxXml').replace('function textBoxXml', 'var textBoxXml = function'));
const realFnSrc = textBoxXml.toString();
const hasFix = !!(realFnSrc && realFnSrc.indexOf('wordCount >= 2') !== -1);
assert(hasFix === true, 'End-to-end: the exact admin-panel check expression correctly finds the fix in the real, currently-defined function');

console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
