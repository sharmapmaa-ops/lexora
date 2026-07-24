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
    if (!STATE[id]) STATE[id] = { files: [], log: [], running: false, stopped: false, nextId: 1 };
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
        ? '<span class="file-action-link disabled">Done</span>'
        : (f.status === 'Failed'
            ? `<span class="file-action-link error-link" title="${esc(f.error || 'Failed')}">⚠</span>`
            : `<span class="file-action-link disabled" title="${esc(f.status || 'Pending')}">${f.status === 'Processing' ? '\u23f3' : '\u2022'}</span>`);
      return `
        <tr>
          <td><input type="checkbox" class="file-select-checkbox" ${f.selected !== false ? 'checked' : ''}
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

  function render(id) {
    const svc = SERVICES[id];
    if (!svc) return '<div class="content-section"><p>This service is not available.</p></div>';
    const st = state(id);
    const setup = typeof svc.setupHtml === 'function' ? svc.setupHtml(st) : '';
    const countText = st.files.length ? `${st.files.length} file(s) uploaded` : 'No files uploaded yet';
    const accept = svc.accept || '';
    const browseHint = svc.browseHint || (accept.indexOf('image') !== -1 ? 'or click to browse (JPG / PNG)' : 'or click to browse (PDF only)');

    const backBar = svc.backTo ? `<div style="margin-bottom:14px;">
          <button class="process-btn clear-btn" onclick="${svc.backTo}">← Back to Other Services</button>
        </div>` : '';

    return `
      <div>
        ${backBar}
        <div class="service-page-grid">
          <div class="service-col">
          <div class="service-card">
            <h3>📤 Upload File(s)</h3>
            <div class="card-body">
              <div class="drop-zone" onclick="${st.running ? 'void(0)' : `document.getElementById('srIn_${id}').click()`}"
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
              ${setup}
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
            <span class="file-list-charge-estimate">${svc.freeNote === false ? '' : '🎁 Free - runs in your browser'}</span>
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
          </div>
        </div>`;
  }

  function refresh(id) {
    const host = document.getElementById('contentBody');
    if (!host) return;
    if (!document.getElementById('srIn_' + id)) return;
    host.innerHTML = render(id);
  }

  // ── interactions ───────────────────────────────────────────────────
  function onPick(id, ev) {
    const st = state(id);
    const picked = Array.from((ev.target && ev.target.files) || []);
    picked.forEach(function (f) {
      st.files.push({ uid: st.nextId++, file: f, selected: true, status: 'Pending' });
    });
    refresh(id);
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

    const ctx = {
      log: function (msg, status) { addLog(id, msg, status); refresh(id); },
      download: downloadBlob,
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
        } catch (e) {
          entry.status = 'Failed';
          entry.error = e.message || 'Processing failed';
          ctx.log(`${label} > Error > ${entry.error}`, 'Failed');
        }
        refresh(id);
      }
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
    const ctx = {
      log: function (msg, status) { addLog(id, msg, status); refresh(id); },
      download: downloadBlob,
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
      st.files.forEach(function (f) { if (f.selected !== false) { f.status = 'Success'; f.progress = 100; } });
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
    toggleSelect: toggleSelect,
    toggleAll: toggleAll,
    clear: clear,
    start: start,
    startBatch: startBatch,
    download: downloadBlob
  };
})();
