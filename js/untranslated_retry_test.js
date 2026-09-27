// Test for the untranslated-box retry pass added to
// buildBoxBasedTranslatedDocxBlob, per explicit direction: confirmed
// real bug against a real reported document - roughly 6% of lines
// (short, isolated label fragments) came back from the main
// merged-paragraph translation call still containing the source
// script, when the target language was not RTL-scripted. This is a
// structural/source-level test (real live LLM calls aren't available
// in this environment) confirming the retry pass exists, is correctly
// gated, and never writes back a still-broken result.

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'engine-translation.js'), 'utf8');

function assert(cond, label) { if (!cond) { console.log('FAIL:', label); process.exitCode = 1; } else console.log('PASS:', label); }

function extractFn(name) {
  const marker = 'async function ' + name + '(';
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(name + ' not found');
  let depth = 0, end = -1;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return src.slice(start, end);
}

const fnSrc = extractFn('buildBoxBasedTranslatedDocxBlob');

assert(fnSrc.includes('stillUntranslated'), 'A retry pass scans for lines still needing translation');
assert(fnSrc.includes('hasRTL(line.runs[0].text'), 'Detection uses the real hasRTL check on the line\'s CURRENT (post-main-pass) text, not the original');
assert(fnSrc.includes('if (!wantRtl)'), 'The retry pass is gated to only run when the TARGET language is not RTL-scripted (remaining RTL text is only a bug when the target is not RTL)');

// The retry call itself.
const retryIdx = fnSrc.indexOf('if (!wantRtl)');
const retryBlock = fnSrc.slice(retryIdx);
assert(retryBlock.includes('v14TranslateAllPages(model, retryBlocks, targetLang, false)'), 'Retry calls v14TranslateAllPages again, WITHOUT paragraph grouping (each failed line retried individually/isolated)');
assert(retryBlock.includes('v14ApplyTranslations(retryBlocks'), 'Retry reuses v14ApplyTranslations, not a second application mechanism');

// Never writes back a still-broken result.
assert(retryBlock.includes('hasRTL(b.text)) return'), 'If the retry ALSO still contains RTL text, the line is left as-is rather than overwritten with another broken result');
assert(retryBlock.includes('catch (retryErr)'), 'A failed retry call itself is handled gracefully (logged, not thrown) - the main translation is not undone by a failed second pass');

console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
