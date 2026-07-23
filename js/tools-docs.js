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

  function renderDoc(kind) {
    docKind = kind;
    const k = DOC_KINDS[kind];
    const today = new Date().toISOString().slice(0, 10);
    return card(k.icon, k.title, `
      <div style="display:flex;gap:12px;flex-wrap:wrap;">
        ${fld('Your business name', `<input type="text" id="tDvFrom" placeholder="Acme Pvt Ltd" style="width:100%;" />`)}
        ${fld(k.numLabel, `<input type="text" id="tDvNo" value="001" style="width:100%;" />`)}
        ${fld(k.dateLabel, `<input type="date" id="tDvDate" value="${today}" style="width:100%;" />`)}
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
        ${fld('Currency symbol', `<input type="text" id="tDvCur" value="₹" style="width:100%;" oninput="ToolsDocs.recalcDoc()" />`)}
        ${fld('Tax %', `<input type="number" id="tDvTax" value="18" step="any" oninput="ToolsDocs.recalcDoc()" style="width:100%;" />`)}
        ${fld('Notes', `<input type="text" id="tDvNotes" placeholder="Payment terms, thank-you note" style="width:100%;" />`, 2)}
      </div>
      <div id="tDvTotals" style="margin-top:12px;"></div>
      <div class="process-controls" style="margin-top:12px;">
        <button class="process-btn start-btn" onclick="ToolsDocs.buildDocPdf()">⬇️ Download PDF</button>
      </div>
      <div id="tDvStatus" style="margin-top:8px;font-size:0.86rem;min-height:1.1em;"></div>`);
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
  function renderJsonCsv() {
    return card('🔄', 'JSON ↔ CSV', `
      <div class="setup-group">
        <label>Input</label>
        <textarea id="tJcIn" rows="8" style="width:100%;font-family:monospace;font-size:12px;"
                  placeholder='Paste JSON (array of objects) or CSV here…'></textarea>
      </div>
      <div class="process-controls" style="margin-top:12px;">
        <button class="process-btn start-btn" onclick="ToolsDocs.convert('j2c')">JSON → CSV</button>
        <button class="process-btn start-btn" onclick="ToolsDocs.convert('c2j')">CSV → JSON</button>
      </div>
      <div id="tJcStatus" style="margin-top:8px;font-size:0.86rem;min-height:1.1em;"></div>
      <div class="setup-group" style="margin-top:10px;">
        <label>Output</label>
        <textarea id="tJcOut" rows="8" style="width:100%;font-family:monospace;font-size:12px;" readonly></textarea>
      </div>
      <div class="process-controls" style="margin-top:10px;">
        <button class="process-btn clear-btn" onclick="ToolsDocs.downloadConverted()">⬇️ Download</button>
      </div>`);
  }

  let convertedAs = 'csv';

  function convert(dir) {
    const input = val('tJcIn');
    const set = (v) => { const el = document.getElementById('tJcOut'); if (el) el.value = v; };
    try {
      if (dir === 'j2c') {
        const data = JSON.parse(input);
        if (!Array.isArray(data)) throw new Error('Expected a JSON array of objects.');
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
        convertedAs = 'csv';
        say('tJcStatus', `Converted ${data.length} record(s).`, 'ok');
      } else {
        const rows = parseCsv(input);
        if (rows.length < 2) throw new Error('Need a header row plus at least one data row.');
        const heads = rows[0].map(function (h) { return String(h).trim(); });
        const objs = rows.slice(1).map(function (r) {
          const o = {}; heads.forEach(function (h, i) { o[h] = r[i] == null ? '' : r[i]; }); return o;
        });
        set(JSON.stringify(objs, null, 2));
        convertedAs = 'json';
        say('tJcStatus', `Converted ${objs.length} row(s).`, 'ok');
      }
    } catch (e) {
      set('');
      say('tJcStatus', e.message, 'error');
    }
  }

  function downloadConverted() {
    const text = val('tJcOut');
    if (!text) return say('tJcStatus', 'Convert something first.', 'error');
    download(new Blob([text], { type: convertedAs === 'json' ? 'application/json' : 'text/csv;charset=utf-8' }),
      'converted.' + convertedAs);
  }


  // ══════════════════════════════════════════════════════════════════
  // QR CODE GENERATOR
  // ══════════════════════════════════════════════════════════════════
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

  // ── card registry ──────────────────────────────────────────────────
  const CARDS = {
    'invoice-generator':   { label: 'Invoice Generator',   icon: '🧾', desc: 'Build an invoice and download it as a PDF.',   render: function () { return renderDoc('invoice-generator'); } },
    'quotation-generator': { label: 'Quotation Generator', icon: '📋', desc: 'Build a quotation and download it as a PDF.',  render: function () { return renderDoc('quotation-generator'); } },
    'receipt-generator':   { label: 'Receipt Generator',   icon: '🧾', desc: 'Build a receipt and download it as a PDF.',    render: function () { return renderDoc('receipt-generator'); } },
    'email-template':      { label: 'Email Template',      icon: '📧', desc: 'Mail-merge a template with CSV data.',        render: function () { return renderMerge('email-template'); } },
    'create-letters':      { label: 'Create Letters',      icon: '✉️', desc: 'Generate letters from a template plus data.',  render: function () { return renderMerge('create-letters'); } },
    'etl':                 { label: 'ETL',                 icon: '🔀', desc: 'Pick, rename and re-export columns.',         render: renderEtl },
    'word-counter':        { label: 'Word Counter',        icon: '🔢', desc: 'Words, characters, sentences, reading time.', render: renderWordCount },
    'json-csv':            { label: 'JSON ↔ CSV',          icon: '🔄', desc: 'Convert between JSON and CSV.',               render: renderJsonCsv },
    'qr-generator':        { label: 'QR Code Generator',   icon: '🔳', desc: 'Make a QR code from any text or link.',       render: renderQr },
    'barcode-generator':   { label: 'Barcode Generator',   icon: '▮',  desc: 'CODE128, EAN, UPC and more.',                 render: renderBarcode }
  };

  window.ToolsDocs = {
    cards: CARDS,
    recalcDoc: recalcDoc,
    addItem: addItem,
    removeItem: removeItem,
    buildDocPdf: buildDocPdf,
    runMerge: runMerge,
    downloadMerge: downloadMerge,
    loadEtl: loadEtl,
    runEtl: runEtl,
    runWordCount: runWordCount,
    convert: convert,
    downloadConverted: downloadConverted,
    runQr: runQr,
    downloadQr: downloadQr,
    runBarcode: runBarcode,
    downloadBarcode: downloadBarcode,
    parseCsv: parseCsv,
    applyTemplate: applyTemplate
  };
})();
