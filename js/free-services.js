/* free-services.js — Lexora Free Services (no billing, no API calls).
 *
 * Everything here runs ENTIRELY in the browser:
 *   - pdf.js  (already loaded) reads/renders PDFs
 *   - pdf-lib (loaded in index.html) writes PDFs
 * Nothing is uploaded to the server, so these tools are free to run, work
 * offline, and the user's documents never leave their machine - which also
 * means there's no privacy question about handing over password-protected
 * or personal files.
 *
 * app.js's CONTENT_DATA delegates to window.FreeServices.render(id).
 */
(function () {
  'use strict';

  // ── small shared helpers ───────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function setStatus(elId, msg, kind) {
    const el = document.getElementById(elId);
    if (!el) return;
    const colors = { error: '#b3261e', ok: '#1b5e20', busy: '#2c5777' };
    el.style.color = colors[kind] || '#444';
    el.textContent = msg || '';
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoke a moment later - revoking immediately can cancel the download
    // in some browsers before it has actually started reading the blob.
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function fileInputFiles(id) {
    const el = document.getElementById(id);
    return el && el.files ? Array.from(el.files) : [];
  }

  function requireLibs(needPdfLib) {
    if (typeof pdfjsLib === 'undefined') throw new Error('pdf.js failed to load - please refresh the page.');
    if (needPdfLib && typeof PDFLib === 'undefined') throw new Error('pdf-lib failed to load - please refresh the page.');
  }

  // Parses "1-3, 5, 8-10" into a sorted, de-duplicated list of 0-based page
  // indices, validated against the document's real page count so a typo
  // produces a clear message instead of a silently wrong output file.
  function parsePageRanges(spec, pageCount) {
    const out = new Set();
    const parts = String(spec || '').split(',');
    for (const raw of parts) {
      const part = raw.trim();
      if (!part) continue;
      const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
      if (m) {
        let a = parseInt(m[1], 10), b = parseInt(m[2], 10);
        if (a > b) { const t = a; a = b; b = t; }
        if (a < 1 || b > pageCount) throw new Error(`Page range "${part}" is outside this document (it has ${pageCount} page(s)).`);
        for (let i = a; i <= b; i++) out.add(i - 1);
        continue;
      }
      if (/^\d+$/.test(part)) {
        const n = parseInt(part, 10);
        if (n < 1 || n > pageCount) throw new Error(`Page ${n} is outside this document (it has ${pageCount} page(s)).`);
        out.add(n - 1);
        continue;
      }
      throw new Error(`Could not understand "${part}". Use formats like: 1-3, 5, 8-10`);
    }
    if (out.size === 0) throw new Error('Please enter at least one page or range.');
    return Array.from(out).sort(function (a, b) { return a - b; });
  }

  function baseName(name) {
    return String(name || 'document').replace(/\.[^.]+$/, '');
  }

  // ── card shell ─────────────────────────────────────────────────────
  function card(title, icon, description, bodyHtml) {
    return `
      <div class="content-section">
        <h3>${icon} ${esc(title)}</h3>
        <p style="color:#555;margin:-2px 0 14px 0;font-size:0.9rem;">${description}</p>
        ${bodyHtml}
        <p style="margin-top:14px;font-size:0.78rem;color:rgba(0,0,0,0.45);">
          Runs entirely in your browser - your file is never uploaded, and this tool is free to use.
        </p>
      </div>`;
  }

  const btn = (onclick, label) =>
    `<button class="filter-btn" style="margin-top:10px;" onclick="${onclick}">${label}</button>`;

  const statusLine = (id) => `<div id="${id}" style="margin-top:10px;font-size:0.86rem;min-height:1.2em;"></div>`;

  // ══════════════════════════════════════════════════════════════════
  // PDF SPLIT
  // ══════════════════════════════════════════════════════════════════
  function renderPdfSplit() {
    return card('PDF Split', '✂️',
      'Pull selected pages out of a PDF into a new file.', `
      <div class="setup-group">
        <label>PDF file</label>
        <input type="file" id="fsSplitFile" accept="application/pdf" />
      </div>
      <div class="setup-group" style="margin-top:10px;">
        <label>Pages to keep</label>
        <input type="text" id="fsSplitRange" placeholder="e.g. 1-3, 5, 8-10" />
        <div style="font-size:0.78rem;color:rgba(0,0,0,0.5);margin-top:4px;">
          Leave empty to split every page into its own separate PDF (delivered as a ZIP).
        </div>
      </div>
      ${btn('FreeServices.runSplit()', '✂️ Split PDF')}
      ${statusLine('fsSplitStatus')}`);
  }

  async function runSplit() {
    try {
      requireLibs(true);
      const files = fileInputFiles('fsSplitFile');
      if (!files.length) return setStatus('fsSplitStatus', 'Please choose a PDF file first.', 'error');
      const spec = (document.getElementById('fsSplitRange') || {}).value || '';

      setStatus('fsSplitStatus', 'Working...', 'busy');
      const bytes = await files[0].arrayBuffer();
      const src = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
      const total = src.getPageCount();
      const stem = baseName(files[0].name);

      if (!spec.trim()) {
        // Every page as its own file -> ZIP
        if (typeof JSZip === 'undefined') throw new Error('JSZip failed to load - please refresh the page.');
        const zip = new JSZip();
        for (let i = 0; i < total; i++) {
          const out = await PDFLib.PDFDocument.create();
          const [pg] = await out.copyPages(src, [i]);
          out.addPage(pg);
          zip.file(`${stem}_page_${i + 1}.pdf`, await out.save());
        }
        const blob = await zip.generateAsync({ type: 'blob' });
        downloadBlob(blob, `${stem}_split_pages.zip`);
        return setStatus('fsSplitStatus', `Done - ${total} single-page PDF(s) in a ZIP.`, 'ok');
      }

      const idx = parsePageRanges(spec, total);
      const out = await PDFLib.PDFDocument.create();
      const copied = await out.copyPages(src, idx);
      copied.forEach(function (p) { out.addPage(p); });
      const blob = new Blob([await out.save()], { type: 'application/pdf' });
      downloadBlob(blob, `${stem}_split.pdf`);
      setStatus('fsSplitStatus', `Done - ${idx.length} page(s) extracted.`, 'ok');
    } catch (e) {
      setStatus('fsSplitStatus', e.message || 'Could not split this PDF.', 'error');
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // PDF MERGE
  // ══════════════════════════════════════════════════════════════════
  function renderPdfMerge() {
    return card('PDF Merge', '🔗',
      'Combine several PDFs into one, in the order you select them.', `
      <div class="setup-group">
        <label>PDF files (select two or more)</label>
        <input type="file" id="fsMergeFiles" accept="application/pdf" multiple />
      </div>
      ${btn('FreeServices.runMerge()', '🔗 Merge PDFs')}
      ${statusLine('fsMergeStatus')}`);
  }

  async function runMerge() {
    try {
      requireLibs(true);
      const files = fileInputFiles('fsMergeFiles');
      if (files.length < 2) return setStatus('fsMergeStatus', 'Please choose at least two PDF files.', 'error');

      setStatus('fsMergeStatus', 'Working...', 'busy');
      const out = await PDFLib.PDFDocument.create();
      let pages = 0;
      for (const f of files) {
        const src = await PDFLib.PDFDocument.load(await f.arrayBuffer(), { ignoreEncryption: true });
        const copied = await out.copyPages(src, src.getPageIndices());
        copied.forEach(function (p) { out.addPage(p); pages++; });
      }
      const blob = new Blob([await out.save()], { type: 'application/pdf' });
      downloadBlob(blob, 'merged.pdf');
      setStatus('fsMergeStatus', `Done - ${files.length} file(s), ${pages} page(s) merged.`, 'ok');
    } catch (e) {
      setStatus('fsMergeStatus', e.message || 'Could not merge these PDFs.', 'error');
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // PDF UNPROTECT
  // ══════════════════════════════════════════════════════════════════
  function renderPdfUnprotect() {
    return card('PDF Unprotect', '🔓',
      'Remove restrictions (printing/copying) from a PDF you own, or produce an unlocked copy of a password-protected one.', `
      <div class="setup-group">
        <label>PDF file</label>
        <input type="file" id="fsUnlockFile" accept="application/pdf" />
      </div>
      <div class="setup-group" style="margin-top:10px;">
        <label>Password (only if the PDF asks for one to open)</label>
        <input type="password" id="fsUnlockPwd" placeholder="Leave empty if it opens without a password" />
      </div>
      <div style="margin-top:10px;padding:8px 10px;border:1px solid #e0a800;background:#fff8e1;border-radius:6px;font-size:0.8rem;color:#7a5c00;">
        Only use this on documents you own or are authorised to unlock.
        If a password is needed to open the file, the unlocked copy is rebuilt
        from page images, so its text will no longer be selectable.
      </div>
      ${btn('FreeServices.runUnprotect()', '🔓 Unprotect PDF')}
      ${statusLine('fsUnlockStatus')}`);
  }

  async function runUnprotect() {
    try {
      requireLibs(true);
      const files = fileInputFiles('fsUnlockFile');
      if (!files.length) return setStatus('fsUnlockStatus', 'Please choose a PDF file first.', 'error');
      const pwd = ((document.getElementById('fsUnlockPwd') || {}).value || '').trim();
      const bytes = await files[0].arrayBuffer();
      const stem = baseName(files[0].name);

      setStatus('fsUnlockStatus', 'Working...', 'busy');

      if (!pwd) {
        // Restrictions-only case (owner password): the file opens fine, it
        // just forbids printing/copying. Re-saving through pdf-lib drops
        // those restrictions while keeping real, selectable text.
        const src = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
        const out = await PDFLib.PDFDocument.create();
        const copied = await out.copyPages(src, src.getPageIndices());
        copied.forEach(function (p) { out.addPage(p); });
        const blob = new Blob([await out.save()], { type: 'application/pdf' });
        downloadBlob(blob, `${stem}_unprotected.pdf`);
        return setStatus('fsUnlockStatus', 'Done - restrictions removed, text kept selectable.', 'ok');
      }

      // Password-to-open case: pdf.js can DECRYPT with the password, but
      // pdf-lib cannot, so the only way to produce an unlocked file is to
      // render each decrypted page and rebuild from those images. The user
      // was warned above that this loses selectable text.
      const pdf = await pdfjsLib.getDocument({ data: bytes, password: pwd }).promise;
      const out = await PDFLib.PDFDocument.create();
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const vp = page.getViewport({ scale: 2.0 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(vp.width);
        canvas.height = Math.round(vp.height);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
        const png = await new Promise(function (res) { canvas.toBlob(res, 'image/png'); });
        const img = await out.embedPng(await png.arrayBuffer());
        const p = out.addPage([img.width, img.height]);
        p.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
        setStatus('fsUnlockStatus', `Working... page ${i}/${pdf.numPages}`, 'busy');
      }
      const blob = new Blob([await out.save()], { type: 'application/pdf' });
      downloadBlob(blob, `${stem}_unprotected.pdf`);
      setStatus('fsUnlockStatus', `Done - ${pdf.numPages} page(s) unlocked (image-based).`, 'ok');
    } catch (e) {
      const msg = /password/i.test(e.message || '')
        ? 'That password did not work for this PDF.'
        : (e.message || 'Could not unprotect this PDF.');
      setStatus('fsUnlockStatus', msg, 'error');
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // IMAGE -> PDF
  // ══════════════════════════════════════════════════════════════════
  function renderImageToPdf() {
    return card('Image to PDF', '🖼️',
      'Turn JPG/PNG images into a single PDF - one image per page.', `
      <div class="setup-group">
        <label>Images (JPG or PNG)</label>
        <input type="file" id="fsImgFiles" accept="image/jpeg,image/png" multiple />
      </div>
      ${btn('FreeServices.runImageToPdf()', '🖼️ Create PDF')}
      ${statusLine('fsImgStatus')}`);
  }

  async function runImageToPdf() {
    try {
      requireLibs(true);
      const files = fileInputFiles('fsImgFiles');
      if (!files.length) return setStatus('fsImgStatus', 'Please choose at least one image.', 'error');

      setStatus('fsImgStatus', 'Working...', 'busy');
      const out = await PDFLib.PDFDocument.create();
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const buf = await f.arrayBuffer();
        const isPng = /png$/i.test(f.type) || /\.png$/i.test(f.name);
        const img = isPng ? await out.embedPng(buf) : await out.embedJpg(buf);
        const page = out.addPage([img.width, img.height]);
        page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
        setStatus('fsImgStatus', `Working... ${i + 1}/${files.length}`, 'busy');
      }
      const blob = new Blob([await out.save()], { type: 'application/pdf' });
      downloadBlob(blob, 'images.pdf');
      setStatus('fsImgStatus', `Done - ${files.length} image(s) in one PDF.`, 'ok');
    } catch (e) {
      setStatus('fsImgStatus', e.message || 'Could not build the PDF. JPG and PNG are supported.', 'error');
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // PDF -> IMAGE
  // ══════════════════════════════════════════════════════════════════
  function renderPdfToImage() {
    return card('PDF to Image', '📸',
      'Export each PDF page as a PNG image.', `
      <div class="setup-group">
        <label>PDF file</label>
        <input type="file" id="fsP2iFile" accept="application/pdf" />
      </div>
      <div class="setup-group" style="margin-top:10px;">
        <label>Quality</label>
        <select id="fsP2iScale">
          <option value="1.5">Standard</option>
          <option value="2" selected>High</option>
          <option value="3">Very high (larger files)</option>
        </select>
      </div>
      ${btn('FreeServices.runPdfToImage()', '📸 Convert to Images')}
      ${statusLine('fsP2iStatus')}`);
  }

  async function runPdfToImage() {
    try {
      requireLibs(false);
      if (typeof JSZip === 'undefined') throw new Error('JSZip failed to load - please refresh the page.');
      const files = fileInputFiles('fsP2iFile');
      if (!files.length) return setStatus('fsP2iStatus', 'Please choose a PDF file first.', 'error');
      const scale = parseFloat((document.getElementById('fsP2iScale') || {}).value || '2') || 2;
      const stem = baseName(files[0].name);

      setStatus('fsP2iStatus', 'Working...', 'busy');
      const pdf = await pdfjsLib.getDocument({ data: await files[0].arrayBuffer() }).promise;
      const zip = new JSZip();
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const vp = page.getViewport({ scale: scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(vp.width);
        canvas.height = Math.round(vp.height);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
        const blob = await new Promise(function (res) { canvas.toBlob(res, 'image/png'); });
        zip.file(`${stem}_page_${i}.png`, blob);
        setStatus('fsP2iStatus', `Working... page ${i}/${pdf.numPages}`, 'busy');
      }
      downloadBlob(await zip.generateAsync({ type: 'blob' }), `${stem}_images.zip`);
      setStatus('fsP2iStatus', `Done - ${pdf.numPages} PNG image(s) in a ZIP.`, 'ok');
    } catch (e) {
      setStatus('fsP2iStatus', e.message || 'Could not convert this PDF.', 'error');
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // EMI CALCULATOR
  // ══════════════════════════════════════════════════════════════════
  function renderEmiCalculator() {
    return card('EMI Calculator', '🏦',
      'Work out the monthly instalment on a loan, plus the total interest you would pay.', `
      <div style="display:flex;gap:12px;flex-wrap:wrap;">
        <div class="setup-group" style="flex:1;min-width:170px;">
          <label>Loan amount</label>
          <input type="number" id="fsEmiAmount" min="0" step="any" placeholder="e.g. 500000" />
        </div>
        <div class="setup-group" style="flex:1;min-width:170px;">
          <label>Annual interest rate (%)</label>
          <input type="number" id="fsEmiRate" min="0" step="any" placeholder="e.g. 8.5" />
        </div>
        <div class="setup-group" style="flex:1;min-width:170px;">
          <label>Tenure (months)</label>
          <input type="number" id="fsEmiMonths" min="1" step="1" placeholder="e.g. 60" />
        </div>
      </div>
      ${btn('FreeServices.runEmi()', '🏦 Calculate EMI')}
      <div id="fsEmiResult" style="margin-top:12px;"></div>
      ${statusLine('fsEmiStatus')}`);
  }

  function runEmi() {
    const num = (id) => parseFloat((document.getElementById(id) || {}).value);
    const P = num('fsEmiAmount'), annual = num('fsEmiRate'), n = num('fsEmiMonths');
    const res = document.getElementById('fsEmiResult');
    if (res) res.innerHTML = '';

    if (!Number.isFinite(P) || P <= 0) return setStatus('fsEmiStatus', 'Enter a loan amount greater than 0.', 'error');
    if (!Number.isFinite(annual) || annual < 0) return setStatus('fsEmiStatus', 'Enter a valid interest rate (0 or more).', 'error');
    if (!Number.isFinite(n) || n < 1) return setStatus('fsEmiStatus', 'Enter a tenure of at least 1 month.', 'error');

    const r = annual / 12 / 100;
    // r === 0 would make the standard formula divide by zero, so a 0%
    // loan is just the principal split evenly across the tenure.
    const emi = r === 0 ? (P / n) : (P * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
    const total = emi * n;
    const interest = total - P;
    const fmt = (v) => v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    setStatus('fsEmiStatus', '', 'ok');
    if (res) res.innerHTML = `
      <table class="admin-json-table" style="width:100%;">
        <tbody>
          <tr><td><b>Monthly EMI</b></td><td style="text-align:right;"><b>${fmt(emi)}</b></td></tr>
          <tr><td>Principal</td><td style="text-align:right;">${fmt(P)}</td></tr>
          <tr><td>Total interest</td><td style="text-align:right;">${fmt(interest)}</td></tr>
          <tr><td>Total payable</td><td style="text-align:right;">${fmt(total)}</td></tr>
        </tbody>
      </table>
      <p style="font-size:0.78rem;color:rgba(0,0,0,0.5);margin-top:8px;">
        Reducing-balance basis. Your lender's actual figure can differ slightly
        depending on fees, rounding, and how they count the first instalment.
      </p>`;
  }

  // ══════════════════════════════════════════════════════════════════
  // GRATUITY CALCULATOR
  // ══════════════════════════════════════════════════════════════════
  function renderGratuityCalculator() {
    return card('Gratuity Calculator', '💼',
      'Estimate a gratuity payout from last drawn salary and years of service.', `
      <div style="display:flex;gap:12px;flex-wrap:wrap;">
        <div class="setup-group" style="flex:1;min-width:200px;">
          <label>Last drawn monthly salary (basic + DA)</label>
          <input type="number" id="fsGraSalary" min="0" step="any" placeholder="e.g. 50000" />
        </div>
        <div class="setup-group" style="flex:1;min-width:170px;">
          <label>Years of service</label>
          <input type="number" id="fsGraYears" min="0" step="any" placeholder="e.g. 7" />
        </div>
      </div>
      ${btn('FreeServices.runGratuity()', '💼 Calculate Gratuity')}
      <div id="fsGraResult" style="margin-top:12px;"></div>
      ${statusLine('fsGraStatus')}`);
  }

  function runGratuity() {
    const num = (id) => parseFloat((document.getElementById(id) || {}).value);
    const salary = num('fsGraSalary'), years = num('fsGraYears');
    const res = document.getElementById('fsGraResult');
    if (res) res.innerHTML = '';

    if (!Number.isFinite(salary) || salary <= 0) return setStatus('fsGraStatus', 'Enter a salary greater than 0.', 'error');
    if (!Number.isFinite(years) || years < 0) return setStatus('fsGraStatus', 'Enter a valid number of years.', 'error');

    // Common statutory formula: salary x 15/26 x completed years, where a
    // part-year over 6 months counts as a full year. Rules differ by
    // country/employer, so this is clearly labelled an estimate below.
    const roundedYears = Math.floor(years) + ((years - Math.floor(years)) > 0.5 ? 1 : 0);
    const amount = salary * (15 / 26) * roundedYears;
    const fmt = (v) => v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    setStatus('fsGraStatus', '', 'ok');
    if (res) res.innerHTML = `
      <table class="admin-json-table" style="width:100%;">
        <tbody>
          <tr><td><b>Estimated gratuity</b></td><td style="text-align:right;"><b>${fmt(amount)}</b></td></tr>
          <tr><td>Salary used</td><td style="text-align:right;">${fmt(salary)}</td></tr>
          <tr><td>Years counted</td><td style="text-align:right;">${roundedYears}</td></tr>
        </tbody>
      </table>
      <p style="font-size:0.78rem;color:rgba(0,0,0,0.5);margin-top:8px;">
        Estimate only, using the salary x 15/26 x years formula (a part-year
        above 6 months counted as a full year). Eligibility rules, caps and
        formulas vary by country and employer - check your own terms, and
        treat this as a guide rather than a statement of what you are owed.
      </p>`;
  }

  // ── registry + dispatcher ──────────────────────────────────────────
  const TOOLS = {
    'pdf-split': renderPdfSplit,
    'pdf-merge': renderPdfMerge,
    'pdf-unprotect': renderPdfUnprotect,
    'image-to-pdf': renderImageToPdf,
    'pdf-to-image': renderPdfToImage,
    'emi-calculator': renderEmiCalculator,
    'gratuity-calculator': renderGratuityCalculator
  };

  function render(toolId) {
    const fn = TOOLS[toolId];
    if (!fn) {
      return '<div class="content-section"><p>This tool is not available.</p></div>';
    }
    return fn();
  }

  window.FreeServices = {
    render: render,
    has: function (id) { return Object.prototype.hasOwnProperty.call(TOOLS, id); },
    runSplit: runSplit,
    runMerge: runMerge,
    runUnprotect: runUnprotect,
    runImageToPdf: runImageToPdf,
    runPdfToImage: runPdfToImage,
    runEmi: runEmi,
    runGratuity: runGratuity
  };
})();
