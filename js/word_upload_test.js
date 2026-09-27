// Test for Word-document upload support in Translation service, per
// explicit direction: uploading a .docx (not just .pdf) is now
// supported. A .docx upload ALWAYS routes into the Aspose branch,
// which for a docx upload specifically skips the actual Aspose call
// (there's no PDF for Aspose to convert) and uses the uploaded file
// directly as step 1's own output. A docx upload NEVER goes through
// any OCR/vision pipeline (neither Aspose's own conversion nor the
// pdf.js/vision hybrid pipeline) - confirmed via a real reported case
// that routing a Word-sourced document through OCR/vision extraction
// badly mangled its structure (bolded everything into one run,
// scrambled clause order), since that pipeline re-extracts structure
// from a rendered PDF image, destroying structure the docx already
// had correctly. See translation_flow_test.js for the full per-file
// Aspose-vs-pdf.js decision flow this plugs into.

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function assert(cond, label) { if (!cond) { console.log('FAIL:', label); process.exitCode = 1; } else console.log('PASS:', label); }

// Upload validation: Translation accepts .docx too, Lease Abstraction still doesn't.
assert(src.includes('/\\.(pdf|docx)$/i.test(f.name)'), 'Translation-specific file validation accepts both .pdf and .docx');
assert(src.includes("isDocxUpload: isDocx"), 'Each uploaded file is tagged with whether it was a .docx upload');
assert(src.includes("accept=\"${isTranslation ? '.pdf,.docx' : '.pdf'}\""), 'The file input\'s accept attribute is docx-aware for Translation specifically, unchanged for other services');

// The per-file decision: a docx upload unconditionally routes into the Aspose branch.
const decisionIdx = src.indexOf('let useAsposeForThisFile;');
assert(decisionIdx !== -1, 'A per-file useAsposeForThisFile decision variable exists');
const decisionBlock = src.slice(decisionIdx, decisionIdx + 400);
assert(decisionBlock.includes('if (file.isDocxUpload) {') && decisionBlock.includes('useAsposeForThisFile = true;'), 'A docx upload is unconditionally decided toward the Aspose branch, before any PDF-content detection runs');

// Inside the Aspose branch itself: docx uploads skip the actual Aspose call.
const asposeSkipIdx = src.indexOf('if (file.isDocxUpload) {', decisionIdx + 400);
assert(asposeSkipIdx !== -1, 'The Aspose branch ALSO checks file.isDocxUpload (a second, separate check from the routing decision above)');
const asposeSkipBlock = src.slice(asposeSkipIdx, asposeSkipIdx + 900);
assert(asposeSkipBlock.includes('skipping Aspose conversion'), 'A skip-Aspose activity message is logged for docx uploads');
assert(asposeSkipBlock.includes('step1DocxBase64 = dataBase64'), 'The uploaded docx\'s own base64 is used directly as step 1\'s output, with no Aspose call');
assert(!asposeSkipBlock.includes("fetch('/api/translation/aspose-convert'"), 'No Aspose endpoint is called inside the skip-branch itself');

// A docx upload never reaches the non-Aspose (hybrid vision/OCR)
// branch at all anymore - there is no docx-to-pdf conversion path
// left in the codebase for this purpose.
assert(!src.includes("fetch('/api/translation/docx-to-pdf'"), 'No remaining call to a docx-to-pdf conversion endpoint anywhere in app.js - a docx upload never needs one');

console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
