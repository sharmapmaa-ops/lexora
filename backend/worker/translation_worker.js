// Lexora - Translation background worker (Phase 4a)
// ====================================================
// Runs buildPdfjsTranslatedDocxBlob (the SAME function frontend/js/engine-
// translation.js exports, ported here unchanged) as a standalone Node
// process. Node has no <script src=cdn> tags, so the small set of
// libraries that came from CDN script tags in the browser are npm
// dependencies here instead (see package.json) - everything else
// (buildBasePdf, region detection, DOCX generation, v14TranslateAllPages
// and its domain-glossary + reviewer-agent chain) is the EXACT same
// source text, extracted from engine-translation.js at startup and
// eval'd, not re-written - so a fix made in the browser file's function
// bodies is picked up here too without needing a second edit.
//
// Usage: node translation_worker.js <jobDir>
//   <jobDir>/job.json   - {jobId, userId, token, targetLang, model, port, status, ...}
//   <jobDir>/input.pdf  - the uploaded source file
//   <jobDir>/output.docx - written here on success
//
// This process is spawned detached by server.py's job-start handler and
// is expected to run to completion on its own; it never talks back to
// the browser directly, only to job.json (which the browser polls via
// server.py) and to server.py's own /api/... routes (for the OpenRouter
// proxy and the domain/rules data endpoints, exactly as the browser
// itself would call them).

const fs = require('fs');
const path = require('path');
const { createCanvas } = require('canvas');

const jobDir = process.argv[2];
if (!jobDir) {
  console.error('Usage: node translation_worker.js <jobDir>');
  process.exit(1);
}

const jobJsonPath = path.join(jobDir, 'job.json');
const inputPath = path.join(jobDir, 'input.pdf');
const outputPath = path.join(jobDir, 'output.docx');

function readJob() {
  return JSON.parse(fs.readFileSync(jobJsonPath, 'utf-8'));
}
function writeJob(patch) {
  const current = readJob();
  const merged = Object.assign(current, patch, { updatedAt: new Date().toISOString() });
  // Write to a temp file then rename - so a concurrent status-read from
  // server.py never sees a half-written file.
  const tmp = jobJsonPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
  fs.renameSync(tmp, jobJsonPath);
  return merged;
}

const job = readJob();
const PORT = job.port || process.env.PORT || 8000;
const AUTH_TOKEN = job.token || '';

// ---------------------------------------------------------------------
// Global environment the ported browser code expects to find.
// ---------------------------------------------------------------------
global.window = global;
global.document = {
  createElement: function (tag) {
    if (tag === 'canvas') return createCanvas(1, 1);
    throw new Error('document.createElement("' + tag + '") is not available in the worker - only "canvas" is stubbed.');
  }
};
global.requestAnimationFrame = function (cb) { setTimeout(cb, 0); };

global.pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
global.PDFLib = require('pdf-lib');
global.fontkit = require('@pdf-lib/fontkit');
global.JSZip = require('jszip');

// Amiri font (Arabic/RTL) - loaded from the same public CDN URLs the
// browser build uses, via fetch() below (defined before these are read).
// Amiri font (Arabic/RTL) - same URLs as the browser's own copies (see
// frontend/index.html's inline <script>, right before the engine-*.js
// files load).
global.AMIRI_FONT_URL = 'https://raw.githubusercontent.com/google/fonts/main/ofl/amiri/Amiri-Regular.ttf';
global.AMIRI_BOLD_FONT_URL = 'https://raw.githubusercontent.com/google/fonts/main/ofl/amiri/Amiri-Bold.ttf';
global.AMIRI_ITALIC_FONT_URL = 'https://raw.githubusercontent.com/google/fonts/main/ofl/amiri/Amiri-Italic.ttf';
global.AMIRI_BOLDITALIC_FONT_URL = 'https://raw.githubusercontent.com/google/fonts/main/ofl/amiri/Amiri-BoldItalic.ttf';

