/* js/engine-calculators.js - FULLY SEPARATE per-service copy of the shared
 * rendering engine (originally translation-offline.js), split per
 * explicit user direction so every service has its own independent
 * file - deliberate duplication, not a shared import, so a fix or a
 * cache/deploy issue in one service's copy can never be confused
 * with another's. Exports live under window.__calculatorsEngine only
 * (not flat window.* names) to avoid collisions with the other 4
 * copies loaded on the same page. */
(function () {
  'use strict';
  // BUILD VERSION MARKER - purely diagnostic, no functional effect. Set
  // on window so the admin "Claude" tab can display it directly, giving
  // an immediate, no-DevTools-needed way to confirm whether the file
  // actually running in the browser is the latest deployed one (added
  // after a real reported case where a redeploy + hard-refresh still
  // showed old behavior - this makes that mismatch visible at a glance
  // instead of needing to inspect the file manually). Bump the string
  // whenever a real functional change is made to this file, so the
  // marker is only useful if kept honest.
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

    // REAL ROOT CAUSE (confirmed via Microsoft's own OpenXML SDK docs,
    // not assumed): w:jc="distribute" is literally defined as
    // "Distribute ALL CHARACTERS Equally" - it is a CJK/Thai-style
    // character-level justification by design, not a Latin-script
    // word-level one. This is why the earlier "word count >= 2" fix
    // (which correctly identified single-word lines but still used
    // "distribute" for 2+-word lines) did NOT actually fix the real
    // problem - a real reported screenshot showed a 6-word title STILL
    // character-spread ("A C C O R D O..."), because "distribute"
    // spreads every character regardless of word count.
    //
    // jc="both" (real Word-standard word-level justify) was ALSO
    // already tried and confirmed broken for a different reason: Word
    // exempts a paragraph's only/last line from "both"-style stretching
    // - and every line here IS its own one-line paragraph.
    //
    // Neither built-in jc value can do "stretch space between WORDS
    // only, even for a single-line paragraph" - so this computes and
    // injects the needed extra inter-word spacing manually, via
    // w:spacing (character tracking) applied ONLY to the space
    // character between words, never within a word. jc is left as
    // "left" unconditionally; the box's own real width (line.wPt, from
    // the source PDF's real glyph positions) is compared against the
    // natural (unstretched) width the same words need - if the box is
    // genuinely wider than the text needs, that slack is distributed
    // across the real inter-word gaps; if the box already matches the
    // natural width (a normal ragged-right line), no extra spacing gets
    // added at all. This needs no per-line "is this justified" guess -
    // it falls directly out of comparing real geometry to real text
    // measurement.
    const rawText = (line.runs || []).map(function (r) { return r.text || ''; }).join('');
    const wordList = rawText.trim().split(/\s+/).filter(Boolean);
    const gapCount = Math.max(0, wordList.length - 1);

    let naturalWidthPt = 0;
    (line.runs || []).forEach(function (r) {
      const tokens = (r.text || '').split(/(\s+)/).filter(function (t) { return t.length > 0; });
      tokens.forEach(function (tok) {
        naturalWidthPt += measureTextPt(tok, r.sizePt || 11, r.family, r.bold, r.italic);
      });
    });
    const extraSpacePt = gapCount > 0 ? Math.max(0, line.wPt - naturalWidthPt) : 0;
    const extraPerGapTwips = gapCount > 0 ? Math.round((extraSpacePt / gapCount) * 20) : 0;

    const order = line.rtl ? line.runs.slice().reverse() : line.runs;
    let gapsSeenSoFar = 0;
    const runsXml = order.map(function(r){
      const sz  = Math.max(2, Math.round((r.sizePt || 11) * 2)); // half-points, fractional preserved
      const col = /^[0-9A-F]{6}$/i.test(r.color || '') ? r.color.toUpperCase() : '000000';
      const fam = esc(r.family || 'Arial');
      const baseRPr =
        '<w:rFonts w:ascii="' + fam + '" w:hAnsi="' + fam + '" w:cs="' + fam + '"/>' +
        (r.bold ? '<w:b/><w:bCs/>' : '') +
        (r.italic ? '<w:i/><w:iCs/>' : '') +
        '<w:color w:val="' + col + '"/>' +
        '<w:sz w:val="' + sz + '"/><w:szCs w:val="' + sz + '"/>' +
        (line.rtl ? '<w:rtl/>' : '');

      if (extraPerGapTwips <= 0) {
        // No real slack to distribute (box already matches natural
        // width, or a single-word line) - emit the run exactly as
        // before, unchanged.
        return '<w:r><w:rPr>' + baseRPr + '</w:rPr><w:t xml:space="preserve">' + esc(r.text) + '</w:t></w:r>';
      }

      // Split this run into word/space tokens so extra tracking can be
      // applied to inter-word spaces only, never within a word.
      const tokens = (r.text || '').split(/(\s+)/).filter(function (t) { return t.length > 0; });
      return tokens.map(function (tok) {
        const isSpace = /^\s+$/.test(tok);
        if (isSpace && gapsSeenSoFar < gapCount) {
          gapsSeenSoFar++;
          return '<w:r><w:rPr>' + baseRPr + '<w:spacing w:val="' + extraPerGapTwips + '"/></w:rPr><w:t xml:space="preserve">' + esc(tok) + '</w:t></w:r>';
        }
        return '<w:r><w:rPr>' + baseRPr + '</w:rPr><w:t xml:space="preserve">' + esc(tok) + '</w:t></w:r>';
      }).join('');
    }).join('');

    const jc = 'left';

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
      '<w:jc w:val="' + jc + '"/></w:pPr>' + runsXml + '</w:p>' +
      '</w:txbxContent></wps:txbx>' +
      // wrap="none": text apni width se wrap NAHI hoga, box size exact rahega
      '<wps:bodyPr rot="0" vert="horz" wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t"><a:noAutofit/></wps:bodyPr>' +
      '</wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>';
  }
  // DIAGNOSTIC ONLY, no functional effect - exposes this exact
  // function's OWN real source code for the admin "Claude" tab to
  // display directly, added after a real reported case where a
  // separate top-of-file version marker showed the correct NEW value
  // while the actual OCR output still showed OLD behavior, from the
  // SAME script file - a marker string can drift out of sync with the
  // real function it's meant to represent (e.g. if only PART of a
  // deploy updates, or some other environment-specific issue this
  // sandbox can't reproduce or diagnose further). Showing the function's
  // OWN literal source removes that ambiguity entirely - what's
  // displayed IS what's executing, not a separate claim about it.

  function floatingImageXml(relId, xPt, yPt, wPt, hPt, name) {
    // Same positioning convention as textBoxXml above (positionH
    // relativeFrom="page", positionV relativeFrom="paragraph") - REQUIRED
    // for correct multi-page placement in buildDocx's architecture (each
    // page = its own paragraph + page-sized section; page-relative
    // vertical positioning would place every page's images using the
    // SAME y-origin, causing them to overlap/shift onto the wrong
    // physical page - see buildDocx's own "MULTI-PAGE FIX" comment for
    // the identical issue already solved for text boxes).
    drawId++;
    const x = Math.max(0, Math.round(xPt * EMU));
    const y = Math.max(0, Math.round(yPt * EMU));
    const cx = Math.max(1, Math.round(wPt * EMU));
    const cy = Math.max(1, Math.round(hPt * EMU));
    return '<w:r><w:drawing>' +
      '<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="' + drawId +
      '" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">' +
      '<wp:simplePos x="0" y="0"/>' +
      '<wp:positionH relativeFrom="page"><wp:posOffset>' + x + '</wp:posOffset></wp:positionH>' +
      '<wp:positionV relativeFrom="paragraph"><wp:posOffset>' + y + '</wp:posOffset></wp:positionV>' +
      '<wp:extent cx="' + cx + '" cy="' + cy + '"/>' +
      '<wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>' +
      '<wp:docPr id="' + drawId + '" name="' + esc(name || 'IMG') + drawId + '"/><wp:cNvGraphicFramePr/>' +
      '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
      '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<pic:nvPicPr><pic:cNvPr id="' + drawId + '" name="img' + drawId + '.jpg"/><pic:cNvPicPr/></pic:nvPicPr>' +
      '<pic:blipFill><a:blip r:embed="' + relId + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
      '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>' +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
      '</pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>';
  }

  function paragraphBoxXml(p, containerRightPt) {
    // Solution 9's SECOND iteration - real root cause found via a
    // reported case: the original per-LINE, wrap="none", fixed-width
    // boxes (textBoxXml) had a structural overflow risk - the box width
    // came from pdf.js's measurement of the SOURCE PDF's own font, but
    // Word renders with its own font/metrics, which can measure the
    // SAME text as wider. wrap="none" then means Word does not wrap to
    // compensate - it just draws past the box's right edge. This
    // doesn't happen occasionally, it's a structural property of
    // "fixed width + no wrap": ANY font-metric mismatch shows as
    // overflow, not just large ones.
    //
    // FIX: render per-PARAGRAPH (not per-line) absolute boxes that DO
    // wrap normally (real Word/LibreOffice line-wrapping handles
    // whatever width the text actually needs, the same way a normal
    // Word document never overflows its margins) and auto-grow their
    // height to fit (a:spAutoFit, native OOXML mechanism - not a
    // height estimate of our own, learned from earlier estimation
    // failures this project). Page-boundary fidelity (the original
    // reason for Solution 9 existing) is preserved because each
    // paragraph is still absolutely positioned at its own real source
    // page/coordinates - only the WITHIN-paragraph rendering changed
    // from "rigid line-by-line" to "positioned column that wraps
    // normally like text". Justify (jc="both") now works correctly too,
    // for the same reason it already worked in the OTHER strategies'
    // flowing-paragraph pipeline: a real multi-line WRAPPED paragraph
    // does not have the single-line-exemption problem a one-line-per-
    // box architecture had.
    drawId++;
    const x = Math.max(0, Math.round(p.leftPt * EMU));
    const y = Math.max(0, Math.round(p.topPt * EMU));
    const rightBoundary = (containerRightPt != null && containerRightPt > p.leftPt) ? containerRightPt : p.rightPt;
    const cx = Math.max(1, Math.round((rightBoundary - p.leftPt) * EMU));
    const cy = Math.max(1, Math.round(Math.max(p.bottomPt - p.topPt, (p.lineTwips || 276) / 20) * EMU));

    const jcMap = { left: 'left', center: 'center', right: 'right', justify: 'both' };
    const jc = jcMap[p.align] || 'left';

    const segs = p.segments || [];
    const runsXml = segs.map(function (seg, i) {
      if (!seg.text) return seg.lineBreakBefore ? '<w:r><w:br/></w:r>' : '';
      let text = seg.text;
      if (i > 0 && !seg.lineBreakBefore) {
        const prev = segs[i - 1];
        if (prev && prev.text) {
          const prevEndsSpace = /\s$/.test(prev.text);
          const nextStartsSpace = /^\s/.test(text);
          const prevOpensNoSpace = /[(\[{'"\u2018\u201c]$/.test(prev.text);
          const nextClosesNoSpace = /^[)\]},.;:!?'"\u2019\u201d]/.test(text);
          if (!prevEndsSpace && !nextStartsSpace && !prevOpensNoSpace && !nextClosesNoSpace) text = ' ' + text;
        }
      }
      const sz = Math.max(2, Math.round((seg.sizePt || 11) * 2));
      const col = /^[0-9A-F]{6}$/i.test(seg.color || '') ? seg.color.toUpperCase() : '000000';
      const fam = esc(seg.family || 'Arial');
      const br = seg.lineBreakBefore ? '<w:br/>' : '';
      return '<w:r><w:rPr>' +
        '<w:rFonts w:ascii="' + fam + '" w:hAnsi="' + fam + '" w:cs="' + fam + '"/>' +
        (seg.bold ? '<w:b/><w:bCs/>' : '') +
        (seg.italic ? '<w:i/><w:iCs/>' : '') +
        '<w:color w:val="' + col + '"/>' +
        '<w:sz w:val="' + sz + '"/><w:szCs w:val="' + sz + '"/>' +
        (p.rtl ? '<w:rtl/>' : '') +
        '</w:rPr>' + br + '<w:t xml:space="preserve">' + esc(text) + '</w:t></w:r>';
    }).join('');

    const lineTw = p.lineTwips || 276;

    return '<w:r><w:drawing>' +
      '<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="' + drawId +
      '" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">' +
      '<wp:simplePos x="0" y="0"/>' +
      '<wp:positionH relativeFrom="page"><wp:posOffset>' + x + '</wp:posOffset></wp:positionH>' +
      '<wp:positionV relativeFrom="paragraph"><wp:posOffset>' + y + '</wp:posOffset></wp:positionV>' +
      '<wp:extent cx="' + cx + '" cy="' + cy + '"/>' +
      '<wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>' +
      '<wp:docPr id="' + drawId + '" name="P' + drawId + '"/><wp:cNvGraphicFramePr/>' +
      '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
      '<a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
      '<wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr>' +
      '<a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>' +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln>' +
      '</wps:spPr><wps:txbx><w:txbxContent>' +
      '<w:p><w:pPr>' +
      '<w:spacing w:before="0" w:after="0" w:line="' + lineTw + '" w:lineRule="auto"/>' +
      (p.rtl ? '<w:bidi/>' : '') +
      '<w:jc w:val="' + jc + '"/></w:pPr>' + runsXml + '</w:p>' +
      '</w:txbxContent></wps:txbx>' +
      // wrap="square" (real wrapping, NOT "none") + spAutoFit (native
      // OOXML auto-grow, not our own height guess) - this pair is what
      // structurally removes the overflow risk textBoxXml had.
      '<wps:bodyPr rot="0" vert="horz" wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t"><a:spAutoFit/></wps:bodyPr>' +
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

  // ---- FLOWING PARAGRAPH BUILDER (text-based mode only) ----
  // Text-based mode has REAL structured text from the PDF's own text
  // layer (unlike OCR, which only has a vision model's best guess at
  // positions) - there's no need to pin every line to an exact pixel
  // position with a floating textbox and a full-page background image.
  // A normal flowing Word document (real margins, real paragraph
  // alignment, natural text wrap) reads better and avoids the
  // "floating textbox" artifacts entirely.

  // Groups a page's lines into paragraphs by vertical gap: lines that
  // sit close together (within about 0.6x the surrounding line height)
  // are the same paragraph; a bigger gap signals a paragraph break.
  // ---- DOMINANT STYLE (weighted, not "just the first run") ----
  // A paragraph's marker ("4.", "A.") is often bold even when the body
  // text after it is not - reading style off paraLines[0].runs[0]
  // picked up the MARKER's style (a couple of bold characters) and
  // applied it to the entire translated body. Weighting each run's
  // style by how many characters it covers means a two-character bold
  // marker can no longer outvote a 400-character regular body run; the
  // style that actually covers most of the paragraph wins, which is
  // also what correctly keeps a genuinely-all-bold paragraph (e.g. the
  // preamble's defined-party block) bold.
  function v14DominantStyle(paraLines) {
    const buckets = {}; // key -> { weight, sizePt, bold, italic, color, family }
    let totalWeight = 0;
    paraLines.forEach(function (L) {
      (L.runs || []).forEach(function (r) {
        const len = (r.text || '').length;
        if (!len) return;
        totalWeight += len;
        const key = (r.sizePt || 11) + '|' + !!r.bold + '|' + !!r.italic + '|' + (r.color || '000000') + '|' + (r.family || 'Arial');
        if (!buckets[key]) buckets[key] = { weight: 0, sizePt: r.sizePt || 11, bold: !!r.bold, italic: !!r.italic, color: r.color || '000000', family: r.family || 'Arial' };
        buckets[key].weight += len;
      });
    });
    let best = null;
    Object.keys(buckets).forEach(function (k) {
      if (!best || buckets[k].weight > best.weight) best = buckets[k];
    });
    if (!best) {
      const r0 = (paraLines[0] && paraLines[0].runs && paraLines[0].runs[0]) || {};
      return { sizePt: r0.sizePt || 11, bold: !!r0.bold, italic: !!r0.italic, color: r0.color || '000000', family: r0.family || 'Arial' };
    }
    return best;
  }

  // ---- STYLE SEGMENTS (preserve bold/italic boundaries WITHIN a
  // paragraph, even through translation) ----
  // Collapsing a whole paragraph into one styled run is what caused
  // "the whole paragraph went bold" - a bold company name followed by
  // a regular address is two different styles inside ONE paragraph.
  // This walks the paragraph's original runs in reading order and
  // merges only the CONSECUTIVE runs that share the same style into a
  // segment, so a style change mid-paragraph (bold name -> regular
  // text) becomes two segments that survive into the output as two
  // separate <w:r> elements with their own formatting.
  // isBlock forces every original LINE to start its own segment
  // (regardless of style) - used for address/signature-style
  // paragraphs where the original hard line breaks are the actual
  // content structure, not just word-wrap, so they must render as real
  // line breaks instead of being flowed/joined with spaces.
  function v14BuildSegments(paraLines, isBlock) {
    const segments = [];
    paraLines.forEach(function (L) {
      // L.runs is already in correct logical reading order (fixed at
      // extraction, in makeLine) - no reversal needed here regardless
      // of direction.
      const order = L.runs;
      order.forEach(function (r, ri) {
        if (!r.text) return;
        const sizePt = r.sizePt || 11, bold = !!r.bold, italic = !!r.italic,
          color = r.color || '000000', family = r.family || 'Arial';
        const styleKey = Math.round(sizePt) + '|' + bold + '|' + italic + '|' + color + '|' + family;
        const isLineStart = ri === 0;
        const last = segments[segments.length - 1];
        if (last && last.styleKey === styleKey && !(isBlock && isLineStart)) {
          last.text += ' ' + r.text;
        } else {
          segments.push({
            text: r.text, sizePt: sizePt, bold: bold, italic: italic, color: color, family: family,
            styleKey: styleKey,
            lineBreakBefore: !!(isBlock && isLineStart && segments.length > 0)
          });
        }
      });
    });
    return segments;
  }

  // A paragraph whose non-last lines are all noticeably narrower than
  // the page's real content column is a deliberate short-line block
  // (an address, a signature block, a "Between" party header) rather
  // than word-wrapped prose - wrapped prose's lines (other than the
  // final, naturally-short one) run close to the full column width.
  function v14IsBlockParagraph(paraLines, columnWidthPt) {
    if (paraLines.length < 2 || !(columnWidthPt > 0)) return false;
    const nonLast = paraLines.slice(0, -1);
    return nonLast.every(function (l) { return l.wPt < columnWidthPt * 0.62; });
  }

  // ============================================================
  // TABLE DETECTION (local/free - never calls the vision API)
  // ============================================================
  // extractOfflinePage already splits a visual row into SEPARATE line
  // objects wherever there's a big horizontal gap ("table columns as
  // separate boxes" - see the row-splitting step there), so a table
  // row's cells already arrive as distinct `lines` entries sharing
  // close to the same yPt. What was missing was recognising that
  // PATTERN - several consecutive rows that each split into 2+ pieces,
  // whose split points line up into the same handful of x-positions
  // across those rows - as a table, instead of feeding all those
  // pieces into the paragraph grouper, which just sorted them by
  // position and joined them with spaces (scrambling every column of a
  // payment schedule into one unlabelled run of numbers).

  // Groups lines into visual ROWS by y-range overlap (not the looser
  // "close enough" paragraph gap test - a row's cells must genuinely
  // sit side by side, not just be vertically nearby).
  function v14GroupIntoRows(lines) {
    const sorted = lines.slice().sort(function (a, b) { return a.yPt - b.yPt || a.xPt - b.xPt; });
    const rows = [];
    sorted.forEach(function (L) {
      const row = rows.find(function (R) {
        const overlap = Math.min(R.yBottom, L.yPt + L.hPt) - Math.max(R.yTop, L.yPt);
        return overlap > Math.min(R.yBottom - R.yTop, L.hPt) * 0.5;
      });
      if (row) {
        row.lines.push(L);
        row.yTop = Math.min(row.yTop, L.yPt);
        row.yBottom = Math.max(row.yBottom, L.yPt + L.hPt);
      } else {
        rows.push({ yTop: L.yPt, yBottom: L.yPt + L.hPt, lines: [L] });
      }
    });
    rows.forEach(function (R) { R.lines.sort(function (a, b) { return a.xPt - b.xPt; }); });
    rows.sort(function (a, b) { return a.yTop - b.yTop; });
    return rows;
  }

  function v14NearestColumn(x, colStarts) {
    let best = 0, bestDist = Infinity;
    colStarts.forEach(function (c, idx) {
      const d = Math.abs(x - c);
      if (d < bestDist) { bestDist = d; best = idx; }
    });
    return best;
  }

  // Scans a page's rows for a run of 2+ CONSECUTIVE multi-cell rows
  // whose cells' left edges cluster into the same set of x-positions -
  // that column alignment repeating row after row is the actual
  // signature of a table, as opposed to two unrelated short lines that
  // just happen to sit near the same height once.
  // A row's line(s) sit close enough to the table's already-detected
  // column x-positions to plausibly belong to it, even if this
  // particular row only populated one of those columns (e.g. a field
  // whose value happened to be blank in the source).
  function v14RowFitsColumns(R, colStarts, tolerancePt) {
    return R.lines.every(function (L) {
      return colStarts.some(function (c) { return Math.abs(L.xPt - c) < tolerancePt; });
    });
  }

  // Item - table/structure fidelity improvement. The existing detector
  // above works PURELY from text-position clustering (do several rows
  // of text happen to line up into 2+ columns) - it has no idea whether
  // the source PDF actually DREW a table (ruled borders/gridlines) at
  // all. Most financial-report and structured-data tables genuinely do
  // have real drawn borders, and those borders are a far more reliable,
  // exact signal for where a column boundary actually sits than
  // averaging where text happened to start - text can be inset from its
  // cell's true border by an inconsistent amount, especially with mixed
  // alignment (numbers right-aligned, labels left-aligned) within the
  // same table. This walks the page's content-stream the same way
  // extractOfflineImages does (tracking the CTM through save/restore/
  // transform), collecting axis-aligned rectangles thin enough in one
  // dimension to be a ruled line (a hairline stroke, or a thin filled
  // bar - both common ways PDF generators draw table borders) rather
  // than a real filled shape or a text glyph. Returns two arrays of
  // page-space coordinates: vertical line X-positions (candidate column
  // boundaries) and horizontal line Y-positions (candidate row
  // boundaries) - used below to SNAP an already-detected table's
  // column positions to the nearest real line when one exists nearby,
  // rather than trusting the text-position average alone.
  async function extractOfflineTableLines(page, pageH) {
    const F = pdfjsLib.OPS;
    let ops;
    try { ops = await page.getOperatorList(); } catch (e) { return { vLines: [], hLines: [], fills: [] }; }

    const vLines = [], hLines = [], fills = [];
    const stack = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    let fillStack = [], fillColor = null;
    function concat(base, add) {
      return [
        add[0] * base[0] + add[1] * base[2],
        add[0] * base[1] + add[1] * base[3],
        add[2] * base[0] + add[3] * base[2],
        add[2] * base[1] + add[3] * base[3],
        add[4] * base[0] + add[5] * base[2] + base[4],
        add[4] * base[1] + add[5] * base[3] + base[5]
      ];
    }
    // Slim, thin-rectangle-only path reader: pdf.js encodes a
    // constructPath's args as [opsArray, coordsArray] where opsArray is
    // a sequence of OPS.moveTo/lineTo/rectangle/closePath codes and
    // coordsArray is the flat [x0,y0,x1,y1,...] list consumed in that
    // order - this just tracks the running bounding box of whatever
    // path was built, which is all a THIN-RECTANGLE classification
    // needs (an actual curved/complex path would also produce a
    // bounding box here, but would essentially never end up thin
    // enough in one dimension to pass the hairline check below, so no
    // separate curve-detection is needed to avoid false positives).
    // Entirely wrapped in try/catch: this is a refinement, never a
    // requirement - if the argsArray shape here ever doesn't match what
    // this assumes (a pdf.js internal detail that could change across
    // versions), the whole thing just yields no lines rather than
    // breaking table detection or the translation itself.
    try {
      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i], args = ops.argsArray[i] || [];
        if (fn === F.save) {
          stack.push(ctm.slice());
          fillStack.push(fillColor);
        } else if (fn === F.restore) {
          ctm = stack.length ? stack.pop() : ctm;
          fillColor = fillStack.length ? fillStack.pop() : fillColor;
        } else if (fn === F.transform) {
          ctm = concat(ctm, args);
        } else if (fn === F.setFillRGBColor && args && args.length >= 3) {
          fillColor = [args[0], args[1], args[2]];
        } else if (fn === F.setFillGray && args && args.length >= 1) {
          const g = Math.round(args[0] * 255);
          fillColor = [g, g, g];
        } else if (fn === F.setFillCMYKColor && args && args.length >= 4) {
          const c = args[0], m = args[1], y = args[2], k = args[3];
          fillColor = [
            Math.round(255 * (1 - c) * (1 - k)),
            Math.round(255 * (1 - m) * (1 - k)),
            Math.round(255 * (1 - y) * (1 - k))
          ];
        } else if (fn === F.constructPath) {
          const coords = args[1];
          const pathOps = args[0];
          if (!coords || typeof coords.length !== 'number' || !coords.length) continue;
          let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
          for (let c = 0; c + 1 < coords.length; c += 2) {
            const cx = coords[c], cy = coords[c + 1];
            if (typeof cx !== 'number' || typeof cy !== 'number') continue;
            const px = ctm[0] * cx + ctm[2] * cy + ctm[4];
            const py = ctm[1] * cx + ctm[3] * cy + ctm[5];
            if (px < minX) minX = px; if (px > maxX) maxX = px;
            if (py < minY) minY = py; if (py > maxY) maxY = py;
          }
          if (!isFinite(minX) || !isFinite(minY)) continue;
          const w = maxX - minX, h = maxY - minY;
          // "Thin enough to be a ruled line, long enough to be a table
          // border rather than punctuation/a glyph stroke": under 2.5pt
          // in the thin dimension, over 15pt in the long one.
          if (h < 2.5 && w > 15) {
            hLines.push({ yPt: pageH - (minY + maxY) / 2, x0Pt: minX, x1Pt: maxX });
          } else if (w < 2.5 && h > 15) {
            vLines.push({ xPt: (minX + maxX) / 2, y0Pt: pageH - maxY, y1Pt: pageH - minY });
          } else if (w > 15 && h > 4 && fillColor &&
                     !(fillColor[0] > 248 && fillColor[1] > 248 && fillColor[2] > 248)) {
            // A wider filled rectangle (not thin - a real shaded region,
            // not a ruled line) in a non-white color: candidate ROW
            // shading (a colored header band, alternating-row tint -
            // both very common in financial-report tables). Not every
            // fill on the page is table shading (a colored callout box,
            // a logo backdrop), so this only actually gets USED below
            // where it overlaps a CONFIRMED table row's Y-range - a
            // false candidate here that never overlaps a real table row
            // is simply never applied to anything.
            fills.push({
              yTopPt: pageH - maxY, yBottomPt: pageH - minY,
              color: fillColor.map(function (v) { return Math.max(0, Math.min(255, Math.round(v))); })
            });
          }
        }
      }
    } catch (e) { /* refinement only - proceed with whatever lines were found before the failure, or none */ }
    return { vLines: vLines, hLines: hLines, fills: fills };
  }

  // Snaps each of a detected table's column start-positions to the
  // nearest real vertical line within a small tolerance, if one exists -
  // leaves a column's position exactly as the text-clustering average
  // computed it if no matching drawn line is nearby (most tables mix
  // ruled and unruled columns, or have none at all, so this is a
  // refinement on top of the existing detector, never a requirement).
  function v14SnapColumnsToLines(colStarts, vLines, tablePt) {
    if (!vLines || !vLines.length) return colStarts;
    const tolerance = 10;
    return colStarts.map(function (x) {
      let best = null, bestDist = tolerance;
      vLines.forEach(function (v) {
        // Only consider a vertical line that actually spans (at least
        // roughly overlaps) this table's own row range, not some
        // unrelated ruled line elsewhere on the page that happens to
        // share a similar X position.
        if (tablePt && (v.y1Pt < tablePt.topPt - 20 || v.y0Pt > tablePt.bottomPt + 20)) return;
        const d = Math.abs(v.xPt - x);
        if (d < bestDist) { bestDist = d; best = v.xPt; }
      });
      return best != null ? best : x;
    });
  }

  function v14DetectTables(lines, vLines) {
    const rows = v14GroupIntoRows(lines);
    const tables = [];
    const usedLines = new Set();
    let i = 0;
    while (i < rows.length) {
      if (rows[i].lines.length < 2) { i++; continue; }
      let j = i;
      while (j < rows.length && rows[j].lines.length >= 2) j++;
      const block = rows.slice(i, j);
      if (block.length >= 2) {
        const xs = [];
        block.forEach(function (R) { R.lines.forEach(function (L) { xs.push(L.xPt); }); });
        xs.sort(function (a, b) { return a - b; });
        const clusters = [];
        xs.forEach(function (x) {
          const last = clusters[clusters.length - 1];
          if (last && x - last.max < 16) { last.max = x; last.sum += x; last.n++; }
          else clusters.push({ max: x, sum: x, n: 1 });
        });
        if (clusters.length >= 2) {
          const colStarts = clusters.map(function (c) { return c.sum / c.n; });
          let goodRows = 0;
          block.forEach(function (R) {
            const cols = new Set(R.lines.map(function (L) { return v14NearestColumn(L.xPt, colStarts); }));
            if (cols.size >= 2) goodRows++;
          });
          // Require most rows in the block to genuinely populate 2+ of
          // the detected columns, and at least 3 rows total (2 rows of
          // aligned text is common coincidence; 3+ repeating almost
          // never is) - keeps this conservative so ordinary two-line
          // paragraphs that happen to align once are never misread as
          // a table and pulled out of normal flowing text.
          if (block.length >= 3 && goodRows >= Math.ceil(block.length * 0.6)) {
            // Grow the confirmed block outward to absorb immediately
            // adjacent rows that only populated ONE of the table's
            // columns (a blank value cell, a single-line note row,
            // etc.) - otherwise a single sparse row in the middle of an
            // obvious table breaks it into separate pieces and that row
            // leaks out as a stray paragraph floating outside any table
            // border, misaligned from everything around it.
            const tolerancePt = 18;
            let startIdx = i, endIdx = j;
            while (startIdx > 0 && rows[startIdx - 1].lines.length >= 1 &&
                   rows[startIdx - 1].lines.every(function (L) { return !usedLines.has(L); }) &&
                   v14RowFitsColumns(rows[startIdx - 1], colStarts, tolerancePt)) {
              startIdx--;
            }
            while (endIdx < rows.length && rows[endIdx].lines.length >= 1 &&
                   rows[endIdx].lines.every(function (L) { return !usedLines.has(L); }) &&
                   v14RowFitsColumns(rows[endIdx], colStarts, tolerancePt)) {
              endIdx++;
            }
            const grownBlock = rows.slice(startIdx, endIdx);
            // Refine the text-clustering average toward a real drawn
            // border, when one exists close by - see
            // v14SnapColumnsToLines/extractOfflineTableLines above for
            // why this specifically helps mixed-alignment tables
            // (numbers right-aligned, labels left-aligned) where the
            // pure text-position average can land noticeably off from
            // where the column's actual ruled edge is.
            const snappedColStarts = v14SnapColumnsToLines(colStarts, vLines, {
              topPt: grownBlock[0].yTop, bottomPt: grownBlock[grownBlock.length - 1].yBottom
            });
            tables.push({ rows: grownBlock, colStarts: snappedColStarts });
            grownBlock.forEach(function (R) { R.lines.forEach(function (L) { usedLines.add(L); }); });
            i = endIdx;
            continue;
          }
        }
      }
      i = j > i ? j : i + 1;
    }
    return { tables: tables, usedLines: usedLines };
  }

  // Converts a detected table's rows/columns into a plain grid of cell
  // strings (row-major), merging any line whose x falls nearer one
  // Converts a detected table's rows/columns into a grid of CELL
  // OBJECTS (row-major) - not just plain strings. Each cell keeps its
  // own dominant style AND, when a source line's actual width spans
  // past the next detected column boundary, a colspan count - the
  // source's own merged/wide cells (a label spanning two columns) are
  // common in form-style tables and would otherwise just leave the
  // "extra" columns in that row looking like stray empty cells rather
  // than one properly merged one.
  // A "title" row that only has text at the very FIRST and very LAST
  // column, with everything between empty, is this EJAR-style
  // document's bilingual section header pattern (e.g. an English label
  // at one edge and its Arabic/numbered mirror at the other, drawn
  // over one full-width colored bar in the source) rather than a real
  // 2-column data row - collapsing it into one full-span cell matches
  // how it actually reads, instead of a mostly-empty-looking row.
  function v14CollapseHeaderRow(row, nCols) {
    if (row.length !== nCols) return row; // only simple, unspanned rows
    const nonEmptyIdx = [];
    row.forEach(function (c, i) { if (c.text) nonEmptyIdx.push(i); });
    if (nonEmptyIdx.length !== 2 || nonEmptyIdx[0] !== 0 || nonEmptyIdx[1] !== nCols - 1) return row;
    const first = row[0], last = row[nCols - 1];
    const text = first.text.length >= last.text.length ? first.text : last.text;
    return [{
      text: text, bold: first.bold || last.bold, italic: first.italic || last.italic,
      color: first.color, family: first.family, span: nCols, col: 0
    }];
  }

  function v14BuildTableGrid(table) {
    const nCols = table.colStarts.length;
    return table.rows.map(function (R) {
      const bucket = new Array(nCols).fill(null); // bucket[startCol] = { lines, span }
      R.lines.forEach(function (L) {
        const startCol = v14NearestColumn(L.xPt, table.colStarts);
        let endCol = v14NearestColumn(L.xPt + L.wPt, table.colStarts);
        if (endCol < startCol) endCol = startCol;
        endCol = Math.min(endCol, nCols - 1);
        if (!bucket[startCol]) bucket[startCol] = { lines: [L], span: endCol - startCol + 1 };
        else {
          bucket[startCol].lines.push(L);
          bucket[startCol].span = Math.max(bucket[startCol].span, endCol - startCol + 1);
        }
      });
      const rowOut = [];
      let c = 0;
      while (c < nCols) {
        const b = bucket[c];
        if (!b) { rowOut.push({ text: '', bold: false, italic: false, color: '000000', family: 'Arial', span: 1, col: c }); c += 1; continue; }
        const text = b.lines.map(function (L) {
          return L.runs.map(function (r) { return r.text; }).join(' ').trim();
        }).filter(Boolean).join(' ');
        const style = v14DominantStyle(b.lines);
        rowOut.push({ text: text, bold: style.bold, italic: style.italic, color: style.color, family: style.family, span: b.span, col: c });
        c += b.span;
      }
      return v14CollapseHeaderRow(rowOut, nCols);
    });
  }

  function v14GroupLinesIntoParagraphs(lines) {
    if (!lines.length) return [];
    const sorted = lines.slice().sort((a, b) => a.yPt - b.yPt || a.xPt - b.xPt);
    const paragraphs = [[sorted[0]]];
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1], cur = sorted[i];
      const prevBottom = prev.yPt + prev.hPt;
      const gap = cur.yPt - prevBottom;
      const avgH = (prev.hPt + cur.hPt) / 2;
      // Item - a line starting its OWN list/sub-clause marker ("a)",
      // "b)", "2.", a bullet, ...) always starts a NEW paragraph, even
      // when the vertical gap to the previous line is small enough that
      // the gap-based check below would otherwise have called it a
      // continuation. Tightly-spaced sub-items (e.g. "a) ...;" then,
      // right on the very next line, "b) ...;") are exactly the case
      // this was merging into one run-on paragraph - "a)" and "b)" both
      // being real markers of the SAME (list) kind is what makes this
      // safe to do unconditionally, rather than every line with a small
      // gap accidentally starting its own paragraph.
      const curText = (cur.runs || []).map(r => r.text).join('').trim();
      const curIsListStart = curText && v14DetectListMarker(curText) != null;
      if (!curIsListStart && gap <= avgH * 0.6) {
        paragraphs[paragraphs.length - 1].push(cur);
      } else {
        paragraphs.push([cur]);
      }
    }
    return paragraphs;
  }

  // Guesses left/center/right/justify by comparing how consistent each
  // line's left edge and right edge are with each other across the
  // paragraph - centered text has neither edge consistent but a
  // consistent midpoint; justified text has both edges consistent
  // except the last line; left-aligned has a consistent left edge with
  // a ragged right edge, and so on.
  function v14DetectAlignment(paraLines, pageWidth, contentLeftPt, contentRightPt) {
    const variance = arr => {
      const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
      return arr.reduce((a, b) => a + Math.abs(b - mean), 0) / arr.length;
    };
    const tolerance = Math.max(4, pageWidth * 0.01);
    // SINGLE-LINE paragraph: no left/right edge to compare across lines,
    // but we can still tell left/center/right from where the one line
    // sits relative to the page's actual content column (contentLeftPt/
    // contentRightPt - the real margins measured from the whole
    // document, not the page edges), instead of always defaulting to
    // 'left'. A line whose midpoint sits near the column's midpoint,
    // with roughly equal empty space on both sides, is centered; one
    // that hugs the right edge of the column but not the left is
    // right-aligned; otherwise left.
    if (paraLines.length < 2) {
      const l = paraLines[0];
      if (!l || !(contentRightPt > contentLeftPt)) return 'left';
      const colW = contentRightPt - contentLeftPt;
      const leftGap = l.xPt - contentLeftPt;
      const rightGap = contentRightPt - (l.xPt + l.wPt);
      const gapTol = Math.max(6, colW * 0.04);
      if (Math.abs(leftGap - rightGap) < gapTol && leftGap > colW * 0.08) return 'center';
      if (rightGap < gapTol && leftGap > colW * 0.15) return 'right';
      return 'left';
    }
    const lefts = paraLines.map(l => l.xPt);
    const rights = paraLines.map(l => l.xPt + l.wPt);
    const mids = paraLines.map(l => l.xPt + l.wPt / 2);
    const leftConsistent = variance(lefts) < tolerance;
    // Exclude the last line (often shorter) when checking right-edge consistency for justify
    const rightsExceptLast = rights.slice(0, -1);
    const rightConsistent = rightsExceptLast.length > 1 ? variance(rightsExceptLast) < tolerance : false;
    const midConsistent = variance(mids) < tolerance;
    if (leftConsistent && rightConsistent) return 'justify';
    if (midConsistent && !leftConsistent) return 'center';
    if (leftConsistent) return 'left';
    if (variance(rights) < tolerance) return 'right';
    return 'left';
  }

  // ---- LIST MARKER DETECTION (bullets/numbering) ----
  // Looks at the start of a paragraph's first line for a bullet or
  // numbering marker (bullet dot, "1.", "a)", "(i)", "A.", etc.). When
  // found, the marker is stripped from the translatable text and the
  // paragraph is flagged so buildFlowingDocx can give it REAL Word
  // numbering (w:numPr) instead of leaving a literal marker character
  // sitting in the translated text - real numbering survives
  // translation (only the text after the marker gets translated, the
  // marker itself is regenerated by Word) and indents correctly.
  const LIST_BULLET_RE = /^[•▪◦‣∙○●*·-]\s+/;
  const LIST_DECIMAL_RE = /^(\d{1,3})[.)]\s+/;
  const LIST_ROMAN_RE = /^\(?([ivxlcdmIVXLCDM]{1,6})[.)]\s+/;
  const LIST_ALPHA_RE = /^\(?([a-zA-Z])[.)]\s+/;
  function v14DetectListMarker(text) {
    const t = String(text || '');
    if (LIST_BULLET_RE.test(t)) return { type: 'bullet', clean: t.replace(LIST_BULLET_RE, '') };
    let m = t.match(LIST_DECIMAL_RE);
    if (m) return { type: 'decimal', clean: t.slice(m[0].length) };
    // Roman is checked before generic alpha, since a lone "i." or "iv."
    // would otherwise be caught by the single-letter alpha pattern too.
    // IMPORTANT: only multi-character sequences ("ii.", "iv.", "xii.")
    // are treated as roman. A single letter is NEVER classified as
    // roman even though some single letters (I, V, X, L, C, D, M) are
    // technically valid roman numerals - a document numbering its
    // recitals A, B, C would otherwise have "C." misread as roman
    // numeral 100 the moment the sequence reached the letter C, breaking
    // the list into a fresh "I." instead of continuing "C.".
    m = t.match(LIST_ROMAN_RE);
    if (m && m[1].length >= 2 && /^[ivxlcdmIVXLCDM]+$/.test(m[1])) {
      return { type: /[IVXLCDM]/.test(m[1]) ? 'upperRoman' : 'lowerRoman', clean: t.slice(m[0].length) };
    }
    m = t.match(LIST_ALPHA_RE);
    if (m) return { type: /[A-Z]/.test(m[1]) ? 'upperLetter' : 'lowerLetter', clean: t.slice(m[0].length) };
    return null;
  }

  // ---- CHARACTER SPACING (tracking) DETECTION ----
  // Compares a line's real measured (natural) text width against its
  // actual bounding-box width from the PDF's own text layer. If the box
  // is meaningfully wider than the text naturally renders, the source
  // used letter-spacing/tracking (common in headers like "A G R E E
  // M E N T" or spaced-out emphasis) - return the extra width per
  // character gap, in points, so it can be applied as a real w:spacing
  // value on the run instead of being silently lost.
  function v14DetectTracking(line) {
    if (!line || !line.runs || !line.runs.length) return 0;
    const text = line.runs.map(r => r.text).join('');
    const charCount = text.replace(/\s/g, '').length;
    if (charCount < 2) return 0;
    const r0 = line.runs[0];
    const natural = measureTextPt(text, r0.sizePt || 11, r0.family, r0.bold, r0.italic);
    if (!(natural > 0) || !(line.wPt > natural)) return 0;
    const extra = (line.wPt - natural) / Math.max(1, charCount - 1);
    // Cap - beyond ~2pt/char it's almost certainly a measurement glitch
    // (e.g. a column gap wrongly folded into one line), not real tracking.
    if (extra < 0.3 || extra > 2) return 0;
    return extra;
  }

  // Whether a language LABEL (as typed into the target-language field,
  // e.g. "Arabic", "English", "Hebrew (Israel)") reads right-to-left.
  // Direction/alignment in the OUTPUT must follow the language being
  // translated INTO, not whatever the source document happened to be -
  // a paragraph translated from Arabic into English is English text
  // now and belongs left-aligned/LTR, even though every geometric
  // signal extracted from the source PDF said "this was a right-to-
  // left line". Carrying the source's direction straight through to a
  // translated-to-English output is what put paragraphs against the
  // right margin, in RTL reading order, when they should read left to
  // right like the rest of the English document.
  function v14IsRtlLanguage(label) {
    return /\b(arabic|hebrew|urdu|farsi|persian|dari|pashto|yiddish|sorani|kurdish)\b/i.test(String(label || ''));
  }

  // MARGIN_TWIPS is only the FALLBACK for a page with no detected
  // content at all - real pages get their margins measured from where
  // their own text/images actually sit (see computePageMargins below).
  const MARGIN_TWIPS = 1440; // 1 inch
  const MIN_MARGIN_TWIPS = 432;  // 0.3"  floor  - never crush content to the edge
  const MAX_MARGIN_TWIPS = 2160; // 1.5"  ceiling - never balloon from one outlier

  // Measures the real left/top/right/bottom extent of a page's content
  // (paragraphs + images) and turns it into section margins, instead of
  // always forcing the generic 1-inch default regardless of how the
  // source document was actually laid out.
  function computePageMargins(pg) {
    const items = pg.paragraphs.concat(pg.images || []).concat(pg.tables || []);
    if (!items.length) {
      return { top: MARGIN_TWIPS, right: MARGIN_TWIPS, bottom: MARGIN_TWIPS, left: MARGIN_TWIPS };
    }
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    items.forEach(function (it) {
      const l = it.leftPt != null ? it.leftPt : it.xPt;
      const r = it.rightPt != null ? it.rightPt : (it.xPt + it.wPt);
      const t = it.topPt != null ? it.topPt : it.yPt;
      const b = it.bottomPt != null ? it.bottomPt : (it.yPt + it.hPt);
      if (l < left) left = l;
      if (r > right) right = r;
      if (t < top) top = t;
      if (b > bottom) bottom = b;
    });
    const pad = 4; // small breathing room in points so glyphs don't kiss the margin
    const clamp = v => Math.max(MIN_MARGIN_TWIPS, Math.min(MAX_MARGIN_TWIPS, Math.round(v * 20)));
    return {
      left: clamp(Math.max(0, left - pad)),
      top: clamp(Math.max(0, top - pad)),
      right: clamp(Math.max(0, pg.wPt - right - pad)),
      bottom: clamp(Math.max(0, pg.hPt - bottom - pad))
    };
  }

  // ── ClaudeDebug live-switchable strategies (see admin "🤖 Claude" tab) ──
  // Persisted via localStorage - a selection made once should stay
  // selected across page reloads / new sessions, not just live in
  // memory for the current tab.
  function _ocrPageBreakStrategy() {
    // FINALIZED per explicit direction: Solution 2 (forced-budget-
    // aggressive: forced page break per source page + 25% flat spacing
    // reduction) is now the ONLY, permanent OCR page-break behavior.
    // The admin "Claude" tab's strategy dropdown (which offered 9
    // experimental options while this was being decided) has been
    // removed accordingly, per its own stated philosophy: once a
    // solution is confirmed correct, it becomes permanent and the
    // other options are removed rather than left selectable.
    return 'forced-budget-aggressive';
  }
  function _ocrShouldForceBreak() {
    const s = _ocrPageBreakStrategy();
    return s !== 'natural' && s !== 'absolute-position';
  }

  // ── PAGE SPACING COMPACTION (Solution 2, FINALIZED) ─────────────────────
  // Multiple genuinely different approaches to the "source page N content
  // lands on output page N+1" problem were built and tested live from the
  // admin "Claude" tab; Solution 2 (spacing-only, 25% flat reduction) was
  // confirmed correct and is now the sole, permanent behavior - the other
  // 8 (Solution 1's milder 0.85 ratio, font-reduce, margin-tighten,
  // combined-mild, forced-nobudget, natural, absolute-position's separate
  // box pipeline, and the server feedback-loop) have been removed, per the
  // admin tab's own stated philosophy: once a solution is confirmed, it
  // becomes permanent and the alternatives are removed rather than left
  // selectable. The 0.75 ratio itself follows the same empirical-
  // calibration approach used for the original 0.85 value (see
  // py/calibrate_compaction_ratio.py) - actually re-rendering real
  // documents at candidate ratios rather than guessing.
  const BUDGET_LINE_FLOOR_TWIPS = 200;       // ~single-spacing floor, never go tighter
  const BUDGET_SPACE_AFTER_FLOOR_TWIPS = 40; // ~2pt floor between paragraphs

  function applyPageHeightBudget(pg) {
    // FINALIZED per explicit direction: only Solution 2 (spacing-only,
    // 25% reduction - same lever as Solution 1, just more aggressive)
    // just more aggressive) is used now. The other 7 experimental
    // strategies (font-reduce, margin-tighten, combined-mild,
    // forced-nobudget, natural, absolute-position's separate pipeline,
    // feedback-loop) have been removed from this function entirely, per
    // the admin "Claude" tab's own stated philosophy: once a solution is
    // confirmed correct, it becomes permanent and the others are
    // removed rather than left selectable.
    const SPACING_RATIO = 0.75;
    (pg.paragraphs || []).forEach(function (p) {
      p.lineTwips = Math.max(BUDGET_LINE_FLOOR_TWIPS, Math.round((p.lineTwips || 276) * SPACING_RATIO));
      p.spaceAfterTwips = Math.max(
        BUDGET_SPACE_AFTER_FLOOR_TWIPS,
        Math.round((p.spaceAfterTwips != null ? p.spaceAfterTwips : 160) * SPACING_RATIO)
      );
    });
    // HONEST LIMITATION (unchanged from before): this is a flat ratio
    // calibrated against ONE real document (py/calibrate_compaction_ratio.py).
    // A page whose content is much denser than that calibration case
    // could still overflow.
  }

  // ── Solution 8: REAL server-verified feedback loop ─────────────────────
  // Genuinely different architecture from 1/2/5/6/7 above: instead of
  // trusting any fixed ratio (calibrated or reasoned), this generates the
  // document, asks the SERVER to actually render it with LibreOffice and
  // report the real page count (py: _handle_ocr_check_page_count), and
  // increases compaction and regenerates if it's still too many pages -
  // repeating against real ground truth each time, bounded to a handful
  // of attempts so it can't loop forever on a pathological document.
  async function buildWithFeedbackLoop(pages, sourcePageCount, logFn) {
    const MAX_ATTEMPTS = 6;
    let ratio = 1.0;
    let lastBlob = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // Re-apply the CURRENT attempt's ratio fresh each time (paragraphs
      // were already possibly scaled by a previous attempt - always
      // scale from the page's original captured values, not
      // compounding shrinkage attempt over attempt).
      pages.forEach(function (pg) {
        (pg.paragraphs || []).forEach(function (p) {
          if (p._origLineTwips == null) p._origLineTwips = p.lineTwips;
          if (p._origSpaceAfterTwips == null) p._origSpaceAfterTwips = p.spaceAfterTwips;
          p.lineTwips = Math.max(BUDGET_LINE_FLOOR_TWIPS, Math.round(p._origLineTwips * ratio));
          p.spaceAfterTwips = Math.max(BUDGET_SPACE_AFTER_FLOOR_TWIPS, Math.round(p._origSpaceAfterTwips * ratio));
        });
      });
      const blob = await buildFlowingDocx(pages); // applyPageHeightBudget no-ops for 'feedback-loop' strategy - compaction is applied above instead
      lastBlob = blob;

      let pageCount = null;
      try {
        const b64 = await new Promise(function (resolve, reject) {
          const reader = new FileReader();
          reader.onload = function () { resolve(String(reader.result).split(',')[1]); };
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        const resp = await fetch('/api/ocr/check-page-count', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (window.__lexoraAuthToken || '') },
          body: JSON.stringify({ docxBase64: b64 })
        });
        const data = await resp.json();
        if (data && data.ok) pageCount = data.pageCount;
        else if (logFn) logFn('Feedback loop: page-count check failed (' + ((data && data.error) || 'unknown') + ') - using this attempt as-is', 'warn');
      } catch (e) {
        if (logFn) logFn('Feedback loop: page-count check request failed - using this attempt as-is', 'warn');
      }

      if (logFn) logFn('Feedback loop attempt ' + attempt + ': ratio=' + ratio.toFixed(2) + ' -> ' + (pageCount == null ? 'unknown' : pageCount) + ' page(s) (source has ' + sourcePageCount + ')', 'info');

      if (pageCount == null || pageCount <= sourcePageCount) {
        return blob; // real ground truth confirms this fits (or the check itself failed - don't loop forever on that)
      }
      ratio -= 0.05; // real evidence says still too many pages - tighten and try again
      if (ratio < 0.5) break; // don't compress into illegibility chasing a pathological document
    }
    if (logFn) logFn('Feedback loop: reached ' + MAX_ATTEMPTS + ' attempts without matching source page count exactly - using the tightest attempt', 'warn');
    return lastBlob;
  }


  function buildFlowingDocx(pages) {
    const zip = new JSZip();
    const jcMap = { left: 'left', center: 'center', right: 'right', justify: 'both' };
    const media = []; // { relId, file, base64 }
    let drawIdCounter = 500;
    let mediaCounter = 0;

    function sectPrXml(pg) {
      const w = Math.round(pg.wPt * 20), h = Math.round(pg.hPt * 20);
      const m = pg.margins || { top: MARGIN_TWIPS, right: MARGIN_TWIPS, bottom: MARGIN_TWIPS, left: MARGIN_TWIPS };
      return '<w:pgSz w:w="' + w + '" w:h="' + h + '"/>' +
        '<w:pgMar w:top="' + m.top + '" w:right="' + m.right + '" w:bottom="' + m.bottom +
        '" w:left="' + m.left + '" w:header="720" w:footer="720" w:gutter="0"/>';
    }

    // One <w:r> per SEGMENT, not per paragraph - a paragraph with a
    // bold company name followed by regular body text now keeps both
    // styles instead of collapsing to a single dominant one. A segment
    // marked lineBreakBefore (address/signature-style paragraphs) opens
    // with a real <w:br/> so the original hard line break survives
    // instead of being flattened into flowing, space-joined text.
    function segRunXml(seg, trackingPt) {
      const sz = Math.max(2, Math.round((seg.sizePt || 11) * 2));
      const col = /^[0-9A-F]{6}$/i.test(seg.color || '') ? seg.color.toUpperCase() : '000000';
      const fam = esc(seg.family || 'Arial');
      const spacing = trackingPt ? ' <w:spacing w:val="' + Math.round(trackingPt * 20) + '"/>' : '';
      const br = seg.lineBreakBefore ? '<w:br/>' : '';
      return '<w:r><w:rPr>' +
        '<w:rFonts w:ascii="' + fam + '" w:hAnsi="' + fam + '" w:cs="' + fam + '"/>' +
        (seg.bold ? '<w:b/><w:bCs/>' : '') +
        (seg.italic ? '<w:i/><w:iCs/>' : '') +
        '<w:color w:val="' + col + '"/>' +
        '<w:sz w:val="' + sz + '"/><w:szCs w:val="' + sz + '"/>' + spacing +
        '</w:rPr>' + br + '<w:t xml:space="preserve">' + esc(seg.text) + '</w:t></w:r>';
    }
    // Item - PDF text extraction sometimes represents the space between
    // two words purely via horizontal KERNING/positioning rather than an
    // actual space glyph in the text stream - this seems to specifically
    // happen right at a style change (e.g. regular text ending, a bold
    // term beginning), which is exactly where a paragraph gets split into
    // separate segments/runs here. The result: "hereinafter, AF Logistics"
    // in the source PDF was losing its space and coming out as
    // "hereinafter,AF Logistics" in the translated output, only ever at
    // segment boundaries, never within a single (same-style) run of text.
    // This adds a space back between two adjacent segments' text UNLESS
    // one is already there, or the boundary is right after opening
    // punctuation ("(", "[", "{", a quote) or right before closing
    // punctuation (")", "]", "}", ",", ".", ";", ":", "!", "?", a quote) -
    // those genuinely shouldn't get a space, so this only fills in the
    // gap for actual word-to-word boundaries.
    function v14NeedsSpaceBetween(prevText, nextText) {
      if (!prevText || !nextText) return false;
      if (/\s$/.test(prevText) || /^\s/.test(nextText)) return false;
      if (/[(\[{'"\u2018\u201c]$/.test(prevText)) return false;
      if (/^[)\]},.;:!?'"\u2019\u201d]/.test(nextText)) return false;
      return true;
    }
    function paragraphRunsXml(p) {
      const segs = p.segments || [];
      return segs.map(function (seg, i) {
        if (!seg.text) return seg.lineBreakBefore ? '<w:r><w:br/></w:r>' : '';
        let text = seg.text;
        if (i > 0 && !seg.lineBreakBefore) {
          const prev = segs[i - 1];
          if (prev && prev.text && v14NeedsSpaceBetween(prev.text, text)) {
            text = ' ' + text;
          }
        }
        return segRunXml(Object.assign({}, seg, { text: text }), p.trackingPt);
      }).join('');
    }

    // ---- NUMBERING (bullets/numbered clauses) ----
    // A fixed abstractNum per marker family (bullet / decimal / letters /
    // roman), and a fresh concrete <w:num> instance per unbroken run of
    // same-type list paragraphs so each run's numbering restarts at 1 -
    // exactly like the source document's own clause numbering did.
    const ABSTRACT_BY_TYPE = { bullet: 0, decimal: 1, lowerLetter: 2, upperLetter: 3, lowerRoman: 4, upperRoman: 5 };
    const numInstances = []; // { numId, abstractNumId }
    let nextNumId = 1;
    let openRun = null; // { type, numId }
    function numPrFor(listInfo) {
      if (!listInfo) { openRun = null; return ''; }
      if (!openRun || openRun.type !== listInfo.type) {
        const numId = nextNumId++;
        numInstances.push({ numId: numId, abstractNumId: ABSTRACT_BY_TYPE[listInfo.type] });
        openRun = { type: listInfo.type, numId: numId };
      }
      const lvl = Math.max(0, Math.min(2, listInfo.level || 0));
      return '<w:numPr><w:ilvl w:val="' + lvl + '"/><w:numId w:val="' + openRun.numId + '"/></w:numPr>';
    }

    function abstractNumXml(id, type) {
      const fmtMap = {
        bullet: { fmt: 'bullet', text: '•', font: 'Symbol' },
        decimal: { fmt: 'decimal', text: '%1.', font: null },
        lowerLetter: { fmt: 'lowerLetter', text: '%1.', font: null },
        upperLetter: { fmt: 'upperLetter', text: '%1.', font: null },
        lowerRoman: { fmt: 'lowerRoman', text: '%1.', font: null },
        upperRoman: { fmt: 'upperRoman', text: '%1.', font: null }
      };
      const d = fmtMap[type];
      const rPr = d.font ? '<w:rPr><w:rFonts w:ascii="' + d.font + '" w:hAnsi="' + d.font + '"/></w:rPr>' : '';
      let lvls = '';
      for (let lvl = 0; lvl < 3; lvl++) {
        const indent = 360 + lvl * 360;
        // Item - the exact, confirmed root cause of every sub-clause
        // showing "a." "a." instead of "a." "b.": this used the SAME
        // lvlText ("%1.") for all three ilvl levels. %N in OOXML
        // numbering refers to the Nth level's OWN counter (1-indexed by
        // depth), not "whichever level this <w:lvl> node happens to be" -
        // ilvl=0 needs %1, ilvl=1 needs %2, ilvl=2 needs %3. With every
        // level hardcoded to %1, a sub-clause at ilvl=1 was displaying
        // ilvl=0's counter instead of its own - and since nothing at
        // ilvl=0 was actually incrementing between two sub-clauses of the
        // same top-level item, that borrowed counter just stayed on "a"
        // for both of them.
        const lvlText = d.text.replace('%1', '%' + (lvl + 1));
        lvls += '<w:lvl w:ilvl="' + lvl + '"><w:start w:val="1"/>' +
          '<w:numFmt w:val="' + d.fmt + '"/><w:lvlText w:val="' + esc(lvlText) + '"/>' +
          '<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="' + indent + '" w:hanging="360"/></w:pPr>' + rPr + '</w:lvl>';
      }
      return '<w:abstractNum w:abstractNumId="' + id + '">' + lvls + '</w:abstractNum>';
    }

    // ---- IMAGE placement ----
    // Each image keeps its original left/top position and size (scaled
    // to EMU) as a floating picture with square text-wrap, so the
    // paragraphs before and after it in the flow wrap around the same
    // reserved space the image occupied in the source, instead of the
    // image being silently dropped or the text ignoring it entirely.
    function imageXml(img, pg) {
      drawIdCounter++;
      mediaCounter++;
      const relId = 'rIdPic' + mediaCounter;
      const file = 'media/pic' + mediaCounter + '.jpg';
      media.push({ id: relId, file: file, base64: img.base64 });
      const cx = Math.max(1, Math.round(img.wPt * EMU));
      const cy = Math.max(1, Math.round(img.hPt * EMU));
      // Item - both earlier positioning attempts were still coordinate
      // math against a source PDF whose layout translation had already
      // changed: page-relative absolute (posOffset from the ORIGINAL
      // PDF's page coordinates) landed on the wrong page once
      // translated text reflowed the page breaks; paragraph-relative
      // fixed that, but a signature's original X (its offset from the
      // PDF's left margin) doesn't mean anything reliable once it's
      // sitting next to DIFFERENT text of a different length ("MARR
      // S.p.A." translated is shorter than the source line it used to
      // share a page position with) - it ended up landing mid-word,
      // splitting "MARR" from "S.p.A." right where the pen graphic sat.
      // An inline image sidesteps coordinate math entirely: it's placed
      // as its own paragraph, right where the sorted `flow` array
      // (caller) already puts it among the surrounding paragraphs, and
      // Word lays it out exactly like it would any other line of
      // content - no absolute or relative offset to get wrong, and it
      // can never overlap neighbouring text since it isn't floating.
      return '<w:p><w:r><w:drawing>' +
        '<wp:inline distT="0" distB="0" distL="0" distR="0">' +
        '<wp:extent cx="' + cx + '" cy="' + cy + '"/>' +
        '<wp:effectExtent l="0" t="0" r="0" b="0"/>' +
        '<wp:docPr id="' + drawIdCounter + '" name="img' + drawIdCounter + '"/><wp:cNvGraphicFramePr/>' +
        '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
        '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
        '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
        '<pic:nvPicPr><pic:cNvPr id="' + drawIdCounter + '" name="pic.jpg"/><pic:cNvPicPr/></pic:nvPicPr>' +
        '<pic:blipFill><a:blip r:embed="' + relId + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
        '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>' +
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
        '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
    }

    // Item - a per-page BACKGROUND image (colored bands, borders, logos,
    // letterhead graphics - the source PDF page with body text painted
    // out, see pageBg capture in the extraction loop above), inserted as
    // its own zero-height paragraph right at the start of that page's
    // content flow (caller). behindDoc="1" + relativeFrom="page" is the
    // key combination: Word resolves "page" using whichever OUTPUT page
    // this specific anchor paragraph actually lands on, not a fixed
    // page-number - so as long as this paragraph is correctly positioned
    // FIRST in that page's own flow (which the caller guarantees), the
    // background stays correctly paired with its own content even after
    // translation reflow shifts which page number that ends up being.
    function pageBackgroundXml(dataUrl, wPt, hPt) {
      drawIdCounter++;
      mediaCounter++;
      const relId = 'rIdPic' + mediaCounter;
      const file = 'media/pic' + mediaCounter + '.jpg';
      const base64 = String(dataUrl || '').split(',')[1] || '';
      if (!base64) return '';
      media.push({ id: relId, file: file, base64: base64 });
      const cx = Math.max(1, Math.round(wPt * EMU));
      const cy = Math.max(1, Math.round(hPt * EMU));
      return '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="1" w:lineRule="exact"/></w:pPr><w:r><w:drawing>' +
        '<wp:anchor behindDoc="1" distT="0" distB="0" distL="0" distR="0" simplePos="0" locked="0" layoutInCell="1" allowOverlap="1" relativeHeight="' + drawIdCounter + '">' +
        '<wp:simplePos x="0" y="0"/>' +
        '<wp:positionH relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionH>' +
        '<wp:positionV relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionV>' +
        '<wp:extent cx="' + cx + '" cy="' + cy + '"/>' +
        '<wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>' +
        '<wp:docPr id="' + drawIdCounter + '" name="pagebg' + drawIdCounter + '"/><wp:cNvGraphicFramePr/>' +
        '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
        '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
        '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
        '<pic:nvPicPr><pic:cNvPr id="' + drawIdCounter + '" name="pagebg.jpg"/><pic:cNvPicPr/></pic:nvPicPr>' +
        '<pic:blipFill><a:blip r:embed="' + relId + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
        '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>' +
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
        '</pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r></w:p>';
    }

    // Longest single WORD's rendered width at a given font size - the
    // real minimum a column can be without forcing an ugly mid-word
    // break (Word only wraps at spaces/hyphens; a column narrower than
    // its longest word has no valid break point at all).
    function v14LongestWordWidthPt(text, sizePt, family) {
      const words = String(text || '').split(/\s+/).filter(Boolean);
      let max = 0;
      words.forEach(function (w) {
        const width = measureTextPt(w, sizePt, family, false, false);
        if (width > max) max = width;
      });
      return max;
    }

    // ---- TABLE rendering ----
    // A detected table becomes a real <w:tbl> (not flowing paragraphs),
    // with its own column grid and light borders so rows/columns stay
    // aligned instead of collapsing into one unlabelled run of text.
    // Column widths start from the source's detected proportions, but
    // every column is guaranteed at least as wide as its longest actual
    // word (post-translation, since translated labels are usually
    // longer than the source) - if that still doesn't fit the page,
    // the table's font shrinks first (down to a floor) rather than
    // words being force-broken mid-word.
    function tableXml(table, pg) {
      const nCols = table.colStarts.length;
      const marginLeftPt = pg.margins.left / 20, marginRightPt = pg.margins.right / 20;
      // Preserve the table's own original horizontal position relative
      // to the page margin, instead of always snapping it flush to the
      // page's overall left margin - the page margin is computed from
      // the TIGHTEST content on the page (which may be some other
      // paragraph or image), so a table that originally sat further
      // right/inset than that would otherwise render further left than
      // it ever was in the source.
      const tblIndentPt = Math.max(0, table.leftPt - marginLeftPt);
      const usableWidthPt = pg.wPt - marginLeftPt - marginRightPt - tblIndentPt;
      const naturalWidths = table.colStarts.map(function (x, i) {
        const nextX = i < nCols - 1 ? table.colStarts[i + 1] : table.rightPt;
        return Math.max(24, nextX - x);
      });
      const naturalTotal = naturalWidths.reduce(function (a, b) { return a + b; }, 0);

      const CELL_FONT_PT = 8, FLOOR_FONT_PT = 6, PADDING_PT = 10;
      // Per-GRID-COLUMN minimum: a spanning cell's word-width demand is
      // split evenly across the columns it covers, since its final
      // width will be the SUM of those columns.
      function minWidthsAt(fontPt) {
        const m = new Array(nCols).fill(16);
        table.grid.forEach(function (row) {
          row.forEach(function (cell) {
            if (!cell || !cell.text) return;
            const need = (v14LongestWordWidthPt(cell.text, fontPt, cell.family || 'Arial') + PADDING_PT) / cell.span;
            for (let k = cell.col; k < cell.col + cell.span && k < nCols; k++) {
              if (need > m[k]) m[k] = need;
            }
          });
        });
        return m;
      }

      // Shrink the font in steps until the SUM of per-word minimums
      // fits the page, or the floor is reached - a smaller (but still
      // legible) font is always preferable to a word being force-broken.
      let fontPt = CELL_FONT_PT;
      let mins = minWidthsAt(fontPt);
      let minTotal = mins.reduce(function (a, b) { return a + b; }, 0);
      while (minTotal > usableWidthPt && fontPt > FLOOR_FONT_PT) {
        fontPt = Math.max(FLOOR_FONT_PT, fontPt - 0.5);
        mins = minWidthsAt(fontPt);
        minTotal = mins.reduce(function (a, b) { return a + b; }, 0);
      }

      // Every column starts AT its own minimum - that floor is never
      // reduced again. Any page width left over after that is handed
      // out proportionally to the source's original column widths. If
      // the minimums alone already exceed the page (a very dense
      // table even at floor font), the table is simply allowed to run
      // wider than the page rather than crushing every column below
      // its own word-fit floor, which previously broke every column's
      // words at once instead of just the one genuine outlier.
      let widths;
      if (minTotal >= usableWidthPt) {
        widths = mins;
      } else {
        const extra = usableWidthPt - minTotal;
        widths = mins.map(function (m, i) { return m + extra * (naturalWidths[i] / naturalTotal); });
      }
      const total = widths.reduce(function (a, b) { return a + b; }, 0);

      const gridCols = widths.map(function (w) { return '<w:gridCol w:w="' + Math.round(w * 20) + '"/>'; }).join('');
      // Item - only draw a full grid of borders when the source PDF
      // actually had ruled lines detected for this table (see
      // hasRuledLines, set from extractOfflineTableLines above) - a
      // table found purely by text-alignment, with no real drawn border
      // in the source at all, gets just a thin header-underline instead
      // (the common convention for "borderless" financial-report
      // tables: a rule under the header row, nothing else), rather than
      // a uniform grid that was never actually in the original.
      const borderXml = table.hasRuledLines
        ? '<w:tblBorders>' +
          ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(function (side) {
            return '<w:' + side + ' w:val="single" w:sz="4" w:space="0" w:color="999999"/>';
          }).join('') + '</w:tblBorders>'
        : '<w:tblBorders>' +
          ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(function (side) {
            return '<w:' + side + ' w:val="none" w:sz="0" w:space="0" w:color="auto"/>';
          }).join('') + '</w:tblBorders>';
      const sz = Math.max(2, Math.round(fontPt * 2));
      let rowsXml = '';
      table.grid.forEach(function (row, rowIdx) {
        let cellsXml = '';
        // Item - borderless tables (no ruled lines found in the source,
        // see hasRuledLines above) still get ONE visual cue: a thin rule
        // under the header row, matching the common real-world
        // convention for this table style, instead of either a full
        // grid that was never there or literally zero visual structure
        // at all.
        const headerUnderline = (!table.hasRuledLines && rowIdx === 0)
          ? '<w:bottom w:val="single" w:sz="6" w:space="0" w:color="666666"/>'
          : '';
        const shade = (table.rowShades && table.rowShades[rowIdx])
          ? '<w:shd w:val="clear" w:color="auto" w:fill="' +
            table.rowShades[rowIdx].map(function (v) { return v.toString(16).padStart(2, '0'); }).join('').toUpperCase() + '"/>'
          : '';
        const tcBorders = headerUnderline ? '<w:tcBorders>' + headerUnderline + '</w:tcBorders>' : '';
        const rowShadeColor = table.rowShades && table.rowShades[rowIdx];
        // Luminance check: a genuinely DARK header/row fill (common for
        // a bold-colored header band) needs white text for readability -
        // the source's own text color at that spot is often black
        // simply because the PDF renderer draws glyphs in whatever the
        // page's default text color is, on TOP of the colored fill
        // underneath, which still looks fine in the original but would
        // read as black-on-dark-navy (illegible) once shading is added
        // here without this check.
        const shadeIsDark = rowShadeColor && (0.299 * rowShadeColor[0] + 0.587 * rowShadeColor[1] + 0.114 * rowShadeColor[2]) < 128;
        row.forEach(function (cell) {
          let w = 0;
          for (let k = cell.col; k < cell.col + cell.span && k < nCols; k++) w += widths[k] || 40;
          const bold = cell.bold ? '<w:b/><w:bCs/>' : '';
          const italic = cell.italic ? '<w:i/><w:iCs/>' : '';
          let col = /^[0-9A-F]{6}$/i.test(cell.color || '') ? cell.color.toUpperCase() : '000000';
          if (shadeIsDark && col === '000000') col = 'FFFFFF';
          const fam = esc(cell.family || 'Arial');
          const span = cell.span > 1 ? '<w:gridSpan w:val="' + cell.span + '"/>' : '';
          cellsXml += '<w:tc><w:tcPr><w:tcW w:w="' + Math.round(w * 20) + '" w:type="dxa"/>' + span + tcBorders + shade + '</w:tcPr>' +
            '<w:p><w:pPr><w:spacing w:before="20" w:after="20"/></w:pPr><w:r><w:rPr>' + bold + italic +
            '<w:rFonts w:ascii="' + fam + '" w:hAnsi="' + fam + '" w:cs="' + fam + '"/>' +
            '<w:color w:val="' + col + '"/><w:sz w:val="' + sz + '"/><w:szCs w:val="' + sz + '"/></w:rPr>' +
            '<w:t xml:space="preserve">' + esc(cell.text) + '</w:t></w:r></w:p></w:tc>';
        });
        rowsXml += '<w:tr>' + cellsXml + '</w:tr>';
      });
      return '<w:tbl><w:tblPr><w:tblW w:w="' + Math.round(total * 20) + '" w:type="dxa"/>' +
        '<w:tblInd w:w="' + Math.round(tblIndentPt * 20) + '" w:type="dxa"/>' + borderXml +
        '<w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>' + gridCols + '</w:tblGrid>' + rowsXml + '</w:tbl>';
    }

  let bodyXml = '';
  let lastPageSectPrWritten = false;
  pages.forEach(function (pg, pIdx) {
    pg.margins = computePageMargins(pg);
    applyPageHeightBudget(pg);
    const isLastPage = pIdx === pages.length - 1;

      // Interleave paragraphs, images and tables in original vertical
      // reading order, so an image or table that sat between two
      // paragraphs in the source still sits between the SAME two
      // paragraphs here.
      const flow = pg.paragraphs.map(function (p) { return { kind: 'para', topPt: p.topPt, data: p }; })
        .concat((pg.images || []).map(function (im) { return { kind: 'image', topPt: im.yPt, data: im }; }))
        .concat((pg.tables || []).map(function (t) { return { kind: 'table', topPt: t.topPt, data: t }; }));
      flow.sort(function (a, b) { return a.topPt - b.topPt; });

      // ROOT CAUSE FOUND (confirmed against a real reported document,
      // not assumed): the page-break condition below used to ALSO
      // require pg.pageBg to be truthy. For a document with no
      // letterhead/colored-band design - i.e. a genuinely plain white
      // page, which is the OVERWHELMING MAJORITY of real-world text
      // documents including the one this was debugged against -
      // pg.pageBg is DELIBERATELY null (see the "skip embedding
      // entirely if this page's cleaned background is just plain
      // white" optimization in the extraction loop above). That meant
      // the page-break condition NEVER fired for any plain document,
      // for ANY page, ever - the entire multi-page source PDF flowed
      // as one single unbroken stream, with ZERO enforcement of source
      // page boundaries. Word/LibreOffice then paginated it however
      // content happened to fit, completely disconnected from where
      // the source PDF's own pages actually ended - which is exactly
      // why page 3's content was landing on an output page 4 with no
      // relationship to the real page 3 boundary at all.
      //
      // FIX: the page break is now driven ONLY by "does this source
      // page have real content" (flow.length > 0), completely
      // decoupled from whether there's also a background image worth
      // preserving. Source-page correspondence is a harder requirement
      // than "don't waste space for plain documents" - preserving it
      // for EVERY document (plain or designed) matters more than the
      // old space-saving optimization, which is now handled instead by
      // the page-height-budget compaction above (applyPageHeightBudget)
      // minimizing how much any given page needs to spill over, rather
      // than skipping the boundary that spillage should have respected
      // in the first place.
      if (pIdx > 0 && flow.length > 0 && _ocrShouldForceBreak()) {
        bodyXml += '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
      }

      // Background image rendering stays conditional on pg.pageBg -
      // this part genuinely only applies when there's a real design to
      // preserve, independent of the page-break decision above.
      if (pg.pageBg && flow.length > 0) {
        bodyXml += pageBackgroundXml(pg.pageBg, pg.wPt, pg.hPt);
      }

      flow.forEach(function (item, idx) {
        const isLastFlowItem = idx === flow.length - 1;
        if (item.kind === 'image') {
          bodyXml += imageXml(item.data, pg);
          if (isLastPage && isLastFlowItem) {
            bodyXml += '<w:p><w:pPr><w:sectPr>' + sectPrXml(pg) + '</w:sectPr></w:pPr></w:p>';
            lastPageSectPrWritten = true;
          }
          return;
        }
        if (item.kind === 'table') {
          bodyXml += tableXml(item.data, pg);
          // OOXML requires a paragraph immediately following a table
          // (a table can't be the literal last thing before a section
          // break or the body's end) - this doubles as that spacer and,
          // when the table is the page's last item, carries the actual
          // section-break properties.
          bodyXml += '<w:p>' + (isLastPage && isLastFlowItem ? '<w:pPr><w:sectPr>' + sectPrXml(pg) + '</w:sectPr></w:pPr>' : '') + '</w:p>';
          if (isLastPage && isLastFlowItem) lastPageSectPrWritten = true;
          return;
        }
        const p = item.data;
        const runsXml = paragraphRunsXml(p);
        const isLastParagraph = isLastPage && isLastFlowItem;
        const pPr = '<w:pPr><w:spacing w:before="0" w:after="' + (p.spaceAfterTwips != null ? p.spaceAfterTwips : 160) +
          '" w:line="' + (p.lineTwips || 276) + '" w:lineRule="auto"/>' +
          '<w:jc w:val="' + (jcMap[p.align] || 'left') + '"/>' +
          numPrFor(p.listInfo) +
          (p.rtl ? '<w:bidi/>' : '') +
          (isLastParagraph ? '<w:sectPr>' + sectPrXml(pg) + '</w:sectPr>' : '') +
          '</w:pPr>';
        bodyXml += '<w:p>' + pPr + runsXml + '</w:p>';
        if (isLastParagraph) lastPageSectPrWritten = true;
      });

      // Item - genuine root cause of a stray, entirely blank trailing
      // page (3-page source PDF becoming 5 output pages, with the last
      // one blank): this specifically EXCLUDED the case where the LAST
      // PDF page's own flow is empty (e.g. that page's real content is
      // reserved into a background/image with nothing else extractable
      // as a paragraph, or the page break inserted above for a detected
      // per-page background pushed onto a fresh page with nothing after
      // it). When that happens, no closing sectPr paragraph was EVER
      // written for it - leaving Word to end the document mid-section,
      // which routinely renders as a dangling extra blank page rather
      // than cleanly finishing on the previous page's content.
      if (flow.length === 0 && !isLastPage) {
        bodyXml += '<w:p><w:pPr><w:sectPr>' + sectPrXml(pg) + '</w:sectPr></w:pPr></w:p>';
      }
    });

    // SECOND, independent cause of the SAME "3-page source PDF -> 5
    // output pages, blank last page" symptom (confirmed via real
    // OOXML inspection, not assumed): the block above already writes
    // a closing <w:sectPr> INSIDE the last real paragraph/image/table's
    // own <w:pPr> for the last page (see lastPageSectPrWritten). The
    // trailing body-level <w:sectPr> below is REQUIRED when that never
    // happened (e.g. the very last page's flow was genuinely empty),
    // but was previously being written UNCONDITIONALLY regardless -
    // producing a paragraph with its own embedded closing sectPr
    // immediately followed by a second, completely empty section (a
    // <w:sectPr> as a bare <w:body> child with no paragraph before the
    // next one), which Word/LibreOffice render as one extra blank page
    // to satisfy "every section needs at least an empty page". Only
    // emit it now if the loop above never already closed the last
    // section.
    const trailingSectPr = lastPageSectPrWritten
      ? ''
      : '<w:sectPr>' + sectPrXml(pages[pages.length - 1]) + '</w:sectPr>';

    const documentXml =
'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
'<w:body>' + bodyXml +
trailingSectPr + '</w:body></w:document>';

    const contentTypes =
'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
'<Default Extension="xml" ContentType="application/xml"/>' +
(media.length ? '<Default Extension="jpg" ContentType="image/jpeg"/>' : '') +
'<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
'<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
'<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
'</Types>';

    zip.file('[Content_Types].xml', contentTypes);

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

    // numbering.xml: fixed abstractNums (one per marker family) + one
    // concrete <w:num> per detected list run (built while walking the
    // paragraphs above, in numInstances).
    let numberingXml =
'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
'<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">';
    Object.keys(ABSTRACT_BY_TYPE).forEach(function (type) {
      numberingXml += abstractNumXml(ABSTRACT_BY_TYPE[type], type);
    });
    numInstances.forEach(function (n) {
      numberingXml += '<w:num w:numId="' + n.numId + '"><w:abstractNumId w:val="' + n.abstractNumId + '"/></w:num>';
    });
    numberingXml += '</w:numbering>';
    zip.file('word/numbering.xml', numberingXml);

    zip.file('word/document.xml', documentXml);

    let relsXml =
'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
'<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
'<Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>';
    media.forEach(function (m) {
      relsXml += '<Relationship Id="' + m.id + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="' + m.file + '"/>';
    });
    relsXml += '</Relationships>';
    zip.file('word/_rels/document.xml.rels', relsXml);
    media.forEach(function (m) { zip.file('word/' + m.file, m.base64, { base64: true }); });

    return zip.generateAsync({ type: 'blob',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  }

  function buildDocx(pages, includeBg, renderPageExtra){
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
      // renderPageExtra, when given, REPLACES the default per-line
      // rendering below - used by the paragraph-box mode (real Word
      // wrapping, no overflow risk - see paragraphBoxXml's own comment)
      // instead of the original fixed-width non-wrapping per-line boxes.
      // Kept as an OPTIONAL parameter: existing 2-arg callers (e.g. the
      // vision-OCR hybrid pipeline) are completely unaffected - this
      // only changes behavior when a caller explicitly opts in - rather
      // than duplicating this function's zip/rels/sectPr scaffolding
      // into a second near-identical function that could silently drift
      // out of sync with this one over time.
      if (renderPageExtra) {
        runs += renderPageExtra(pg, i);
      } else {
        pg.lines.forEach(function(L){
          if (L.runs.some(r => r.text && r.text.trim())) runs += textBoxXml(L);
        });
      }
      // Real embedded pictures/signatures (pg.images, extracted earlier
      // in buildOfflineDocxBlob - {xPt,yPt,wPt,hPt,base64} JPEGs) -
      // previously NOT carried into this rendering path at all (a known,
      // explicitly documented limitation when Solution 9 was first
      // built). Added now that Solution 9 is the user's preferred
      // strategy and the missing signature was reported as the one real
      // gap. Independent of includeBg - a signature is its own picture,
      // not part of the page background.
      (pg.images || []).forEach(function (im, imIdx) {
        if (!im.base64) return;
        const relId = 'rIdPageImg' + (i + 1) + '_' + (imIdx + 1);
        rels.push({ id: relId, file: 'media/pageimg' + (i + 1) + '_' + (imIdx + 1) + '.jpg', data: im.base64 });
        runs += floatingImageXml(relId, im.xPt, im.yPt, im.wPt, im.hPt, 'SIG');
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
    // Item - root cause of stray/wrong text colors (a gray "666666" or
    // similar showing up on text that should be plain black): this
    // never tracked PDF's own save/restore (q/Q) state at all. A fill
    // color set temporarily for some OTHER graphic element (a table
    // rule, a decorative shape, a border) inside its own save/restore
    // block is meant to be forgotten the moment that block's restore
    // happens - but `cur` here just kept whatever the last color-set op
    // was, permanently, regardless of save/restore, so ANY such
    // temporary graphic color happening to appear before real text in
    // the content stream leaked into that text's color entirely by
    // accident. Tracking a color stack alongside save/restore (the same
    // pattern already used for CTM tracking in extractOfflineImages/
    // extractOfflineTableLines) makes this respect the PDF's own
    // scoping the way any real renderer would.
    const colorStack = [];
    for (let i = 0; i < ops.fnArray.length; i++){
      const fn = ops.fnArray[i], args = ops.argsArray[i] || [];
      if (fn === F.save) {
        colorStack.push(cur);
      } else if (fn === F.restore) {
        if (colorStack.length) cur = colorStack.pop();
      } else if (fn === F.setFillRGBColor && args.length >= 3){
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

  // ---- IMAGE REGION DETECTION (for "space for image" reservation) ----
  // text-based mode only ever looked at the PDF's TEXT layer - any real
  // embedded image (logo, stamp, photo, diagram) was invisible to it, so
  // it was silently dropped from the flowing output entirely. This walks
  // the raw content-stream operator list, tracking the CTM (current
  // transformation matrix) through save/restore/transform ops exactly as
  // a PDF renderer would, and for every paintImageXObject/paintJpegXObject
  // op computes where the image's unit square lands in page space. That
  // gives real page-coordinate boxes we can later crop out of the
  // rendered page canvas and re-insert as their own picture in the
  // flowing document, with the surrounding paragraphs reading in the
  // same order as before/after it.
  async function extractOfflineImages(page, pageH, pageNo) {
    const F = pdfjsLib.OPS;
    let ops;
    try { ops = await page.getOperatorList(); } catch (e) { return []; }

    // Signature/form-field WIDGET annotations (e-signature fields, "sign
    // here" boxes) sometimes surface their appearance-stream artwork
    // through the same paint ops as real page content - that copy is
    // dropped (see overlapsAnnotation below) so it never becomes a
    // SECOND, duplicate picture. But the annotation itself may be a
    // real, meaningful signature (someone's actual pen-drawn signature,
    // captured as vector paths inside a nested Form XObject the way
    // most e-signature platforms render one - never a paintImageXObject
    // op this operator-list walk can see at all) - dropping it entirely
    // was throwing away real signed content, not just placeholder
    // stamps. Any Widget/Sig annotation that actually HAS visible
    // appearance content (hasAppearance - an unsigned, still-blank
    // field has none) is captured as its own image region instead, to
    // be cropped straight from the rendered page canvas below (the one
    // place that DOES know how to paint whatever's really inside a
    // signature field, vector paths included).
    let annotRects = [];
    let signatureRects = [];
    try {
      const annots = await page.getAnnotations({ intent: 'display' });
      const widgetAnnots = (annots || []).filter(function (a) { return a.subtype === 'Widget' || a.fieldType === 'Sig'; });
      annotRects = widgetAnnots.map(function (a) {
        const r = a.rect; // [x1, y1, x2, y2] in PDF user space (bottom-origin)
        const x0 = Math.min(r[0], r[2]), x1 = Math.max(r[0], r[2]);
        const y0 = Math.min(r[1], r[3]), y1 = Math.max(r[1], r[3]);
        return { xPt: x0, yPt: pageH - y1, wPt: x1 - x0, hPt: y1 - y0 };
      });
      signatureRects = widgetAnnots
        // hasAppearance === false means pdf.js is sure this field is
        // still blank/unsigned (nothing to crop); treat anything else
        // (true, or the property missing entirely on an older pdf.js
        // build) as "assume it might have real content" - the cost of
        // over-including an actually-blank field is one empty picture
        // in the output, not silently losing a real signature because
        // of a property name that turned out not to exist.
        .filter(function (a) { return a.hasAppearance !== false; })
        .map(function (a) {
          const r = a.rect;
          const x0 = Math.min(r[0], r[2]), x1 = Math.max(r[0], r[2]);
          const y0 = Math.min(r[1], r[3]), y1 = Math.max(r[1], r[3]);
          return { xPt: x0, yPt: pageH - y1, wPt: x1 - x0, hPt: y1 - y0 };
        });
    } catch (e) { /* annotations optional - proceed without the exclusion/signature lists */ }
    function overlapsAnnotation(box) {
      return annotRects.some(function (a) {
        const ox = Math.min(box.xPt + box.wPt, a.xPt + a.wPt) - Math.max(box.xPt, a.xPt);
        const oy = Math.min(box.yPt + box.hPt, a.yPt + a.hPt) - Math.max(box.yPt, a.yPt);
        return ox > 0 && oy > 0;
      });
    }

    const images = signatureRects.slice();
    const stack = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    function concat(base, add) {
      return [
        add[0] * base[0] + add[1] * base[2],
        add[0] * base[1] + add[1] * base[3],
        add[2] * base[0] + add[3] * base[2],
        add[2] * base[1] + add[3] * base[3],
        add[4] * base[0] + add[5] * base[2] + base[4],
        add[4] * base[1] + add[5] * base[3] + base[5]
      ];
    }
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i], args = ops.argsArray[i] || [];
      if (fn === F.save) {
        stack.push(ctm.slice());
      } else if (fn === F.restore) {
        ctm = stack.length ? stack.pop() : ctm;
      } else if (fn === F.transform) {
        ctm = concat(ctm, args);
      } else if (fn === F.paintFormXObjectBegin) {
        // Entering a Form XObject (letterheads/logos are often wrapped
        // in one) applies its own matrix on top of the current CTM,
        // exactly like an explicit "cm" - without this, any image drawn
        // inside the form inherits the OUTER transform only and lands
        // at the wrong page position.
        stack.push(ctm.slice());
        if (args && args[0]) ctm = concat(ctm, args[0]);
      } else if (fn === F.paintFormXObjectEnd) {
        ctm = stack.length ? stack.pop() : ctm;
      } else if (fn === F.paintImageXObject || fn === F.paintJpegXObject ||
                 fn === F.paintImageMaskXObject) {
        const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(function (p) {
          return [ctm[0] * p[0] + ctm[2] * p[1] + ctm[4], ctm[1] * p[0] + ctm[3] * p[1] + ctm[5]];
        });
        const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
        const minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
        const minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
        const wPt = maxX - minX, hPt = maxY - minY;
        // Skip slivers - hairline rules/underlines are sometimes drawn as
        // 1px-tall images and shouldn't reserve a picture box.
        if (wPt < 10 || hPt < 10) continue;
        const box = { xPt: minX, yPt: pageH - maxY, wPt: wPt, hPt: hPt };
        if (overlapsAnnotation(box)) continue;
        images.push(box);
      }
    }
    if (images.length) log('P' + pageNo + ': ' + images.length + ' image region(s) detected', 'info');
    return images;
  }

  async function extractOfflinePage(page, vp1, pageNo){
    const tc = await page.getTextContent();
    let colors = [];
    try { colors = await extractColors(page); } catch(e){ log('P' + pageNo + ' color extract fail: ' + e.message, 'warn'); }
    // Item - colors.length and tc.items.length routinely don't match
    // exactly (extractColors counts one entry per raw showText-family
    // OPERATOR call in the content stream, while tc.items is PDF.js's
    // OWN text-run segmentation, which splits/merges runs differently -
    // two different units of counting that were never actually
    // guaranteed to line up 1:1 in the first place). This used to
    // discard EVERY colour on the page the moment the two totals
    // disagreed even slightly, falling back to plain black for
    // literally all text - losing real colour information (e.g. a red
    // warning clause, a blue hyperlink) on what was probably just a
    // handful of runs near the mismatch, not the whole page. Using
    // colors[idx] directly instead: both arrays are still built in the
    // same stream/reading order, so a positional lookup is a reasonable
    // best-effort match per item, and simply falls back to black for
    // any individual item beyond what colour data is available -
    // instead of an all-or-nothing black wash for the entire page over
    // what's usually only a small count discrepancy.
    if (colors.length && colors.length !== tc.items.length) {
      log('P' + pageNo + ': color count is ' + colors.length + ' vs ' + tc.items.length + ' text item(s) - matching by position, not discarding', 'info');
    }

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
        color: colors[idx] || '000000',
        srcIdx: idx   // original PDF content-stream order - the actual
                       // LOGICAL reading order, independent of visual
                       // x-position. Needed because right-to-left text
                       // sorted by x ends up in reverse reading order,
                       // and reversing that array again doesn't
                       // reliably restore correct order once embedded
                       // Latin numbers/punctuation (e.g. "(131)",
                       // "1435/4/3") are mixed into the RTL line -
                       // proper bidi text needs the ORIGINAL order, not
                       // a blanket reversal.
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
    // For an RTL line, reading order is NOT "sorted by x" (that's
    // visual/left-to-right order, which is backwards for Arabic/Hebrew
    // text) - it's the order the PDF's own content stream drew the
    // glyphs in, which is the true logical reading order. Geometry
    // (xPt/wPt/etc, above) stays based on visual position regardless;
    // only which order the TEXT gets read/joined in changes here.
    const ordered = rtl ? seg.slice().sort(function (a, b) { return a.srcIdx - b.srcIdx; }) : seg;
    return {
      xPt: x0,
      yPt: pageH - yBase - maxAsc,      // top-left, exact — koi shift nahi
      wPt: x1 - x0,                      // sirf sentence jitni width
      hPt: maxAsc + maxDesc,             // sabse bade text ki height
      rtl: rtl,
      runs: ordered.map(function(r){
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
      const rawImages = await extractOfflineImages(page, vp1.height, p);
      const tableLines = await extractOfflineTableLines(page, vp1.height);

      // WITH IMAGE (client-side render): text-layer extraction above used
      // the raw page at scale 1 (points) for exact coordinate math; this
      // is a separate, higher-pixel-scale render of the SAME page purely
      // for a crisp-looking background.
      //
      // BUG FIX: this canvas used to ONLY get created `if (withImage)`,
      // and cropping real embedded images (rawImages, above) out of it
      // was gated on that SAME canvas existing - so with "With Image"
      // left off (the default for plain text-based translation), any
      // real pictures the PDF actually contained were detected but then
      // silently dropped, every time, regardless of the user's intent
      // for the background. Preserving a document's actual embedded
      // pictures and rendering a nice page background are two different
      // things; a canvas is now built whenever EITHER is needed
      // (rawImages.length > 0 covers "this page really does have
      // pictures to keep"), and only used AS the background if withImage
      // is also on.
      let bgCanvas = null, bgScale = 1;
      let images = [];
      if (withImage || rawImages.length) {
        bgScale = Math.min(3.0, 2000 / Math.max(vp1.width, vp1.height));
        const bgVp = page.getViewport({ scale: bgScale });
        bgCanvas = document.createElement('canvas');
        bgCanvas.width = Math.round(bgVp.width);
        bgCanvas.height = Math.round(bgVp.height);
        // annotationMode renders Widget/signature-field appearances onto
        // this canvas too (not just the page's own content-stream ops) -
        // needed so a real pen-drawn signature (which lives entirely in
        // an annotation's appearance stream, often as vector paths a
        // simple operator-list walk can't see at all) actually has
        // pixels here to crop out for signatureRects, above.
        const annotationMode = (pdfjsLib.AnnotationMode && pdfjsLib.AnnotationMode.ENABLE_FORMS) || 2;
        await page.render({ canvasContext: bgCanvas.getContext('2d'), viewport: bgVp, annotationMode: annotationMode }).promise;

        // Crop each detected image/signature region out of the canvas
        // BEFORE any cleaning happens below, into its own small JPEG, so
        // it can be re-inserted as a real floating picture at its
        // original spot instead of being lost entirely. This MUST run
        // before the cleanImage step (not after, as it previously did):
        // a signature stamp routinely overlaps nearby real text (e.g.
        // sitting right across a party's printed name/company line just
        // above the signature block) - cropping after cleanImage would
        // pick up a chunk of that overlapping text having already been
        // painted white, i.e. a corner of the signature erased/cut off
        // before it was ever captured.
        images = [];
        if (rawImages.length) {
          rawImages.forEach(function (im) {
            const sx = Math.max(0, Math.round(im.xPt * bgScale));
            const sy = Math.max(0, Math.round(im.yPt * bgScale));
            const sw = Math.min(bgCanvas.width - sx, Math.round(im.wPt * bgScale));
            const sh = Math.min(bgCanvas.height - sy, Math.round(im.hPt * bgScale));
            if (sw < 4 || sh < 4) return;
            const crop = document.createElement('canvas');
            crop.width = sw; crop.height = sh;
            crop.getContext('2d').drawImage(bgCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
            images.push({
              xPt: im.xPt, yPt: im.yPt, wPt: im.wPt, hPt: im.hPt,
              base64: crop.toDataURL('image/jpeg', 0.92).split(',')[1]
            });
          });
        }

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
        // Only relevant when withImage is actually being used AS the
        // background - skip it when this canvas exists purely to crop
        // real pictures out of, since there's no background being kept.
        if (cleanImage && withImage) {
          const cctx = bgCanvas.getContext('2d');
          cctx.fillStyle = '#ffffff';
          const pad = 1;   // small padding so anti-aliased glyph edges don't peek out
          lines.forEach(function (L) {
            cctx.fillRect(L.xPt * bgScale - pad, L.yPt * bgScale - pad,
              L.wPt * bgScale + pad * 2, L.hPt * bgScale + pad * 2);
          });
          // Item - was only painting over TEXT regions, never the
          // page's own real images (rawImages, cropped separately just
          // above into `images`) - meaning a page's background snapshot
          // still had a full copy of, say, a chart or logo baked
          // straight into the background JPEG's pixels, UNEDITABLE and
          // impossible to exclude, WHILE that exact same picture also
          // got extracted and re-inserted as its own separate floating
          // image - the result was the same picture visibly appearing
          // TWICE in the output (once "trapped" in the background,
          // once as its own real picture). Painting over image regions
          // here too keeps the background genuinely limited to design
          // elements (colors, borders, letterhead) that aren't already
          // being carried through some other way.
          rawImages.forEach(function (im) {
            cctx.fillRect(im.xPt * bgScale - pad, im.yPt * bgScale - pad,
              im.wPt * bgScale + pad * 2, im.hPt * bgScale + pad * 2);
          });
          log('P' + p + ': background image cleaned (' + lines.length + ' text region(s), ' + rawImages.length + ' image region(s) painted over)');
        }
      }

      // Item - "does the source PDF have a per-page background (colored
      // bands, borders, logos, letterhead graphics - anything that
      // ISN'T the body text) that should carry through into the
      // translated Word doc?" The cleaned bgCanvas above (text regions
      // painted white, everything else untouched) is already exactly
      // the right image for that - genuinely NEW page content doesn't
      // need generating, just capturing before it goes out of scope.
      // Downscaled and JPEG-compressed here (not the full bgScale
      // canvas) since this is a big full-page image inserted once per
      // page - keeping every page's background at full 2000px-wide
      // resolution would make the output .docx enormous for no visible
      // benefit once it's sized down to a page in Word anyway.
      let pageBgDataUrl = null;
      if (bgCanvas) {
        // Item - skip embedding entirely if this page's cleaned
        // background is just plain white (the overwhelmingly common
        // case for ordinary text documents that have no real letterhead/
        // border/colored-band design) - a blank white full-page JPEG
        // adds real file size and Word-render cost for zero visible
        // difference from not having a background image at all. Sampled,
        // not every pixel - a 40x40 grid is more than enough to catch
        // any real design element while staying fast.
        const sctx = bgCanvas.getContext('2d');
        let hasVisibleContent = false;
        const full = sctx.getImageData(0, 0, bgCanvas.width, bgCanvas.height).data;
        const stepX = Math.max(1, Math.floor(bgCanvas.width / 40));
        const stepY = Math.max(1, Math.floor(bgCanvas.height / 40));
        outer:
        for (let y = 0; y < bgCanvas.height; y += stepY) {
          for (let x = 0; x < bgCanvas.width; x += stepX) {
            const idx = (y * bgCanvas.width + x) * 4;
            if (full[idx] < 250 || full[idx + 1] < 250 || full[idx + 2] < 250) { hasVisibleContent = true; break outer; }
          }
        }
        if (hasVisibleContent) {
          const maxBgPx = 1000;
          const bgDownscale = Math.min(1, maxBgPx / Math.max(bgCanvas.width, bgCanvas.height));
          if (bgDownscale < 1) {
            const small = document.createElement('canvas');
            small.width = Math.round(bgCanvas.width * bgDownscale);
            small.height = Math.round(bgCanvas.height * bgDownscale);
            small.getContext('2d').drawImage(bgCanvas, 0, 0, small.width, small.height);
            pageBgDataUrl = small.toDataURL('image/jpeg', 0.75);
          } else {
            pageBgDataUrl = bgCanvas.toDataURL('image/jpeg', 0.75);
          }
        }
      }

      pages.push({ lines: lines, images: images, wPt: vp1.width, hPt: vp1.height, pageBg: pageBgDataUrl, tableLines: tableLines });
      log('P' + p + ': ' + lines.length + ' text line(s) + ' + images.length + ' image(s) extracted (no API)');
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

    // ---- PARAGRAPH BUILDING (before translation) ----
    // Lines are grouped into paragraphs HERE, once, up front - not
    // re-derived later from gaps between whatever lines happen to
    // survive translation. That grouping drives everything: alignment,
    // list/numbering detection, line-spacing, paragraph-to-paragraph
    // spacing, and - critically for translation quality/reliability -
    // the unit that gets sent to the translation model. Translating one
    // combined string per PARAGRAPH instead of one call per raw PDF
    // LINE cuts the item count for a dense contract from hundreds down
    // to the real paragraph count, which both avoids response
    // truncation on long documents and stops the failure mode where
    // some lines silently keep their original-language text (because
    // their line ID didn't come back from a truncated response) while
    // neighbouring lines in the same visual paragraph got translated -
    // the exact "half English / half Italian in one paragraph" bug.
    pages.forEach(function (pg) {
      const allUsableLines = pg.lines.filter(function (L) { return L.runs.some(r => r.text && r.text.trim()); });

      // TABLE DETECTION runs first, on the FULL set of lines, so that
      // rows recognised as a table are pulled out of the pool BEFORE
      // paragraph grouping ever sees them - otherwise the paragraph
      // grouper (which only understands "close together = same
      // paragraph") would flatten a payment schedule's rows into
      // unlabelled runs of numbers, exactly as seen before this existed.
      const tableResult = v14DetectTables(allUsableLines, pg.tableLines && pg.tableLines.vLines);
      const usableLines = allUsableLines.filter(function (L) { return !tableResult.usedLines.has(L); });
      pg.tables = tableResult.tables.map(function (t) {
        const allX = t.rows.reduce(function (acc, R) { return acc.concat(R.lines.map(l => l.xPt)); }, []);
        const allX2 = t.rows.reduce(function (acc, R) { return acc.concat(R.lines.map(l => l.xPt + l.wPt)); }, []);
        const topPt = Math.min.apply(null, t.rows.map(R => R.yTop));
        const bottomPt = Math.max.apply(null, t.rows.map(R => R.yBottom));
        // Item - "does this table actually have drawn borders in the
        // source at all?" A genuinely ruled table (any real gridline
        // found overlapping its row range) keeps the existing uniform
        // grid rendering; a table detected PURELY from text-position
        // alignment (very common for financial tables that rely only on
        // whitespace, no visible ruling at all) renders with none -
        // matching the source's own borderless look instead of adding
        // visual structure that was never actually there.
        const hasRuledLines = !!(pg.tableLines && (
          (pg.tableLines.vLines || []).some(function (v) { return v.y1Pt >= topPt - 5 && v.y0Pt <= bottomPt + 5; }) ||
          (pg.tableLines.hLines || []).some(function (h) { return h.yPt >= topPt - 5 && h.yPt <= bottomPt + 5; })
        ));
        // Item - per-row shading: for each of this table's ROWS, is
        // there a detected fill (extractOfflineTableLines, above) whose
        // Y-range substantially covers this specific row? Matched by
        // ROW (not per-cell) since a shaded band almost always covers
        // an entire row's height in real documents (a colored header
        // bar, an alternating-row tint) - per-cell precision would add
        // real complexity for a case that essentially never occurs.
        const rowShades = t.rows.map(function (R) {
          const fills = (pg.tableLines && pg.tableLines.fills) || [];
          const match = fills.find(function (f) {
            const overlap = Math.min(f.yBottomPt, R.yBottom) - Math.max(f.yTopPt, R.yTop);
            return overlap > (R.yBottom - R.yTop) * 0.6;
          });
          return match ? match.color : null;
        });
        return {
          grid: v14BuildTableGrid(t),
          colStarts: t.colStarts,
          topPt: topPt,
          bottomPt: bottomPt,
          rowShades: rowShades,
          leftPt: Math.min.apply(null, allX),
          rightPt: Math.max.apply(null, allX2),
          rtl: t.rows.some(function (R) { return R.lines.some(function (L) { return L.rtl; }); }),
          hasRuledLines: hasRuledLines
        };
      });
      if (pg.tables.length) log(pg.tables.length + ' table(s) detected (' + tableResult.usedLines.size + ' line(s) reserved for table cells)', 'info');

      const contentLeftPt = usableLines.length ? Math.min.apply(null, usableLines.map(l => l.xPt)) : 0;
      const contentRightPt = usableLines.length ? Math.max.apply(null, usableLines.map(l => l.xPt + l.wPt)) : pg.wPt;
      // Persisted onto pg (not just this loop-scoped const) so Solution
      // 9's paragraph-box mode can use the SAME real content-column
      // boundary already computed here for alignment detection, instead
      // of recomputing a second, potentially-inconsistent estimate.
      pg.contentLeftPt = contentLeftPt;
      pg.contentRightPt = contentRightPt;
      const groups = v14GroupLinesIntoParagraphs(usableLines);

      const paragraphs = groups.map(function (paraLines) {
        const align = v14DetectAlignment(paraLines, pg.wPt, contentLeftPt, contentRightPt);
        const rtl = paraLines.some(l => l.rtl);
        const originalText = paraLines.map(function (L) {
          // L.runs is already in correct logical reading order (fixed
          // at extraction) - no reversal needed here either.
          return L.runs.map(r => r.text).join(' ');
        }).join(' ').replace(/\s+/g, ' ').trim();
        const listInfo = v14DetectListMarker(originalText);

        const isBlock = v14IsBlockParagraph(paraLines, contentRightPt - contentLeftPt);
        const segments = v14BuildSegments(paraLines, isBlock);
        // Strip the detected list marker out of the segments that
        // actually hold it - NOT always just "re-match the marker regex
        // against segments[0].text", because that regex requires
        // trailing whitespace+more-text to confirm a bare number is
        // really a marker (not just a naked "4)" that means something
        // else) - and a numbered clause's "4." is very often its OWN
        // separate BOLD run in the source PDF (clause labels are
        // frequently bold, the body text after them isn't), landing as
        // its own first segment with nothing but "4." in it. That
        // segment alone never matches the regex (no trailing text to
        // see), so it was never getting stripped - staying in as its
        // own literal bold "4." text run, sent to translation and
        // re-inserted, DUPLICATING the real Word auto-number this exact
        // marker was already correctly feeding into numPr below.
        if (listInfo && segments.length) {
          const markerMatch = originalText.match(/^([•▪◦‣∙○●*·-]|\(?[a-zA-Z0-9ivxlcdmIVXLCDM]{1,6}[.)])\s+/);
          const markerText = markerMatch ? markerMatch[1].trim() : null;
          if (markerText && segments[0].text.trim() === markerText) {
            // The marker was its OWN whole segment (e.g. a bold "4." with
            // nothing else in that run) - drop it entirely instead of
            // trying to strip text out of it.
            segments.shift();
            // Whatever's now first was originally the SECOND segment -
            // if it had lineBreakBefore set (only possible for a block
            // paragraph whose marker sat on its own physical line), that
            // would insert a stray blank line at the very start of the
            // paragraph now that it's actually the first thing in it.
            if (segments[0]) segments[0].lineBreakBefore = false;
          } else {
            const stripped = v14DetectListMarker(segments[0].text);
            if (stripped) segments[0].text = stripped.clean.trim();
          }
        }

        const r0 = (paraLines[0].runs && paraLines[0].runs[0]) || {};
        const style = v14DominantStyle(paraLines);
        // Average line-to-line gap within the paragraph, relative to
        // font size, becomes the real w:line spacing value instead of
        // one fixed constant for every paragraph in the document.
        let lineTwips = 276;
        if (paraLines.length > 1) {
          let gapSum = 0, gapCount = 0;
          for (let i = 1; i < paraLines.length; i++) {
            gapSum += (paraLines[i].yPt - paraLines[i - 1].yPt);
            gapCount++;
          }
          const avgGapPt = gapSum / Math.max(1, gapCount);
          const fontPt = r0.sizePt || 11;
          if (fontPt > 0 && avgGapPt > 0) {
            lineTwips = Math.max(240, Math.min(480, Math.round((avgGapPt / fontPt) * 240)));
          }
        }
        const leftPt = Math.min.apply(null, paraLines.map(l => l.xPt));
        const rightPt = Math.max.apply(null, paraLines.map(l => l.xPt + l.wPt));
        const topPt = Math.min.apply(null, paraLines.map(l => l.yPt));
        const bottomPt = Math.max.apply(null, paraLines.map(l => l.yPt + l.hPt));
        // Indentation level for nested list markers (a), i), etc. under
        // a numbered clause): how many "steps" this paragraph's left
        // edge sits to the right of the page's own content-left edge.
        // Indent level uses a generous threshold before promoting a
        // paragraph off level 0: a few points of natural jitter (font
        // metrics, kerning) between "genuinely top-level" markers must
        // never round up to level 1 - Word/LibreOffice numbering only
        // increments cleanly when consecutive same-type items share
        // level 0, and level 1 was seen to render every item as the
        // first symbol ("A." repeating) when the parent level (0) had
        // never actually been used. Floor (not round) + a real minimum
        // offset means only clearly-indented sub-items go to level 1+.
        const indentUnitPt = Math.max(14, (r0.sizePt || 11) * 2.2);
        const indentOffset = leftPt - contentLeftPt;
        const level = listInfo && indentOffset >= indentUnitPt * 0.9
          ? Math.max(0, Math.floor(indentOffset / indentUnitPt))
          : 0;

        return {
          segments: segments,       // each segment's .text may be replaced with translated text below
          originalText: originalText,
          isBlock: isBlock,
          rtl: rtl,
          align: align,
          listInfo: listInfo ? { type: listInfo.type, level: level } : null,
          trackingPt: v14DetectTracking(paraLines[0]),
          lineTwips: lineTwips,
          spaceAfterTwips: 160, // refined below once all paragraphs on the page are known
          topPt: topPt, bottomPt: bottomPt, leftPt: leftPt, rightPt: rightPt
        };
      })
      // Drop page-number / running-header artifacts: a "paragraph" that
      // is nothing but a bare number (no marker punctuation, no other
      // text - a real numbered clause always has content after the
      // marker) is almost certainly a footer/header page number that
      // the text layer happened to pick up as its own line. Keeping it
      // both cluttered the output with a floating stray digit AND (worse)
      // broke list numbering by looking like "not a list item", forcing
      // the next real item to start a fresh numId instead of continuing
      // the sequence.
      .filter(function (para) { return !/^\d{1,4}$/.test(para.originalText); });

      // Paragraph-to-paragraph vertical rhythm: the gap actually
      // measured between consecutive paragraphs in the source, not one
      // fixed "after" value for every paragraph regardless of how close
      // or far apart they really were.
      for (let i = 0; i < paragraphs.length; i++) {
        if (i === paragraphs.length - 1) { paragraphs[i].spaceAfterTwips = 160; continue; }
        const gapPt = paragraphs[i + 1].topPt - paragraphs[i].bottomPt;
        paragraphs[i].spaceAfterTwips = Math.max(80, Math.min(480, Math.round(gapPt * 20)));
      }

      pg.paragraphs = paragraphs;
    });

    // Solution 9: absolute-positioned, per-LINE boxes (textBoxXml +
    // floatingImageXml, via buildDocx's DEFAULT rendering when no
    // renderPageExtra is given). This is the EXACT checkpoint state
    // Solution 9 (absolute-positioned per-line boxes) and Solution 8
    // (server feedback-loop) were both real, working alternative
    // architectures for the "source page N content lands on output
    // page N+1" problem, explored and tested via the admin "Claude"
    // tab. Solution 2 (forced page break + 25% spacing reduction) has
    // now been FINALIZED as the sole, permanent behavior per explicit
    // direction, so the dispatch to Solutions 8/9 has been removed
    // here (their implementations - buildDocx, textBoxXml,
    // buildWithFeedbackLoop, etc. - are kept, unused, as available
    // tested infrastructure in case that architecture is wanted again
    // later, consistent with how paragraphBoxXml was already kept
    // after an earlier finalize/revert).

    // TRANSLATION: the other exception to "no API call" in text-based
    // mode. Each PARAGRAPH (not each raw line) is translated as one
    // unit - see the paragraph-building comment above for why. A
    // paragraph that carries more than one STYLE SEGMENT (e.g. a bold
    // company name followed by a regular address, or a signature block
    // whose lines must stay separate) sends each segment as its own
    // translation item instead of collapsing them into one string, so
    // the bold/line-break boundary survives translation instead of
    // disappearing into a single uniformly-styled block of text.
    if (!keepOriginal) {
      let counter = 0;
      const flatParas = [];
      const paraRefs = []; // parallel array: {pg, idx, segIdx, id} for each flatParas entry
      const tableRefs = []; // parallel array: {table, row, col, id} for table-cell entries
      pages.forEach(function (pg, pIdx) {
        pg.paragraphs.forEach(function (para, paIdx) {
          para.segments.forEach(function (seg, segIdx) {
            if (!seg.text) return;
            counter++;
            const id = 'off_p' + (pIdx + 1) + '_para' + paIdx + (para.segments.length > 1 ? '_s' + segIdx : '');
            flatParas.push({
              id: id,
              page: pIdx + 1,
              // Segments of the SAME paragraph share a paragraph_id so
              // the translation model can use each other for context
              // even though each is translated back into its own slot.
              paragraph_id: para.segments.length > 1 ? ('p' + (pIdx + 1) + '_' + paIdx) : undefined,
              reading_order: counter,
              text: seg.text,
              language: 'unknown',
              direction: para.rtl ? 'rtl' : 'ltr'
            });
            paraRefs.push({ pg: pg, paIdx: paIdx, segIdx: segIdx, id: id });
          });
        });
        // Table cells translate individually too, but every cell in the
        // SAME table shares one paragraph_id so the model can see the
        // whole table (headers, neighbouring cells) for context - e.g.
        // knowing a column is "VAT" helps it translate that column's
        // numeric-looking cells correctly rather than guessing blind.
        (pg.tables || []).forEach(function (table, tblIdx) {
          const tableId = 'p' + (pIdx + 1) + '_tbl' + tblIdx;
          table.grid.forEach(function (row, rowIdx) {
            row.forEach(function (cell, colIdx) {
              if (!cell.text) return;
              counter++;
              const id = 'off_' + tableId + '_r' + rowIdx + '_c' + colIdx;
              flatParas.push({
                id: id,
                page: pIdx + 1,
                paragraph_id: tableId,
                reading_order: counter,
                text: cell.text,
                language: 'unknown',
                direction: table.rtl ? 'rtl' : 'ltr'
              });
              tableRefs.push({ table: table, rowIdx: rowIdx, colIdx: colIdx, id: id });
            });
          });
        });
      });

      if (flatParas.length > 0) {
        const updBefore = snapshotApiCalls();
        try {
          log('Translating extracted text to ' + targetLang + ' (' + flatParas.length + ' segment(s))...');
          const translationResult = await v14TranslateAllPages(model, flatParas, targetLang);
          const map = {};
          (translationResult.translations || []).forEach(function (t) {
            if (t && t.id && typeof t.translated_text === 'string' && t.translated_text.trim()) {
              map[t.id] = t.translated_text.trim();
            }
          });
          let replaced = 0, missing = 0;
          paraRefs.forEach(function (ref) {
            const seg = ref.pg.paragraphs[ref.paIdx].segments[ref.segIdx];
            if (map[ref.id] !== undefined) {
              seg.text = map[ref.id];
              replaced++;
            } else {
              // No entry came back for this segment (e.g. it fell
              // outside a still-truncated response) - say so explicitly
              // instead of silently leaving it in the source language,
              // so a mixed-language document is visible in the log
              // rather than only discoverable by reading every page.
              missing++;
            }
          });
          tableRefs.forEach(function (ref) {
            if (map[ref.id] !== undefined) {
              ref.table.grid[ref.rowIdx][ref.colIdx].text = map[ref.id];
              replaced++;
            } else {
              missing++;
            }
          });
          log('Translation: ' + replaced + ' segment(s) translated' +
            (missing ? ', ' + missing + ' segment(s) came back untranslated (kept in source language)' : ''),
            missing ? 'warn' : 'info');
        } catch (translateErr) {
          log('TRANSLATION DID NOT HAPPEN (' + translateErr.message + ') — the output has the ORIGINAL untranslated text', 'error');
        }
        const updAfter = snapshotApiCalls();
        emit({
          type: 'update',
          jsonCalls: updAfter.json - updBefore.json,
          imageCalls: updAfter.image - updBefore.image,
          textData: flatParas.length
        });
      }
    }

    // Direction/alignment reflects the OUTPUT language, not the
    // source (see v14IsRtlLanguage) - only relevant when translation
    // actually ran; keepOriginal output stays in the source script and
    // should keep reading exactly as extracted. A paragraph that was
    // right-aligned because right-aligned is RTL's natural "start"
    // becomes left-aligned once it's English's natural "start";
    // center/justify are unaffected by which direction is which.
    if (!keepOriginal) {
      const outputRtl = v14IsRtlLanguage(targetLang);
      const mirrorAlign = { left: 'right', right: 'left', center: 'center', justify: 'justify' };
      pages.forEach(function (pg) {
        (pg.paragraphs || []).forEach(function (p) {
          if (p.rtl !== outputRtl) {
            p.align = mirrorAlign[p.align] || p.align;
            p.rtl = outputRtl;
          }
        });
        (pg.tables || []).forEach(function (t) { t.rtl = outputRtl; });
      });
    }

    return buildFlowingDocx(pages);
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

  // A quote character INSIDE a translated string value that the model
  // forgot to escape (e.g. translating a quoted term like "CAMELOT")
  // breaks JSON.parse at that exact spot, even though the rest of the
  // response is perfectly well-formed. Walk the text tracking whether
  // we're inside a string; when a quote appears mid-string but the next
  // meaningful character isn't a valid JSON continuation (, } ] :), it's
  // almost certainly an unescaped internal quote, not a real string
  // boundary - escape it instead of letting it terminate the string.
  function v14RepairUnescapedQuotes(text) {
    let result = '';
    let inString = false;
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\' && inString) {
        result += ch + (text[i + 1] || '');
        i += 2;
        continue;
      }
      if (ch === '"') {
        if (!inString) {
          inString = true;
          result += ch;
          i++;
          continue;
        }
        // We're inside a string and hit an unescaped quote - look ahead
        // (skipping whitespace) to see if this looks like a real closing
        // quote (followed by a JSON structural character) or a stray
        // internal quote that needs escaping.
        let j = i + 1;
        while (j < text.length && /\s/.test(text[j])) j++;
        const next = text[j];
        let looksLikeRealClose = (next === '}' || next === ']' || next === ':' || next === undefined);
        if (!looksLikeRealClose && next === ',') {
          // A comma is ambiguous - could be real JSON structure (next
          // property, or next array element) or just a comma inside the
          // sentence itself (e.g. '..."CAMELOT", established...'). Only
          // trust it if what follows genuinely looks like a new JSON
          // key ("something": ) or the start of a new object/array
          // element - not more lowercase prose.
          let k = j + 1;
          while (k < text.length && /\s/.test(text[k])) k++;
          const rest = text.slice(k, k + 40);
          looksLikeRealClose = /^"[^"]{1,60}"\s*:/.test(rest) || /^[{\[]/.test(rest);
        }
        if (looksLikeRealClose) {
          inString = false;
          result += ch;
          i++;
        } else {
          result += '\\"';
          i++;
        }
        continue;
      }
      result += ch;
      i++;
    }
    return result;
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
    const WIDE_MARGIN = 22; // fallback search room before concluding "no real ink here at all"

    function isInk(px, py) {
      if (px < 0 || py < 0 || px >= imgW || py >= imgH) return false;
      const idx = (py * imgW + px) * 4;
      const lum = data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
      return lum < DARK_THRESHOLD;
    }

    function findInkBounds(b, margin) {
      const searchX0 = Math.max(0, Math.round(b.x - margin));
      const searchY0 = Math.max(0, Math.round(b.y - margin));
      const searchX1 = Math.min(imgW - 1, Math.round(b.x + b.width + margin));
      const searchY1 = Math.min(imgH - 1, Math.round(b.y + b.height + margin));
      if (searchX1 <= searchX0 || searchY1 <= searchY0) return null;

      let minX = null, minY = null, maxX = null, maxY = null;
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
      return minX === null ? null : { minX, minY, maxX, maxY };
    }

    return blocks.map(function (b) {
      let bounds = findInkBounds(b, MARGIN);
      if (!bounds) {
        // Nothing in the normal search window - before concluding this
        // block is a hallucination, give it one more chance with a much
        // wider margin (the model's box could just be quite far off,
        // not necessarily fabricated).
        bounds = findInkBounds(b, WIDE_MARGIN);
      }
      if (!bounds) {
        // No ink anywhere near this block even with a generous margin -
        // this is almost certainly a false detection (text the model
        // "saw" that doesn't actually exist on the page), which is what
        // produced the empty ghost boxes visible in blank areas like the
        // header margin. Drop it rather than keep it at a wrong position.
        return null;
      }

      const { minX, minY, maxX, maxY } = bounds;
      const refinedW = Math.max(1, maxX - minX + 1);
      const refinedH = Math.max(1, maxY - minY + 1);
      // Sanity check: if the refined box is wildly smaller than the
      // model's own box (e.g. only caught one stray dark pixel), the
      // model's box is probably more trustworthy for this one - only
      // apply the refinement when it's a plausible tightening, not a
      // collapse.
      if (refinedW < b.width * 0.3 || refinedH < b.height * 0.3) return b;

      return Object.assign({}, b, { x: minX, y: minY, width: refinedW, height: refinedH });
    }).filter(Boolean);
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
        let p;
        try {
          p = JSON.parse(cleaned);
        } catch (parseErr0) {
          p = JSON.parse(v14RepairUnescapedQuotes(cleaned));
        }
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

  // Item - fetches domain-expert profiles that got auto-generated for
  // PREVIOUS documents (see v14GenerateAndSaveDomainExpert below) -
  // merged with the 13 hardcoded ones, this is the FULL set of domains
  // the pipeline already knows how to handle without generating
  // anything new. Never blocks/fails translation if this can't be
  // reached - just means today's run treats every dynamic domain as new
  // again, at worst (still correct, just skips the "reuse a saved one"
  // shortcut for this one run).
  async function v14FetchDynamicDomains() {
    try {
      const fetcher = window.authFetch || window.fetch;
      const res = await fetcher('/api/data/translation-domains');
      if (!res.ok) return {};
      const rows = await res.json();
      const out = {};
      (Array.isArray(rows) ? rows : []).forEach(function (r) {
        if (r && r.domain && r.role) out[r.domain] = { role: r.role, terms: r.terms || '' };
      });
      return out;
    } catch (e) {
      return {};
    }
  }

  // Item - the self-expansion step. Called only when the classifier (see
  // v14ClassifyTranslationDomain) names a domain that matches NEITHER
  // the 13 hardcoded ones NOR anything already saved from a previous
  // document. Generates a {role, terms} profile in the exact same shape
  // and style as the hand-written ones - via its own small, focused LLM
  // call - then saves it so every future document in this same domain
  // reuses it instantly instead of generating one again.
  async function v14GenerateAndSaveDomainExpert(model, domain, docType, sampleText) {
    const genPrompt = `You are building a domain-expert persona profile for a document translation system, for the domain "${domain}" (a document of type "${docType}" was just classified into this domain, sample text below for context).

Produce exactly two things, in the SAME style as these existing examples for OTHER domains:
- Real Estate role: "a senior commercial real estate attorney and certified native translator with 20+ years drafting leases, purchase agreements, and management contracts"
- Real Estate terms (a comma-separated glossary, each entry "English Term (equivalent1, equivalent2, ...)" giving 2-4 other major languages' equivalents): "Lessor (arrendador, bailleur, Vermieter, locatore), Lessee/Tenant (arrendatario, locataire, Mieter, conduttore), Premises (inmueble, locaux, Mietsache, locali), ..."

For "${domain}" specifically: write a "role" describing the single most appropriate senior professional (20+ years experience) who would actually be handed a "${docType}" document to review/use in real life - a job title that exists in the real world for this domain - plus "and certified native translator". Then write a "terms" glossary of 10-14 of the most important recurring technical/professional terms in this exact domain, each with equivalents in 2-4 other major world languages, same comma-separated format as the example.

SAMPLE TEXT FROM THE ACTUAL DOCUMENT (for context on what this domain's documents actually contain):
${String(sampleText || '').slice(0, 1000)}

Return ONLY this JSON shape, nothing else:
{"role": "...", "terms": "..."}`;

    const data = await v14ProxyJson({
      model: model,
      temperature: 0.2,
      max_tokens: 800,
      messages: [{ role: 'user', content: genPrompt }]
    });
    const raw = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!raw) throw new Error('No content received generating a new domain-expert profile.');
    const parsed = JSON.parse(v14CleanJsonResponse(raw));
    if (!parsed || !parsed.role) throw new Error('Malformed domain-expert profile response.');
    const profile = { role: String(parsed.role).trim(), terms: String(parsed.terms || '').trim() };

    // Save it (best-effort - a failed save just means this domain gets
    // regenerated next time instead of reused, not a translation
    // failure) so future documents in this domain reuse it instantly.
    try {
      const fetcher = window.authFetch || window.fetch;
      const listRes = await fetcher('/api/data/translation-domains');
      const existing = listRes.ok ? (await listRes.json()) : [];
      const rows = Array.isArray(existing) ? existing.slice() : [];
      const slug = domain.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      rows.push({ id: slug || ('domain-' + Date.now()), domain: domain, role: profile.role, terms: profile.terms, autoGenerated: 'Yes' });
      await fetcher('/api/data/translation-domains', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rows)
      });
    } catch (saveErr) {
      try { console.error('Could not save new domain-expert profile:', saveErr.message); } catch (e) {}
    }
    return profile;
  }

  // Quick, cheap, focused call (~1500 chars of sample text) BEFORE the
  // main translation - the model's full attention goes to classification
  // alone, which is more reliable than asking it to classify AND
  // translate in the same call. Falls back to General Business on any
  // failure so translation always proceeds even if this step errors out.
  //
  // Item - domain naming is now OPEN, not constrained to the 13
  // hardcoded ones: the classifier names whatever domain actually fits
  // best (e.g. "Aviation", "Maritime Law"), and the caller
  // (v14TranslateAllPages) is responsible for checking that name against
  // the hardcoded + previously-saved-dynamic sets and generating a new
  // profile on the spot if it's genuinely new - see
  // v14GenerateAndSaveDomainExpert above. This function itself no longer
  // decides "known vs unknown" or falls back to General Business for an
  // unrecognized name - it just reports what it saw.
  async function v14ClassifyTranslationDomain(model, sampleText) {
    const knownExamples = Object.keys(TRANSLATION_DOMAIN_EXPERTS).slice(0, 6).join(', ');
    const systemPrompt = [
      'You are a document classifier. Given a sample of text from a document, identify:',
      '1. Domain: the single professional/industry field this document actually belongs to (e.g. ' + knownExamples + ', Aviation, Maritime Law, Agriculture, Education, Energy, Telecommunications, Automotive, Pharmaceutical, or whatever field genuinely fits best - do NOT force-fit into a generic category if a more specific, accurate field name exists). Use a short (1-3 word) standard industry/field name.',
      '2. Document type: a brief 2-4 word descriptor (e.g. "Lease Agreement", "Medical Report", "Invoice", "Employment Contract", "Tax Filing")',
      '',
      'Output ONLY this format, nothing else:',
      'DOMAIN: <1-3 word field name>',
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
      const detected = (domainMatch && domainMatch[1] || '').trim() || 'General Business';
      return { domain: detected, docType: (typeMatch && typeMatch[1] || 'Document').trim() };
    } catch (err) {
      log('Domain detection failed, continuing with General Business terminology: ' + err.message, 'warn');
      return { domain: 'General Business', docType: 'Document' };
    }
  }

  // Item - fetches the current, admin-editable set of active
  // "Translation Rules" (Admin > PostgreSQL > Translation Rules) and
  // formats them for direct inclusion in the translation prompt. This
  // is the actual self-improvement mechanism: every correction learned
  // from real reviewer feedback becomes a row in this table instead of
  // a one-off code edit, and a NEW row (added by an Admin at any time,
  // no redeploy) takes effect on the very next translation automatically,
  // since this runs fresh before every translate call. Never blocks or
  // fails a translation if the fetch doesn't work (offline, DB down,
  // not logged in yet) - just proceeds with no extra rules that run.
  async function v14FetchTranslationRules() {
    try {
      const fetcher = window.authFetch || window.fetch;
      const res = await fetcher('/api/data/translation-rules');
      if (!res.ok) return '';
      const rows = await res.json();
      const active = (Array.isArray(rows) ? rows : [])
        .filter(function (r) { return (r.active || 'Yes') !== 'No' && (r.ruleText || '').trim(); })
        .map(function (r) { return '- ' + r.ruleText.trim(); });
      if (!active.length) return '';
      return '\n\nLEARNED CORRECTIONS (from real translation review feedback - apply every one of these):\n' + active.join('\n');
    } catch (e) {
      return '';
    }
  }

  // ---- TRANSLATION (single final call, whole document — v14 exact) ----
  // LAST me, ek hi call, saare pages saath — page-boundary-crossing
  // paragraphs ki continuity per-page translation tod deti hai.
  function v14BuildTranslationPrompt(targetLanguageLabel, targetCountry, domainInfo, learnedRulesBlock) {
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
- Preserve IN-SENTENCE cross-references to other parts of the document exactly as given (e.g. "see Article 15", "as defined in Clause 4", "pursuant to Section II") - translate only the text around them, never the reference itself. This does NOT apply to a numbering marker that starts the block itself (e.g. a block whose source text begins "1.", "2.", "(a)", "b)") - that marker has ALREADY been removed before this text reached you (it's rendered separately by the document's own numbering), so never reconstruct or prepend it yourself. If a block's translated text would otherwise start with a number/letter followed by a period or parenthesis in that position, you have added a numbering marker that doesn't belong there - remove it and translate only the substantive content.

IMPORTANT — ELIMINATE LITERAL TRANSLATION PATTERNS:
Rewrite awkward, stiff constructions that come from translating word-for-word into natural ${targetLanguageLabel} a native professional would actually write. For example (English source shown for illustration - apply the same principle regardless of source/target language pair): "The appearing parties mutually and reciprocally acknowledge" -> "The parties acknowledge"; "free disposal thereof" -> "full legal authority"; "interest and will" -> "intention"; "price of lease" -> "rent" (in a Real Estate document); "cannot be adapted to regulations" -> "cannot be brought into regulatory compliance". Apply this same kind of simplification and naturalization throughout, in whichever language pair you are actually translating.
This does NOT license shortening a set legal phrase that carries a specific combined meaning just because it sounds wordy - e.g. "in the name and on behalf of" (a distinct legal-agency concept in many jurisdictions - acting IN THE NAME OF a principal, not merely generally "on behalf of" them) must stay complete, not become just "on behalf of". The difference from the examples above: those trim genuinely redundant restatement (saying the same thing twice - "mutually AND reciprocally"), this would drop actual legal content the source phrase specifically conveys. If unsure whether a phrase is redundant filler or a set legal term-of-art, keep it complete rather than risk losing meaning.

IMPORTANT — TERMINOLOGY PREFERENCES FOR THIS DOCUMENT TYPE (real estate / lease):
- A party's right to unilaterally exit a contract without alleging breach ("recesso" in Italian, and equivalent concepts in other civil-law languages) should be translated as "withdraw"/"right of withdrawal" - NOT "terminate"/"termination". Keep this distinct from a party ending the contract FOR BREACH (which is legitimately "terminate"/"termination"). Conflating the two loses a real legal distinction between a no-fault contractual exit right and a breach-based remedy.
- For a clause about a document being registered with a tax/revenue authority within a legally mandated period, prefer the phrasing "registration within the mandatory statutory period" over "fixed-term registration" - it reads as more natural, standard legal English for this concept.

IMPORTANT — NEVER ALTER FACTUAL DATA WHILE TRANSLATING:
The following must come through EXACTLY as in the source, never re-worded, re-formatted, recalculated, converted, or "corrected": dates, personal and organization names, addresses, all numbers, monetary amounts and currency symbols/codes, units of measurement, identifiers (tax/VAT/registration/file/account numbers), and cross-references to laws, articles, or clauses. Translate the words around them, but copy these through verbatim. Do not convert a currency into another currency, do not convert units, and do not change a date's format or calendar. Do not add any information that is not in the source, and do not omit any information that is.

IMPORTANT — DO NOT TRANSLATE NON-TEXT MARKS:
If a block is a signature, a logo/wordmark, a stamp or seal legend, a barcode/QR label, or a similar mark rather than readable body text, leave its text exactly as-is rather than translating it. Only translate genuine readable language content.

IMPORTANT — OCR DUPLICATE DETECTION:
Before translating each paragraph, check whether any of its content is an accidental OCR artifact rather than something the document actually repeats intentionally. This includes duplicated words, duplicated lines, duplicated sentences, duplicated paragraphs, and duplicated page headers/footers/page numbers that a scan or OCR pass sometimes produces (e.g. a heading or footer line appearing twice in a row, or a whole sentence immediately repeating itself verbatim with no intervening content). If content is clearly an OCR duplication artifact, translate it only once in the output. Do not remove or collapse repetitions that are a genuine, intentional part of the document itself (e.g. a legal document deliberately repeating a defined term's full name, or a form field that legitimately appears on every page) - only collapse repetition that has the clear signature of a scanning/OCR error (identical text immediately adjacent to itself, with no other content between the two copies).

IMPORTANT — NEVER RECONSTRUCT OR COMPLETE BROKEN OCR:
Never infer missing text, never reconstruct an incomplete OCR block, never complete a sentence that was cut off mid-word or mid-thought, and never repair a paragraph that reads as damaged or garbled. Translate only what genuinely exists in the source text for that block. If the OCR text you were given is incomplete or truncated, the translated output for that block must remain equally incomplete/truncated in the same way - do not "fix" it by guessing what the rest of the sentence probably said.

IMPORTANT — CROSS-REFERENCE AND LABEL-WORD PRESERVATION:
Internal references to other parts of the document - "Article 15", "Clause 4", "Annex B", "Schedule 2", "Section III", and similar - must be preserved exactly, including the LABEL WORD itself (Article/Clause/Annex/Schedule/Section/etc.), not just the number. Never substitute one label word for another (e.g. never turn "Article 15" into "Section 15") even if the target language's normal convention would usually use a different word for that kind of division - these are cross-references INTO this specific document's own numbering scheme and must point to the exact same label+number the source used.

IMPORTANT — SELF-CONSISTENCY FOR REPEATED SENTENCES AND CLAUSES:
Beyond individual terminology (covered above), if the exact same sentence or clause appears more than once in the document (as is common with standard/boilerplate legal clauses), translate it identically every time it appears, word for word the same in the output - never produce two different-sounding translations of what was the same sentence in the source, unless the surrounding context makes the same source sentence mean something different in that specific spot.

IMPORTANT — DEFINED ENTITY PROTECTION:
In addition to personal and organization names (covered above under factual data), never translate fund names, project names, building/property names, product names, or trademark/brand names - carry these through exactly as written in the source, in their original script/language, even when translating the sentence around them.

IMPORTANT — PUNCTUATION AND CAPITALIZATION FIDELITY:
Preserve the source's actual punctuation marks rather than substituting a look-alike: an em dash (—) or en dash (–) in the source must stay an em/en dash in the output, not become a plain hyphen (-), and vice versa; preserve curly/smart quotation marks as such rather than converting them to straight quotes. For any term the source treats as a defined term (capitalized consistently in the source, e.g. "the Premises", "the Agreement", "the Party"), keep that same capitalization EVERY time it appears in the translation - never capitalize it in one paragraph and lowercase the same word used the same way in another.

Before returning your JSON, do a final self-check: verify that every paragraph was translated, none was skipped, none was duplicated beyond what genuinely appears once in your output per input block, every input id appears in your output exactly once, and all numbering, cross-references, and defined terms remained consistent throughout. Correct anything you find before producing your final output.

The translated document must preserve the legal/practical meaning, effect, structure, and evidential value of the source document - the translation must never alter what any party is agreeing to, obligated to, entitled to, or bound by.

IMPORTANT — TRANSLATE PARAGRAPH-WISE, NOT LINE-BY-LINE:
Entries that share the same "paragraph_id" belong to the same paragraph. If you receive multiple separate entries for one paragraph_id, mentally join them in their given order (across pages if needed) to understand the FULL paragraph's meaning and grammar before translating - never translate an isolated fragment without its paragraph's full context. Some paragraphs may already arrive as a single combined entry instead of several - in that case just translate that one entry naturally as a complete paragraph.

IMPORTANT — DO NOT WORRY ABOUT LINE-FITTING OR BOX WIDTHS:
Translate each paragraph/entry as naturally-flowing text in ${targetLanguageLabel}, at whatever length that naturally takes - do not artificially shorten or pad it, and do not try to match the line-count or per-line length of the source. Exactly how the translated text gets fitted back into the page's layout is handled entirely outside of this step; your only job is an accurate, natural, complete translation of each entry's full content.

RULES
- Never add or remove blocks. Every input id must appear exactly once in your output, in the same order. No translated content may be lost, and no translated content may appear twice under different ids.
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
}` + (learnedRulesBlock || '');
  }

  async function v14TranslateAllPages(model, allPagesJsonArr, targetLanguageLabel, enableParagraphGrouping) {
    // Group blocks that share a paragraph_id (2+ blocks) into ONE
    // combined-text entry - the model translates the whole paragraph as
    // a single string, and v14ReflowTextIntoBlocks (used later in
    // v14ApplyTranslations) redistributes that string back across the
    // original block widths locally. Blocks with no paragraph_id, or
    // whose paragraph_id only has one block (isolated labels/titles),
    // are sent individually exactly as before. Opt-in only (see param
    // above) - only the caller that merges via v14ApplyTranslations
    // (which understands para_-prefixed ids) enables this; the
    // text-based path's own simpler line-id merge does not yet, so it
    // keeps sending one entry per line as before.
    const byParagraph = {};
    if (enableParagraphGrouping) {
      allPagesJsonArr.forEach(function (b) {
        if (!b.paragraph_id) return;
        if (!byParagraph[b.paragraph_id]) byParagraph[b.paragraph_id] = [];
        byParagraph[b.paragraph_id].push(b);
      });
    }

    const compact = [];
    const seenParagraphs = {};
    allPagesJsonArr.forEach(function (b) {
      const group = b.paragraph_id ? byParagraph[b.paragraph_id] : null;
      if (group && group.length > 1) {
        if (seenParagraphs[b.paragraph_id]) return; // already added this paragraph's combined entry
        seenParagraphs[b.paragraph_id] = true;
        const ordered = group.slice().sort((a, c) => (Number(a.reading_order) || 0) - (Number(c.reading_order) || 0));
        compact.push({
          id: 'para_' + b.paragraph_id,
          page: ordered[0].page,
          paragraph_id: b.paragraph_id,
          order: ordered[0].reading_order,
          text: ordered.map(o => o.text).join(' '),
          language: b.language,
          direction: b.direction
        });
      } else {
        compact.push({
          id: b.id,
          page: b.page,
          paragraph_id: b.paragraph_id,
          order: b.reading_order,
          text: b.text,
          language: b.language,
          direction: b.direction
        });
      }
    });

    const targetCountry = window.getSetupPref ? window.getSetupPref('translation', 'targetCountry', '') : '';

    // Item - PII masking layer. High-confidence sensitive-data patterns
    // (email addresses, IBAN-style bank account numbers, credit-card-
    // shaped digit sequences, phone numbers) get replaced with plain
    // placeholder tokens BEFORE this text ever leaves the browser for
    // the translation API - the underlying LLM provider never actually
    // sees the real value at all, not just "is instructed to leave it
    // unchanged" (which the existing NAMES AND IDENTIFIERS prompt rule
    // already does, but that still means transmitting the real value).
    // Tokens get swapped back for the real values locally, after
    // translation, before anything is written into the output document -
    // this step is invisible to the model entirely on both ends.
    // Deliberately conservative pattern set (only very high-confidence
    // PII shapes) - a missed edge case here means a real value is sent
    // like before (no worse than the current baseline), but an
    // OVER-eager pattern could mangle a legitimate reference number,
    // quantity, or date, which would be a real regression - so common,
    // ambiguous "just some digits" patterns are deliberately NOT masked.
    const piiMap = {};
    let piiCounter = 0;
    function maskPiiInText(text) {
      if (!text) return text;
      let masked = text;
      const patterns = [
        // Email addresses.
        /[\w.+-]+@[\w-]+\.[\w.-]+/g,
        // IBAN-format bank account (2 letters + 2 digits + up to 30
        // alnum, spaced or not) - specific enough not to false-positive
        // on ordinary text.
        /\b[A-Z]{2}\d{2}[A-Z0-9]{4,30}\b/g,
        // Credit-card-shaped: 4 groups of 4 digits (spaced or dashed),
        // or 13-19 digits run together - deliberately requires the
        // GROUPED shape or a long enough run that it's very unlikely to
        // be an ordinary document reference number.
        /\b(?:\d{4}[ -]){3}\d{4}\b|\b\d{13,19}\b/g,
        // Phone numbers: an optional + / country code, then 8+ digits
        // with typical separators - requires at least one separator or
        // a leading + so a bare long integer (already covered above)
        // isn't double-matched here.
        /\+?\d{1,3}[\s.-]?\(?\d{2,4}\)?(?:[\s.-]\d{2,4}){2,4}/g,
      ];
      patterns.forEach(function (re) {
        masked = masked.replace(re, function (match) {
          piiCounter++;
          const token = '[[PII' + piiCounter + ']]';
          piiMap[token] = match;
          return token;
        });
      });
      return masked;
    }
    function unmaskPiiInText(text) {
      if (!text) return text;
      let out = text;
      Object.keys(piiMap).forEach(function (token) {
        if (out.indexOf(token) !== -1) out = out.split(token).join(piiMap[token]);
      });
      return out;
    }
    compact.forEach(function (b) { if (b.text) b.text = maskPiiInText(b.text); });
    if (piiCounter > 0) log('PII masking: ' + piiCounter + ' sensitive value(s) masked before sending to translation.', 'info');


    // Classify domain first (separate, focused, cheap call) so the main
    // translation call can be given the domain expert persona + exact
    // terminology glossary up front, instead of guessing terminology
    // while also doing the harder job of translating.
    const sampleText = compact.slice(0, 25).map(b => b.text).filter(Boolean).join('\n').slice(0, 1500);
    log('Detecting document domain for terminology matching...', 'info');
    const domainInfo = await v14ClassifyTranslationDomain(model, sampleText);

    // Item - self-expansion: check the classified domain against the 13
    // hardcoded personas AND every domain already saved from a previous
    // document (fetched fresh here so a domain another user's document
    // saved five minutes ago is already available). Only if it matches
    // NEITHER does this generate (and save) a new one - most documents
    // hit an existing match and skip straight past this.
    let matchedDomainKey = null;
    const dynamicDomains = await v14FetchDynamicDomains();
    const knownDomainNames = Object.keys(TRANSLATION_DOMAIN_EXPERTS).concat(Object.keys(dynamicDomains));
    for (const d of knownDomainNames) {
      if (d.toLowerCase() === domainInfo.domain.toLowerCase()) { matchedDomainKey = d; break; }
    }
    if (!matchedDomainKey) {
      for (const d of knownDomainNames) {
        if (domainInfo.domain.toLowerCase().includes(d.toLowerCase()) || d.toLowerCase().includes(domainInfo.domain.toLowerCase())) {
          matchedDomainKey = d; break;
        }
      }
    }
    if (matchedDomainKey) {
      // Merge in case this came from dynamicDomains (not already in
      // TRANSLATION_DOMAIN_EXPERTS) - the prompt builders below just do
      // a plain TRANSLATION_DOMAIN_EXPERTS[domainInfo.domain] lookup, so
      // having it there under the SAME key name they'll look up is what
      // actually makes this usable without changing those functions.
      if (!TRANSLATION_DOMAIN_EXPERTS[matchedDomainKey] && dynamicDomains[matchedDomainKey]) {
        TRANSLATION_DOMAIN_EXPERTS[matchedDomainKey] = dynamicDomains[matchedDomainKey];
      }
      domainInfo.domain = matchedDomainKey;
      log(`Detected domain: ${domainInfo.domain} (${domainInfo.docType})`, 'info');
    } else {
      log(`Detected a new domain not seen before: "${domainInfo.domain}" - generating a matching expert profile...`, 'info');
      try {
        const newProfile = await v14GenerateAndSaveDomainExpert(model, domainInfo.domain, domainInfo.docType, sampleText);
        TRANSLATION_DOMAIN_EXPERTS[domainInfo.domain] = newProfile;
        log(`New domain profile created and saved for future documents: "${domainInfo.domain}"`, 'info');
      } catch (genErr) {
        log('Could not generate a new domain profile (' + genErr.message + ') - continuing with General Business terminology instead.', 'warn');
        domainInfo.domain = 'General Business';
      }
    }

    const learnedRulesBlock = await v14FetchTranslationRules();

    const prompt = v14BuildTranslationPrompt(targetLanguageLabel, targetCountry, domainInfo, learnedRulesBlock) +
      '\n\nINPUT BLOCKS (full document, all pages, reading order):\n' +
      JSON.stringify(compact);

    // Bade documents ka translation JSON bhi bada — max_tokens block-count
    // se scale, truncate ho to ek retry badi limit se (OCR jaisa pattern).
    // Floor raised from 16000 - the domain-expert glossary injected into
    // the prompt (see v14BuildTranslationPrompt) added real length, and
    // documents with many small blocks need more room for the output.
    const baseMaxTokens = Math.min(60000, Math.max(24000, compact.length * 220));

    async function callTranslationOnce(maxTokens, temperature) {
      const data = await v14ProxyJson({
        model: model,
        temperature: temperature != null ? temperature : 0,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }]
      });
      const finishReason = data.choices && data.choices[0] && data.choices[0].finish_reason;
      const raw = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      return { raw: raw, finishReason: finishReason };
    }

    async function attemptTranslation(temperature) {
      let res = await callTranslationOnce(baseMaxTokens, temperature);
      if (res.finishReason === 'length') {
        log('Translation response was truncated by the token limit — retrying with a higher limit...', 'warn');
        res = await callTranslationOnce(Math.min(100000, baseMaxTokens * 2), temperature);
      }
      if (!res.raw) throw new Error('No content received from the translation model.');
      const cleaned = v14CleanJsonResponse(res.raw);
      let parsed;
      try {
        parsed = JSON.parse(cleaned);
      } catch (parseErr) {
        // Likely an unescaped quote inside a translated string value
        // (e.g. a quoted term like "CAMELOT") breaking the JSON at that
        // exact spot - repair and try again before giving up on this
        // whole attempt.
        try {
          parsed = JSON.parse(v14RepairUnescapedQuotes(cleaned));
          log('Translation JSON had an unescaped quote - repaired automatically.', 'info');
        } catch (repairErr) {
          throw parseErr; // repair didn't help either - surface the original error
        }
      }
      if (!parsed || !Array.isArray(parsed.translations)) {
        throw new Error('Translation response did not include a "translations" array.');
      }
      return parsed;
    }

    // temperature=0 is deterministic - if it produces malformed JSON once,
    // retrying at temperature=0 again reproduces the IDENTICAL broken
    // output (same issue diagnosed and fixed for OCR). A genuine second
    // chance needs a different temperature, not a repeat of the same
    // request.
    let result;
    try {
      result = await attemptTranslation(0);
    } catch (firstErr) {
      try { console.error('Translation attempt 1 failed:', firstErr.message); } catch (e) {}
      log('Translation response was invalid (' + firstErr.message + ') — retrying with a fresh attempt...', 'warn');
      try {
        result = await attemptTranslation(0.3);
      } catch (secondErr) {
        try { console.error('Translation attempt 2 also failed:', secondErr.message); } catch (e) {}
        throw new Error('Translation failed after 2 attempts: ' + secondErr.message);
      }
    }

    // ---- REVIEWER PASS ----
    // A second, independent call reviewing the translation just produced -
    // not as the same translator re-checking its own work, but as a
    // domain-matched, target-country-qualified professional (e.g. an
    // attorney licensed in the TARGET country specifically, for a legal
    // document - not a generic "translator", and not licensed just
    // anywhere) reading it the way a real reviewer in that field and
    // jurisdiction would. Corrections it finds are applied directly to
    // the output, not just reported - the goal is a better translation
    // delivered, not a report the person has to act on themselves.
    try {
      result.translations = await v14ReviewTranslation(model, compact, result.translations, targetLanguageLabel, targetCountry, domainInfo);
    } catch (reviewErr) {
      // The review pass improving quality is a bonus, not a
      // requirement - if it fails for any reason (network, malformed
      // response, etc.), the already-good primary translation still
      // ships rather than the whole job failing over a QA step.
      try { console.error('Review pass failed, shipping unreviewed translation:', reviewErr.message); } catch (e) {}
      log('Review pass could not complete (' + reviewErr.message + ') - using the primary translation as-is.', 'warn');
    }

    // Restore the real PII values now that both translation and review
    // are fully done - this is the only point downstream code ever sees
    // the actual sensitive values again, entirely locally, never sent
    // back over the network.
    if (piiCounter > 0 && result && Array.isArray(result.translations)) {
      result.translations = result.translations.map(function (t) {
        return t && typeof t.translated_text === 'string'
          ? Object.assign({}, t, { translated_text: unmaskPiiInText(t.translated_text) })
          : t;
      });
    }
    return result;
  }

  // Item - builds the reviewer's persona: takes the SAME domain-expert
  // role already used for the translator (TRANSLATION_DOMAIN_EXPERTS),
  // but frames it as someone licensed/qualified specifically in the
  // TARGET country, reviewing a colleague's translation for professional
  // accuracy - not as a translator, as the domain professional who would
  // actually be handed this document to use (an attorney for a legal
  // document, a physician for a medical one, a CPA for a financial one,
  // and so on), in that country's own jurisdiction/practice.
  function v14BuildReviewerPrompt(targetLanguageLabel, targetCountry, domainInfo, existingRuleTexts) {
    const expert = domainInfo && TRANSLATION_DOMAIN_EXPERTS[domainInfo.domain];
    const countryPhrase = targetCountry
      ? `licensed and currently qualified to practice in ${targetCountry} specifically (not generically "wherever ${targetLanguageLabel} is spoken" - ${targetCountry}'s own professional licensing, terminology conventions, and regulatory/legal standards)`
      : `licensed and qualified to practice professionally in a jurisdiction where ${targetLanguageLabel} is the working language`;
    const roleDesc = expert
      ? expert.role.replace(/\s*and\s+certified\s+native\s+translator\b/i, '').trim()
      : `a senior professional`;
    const existingRulesBlock = (existingRuleTexts && existingRuleTexts.length)
      ? `\n\nRULES ALREADY KNOWN (already in effect or already suggested by a previous review - do NOT suggest any of these again, in this or different wording, and do not flag a correction as "learned_rules"-worthy if it's just applying one of these):\n${existingRuleTexts.map(function (r) { return '- ' + r; }).join('\n')}`
      : '';
    return `You are ${roleDesc}, ${countryPhrase}. You have been handed a colleague's ${targetLanguageLabel} translation of a ${(domainInfo && domainInfo.docType) || 'document'} to professionally review before it goes into real use - not as a linguist checking grammar, but as the domain professional who would actually rely on this document, checking it the way you would check any colleague's work product in your own field before signing off on it.

You will receive a list of paragraph entries, each with: id, the ORIGINAL source text, and the CURRENT ${targetLanguageLabel} translation.

For each entry, check specifically for:
- Terminology a professional in your field, in ${targetCountry || 'your jurisdiction'} specifically, would never phrase this way - including your field's standard terms, defined-term consistency, and country-specific conventions.
- Any meaning that was lost, changed, added, or that no longer matches what the original actually says or legally/professionally means.
- Duplicated sentences, lines, or trailing phrases that look like an extraction/OCR artifact rather than something the source intentionally repeats.
- Numbering, dates, names, amounts, and identifiers that do not exactly match the original.
- Phrasing that is technically correct but that no working professional in your field would actually write this way in a real ${(domainInfo && domainInfo.docType) || 'document'}.

Only include an entry in your response if you are making an actual correction to it. If an entry's current translation is already correct and professionally sound, do NOT include it at all - most entries in a good translation need no change.

SEPARATELY from those per-entry wording corrections, also watch for a DIFFERENT kind of problem: a PATTERN across multiple entries that looks like a defect in the software that PRODUCED this translation, not a wording/quality choice - for example:
- The same short trailing phrase repeated right after several different, unrelated sentences (suggests a text-extraction/chunking bug, not a translation choice)
- A sequence of items that should be numbered/lettered in order (a, b, c... or 1, 2, 3...) but several of them show the SAME number/letter instead of incrementing
- The same formatting defect (e.g. missing spacing at the same kind of position, a value cut off at the same kind of boundary) recurring identically across multiple unrelated entries
This is different from an isolated one-off issue in a single entry (that's just a normal correction, above) - only flag something here if the SAME kind of defect shows up more than once in a way that looks systematic rather than coincidental. If you see nothing like this, leave "code_issues" empty - most documents have none.

ALSO SEPARATELY, watch for a THIRD kind of thing: any correction you made above that reflects a GENERALIZABLE rule - something that would be equally true for ANY future document in this same domain/language pair, not just something specific to this one document. For example "translate X term as Y, never Z" or "never shorten phrase X" is generalizable; fixing a typo in this specific document's own text, or a date/name/number specific to this document, is NOT - those only apply here. Only include something here if you would confidently tell a translator "always do this from now on", not just "this one time". Most corrections are NOT generalizable - leave "learned_rules" empty unless something genuinely is. Before including anything here, check it against the RULES ALREADY KNOWN list below (if given) - never repeat one of those, even rephrased.${existingRulesBlock}

A SPECIFIC FAILURE PATTERN TO AVOID: if this document has many similarly-shaped fields/entries (e.g. a form with dozens of "This field indicates the amount of the X fee..." descriptions, one per named fee), do NOT produce one "rule" per field just because you noticed the same template repeated with a different field name each time - "ensure the full descriptive phrase for the brokerage fee field is maintained", "...for the waste removal fee field...", "...for the engineering supervision fee field..." are NOT ten different generalizable rules, they are the SAME one-off observation about THIS document's own field list, restated with different nouns - and it usually isn't even a real rule at all (a translator should preserve full meaning for EVERY field description as a matter of course, that's not a special instruction this document taught you, it's just... translating correctly). If you find yourself about to write several "learned_rules" entries that share the same sentence structure with only a name/noun swapped, that is the signal to write AT MOST ONE, phrased generally enough to cover all of them ("preserve full descriptive text in field-description entries, don't summarize them" - once, covering every fee/field this applies to), or more likely, none at all, because "translate completely and accurately" was never a document-specific discovery to begin with. A genuinely new rule is a surprising, specific correction to a term/phrase/convention - not a restatement of the general instruction to translate well.

FINALLY, after reviewing every entry (and after accounting for the corrections you're making - i.e. score the translation as it will read AFTER your corrections are applied, not as it read before), give an overall semantic-faithfulness score: your honest professional judgment of what percentage of the source document's legal/practical meaning, obligations, and factual content is preserved EXACTLY and correctly in the (corrected) translation, as a single integer 0-100. This is not a grammar/style score - a translation that reads awkwardly but preserves every obligation, date, and amount correctly still scores high; one that reads beautifully but drops or changes a single obligation, date, or amount scores low. Be honest and calibrated, not automatically generous - most competent translations of a well-extracted source score in the 90s, but a genuine problem (a dropped clause, a changed number, a reversed obligation) should pull the score down accordingly, and you have already been looking for exactly these things above.

Return ONLY this JSON shape, nothing else, no commentary:
{
  "corrections": [
    {"id": "pg1_b0", "corrected_text": "..."}
  ],
  "code_issues": [
    {"description": "Plain-language description of the systematic pattern observed", "evidence": "A short verbatim example from the text showing it"}
  ],
  "learned_rules": [
    {"rule_text": "A general, standalone instruction phrased for a future translator/reviewer, not referencing this specific document"}
  ],
  "faithfulness_score": 0,
  "faithfulness_notes": "One sentence on what, if anything, kept this below 100"
}`;
  }

  async function v14ReviewTranslation(model, compact, translations, targetLanguageLabel, targetCountry, domainInfo) {
    if (!translations || !translations.length) return translations;
    const byId = {};
    translations.forEach(function (t) { if (t && t.id) byId[t.id] = t.translated_text; });
    const pairs = compact
      .filter(function (b) { return b.text && b.text.trim() && byId[b.id] != null; })
      .map(function (b) { return { id: b.id, original: b.text, current_translation: byId[b.id] }; });
    if (!pairs.length) return translations;

    log('Reviewing translation as a ' + ((domainInfo && domainInfo.domain) || 'domain') + ' professional qualified in ' + (targetCountry || targetLanguageLabel) + '...', 'info');
    // Item - the reviewer needs to SEE what's already known before it
    // can avoid suggesting it again (a post-hoc exact-text duplicate
    // check alone isn't reliable - the same underlying rule can get
    // phrased differently each time an LLM generates it). Pulls BOTH
    // active and not-yet-approved rules, since a not-yet-approved
    // suggestion from an earlier document is still "already suggested",
    // not something to suggest again as if new.
    let existingRuleTexts = [];
    try {
      const fetcher = window.authFetch || window.fetch;
      const rulesRes = await fetcher('/api/data/translation-rules');
      if (rulesRes.ok) {
        const rulesRows = await rulesRes.json();
        existingRuleTexts = (Array.isArray(rulesRows) ? rulesRows : [])
          .map(function (r) { return (r.ruleText || '').trim(); })
          .filter(Boolean);
      }
    } catch (e) { /* proceed without the list - worst case, a rare re-suggestion gets caught by the exact-text check in v14SaveLearnedRules instead */ }

    const prompt = v14BuildReviewerPrompt(targetLanguageLabel, targetCountry, domainInfo, existingRuleTexts) +
      '\n\nENTRIES TO REVIEW:\n' + JSON.stringify(pairs);
    const maxTokens = Math.min(40000, Math.max(8000, pairs.length * 150));
    const data = await v14ProxyJson({
      model: model,
      temperature: 0,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }]
    });
    const raw = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!raw) return translations;
    let parsed;
    try {
      parsed = JSON.parse(v14CleanJsonResponse(raw));
    } catch (e) {
      try { parsed = JSON.parse(v14RepairUnescapedQuotes(v14CleanJsonResponse(raw))); }
      catch (e2) { return translations; }
    }
    const corrections = parsed && Array.isArray(parsed.corrections) ? parsed.corrections : [];
    const codeIssues = parsed && Array.isArray(parsed.code_issues) ? parsed.code_issues : [];
    const learnedRules = parsed && Array.isArray(parsed.learned_rules) ? parsed.learned_rules : [];
    const score = parsed && typeof parsed.faithfulness_score === 'number' ? Math.max(0, Math.min(100, Math.round(parsed.faithfulness_score))) : null;
    if (score != null) {
      log('Faithfulness score: ' + score + '/100' + (parsed.faithfulness_notes ? ' - ' + parsed.faithfulness_notes : ''), score >= 90 ? 'info' : 'warn');
    }

    if (codeIssues.length) {
      v14SaveCodeIssues(codeIssues, domainInfo).catch(function (e) {
        try { console.error('Could not save flagged code issue(s):', e.message); } catch (err) {}
      });
    }
    if (learnedRules.length) {
      v14SaveLearnedRules(learnedRules, domainInfo).catch(function (e) {
        try { console.error('Could not save learned rule(s):', e.message); } catch (err) {}
      });
    }

    if (!corrections.length) {
      log('Review pass: no wording corrections needed' + (codeIssues.length ? (', ' + codeIssues.length + ' possible code-level issue(s) flagged for review') : '') + (learnedRules.length ? (', ' + learnedRules.length + ' possible new rule(s) suggested for review') : '') + '.', 'info');
      return translations;
    }
    const correctionMap = {};
    corrections.forEach(function (c) {
      if (c && c.id && typeof c.corrected_text === 'string' && c.corrected_text.trim()) {
        correctionMap[c.id] = c.corrected_text.trim();
      }
    });
    let appliedCount = 0;
    const refined = translations.map(function (t) {
      if (t && t.id && correctionMap[t.id] != null) {
        appliedCount++;
        return Object.assign({}, t, { translated_text: correctionMap[t.id] });
      }
      return t;
    });
    log('Review pass: ' + appliedCount + ' correction(s) applied' + (codeIssues.length ? (', ' + codeIssues.length + ' possible code-level issue(s) flagged for review') : '') + (learnedRules.length ? (', ' + learnedRules.length + ' possible new rule(s) suggested for review') : '') + '.', 'info');
    return refined;
  }

  // Item - saves reviewer-flagged structural/systematic patterns to the
  // "Translation Code Issues" table (Admin > PostgreSQL) - DETECTION
  // ONLY. This never touches, generates, or deploys any code itself -
  // it just records what the reviewer noticed, with status "New", for
  // an actual human (Admin/developer) to look at, confirm, and fix
  // deliberately. Best-effort save (a failure here never affects the
  // translation itself, which has already completed by this point).
  async function v14SaveCodeIssues(codeIssues, domainInfo) {
    const fetcher = window.authFetch || window.fetch;
    const listRes = await fetcher('/api/data/translation-code-issues');
    const existing = listRes.ok ? (await listRes.json()) : [];
    const rows = Array.isArray(existing) ? existing.slice() : [];
    const now = new Date().toISOString();
    codeIssues.forEach(function (issue) {
      if (!issue || !issue.description) return;
      rows.push({
        id: 'issue-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        description: String(issue.description).trim(),
        evidence: String(issue.evidence || '').trim(),
        domain: (domainInfo && domainInfo.domain) || '',
        docType: (domainInfo && domainInfo.docType) || '',
        flaggedAt: now,
        status: 'New',
      });
    });
    await fetcher('/api/data/translation-code-issues', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rows)
    });
  }

  // Item - saves reviewer-suggested GENERALIZABLE rules to "Translation
  // Rules" (Admin > PostgreSQL) - the same table v14FetchTranslationRules
  // reads from and injects into every future prompt. Unlike Translation
  // Domains (which auto-activate immediately, since a wrong domain
  // profile only affects documents in that one narrow domain), a bad
  // rule here would inject wrong guidance into EVERY future translation
  // regardless of domain - real risk, not just narrow-scope risk. So
  // these save with active="No": captured automatically so nothing
  // discovered is lost, but NOT live in any prompt until a human
  // reviews it in the Admin table and flips it to "Yes" - deliberately
  // a lower level of trust than Domains gets, matched to the bigger
  // blast radius a bad row here would have.
  async function v14SaveLearnedRules(learnedRules, domainInfo) {
    const fetcher = window.authFetch || window.fetch;
    const listRes = await fetcher('/api/data/translation-rules');
    const existing = listRes.ok ? (await listRes.json()) : [];
    const rows = Array.isArray(existing) ? existing.slice() : [];
    // Skip near-duplicates of a rule already present (active or not) -
    // otherwise the same pattern found across many documents in the
    // same domain would pile up as repeated near-identical rows.
    const existingTexts = rows.map(function (r) { return (r.ruleText || '').toLowerCase().trim(); });
    // Item - hard cap, independent of the prompt instruction above: even
    // with the strengthened "don't produce one rule per templated field"
    // guidance, this is a second, code-level backstop against the exact
    // failure this session found in real output (a single large form
    // document produced 20+ near-identical "preserve the full
    // description for field X" rules, one per field). A genuinely new,
    // generalizable insight from ONE document reviewing ONE more time is
    // rare - if the model proposes more than a handful, something's
    // already gone wrong the same way it did before, and only the first
    // few get a chance to actually be reviewed rather than burying them
    // in a flood of near-duplicates.
    const MAX_NEW_RULES_PER_DOCUMENT = 5;
    let savedCount = 0;
    learnedRules.forEach(function (rule) {
      if (savedCount >= MAX_NEW_RULES_PER_DOCUMENT) return;
      if (!rule || !rule.rule_text) return;
      const text = String(rule.rule_text).trim();
      if (!text || existingTexts.indexOf(text.toLowerCase()) !== -1) return;
      rows.push({
        id: 'rule-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        ruleText: text,
        category: 'Terminology',
        active: 'No',
        note: 'Auto-suggested by the reviewer pass (domain: ' + ((domainInfo && domainInfo.domain) || 'n/a') +
          ') - review and switch Active to Yes to actually use this in future translations.',
      });
      savedCount++;
    });
    if (learnedRules.length > MAX_NEW_RULES_PER_DOCUMENT) {
      log('Review pass suggested ' + learnedRules.length + ' new rule(s) - only the first ' + MAX_NEW_RULES_PER_DOCUMENT + ' were saved (likely template-repetition, see Translation Health).', 'warn');
    }
    await fetcher('/api/data/translation-rules', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rows)
    });
  }

  // id-match karke original text ko translated text se REPLACE karta hai.
  // Redistributes ONE translated paragraph string across the N original
  // blocks it came from, word by word, using each block's own width/
  // font-size as the wrap boundary (same measurement tool used for
  // font-size fitting) - this replaces asking the model to guess how to
  // split translated text across blocks, which needed the model to
  // output N separate entries per paragraph. Now it only needs to
  // output ONE translated string per paragraph, and we handle the
  // line-splitting locally, deterministically.
  function v14ReflowTextIntoBlocks(translatedText, blocks) {
    const words = String(translatedText || '').split(/\s+/).filter(Boolean);
    if (!blocks.length) return [];
    if (blocks.length === 1 || words.length === 0) {
      return blocks.map((b, i) => (i === 0 ? translatedText : ''));
    }

    const fontPt = Number(blocks[0].font_size_px) ? Number(blocks[0].font_size_px) * 0.75 : 10;
    const bold = String(blocks[0].style || '').toLowerCase().indexOf('bold') !== -1;

    const linesOut = [];
    let wordIdx = 0;
    for (let li = 0; li < blocks.length; li++) {
      const isLastBlock = li === blocks.length - 1;
      const maxWidthPx = Math.max(10, Number(blocks[li].width) || 100);
      let current = '';
      if (isLastBlock) {
        // Last available block gets everything remaining, however much
        // that is - better a slightly-overflowing final line (font-fit
        // step already handles that) than silently dropped words.
        current = words.slice(wordIdx).join(' ');
        wordIdx = words.length;
      } else {
        while (wordIdx < words.length) {
          const candidate = current ? current + ' ' + words[wordIdx] : words[wordIdx];
          const w = v14MeasureTextWidthPx(candidate, fontPt, bold);
          if (w <= maxWidthPx || !current) {
            current = candidate;
            wordIdx++;
          } else {
            break;
          }
        }
      }
      linesOut.push(current);
    }
    return linesOut;
  }

  function v14ApplyTranslations(allPagesJsonArr, translations) {
    const blockMap = {};    // block id -> translated text
    const paragraphMap = {}; // paragraph_id -> combined translated text
    translations.forEach(t => {
      if (!t || typeof t.translated_text !== 'string' || !t.translated_text.trim()) return;
      if (typeof t.id === 'string' && t.id.indexOf('para_') === 0) {
        paragraphMap[t.id.slice(5)] = t.translated_text.trim();
      } else if (t.id) {
        blockMap[t.id] = t.translated_text.trim();
      }
    });

    // Group original blocks by paragraph_id so paragraph-level
    // translations can be reflowed across the right set of blocks, in
    // their original reading order.
    const byParagraph = {};
    allPagesJsonArr.forEach(function (b) {
      if (!b.paragraph_id) return;
      if (!byParagraph[b.paragraph_id]) byParagraph[b.paragraph_id] = [];
      byParagraph[b.paragraph_id].push(b);
    });
    const reflowedByBlockId = {};
    Object.keys(paragraphMap).forEach(function (pid) {
      const group = (byParagraph[pid] || []).slice().sort((a, c) => (Number(a.reading_order) || 0) - (Number(c.reading_order) || 0));
      if (!group.length) return;
      const lines = v14ReflowTextIntoBlocks(paragraphMap[pid], group);
      group.forEach(function (b, i) { reflowedByBlockId[b.id] = lines[i] || ''; });
    });

    let replacedCount = 0;
    const result = allPagesJsonArr.map(b => {
      if (b.id && reflowedByBlockId[b.id] !== undefined) {
        replacedCount++;
        return Object.assign({}, b, { text: reflowedByBlockId[b.id] });
      }
      if (b.id && blockMap[b.id] !== undefined) {
        replacedCount++;
        return Object.assign({}, b, { text: blockMap[b.id] });
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

    // Pre-pass: compute each line's own best-fit font size first (same
    // calculation as before), then unify every line that shares a
    // paragraph_id to ONE common size - the smallest individually-needed
    // size in that paragraph, so every line still fits, but the whole
    // paragraph renders with a single consistent font size instead of
    // visibly jumping between sizes from one line to the next.
    const perItemFit = pageJson.map(function (item) {
      const text = String(item.text || '').trim();
      const boxWidth = (parseFloat(item.width) || 50) * scale;
      const boxHeight = (parseFloat(item.height) || 20) * scale;
      const styleStr = String(item.style || 'normal').toLowerCase();
      const isBold = styleStr.indexOf('bold') !== -1;
      return v14FindSmartFontSize(text, boxWidth, boxHeight, isBold);
    });
    const paragraphMinSize = {};
    pageJson.forEach(function (item, idx) {
      const pid = item.paragraph_id;
      if (!pid) return;
      const size = perItemFit[idx].fontSize;
      if (paragraphMinSize[pid] === undefined || size < paragraphMinSize[pid]) {
        paragraphMinSize[pid] = size;
      }
    });

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

      const result = perItemFit[i];
      const unifiedSize = item.paragraph_id && paragraphMinSize[item.paragraph_id] !== undefined
        ? paragraphMinSize[item.paragraph_id]
        : result.fontSize;
      const optimalFontSize = unifiedSize;
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
        const translationResult = await v14TranslateAllPages(model, allPagesJson, targetLang, true);
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
          log('TRANSLATION DID NOT HAPPEN (' + translateErr.message + ') — the output has the ORIGINAL untranslated text', 'error');
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

  // NAMESPACED exports - this file is one of 5 fully-separate,
  // per-service copies of the same engine (split per explicit user
  // direction: each service must have its own independent file).
  // Kept as a namespaced OBJECT (not flat window.X = Y) so that
  // loading all 5 copies on the same page can never let one
  // service's copy silently overwrite another's.
  window.__calculatorsEngine = {
    buildHybridDocxBlob: buildHybridDocxBlob,
    buildOfflineDocxBlob: buildOfflineDocxBlob,
    setVisionAuthToken: setVisionAuthToken,
    setVisionStopCheck: setStopCheck,
    setPipelineEventHandler: setPipelineEventHandler,
    lexoraProxyJson: v14ProxyJson,
    lexoraPdfToImages: v14PdfToImages,
    resetPipelineApiCounters: resetApiCalls,
    abortVision: abortVision
  };
})();
