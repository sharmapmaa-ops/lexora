/* storage-destinations.js — "Where should the output go?" selector for
 * paid services that produce a downloadable file.
 *
 * Everything runs in the browser, with credentials the PERSON pastes in
 * themselves - Lexora never registers an OAuth app with any of these
 * providers, so there's no Client ID to configure anywhere. Instead,
 * each provider has its own way of generating a personal access token
 * (a Bearer token, exactly as if a real OAuth flow had already
 * happened) directly from that provider's own developer console/site -
 * the person does that once, pastes the result into the fields below,
 * and Lexora just uses it directly for the API calls. This is the same
 * pattern as the reference project shared for this feature.
 *
 * This is different from the existing ShareFile/SharePoint integration
 * in py/server.py (that one is server-managed, using Lexora's own
 * registered app + a server-side OAuth callback) - this module is
 * fully browser-side and per-person.
 */
(function () {
  'use strict';

  const PROVIDERS = [
    { id: 'local', name: 'Local System', icon: '💻', desc: 'Download directly to your computer (default)' },
    { id: 'google-drive', name: 'Google Drive', icon: '📁', desc: 'Save to a folder in your Google Drive account' },
    { id: 'dropbox', name: 'Dropbox', icon: '📦', desc: 'Save to a Dropbox folder via the Dropbox API' },
    { id: 'box', name: 'Box', icon: '🗃️', desc: 'Save to a Box folder via the Box Content API' },
    { id: 'sharepoint', name: 'SharePoint', icon: '🏢', desc: 'Upload to a SharePoint document library via Microsoft Graph' },
    { id: 'onedrive', name: 'OneDrive', icon: '☁️', desc: 'Save to OneDrive for Business via Microsoft Graph' },
    { id: 'sharefile', name: 'ShareFile', icon: '🔐', desc: 'Citrix ShareFile secure DMS via the ShareFile API' },
    { id: 'webdav', name: 'WebDAV', icon: '🌐', desc: 'Any WebDAV-compatible server (NextCloud, ownCloud, etc.)' },
    { id: 'sftp', name: 'SFTP', icon: '🖥️', desc: 'Upload via SFTP to your organisation\'s file server' },
  ];

  // Which credential fields each provider needs, and where to go get
  // them. type 'password' just masks the input visually - these are
  // still stored/sent the same as any other field.
  const CRED_FIELDS = {
    'google-drive': [
      { key: 'accessToken', label: 'OAuth Access Token', type: 'password', hint: 'A Bearer token from Google OAuth 2.0 (e.g. via OAuth Playground with the Drive API scope)' },
      { key: 'folderId', label: 'Folder ID (optional)', type: 'text', hint: 'Google Drive folder ID to save into - leave blank for My Drive root' },
    ],
    dropbox: [
      { key: 'accessToken', label: 'Access Token', type: 'password', hint: 'Dropbox App Console → your app → OAuth 2 → Generated access token' },
      { key: 'folder', label: 'Target Folder', type: 'text', hint: 'Dropbox path, e.g. /Lexora/Output', default: '/Lexora/Output' },
    ],
    box: [
      { key: 'accessToken', label: 'Developer Token', type: 'password', hint: 'Box Developer Console → your app → Developer Token' },
      { key: 'folderId', label: 'Folder ID', type: 'text', hint: 'Box folder ID (0 = root) - visible in the URL when viewing the folder', default: '0' },
    ],
    sharepoint: [
      { key: 'accessToken', label: 'Microsoft Graph Token', type: 'password', hint: 'A Bearer token from Azure AD / MSAL with Sites.ReadWrite.All' },
      { key: 'siteId', label: 'SharePoint Site ID', type: 'text', hint: 'e.g. yourcompany.sharepoint.com,{site-guid},{web-guid}' },
      { key: 'folder', label: 'Document Library Path', type: 'text', hint: 'Server-relative path inside the site', default: '/Shared Documents/Lexora' },
    ],
    onedrive: [
      { key: 'accessToken', label: 'Microsoft Graph Token', type: 'password', hint: 'A Bearer token from Azure AD / MSAL with Files.ReadWrite' },
      { key: 'folder', label: 'OneDrive Folder Path', type: 'text', hint: 'Path in your OneDrive, e.g. Documents/Lexora', default: 'Lexora/Output' },
    ],
    sharefile: [
      { key: 'subdomain', label: 'ShareFile Subdomain', type: 'text', hint: 'Your Citrix ShareFile subdomain (e.g. yourcompany)' },
      { key: 'apiKey', label: 'API Bearer Token', type: 'password', hint: 'ShareFile developer portal → OAuth client credentials' },
      { key: 'folderId', label: 'Folder ID', type: 'text', hint: 'ShareFile folder ID (from the folder\'s URL) - leave blank for Home', default: 'home' },
    ],
    webdav: [
      { key: 'serverUrl', label: 'Server URL', type: 'text', hint: 'Full base URL of your WebDAV server' },
      { key: 'username', label: 'Username', type: 'text', hint: 'WebDAV login username' },
      { key: 'password', label: 'Password', type: 'password', hint: 'WebDAV login password' },
      { key: 'folder', label: 'Remote Folder', type: 'text', hint: 'Folder path on the server', default: '/Lexora' },
    ],
    sftp: [
      { key: 'serverUrl', label: 'Server Hostname', type: 'text', hint: 'SFTP server hostname or IP' },
      { key: 'username', label: 'Username', type: 'text', hint: 'SFTP username' },
      { key: 'password', label: 'Password', type: 'password', hint: 'Password (or note your key setup) - browsers can\'t do SFTP directly, see note below' },
      { key: 'folder', label: 'Remote Path', type: 'text', hint: 'Absolute path on the server', default: '/home/user/lexora' },
    ],
  };

  function storageKey(provider) { return `lexora_storage_creds_${provider}`; }

  function getCreds(provider) {
    try {
      const raw = localStorage.getItem(storageKey(provider));
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }

  function setCreds(provider, data) {
    localStorage.setItem(storageKey(provider), JSON.stringify(data));
  }

  function clearCreds(provider) {
    localStorage.removeItem(storageKey(provider));
  }

  function isConfigured(provider) {
    if (provider === 'local') return true;
    const fields = CRED_FIELDS[provider] || [];
    const creds = getCreds(provider);
    // "Configured" = every field without a default has something in it -
    // fields with a default (folder paths etc.) are optional.
    return fields.every(f => f.default !== undefined || (creds[f.key] && creds[f.key].trim()));
  }

  function providerName(provider) {
    const p = PROVIDERS.find(x => x.id === provider);
    return p ? p.name : provider;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── UI: the <select> + configure status, dropped into any setup card ──
  function renderSelectorHtml(inputId) {
    return `
      <div class="setup-group">
        <label>Save output to</label>
        <select id="${inputId}" onchange="StorageDestinations.onSelectChange('${inputId}')" style="width:100%;">
          ${PROVIDERS.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}
        </select>
        <div id="${inputId}Status" style="margin-top:6px;font-size:0.8rem;color:rgba(0,0,0,0.55);"></div>
      </div>`;
  }

  function refreshStatus(inputId) {
    const sel = document.getElementById(inputId);
    const statusEl = document.getElementById(inputId + 'Status');
    if (!sel || !statusEl) return;
    const provider = sel.value;
    if (provider === 'local') { statusEl.textContent = ''; return; }
    if (provider === 'sftp') {
      statusEl.innerHTML = isConfigured(provider)
        ? `<span style="color:#1b5e20;">✓ Configured</span> - <a onclick="StorageDestinations.openConfig('${provider}', '${inputId}')" style="cursor:pointer;color:#1257f5;">edit</a> · <span style="color:rgba(0,0,0,0.5);">browsers can't upload via SFTP directly - the file downloads locally with upload instructions.</span>`
        : `<a onclick="StorageDestinations.openConfig('${provider}', '${inputId}')" style="cursor:pointer;color:#1257f5;font-weight:600;">Set up ${providerName(provider)}…</a>`;
      return;
    }
    if (isConfigured(provider)) {
      statusEl.innerHTML = `<span style="color:#1b5e20;">✓ Configured</span> - <a onclick="StorageDestinations.openConfig('${provider}', '${inputId}')" style="cursor:pointer;color:#1257f5;">edit</a> · <a onclick="StorageDestinations.disconnect('${provider}', '${inputId}')" style="cursor:pointer;color:#b3261e;">remove</a>`;
    } else {
      statusEl.innerHTML = `<a onclick="StorageDestinations.openConfig('${provider}', '${inputId}')" style="cursor:pointer;color:#1257f5;font-weight:600;">Set up ${providerName(provider)}…</a>`;
    }
  }

  function onSelectChange(inputId) { refreshStatus(inputId); }

  function disconnect(provider, inputId) {
    clearCreds(provider);
    if (inputId) refreshStatus(inputId);
  }

  // ── Credential entry modal - one small form per provider ─────────────
  function openConfig(provider, inputId) {
    const fields = CRED_FIELDS[provider] || [];
    const creds = getCreds(provider);
    const existing = document.getElementById('storageConfigOverlay');
    if (existing) existing.remove();

    const html = `
      <div class="admin-modal-overlay" id="storageConfigOverlay">
        <div class="admin-modal-card message-popup-card" style="max-width:440px;">
          <button class="admin-modal-close" onclick="StorageDestinations.closeConfig()">✕</button>
          <h3 class="admin-modal-title">${esc(providerName(provider))}</h3>
          <p style="font-size:0.82rem;color:rgba(0,0,0,0.55);margin:0 0 14px;">
            Paste your own ${esc(providerName(provider))} credentials below - generated from your own account,
            nothing is shared with Lexora's servers, this stays in your browser only.
          </p>
          ${fields.map(f => `
            <div class="setup-group" style="margin-bottom:10px;">
              <label>${esc(f.label)}</label>
              <input type="${f.type}" id="storageCredField_${f.key}"
                     value="${esc(creds[f.key] != null ? creds[f.key] : (f.default || ''))}"
                     placeholder="${esc(f.hint)}" style="width:100%;" />
              <div style="font-size:0.74rem;color:rgba(0,0,0,0.45);margin-top:2px;">${esc(f.hint)}</div>
            </div>`).join('')}
          ${provider === 'sftp' ? `
            <div style="margin-top:6px;padding:8px 10px;background:#fff8e1;border:1px solid #e0a800;border-radius:6px;font-size:0.78rem;color:#7a5c00;">
              Browsers can't speak SFTP directly - saving this just means the file will download locally with
              a ready-to-copy SFTP command using these details, instead of you having to type it from scratch.
            </div>` : ''}
          <div class="admin-modal-actions" style="margin-top:14px;">
            <button class="admin-modal-cancel" onclick="StorageDestinations.closeConfig()">Cancel</button>
            <button class="admin-modal-save" onclick="StorageDestinations.saveConfig('${provider}', '${inputId}')">Save</button>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  }

  function closeConfig() {
    const overlay = document.getElementById('storageConfigOverlay');
    if (overlay) overlay.remove();
  }

  function saveConfig(provider, inputId) {
    const fields = CRED_FIELDS[provider] || [];
    const data = {};
    fields.forEach(f => {
      const el = document.getElementById('storageCredField_' + f.key);
      data[f.key] = el ? el.value.trim() : '';
    });
    setCreds(provider, data);
    closeConfig();
    if (inputId) refreshStatus(inputId);
  }

  // ── Upload implementations - each just uses the pasted Bearer token
  //    directly, exactly like it would if a real OAuth flow had handed
  //    it over. ──────────────────────────────────────────────────────
  async function uploadGoogleDrive(blob, filename) {
    const c = getCreds('google-drive');
    if (!c.accessToken) throw new Error('Google Drive is not set up yet.');
    const meta = JSON.stringify({ name: filename, parents: c.folderId ? [c.folderId] : [] });
    const form = new FormData();
    form.append('metadata', new Blob([meta], { type: 'application/json' }));
    form.append('file', blob, filename);
    const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST', headers: { Authorization: 'Bearer ' + c.accessToken }, body: form,
    });
    if (!res.ok) throw new Error('Google Drive upload failed (' + res.status + ') - check your token.');
  }

  async function uploadDropbox(blob, filename) {
    const c = getCreds('dropbox');
    if (!c.accessToken) throw new Error('Dropbox is not set up yet.');
    const path = ((c.folder || '/Lexora/Output') + '/' + filename).replace(/\/+/g, '/');
    const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + c.accessToken,
        'Dropbox-API-Arg': JSON.stringify({ path: path, mode: 'add', autorename: true, mute: false }),
        'Content-Type': 'application/octet-stream',
      },
      body: blob,
    });
    if (!res.ok) throw new Error('Dropbox upload failed (' + res.status + ') - check your token.');
  }

  async function uploadBox(blob, filename) {
    const c = getCreds('box');
    if (!c.accessToken) throw new Error('Box is not set up yet.');
    const form = new FormData();
    form.append('attributes', JSON.stringify({ name: filename, parent: { id: c.folderId || '0' } }));
    form.append('file', blob, filename);
    const res = await fetch('https://upload.box.com/api/2.0/files/content', {
      method: 'POST', headers: { Authorization: 'Bearer ' + c.accessToken }, body: form,
    });
    if (!res.ok) throw new Error('Box upload failed (' + res.status + ') - check your token or folder ID.');
  }

  async function uploadSharePoint(blob, filename) {
    const c = getCreds('sharepoint');
    if (!c.accessToken || !c.siteId) throw new Error('SharePoint is not set up yet.');
    const path = ((c.folder || '/Shared Documents/Lexora') + '/' + filename).replace(/\/+/g, '/');
    const res = await fetch(`https://graph.microsoft.com/v1.0/sites/${c.siteId}/drive/root:${encodeURI(path)}:/content`, {
      method: 'PUT', headers: { Authorization: 'Bearer ' + c.accessToken }, body: blob,
    });
    if (!res.ok) throw new Error('SharePoint upload failed (' + res.status + ') - check your token and Site ID.');
  }

  async function uploadOneDrive(blob, filename) {
    const c = getCreds('onedrive');
    if (!c.accessToken) throw new Error('OneDrive is not set up yet.');
    const path = ((c.folder || 'Lexora/Output') + '/' + filename).replace(/^\/+/, '');
    const res = await fetch(`https://graph.microsoft.com/v1.0/me/drive/root:/${encodeURI(path)}:/content`, {
      method: 'PUT', headers: { Authorization: 'Bearer ' + c.accessToken }, body: blob,
    });
    if (!res.ok) throw new Error('OneDrive upload failed (' + res.status + ') - check your token.');
  }

  async function uploadShareFile(blob, filename) {
    const c = getCreds('sharefile');
    if (!c.apiKey || !c.subdomain) throw new Error('ShareFile is not set up yet.');
    const baseUrl = `https://${c.subdomain}.sf-api.com/sf/v3/`;
    const folderId = c.folderId || 'home';
    const infoRes = await fetch(`${baseUrl}Items(${folderId})/Upload2?method=standard&raw=true&fileName=${encodeURIComponent(filename)}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + c.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ Method: 'standard', FileName: filename, FileSize: blob.size, Overwrite: true }),
    });
    const info = await infoRes.json();
    if (!info.ChunkUri) throw new Error('ShareFile did not return an upload URL - check your token and subdomain.');
    const uploadRes = await fetch(info.ChunkUri, { method: 'POST', body: blob });
    if (!uploadRes.ok) throw new Error('ShareFile upload failed (' + uploadRes.status + ').');
  }

  async function uploadWebdav(blob, filename) {
    const c = getCreds('webdav');
    if (!c.serverUrl) throw new Error('WebDAV is not set up yet.');
    const url = c.serverUrl.replace(/\/+$/, '') + (c.folder || '/Lexora') + '/' + filename;
    const headers = { 'Content-Type': 'application/octet-stream' };
    if (c.username && c.password) headers.Authorization = 'Basic ' + btoa(c.username + ':' + c.password);
    const res = await fetch(url, { method: 'PUT', headers: headers, body: blob });
    if (!res.ok) {
      throw new Error('WebDAV upload failed (' + res.status + ') - many WebDAV servers also block browser ' +
        'uploads unless CORS is specifically enabled server-side; check with whoever manages it.');
    }
  }

  // Browsers can't speak SFTP - always "fails over" to local download,
  // then shows a ready-to-copy terminal command using the saved details.
  function showSftpInstructions(filename) {
    const c = getCreds('sftp');
    const cmd = `sftp ${esc(c.username || 'username')}@${esc(c.serverUrl || 'your-server.com')}\ncd ${esc(c.folder || '/Lexora')}\nput ~/Downloads/${esc(filename)}`;
    const existing = document.getElementById('sftpInstructionsOverlay');
    if (existing) existing.remove();
    const html = `
      <div class="admin-modal-overlay" id="sftpInstructionsOverlay">
        <div class="admin-modal-card message-popup-card" style="max-width:460px;">
          <button class="admin-modal-close" onclick="document.getElementById('sftpInstructionsOverlay').remove()">✕</button>
          <h3 class="admin-modal-title">🖥️ SFTP Upload Instructions</h3>
          <p style="font-size:0.84rem;color:rgba(0,0,0,0.6);margin:0 0 12px;">
            Browsers can't perform SFTP transfers directly. Your file has downloaded locally -
            use the command below (or an app like FileZilla/WinSCP/Cyberduck) to send it to your server.
          </p>
          <pre style="background:#0b1533;color:#7de3c8;padding:12px 14px;border-radius:8px;font-size:0.8rem;line-height:1.7;white-space:pre-wrap;">${cmd}</pre>
          <div class="admin-modal-actions" style="margin-top:14px;">
            <button class="admin-modal-save" onclick="document.getElementById('sftpInstructionsOverlay').remove()">OK</button>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  }

  // ── Public API ────────────────────────────────────────────────────
  // Called by each service after it has a finished file - handles
  // routing to whichever destination the person picked. Falls back to a
  // normal local download if the destination isn't set up, so a file is
  // never silently lost.
  async function saveFile(inputId, blob, filename) {
    const sel = document.getElementById(inputId);
    const provider = sel ? sel.value : 'local';
    return saveFileToProvider(provider, blob, filename);
  }

  async function saveFileToProvider(provider, blob, filename) {
    if (provider === 'sftp') {
      localDownload(blob, filename);
      if (isConfigured('sftp')) showSftpInstructions(filename);
      return { provider: 'local' };
    }

    if (provider === 'local' || !isConfigured(provider)) {
      localDownload(blob, filename);
      return { provider: 'local' };
    }

    const uploaders = {
      'google-drive': uploadGoogleDrive, dropbox: uploadDropbox, box: uploadBox,
      sharepoint: uploadSharePoint, onedrive: uploadOneDrive, sharefile: uploadShareFile,
      webdav: uploadWebdav,
    };
    await uploaders[provider](blob, filename);
    return { provider: provider };
  }

  function localDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  window.StorageDestinations = {
    PROVIDERS: PROVIDERS,
    renderSelectorHtml: renderSelectorHtml,
    refreshStatus: refreshStatus,
    onSelectChange: onSelectChange,
    openConfig: openConfig,
    closeConfig: closeConfig,
    saveConfig: saveConfig,
    disconnect: disconnect,
    isConfigured: isConfigured,
    saveFile: saveFile,
    saveFileToProvider: saveFileToProvider,
    labelFor: providerName,
  };
})();
