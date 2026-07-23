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
            return { header: String(f.header || ''), description: String(f.description || '') };
          });
          return STATE.fields;
        }
      }
    } catch (e) { /* corrupt/unavailable storage - fall through to defaults */ }
    STATE.fields = DEFAULT_FIELDS.map(function (f) { return { header: f.header, description: f.description }; });
    return STATE.fields;
  }

  function saveFields() {
    readFieldsFromDom();
    const bad = STATE.fields.filter(function (f) { return !f.header.trim(); });
    if (bad.length) return setStatus('Every field needs a header name.', 'error');
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(STATE.fields));
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
    STATE.fields.push({ header: '', description: '' });
    rerender();
  }

  function removeField(i) {
    readFieldsFromDom();
    STATE.fields.splice(i, 1);
    if (!STATE.fields.length) STATE.fields.push({ header: '', description: '' });
    rerender();
  }

  function resetFields() {
    STATE.fields = DEFAULT_FIELDS.map(function (f) { return { header: f.header, description: f.description }; });
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
  async function readPdfTextLocal(file) {
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const tc = await (await pdf.getPage(p)).getTextContent();
      pages.push(tc.items.map(function (it) { return it.str; }).join(' ').replace(/\s+/g, ' ').trim());
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

  function exportOutput() {
    if (!STATE.rows.length) return setStatus('Nothing to export yet - process some files first.', 'error');
    const fmt = (document.getElementById('deFormat') || {}).value || 'json';
    const { heads, body } = asMatrix();
    const stamp = new Date().toISOString().slice(0, 10);

    if (fmt === 'json') {
      const payload = STATE.rows.map(function (r) { return Object.assign({ File: r.file }, r.values); });
      download(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `extracted_data_${stamp}.json`);
    } else if (fmt === 'csv') {
      const lines = [heads.map(csvCell).join(',')].concat(body.map(function (row) { return row.map(csvCell).join(','); }));
      // BOM so Excel opens UTF-8 accented/non-Latin text correctly.
      download(new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), `extracted_data_${stamp}.csv`);
    } else if (fmt === 'excel') {
      if (typeof XLSX === 'undefined') return setStatus('The spreadsheet library failed to load - please refresh.', 'error');
      const ws = XLSX.utils.aoa_to_sheet([heads].concat(body));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Extracted Data');
      const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      download(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `extracted_data_${stamp}.xlsx`);
    } else if (fmt === 'word') {
      const table = `<table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse;font-family:Calibri,Arial,sans-serif;font-size:11pt;">
        <thead><tr>${heads.map(function (h) { return `<th style="background:#eee;text-align:left;">${esc(h)}</th>`; }).join('')}</tr></thead>
        <tbody>${body.map(function (row) {
          return `<tr>${row.map(function (c) { return `<td>${esc(c)}</td>`; }).join('')}</tr>`;
        }).join('')}</tbody></table>`;
      const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
        <head><meta charset="utf-8"><title>Extracted Data</title></head>
        <body><h2 style="font-family:Calibri,Arial,sans-serif;">Extracted Data</h2>${table}</body></html>`;
      download(new Blob(['\uFEFF' + html], { type: 'application/msword' }), `extracted_data_${stamp}.doc`);
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

    const ocrEl = document.getElementById('deOcr');
    const useOcr = ocrEl ? !!ocrEl.checked : false;
    const model = 'google/gemini-2.5-flash';

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
      log(`${label} > File Processing > ${entry.file.name}`, 'Info');
      rerender();
      try {
        const read = useOcr
          ? await readPdfTextOcr(entry.file, model, function (p, t) {
              log(`${label} > Page(${p}/${t}) > API Call(s) > JSON=1, IMAGE=0`, 'Success');
              rerender();
            })
          : await readPdfTextLocal(entry.file);

        const joined = read.pages.join('\n\n').trim();
        log(`${label} > Text Data = ${joined.length} character(s) from ${read.pages.length} page(s)`, 'Info');
        if (!joined) throw new Error('No readable text found. If this is a scanned PDF, enable With OCR.');

        const values = await extractFields(joined, fields, model);
        const filled = Object.keys(values).filter(function (k) { return values[k]; }).length;
        log(`${label} > Extract Data > API Call(s) > JSON=1, IMAGE=0`, 'Success');
        log(`${label} > Fields found = ${filled}/${fields.length}`, 'Info');

        STATE.rows.push({ file: entry.file.name, values: values });
        entry.status = 'Success';
      } catch (e) {
        entry.status = 'Failed';
        log(`${label} > Error > ${e.message || 'Extraction failed'}`, 'Failed');
      }
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
  function statusClass(s) {
    if (s === 'Success') return 'completed';
    if (s === 'Failed') return 'error';
    if (s === 'Processing') return 'processing';
    return 'pending';
  }

  function fieldsTable() {
    const fields = loadFields();
    return `
      <div style="overflow:auto;">
        <table class="admin-json-table" style="width:100%;">
          <thead><tr>
            <th style="width:44px;">#</th>
            <th style="width:34%;">Field Header</th>
            <th>Description (what this field means)</th>
            <th style="width:60px;"></th>
          </tr></thead>
          <tbody>
            ${fields.map(function (f, i) {
              return `<tr>
                <td>${i + 1}</td>
                <td><input type="text" id="deH_${i}" value="${esc(f.header)}" placeholder="e.g. Invoice No" style="width:100%;" /></td>
                <td><input type="text" id="deD_${i}" value="${esc(f.description)}" placeholder="Describe it so the extractor knows what to look for" style="width:100%;" /></td>
                <td><button class="filter-btn" style="padding:2px 8px;" onclick="DataExtraction.removeField(${i})">✕</button></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
        <button class="filter-btn" onclick="DataExtraction.addField()">➕ Add Field</button>
        <button class="filter-btn" onclick="DataExtraction.saveFields()">💾 Save</button>
        <button class="filter-btn" onclick="DataExtraction.resetFields()">↩️ Reset to defaults</button>
        <span style="font-size:0.78rem;color:rgba(0,0,0,0.5);">${fields.length}/${MAX_FIELDS} fields</span>
      </div>
      <div id="deStatus" style="margin-top:8px;font-size:0.86rem;min-height:1.1em;"></div>`;
  }

  function fileRows() {
    if (!STATE.files.length) {
      return `<tr><td colspan="5" style="text-align:center;color:rgba(0,0,0,0.45);">No files uploaded yet.</td></tr>`;
    }
    return STATE.files.map(function (f, i) {
      return `<tr>
        <td><input type="checkbox" ${f.selected !== false ? 'checked' : ''} ${STATE.running ? 'disabled' : ''}
                   onchange="DataExtraction.toggleSelect(${f.uid}, this.checked)" /></td>
        <td>${i + 1}</td>
        <td>${esc(f.file.name)}</td>
        <td>${(f.file.size / 1024).toFixed(0)} KB</td>
        <td><span class="activity-result ${statusClass(f.status)}">${esc(f.status)}</span></td>
      </tr>`;
    }).join('');
  }

  function resultsTable() {
    if (!STATE.rows.length) return '';
    const { heads, body } = asMatrix();
    return `
      <div class="content-section">
        <h3>📊 Extracted Data</h3>
        <div style="overflow:auto;max-height:360px;">
          <table class="admin-json-table" style="width:100%;">
            <thead><tr>${heads.map(function (h) { return `<th>${esc(h)}</th>`; }).join('')}</tr></thead>
            <tbody>${body.map(function (row) {
              return `<tr>${row.map(function (c) { return `<td>${esc(c) || '<span style="color:rgba(0,0,0,0.3);">—</span>'}</td>`; }).join('')}</tr>`;
            }).join('')}</tbody>
          </table>
        </div>
      </div>`;
  }

  function logRows() {
    if (!STATE.log.length) {
      return `<tr><td colspan="3" style="text-align:center;color:rgba(0,0,0,0.45);">No activity yet.</td></tr>`;
    }
    return STATE.log.map(function (e) {
      return `<tr><td>${esc(e.time)}</td><td>${esc(e.activity)}</td>
        <td><span class="activity-result ${statusClass(e.status)}">${esc(e.status)}</span></td></tr>`;
    }).join('');
  }

  function render() {
    return `
      <div class="content-section">
        <h3>🧾 Data Extraction</h3>
        <p style="color:#555;margin:-2px 0 0 0;font-size:0.9rem;">
          Define the fields you need, upload PDFs, and get one table with those fields pulled out of every document.
        </p>
      </div>

      <div class="content-section">
        <h3>⚙️ Fields to Extract</h3>
        ${fieldsTable()}
      </div>

      <div class="content-section">
        <h3>⚙️ Setup</h3>
        <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-end;">
          <div class="setup-group" style="flex:1;min-width:200px;">
            <label>Output Format</label>
            <select id="deFormat" style="width:100%;">
              <option value="json">JSON (.json)</option>
              <option value="excel">Excel (.xlsx)</option>
              <option value="csv">CSV (.csv)</option>
              <option value="word">Word (.doc)</option>
            </select>
          </div>
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:normal;padding-bottom:8px;"
                 title="Checked: each page is read by the vision model - works on scanned/photographed PDFs. Unchecked: faster local text read, for text-based PDFs only.">
            <input type="checkbox" id="deOcr" style="width:auto;margin:0;" ${STATE.running ? 'disabled' : ''} />
            <span>With OCR</span>
          </label>
        </div>
      </div>

      <div class="content-section">
        <h3>📤 Upload Files</h3>
        <input type="file" id="deInput" accept="application/pdf" multiple ${STATE.running ? 'disabled' : ''}
               onchange="DataExtraction.onPick(event)" />
        <div style="margin-top:14px;overflow:auto;">
          <table class="admin-json-table" style="width:100%;">
            <thead><tr><th style="width:36px;"></th><th style="width:44px;">#</th><th>File</th><th style="width:90px;">Size</th><th style="width:110px;">Status</th></tr></thead>
            <tbody>${fileRows()}</tbody>
          </table>
        </div>
        <div style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap;">
          <button class="filter-btn" ${STATE.running ? 'disabled' : ''} onclick="DataExtraction.start()">▶️ Start</button>
          <button class="filter-btn" ${STATE.running ? 'disabled' : ''} onclick="DataExtraction.exportOutput()">⬇️ Download Output</button>
          <button class="filter-btn" ${STATE.running ? 'disabled' : ''} onclick="DataExtraction.clearAll()">🗑️ Clear</button>
        </div>
      </div>

      ${resultsTable()}

      <div class="content-section">
        <h3>📋 Activity Log</h3>
        <div style="max-height:320px;overflow:auto;">
          <table class="admin-json-table" style="width:100%;">
            <thead><tr><th style="width:140px;">Date &amp; Time</th><th>Activity</th><th style="width:110px;">Status</th></tr></thead>
            <tbody>${logRows()}</tbody>
          </table>
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
    removeField: removeField,
    saveFields: saveFields,
    resetFields: resetFields,
    onPick: onPick,
    toggleSelect: toggleSelect,
    clearAll: clearAll,
    start: start,
    exportOutput: exportOutput
  };
})();
