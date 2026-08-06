/* translation-offline.js — Test.html offline mode ka EXACT verbatim logic
 * (pdf.js + JSZip, browser). window.buildOfflineDocxBlob(file, logFn) -> Blob */
(function () {
  'use strict';
  const EMU = 12700;
  const MIN_FONT_PT = 6;
  const FONT_FLOOR_RATIO = 0.55;
  let drawId = 100;
  let _measureCtx = null;
  let _log = function (m) { try { console.log(m); } catch (e) {} };
  function log(m, level) { _log(m, level || 'info'); }

  // Structured events for the Activity Log. The plain `log()` above is
  // free text meant for humans; app.js needs exact per-page numbers
  // (API calls made, text blocks found) to build its per-page log rows
  // and per-page billing, so those are emitted separately as objects.
  let _event = function () {};
  function setPipelineEventHandler(fn) { _event = (typeof fn === 'function') ? fn : function () {}; }
  function emit(ev) { try { _event(ev); } catch (e) {} }

  // API call counters. Incremented inside the single central fetch
  // wrapper so RETRIES are counted too (a page whose OCR JSON came back
  // malformed and got retried genuinely cost 2 calls, and the log/billing
  // should say so rather than assuming 1 per page).
  let _apiCalls = { json: 0, image: 0 };
  function resetApiCalls() { _apiCalls = { json: 0, image: 0 }; }
  function snapshotApiCalls() { return { json: _apiCalls.json, image: _apiCalls.image }; }

  // OPTION A: vision calls SERVER PROXY se jaati hain (/api/translation/
  // vision-proxy). Key browser me nahi aati — server .env se lagti hai.
  // Auth token app.js set karta hai (setVisionAuthToken).
  let _authToken = '';
  function setVisionAuthToken(t) { _authToken = t || ''; }

  // STOP support: app.js ek shouldStop() callback deta hai. Stop dabate hi
  // in-flight fetch abort ho jaati hai (paisa turant rukta hai) aur baaki
  // pages skip. Jitne pages ho chuke unka partial docx banta hai.
  let _shouldStop = function () { return false; };
  let _abort = null;
  function setStopCheck(fn) { _shouldStop = (typeof fn === 'function') ? fn : function () { return false; }; }
  function _newAbort() { _abort = (typeof AbortController !== 'undefined') ? new AbortController() : null; return _abort; }
  function abortVision() { try { if (_abort) _abort.abort(); } catch (e) {} }

  // WITH IMAGE (Option B): text-box regions ko page image se cv2 se hata kar
  // clean background wapas laata hai (server /inpaint-proxy). Fail ho to
  // original image hi use hoti hai (graceful).
  async function _inpaintFetch(imageBase64, boxes, texts) {
    const headers = { 'Content-Type': 'application/json' };
    if (_authToken) headers['Authorization'] = 'Bearer ' + _authToken;
    const init = { method: 'POST', headers: headers,
      body: JSON.stringify({ imageBase64: imageBase64, boxes: boxes, texts: texts || [] }) };
    if (_abort) init.signal = _abort.signal;
    return fetch('/api/translation/inpaint-proxy', init);
  }

  async function _visionFetch(reqBody) {
    const headers = { 'Content-Type': 'application/json' };
    if (_authToken) headers['Authorization'] = 'Bearer ' + _authToken;
    const init = { method: 'POST', headers: headers, body: JSON.stringify(reqBody) };
    if (_abort) init.signal = _abort.signal;
    return fetch('/api/translation/vision-proxy', init);
  }

  function esc(s){
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&apos;')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'');
  }

  function hasRTL(s){ return /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/.test(s); }

  function toHex(r,g,b){
    // components 0..1 or 0..255 dono handle
    if (r <= 1 && g <= 1 && b <= 1){ r*=255; g*=255; b*=255; }
    return [r,g,b].map(v => Math.max(0,Math.min(255,Math.round(v))).toString(16).padStart(2,'0')).join('').toUpperCase();
  }

  function measureTextPt(text, sizePt, family, bold, italic){
    if (!_measureCtx){
      const c = document.createElement('canvas');
      c.width = 8; c.height = 8;
      _measureCtx = c.getContext('2d');
    }
    _measureCtx.font = (italic ? 'italic ' : '') + (bold ? 'bold ' : '') +
      sizePt + 'px ' + (family || 'Arial') + ', Arial, sans-serif';
    return _measureCtx.measureText(String(text)).width; // 1 canvas px == 1 pt yahan
  }

  // SIRF overflow-fix: text box-width se bahar ja raha ho to font
  // proportionally chhota karo (floor 5pt). Position/box size same rehta hai.
  // FIT-TO-BOX (user idea): box ki height/width almost sahi nikli hui hai.
  // Minimum font (5pt) se shuru karke font BADHAO jab tak text box ki width
  // YA height se overflow na ho — box ko maximum bharo. Ye shrinkOverflow se
  // ulta hai (jo original font se ghatata tha); ye har box ko best-fit deta
  // hai. Font ka original vision-size upper cap rehta hai (usse bada nahi).
  function shrinkOverflow(lines){
    lines.forEach(function(L){
      if (!L.runs || !L.runs.length) return;
      var t = L.runs.map(function(r){ return r.text || ''; }).join('');
      if (!t.trim() || !(L.wPt > 0) || !(L.hPt > 0)) return;
      var r0 = L.runs[0] || {};
      var fam = r0.family || 'Arial', bold = !!r0.bold, italic = !!r0.italic;
      // upper cap = vision-reported font (usse bada text box me nahi ghusana)
      var cap = Math.max.apply(null, L.runs.map(function(r){ return r.sizePt || 11; }));
      cap = Math.min(cap, L.hPt * 1.15);          // height se bada font pointless
      var MIN = 5;
      // best size dhundo: sabse bada size jispe width AND height fit ho
      var best = MIN;
      for (var sz = MIN; sz <= cap; sz += 0.5){
        var w = measureTextPt(t, sz, fam, bold, italic);
        var fitsW = w <= L.wPt;
        var fitsH = sz <= L.hPt * 1.05;           // single line height check
        if (fitsW && fitsH) best = sz; else break;
      }
      // sab runs ko best size par set karo (proportion preserve: agar runs
      // ke alag sizes the to sabse bade ko best, baaki ko usi ratio me)
      if (best !== cap){
        var ratio = best / cap;
        L.runs.forEach(function(r){
          r.sizePt = Math.max(MIN, Math.min(cap, (r.sizePt || 11) * ratio));
        });
      }
    });
  }

  function autofitPage(lines, pageW, pageH, pageNo){
    let shrunk = 0, wrapped = 0, moved = 0, clamped = 0;

    // ---- 1. per-box overflow fit ----
    lines.forEach(function(L){
      const r = L.runs[0];
      if (!r || !r.text) return;
      const fs0 = r.sizePt || 11;
      const floor = Math.max(MIN_FONT_PT, fs0 * FONT_FLOOR_RATIO);
      const w = measureTextPt(r.text, fs0, r.family, r.bold, r.italic);
      if (w > L.wPt * 1.02){
        const fit = fs0 * (L.wPt / w);
        if (fit >= floor){
          r.sizePt = Math.max(MIN_FONT_PT, Math.floor(fit * 10) / 10);
          shrunk++;
        } else {
          // itna lamba (translated) text — floor font par wrap + height grow
          r.sizePt = Math.floor(floor * 10) / 10;
          const wf = measureTextPt(r.text, r.sizePt, r.family, r.bold, r.italic);
          const nLines = Math.max(2, Math.ceil(wf / Math.max(1, L.wPt)));
          L.wrapMulti = true;
          L.hPt = Math.max(L.hPt, nLines * r.sizePt * 1.22);
          wrapped++;
        }
      }
      // box height font se chhota ho to text clip hota hai — uthao
      if (!L.wrapMulti && L.hPt < r.sizePt * 1.05) L.hPt = r.sizePt * 1.15;
    });

    // ---- 2. page-bounds clamp ----
    lines.forEach(function(L){
      const r = L.runs[0];
      if (L.xPt < 0){ L.xPt = 0; clamped++; }
      if (L.yPt < 0){ L.yPt = 0; clamped++; }
      if (L.xPt + L.wPt > pageW){
        const over = L.xPt + L.wPt - pageW;
        if (over <= L.wPt * 0.15 && L.xPt - over >= 0){
          L.xPt -= over;                                  // halka shift kaafi hai
        } else if (r){
          const avail = Math.max(8, pageW - L.xPt);
          const w = measureTextPt(r.text, r.sizePt, r.family, r.bold, r.italic);
          if (w > avail) r.sizePt = Math.max(MIN_FONT_PT, r.sizePt * avail / w);
          L.wPt = avail;
        }
        clamped++;
      }
      if (L.yPt + L.hPt > pageH){ L.yPt = Math.max(0, pageH - L.hPt); clamped++; }
    });

    // ---- 3. collision resolution (top→bottom cascade, max 3 passes) ----
    const sorted = lines.slice().sort(function(a, b){ return a.yPt - b.yPt || a.xPt - b.xPt; });
    for (let pass = 0; pass < 3; pass++){
      let any = false;
      for (let i = 0; i < sorted.length; i++){
        const A = sorted[i];
        for (let j = i + 1; j < sorted.length; j++){
          const B = sorted[j];
          if (B.yPt >= A.yPt + A.hPt) break;              // yPt-sorted → aage sab neeche
          const hx = Math.min(A.xPt + A.wPt, B.xPt + B.wPt) - Math.max(A.xPt, B.xPt);
          if (hx <= Math.min(A.wPt, B.wPt) * 0.3) continue; // side-by-side columns — theek
          const overlap = (A.yPt + A.hPt) - B.yPt;
          if (overlap <= Math.min(A.hPt, B.hPt) * 0.18) continue; // chhota OCR jitter — visually ok
          const shift = overlap + 0.5;
          if (A.wrapMulti || shift <= B.hPt * 0.9){
            // A wrap se grow hua ho to poora cascade-shift hi sahi hai;
            // warna chhota shift (<= 0.9x line height) layout ko disturb nahi karta
            B.yPt += shift; moved++; any = true;
          } else {
            // native OCR bbox slop: A ki box B ke shuru tak trim karo agar
            // A ka font phir bhi fit rehta hai — position bilkul nahi hilti
            const trimmed = B.yPt - A.yPt - 0.5;
            if (trimmed >= (A.runs[0] ? A.runs[0].sizePt * 1.05 : 8)){
              A.hPt = trimmed; shrunk++; any = true;
            } else if (B.runs[0]){
              B.runs[0].sizePt = Math.max(MIN_FONT_PT, B.runs[0].sizePt * 0.9);
              B.hPt = Math.max(B.runs[0].sizePt * 1.15, 6);
              B.yPt = A.yPt + A.hPt + 0.5;                // resolve guaranteed
              moved++; any = true;
            }
          }
        }
      }
      if (!any) break;
      sorted.sort(function(a, b){ return a.yPt - b.yPt || a.xPt - b.xPt; });
    }

    // ---- 4. reading order (anchor emit order = logical flow) ----
    const rtlPage = lines.filter(function(L){ return L.rtl; }).length > lines.length / 2;
    lines.sort(function(a, b){
      const ay = a.yPt + a.hPt / 2, by = b.yPt + b.hPt / 2;
      if (Math.abs(ay - by) > Math.min(a.hPt, b.hPt) * 0.6) return ay - by;
      return rtlPage ? (b.xPt - a.xPt) : (a.xPt - b.xPt);
    });

    if (shrunk || wrapped || moved || clamped){
      log('P' + pageNo + ' layout-fit: ' + shrunk + ' font-scaled, ' + wrapped + ' wrapped, ' +
        moved + ' repositioned, ' + clamped + ' page-clamped', 'info');
    }
  }

  function textBoxXml(line){
    drawId++;
    const x  = Math.max(0, Math.round(line.xPt * EMU));
    const y  = Math.max(0, Math.round(line.yPt * EMU));
    const cx = Math.max(1, Math.round(line.wPt * EMU));
    const cy = Math.max(1, Math.round(line.hPt * EMU));
    const lineTw = Math.max(20, Math.round(line.hPt * 20)); // exact line height (twips)

    const order = line.rtl ? line.runs.slice().reverse() : line.runs;
    const runsXml = order.map(function(r){
      const sz  = Math.max(2, Math.round((r.sizePt || 11) * 2)); // half-points, fractional preserved
      const col = /^[0-9A-F]{6}$/i.test(r.color || '') ? r.color.toUpperCase() : '000000';
      const fam = esc(r.family || 'Arial');
      return '<w:r><w:rPr>' +
        '<w:rFonts w:ascii="' + fam + '" w:hAnsi="' + fam + '" w:cs="' + fam + '"/>' +
        (r.bold ? '<w:b/><w:bCs/>' : '') +
        (r.italic ? '<w:i/><w:iCs/>' : '') +
        '<w:color w:val="' + col + '"/>' +
        '<w:sz w:val="' + sz + '"/><w:szCs w:val="' + sz + '"/>' +
        (line.rtl ? '<w:rtl/>' : '') +
        '</w:rPr><w:t xml:space="preserve">' + esc(r.text) + '</w:t></w:r>';
    }).join('');

    return '<w:r><w:drawing>' +
      '<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="' + drawId +
      '" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">' +
      '<wp:simplePos x="0" y="0"/>' +
      '<wp:positionH relativeFrom="page"><wp:posOffset>' + x + '</wp:posOffset></wp:positionH>' +
      '<wp:positionV relativeFrom="paragraph"><wp:posOffset>' + y + '</wp:posOffset></wp:positionV>' +
      '<wp:extent cx="' + cx + '" cy="' + cy + '"/>' +
      '<wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>' +
      '<wp:docPr id="' + drawId + '" name="L' + drawId + '"/><wp:cNvGraphicFramePr/>' +
      '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
      '<a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
      '<wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr>' +
      '<a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>' +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln>' +
      '</wps:spPr><wps:txbx><w:txbxContent>' +
      '<w:p><w:pPr>' +
      '<w:spacing w:before="0" w:after="0" w:line="' + lineTw + '" w:lineRule="exact"/>' +
      (line.rtl ? '<w:bidi/>' : '') +
      '<w:jc w:val="both"/></w:pPr>' + runsXml + '</w:p>' +
      '</w:txbxContent></wps:txbx>' +
      // wrap="none": text apni width se wrap NAHI hoga, box size exact rahega
      '<wps:bodyPr rot="0" vert="horz" wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t"><a:noAutofit/></wps:bodyPr>' +
      '</wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>';
  }

  function bgImageXml(relId, wPt, hPt){
    drawId++;
    const cx = Math.round(wPt * EMU), cy = Math.round(hPt * EMU);
    return '<w:r><w:drawing>' +
      '<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="1" behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1">' +
      '<wp:simplePos x="0" y="0"/>' +
      '<wp:positionH relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionH>' +
      '<wp:positionV relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionV>' +
      '<wp:extent cx="' + cx + '" cy="' + cy + '"/>' +
      '<wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>' +
      '<wp:docPr id="' + drawId + '" name="BG' + drawId + '"/><wp:cNvGraphicFramePr/>' +
      '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
      '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<pic:nvPicPr><pic:cNvPr id="' + drawId + '" name="bg.jpg"/><pic:cNvPicPr/></pic:nvPicPr>' +
      '<pic:blipFill><a:blip r:embed="' + relId + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
      '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>' +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
      '</pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>';
  }

  function buildDocx(pages, includeBg){
    const zip = new JSZip();
    const wPt = pages[0].wPt, hPt = pages[0].hPt;
    const pgW = Math.round(wPt * 20), pgH = Math.round(hPt * 20);

    let bodyXml = '';
    const rels = [];
    // MULTI-PAGE FIX: har page = apna paragraph + apna page-sized section.
    // positionV paragraph-relative hai, isliye har page ke boxes us page ke
    // paragraph se position lete hain — warna page 2 ke boxes page 1 par
    // overlap/shift ho jaate the (page 1 blank dikhta tha).
    function sectPrXml(pg){
      const w = Math.round(pg.wPt * 20), h = Math.round(pg.hPt * 20);
      return '<w:pgSz w:w="' + w + '" w:h="' + h + '"/>' +
        '<w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" w:header="0" w:footer="0" w:gutter="0"/>';
    }
    pages.forEach(function(pg, i){
      let runs = '';
      if (includeBg && pg.jpegBase64){
        const relId = 'rIdImg' + (i + 1);
        rels.push({ id: relId, file: 'media/page' + (i + 1) + '.jpg', data: pg.jpegBase64 });
        runs += bgImageXml(relId, pg.wPt, pg.hPt);
      }
      pg.lines.forEach(function(L){
        if (L.runs.some(r => r.text && r.text.trim())) runs += textBoxXml(L);
      });
      if (i < pages.length - 1){
        bodyXml += '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="' +
          Math.round(pg.hPt * 20) + '" w:lineRule="exact"/>' +
          '<w:sectPr>' + sectPrXml(pg) + '<w:type w:val="nextPage"/></w:sectPr>' +
          '</w:pPr>' + runs + '</w:p>';
      } else {
        bodyXml += '<w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr>' + runs + '</w:p>';
      }
    });

    const documentXml =
'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" ' +
'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" ' +
'xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" ' +
'mc:Ignorable="w14 wp14">' +
'<w:body>' + bodyXml +
'<w:sectPr>' + sectPrXml(pages[pages.length - 1]) + '</w:sectPr></w:body></w:document>';

    let relsXml =
'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
'<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>';
    rels.forEach(function(r){
      relsXml += '<Relationship Id="' + r.id + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="' + r.file + '"/>';
    });
    relsXml += '</Relationships>';

    zip.file('[Content_Types].xml',
'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
'<Default Extension="xml" ContentType="application/xml"/>' +
'<Default Extension="jpg" ContentType="image/jpeg"/>' +
'<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
'<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
'</Types>');

    zip.file('_rels/.rels',
'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
'</Relationships>');

    zip.file('word/styles.xml',
'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
'<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
'<w:docDefaults><w:rPrDefault><w:rPr>' +
'<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="22"/><w:szCs w:val="22"/>' +
'</w:rPr></w:rPrDefault></w:docDefaults></w:styles>');

    zip.file('word/document.xml', documentXml);
    zip.file('word/_rels/document.xml.rels', relsXml);
    rels.forEach(function(r){ zip.file('word/' + r.file, r.data, { base64: true }); });

    return zip.generateAsync({ type: 'blob',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  }

  async function extractColors(page){
    const F = pdfjsLib.OPS;
    const ops = await page.getOperatorList();
    const out = [];
    let cur = '000000';
    for (let i = 0; i < ops.fnArray.length; i++){
      const fn = ops.fnArray[i], args = ops.argsArray[i] || [];
      if (fn === F.setFillRGBColor && args.length >= 3){
        cur = toHex(args[0], args[1], args[2]);
      } else if (fn === F.setFillGray && args.length >= 1){
        cur = toHex(args[0], args[0], args[0]);
      } else if (fn === F.setFillCMYKColor && args.length >= 4){
        const c=args[0],m=args[1],y=args[2],k=args[3];
        cur = toHex((1-c)*(1-k),(1-m)*(1-k),(1-y)*(1-k));
      } else if (fn === F.showText || fn === F.showSpacedText ||
                 fn === F.nextLineShowText || fn === F.nextLineSetSpacingShowText){
        out.push(cur);
      }
    }
    return out;
  }

  async function resolveFonts(page, items){
    const map = {};
    const names = [...new Set(items.map(i => i.fontName))];
    for (const n of names){
      let info = { bold: false, italic: false, family: null };
      try {
        const f = await new Promise(function(res){
          try { page.commonObjs.get(n, res); } catch(e){ res(null); }
          setTimeout(() => res(null), 300);
        });
        if (f && f.name){
          let ps = f.name.replace(/^[A-Z]{6}\+/, ''); // subset prefix hatao
          info.bold = /bold|black|heavy/i.test(ps);
          info.italic = /italic|oblique/i.test(ps);
          info.family = ps.split(/[-,]/)[0].replace(/(MT|PS|Std|Pro)$/,'').trim();
        }
      } catch(e){}
      map[n] = info;
    }
    return map;
  }

  function genericFamily(cssFamily){
    if (!cssFamily) return 'Arial';
    if (/serif/i.test(cssFamily) && !/sans/i.test(cssFamily)) return 'Times New Roman';
    if (/mono/i.test(cssFamily)) return 'Courier New';
    return 'Arial';
  }

  async function extractOfflinePage(page, vp1, pageNo){
    const tc = await page.getTextContent();
    let colors = [];
    try { colors = await extractColors(page); } catch(e){ log('P' + pageNo + ' color extract fail: ' + e.message, 'warn'); }
    const colorOk = colors.length === tc.items.length;
    if (!colorOk && colors.length) log('P' + pageNo + ': color count mismatch (' + colors.length + ' vs ' + tc.items.length + '), default black', 'warn');

    const fontMap = await resolveFonts(page, tc.items);
    const pageH = vp1.height;

    // Har text item → run with exact metrics
    const runs = [];
    tc.items.forEach(function(it, idx){
      if (!it.str || !it.str.trim()) return;
      const tr = it.transform;
      const fontH = Math.hypot(tr[2], tr[3]) || Math.abs(tr[3]) || 10; // exact font size (pt)
      const st = tc.styles[it.fontName] || {};
      const fi = fontMap[it.fontName] || {};
      runs.push({
        text: it.str,
        x: tr[4],
        yBase: tr[5],                                  // baseline (PDF coords, bottom-origin)
        w: it.width || (it.str.length * fontH * 0.5),
        sizePt: fontH,
        ascent: (typeof st.ascent === 'number' && st.ascent > 0) ? st.ascent : 0.85,
        descent: (typeof st.descent === 'number') ? Math.abs(st.descent) : 0.2,
        bold: !!fi.bold,
        italic: !!fi.italic,
        family: fi.family || genericFamily(st.fontFamily),
        color: colorOk ? (colors[idx] || '000000') : '000000'
      });
    });

    // ---- Line grouping: same baseline ke runs ek line ----
    runs.sort(function(a,b){ return (b.yBase - a.yBase) || (a.x - b.x); });
    const rows = [];
    runs.forEach(function(r){
      const row = rows.find(function(R){ return Math.abs(R.yBase - r.yBase) < Math.max(2, r.sizePt * 0.4); });
      if (row){ row.items.push(r); row.yBase = (row.yBase + r.yBase) / 2; }
      else rows.push({ yBase: r.yBase, items: [r] });
    });

    // ---- Har row ko horizontal gaps par split (table columns alag boxes) ----
    const lines = [];
    rows.forEach(function(R){
      R.items.sort(function(a,b){ return a.x - b.x; });
      let seg = [R.items[0]];
      for (let i = 1; i < R.items.length; i++){
        const prev = seg[seg.length - 1], cur = R.items[i];
        const gap = cur.x - (prev.x + prev.w);
        if (gap > Math.max(prev.sizePt, cur.sizePt) * 1.5){
          lines.push(makeLine(seg, pageH)); seg = [cur];
        } else {
          // agar visible gap hai par space missing, ek space daal do
          if (gap > Math.max(prev.sizePt, cur.sizePt) * 0.15 && !/\s$/.test(prev.text) && !/^\s/.test(cur.text)){
            prev.text += ' ';
          }
          seg.push(cur);
        }
      }
      lines.push(makeLine(seg, pageH));
    });
    return lines;
  }

  function makeLine(seg, pageH){
    const x0 = Math.min.apply(null, seg.map(r => r.x));
    const x1 = Math.max.apply(null, seg.map(r => r.x + r.w));
    const maxAsc  = Math.max.apply(null, seg.map(r => r.ascent  * r.sizePt));
    const maxDesc = Math.max.apply(null, seg.map(r => r.descent * r.sizePt));
    const yBase = seg[0].yBase;
    const rtl = seg.some(r => hasRTL(r.text));
    return {
      xPt: x0,
      yPt: pageH - yBase - maxAsc,      // top-left, exact — koi shift nahi
      wPt: x1 - x0,                      // sirf sentence jitni width
      hPt: maxAsc + maxDesc,             // sabse bade text ki height
      rtl: rtl,
      runs: seg.map(function(r){
        return { text: r.text, sizePt: r.sizePt, bold: r.bold, italic: r.italic, color: r.color, family: r.family };
      })
    };
  }

  async function buildOfflineDocxBlob(file, opts, logFn) {
    if (typeof logFn === 'function') _log = logFn;
    opts = opts || {};
    // Image is always kept behind the text now, and text-based mode
    // always cleans it via deterministic local paint (we have the exact
    // text positions from the PDF text layer - no AI needed, no checkbox).
    const withImage = true;
    const cleanImage = true;
    const model = opts.model || (window.COMPANY_INFO && window.COMPANY_INFO.textExtractionModel) || 'google/gemini-2.5-flash';
    const targetLang = opts.targetLang || 'original';
    const keepOriginal = !targetLang || String(targetLang).toLowerCase() === 'original';
    if (typeof pdfjsLib === 'undefined') throw new Error('pdf.js failed to load');
    if (typeof JSZip === 'undefined') throw new Error('JSZip failed to load');
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    let sampleItems = 0;
    for (let sp = 1; sp <= Math.min(2, pdf.numPages); sp++) {
      const tc0 = await (await pdf.getPage(sp)).getTextContent();
      sampleItems += tc0.items.filter(function (it) { return it.str && it.str.trim(); }).length;
    }
    if (sampleItems < 3)
      throw new Error('This PDF looks scanned/image-based — text-based mode only processes text-based PDFs. Enable With OCR and retry.');
    const pages = [];
    let totalLines = 0;
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const vp1 = page.getViewport({ scale: 1 });
      let lines = await extractOfflinePage(page, vp1, p);
      if (lines.length) autofitPage(lines, vp1.width, vp1.height, p);
      totalLines += lines.length;

      // WITH IMAGE (client-side render): text-layer extraction above used
      // the raw page at scale 1 (points) for exact coordinate math; this
      // is a separate, higher-pixel-scale render of the SAME page purely
      // for a crisp-looking background.
      let jpegBase64 = null;
      if (withImage) {
        const bgScale = Math.min(3.0, 2000 / Math.max(vp1.width, vp1.height));
        const bgVp = page.getViewport({ scale: bgScale });
        const bgCanvas = document.createElement('canvas');
        bgCanvas.width = Math.round(bgVp.width);
        bgCanvas.height = Math.round(bgVp.height);
        await page.render({ canvasContext: bgCanvas.getContext('2d'), viewport: bgVp }).promise;

        // CLEAN IMAGE (text-based mode): DETERMINISTIC, not AI-based.
        // Text-based mode already knows the EXACT position of every line
        // of text - straight from the real PDF text layer, that's what
        // `lines` already is - so instead of asking an image model to
        // visually guess where the text is and remove it, we just paint
        // over each known line's exact box with white directly. This is
        // 100% reliable, instant, and free. (An AI-based clean-image call
        // was tried here first, but on dense legal-text pages - which is
        // the overwhelming majority of what text-based mode processes -
        // it failed in testing: sometimes it returned the image completely
        // unchanged, and sometimes it regenerated a different-looking
        // image that still had every word of the original text intact.
        // A page that's almost entirely body text has no real
        // "background" for an image model to fall back to, but we don't
        // need to guess at all since we already have the ground truth.)
        if (cleanImage) {
          const cctx = bgCanvas.getContext('2d');
          cctx.fillStyle = '#ffffff';
          const pad = 1;   // small padding so anti-aliased glyph edges don't peek out
          lines.forEach(function (L) {
            cctx.fillRect(L.xPt * bgScale - pad, L.yPt * bgScale - pad,
              L.wPt * bgScale + pad * 2, L.hPt * bgScale + pad * 2);
          });
          log('P' + p + ': background image cleaned (' + lines.length + ' text region(s) painted over)');
        }
        jpegBase64 = bgCanvas.toDataURL('image/jpeg', 0.92).split(',')[1];
      }

      pages.push({ lines: lines, wPt: vp1.width, hPt: vp1.height, jpegBase64: jpegBase64 });
      log('P' + p + ': ' + lines.length + ' text line(s) extracted (no API)' + (withImage ? ' + page image rendered' : ''));
      // Text-based extraction is fully local, so this page cost 0 API
      // calls - but it still reports its text count and still gets its
      // own Activity Log rows and per-page charge.
      emit({
        type: 'page',
        page: p,
        totalPages: pdf.numPages,
        jsonCalls: 0,
        imageCalls: 0,
        textData: lines.length,
        ok: true
      });
    }
    if (totalLines === 0)
      throw new Error('No selectable text found in this PDF — offline mode only processes text-based PDFs');

    // TRANSLATION: the other exception to "no API call" in text-based
    // mode. Each extracted LINE is translated as its own independent
    // unit (no cross-line paragraph joining - unlike the OCR/Hybrid
    // pipeline, plain text-layer extraction has no paragraph grouping
    // to join on), reusing the same whole-document translate call as
    // the OCR pipeline for consistent tone/terminology handling.
    if (!keepOriginal) {
      let counter = 0;
      const flatLines = [];
      pages.forEach(function (pg, pIdx) {
        pg.lines.forEach(function (L, lIdx) {
          const fullText = L.runs.map(function (r) { return r.text; }).join(' ').trim();
          if (!fullText) return;
          const id = 'off_p' + (pIdx + 1) + '_l' + lIdx;
          L._translateId = id;
          counter++;
          flatLines.push({
            id: id,
            page: pIdx + 1,
            paragraph_id: id,   // each line translated independently
            reading_order: counter,
            text: fullText,
            width: L.wPt,
            language: 'unknown',
            direction: L.rtl ? 'rtl' : 'ltr'
          });
        });
      });

      if (flatLines.length > 0) {
        const updBefore = snapshotApiCalls();
        try {
          log('Translating extracted text to ' + targetLang + '...');
          const translationResult = await v14TranslateAllPages(model, flatLines, targetLang);
          const map = {};
          (translationResult.translations || []).forEach(function (t) {
            if (t && t.id && typeof t.translated_text === 'string' && t.translated_text.trim()) {
              map[t.id] = t.translated_text.trim();
            }
          });
          let replaced = 0;
          pages.forEach(function (pg) {
            pg.lines.forEach(function (L) {
              if (L._translateId && map[L._translateId] !== undefined && L.runs.length > 0) {
                // Whole translated line goes into the first run (keeps
                // its original styling); other runs on the same line are
                // cleared so the line doesn't show the original text
                // twice - geometry (position/size) stays as extracted.
                L.runs[0] = Object.assign({}, L.runs[0], { text: map[L._translateId] });
                for (let k = 1; k < L.runs.length; k++) {
                  L.runs[k] = Object.assign({}, L.runs[k], { text: '' });
                }
                replaced++;
              }
            });
          });
          log('Translation: ' + replaced + ' line(s) translated');
        } catch (translateErr) {
          log('Translation failed (' + translateErr.message + ') — keeping the original extracted text', 'warn');
        }
        const updAfter = snapshotApiCalls();
        emit({
          type: 'update',
          jsonCalls: updAfter.json - updBefore.json,
          imageCalls: updAfter.image - updBefore.image,
          textData: flatLines.length
        });
      }
    }

    return buildDocx(pages, withImage);
  }


  // ===================================================================
  //  HYBRID (with API) — VISION OCR path, Test.html se verbatim.
  //  Line-level blocks (Box-tool jaisa), single vision call = fast.
  //  Ensemble/High-Accuracy jaan-boojh kar NAHI (wo slow karte hain).
  // ===================================================================

  async function mapWithConcurrency(items, limit, worker, onProgress){
    const results = new Array(items.length);
    let next = 0, done = 0;
    async function run(){
      while (next < items.length){
        const i = next++;
        results[i] = await worker(items[i], i);
        done++;
        if (onProgress) onProgress(done, items.length);
      }
    }
    const pool = [];
    for (let w = 0; w < Math.min(limit, items.length); w++) pool.push(run());
    await Promise.all(pool);
    return results;
  }

  async function extractApiPage(apiKey, model, dataUrl, wPt, hPt, pageNo){
    const prompt =
`You are a precise OCR and layout extraction engine. Analyze this document page image (page size: ${Math.round(wPt)} x ${Math.round(hPt)} points).

Return ONLY valid JSON, no markdown fences, no explanation:
{"page_type":"...","lines":[{"text":"...","x":0,"y":0,"w":0,"h":0,"font_size_pt":11,"bold":false,"italic":false,"color":"000000"}]}

STRICT RULES:
- Each VISUAL LINE of text = one separate entry. NEVER merge multiple lines into one entry. NEVER use \\n inside text.
- If one visual row contains separate columns/cells with a big horizontal gap, output each column segment as its own entry.
- x, y = top-left corner of THAT LINE's text, normalized 0-1000 relative to page width/height.
- w = tight width of exactly that line's text, nothing more. h = height of the tallest character in that line (cap height to descender), nothing more. NO padding.
- font_size_pt = real font size estimate in points (page is ${Math.round(hPt)} pt tall). Keep it consistent for identically-sized text.
- OCR text EXACTLY in original language and script. Do NOT translate. Do NOT normalize.
- color = 6-digit hex of the text color, no #.
- Include ALL text: headers, footers, stamps, table cells, page numbers.
- page_type = ONE short free-text sentence describing THIS page from its visible content: what kind of document page it is, its subject domain, language(s)/script, and register/formality. Do not pick from a fixed list — describe what you actually see. (This only guides translation tone; it does not change the OCR.)`;

    const body = {
      model: model, temperature: 0, max_tokens: 16000,
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: dataUrl } }
      ]}]
    };

    for (let attempt = 1; attempt <= 2; attempt++){
      let resp;
      try { resp = await _visionFetch(body); }
      catch (netErr) { if (_shouldStop()) throw new Error('stopped'); throw netErr; }
      if (!resp.ok){
        const t = await resp.text();
        throw new Error('OpenRouter HTTP ' + resp.status + ': ' + t.slice(0, 300));
      }
      const data = await resp.json();
      let raw = (data.choices && data.choices[0] && data.choices[0].message.content) || '';
      raw = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
      const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
      if (a !== -1 && b > a) raw = raw.slice(a, b + 1);
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch (pe) {
        // SALVAGE: poora JSON toota (truncated/malformed) — individual line
        // objects regex se nikaal lo, taaki ek galat line se poori page na
        // jaye. Ye tumhare "JSON error -> sentence hat jaata -> page missing"
        // issue ka fix hai.
        const objs = raw.match(/\{[^{}]*"text"[^{}]*\}/g);
        if (objs && objs.length){
          const salvaged = [];
          objs.forEach(function(o){
            try { salvaged.push(JSON.parse(o)); } catch (e2) {}
          });
          if (salvaged.length){
            parsed = { lines: salvaged };
            log('P' + pageNo + ': JSON partial tha — ' + salvaged.length + ' line(s) salvage ki (page nahi giri)', 'warn');
          }
        }
        if (!parsed) throw pe;
      }
      try {
        const arr = parsed.lines || parsed.blocks;
        if (!Array.isArray(arr)) throw new Error('no lines array');
        // normalized 0-1000 → absolute points, same line struct
        const out = arr.filter(L => L && L.text && String(L.text).trim()).map(function(L){
          const fs = Math.max(4, Math.min(96, Number(L.font_size_pt) || 11));
          return {
            xPt: (L.x / 1000) * wPt,
            yPt: (L.y / 1000) * hPt,
            wPt: Math.max(fs * 0.5, (L.w / 1000) * wPt),
            hPt: Math.max(fs, (L.h / 1000) * hPt),
            rtl: hasRTL(L.text),
            runs: [{
              text: String(L.text).replace(/\n/g, ' '),
              sizePt: fs,
              bold: !!L.bold, italic: !!L.italic,
              color: /^[0-9a-fA-F]{6}$/.test(L.color || '') ? L.color : '000000',
              family: 'Arial'
            }]
          };
        });
        // page_type sirf translation tone ke liye — box rendering untouched
        out.pageType = (typeof parsed.page_type === 'string') ? parsed.page_type.slice(0, 160) : '';
        if (out.pageType) log('P' + pageNo + ' type: ' + out.pageType);
        return out;
      } catch (e){
        if (_shouldStop()) throw new Error('stopped');
        log('Page ' + pageNo + ' parse fail (attempt ' + attempt + '): ' + e.message, 'warn');
        if (attempt === 2) throw new Error('Page ' + pageNo + ': malformed JSON twice');
      }
    }
  }

  // Hybrid deliverable: har page ka image vision model ko bhejo, line-level
  // blocks lo, wahi makeLine-style boxes + optional background image se docx.
  // keepOriginal=true => sirf OCR (koi translation); warna translate bhi.
  // ====================================================================
  // HYBRID v14 — pdf_to_word_v14_translation.html ka EXACT pipeline.
  // (Without-Hybrid / buildOfflineDocxBlob bilkul untouched hai.)
  // Flow (HTML tool jaisa hi):
  //   1) pdf.js render (scale 2.0, PNG)
  //   2) [optional, Clean Image checked] image-output model se background
  //      ka saara text remove (CLEAN_IMAGE_PROMPT) — OCR HAMESHA original
  //      image par hota hai, cleaned sirf background ke liye
  //   3) per-page OCR: box_2d [ymin,xmin,ymax,xmax] normalized 0-1000
  //      -> px, repairBlocks -> resolveOverlaps
  //   4) translation (agar language chuni ho): POORE document ki EK final
  //      call — document_type + era_tone detect, paragraph-wise context,
  //      width-aware split-back (kabhi per-page nahi)
  //   5) VML textboxes (findSmartFontSize binary-search) + MHT container
  //      (Word data-URL images nahi padhta, isliye images alag MIME parts)
  //      -> .doc blob (application/msword)
  // Farq sirf itna: OpenRouter direct nahi — server /vision-proxy ke
  // through (key .env me, browser me kabhi nahi). Isi wajah se HTML ka
  // validateApiKey step yahan nahi hai (key server ki zimmedari hai;
  // galat key hogi to proxy ka error waise hi surface hota hai).
  // ====================================================================

  function v14BuildExtractionPrompt() {
    const prompt = window.getAiPrompt ? window.getAiPrompt('OCR', 1) : null;
    if (!prompt) throw new Error('AI Prompt for OCR (prompt #1, text extraction) is not configured - add it in Admin > AI Prompts, or run migration first.');
    return prompt;
  }

  function v14CleanJsonResponse(raw) {
    let cleaned = String(raw || '').trim();
    cleaned = cleaned.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '');
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.substring(firstBrace, lastBrace + 1);
    }
    return cleaned.trim();
  }

  // ---- proxy calls (OpenRouter direct nahi — server key lagata hai) ----
  async function v14ProxyJson(reqBody) {
    // Count before dispatch: a call that fails still consumed a call.
    if (reqBody && Array.isArray(reqBody.modalities) && reqBody.modalities.indexOf('image') !== -1) {
      _apiCalls.image++;
    } else {
      _apiCalls.json++;
    }
    const resp = await _visionFetch(reqBody);
    let data = null;
    try { data = await resp.json(); } catch (e) { /* non-json error body */ }
    if (!resp.ok) {
      const msg = (data && (data.error && data.error.message || data.error)) || ('HTTP ' + resp.status);
      throw new Error('Vision proxy error: ' + (typeof msg === 'string' ? msg.substring(0, 300) : JSON.stringify(msg).substring(0, 300)));
    }
    if (!data) throw new Error('Vision proxy did not return a JSON response.');
    return data;
  }

  async function v14VisionOnce(model, dataUrl, prompt, maxTokens, temperature) {
    const data = await v14ProxyJson({
      model: model,
      temperature: temperature != null ? temperature : 0,
      max_tokens: maxTokens,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: dataUrl } }
          ]
        }
      ]
    });
    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      throw new Error('Unexpected API response format from OpenRouter.');
    }
    return { content: data.choices[0].message.content, finishReason: data.choices[0].finish_reason };
  }

  // max_tokens explicit — finish_reason="length" (token-limit truncation)
  // par EK retry badi limit ke saath. Ye "dobara guess" retry NAHI hai —
  // sirf already-decided JSON poori likhne ki jagah dena hai. (v13/v14 fix)
  //
  // NOTE: ek speculative extra retry ("finish_reason !== 'stop' to retry
  // karo") pehle yahan tha, lekin providers finish_reason ko alag-alag
  // spelling/case me bhejte hain (e.g. "STOP" vs "stop", ya bilkul field
  // hi missing) — us guess ki wajah se HAR page do baar call ho raha tha
  // (speed aadhi ho gayi thi, aur "HTML me 1 call, Lexora me multiple
  // calls" wala mismatch yahi tha). Hata diya — asli truncation/garbage
  // output ko JSON.parse hi reliably pakadta hai (v14ProcessSingleImage
  // ka apna retry-on-parse-failure), isliye normal path par hamesha
  // sirf EK hi call lagti hai, jaisa HTML tool me hota hai.
  async function v14VisionCall(model, dataUrl, prompt, startTokens, temperature) {
    let result = await v14VisionOnce(model, dataUrl, prompt, startTokens || 16000, temperature);
    if (result.finishReason === 'length') {
      log('OCR response was truncated by the token limit — retrying with 32000 tokens...', 'warn');
      result = await v14VisionOnce(model, dataUrl, prompt, 32000, temperature);
    }
    return { content: result.content, finishReason: result.finishReason, hitTokenLimit: result.finishReason === 'length' };
  }

  // ---- CLEAN IMAGE (image-output model, HTML tool ka EXACT prompt) ----
  // AI-based clean, used ONLY for pages the OCR flags as having a real
  // visual background (logo/seal/photo/texture) worth preserving. An
  // image-output model removes the text while keeping the graphics.
  function v14GetCleanImagePrompt() {
    const prompt = window.getAiPrompt ? window.getAiPrompt('OCR', 2) : null;
    if (!prompt) throw new Error('AI Prompt for OCR (prompt #2, image cleaning) is not configured - add it in Admin > AI Prompts, or run migration first.');
    return prompt;
  }

  // A model can silently return an unchanged image on hard pages. Cheap
  // downsampled diff so the caller can treat that as failure and fall
  // back to deterministic local paint.
  function v14ImagesLookNearlyIdentical(dataUrlA, dataUrlB) {
    return new Promise(function (resolve) {
      const SIZE = 32;
      function toSamples(dataUrl) {
        return new Promise(function (res, rej) {
          const im = new Image();
          im.onload = function () {
            try {
              const c = document.createElement('canvas');
              c.width = SIZE; c.height = SIZE;
              const ctx = c.getContext('2d');
              ctx.drawImage(im, 0, 0, SIZE, SIZE);
              res(ctx.getImageData(0, 0, SIZE, SIZE).data);
            } catch (e) { rej(e); }
          };
          im.onerror = function () { rej(new Error('image load failed')); };
          im.src = dataUrl;
        });
      }
      Promise.all([toSamples(dataUrlA), toSamples(dataUrlB)])
        .then(function (pair) {
          const a = pair[0], b = pair[1];
          let totalDiff = 0;
          for (let i = 0; i < a.length; i += 4) {
            totalDiff += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
          }
          const maxDiff = (a.length / 4) * 3 * 255;
          resolve((totalDiff / maxDiff) < 0.02);
        })
        .catch(function () { resolve(false); });
    });
  }

  async function v14CleanImageAI(cleanModel, dataUrl) {
    const data = await v14ProxyJson({
      model: cleanModel,
      modalities: ['image', 'text'],
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: v14GetCleanImagePrompt() },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }]
    });
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    const images = msg && msg.images;
    if (!images || !images.length) {
      throw new Error('the model did not return an image (does this model support image output?)');
    }
    const url = images[0].image_url && images[0].image_url.url;
    if (!url || !/^data:image\//i.test(url)) {
      throw new Error('clean-image response did not contain a valid image data URL');
    }
    const nearlyIdentical = await v14ImagesLookNearlyIdentical(dataUrl, url);
    if (nearlyIdentical) {
      throw new Error('model returned a near-identical image (could not remove the text)');
    }
    return url;
  }

  // Deterministic Clean Image for the With-OCR (vision) pipeline: load
  // the page image into a canvas and paint white over every OCR text
  // block's exact box. v14ProcessSingleImage already converted each
  // block's box_2d (normalized 0-1000) into pixel x/y/width/height, so
  // we just paint those. No AI call, 100% reliable.
  function v14PaintOverTextBoxes(dataUrl, blocks) {
    return new Promise(function (resolve, reject) {
      const img = new Image();
      img.onload = function () {
        try {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth || img.width;
          c.height = img.naturalHeight || img.height;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0);
          ctx.fillStyle = '#ffffff';
          const pad = 1;   // cover anti-aliased glyph edges
          blocks.forEach(function (b) {
            const x = Number(b.x) || 0, y = Number(b.y) || 0;
            const w = Number(b.width) || 0, h = Number(b.height) || 0;
            if (w > 0 && h > 0) ctx.fillRect(x - pad, y - pad, w + pad * 2, h + pad * 2);
          });
          resolve(c.toDataURL('image/png'));
        } catch (e) { reject(e); }
      };
      img.onerror = function () { reject(new Error('failed to load page image for cleaning')); };
      img.src = dataUrl;
    });
  }

  // ---- PDF -> IMAGES (v14: scale 2.0, PNG) ----
  async function v14PdfToImages(pdf) {
    const numPages = pdf.numPages;
    const images = [];
    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale: 2.0 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const context = canvas.getContext('2d');
      await page.render({ canvasContext: context, viewport: viewport }).promise;
      images.push({
        dataUrl: canvas.toDataURL('image/png'),
        width: viewport.width,
        height: viewport.height,
        pageNum: pageNum
      });
      emit({ type: 'scan', page: pageNum, totalPages: numPages });
    }
    return images;
  }

  // ---- REPAIR (v14 exact) ----
  // ---- Pixel-level box refinement (ink detection) ----
  // Vision-LLM bounding boxes are a well-known weak point: the model is
  // good at READING text but not at precisely LOCALIZING it pixel-by-
  // pixel, especially in a dense table with many small adjacent cells.
  // This scans the actual rendered page image for real dark/ink pixels
  // within and slightly around the model's rough box, and tightens the
  // box to the true ink boundary - the same principle used successfully
  // in this project's earlier PDF-to-Word tool ("geometry must come from
  // pixel measurement, not the model's guess").
  function v14GetImageDataFromDataUrl(dataUrl) {
    return new Promise(function (resolve, reject) {
      const img = new Image();
      img.onload = function () {
        try {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0);
          resolve({ imageData: ctx.getImageData(0, 0, c.width, c.height), width: c.width, height: c.height });
        } catch (e) { reject(e); }
      };
      img.onerror = function () { reject(new Error('Could not load page image for box refinement.')); };
      img.src = dataUrl;
    });
  }

  function v14RefineBoxesWithInk(pixelInfo, blocks) {
    const { imageData, width: imgW, height: imgH } = pixelInfo;
    const data = imageData.data;
    const DARK_THRESHOLD = 150; // luminance below this counts as "ink"
    const MARGIN = 6; // px of search room around the model's rough box

    function isInk(px, py) {
      if (px < 0 || py < 0 || px >= imgW || py >= imgH) return false;
      const idx = (py * imgW + px) * 4;
      const lum = data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
      return lum < DARK_THRESHOLD;
    }

    return blocks.map(function (b) {
      const searchX0 = Math.max(0, Math.round(b.x - MARGIN));
      const searchY0 = Math.max(0, Math.round(b.y - MARGIN));
      const searchX1 = Math.min(imgW - 1, Math.round(b.x + b.w + MARGIN));
      const searchY1 = Math.min(imgH - 1, Math.round(b.y + b.h + MARGIN));
      if (searchX1 <= searchX0 || searchY1 <= searchY0) return b;

      let minX = null, minY = null, maxX = null, maxY = null;
      // Sample every pixel in the (small) search window - these boxes are
      // only tens of pixels across, so this stays cheap.
      for (let py = searchY0; py <= searchY1; py++) {
        for (let px = searchX0; px <= searchX1; px++) {
          if (isInk(px, py)) {
            if (minX === null || px < minX) minX = px;
            if (minY === null || py < minY) minY = py;
            if (maxX === null || px > maxX) maxX = px;
            if (maxY === null || py > maxY) maxY = py;
          }
        }
      }
      // No ink found nearby - keep the model's original box rather than
      // collapsing it (could be a genuinely blank field, or ink outside
      // the search margin for an unusually large text block).
      if (minX === null) return b;

      const refinedW = Math.max(1, maxX - minX + 1);
      const refinedH = Math.max(1, maxY - minY + 1);
      // Sanity check: if the refined box is wildly smaller than the
      // model's own box (e.g. only caught one stray dark pixel), the
      // model's box is probably more trustworthy for this one - only
      // apply the refinement when it's a plausible tightening, not a
      // collapse.
      if (refinedW < b.w * 0.3 || refinedH < b.h * 0.3) return b;

      return Object.assign({}, b, { x: minX, y: minY, w: refinedW, h: refinedH });
    });
  }

  function v14RepairBlocks(blocks, imgW, imgH) {
    const notes = [];
    const repaired = blocks.map((b, i) => {
      const item = Object.assign({}, b);
      const tag = `[#${i + 1} "${String(item.text).substring(0, 20)}"]`;

      let x = Math.round(Number(item.x)) || 0;
      let y = Math.round(Number(item.y)) || 0;
      let w = Math.round(Number(item.width)) || 0;
      let h = Math.round(Number(item.height)) || 0;
      let fs = Number(item.font_size_px);
      let baseline = Number(item.baseline_y);

      if (!Number.isFinite(fs) || fs <= 0) {
        fs = (h > 2) ? Math.round(h * 0.8) : 14;
        notes.push(`${tag} font_size_px missing → estimated ${fs}`);
      }

      if (h < fs * 0.8 || h < 2) {
        const newH = Math.max(2, Math.round(fs * 1.3));
        if (Number.isFinite(baseline) && baseline > y + h && baseline <= imgH) {
          const newY = Math.max(0, Math.round(baseline - fs * 1.05));
          notes.push(`${tag} y ${y}→${newY} (repositioned from baseline_y=${baseline})`);
          y = newY;
        }
        notes.push(`${tag} height ${h}→${newH} (font_size_px=${fs}, height was impossible)`);
        h = newH;
      }

      if (w < 2) {
        const estW = Math.max(10, Math.round(String(item.text).length * fs * 0.6));
        notes.push(`${tag} width ${w}→${estW} (estimated from text length)`);
        w = estW;
      }

      x = Math.min(Math.max(0, x), Math.max(0, imgW - 1));
      y = Math.min(Math.max(0, y), Math.max(0, imgH - 1));
      if (x + w > imgW) { w = Math.max(1, imgW - x); }
      if (y + h > imgH) {
        const shiftedY = imgH - h;
        if (shiftedY >= 0) {
          notes.push(`${tag} y ${y}→${shiftedY} (box was overflowing bottom edge)`);
          y = shiftedY;
        } else {
          h = Math.max(1, imgH - y);
          notes.push(`${tag} height clamped to ${h} (image edge)`);
        }
      }

      if (!Number.isFinite(baseline) || baseline < y || baseline > y + h) {
        const newBaseline = Math.round(y + h * 0.8);
        if (Number.isFinite(baseline)) {
          notes.push(`${tag} baseline_y ${baseline}→${newBaseline} (was outside box)`);
        }
        baseline = newBaseline;
      }

      if (fs > h) {
        notes.push(`${tag} font_size_px ${fs}→${h} (cannot exceed box height)`);
        fs = h;
      }

      item.x = x;
      item.y = y;
      item.width = w;
      item.height = h;
      item.right = x + w;
      item.bottom = y + h;
      item.baseline_y = baseline;
      item.font_size_px = fs;
      return item;
    });

    return { blocks: repaired, notes: notes };
  }

  function v14ResolveOverlaps(blocks, imgW, imgH) {
    const notes = [];
    const MIN_GAP = 1;
    const n = blocks.length;
    const result = blocks.map(b => Object.assign({}, b));

    const geo = result.map(b => ({
      x: Number(b.x) || 0,
      y: Number(b.y) || 0,
      w: Number(b.width) || 0,
      h: Number(b.height) || 0
    }));

    function significantOverlap(a, b) {
      const xOverlap = a.x < b.x + b.w && a.x + a.w > b.x;
      if (!xOverlap) return false;
      const yOverlap = a.y < b.y + b.h && a.y + a.h > b.y;
      if (!yOverlap) return false;
      const overlapPx = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      const smallerH = Math.min(a.h, b.h);
      return overlapPx > 2 && overlapPx >= smallerH * 0.15;
    }

    const parent = Array.from({ length: n }, (_, i) => i);
    function find(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
    function union(i, j) { const ri = find(i), rj = find(j); if (ri !== rj) parent[ri] = rj; }

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (significantOverlap(geo[i], geo[j])) union(i, j);
      }
    }

    const clusters = {};
    for (let i = 0; i < n; i++) {
      const r = find(i);
      (clusters[r] = clusters[r] || []).push(i);
    }

    for (const key in clusters) {
      const idxs = clusters[key];
      if (idxs.length < 2) continue;

      idxs.sort((a, b) => {
        if (geo[a].y !== geo[b].y) return geo[a].y - geo[b].y;
        const ra = Number(result[a].reading_order) || 0;
        const rb = Number(result[b].reading_order) || 0;
        return ra - rb;
      });

      const envMinY = Math.min(...idxs.map(i => geo[i].y));
      const envMaxBottom = Math.max(...idxs.map(i => geo[i].y + geo[i].h));
      const envelope = Math.max(2, envMaxBottom - envMinY);

      const totalGap = (idxs.length - 1) * MIN_GAP;
      const sumH = idxs.reduce((s, i) => s + geo[i].h, 0);

      let scale = 1;
      if (sumH + totalGap > envelope) {
        scale = Math.max(0.35, (envelope - totalGap) / sumH);
      }

      let cursorY = envMinY;
      for (const i of idxs) {
        const item = result[i];
        const origY = geo[i].y, origH = geo[i].h;
        const newH = Math.max(4, Math.round(origH * scale));
        const newY = Math.round(cursorY);

        if (newY !== origY || newH !== origH) {
          notes.push(`[overlap-fix "${String(item.text).substring(0, 20)}"] y ${origY}→${newY}, height ${origH}→${newH}`);
        }

        item.y = newY;
        item.height = newH;
        item.bottom = newY + newH;
        item.right = item.x + item.width;
        item.baseline_y = newY + Math.round(newH * 0.8);
        if (Number.isFinite(item.font_size_px) && item.font_size_px > newH) {
          item.font_size_px = newH;
        }

        cursorY = newY + newH + MIN_GAP;
      }

      const lastIdx = idxs[idxs.length - 1];
      if (result[lastIdx].bottom > imgH) {
        const overflow = result[lastIdx].bottom - imgH;
        result[lastIdx].height = Math.max(4, result[lastIdx].height - overflow);
        result[lastIdx].bottom = result[lastIdx].y + result[lastIdx].height;
      }
    }

    return { blocks: result, notes };
  }

  // ---- CANVAS MEASUREMENT + SMART FONT SIZE (v14 exact) ----
  const v14MeasureCanvas = document.createElement('canvas');
  const v14MeasureCtx = v14MeasureCanvas.getContext('2d');

  function v14MeasureTextWidthPx(text, fontPt, bold) {
    const fontPx = fontPt * 96 / 72;
    v14MeasureCtx.font = `${bold ? 'bold ' : ''}${fontPx}px Arial`;
    return v14MeasureCtx.measureText(text).width;
  }

  function v14FindSmartFontSize(text, boxWidth, boxHeight, bold) {
    if (!text || text.length === 0) {
      return { fontSize: 1, log: [], overflowed: false };
    }

    const padding = 2;
    const effectiveWidth = Math.max(4, boxWidth - padding * 2);
    const effectiveHeight = Math.max(4, boxHeight - padding * 2);

    const maxByHeightPt = effectiveHeight * 0.75;
    // Don't shrink past a readable floor. Translated text is very often
    // longer than the original line (English vs Arabic word counts
    // differ a lot in both directions) - without a floor, the old binary
    // search would keep shrinking toward ~1pt trying to make it "fit",
    // producing invisible text. Below MIN_FONT_PT we stop shrinking and
    // instead let the render step show the overflow rather than clip it.
    const MIN_FONT_PT = 6;
    const lowestUsable = Math.min(MIN_FONT_PT, Math.max(1, maxByHeightPt));

    let lo = 1;
    let hi = Math.max(1, maxByHeightPt);
    const logArr = [];

    for (let iter = 0; iter < 24; iter++) {
      const mid = (lo + hi) / 2;
      const textWidth = v14MeasureTextWidthPx(text, mid, bold);
      const fits = textWidth <= effectiveWidth;
      logArr.push({ fontSize: Math.round(mid * 10) / 10, textWidth: textWidth, fontHeight: Math.round(mid * 96 / 72), fits: fits });
      if (fits) {
        lo = mid;
      } else {
        hi = mid;
      }
      if (hi - lo < 0.05) break;
    }

    let finalSize = Math.floor(lo * 10) / 10;
    if (finalSize < 1) finalSize = 1;

    // If shrinking to fit would require going below the readable floor,
    // use the floor instead and flag it as overflowing - the renderer
    // then lets the (small amount of) extra text spill past the box
    // edge instead of invisibly clipping it. A slightly-overflowing but
    // COMPLETE line (including its trailing comma/period) beats a
    // perfectly-boxed line that's missing its last character.
    let overflowed = false;
    if (finalSize < lowestUsable) {
      finalSize = lowestUsable;
      overflowed = true;
    }

    return { fontSize: finalSize, log: logArr, overflowed: overflowed };
  }

  function v14EscapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function v14IsValidHexColor(c) {
    return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);
  }

  // ---- Salvage partial text_blocks when the overall JSON is malformed ----
  // A single bad escape/quote anywhere in a dense bilingual page can break
  // JSON.parse for the WHOLE response even though most individual block
  // objects are perfectly well-formed. Rather than losing the entire page,
  // scan for the text_blocks array and pull out every {...} object that
  // parses cleanly on its own, skipping only the one(s) that don't.
  function v14SalvagePartialTextBlocks(raw) {
    const arrayStart = raw.indexOf('"text_blocks"');
    if (arrayStart === -1) return [];
    const bracketStart = raw.indexOf('[', arrayStart);
    if (bracketStart === -1) return [];

    const blocks = [];
    let i = bracketStart + 1;
    while (i < raw.length) {
      while (i < raw.length && /[\s,]/.test(raw[i])) i++;
      if (raw[i] === ']' || i >= raw.length) break;
      if (raw[i] !== '{') { i++; continue; }

      // Balanced-brace scan for one object, respecting quoted strings so a
      // '{' or '}' inside a text value doesn't throw the count off.
      let depth = 0, inString = false, escaped = false, objStart = i, objEnd = -1;
      for (let j = i; j < raw.length; j++) {
        const ch = raw[j];
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { objEnd = j; break; } }
      }
      if (objEnd === -1) break; // unterminated - rest of the response is unusable
      const candidate = raw.slice(objStart, objEnd + 1);
      try {
        const obj = JSON.parse(candidate);
        if (obj && typeof obj === 'object' && typeof obj.text === 'string') blocks.push(obj);
      } catch (e) { /* this one block was the malformed one - skip it, keep going */ }
      i = objEnd + 1;
    }
    return blocks;
  }

  // Same idea as v14SalvagePartialTextBlocks, but for the top-level
  // has_visual_background flag - a simple regex match works fine here
  // since it's a plain boolean field, not nested structure. Losing this
  // flag on a malformed response silently skipped image-cleaning on
  // pages that clearly had a background worth preserving (logos, seals,
  // colored headers) - that was a real bug, not intentional behavior.
  function v14SalvageHasVisualBackground(raw) {
    const m = raw.match(/"has_visual_background"\s*:\s*(true|false)/i);
    return m ? m[1].toLowerCase() === 'true' : null;
  }

  // ---- OCR one page: box_2d 0-1000 -> px, filter, repair, de-overlap ----
  // ROOT CAUSE FIX: agar pehli call ka JSON malformed/incomplete nikle
  // (flaky vision-model output — v14VisionCall ke reason dekho), to
  // seedha page skip karne ki jagah EK poora fresh OCR attempt aur
  // karte hain — dusra attempt zyada baar sahi JSON deta hai. Sirf
  // dusri baar bhi fail ho to page fail hota hai (jaisa pehle tha),
  // par ab asli finish_reason bhi error message me dikhta hai.
  async function v14ProcessSingleImage(model, dataUrl, width, height, pageNum, startTokens) {
    const prompt = v14BuildExtractionPrompt();

    let parsed, rawContent, finishReason, lastErr;
    const MAX_ATTEMPTS = 2;
    let nextStartTokens = startTokens || 16000; // once an attempt needs 32000, skip the wasted 16000 call on the next one
    let bestSalvage = { blocks: [], hasVisualBackground: null };
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // temperature=0 is deterministic - if attempt 1 fails, retrying at
      // temperature=0 again just reproduces the IDENTICAL broken output
      // (verified: same char count, same finish_reason, every time on a
      // page that fails this way). A real second chance needs a
      // genuinely different sample, so attempt 2 uses a small non-zero
      // temperature instead of repeating the same request pointlessly.
      const temperature = attempt === 1 ? 0 : 0.3;
      const callResult = await v14VisionCall(model, dataUrl, prompt, nextStartTokens, temperature);
      rawContent = callResult.content;
      finishReason = callResult.finishReason;
      if (callResult.hitTokenLimit) nextStartTokens = 32000;
      const cleaned = v14CleanJsonResponse(rawContent);

      try {
        const p = JSON.parse(cleaned);
        if (!p || typeof p !== 'object' || !Array.isArray(p.text_blocks)) {
          throw new Error('Model did not return the expected {"text_blocks":[...]} format.');
        }
        parsed = p;
        lastErr = null;
        break;
      } catch (parseErr) {
        try { console.error('Raw model response (attempt ' + attempt + ', finish_reason=' + finishReason + '):', rawContent); } catch (e) {}
        const looksTruncated = !cleaned.trim().endsWith('}');
        const tail = cleaned.slice(-80);
        const detail = (parseErr.message === 'Model did not return the expected {"text_blocks":[...]} format.')
          ? parseErr.message
          : `JSON parse failed (${cleaned.length} chars, finish_reason="${finishReason}", ${looksTruncated ? 'response looks truncated — end: "...' + tail + '"' : 'JSON is malformed'})`;
        lastErr = new Error(detail);

        // Keep this attempt's salvage only if it beats what we already
        // have - don't settle for a smaller partial recovery from a
        // later attempt when an earlier one actually did better.
        const salvaged = v14SalvagePartialTextBlocks(cleaned);
        const salvagedBg = v14SalvageHasVisualBackground(cleaned);
        if (salvaged.length > bestSalvage.blocks.length) {
          bestSalvage = { blocks: salvaged, hasVisualBackground: salvagedBg };
        }

        if (attempt < MAX_ATTEMPTS) {
          log('P' + pageNum + ': OCR JSON invalid (' + detail + ') — retrying with a fresh attempt (' + (attempt + 1) + '/' + MAX_ATTEMPTS + ')...', 'warn');
        } else if (bestSalvage.blocks.length) {
          // Both attempts failed to parse cleanly - use whichever
          // attempt recovered the most blocks rather than losing the
          // page entirely.
          log('P' + pageNum + ': full JSON still malformed after ' + MAX_ATTEMPTS + ' attempts, but recovered ' + bestSalvage.blocks.length + ' text block(s) from the best partial response.', 'warn');
          parsed = { text_blocks: bestSalvage.blocks, has_visual_background: bestSalvage.hasVisualBackground };
          lastErr = null;
        }
      }
    }
    if (lastErr) throw lastErr;

    const filtered = parsed.text_blocks
      .filter(item => item && typeof item === 'object' && typeof item.text === 'string' && item.text.trim().length > 0)
      .map((item, i) => {
        let x = 0, y = 0, w = 10, h = 10;
        const box = item.box_2d;
        if (Array.isArray(box) && box.length === 4 && box.every(n => Number.isFinite(Number(n)))) {
          const ymin = Math.min(Number(box[0]), Number(box[2]));
          const xmin = Math.min(Number(box[1]), Number(box[3]));
          const ymax = Math.max(Number(box[0]), Number(box[2]));
          const xmax = Math.max(Number(box[1]), Number(box[3]));

          const pxXmin = Math.round((xmin / 1000) * width);
          const pxYmin = Math.round((ymin / 1000) * height);
          const pxXmax = Math.round((xmax / 1000) * width);
          const pxYmax = Math.round((ymax / 1000) * height);

          x = pxXmin;
          y = pxYmin;
          w = Math.max(1, pxXmax - pxXmin);
          h = Math.max(1, pxYmax - pxYmin);
        } else if (Number.isFinite(Number(item.x)) && Number.isFinite(Number(item.width))) {
          x = Math.round(Number(item.x)) || 0;
          y = Math.round(Number(item.y)) || 0;
          w = Math.max(1, Math.round(Number(item.width)) || 10);
          h = Math.max(1, Math.round(Number(item.height)) || 10);
        }

        const fontSizePx = Math.max(2, Math.round(h * 0.8));
        const baselineY = y + fontSizePx;

        return {
          id: `pg${pageNum}_b${i}`,
          page: pageNum,
          paragraph_id: item.paragraph_id || '',
          reading_order: Number.isFinite(Number(item.reading_order)) ? Number(item.reading_order) : 0,
          line_index: Number.isFinite(Number(item.line_index)) ? Number(item.line_index) : 0,
          text: item.text.trim(),
          language: item.language || 'unknown',
          direction: item.direction || 'ltr',
          x: x,
          y: y,
          width: w,
          height: h,
          right: x + w,
          bottom: y + h,
          baseline_y: baselineY,
          font_size_px: fontSizePx,
          text_height_px: fontSizePx,
          bbox_height_px: h,
          font_family: item.font_family || 'unknown',
          style: item.style || 'normal',
          color: item.color || '#000000',
          align: item.align || 'left',
          is_handwritten: typeof item.is_handwritten === 'boolean' ? item.is_handwritten : null,
          rotation: Number(item.rotation) || 0,
          confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : null
        };
      });

    if (filtered.length === 0) {
      throw new Error('No readable text was detected in the image.');
    }

    let refined = filtered;
    try {
      const pixelInfo = await v14GetImageDataFromDataUrl(dataUrl);
      refined = v14RefineBoxesWithInk(pixelInfo, filtered);
    } catch (e) {
      // If pixel refinement fails for any reason (canvas/image error),
      // fall back to the model's own coordinates rather than losing the
      // page - refinement is a quality improvement, not a hard dependency.
    }

    const rep = v14RepairBlocks(refined, width, height);
    const deo = v14ResolveOverlaps(rep.blocks, width, height);
    const hasVisualBackground = (parsed.has_visual_background === true);
    return { blocks: deo.blocks, notes: rep.notes.concat(deo.notes), width: width, height: height, hasVisualBackground: hasVisualBackground, startTokensNeeded: nextStartTokens };
  }

  // ---- DOMAIN EXPERT PERSONAS (17 domains) ----
  // Each persona = an expert role framing + a hard-locked terminology
  // glossary (source term -> exact target-language equivalents). Giving
  // the model the EXACT terms up front, rather than a generic "use
  // domain terminology" instruction, is what keeps terminology
  // consistent across a whole document and matches how a genuine
  // subject-matter professional would translate it.
  const TRANSLATION_DOMAIN_EXPERTS = {
    'Real Estate': {
      role: 'a senior commercial real estate attorney and certified native translator with 20+ years drafting leases, purchase agreements, and management contracts',
      terms: 'Lessor (arrendador, bailleur, Vermieter, locatore), Lessee/Tenant (arrendatario, locataire, Mieter, conduttore), Premises (inmueble, locaux, Mietsache, locali), Rent (renta/canon, loyer, Miete, canone), Security Deposit (fianza, depot de garantie, Kaution, deposito cauzionale), Term (vigencia/plazo, duree, Mietdauer, durata), Assignment (cesion, cession, Abtretung, cessione), Sublease (subarriendo, sous-location, Untervermietung, sublocazione), Common Area (zonas comunes), Force Majeure (fuerza mayor, force majeure, hohere Gewalt, forza maggiore), Default (incumplimiento), Termination (rescision/resolucion, resiliation, Kundigung, risoluzione)'
    },
    'Legal': {
      role: 'a senior corporate attorney and certified native translator specializing in contracts, litigation, regulatory filings, and court documents with 20+ years drafting in formal legal register',
      terms: 'Party (parte, partie, Partei, parte), Counterparty (contraparte), Whereas (considerando), Hereby (por la presente), Hereinafter (en lo sucesivo), Notwithstanding (no obstante), Indemnity (indemnizacion), Liability (responsabilidad), Jurisdiction (jurisdiccion), Governing Law (ley aplicable), Arbitration (arbitraje), Damages (danos y perjuicios), Breach (incumplimiento), Remedy (remedio), Waiver (renuncia), Severability (divisibilidad)'
    },
    'Healthcare': {
      role: 'a senior healthcare administrator and certified medical translator with 20+ years working across hospitals, clinics, and provider networks',
      terms: 'Patient (paciente), Provider (proveedor/prestador), Clinic (clinica), Diagnosis (diagnostico), Treatment (tratamiento), Care Plan (plan de atencion), Medical Record (historia clinica), Consent (consentimiento), Practitioner (profesional sanitario), Referral (derivacion/remision), Triage (triaje), Outpatient (ambulatorio), Inpatient (hospitalizado), Discharge (alta), Admission (ingreso)'
    },
    'Finance': {
      role: 'a senior financial controller and certified accounting translator (CPA-equivalent) with 20+ years in financial reporting, auditing, and corporate accounting',
      terms: 'Assets (activos), Liabilities (pasivos), Equity (patrimonio neto), Revenue (ingresos), Expenses (gastos), Net Income (resultado neto/utilidad neta), Accounts Payable (cuentas por pagar), Accounts Receivable (cuentas por cobrar), Working Capital (capital de trabajo), EBITDA (BAIIDA), Cash Flow (flujo de caja), Depreciation (amortizacion/depreciacion), Accrual (devengo), Reconciliation (conciliacion)'
    },
    'Insurance': {
      role: 'a senior insurance underwriter and certified native translator with 20+ years in property, casualty, life, and commercial insurance',
      terms: 'Policyholder (tomador/asegurado), Insurer (aseguradora), Insured (asegurado), Beneficiary (beneficiario), Premium (prima), Deductible (franquicia/deducible), Coverage (cobertura), Claim (reclamo/siniestro), Endorsement (endoso), Exclusion (exclusion), Underwriting (suscripcion), Loss (siniestro), Adjuster (perito/ajustador), Subrogation (subrogacion)'
    },
    'Banking': {
      role: 'a senior banking executive and certified native translator with 20+ years in retail banking, commercial lending, and treasury operations',
      terms: 'Account (cuenta), Loan (prestamo), Mortgage (hipoteca), Credit Line (linea de credito), Principal (principal/capital), Interest Rate (tasa de interes), Collateral (garantia/colateral), Guarantor (avalista/garante), Default (mora/incumplimiento), Disbursement (desembolso), Wire Transfer (transferencia bancaria), KYC (conocer al cliente), AML (prevencion de blanqueo), Beneficial Owner (titular real)'
    },
    'Procurement': {
      role: 'a senior supply chain and procurement director and certified native translator with 20+ years in vendor contracts, RFPs, and sourcing strategy',
      terms: 'Purchase Order (orden de compra), Vendor/Supplier (proveedor), Buyer (comprador), Specification (especificacion), Lead Time (plazo de entrega), Delivery Terms (condiciones de entrega), Incoterms, Quality Standards (estandares de calidad), Service Level Agreement (acuerdo de nivel de servicio), Master Service Agreement (acuerdo marco), Statement of Work (descripcion del trabajo), RFP (solicitud de propuesta), RFQ (solicitud de cotizacion)'
    },
    'HR': {
      role: 'a senior human resources director and certified employment-law translator with 20+ years in employment contracts, policies, and labor compliance',
      terms: 'Employee (empleado), Employer (empleador), Compensation (remuneracion), Salary (salario), Benefits (prestaciones/beneficios), Termination (terminacion/despido), Severance (indemnizacion), Probation (periodo de prueba), Notice Period (preaviso), Performance Review (evaluacion de desempeno), Code of Conduct (codigo de conducta), Confidentiality (confidencialidad), Non-compete (no competencia), Non-disclosure (no divulgacion)'
    },
    'Tax': {
      role: 'a senior tax advisor and certified native translator (CPA/EA-equivalent) with 20+ years in corporate tax, international tax, and tax controversy',
      terms: 'Taxpayer (contribuyente), Tax Authority (autoridad fiscal/hacienda), Withholding (retencion), Tax Return (declaracion fiscal/de impuestos), VAT (IVA), Income Tax (impuesto sobre la renta), Corporate Tax (impuesto de sociedades), Tax Year (ejercicio fiscal), Tax Base (base imponible), Tax Credit (credito fiscal), Deduction (deduccion), Tax Treaty (tratado fiscal), Transfer Pricing (precios de transferencia)'
    },
    'Manufacturing': {
      role: 'a senior manufacturing operations director and certified native translator with 20+ years in production, quality control, and industrial engineering',
      terms: 'Production (produccion), Equipment (equipo/maquinaria), Assembly (ensamblaje/montaje), Maintenance (mantenimiento), Inventory (inventario), Bill of Materials (lista de materiales), Quality Control (control de calidad), Yield (rendimiento), Throughput (rendimiento de produccion), Downtime (tiempo de inactividad), Lean Manufacturing (manufactura esbelta), Just-in-Time (justo a tiempo), Kaizen, Six Sigma'
    },
    'Technical': {
      role: 'a senior software/systems architect and certified technical translator with 20+ years in engineering documentation, infrastructure design, and technical specifications',
      terms: 'System (sistema), Architecture (arquitectura), Deployment (despliegue), Infrastructure (infraestructura), Specification (especificacion), API (API/interfaz de programacion), Database (base de datos), Endpoint (punto de conexion), Throughput (rendimiento), Latency (latencia), Scalability (escalabilidad), Redundancy (redundancia), Failover (conmutacion por error), Authentication (autenticacion)'
    },
    'Medical': {
      role: 'a senior physician and certified medical translator (board-equivalent) with 20+ years in clinical practice, medical research, and pharmaceutical documentation',
      terms: 'Patient (paciente), Diagnosis (diagnostico), Prognosis (pronostico), Pathology (patologia), Etiology (etiologia), Symptom (sintoma), Sign (signo), Comorbidity (comorbilidad), Adverse Event (evento adverso), Indication (indicacion), Contraindication (contraindicacion), Posology (posologia/dosificacion), Pharmacokinetics (farmacocinetica), Clinical Trial (ensayo clinico)'
    },
    'Compliance': {
      role: 'a senior compliance officer (CCO/CECO-equivalent) and certified native translator with 20+ years in regulatory affairs, AML, sanctions, and corporate governance',
      terms: 'Regulation (regulacion/normativa), Regulatory Body (organismo regulador), Compliance Program (programa de cumplimiento), Risk Assessment (evaluacion de riesgos), Audit (auditoria), Control (control), Whistleblower (denunciante), Internal Investigation (investigacion interna), Sanctions (sanciones), Due Diligence (debida diligencia), Beneficial Owner (titular real), Material Risk (riesgo material)'
    },
    'Corporate': {
      role: 'a senior corporate executive (general counsel / company secretary equivalent) and certified native translator with 20+ years in M&A, board governance, and shareholder relations',
      terms: 'Board of Directors (consejo de administracion/junta directiva), Shareholder (accionista), Equity Holder (tenedor de capital), Quorum (quorum), Resolution (acuerdo/resolucion), Bylaws (estatutos), Articles of Association (escritura constitutiva), Merger (fusion), Acquisition (adquisicion), Spin-off (escision), Dividend (dividendo), Share Capital (capital social), Subsidiary (filial/subsidiaria), Parent Company (matriz)'
    },
    'Government': {
      role: 'a senior public-sector official (policy adviser / regulatory specialist) and certified native translator with 20+ years in legislative drafting, public administration, and intergovernmental affairs',
      terms: 'Statute (ley/estatuto), Regulation (reglamento), Decree (decreto), Ordinance (ordenanza), Public Authority (autoridad publica), Ministry (ministerio), Agency (agencia/organismo), Permit (permiso), License (licencia), Public Tender (licitacion publica), Citizen (ciudadano), Resident (residente), Jurisdiction (jurisdiccion), Procedural Code (codigo procesal)'
    },
    'Academic': {
      role: 'a senior research professor and certified academic translator with 20+ years in scholarly publishing, peer review, and grant proposals',
      terms: 'Research (investigacion), Hypothesis (hipotesis), Methodology (metodologia), Findings (hallazgos/resultados), Citation (cita), Bibliography (bibliografia), Peer Review (revision por pares), Abstract (resumen), Literature Review (revision de literatura), Empirical (empirico), Quantitative (cuantitativo), Qualitative (cualitativo), Hypothesis Testing (contraste de hipotesis), Sample (muestra)'
    },
    'General Business': {
      role: 'a senior business executive and certified native translator with 20+ years in general corporate communications, business correspondence, and operational documentation',
      terms: 'Company (empresa), Customer (cliente), Stakeholder (parte interesada), Strategy (estrategia), Operations (operaciones), Performance (desempeno/rendimiento), KPI (indicador clave), ROI (retorno de inversion), Market (mercado), Competitor (competidor), Partnership (alianza/asociacion), Deliverable (entregable), Milestone (hito)'
    }
  };

  // Quick, cheap, focused call (~1500 chars of sample text) BEFORE the
  // main translation - the model's full attention goes to classification
  // alone, which is more reliable than asking it to classify AND
  // translate in the same call. Falls back to General Business on any
  // failure so translation always proceeds even if this step errors out.
  async function v14ClassifyTranslationDomain(model, sampleText) {
    const domains = Object.keys(TRANSLATION_DOMAIN_EXPERTS);
    const systemPrompt = [
      'You are a document classifier. Given a sample of text from a document, identify:',
      '1. Domain: one of [' + domains.join(', ') + ']',
      '2. Document type: a brief 2-4 word descriptor (e.g. "Lease Agreement", "Medical Report", "Invoice", "Employment Contract", "Tax Filing")',
      '',
      'Output ONLY this format, nothing else:',
      'DOMAIN: <one from list>',
      'TYPE: <2-4 words>'
    ].join('\n');

    try {
      const data = await v14ProxyJson({
        model: model,
        temperature: 0,
        max_tokens: 60,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: String(sampleText || '').slice(0, 1500) }
        ]
      });
      const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
      const domainMatch = content.match(/DOMAIN:\s*([^\n]+)/i);
      const typeMatch = content.match(/TYPE:\s*([^\n]+)/i);
      const detected = (domainMatch && domainMatch[1] || '').trim();

      let matched = 'General Business';
      for (const d of domains) {
        if (d.toLowerCase() === detected.toLowerCase()) { matched = d; break; }
      }
      if (matched === 'General Business' && detected) {
        for (const d of domains) {
          if (detected.toLowerCase().includes(d.toLowerCase()) || d.toLowerCase().includes(detected.toLowerCase())) { matched = d; break; }
        }
      }
      return { domain: matched, docType: (typeMatch && typeMatch[1] || 'Document').trim() };
    } catch (err) {
      log('Domain detection failed, continuing with General Business terminology: ' + err.message, 'warn');
      return { domain: 'General Business', docType: 'Document' };
    }
  }

  // ---- TRANSLATION (single final call, whole document — v14 exact) ----
  // LAST me, ek hi call, saare pages saath — page-boundary-crossing
  // paragraphs ki continuity per-page translation tod deti hai.
  function v14BuildTranslationPrompt(targetLanguageLabel, targetCountry, domainInfo) {
    const countryInstruction = targetCountry
      ? `\n\nTARGET COUNTRY SPECIFIED: ${targetCountry}. Use the standard variant of ${targetLanguageLabel} as spoken/written in ${targetCountry} specifically - its spelling conventions, its official/legal terminology, its units and formatting conventions (dates, currency, addresses), and the terms ${targetCountry}'s own administrative/legal system actually uses for each concept. This takes priority over guessing a variant from the source document.`
      : '';
    const expert = domainInfo && TRANSLATION_DOMAIN_EXPERTS[domainInfo.domain];
    const domainPersonaInstruction = expert
      ? `\n\nDOMAIN EXPERT PERSONA:\nThis document was pre-classified as domain "${domainInfo.domain}" (document type: "${domainInfo.docType || 'Document'}"). Translate it as ${expert.role}. Write in ${targetLanguageLabel} as a native professional in this field would - natural, fluent, idiomatic, and using this field's precise terminology.\n\nDOMAIN TERMINOLOGY (use these exact ${targetLanguageLabel} equivalents consistently wherever the source term or its clear equivalent appears - these override your own judgment call on which synonym to pick):\n${expert.terms}`
      : '';
    return `You are a professional document translator and typesetter.

You will be given the FULL extracted content of a multi-page scanned document, as a flat list of text blocks in reading order (across ALL pages). Each block has: id, page, paragraph_id, order, text (original), width (its textbox's pixel width in the final layout), language, direction.

STEP 1 — CLASSIFY THE DOCUMENT
Before translating, look at the whole document's content and determine:
- "document_type": what kind of document this is (e.g. certificate, legal document/contract, official government form, personal/business letter, book or literary excerpt, religious text, invoice/receipt, academic paper, resume/CV, or other — pick the closest fit).
- "domain": the professional field whose terminology conventions apply (e.g. legal, medical, financial, academic, government/administrative, insurance, engineering, real estate, immigration, or general). This decides WHICH profession's standard vocabulary to translate into.
- "source_region": the country/region and issuing authority the document appears to come from, if inferable from its content (e.g. from the language variant, address format, named authorities, legal references, or date conventions). Use this to understand which legal/administrative system's concepts the source terms refer to. If it isn't inferable, say "unknown".
- "era_tone": the appropriate register for translation based on how old/period-specific the writing feels (e.g. "modern/contemporary" for anything ordinary or recent, or a period label like "formal classical/historical" or an approximate era if the vocabulary, spelling, honorifics or subject matter clearly suggest an older text). Default to "modern/contemporary" unless there is a real signal it's from another era.

STEP 2 — TRANSLATE INTO ${targetLanguageLabel}
Translate the ENTIRE document into ${targetLanguageLabel}, using a tone/register appropriate to the document_type, domain and era_tone you determined (e.g. a certificate needs a formal ceremonial register, a legal document needs precise legal register, an old book needs period-appropriate literary tone, a casual letter needs a conversational tone).

IMPORTANT — PICK THE RIGHT REGIONAL VARIANT OF ${targetLanguageLabel}:
Most languages have several standard regional variants that differ in spelling, official terminology, and legal/administrative vocabulary (for example a language may have distinct European vs. North/South American vs. South Asian standards). Decide which variant of ${targetLanguageLabel} best fits this document's domain and likely audience, then apply it CONSISTENTLY throughout: its spelling conventions, its standard professional/official terminology, and the terms that variant's own legal or administrative system actually uses for each concept. Also record which variant you chose as "target_variant". If nothing indicates a specific region, use the most widely-understood neutral standard form of ${targetLanguageLabel} and say so.${countryInstruction}${domainPersonaInstruction}

IMPORTANT — TERMINOLOGY MUST STAY CONSISTENT ACROSS THE WHOLE DOCUMENT:
Before translating, mentally note the key recurring terms and concepts in the document — legal, financial, technical, or otherwise (e.g. rent, tenant, landlord, terminate, deposit, premises, party, agreement, or whatever else actually recurs in THIS document). For each such term, pick ONE precise ${targetLanguageLabel} equivalent appropriate to the document_type's register, and use that EXACT SAME word every single time that term/concept appears, on every page. Do not vary it with a different synonym from one occurrence to the next - inconsistent terminology changes the meaning of a document like this (especially a legal or technical one), it isn't a stylistic choice.

IMPORTANT — TRANSLATE LIKE A NATIVE PROFESSIONAL WRITER OF ${targetLanguageLabel}, NOT WORD-FOR-WORD:
Do not produce a literal, word-by-word rendering that mirrors the source language's sentence structure, word order, or idioms. Instead, understand what each sentence/clause is actually saying and re-express that same meaning the way a native ${targetLanguageLabel}-speaking professional would naturally write it for a document of this document_type - using that field's own standard conventions, set phrases, and idiomatic terminology for the equivalent concept, not a dictionary-literal translation of the source wording. This matters most for formal documents (legal/contract, official government, academic, business) where the target language has its own established drafting conventions:
- For a legal/contractual document_type: use the standard terms and set phrases a professional in that legal tradition would use for each concept (e.g. how that legal system's professionals normally phrase ending an agreement, standard boilerplate expressions, standard clause openers) - a concept-for-concept translation of what the clause legally does, not a literal word-for-word one. If a long sentence's source-language structure would read as awkward or unnatural when translated word-for-word, restructure it into the sentence structure ${targetLanguageLabel} would normally use for that kind of clause, while preserving the exact legal meaning and effect - do not change what any party is agreeing to, obligated to, or entitled to.
- Official entity names, company/organization titles, authority names, and any term the source document treats as a defined/formal term (capitalized, quoted, or explicitly defined) should be translated to their standard recognized ${targetLanguageLabel} equivalent if one exists, and otherwise kept in a single consistent form - never translated one way in one place and a different way elsewhere.
- Preserve clause/section numbering and structural markers exactly as given (e.g. "1.", "(a)", "Article 3", "Section II") - translate only the text that follows them, never the numbering/lettering itself, since these are used for cross-references within the document.

IMPORTANT — ELIMINATE LITERAL TRANSLATION PATTERNS:
Rewrite awkward, stiff constructions that come from translating word-for-word into natural ${targetLanguageLabel} a native professional would actually write. For example (English source shown for illustration - apply the same principle regardless of source/target language pair): "The appearing parties mutually and reciprocally acknowledge" -> "The parties acknowledge"; "free disposal thereof" -> "full legal authority"; "interest and will" -> "intention"; "price of lease" -> "rent" (in a Real Estate document); "cannot be adapted to regulations" -> "cannot be brought into regulatory compliance". Apply this same kind of simplification and naturalization throughout, in whichever language pair you are actually translating.

IMPORTANT — NEVER ALTER FACTUAL DATA WHILE TRANSLATING:
The following must come through EXACTLY as in the source, never re-worded, re-formatted, recalculated, converted, or "corrected": dates, personal and organization names, addresses, all numbers, monetary amounts and currency symbols/codes, units of measurement, identifiers (tax/VAT/registration/file/account numbers), and cross-references to laws, articles, or clauses. Translate the words around them, but copy these through verbatim. Do not convert a currency into another currency, do not convert units, and do not change a date's format or calendar. Do not add any information that is not in the source, and do not omit any information that is.

IMPORTANT — DO NOT TRANSLATE NON-TEXT MARKS:
If a block is a signature, a logo/wordmark, a stamp or seal legend, a barcode/QR label, or a similar mark rather than readable body text, leave its text exactly as-is rather than translating it. Only translate genuine readable language content.

IMPORTANT — TRANSLATE PARAGRAPH-WISE, NOT LINE-BY-LINE:
Blocks that share the same "paragraph_id", taken in their given order (across pages if needed — a paragraph_id's blocks may span a page boundary, since blocks are given in full-document reading order), together form ONE continuous paragraph. Join them, understand the FULL paragraph's meaning and grammar, and translate it as one coherent unit — never translate an isolated block without its paragraph's context.

IMPORTANT — SPLIT BACK INTO THE SAME BLOCKS, WIDTH-AWARE:
After translating a paragraph as a whole, split the translated text back across exactly the same blocks (same count, same order) that paragraph came from. Use each block's given "width" (pixels) as a guide for how much of the translated text that specific block/line should carry — a wider block's line should carry proportionally more translated text than a narrow one — so that when placed into a textbox of that same width, the text fits reasonably (not drastically too long or too short for that line). Blocks that are not part of any multi-line paragraph (isolated labels, single words, dates, numbers, standalone titles) just get their own direct translation.

RULES
- Never add or remove blocks. Every input id must appear exactly once in your output, in the same order.
- Never translate the "id", "page", "paragraph_id" values themselves — only the text.
- Do not add commentary, explanation, or anything outside the JSON.

Return ONLY this JSON shape, nothing else:
{
  "document_type": "...",
  "domain": "...",
  "source_region": "...",
  "target_variant": "...",
  "era_tone": "...",
  "translations": [
    {"id": "pg1_b0", "translated_text": "..."},
    {"id": "pg1_b1", "translated_text": "..."}
  ]
}`;
  }

  async function v14TranslateAllPages(model, allPagesJsonArr, targetLanguageLabel) {
    const compact = allPagesJsonArr.map(b => ({
      id: b.id,
      page: b.page,
      paragraph_id: b.paragraph_id,
      order: b.reading_order,
      text: b.text,
      width: b.width,
      language: b.language,
      direction: b.direction
    }));

    const targetCountry = window.getSetupPref ? window.getSetupPref('translation', 'targetCountry', '') : '';

    // Classify domain first (separate, focused, cheap call) so the main
    // translation call can be given the domain expert persona + exact
    // terminology glossary up front, instead of guessing terminology
    // while also doing the harder job of translating.
    const sampleText = compact.slice(0, 25).map(b => b.text).filter(Boolean).join('\n').slice(0, 1500);
    log('Detecting document domain for terminology matching...', 'info');
    const domainInfo = await v14ClassifyTranslationDomain(model, sampleText);
    log(`Detected domain: ${domainInfo.domain} (${domainInfo.docType})`, 'info');

    const prompt = v14BuildTranslationPrompt(targetLanguageLabel, targetCountry, domainInfo) +
      '\n\nINPUT BLOCKS (full document, all pages, reading order):\n' +
      JSON.stringify(compact);

    // Bade documents ka translation JSON bhi bada — max_tokens block-count
    // se scale, truncate ho to ek retry badi limit se (OCR jaisa pattern).
    const baseMaxTokens = Math.min(60000, Math.max(16000, compact.length * 200));

    async function callTranslationOnce(maxTokens) {
      const data = await v14ProxyJson({
        model: model,
        temperature: 0,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }]
      });
      const finishReason = data.choices && data.choices[0] && data.choices[0].finish_reason;
      const raw = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      return { raw: raw, finishReason: finishReason };
    }

    let res = await callTranslationOnce(baseMaxTokens);
    if (res.finishReason === 'length') {
      log('Translation response was truncated by the token limit — retrying with a higher limit...', 'warn');
      res = await callTranslationOnce(Math.min(100000, baseMaxTokens * 2));
    }

    if (!res.raw) throw new Error('No content received from the translation model.');

    const cleaned = v14CleanJsonResponse(res.raw);
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      try { console.error('Raw translation response (full):', res.raw); } catch (e2) {}
      throw new Error('Translation model did not return valid JSON (see console).');
    }

    if (!parsed || !Array.isArray(parsed.translations)) {
      try { console.error('Raw translation response:', res.raw); } catch (e2) {}
      throw new Error('Translation response did not include a "translations" array.');
    }

    return parsed;
  }

  // id-match karke original text ko translated text se REPLACE karta hai.
  function v14ApplyTranslations(allPagesJsonArr, translations) {
    const map = {};
    translations.forEach(t => {
      if (t && t.id && typeof t.translated_text === 'string' && t.translated_text.trim().length > 0) {
        map[t.id] = t.translated_text.trim();
      }
    });
    let replacedCount = 0;
    const result = allPagesJsonArr.map(b => {
      if (b.id && map[b.id] !== undefined) {
        replacedCount++;
        return Object.assign({}, b, { text: map[b.id] });
      }
      return b;
    });
    return { blocks: result, replacedCount: replacedCount };
  }

  // ---- MHT (MIME-HTML) BUILDER (v14 exact) ----
  // Word "Single File Web Page" isi format me save karta hai:
  //   multipart/related ├─ HTML (base64 utf-8) ├─ har page image apne
  //   Content-Location ke saath. <v:imagedata src> ka URL part ke
  //   Content-Location se EXACT match hona zaroori hai.
  function v14Wrap76(b64) {
    return b64.replace(/(.{76})/g, '$1\r\n');
  }

  function v14BuildMhtDocument(html, images) {
    const boundary = '----=_NextPart_LEXORA_001';
    // UTF-8 safe base64 (Arabic/Unicode text ke liye zaroori)
    const htmlB64 = btoa(unescape(encodeURIComponent(html)));

    let mht =
      'MIME-Version: 1.0\r\n' +
      'Content-Type: multipart/related; type="text/html"; boundary="' + boundary + '"\r\n' +
      '\r\n' +
      '--' + boundary + '\r\n' +
      'Content-Type: text/html; charset="utf-8"\r\n' +
      'Content-Transfer-Encoding: base64\r\n' +
      'Content-Location: file:///C:/fake/document.html\r\n' +
      '\r\n' +
      v14Wrap76(htmlB64) + '\r\n' +
      '\r\n';

    for (const img of images) {
      mht +=
        '--' + boundary + '\r\n' +
        'Content-Type: ' + img.mime + '\r\n' +
        'Content-Transfer-Encoding: base64\r\n' +
        'Content-Location: ' + img.location + '\r\n' +
        '\r\n' +
        v14Wrap76(img.base64) + '\r\n' +
        '\r\n';
    }
    mht += '--' + boundary + '--';
    return mht;
  }

  // data:image/png;base64,XXXX → {mime, base64} (MHT part ke liye)
  function v14ParseDataUrl(dataUrl) {
    const m = /^data:(image\/[a-z0-9+.-]+);base64,([\s\S]*)$/i.exec(dataUrl);
    if (!m) return null;
    return { mime: m[1], base64: m[2] };
  }

  // ---- SINGLE PAGE -> VML/HTML (v14 exact) ----
  function v14GenerateSinglePageWord(pageJson, imgDims, pageNum, hasBgImage) {
    if (!Array.isArray(pageJson) || pageJson.length === 0) {
      throw new Error('Page JSON must be a non-empty array.');
    }

    const imgW = (imgDims && imgDims.width) || 816;
    const imgH = (imgDims && imgDims.height) || 1056;
    const MAX_PAGE_PX = 22 * 96;
    const scale = Math.min(1, MAX_PAGE_PX / imgW, MAX_PAGE_PX / imgH);
    const pageWpx = Math.round(imgW * scale);
    const pageHpx = Math.round(imgH * scale);

    let textboxesHtml = '';

    for (let i = 0; i < pageJson.length; i++) {
      const item = pageJson[i];

      const text = String(item.text || '').trim();
      const x = (parseFloat(item.x) || 0) * scale;
      const y = (parseFloat(item.y) || 0) * scale;
      const boxWidth = (parseFloat(item.width) || 50) * scale;
      const boxHeight = (parseFloat(item.height) || 20) * scale;

      const isArabic = /[\u0600-\u06FF]/.test(text);
      const styleStr = String(item.style || 'normal').toLowerCase();
      const isBold = styleStr.indexOf('bold') !== -1;
      const isItalic = styleStr.indexOf('italic') !== -1;

      const result = v14FindSmartFontSize(text, boxWidth, boxHeight, isBold);
      const optimalFontSize = result.fontSize;
      // Clipping fix: if even the readable-floor font size doesn't fit
      // the box, let the (small) excess spill past the box edge instead
      // of clipping it - a slightly-overflowing complete line beats a
      // perfectly-boxed one that's silently missing its last character
      // (this is what showed up as "comma/full-stop galat aa raha he").
      const overflowCss = result.overflowed ? 'overflow:visible;' : 'overflow:hidden;text-overflow:clip;';

      const padding = 2;

      const dir = (item.direction === 'rtl' || item.direction === 'ltr') ? item.direction : (isArabic ? 'rtl' : 'ltr');
      const color = v14IsValidHexColor(item.color) ? item.color : '#000000';
      const align = String(item.align || '').toLowerCase();
      let tdAlign, justifyCss;
      if (align === 'center') {
        tdAlign = 'center';
        justifyCss = 'text-align:center;';
      } else if (align === 'left') {
        tdAlign = 'left';
        justifyCss = 'text-align:left;';
      } else if (align === 'right') {
        tdAlign = 'right';
        justifyCss = 'text-align:right;';
      } else {
        tdAlign = 'distribute';
        justifyCss = 'text-align:distribute;text-justify:distribute-all-lines;mso-text-justify:distribute-all-lines;';
      }

      const fontWeightCss = isBold ? 'font-weight:bold;' : '';
      const fontStyleCss = isItalic ? 'font-style:italic;' : '';

      const shapeId = `Textbox_p${pageNum}_${i}`;

      textboxesHtml += `
          <v:shape id="${shapeId}" 
              type="#_x0000_t202" 
              style="position:absolute;left:${x.toFixed(1)}px;top:${y.toFixed(1)}px;width:${boxWidth.toFixed(1)}px;height:${boxHeight.toFixed(1)}px;mso-position-horizontal:absolute;mso-position-vertical:absolute;z-index:1;"
              fillcolor="white" 
              stroked="f"
              o:allowincell="f">
              <v:fill opacity="0"/>
              <v:textbox style="mso-fit-shape-to-text:f;mso-next-textbox:auto;mso-textbox-vertical-align:middle;" inset="0,0,0,0">
                  <table width="100%" height="100%" cellpadding="0" cellspacing="0" border="0" style="border:none;border-collapse:collapse;table-layout:fixed;">
                      <tr>
                          <td align="${tdAlign}" valign="middle" 
                              style="font-family:Arial;font-size:${optimalFontSize}pt;color:${color};${fontWeightCss}${fontStyleCss}padding:${padding}px;border:none;
                                     white-space:nowrap;word-wrap:normal;${overflowCss}
                                     direction:${dir};unicode-bidi:embed;
                                     ${justifyCss}">
                              <p style="margin:0;padding:0;line-height:normal;${justifyCss}">${v14EscapeHtml(text)}</p>
                          </td>
                      </tr>
                  </table>
              </v:textbox>
          </v:shape>
      `;
    }

    // --- IMAGE (MHT-compatible) ---
    // Word HTML .doc me data:image base64 URI KAAM NAHI KARTA — src me
    // sirf REFERENCE (file:///C:/fake/imageN.png); asli base64 MHT ke
    // alag MIME part me jata hai jiska Content-Location isse match karta hai.
    let imageHtml = '';
    if (hasBgImage) {
      imageHtml = `
          <v:shape id="PageImage_${pageNum}" 
              type="#_x0000_t75" 
              style="position:absolute;left:0;top:0;width:${pageWpx}px;height:${pageHpx}px;z-index:0;mso-position-horizontal:absolute;mso-position-vertical:absolute;"
              fillcolor="white" 
              stroked="f">
              <v:imagedata src="file:///C:/fake/image${pageNum}.png" />
          </v:shape>
      `;
    }

    const pageBreakStyle = (pageNum > 1) ? 'page-break-before:always;mso-page-break-before:always;' : '';

    return `
        <div class="Section${pageNum}" style="position:relative;width:${pageWpx}px;height:${pageHpx}px;margin:0;padding:0;background:white;${pageBreakStyle}">
            ${imageHtml}
            ${textboxesHtml}
        </div>
    `;
  }

  // ---- FINAL WORD DOCUMENT (v14 exact) ----
  function v14BuildFinalWordDocument(pageHtmls, imgDims, totalPages) {
    const imgW = (imgDims && imgDims.width) || 816;
    const imgH = (imgDims && imgDims.height) || 1056;
    const MAX_PAGE_PX = 22 * 96;
    const scale = Math.min(1, MAX_PAGE_PX / imgW, MAX_PAGE_PX / imgH);
    const pageWpx = Math.round(imgW * scale);
    const pageHpx = Math.round(imgH * scale);
    const pageWin = (pageWpx / 96).toFixed(3);
    const pageHin = (pageHpx / 96).toFixed(3);

    let pageRules = '';
    for (let i = 1; i <= totalPages; i++) {
      pageRules += `
          @page Section${i} {
              size: ${pageWin}in ${pageHin}in;
              margin: 0in 0in 0in 0in;
              mso-header-margin: 0in;
              mso-footer-margin: 0in;
              mso-title-page: no;
              mso-header: none;
              mso-footer: none;
              mso-paper-source: 0;
          }
          div.Section${i} { page: Section${i}; }
      `;
    }

    return `<!DOCTYPE html>
    <html xmlns:v="urn:schemas-microsoft-com:vml" 
          xmlns:o="urn:schemas-microsoft-com:office:office" 
          xmlns:w="urn:schemas-microsoft-com:office:word" 
          xmlns="http://www.w3.org/TR/REC-html40">
    <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
        
        <!--[if gte mso 9]>
        <xml>
            <w:WordDocument>
                <w:View>Print</w:View>
                <w:Zoom>100</w:Zoom>
                <w:DoNotOptimizeForBrowser/>
                <w:DoNotShadeFormData/>
                <w:DisplayHorizontalDrawingGridEvery>0</w:DisplayHorizontalDrawingGridEvery>
                <w:DisplayVerticalDrawingGridEvery>0</w:DisplayVerticalDrawingGridEvery>
            </w:WordDocument>
        </xml>
        <![endif]-->

        <style>
            ${pageRules}

            @page {
                margin: 0cm 0cm 0cm 0cm;
                mso-page-orientation: portrait;
            }

            html, body {
                margin: 0cm !important;
                padding: 0cm !important;
                background: white;
                background-image: none !important;
            }

            v\\:shape {
                behavior: url(#default#VML);
                display: inline-block;
            }
            v\\:textbox {
                behavior: url(#default#VML);
            }

            v\\:shape, v\\:textbox, table, td {
                border: none !important;
            }

            table {
                border-collapse: collapse;
            }
            td {
                white-space: nowrap !important;
                word-wrap: normal !important;
                overflow: hidden;
                text-overflow: clip;
            }
            td p {
                margin: 0;
                padding: 0;
                line-height: normal;
            }

            div, p, span, br {
                margin: 0;
                padding: 0;
                line-height: 1;
            }
        </style>
    </head>
    <body style="margin:0cm;padding:0cm;background:white;">
        ${pageHtmls.join('\n')}
    </body>
    </html>`;
  }

  // ---- HYBRID ENTRY (public API same: (file, opts, logFn) -> Blob) ----
  // opts: { withImage, cleanImage, targetLang, model? }
  // Output ab MHT-format Word document hai — .doc extension (docx zip nahi).
  async function buildHybridDocxBlob(file, opts, logFn) {
    if (typeof logFn === 'function') _log = logFn;
    opts = opts || {};
    const model = opts.model || (window.COMPANY_INFO && window.COMPANY_INFO.textExtractionModel) || 'google/gemini-2.5-flash';
    const cleanModel = opts.cleanModel || (window.COMPANY_INFO && window.COMPANY_INFO.imageCleaningModel) || 'google/gemini-3.1-flash-image';
    const withImage = true;   // image is always kept behind the text now
    const targetLang = opts.targetLang || 'original';
    const keepOriginal = !targetLang || String(targetLang).toLowerCase() === 'original';
    if (typeof pdfjsLib === 'undefined') throw new Error('pdf.js failed to load');

    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    _newAbort();   // fresh AbortController is run ke liye

    // 1) PDF -> images (v14: scale 2.0, PNG)
    const images = await v14PdfToImages(pdf);
    const totalPages = images.length;
    if (totalPages === 0) throw new Error('This PDF has no pages.');

    let allPagesJson = [];
    let pageDims = null;
    const pageBackgrounds = {};   // pageNum -> {bgDataUrl, bgIsCleaned}
    const pageErrors = [];
    let stoppedEarly = false;
    // Once any page in this document needs the 32000-token retry, start
    // every later page there directly too - pages from the same document
    // tend to share similar structural density (same table layout,
    // same bilingual content), so the 16000-token attempt is very likely
    // wasted on them as well.
    let sharedStartTokens = 16000;

    // 2) per-page: [Clean Image] -> OCR — v14 ki tarah SEQUENTIAL
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const pageNum = i + 1;
      const callsBefore = snapshotApiCalls();
      let pageTextCount = 0;
      let pageOk = false;

      if (_shouldStop()) { abortVision(); stoppedEarly = true; break; }

      try {
        // ═══ CALL 1: OCR/JSON (now FIRST) ═══
        // Clean Image is no longer a separate AI call. We OCR first to
        // get every text block's exact bounding box, then (if Clean Image
        // is on) paint white over those exact boxes deterministically -
        // same reliable approach as Text-based mode. The old AI clean-
        // image call was verified to leave the original text fully intact
        // on dense pages, and it cost an extra API call per page.
        emit({ type: 'page_start', page: pageNum, totalPages: images.length });
        const result = await v14ProcessSingleImage(model, img.dataUrl, img.width, img.height, pageNum, sharedStartTokens);
        if (result.startTokensNeeded > sharedStartTokens) sharedStartTokens = result.startTokensNeeded;
        let currentJson = result.blocks;
        const pageHasVisualBg = !!result.hasVisualBackground;

        if (!pageDims) pageDims = { width: img.width, height: img.height };

        // Image is always kept behind the text. Cleaning method is decided
        // per page from the OCR's has_visual_background flag:
        //  - real background (logo/seal/photo/texture) -> AI clean (removes
        //    text, keeps graphics), with local-paint fallback if it fails
        //  - plain text page -> deterministic local paint (reliable, free)
        let bgDataUrl = img.dataUrl;
        let bgIsCleaned = false;
        if (currentJson.length > 0) {
          if (pageHasVisualBg) {
            try {
              log('P' + pageNum + ': page has a visual background — AI-cleaning (' + cleanModel + ')...');
              bgDataUrl = await v14CleanImageAI(cleanModel, img.dataUrl);
              bgIsCleaned = true;
              log('P' + pageNum + ': background AI-cleaned (graphics preserved)');
            } catch (cleanErr) {
              if (_shouldStop()) { abortVision(); stoppedEarly = true; break; }
              log('P' + pageNum + ': AI clean failed (' + cleanErr.message + ') — falling back to local paint', 'warn');
              try {
                bgDataUrl = await v14PaintOverTextBoxes(img.dataUrl, currentJson);
                bgIsCleaned = true;
                log('P' + pageNum + ': background cleaned via local paint (' + currentJson.length + ' region(s))');
              } catch (paintErr) {
                log('P' + pageNum + ': local paint also failed (' + paintErr.message + ') — using ORIGINAL image', 'warn');
                bgDataUrl = img.dataUrl;
              }
            }
          } else {
            try {
              bgDataUrl = await v14PaintOverTextBoxes(img.dataUrl, currentJson);
              bgIsCleaned = true;
              log('P' + pageNum + ': background cleaned via local paint (' + currentJson.length + ' region(s))');
            } catch (paintErr) {
              log('P' + pageNum + ': local paint failed (' + paintErr.message + ') — using ORIGINAL image', 'warn');
              bgDataUrl = img.dataUrl;
            }
          }
        }

        if (_shouldStop()) { abortVision(); stoppedEarly = true; break; }

        // translation step ko guaranteed unique id chahiye
        currentJson = currentJson.map((b, idx) => Object.assign({}, b, {
          id: b.id || ('pg' + pageNum + '_b' + idx),
          page: pageNum
        }));

        allPagesJson = allPagesJson.concat(currentJson);
        pageBackgrounds[pageNum] = { bgDataUrl: bgDataUrl, bgIsCleaned: bgIsCleaned };

        log('P' + pageNum + ': ' + currentJson.length + ' line-boxes' + (bgIsCleaned ? ' (cleaned background)' : (withImage ? ' (with image)' : '')));
        pageTextCount = currentJson.length;
        pageOk = true;
      } catch (err) {
        if (_shouldStop()) { abortVision(); stoppedEarly = true; break; }
        // ek page fail se poora run mat girao — record karke aage badho
        // (v14 behaviour), lekin chup mat raho.
        pageErrors.push({ page: pageNum, message: err.message });
        log('P' + pageNum + ' FAILED: ' + err.message + ' — continuing with the next page', 'error');
      }

      const callsAfter = snapshotApiCalls();
      emit({
        type: 'page',
        page: pageNum,
        totalPages: totalPages,
        jsonCalls: callsAfter.json - callsBefore.json,
        imageCalls: callsAfter.image - callsBefore.image,
        textData: pageTextCount,
        ok: pageOk
      });

      log('Vision OCR: ' + pageNum + '/' + totalPages + ' pages');

      // v14: pages ke beech chhota gap
      if (pageNum < totalPages && !_shouldStop()) {
        await new Promise(function (resolve) { setTimeout(resolve, 500); });
      }
    }

    if (allPagesJson.length === 0) {
      if (stoppedEarly) throw new Error('Process was stopped — no page completed');
      const errorList = pageErrors.map(function (e) { return 'Page ' + e.page + ': ' + e.message; }).join('; ');
      throw new Error('No text was detected — 0 textboxes. ' + (errorList || 'Check the console (F12).'));
    }
    if (stoppedEarly) log('Stop requested — partial output up to ' + Object.keys(pageBackgrounds).length + '/' + totalPages + ' pages');
    if (pageErrors.length) log('WARNING: page(s) ' + pageErrors.map(function (e) { return e.page; }).join(', ') + ' skipped', 'warn');

    // 3) ═══ CALL 3: TRANSLATION — sirf EK baar, POORE document ke liye ═══
    if (!keepOriginal && !_shouldStop()) {
      const updBefore = snapshotApiCalls();
      try {
        log('[Final Call] Translating the whole document to ' + targetLang + ' (detecting document type + tone)...');
        const translationResult = await v14TranslateAllPages(model, allPagesJson, targetLang);
        const applied = v14ApplyTranslations(allPagesJson, translationResult.translations);
        allPagesJson = applied.blocks;
        log('Translation: ' + applied.replacedCount + ' line(s) translated');
        log('Document type: "' + translationResult.document_type + '", Domain: "' + (translationResult.domain || 'n/a') +
            '", Source region: "' + (translationResult.source_region || 'n/a') +
            '", Target variant: "' + (translationResult.target_variant || 'n/a') +
            '", Tone/era: "' + translationResult.era_tone + '"');
      } catch (translateErr) {
        if (_shouldStop()) {
          log('Stop requested — translation cancelled, output uses the ORIGINAL text', 'warn');
        } else {
          log('Translation failed (' + translateErr.message + ') — building the document with the ORIGINAL text', 'warn');
        }
      }
      const updAfter = snapshotApiCalls();
      emit({
        type: 'update',
        jsonCalls: updAfter.json - updBefore.json,
        imageCalls: updAfter.image - updBefore.image,
        textData: allPagesJson.length
      });
    }

    // 4) FINAL TEXT (translated ya original) se har page ka HTML + MHT images
    const allPageHtmls = [];
    const mhtImages = [];
    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      const pageBlocks = allPagesJson.filter(function (b) { return (Number(b.page) || 1) === pageNum; });
      if (pageBlocks.length === 0) continue;

      const bg = pageBackgrounds[pageNum] || {};
      const pageHtml = v14GenerateSinglePageWord(pageBlocks, pageDims, pageNum, !!(withImage && bg.bgDataUrl));
      allPageHtmls.push(pageHtml);

      if (withImage && bg.bgDataUrl) {
        const parsedImg = v14ParseDataUrl(bg.bgDataUrl);
        if (parsedImg) {
          mhtImages.push({
            location: 'file:///C:/fake/image' + pageNum + '.png',
            mime: parsedImg.mime,
            base64: parsedImg.base64
          });
        } else {
          log('P' + pageNum + ': dataUrl failed to parse — this page\'s image will not appear in the document', 'warn');
        }
      }
    }

    const finalDoc = v14BuildFinalWordDocument(allPageHtmls, pageDims, totalPages);
    // Images hain to MHT container me pack karo (warna plain HTML) —
    // extension .doc hi rehta hai, Word MHT natively kholta hai.
    const finalOut = mhtImages.length > 0 ? v14BuildMhtDocument(finalDoc, mhtImages) : finalDoc;

    log('Word document ready: ' + allPageHtmls.length + ' page(s), ' + allPagesJson.length + ' textboxes');
    return new Blob([finalOut], { type: 'application/msword' });
  }

  async function translateTexts(apiKey, model, texts, targetLang, pageType){
    if (!texts.length) return texts;
    const prompt =
`The JSON array below contains OCR'd lines from a document — treat this OCR text as FROZEN/IMMUTABLE. You are ONLY translating it into ${targetLang}, not re-reading, correcting, or improving it. These lines are individual and out of context, possibly fragmentary.

Rules:
- Translate literally, staying as close to the source wording and word order as ${targetLang} grammar allows. Do not summarize, paraphrase, expand, or produce a smoother/more fluent rewrite than the source supports.
- Every source word/token should have a corresponding translated token — do not silently omit or merge words.
- You are forbidden from "fixing" apparent OCR mistakes. If a source line looks broken or incomplete, translate it as-is (broken/incomplete) rather than completing it into a full sentence.
- Translate each line LITERALLY and independently. Never substitute a semantic paraphrase, summary, or "improved" version for the literal text. Transliterate proper names and domain terms that have no established ${targetLang} equivalent.
${pageType ? '- Document page context (auto-detected from this page itself, not assumed for the whole document): "' + pageType + '". Match the register, terminology, formality and tone appropriate to exactly this kind of page.' : ''}
- Proper names, personal names, botanical/medical/Latin names, and historical/technical terms with no established ${targetLang} equivalent must be transliterated, not translated or replaced with a generic description.
- If a source line contains the character □ (marking an illegible OCR character), preserve □ at the corresponding position in the output — do not remove it or guess what it represents.
- Return ONLY a JSON array, same length and same order as the input, where each element is an object {"s": exact unmodified copy of the source line, "t": its ${targetLang} translation}. The "s" field must be character-identical to the input line — it is used to verify alignment. No explanation, no markdown fences, no other keys.

${JSON.stringify(texts)}`;

    const body = { model: model, temperature: 0, max_tokens: 12000,
      messages: [{ role: 'user', content: prompt }] };

    for (let attempt = 1; attempt <= 2; attempt++){
      let resp;
      try { resp = await _visionFetch(body); }
      catch (netErr) { if (_shouldStop()) return texts; throw netErr; }
      if (!resp.ok){
        const t = await resp.text();
        throw new Error('OpenRouter translate HTTP ' + resp.status + ': ' + t.slice(0, 300));
      }
      const data = await resp.json();
      let raw = (data.choices && data.choices[0] && data.choices[0].message.content) || '';
      raw = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
      const a = raw.indexOf('['), b = raw.lastIndexOf(']');
      if (a !== -1 && b > a) raw = raw.slice(a, b + 1);
      try {
        let arr = null;
        try {
          arr = JSON.parse(raw);
        } catch (pe) {
          // SALVAGE: poora JSON toota (ek line ka malformed {s,t} object) —
          // individual objects regex se nikaalo taaki poore page ki
          // translation na jaye. (page 2 ka "parse fail" issue ka fix)
          const objs = raw.match(/\{[^{}]*"t"\s*:[^{}]*\}/g);
          if (objs && objs.length){
            const salv = [];
            objs.forEach(function(o){ try { salv.push(JSON.parse(o)); } catch (e2){ salv.push(null); } });
            if (salv.length){ arr = salv; log('Translation: JSON partial tha — ' + salv.filter(Boolean).length + ' line(s) salvage ki', 'warn'); }
          }
          if (!arr) throw pe;
        }
        // length mismatch par bhi kaam chalao: jitne mile utne map karo,
        // baaki original (poora page mat girao)
        if (!Array.isArray(arr)) throw new Error('not an array');
        if (arr.length !== texts.length){
          log('Translation: ' + arr.length + '/' + texts.length + ' line(s) aaye — baaki original rakhe', 'warn');
        }
        let misaligned = 0;
        const out = texts.map(function(srcTxt, i){
          const m = arr[i];
          if (m == null) return texts[i];
          if (typeof m === 'string') return m === '' ? texts[i] : m; // fallback: plain string array bhi chalega
          const s = (m.s == null) ? '' : String(m.s);
          const t = (m.t == null) ? '' : String(m.t);
          // echo verification: agar model ne source galat quote kiya to us
          // line par alignment bharosemand nahi — original text rakho
          if (s.trim() !== String(texts[i]).trim()){ misaligned++; return texts[i]; }
          return t === '' ? texts[i] : t;
        });
        if (misaligned) log('Translation: ' + misaligned + ' line(s) echo-mismatch — original kept', 'warn');
        // Per-line debug hataya (activity log flood karta tha). Sirf summary.
        log('Translation: ' + out.length + ' line(s) translated', 'ok');
        return out;
      } catch (e){
        if (_shouldStop()) return texts;   // stop: original rakho, dobara call mat karo
        if (attempt === 2){
          log('Translation parse fail, keeping original text for this page: ' + e.message, 'warn');
          return texts; // fail-safe: don't lose content, just skip translation for this page
        }
      }
    }
  }

  async function translateLinesInPlace(apiKey, model, lines, targetLang){
    const texts = lines.map(function(L){ return L.runs.map(function(r){ return r.text; }).join(''); });
    const translated = await translateTexts(apiKey, model, texts, targetLang, lines.pageType || '');
    lines.forEach(function(L, i){
      const t = translated[i] || texts[i];
      const base = L.runs[0] || { sizePt: 11, color: '000000', family: 'Arial' };
      L.runs = [{ text: t, sizePt: base.sizePt, bold: base.bold, italic: base.italic, color: base.color, family: base.family }];
      L.rtl = hasRTL(t);
      // NOTE: box width ab NAHI badhate — coordinate fidelity pehle; lamba
      // text layout-fit engine (autofitPage) font-scale/wrap se sambhalta hai
    });
  }

  window.buildHybridDocxBlob = buildHybridDocxBlob;
  window.setVisionAuthToken = setVisionAuthToken;
  window.setVisionStopCheck = setStopCheck;
  window.setPipelineEventHandler = setPipelineEventHandler;
  // Shared LLM access for other service modules (e.g. Data Extraction).
  // Everything still goes through the server proxy, so the API key never
  // reaches the browser, and calls are counted/abortable like the rest.
  window.lexoraProxyJson = v14ProxyJson;
  window.lexoraPdfToImages = v14PdfToImages;
  window.resetPipelineApiCounters = resetApiCalls;
  window.abortVision = abortVision;

    window.buildOfflineDocxBlob = buildOfflineDocxBlob;
})();
