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
  // ==== HTML-PARITY PORT (Cordinates___Font_Size.html se verbatim) ====
  // normalizeBlock: permille/percent/fraction/pixel -> dst POINTS space.
  // HTML VERBATIM (autoCleanImage): scan ke border/margin auto-crop.
  // "content" pixel = koi bhi channel < 250. bottom/right par +1 padding.
  function autoCleanImageCanvas(srcCanvas){
    const W = srcCanvas.width, H = srcCanvas.height;
    const d = srcCanvas.getContext('2d').getImageData(0, 0, W, H).data;
    const hit = (i) => (d[i] < 250 || d[i+1] < 250 || d[i+2] < 250);
    let top = 0, bottom = H, left = 0, right = W, found = false;
    for (let y = 0; y < H; y++){ let h=false;
      for (let x = 0; x < W; x++){ if (hit((y*W+x)*4)){ h=true; break; } }
      if (h){ top = y; found = true; break; } }
    for (let y = H-1; y >= 0; y--){ let h=false;
      for (let x = 0; x < W; x++){ if (hit((y*W+x)*4)){ h=true; break; } }
      if (h){ bottom = y; break; } }
    for (let x = 0; x < W; x++){ let h=false;
      for (let y = 0; y < H; y++){ if (hit((y*W+x)*4)){ h=true; break; } }
      if (h){ left = x; break; } }
    for (let x = W-1; x >= 0; x--){ let h=false;
      for (let y = 0; y < H; y++){ if (hit((y*W+x)*4)){ h=true; break; } }
      if (h){ right = x; break; } }
    if (found){ top = Math.max(0, top); left = Math.max(0, left);
      bottom = Math.min(H, bottom + 1); right = Math.min(W, right + 1); }
    const nw = right - left, nh = bottom - top;
    if (nw <= 0 || nh <= 0) return srcCanvas;
    const out = document.createElement('canvas');
    out.width = nw; out.height = nh;
    out.getContext('2d').drawImage(srcCanvas, left, top, nw, nh, 0, 0, nw, nh);
    return out;
  }

  // HTML VERBATIM: prompt1 (coordinate-detection), HTML ke textarea se as-is
  const VISION_PROMPT1 = 'Return a single JSON object with exactly one top-level key named "text_blocks", whose value is an array of line objects (do NOT use any other key name like text_lines, textBlocks, or lines).\nProcess the image line-by-line (row by row) from top to bottom, scanning pixel by pixel. For each row:\nSTEP 1 — DETECT TEXT START & END: When text is detected in a row, locate the exact start pixel (leftmost x-coordinate) and end pixel (rightmost x-coordinate) of that text segment. Group consecutive rows that contain the same text to form complete lines.\nSTEP 2 — ADD TO JSON FIRST: For every complete text line identified, immediately extract and add its data to the JSON object with the following fields:\n\t1)paragraph_id: group reference (e.g. "p1", "p2") — all lines of the same paragraph/sentence share the same id; standalone lines get their own id\n\t2)line_index: line number within the paragraph (1, 2, 3...)\n\t3)top: vertical position on a normalized 0-1000 scale (0 = top edge, 1000 = bottom edge)\n\t4)left: horizontal position on a normalized 0-1000 scale (0 = left edge, 1000 = right edge)\n\t5)width: this line\'s bounding box width on the 0-1000 scale\n\t6)height: this line\'s bounding box height on the 0-1000 scale\n\t7)font_size: this line\'s text height on the 0-1000 scale (relative to image height)\n\t8)color: hex color code (e.g., #000000)\n\t9)style: "normal", "bold", "italic", or "bold italic"\n\t10)text: this line\'s exact text content (preserve original spelling)\n\t11)align: "left", "center", "right", or "justify"\n\nContinue this line-by-line process until ALL text has been detected, added to JSON.\n\nImportant:\n1)Process rows sequentially from top to bottom\n2)For each line, find the exact start pixel and end pixel of the text\n3)ALL coordinates use the 0-1000 normalized scale, NOT pixels — convert pixel positions to 0-1000 scale\n4)Every line must have its own accurate font_size, style and color\n5)Include EVERY text line (even small words, numbers, handwritten)\n6)Preserve original text exactly (don\'t correct spelling)\n7)Return ONLY valid JSON — no extra text, no markdown';
  const HTML_MODEL = 'google/gemini-3.1-flash-image';
  const HTML_PROMPT2 = 'Generate a clean version of this image without changing its original width and height. Completely remove all readable text, printed words, handwritten signatures, and any linguistic characters from the image, as if they never existed. Do not alter any non-readable elements like lines, patterns, textures, abstract shapes, or background designs. The output must have the exact same dimensions as the input and no new text should be added.';

  // HTML VERBATIM (processPageCombined): EK call me JSON text_blocks +
  // cleaned image. 0 blocks / image nahi / truncated -> ek retry.
  // Phir refineBlocksWithInk CLEANED image par.
  // TEXT EXTRACTION — Box_Size_and_Exact_Text.html ka simple prompt VERBATIM.
  // Wahan text lagbhag poora capture hota hai kyunki (a) sirf 8 fields hain,
  // (b) text pehle image baad me, (c) poore 8000 tokens JSON ko milte hain
  // (koi image generation nahi). Geometry baad me refineBlocksWithInk se
  // pixel-measure hoti hai (Cordinates HTML wala part).
  async function processPageCombined(dataUrl, cleanCanvas, imgW, imgH, pageNo, model, wPt, hPt){
    const prompt =
`You are a precise OCR and layout extraction engine. Analyze this document page image (page size: ${Math.round(wPt)} x ${Math.round(hPt)} points).

Return ONLY valid JSON, no markdown fences, no explanation:
{"lines":[{"text":"...","x":0,"y":0,"w":0,"h":0,"font_size_pt":11,"bold":false,"italic":false,"color":"000000"}]}

STRICT RULES:
- Each VISUAL LINE of text = one separate entry. NEVER merge multiple lines into one entry. NEVER use \\n inside text.
- If one visual row contains separate columns/cells with a big horizontal gap, output each column segment as its own entry.
- x, y = top-left corner of THAT LINE's text, normalized 0-1000 relative to page width/height.
- w = tight width of exactly that line's text, nothing more. h = height of the tallest character in that line (cap height to descender), nothing more. NO padding.
- font_size_pt = real font size estimate in points (page is ${Math.round(hPt)} pt tall). Keep it consistent for identically-sized text.
- OCR text EXACTLY in original language and script. Do NOT translate. Do NOT normalize.
- color = 6-digit hex of the text color, no #.
- Include ALL text: headers, footers, stamps, table cells, page numbers.`;

    const body = {
      model: model, temperature: 0, max_tokens: 8000,
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: dataUrl } }
      ]}]
    };

    let blocks = [];
    for (let attempt = 1; attempt <= 2; attempt++){
      if (_shouldStop()) break;
      const resp = await _visionFetch(body);
      if (!resp.ok){
        const t = await resp.text();
        throw new Error('OpenRouter HTTP ' + resp.status + ': ' + t.slice(0, 300));
      }
      const data = await resp.json();
      let raw = (data.choices && data.choices[0] && data.choices[0].message.content) || '';
      raw = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
      const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
      if (a !== -1 && b > a) raw = raw.slice(a, b + 1);
      try {
        const parsed = JSON.parse(raw);
        const arr = parsed.lines || parsed.blocks || parsed.text_blocks;
        if (!Array.isArray(arr)) throw new Error('no lines array');
        blocks = arr.filter(function(L){ return L && L.text && String(L.text).trim(); });
        break;
      } catch (e){
        log('P' + pageNo + ' parse fail (attempt ' + attempt + '): ' + e.message, 'warn');
        if (attempt === 2) throw new Error('P' + pageNo + ': malformed JSON twice');
      }
    }

    // GEOMETRY: box/size/color actual ink pixels se measure (Cordinates HTML)
    if (blocks.length > 0) blocks = refineBlocksWithInk(cleanCanvas, blocks);
    log('P' + pageNo + ': ' + blocks.length + ' text lines extracted');
    return { textBlocks: blocks, image: null };
  }

  function normalizeBlockHtml(block, srcW, srcH, dstW, dstH, units){
    let left = parseFloat(block.left) || 0;
    let top = parseFloat(block.top) || 0;
    let width = parseFloat(block.width) || 0;
    let height = parseFloat(block.height) || 0;

    if (units === 'fraction'){ left *= srcW; width *= srcW; top *= srcH; height *= srcH; }
    else if (units === 'percent'){ left = left/100*srcW; width = width/100*srcW; top = top/100*srcH; height = height/100*srcH; }
    else if (units === 'permille'){ left = left/1000*srcW; width = width/1000*srcW; top = top/1000*srcH; height = height/1000*srcH; }

    const sx = dstW / srcW, sy = dstH / srcH;
    left *= sx; width *= sx; top *= sy; height *= sy;

    left = Math.max(0, Math.min(left, dstW - 1));
    top = Math.max(0, Math.min(top, dstH - 1));
    if (width <= 0) width = Math.min(200, dstW - left);
    if (height <= 0) height = 24;
    width = Math.min(width, dstW - left);
    height = Math.min(height, dstH - top);

    // simple schema: font_size_pt already POINTS me hai (permille nahi)
    if (block.font_size == null && block.font_size_pt != null){
      const fp = parseFloat(block.font_size_pt) || 0;
      if (fp > 0){
        const st2 = String(block.style || '').toLowerCase();
        let col2 = String(block.color || '000000').replace('#','').trim();
        if (!/^[0-9a-fA-F]{6}$/.test(col2)) col2 = '000000';
        const al2 = String(block.align || 'left').toLowerCase();
        return { left: left, top: top, width: width, height: height,
                 fontPx: Math.max(4, Math.min(96, fp)), color: col2,
                 bold: !!block.bold || st2.indexOf('bold') !== -1,
                 italic: !!block.italic || st2.indexOf('italic') !== -1,
                 jc: al2==='center'?'center':al2==='right'?'right':al2==='justify'?'both':'left',
                 text: String(block.text || '') };
      }
    }
    let fontPx = parseFloat(block.font_size) || 0;
    if (fontPx > 0){
      if (units === 'fraction') fontPx *= srcH;
      else if (units === 'percent') fontPx = fontPx/100*srcH;
      else if (units === 'permille') fontPx = fontPx/1000*srcH;
      fontPx *= sy;
    }
    if (!fontPx || fontPx < 3) fontPx = Math.max(6, Math.min(height * 0.72, 48));

    let color = String(block.color || '000000').replace('#', '').trim();
    if (!/^[0-9a-fA-F]{6}$/.test(color)) color = '000000';

    const style = String(block.style || '').toLowerCase();
    const alignRaw = String(block.align || 'left').toLowerCase();
    const jc = alignRaw === 'center' ? 'center' : alignRaw === 'right' ? 'right'
             : alignRaw === 'justify' ? 'both' : 'left';

    return { left: left, top: top, width: width, height: height, fontPx: fontPx,
             color: color, bold: style.indexOf('bold') !== -1,
             italic: style.indexOf('italic') !== -1, jc: jc, text: String(block.text || '') };
  }

  // HTML ka textbox XML — page-relative, noAutofit, zero insets, NO bidi/rtl,
  // model ka align. Koi collision/wrap/shrink nahi: box jahan measure hui,
  // wahin exactly place hoti hai.
  function textBoxXmlHtmlParity(b, boxId){
    const E = 12700;
    const fontHalfPts = Math.max(2, Math.round(b.fontPx * 2));
    const rPr = '<w:rPr>' + (b.bold ? '<w:b/><w:bCs/>' : '') + (b.italic ? '<w:i/><w:iCs/>' : '') +
      '<w:color w:val="' + b.color + '"/><w:sz w:val="' + fontHalfPts + '"/>' +
      '<w:szCs w:val="' + fontHalfPts + '"/></w:rPr>';
    const pPr = '<w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>' +
      '<w:jc w:val="' + b.jc + '"/></w:pPr>';
    const parts = b.text.split(/\r?\n/);
    let runsXml = '';
    parts.forEach(function(line, li){
      if (li > 0) runsXml += '<w:r>' + rPr + '<w:br/></w:r>';
      runsXml += '<w:r>' + rPr + '<w:t xml:space="preserve">' + esc(line) + '</w:t></w:r>';
    });
    const leftEmu = Math.round(b.left * E), topEmu = Math.round(b.top * E);
    const wEmu = Math.round(b.width * E), hEmu = Math.round(b.height * E);
    return '<w:r><w:rPr><w:noProof/></w:rPr><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing>' +
      '<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="' + (boxId + 100) +
      '" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/>' +
      '<wp:positionH relativeFrom="page"><wp:posOffset>' + leftEmu + '</wp:posOffset></wp:positionH>' +
      '<wp:positionV relativeFrom="page"><wp:posOffset>' + topEmu + '</wp:posOffset></wp:positionV>' +
      '<wp:extent cx="' + wEmu + '" cy="' + hEmu + '"/><wp:effectExtent l="0" t="0" r="0" b="0"/>' +
      '<wp:wrapNone/><wp:docPr id="' + boxId + '" name="TextBox ' + boxId + '"/><wp:cNvGraphicFramePr/>' +
      '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
      '<wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm><a:off x="0" y="0"/>' +
      '<a:ext cx="' + wEmu + '" cy="' + hEmu + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
      '<a:noFill/><a:ln><a:noFill/></a:ln></wps:spPr><wps:txbx><w:txbxContent><w:p>' + pPr + runsXml +
      '</w:p></w:txbxContent></wps:txbx>' +
      '<wps:bodyPr rot="0" vert="horz" wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t">' +
      '<a:noAutofit/></wps:bodyPr></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing>' +
      '</mc:Choice></mc:AlternateContent></w:r>';
  }

  // HTML ka page structure: har page = ek <w:p> (background + saare boxes),
  // uske baad sectPr wala alag <w:p>; last page ka sectPr body level pe.
  async function buildDocxHtmlParity(pages, includeBg){
    const zip = new JSZip();
    zip.file('[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="jpg" ContentType="image/jpeg"/>' +
      '<Default Extension="png" ContentType="image/png"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '</Types>');
    zip.file('_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="word/styles.xml"/>' +
      '</Relationships>');
    zip.file('word/styles.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr>' +
      '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="24"/><w:szCs w:val="24"/>' +
      '</w:rPr></w:rPrDefault></w:docDefaults></w:styles>');

    let relsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
    let doc = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
      'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
      'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
      'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ' +
      'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
      'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" mc:Ignorable="wps"><w:body>';

    let shapeId = 1;
    const E = 12700;
    pages.forEach(function(pg, idx){
      const pw = pg.wPt, ph = pg.hPt;
      const orient = pw > ph ? ' w:orient="landscape"' : '';
      doc += '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>';

      if (includeBg && pg.jpegBase64){
        const bgId = shapeId++;
        const relId = 'rIdImg' + (idx + 1);
        relsXml += '<Relationship Id="' + relId + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/page' + (idx+1) + '.png"/>';
        zip.file('word/media/page' + (idx+1) + '.png', pg.jpegBase64, { base64: true });
        doc += '<w:r><w:rPr><w:noProof/></w:rPr><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" ' +
          'simplePos="0" relativeHeight="1" behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1">' +
          '<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionH>' +
          '<wp:positionV relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionV>' +
          '<wp:extent cx="' + Math.round(pw*E) + '" cy="' + Math.round(ph*E) + '"/>' +
          '<wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="' + bgId + '" name="Background ' + (idx+1) + '"/>' +
          '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
          '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>' +
          '<pic:nvPicPr><pic:cNvPr id="' + bgId + '" name="Background ' + (idx+1) + '"/><pic:cNvPicPr/></pic:nvPicPr>' +
          '<pic:blipFill><a:blip r:embed="' + relId + '" cstate="print"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
          '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + Math.round(pw*E) + '" cy="' + Math.round(ph*E) + '"/></a:xfrm>' +
          '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>';
      }

      const blocks = pg.blocks || [];
      const units = detectCoordUnits(blocks);
      blocks.forEach(function(raw){
        const b = normalizeBlockHtml(raw, pg.srcW || pw, pg.srcH || ph, pw, ph, units);
        if (!b.text.trim()) return;
        doc += textBoxXmlHtmlParity(b, shapeId++);
      });

      doc += '</w:p>';
      const sectPr = '<w:sectPr><w:pgSz w:w="' + Math.round(pw*20) + '" w:h="' + Math.round(ph*20) + '"' + orient + '/>' +
        '<w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>';
      if (idx < pages.length - 1){
        doc += '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>' + sectPr + '</w:pPr></w:p>';
      } else {
        doc += sectPr;
      }
    });
    doc += '</w:body></w:document>';
    relsXml += '</Relationships>';
    zip.file('word/_rels/document.xml.rels', relsXml);
    zip.file('word/document.xml', doc);
    return zip.generateAsync({ type: 'blob',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  }

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
      const ey = Math.max(6, Math.round(bh * 0.3));
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
            const huge = ch > 3 * Math.max(bh, 20);
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

      // HTML-VERBATIM: measured values (0-1000 permille). Koi guard nahi —
      // HTML bilkul aisa hi karta hai aur uska output perfect aata hai.
      const mLeft = x0 + tight[0], mTop = y0 + tight[2];
      const mW = tight[1] - tight[0] + 1, mH = tight[3] - tight[2] + 1;
      colorSamples.sort((a, b) => (a[0]+a[1]+a[2]) - (b[0]+b[1]+b[2]));
      const mc = colorSamples.length ? colorSamples[colorSamples.length >> 1] : [0, 0, 0];
      const hex = mc.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');

      const out = Object.assign({}, blk);
      out.left = mLeft / W * 1000;
      out.top = mTop / H * 1000;
      out.width = mW / W * 1000;
      out.height = mH / H * 1000;
      out.font_size = (mH / H * 1000) * 0.8;
      out.color = hex;
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

        // HTML-PARITY: raw blocks (permille) hi return karo. Points me
        // conversion build time par normalizeBlockHtml karega — bilkul HTML
        // jaisa. Yahan koi geometry post-processing NAHI.
        const out = arr.map(function(L){
          return {
            text: String(L.text).replace(/\n/g, ' '),
            left: (L.left != null ? L.left : L.x) || 0,
            top:  (L.top  != null ? L.top  : L.y) || 0,
            width:  (L.width  != null ? L.width  : L.w) || 0,
            height: (L.height != null ? L.height : L.h) || 0,
            font_size: L.font_size != null ? L.font_size : null,
            color: L.color || '000000',
            style: L.style || ((L.bold ? 'bold ' : '') + (L.italic ? 'italic' : '')).trim(),
            align: L.align || ''
          };
        });
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
    // REFERENCE PARITY: jis model se HTML ka reference output bana tha
    // wahi model. Same prompt + alag model = alag output — text quality ka
    // asli farak yahi tha (gemini-2.5-flash vs reference ka model).
    const model = opts.model || 'google/gemini-3.1-flash-image';
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
    // HTML VERBATIM: pages strictly SEQUENTIAL (for loop, ek ke baad ek).
    const CONCURRENCY = 1;
    const pageNums = Array.from({ length: pdf.numPages }, function (_, i) { return i + 1; });
    _newAbort();   // fresh AbortController is run ke liye

    const pages = await mapWithConcurrency(pageNums, CONCURRENCY, async function (p) {
      // STOP: is page ka koi API call mat karo — abort + skip
      if (_shouldStop()) { abortVision(); return { lines: [], wPt: 0, hPt: 0, jpegBase64: null, skipped: true }; }
      try {
      const page = await pdf.getPage(p);
      // HTML VERBATIM: render scale 2.0 (fixed), PNG. Page points = scale 1.
      const vp1 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: 2.0 });
      const rawCanvas = document.createElement('canvas');
      rawCanvas.width = Math.round(vp.width); rawCanvas.height = Math.round(vp.height);
      await page.render({ canvasContext: rawCanvas.getContext('2d'), viewport: vp }).promise;

      // HTML VERBATIM: autoCleanImage -> cleaned canvas. Yahi image model ko
      // jaati hai AUR yahi coordinates ka source space (srcW/srcH) hai.
      const cleanCanvas = autoCleanImageCanvas(rawCanvas);
      const cleanedDataUrl = cleanCanvas.toDataURL('image/png');

      // HTML VERBATIM: ek hi combined call — JSON text_blocks + cleaned image
      const combined = await processPageCombined(cleanedDataUrl, cleanCanvas,
        cleanCanvas.width, cleanCanvas.height, p, model, vp1.width, vp1.height);
      let lines = combined.textBlocks || [];
      // HTML: finalImage = combined call ki edited image, warna cleaned image
      let finalImageUrl = combined.image || cleanedDataUrl;

      // OPTION B — ALAG IMAGE-EDIT CALL: combined call se edited image nahi
      // aayi (practically kabhi nahi aati) to dedicated Gemini image-edit
      // model se background ka text hatao. Ye HTML se aage ka step hai —
      // HTML background me original page hi chhod deta hai.
      if (withImage && !combined.image && lines.length && !_shouldStop()) {
        try {
          const IW = cleanCanvas.width, IH = cleanCanvas.height;
          const tl = lines.filter(function (B) { return B.text && String(B.text).trim(); });
          const boxesPx = tl.map(function (B) {
            return { x: (B.left/1000)*IW, y: (B.top/1000)*IH,
                     w: (B.width/1000)*IW, h: (B.height/1000)*IH };
          });
          const texts = tl.map(function (B) { return B.text; });
          const b64 = cleanedDataUrl.indexOf('base64,') !== -1
            ? cleanedDataUrl.split('base64,')[1] : cleanedDataUrl;
          const resp = await _inpaintFetch(b64, boxesPx, texts);
          if (resp.ok) {
            const j = await resp.json();
            if (j && j.imageBase64) {
              finalImageUrl = 'data:image/png;base64,' + j.imageBase64;
              if (j.prompt) log('P' + p + ' image-edit prompt: ' + j.prompt);
              log('P' + p + ': background text removed (' + (j.method || 'edit') + ')');
            }
          } else {
            log('P' + p + ': image-edit skip — original page background rahega', 'warn');
          }
        } catch (e) {
          if (!_shouldStop()) log('P' + p + ': image-edit fail — ' + e.message, 'warn');
        }
      }

      const bgBase64 = withImage
        ? (finalImageUrl.indexOf('base64,') !== -1 ? finalImageUrl.split('base64,')[1] : null)
        : null;

      if (_shouldStop()) { abortVision(); return { blocks: lines, srcW: cleanCanvas.width,
        srcH: cleanCanvas.height, wPt: vp1.width, hPt: vp1.height, jpegBase64: bgBase64 }; }

      // Lexora-only step: translation (HTML me nahi). Sirf .text badalta hai,
      // geometry bilkul untouched.
      if (!keepOriginal && lines.length) {
        await translateLinesInPlace(apiKey, model, lines, targetLang);
      }

      return { blocks: lines, srcW: cleanCanvas.width, srcH: cleanCanvas.height,
               wPt: vp1.width, hPt: vp1.height, jpegBase64: bgBase64 };
      } catch (pageErr) {
        // stop ke wajah se abort -> skipped (partial output me ignore).
        if (_shouldStop()) return { blocks: [], wPt: 0, hPt: 0, jpegBase64: null, skipped: true };
        // asli failure (stop nahi): ek page fail se pura run mat girao, LEKIN
        // chup mat skip karo — visible error + failed-page record.
        log('P' + p + ' FAILED: ' + pageErr.message + ' — is page ka text nahi aaya', 'error');
        return { blocks: [], wPt: 0, hPt: 0, jpegBase64: null, failed: true, pageNo: p };
      }
    }, function (done, total) {
      log('Vision OCR: ' + done + '/' + total + ' pages');
    });

    // Partial output: skipped (stop) / failed / empty pages nikaal do.
    const usable = pages.filter(function (pg) { return !pg.skipped && !pg.failed && pg.blocks && pg.blocks.length; });
    const failedPages = pages.filter(function (pg) { return pg.failed; }).map(function (pg) { return pg.pageNo; });
    if (_shouldStop()) log('Stop requested — ' + usable.length + '/' + pdf.numPages + ' pages tak ka partial output');
    if (failedPages.length) log('WARNING: page(s) ' + failedPages.join(', ') + ' could not be processed (vision returned no text) — output has ' + usable.length + '/' + pdf.numPages + ' page(s)', 'error');
    // PER-PAGE CONFIRMATION: user ko har page ka result clear pata chale.
    // successfully-processed page numbers explicitly list karo.
    const okPages = pages.filter(function (pg) { return !pg.skipped && !pg.failed && pg.blocks && pg.blocks.length; })
                         .map(function (pg, i) { return i + 1; });
    log('Pages processed: ' + usable.length + '/' + pdf.numPages +
        (failedPages.length ? ' (failed: ' + failedPages.join(', ') + ')' : ' — all pages OK'), failedPages.length ? 'warn' : 'ok');
    const totalLines = usable.reduce(function (a, pg) { return a + pg.blocks.length; }, 0);
    if (totalLines === 0) throw new Error(_shouldStop() ? 'Process stop kiya gaya — koi page complete nahi hua' : 'Kisi bhi page se text nahi aaya — vision model ne kuch nahi padha');
    return buildDocxHtmlParity(usable, withImage);
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

  // HTML-PARITY: blocks (raw permille) par translation — sirf .text badalta
  // hai, geometry (left/top/width/height/font_size/color) bilkul untouched.
  async function translateLinesInPlace(apiKey, model, blocks, targetLang){
    const texts = blocks.map(function(B){ return B.text; });
    const translated = await translateTexts(apiKey, model, texts, targetLang, blocks.pageType || '');
    blocks.forEach(function(B, i){ B.text = translated[i] || texts[i]; });
  }

  window.buildHybridDocxBlob = buildHybridDocxBlob;
  window.setVisionAuthToken = setVisionAuthToken;
  window.setVisionStopCheck = setStopCheck;
  window.abortVision = abortVision;

    window.buildOfflineDocxBlob = buildOfflineDocxBlob;
})();
