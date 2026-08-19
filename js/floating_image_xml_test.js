// Directly executes the REAL floatingImageXml source (extracted verbatim
// from translation-offline.js, not reimplemented) and validates its
// output is well-formed XML - this function is pure string construction
// with no DOM/browser dependency, so it can run as-is in plain Node.
//
// Requires: npm install @xmldom/xmldom  (dev-only, for XML well-
// formedness validation - not a runtime dependency of the actual app).

const fs = require('fs');
const path = require('path');

// Pull the real function's exact source out of the real file, so this
// test can never silently drift from what's actually shipped.
const src = fs.readFileSync(path.join(__dirname, 'translation-offline.js'), 'utf8');
const startMarker = 'function floatingImageXml(relId, xPt, yPt, wPt, hPt, name) {';
const startIdx = src.indexOf(startMarker);
if (startIdx === -1) throw new Error('floatingImageXml not found in translation-offline.js');
// Find the matching closing brace by depth-counting from the function start.
let depth = 0, i = startIdx, endIdx = -1;
for (; i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (depth === 0) { endIdx = i + 1; break; } }
}
if (endIdx === -1) throw new Error('Could not find end of floatingImageXml');
const fnSrc = src.slice(startIdx, endIdx);

// Minimal shims for the two globals floatingImageXml depends on.
let drawId = 500;
const EMU = 12700; // 1pt = 12700 EMU, matches the real file's constant
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// eslint-disable-next-line no-eval
eval(fnSrc.replace('function floatingImageXml', 'var floatingImageXml = function'));

function assert(cond, label) { if (!cond) { console.log('FAIL:', label); process.exitCode = 1; } else console.log('PASS:', label); }

const xml = floatingImageXml('rIdTest1', 61.5, 700.2, 150.0, 45.0, 'SIG');

assert(typeof xml === 'string' && xml.length > 0, 'floatingImageXml returns a non-empty string');
assert(xml.includes('r:embed="rIdTest1"'), 'references the correct relationship ID');
assert(xml.includes('relativeFrom="page"'), 'horizontal position is page-relative');
assert(xml.includes('relativeFrom="paragraph"'), 'vertical position is paragraph-relative (multi-page correctness)');
assert(xml.includes('<pic:pic'), 'contains a real picture element, not a text box');
assert(!xml.includes('<w:t'), 'contains no text run (this is a picture, not a text box)');

// Validate well-formed XML by wrapping in a minimal valid document and
// parsing it - a real, structural check, not just substring matching.
const wrapped = '<?xml version="1.0"?><root xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' + xml + '</root>';

let parseOk = true, parseError = null;
try {
  const { DOMParser } = require('@xmldom/xmldom');
  const doc = new DOMParser({
    onError: (level, msg) => { if (level === 'error' || level === 'fatalError') throw new Error(msg); }
  }).parseFromString(wrapped, 'text/xml');
  parseOk = !!doc.documentElement;
} catch (e) {
  parseOk = false;
  parseError = e.message;
}
assert(parseOk, 'generated XML is well-formed (parses successfully)' + (parseError ? ' - ' + parseError : ''));

// Coordinate math: EMU conversion must be exact (this is what actually
// positions the signature - a wrong multiplier here silently mis-places
// or mis-sizes every embedded image).
const expectedX = Math.round(61.5 * EMU);
const expectedCy = Math.round(45.0 * EMU);
assert(xml.includes('<wp:posOffset>' + expectedX + '</wp:posOffset>'), 'x-position converts pt->EMU correctly (' + expectedX + ')');
assert(xml.includes('cy="' + expectedCy + '"'), 'height converts pt->EMU correctly (' + expectedCy + ')');

console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
