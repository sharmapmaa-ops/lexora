// Test for the enhanced "document engine failed to load" diagnostic in
// ocr-service.js, added after a real reported case where this generic
// message gave no way to tell WHY window.__ocrEngine was missing -
// specifically, whether engine-ocr.js never started executing at all,
// or started (setting its early markers) but never finished (so the
// final window.__ocrEngine export never ran). The enhanced message
// includes the real diagnostic state at the exact moment of failure.

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'ocr-service.js'), 'utf8');

function assert(cond, label) { if (!cond) { console.log('FAIL:', label); process.exitCode = 1; } else console.log('PASS:', label); }

assert(src.includes('window.__ocrEngineBuildTag ||'), 'ocr-service.js reads the build-tag marker in its diagnostic');
assert(src.includes('window.__ocrTextBoxXmlSource'), 'ocr-service.js reads the textBoxXml-source marker in its diagnostic');
assert(src.includes("console.error('OCR engine diagnostic"), 'A console.error is emitted with the full diagnostic object, for anyone who does check DevTools');
assert(src.includes('[diag: engine='), 'The user-visible status message itself includes the diagnostic (no DevTools needed to see it)');

// Extract and directly exercise the real function's logic (not a
// reimplementation) across the three real scenarios that matter.
function extractCheckBlock() {
  const start = src.indexOf('if (!window.__ocrEngine || !window.__ocrEngine.buildOfflineDocxBlob) {');
  let depth = 0, end = -1;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return src.slice(start, end);
}
function setStatus(msg, level) { return { msg: msg, level: level }; }
function checkEngine() {
  // eslint-disable-next-line no-eval
  return eval('(function(){' + extractCheckBlock() + ' return null;})()');
}

global.window = {};
let r = checkEngine();
assert(r && r.msg.includes('engine=false'), 'Real code, scenario "never loaded": diagnostic shows engine=false');

global.window = { __ocrEngineBuildTag: 'some-tag', __ocrTextBoxXmlSource: 'function x(){}' };
r = checkEngine();
assert(r && r.msg.includes('some-tag'), 'Real code, scenario "partial load" (markers set, export missing): diagnostic surfaces the real tag, distinguishing this from "never loaded"');

global.window = { __ocrEngine: { buildOfflineDocxBlob: function () {} } };
r = checkEngine();
assert(r === null, 'Real code, scenario "fully loaded": check passes, no error');

console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
