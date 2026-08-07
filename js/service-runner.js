/* service-runner.js — generic, browser-side "upload files → process → download"
 * service shell.
 *
 * WHY THIS EXISTS
 * The Translation page's UI is built by buildServiceUploadHTML() in app.js,
 * which is hardwired to translation/lease state (getMyTranslationFiles(),
 * agent pills, wallet charge estimates, processState, ...). Reusing it for the
 * newer file tools would have meant refactoring that shared data layer, which
 * is exactly the code path the paid Translation service depends on.
 *
 * So instead this module reproduces the SAME layout (Setup card → Upload card
 * → file table with checkboxes → Activity Log → Start/Clear) against its own
 * isolated per-service state. Translation is left completely untouched.
 *
 * A service registers itself with:
 *   ServiceRunner.register({
 *     id, title, icon, accept, multiple,
 *     setupHtml()        -> optional HTML for the Setup card
 *     process(files, ctx)-> async; does the work, uses ctx.log()/ctx.progress()
 *   })
 */
(function () {
  'use strict';

  const SERVICES = {};      // id -> definition
  const STATE = {};         // id -> { files, log, running, stopped, nextId }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function state(id) {
    if (!STATE[id]) {
      STATE[id] = { files: [], log: [], running: false, stopped: false, nextId: 1 };
      STATE[id].systemConfig = (window.getSetupPref ? window.getSetupPref(id, 'systemConfig', 'Desktop') : 'Desktop');
    }
    return STATE[id];
  }

  function nowStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function addLog(id, activity, status) {
    state(id).log.unshift({ time: nowStamp(), activity: activity, status: status || 'Info' });
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  // Item 14/16 - if this service's Services Catalog row has
  // systemConfig=Yes, route the finished file through whatever System
  // Configuration is selected (upload to the browser-managed provider,
  // or a click-to-download link) instead of firing the browser's
  // download immediately. Anything without systemConfig keeps the
  // original direct-download behavior, unchanged.
  async function _resolveRunConfig(id) {
    if (window.refreshServicesCatalog) {
      try { await window.refreshServicesCatalog(); } catch (e) { /* fall back to whatever's cached */ }
    }
    const catalogEntry = window.SERVICES_CATALOG && window.SERVICES_CATALOG[id];
    const hasSystemConfig = !!(catalogEntry && catalogEntry.systemConfig === 'Yes');
    const st = state(id);
    const selected = hasSystemConfig ? (st.systemConfig || 'Desktop') : 'Desktop';
    return { hasSystemConfig: hasSystemConfig, selected: selected };
  }

  // Item: exact 3-case spec -
  //   System Configuration available + Desktop -> every file downloads
  //     individually as it completes; one "Process Completed" message
  //     once the whole run finishes.
  //   System Configuration available + Email -> nothing is emailed per
  //     file; every output file from this run is collected and sent in
  //     ONE email (zipped together if there's more than one) once the
  //     whole run finishes, then "All Files sent on email".
  //   System Configuration not available -> same as Desktop.
  // Cloud-provider destinations (Google Drive etc.) aren't part of this
  // spec and keep their existing per-file upload + message behavior.
  function _createRunCtx(id, runConfig) {
    const pendingEmailFiles = [];
    const isEmailRun = runConfig.hasSystemConfig && runConfig.selected.trim().toLowerCase() === 'email';

    async function download(blob, filename) {
      if (isEmailRun) {
        pendingEmailFiles.push({ blob: blob, filename: filename });
        addLog(id, `System > Queued ${filename} for the batch email`, 'Info');
        return;
      }
      if (!runConfig.hasSystemConfig || runConfig.selected.trim().toLowerCase() === 'desktop') {
        downloadBlob(blob, filename);
        addLog(id, `System > Downloaded ${filename}`, 'Success');
        return;
      }
      if (runConfig.selected.trim().toLowerCase() === 'google drive') {
        try {
          await window.uploadBlobToGoogleDrive(blob, filename);
          addLog(id, `System > Saved ${filename} to Google Drive`, 'Success');
          if (window.showMessage) window.showMessage('✅ Saved', `${filename} was saved to Google Drive.`, ['OK']);
        } catch (err) {
          addLog(id, `System > Google Drive upload failed for ${filename}: ${err.message}`, 'Failed');
          if (window.showWarning) window.showWarning(`Google Drive upload failed for ${filename}: ${err.message}`);
        }
        return;
      }
      // Cloud-provider destination - unchanged per-file behavior.
      try {
        if (window.systemConfigProviderId && window.StorageDestinations) {
          const providerId = window.systemConfigProviderId(runConfig.selected);
          if (providerId) {
            const result = await StorageDestinations.saveFileToProvider(providerId, blob, filename);
            if (result.provider !== 'local') {
              addLog(id, `System > Saved to ${runConfig.selected}`, 'Success');
              if (window.showMessage) window.showMessage('✅ Saved', `${filename} was saved to ${runConfig.selected}.`, ['OK']);
              return;
            }
          }
        }
      } catch (err) {
        addLog(id, `System > Could not save to ${runConfig.selected} - ${err.message || err}`, 'Failed');
      }
      const url = URL.createObjectURL(blob);
      if (window.showDownloadLinkModal) {
        window.showDownloadLinkModal(filename, url);
      } else {
        downloadBlob(blob, filename);
      }
    }

    async function finalize() {
      if (isEmailRun) {
        if (!pendingEmailFiles.length) return;
        try {
          let attachmentBlob = pendingEmailFiles[0].blob;
          let attachmentName = pendingEmailFiles[0].filename;
          if (pendingEmailFiles.length > 1 && window.JSZip) {
            const zip = new JSZip();
            pendingEmailFiles.forEach(f => zip.file(f.filename, f.blob));
            attachmentBlob = await zip.generateAsync({ type: 'blob' });
            attachmentName = `${id}_output_files.zip`;
          }
          const b64 = await window.blobToBase64(attachmentBlob);
          const res = await window.authFetch('/api/system-config/email-file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: window.getCurrentUserId(), filename: attachmentName, fileData: b64 })
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Could not email those files.');
          addLog(id, `System > All files emailed to ${data.emailedTo}`, 'Success');
          if (window.showMessage) window.showMessage('✅ All Files Sent', 'All Files sent on email', ['OK']);
        } catch (err) {
          addLog(id, `System > Could not email the output files - ${err.message || err}`, 'Failed');
          if (window.showWarning) window.showWarning(err.message || 'Could not email the output files.');
        }
        return;
      }
      if (!runConfig.hasSystemConfig || runConfig.selected.trim().toLowerCase() === 'desktop') {
        if (window.showMessage) window.showMessage('✅ Done', 'Process Completed', ['OK']);
      }
    }

    return { download: download, finalize: finalize };
  }

  // Convenience wrapper for single-shot callers outside the normal
  // start()/startBatch() loop (e.g. the PDF form filler, which produces
  // one file directly rather than looping over a file list) - treats it
  // as a one-file "batch": download (or queue-for-email), then finalize
  // immediately.
  async function smartDownload(id, blob, filename) {
    const runConfig = await _resolveRunConfig(id);
    const runCtx = _createRunCtx(id, runConfig);
    await runCtx.download(blob, filename);
    await runCtx.finalize();
  }

  // ── rendering ──────────────────────────────────────────────────────
  // Deliberately mirrors buildServiceUploadHTML() in app.js class-for-class
  // (service-upload-layout / service-card / drop-zone / file-list-card /
  // activity-log-card / file-table), so these services look identical to
  // Translation without sharing its translation-specific state.
  // IDs are scoped per service (srX_<id>) so they never collide with the
  // Translation page's own element IDs.
  function statusClass(s) {
    if (s === 'Success') return 'completed';
    if (s === 'Failed') return 'error';
    if (s === 'Processing') return 'processing';
    return 'pending';
  }

  function fileRows(id) {
    const st = state(id);
    if (!st.files.length) {
      return '<tr><td colspan="6" style="text-align:center;padding:15px;color:rgba(0,0,0,0.3);">No files uploaded yet.</td></tr>';
    }
    return st.files.map(function (f) {
      const cls = statusClass(f.status);
      const pct = f.progress != null ? f.progress : (f.status === 'Success' ? 100 : 0);
      const progressCell = `
        <span class="progress-label">${pct}%</span>`;
      const action = f.status === 'Success'
        ? '<span class="file-action-link done-label">Success</span>'
        : (f.status === 'Failed'
            ? `<span class="file-action-link error-link" title="${esc(f.error || 'Failed')}">⚠</span>`
            : (f.status === 'Processing'
                ? '<span class="file-action-link disabled">Processing…</span>'
                : `<span class="file-action-link disabled" title="${esc(f.status || 'Pending')}">\u2022</span>`));
      return `
        <tr>
          <td><input type="checkbox" class="file-select-checkbox" ${(f.selected !== false && f.status !== 'Success') ? 'checked' : ''}
                     ${st.running ? 'disabled' : ''}
                     onchange="ServiceRunner.toggleSelect('${id}', ${f.uid}, this.checked)" /></td>
          <td class="file-name"><span class="file-name-link">${esc(f.file.name)}</span></td>
          <td>${f.pageCount || '-'}</td>
          <td><span class="scan-result-text ${cls}">${esc(f.status || 'Pending')}</span></td>
          <td>${progressCell}</td>
          <td>${action}</td>
        </tr>`;
    }).join('');
  }

  function logRows(id) {
    const st = state(id);
    if (!st.log.length) {
      return '<tr><td colspan="3" style="text-align:center;padding:15px;color:rgba(0,0,0,0.3);">No activities recorded.</td></tr>';
    }
    return st.log.map(function (e) {
      return `<tr>
        <td>${esc(e.time)}</td>
        <td>${esc(e.activity)}</td>
        <td><span class="activity-result ${statusClass(e.status)}">${esc(e.status)}</span></td>
      </tr>`;
    }).join('');
  }

  // Item 14 - shows only when this service's Services Catalog row has
  // systemConfig=Yes. Mirrors app.js's Lease Abstraction implementation
  // but keeps state per-service (state(id).systemConfig) instead of one
  // shared variable, since ServiceRunner covers many services at once.
  function _systemConfigHtml(id, st) {
    const catalogEntry = window.SERVICES_CATALOG && window.SERVICES_CATALOG[id];
    if (!catalogEntry || catalogEntry.systemConfig !== 'Yes') return '';
    if (!st.systemConfig) st.systemConfig = 'Desktop';
    const options = (window.getSystemConfigs ? window.getSystemConfigs() : ['Desktop']);
    const optionsHtml = options.map(function (name) {
      return `<option value="${esc(name)}" ${name === st.systemConfig ? 'selected' : ''}>${esc(name)}</option>`;
    }).join('');
    const statusHtml = st.connectionStatus === 'connected'
      ? '<span class="connection-status connected">\u25cf Connected</span>'
      : (st.connectionStatus === 'disconnected' ? '<span class="connection-status disconnected">\u25cf Not Connected</span>' : '');
    return `
      <div class="setup-group">
        <label>System Configuration</label>
        <div class="system-config-row">
          <select id="srSysConfig_${id}" onchange="ServiceRunner.verifyConnection('${id}')">
            ${optionsHtml}
          </select>
          <span id="srSysConfigStatus_${id}">${statusHtml}</span>
        </div>
      </div>`;
  }

  function verifyConnection(id) {
    const select = document.getElementById('srSysConfig_' + id);
    if (!select) return;
    const selected = select.value;
    const st = state(id);

    if (selected === 'Desktop') {
      st.systemConfig = 'Desktop';
      st.connectionStatus = 'connected';
      if (window.saveSetupPref) window.saveSetupPref(id, 'systemConfig', 'Desktop');
      refresh(id);
      return;
    }

    if (selected.trim().toLowerCase() === 'email') {
      st.systemConfig = selected;
      st.connectionStatus = 'connected';
      if (window.saveSetupPref) window.saveSetupPref(id, 'systemConfig', selected);
      refresh(id);
      return;
    }

    if (selected.trim().toLowerCase() === 'google drive') {
      if (!window.verifyGoogleDriveConnection) { select.value = 'Desktop'; return; }
      window.verifyGoogleDriveConnection(select, function (status) {
        st.systemConfig = status === 'connected' ? 'Google Drive' : 'Desktop';
        st.connectionStatus = status;
        if (status !== 'connected') select.value = 'Desktop';
        if (window.saveSetupPref) window.saveSetupPref(id, 'systemConfig', st.systemConfig);
        refresh(id);
      });
      return;
    }

    const providerId = window.systemConfigProviderId ? window.systemConfigProviderId(selected) : null;
    if (providerId && window.StorageDestinations) {
      StorageDestinations.openConfig(providerId, null);
      const check = setInterval(function () {
        if (document.getElementById('storageConfigOverlay')) return; // still open
        clearInterval(check);
        if (StorageDestinations.isConfigured(providerId)) {
          st.systemConfig = selected;
          st.connectionStatus = 'connected';
        } else {
          st.systemConfig = 'Desktop';
          st.connectionStatus = 'idle';
          select.value = 'Desktop';
        }
        if (window.saveSetupPref) window.saveSetupPref(id, 'systemConfig', st.systemConfig);
        refresh(id);
      }, 400);
      return;
    }

    // Sharefile/Sharepoint - same server-managed OAuth check app.js uses.
    (async function () {
      try {
        const statusRes = await window.authFetch(`/api/integrations/status?provider=${selected.toLowerCase()}`);
        const status = await statusRes.json();
        if (!status.configured) {
          st.systemConfig = 'Desktop';
          st.connectionStatus = 'disconnected';
          select.value = 'Desktop';
          refresh(id);
          if (window.showMessage) window.showMessage('⚙️ Not Set Up Yet', `${selected} isn't connected yet - ask your Developer to register it first. Switched back to Desktop for now.`, ['OK']);
          return;
        }
        window.open(status.authUrl, '_blank', 'width=520,height=640');
        select.value = 'Desktop';
        st.systemConfig = 'Desktop';
        refresh(id);
      } catch (err) {
        select.value = 'Desktop';
        st.systemConfig = 'Desktop';
        refresh(id);
      }
    })();
  }

  // Item 13 - "any service marked Paid should show this line too":
  // ServiceRunner covers every "Other Services" tool, most of which are
  // free, so this only produces anything when the Services Catalog
  // marks this particular one Paid (reuses the same window.LexoraBilling
  // rate API that Translation/Lease/BAI2/OCR/Data Extraction already do).
  function chargeEstimateHtml(id) {
    if (!window.LexoraBilling) return '';
    const catalogEntry = window.SERVICES_CATALOG && window.SERVICES_CATALOG[id];
    if (!catalogEntry || catalogEntry.type !== 'Paid') return '';
    const st = state(id);
    const selectedFiles = st.files.filter(function (f) { return f.selected !== false; });
    if (!selectedFiles.length) return '';
    const perDocument = window.LexoraBilling.isPerDocument(id);
    const rate = Number(window.LexoraBilling.perPageRate(id)) || 0;
    const sym = window.LexoraBilling.currencySymbol();
    const total = selectedFiles.reduce(function (sum, f) {
      return sum + (perDocument ? rate : rate * (f.pageCount || 1));
    }, 0);
    return `\ud83d\udcb0 Rate: ${sym}${rate.toFixed(2)}${perDocument ? '/document' : '/page'} \u00b7 Est. total: ${sym}${total.toFixed(2)} for ${selectedFiles.length} selected file(s)`;
  }

  function render(id) {
    const svc = SERVICES[id];
    if (!svc) return '<div class="content-section"><p>This service is not available.</p></div>';
    const st = state(id);
    // Picked up by updateContent() (app.js) and placed next to the
    // breadcrumb title instead of inline in the Uploaded Files header.
    window.__pendingChargeEstimateHtml = chargeEstimateHtml(id);
    const setup = typeof svc.setupHtml === 'function' ? svc.setupHtml(st) : '';
    const countText = st.files.length ? `${st.files.length} file(s) uploaded` : 'No files uploaded yet';
    const accept = svc.accept || '';
    const browseHint = svc.browseHint || (accept.indexOf('image') !== -1 ? 'or click to browse (JPG / PNG)' : 'or click to browse (PDF only)');

    const backBtn = svc.backTo
      ? `<button class="process-btn clear-btn card-back-btn" onclick="${svc.backTo}">← Back to Services</button>`
      : '';

    return `
      <div>
        <div class="service-page-grid">
          <div class="service-col">
          <div class="service-card">
            <h3 class="card-head-row"><span>📤 Upload File(s)</span>${backBtn}</h3>
            <div class="card-body">
              <div class="drop-zone" onclick="${st.running ? 'void(0)' : `document.getElementById('srIn_${id}').click()`}"
                   ondragover="ServiceRunner.onDragOver(event)"
                   ondragleave="ServiceRunner.onDragLeave(event)"
                   ondrop="ServiceRunner.onDrop('${id}', event)"
                   style="${st.running ? 'opacity:0.5;pointer-events:none;' : ''}">
                <div class="drop-icon">📤</div>
                <div class="drop-text">Drag &amp; drop files here</div>
                <div class="drop-sub">${esc(browseHint)}</div>
                <div class="file-count-text">${countText}</div>
              </div>
              <input type="file" id="srIn_${id}" ${svc.multiple === false ? '' : 'multiple'} style="display:none;"
                     accept="${accept}" onchange="ServiceRunner.onPick('${id}', event)" />
            </div>
          </div>

          <div class="service-card">
            <h3>⚙️ Setup</h3>
            <div class="card-body">
              ${_systemConfigHtml(id, st)}
              <div id="srSetup_${id}">${setup}</div>
              <div class="setup-group" style="margin-top:8px;">
                <div class="process-controls">
                  <button class="process-btn start-btn" ${st.running || !st.files.length ? 'disabled' : ''}
                          onclick="ServiceRunner.start('${id}')">▶️ Start</button>
                  <button class="process-btn clear-btn" ${st.running ? 'disabled' : ''}
                          onclick="ServiceRunner.clear('${id}')">🗑️ Clear Files</button>
                </div>
              </div>
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
                  <th><input type="checkbox" ${(st.files.length > 0 && st.files.every(function (f) { return f.selected !== false; })) ? 'checked' : ''}
                             ${st.running ? 'disabled' : ''} onchange="ServiceRunner.toggleAll('${id}', this.checked)" title="Select all" /></th>
                  <th>File Name</th><th>Pages</th><th>Scan Result</th><th>Progress</th><th>Action</th>
                </tr></thead>
              </table>
              <div class="file-table-scroll">
                <table class="file-table file-table-files">
                  <colgroup><col style="width:4%;"><col style="width:50%;"><col style="width:10%;"><col style="width:16%;"><col style="width:11%;"><col style="width:9%;"></colgroup>
                  <tbody>${fileRows(id)}</tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        ${window.isAdminOrDeveloper && window.isAdminOrDeveloper() ? `
        <div class="activity-log-section">
          <div class="activity-log-card">
            <div class="log-header">
              <h3>📋 Activity Log</h3>
            </div>
            <div class="card-body">
              <div class="file-table-wrapper">
                <table class="file-table file-table-activity">
                  <colgroup><col style="width:20%;"><col style="width:62%;"><col style="width:18%;"></colgroup>
                  <thead><tr><th>Date &amp; Time</th><th>Activity</th><th>Status</th></tr></thead>
                </table>
                <div class="file-table-scroll">
                  <table class="file-table file-table-activity">
                    <colgroup><col style="width:20%;"><col style="width:62%;"><col style="width:18%;"></colgroup>
                    <tbody>${logRows(id)}</tbody>
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

  // Every refresh() re-renders the WHOLE page (file table, log, Setup card,
  // all of it) from scratch, because setupHtml() only knows the service's
  // *file* state (st), not whatever the user has typed/picked in the Setup
  // card's own inputs - those live only in the DOM. Left alone, that means
  // adding a file or checking a checkbox (both call refresh()) silently
  // resets any "Pages to keep" range, compression level, output-mode radio,
  // etc. back to the HTML's hardcoded defaults right before Start runs -
  // exactly the "my setup choice changed itself" bug. Fix: snapshot every
  // input/select/textarea inside #srSetup_<id> immediately before the
  // innerHTML swap, then write those same values back in afterwards. Works
  // for any field in any service's setupHtml() with zero per-service code.
  function _captureSetupValues(id) {
    const container = document.getElementById('srSetup_' + id);
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

  function _restoreSetupValues(id, values) {
    const container = document.getElementById('srSetup_' + id);
    if (!container || !values) return;
    container.querySelectorAll('input, select, textarea').forEach(function (el) {
      const key = el.name || el.id;
      if (!key || !(key in values)) return;
      if (el.type === 'checkbox') el.checked = !!values[key];
      else if (el.type === 'radio') el.checked = (el.value === values[key]);
      else el.value = values[key];
    });
  }

  function refresh(id) {
    // Item 13 - targets the body-only wrapper (app.js's updateContent
    // wraps every page's body in #serviceBodyRoot) so the breadcrumb bar
    // survives every refresh. BUT tools opened by drilling into "Other
    // Services" go through FreeServices.openNow(), which replaces
    // #contentBody directly and never creates #serviceBodyRoot - falling
    // back to #contentBody there is what was CORRECT before, and without
    // it this refresh() found no host at all and silently did nothing,
    // which is exactly what broke file pick/drag-drop for those tools.
    const host = document.getElementById('serviceBodyRoot') || document.getElementById('contentBody');
    if (!host) return;
    if (!document.getElementById('srIn_' + id)) return;
    const savedSetup = _captureSetupValues(id);
    host.innerHTML = render(id);
    _restoreSetupValues(id, savedSetup);
    const estEl = document.getElementById('fileListChargeEstimate');
    if (estEl) estEl.innerHTML = window.__pendingChargeEstimateHtml || '';
    if (window.lexoraEnhancePage) window.lexoraEnhancePage(host);
  }

  // Item 4c - most of the 24 registered tools' own process() never call
  // ctx.pages(n) (only 2 of them do), so the Pages column stayed blank
  // for everything else. This detects it independently the moment a
  // PDF is added, using pdf.js (already loaded globally for the
  // translation pipeline) - works for every tool without each one
  // needing its own page-counting code.
  async function _autoDetectPageCount(entry, id) {
    if (!window.pdfjsLib || !/\.pdf$/i.test(entry.file.name || '')) return;
    try {
      const buf = await entry.file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      entry.pageCount = pdf.numPages;
      refresh(id);
    } catch (e) { /* not a readable PDF - leave the Pages cell blank */ }
  }

  // ── interactions ───────────────────────────────────────────────────
  function onPick(id, ev) {
    const st = state(id);
    const picked = Array.from((ev.target && ev.target.files) || []);
    picked.forEach(function (f) {
      const entry = { uid: st.nextId++, file: f, selected: true, status: 'Pending' };
      st.files.push(entry);
      _autoDetectPageCount(entry, id);
    });
    refresh(id);
  }

  function onDrop(id, ev) {
    ev.preventDefault();
    ev.stopPropagation();
    const zone = ev.currentTarget;
    if (zone) zone.classList.remove('dragover');
    const st = state(id);
    if (st.running) return;
    const dropped = Array.from((ev.dataTransfer && ev.dataTransfer.files) || []);
    if (!dropped.length) return;
    dropped.forEach(function (f) {
      const entry = { uid: st.nextId++, file: f, selected: true, status: 'Pending' };
      st.files.push(entry);
      _autoDetectPageCount(entry, id);
    });
    refresh(id);
  }

  function onDragOver(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.currentTarget) ev.currentTarget.classList.add('dragover');
  }

  function onDragLeave(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.currentTarget) ev.currentTarget.classList.remove('dragover');
  }

  function toggleAll(id, checked) {
    state(id).files.forEach(function (f) { f.selected = !!checked; });
    refresh(id);
  }

  function toggleSelect(id, uid, checked) {
    const f = state(id).files.find(function (x) { return x.uid === uid; });
    if (f) f.selected = !!checked;
  }

  function clear(id) {
    const st = state(id);
    st.files = []; st.log = []; st.nextId = 1;
    refresh(id);
  }

  async function start(id) {
    const svc = SERVICES[id];
    const st = state(id);
    if (!svc || st.running) return;

    // Some services (Merge, Image-to-PDF) combine ALL selected files into a
    // single output, so they get every file in one call instead of a loop.
    if (svc.batch) return startBatch(id);

    const selected = st.files.filter(function (f) { return f.selected !== false; });
    if (!selected.length) {
      addLog(id, 'System > No files selected', 'Failed');
      return refresh(id);
    }

    st.running = true; st.stopped = false;
    refresh(id);

    const runConfig = await _resolveRunConfig(id);
    const runCtx = _createRunCtx(id, runConfig);
    const ctx = {
      log: function (msg, status) { addLog(id, msg, status); refresh(id); },
      download: function (blob, filename) { return runCtx.download(blob, filename); },
      shouldStop: function () { return st.stopped; }
    };

    try {
      for (let i = 0; i < selected.length; i++) {
        const entry = selected[i];
        const label = `File(${i + 1}/${selected.length})`;
        entry.status = 'Processing';
        entry.progress = 5;
        ctx.log(`${label} > File Processing > ${entry.file.name}`, 'Info');
        refresh(id);
        try {
          // Services can report progress for the file they're working on.
          ctx.progress = function (pct) { entry.progress = Math.max(0, Math.min(100, Math.round(pct))); refresh(id); };
          ctx.pages = function (n) { entry.pageCount = n; refresh(id); };
          await svc.process([entry.file], ctx, label);
          entry.status = 'Success';
          entry.progress = 100;
          entry.selected = false; // Item 8 - processed files auto-uncheck
        } catch (e) {
          entry.status = 'Failed';
          entry.error = e.message || 'Processing failed';
          ctx.log(`${label} > Error > ${entry.error}`, 'Failed');
        }
        refresh(id);
      }
      await runCtx.finalize();
    } finally {
      st.running = false;
      refresh(id);
    }
  }

  // Services whose work spans ALL selected files at once (e.g. Merge)
  // rather than one file at a time.
  async function startBatch(id) {
    const svc = SERVICES[id];
    const st = state(id);
    if (!svc || st.running) return;
    const selected = st.files.filter(function (f) { return f.selected !== false; }).map(function (f) { return f.file; });
    if (!selected.length) {
      addLog(id, 'System > No files selected', 'Failed');
      return refresh(id);
    }
    st.running = true; st.stopped = false;
    refresh(id);
    const runConfig = await _resolveRunConfig(id);
    const runCtx = _createRunCtx(id, runConfig);
    const ctx = {
      log: function (msg, status) { addLog(id, msg, status); refresh(id); },
      download: function (blob, filename) { return runCtx.download(blob, filename); },
      shouldStop: function () { return st.stopped; }
    };
    try {
      ctx.progress = function (pct) {
        const v = Math.max(0, Math.min(100, Math.round(pct)));
        st.files.forEach(function (f) { if (f.selected !== false) f.progress = v; });
        refresh(id);
      };
      ctx.pages = function () {};
      st.files.forEach(function (f) { if (f.selected !== false) { f.status = 'Processing'; f.progress = 5; } });
      refresh(id);
      await svc.process(selected, ctx, 'Batch');
      st.files.forEach(function (f) { if (f.selected !== false) { f.status = 'Success'; f.progress = 100; f.selected = false; } });
      await runCtx.finalize();
    } catch (e) {
      ctx.log(`Error > ${e.message || 'Processing failed'}`, 'Failed');
      st.files.forEach(function (f) { if (f.selected !== false) { f.status = 'Failed'; f.error = e.message; } });
    } finally {
      st.running = false;
      refresh(id);
    }
  }

  function register(def) {
    SERVICES[def.id] = def;
  }

  // Lets the Other Services landing page list every registered tool without
  // each module also having to declare itself in a second place.
  function list() {
    return Object.keys(SERVICES).map(function (id) {
      const s = SERVICES[id];
      return { id: id, label: s.title, icon: s.icon, desc: s.description || '' };
    });
  }

  window.ServiceRunner = {
    register: register,
    list: list,
    render: render,
    refresh: refresh,
    has: function (id) { return Object.prototype.hasOwnProperty.call(SERVICES, id); },
    state: state,
    onPick: onPick,
    onDrop: onDrop,
    onDragOver: onDragOver,
    onDragLeave: onDragLeave,
    verifyConnection: verifyConnection,
    toggleSelect: toggleSelect,
    toggleAll: toggleAll,
    clear: clear,
    start: start,
    startBatch: startBatch,
    download: downloadBlob,
    smartDownload: smartDownload
  };
})();
