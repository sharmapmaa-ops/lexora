/* free-services.js — "Other Services" (free, no billing, no API calls).
 *
 * Two different UI shapes, chosen to fit the task:
 *
 *  - FILE TOOLS (PDF Split/Merge, Image↔PDF) use the shared ServiceRunner so
 *    they get the same layout as Translation: upload card, file table with
 *    checkboxes, activity log, Start/Clear.
 *
 *  - CALCULATORS (EMI, Gratuity) are a single self-contained card - there are
 *    no files to upload or track, so the file-table/activity-log shell would
 *    be empty scaffolding. Input fields + Calculate + the result render in
 *    that one card.
 *
 * Everything runs in the browser (pdf.js reads PDFs, pdf-lib writes them),
 * so nothing is uploaded and nothing is charged.
 */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function requireLibs(needPdfLib) {
    if (typeof pdfjsLib === 'undefined') throw new Error('pdf.js failed to load - please refresh the page.');
    if (needPdfLib && typeof PDFLib === 'undefined') throw new Error('pdf-lib failed to load - please refresh the page.');
  }

  function baseName(name) { return String(name || 'document').replace(/\.[^.]+$/, ''); }

  // "1-3, 5, 8-10" -> sorted unique 0-based indices, validated against the
  // real page count so a typo gives a clear message instead of a wrong file.
  function parsePageRanges(spec, pageCount) {
    const out = new Set();
    for (const raw of String(spec || '').split(',')) {
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

  // ══════════════════════════════════════════════════════════════════
  // FILE TOOLS (ServiceRunner-based)
  // ══════════════════════════════════════════════════════════════════

  ServiceRunner.register({
    id: 'pdf-split',
    title: 'PDF Split',
    icon: '✂️',
    accept: 'application/pdf',
    description: 'Pull selected pages out of a PDF into a new file.',
    setupHtml: function () {
      return `
        <div class="setup-group">
          <label>Pages to keep</label>
          <input type="text" id="fsSplitRange" placeholder="e.g. 1-3, 5, 8-10" />
          <div style="font-size:0.78rem;color:rgba(0,0,0,0.5);margin-top:4px;">
            Leave empty to split every page into its own separate PDF (delivered as a ZIP).
          </div>
        </div>`;
    },
    process: async function (files, ctx, label) {
      requireLibs(true);
      const spec = ((document.getElementById('fsSplitRange') || {}).value || '').trim();
      const f = files[0];
      const src = await PDFLib.PDFDocument.load(await f.arrayBuffer(), { ignoreEncryption: true });
      const total = src.getPageCount();
      const stem = baseName(f.name);
      ctx.log(`${label} > Pages found = ${total}`, 'Info');

      if (!spec) {
        if (typeof JSZip === 'undefined') throw new Error('JSZip failed to load - please refresh the page.');
        const zip = new JSZip();
        for (let i = 0; i < total; i++) {
          const out = await PDFLib.PDFDocument.create();
          const [pg] = await out.copyPages(src, [i]);
          out.addPage(pg);
          zip.file(`${stem}_page_${i + 1}.pdf`, await out.save());
        }
        ctx.download(await zip.generateAsync({ type: 'blob' }), `${stem}_split_pages.zip`);
        ctx.log(`${label} > Generate Output > ${stem}_split_pages.zip (${total} file(s))`, 'Success');
        return;
      }

      const idx = parsePageRanges(spec, total);
      const out = await PDFLib.PDFDocument.create();
      (await out.copyPages(src, idx)).forEach(function (p) { out.addPage(p); });
      ctx.download(new Blob([await out.save()], { type: 'application/pdf' }), `${stem}_split.pdf`);
      ctx.log(`${label} > Generate Output > ${stem}_split.pdf (${idx.length} page(s))`, 'Success');
    }
  });

  ServiceRunner.register({
    id: 'pdf-merge',
    title: 'PDF Merge',
    icon: '🔗',
    accept: 'application/pdf',
    batch: true,      // merge needs ALL selected files together, not one-by-one
    description: 'Combine several PDFs into one, in the order they appear in the list.',
    process: async function (files, ctx) {
      requireLibs(true);
      if (files.length < 2) throw new Error('Select at least two PDF files to merge.');
      const out = await PDFLib.PDFDocument.create();
      let pages = 0;
      for (let i = 0; i < files.length; i++) {
        const src = await PDFLib.PDFDocument.load(await files[i].arrayBuffer(), { ignoreEncryption: true });
        (await out.copyPages(src, src.getPageIndices())).forEach(function (p) { out.addPage(p); pages++; });
        ctx.log(`Merged ${i + 1}/${files.length} > ${files[i].name}`, 'Info');
      }
      ctx.download(new Blob([await out.save()], { type: 'application/pdf' }), 'merged.pdf');
      ctx.log(`Generate Output > merged.pdf (${files.length} file(s), ${pages} page(s))`, 'Success');
    }
  });

  ServiceRunner.register({
    id: 'image-to-pdf',
    title: 'Image to PDF',
    icon: '🖼️',
    accept: 'image/jpeg,image/png',
    batch: true,      // all selected images become one PDF
    description: 'Turn JPG/PNG images into a single PDF - one image per page.',
    process: async function (files, ctx) {
      requireLibs(true);
      const out = await PDFLib.PDFDocument.create();
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const buf = await f.arrayBuffer();
        const isPng = /png$/i.test(f.type) || /\.png$/i.test(f.name);
        const img = isPng ? await out.embedPng(buf) : await out.embedJpg(buf);
        const page = out.addPage([img.width, img.height]);
        page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
        ctx.log(`Added ${i + 1}/${files.length} > ${f.name}`, 'Info');
      }
      ctx.download(new Blob([await out.save()], { type: 'application/pdf' }), 'images.pdf');
      ctx.log(`Generate Output > images.pdf (${files.length} page(s))`, 'Success');
    }
  });

  ServiceRunner.register({
    id: 'pdf-to-image',
    title: 'PDF to Image',
    icon: '📸',
    accept: 'application/pdf',
    description: 'Export each PDF page as a PNG image.',
    setupHtml: function () {
      return `
        <div class="setup-group">
          <label>Quality</label>
          <select id="fsP2iScale" style="width:220px;">
            <option value="1.5">Standard</option>
            <option value="2" selected>High</option>
            <option value="3">Very high (larger files)</option>
          </select>
        </div>`;
    },
    process: async function (files, ctx, label) {
      requireLibs(false);
      if (typeof JSZip === 'undefined') throw new Error('JSZip failed to load - please refresh the page.');
      const scale = parseFloat((document.getElementById('fsP2iScale') || {}).value || '2') || 2;
      const f = files[0];
      const stem = baseName(f.name);
      const pdf = await pdfjsLib.getDocument({ data: await f.arrayBuffer() }).promise;
      const zip = new JSZip();
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const vp = page.getViewport({ scale: scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
        const blob = await new Promise(function (res) { canvas.toBlob(res, 'image/png'); });
        zip.file(`${stem}_page_${i}.png`, blob);
        ctx.log(`${label} > Page(${i}/${pdf.numPages}) > rendered`, 'Info');
      }
      ctx.download(await zip.generateAsync({ type: 'blob' }), `${stem}_images.zip`);
      ctx.log(`${label} > Generate Output > ${stem}_images.zip (${pdf.numPages} image(s))`, 'Success');
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // CALCULATORS (single card, result renders in the same card)
  // ══════════════════════════════════════════════════════════════════

  function calcCard(title, icon, description, fieldsHtml, onclick, btnLabel, resultId, statusId) {
    return `
      <div class="content-section">
        <h3>${icon} ${esc(title)}</h3>
        <p style="color:#555;margin:-2px 0 14px 0;font-size:0.9rem;">${description}</p>
        ${fieldsHtml}
        <button class="filter-btn" style="margin-top:12px;" onclick="${onclick}">${btnLabel}</button>
        <div id="${statusId}" style="margin-top:10px;font-size:0.86rem;color:#b3261e;min-height:1.1em;"></div>
        <div id="${resultId}" style="margin-top:12px;"></div>
      </div>`;
  }

  function renderEmi() {
    return calcCard('EMI Calculator', '🏦',
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
      </div>`,
      'FreeServices.runEmi()', '🏦 Calculate', 'fsEmiResult', 'fsEmiStatus');
  }

  function runEmi() {
    const num = (id) => parseFloat((document.getElementById(id) || {}).value);
    const P = num('fsEmiAmount'), annual = num('fsEmiRate'), n = num('fsEmiMonths');
    const res = document.getElementById('fsEmiResult');
    const stat = document.getElementById('fsEmiStatus');
    if (res) res.innerHTML = '';
    const fail = (m) => { if (stat) stat.textContent = m; };
    if (stat) stat.textContent = '';

    if (!Number.isFinite(P) || P <= 0) return fail('Enter a loan amount greater than 0.');
    if (!Number.isFinite(annual) || annual < 0) return fail('Enter a valid interest rate (0 or more).');
    if (!Number.isFinite(n) || n < 1) return fail('Enter a tenure of at least 1 month.');

    const r = annual / 12 / 100;
    // r === 0 would divide by zero in the standard formula, so a 0% loan is
    // simply the principal split evenly across the tenure.
    const emi = r === 0 ? (P / n) : (P * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
    const total = emi * n, interest = total - P;
    const fmt = (v) => v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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

  function renderGratuity() {
    return calcCard('Gratuity Calculator', '💼',
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
      </div>`,
      'FreeServices.runGratuity()', '💼 Calculate', 'fsGraResult', 'fsGraStatus');
  }

  function runGratuity() {
    const num = (id) => parseFloat((document.getElementById(id) || {}).value);
    const salary = num('fsGraSalary'), years = num('fsGraYears');
    const res = document.getElementById('fsGraResult');
    const stat = document.getElementById('fsGraStatus');
    if (res) res.innerHTML = '';
    const fail = (m) => { if (stat) stat.textContent = m; };
    if (stat) stat.textContent = '';

    if (!Number.isFinite(salary) || salary <= 0) return fail('Enter a salary greater than 0.');
    if (!Number.isFinite(years) || years < 0) return fail('Enter a valid number of years.');

    // Common statutory formula: salary x 15/26 x completed years, with a
    // part-year over 6 months counting as a full year. Rules vary by country
    // and employer, so the result is labelled an estimate below.
    const roundedYears = Math.floor(years) + ((years - Math.floor(years)) > 0.5 ? 1 : 0);
    const amount = salary * (15 / 26) * roundedYears;
    const fmt = (v) => v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
        formulas vary by country and employer - check your own terms and treat
        this as a guide rather than a statement of what you are owed.
      </p>`;
  }

  // ── Other Services landing page ────────────────────────────────────
  const TOOLS = [
    { id: 'pdf-split', label: 'PDF Split', icon: '✂️', desc: 'Extract selected pages into a new PDF.' },
    { id: 'pdf-merge', label: 'PDF Merge', icon: '🔗', desc: 'Combine several PDFs into one.' },
    { id: 'image-to-pdf', label: 'Image to PDF', icon: '🖼️', desc: 'JPG/PNG images into a single PDF.' },
    { id: 'pdf-to-image', label: 'PDF to Image', icon: '📸', desc: 'Every page exported as a PNG.' },
    { id: 'emi-calculator', label: 'EMI Calculator', icon: '🏦', desc: 'Monthly instalment and total interest.' },
    { id: 'gratuity-calculator', label: 'Gratuity Calculator', icon: '💼', desc: 'Estimate a gratuity payout.' }
  ];

  function renderIndex() {
    return `
      <div class="content-section">
        <h3>🎁 Other Services</h3>
        <p style="color:#555;">Free tools that run entirely in your browser - nothing is uploaded, nothing is charged.</p>
      </div>
      <div class="plans-grid">
        ${TOOLS.map(function (t) {
          return `
            <div class="plan-card" style="cursor:pointer;" onclick="FreeServices.open('${t.id}')">
              <div class="plan-name">${t.icon} ${esc(t.label)}</div>
              <p style="color:#555;font-size:0.86rem;margin-top:6px;">${esc(t.desc)}</p>
              <button class="plan-cta-btn" onclick="event.stopPropagation();FreeServices.open('${t.id}')">Open</button>
            </div>`;
        }).join('')}
      </div>`;
  }

  const CALCULATORS = { 'emi-calculator': renderEmi, 'gratuity-calculator': renderGratuity };

  function render(id) {
    if (id === 'other-services') return renderIndex();
    if (CALCULATORS[id]) return CALCULATORS[id]();
    if (window.ServiceRunner && ServiceRunner.has(id)) return ServiceRunner.render(id);
    return '<div class="content-section"><p>This tool is not available.</p></div>';
  }

  function has(id) {
    return id === 'other-services' || !!CALCULATORS[id] ||
      (!!window.ServiceRunner && ServiceRunner.has(id));
  }

  function open(id) {
    const host = document.getElementById('contentBody');
    if (host) host.innerHTML = render(id);
  }

  window.FreeServices = {
    render: render,
    has: has,
    open: open,
    runEmi: runEmi,
    runGratuity: runGratuity
  };
})();
