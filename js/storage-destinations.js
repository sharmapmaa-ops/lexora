/* storage-destinations.js — "Where should the output go?" selector for
 * paid services that produce a downloadable file.
 *
 * Everything here runs in the browser, with the PERSON'S OWN credentials -
 * Lexora's server never sees the file or the destination account's
 * token. This is different from the existing ShareFile/SharePoint
 * integration in py/server.py (that one is server-managed, using
 * Lexora's own registered app + a server-side OAuth callback). This
 * module is the opposite: browser-managed, per-person connections.
 *
 * STATUS PER PROVIDER (be honest about what's real vs not yet built):
 *   - Local:        always works (existing browser download).
 *   - Google Drive: fully implemented (Google Identity Services token
 *                   client + Drive API v3 direct upload).
 *   - Dropbox:      fully implemented (Dropbox OAuth2 implicit grant +
 *                   Dropbox API v2 direct upload).
 *   - Box, OneDrive, SharePoint, ShareFile, WebDAV, SFTP: selectable in
 *     the UI (per the requested 9 options) but not yet wired up - see
 *     connect() below. Each remaining one is its own integration
 *     (different OAuth flow + upload API) and needs to be built the same
 *     incremental way Google Drive/Dropbox were. SFTP specifically is a
 *     raw TCP/SSH protocol, not something a browser can speak at all -
 *     that one needs a small server-side relay no matter what, there's
 *     no browser-only way to do it.
 */