// fetch(): a relative "/api/..." path (exactly what every authFetch/fetch
// call inside the ported code uses, since in the browser these resolve
// against the current page's own origin) is rewritten to this same
// server's own localhost port; an absolute https:// URL (Amiri fonts,
// OpenRouter is itself only ever reached VIA this server's own proxy
// routes, never directly) passes through unchanged. Every call also
// carries this job's owner's own session token, exactly as the browser's
// authFetch would have - so the existing per-user auth on /api/data/...
// applies unchanged; the proxy routes ignore it since they don't require
// auth, so attaching it there too is harmless.
const nodeFetch = global.fetch;
global.fetch = function (url, opts) {
  opts = opts || {};
  const isRelative = typeof url === 'string' && url.startsWith('/');
  if (isRelative) {
    url = 'http://127.0.0.1:' + PORT + url;
    opts.headers = Object.assign({}, opts.headers, AUTH_TOKEN ? { Authorization: 'Bearer ' + AUTH_TOKEN } : {});
  }
  return nodeFetch(url, opts);
};

// log()/_log(): every ported function that reports progress calls this;
// wire it to append into job.json's own progress log, which server.py's
// status-poll route reads back for the browser's activity log.
global._log = function (msg) {
  try {
    console.log('[job ' + job.jobId + ']', msg);
    const current = readJob();
    const logLines = current.progressLog || [];
    logLines.push({ t: new Date().toISOString(), msg: String(msg) });
    writeJob({ progressLog: logLines });
  } catch (e) { /* logging must never crash the job */ }
};
global.log = function (msg, level) { global._log(msg); };

// ---------------------------------------------------------------------
// Load the ported source: extract each needed function's exact text
// from engine-translation.js and eval it into this process - the SAME
// technique used throughout this project's own test suite (see e.g.
// js/engine_split_test.js), so the worker is always running the exact
// same function bodies as the browser file, never a hand-copied
// duplicate that could drift out of sync.
// ---------------------------------------------------------------------
const ENGINE_SRC_PATH = path.join(__dirname, '..', '..', 'frontend', 'js', 'engine-translation.js');
const engineSrc = fs.readFileSync(ENGINE_SRC_PATH, 'utf-8');

function extractFn(name) {
  const re = new RegExp('(?:async )?function ' + name + '\\([^)]*\\)\\s*\\{');
  const m = engineSrc.match(re);
  if (!m) throw new Error('Could not find function "' + name + '" in engine-translation.js');
  let start = m.index;
  let i = engineSrc.indexOf('{', start);
  let depth = 1;
  i++;
  while (depth > 0) {
    if (engineSrc[i] === '{') depth++;
    else if (engineSrc[i] === '}') depth--;
    i++;
  }
  return engineSrc.slice(start, i);
}

function loadFn(name) {
  global.eval(extractFn(name));
}

// Module-level state the ported functions close over (mirrors the
// declarations at the top of engine-translation.js's own IIFE).
global._apiCalls = { json: 0, image: 0 };
global._authToken = AUTH_TOKEN;
global._abort = null;

