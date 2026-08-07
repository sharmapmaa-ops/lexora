/* bai2.js — Lexora "BAI2" service (PAID).
 *
 * Reads a bank statement (PDF or scanned image), pulls out the account
 * details and transactions, and writes them in BAI2 - the fixed cash-
 * management format banks and treasury systems exchange - as well as plain
 * CSV/JSON for anything that can't read BAI2.
 *
 * Billing mirrors Translation and Data Extraction: one flat charge per
 * finished file when the plan bills per document (the current default),
 * or per-page if the plan is ever configured that way - always through
 * window.LexoraBilling, and only once the whole file has succeeded.
 */
(function () {
  'use strict';

  function MODEL() {
    return (window.COMPANY_INFO && window.COMPANY_INFO.textExtractionModel) || 'google/gemini-2.5-flash';
  }

  const STATE = {
    files: [], nextId: 1, running: false, log: [],
    results: []          // { file, account, transactions[] }
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function log(activity, status) {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    STATE.log.unshift({
      time: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`,
      activity: activity, status: status || 'Info'
    });
  }

  function setStatus(msg, kind) {
    const el = document.getElementById('baiStatus');
    if (!el) return;
    el.style.color = kind === 'error' ? '#b3261e' : (kind === 'ok' ? '#1b5e20' : '#2c5777');
    el.textContent = msg || '';
  }

  function download(blob, name) {
    if (window.standaloneSmartDownload) {
      window.standaloneSmartDownload('bai2', blob, name);
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    setStatus('Downloaded.', 'ok');
  }

  // ── reading the statement ──────────────────────────────────────────
  async function pagesFromFile(file, useOcr, onPage) {
    // An image has no text layer at all, so it always goes to the model.
    const isImage = /^image\//.test(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name);
    if (isImage) {
      const dataUrl = await new Promise(function (res, rej) {
        const r = new FileReader();
        r.onload = function () { res(r.result); };
        r.onerror = function () { rej(new Error('That image could not be read.')); };
        r.readAsDataURL(file);
      });
      const text = await transcribe(dataUrl);
      if (onPage) onPage(1, 1, 1);
      return [text];
    }

    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages = [];
    if (useOcr) {
      const images = await window.lexoraPdfToImages(pdf);
      for (let i = 0; i < images.length; i++) {
        pages.push(await transcribe(images[i].dataUrl));
        if (onPage) onPage(i + 1, images.length, 1);
      }
    } else {
      for (let p = 1; p <= pdf.numPages; p++) {
        const tc = await (await pdf.getPage(p)).getTextContent();
        pages.push(tc.items.map(function (it) { return it.str; }).join(' ').replace(/\s+/g, ' ').trim());
        if (onPage) onPage(p, pdf.numPages, 0);
      }
    }
    return pages;
  }

  async function transcribe(dataUrl) {
    const prompt = window.getAiPrompt ? window.getAiPrompt('BAI2', 2) : null;
    if (!prompt) throw new Error('AI Prompt for BAI2 (prompt #2) is not configured - add it in Admin > AI Prompts, or run migration first.');
    const data = await window.lexoraProxyJson({
      model: MODEL(),
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }]
    });
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    return (msg && msg.content ? String(msg.content) : '').trim();
  }

  // ── extracting structured transactions ─────────────────────────────
  function extractionPrompt() {
    const prompt = window.getAiPrompt ? window.getAiPrompt('BAI2', 1) : null;
    if (!prompt) throw new Error('AI Prompt for BAI2 (prompt #1) is not configured - add it in Admin > AI Prompts, or run migration first.');
    return prompt;
  }

  async function extract(text) {
    const data = await window.lexoraProxyJson({
      model: MODEL(),
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: extractionPrompt() + '\n\nSTATEMENT TEXT:\n' + text }]
    });
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    let raw = (msg && msg.content ? String(msg.content) : '').trim();
    raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '');
    const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
    if (a !== -1 && b > a) raw = raw.slice(a, b + 1);
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) { throw new Error('The model did not return valid JSON for this statement.'); }

    const txns = Array.isArray(parsed.transactions) ? parsed.transactions : [];
    return {
      account_number: String(parsed.account_number || ''),
      account_name: String(parsed.account_name || ''),
      bank_name: String(parsed.bank_name || ''),
      currency: String(parsed.currency || ''),
      statement_start: String(parsed.statement_start || ''),
      statement_end: String(parsed.statement_end || ''),
      opening_balance: String(parsed.opening_balance || ''),
      closing_balance: String(parsed.closing_balance || ''),
      transactions: txns.map(function (t) {
        return {
          date: String((t && t.date) || ''),
          description: String((t && t.description) || ''),
          reference: String((t && t.reference) || ''),
          amount: String((t && t.amount) || '0'),
          type: String((t && t.type) || '').toLowerCase() === 'credit' ? 'credit' : 'debit',
          balance: String((t && t.balance) || '')
        };
      })
    };
  }

  // ── BAI2 writer ────────────────────────────────────────────────────
  // BAI2 records: 01 file header, 02 group header, 03 account, 16
  // transaction detail, 49 account trailer, 98 group trailer, 99 file
  // trailer. Amounts are whole cents (no decimal point) - that is the
  // format's own convention, not a rounding choice.
  const BAI_CODES = { credit: '399', debit: '699' };   // generic misc credit / debit

  function cents(v) {
    const n = Math.round((parseFloat(String(v).replace(/[^0-9.\-]/g, '')) || 0) * 100);
    return String(Math.abs(n));
  }
  function yymmdd(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      return String(d.getFullYear()).slice(2) + p(d.getMonth() + 1) + p(d.getDate());
    }
    return m[1].slice(2) + m[2] + m[3];
  }
  // Commas and slashes are BAI2 field/record delimiters, so any that appear
  // inside a description would corrupt the record if left in.
  const clean = (s) => String(s || '').replace(/[,/]/g, ' ').replace(/\s+/g, ' ').trim();

  function buildBai2(results) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const fileDate = String(now.getFullYear()).slice(2) + pad(now.getMonth() + 1) + pad(now.getDate());
    const fileTime = pad(now.getHours()) + pad(now.getMinutes());
    const lines = [];
    let fileControl = 0;

    lines.push(['01', 'LEXORA', 'RECEIVER', fileDate, fileTime, '1', '80', '', '2/'].join(','));

    results.forEach(function (r, gi) {
      const acct = r.account;
      const asOf = yymmdd(acct.statement_end || acct.statement_start);
      lines.push(['02', clean(acct.bank_name) || 'BANK', 'LEXORA', '1', asOf, '', clean(acct.currency) || 'USD', '2/'].join(','));

      let groupControl = 0;
      lines.push(['03', clean(acct.account_number) || 'UNKNOWN', clean(acct.currency) || 'USD',
        '010', acct.opening_balance ? cents(acct.opening_balance) : '', '', '',
        '015', acct.closing_balance ? cents(acct.closing_balance) : '', '', '/'].join(','));

      let acctControl = 0;
      r.transactions.forEach(function (t) {
        const amt = cents(t.amount);
        acctControl += parseInt(amt, 10) || 0;
        lines.push(['16', BAI_CODES[t.type] || '699', amt, 'Z', clean(t.reference), '',
          clean(t.description).slice(0, 80) + '/'].join(','));
      });

      // 49 = account trailer: control total + number of records in this
      // account block (03 + each 16 + the 49 itself).
      lines.push(['49', String(acctControl), String(r.transactions.length + 2) + '/'].join(','));
      groupControl += acctControl;
      lines.push(['98', String(groupControl), '1', String(r.transactions.length + 4) + '/'].join(','));
      fileControl += groupControl;
    });

    lines.push(['99', String(fileControl), String(results.length), String(lines.length + 1) + '/'].join(','));
    return lines.join('\r\n') + '\r\n';
  }

  function flatRows() {
    const rows = [];
    STATE.results.forEach(function (r) {
      r.transactions.forEach(function (t) {
        rows.push({
          File: r.file,
          Bank: r.account.bank_name,
          Account: r.account.account_number,
          Currency: r.account.currency,
          Date: t.date,
          Description: t.description,
          Reference: t.reference,
          Type: t.type,
          Amount: t.amount,
          Balance: t.balance
        });
      });
    });
    return rows;
  }

  function exportAs(fmt) {
    if (!STATE.results.length) return setStatus('Process a statement first.', 'error');
    const stamp = new Date().toISOString().slice(0, 10);
    if (fmt === 'bai2') {
      download(new Blob([buildBai2(STATE.results)], { type: 'text/plain' }), `statement_${stamp}.bai`);
    } else if (fmt === 'json') {
      download(new Blob([JSON.stringify(STATE.results, null, 2)], { type: 'application/json' }), `statement_${stamp}.json`);
    } else {
      const rows = flatRows();
      if (!rows.length) return setStatus('No transactions were found to export.', 'error');
      const heads = Object.keys(rows[0]);
      const cell = (v) => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
      const lines = [heads.join(',')].concat(rows.map(function (r) {
        return heads.map(function (h) { return cell(r[h]); }).join(',');
      }));
      download(new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), `statement_${stamp}.csv`);
    }
  }

  function _buildOutputBlobForResult(r, fmt, stem) {
    if (fmt === 'bai2') return { blob: new Blob([buildBai2([r])], { type: 'text/plain' }), name: `${stem}.bai` };
    if (fmt === 'json') return { blob: new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' }), name: `${stem}.json` };
    const rows = flatRows().filter(function (x) { return x.File === r.file; });
    const heads = Object.keys(rows[0] || { File: '' });
    const cell = (v) => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
    const lines = [heads.join(',')].concat(rows.map(function (x) {
      return heads.map(function (h) { return cell(x[h]); }).join(',');
    }));
    return { blob: new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), name: `${stem}.csv` };
  }

  function downloadOne(uid) {
    const entry = STATE.files.find(function (f) { return f.uid === uid; });
    if (!entry) return;
    const r = STATE.results.find(function (x) { return x.file === entry.file.name; });
    if (!r) return setStatus('That file has no extracted data yet.', 'error');
    const fmt = (document.getElementById('baiFormat') || {}).value || 'bai2';
    const stem = entry.file.name.replace(/\.[^.]+$/, '');
    const out = _buildOutputBlobForResult(r, fmt, stem);
    download(out.blob, out.name);
  }

  // ── processing ─────────────────────────────────────────────────────
  async function start() {
    if (STATE.running) return;
    const selected = STATE.files.filter(function (f) { return f.selected !== false; });
    if (!selected.length) return setStatus('Select at least one file.', 'error');

    const billing = window.LexoraBilling;
    if (!billing) return setStatus('Billing is unavailable - please reload the page.', 'error');

    const ocrEl = document.getElementById('baiOcr');
    const useOcr = ocrEl ? !!ocrEl.checked : true;

    const rate = billing.perPageRate('bai2');
    const perDocument = billing.isPerDocument('bai2');
    const minNeeded = rate * selected.length;
    log(`System > Checking Wallet Balance > ${CURRENCY_SYMBOL}${minNeeded.toFixed(2)} required for ${selected.length} file(s) (${billing.planName()} plan: BAI2 ${CURRENCY_SYMBOL}${rate}${perDocument ? '/document' : '/page'})`, 'Info');
    if (minNeeded > 0 && billing.balance() < minNeeded) {
      log(`System > Process Aborted > Insufficient balance - you have ${CURRENCY_SYMBOL}${billing.balance().toFixed(2)}`, 'Failed');
      rerender();
      return setStatus(`Insufficient balance. At least ${CURRENCY_SYMBOL}${minNeeded.toFixed(2)} is needed.`, 'error');
    }

    STATE.running = true;
    STATE.results = [];
    setStatus('');
    if (window.setVisionAuthToken) window.setVisionAuthToken(window.__lexoraAuthToken || '');
    log(`System > ${useOcr ? 'With OCR' : 'Without OCR'}`, 'Success');
    rerender();

    const runCtx = window.createStandaloneRunCtx ? await window.createStandaloneRunCtx('bai2') : null;
    const outputFmt = (document.getElementById('baiFormat') || {}).value || 'bai2';

    for (let i = 0; i < selected.length; i++) {
      const entry = selected[i];
      const label = `File(${i + 1}/${selected.length})`;
      entry.status = useOcr ? 'Scanning' : 'Processing';
      entry.scanProgress = 0;
      entry.progress = useOcr ? 0 : 5;
      log(`${label} > File Processing > ${entry.file.name}`, 'Info');
      rerender();

      let charged = 0, pagesDone = 0, jsonCalls = 0;
      try {
        if (window.setPipelineEventHandler) {
          window.setPipelineEventHandler(function (ev) {
            if (!ev || ev.type !== 'scan') return;
            entry.scanProgress = Math.round((ev.page / (ev.totalPages || 1)) * 100);
            if (entry.scanProgress >= 100) {
              log(`${label} > Scanning > 100%`, 'Success');
              entry.status = 'Processing';
            }
            rerender();
          });
        }
        const pages = await pagesFromFile(entry.file, useOcr, function (p, total, calls) {
          jsonCalls += calls;
          // FULL-FILE BILLING: accrue the running total only - nothing is
          // actually charged to the wallet until the whole file finishes
          // (see billing.charge() call after this try block). If the file
          // fails partway, none of this is charged. Per-document plans
          // charge the flat rate once (set below, not accumulated here);
          // per-page plans add rate for every page that comes through.
          pagesDone++;
          if (!perDocument) charged += rate;
          entry.pageCount = total;
          entry.progress = Math.round((p / total) * 70);
          log(`${label} > Page(${p}/${total}) > API Call(s) > JSON=${calls}, IMAGE=0`, 'Success');
          rerender();
        });

        const text = pages.join('\n\n').trim();
        if (!text) throw new Error('No readable text found. If this is a scan, enable With OCR.');
        log(`${label} > Text Data = ${text.length} character(s)`, 'Info');

        const account = await extract(text);
        jsonCalls++;
        log(`${label} > Extract Data > API Call(s) > JSON=1, IMAGE=0`, 'Success');
        log(`${label} > Transactions found = ${account.transactions.length}`, 'Info');

        STATE.results.push({ file: entry.file.name, account: account, transactions: account.transactions });
        entry.status = 'Success';
        entry.progress = 100;
        if (runCtx) {
            const stem = entry.file.name.replace(/\.[^.]+$/, '');
            const out = _buildOutputBlobForResult({ file: entry.file.name, account: account, transactions: account.transactions }, outputFmt, stem);
            await runCtx.download(out.blob, out.name);
        }

        // Per-document plans: one flat charge for the whole file now
        // that it's done, regardless of page count.
        if (perDocument && pagesDone > 0) charged = rate;

        // Charge once, only now that the file has fully succeeded.
        const txnId = billing.charge(`BAI2 - ${entry.file.name}`, charged);
        log(`${label} > Page(All) > API Call(s) > JSON=${jsonCalls}, IMAGE=0`, 'Info');
        log(`${label} > Page(All) > Amount Deducted from Wallet=${CURRENCY_SYMBOL}${charged.toFixed(2)}` +
            (perDocument ? ' (flat per-document rate)' : ` (${pagesDone} page(s) @ ${CURRENCY_SYMBOL}${rate}/page)`), 'Info');
        if (charged > 0 && window.notifyProcessCompletion) {
          window.notifyProcessCompletion('BAI2', entry.file.name, charged, txnId);
        }
      } catch (e) {
        entry.status = 'Failed';
        entry.error = e.message || 'Processing failed';
        log(`${label} > Error > ${entry.error}`, 'Failed');
        log(`${label} > System > No charge - file did not finish processing`, 'Info');
      }
      rerender();
    }

    STATE.running = false;
    if (runCtx) await runCtx.finalize();
    log(`Generate Output > ${STATE.results.length} statement(s) ready`, 'Success');
    rerender();
  }

  // ── UI ─────────────────────────────────────────────────────────────
  function onPick(ev) {
    Array.from((ev.target && ev.target.files) || []).forEach(function (f) {
      STATE.files.push({ uid: STATE.nextId++, file: f, selected: true, status: 'Pending' });
    });
    rerender();
  }
  function toggleSelect(uid, checked) {
    const f = STATE.files.find(function (x) { return x.uid === uid; });
    if (f) f.selected = !!checked;
  }
  function toggleAll(checked) {
    STATE.files.forEach(function (f) { f.selected = !!checked; });
    rerender();
  }
  function clearAll() {
    STATE.files = []; STATE.log = []; STATE.results = []; STATE.nextId = 1;
    rerender();
  }

  function statusClass(s) {
    if (s === 'Success') return 'completed';
    if (s === 'Failed') return 'error';
    if (s === 'Processing') return 'processing';
    if (s === 'Scanning') return 'processing';
    return 'pending';
  }

  function chargeEstimate() {
    const b = window.LexoraBilling;
    if (!b) return '';
    const sel = STATE.files.filter(function (f) { return f.selected !== false; });
    if (!sel.length) return '';
    const rate = b.perPageRate('bai2');
    const perDocument = b.isPerDocument('bai2');
    const total = perDocument ? rate * sel.length : sel.reduce(function (s, f) { return s + rate * Math.max(1, f.pageCount || 1); }, 0);
    return `💰 Rate: ${CURRENCY_SYMBOL}${rate.toFixed(2)}${perDocument ? '/document' : '/page'} · Est. total: ${CURRENCY_SYMBOL}${total.toFixed(2)} for ${sel.length} selected file(s)`;
  }

  function fileRows() {
    if (!STATE.files.length) {
      return '<tr><td colspan="6" style="text-align:center;padding:15px;color:rgba(0,0,0,0.3);">No files uploaded yet.</td></tr>';
    }
    return STATE.files.map(function (f) {
      const cls = statusClass(f.status);
      const pct = f.progress != null ? f.progress : (f.status === 'Success' ? 100 : 0);
      const action = window.buildFileActionCell(f.status, f.error);
      return `<tr>
        <td><input type="checkbox" class="file-select-checkbox" ${(f.selected !== false && f.status !== 'Success') ? 'checked' : ''}
                   ${STATE.running ? 'disabled' : ''} onchange="Bai2.toggleSelect(${f.uid}, this.checked)" /></td>
        <td class="file-name"><span class="file-name-link">${esc(f.file.name)}</span></td>
        <td>${f.pageCount || '-'}</td>
        <td><span class="scan-result-text ${cls}">${f.status === 'Scanning' ? (f.scanProgress || 0) + '%' : esc(f.status)}</span></td>
        <td><span class="progress-label">${pct}%</span></td>
        <td>${action}</td>
      </tr>`;
    }).join('');
  }

  function resultsTable() {
    const rows = flatRows();
    if (!rows.length) return '';
    const heads = Object.keys(rows[0]);
    return `
      <div class="file-list-card" style="height:auto;">
        <div class="file-list-card-header"><h3>🏦 Transactions (${rows.length})</h3></div>
        <div class="card-body">
          <div class="file-table-wrapper">
            <div class="file-table-scroll" style="height:260px;max-height:260px;overflow-y:scroll;">
              <table class="file-table">
                <thead><tr>${heads.map(function (h) { return `<th>${esc(h)}</th>`; }).join('')}</tr></thead>
                <tbody>${rows.map(function (r) {
                  return `<tr>${heads.map(function (h) {
                    return `<td>${esc(r[h]) || '<span style="color:rgba(0,0,0,0.3);">—</span>'}</td>`;
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

  function render() {
    const countText = STATE.files.length ? `${STATE.files.length} file(s) uploaded` : 'No files uploaded yet';
    // Item 13 - picked up by updateContent() (app.js) and placed next to
    // the breadcrumb title instead of inline in this card's header.
    window.__pendingChargeEstimateHtml = chargeEstimate();
    return `
      <div>
        <div class="service-page-grid">
          <div class="service-col">
          <div class="service-card">
            <h3 class="card-head-row"><span>📤 Upload File(s)</span><button class="process-btn clear-btn card-back-btn" onclick="goBackToServices()">← Back to Services</button></h3>
            <div class="card-body">
              <div class="drop-zone" onclick="${STATE.running ? 'void(0)' : "document.getElementById('baiInput').click()"}"
                   style="${STATE.running ? 'opacity:0.5;pointer-events:none;' : ''}">
                <div class="drop-icon">📤</div>
                <div class="drop-text">Drag &amp; drop bank statements here</div>
                <div class="drop-sub">or click to browse (PDF / JPG / PNG)</div>
                <div class="file-count-text">${countText}</div>
              </div>
              <input type="file" id="baiInput" multiple style="display:none;" accept=".pdf,image/*"
                     onchange="Bai2.onPick(event)" />
            </div>
          </div>

          <div class="service-card">
            <h3>⚙️ Setup</h3>
            <div class="card-body">
              ${window.buildStandaloneSystemConfigHtml ? window.buildStandaloneSystemConfigHtml('bai2') : ''}
              <div id="baiSetup">
              <div class="setup-group">
                <label>Output Format</label>
                <select id="baiFormat" style="width:100%;" ${STATE.running ? 'disabled' : ''}>
                  <option value="bai2">BAI2 (.bai)</option>
                  <option value="csv">CSV (.csv)</option>
                  <option value="json">JSON (.json)</option>
                </select>
              </div>

              <div class="setup-group">
                <div style="display:flex;align-items:center;gap:20px;margin-top:10px;">
                  <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:normal;"
                         title="Checked: each page is read by the vision model - needed for scans and images. Unchecked: faster local text read, for text-based PDFs only.">
                    <input type="checkbox" id="baiOcr" style="width:auto;margin:0;" checked ${STATE.running ? 'disabled' : ''} />
                    <span>With OCR</span>
                  </label>
                </div>
              </div>
              </div>
              <div class="setup-group" style="margin-top:8px;">
                <div class="process-controls">
                  <button class="process-btn start-btn" ${STATE.running || !STATE.files.length ? 'disabled' : ''}
                          onclick="Bai2.start()">▶️ Start</button>
                  <button class="process-btn clear-btn" ${STATE.running ? 'disabled' : ''}
                          onclick="Bai2.exportAll()">⬇️ Download All</button>
                  <button class="process-btn clear-btn" ${STATE.running ? 'disabled' : ''}
                          onclick="Bai2.clearAll()">🗑️ Clear Files</button>
                </div>
              </div>
              <div id="baiStatus" style="margin-top:8px;font-size:0.86rem;min-height:1.1em;"></div>
            </div>
          </div>
          </div>

          <div class="service-col">
        <div class="file-list-card">
          <div class="file-list-card-header">
            <h3>📁 Uploaded Files</h3>
          </div>
          <div class="card-body">
            <div class="file-table-wrapper">
              <table class="file-table file-table-files">
                <colgroup><col style="width:4%;"><col style="width:50%;"><col style="width:10%;"><col style="width:16%;"><col style="width:11%;"><col style="width:9%;"></colgroup>
                <thead><tr>
                  <th><input type="checkbox" ${(STATE.files.length > 0 && STATE.files.every(function (f) { return f.selected !== false; })) ? 'checked' : ''}
                             ${STATE.running ? 'disabled' : ''} onchange="Bai2.toggleAll(this.checked)" title="Select all" /></th>
                  <th>File Name</th><th>Pages</th><th>Scan Result</th><th>Progress</th><th>Action</th>
                </tr></thead>
              </table>
              <div class="file-table-scroll">
                <table class="file-table file-table-files">
                  <colgroup><col style="width:4%;"><col style="width:50%;"><col style="width:10%;"><col style="width:16%;"><col style="width:11%;"><col style="width:9%;"></colgroup>
                  <tbody>${fileRows()}</tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        ${window.isAdminOrDeveloper && window.isAdminOrDeveloper() ? `
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
        ` : ''}
          </div>
        </div>

        ${resultsTable()}
`;
  }

  // rerender() replaces the WHOLE page (file table, log, Setup card) on
  // every progress tick, log line, and file pick - so without this, the
  // Output Format select and With OCR checkbox silently reset to their
  // hardcoded defaults mid-run, same issue fixed in service-runner.js.
  function _captureSetupValues() {
    const container = document.getElementById('baiSetup');
    const values = {};
    if (!container) return values;
    container.querySelectorAll('input, select, textarea').forEach(function (el) {
      const key = el.name || el.id;
      if (!key) return;
      if (el.type === 'checkbox') values[key] = el.checked;
      else if (el.type === 'radio') { if (el.checked) values[key] = el.value; }
      else values[key] = el.value;
    });
    return values;
  }

  function _restoreSetupValues(values) {
    const container = document.getElementById('baiSetup');
    if (!container || !values) return;
    container.querySelectorAll('input, select, textarea').forEach(function (el) {
      const key = el.name || el.id;
      if (!key || !(key in values)) return;
      if (el.type === 'checkbox') el.checked = !!values[key];
      else if (el.type === 'radio') el.checked = (el.value === values[key]);
      else el.value = values[key];
    });
  }

  function rerender() {
    // Item 13 - targets the body-only wrapper (app.js's updateContent
    // wraps every page's body in #serviceBodyRoot) instead of the whole
    // #contentBody, so the breadcrumb bar sitting above it - which now
    // also carries the charge-estimate span - survives every rerender
    // instead of being wiped out on the very first file pick/progress
    // tick (rerender() fires constantly during a run).
    const host = document.getElementById('serviceBodyRoot') || document.getElementById('contentBody');
    if (!host || !document.getElementById('baiInput')) return;
    const savedSetup = _captureSetupValues();
    host.innerHTML = render();
    _restoreSetupValues(savedSetup);
    if (window.lexoraEnhancePage) window.lexoraEnhancePage(host);
    // render() (above) already set window.__pendingChargeEstimateHtml -
    // updateContent() isn't in the loop for this rerender, so update the
    // breadcrumb's estimate span directly here instead.
    const estEl = document.getElementById('fileListChargeEstimate');
    if (estEl) estEl.innerHTML = window.__pendingChargeEstimateHtml || '';
  }

  window.Bai2 = {
    render: render,
    onPick: onPick,
    toggleSelect: toggleSelect,
    toggleAll: toggleAll,
    clearAll: clearAll,
    start: start,
    downloadOne: downloadOne,
    exportAll: function () { exportAs((document.getElementById('baiFormat') || {}).value || 'bai2'); },
    buildBai2: buildBai2
  };
})();
