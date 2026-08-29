// Test for the Translation service's CURRENT real flow, per explicit
// direction: the old single upfront "Use Aspose?" confirmation dialog
// is GONE. Instead, for EACH file, a decision is made automatically:
//   - a Word (.docx) upload ALWAYS routes into the Aspose branch,
//     which for a docx upload specifically skips the actual Aspose
//     call and uses the uploaded file directly as step 1's output
//     (confirmed real reported case: routing a Word-sourced document
//     through the vision/OCR hybrid pipeline instead badly mangled
//     its structure - bolded everything into one run and scrambled
//     clause order).
//   - a PDF upload is analyzed automatically via a new server
//     endpoint (/api/translation/detect-pdf-content, real pdfplumber
//     table/image detection) - Aspose is used only if a real table or
//     image is found on some page; otherwise the lighter pdf.js/
//     vision pipeline runs.
// If Aspose is used, the 3-step pipeline runs:
//   Step 1: send the PDF to Aspose, get back the converted Word doc
//           (/api/translation/aspose-convert)
//   Step 2: inject the actual translation into that docx
//           (/api/translation/inject-translation)
//   Step 3: document reviewer (/api/translation/review)
// Otherwise, the EXISTING vision-based hybrid pipeline runs
// (window.__translationEngine.buildHybridDocxBlob).
// Both paths trigger 3 immediate downloads as each real stage's
// document becomes ready (OCR, Translation, Final Output).

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function assert(cond, label) { if (!cond) { console.log('FAIL:', label); process.exitCode = 1; } else console.log('PASS:', label); }

// The old upfront confirmation dialog is gone.
assert(!src.includes("showConfirm('Use Aspose?'"), 'The old upfront "Use Aspose?" confirmation dialog is completely removed');
assert(!src.includes('processState.translationUseAspose'), 'No remaining references to the old per-batch processState flag');

// The per-file decision: docx always -> Aspose branch; PDF -> real detection call.
const decisionIdx = src.indexOf('let useAsposeForThisFile;');
assert(decisionIdx !== -1, 'A per-file useAsposeForThisFile decision variable exists');
const decisionBlock = src.slice(decisionIdx, decisionIdx + 2400);
assert(decisionBlock.includes('if (file.isDocxUpload) {') && decisionBlock.includes('useAsposeForThisFile = true;'), 'A docx upload unconditionally routes into the Aspose branch');
assert(decisionBlock.includes("fetch('/api/translation/detect-pdf-content'"), 'A PDF upload calls the new content-detection endpoint');
assert(decisionBlock.includes('useAsposeForThisFile = !!detectData.recommendAspose'), 'The detection result (real table/image presence) drives the per-file decision for PDFs');
assert(decisionBlock.includes('useAsposeForThisFile = true;') && /content check failed/i.test(decisionBlock), 'A failed detection call fails safe toward Aspose, not silently toward the lighter pipeline');

// Per-file branching now uses the new local variable, not the old per-batch flag.
assert(src.includes('if (useAsposeForThisFile) {'), 'Per-file processing branches on the new per-file decision');

// The Aspose branch: all 3 steps present, in the right order, wired correctly.
const asposeBranchStart = src.indexOf('if (useAsposeForThisFile) {');
// The branch has an INNER if/else (docx-upload vs PDF-upload, for Step
// 1 specifically) nested inside it, so anchor on the Final Output
// download (the last real action in the branch) and find the outer
// "} else {" AFTER that, which is unambiguous regardless of nesting.
const finalOutputDownloadIdx = src.indexOf("_downloadBlobImmediately(offlineBlob, baseName + ' Final Output.docx')", asposeBranchStart);
const asposeBranchEnd = src.indexOf('} else {', finalOutputDownloadIdx);
const asposeBranch = src.slice(asposeBranchStart, asposeBranchEnd);
assert(asposeBranch.includes("fetch('/api/translation/aspose-convert'"), 'Aspose branch, Step 1: calls /api/translation/aspose-convert');
assert(asposeBranch.includes("fetch('/api/translation/inject-translation'"), 'Aspose branch, Step 2: calls /api/translation/inject-translation');
assert(asposeBranch.includes("fetch('/api/translation/review'"), 'Aspose branch, Step 3: calls /api/translation/review');
const s1 = asposeBranch.indexOf("fetch('/api/translation/aspose-convert'");
const s2 = asposeBranch.indexOf("fetch('/api/translation/inject-translation'");
const s3 = asposeBranch.indexOf("fetch('/api/translation/review'");
assert(s1 < s2 && s2 < s3, 'Aspose branch: Step 1 -> Step 2 -> Step 3 run in the correct real order');
assert(asposeBranch.includes('reviewIssues = reviewData.issues'), "The reviewer's issue list is captured, not discarded");

