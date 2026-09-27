// Test for the buildHybridDocxBlob checkpoint refactor: an optional
// onCheckpoint(stage, blob) callback fires with ('ocr', blob) right
// after OCR/extraction completes (BEFORE translation) and with
// ('translation', blob) right after translation completes - so the
// caller can trigger an immediate download at each real stage.
// _assembleHybridDocumentBlob is the extracted, reusable document-
// assembly step both checkpoints (and the final return) now share.

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'engine-translation.js'), 'utf8');

function assert(cond, label) { if (!cond) { console.log('FAIL:', label); process.exitCode = 1; } else console.log('PASS:', label); }

function extractFn(marker) {
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(marker + ' not found');
  let depth = 0, end = -1;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return src.slice(start, end);
}

assert(src.includes('function _assembleHybridDocumentBlob('), '_assembleHybridDocumentBlob is defined as its own reusable function');
const hybridSrc = extractFn('async function buildHybridDocxBlob(');

assert(hybridSrc.includes('const onCheckpoint = typeof opts.onCheckpoint'), 'buildHybridDocxBlob reads an optional onCheckpoint callback from opts');

// OCR checkpoint: fires BEFORE translation, using the untranslated allPagesJson.
const ocrCkIdx = hybridSrc.indexOf("onCheckpoint('ocr'");
const translateCallIdx = hybridSrc.indexOf('CALL 3: TRANSLATION');
assert(ocrCkIdx !== -1, "onCheckpoint('ocr', ...) is called");
assert(ocrCkIdx < translateCallIdx, 'The OCR checkpoint fires BEFORE the translation call, not after');
assert(hybridSrc.slice(Math.max(0, ocrCkIdx - 300), ocrCkIdx).includes('_assembleHybridDocumentBlob('), 'The OCR checkpoint blob is built via the shared assembly helper, not a separate implementation');

// Translation checkpoint: fires AFTER translation, gated to only fire when translation actually ran.
const transCkIdx = hybridSrc.indexOf("onCheckpoint('translation'");
assert(transCkIdx !== -1, "onCheckpoint('translation', ...) is called");
assert(transCkIdx > translateCallIdx, 'The Translation checkpoint fires AFTER the translation call, not before');
assert(hybridSrc.slice(Math.max(0, transCkIdx - 200), transCkIdx).includes('!keepOriginal'), 'The Translation checkpoint only fires when translation actually ran (target language is not "original")');

// The final return value reuses the SAME assembled blob as the
// translation checkpoint - not a third, separate assembly.
assert(hybridSrc.includes('return finalBlob'), 'The function returns the same finalBlob used for the translation checkpoint - one assembly, not built twice');

// Backward compatibility: calling without opts.onCheckpoint must not throw.
assert(hybridSrc.includes('typeof opts.onCheckpoint === \'function\' ? opts.onCheckpoint : null'), 'onCheckpoint safely defaults to null when not provided - existing callers without it are unaffected');

console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
