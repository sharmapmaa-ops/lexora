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
  function statusClass(s) {
    if (s === 'Success') return 'completed';
    if (s === 'Failed') return 'error';
    if (s === 'Processing') return 'processing';
    return 'pending';
  }

  function fileRows(id) {
    const st = state(id);
    if (!st.files.length) {
      return `<tr><td colspan="5" style="text-align:center;color:rgba(0,0,0,0.45);">No files uploaded yet.</td></tr>`;
    }
    return st.files.map(function (f, i) {
      return `
        <tr>
          <td><input type="checkbox" ${f.selected !== false ? 'checked' : ''} ${st.running ? 'disabled' : ''}
                     onchange="ServiceRunner.toggleSelect('${id}', ${f.uid}, this.checked)" /></td>
          <td>${i + 1}</td>
          <td>${esc(f.file.name)}</td>
          <td>${(f.file.size / 1024).toFixed(0)} KB</td>
          <td><span class="activity-result ${statusClass(f.status)}">${esc(f.status || 'Pending')}</span></td>
        </tr>`;
    }).join('');
  }

  function logRows(id) {
    const st = state(id);
    if (!st.log.length) {
      return `<tr><td colspan="3" style="text-align:center;color:rgba(0,0,0,0.45);">No activity yet.</td></tr>`;
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

    return `
      <div class="content-section">
        <h3>${svc.icon} ${esc(svc.title)}</h3>
        ${svc.description ? `<p style="color:#555;margin:-2px 0 12px 0;font-size:0.9rem;">${svc.description}</p>` : ''}
      </div>

      ${setup ? `<div class="content-section"><h3>⚙️ Setup</h3>${setup}</div>` : ''}

      <div class="content-section">
        <h3>📤 Upload Files</h3>
        <input type="file" id="srInput_${id}" ${svc.multiple === false ? '' : 'multiple'}
               accept="${svc.accept || ''}" ${st.running ? 'disabled' : ''}
               onchange="ServiceRunner.onPick('${id}', event)" />
        <div style="margin-top:14px;overflow:auto;">
          <table class="admin-json-table" style="width:100%;">
            <thead><tr><th style="width:36px;"></th><th style="width:44px;">#</th><th>File</th><th style="width:90px;">Size</th><th style="width:110px;">Status</th></tr></thead>
            <tbody>${fileRows(id)}</tbody>
          </table>
        </div>
        <div style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap;">
          <button class="filter-btn" ${st.running ? 'disabled' : ''} onclick="ServiceRunner.start('${id}')">▶️ Start</button>
          <button class="filter-btn" ${st.running ? 'disabled' : ''} onclick="ServiceRunner.clear('${id}')">🗑️ Clear</button>
        </div>
      </div>

      <div class="content-section">
        <h3>📋 Activity Log</h3>
        <div style="max-height:320px;overflow:auto;">
          <table class="admin-json-table" style="width:100%;">
            <thead><tr><th style="width:140px;">Date &amp; Time</th><th>Activity</th><th style="width:110px;">Status</th></tr></thead>
            <tbody id="srLog_${id}">${logRows(id)}</tbody>
          </table>
        </div>
      </div>

      <p style="font-size:0.78rem;color:rgba(0,0,0,0.45);">
        Runs entirely in your browser - your files are never uploaded${svc.freeNote === false ? '' : ', and this service is free to use'}.
      </p>`;
  }

  function refresh(id) {
    // Re-render in place if this service's page is currently showing.
    const host = document.getElementById('contentBody');
    if (!host) return;
    if (!document.getElementById('srInput_' + id)) return;
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
        ctx.log(`${label} > Processing > ${entry.file.name}`, 'Info');
        try {
          await svc.process([entry.file], ctx, label);
          entry.status = 'Success';
        } catch (e) {
          entry.status = 'Failed';
          ctx.log(`${label} > Error > ${e.message || 'Processing failed'}`, 'Failed');
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
      await svc.process(selected, ctx, 'Batch');
      st.files.forEach(function (f) { if (f.selected !== false) f.status = 'Success'; });
    } catch (e) {
      ctx.log(`Error > ${e.message || 'Processing failed'}`, 'Failed');
      st.files.forEach(function (f) { if (f.selected !== false) f.status = 'Failed'; });
    } finally {
      st.running = false;
      refresh(id);
    }
  }

  function register(def) {
    SERVICES[def.id] = def;
  }

  window.ServiceRunner = {
    register: register,
    render: render,
    refresh: refresh,
    has: function (id) { return Object.prototype.hasOwnProperty.call(SERVICES, id); },
    state: state,
    onPick: onPick,
    toggleSelect: toggleSelect,
    clear: clear,
    start: start,
    startBatch: startBatch,
    download: downloadBlob
  };
})();
