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
    backTo: "goBackToServices()",
    description: 'Pull selected pages out of a PDF into a new file.',
    batch: true,
    setupHtml: function () {
      return `
        <div class="setup-group">
          <label>Pages to keep</label>
          <input type="text" id="fsSplitRange" placeholder="e.g. 1-3, 5, 8-10" />
        </div>
        <div class="setup-group">
          <div style="display:flex;gap:18px;margin-top:6px;">
            <label style="display:flex;align-items:center;gap:6px;font-weight:normal;cursor:pointer;">
              <input type="radio" name="fsSplitMode" value="merge" checked style="width:auto;margin:0;" />
              <span>Merged PDF</span>
            </label>
            <label style="display:flex;align-items:center;gap:6px;font-weight:normal;cursor:pointer;">
              <input type="radio" name="fsSplitMode" value="separate" style="width:auto;margin:0;" />
              <span>Sepreate PDF</span>
            </label>
          </div>
        </div>`;
    },
    process: async function (files, ctx, label) {
      requireLibs(true);
      const spec = ((document.getElementById('fsSplitRange') || {}).value || '').trim();
      const modeEl = document.querySelector('input[name="fsSplitMode"]:checked');
      const mode = modeEl ? modeEl.value : 'merge';
      if (typeof JSZip === 'undefined') throw new Error('JSZip failed to load - please refresh the page.');

      // No range at all -> each file gets fully decomposed into one PDF
      // per page. That naturally produces MANY files per input, so each
      // source file gets its OWN zip, delivered as soon as that file's
      // done (not held back waiting for the rest of the batch).
      if (!spec) {
        for (let fi = 0; fi < files.length; fi++) {
          const f = files[fi];
          const src = await PDFLib.PDFDocument.load(await f.arrayBuffer(), { ignoreEncryption: true });
          const total = src.getPageCount();
          const stem = baseName(f.name);
          if (ctx.pages) ctx.pages(total);
          ctx.log(`${label} > ${f.name} > Pages found = ${total}`, 'Info');
          const zip = new JSZip();
          for (let i = 0; i < total; i++) {
            const out = await PDFLib.PDFDocument.create();
            const [pg] = await out.copyPages(src, [i]);
            out.addPage(pg);
            zip.file(`${stem}_page_${i + 1}.pdf`, await out.save());
            if (ctx.progress) ctx.progress(((i + 1) / total) * 100);
          }
          ctx.download(await zip.generateAsync({ type: 'blob' }), `${stem}_split_pages.zip`);
          ctx.log(`${label} > ${f.name} > Generate Output > ${stem}_split_pages.zip (${total} file(s))`, 'Success');
        }
        return;
      }

      // A range was given -> each file produces exactly ONE output (the
      // extracted range, either as a single combined PDF or as
      // individually-separated pages depending on the radio choice).
      // Since it's one predictable output per file either way, the
      // whole batch bundles into a SINGLE zip instead of one per file.
      const batchZip = new JSZip();
      for (let fi = 0; fi < files.length; fi++) {
        const f = files[fi];
        const src = await PDFLib.PDFDocument.load(await f.arrayBuffer(), { ignoreEncryption: true });
        const total = src.getPageCount();
        const stem = baseName(f.name);
        if (ctx.pages) ctx.pages(total);
        const idx = parsePageRanges(spec, total);

        if (mode === 'separate') {
          for (let i = 0; i < idx.length; i++) {
            const out = await PDFLib.PDFDocument.create();
            const [pg] = await out.copyPages(src, [idx[i]]);
            out.addPage(pg);
            batchZip.file(`${stem}_page_${idx[i] + 1}.pdf`, await out.save());
          }
        } else {
          const out = await PDFLib.PDFDocument.create();
          (await out.copyPages(src, idx)).forEach(function (p) { out.addPage(p); });
          batchZip.file(`${stem}_split.pdf`, await out.save());
        }
        ctx.log(`${label} > ${f.name} > Extracted ${idx.length} page(s)`, 'Success');
        if (ctx.progress) ctx.progress(((fi + 1) / files.length) * 100);
      }
      ctx.download(await batchZip.generateAsync({ type: 'blob' }), `split_batch_${files.length}_files.zip`);
      ctx.log(`${label} > Generate Output > split_batch_${files.length}_files.zip`, 'Success');
    }
  });

  ServiceRunner.register({
    id: 'pdf-merge',
    title: 'PDF Merge',
    icon: '🔗',
    accept: 'application/pdf',
    backTo: "goBackToServices()",
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
        if (ctx.progress) ctx.progress(((i + 1) / files.length) * 100);
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
    backTo: "goBackToServices()",
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
        if (ctx.progress) ctx.progress(((i + 1) / files.length) * 100);
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
    backTo: "goBackToServices()",
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
      if (ctx.pages) ctx.pages(pdf.numPages);
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
        if (ctx.progress) ctx.progress((i / pdf.numPages) * 100);
      }
      ctx.download(await zip.generateAsync({ type: 'blob' }), `${stem}_images.zip`);
      ctx.log(`${label} > Generate Output > ${stem}_images.zip (${pdf.numPages} image(s))`, 'Success');
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // CALCULATORS (single card, result renders in the same card)
  // ══════════════════════════════════════════════════════════════════

  // Every tool page gets a way back to the Other Services list.
  // Injected into a card's own <h3> so the button sits inside the first
  // card (right-aligned) rather than floating above the page.
  function withBackButton(html) {
    const btn = '<button class="process-btn clear-btn card-back-btn" onclick="lexoraNavigate(\'services\',\'services\')">← Back to Services</button>';
    return html.replace(/<h3>([\s\S]*?)<\/h3>/, '<h3 class="card-head-row"><span>$1</span>' + btn + '</h3>');
  }

  // ── calculators ────────────────────────────────────────────────────
  // Slider + typed-value pairs that recalculate live (no Calculate button),
  // matching the reference design. Both controls write the same underlying
  // value, so dragging updates the box and typing moves the slider.
  // Deliberately currency-less: these calculators work the same in any
  // currency, and showing one symbol would misrepresent the others.
  const AMT = function (v) {
    return Math.round(v).toLocaleString('en-IN');
  };

  function sliderRow(label, id, value, min, max, step, suffix, prefix) {
    return `
      <div style="margin-bottom:22px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
          <label style="font-weight:500;color:#3d4a5c;">${esc(label)}</label>
          <div style="display:flex;align-items:center;gap:6px;background:#e8f6f0;border-radius:6px;padding:6px 10px;min-width:130px;justify-content:flex-end;">
            ${prefix ? `<span style="color:#12a37a;font-weight:600;">${prefix}</span>` : ''}
            <input type="number" id="${id}" value="${value}" min="${min}" max="${max}" step="${step}"
                   oninput="FreeServices.syncFromBox('${id}')"
                   style="border:none;background:transparent;text-align:right;width:92px;padding:0;font-weight:700;color:#12a37a;" />
            ${suffix ? `<span style="color:#12a37a;font-weight:600;">${suffix}</span>` : ''}
          </div>
        </div>
        <input type="range" id="${id}_r" value="${value}" min="${min}" max="${max}" step="${step}"
               oninput="FreeServices.syncFromSlider('${id}')"
               style="width:100%;margin-top:12px;accent-color:#12a37a;" />
      </div>`;
  }

  // Keep the number box and its slider in step, then recalculate.
  function syncFromBox(id) {
    const box = document.getElementById(id), sl = document.getElementById(id + '_r');
    if (box && sl) sl.value = box.value;
    recalc(id);
  }
  function syncFromSlider(id) {
    const box = document.getElementById(id), sl = document.getElementById(id + '_r');
    if (box && sl) box.value = sl.value;
    recalc(id);
  }
  function recalc(id) {
    if (id.indexOf('fsEmi') === 0) runEmi();
    else runGratuity();
  }

  function resultRow(label, value, strong) {
    return `<div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid rgba(0,0,0,0.06);">
      <span style="color:#6b7280;">${esc(label)}</span>
      <span style="${strong ? 'font-weight:700;' : ''}color:#3d4a5c;">${value}</span>
    </div>`;
  }

  // Item 16 - Services Catalog "Image" column can hold a full path;
  // falls back to the naming-convention path when not set.
  function catalogImageSrc(id, fallbackPath) {
    const entry = window.SERVICES_CATALOG && window.SERVICES_CATALOG[id];
    return (entry && entry.image && entry.image.trim()) || fallbackPath;
  }

  function renderEmi() {
    setTimeout(runEmi, 0);   // first paint of the result, after insertion
    return `
      <div class="service-split-layout">
        <div class="service-visual-panel" aria-hidden="true">
          <img class="service-visual-img" src="${esc(catalogImageSrc('emi-calculator', 'Pictures/service-images/emi-calculator.jpg'))}" alt=""
               onerror="this.style.display='none'; this.parentElement.classList.add('is-fallback');" />
          <span class="service-visual-icon">🏦</span>
        </div>
        <div class="service-card">
        <h3>🏦 EMI Calculator</h3>
        <div class="card-body">
          ${sliderRow('Loan amount', 'fsEmiAmount', 1000000, 10000, 20000000, 10000, '', '')}
          ${sliderRow('Rate of interest (p.a)', 'fsEmiRate', 6.5, 1, 30, 0.1, '%', '')}
          ${sliderRow('Loan tenure', 'fsEmiMonths', 5, 1, 30, 1, 'Yr', '')}
          <div id="fsEmiResult" style="margin-top:8px;"></div>
          <p style="font-size:0.76rem;color:rgba(0,0,0,0.45);margin-top:12px;">
            Reducing-balance basis. Your lender's figure can differ slightly depending on
            fees, rounding, and how the first instalment is counted.
          </p>
        </div>
        </div>
      </div>`;
  }

  function runEmi() {
    const num = (id) => parseFloat((document.getElementById(id) || {}).value);
    const P = num('fsEmiAmount'), annual = num('fsEmiRate'), years = num('fsEmiMonths');
    const res = document.getElementById('fsEmiResult');
    if (!res) return;
    if (!Number.isFinite(P) || P <= 0 || !Number.isFinite(annual) || annual < 0 || !Number.isFinite(years) || years < 1) {
      res.innerHTML = '<div style="color:#b3261e;font-size:0.86rem;">Enter a loan amount, a rate of 0 or more, and a tenure of at least 1 year.</div>';
      return;
    }
    const n = Math.round(years * 12);
    const r = annual / 12 / 100;
    // r === 0 would divide by zero in the standard formula, so an interest-free
    // loan is simply the principal split evenly across the tenure.
    const emi = r === 0 ? (P / n) : (P * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
    const total = emi * n;
    res.innerHTML =
      resultRow('Monthly EMI', AMT(emi), true) +
      resultRow('Principal amount', AMT(P)) +
      resultRow('Total interest', AMT(total - P)) +
      resultRow('Total amount', AMT(total));
  }

  function renderGratuity() {
    setTimeout(runGratuity, 0);
    return `
      <div class="service-split-layout">
        <div class="service-visual-panel" aria-hidden="true">
          <img class="service-visual-img" src="${esc(catalogImageSrc('gratuity-calculator', 'Pictures/service-images/gratuity-calculator.jpg'))}" alt=""
               onerror="this.style.display='none'; this.parentElement.classList.add('is-fallback');" />
          <span class="service-visual-icon">💼</span>
        </div>
        <div class="service-card">
        <h3>💼 Gratuity Calculator</h3>
        <div class="card-body">
          ${sliderRow('Monthly salary (Basic + DA)', 'fsGraSalary', 60000, 5000, 1000000, 1000, '', '')}
          ${sliderRow('Years of service', 'fsGraYears', 20, 1, 50, 1, '', '')}
          <div id="fsGraResult" style="margin-top:18px;"></div>
          <p style="font-size:0.76rem;color:rgba(0,0,0,0.45);margin-top:16px;">
            Estimate only, using the salary x 15/26 x years formula. Eligibility rules,
            caps and formulas vary by country and employer - check your own terms and
            treat this as a guide rather than a statement of what you are owed.
          </p>
        </div>
        </div>
      </div>`;
  }

  function runGratuity() {
    const num = (id) => parseFloat((document.getElementById(id) || {}).value);
    const salary = num('fsGraSalary'), years = num('fsGraYears');
    const res = document.getElementById('fsGraResult');
    if (!res) return;
    if (!Number.isFinite(salary) || salary <= 0 || !Number.isFinite(years) || years < 1) {
      res.innerHTML = '<div style="color:#b3261e;font-size:0.86rem;">Enter a salary above 0 and at least 1 year of service.</div>';
      return;
    }
    const amount = salary * (15 / 26) * years;
    res.innerHTML = `
      <div style="text-align:center;padding:10px 0;">
        <div style="color:#6b7280;font-size:0.9rem;">Total Gratuity payable</div>
        <div style="font-size:2rem;font-weight:700;color:#3d4a5c;margin-top:6px;">${AMT(amount)}</div>
      </div>`;
  }

  // ── Other Services landing page ────────────────────────────────────
  // Cards contributed by js/tools.js (pure-JS utilities). Merged in at
  // render time so adding a tool there needs no change in this file.
  function extraCards() {
    const list = [];
    [window.Tools, window.ToolsDocs].forEach(function (mod) {
      if (!mod || !mod.cards) return;
      Object.keys(mod.cards).forEach(function (id) {
        const c = mod.cards[id];
        list.push({ id: id, label: c.label, icon: c.icon, desc: c.desc });
      });
    });
    if (window.PaidCalculators && window.PaidCalculators.freeCards) {
      Object.keys(window.PaidCalculators.freeCards).forEach(function (id) {
        const c = window.PaidCalculators.freeCards[id];
        list.push({ id: id, label: c.label, icon: c.icon, desc: c.desc });
      });
    }
    return list;
  }

  // Card-based tools live in tools.js / tools-docs.js; file-based ones
  // register themselves with ServiceRunner. Look up whichever has it.
  function cardModule(id) {
    if (window.Tools && Tools.cards && Tools.cards[id]) return Tools.cards[id];
    if (window.ToolsDocs && ToolsDocs.cards && ToolsDocs.cards[id]) return ToolsDocs.cards[id];
    if (window.PaidCalculators && PaidCalculators.freeCards && PaidCalculators.freeCards[id]) return PaidCalculators.freeCards[id];
    return null;
  }

  const TOOLS = [
    { id: 'pdf-split', label: 'PDF Split', icon: '✂️', desc: 'Extract selected pages into a new PDF.' },
    { id: 'pdf-merge', label: 'PDF Merge', icon: '🔗', desc: 'Combine several PDFs into one.' },
    { id: 'image-to-pdf', label: 'Image to PDF', icon: '🖼️', desc: 'JPG/PNG images into a single PDF.' },
    { id: 'pdf-to-image', label: 'PDF to Image', icon: '📸', desc: 'Every page exported as a PNG.' },
    { id: 'emi-calculator', label: 'EMI Calculator', icon: '🏦', desc: 'Monthly instalment and total interest.' },
    { id: 'gratuity-calculator', label: 'Gratuity Calculator', icon: '💼', desc: 'Estimate a gratuity payout.' }
  ];

  // Tools grouped by what they operate on, so the landing page reads as a
  // small catalogue rather than one long undifferentiated grid. Anything
  // registered but not listed here still shows up under "More".
  const GROUPS = [
    { title: 'PDF Tools', icon: '📄', ids: ['pdf-split', 'pdf-merge', 'pdf-compress', 'pdf-to-image', 'pdf-to-word', 'pdf-form-filler', 'create-pdf', 'unlock-pdf', 'pdf-rotate-reorder', 'word-to-pdf', 'excel-to-pdf'] },
    { title: 'Image Tools', icon: '🖼️', ids: ['size-photo', 'image-compressor', 'image-cropper', 'image-to-pdf', 'image-format-converter', 'color-palette-extractor', 'passport-photo-maker', 'meme-generator', 'background-remover'] },
    { title: 'Calculators', icon: '🧮', ids: ['emi-calculator', 'gratuity-calculator', 'age-calculator', 'unit-converter', 'currency-converter', 'bmi-calculator', 'percentage-calculator', 'date-diff-calculator', 'discount-gst-calculator', 'sip-calculator', 'income-tax-calculator', 'compound-interest-calculator', 'loan-eligibility-calculator'] },
    { title: 'Data Tools', icon: '📊', ids: ['data-comparison', 'etl', 'json-to-csv', 'csv-to-json', 'word-counter', 'excel-to-csv', 'csv-to-excel', 'split-excel', 'grammar-check'] },
    { title: 'Document Builders', icon: '📝', ids: ['invoice-generator', 'quotation-generator', 'receipt-generator', 'certificate-generator', 'business-card-maker'] },
    { title: 'Generators', icon: '✨', ids: ['business-name-generator', 'logo-builder'] },
    { title: 'Video Tools', icon: '🎬', ids: ['video-to-audio', 'trim-video-audio'] },
    { title: 'Utilities', icon: '🔧', ids: ['timezone', 'password-generator', 'qr-generator', 'barcode-generator', 'create-zip', 'signature-maker', 'check-ip', 'speed-test', 'text-to-speech'] }
  ];

  // Everything that can be opened, whichever module registered it:
  // ServiceRunner file-tools, plus the card-based registries.
  // The 7 services with their own dedicated page/billing outside this
  // module (Translation, OCR, etc. - built in app.js/paid-calculators.js
  // as full paid-service UIs, not a simple card()/ServiceRunner tool).
  // When the Services Catalog marks one of these "Free", it still needs
  // its own real page (can't be rendered generically), so it's added as
  // an "external" tile here - clicking it navigates to that dedicated
  // page instead of trying to render it inline.
  const NATIVE_PAID_SERVICES = [
    { id: 'lease-abstraction', label: 'Lease Abstraction', icon: '📄', desc: 'Extract key terms and clauses from lease documents.' },
    { id: 'translation', label: 'Translation', icon: '🌐', desc: 'Translate documents into 60+ languages, layout preserved.' },
    { id: 'ocr', label: 'OCR', icon: '🔍', desc: 'Turn scanned or photographed pages into editable Word.' },
    { id: 'data-extraction', label: 'Data Extraction', icon: '📊', desc: 'Define your own fields and get a clean structured table.' },
    { id: 'bai2', label: 'BAI2', icon: '🏦', desc: 'Convert bank statements into BAI2, CSV, or JSON.' },
    { id: 'content-writing-tool', label: 'Content Writing Tool', icon: '✍️', desc: 'Generate blog posts, captions, product descriptions and more.' },
    { id: 'humanize-document-tool', label: 'Humanize Document Tool', icon: '🧑', desc: 'Rewrite stiff or AI-sounding text to read more naturally.' },
  ];

  // Services Catalog (Admin > PostgreSQL > Services Catalog table) can
  // move any service between Free/Paid - checked here so both the tile
  // list and the actual open() gate agree on the same classification.
  // Falls back to "whatever this module already treats it as" (free) for
  // anything not yet in the catalog, so a partially-seeded table never
  // hides a tool that was working before.
  function catalogType(id) {
    const entry = window.SERVICES_CATALOG && window.SERVICES_CATALOG[id];
    return entry ? entry.type : null;
  }

  // "Hidden" in the Services Catalog removes a service from EVERY
  // listing (Free Services, Paid Services, API Documentation) - a
  // stronger switch than the Paid/Free toggle, which just moves a
  // service between two catalogues rather than removing it entirely.
  function isHidden(id) {
    const entry = window.SERVICES_CATALOG && window.SERVICES_CATALOG[id];
    return !!(entry && entry.visibility === 'Hidden');
  }

  // Services Catalog "Name" column overrides a service's display label
  // everywhere it's shown as a tile - the id (and everything id-based,
  // like the service-image lookup) never changes, only what's printed
  // on screen.
  function catalogName(id, fallback) {
    const entry = window.SERVICES_CATALOG && window.SERVICES_CATALOG[id];
    return (entry && entry.name && entry.name.trim()) ? entry.name.trim() : fallback;
  }

  function allToolsRaw() {
    const seen = {};
    const list = [];
    const push = (t) => { if (t && t.id && !seen[t.id]) { seen[t.id] = true; list.push(t); } };
    if (window.ServiceRunner && ServiceRunner.list) ServiceRunner.list().forEach(push);
    TOOLS.forEach(push);
    extraCards().forEach(push);
    return list;
  }

  function allTools() {
    const list = allToolsRaw();

    // A normally-free tool marked "Paid" in the catalog moves OUT of
    // this list (the Paid Services page picks it up instead - see
    // app.js's paid-services landing body). Hidden ones are removed
    // entirely, regardless of Paid/Free.
    const filtered = list.filter(t => catalogType(t.id) !== 'Paid' && !isHidden(t.id))
      .map(t => Object.assign({}, t, { label: catalogName(t.id, t.label) }));

    // A native paid service marked "Free" moves IN, as an external tile
    // (its own real page, not rendered by this module) - unless hidden.
    NATIVE_PAID_SERVICES.forEach(function (svc) {
      if (catalogType(svc.id) === 'Free' && !isHidden(svc.id)) {
        filtered.push(Object.assign({ external: true }, svc, { label: catalogName(svc.id, svc.label) }));
      }
    });

    return filtered;
  }

  // Login page ko wahi catalogue chahiye jo Other Services dikhata hai.
  // Pehle wo list manually likhi gayi thi, isliye kai tools chhoot gaye
  // the. Ab ek hi source hai - naya tool register karte hi dono jagah
  // apne aap aa jayega.
  function catalogue() {
    const byId = {};
    allTools().forEach(function (t) { byId[t.id] = t; });

    const used = {};
    const groups = GROUPS.map(function (g) {
      // Poora tool object lautao (id/label/desc) - login page ko sirf
      // label chahiye, par API Documentation ko id aur desc bhi chahiye.
      const tools = g.ids.map(function (id) { used[id] = true; return byId[id]; })
        .filter(Boolean);
      return { title: g.title, icon: g.icon, tools: tools };
    }).filter(function (g) { return g.tools.length; });

    const more = allTools().filter(function (t) { return !used[t.id]; });
    if (more.length) groups.push({ title: 'More Tools', icon: '\u{1F527}', tools: more });

    return groups;
  }

  function toolCard(t) {
    const click = t.external ? `lexoraNavigate('services','${t.id}')` : `FreeServices.open('${t.id}')`;
    return `
      <div class="tool-card" data-service-search="${esc((t.label + ' ' + (t.desc || '')).toLowerCase())}" onclick="${click}">
        <div class="tool-card-icon">${t.icon || '🔧'}</div>
        <div class="tool-card-text">
          <div class="tool-card-name">${esc(t.label)}</div>
          <div class="tool-card-desc">${esc(t.desc || '')}</div>
        </div>
      </div>`;
  }

  function renderIndex() {
    const all = allTools();
    return `<div class="tool-group-title">🧰 Free Services</div>
      <div class="tools-grid">${all.map(toolCard).join('')}</div>`;
  }

  const CALCULATORS = { 'emi-calculator': renderEmi, 'gratuity-calculator': renderGratuity };

  function render(id) {
    if (id === 'other-services') return renderIndex();
    const cm = cardModule(id);
    if (cm) return withBackButton(cm.render());
    if (CALCULATORS[id]) return withBackButton(CALCULATORS[id]());
    if (window.ServiceRunner && ServiceRunner.has(id)) return ServiceRunner.render(id);
    return '<div class="content-section"><p>This tool is not available.</p></div>';
  }

  function has(id) {
    return id === 'other-services' || !!CALCULATORS[id] ||
      !!cardModule(id) ||
      (!!window.ServiceRunner && ServiceRunner.has(id));
  }

  // Tool pages are opened by swapping contentBody directly (no loadContent),
  // so the page header has to be updated here too - otherwise it keeps
  // showing the parent section ("Services / Other Services") after drilling
  // into a tool.
  function titleOf(id) {
    const t = TOOLS.concat(extraCards()).find(function (x) { return x.id === id; });
    if (t) return catalogName(id, t.label);
    if (window.ServiceRunner && ServiceRunner.has(id)) return catalogName(id, id);
    return '';
  }

  // A normally-free tool marked "Paid" in the Services Catalog charges
  // once per open (there's no single natural "process" moment shared
  // across calculators/generators/converters the way file-upload paid
  // services have a Start button) - same rate/balance machinery every
  // other paid service already uses (window.LexoraBilling), just
  // triggered here instead of from inside the tool itself.
  // Two-step by design: NEVER charge before we know the work actually
  // succeeded. Call confirmPaidAccess() before starting work (checks
  // balance, asks for confirmation, but charges nothing yet) - if it
  // resolves true, do the work; only call chargeForPaidAccess() from
  // inside your OWN success path afterwards. A failure anywhere in
  // between costs the person nothing.
  function isPaidInCatalog(id) {
    return catalogType(id) === 'Paid' && !NATIVE_PAID_SERVICES.some(s => s.id === id);
  }

  function confirmPaidAccess(id) {
    return new Promise(function (resolve) {
      if (!isPaidInCatalog(id)) { resolve(true); return; }
      const billing = window.LexoraBilling;
      if (!billing) { resolve(true); return; } // billing not ready - fail open rather than block the tool entirely
      const rate = billing.perPageRate(id);
      if (!rate || rate <= 0) { resolve(true); return; }
      if (billing.balance() < rate) {
        if (window.showWarning) showWarning(`This is a paid feature. \u20b9${rate.toFixed(2)} is needed but your wallet balance is too low - please add balance first.`);
        resolve(false);
        return;
      }
      if (window.showConfirm) {
        showConfirm('\ud83d\udcb0 Paid Feature', `This is a paid feature. \u20b9${rate.toFixed(2)} will be charged only if it completes successfully. Continue?`, function (confirmed) {
          resolve(!!confirmed);
        });
      } else {
        resolve(true);
      }
    });
  }

  function chargeForPaidAccess(id) {
    if (!isPaidInCatalog(id)) return null;
    const billing = window.LexoraBilling;
    if (!billing) return null;
    const rate = billing.perPageRate(id);
    if (!rate || rate <= 0) return null;
    const txnId = billing.charge(titleOf(id) + ' - access', rate);
    if (txnId && window.notifyProcessCompletion) window.notifyProcessCompletion(titleOf(id), 'Use', rate, txnId);
    return txnId;
  }

  function open(id) {
    openNow(id);
  }

  function openNow(id) {
    const host = document.getElementById('contentBody');
    if (host) host.innerHTML = render(id);
    if (window.lexoraEnhancePage) window.lexoraEnhancePage(host);
    if (window.setLexoraBreadcrumb) {
      const base = window.__lexoraBreadcrumb || '\ud83d\udee0\ufe0f Services / Free Services';
      const name = id === 'other-services' ? '' : titleOf(id);
      window.setLexoraBreadcrumb(name ? base + ' / ' + name : base);
    }
  }

  window.FreeServices = {
    render: render,
    has: has,
    open: open,
    catalogue: catalogue,
    allToolsRaw: allToolsRaw,
    nativePaidServices: NATIVE_PAID_SERVICES,
    isHidden: isHidden,
    isPaidInCatalog: isPaidInCatalog,
    confirmPaidAccess: confirmPaidAccess,
    chargeForPaidAccess: chargeForPaidAccess,
    syncFromBox: syncFromBox,
    syncFromSlider: syncFromSlider,
    runEmi: runEmi,
    runGratuity: runGratuity
  };
})();
