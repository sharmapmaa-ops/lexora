// Isolated reproduction of the sectPr-emission logic from
// buildFlowingDocx() in js/translation-offline.js, extracted to verify
// the fix (exactly one closing <w:sectPr> for the whole document,
// regardless of what the last page's last flow item is) without
// needing the full browser/pdf.js/JSZip stack.

function sectPrXml(pg) { return '<w:pgSz.../>'; } // stub, content doesn't matter for this test

function buildBodyXml(pages) {
  let bodyXml = '';
  let lastPageSectPrWritten = false;

  pages.forEach(function (pg, pIdx) {
    const isLastPage = pIdx === pages.length - 1;
    const flow = pg.flow; // pre-built for this test: array of {kind, isLast}

    // FIXED: page break now driven ONLY by flow.length > 0, decoupled
    // from pg.pageBg - matches the real fix in translation-offline.js
    // (the pageBg-gated version never broke pages for plain-white
    // documents at all, which was the actual root cause of a whole
    // source PDF flowing as one unbroken stream).
    if (pIdx > 0 && flow.length > 0) {
      bodyXml += '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
    }

    flow.forEach(function (item, idx) {
      const isLastFlowItem = idx === flow.length - 1;
      if (item.kind === 'image') {
        bodyXml += '<IMG/>';
        if (isLastPage && isLastFlowItem) {
          bodyXml += '<w:p><w:pPr><w:sectPr>' + sectPrXml(pg) + '</w:sectPr></w:pPr></w:p>';
          lastPageSectPrWritten = true;
        }
        return;
      }
      if (item.kind === 'table') {
        bodyXml += '<TBL/>';
        bodyXml += '<w:p>' + (isLastPage && isLastFlowItem ? '<w:pPr><w:sectPr>' + sectPrXml(pg) + '</w:sectPr></w:pPr>' : '') + '</w:p>';
        if (isLastPage && isLastFlowItem) lastPageSectPrWritten = true;
        return;
      }
      const isLastParagraph = isLastPage && isLastFlowItem;
      bodyXml += '<w:p>' + (isLastParagraph ? '<w:pPr><w:sectPr>' + sectPrXml(pg) + '</w:sectPr></w:pPr>' : '') + '<TEXT/></w:p>';
      if (isLastParagraph) lastPageSectPrWritten = true;
    });

    if (flow.length === 0 && !isLastPage) {
      bodyXml += '<w:p><w:pPr><w:sectPr>' + sectPrXml(pg) + '</w:sectPr></w:pPr></w:p>';
    }
  });

  const trailingSectPr = lastPageSectPrWritten ? '' : '<w:sectPr>' + sectPrXml(pages[pages.length - 1]) + '</w:sectPr>';
  return bodyXml + trailingSectPr;
}

function countSectPr(xml) {
  return (xml.match(/<w:sectPr>/g) || []).length;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    console.log('FAIL: ' + label + ' - expected ' + expected + ', got ' + actual);
    process.exitCode = 1;
  } else {
    console.log('PASS: ' + label + ' (value = ' + actual + ')');
  }
}

// Case 1: matches the REAL reported bug shape - 3 pages, last page's
// flow ends in a paragraph (like the MARR signature block text).
const case1 = [
  { pageBg: true, flow: [{ kind: 'para' }] },
  { pageBg: true, flow: [{ kind: 'para' }] },
  { pageBg: true, flow: [{ kind: 'para' }, { kind: 'image' }, { kind: 'para' }] },
];
assertEqual(countSectPr(buildBodyXml(case1)), 1, 'Case 1: last item is a paragraph');

// Case 2: last page's flow ends in an image (e.g. a signature graphic
// is literally the last captured item on the page).
const case2 = [
  { pageBg: true, flow: [{ kind: 'para' }] },
  { pageBg: true, flow: [{ kind: 'para' }, { kind: 'image' }] },
];
assertEqual(countSectPr(buildBodyXml(case2)), 1, 'Case 2: last item is an image');

// Case 3: last page's flow ends in a table.
const case3 = [
  { pageBg: true, flow: [{ kind: 'para' }] },
  { pageBg: true, flow: [{ kind: 'table' }] },
];
assertEqual(countSectPr(buildBodyXml(case3)), 1, 'Case 3: last item is a table');

// Case 4: edge case - the very last page has a totally empty flow
// (e.g. all its content was captured as background only).
const case4 = [
  { pageBg: true, flow: [{ kind: 'para' }] },
  { pageBg: true, flow: [] },
];
assertEqual(countSectPr(buildBodyXml(case4)), 1, 'Case 4: last page flow is empty');

// Case 5: single page document.
const case5 = [
  { pageBg: false, flow: [{ kind: 'para' }] },
];
assertEqual(countSectPr(buildBodyXml(case5)), 1, 'Case 5: single-page document');

// Case 6: THE ACTUAL REPORTED SCENARIO - a plain-white document with NO
// background image on any page (pageBg: null everywhere, exactly what
// happens for a genuinely plain document like a legal contract with no
// letterhead). Confirms page breaks still fire (previously they did
// NOT, since the break was wrongly gated on pageBg - the real root
// cause of a 3-page source PDF flowing as one unbroken stream).
const case6 = [
  { pageBg: null, flow: [{ kind: 'para' }] },
  { pageBg: null, flow: [{ kind: 'para' }] },
  { pageBg: null, flow: [{ kind: 'para' }, { kind: 'image' }, { kind: 'para' }] },
];
const xml6 = buildBodyXml(case6);
const breakCount6 = (xml6.match(/w:br w:type="page"/g) || []).length;
assertEqual(breakCount6, 2, 'Case 6: plain document (no pageBg anywhere) still gets 2 page breaks for 3 pages');
assertEqual(countSectPr(xml6), 1, 'Case 6b: still exactly one sectPr');

console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
