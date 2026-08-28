// Test for Word-document upload support in Translation service, per
// explicit direction: uploading a .docx (not just .pdf) is now
// supported, and:
//   "Yes" (use Aspose) + docx upload -> Aspose conversion (Step 1) is
//     SKIPPED entirely (there's no PDF for Aspose to convert), the
//     uploaded docx is used directly as step 1's own output.
//   "No" (no Aspose) + docx upload -> the uploaded docx is converted
//     to a real PDF server-side first (/api/translation/docx-to-pdf),
//     then the EXISTING vision-based hybrid pipeline runs on that PDF
//     exactly as it would for a normal PDF upload.

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function assert(cond, label) { if (!cond) { console.log('FAIL:', label); process.exitCode = 1; } else console.log('PASS:', label); }

// Upload validation: Translation accepts .docx too, Lease Abstraction still doesn't.
assert(src.includes('/\\.(pdf|docx)$/i.test(f.name)'), 'Translation-specific file validation accepts both .pdf and .docx');
assert(src.includes("isDocxUpload: isDocx"), 'Each uploaded file is tagged with whether it was a .docx upload');
assert(src.includes("accept=\"${isTranslation ? '.pdf,.docx' : '.pdf'}\""), 'The file input\'s accept attribute is docx-aware for Translation specifically, unchanged for other services');

// Yes + docx: Aspose Step 1 is skipped.
const asposeSkipIdx = src.indexOf('if (file.isDocxUpload) {');
assert(asposeSkipIdx !== -1, 'The Aspose branch checks file.isDocxUpload');
const asposeSkipBlock = src.slice(asposeSkipIdx, asposeSkipIdx + 900);
assert(asposeSkipBlock.includes('skipping Aspose conversion'), 'A skip-Aspose activity message is logged for docx uploads');
assert(asposeSkipBlock.includes('step1DocxBase64 = dataBase64'), 'The uploaded docx\'s own base64 is used directly as step 1\'s output, with no Aspose call');
assert(!asposeSkipBlock.includes("fetch('/api/translation/aspose-convert'"), 'No Aspose endpoint is called inside the skip-branch itself');

// No + docx: converted to PDF first, then the existing hybrid pipeline runs on it.
const noBranchIdx = src.indexOf("let hybridInputBlob = blob;");
assert(noBranchIdx !== -1, 'The non-Aspose branch introduces a separate hybridInputBlob variable (not overwriting the original upload)');
const noBranchBlock = src.slice(noBranchIdx, noBranchIdx + 3200);
assert(noBranchBlock.includes("fetch('/api/translation/docx-to-pdf'"), 'Calls the new docx-to-pdf conversion endpoint');
assert(noBranchBlock.includes('hybridInputBlob = new Blob'), 'The converted PDF bytes become the new input blob');
assert(noBranchBlock.includes('buildHybridDocxBlob(hybridInputBlob'), 'The EXISTING hybrid pipeline is called with the (possibly-converted) blob, not a new implementation');

console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