(function () {
  'use strict';

  const PROVIDERS = [
    { id: 'local', label: 'Local (browser download)' },
    { id: 'google-drive', label: 'Google Drive' },
    { id: 'dropbox', label: 'Dropbox' },
    { id: 'box', label: 'Box' },
    { id: 'sharepoint', label: 'SharePoint' },
    { id: 'onedrive', label: 'OneDrive' },
    { id: 'sharefile', label: 'ShareFile' },
    { id: 'webdav', label: 'WebDAV' },
    { id: 'sftp', label: 'SFTP' },
  ];

  const IMPLEMENTED = { local: true, 'google-drive': true, dropbox: true, box: true, onedrive: true, sharepoint: true, webdav: true };

  // ShareFile is deliberately NOT implemented here. Its OAuth2 token
  // exchange requires a client secret (a "confidential client") - there
  // is no secretless/PKCE path for it the way Box and Dropbox offer.
  // Embedding that secret in browser code would mean every visitor's
  // browser could read it in plain text, which defeats the whole point
  // of a secret. ShareFile stays on the existing SERVER-managed
  // integration (py/server.py's /api/integrations/callback) instead -
  // that's not a limitation of this feature, it's the secure way to use
  // ShareFile's own OAuth design.

  // Public Client IDs (not secret - these are meant to be embedded in
  // frontend code for this exact "implicit grant" flow) come from the
  // Admin-configurable settings below, falling back to a global set by
  // index.html if present. Nothing here ever touches the server for the
  // actual file transfer - only to read these public IDs.
  function getClientId(provider) {
    const cfg = window.LEXORA_STORAGE_CLIENT_IDS || {};
    return cfg[provider] || '';
  }

  function storageKey(provider) { return `lexora_storage_conn_${provider}`; }

  function getConnection(provider) {
    try {
      const raw = localStorage.getItem(storageKey(provider));
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function setConnection(provider, data) {
    localStorage.setItem(storageKey(provider), JSON.stringify(data));
  }

  function clearConnection(provider) {
    localStorage.removeItem(storageKey(provider));
  }

  function isConnected(provider) {
    if (provider === 'local') return true;
    const c = getConnection(provider);
    return !!(c && c.accessToken && (!c.expiresAt || c.expiresAt > Date.now()));
  }

  // ── UI: the <select> + connect status, dropped into any setup card ──
  const NOT_YET_LABEL = { sftp: ' (not supported from a browser)', sharefile: ' (managed by your Admin, not here)' };

  function renderSelectorHtml(inputId) {
    return `
      <div class="setup-group">
        <label>Save output to</label>
        <select id="${inputId}" onchange="StorageDestinations.onSelectChange('${inputId}')" style="width:100%;">
          ${PROVIDERS.map(p => `<option value="${p.id}">${p.label}${IMPLEMENTED[p.id] ? '' : (NOT_YET_LABEL[p.id] || ' (not connected yet)')}</option>`).join('')}
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
    if (!IMPLEMENTED[provider]) {
      const msg = provider === 'sftp'
        ? 'A browser can\'t speak SFTP directly (it\'s not a web protocol) - this would need a small server-side relay. The file will download locally instead.'
        : provider === 'sharefile'
          ? 'ShareFile is managed by your Admin (server-side), not connected here individually. The file will download locally instead.'
          : 'This destination isn\'t connected yet - the file will download locally instead.';
      statusEl.innerHTML = `<span style="color:#b3261e;">${msg}</span>`;
      return;
    }
    if (isConnected(provider)) {
      const c = getConnection(provider);
      statusEl.innerHTML = `<span style="color:#1b5e20;">✓ Connected${c.accountLabel ? ' as ' + escapeHtmlLocal(c.accountLabel) : ''}</span> - <a onclick="StorageDestinations.disconnect('${provider}', '${inputId}')" style="cursor:pointer;color:#1257f5;">disconnect</a>`;
    } else {
      statusEl.innerHTML = `<a onclick="StorageDestinations.connect('${provider}', '${inputId}')" style="cursor:pointer;color:#1257f5;font-weight:600;">Connect ${labelFor(provider)}…</a>`;
    }
  }

  function labelFor(provider) {
    const p = PROVIDERS.find(x => x.id === provider);
    return p ? p.label : provider;
  }

  function escapeHtmlLocal(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function onSelectChange(inputId) { refreshStatus(inputId); }

  // ── Google Drive: Google Identity Services token client ─────────────
  let gisLoaded = null;
  function loadGis() {
    if (gisLoaded) return gisLoaded;
    gisLoaded = new Promise((resolve, reject) => {
      if (window.google && window.google.accounts && window.google.accounts.oauth2) return resolve();
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load Google\'s sign-in library.'));
      document.head.appendChild(s);
    });
    return gisLoaded;
  }

  async function connectGoogleDrive() {
    const clientId = getClientId('google-drive');
    if (!clientId) throw new Error('Google Drive isn\'t configured yet - an Admin needs to add a Client ID in Admin Settings.');
    await loadGis();
    return new Promise((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: 'https://www.googleapis.com/auth/drive.file',
        callback: (resp) => {
          if (resp.error) { reject(new Error('Google Drive connection was cancelled or denied.')); return; }
          setConnection('google-drive', {
            accessToken: resp.access_token,
            expiresAt: Date.now() + (resp.expires_in || 3600) * 1000,
            accountLabel: '',
          });
          resolve();
        },
      });
      client.requestAccessToken();
    });
  }

  async function uploadGoogleDrive(blob, filename) {
    const conn = getConnection('google-drive');
    if (!conn) throw new Error('Not connected to Google Drive.');
    const metadata = { name: filename };
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', blob);
    const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + conn.accessToken },
      body: form,
    });
    if (!res.ok) throw new Error('Google Drive upload failed (' + res.status + ') - try reconnecting.');
    return res.json();
  }

  // ── Dropbox: OAuth2 implicit grant + Dropbox API v2 ──────────────────
  async function connectDropbox() {
    const clientId = getClientId('dropbox');
    if (!clientId) throw new Error('Dropbox isn\'t configured yet - an Admin needs to add an App key in Admin Settings.');
    const redirectUri = window.location.origin + window.location.pathname;
    const state = 'dbx_' + Math.random().toString(36).slice(2);
    sessionStorage.setItem('lexora_dropbox_state', state);
    const authUrl = 'https://www.dropbox.com/oauth2/authorize?' + new URLSearchParams({
      client_id: clientId, redirect_uri: redirectUri, response_type: 'token', state: state,
    }).toString();

    return new Promise((resolve, reject) => {
      const popup = window.open(authUrl, 'dropbox-connect', 'width=480,height=680');
      if (!popup) { reject(new Error('Please allow pop-ups to connect Dropbox.')); return; }
      const timer = setInterval(() => {
        try {
          if (popup.closed) { clearInterval(timer); reject(new Error('Dropbox connection was cancelled.')); return; }
          const url = popup.location.href;
          if (url.indexOf(redirectUri) !== 0) return;
          const hash = new URLSearchParams(popup.location.hash.slice(1));
          clearInterval(timer);
          popup.close();
          if (hash.get('state') !== state) { reject(new Error('Dropbox connection failed a security check - please try again.')); return; }
          const token = hash.get('access_token');
          if (!token) { reject(new Error('Dropbox did not return an access token.')); return; }
          setConnection('dropbox', { accessToken: token, expiresAt: null, accountLabel: '' });
          resolve();
        } catch (e) { /* still on Dropbox's domain - cross-origin read blocked until redirect back, keep polling */ }
      }, 500);
    });
  }

  async function uploadDropbox(blob, filename) {
    const conn = getConnection('dropbox');
    if (!conn) throw new Error('Not connected to Dropbox.');
    const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + conn.accessToken,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({ path: '/' + filename, mode: 'add', autorename: true, mute: false }),
      },
      body: blob,
    });
    if (!res.ok) throw new Error('Dropbox upload failed (' + res.status + ') - try reconnecting.');
    return res.json();
  }

  // ── Box: OAuth2 Authorization Code + PKCE (no client secret needed) ──
  function randomVerifier() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function pkceChallenge(verifier) {
    const data = new TextEncoder().encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function popupAndWaitForRedirect(authUrl, redirectUri, popupName) {
    return new Promise((resolve, reject) => {
      const popup = window.open(authUrl, popupName, 'width=480,height=680');
      if (!popup) { reject(new Error('Please allow pop-ups to connect.')); return; }
      const timer = setInterval(() => {
        try {
          if (popup.closed) { clearInterval(timer); reject(new Error('Connection was cancelled.')); return; }
          const url = popup.location.href;
          if (url.indexOf(redirectUri) !== 0) return;
          clearInterval(timer);
          const fullUrl = url;
          popup.close();
          resolve(fullUrl);
        } catch (e) { /* still on the provider's own domain - cross-origin read blocked until it redirects back */ }
      }, 500);
    });
  }

  async function connectBox() {
    const clientId = getClientId('box');
    if (!clientId) throw new Error('Box isn\'t configured yet - an Admin needs to add a Client ID in Admin Settings.');
    const redirectUri = window.location.origin + window.location.pathname;
    const state = 'box_' + Math.random().toString(36).slice(2);
    const verifier = randomVerifier();
    const challenge = await pkceChallenge(verifier);
    const authUrl = 'https://account.box.com/api/oauth2/authorize?' + new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
      state: state, code_challenge: challenge, code_challenge_method: 'S256',
    }).toString();

    const returnedUrl = await popupAndWaitForRedirect(authUrl, redirectUri, 'box-connect');
    const params = new URL(returnedUrl).searchParams;
    if (params.get('state') !== state) throw new Error('Box connection failed a security check - please try again.');
    const code = params.get('code');
    if (!code) throw new Error('Box did not return an authorization code.');

    const tokenRes = await fetch('https://api.box.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code: code, client_id: clientId,
        code_verifier: verifier, redirect_uri: redirectUri,
      }).toString(),
    });
    if (!tokenRes.ok) throw new Error('Box could not finish connecting - please try again.');
    const tok = await tokenRes.json();
    setConnection('box', {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token,
      expiresAt: Date.now() + (tok.expires_in || 3600) * 1000,
      accountLabel: '',
    });
  }

  async function uploadBox(blob, filename) {
    const conn = getConnection('box');
    if (!conn) throw new Error('Not connected to Box.');
    const form = new FormData();
    form.append('attributes', JSON.stringify({ name: filename, parent: { id: '0' } }));
    form.append('file', blob, filename);
    const res = await fetch('https://upload.box.com/api/2.0/files/content', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + conn.accessToken },
      body: form,
    });
    if (!res.ok) throw new Error('Box upload failed (' + res.status + ') - try reconnecting.');
    return res.json();
  }

  // ── OneDrive / SharePoint: Microsoft Graph, implicit grant ───────────
  // Both use the same Microsoft sign-in - SharePoint just targets a
  // different drive (a specific site's document library) instead of the
  // person's own OneDrive root. One connection covers both.
  async function connectMicrosoft(scope, storageProvider) {
    const clientId = getClientId('microsoft');
    if (!clientId) throw new Error('Microsoft (OneDrive/SharePoint) isn\'t configured yet - an Admin needs to add a Client ID in Admin Settings.');
    const redirectUri = window.location.origin + window.location.pathname;
    const state = 'ms_' + Math.random().toString(36).slice(2);
    const authUrl = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?' + new URLSearchParams({
      client_id: clientId, response_type: 'token', redirect_uri: redirectUri,
      scope: scope, response_mode: 'fragment', state: state,
    }).toString();

    return new Promise((resolve, reject) => {
      const popup = window.open(authUrl, storageProvider + '-connect', 'width=480,height=680');
      if (!popup) { reject(new Error('Please allow pop-ups to connect.')); return; }
      const timer = setInterval(() => {
        try {
          if (popup.closed) { clearInterval(timer); reject(new Error('Connection was cancelled.')); return; }
          const url = popup.location.href;
          if (url.indexOf(redirectUri) !== 0) return;
          const hash = new URLSearchParams(popup.location.hash.slice(1));
          clearInterval(timer);
          popup.close();
          if (hash.get('state') !== state) { reject(new Error('Connection failed a security check - please try again.')); return; }
          const token = hash.get('access_token');
          if (!token) { reject(new Error('Microsoft did not return an access token.')); return; }
          resolve({ accessToken: token, expiresAt: Date.now() + (parseInt(hash.get('expires_in'), 10) || 3600) * 1000 });
        } catch (e) { /* still on Microsoft's domain */ }
      }, 500);
    });
  }

  async function connectOneDrive() {
    const tok = await connectMicrosoft('Files.ReadWrite', 'onedrive');
    setConnection('onedrive', Object.assign({}, tok, { accountLabel: '' }));
  }

  async function uploadOneDrive(blob, filename) {
    const conn = getConnection('onedrive');
    if (!conn) throw new Error('Not connected to OneDrive.');
    const res = await fetch(`https://graph.microsoft.com/v1.0/me/drive/root:/${encodeURIComponent(filename)}:/content`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + conn.accessToken },
      body: blob,
    });
    if (!res.ok) throw new Error('OneDrive upload failed (' + res.status + ') - try reconnecting.');
    return res.json();
  }

  // SharePoint needs to know WHICH site's document library to use -
  // there's no single "root" like OneDrive. Asked for once at connect
  // time (a Graph drive ID, findable via
  // https://graph.microsoft.com/v1.0/sites/{hostname}:/{site-path}:/drive),
  // stored alongside the token so it isn't asked again until reconnected.
  async function connectSharePoint() {
    const driveId = prompt('Enter your SharePoint site\'s Drive ID (from Microsoft Graph - ask your IT admin if unsure):');
    if (!driveId || !driveId.trim()) throw new Error('A SharePoint Drive ID is required to connect.');
    const tok = await connectMicrosoft('Sites.ReadWrite.All', 'sharepoint');
    setConnection('sharepoint', Object.assign({}, tok, { driveId: driveId.trim(), accountLabel: '' }));
  }

  async function uploadSharePoint(blob, filename) {
    const conn = getConnection('sharepoint');
    if (!conn || !conn.driveId) throw new Error('Not connected to SharePoint.');
    const res = await fetch(`https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(conn.driveId)}/root:/${encodeURIComponent(filename)}:/content`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + conn.accessToken },
      body: blob,
    });
    if (!res.ok) throw new Error('SharePoint upload failed (' + res.status + ') - try reconnecting.');
    return res.json();
  }

  // ── WebDAV: username/password (Basic Auth), no OAuth ─────────────────
  // IMPORTANT CAVEAT: most WebDAV servers don't send
  // Access-Control-Allow-Origin headers, so the browser will block this
  // fetch() with a CORS error unless the server has specifically been
  // configured to allow it. This isn't something that can be fixed from
  // the browser side - the server has to opt in. If uploads fail here,
  // that's almost certainly why.
  async function connectWebdav() {
    const url = prompt('WebDAV server URL (e.g. https://files.example.com/dav/):');
    if (!url || !url.trim()) throw new Error('A WebDAV server URL is required.');
    const username = prompt('WebDAV username:');
    if (!username) throw new Error('A username is required.');
    const password = prompt('WebDAV password:');
    if (!password) throw new Error('A password is required.');
    setConnection('webdav', {
      accessToken: btoa(username + ':' + password), // Basic Auth token, not an OAuth access token
      serverUrl: url.trim().replace(/\/+$/, ''),
      accountLabel: username,
    });
  }

  async function uploadWebdav(blob, filename) {
    const conn = getConnection('webdav');
    if (!conn) throw new Error('Not connected to WebDAV.');
    const res = await fetch(conn.serverUrl + '/' + encodeURIComponent(filename), {
      method: 'PUT',
      headers: { Authorization: 'Basic ' + conn.accessToken },
      body: blob,
    });
    if (!res.ok) {
      throw new Error('WebDAV upload failed (' + res.status + ') - many WebDAV servers block browser uploads ' +
        'unless CORS is specifically enabled on the server; check with whoever manages it.');
    }
    return true;
  }

  // ── Public API ────────────────────────────────────────────────────
  async function connect(provider, inputId) {
    try {
      if (provider === 'google-drive') await connectGoogleDrive();
      else if (provider === 'dropbox') await connectDropbox();
      else if (provider === 'box') await connectBox();
      else if (provider === 'onedrive') await connectOneDrive();
      else if (provider === 'sharepoint') await connectSharePoint();
      else if (provider === 'webdav') await connectWebdav();
      else throw new Error(labelFor(provider) + ' isn\'t connected yet - this destination is on the roadmap but not built yet. The file will download locally for now.');
      if (inputId) refreshStatus(inputId);
    } catch (e) {
      if (window.showWarning) showWarning(e.message);
      else alert(e.message);
    }
  }

  function disconnect(provider, inputId) {
    clearConnection(provider);
    if (inputId) refreshStatus(inputId);
  }

  // Called by each service after it has a finished file - handles
  // routing to whichever destination the person picked. Falls back to a
  // normal local download if the destination isn't connected/implemented,
  // so a file is never silently lost.
  async function saveFile(inputId, blob, filename) {
    const sel = document.getElementById(inputId);
    const provider = sel ? sel.value : 'local';
    if (provider === 'local' || !IMPLEMENTED[provider] || !isConnected(provider)) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      return { provider: 'local' };
    }
    if (provider === 'google-drive') { await uploadGoogleDrive(blob, filename); return { provider }; }
    if (provider === 'dropbox') { await uploadDropbox(blob, filename); return { provider }; }
    if (provider === 'box') { await uploadBox(blob, filename); return { provider }; }
    if (provider === 'onedrive') { await uploadOneDrive(blob, filename); return { provider }; }
    if (provider === 'sharepoint') { await uploadSharePoint(blob, filename); return { provider }; }
    if (provider === 'webdav') { await uploadWebdav(blob, filename); return { provider }; }
    return { provider: 'local' };
  }

  window.StorageDestinations = {
    PROVIDERS: PROVIDERS,
    renderSelectorHtml: renderSelectorHtml,
    refreshStatus: refreshStatus,
    onSelectChange: onSelectChange,
    connect: connect,
    disconnect: disconnect,
    isConnected: isConnected,
    saveFile: saveFile,
    labelFor: labelFor,
  };
})();
