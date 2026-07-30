/* tools-docs.js — Other Services: document & data tools (card-based).
 *
 * These don't fit the "upload files, press Start" shell - they're forms or
 * text areas where the user builds something, so each is a single card.
 * All browser-side: pdf-lib writes PDFs, SheetJS reads spreadsheets.
 */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  const val = (id) => (document.getElementById(id) || {}).value || '';
  const out = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
  const say = (id, msg, kind) => {
    const el = document.getElementById(id);
    if (el) { el.style.color = kind === 'error' ? '#b3261e' : '#1b5e20'; el.textContent = msg; }
  };

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function card(icon, title, body, note) {
    return `
      <div class="service-card">
        <h3>${icon} ${esc(title)}</h3>
        <div class="card-body">
          ${body}
          ${note ? `<p style="font-size:0.76rem;color:rgba(0,0,0,0.45);margin-top:14px;">${note}</p>` : ''}
        </div>
      </div>`;
  }

  const fld = (label, inner, flex) =>
    `<div class="setup-group" style="flex:${flex || 1};min-width:180px;"><label>${esc(label)}</label>${inner}</div>`;

  // ══════════════════════════════════════════════════════════════════
  // INVOICE / QUOTATION / RECEIPT GENERATOR
  // ══════════════════════════════════════════════════════════════════
  // One implementation, three documents - they differ only in wording, so
  // duplicating the whole builder three times would just be three places to
  // fix the same bug.
  const DOC_KINDS = {
    'invoice-generator':   { title: 'Invoice Generator',   icon: '🧾', heading: 'INVOICE',   numLabel: 'Invoice No',   dateLabel: 'Invoice Date' },
    'quotation-generator': { title: 'Quotation Generator', icon: '📋', heading: 'QUOTATION', numLabel: 'Quotation No', dateLabel: 'Quotation Date' },
    'receipt-generator':   { title: 'Receipt Generator',   icon: '🧾', heading: 'RECEIPT',   numLabel: 'Receipt No',   dateLabel: 'Receipt Date' }
  };

  let docItems = [{ desc: '', qty: 1, rate: 0 }];
  let docKind = 'invoice-generator';
  const docLogos = {}; // keyed by docKind: { bytes, ext }

  function renderDoc(kind) {
    docKind = kind;
    const k = DOC_KINDS[kind];
    const today = new Date().toISOString().slice(0, 10);
    const logo = docLogos[kind];
    return card(k.icon, k.title, `
      <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;">
        ${fld('Your business name', `<input type="text" id="tDvFrom" placeholder="Acme Pvt Ltd" style="width:100%;" />`)}
        ${fld(k.numLabel, `<input type="text" id="tDvNo" value="001" style="width:100%;" />`)}
        ${fld(k.dateLabel, `<input type="date" id="tDvDate" value="${today}" style="width:100%;" />`)}
        <div class="setup-group" style="flex:1;min-width:180px;">
          <label>Logo</label>
          <div style="display:flex;align-items:center;gap:8px;">
            <button class="process-btn clear-btn" onclick="document.getElementById('tDvLogoFile').click()">
              ${logo ? '🖼️ Change Logo' : '🖼️ Add Logo'}
            </button>
            ${logo ? `<img src="${logo.dataUrl}" alt="Logo" style="height:32px;max-width:70px;object-fit:contain;border:1px solid rgba(0,0,0,0.1);border-radius:4px;" />
              <button class="process-btn clear-btn" onclick="ToolsDocs.removeLogo()" title="Remove logo">✕</button>` : ''}
          </div>
          <input type="file" id="tDvLogoFile" accept="image/png,image/jpeg" style="display:none;" onchange="ToolsDocs.onLogoPick(this.files[0])" />
        </div>
      </div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;">
        ${fld('Bill to', `<textarea id="tDvTo" rows="3" placeholder="Customer name&#10;Address" style="width:100%;"></textarea>`, 2)}
        ${fld('From address', `<textarea id="tDvFromAddr" rows="3" placeholder="Your address" style="width:100%;"></textarea>`, 2)}
      </div>

      <label style="font-weight:600;margin-top:6px;display:block;">Line items</label>
      <div class="file-table-wrapper" style="margin-top:6px;">
        <table class="file-table">
          <colgroup><col style="width:52%;"><col style="width:14%;"><col style="width:18%;"><col style="width:16%;"></colgroup>
          <thead><tr><th>Description</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead>
        </table>
        <div class="file-table-scroll" style="height:150px;max-height:150px;overflow-y:scroll;">
          <table class="file-table">
            <colgroup><col style="width:52%;"><col style="width:14%;"><col style="width:18%;"><col style="width:16%;"></colgroup>
            <tbody>
              ${docItems.map(function (it, i) {
                return `<tr>
                  <td><input type="text" id="tDvD_${i}" value="${esc(it.desc)}" placeholder="Item description" oninput="ToolsDocs.recalcDoc()" style="width:100%;" /></td>
                  <td><input type="number" id="tDvQ_${i}" value="${it.qty}" step="any" oninput="ToolsDocs.recalcDoc()" style="width:100%;" /></td>
                  <td><input type="number" id="tDvR_${i}" value="${it.rate}" step="any" oninput="ToolsDocs.recalcDoc()" style="width:100%;" /></td>
                  <td id="tDvA_${i}" style="text-align:right;padding-right:8px;">0.00</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
      <div class="process-controls" style="margin-top:10px;">
        <button class="process-btn start-btn" onclick="ToolsDocs.addItem()">➕ Add Item</button>
        <button class="process-btn clear-btn" onclick="ToolsDocs.removeItem()">🗑️ Remove Last</button>
      </div>

      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:12px;">
        ${fld('Currency symbol', `<input type="text" id="tDvCur" value="" style="width:100%;" oninput="ToolsDocs.recalcDoc()" />`)}
        ${fld('Tax %', `<input type="number" id="tDvTax" value="18" step="any" oninput="ToolsDocs.recalcDoc()" style="width:100%;" />`)}
        ${fld('Notes', `<input type="text" id="tDvNotes" placeholder="Payment terms, thank-you note" style="width:100%;" />`, 2)}
      </div>
      <div id="tDvTotals" style="margin-top:12px;"></div>
      <div class="process-controls" style="margin-top:12px;">
        <button class="process-btn start-btn" onclick="ToolsDocs.buildDocPdf()">⬇️ Download PDF</button>
      </div>
      <div id="tDvStatus" style="margin-top:8px;font-size:0.86rem;min-height:1.1em;"></div>`);
  }

  // Reads the picked image as both raw bytes (for pdf-lib to embed) and a
  // data URL (for the small on-page preview) - stored per docKind so
  // switching between Invoice/Quotation/Receipt doesn't mix logos up.
  function onLogoPick(file) {
    if (!file) return;
    const ext = /png/i.test(file.type) ? 'png' : 'jpg';
    const reader = new FileReader();
    reader.onload = function () {
      docLogos[docKind] = { bytes: new Uint8Array(reader.result), ext: ext, dataUrl: null };
      // Data URL for the preview thumbnail (separate quick read, cheap for
      // a small logo image).
      const reader2 = new FileReader();
      reader2.onload = function () {
        if (docLogos[docKind]) docLogos[docKind].dataUrl = String(reader2.result || '');
        if (window.FreeServices) FreeServices.open(docKind);
      };
      reader2.readAsDataURL(file);
    };
    reader.onerror = function () { say('tDvStatus', 'Could not read that image.', 'error'); };
    reader.readAsArrayBuffer(file);
  }

  function removeLogo() {
    delete docLogos[docKind];
    if (window.FreeServices) FreeServices.open(docKind);
  }

  function readItems() {
    docItems = docItems.map(function (_, i) {
      return {
        desc: val('tDvD_' + i),
        qty: parseFloat(val('tDvQ_' + i)) || 0,
        rate: parseFloat(val('tDvR_' + i)) || 0
      };
    });
    return docItems;
  }

  function recalcDoc() {
    const items = readItems();
    const cur = val('tDvCur') || '';
    const taxPct = parseFloat(val('tDvTax')) || 0;
    let subtotal = 0;
    items.forEach(function (it, i) {
      const amt = it.qty * it.rate;
      subtotal += amt;
      const cell = document.getElementById('tDvA_' + i);
      if (cell) cell.textContent = amt.toFixed(2);
    });
    const tax = subtotal * taxPct / 100;
    const fmt = (v) => cur + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const line = (l, v, b) => `<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid rgba(0,0,0,0.06);">
      <span style="color:#6b7280;">${l}</span><span style="${b ? 'font-weight:700;' : ''}">${v}</span></div>`;
    out('tDvTotals', line('Subtotal', fmt(subtotal)) + line(`Tax (${taxPct}%)`, fmt(tax)) + line('Total', fmt(subtotal + tax), true));
  }

  function addItem() {
    readItems();
    if (docItems.length >= 40) return say('tDvStatus', 'That is the maximum number of line items.', 'error');
    docItems.push({ desc: '', qty: 1, rate: 0 });
    if (window.FreeServices) FreeServices.open(docKind);
    setTimeout(recalcDoc, 0);
  }

  function removeItem() {
    readItems();
    if (docItems.length <= 1) return say('tDvStatus', 'At least one line item is needed.', 'error');
    docItems.pop();
    if (window.FreeServices) FreeServices.open(docKind);
    setTimeout(recalcDoc, 0);
  }

  async function buildDocPdf() {
    if (typeof PDFLib === 'undefined') return say('tDvStatus', 'pdf-lib failed to load - please refresh.', 'error');
    const k = DOC_KINDS[docKind];
    const items = readItems().filter(function (it) { return it.desc.trim() || it.qty || it.rate; });
    if (!items.length) return say('tDvStatus', 'Add at least one line item.', 'error');

    const cur = val('tDvCur') || '';
    const taxPct = parseFloat(val('tDvTax')) || 0;
    const subtotal = items.reduce(function (s, it) { return s + it.qty * it.rate; }, 0);
    const tax = subtotal * taxPct / 100;

    const doc = await PDFLib.PDFDocument.create();
    const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    const bold = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);
    const page = doc.addPage([595, 842]);
    const M = 45;
    let y = 842 - M;

    // The standard PDF fonts use WinAnsi, which has no rupee sign and no
    // most non-Latin characters - strip anything unencodable rather than
    // letting drawText throw halfway through building the document.
    const safe = (s) => String(s == null ? '' : s).replace(/[^\x20-\xFF]/g, '');
    const curSafe = safe(cur) || '';
    const text = (s, x, yy, size, f) => {
      try { page.drawText(safe(s), { x: x, y: yy, size: size || 10, font: f || font }); } catch (e) {}
    };
    const money = (v) => curSafe + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    text(k.heading, M, y, 22, bold); y -= 30;
    text(val('tDvFrom') || '', M, y, 12, bold); y -= 15;
    String(val('tDvFromAddr') || '').split('\n').forEach(function (l) { text(l, M, y, 9); y -= 12; });

    // Logo, top-right corner - scaled to fit within a fixed box so a huge
    // source image doesn't blow past the page margins or overlap the
    // invoice number/date block below it.
    const logo = docLogos[docKind];
    if (logo && logo.bytes) {
      try {
        const img = logo.ext === 'png' ? await doc.embedPng(logo.bytes) : await doc.embedJpg(logo.bytes);
        const maxW = 110, maxH = 55;
        const scale = Math.min(maxW / img.width, maxH / img.height, 1);
        const w = img.width * scale, h = img.height * scale;
        page.drawImage(img, { x: 595 - M - w, y: 842 - M - h, width: w, height: h });
      } catch (e) {
        // A bad/corrupt image shouldn't stop the whole PDF from building.
      }
    }

    let ry = 842 - M - 30;
    text(`${k.numLabel}: ${val('tDvNo')}`, 380, ry, 10); ry -= 14;
    text(`${k.dateLabel}: ${val('tDvDate')}`, 380, ry, 10);

    y -= 12;
    text('Bill To:', M, y, 10, bold); y -= 14;
    String(val('tDvTo') || '').split('\n').forEach(function (l) { text(l, M, y, 9); y -= 12; });

    y -= 14;
    page.drawRectangle({ x: M, y: y - 4, width: 595 - M * 2, height: 20, color: PDFLib.rgb(0.93, 0.95, 0.98) });
    text('Description', M + 4, y + 2, 10, bold);
    text('Qty', 350, y + 2, 10, bold);
    text('Rate', 410, y + 2, 10, bold);
    text('Amount', 490, y + 2, 10, bold);
    y -= 22;

    items.forEach(function (it) {
      if (y < 140) return;                       // keep room for the totals block
      text(it.desc.slice(0, 55), M + 4, y, 9);
      text(String(it.qty), 350, y, 9);
      text(money(it.rate), 410, y, 9);
      text(money(it.qty * it.rate), 490, y, 9);
      y -= 15;
    });

    y -= 10;
    text('Subtotal', 410, y, 10); text(money(subtotal), 490, y, 10); y -= 15;
    text(`Tax (${taxPct}%)`, 410, y, 10); text(money(tax), 490, y, 10); y -= 17;
    text('Total', 410, y, 12, bold); text(money(subtotal + tax), 490, y, 12, bold);

    const notes = val('tDvNotes');
    if (notes) { y -= 30; text('Notes: ' + notes, M, y, 9); }

    const bytes = await doc.save();
    download(new Blob([bytes], { type: 'application/pdf' }), `${k.heading.toLowerCase()}_${val('tDvNo') || '001'}.pdf`);
    say('tDvStatus', 'PDF downloaded.' + (curSafe !== cur ? ' (Currency symbol was dropped - the standard PDF font cannot render it.)' : ''), 'ok');
  }

  // ══════════════════════════════════════════════════════════════════
  // MAIL MERGE — EMAIL TEMPLATE / CREATE LETTERS
  // ══════════════════════════════════════════════════════════════════
  const MERGE_KINDS = {
    'email-template': { title: 'Email Template', icon: '📧', unit: 'email', hasSubject: true },
    'create-letters': { title: 'Create Letters', icon: '✉️', unit: 'letter', hasSubject: false }
  };
  let mergeKind = 'email-template';

  function renderMerge(kind) {
    mergeKind = kind;
    const k = MERGE_KINDS[kind];
    return card(k.icon, k.title, `
      <div class="setup-group">
        <label>Data (CSV - first row is the column names)</label>
        <textarea id="tMgData" rows="5" style="width:100%;font-family:monospace;font-size:12px;"
                  placeholder="name,company,amount&#10;Asha,Acme Ltd,5000&#10;Ravi,Globex,7200"></textarea>
      </div>
      ${k.hasSubject ? `<div class="setup-group" style="margin-top:10px;">
        <label>Subject</label>
        <input type="text" id="tMgSubject" placeholder="Invoice for {{company}}" style="width:100%;" />
      </div>` : ''}
      <div class="setup-group" style="margin-top:10px;">
        <label>Template - use {{column}} wherever a value should go</label>
        <textarea id="tMgTpl" rows="8" style="width:100%;font-family:monospace;font-size:12px;"
                  placeholder="Dear {{name}},&#10;&#10;Your outstanding balance with {{company}} is {{amount}}.&#10;&#10;Regards,&#10;Accounts Team"></textarea>
      </div>
      <div class="process-controls" style="margin-top:12px;">
        <button class="process-btn start-btn" onclick="ToolsDocs.runMerge()">👁️ Preview</button>
        <button class="process-btn clear-btn" onclick="ToolsDocs.downloadMerge('txt')">⬇️ Download .txt</button>
        <button class="process-btn clear-btn" onclick="ToolsDocs.downloadMerge('csv')">⬇️ Download .csv</button>
      </div>
      <div id="tMgStatus" style="margin-top:8px;font-size:0.86rem;min-height:1.1em;"></div>
      <div id="tMgOut" style="margin-top:12px;"></div>`,
      `Nothing is sent from here - this produces the finished ${k.unit} text for you to paste into your own mail tool.`);
  }

  // Minimal CSV parser: handles quoted fields, escaped quotes and commas
  // inside quotes. Written out rather than split(',') because a naive split
  // corrupts any row containing an address or an amount like "1,200".
  function parseCsv(text) {
    const rows = [];
    let row = [], cur = '', q = false;
    const src = String(text || '').replace(/\r\n?/g, '\n');
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (q) {
        if (c === '"') { if (src[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); });
  }

  function mergeRows() {
    const rows = parseCsv(val('tMgData'));
    if (rows.length < 2) throw new Error('Add a header row plus at least one data row.');
    const headers = rows[0].map(function (h) { return String(h).trim(); });
    return rows.slice(1).map(function (r) {
      const o = {};
      headers.forEach(function (h, i) { o[h] = (r[i] == null ? '' : String(r[i]).trim()); });
      return o;
    });
  }

  function applyTemplate(tpl, rowObj) {
    return String(tpl).replace(/\{\{\s*([^}]+?)\s*\}\}/g, function (_, key) {
      // Unknown placeholder -> leave it visible rather than silently blank,
      // so a typo'd column name is obvious in the preview.
      return Object.prototype.hasOwnProperty.call(rowObj, key) ? rowObj[key] : '{{' + key + '}}';
    });
  }

  function buildMerged() {
    const k = MERGE_KINDS[mergeKind];
    const rows = mergeRows();
    const tpl = val('tMgTpl');
    if (!tpl.trim()) throw new Error('Write a template first.');
    return rows.map(function (r) {
      return {
        subject: k.hasSubject ? applyTemplate(val('tMgSubject'), r) : '',
        body: applyTemplate(tpl, r),
        row: r
      };
    });
  }

  function runMerge() {
    try {
      const items = buildMerged();
      const k = MERGE_KINDS[mergeKind];
      say('tMgStatus', `${items.length} ${k.unit}(s) generated.`, 'ok');
      out('tMgOut', items.slice(0, 5).map(function (it, i) {
        return `<div style="border:1px solid rgba(0,0,139,0.12);border-radius:6px;padding:10px;margin-bottom:8px;">
          <div style="font-size:0.76rem;color:rgba(0,0,0,0.5);">#${i + 1}</div>
          ${it.subject ? `<div style="font-weight:600;margin:4px 0;">${esc(it.subject)}</div>` : ''}
          <pre style="white-space:pre-wrap;font-family:inherit;margin:0;font-size:0.88rem;">${esc(it.body)}</pre>
        </div>`;
      }).join('') + (items.length > 5 ? `<div style="font-size:0.8rem;color:rgba(0,0,0,0.5);">…and ${items.length - 5} more. Download to see them all.</div>` : ''));
    } catch (e) {
      say('tMgStatus', e.message, 'error');
      out('tMgOut', '');
    }
  }

  function downloadMerge(fmt) {
    try {
      const items = buildMerged();
      const k = MERGE_KINDS[mergeKind];
      if (fmt === 'csv') {
        const cell = (v) => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
        const head = (k.hasSubject ? ['Subject', 'Body'] : ['Body']).join(',');
        const body = items.map(function (it) {
          return (k.hasSubject ? [cell(it.subject), cell(it.body)] : [cell(it.body)]).join(',');
        }).join('\r\n');
        download(new Blob(['\uFEFF' + head + '\r\n' + body], { type: 'text/csv;charset=utf-8' }), `${mergeKind}.csv`);
      } else {
        const txt = items.map(function (it, i) {
          return `----- ${k.unit.toUpperCase()} ${i + 1} -----\n` +
            (it.subject ? `Subject: ${it.subject}\n\n` : '') + it.body;
        }).join('\n\n');
        download(new Blob([txt], { type: 'text/plain;charset=utf-8' }), `${mergeKind}.txt`);
      }
      say('tMgStatus', `Downloaded ${items.length} ${k.unit}(s).`, 'ok');
    } catch (e) { say('tMgStatus', e.message, 'error'); }
  }

  // ══════════════════════════════════════════════════════════════════
  // ETL  (pick / rename / reorder columns, then export)
  // ══════════════════════════════════════════════════════════════════
  let etlHeaders = [], etlRows = [];

  function renderEtl() {
    return card('🔀', 'ETL', `
      <div class="setup-group">
        <label>Source file (CSV or Excel)</label>
        <input type="file" id="tEtFile" accept=".csv,.xlsx,.xls" onchange="ToolsDocs.loadEtl(event)" style="width:100%;" />
      </div>
      <div id="tEtMap" style="margin-top:12px;">
        ${etlHeaders.length ? '' : '<div style="font-size:0.84rem;color:rgba(0,0,0,0.55);">Load a file to map its columns.</div>'}
      </div>
      <div id="tEtStatus" style="margin-top:8px;font-size:0.86rem;min-height:1.1em;"></div>`,
      'Choose which columns to keep, rename them, and export - useful for reshaping a file before importing it somewhere else.');
  }

  async function loadEtl(ev) {
    const f = ev.target.files && ev.target.files[0];
    if (!f) return;
    try {
      if (/\.(xlsx|xls)$/i.test(f.name)) {
        if (typeof XLSX === 'undefined') throw new Error('The spreadsheet library failed to load.');
        const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
        const grid = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
        etlHeaders = (grid[0] || []).map(String);
        etlRows = grid.slice(1);
      } else {
        const grid = parseCsv(await f.text());
        etlHeaders = (grid[0] || []).map(String);
        etlRows = grid.slice(1);
      }
      if (!etlHeaders.length) throw new Error('No columns found in that file.');
      renderEtlMap();
      say('tEtStatus', `Loaded ${etlRows.length} row(s), ${etlHeaders.length} column(s).`, 'ok');
    } catch (e) { say('tEtStatus', e.message, 'error'); }
  }

  function renderEtlMap() {
    out('tEtMap', `
      <label style="font-weight:600;">Columns</label>
      <div class="file-table-wrapper" style="margin-top:6px;">
        <table class="file-table">
          <colgroup><col style="width:10%;"><col style="width:45%;"><col style="width:45%;"></colgroup>
          <thead><tr><th>Keep</th><th>Source column</th><th>Rename to</th></tr></thead>
        </table>
        <div class="file-table-scroll" style="height:180px;max-height:180px;overflow-y:scroll;">
          <table class="file-table">
            <colgroup><col style="width:10%;"><col style="width:45%;"><col style="width:45%;"></colgroup>
            <tbody>
              ${etlHeaders.map(function (h, i) {
                return `<tr>
                  <td><input type="checkbox" class="file-select-checkbox" id="tEtK_${i}" checked /></td>
                  <td>${esc(h)}</td>
                  <td><input type="text" id="tEtN_${i}" value="${esc(h)}" style="width:100%;" /></td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
      <div class="process-controls" style="margin-top:12px;">
        <button class="process-btn start-btn" onclick="ToolsDocs.runEtl('csv')">⬇️ Export CSV</button>
        <button class="process-btn clear-btn" onclick="ToolsDocs.runEtl('xlsx')">⬇️ Export Excel</button>
        <button class="process-btn clear-btn" onclick="ToolsDocs.runEtl('json')">⬇️ Export JSON</button>
      </div>`);
  }

  function runEtl(fmt) {
    try {
      const keep = [];
      etlHeaders.forEach(function (h, i) {
        const k = document.getElementById('tEtK_' + i);
        if (k && k.checked) keep.push({ index: i, name: val('tEtN_' + i) || h });
      });
      if (!keep.length) throw new Error('Keep at least one column.');

      const heads = keep.map(function (k) { return k.name; });
      const body = etlRows.map(function (r) {
        return keep.map(function (k) { return r[k.index] == null ? '' : String(r[k.index]); });
      });

      if (fmt === 'json') {
        const objs = body.map(function (r) {
          const o = {}; heads.forEach(function (h, i) { o[h] = r[i]; }); return o;
        });
        download(new Blob([JSON.stringify(objs, null, 2)], { type: 'application/json' }), 'etl_output.json');
      } else if (fmt === 'xlsx') {
        if (typeof XLSX === 'undefined') throw new Error('The spreadsheet library failed to load.');
        const ws = XLSX.utils.aoa_to_sheet([heads].concat(body));
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Data');
        download(new Blob([XLSX.write(wb, { bookType: 'xlsx', type: 'array' })],
          { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'etl_output.xlsx');
      } else {
        const cell = (v) => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
        const lines = [heads.map(cell).join(',')].concat(body.map(function (r) { return r.map(cell).join(','); }));
        download(new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), 'etl_output.csv');
      }
      say('tEtStatus', `Exported ${body.length} row(s), ${heads.length} column(s).`, 'ok');
    } catch (e) { say('tEtStatus', e.message, 'error'); }
  }

  // ══════════════════════════════════════════════════════════════════
  // BMI CALCULATOR
  // ══════════════════════════════════════════════════════════════════
  function renderBmi() {
    setTimeout(runBmi, 0);
    return card('⚖️', 'BMI Calculator', `
      <div style="display:flex;gap:12px;flex-wrap:wrap;">
        ${fld('Height (cm)', `<input type="number" id="tBmiH" value="170" min="1" oninput="ToolsDocs.runBmi()" style="width:100%;" />`)}
        ${fld('Weight (kg)', `<input type="number" id="tBmiW" value="65" min="1" oninput="ToolsDocs.runBmi()" style="width:100%;" />`)}
      </div>
      <div id="tBmiOut" style="margin-top:14px;"></div>`);
  }

  function runBmi() {
    const h = parseFloat(val('tBmiH')) / 100;
    const w = parseFloat(val('tBmiW'));
    const box = document.getElementById('tBmiOut');
    if (!box || !h || !w) { if (box) box.innerHTML = ''; return; }
    const bmi = w / (h * h);
    let label = 'Normal', color = '#1b5e20';
    if (bmi < 18.5) { label = 'Underweight'; color = '#b8860b'; }
    else if (bmi >= 25 && bmi < 30) { label = 'Overweight'; color = '#b8860b'; }
    else if (bmi >= 30) { label = 'Obese'; color = '#b3261e'; }
    box.innerHTML = `<div style="font-size:1.6rem;font-weight:800;color:${color};">${bmi.toFixed(1)}</div>
      <div style="color:${color};font-weight:600;">${label}</div>`;
  }

  // ══════════════════════════════════════════════════════════════════
  // PERCENTAGE CALCULATOR
  // ══════════════════════════════════════════════════════════════════
  function renderPercentage() {
    setTimeout(runPercentage, 0);
    return card('💯', 'Percentage Calculator', `
      <div class="setup-group">
        <label>What is</label>
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
          <input type="number" id="tPcA" value="20" oninput="ToolsDocs.runPercentage()" style="width:100px;" />
          <span>% of</span>
          <input type="number" id="tPcB" value="500" oninput="ToolsDocs.runPercentage()" style="width:120px;" />
        </div>
      </div>
      <div id="tPcOut1" style="margin:10px 0;font-weight:700;"></div>
      <div class="setup-group" style="margin-top:14px;border-top:1px solid rgba(0,0,0,0.08);padding-top:14px;">
        <label>What percent is</label>
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
          <input type="number" id="tPcC" value="50" oninput="ToolsDocs.runPercentage()" style="width:120px;" />
          <span>of</span>
          <input type="number" id="tPcD" value="200" oninput="ToolsDocs.runPercentage()" style="width:120px;" />
        </div>
      </div>
      <div id="tPcOut2" style="margin-top:10px;font-weight:700;"></div>`);
  }

  function runPercentage() {
    const a = parseFloat(val('tPcA')), b = parseFloat(val('tPcB'));
    const c = parseFloat(val('tPcC')), d = parseFloat(val('tPcD'));
    out('tPcOut1', (!isNaN(a) && !isNaN(b)) ? `= ${(a * b / 100).toLocaleString(undefined, { maximumFractionDigits: 4 })}` : '');
    out('tPcOut2', (!isNaN(c) && !isNaN(d) && d !== 0) ? `= ${(c / d * 100).toLocaleString(undefined, { maximumFractionDigits: 4 })}%` : '');
  }

  // ══════════════════════════════════════════════════════════════════
  // DATE DIFFERENCE CALCULATOR
  // ══════════════════════════════════════════════════════════════════
  function renderDateDiff() {
    setTimeout(runDateDiff, 0);
    const today = new Date().toISOString().slice(0, 10);
    return card('📅', 'Date Difference Calculator', `
      <div style="display:flex;gap:12px;flex-wrap:wrap;">
        ${fld('From date', `<input type="date" id="tDdFrom" value="${today}" oninput="ToolsDocs.runDateDiff()" style="width:100%;" />`)}
        ${fld('To date', `<input type="date" id="tDdTo" value="${today}" oninput="ToolsDocs.runDateDiff()" style="width:100%;" />`)}
      </div>
      <div id="tDdOut" style="margin-top:14px;"></div>`);
  }

  function runDateDiff() {
    const from = new Date(val('tDdFrom'));
    const to = new Date(val('tDdTo'));
    const box = document.getElementById('tDdOut');
    if (!box || isNaN(from.getTime()) || isNaN(to.getTime())) { if (box) box.innerHTML = ''; return; }
    const ms = to - from;
    const days = Math.round(ms / 86400000);
    const absDays = Math.abs(days);
    const years = Math.floor(absDays / 365);
    const months = Math.floor((absDays % 365) / 30);
    const remDays = (absDays % 365) % 30;
    box.innerHTML = `<div style="font-size:1.4rem;font-weight:800;">${days} day(s)</div>
      <div style="color:#6b7280;margin-top:4px;">\u2248 ${years} year(s), ${months} month(s), ${remDays} day(s)</div>`;
  }

  // ══════════════════════════════════════════════════════════════════
  // DISCOUNT / GST CALCULATOR
  // ══════════════════════════════════════════════════════════════════
  function renderDiscountGst() {
    setTimeout(runDiscountGst, 0);
    return card('🏷️', 'Discount/GST Calculator', `
      <div style="display:flex;gap:12px;flex-wrap:wrap;">
        ${fld('Original price', `<input type="number" id="tDgPrice" value="1000" oninput="ToolsDocs.runDiscountGst()" style="width:100%;" />`)}
        ${fld('Discount %', `<input type="number" id="tDgDisc" value="10" oninput="ToolsDocs.runDiscountGst()" style="width:100%;" />`)}
        ${fld('GST %', `<input type="number" id="tDgGst" value="18" oninput="ToolsDocs.runDiscountGst()" style="width:100%;" />`)}
      </div>
      <div id="tDgOut" style="margin-top:14px;"></div>`);
  }

  function runDiscountGst() {
    const price = parseFloat(val('tDgPrice')) || 0;
    const discPct = parseFloat(val('tDgDisc')) || 0;
    const gstPct = parseFloat(val('tDgGst')) || 0;
    const disc = price * discPct / 100;
    const afterDisc = price - disc;
    const gst = afterDisc * gstPct / 100;
    const final = afterDisc + gst;
    const fmt = (v) => v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const line = (l, v, b) => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(0,0,0,0.06);">
      <span style="color:#6b7280;">${l}</span><span style="${b ? 'font-weight:700;' : ''}">${v}</span></div>`;
    out('tDgOut', line('Discount amount', fmt(disc)) + line('Price after discount', fmt(afterDisc)) +
      line(`GST (${gstPct}%)`, fmt(gst)) + line('Final price', fmt(final), true));
  }

  // ══════════════════════════════════════════════════════════════════
  // CHECK SPELLING & GRAMMAR
  // ══════════════════════════════════════════════════════════════════
  function renderGrammarCheck() {
    return card('✅', 'Check Spelling & Grammar', `
      <div class="setup-group">
        <label>Text to check</label>
        <textarea id="tGcIn" rows="8" style="width:100%;" placeholder="Paste or type your text here…"></textarea>
      </div>
      <div class="process-controls" style="margin-top:12px;">
        <button class="process-btn start-btn" onclick="ToolsDocs.runGrammarCheck()">Check</button>
      </div>
      <div id="tGcStatus" style="margin-top:8px;font-size:0.86rem;min-height:1.1em;"></div>
      <div id="tGcOut" style="margin-top:10px;"></div>
      <p style="font-size:0.76rem;color:rgba(0,0,0,0.45);margin-top:12px;">
        Uses the free LanguageTool public API - suitable for occasional checks, not bulk/automated use.
      </p>`);
  }

  async function runGrammarCheck() {
    const text = val('tGcIn').trim();
    const statusEl = document.getElementById('tGcStatus');
    const outEl = document.getElementById('tGcOut');
    if (!text) { say('tGcStatus', 'Enter some text first.', 'error'); return; }
    say('tGcStatus', 'Checking…', 'ok');
    outEl.innerHTML = '';
    try {
      const res = await fetch('https://api.languagetool.org/v2/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'text=' + encodeURIComponent(text) + '&language=en-US'
      });
      if (!res.ok) throw new Error('The grammar-check service is unavailable right now.');
      const data = await res.json();
      const matches = data.matches || [];
      if (!matches.length) {
        say('tGcStatus', 'No issues found. Looks good!', 'ok');
        return;
      }
      say('tGcStatus', `${matches.length} issue(s) found.`, 'error');
      outEl.innerHTML = matches.slice(0, 30).map(function (m) {
        const snippet = text.slice(Math.max(0, m.offset - 20), m.offset) +
          '<mark>' + text.slice(m.offset, m.offset + m.length) + '</mark>' +
          text.slice(m.offset + m.length, m.offset + m.length + 20);
        const suggestions = (m.replacements || []).slice(0, 3).map(function (r) { return esc(r.value); }).join(', ');
        return `<div style="padding:10px 0;border-bottom:1px solid rgba(0,0,0,0.06);">
          <div style="font-size:0.86rem;">${esc(m.message)}</div>
          <div style="font-size:0.8rem;color:#6b7280;margin-top:4px;font-family:monospace;">…${snippet}…</div>
          ${suggestions ? `<div style="font-size:0.8rem;color:#1257f5;margin-top:4px;">Suggestion(s): ${suggestions}</div>` : ''}
        </div>`;
      }).join('');
    } catch (e) {
      say('tGcStatus', e.message || 'Could not check that text.', 'error');
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // WORD COUNTER
  // ══════════════════════════════════════════════════════════════════
  function renderWordCount() {
    setTimeout(runWordCount, 0);
    return card('🔢', 'Word Counter', `
      <div class="setup-group">
        <label>Text</label>
        <textarea id="tWcText" rows="10" style="width:100%;" oninput="ToolsDocs.runWordCount()"
                  placeholder="Paste or type your text here…"></textarea>
      </div>
      <div id="tWcOut" style="margin-top:12px;"></div>`);
  }

  function runWordCount() {
    const t = val('tWcText');
    const words = t.trim() ? t.trim().split(/\s+/).length : 0;
    const sentences = t.trim() ? (t.match(/[^.!?]+[.!?]+/g) || [t]).length : 0;
    const paragraphs = t.trim() ? t.split(/\n\s*\n/).filter(function (p) { return p.trim(); }).length : 0;
    const line = (l, v) => `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(0,0,0,0.06);">
      <span style="color:#6b7280;">${l}</span><span style="font-weight:600;">${v}</span></div>`;
    out('tWcOut',
      line('Words', words.toLocaleString()) +
      line('Characters (with spaces)', t.length.toLocaleString()) +
      line('Characters (no spaces)', t.replace(/\s/g, '').length.toLocaleString()) +
      line('Sentences', sentences.toLocaleString()) +
      line('Paragraphs', paragraphs.toLocaleString()) +
      line('Reading time', `~${Math.max(1, Math.ceil(words / 200))} min`));
  }

  // ══════════════════════════════════════════════════════════════════
  // JSON ↔ CSV
  // ══════════════════════════════════════════════════════════════════
  // ══════════════════════════════════════════════════════════════════
  // JSON TO CSV
  // ══════════════════════════════════════════════════════════════════
  function renderJsonToCsv() {
    return card('🔄', 'JSON to CSV', `
      <div class="setup-group">
        <label>Upload a JSON file, or paste JSON below</label>
        <div style="margin-bottom:8px;">
          <button class="process-btn clear-btn" onclick="document.getElementById('tJ2cFile').click()">📁 Upload JSON file</button>
          <input type="file" id="tJ2cFile" accept=".json,application/json" style="display:none;" onchange="ToolsDocs.loadJsonFile(this.files[0])" />
        </div>
        <textarea id="tJ2cIn" rows="8" style="width:100%;font-family:monospace;font-size:12px;"
                  placeholder='Paste JSON (an object, or an array of objects)…'></textarea>
      </div>
      <div class="process-controls" style="margin-top:12px;">
        <button class="process-btn start-btn" onclick="ToolsDocs.convertJsonToCsv()">Convert to CSV</button>
      </div>
      <div id="tJ2cStatus" style="margin-top:8px;font-size:0.86rem;min-height:1.1em;"></div>
      <div class="setup-group" style="margin-top:10px;">
        <label>Output (CSV)</label>
        <textarea id="tJ2cOut" rows="8" style="width:100%;font-family:monospace;font-size:12px;" readonly></textarea>
      </div>
      <div class="process-controls" style="margin-top:10px;">
        <button class="process-btn clear-btn" onclick="ToolsDocs.downloadJsonToCsv()">⬇️ Download CSV</button>
      </div>`);
  }

  function loadJsonFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () {
      const el = document.getElementById('tJ2cIn');
      if (el) el.value = String(reader.result || '');
      say('tJ2cStatus', `Loaded "${file.name}" - click Convert to CSV.`, 'ok');
    };
    reader.onerror = function () { say('tJ2cStatus', 'Could not read that file.', 'error'); };
    reader.readAsText(file);
  }

  function convertJsonToCsv() {
    const input = val('tJ2cIn');
    const set = (v) => { const el = document.getElementById('tJ2cOut'); if (el) el.value = v; };
    try {
      let data = JSON.parse(input);
      // A single JSON object (not wrapped in an array) is a perfectly
      // reasonable thing to paste/upload - convert it to a one-row CSV
      // instead of rejecting it.
      if (data && typeof data === 'object' && !Array.isArray(data)) data = [data];
      if (!Array.isArray(data)) throw new Error('Expected a JSON object or an array of objects.');
      if (!data.length) throw new Error('That array is empty.');
      // Union of all keys, so rows with extra/missing fields still line up.
      const heads = [];
      data.forEach(function (o) {
        Object.keys(o || {}).forEach(function (k) { if (heads.indexOf(k) === -1) heads.push(k); });
      });
      const cell = (v) => {
        const s = v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      set([heads.join(',')].concat(data.map(function (o) {
        return heads.map(function (h) { return cell(o ? o[h] : ''); }).join(',');
      })).join('\n'));
      say('tJ2cStatus', `Converted ${data.length} record(s).`, 'ok');
    } catch (e) {
      set('');
      say('tJ2cStatus', e.message, 'error');
    }
  }

  function downloadJsonToCsv() {
    const text = val('tJ2cOut');
    if (!text) return say('tJ2cStatus', 'Convert something first.', 'error');
    download(new Blob([text], { type: 'text/csv;charset=utf-8' }), 'converted.csv');
  }

  // ══════════════════════════════════════════════════════════════════
  // CSV/EXCEL TO JSON
  // ══════════════════════════════════════════════════════════════════
  function renderCsvToJson() {
    return card('🔄', 'CSV/Excel to JSON', `
      <div class="setup-group">
        <label>Upload a CSV or Excel file, or paste CSV below</label>
        <div style="margin-bottom:8px;">
          <button class="process-btn clear-btn" onclick="document.getElementById('tC2jFile').click()">📁 Upload CSV/Excel file</button>
          <input type="file" id="tC2jFile" accept=".csv,.xlsx,.xls,text/csv" style="display:none;" onchange="ToolsDocs.loadCsvOrExcelFile(this.files[0])" />
        </div>
        <textarea id="tC2jIn" rows="8" style="width:100%;font-family:monospace;font-size:12px;"
                  placeholder='Paste CSV here, or upload a file above…'></textarea>
      </div>
      <div class="process-controls" style="margin-top:12px;">
        <button class="process-btn start-btn" onclick="ToolsDocs.convertCsvToJson()">Convert to JSON</button>
      </div>
      <div id="tC2jStatus" style="margin-top:8px;font-size:0.86rem;min-height:1.1em;"></div>
      <div class="setup-group" style="margin-top:10px;">
        <label>Output (JSON)</label>
        <textarea id="tC2jOut" rows="8" style="width:100%;font-family:monospace;font-size:12px;" readonly></textarea>
      </div>
      <div class="process-controls" style="margin-top:10px;">
        <button class="process-btn clear-btn" onclick="ToolsDocs.downloadCsvToJson()">⬇️ Download JSON</button>
      </div>`);
  }

  // Excel files are binary, so they can't go through the plain-text
  // textarea like CSV/JSON can - read them with SheetJS and convert the
  // first sheet straight to a CSV string, which then reuses the exact
  // same CSV-parsing path as a pasted/typed CSV.
  function loadCsvOrExcelFile(file) {
    if (!file) return;
    const isExcel = /\.xlsx?$/i.test(file.name);
    if (isExcel) {
      if (typeof XLSX === 'undefined') return say('tC2jStatus', 'Excel support failed to load - please refresh.', 'error');
      const reader = new FileReader();
      reader.onload = function () {
        try {
          const wb = XLSX.read(new Uint8Array(reader.result), { type: 'array' });
          const sheet = wb.Sheets[wb.SheetNames[0]];
          const csv = XLSX.utils.sheet_to_csv(sheet);
          const el = document.getElementById('tC2jIn');
          if (el) el.value = csv;
          say('tC2jStatus', `Loaded "${file.name}" (sheet: ${wb.SheetNames[0]}) - click Convert to JSON.`, 'ok');
        } catch (e) {
          say('tC2jStatus', 'Could not read that Excel file.', 'error');
        }
      };
      reader.onerror = function () { say('tC2jStatus', 'Could not read that file.', 'error'); };
      reader.readAsArrayBuffer(file);
    } else {
      const reader = new FileReader();
      reader.onload = function () {
        const el = document.getElementById('tC2jIn');
        if (el) el.value = String(reader.result || '');
        say('tC2jStatus', `Loaded "${file.name}" - click Convert to JSON.`, 'ok');
      };
      reader.onerror = function () { say('tC2jStatus', 'Could not read that file.', 'error'); };
      reader.readAsText(file);
    }
  }

  function convertCsvToJson() {
    const input = val('tC2jIn');
    const set = (v) => { const el = document.getElementById('tC2jOut'); if (el) el.value = v; };
    try {
      const rows = parseCsv(input);
      if (rows.length < 2) throw new Error('Need a header row plus at least one data row.');
      const heads = rows[0].map(function (h) { return String(h).trim(); });
      const objs = rows.slice(1).map(function (r) {
        const o = {}; heads.forEach(function (h, i) { o[h] = r[i] == null ? '' : r[i]; }); return o;
      });
      set(JSON.stringify(objs, null, 2));
      say('tC2jStatus', `Converted ${objs.length} row(s).`, 'ok');
    } catch (e) {
      set('');
      say('tC2jStatus', e.message, 'error');
    }
  }

  function downloadCsvToJson() {
    const text = val('tC2jOut');
    if (!text) return say('tC2jStatus', 'Convert something first.', 'error');
    download(new Blob([text], { type: 'application/json' }), 'converted.json');
  }


  // ══════════════════════════════════════════════════════════════════
  // QR CODE GENERATOR
  // ══════════════════════════════════════════════════════════════════
  // ══════════════════════════════════════════════════════════════════
  // BUSINESS NAME GENERATOR
  // ══════════════════════════════════════════════════════════════════
  const BIZ_PREFIXES = ['Prime', 'Nova', 'Apex', 'Bright', 'Blue', 'Silver', 'Golden', 'Swift', 'Peak', 'Urban', 'True', 'Vivid', 'Bold', 'Clear', 'North', 'Summit', 'Core', 'Pure', 'Rapid', 'Elevate'];
  const BIZ_SUFFIXES = ['Hub', 'Works', 'Labs', 'Group', 'Studio', 'Solutions', 'Collective', 'Co', 'Ventures', 'Partners', 'Network', 'House', 'Point', 'Craft', 'Forge'];

  function renderBusinessName() {
    setTimeout(runBusinessName, 0);
    return card('🏷️', 'Business Name Generator', `
      <div class="setup-group">
        <label>A word describing your business (industry, product, or theme)</label>
        <input type="text" id="tBnKeyword" value="Coffee" oninput="ToolsDocs.runBusinessName()" style="width:100%;" />
      </div>
      <div class="process-controls" style="margin-top:12px;">
        <button class="process-btn start-btn" onclick="ToolsDocs.runBusinessName()">🔄 Generate More</button>
      </div>
      <div id="tBnOut" style="margin-top:14px;display:flex;flex-wrap:wrap;gap:10px;"></div>
      <p style="font-size:0.76rem;color:rgba(0,0,0,0.45);margin-top:12px;">
        Ideas to get you started - always check trademark/domain availability before committing to one.
      </p>`);
  }

  function runBusinessName() {
    const keyword = (val('tBnKeyword') || '').trim();
    const box = document.getElementById('tBnOut');
    if (!box) return;
    if (!keyword) { box.innerHTML = '<div style="color:#b3261e;font-size:0.86rem;">Enter a keyword first.</div>'; return; }
    const cap = keyword.charAt(0).toUpperCase() + keyword.slice(1);
    const shuffle = function (arr) { return arr.slice().sort(function () { return Math.random() - 0.5; }); };
    const prefixes = shuffle(BIZ_PREFIXES).slice(0, 4);
    const suffixes = shuffle(BIZ_SUFFIXES).slice(0, 4);
    const names = [];
    prefixes.forEach(function (p) { names.push(`${p} ${cap}`); });
    suffixes.forEach(function (s) { names.push(`${cap} ${s}`); });
    names.push(`The ${cap} Co`);
    names.push(`${cap}ify`);
    box.innerHTML = names.map(function (n) {
      return `<span style="background:#eef2fb;border-radius:20px;padding:8px 16px;font-weight:600;color:#1257f5;">${esc(n)}</span>`;
    }).join('');
  }

  // ══════════════════════════════════════════════════════════════════
  // CERTIFICATE GENERATOR
  // ══════════════════════════════════════════════════════════════════
  function renderCertificate() {
    return card('🎓', 'Certificate Generator', `
      <div style="display:flex;gap:12px;flex-wrap:wrap;">
        ${fld('Recipient name', `<input type="text" id="tCertName" value="Jane Doe" style="width:100%;" />`)}
        ${fld('Awarded for / course', `<input type="text" id="tCertFor" value="Completing the Advanced Excel Workshop" style="width:100%;" />`)}
      </div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;">
        ${fld('Issued by', `<input type="text" id="tCertIssuer" value="Acme Training Institute" style="width:100%;" />`)}
        ${fld('Date', `<input type="date" id="tCertDate" value="${new Date().toISOString().slice(0, 10)}" style="width:100%;" />`)}
      </div>
      <div class="process-controls" style="margin-top:12px;">
        <button class="process-btn start-btn" onclick="ToolsDocs.buildCertificate()">⬇️ Download PDF</button>
      </div>
      <div id="tCertStatus" style="margin-top:8px;font-size:0.86rem;min-height:1.1em;"></div>`);
  }

  async function buildCertificate() {
    if (typeof PDFLib === 'undefined') return say('tCertStatus', 'pdf-lib failed to load - please refresh.', 'error');
    const name = val('tCertName') || 'Recipient Name';
    const forText = val('tCertFor') || '';
    const issuer = val('tCertIssuer') || '';
    const date = val('tCertDate') || '';

    const doc = await PDFLib.PDFDocument.create();
    const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    const bold = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);
    const italic = await doc.embedFont(PDFLib.StandardFonts.HelveticaOblique);
    const page = doc.addPage([842, 595]); // landscape A4-ish
    const safe = (s) => String(s == null ? '' : s).replace(/[^\x20-\xFF]/g, '');
    const centered = (text, y, size, f, color) => {
      const w = f.widthOfTextAtSize(safe(text), size);
      page.drawText(safe(text), { x: (842 - w) / 2, y: y, size: size, font: f, color: color || PDFLib.rgb(0.1, 0.1, 0.15) });
    };

    page.drawRectangle({ x: 20, y: 20, width: 802, height: 555, borderColor: PDFLib.rgb(0.07, 0.09, 0.2), borderWidth: 3 });
    page.drawRectangle({ x: 32, y: 32, width: 778, height: 531, borderColor: PDFLib.rgb(0.4, 0.5, 0.7), borderWidth: 1 });

    centered('CERTIFICATE OF ACHIEVEMENT', 470, 26, bold);
    centered('This certificate is proudly presented to', 400, 13, italic, PDFLib.rgb(0.35, 0.35, 0.4));
    centered(name, 340, 34, bold);
    centered('for', 300, 12, italic, PDFLib.rgb(0.35, 0.35, 0.4));
    centered(forText, 260, 15, font);
    if (issuer) centered(issuer, 130, 12, bold);
    if (date) centered(date, 105, 10, font, PDFLib.rgb(0.4, 0.4, 0.45));

    const bytes = await doc.save();
    download(new Blob([bytes], { type: 'application/pdf' }), `certificate_${(name || 'recipient').replace(/\s+/g, '_')}.pdf`);
    say('tCertStatus', 'PDF downloaded.', 'ok');
  }

  // ══════════════════════════════════════════════════════════════════
  // BUSINESS CARD MAKER
  // ══════════════════════════════════════════════════════════════════
  function renderBusinessCard() {
    return card('💳', 'Business Card Maker', `
      <div style="display:flex;gap:12px;flex-wrap:wrap;">
        ${fld('Full name', `<input type="text" id="tBcName" value="Jane Doe" style="width:100%;" />`)}
        ${fld('Job title', `<input type="text" id="tBcTitle" value="Founder" style="width:100%;" />`)}
      </div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;">
        ${fld('Company name', `<input type="text" id="tBcCompany" value="Acme Pvt Ltd" style="width:100%;" />`)}
        ${fld('Accent color', `<input type="color" id="tBcColor" value="#1257f5" style="width:100%;height:38px;" />`)}
      </div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;">
        ${fld('Phone', `<input type="text" id="tBcPhone" value="+91 98765 43210" style="width:100%;" />`)}
        ${fld('Email', `<input type="text" id="tBcEmail" value="jane@acme.com" style="width:100%;" />`)}
      </div>
      <div class="process-controls" style="margin-top:12px;">
        <button class="process-btn start-btn" onclick="ToolsDocs.buildBusinessCard()">⬇️ Download PDF</button>
      </div>
      <div id="tBcStatus" style="margin-top:8px;font-size:0.86rem;min-height:1.1em;"></div>
      <p style="font-size:0.76rem;color:rgba(0,0,0,0.45);margin-top:12px;">Standard card size (3.5 x 2 inch), one card per page.</p>`);
  }

  function hexToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '#1257f5') || [];
    const n = (h) => parseInt(h || '00', 16) / 255;
    return { r: n(m[1]), g: n(m[2]), b: n(m[3]) };
  }

  async function buildBusinessCard() {
    if (typeof PDFLib === 'undefined') return say('tBcStatus', 'pdf-lib failed to load - please refresh.', 'error');
    const name = val('tBcName') || '';
    const title = val('tBcTitle') || '';
    const company = val('tBcCompany') || '';
    const phone = val('tBcPhone') || '';
    const email = val('tBcEmail') || '';
    const accent = hexToRgb(val('tBcColor'));

    const doc = await PDFLib.PDFDocument.create();
    const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    const bold = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);
    // 3.5in x 2in at 72pt/inch = 252 x 144
    const page = doc.addPage([252, 144]);
    const safe = (s) => String(s == null ? '' : s).replace(/[^\x20-\xFF]/g, '');
    const color = PDFLib.rgb(accent.r, accent.g, accent.b);

    page.drawRectangle({ x: 0, y: 0, width: 252, height: 144, color: PDFLib.rgb(1, 1, 1) });
    page.drawRectangle({ x: 0, y: 0, width: 8, height: 144, color: color });
    page.drawText(safe(name), { x: 22, y: 100, size: 15, font: bold, color: PDFLib.rgb(0.1, 0.1, 0.15) });
    page.drawText(safe(title), { x: 22, y: 84, size: 9, font: font, color: color });
    page.drawText(safe(company), { x: 22, y: 68, size: 9, font: bold, color: PDFLib.rgb(0.3, 0.3, 0.35) });
    page.drawLine({ start: { x: 22, y: 56 }, end: { x: 230, y: 56 }, thickness: 0.5, color: PDFLib.rgb(0.85, 0.85, 0.85) });
    if (phone) page.drawText(safe(phone), { x: 22, y: 40, size: 8, font: font });
    if (email) page.drawText(safe(email), { x: 22, y: 26, size: 8, font: font });

    const bytes = await doc.save();
    download(new Blob([bytes], { type: 'application/pdf' }), `business_card_${(name || 'card').replace(/\s+/g, '_')}.pdf`);
    say('tBcStatus', 'PDF downloaded.', 'ok');
  }

  function renderQr() {
    setTimeout(runQr, 0);
    return card('🔳', 'QR Code Generator', `
      <div class="setup-group">
        <label>Content (text, URL, phone, wifi, anything)</label>
        <textarea id="tQrText" rows="3" style="width:100%;" oninput="ToolsDocs.runQr()"
                  placeholder="https://example.com">https://example.com</textarea>
      </div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;">
        ${fld('Size (px)', `<input type="number" id="tQrSize" value="300" min="80" max="1000" step="10" oninput="ToolsDocs.runQr()" style="width:100%;" />`)}
        ${fld('Error correction', `<select id="tQrEc" onchange="ToolsDocs.runQr()" style="width:100%;">
            <option value="L">L - smallest</option>
            <option value="M" selected>M - standard</option>
            <option value="Q">Q - tolerant</option>
            <option value="H">H - most tolerant (survives damage/logos)</option>
          </select>`)}
      </div>
      <div id="tQrBox" style="margin-top:14px;display:flex;justify-content:center;"></div>
      <div class="process-controls" style="margin-top:12px;">
        <button class="process-btn start-btn" onclick="ToolsDocs.downloadQr()">⬇️ Download PNG</button>
      </div>
      <div id="tQrStatus" style="margin-top:8px;font-size:0.86rem;min-height:1.1em;"></div>`);
  }

  function runQr() {
    const box = document.getElementById('tQrBox');
    if (!box) return;
    if (typeof QRCode === 'undefined') { box.innerHTML = '<span style="color:#b3261e;">QR library failed to load - please refresh.</span>'; return; }
    const text = val('tQrText');
    box.innerHTML = '';
    if (!text.trim()) { say('tQrStatus', 'Enter some content.', 'error'); return; }
    const size = Math.max(80, Math.min(1000, parseInt(val('tQrSize'), 10) || 300));
    const ecMap = { L: QRCode.CorrectLevel.L, M: QRCode.CorrectLevel.M, Q: QRCode.CorrectLevel.Q, H: QRCode.CorrectLevel.H };
    try {
      new QRCode(box, {
        text: text, width: size, height: size,
        correctLevel: ecMap[val('tQrEc')] || QRCode.CorrectLevel.M
      });
      say('tQrStatus', '', 'ok');
    } catch (e) {
      // The library throws when the content exceeds what the chosen error
      // correction level can encode - say so instead of showing nothing.
      say('tQrStatus', 'That content is too long for this error-correction level. Try level L or shorten the text.', 'error');
    }
  }

  function downloadQr() {
    const canvas = document.querySelector('#tQrBox canvas');
    const img = document.querySelector('#tQrBox img');
    if (canvas) {
      canvas.toBlob(function (b) { if (b) download(b, 'qr-code.png'); });
      return say('tQrStatus', 'Downloaded.', 'ok');
    }
    if (img && img.src) {
      // Some builds render an <img> with a data URL rather than a canvas.
      fetch(img.src).then(function (r) { return r.blob(); })
        .then(function (b) { download(b, 'qr-code.png'); say('tQrStatus', 'Downloaded.', 'ok'); })
        .catch(function () { say('tQrStatus', 'Could not export the image.', 'error'); });
      return;
    }
    say('tQrStatus', 'Generate a QR code first.', 'error');
  }

  // ══════════════════════════════════════════════════════════════════
  // BARCODE GENERATOR
  // ══════════════════════════════════════════════════════════════════
  const BARCODE_FORMATS = ['CODE128', 'CODE39', 'EAN13', 'EAN8', 'UPC', 'ITF14', 'MSI', 'pharmacode'];

  function renderBarcode() {
    setTimeout(runBarcode, 0);
    return card('▮', 'Barcode Generator', `
      <div style="display:flex;gap:12px;flex-wrap:wrap;">
        ${fld('Value', `<input type="text" id="tBcVal" value="LEXORA123" oninput="ToolsDocs.runBarcode()" style="width:100%;" />`, 2)}
        ${fld('Format', `<select id="tBcFmt" onchange="ToolsDocs.runBarcode()" style="width:100%;">
            ${BARCODE_FORMATS.map(function (f) { return `<option value="${f}">${f}</option>`; }).join('')}
          </select>`)}
      </div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;">
        ${fld('Bar width', `<input type="number" id="tBcW" value="2" min="1" max="6" oninput="ToolsDocs.runBarcode()" style="width:100%;" />`)}
        ${fld('Height', `<input type="number" id="tBcH" value="100" min="30" max="300" step="10" oninput="ToolsDocs.runBarcode()" style="width:100%;" />`)}
      </div>
      <div style="margin-top:14px;display:flex;justify-content:center;background:#fff;padding:10px;">
        <canvas id="tBcCanvas"></canvas>
      </div>
      <div class="process-controls" style="margin-top:12px;">
        <button class="process-btn start-btn" onclick="ToolsDocs.downloadBarcode()">⬇️ Download PNG</button>
      </div>
      <div id="tBcStatus" style="margin-top:8px;font-size:0.86rem;min-height:1.1em;"></div>`,
      'EAN/UPC formats only accept digits of a specific length - the status line will say if the value does not fit the chosen format.');
  }

  function runBarcode() {
    if (typeof JsBarcode === 'undefined') return say('tBcStatus', 'Barcode library failed to load - please refresh.', 'error');
    const canvas = document.getElementById('tBcCanvas');
    if (!canvas) return;
    const value = val('tBcVal');
    if (!value.trim()) return say('tBcStatus', 'Enter a value.', 'error');
    try {
      JsBarcode(canvas, value, {
        format: val('tBcFmt') || 'CODE128',
        width: Math.max(1, parseInt(val('tBcW'), 10) || 2),
        height: Math.max(30, parseInt(val('tBcH'), 10) || 100),
        displayValue: true,
        valid: function (ok) {
          if (!ok) say('tBcStatus', `"${value}" is not valid for ${val('tBcFmt')} - check the required length/character set.`, 'error');
          else say('tBcStatus', '', 'ok');
        }
      });
    } catch (e) {
      say('tBcStatus', `"${value}" is not valid for ${val('tBcFmt')}.`, 'error');
    }
  }

  function downloadBarcode() {
    const canvas = document.getElementById('tBcCanvas');
    if (!canvas || !canvas.width) return say('tBcStatus', 'Generate a barcode first.', 'error');
    canvas.toBlob(function (b) { if (b) { download(b, 'barcode.png'); say('tBcStatus', 'Downloaded.', 'ok'); } });
  }

  // ══════════════════════════════════════════════════════════════════
  // SIGNATURE MAKER
  // ══════════════════════════════════════════════════════════════════
  let sigDrawing = false, sigHasStrokes = false;

  function renderSignatureMaker() {
    setTimeout(function () { wireSignatureCanvas(); }, 0);
    return card('✍️', 'Signature Maker', `
      <div class="setup-group">
        <label>Draw your signature below</label>
        <canvas id="tSigCanvas" width="600" height="220"
                style="width:100%;max-width:600px;height:220px;border:1px dashed rgba(0,0,0,0.25);border-radius:8px;background:#fff;touch-action:none;cursor:crosshair;"></canvas>
      </div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:8px;">
        ${fld('Pen color', `<input type="color" id="tSigColor" value="#0b1533" style="width:100%;height:38px;" />`)}
        ${fld('Pen size', `<input type="range" id="tSigWidth" min="1" max="10" value="3" style="width:100%;" />`)}
      </div>
      <div class="process-controls" style="margin-top:12px;">
        <button class="process-btn clear-btn" onclick="ToolsDocs.clearSignature()">🗑️ Clear</button>
        <button class="process-btn start-btn" onclick="ToolsDocs.downloadSignature()">⬇️ Download PNG</button>
      </div>
      <div id="tSigStatus" style="margin-top:8px;font-size:0.86rem;min-height:1.1em;"></div>
      <p style="font-size:0.76rem;color:rgba(0,0,0,0.45);margin-top:10px;">
        Downloaded as a transparent PNG, so it drops cleanly onto documents without a white box around it.
      </p>`);
  }

  function wireSignatureCanvas() {
    const canvas = document.getElementById('tSigCanvas');
    if (!canvas || canvas.dataset.wired) return;
    canvas.dataset.wired = '1';
    const ctx2d = canvas.getContext('2d');

    const posFromEvent = function (ev) {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width, scaleY = canvas.height / rect.height;
      const point = ev.touches ? ev.touches[0] : ev;
      return { x: (point.clientX - rect.left) * scaleX, y: (point.clientY - rect.top) * scaleY };
    };
    const start = function (ev) {
      ev.preventDefault();
      sigDrawing = true;
      const p = posFromEvent(ev);
      ctx2d.beginPath();
      ctx2d.moveTo(p.x, p.y);
    };
    const move = function (ev) {
      if (!sigDrawing) return;
      ev.preventDefault();
      const p = posFromEvent(ev);
      ctx2d.strokeStyle = val('tSigColor') || '#0b1533';
      ctx2d.lineWidth = parseFloat(val('tSigWidth')) || 3;
      ctx2d.lineCap = 'round';
      ctx2d.lineJoin = 'round';
      ctx2d.lineTo(p.x, p.y);
      ctx2d.stroke();
      sigHasStrokes = true;
    };
    const end = function () { sigDrawing = false; };

    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', end);
  }

  function clearSignature() {
    const canvas = document.getElementById('tSigCanvas');
    if (!canvas) return;
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    sigHasStrokes = false;
    say('tSigStatus', '', 'ok');
  }

  function downloadSignature() {
    const canvas = document.getElementById('tSigCanvas');
    if (!canvas || !sigHasStrokes) return say('tSigStatus', 'Draw a signature first.', 'error');
    canvas.toBlob(function (blob) {
      if (!blob) return say('tSigStatus', 'Could not export the signature.', 'error');
      download(blob, 'signature.png');
      say('tSigStatus', 'Downloaded.', 'ok');
    }, 'image/png');
  }

  // ══════════════════════════════════════════════════════════════════
  // LOGO BUILDER
  // ══════════════════════════════════════════════════════════════════
  function renderLogoBuilder() {
    setTimeout(runLogoBuilder, 0);
    return card('🎯', 'Logo Builder', `
      <div style="display:flex;gap:12px;flex-wrap:wrap;">
        ${fld('Initials or short text', `<input type="text" id="tLbText" value="AB" maxlength="3" oninput="ToolsDocs.runLogoBuilder()" style="width:100%;" />`)}
        ${fld('Shape', `<select id="tLbShape" onchange="ToolsDocs.runLogoBuilder()" style="width:100%;">
            <option value="circle">Circle</option>
            <option value="square">Rounded square</option>
            <option value="hexagon">Hexagon</option>
          </select>`)}
      </div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;">
        ${fld('Background color', `<input type="color" id="tLbBg" value="#1257f5" oninput="ToolsDocs.runLogoBuilder()" style="width:100%;height:38px;" />`)}
        ${fld('Text color', `<input type="color" id="tLbFg" value="#ffffff" oninput="ToolsDocs.runLogoBuilder()" style="width:100%;height:38px;" />`)}
      </div>
      <div style="margin-top:14px;display:flex;justify-content:center;">
        <canvas id="tLbCanvas" width="300" height="300" style="width:200px;height:200px;"></canvas>
      </div>
      <div class="process-controls" style="margin-top:12px;justify-content:center;">
        <button class="process-btn start-btn" onclick="ToolsDocs.downloadLogo()">⬇️ Download PNG</button>
      </div>
      <div id="tLbStatus" style="margin-top:8px;font-size:0.86rem;min-height:1.1em;text-align:center;"></div>`);
  }

  function drawLogoShape(cctx, shape, size, color) {
    cctx.fillStyle = color;
    cctx.beginPath();
    if (shape === 'circle') {
      cctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    } else if (shape === 'hexagon') {
      const cx = size / 2, cy = size / 2, r = size / 2;
      for (let i = 0; i < 6; i++) {
        const angle = Math.PI / 3 * i - Math.PI / 2;
        const x = cx + r * Math.cos(angle), y = cy + r * Math.sin(angle);
        if (i === 0) cctx.moveTo(x, y); else cctx.lineTo(x, y);
      }
      cctx.closePath();
    } else {
      const r = size * 0.18;
      cctx.moveTo(r, 0);
      cctx.arcTo(size, 0, size, size, r);
      cctx.arcTo(size, size, 0, size, r);
      cctx.arcTo(0, size, 0, 0, r);
      cctx.arcTo(0, 0, size, 0, r);
      cctx.closePath();
    }
    cctx.fill();
  }

  function runLogoBuilder() {
    const canvas = document.getElementById('tLbCanvas');
    if (!canvas) return;
    const size = canvas.width;
    const cctx = canvas.getContext('2d');
    cctx.clearRect(0, 0, size, size);
    drawLogoShape(cctx, val('tLbShape') || 'circle', size, val('tLbBg') || '#1257f5');
    const text = (val('tLbText') || '').toUpperCase();
    if (text) {
      cctx.fillStyle = val('tLbFg') || '#ffffff';
      cctx.font = `bold ${Math.round(size * 0.36)}px Arial, sans-serif`;
      cctx.textAlign = 'center';
      cctx.textBaseline = 'middle';
      cctx.fillText(text, size / 2, size / 2 + size * 0.02);
    }
  }

  function downloadLogo() {
    const canvas = document.getElementById('tLbCanvas');
    if (!canvas) return;
    canvas.toBlob(function (blob) {
      download(blob, 'logo.png');
      say('tLbStatus', 'Downloaded.', 'ok');
    }, 'image/png');
  }

  // ══════════════════════════════════════════════════════════════════
  // CHECK IP ADDRESS
  // ══════════════════════════════════════════════════════════════════
  function renderCheckIp() {
    setTimeout(runCheckIp, 0);
    return card('🌐', 'Check IP Address', `
      <div id="tIpOut" style="min-height:2em;">Looking up your IP address\u2026</div>
      <div class="process-controls" style="margin-top:12px;">
        <button class="process-btn start-btn" onclick="ToolsDocs.runCheckIp()">\ud83d\udd04 Refresh</button>
      </div>`);
  }

  async function runCheckIp() {
    const box = document.getElementById('tIpOut');
    if (!box) return;
    box.textContent = 'Looking up your IP address\u2026';
    try {
      const res = await fetch('https://ipapi.co/json/');
      if (!res.ok) throw new Error('Lookup failed');
      const d = await res.json();
      box.innerHTML =
        resultRowIp('IP Address', d.ip) +
        resultRowIp('City', d.city) +
        resultRowIp('Region', d.region) +
        resultRowIp('Country', d.country_name) +
        resultRowIp('ISP', d.org) +
        resultRowIp('Timezone', d.timezone);
    } catch (e) {
      box.innerHTML = '<div style="color:#b3261e;font-size:0.86rem;">Could not look up your IP address. Please check your connection and try again.</div>';
    }
  }

  function resultRowIp(label, value) {
    return `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(0,0,0,0.06);">
      <span style="color:#6b7280;">${esc(label)}</span><span style="font-weight:600;">${esc(value || '-')}</span></div>`;
  }

  // ══════════════════════════════════════════════════════════════════
  // CHECK INTERNET SPEED
  // ══════════════════════════════════════════════════════════════════
  function renderSpeedTest() {
    return card('\u26a1', 'Check Internet Speed', `
      <div style="text-align:center;">
        <button class="process-btn start-btn" onclick="ToolsDocs.runSpeedTest()">\u25b6\ufe0f Start Test</button>
      </div>
      <div id="tStOut" style="margin-top:16px;"></div>
      <p style="font-size:0.76rem;color:rgba(0,0,0,0.45);margin-top:12px;text-align:center;">
        Uses Cloudflare's public speed-test endpoints. Results are an estimate and can vary with network conditions.
      </p>`);
  }

  async function runSpeedTest() {
    const box = document.getElementById('tStOut');
    if (!box) return;
    box.innerHTML = '<div style="text-align:center;color:#6b7280;">Testing latency\u2026</div>';
    try {
      // Latency: a handful of small no-store fetches, smallest round-trip wins.
      let bestPing = Infinity;
      for (let i = 0; i < 4; i++) {
        const t0 = performance.now();
        await fetch('https://speed.cloudflare.com/__down?bytes=1000', { cache: 'no-store' });
        bestPing = Math.min(bestPing, performance.now() - t0);
      }

      box.innerHTML = '<div style="text-align:center;color:#6b7280;">Testing download speed\u2026</div>';
      const dlBytes = 25 * 1000 * 1000;
      const t1 = performance.now();
      const dlRes = await fetch(`https://speed.cloudflare.com/__down?bytes=${dlBytes}`, { cache: 'no-store' });
      await dlRes.arrayBuffer();
      const dlSeconds = (performance.now() - t1) / 1000;
      const dlMbps = (dlBytes * 8 / 1000000) / dlSeconds;

      box.innerHTML = '<div style="text-align:center;color:#6b7280;">Testing upload speed\u2026</div>';
      const upBytes = 5 * 1000 * 1000;
      const upData = new Uint8Array(upBytes);
      const t2 = performance.now();
      await fetch('https://speed.cloudflare.com/__up', { method: 'POST', body: upData, cache: 'no-store' });
      const upSeconds = (performance.now() - t2) / 1000;
      const upMbps = (upBytes * 8 / 1000000) / upSeconds;

      box.innerHTML =
        resultRowIp('Ping', bestPing.toFixed(0) + ' ms') +
        resultRowIp('Download', dlMbps.toFixed(1) + ' Mbps') +
        resultRowIp('Upload', upMbps.toFixed(1) + ' Mbps');
    } catch (e) {
      box.innerHTML = '<div style="color:#b3261e;font-size:0.86rem;text-align:center;">Speed test failed - please check your connection and try again.</div>';
    }
  }

  // ── card registry ──────────────────────────────────────────────────
  const CARDS = {
    'invoice-generator':   { label: 'Invoice Generator',   icon: '🧾', desc: 'Build an invoice and download it as a PDF.',   render: function () { return renderDoc('invoice-generator'); } },
    'quotation-generator': { label: 'Quotation Generator', icon: '📋', desc: 'Build a quotation and download it as a PDF.',  render: function () { return renderDoc('quotation-generator'); } },
    'receipt-generator':   { label: 'Receipt Generator',   icon: '🧾', desc: 'Build a receipt and download it as a PDF.',    render: function () { return renderDoc('receipt-generator'); } },
    'etl':                 { label: 'ETL',                 icon: '🔀', desc: 'Pick, rename and re-export columns.',         render: renderEtl },
    'word-counter':        { label: 'Word Counter',        icon: '🔢', desc: 'Words, characters, sentences, reading time.', render: renderWordCount },
    'grammar-check':       { label: 'Check Spelling & Grammar', icon: '✅', desc: 'Find spelling and grammar issues in text.', render: renderGrammarCheck },
    'bmi-calculator':      { label: 'BMI Calculator',       icon: '⚖️', desc: 'Body mass index from height and weight.',     render: renderBmi },
    'percentage-calculator': { label: 'Percentage Calculator', icon: '💯', desc: 'What is X% of Y, and what % is X of Y.',  render: renderPercentage },
    'date-diff-calculator': { label: 'Date Difference Calculator', icon: '📅', desc: 'Days between two dates.',             render: renderDateDiff },
    'discount-gst-calculator': { label: 'Discount/GST Calculator', icon: '🏷️', desc: 'Discount and GST on a price.',       render: renderDiscountGst },
    'json-to-csv':         { label: 'JSON to CSV',         icon: '🔄', desc: 'Upload JSON, get a CSV file.',                render: renderJsonToCsv },
    'csv-to-json':         { label: 'CSV/Excel to JSON',   icon: '🔄', desc: 'Upload CSV or Excel, get JSON.',             render: renderCsvToJson },
    'qr-generator':        { label: 'QR Code Generator',   icon: '🔳', desc: 'Make a QR code from any text or link.',       render: renderQr },
    'barcode-generator':   { label: 'Barcode Generator',   icon: '▮',  desc: 'CODE128, EAN, UPC and more.',                 render: renderBarcode },
    'signature-maker':     { label: 'Signature Maker',     icon: '✍️', desc: 'Draw a signature, download as a transparent PNG.', render: renderSignatureMaker },
    'business-name-generator': { label: 'Business Name Generator', icon: '🏷️', desc: 'Generate name ideas from a keyword.', render: renderBusinessName },
    'certificate-generator': { label: 'Certificate Generator', icon: '🎓', desc: 'Build an achievement certificate PDF.',   render: renderCertificate },
    'business-card-maker': { label: 'Business Card Maker', icon: '💳', desc: 'Build a business card PDF.',                render: renderBusinessCard },
    'logo-builder':        { label: 'Logo Builder',        icon: '🎯', desc: 'Simple shape + initials logo, as a PNG.',  render: renderLogoBuilder },
    'check-ip':            { label: 'Check IP Address',    icon: '🌐', desc: 'Your public IP address and rough location.', render: renderCheckIp },
    'speed-test':          { label: 'Check Internet Speed', icon: '⚡', desc: 'Ping, download and upload speed.',         render: renderSpeedTest }
  };

  window.ToolsDocs = {
    cards: CARDS,
    recalcDoc: recalcDoc,
    addItem: addItem,
    removeItem: removeItem,
    onLogoPick: onLogoPick,
    removeLogo: removeLogo,
    buildDocPdf: buildDocPdf,
    runMerge: runMerge,
    downloadMerge: downloadMerge,
    loadEtl: loadEtl,
    runEtl: runEtl,
    runWordCount: runWordCount,
    runGrammarCheck: runGrammarCheck,
    runBmi: runBmi,
    runPercentage: runPercentage,
    runDateDiff: runDateDiff,
    runDiscountGst: runDiscountGst,
    loadJsonFile: loadJsonFile,
    convertJsonToCsv: convertJsonToCsv,
    downloadJsonToCsv: downloadJsonToCsv,
    loadCsvOrExcelFile: loadCsvOrExcelFile,
    convertCsvToJson: convertCsvToJson,
    downloadCsvToJson: downloadCsvToJson,
    runQr: runQr,
    downloadQr: downloadQr,
    runBarcode: runBarcode,
    clearSignature: clearSignature,
    downloadSignature: downloadSignature,
    runBusinessName: runBusinessName,
    buildCertificate: buildCertificate,
    buildBusinessCard: buildBusinessCard,
    runLogoBuilder: runLogoBuilder,
    downloadLogo: downloadLogo,
    runCheckIp: runCheckIp,
    runSpeedTest: runSpeedTest,
    downloadBarcode: downloadBarcode,
    parseCsv: parseCsv,
    applyTemplate: applyTemplate
  };
})();
