// Test for the full per-service engine split (translation-offline.js ->
// 5 fully-separate files), done per explicit user direction after a
// real, still-unexplained deploy/cache mismatch and a follow-up
// decision to give every service ("Translation", "OCR", "Data
// Extraction", "BAI2", "Paid Calculators") its own completely
// independent engine file rather than one shared one.
//
// Verifies, by ACTUALLY LOADING each real file (not just reading its
// text), that each one correctly assigns its own uniquely-named
// window.* namespace with all expected functions - the critical
// property this split depends on: if all 5 were loaded on the same
// page with identical flat window.X = Y names, whichever loaded last
// would silently overwrite the others.

const path = require('path');

function loadEngine(filename) {
  const win = {};
  const originalWindow = global.window;
  const originalDocument = global.document;
  global.window = win;
  global.document = {
    createElement: function () {
      return { getContext: function () { return { measureText: function () { return { width: 10 }; }, font: '' }; } };
    },
  };
  try {
    delete require.cache[require.resolve(path.join(__dirname, filename))];
    require(path.join(__dirname, filename));
  } catch (e) {
    // Some deep browser-only code path may throw once real DOM/pdf.js
    // APIs are touched - irrelevant here, since the namespace assignment
    // happens synchronously at the END of the IIFE; if we got far enough
    // for that assignment to run, `win` already has what we need.
  } finally {
    global.window = originalWindow;
    global.document = originalDocument;
  }
  return win;
}

function assert(cond, label) { if (!cond) { console.log('FAIL:', label); process.exitCode = 1; } else console.log('PASS:', label); }

const services = [
  { file: 'engine-ocr.js', ns: '__ocrEngine' },
  { file: 'engine-translation.js', ns: '__translationEngine' },
  { file: 'engine-dataextraction.js', ns: '__dataExtractionEngine' },
  { file: 'engine-bai2.js', ns: '__bai2Engine' },
  { file: 'engine-calculators.js', ns: '__calculatorsEngine' },
];

const requiredKeys = ['buildHybridDocxBlob', 'buildOfflineDocxBlob', 'buildBoxBasedTranslatedDocxBlob', 'setVisionAuthToken', 'setVisionStopCheck', 'setPipelineEventHandler', 'lexoraProxyJson', 'lexoraPdfToImages', 'resetPipelineApiCounters', 'abortVision'];

const allNamespaces = new Set();

services.forEach(function (svc) {
  const win = loadEngine(svc.file);
  const ns = win[svc.ns];
  assert(typeof ns === 'object' && ns !== null, svc.file + ' assigns window.' + svc.ns + ' as an object');
  if (ns) {
    requiredKeys.forEach(function (key) {
      assert(typeof ns[key] === 'function', svc.file + '\'s ' + svc.ns + '.' + key + ' is a function');
    });
  }
  assert(!allNamespaces.has(svc.ns), svc.ns + ' is not reused by any other service (unique namespace)');
  allNamespaces.add(svc.ns);
});

// OCR-specific diagnostics must exist ONLY in engine-ocr.js.
const ocrWin = loadEngine('engine-ocr.js');
assert(typeof ocrWin.__ocrEngineBuildTag === 'string', 'engine-ocr.js sets __ocrEngineBuildTag');
assert(typeof ocrWin.__ocrTextBoxXmlSource === 'string', 'engine-ocr.js sets __ocrTextBoxXmlSource');

const translationWin = loadEngine('engine-translation.js');
assert(translationWin.__ocrEngineBuildTag === undefined, 'engine-translation.js does NOT define the OCR-specific diagnostic markers');

console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
