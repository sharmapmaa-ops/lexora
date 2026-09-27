// Test for the Translation service's NEW automatic Aspose-vs-pdf.js
// routing (js/app.js), replacing the old manual "With OCR" checkbox
// entirely, per explicit direction: a source PDF with tables or
// background color goes through Aspose (structure-aware conversion +
// real in-place LLM translation); everything else uses the existing
// client-side pdf.js text-layer pipeline, falling back automatically
// to vision-based OCR for genuinely scanned PDFs - mirroring
// ocr-service.js's own fallback pattern exactly, rather than a manual
// toggle deciding vision-vs-text-layer.

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function assert(cond, label) { if (!cond) { console.log('FAIL:', label); process.exitCode = 1; } else console.log('PASS:', label); }

// The old manual checkbox and its supporting variables are genuinely gone
// from the reachable code, not just renamed.
assert(!src.includes("getElementById('translationHybridCheck')"), 'No remaining reference to the removed translationHybridCheck checkbox element');
assert(!src.includes('const translationHybridMode ='), 'The old translationHybridMode constant declaration is removed');

// The new routing calls both real endpoints.
assert(src.includes("fetch('/api/translation/analyze-strategy'"), 'Calls the new /api/translation/analyze-strategy endpoint');
assert(src.includes("fetch('/api/translation/process-aspose'"), 'Calls the new /api/translation/process-aspose endpoint');

// The three-way strategy outcome drives naming/extension, not a binary hybridMode.
assert(src.includes("actualStrategyUsed === 'aspose'"), 'Output naming distinguishes the aspose outcome');
assert(src.includes("actualStrategyUsed === 'vision_ocr_fallback'"), 'Output naming distinguishes the vision-OCR-fallback outcome');
assert(src.includes("actualStrategyUsed === 'client_text_layer'") || src.includes("actualStrategyUsed = 'client_text_layer'"), 'The plain client-side text-layer outcome is tracked as its own named state');

// The automatic scanned-PDF fallback mirrors ocr-service.js's own pattern
// (catch the specific "scanned/image-based" signal, fall back to
// buildHybridDocxBlob) rather than a manual toggle.
const translationFlowStart = src.indexOf("if (translationStrategy === 'aspose')");
assert(translationFlowStart !== -1, 'The new translationStrategy dispatch exists');
const translationFlowSrc = src.slice(translationFlowStart, translationFlowStart + 7000);
assert(translationFlowSrc.includes('looksLikeScanSignal'), 'The scanned-PDF signal is checked, same as ocr-service.js');
assert(translationFlowSrc.includes('buildHybridDocxBlob'), 'Falls back to buildHybridDocxBlob automatically on that signal');
assert(translationFlowSrc.includes('buildOfflineDocxBlob'), 'Tries buildOfflineDocxBlob (pdf.js text-layer) first, as the default path');

// Billing: the Aspose path (no per-page event stream) must still charge
// correctly, using the page count already known from analyze-strategy.
assert(translationFlowSrc.includes('translationStrategyAnalysis') && translationFlowSrc.includes('page_count'),
  'Aspose path bills using the real page count from the analyze-strategy call (not left at zero for lack of per-page events)');

// A failed analyze-strategy call must not block translation entirely -
// same defensive default as OCR's own analyzeOcrStrategy().
const analyzeCallIdx = src.indexOf("fetch('/api/translation/analyze-strategy'");
const analyzeSurrounding = src.slice(Math.max(0, analyzeCallIdx - 800), analyzeCallIdx + 200);
assert(analyzeSurrounding.includes("let translationStrategy = 'lightweight'"), 'translationStrategy defaults to lightweight before the analysis call, so a failed request still lets translation proceed');

console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
