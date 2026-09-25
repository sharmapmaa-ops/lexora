// Test for the OCR engine build-version diagnostic marker, added after
// a real reported case: user redeployed + hard-refreshed, but the
// output still showed old (jc="both") behavior instead of the fix
// (jc="distribute"). window.__ocrEngineBuildTag lets this mismatch be
// seen directly in the admin "Claude" tab (no DevTools needed) instead
// of requiring manual file inspection. Lives in js/engine-ocr.js (the
// OCR service's own fully-separate engine copy) since this diagnostic
// is OCR-specific.

const fs = require('fs');
const path = require('path');

const offlineSrc = fs.readFileSync(path.join(__dirname, 'engine-ocr.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function assert(cond, label) { if (!cond) { console.log('FAIL:', label); process.exitCode = 1; } else console.log('PASS:', label); }

const setMatch = offlineSrc.match(/window\.__ocrEngineBuildTag\s*=\s*'([^']+)'/);
assert(!!setMatch, 'engine-ocr.js sets window.__ocrEngineBuildTag');

const compareMatch = appSrc.match(/_expected\s*=\s*'([^']+)'/);
assert(!!compareMatch, 'app.js has an _expected version string to compare against');

if (setMatch && compareMatch) {
  assert(setMatch[1] === compareMatch[1], 'The version string set in engine-ocr.js EXACTLY matches the one app.js compares against (' + setMatch[1] + ')');
}

assert(appSrc.includes('getElementById(\'ocrEngineVersionDisplay\')'), 'app.js displays the live loaded version in the admin panel');
assert(appSrc.includes('getElementById(\'ocrEngineVersionWarn\')'), 'app.js shows a visible warning when the loaded version does not match');

console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
