/* ocr-service.js — Lexora "OCR" service (PAID).
 *
 * Turns a PDF into an editable Word document with its LAYOUT PRESERVED -
 * text is rebuilt as positioned textboxes over the original page image.
 * This is exactly what Translation does minus the translating step, so it
 * calls the SAME pipeline (buildHybridDocxBlob / buildOfflineDocxBlob) with
 * the target language locked to "original". Nothing about the conversion is
 * reimplemented here - only the page around it.
 *
 * Why it's a separate service rather than an option inside Translation:
 * asking for OCR by choosing "Translation -> No Translation" is not
 * something anyone would think to look for.
 *
 * Billing matches Translation: one flat charge per finished file when the
 * plan bills per document (the current default), or per-page if the plan
 * is ever configured that way - through window.LexoraBilling, at the same
 * plan rate, only once the whole file has succeeded.
 */
(function () {
  'use strict';

  const STATE = { files: [], nextId: 1, running: false, stopped: false, log: [], blobs: {} };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function log(activity, status) {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    const entry = {
      time: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`,
      activity: activity, status: status || 'Info'
    };
    STATE.log.unshift(entry);
    return entry;
  }

  function setStatus(msg, kind) {
    const el = document.getElementById('ocrStatus');
    if (!el) return;
    el.style.color = kind === 'error' ? '#b3261e' : (kind === 'ok' ? '#1b5e20' : '#2c5777');
    el.textContent = msg || '';
  }

  function download(blob, name) {
    if (window.standaloneSmartDownload) {
      window.standaloneSmartDownload('ocr', blob, name);
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  // ── processing ─────────────────────────────────────────────────────
  async function start() {
    if (STATE.running) return;
    const selected = STATE.files.filter(function (f) { return f.selected !== false; });
    if (!selected.length) return setStatus('Select at least one file.', 'error');

    const billing = window.LexoraBilling;
    if (!billing) return setStatus('Billing is unavailable - please reload the page.', 'error');
    if (!window.buildHybridDocxBlob || !window.buildOfflineDocxBlob) {
      return setStatus('The document engine failed to load - please reload the page.', 'error');
    }

    // OCR service is always vision-based OCR now - no toggle, no
    // text-layer fallback (that's what Translation/Data Extraction are for).
    const useOcr = true;

    const rate = billing.perPageRate('ocr');
    const perDocument = billing.isPerDocument('ocr');
    const minNeeded = rate * selected.length;
    log(`System > Checking Wallet Balance > ${CURRENCY_SYMBOL}${minNeeded.toFixed(2)} required for ${selected.length} file(s) (${billing.planName()} plan: OCR ${CURRENCY_SYMBOL}${rate}${perDocument ? '/document' : '/page'})`, 'Info');
    if (minNeeded > 0 && billing.balance() < minNeeded) {
      log(`System > Process Aborted > Insufficient balance - you have ${CURRENCY_SYMBOL}${billing.balance().toFixed(2)}`, 'Failed');
      rerender();
      return setStatus(`Insufficient balance. At least ${CURRENCY_SYMBOL}${minNeeded.toFixed(2)} is needed.`, 'error');
    }

    STATE.running = true;
    STATE.stopped = false;
    setStatus('');
    if (window.setVisionAuthToken) window.setVisionAuthToken(window.__lexoraAuthToken || '');
    if (window.setVisionStopCheck) window.setVisionStopCheck(function () { return STATE.stopped; });
    log(`System > ${useOcr ? 'With OCR' : 'Without OCR'} + Without Translation`, 'Success');
    rerender();

    const runCtx = window.createStandaloneRunCtx ? await window.createStandaloneRunCtx('ocr') : null;

    for (let i = 0; i < selected.length; i++) {
      const entry = selected[i];
      const label = `File(${i + 1}/${selected.length})`;
      entry.status = useOcr ? 'Scanning' : 'Processing';
      entry.scanProgress = 0;
      entry.progress = useOcr ? 0 : 5;
      log(`${label} > File Processing > ${entry.file.name}`, 'Info');
      rerender();

      let charged = 0, pagesDone = 0, jsonCalls = 0, imageCalls = 0;
      let liveEntry = null;
      try {
        // Per-page rows come from the pipeline's structured events, same
        // as Translation - but billing is now FULL-FILE: pages only
        // accrue toward the total, nothing is charged to the wallet
        // until the whole file finishes successfully below. Per-document
        // plans charge the flat rate once (set after the loop, not
        // accumulated here); per-page plans add rate for every page.
        if (window.setPipelineEventHandler) {
          window.setPipelineEventHandler(function (ev) {
            if (!ev) return;
            if (ev.type === 'scan') {
              // Item 1 - Scan Result reaches 100% BEFORE Progress starts
              // moving at all, not simultaneously.
              entry.scanProgress = Math.round((ev.page / (ev.totalPages || 1)) * 100);
              if (entry.scanProgress >= 100) {
                log(`${label} > Scanning > 100%`, 'Success');
                entry.status = 'Processing';
              }
              rerender();
              return;
            }
            if (ev.type === 'page_start') {
              // Live row: shows "In Progress" for as long as the actual
              // vision API call is in flight, then gets overwritten by
              // the real result below - not a separate permanent entry.
              liveEntry = log(`${label} > Page(${ev.page}/${ev.totalPages}) > Extracting text...`, 'Processing');
              rerender();
              return;
            }
            if (ev.type !== 'page') return;
            jsonCalls += ev.jsonCalls;
            imageCalls += ev.imageCalls;
            const lbl = `Page(${ev.page}/${ev.totalPages})`;
            if (liveEntry) {
              liveEntry.activity = `${label} > ${lbl} > API Call(s) > JSON=${ev.jsonCalls}, IMAGE=${ev.imageCalls}`;
              liveEntry.status = 'Success';
              liveEntry = null;
            } else {
              log(`${label} > ${lbl} > API Call(s) > JSON=${ev.jsonCalls}, IMAGE=${ev.imageCalls}`, 'Success');
            }
            if (ev.ok) {
              pagesDone++;
              if (!perDocument) charged += rate;
            }
            log(`${label} > ${lbl} > Text Data = ${ev.textData}`, 'Info');
            entry.pageCount = ev.totalPages;
            entry.progress = Math.round((ev.page / (ev.totalPages || 1)) * 85);
            rerender();
          });
        }
        if (window.resetPipelineApiCounters) window.resetPipelineApiCounters();

        // targetLang 'original' is what makes this OCR rather than
        // Translation - the pipeline then skips the whole-document
        // translate call entirely.
        const opts = { withImage: true, targetLang: 'original' };
        const blob = useOcr
          ? await window.buildHybridDocxBlob(entry.file, opts, function (m, level) {
              if (level === 'warn' || level === 'error') { log(`${label} > ${m}`, 'Failed'); rerender(); }
            })
          : await window.buildOfflineDocxBlob(entry.file, opts, function (m, level) {
              if (level === 'warn' || level === 'error') { log(`${label} > ${m}`, 'Failed'); rerender(); }
            });

        // With OCR the pipeline emits an MHT-based Word file, which Word
        // rejects if it carries a .docx extension.
        const ext = useOcr ? '.doc' : '.docx';
        const name = entry.file.name.replace(/\.[^.]+$/, '') + ' OCR' + ext;
        STATE.blobs[entry.uid] = { blob: blob, name: name };
        if (runCtx) await runCtx.download(blob, name);

        entry.status = 'Success';
        entry.progress = 100;

        // Per-document plans: one flat charge for the whole file now
        // that it's done, regardless of page count.
        if (perDocument && pagesDone > 0) charged = rate;

        // Charge once, only now that the file has fully succeeded.
        const txnId = billing.charge(`OCR - ${entry.file.name}`, charged);
        log(`${label} > Page(All) > API Call(s) > JSON=${jsonCalls}, IMAGE=${imageCalls}`, 'Info');
        log(`${label} > Page(All) > Amount Deducted from Wallet=${CURRENCY_SYMBOL}${charged.toFixed(2)}` +
            (perDocument ? ' (flat per-document rate)' : ` (${pagesDone} page(s) @ ${CURRENCY_SYMBOL}${rate}/page)`), 'Info');
        log(`${label} > Generate Output > ${name}`, 'Success');
        if (charged > 0 && window.notifyProcessCompletion) {
          window.notifyProcessCompletion('OCR', entry.file.name, charged, txnId);
        }
      } catch (e) {
        entry.status = 'Failed';
        entry.error = e.message || 'Processing failed';
        log(`${label} > Error > ${entry.error}`, 'Failed');
        log(`${label} > System > No charge - file did not finish processing`, 'Info');
      }
      rerender();
    }

    if (window.setPipelineEventHandler) window.setPipelineEventHandler(null);
    if (runCtx) await runCtx.finalize();
    STATE.running = false;
    rerender();
  }

  async function downloadOne(uid) {
    const item = STATE.blobs[uid];
    if (!item) return setStatus('That file has not been processed yet.', 'error');
    download(item.blob, item.name);
  }

  // ── file list ──────────────────────────────────────────────────────
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
    STATE.files = []; STATE.log = []; STATE.blobs = {}; STATE.nextId = 1;
    rerender();
  }
  function stop() {
    STATE.stopped = true;
    log('System > Stop requested', 'Info');
    rerender();
  }

  // ── UI (same shell as Translation) ─────────────────────────────────
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
    const rate = b.perPageRate('ocr');
    const perDocument = b.isPerDocument('ocr');
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
      const action = f.status === 'Success'
        ? `<span class="file-action-link" title="Delivered">✓</span>`
        : (f.status === 'Failed'
            ? `<span class="file-action-link error-link" title="${esc(f.error || 'Failed')}">⚠</span>`
            : `<span class="file-action-link disabled" title="${esc(f.status)}">${f.status === 'Processing' ? '\u23f3' : '\u2022'}</span>`);
      return `<tr>
        <td><input type="checkbox" class="file-select-checkbox" ${f.selected !== false ? 'checked' : ''}
                   ${STATE.running ? 'disabled' : ''} onchange="OcrService.toggleSelect(${f.uid}, this.checked)" /></td>
        <td class="file-name"><span class="file-name-link">${esc(f.file.name)}</span></td>
        <td>${f.pageCount || '-'}</td>
        <td><span class="scan-result-text ${cls}">${f.status === 'Scanning' ? (f.scanProgress || 0) + '%' : esc(f.status)}</span></td>
        <td><span class="progress-label">${pct}%</span></td>
        <td>${action}</td>
      </tr>`;
    }).join('');
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
              <div class="drop-zone" onclick="${STATE.running ? 'void(0)' : "document.getElementById('ocrInput').click()"}"
                   style="${STATE.running ? 'opacity:0.5;pointer-events:none;' : ''}">
                <div class="drop-icon">📤</div>
                <div class="drop-text">Drag &amp; drop files here</div>
                <div class="drop-sub">or click to browse (PDF only)</div>
                <div class="file-count-text">${countText}</div>
              </div>
              <input type="file" id="ocrInput" multiple style="display:none;" accept=".pdf"
                     onchange="OcrService.onPick(event)" />
            </div>
          </div>

          <div class="service-card">
            <h3>⚙️ Setup</h3>
            <div class="card-body">
              ${window.buildStandaloneSystemConfigHtml ? window.buildStandaloneSystemConfigHtml('ocr') : ''}
              <div class="setup-group">
                <div style="font-size:0.84rem;color:rgba(0,0,0,0.6);">
                  Rebuilds your PDF as an editable Word document with the original
                  layout kept - text sits in positioned boxes over the page background.
                </div>
              </div>

              <div class="setup-group" style="margin-top:8px;">
                <div class="process-controls">
                  <button class="process-btn start-btn" ${STATE.running || !STATE.files.length ? 'disabled' : ''}
                          onclick="OcrService.start()">▶️ Start</button>
                  <button class="process-btn clear-btn" ${STATE.running ? '' : 'disabled'}
                          onclick="OcrService.stop()">⏹️ Stop</button>
                  <button class="process-btn clear-btn" ${STATE.running ? 'disabled' : ''}
                          onclick="OcrService.clearAll()">🗑️ Clear Files</button>
                </div>
              </div>
              <div id="ocrStatus" style="margin-top:8px;font-size:0.86rem;min-height:1.1em;"></div>
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
                             ${STATE.running ? 'disabled' : ''} onchange="OcrService.toggleAll(this.checked)" title="Select all" /></th>
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
        </div>`;
  }

  function rerender() {
    // Item 13 - see the matching comment in bai2.js's rerender().
    const host = document.getElementById('serviceBodyRoot');
    if (!host || !document.getElementById('ocrInput')) return;
    host.innerHTML = render();
    if (window.lexoraEnhancePage) window.lexoraEnhancePage(host);
    const estEl = document.getElementById('fileListChargeEstimate');
    if (estEl) estEl.innerHTML = window.__pendingChargeEstimateHtml || '';
  }

  // Called when navigating away, so a half-finished run doesn't keep going
  // and stale session-only output isn't left behind (same rule as Translation).
  function leave() {
    if (STATE.running) { STATE.stopped = true; STATE.running = false; }
    STATE.files = []; STATE.log = []; STATE.blobs = {}; STATE.nextId = 1;
  }

  window.OcrService = {
    render: render,
    onPick: onPick,
    toggleSelect: toggleSelect,
    toggleAll: toggleAll,
    clearAll: clearAll,
    start: start,
    stop: stop,
    downloadOne: downloadOne,
    leave: leave
  };
})();