// TRANSLATION_DOMAIN_EXPERTS is a const object, not a function - extract
// its declaration the same way but up to the matching closing brace of
// the object literal followed by the statement-ending semicolon.
(function loadDomainExperts() {
  const m = engineSrc.match(/const TRANSLATION_DOMAIN_EXPERTS = \{/);
  if (!m) throw new Error('Could not find TRANSLATION_DOMAIN_EXPERTS in engine-translation.js');
  let i = engineSrc.indexOf('{', m.index);
  let depth = 1;
  i++;
  while (depth > 0) {
    if (engineSrc[i] === '{') depth++;
    else if (engineSrc[i] === '}') depth--;
    i++;
  }
  global.eval('global.TRANSLATION_DOMAIN_EXPERTS = ' + engineSrc.slice(m.index + 'const TRANSLATION_DOMAIN_EXPERTS = '.length, i) + ';');
})();

// Core detection/region/DOCX-generation functions (same set the pdf.js
// translation pipeline has always used - see backend integration work).
[
  'makePositionId', 'extractFillRectsSimple', 'isNearWhite', 'rgbTripleToHex', 'pixelToHex',
  'sampleTextColorFromPixels', 'classifyFontBoldItalic', 'dominantFormat', 'hasVisibleText', 'groupItemsIntoLines',
  'scriptOf', 'scriptOfChar', 'classifyDirection', 'reconstructLogicalText', 'reconstructLogicalTextWithMarkup',
  'parseMarkupSpans', 'buildStyledSpansFromMarkup', 'escapeXml', 'docxMultiplyCtm', 'docxImageObjToPngBase64',
  'extractPageVectorsForDocx', 'docxModeColorInRect', 'buildDocxImageShapeXml', 'buildDocxRectShapeXml',
  'buildDocxTextShapeXml', 'estimateDocxTextHeight', 'computeAutoShrinkFontSize', 'docxAlignmentToJc',
  'computeFittedFontSizeRealSpans', 'computeFittedFontSizeReal', 'looksLikelyUntranslated',
  'insertListLineBreaksIntoText', 'docxRectsOverlap', 'detectLanguageSimple', 'detectAlignment',
  'detectGroupAlignment', 'boxesTouch', 'findRoot', 'unionRoots', 'computeGroupBounds', 'buildBlocks',
  'findContainingBounds', 'detectTableCells', 'tokenizeForWrap', 'wrapLogicalString',
  'richCharsFromTranslatedParagraphs', 'tokenizeForWrapRich', 'wrapLogicalStringRich',
  'wrapLogicalStringRichMultiWidth', 'richCharsLineToSpans', 'fitTextToBoxRich', 'hexToRgbTriple',
  'findGapSplits', 'buildRowSegments', 'computeOwnedTextItems', 'addBlueBoxesToRegion',
  'tokenizePdfContentStream', 'groupOperands', 'parseToUnicodeCMap', 'decodePdfStringBytes',
  'computeApToPageTransform', 'walkAppearanceStreamText', 'isLikelyAbbreviation', 'detectRepeatedPhrase',
  'parsePageRange', 'splitRegionIntoParagraphs',
].forEach(loadFn);
loadFn('extractTextItemsSimple');
loadFn('extractPageImagesForDocx');
loadFn('renderComplexPathCrop');
loadFn('extractAnnotationTextItems');
loadFn('buildDocxTextPlacements');
loadFn('buildTranslatedDocxV2');
loadFn('buildBasePdf');

// v14 translation chain (domain-expert glossary + reviewer agent) -
// the exact same shared call every other Lexora service already uses.
[
  '_visionFetch', 'v14CleanJsonResponse', 'v14RepairUnescapedQuotes', 'v14ProxyJson', 'v14VisionOnce', 'v14VisionCall',
  'v14FetchDynamicDomains', 'v14GenerateAndSaveDomainExpert', 'v14ClassifyTranslationDomain',
  'v14FetchTranslationRules', 'v14BuildTranslationPrompt', 'v14BuildReviewerPrompt',
  'v14SaveCodeIssues', 'v14SaveLearnedRules', 'v14ReflowTextIntoBlocks',
].forEach(loadFn);
loadFn('v14ReviewTranslation');
loadFn('v14TranslateAllPages');

// The orchestrator itself, unchanged.
loadFn('buildPdfjsTranslatedDocxBlob');

// ---------------------------------------------------------------------
// Run the job.
// ---------------------------------------------------------------------
async function main() {
  writeJob({ status: 'processing', startedAt: new Date().toISOString() });

  const fileBuf = fs.readFileSync(inputPath);
  const file = {
    arrayBuffer: async function () {
      return fileBuf.buffer.slice(fileBuf.byteOffset, fileBuf.byteOffset + fileBuf.byteLength);
    }
  };

  const blob = await buildPdfjsTranslatedDocxBlob(file, {
    model: job.model || 'google/gemini-2.5-flash',
    targetLang: job.targetLang || 'original'
  }, global._log);

  const outBuf = Buffer.from(await blob.arrayBuffer());
  fs.writeFileSync(outputPath, outBuf);
  writeJob({ status: 'done', finishedAt: new Date().toISOString(), outputBytes: outBuf.length });
}

main().catch(function (err) {
  console.error('[job ' + job.jobId + '] FAILED:', err);
  writeJob({ status: 'failed', finishedAt: new Date().toISOString(), error: String(err && err.message || err) });
  process.exit(1);
});