// The Aspose branch: 3 immediate downloads, one per real stage.
assert(asposeBranch.includes("_downloadBlobImmediately(offlineBlob, baseName + ' OCR.docx')"), 'Aspose branch: OCR stage downloads immediately after Step 1');
assert(asposeBranch.includes("_downloadBlobImmediately(offlineBlob, baseName + ' Translation.docx')"), 'Aspose branch: Translation stage downloads immediately after Step 2');
assert(asposeBranch.includes("_downloadBlobImmediately(offlineBlob, baseName + ' Final Output.docx')"), 'Aspose branch: Final Output stage downloads immediately after Step 3 (reviewer)');

// Real reported edge case: a Word (.docx) upload skips Step 1 entirely
// (there's no PDF for Aspose to convert) - the uploaded file is used
// directly as step 1's own output instead.
assert(asposeBranch.includes('if (file.isDocxUpload) {'), 'Aspose branch checks for a docx upload before deciding whether to call Aspose at all');
assert(asposeBranch.includes('step1DocxBase64 = dataBase64'), 'A docx upload\'s own content is used directly as step 1\'s output - Aspose is skipped for it');

// The non-Aspose branch: uses the EXISTING hybrid pipeline, DIRECTLY on
// the original upload - no docx-to-pdf conversion, since a docx upload
// never reaches this branch anymore.
const nonAsposeBranch = src.slice(asposeBranchEnd, src.indexOf("file.progress = '65';", asposeBranchEnd) + 200);
assert(nonAsposeBranch.includes('buildHybridDocxBlob(blob'), 'Non-Aspose branch: calls the existing vision-based hybrid pipeline directly on the original upload');
assert(!nonAsposeBranch.includes('buildBoxBasedTranslatedDocxBlob('), 'Non-Aspose branch no longer calls the box-based pipeline');
assert(!nonAsposeBranch.includes("fetch('/api/translation/aspose-convert'"), 'Non-Aspose branch does NOT call any Aspose endpoint');
assert(!nonAsposeBranch.includes("fetch('/api/translation/docx-to-pdf'"), 'Non-Aspose branch no longer converts anything to PDF - a docx upload never reaches this branch');

// The non-Aspose branch: 3 immediate downloads via onCheckpoint + a
// direct Final Output download (no compatible reviewer for this
// pipeline's MHT output format yet, so Final Output currently reuses
// the Translation-stage document rather than a separately reviewed one).
assert(nonAsposeBranch.includes("onCheckpoint: function (stage, ckBlob)"), 'Non-Aspose branch passes an onCheckpoint callback into buildHybridDocxBlob');
assert(nonAsposeBranch.includes("stage === 'ocr'") && nonAsposeBranch.includes("baseName + ' OCR.doc'"), 'onCheckpoint downloads the OCR-stage document immediately when it fires');
assert(nonAsposeBranch.includes("stage === 'translation'") && nonAsposeBranch.includes("baseName + ' Translation.doc'"), 'onCheckpoint downloads the Translation-stage document immediately when it fires');
assert(nonAsposeBranch.includes("baseName + ' Final Output.doc'"), 'Non-Aspose branch also downloads a Final Output file, so both paths produce all 3 real files');

// The old table/background routing (a DIFFERENT, earlier mechanism)
// and the old process-aspose endpoint remain genuinely gone.
assert(!src.includes("fetch('/api/translation/analyze-strategy'"), 'The old table/background analyze-strategy call is fully removed');
assert(!src.includes("fetch('/api/translation/process-aspose'"), 'The old process-aspose (structure+translate in one call) is fully removed');

console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
