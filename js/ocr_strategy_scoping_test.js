// Structural scoping test for js/translation-offline.js.
//
// REAL BUG THIS CATCHES: _ocrPageBreakStrategy, applyPageHeightBudget,
// and buildWithFeedbackLoop were accidentally defined NESTED INSIDE
// buildFlowingDocx's function body, instead of as top-level sibling
// functions. buildFlowingDocx itself could call them fine (nested
// functions see their enclosing scope), so no test that only exercises
// logic in isolation (like flat_compaction_test.js) could ever catch
// this - but buildOfflineDocxBlob (a SEPARATE sibling function) also
// calls them directly for the Solution 8/9 branches, and nested
// functions are NOT visible to sibling functions in JS. That produced a
// real, reported runtime error: "_ocrPageBreakStrategy is not defined".
//
// This test parses the real file's brace nesting depth to confirm these
// functions sit at the SAME depth as buildFlowingDocx/buildDocx/
// buildOfflineDocxBlob (siblings), not one level deeper (nested inside
// one of them) - catching this class of scoping bug by construction,
// without needing to actually execute the browser-only file in Node.

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'translation-offline.js');
const src = fs.readFileSync(filePath, 'utf8');
const lines = src.split('\n');

function assert(cond, label) { if (!cond) { console.log('FAIL:', label); process.exitCode = 1; } else console.log('PASS:', label); }

// Track brace depth at the START of each line (before any braces on
// that line are counted) - crude but sufficient here since we only care
// about depth at known function-declaration lines, not full AST parsing.
// Ignores braces inside strings/comments/template literals imperfectly,
// but is accurate enough for this file's actual structure since we're
// only checking a handful of specific, known-unambiguous lines.
function depthAtLine(targetLineIdx) {
  let depth = 0;
  for (let i = 0; i < targetLineIdx; i++) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
  }
  return depth;
}

function findLineIndex(needle) {
  const idx = lines.findIndex((l) => l.includes(needle));
  if (idx === -1) throw new Error('Could not find: ' + needle);
  return idx;
}

const buildFlowingDocxLine = findLineIndex('function buildFlowingDocx(pages)');
const buildDocxLine = findLineIndex('function buildDocx(pages, includeBg, renderPageExtra)');
const buildOfflineDocxBlobLine = findLineIndex('async function buildOfflineDocxBlob(file, opts, logFn)');
const ocrStrategyLine = findLineIndex('function _ocrPageBreakStrategy()');
const applyBudgetLine = findLineIndex('function applyPageHeightBudget(pg)');
const feedbackLoopLine = findLineIndex('async function buildWithFeedbackLoop(');

const depthBuildFlowingDocx = depthAtLine(buildFlowingDocxLine);
const depthBuildDocx = depthAtLine(buildDocxLine);
const depthBuildOfflineDocxBlob = depthAtLine(buildOfflineDocxBlobLine);
const depthOcrStrategy = depthAtLine(ocrStrategyLine);
const depthApplyBudget = depthAtLine(applyBudgetLine);
const depthFeedbackLoop = depthAtLine(feedbackLoopLine);

assert(depthBuildFlowingDocx === depthBuildDocx, 'Sanity: buildFlowingDocx and buildDocx are siblings (same depth)');
assert(depthBuildFlowingDocx === depthBuildOfflineDocxBlob, 'Sanity: buildFlowingDocx and buildOfflineDocxBlob are siblings (same depth)');

assert(depthOcrStrategy === depthBuildFlowingDocx, '_ocrPageBreakStrategy is a TOP-LEVEL sibling, not nested inside buildFlowingDocx (depth ' + depthOcrStrategy + ' === ' + depthBuildFlowingDocx + ')');
assert(depthApplyBudget === depthBuildFlowingDocx, 'applyPageHeightBudget is a TOP-LEVEL sibling, not nested (depth ' + depthApplyBudget + ' === ' + depthBuildFlowingDocx + ')');
assert(depthFeedbackLoop === depthBuildFlowingDocx, 'buildWithFeedbackLoop is a TOP-LEVEL sibling, not nested (depth ' + depthFeedbackLoop + ' === ' + depthBuildFlowingDocx + ')');

// These three MUST be defined BEFORE buildOfflineDocxBlob is declared,
// since JS function declarations are hoisted within their own scope but
// this file also has some function EXPRESSIONS mixed in - defining them
// textually before first use avoids relying on hoisting semantics at all.
assert(ocrStrategyLine < buildOfflineDocxBlobLine, '_ocrPageBreakStrategy is defined before buildOfflineDocxBlob (textual order)');
assert(applyBudgetLine < buildOfflineDocxBlobLine, 'applyPageHeightBudget is defined before buildOfflineDocxBlob (textual order)');
assert(feedbackLoopLine < buildOfflineDocxBlobLine, 'buildWithFeedbackLoop is defined before buildOfflineDocxBlob (textual order)');

// And buildOfflineDocxBlob must actually reference them (confirms the
// call sites this bug affected are still present, not accidentally
// removed instead of fixed).
const buildOfflineDocxBlobSrc = lines.slice(buildOfflineDocxBlobLine).join('\n');
assert(buildOfflineDocxBlobSrc.includes('_ocrPageBreakStrategy()'), 'buildOfflineDocxBlob still calls _ocrPageBreakStrategy()');
assert(buildOfflineDocxBlobSrc.includes('buildWithFeedbackLoop('), 'buildOfflineDocxBlob still calls buildWithFeedbackLoop()');

console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
