// Test for the Translation service's CURRENT real flow, per explicit
// direction: Aspose is no longer used for Document Translation AT ALL.
// Every upload now runs through the SAME pdf.js text-layer pipeline
// (window.__translationEngine.buildPdfjsTranslatedDocxBlob, defined in
// js/engine-translation.js) - it extracts text, vectors, and images
// directly from a real PDF's own content stream (no OCR/vision model;
// Lexora's separate OCR service already covers scanned documents) and
// translates via v14TranslateAllPages, so it gets the same domain-expert
// glossary and reviewer-agent pass every other engine call in this file
// already has.
//
// A Word (.docx) upload is converted to a real PDF FIRST (server-side,
// LibreOffice, via the existing /api/translation/docx-to-pdf endpoint -
// the same conversion already used elsewhere in server.py), then fed
// into the pipeline exactly like a native PDF upload - there is no
// separate "Aspose branch" vs "non-Aspose branch" distinction anymore.

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function assert(cond, label) { if (!cond) { console.log('FAIL:', label); process.exitCode = 1; } else console.log('PASS:', label); }

// The old upfront confirmation dialog, and the old per-file
// useAsposeForThisFile decision, are both fully gone.
assert(!src.includes("showConfirm('Use Aspose?'"), 'The old upfront "Use Aspose?" confirmation dialog is completely removed');
assert(!src.includes('processState.translationUseAspose'), 'No remaining references to the old per-batch processState flag');
assert(!src.includes('useAsposeForThisFile'), 'The old per-file Aspose-vs-not decision variable is fully removed');

// No Aspose endpoints are called anywhere in the Translation flow anymore.
assert(!src.includes("fetch('/api/translation/aspose-convert'"), 'aspose-convert is never called');
assert(!src.includes("fetch('/api/translation/inject-translation'"), 'inject-translation is never called');
assert(!src.includes("fetch('/api/translation/review'"), 'the Aspose document-reviewer step is never called');
assert(!src.includes("fetch('/api/translation/detect-pdf-content'"), 'the old table/image detection routing call is removed (no branching needed - there is only one path now)');
assert(!src.includes('buildBoxBasedTranslatedDocxBlob('), 'The old, dead box-based pipeline is never called');
assert(!src.includes('buildHybridDocxBlob('), 'The old vision/OCR-based hybrid pipeline is never called');

// The new flow: a docx upload converts to PDF first, then EVERY upload
// (docx-converted or native PDF) goes through buildPdfjsTranslatedDocxBlob.
const anchorIdx = src.indexOf('let reviewIssues = [];');
assert(anchorIdx !== -1, 'The new flow block exists (anchored on the reviewIssues declaration)');
const block = src.slice(anchorIdx, src.indexOf('pagesCharged = 1;', anchorIdx) + 50);

assert(block.includes('if (file.isDocxUpload) {'), 'A Word upload is detected before deciding how to obtain a PDF');
assert(block.includes("fetch('/api/translation/docx-to-pdf'"), 'A Word upload calls the docx-to-pdf conversion endpoint');
assert(block.includes('pdfFileForPipeline = new Blob(['), 'The converted PDF bytes are wrapped into a real Blob for the pipeline');
assert(block.includes('window.__translationEngine.buildPdfjsTranslatedDocxBlob(pdfFileForPipeline'), 'The new pdf.js text-layer pipeline is called with the (possibly converted) PDF');
assert(block.includes("targetLang: targetLanguage"), 'The target language is passed through to the pipeline');
assert(block.includes("_downloadBlobImmediately(offlineBlob, baseName + ' Final Output.docx')"), 'The Final Output document downloads immediately once the pipeline finishes');

// A native PDF upload skips the docx-to-pdf conversion entirely (it
// already IS a PDF) - pdfFileForPipeline defaults to the original blob.
assert(block.includes('let pdfFileForPipeline = blob;'), 'A native PDF upload defaults to using its own blob directly, without conversion');

console.log('\nNote: js/engine-translation.js (and its 4 per-service duplicates) are');
console.log('exercised by a separate, dedicated test - this file only covers app.js own routing/wiring logic.');
