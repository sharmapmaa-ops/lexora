/* data-extraction.js — Lexora "Data Extraction" service.
 *
 * The user defines up to 30 fields (a header + a description of what it
 * means), then processes PDFs. Each PDF is read, the defined fields are
 * pulled out by the model, and the results come back as ONE table:
 *   rows    = files processed
 *   columns = the fields the user defined
 * exportable as JSON / Excel / CSV / Word.
 *
 * Reading a PDF follows the same rule as Translation:
 *   - "With OCR" off -> local pdf.js text-layer read (no per-page API call)
 *   - "With OCR" on  -> each page is sent to the vision model
 * Field extraction itself is one model call per file, on the assembled text.
 *
 * Field definitions are saved in localStorage per user, so they survive a
 * page reload without needing a server round-trip or a schema change.
 */
(function () {
  'use strict';

  const MAX_FIELDS = 30;
  const LS_KEY = 'lexora_extraction_fields';

  // Sensible starting point so the table isn't empty on first visit - all of
  // these are editable/removable.
  const DEFAULT_FIELDS = [
    { header: 'Invoice No', description: 'The invoice or document reference number' },
    { header: 'Invoice Date', description: 'The date the document was issued' },
    { header: 'Vendor Name', description: 'The company or person issuing the document' },
    { header: 'Total Amount', description: 'The final total payable, including tax' }
  ];

  // Loaded by the "Default" button - the fields an invoice normally
  // carries. Anything not present in a given document simply comes back
  // empty, so an over-complete list costs nothing but a blank column.
  const INVOICE_FIELDS = [
    { header: 'Invoice No', description: 'The invoice or document reference number' },
    { header: 'Invoice Date', description: 'The date the invoice was issued' },
    { header: 'Due Date', description: 'The date payment is due' },
    { header: 'PO Number', description: 'Purchase order number this invoice relates to' },
    { header: 'Vendor Name', description: 'The company or person issuing the invoice' },
    { header: 'Vendor Address', description: 'Full address of the issuing company' },
    { header: 'Vendor Tax ID', description: 'Vendor GST / VAT / tax registration number' },
    { header: 'Bill To Name', description: 'The customer the invoice is addressed to' },
    { header: 'Bill To Address', description: 'Billing address of the customer' },
    { header: 'Customer Tax ID', description: 'Customer GST / VAT / tax registration number' },
    { header: 'Currency', description: 'Currency of the amounts, e.g. INR, USD, EUR' },
    { header: 'Subtotal', description: 'Total before tax and discounts' },
    { header: 'Discount', description: 'Any discount applied' },
    { header: 'Tax Amount', description: 'Total tax charged (GST/VAT/sales tax)' },
    { header: 'Total Amount', description: 'The final total payable, including tax' },
    { header: 'Amount in Words', description: 'The total written out in words, if shown' },
    { header: 'Payment Terms', description: 'Payment terms, e.g. Net 30, Due on receipt' },
    { header: 'Bank Details', description: 'Bank account / IFSC / IBAN details for payment' }
  ];

  const STATE = {
    fields: null,        // loaded lazily
    rows: [],            // extracted results, one per processed file
    running: false,
    files: [],
    nextId: 1,
    log: []
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── field definitions (load / save) ────────────────────────────────
  function loadFields() {
    if (STATE.fields) return STATE.fields;
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length) {
          STATE.fields = parsed.slice(0, MAX_FIELDS).map(function (f) {
            return { header: String(f.header || ''), description: String(f.description || ''), checked: false };
          });
          return STATE.fields;
        }
      }
    } catch (e) { /* corrupt/unavailable storage - fall through to defaults */ }
    STATE.fields = DEFAULT_FIELDS.map(function (f) { return { header: f.header, description: f.description, checked: false }; });
    return STATE.fields;
  }

  function saveFields() {
    readFieldsFromDom();
    const bad = STATE.fields.filter(function (f) { return !f.header.trim(); });
    if (bad.length) return setStatus('Every field needs a header name.', 'error');
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(STATE.fields.map(function (f) {
        return { header: f.header, description: f.description };
      })));
      setStatus(`Saved ${STATE.fields.length} field(s).`, 'ok');
    } catch (e) {
      setStatus('Could not save - your browser blocked local storage.', 'error');
    }
  }

  // The table inputs are the source of truth while the user is typing, so
  // pull their current values before any save/add/remove/process.
  function readFieldsFromDom() {
    const fields = loadFields();
    fields.forEach(function (f, i) {
      const h = document.getElementById('deH_' + i);
      const d = document.getElementById('deD_' + i);
      if (h) f.header = h.value;
      if (d) f.description = d.value;
    });
  }

  function addField() {
    readFieldsFromDom();
    if (STATE.fields.length >= MAX_FIELDS) {
      return setStatus(`You can define at most ${MAX_FIELDS} fields.`, 'error');
    }
    STATE.fields.push({ header: '', description: '', checked: false });
    rerender();
  }

  function toggleField(i, checked) {
    readFieldsFromDom();
    if (STATE.fields[i]) STATE.fields[i].checked = !!checked;
    rerender();
  }

  function toggleAllFields(checked) {
    readFieldsFromDom();
    STATE.fields.forEach(function (f) { f.checked = !!checked; });
    rerender();
  }

  // Deletes every ticked row at once (the table has a checkbox per line
  // rather than a delete button per line).
  function deleteChecked() {
    readFieldsFromDom();
    const keep = STATE.fields.filter(function (f) { return f.checked === false; });
    if (keep.length === STATE.fields.length) return setStatus('Tick the row(s) you want to delete first.', 'error');
    STATE.fields = keep;
    if (!STATE.fields.length) STATE.fields.push({ header: '', description: '', checked: false });
    rerender();
    setStatus('Deleted the selected field(s) (not saved yet).', 'ok');
  }

  function loadInvoiceDefaults() {
    STATE.fields = INVOICE_FIELDS.slice(0, MAX_FIELDS).map(function (f) {
      return { header: f.header, description: f.description, checked: false };
    });
    rerender();
    setStatus(`Loaded ${STATE.fields.length} standard invoice field(s) - press Save to keep them.`, 'ok');
  }

  function resetFields() {
    STATE.fields = DEFAULT_FIELDS.map(function (f) { return { header: f.header, description: f.description, checked: false }; });
    rerender();
    setStatus('Reset to the default fields (not saved yet).', 'ok');
  }

  function setStatus(msg, kind) {
    const el = document.getElementById('deStatus');
    if (!el) return;
    el.style.color = kind === 'error' ? '#b3261e' : (kind === 'ok' ? '#1b5e20' : '#2c5777');
    el.textContent = msg || '';
  }

  function log(activity, status) {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    STATE.log.unshift({
      time: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`,
      activity: activity, status: status || 'Info'
    });
  }

  // ── PDF reading ────────────────────────────────────────────────────
  async function readPdfTextLocal(file, onPage) {
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const tc = await (await pdf.getPage(p)).getTextContent();
      pages.push(tc.items.map(function (it) { return it.str; }).join(' ').replace(/\s+/g, ' ').trim());
      if (onPage) onPage(p, pdf.numPages);
    }
    return { pages: pages, apiCalls: 0 };
  }

  async function readPdfTextOcr(file, model, onPage) {
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    const images = await window.lexoraPdfToImages(pdf);
    const pages = [];
    let apiCalls = 0;
    for (let i = 0; i < images.length; i++) {
      const data = await window.lexoraProxyJson({
        model: model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Transcribe ALL readable text in this page image, exactly as written, preserving reading order and line breaks. Return the transcription only - no commentary, no formatting markers.' },
            { type: 'image_url', image_url: { url: images[i].dataUrl } }
          ]
        }]
      });
      apiCalls++;
      const msg = data.choices && data.choices[0] && data.choices[0].message;
      pages.push((msg && msg.content ? String(msg.content) : '').trim());
      if (onPage) onPage(i + 1, images.length);
    }
    return { pages: pages, apiCalls: apiCalls };
  }

  // ── field extraction ───────────────────────────────────────────────
  function buildExtractionPrompt(fields) {
    const list = fields.map(function (f, i) {
      return `${i + 1}. "${f.header}"${f.description ? ' — ' + f.description : ''}`;
    }).join('\n');

    return `You are a precise document data-extraction engine.

You will be given the full text of one document. Extract ONLY the fields listed below.

FIELDS TO EXTRACT:
${list}

RULES
- Return the value EXACTLY as it appears in the document. Do not reformat dates, do not convert currencies or units, do not recalculate anything, do not translate.
- If a field genuinely does not appear in the document, return an empty string "" for it. Never guess, never invent a plausible-looking value, and never carry a value over from a different field.
- If a field appears more than once with the same meaning, use the most complete/primary occurrence.
- Keep values short and literal - the value only, without its surrounding label text.

Return ONLY this JSON shape, nothing else:
{
  "fields": {
${fields.map(function (f) { return `    ${JSON.stringify(f.header)}: "..."`; }).join(',\n')}
  }
}`;
  }

  async function extractFields(text, fields, model) {
    const data = await window.lexoraProxyJson({
      model: model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'user', content: buildExtractionPrompt(fields) + '\n\nDOCUMENT TEXT:\n' + text }
      ]
    });
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    let raw = (msg && msg.content ? String(msg.content) : '').trim();
    raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '');
    const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
    if (a !== -1 && b > a) raw = raw.slice(a, b + 1);
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) { throw new Error('The model did not return valid JSON for this document.'); }
    const out = {};
    const got = (parsed && parsed.fields) || {};
    fields.forEach(function (f) {
      const v = got[f.header];
      out[f.header] = (v == null) ? '' : String(v);
    });
    return out;
  }

  // ── outputs ────────────────────────────────────────────────────────
  function headersList() { return STATE.fields.map(function (f) { return f.header; }); }

  function asMatrix() {
    const heads = ['File'].concat(headersList());
    const body = STATE.rows.map(function (r) {
      return [r.file].concat(headersList().map(function (h) { return r.values[h] || ''; }));
    });
    return { heads: heads, body: body };
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function csvCell(v) {
    const s = String(v == null ? '' : v);
    // Quote when the value contains a delimiter, quote or newline; double up
    // inner quotes. Without this a value like "Acme, Inc." would silently
    // split into two columns.
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // Download one processed file's row in the chosen Output Format - same
  // idea as Translation's per-file Download link.
  function downloadFile(uid) {
    const entry = STATE.files.find(function (f) { return f.uid === uid; });
    if (!entry) return;
    const row = STATE.rows.find(function (r) { return r.file === entry.file.name; });
    if (!row) return setStatus('That file has no extracted data yet.', 'error');
    exportRows([row], entry.file.name.replace(/\.[^.]+$/, ''));
  }

  function exportOutput() {
    if (!STATE.rows.length) return setStatus('Nothing to export yet - process some files first.', 'error');
    exportRows(STATE.rows, 'extracted_data_' + new Date().toISOString().slice(0, 10));
  }

  function exportRows(rows, stem) {
    const fmt = (document.getElementById('deFormat') || {}).value || 'json';
    const heads = ['File'].concat(headersList());
    const body = rows.map(function (r) {
      return [r.file].concat(headersList().map(function (h) { return r.values[h] || ''; }));
    });

    if (fmt === 'json') {
      const payload = rows.map(function (r) { return Object.assign({ File: r.file }, r.values); });
      download(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `${stem}.json`);
    } else if (fmt === 'csv') {
      const lines = [heads.map(csvCell).join(',')].concat(body.map(function (row) { return row.map(csvCell).join(','); }));
      // BOM so Excel opens UTF-8 accented/non-Latin text correctly.
      download(new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), `${stem}.csv`);
    } else if (fmt === 'excel') {
      if (typeof XLSX === 'undefined') return setStatus('The spreadsheet library failed to load - please refresh.', 'error');
      const ws = XLSX.utils.aoa_to_sheet([heads].concat(body));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Extracted Data');
      const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      download(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${stem}.xlsx`);
    } else if (fmt === 'word') {
      const table = `<table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse;font-family:Calibri,Arial,sans-serif;font-size:11pt;">
        <thead><tr>${heads.map(function (h) { return `<th style="background:#eee;text-align:left;">${esc(h)}</th>`; }).join('')}</tr></thead>
        <tbody>${body.map(function (row) {
          return `<tr>${row.map(function (c) { return `<td>${esc(c)}</td>`; }).join('')}</tr>`;
        }).join('')}</tbody></table>`;
      const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
        <head><meta charset="utf-8"><title>Extracted Data</title></head>
        <body><h2 style="font-family:Calibri,Arial,sans-serif;">Extracted Data</h2>${table}</body></html>`;
      download(new Blob(['\uFEFF' + html], { type: 'application/msword' }), `${stem}.doc`);
    }
    setStatus('Output downloaded.', 'ok');
  }

  // ── processing ─────────────────────────────────────────────────────
  async function start() {
    if (STATE.running) return;
    readFieldsFromDom();
    const fields = STATE.fields.filter(function (f) { return f.header.trim(); });
    if (!fields.length) return setStatus('Define at least one field before processing.', 'error');

    const selected = STATE.files.filter(function (f) { return f.selected !== false; });
    if (!selected.length) return setStatus('Select at least one file to process.', 'error');

    const billing = window.LexoraBilling;
    if (!billing) return setStatus('Billing is unavailable right now - please reload the page.', 'error');

    const ocrEl = document.getElementById('deOcr');
    const useOcr = ocrEl ? !!ocrEl.checked : false;
    const model = 'google/gemini-2.5-flash';

    // ── wallet check (same shape as Translation) ──────────────────
    // Page counts aren't known until each PDF is opened, so this is a
    // minimum: at least one page per selected file. Real billing happens
    // per page below.
    const perPageRate = billing.perPageRate();
    const minNeeded = perPageRate * selected.length;
    const balance = billing.balance();
    log(`System > Checking Wallet Balance > $${minNeeded.toFixed(2)} required for ${selected.length} file(s) (${billing.planName()} plan: Data Extraction $${perPageRate}/Per Page)`, 'Info');
    if (minNeeded > 0 && balance < minNeeded) {
      log(`System > Process Aborted > Insufficient balance - you have $${balance.toFixed(2)}, but $${minNeeded.toFixed(2)} is required`, 'Failed');
      rerender();
      return setStatus(`Insufficient balance. You have $${balance.toFixed(2)} but at least $${minNeeded.toFixed(2)} is needed.`, 'error');
    }

    STATE.running = true;
    STATE.rows = [];
    setStatus('');
    if (window.setVisionAuthToken) window.setVisionAuthToken(window.__lexoraAuthToken || '');
    log(`System > ${useOcr ? 'With OCR' : 'Without OCR'} + ${fields.length} field(s)`, 'Success');
    rerender();

    for (let i = 0; i < selected.length; i++) {
      const entry = selected[i];
      const label = `File(${i + 1}/${selected.length})`;
      entry.status = 'Processing';
      entry.progress = 5;
      log(`${label} > File Processing > ${entry.file.name}`, 'Info');
      rerender();

      let fileCharged = 0, fileJson = 0, fileImage = 0;
      try {
        // Charging happens per page AS each page is read, so if a later
        // page fails the user keeps what completed and only pays for that.
        const chargePage = function (pageNo, total, jsonCalls) {
          fileJson += jsonCalls;
          billing.charge(
            `Data Extraction - ${entry.file.name} - page ${pageNo}/${total}`,
            perPageRate
          );
          fileCharged += perPageRate;
          log(`${label} > Page(${pageNo}/${total}) > API Call(s) > JSON=${jsonCalls}, IMAGE=0`, 'Success');
          log(`${label} > Page(${pageNo}/${total}) > Amount Deducted from Wallet=$${perPageRate.toFixed(2)}`, 'Info');
          entry.pageCount = total;
          entry.progress = Math.round((pageNo / total) * 80);
          rerender();
        };

        const read = useOcr
          ? await readPdfTextOcr(entry.file, model, function (p, t) { chargePage(p, t, 1); })
          : await readPdfTextLocal(entry.file, function (p, t) { chargePage(p, t, 0); });

        const joined = read.pages.join('\n\n').trim();
        log(`${label} > Text Data = ${joined.length} character(s) from ${read.pages.length} page(s)`, 'Info');
        if (!joined) throw new Error('No readable text found. If this is a scanned PDF, enable With OCR.');

        const values = await extractFields(joined, fields, model);
        fileJson += 1;
        const filled = Object.keys(values).filter(function (k) { return values[k]; }).length;
        log(`${label} > Extract Data > API Call(s) > JSON=1, IMAGE=0`, 'Success');
        log(`${label} > Extract Data > Fields found = ${filled}/${fields.length}`, 'Info');

        STATE.rows.push({ file: entry.file.name, values: values });
        entry.status = 'Success';
        entry.progress = 100;
      } catch (e) {
        entry.status = 'Failed';
        entry.error = e.message || 'Extraction failed';
        log(`${label} > Error > ${entry.error}`, 'Failed');
      }

      log(`${label} > Page(All) > API Call(s) > JSON=${fileJson}, IMAGE=${fileImage}`, 'Info');
      log(`${label} > Page(All) > Amount Deducted from Wallet=$${fileCharged.toFixed(2)}`, 'Info');
      rerender();
    }

    STATE.running = false;
    log(`Generate Output > ${STATE.rows.length} row(s) ready - choose a format and click Download`, 'Success');
    rerender();
  }

  // ── file list ──────────────────────────────────────────────────────
  function onPick(ev) {
    const picked = Array.from((ev.target && ev.target.files) || []);
    picked.forEach(function (f) {
      STATE.files.push({ uid: STATE.nextId++, file: f, selected: true, status: 'Pending' });
    });
    rerender();
  }

  function toggleSelect(uid, checked) {
    const f = STATE.files.find(function (x) { return x.uid === uid; });
    if (f) f.selected = !!checked;
  }

  function clearAll() {
    STATE.files = []; STATE.log = []; STATE.rows = []; STATE.nextId = 1;
    rerender();
  }

  // ── rendering ──────────────────────────────────────────────────────
  // Mirrors Translation's estimate line: only shows when something is
  // selected, and gives both the plan rate and the total for the selection.
  function fieldsTable() {
    const fields = loadFields();
    return `
      <div class="file-table-wrapper">
        <table class="file-table">
          <colgroup><col style="width:6%;"><col style="width:6%;"><col style="width:32%;"><col style="width:56%;"></colgroup>
          <thead><tr>
            <th><input type="checkbox" id="deFieldAll" ${(fields.length && fields.every(function (f) { return f.checked !== false; })) ? 'checked' : ''}
                       onchange="DataExtraction.toggleAllFields(this.checked)" title="Select all" /></th>
            <th>#</th><th>Field Header</th><th>Description (what this field means)</th>
          </tr></thead>
        </table>
        <div class="file-table-scroll" style="height:180px;max-height:180px;overflow-y:scroll;">
          <table class="file-table">
            <colgroup><col style="width:6%;"><col style="width:6%;"><col style="width:32%;"><col style="width:56%;"></colgroup>
            <tbody>
              ${fields.map(function (f, i) {
                return `<tr>
                  <td><input type="checkbox" class="file-select-checkbox" ${f.checked !== false ? 'checked' : ''}
                             onchange="DataExtraction.toggleField(${i}, this.checked)" /></td>
                  <td>${i + 1}</td>
                  <td><input type="text" id="deH_${i}" value="${esc(f.header)}" placeholder="e.g. Invoice No" style="width:100%;" /></td>
                  <td><input type="text" id="deD_${i}" value="${esc(f.description)}" placeholder="Describe it so the extractor knows what to look for" style="width:100%;" /></td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
      <div class="process-controls" style="margin-top:12px;">
        <button class="process-btn start-btn" onclick="DataExtraction.addField()">➕ Add</button>
        <button class="process-btn clear-btn" onclick="DataExtraction.deleteChecked()">🗑️ Delete</button>
        <button class="process-btn clear-btn" onclick="DataExtraction.saveFields()">💾 Save</button>
        <button class="process-btn clear-btn" onclick="DataExtraction.loadInvoiceDefaults()">📄 Default</button>
        <span style="font-size:0.78rem;color:rgba(0,0,0,0.5);align-self:center;margin-left:6px;">${fields.length}/${MAX_FIELDS} fields</span>
      </div>
      <div id="deStatus" style="margin-top:8px;font-size:0.86rem;min-height:1.1em;"></div>`;
  }

  function chargeEstimateHtml() {
    const b = window.LexoraBilling;
    if (!b) return '';
    const sel = STATE.files.filter(function (f) { return f.selected !== false; });
    if (!sel.length) return '';
    const rate = b.perPageRate();
    const total = sel.reduce(function (sum, f) { return sum + rate * Math.max(1, f.pageCount || 1); }, 0);
    return `💰 Rate: $${rate.toFixed(2)}/page · Est. total: $${total.toFixed(2)} for ${sel.length} selected file(s)`;
  }

  function toggleAll(checked) {
    STATE.files.forEach(function (f) { f.selected = !!checked; });
    rerender();
  }

  function statusClass(s) {
    if (s === 'Success') return 'completed';
    if (s === 'Failed') return 'error';
    if (s === 'Processing') return 'processing';
    return 'pending';
  }

  function fileRows() {
    if (!STATE.files.length) {
      return '<tr><td colspan="6" style="text-align:center;padding:15px;color:rgba(0,0,0,0.3);">No files uploaded yet.</td></tr>';
    }
    return STATE.files.map(function (f) {
      const cls = statusClass(f.status);
      const pct = f.progress != null ? f.progress : (f.status === 'Success' ? 100 : 0);
      const action = f.status === 'Success'
        ? `<a class="file-action-link" onclick="DataExtraction.downloadFile(${f.uid})">Download</a>`
        : (f.status === 'Failed'
            ? `<span class="file-action-link error-link" title="${esc(f.error || 'Failed')}">Error</span>`
            : `<span class="file-action-link disabled">${esc(f.status || 'Pending')}</span>`);
      return `<tr>
        <td><input type="checkbox" class="file-select-checkbox" ${f.selected !== false ? 'checked' : ''}
                   ${STATE.running ? 'disabled' : ''} onchange="DataExtraction.toggleSelect(${f.uid}, this.checked)" /></td>
        <td class="file-name"><span class="file-name-link">${esc(f.file.name)}</span></td>
        <td>${f.pageCount || '-'}</td>
        <td><span class="scan-result-text ${cls}">${esc(f.status || 'Pending')}</span></td>
        <td>
          <div class="progress-bar-container">
            <div class="progress-bar-track"><div class="progress-bar-fill ${cls}" style="width:${pct}%;"></div></div>
            <span class="progress-label">${pct}%</span>
          </div>
        </td>
        <td>${action}</td>
      </tr>`;
    }).join('');
  }

  function resultsTable() {
    if (!STATE.rows.length) return '';
    const m = asMatrix();
    return `
      <div class="file-list-card">
        <div class="file-list-card-header"><h3>📊 Extracted Data</h3></div>
        <div class="card-body">
          <div class="file-table-wrapper">
            <div class="file-table-scroll" style="max-height:320px;">
              <table class="file-table">
                <thead><tr>${m.heads.map(function (h) { return `<th>${esc(h)}</th>`; }).join('')}</tr></thead>
                <tbody>${m.body.map(function (row) {
                  return `<tr>${row.map(function (c) {
                    return `<td>${esc(c) || '<span style="color:rgba(0,0,0,0.3);">—</span>'}</td>`;
                  }).join('')}</tr>`;
                }).join('')}</tbody>
              </table>
            </div>
          </div>
        </div>
      </div>`;
  }

  function logRows() {
    if (!STATE.log.length) {
      return '<tr><td colspan="3" style="text-align:center;padding:15px;color:rgba(0,0,0,0.3);">No activities recorded.</td></tr>';
    }
    return STATE.log.map(function (e) {
      return `<tr><td>${esc(e.time)}</td><td>${esc(e.activity)}</td>
        <td><span class="activity-result ${statusClass(e.status)}">${esc(e.status)}</span></td></tr>`;
    }).join('');
  }

  // Same card/class structure as buildServiceUploadHTML() in app.js so this
  // page looks identical to Translation, plus one extra card above the
  // Activity Log for the field definitions.
  function render() {
    const countText = STATE.files.length ? `${STATE.files.length} file(s) uploaded` : 'No files uploaded yet';
    return `
      <div>
        <div class="service-upload-layout">
          <div class="service-card">
            <h3>📤 Upload File(s)</h3>
            <div class="card-body">
              <div class="drop-zone" onclick="${STATE.running ? 'void(0)' : "document.getElementById('deInput').click()"}"
                   style="${STATE.running ? 'opacity:0.5;pointer-events:none;' : ''}">
                <div class="drop-icon">📤</div>
                <div class="drop-text">Drag &amp; drop files here</div>
                <div class="drop-sub">or click to browse (PDF only)</div>
                <div class="file-count-text">${countText}</div>
              </div>
              <input type="file" id="deInput" multiple style="display:none;" accept=".pdf"
                     onchange="DataExtraction.onPick(event)" />
            </div>
          </div>

          <div class="service-card">
            <h3>⚙️ Setup</h3>
            <div class="card-body">
              <div class="setup-group">
                <div style="display:flex;gap:12px;align-items:flex-start;">
                  <div style="flex:1;">
                    <label>Output Format</label>
                    <select id="deFormat" style="width:100%;" ${STATE.running ? 'disabled' : ''}>
                      <option value="json">JSON (.json)</option>
                      <option value="excel">Excel (.xlsx)</option>
                      <option value="csv">CSV (.csv)</option>
                      <option value="word">Word (.doc)</option>
                    </select>
                  </div>
                </div>
                <div style="display:flex;align-items:center;gap:20px;margin-top:10px;">
                  <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:normal;"
                         title="Checked (With OCR): each page is read by the vision model - works on scanned/photographed PDFs. Unchecked: faster local text read, for text-based PDFs only.">
                    <input type="checkbox" id="deOcr" style="width:auto;margin:0;" ${STATE.running ? 'disabled' : ''} />
                    <span>With OCR</span>
                  </label>
                </div>
              </div>
              <div class="setup-group" style="margin-top:8px;">
                <div class="process-controls">
                  <button class="process-btn start-btn" ${STATE.running || !STATE.files.length ? 'disabled' : ''}
                          onclick="DataExtraction.start()">▶️ Start</button>
                  <button class="process-btn clear-btn" ${STATE.running ? 'disabled' : ''}
                          onclick="DataExtraction.clearAll()">🗑️ Clear Files</button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="file-list-card">
          <div class="file-list-card-header">
            <h3>📁 Uploaded Files</h3>
            <span class="file-list-charge-estimate" id="deChargeEstimate">${chargeEstimateHtml()}</span>
          </div>
          <div class="card-body">
            <div class="file-table-wrapper">
              <table class="file-table file-table-files">
                <colgroup><col style="width:5%;"><col style="width:33%;"><col style="width:10%;"><col style="width:16%;"><col style="width:16%;"><col style="width:20%;"></colgroup>
                <thead><tr>
                  <th><input type="checkbox" ${(STATE.files.length > 0 && STATE.files.every(function (f) { return f.selected !== false; })) ? 'checked' : ''}
                             ${STATE.running ? 'disabled' : ''} onchange="DataExtraction.toggleAll(this.checked)" title="Select all" /></th>
                  <th>File Name</th><th>Pages</th><th>Scan Result</th><th>Progress</th><th>Action</th>
                </tr></thead>
              </table>
              <div class="file-table-scroll">
                <table class="file-table file-table-files">
                  <colgroup><col style="width:5%;"><col style="width:33%;"><col style="width:10%;"><col style="width:16%;"><col style="width:16%;"><col style="width:20%;"></colgroup>
                  <tbody>${fileRows()}</tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        ${resultsTable()}

        <div class="file-list-card" style="height:auto;">
          <div class="file-list-card-header">
            <h3>🧾 Fields to Extract</h3>
          </div>
          <div class="card-body">
            ${fieldsTable()}
          </div>
        </div>

        <div class="activity-log-section">
          <div class="activity-log-card">
            <div class="log-header"><h3>📋 Activity Log</h3></div>
            <div class="card-body">
              <div class="file-table-wrapper">
                <table class="file-table file-table-activity">
                  <colgroup><col style="width:20%;"><col style="width:62%;"><col style="width:18%;"></colgroup>
                  <thead><tr><th>Date &amp; Time</th><th>Activity</th><th>Status</th></tr></thead>
                </table>
                <div class="file-table-scroll">
                  <table class="file-table file-table-activity">
                    <colgroup><col style="width:20%;"><col style="width:62%;"><col style="width:18%;"></colgroup>
                    <tbody>${logRows()}</tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>`;
  }

  function rerender() {
    const host = document.getElementById('contentBody');
    if (!host || !document.getElementById('deInput')) return;
    host.innerHTML = render();
  }

  window.DataExtraction = {
    render: render,
    addField: addField,
    toggleField: toggleField,
    toggleAllFields: toggleAllFields,
    deleteChecked: deleteChecked,
    saveFields: saveFields,
    resetFields: resetFields,
    loadInvoiceDefaults: loadInvoiceDefaults,
    onPick: onPick,
    toggleSelect: toggleSelect,
    toggleAll: toggleAll,
    clearAll: clearAll,
    start: start,
    exportOutput: exportOutput,
    downloadFile: downloadFile
  };
})();
