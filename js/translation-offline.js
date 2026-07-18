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
  function log(m) { _log(m); }

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

    // ---- 3b. FINAL PAGE CLAMP (cascade ke BAAD) ----
    // Cascade B.yPt ko neeche dhakelta hai bina clamp ke, isliye boxes page
    // se bahar nikal jaate the (728pt page par y=821 -> text gayab). Ab
    // cascade ke baad har box ko page ke andar wapas laao.
    lines.forEach(function(L){
      if (L.yPt + L.hPt > pageH){
        L.yPt = Math.max(0, pageH - L.hPt);
        clamped++;
      }
      if (L.xPt + L.wPt > pageW){
        L.xPt = Math.max(0, pageW - L.wPt);
        clamped++;
      }
      if (L.yPt < 0){ L.yPt = 0; clamped++; }
      if (L.xPt < 0){ L.xPt = 0; clamped++; }
    });

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

  async function buildOfflineDocxBlob(file, logFn) {
    if (typeof logFn === 'function') _log = logFn;
    if (typeof pdfjsLib === 'undefined') throw new Error('pdf.js load nahi hua');
    if (typeof JSZip === 'undefined') throw new Error('JSZip load nahi hua');
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    let sampleItems = 0;
    for (let sp = 1; sp <= Math.min(2, pdf.numPages); sp++) {
      const tc0 = await (await pdf.getPage(sp)).getTextContent();
      sampleItems += tc0.items.filter(function (it) { return it.str && it.str.trim(); }).length;
    }
    if (sampleItems < 3)
      throw new Error('Ye PDF Scanned/Image-based lagti hai — offline (Hybrid off) mode sirf Text-based PDFs process karta hai. Hybrid enable karke retry karo.');
    const pages = [];
    let totalLines = 0;
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const vp1 = page.getViewport({ scale: 1 });
      let lines = await extractOfflinePage(page, vp1, p);
      if (lines.length) autofitPage(lines, vp1.width, vp1.height, p);
      totalLines += lines.length;
      pages.push({ lines: lines, wPt: vp1.width, hPt: vp1.height, jpegBase64: null });
      log('P' + p + ': ' + lines.length + ' text line(s) extracted (no API)');
    }
    if (totalLines === 0)
      throw new Error('Is PDF me koi selectable text nahi mila — offline mode sirf Text-based PDFs process karta hai');
    return buildDocx(pages, false);
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


  // detectCoordUnits — HTML se. coords ka scale pehchano (fraction/percent/permille/pixel)
  function detectCoordUnits(blocks){
    let maxVal = 0;
    for (const b of blocks){
      const l = parseFloat(b.left != null ? b.left : b.x) || 0;
      const t = parseFloat(b.top  != null ? b.top  : b.y) || 0;
      const w = parseFloat(b.width  != null ? b.width  : b.w) || 0;
      const h = parseFloat(b.height != null ? b.height : b.h) || 0;
      maxVal = Math.max(maxVal, l + w, t + h);
    }
    if (maxVal <= 1.5) return 'fraction';
    if (maxVal <= 110) return 'percent';
    if (maxVal <= 1010) return 'permille';
    return 'pixel';
  }

  // refineBlocksWithInk — HTML reference se verbatim core. Model ki approx
  // box lekar image ke ACTUAL ink pixels ko flood-fill se measure karta hai:
  // exact bounding box, color (median), font-size (= measured height * 0.8).
  // Isse coords/width/size/color guess se MEASUREMENT ban jaate hain.
  // Canvas-based (sync) — Image load nahi.
  function refineBlocksWithInk(srcCanvas, textBlocks){
    const W = srcCanvas.width, H = srcCanvas.height;
    const ctx = srcCanvas.getContext('2d');
    const d = ctx.getImageData(0, 0, W, H).data;
    const units = detectCoordUnits(textBlocks);
    const toPx = (v, total) =>
      units === 'fraction' ? v * total :
      units === 'percent'  ? v / 100 * total :
      units === 'permille' ? v / 1000 * total : v;
    const clampV = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

    return textBlocks.map(function(blk){
      const L = (blk.left != null ? blk.left : blk.x);
      const T = (blk.top  != null ? blk.top  : blk.y);
      const Wd= (blk.width  != null ? blk.width  : blk.w);
      const Ht= (blk.height != null ? blk.height : blk.h);
      const bx = toPx(parseFloat(L) || 0, W);
      const by = toPx(parseFloat(T) || 0, H);
      const bw = toPx(parseFloat(Wd) || 0, W);
      const bh = toPx(parseFloat(Ht) || 0, H);
      if (bw <= 0 || bh <= 0) return blk;

      const ex = Math.max(10, Math.round(bw * 0.05 + bh * 0.5));
      // vertical margin CHHOTA: manuscript me lines paas-paas hoti hain,
      // bada margin upar/neeche ki line ke ascender/descender pakad leta tha
      // (boxes 2-3x tall -> overlap -> cascade -> page se bahar).
      const ey = Math.max(2, Math.round(bh * 0.12));
      const x0 = clampV(Math.round(bx - ex), 0, W - 1);
      const y0 = clampV(Math.round(by - ey), 0, H - 1);
      const x1 = clampV(Math.round(bx + bw + ex), 0, W - 1);
      const y1 = clampV(Math.round(by + bh + ey), 0, H - 1);
      const ww = x1 - x0 + 1, wh = y1 - y0 + 1;
      if (ww < 4 || wh < 4) return blk;

      const ring = [];
      for (let x = x0; x <= x1; x++) ring.push((y0 * W + x) * 4, (y1 * W + x) * 4);
      for (let y = y0; y <= y1; y++) ring.push((y * W + x0) * 4, (y * W + x1) * 4);
      ring.sort((a, b) => (d[a]+d[a+1]+d[a+2]) - (d[b]+d[b+1]+d[b+2]));
      const mi = ring[ring.length >> 1];
      const bg = [d[mi], d[mi+1], d[mi+2]];

      const mask = new Uint8Array(ww * wh);
      let ink = 0;
      for (let y = 0; y < wh; y++){
        for (let x = 0; x < ww; x++){
          const idx = ((y0 + y) * W + (x0 + x)) * 4;
          if (Math.abs(d[idx]-bg[0]) + Math.abs(d[idx+1]-bg[1]) + Math.abs(d[idx+2]-bg[2]) > 60){
            mask[y * ww + x] = 1; ink++;
          }
        }
      }
      if (ink === 0 || ink / (ww * wh) > 0.6) return blk;

      const seen = new Uint8Array(ww * wh);
      const qx = new Int32Array(ww * wh), qy = new Int32Array(ww * wh);
      const seedX0 = bx - x0, seedY0 = by - y0;
      let tight = null;
      const colorSamples = [];
      for (let sy = 0; sy < wh; sy++){
        for (let sx = 0; sx < ww; sx++){
          if (mask[sy * ww + sx] && !seen[sy * ww + sx]){
            let qh = 0, qt = 0;
            qx[qt] = sx; qy[qt] = sy; qt++; seen[sy * ww + sx] = 1;
            let mnx = sx, mxx = sx, mny = sy, mxy = sy;
            const pts = [];
            while (qh < qt){
              const x = qx[qh], y = qy[qh]; qh++;
              pts.push(y * ww + x);
              if (x < mnx) mnx = x; if (x > mxx) mxx = x;
              if (y < mny) mny = y; if (y > mxy) mxy = y;
              const nb = [[x+1,y],[x-1,y],[x,y+1],[x,y-1]];
              for (const c of nb){
                const xx = c[0], yy = c[1];
                if (xx >= 0 && yy >= 0 && xx < ww && yy < wh && mask[yy*ww+xx] && !seen[yy*ww+xx]){
                  seen[yy*ww+xx] = 1; qx[qt] = xx; qy[qt] = yy; qt++;
                }
              }
            }
            const cw = mxx - mnx + 1, ch = mxy - mny + 1;
            const thin = ch <= 5 || cw <= 5;
            const huge = ch > 1.5 * Math.max(bh, 10);
            const intersects = !(mxx < seedX0 || mnx > seedX0 + bw || mxy < seedY0 || mny > seedY0 + bh);
            if (intersects && !thin && !huge){
              if (!tight) tight = [mnx, mxx, mny, mxy];
              else {
                tight[0] = Math.min(tight[0], mnx); tight[1] = Math.max(tight[1], mxx);
                tight[2] = Math.min(tight[2], mny); tight[3] = Math.max(tight[3], mxy);
              }
              const step = Math.max(1, Math.floor(pts.length / 50));
              for (let pi = 0; pi < pts.length; pi += step){
                const idx = ((y0 + Math.floor(pts[pi] / ww)) * W + (x0 + (pts[pi] % ww))) * 4;
                colorSamples.push([d[idx], d[idx+1], d[idx+2]]);
              }
            }
          }
        }
      }
      if (!tight) return blk;

      const mLeft = x0 + tight[0], mTop = y0 + tight[2];
      const mW = tight[1] - tight[0] + 1, mH = tight[3] - tight[2] + 1;

      // GUARD 1 — MERGED COMPONENT REJECT: measured box model se bahut bada
      // ho to flood-fill ne padosi line/border/illustration jod di hai.
      if (mH > bh * 1.5 || mW > bw * 1.5) return blk;

      const out = Object.assign({}, blk);
      // GUARD 2 — SIRF HORIZONTAL measurement lo (left + width). Text lines
      // horizontally alag hoti hain isliye start/end pixel reliable hai —
      // yahi user ka asli issue tha (width/position galat). VERTICAL (top/
      // height) model ka hi rakho: crowded manuscript lines me ink-measure
      // padosi line pakad leta tha -> 2-3x tall boxes -> overlap -> page
      // se bahar. Height layout/collision drive karti hai, isliye safe.
      out.left = mLeft / W * 1000;
      out.width = mW / W * 1000;
      // measured height sirf tab lo jab wo model ke kareeb ho (sanity)
      const mHp = mH / H * 1000, bHp = parseFloat(Ht) || 0;
      if (bHp > 0 && mHp <= bHp * 1.15) out.height = mHp;

      // GUARD 2 — FONT SIZE override NAHI. measured height me diacritics/
      // ascenders/descenders shamil hote hain, isliye height*0.8 bahut bada
      // font deta tha (41pt tak). Model ka font_size rakho; fit-to-box
      // (shrinkOverflow) waise bhi box ke hisaab se best-fit karta hai.

      // GUARD 3 — COLOR: median lene se scan ke anti-aliased edge pixels
      // (ink+paper blend) mid-tone muddy brown de rahe the. Ab CORE ink
      // pixels lo — darkest 25 percentile — aur sirf tab apply karo jab
      // wo background se saaf contrast rakhe. Warna model ka color.
      if (colorSamples.length >= 4){
        colorSamples.sort((a, b) => (a[0]+a[1]+a[2]) - (b[0]+b[1]+b[2]));
        const q = colorSamples[Math.floor(colorSamples.length * 0.25)];
        const bgLum = (bg[0] + bg[1] + bg[2]) / 3;
        const inkLum = (q[0] + q[1] + q[2]) / 3;
        // dark-on-light ya light-on-dark — dono me achha contrast chahiye
        if (Math.abs(bgLum - inkLum) > 70){
          out.color = q.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
        }
      }
      return out;
    });
  }

  async function extractApiPage(apiKey, model, dataUrl, wPt, hPt, pageNo, srcCanvas){
    // HTML reference ka DETAILED coordinate-detection prompt — pixel-by-pixel
    // exact start/end detect, width/height/align explicit. Isse coords/size
    // bahut behtar aate hain (aur phir refineBlocksWithInk se aur precise).
    const prompt =
`Return a single JSON object with exactly one top-level key named "text_blocks", whose value is an array of line objects (do NOT use any other key name like text_lines, textBlocks, or lines). Also include a top-level key "page_type" (one short sentence describing this page: document kind, subject, language/script, register — only guides translation tone).
Process the image line-by-line (row by row) from top to bottom, scanning pixel by pixel. For each row:
STEP 1 - DETECT TEXT START & END: When text is detected in a row, locate the exact start pixel (leftmost x-coordinate) and end pixel (rightmost x-coordinate) of that text segment. Group consecutive rows that contain the same text to form complete lines.
STEP 2 - ADD TO JSON: For every complete text line, add its data with these fields:
	1)top: vertical position on a normalized 0-1000 scale (0 = top edge, 1000 = bottom edge)
	2)left: horizontal position on a normalized 0-1000 scale (0 = left edge, 1000 = right edge)
	3)width: this line's bounding box width on the 0-1000 scale (exact start pixel to end pixel)
	4)height: this line's bounding box height on the 0-1000 scale
	5)font_size: this line's text height on the 0-1000 scale (relative to image height)
	6)color: hex color code (e.g., "000000", no #)
	7)style: "normal", "bold", "italic", or "bold italic"
	8)align: "left", "center", "right", or "justify"
	9)text: this line's exact text content (preserve original spelling/script, do NOT translate)

Important:
1)Process rows sequentially top to bottom
2)For each line, find the EXACT start pixel and end pixel of the text
3)ALL coordinates use the 0-1000 normalized scale, NOT pixels
4)Every line must have its own accurate font_size, style and color
5)Include EVERY text line (even small words, numbers, handwritten)
6)Preserve original text exactly (don't correct spelling), keep the □ character if a glyph is illegible`;

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
        // HTML schema: text_blocks with top/left/width/height/font_size (0-1000
        // permille), style, align. Fallbacks: purane lines/blocks bhi chalein.
        let arr = parsed.text_blocks || parsed.lines || parsed.blocks || parsed.text_lines;
        if (!Array.isArray(arr)) throw new Error('no text_blocks array');
        arr = arr.filter(L => L && L.text && String(L.text).trim());

        // INK REFINEMENT: model ke box ko actual image pixels se re-measure
        // karo (HTML ka refineBlocksWithInk). Ye box/size/color ko guess se
        // measurement banata hai — coords/width/font bahut precise ho jaate.
        if (srcCanvas) {
          try { arr = refineBlocksWithInk(srcCanvas, arr); }
          catch (re) { log('P' + pageNo + ' ink-refine skip: ' + re.message, 'warn'); }
        }

        // permille (0-1000) → absolute points
        const out = arr.map(function(L){
          const styleStr = String(L.style || '').toLowerCase();
          const bold = !!L.bold || styleStr.indexOf('bold') !== -1;
          const italic = !!L.italic || styleStr.indexOf('italic') !== -1;
          // font_size 0-1000 (image-height relative) OR legacy pt
          let fs;
          if (L.font_size != null) fs = (Number(L.font_size) / 1000) * hPt;
          else fs = Number(L.font_size_pt) || 11;
          fs = Math.max(4, Math.min(96, fs));
          const left = (L.left != null ? L.left : L.x) || 0;
          const top  = (L.top  != null ? L.top  : L.y) || 0;
          const w    = (L.width  != null ? L.width  : L.w) || 0;
          const h    = (L.height != null ? L.height : L.h) || 0;
          return {
            xPt: (left / 1000) * wPt,
            yPt: (top / 1000) * hPt,
            wPt: Math.max(fs * 0.5, (w / 1000) * wPt),
            hPt: Math.max(fs, (h / 1000) * hPt),
            align: (L.align || '').toLowerCase(),
            rtl: hasRTL(L.text),
            runs: [{
              text: String(L.text).replace(/\n/g, ' '),
              sizePt: fs,
              bold: bold, italic: italic,
              color: /^#?[0-9a-fA-F]{6}$/.test(L.color || '') ? String(L.color).replace('#','') : '000000',
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
  async function buildHybridDocxBlob(file, opts, logFn) {
    if (typeof logFn === 'function') _log = logFn;
    opts = opts || {};
    // apiKey ab server proxy (.env) se lagti hai — browser me nahi
    const apiKey = 'proxy';
    const model = opts.model || 'google/gemini-2.5-flash';
    const withImage = !!opts.withImage;
    const targetLang = opts.targetLang || 'original';
    const keepOriginal = !targetLang || String(targetLang).toLowerCase() === 'original';
    if (typeof pdfjsLib === 'undefined') throw new Error('pdf.js load nahi hua');
    if (typeof JSZip === 'undefined') throw new Error('JSZip load nahi hua');

    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    // Bug 7 SPEED: With Image OFF -> pages parallel (fast, koi image call
    // nahi to order matter nahi karta). With Image ON -> sequential (1),
    // taaki har page ka Gemini background apne page ke turant baad bane
    // aur stop-safe rahe. Sequence har haal me preserve (OCR->translate
    // ->image per page andar sequential hi hai).
    const CONCURRENCY = withImage ? 1 : 3;
    const pageNums = Array.from({ length: pdf.numPages }, function (_, i) { return i + 1; });
    _newAbort();   // fresh AbortController is run ke liye

    const pages = await mapWithConcurrency(pageNums, CONCURRENCY, async function (p) {
      // STOP: is page ka koi API call mat karo — abort + skip
      if (_shouldStop()) { abortVision(); return { lines: [], wPt: 0, hPt: 0, jpegBase64: null, skipped: true }; }
      try {
      const page = await pdf.getPage(p);
      const vp1 = page.getViewport({ scale: 1 });
      // render page to canvas (vision + optional background)
      const scale = Math.min(3.0, 3000 / Math.max(vp1.width, vp1.height));
      const vp = page.getViewport({ scale: scale });
      const rawCanvas = document.createElement('canvas');
      rawCanvas.width = Math.round(vp.width); rawCanvas.height = Math.round(vp.height);
      await page.render({ canvasContext: rawCanvas.getContext('2d'), viewport: vp }).promise;
      const jpegBase64 = withImage ? rawCanvas.toDataURL('image/jpeg', 0.96).split(',')[1] : null;

      const ocrDataUrl = rawCanvas.toDataURL('image/jpeg', 0.92);
      let lines = await extractApiPage(apiKey, model, ocrDataUrl, vp1.width, vp1.height, p, rawCanvas);

      // STOP: OCR ke baad translate call se pehle dobara check — extra call bachao
      if (_shouldStop()) { abortVision(); return { lines: lines, wPt: vp1.width, hPt: vp1.height, jpegBase64: withImage ? jpegBase64 : null }; }

      if (!keepOriginal && lines.length) {
        // OCR aur translation ALAG — pehle OCR ho chuka, ab translate.
        // Translation ke baad text lamba ho sakta hai -> autofit zaroori.
        await translateLinesInPlace(apiKey, model, lines, targetLang);
        if (lines.length) autofitPage(lines, vp1.width, vp1.height, p);
      }
      // NO-TRANSLATION (Box-tool parity): autofit NAHI — box size/coords
      // bilkul vision-model ke diye jaise rehte hain, exact clarity.
      // NO-TRANSLATION: box position/size exact — sirf overflow par font shrink
      if (keepOriginal && lines.length) shrinkOverflow(lines);

      // WITH IMAGE: text ko page image se cv2 inpaint se hata do — cleaned
      // image background banega (text-boxes uske upar). lines pt-coords ko
      // rendered-image px me convert karke server ko bhejte hain.
      let bgBase64 = withImage ? jpegBase64 : null;
      if (withImage && jpegBase64 && lines.length && !_shouldStop()) {
        try {
          const textLines = lines.filter(function (L) {
            return L.runs && L.runs.some(function (r) { return r.text && r.text.trim(); });
          });
          const boxesPx = textLines.map(function (L) {
            return { x: L.xPt * scale, y: L.yPt * scale, w: L.wPt * scale, h: L.hPt * scale };
          });
          // Gemini prompt me exact extracted text — taaki wo pehchan kar
          // sirf wahi hataye aur aas-paas se predict karke fill kare.
          const texts = textLines.map(function (L) {
            return L.runs.map(function (r) { return r.text; }).join('');
          });
          const resp = await _inpaintFetch(jpegBase64, boxesPx, texts);
          if (resp.ok) {
            const j = await resp.json();
            if (j && j.imageBase64) {
              bgBase64 = j.imageBase64;
              if (j.prompt) log('P' + p + ' image-edit prompt: ' + j.prompt);
              log('P' + p + ': background text removed (' + (j.method || 'edit') + ')');
            }
          } else {
            log('P' + p + ': inpaint skip (server) — original image use hogi', 'warn');
          }
        } catch (e) {
          if (!_shouldStop()) log('P' + p + ': inpaint fail — original image: ' + e.message, 'warn');
        }
      }
      log('P' + p + ': ' + lines.length + ' line-boxes' + (keepOriginal ? ' (OCR only, exact boxes)' : ' (OCR+translate)'));
      return { lines: lines, wPt: vp1.width, hPt: vp1.height, jpegBase64: bgBase64 };
      } catch (pageErr) {
        // stop ke wajah se abort -> skipped (partial output me ignore).
        if (_shouldStop()) return { lines: [], wPt: 0, hPt: 0, jpegBase64: null, skipped: true };
        // asli failure (stop nahi): ek page fail se pura run mat girao, LEKIN
        // chup mat skip karo — visible error + failed-page record.
        log('P' + p + ' FAILED: ' + pageErr.message + ' — is page ka text nahi aaya', 'error');
        return { lines: [], wPt: 0, hPt: 0, jpegBase64: null, failed: true, pageNo: p };
      }
    }, function (done, total) {
      log('Vision OCR: ' + done + '/' + total + ' pages');
    });

    // Partial output: skipped (stop) / failed / empty pages nikaal do.
    const usable = pages.filter(function (pg) { return !pg.skipped && !pg.failed && pg.lines.length; });
    const failedPages = pages.filter(function (pg) { return pg.failed; }).map(function (pg) { return pg.pageNo; });
    if (_shouldStop()) log('Stop requested — ' + usable.length + '/' + pdf.numPages + ' pages tak ka partial output');
    if (failedPages.length) log('WARNING: page(s) ' + failedPages.join(', ') + ' could not be processed (vision returned no text) — output has ' + usable.length + '/' + pdf.numPages + ' page(s)', 'error');
    // PER-PAGE CONFIRMATION: user ko har page ka result clear pata chale.
    // successfully-processed page numbers explicitly list karo.
    const okPages = pages.filter(function (pg) { return !pg.skipped && !pg.failed && pg.lines.length; })
                         .map(function (pg, i) { return i + 1; });
    log('Pages processed: ' + usable.length + '/' + pdf.numPages +
        (failedPages.length ? ' (failed: ' + failedPages.join(', ') + ')' : ' — all pages OK'), failedPages.length ? 'warn' : 'ok');
    const totalLines = usable.reduce(function (s, pg) { return s + pg.lines.length; }, 0);
    if (totalLines === 0) throw new Error(_shouldStop() ? 'Process stop kiya gaya — koi page complete nahi hua' : 'Kisi bhi page se text nahi aaya — vision model ne kuch nahi padha');
    return buildDocx(usable, withImage);
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
  window.abortVision = abortVision;

    window.buildOfflineDocxBlob = buildOfflineDocxBlob;
})();
