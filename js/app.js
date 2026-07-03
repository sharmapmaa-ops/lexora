(function() {
            "use strict";

            // ============================================================
            // 1. JSON CONFIGURATION
            // ============================================================
            let MENU_CONFIG = null;

            // ============================================================
            // 2. SERVICE FILES DATA
            // ============================================================
            let leaseFiles = [];
            let translationFiles = [];
            let nextLeaseFileId = 1;
            let nextTranslationFileId = 1;

            // ============================================================
            // 3. PAYMENT METHODS DATA
            // ============================================================
            let paymentMethods = [];
            let nextPaymentId = 5;

            // ============================================================
            // 4. PAYMENT HISTORY DATA
            // ============================================================
            let paymentHistory = [];
            let nextTransactionId = 11;

            // ============================================================
            // 5. API KEYS DATA
            // ============================================================
            let apiKeys = [];
            let nextApiKeyId = 1;

            // ============================================================
            // 6. SERVICES API REFERENCE DATA
            // ============================================================
            let SERVICES_API_DATA = null;

            // ============================================================
            // 6b. COMPANY DETAILS (logo, name, address, contact info, ...)
            // ============================================================
            let COMPANY_INFO = null;

            // ============================================================
            // 7. CONTACT FORM SUBMISSIONS DATA
            // ============================================================
            let contactSubmissions = [];
            let notifications = [];
            let nextNotificationId = 1;

            // ============================================================
            // 8. USER / PROFILE DATA
            // ============================================================
            // There is no more wholesale "USERS" array loaded client-side -
            // users.json holds plaintext passwords and verification codes,
            // so it's blocked from static serving and from the generic
            // /api/data/<name> API entirely (see py/server.py). The only
            // user record the browser ever sees is the CURRENTLY
            // authenticated one, fetched fresh via GET /api/auth/me after
            // login - see the AUTH section further down.
            let CURRENT_USER_ID = null;
            let profileData = null;

            // Simulated server-side storage layout per the project's folder
            // convention:
            //   Users/{userId}/Profile/
            //   Users/{userId}/Clients/Default/                 <- input files
            //   Users/{userId}/Clients/Default/Template/        <- output templates
            // A static front-end can't actually write to the filesystem, so
            // these paths are used as descriptive labels (Activity Log entries,
            // tooltips) ready to be wired to a real backend later.
            function getUserClientFilePath(userId, fileName) {
                return `Users/${userId}/Clients/Default/${fileName}`;
            }

            function getUserTemplateFilePath(userId, fileName) {
                return `Users/${userId}/Clients/Default/Template/${fileName}`;
            }

            // payment-history.json and contact-submissions.json now carry a
            // userId on every record (multiple users' data can live in the
            // same file) - these helpers scope the lists down to whichever
            // user is currently logged in, the same way a real per-user
            // backend query would.
            function getMyPaymentHistory() {
                return paymentHistory.filter(t => t.userId === CURRENT_USER_ID);
            }

            function getMyPaymentMethods() {
                return paymentMethods.filter(m => m.userId === CURRENT_USER_ID);
            }

            function getMyContactSubmissions() {
                return contactSubmissions.filter(c => c.userId === CURRENT_USER_ID);
            }

            // Developer/Admin see every user's data on the Payment History
            // and Support pages (with a User ID column + filter); a plain
            // User only ever sees their own - getCurrentBalance() etc. still
            // always uses the strictly-own getMyPaymentHistory() above, this
            // one is only for what the *page* displays.
            function isAdminOrDeveloper() {
                return !!profileData && (profileData.role === 'Admin' || profileData.role === 'Developer');
            }

            function getVisiblePaymentHistory() {
                return isAdminOrDeveloper() ? paymentHistory.slice() : getMyPaymentHistory();
            }

            function getVisibleContactSubmissions() {
                return isAdminOrDeveloper() ? contactSubmissions.slice() : getMyContactSubmissions();
            }

            // Sanitized {id, email, firstName, lastName, role, ...} list (no
            // passwords/codes - see py/auth_store.py's public_user_view) -
            // loaded once at startup, used for the Developer/Admin user-id/
            // email filters above and to find "who is the Developer" for
            // the balance-centralization rule in addBalance().
            let USER_DIRECTORY = [];

            async function loadUserDirectory() {
                try {
                    const res = await authFetch('/api/auth/directory');
                    const data = await res.json();
                    USER_DIRECTORY = data.users || [];
                } catch (e) {
                    USER_DIRECTORY = [];
                }
            }

            function getDeveloperUserId() {
                const dev = USER_DIRECTORY.find(u => u.role === 'Developer');
                return dev ? dev.id : null;
            }

            function getUserDirectoryEntry(userId) {
                return USER_DIRECTORY.find(u => u.id === userId) || null;
            }

            // Lease/Translation files and activity logs all live in one
            // shared json file per service (like payments/support above) -
            // these scope them down to the current user so one person's
            // uploads/history never show up in someone else's session.
            function getMyLeaseFiles() {
                return leaseFiles.filter(f => f.userId === CURRENT_USER_ID);
            }

            function getMyTranslationFiles() {
                return translationFiles.filter(f => f.userId === CURRENT_USER_ID);
            }

            function getMyLeaseActivityLog() {
                return leaseActivityLog.filter(a => a.userId === CURRENT_USER_ID);
            }

            function getMyTranslationActivityLog() {
                return translationActivityLog.filter(a => a.userId === CURRENT_USER_ID);
            }

            // ============================================================
            // 9. AGENTS DATA (each agent = one processing stage, per service)
            // ============================================================
            let AGENTS_BY_SERVICE = {};
            let activeAgentId = null;

            function getAgents(serviceId) {
                return AGENTS_BY_SERVICE[serviceId] || [];
            }

            // System Configuration options are fixed (no system-configs.json
            // anymore) - the *default* selection comes from the logged-in
            // user's "sysConfig" field in users.json instead.
            const SYSTEM_CONFIGS = ['Desktop', 'Sharefile', 'Sharepoint'];
            let currentSystemConfig = 'Desktop';
            let connectionStatus = 'idle'; // 'idle', 'connected', 'disconnected'

            // ============================================================
            // 10. PROCESS STATE
            // ============================================================
            let processState = {
                isRunning: false,
                isPaused: false,
                isComplete: false,
                stopped: false
            };

            // ============================================================
            // 11. PERSISTED ACTIVITY LOG (per service)
            // ============================================================
            let leaseActivityLog = [];
            let translationActivityLog = [];

            function addActivity(serviceId, activity, result) {
                const now = new Date();
                const timeStr = now.toISOString().replace('T', ' ').slice(0, 16);
                const entry = { time: timeStr, activity: activity, result: result, userId: CURRENT_USER_ID };
                if (serviceId === 'translation') {
                    translationActivityLog.unshift(entry);
                } else {
                    leaseActivityLog.unshift(entry);
                }
            }

            // ============================================================
            // 12. SERVICE PAGE - REUSABLE PIECE BUILDERS
            //     (shared by the initial full render AND the live, in-place
            //      DOM updates used while a process is running, so nothing
            //      ever needs to be torn down and rebuilt mid-process)
            // ============================================================
            function buildFileTableRows(files) {
                return files.map(file => {
                    const scanIsNumeric = /^\d+$/.test(String(file.scanResult));
                    const progressIsNumeric = /^\d+$/.test(String(file.progress));
                    const scanProgress = scanIsNumeric ? parseInt(file.scanResult) || 0 : 0;
                    const processProgress = progressIsNumeric ? parseInt(file.progress) || 0 : 0;
                    const statusClass = file.status === 'completed' ? 'completed' :
                        file.status === 'error' ? 'error' :
                        file.status === 'processing' ? 'processing' : 'pending';

                    const actionLabel = file.status === 'error' ? (file.errorLabel || 'Error') : null;
                    const docFolder = file.leaseName || file.docName || '';
                    const downloadKind = file.docName ? 'translation' : 'lease';
                    const actionLink = file.status === 'completed' ?
                        `<a class="file-action-link" onclick="downloadFile('Output.pdf', '${docFolder.replace(/'/g, "\\'")}', '${downloadKind}')">Download</a>` :
                        file.status === 'error' ?
                        `<a class="file-action-link error-link" onclick="retryFile('${file.id}')">${actionLabel}</a>` :
                        `<span class="file-action-link disabled">${file.status === 'processing' ? 'Processing' : 'Pending'}</span>`;

                    const scanCell = scanIsNumeric ? `
                        <div class="progress-bar-container">
                            <div class="progress-bar-track">
                                <div class="progress-bar-fill ${statusClass}" style="width:${scanProgress}%;"></div>
                            </div>
                            <span class="progress-label">${scanProgress}%</span>
                        </div>` : `<span class="scan-result-text ${statusClass}">${file.scanResult}</span>`;

                    const progressCell = progressIsNumeric ? `
                        <div class="progress-bar-container">
                            <div class="progress-bar-track">
                                <div class="progress-bar-fill ${statusClass}" style="width:${processProgress}%;"></div>
                            </div>
                            <span class="progress-label">${processProgress}%</span>
                        </div>` : `<span class="scan-result-text ${statusClass}">${file.progress || '-'}</span>`;

                    return `
                        <tr>
                            <td class="file-name">${file.name}</td>
                            <td>${scanCell}</td>
                            <td>${progressCell}</td>
                            <td>${actionLink}</td>
                        </tr>
                    `;
                }).join('');
            }

            function buildActivityLogRows(activityLog) {
                return activityLog.map(log => {
                    const resultClass = log.result === 'Completed' ? 'completed' :
                        log.result === 'Error' ? 'error' :
                        log.result === 'Processing' ? 'processing' : 'pending';
                    return `
                        <tr>
                            <td>${log.time}</td>
                            <td>${log.activity}</td>
                            <td><span class="activity-result ${resultClass}">${log.result}</span></td>
                        </tr>
                    `;
                }).join('');
            }

            // Agent strip shown at the top of the Activity Log - highlights only the currently running agent
            function buildAgentPillsHTML(serviceId) {
                return getAgents(serviceId).map(agent => `
                    <div class="agent-pill ${agent.id === activeAgentId ? 'active' : ''}" title="${agent.step ? agent.step + ' ' : ''}${agent.name}">
                        <span class="agent-pill-icon">${agent.icon}</span>
                        <span class="agent-pill-name">${agent.name}</span>
                    </div>
                `).join('');
            }

            // Connection status badge - intentionally renders nothing while idle (no "Idle" tag)
            function buildConnectionStatusHTML() {
                if (connectionStatus === 'idle') return '';
                const statusText = connectionStatus === 'connected' ? '● Connected' : '● Not Connected';
                const statusClass = connectionStatus === 'connected' ? 'connected' : 'disconnected';
                return `<span class="connection-status ${statusClass}">${statusText}</span>`;
            }

            // Process control buttons (Start/Clear, or Pause/Resume/Stop while running)
            function buildControlButtonsHTML(serviceId, hasFiles) {
                if (processState.isRunning && !processState.isComplete) {
                    const pauseLabel = processState.isPaused ? '▶️ Resume' : '⏸️ Pause';
                    const pauseClass = processState.isPaused ? 'resume-btn' : 'pause-btn';
                    return `
                        <button class="process-btn ${pauseClass}" onclick="togglePause()">${pauseLabel}</button>
                        <button class="process-btn stop-btn" onclick="stopProcess()">⏹️ Stop</button>
                    `;
                }
                return `
                    <button class="process-btn start-btn" onclick="startProcess('${serviceId}')" ${!hasFiles ? 'disabled' : ''}>▶️ Start</button>
                    <button class="process-btn clear-btn" onclick="clearFiles('${serviceId}')">🗑️ Clear Files</button>
                `;
            }

            // ============================================================
            // 13. BUILD SERVICE UPLOAD HTML (full page render)
            // ============================================================
            function buildServiceUploadHTML(serviceId, serviceLabel, icon) {
                const isTranslation = serviceId === 'translation';
                const files = isTranslation ? getMyTranslationFiles() : getMyLeaseFiles();
                const activityLog = isTranslation ? getMyTranslationActivityLog() : getMyLeaseActivityLog();

                const fileRows = buildFileTableRows(files);
                const activityRows = buildActivityLogRows(activityLog);
                const agentPills = buildAgentPillsHTML(serviceId);
                const controlButtons = buildControlButtonsHTML(serviceId, files.length > 0);

                // File count text for drop zone
                const fileCountText = files.length > 0 ?
                    `${files.length} file(s) uploaded` :
                    'No files uploaded yet';

                // Output Template (lease-abstraction) OR Output Language (translation) - shown in Setup card
                const outputFieldHTML = isTranslation ? `
                    <div class="setup-group">
                        <label>Output Language</label>
                        <select id="translationLangSelect">
                            <option value="English" selected>English</option>
                            <option value="Spanish">Spanish</option>
                            <option value="French">French</option>
                            <option value="German">German</option>
                            <option value="Chinese">Chinese</option>
                            <option value="Japanese">Japanese</option>
                            <option value="Arabic">Arabic</option>
                            <option value="Hindi">Hindi</option>
                        </select>
                    </div>
                ` : `
                    <div class="setup-group">
                        <label>Output Template</label>
                        <div class="template-select-row">
                            <button class="select-btn" onclick="document.getElementById('templateFileInput').click()">Select</button>
                            <a class="template-file-link" id="templateFileName" href="#" onclick="return false;">${selectedTemplateFile || 'default.pdf'}</a>
                        </div>
                        <input type="file" id="templateFileInput" style="display:none;" accept=".json,.xml,.pdf,.docx" onchange="selectTemplateFile(event)" />
                    </div>
                `;

                // System config
                let systemOptions = SYSTEM_CONFIGS.map(config => `
                    <option value="${config}" ${config === currentSystemConfig ? 'selected' : ''}>${config}</option>
                `).join('');

                return `
                    <div>
                        <div class="service-upload-layout">
                            <!-- Left: Upload Card -->
                            <div class="service-card">
                                <h3>📤 Upload File(s)</h3>
                                <div class="card-body">
                                    <div class="drop-zone" id="dropZone" onclick="document.getElementById('fileInput').click()">
                                        <div class="drop-icon">📤</div>
                                        <div class="drop-text">Drag & drop files here</div>
                                        <div class="drop-sub">or click to browse (Docx, PDF)</div>
                                        <div class="file-count-text" id="fileCountText">${fileCountText}</div>
                                    </div>
                                    <input type="file" id="fileInput" multiple style="display:none;" accept=".pdf,.docx" onchange="handleFileUpload(event, '${serviceId}')" />
                                </div>
                            </div>

                            <!-- Right: Setup Card -->
                            <div class="service-card">
                                <h3>⚙️ Setup</h3>
                                <div class="card-body">
                                    ${outputFieldHTML}

                                    ${serviceId === 'lease-abstraction' ? `
                                    <div class="setup-row-split">
                                        <div class="setup-group">
                                            <label>Extraction Rules</label>
                                            <button class="filter-btn" onclick="openRulesPopup()">📐 Update Rules</button>
                                        </div>
                                        <div class="setup-group">
                                            <label>System Configuration</label>
                                            <div class="system-config-row">
                                                <select id="systemConfigSelect" onchange="verifySystemConnection()">
                                                    ${systemOptions}
                                                </select>
                                                <span id="connectionStatusWrap">${buildConnectionStatusHTML()}</span>
                                            </div>
                                        </div>
                                    </div>
                                    ` : `
                                    <div class="setup-group">
                                        <label>System Configuration</label>
                                        <div class="system-config-row">
                                            <select id="systemConfigSelect" onchange="verifySystemConnection()">
                                                ${systemOptions}
                                            </select>
                                            <span id="connectionStatusWrap">${buildConnectionStatusHTML()}</span>
                                        </div>
                                    </div>
                                    `}

                                    <div class="setup-group" style="margin-top:8px;">
                                        <div class="process-controls" id="processControls">
                                            ${controlButtons}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- File List Card (Separate) -->
                        <div class="file-list-card">
                            <h3>📁 Uploaded Files</h3>
                            <div class="card-body">
                                <div class="file-table-wrapper">
                                    <table class="file-table file-table-files">
                                        <colgroup>
                                            <col style="width:46%;"><col style="width:18%;"><col style="width:18%;"><col style="width:18%;">
                                        </colgroup>
                                        <thead>
                                            <tr>
                                                <th>File Name</th>
                                                <th>Scan Result</th>
                                                <th>Progress</th>
                                                <th>Action</th>
                                            </tr>
                                        </thead>
                                    </table>
                                    <div class="file-table-scroll">
                                        <table class="file-table file-table-files">
                                            <colgroup>
                                                <col style="width:46%;"><col style="width:18%;"><col style="width:18%;"><col style="width:18%;">
                                            </colgroup>
                                            <tbody id="fileTableBody">
                                                ${fileRows || '<tr><td colspan="4" style="text-align:center;padding:15px;color:rgba(0,0,0,0.3);">No files uploaded yet.</td></tr>'}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- Activity Log below (with active agent strip on top) -->
                        <div class="activity-log-section">
                            <div class="activity-log-card">
                                <div class="agents-top-row" id="agentsTopRow">
                                    ${agentPills}
                                </div>
                                <div class="log-header">
                                    <h3>📋 Activity Log</h3>
                                    <div class="log-actions">
                                        <button onclick="downloadActivityLog()">⬇️ Download Log</button>
                                    </div>
                                </div>
                                <div class="card-body">
                                    <div class="file-table-wrapper">
                                        <table class="file-table file-table-activity">
                                            <colgroup>
                                                <col style="width:20%;"><col style="width:62%;"><col style="width:18%;">
                                            </colgroup>
                                            <thead>
                                                <tr>
                                                    <th>Date &amp; Time</th>
                                                    <th>Activity</th>
                                                    <th>Status</th>
                                                </tr>
                                            </thead>
                                        </table>
                                        <div class="file-table-scroll">
                                            <table class="file-table file-table-activity">
                                                <colgroup>
                                                    <col style="width:20%;"><col style="width:62%;"><col style="width:18%;">
                                                </colgroup>
                                                <tbody id="activityList">
                                                    ${activityRows || '<tr><td colspan="3" style="text-align:center;padding:15px;color:rgba(0,0,0,0.3);">No activities recorded.</td></tr>'}
                                                </tbody>
                                            </table>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                `;
            }

            let selectedTemplateFile = null;

            // ============================================================
            // 13. TEMPLATE FILE SELECTION
            // ============================================================
            window.selectTemplateFile = function(event) {
                const file = event.target.files[0];
                if (!file) { event.target.value = ''; return; }

                const reader = new FileReader();
                reader.onload = async function(e) {
                    const dataBase64 = e.target.result.split(',')[1];
                    try {
                        await postJSON('/api/lease/upload-template', {
                            userId: CURRENT_USER_ID,
                            fileName: file.name,
                            dataBase64: dataBase64
                        });
                        selectedTemplateFile = file.name;
                        document.getElementById('templateFileName').textContent = file.name;
                        const templatePath = getUserTemplateFilePath(CURRENT_USER_ID, file.name);
                        addActivity('lease-abstraction', `Output Template "${file.name}" saved to ${templatePath}`, 'Completed');
                        refreshServicePage('lease-abstraction');
                        persistServiceFiles('lease-abstraction');
                        showMessage('✅ Template Selected', `Template "${file.name}" selected and saved to ${templatePath}.`, ['OK']);
                    } catch (err) {
                        console.warn('Template upload failed:', err);
                        showWarning('Could not save the template to the server. Make sure py/server.py is running.');
                    }
                };
                reader.readAsDataURL(file);
                event.target.value = '';
            };

            // ============================================================
            // 14. FILE DOWNLOAD / RETRY
            // ============================================================
            window.downloadFile = function(fileName, docFolderName, kind) {
                if (!docFolderName) {
                    showWarning('This file was not processed through the real pipeline, so there\'s nothing to download yet.');
                    return;
                }
                const base = kind === 'translation' ? '/api/translation/download' : '/api/lease/download';
                const nameParam = kind === 'translation' ? 'docName' : 'leaseName';
                const url = base + '?userId=' + encodeURIComponent(CURRENT_USER_ID) +
                    '&' + nameParam + '=' + encodeURIComponent(docFolderName) + '&fileName=' + encodeURIComponent(fileName);
                window.open(url, '_blank');
            };

            window.retryFile = function(fileId) {
                const serviceId = activeSubItemId === 'translation' ? 'translation' : 'lease-abstraction';
                const files = serviceId === 'translation' ? getMyTranslationFiles() : getMyLeaseFiles();
                const file = files.find(f => String(f.id) === String(fileId));
                const reason = (file && file.errorReason) ? file.errorReason :
                    'This file could not be processed. Click "Start" to try again.';
                showMessage('❌ Error', reason, ['OK']);
            };

            // ============================================================
            // 15. PROCESS CONTROL (sequential, one file at a time)
            // ============================================================
            function getCurrentBalance() {
                let totalCredit = 0,
                    totalDebit = 0;
                getMyPaymentHistory().forEach(t => { totalCredit += t.credit;
                    totalDebit += t.debit; });
                return totalCredit - totalDebit;
            }

            // ------------------------------------------------------------
            // Lease Abstraction real-processing helpers (section 14)
            // ------------------------------------------------------------
            // Uploaded File objects for lease-abstraction files, keyed by
            // file.id - JSON can't store real file bytes, so these live
            // only in memory for the lifetime of this browser tab/session.
            // If the page is reloaded, a "pending" file entry restored from
            // lease-files.json will have no blob here and Start will ask
            // the user to re-upload it (see processLeaseFileAt below).
            let leaseFileBlobs = {};
            let translationFileBlobs = {};

            function sleep(ms) {
                return new Promise(resolve => setTimeout(resolve, ms));
            }

            function waitIfPausedAsync(serviceId) {
                return new Promise(resolve => waitIfPaused(serviceId, resolve));
            }

            function readFileAsDataURL(blob) {
                return new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = () => reject(reader.error || new Error('Could not read file'));
                    reader.readAsDataURL(blob);
                });
            }

            async function postJSON(url, payload) {
                const res = await authFetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                let data;
                try { data = await res.json(); } catch (e) { data = {}; }
                if (!res.ok) throw new Error(data.error || ('Request to ' + url + ' failed'));
                return data;
            }

            // Starts a background text-extraction job and polls its status
            // every couple of seconds until it's done. Extraction (real OCR
            // for scanned PDFs especially) can take well over a minute for a
            // long document - long enough to trip a reverse-proxy/gateway
            // timeout if it sat inside one single HTTP request/response, so
            // the server just kicks it off and this polls a tiny status
            // endpoint instead (see /api/lease/extract-start + -status).
            async function runExtractJob(stagingPath, onProgress) {
                const startRes = await postJSON('/api/lease/extract-start', { stagingPath });
                const jobId = startRes.jobId;

                while (true) {
                    await sleep(2000);
                    const res = await authFetch('/api/lease/extract-status?jobId=' + encodeURIComponent(jobId));
                    let status;
                    try { status = await res.json(); } catch (e) { status = {}; }
                    if (!res.ok) throw new Error(status.error || 'Could not check extraction status');

                    if (status.status === 'done') {
                        return { text: status.text, textLength: status.textLength };
                    }
                    if (status.status === 'error') {
                        throw new Error(status.error || 'Extraction failed');
                    }
                    if (typeof onProgress === 'function') {
                        onProgress(status.pagesDone, status.pagesTotal);
                    }
                }
            }

            // Uses XMLHttpRequest (not fetch) specifically so the real byte
            // upload progress can drive the Scan Result column/progress bar.
            function uploadWithProgress(url, payload, onProgress) {
                return new Promise((resolve, reject) => {
                    const xhr = new XMLHttpRequest();
                    xhr.open('POST', url);
                    xhr.setRequestHeader('Content-Type', 'application/json');
                    if (AUTH_TOKEN) xhr.setRequestHeader('Authorization', 'Bearer ' + AUTH_TOKEN);
                    xhr.upload.onprogress = function(e) {
                        if (e.lengthComputable && typeof onProgress === 'function') {
                            onProgress(Math.round((e.loaded / e.total) * 100));
                        }
                    };
                    xhr.onload = function() {
                        let data;
                        try { data = JSON.parse(xhr.responseText); } catch (e) { data = {}; }
                        if (xhr.status >= 200 && xhr.status < 300) {
                            resolve(data);
                        } else {
                            reject(new Error(data.error || ('Upload failed with status ' + xhr.status)));
                        }
                    };
                    xhr.onerror = function() { reject(new Error('Network error while uploading')); };
                    xhr.send(JSON.stringify(payload));
                });
            }

            window.startProcess = function(serviceId) {
                const files = serviceId === 'translation' ? getMyTranslationFiles() : getMyLeaseFiles();
                if (files.length === 0) {
                    showWarning('No files to process. Please upload files first.');
                    return;
                }

                processState.isRunning = true;
                processState.isPaused = false;
                processState.isComplete = false;
                processState.stopped = false;

                addActivity(serviceId, 'Process Started', 'Processing');
                refreshServicePage(serviceId);

                if (serviceId === 'lease-abstraction') {
                    setTimeout(() => runLeaseAbstractionPipeline(), 500);
                } else {
                    setTimeout(() => runTranslationPipeline(), 500);
                }
            };

            function waitIfPaused(serviceId, cb) {
                if (processState.stopped) return;
                if (processState.isPaused) {
                    setTimeout(() => waitIfPaused(serviceId, cb), 400);
                    return;
                }
                cb();
            }

            // ============================================================
            // 15b. LEASE ABSTRACTION - REAL PROCESSING PIPELINE (section 14)
            // Backed by the /api/lease/* routes in py/server.py. Progress
            // follows the fixed checkpoints from the spec: 0/20/40/60/80/100.
            // Translation has its own real pipeline too now (see
            // runTranslationPipeline/processTranslationFileAt further down),
            // backed by /api/translation/* - it used to be a setTimeout-only
            // simulation.
            // ============================================================
            async function runLeaseAbstractionPipeline() {
                if (processState.stopped) return;

                // 14.1 - scan the output template ONCE for the whole batch;
                // deliberately not tied to any file's Progress column.
                try {
                    const scanAgent = getAgents('lease-abstraction').find(a => a.phase === 'scan');
                    activeAgentId = scanAgent ? scanAgent.id : null;
                    refreshServicePage('lease-abstraction');
                    const result = await postJSON('/api/lease/scan-template', {
                        userId: CURRENT_USER_ID,
                        templateName: selectedTemplateFile || null
                    });
                    addActivity('lease-abstraction', `Output Template "${result.template}" scanned`, 'Completed');
                } catch (err) {
                    addActivity('lease-abstraction', 'Output Template scan failed - continuing with Default.pdf', 'Error');
                }
                activeAgentId = null;
                refreshServicePage('lease-abstraction');

                processLeaseFileAt(0);
            }

            async function processLeaseFileAt(startIndex) {
                for (let fileIndex = startIndex; ; fileIndex++) {
                    if (processState.stopped) return;

                    const myLeaseFiles = getMyLeaseFiles();
                    if (fileIndex >= myLeaseFiles.length) {
                        const hasErrors = myLeaseFiles.some(f => f.status === 'error');
                        activeAgentId = null;
                        processState.isRunning = false;
                        processState.isComplete = true;
                        addActivity('lease-abstraction',
                            hasErrors ? 'Processing finished with errors' : 'All files processed successfully',
                            hasErrors ? 'Error' : 'Completed');
                        refreshServicePage('lease-abstraction');
                        persistServiceFiles('lease-abstraction');
                        showMessage(hasErrors ? '⚠️ Finished with Errors' : '✅ Complete',
                            hasErrors ?
                            'Processing finished, but one or more files could not be completed. Check the Action column for details.' :
                            'All files have been processed successfully!', ['OK']);
                        return;
                    }

                    await waitIfPausedAsync('lease-abstraction');
                    if (processState.stopped) return;

                    const file = myLeaseFiles[fileIndex];

                    if (file.status === 'completed') {
                        continue;
                    }

                    file.status = 'processing';
                    refreshServicePage('lease-abstraction');
                    await sleep(400);
                    if (processState.stopped) return;

                    // ---- Step 0: minimum $1 balance check (real, live balance) ----
                    if (getCurrentBalance() < 1) {
                        file.status = 'error';
                        file.errorLabel = 'Error';
                        file.errorReason = 'Insufficient balance. A minimum of $1 is required to process this file. Please add balance, then click Start again.';
                        addActivity('lease-abstraction', `${file.name} > Checking Balance`, 'Error');
                        refreshServicePage('lease-abstraction');
                        persistServiceFiles('lease-abstraction');
                        await sleep(300);
                        continue;
                    }
                    addActivity('lease-abstraction', `${file.name} > Checking Balance`, 'Completed');
                    refreshServicePage('lease-abstraction');

                    const blob = leaseFileBlobs[file.id];
                    if (!blob) {
                        file.status = 'error';
                        file.errorLabel = 'Missing';
                        file.scanResult = 'File Not Available';
                        file.errorReason = 'The original file is no longer available in this browser session (this can happen after a page reload). Please remove and re-upload this file, then click Start again.';
                        addActivity('lease-abstraction', `${file.name} > File not available for processing`, 'Error');
                        refreshServicePage('lease-abstraction');
                        persistServiceFiles('lease-abstraction');
                        await sleep(300);
                        continue;
                    }

                    const processAgents = getAgents('lease-abstraction').filter(a => a.phase !== 'scan');

                    try {
                        // ---- 14.2: Input File Scanning - real upload, real progress ----
                        activeAgentId = null;
                        const dataUrl = await readFileAsDataURL(blob);
                        const dataBase64 = dataUrl.split(',')[1];

                        const uploadResult = await uploadWithProgress('/api/lease/upload',
                            { userId: CURRENT_USER_ID, fileName: file.name, dataBase64: dataBase64 },
                            (pct) => { file.scanResult = String(pct); refreshServicePage('lease-abstraction'); }
                        );
                        file.scanResult = '100';
                        file.progress = '0';
                        addActivity('lease-abstraction', `${file.name} > Input File Scanning`, 'Completed');
                        refreshServicePage('lease-abstraction');

                        const stagingPath = uploadResult.stagingPath;
                        const originalFileName = uploadResult.originalFileName;

                        await waitIfPausedAsync('lease-abstraction');
                        if (processState.stopped) return;

                        // ---- 20%: data extraction (async job + polling - a
                        // slow OCR pass can take well over a minute, so this
                        // never sits inside one single HTTP request, which is
                        // what was tripping a gateway/proxy timeout before) ----
                        activeAgentId = processAgents[0] ? processAgents[0].id : null;
                        refreshServicePage('lease-abstraction');
                        const extractRes = await runExtractJob(stagingPath, (pagesDone, pagesTotal) => {
                            if (pagesTotal) {
                                file.scanResult = `OCR ${pagesDone}/${pagesTotal}`;
                                file.progress = String(Math.min(20, Math.round((pagesDone / pagesTotal) * 20)));
                                refreshServicePage('lease-abstraction');
                            }
                        });
                        file.scanResult = '100';
                        file.progress = '20';
                        addActivity('lease-abstraction', `${file.name} > Data extracted from document`, 'Completed');
                        refreshServicePage('lease-abstraction');

                        await waitIfPausedAsync('lease-abstraction');
                        if (processState.stopped) return;

                        // ---- 40%: analysis - real OpenAI/OpenRouter call when
                        // .env has a key configured (using
                        // json/extraction_prompt.txt + json/rules.json), else
                        // the heuristic engine - see py/lease_engine.py ----
                        activeAgentId = processAgents[1] ? processAgents[1].id : null;
                        refreshServicePage('lease-abstraction');
                        const analyzeRes = await postJSON('/api/lease/analyze', {
                            text: extractRes.text,
                            fallbackName: originalFileName.replace(/\.[^.]+$/, '')
                        });
                        file.progress = '40';
                        const methodLabel = analyzeRes.extractionMethod === 'llm-openai' ? 'OpenAI' :
                            analyzeRes.extractionMethod === 'llm-openrouter' ? 'OpenRouter' : 'heuristic engine';
                        addActivity('lease-abstraction', `${file.name} > Data analyzed and interpreted (${methodLabel})`, 'Completed');
                        const accuracyLabel = analyzeRes.accuracyMethod === 'llm-validation' ? 'QC validated' : 'heuristic estimate';
                        addActivity('lease-abstraction', `${file.name} > Accuracy: ${analyzeRes.accuracy}% (${accuracyLabel})`, 'Completed');
                        file.accuracy = analyzeRes.accuracy;
                        refreshServicePage('lease-abstraction');

                        await waitIfPausedAsync('lease-abstraction');
                        if (processState.stopped) return;

                        // ---- 60%: document-type + duplicate validation ----
                        activeAgentId = processAgents[2] ? processAgents[2].id : null;
                        refreshServicePage('lease-abstraction');
                        const validateRes = await postJSON('/api/lease/validate', {
                            userId: CURRENT_USER_ID,
                            docType: analyzeRes.docType,
                            leaseName: analyzeRes.leaseName
                        });

                        if (!validateRes.valid) {
                            file.status = 'error';
                            file.progress = '0';
                            if (validateRes.reason === 'duplicate') {
                                file.scanResult = 'Already Processed';
                                file.errorLabel = 'Duplicate';
                                file.errorReason = `A lease named "${validateRes.leaseName}" has already been processed for your account.`;
                                addActivity('lease-abstraction', `${file.name} > Already Processed`, 'Error');
                            } else {
                                file.scanResult = 'Invalid Document';
                                file.errorLabel = 'Invalid';
                                file.errorReason = 'This document does not appear to be a Lease or Amendment.';
                                addActivity('lease-abstraction', `${file.name} > Invalid Document`, 'Error');
                            }
                            activeAgentId = null;
                            refreshServicePage('lease-abstraction');
                            persistServiceFiles('lease-abstraction');
                            await sleep(300);
                            continue;
                        }

                        file.progress = '60';
                        file.leaseName = validateRes.leaseName;
                        addActivity('lease-abstraction', `${file.name} > Validation completed (document type + duplicate check)`, 'Completed');
                        refreshServicePage('lease-abstraction');

                        await waitIfPausedAsync('lease-abstraction');
                        if (processState.stopped) return;

                        // ---- 80%: Output.json + saved document + LeaseDocuments.json ----
                        activeAgentId = processAgents[3] ? processAgents[3].id : null;
                        refreshServicePage('lease-abstraction');
                        const saveRes = await postJSON('/api/lease/save-output', {
                            userId: CURRENT_USER_ID,
                            leaseName: validateRes.leaseName,
                            docType: analyzeRes.docType,
                            fields: analyzeRes.fields,
                            extractionMethod: analyzeRes.extractionMethod,
                            accuracy: analyzeRes.accuracy,
                            accuracyMethod: analyzeRes.accuracyMethod,
                            accuracySummary: analyzeRes.accuracySummary,
                            missingFields: analyzeRes.missingFields,
                            lowConfidenceFields: analyzeRes.lowConfidenceFields,
                            stagingPath: stagingPath,
                            originalFileName: originalFileName
                        });
                        file.progress = '80';
                        addActivity('lease-abstraction',
                            `${file.name} > Output.json created, document saved to ${saveRes.leaseFolder}`, 'Completed');
                        refreshServicePage('lease-abstraction');

                        await waitIfPausedAsync('lease-abstraction');
                        if (processState.stopped) return;

                        // ---- 100%: Output.pdf generation ----
                        activeAgentId = processAgents[4] ? processAgents[4].id : null;
                        refreshServicePage('lease-abstraction');
                        const pdfRes = await postJSON('/api/lease/generate-pdf', {
                            userId: CURRENT_USER_ID,
                            leaseName: validateRes.leaseName,
                            templateName: selectedTemplateFile || 'Default.pdf'
                        });
                        file.progress = '100';
                        addActivity('lease-abstraction', `${file.name} > ${pdfRes.outputPdf} generated successfully`, 'Completed');

                        // ---- $1 processing fee (kept from the original simulation) ----
                        const now = new Date();
                        const txnId = 'TXN' + String(nextTransactionId++).padStart(3, '0');
                        paymentHistory.push({
                            id: txnId,
                            date: now.toISOString().split('T')[0],
                            time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }),
                            userId: CURRENT_USER_ID,
                            paymentType: 'Service Fee',
                            paymentMode: 'Wallet Balance',
                            description: `Lease Abstraction - ${file.name}`,
                            credit: 0,
                            debit: 1
                        });
                        addActivity('lease-abstraction', `${file.name} > Deduct $1 Balance (${txnId})`, 'Completed');

                        file.status = 'completed';
                        activeAgentId = null;
                        delete leaseFileBlobs[file.id];
                        refreshServicePage('lease-abstraction');
                        persistPaymentHistory();
                        persistServiceFiles('lease-abstraction');

                    } catch (err) {
                        console.error('Lease processing error:', err);
                        file.status = 'error';
                        file.errorLabel = 'Error';
                        file.errorReason = 'Processing failed: ' + (err && err.message ? err.message :
                            'Unknown error. Make sure py/server.py is running with its dependencies installed (pip install -r requirements.txt).');
                        activeAgentId = null;
                        addActivity('lease-abstraction', `${file.name} > Processing failed`, 'Error');
                        refreshServicePage('lease-abstraction');
                        persistServiceFiles('lease-abstraction');
                    }

                    await sleep(300);
                }
            }

            // ============================================================
            // REAL TRANSLATION PIPELINE (used to be entirely simulated with
            // setTimeout - now a real backend pipeline, same shape as lease
            // abstraction: real upload -> real (async, OCR-capable) text
            // extraction -> real LLM translation -> real saved output +
            // downloadable PDF).
            // ============================================================
            async function runTranslationPipeline() {
                if (processState.stopped) return;
                processTranslationFileAt(0);
            }

            async function processTranslationFileAt(startIndex) {
                for (let fileIndex = startIndex; ; fileIndex++) {
                    if (processState.stopped) return;

                    const myFiles = getMyTranslationFiles();
                    if (fileIndex >= myFiles.length) {
                        const hasErrors = myFiles.some(f => f.status === 'error');
                        activeAgentId = null;
                        processState.isRunning = false;
                        processState.isComplete = true;
                        addActivity('translation',
                            hasErrors ? 'Processing finished with errors' : 'All files processed successfully',
                            hasErrors ? 'Error' : 'Completed');
                        refreshServicePage('translation');
                        persistServiceFiles('translation');
                        showMessage(hasErrors ? '⚠️ Finished with Errors' : '✅ Complete',
                            hasErrors ?
                            'Processing finished, but one or more files could not be completed. Check the Action column for details.' :
                            'All files have been processed successfully!', ['OK']);
                        return;
                    }

                    await waitIfPausedAsync('translation');
                    if (processState.stopped) return;

                    const file = myFiles[fileIndex];
                    if (file.status === 'completed') {
                        continue;
                    }

                    file.status = 'processing';
                    refreshServicePage('translation');
                    await sleep(400);
                    if (processState.stopped) return;

                    // ---- Step 0: minimum $1 balance check (real, live balance) ----
                    if (getCurrentBalance() < 1) {
                        file.status = 'error';
                        file.errorLabel = 'Error';
                        file.errorReason = 'Insufficient balance. A minimum of $1 is required to process this file. Please add balance, then click Start again.';
                        addActivity('translation', `${file.name} > Checking Balance`, 'Error');
                        refreshServicePage('translation');
                        persistServiceFiles('translation');
                        await sleep(300);
                        continue;
                    }
                    addActivity('translation', `${file.name} > Checking Balance`, 'Completed');
                    refreshServicePage('translation');

                    const blob = translationFileBlobs[file.id];
                    if (!blob) {
                        file.status = 'error';
                        file.errorLabel = 'Missing';
                        file.scanResult = 'File Not Available';
                        file.errorReason = 'The original file is no longer available in this browser session (this can happen after a page reload). Please remove and re-upload this file, then click Start again.';
                        addActivity('translation', `${file.name} > File not available for processing`, 'Error');
                        refreshServicePage('translation');
                        persistServiceFiles('translation');
                        await sleep(300);
                        continue;
                    }

                    const targetLanguage = file.targetLang || 'English';
                    const processAgents = getAgents('translation').filter(a => a.phase !== 'scan');

                    try {
                        // ---- Input File Scanning - real upload, real progress ----
                        activeAgentId = null;
                        const dataUrl = await readFileAsDataURL(blob);
                        const dataBase64 = dataUrl.split(',')[1];

                        const uploadResult = await uploadWithProgress('/api/translation/upload',
                            { userId: CURRENT_USER_ID, fileName: file.name, dataBase64: dataBase64 },
                            (pct) => { file.scanResult = String(pct); refreshServicePage('translation'); }
                        );
                        file.scanResult = '100';
                        file.progress = '0';
                        addActivity('translation', `${file.name} > Input File Scanning`, 'Completed');
                        refreshServicePage('translation');

                        const stagingPath = uploadResult.stagingPath;
                        const originalFileName = uploadResult.originalFileName;

                        await waitIfPausedAsync('translation');
                        if (processState.stopped) return;

                        // ---- Extracting Text Content (async job + polling, same
                        // OCR-capable pipeline as lease abstraction) ----
                        activeAgentId = processAgents[0] ? processAgents[0].id : null;
                        refreshServicePage('translation');
                        const extractRes = await runExtractJob(stagingPath, (pagesDone, pagesTotal) => {
                            if (pagesTotal) {
                                file.scanResult = `OCR ${pagesDone}/${pagesTotal}`;
                                file.progress = String(Math.min(20, Math.round((pagesDone / pagesTotal) * 20)));
                                refreshServicePage('translation');
                            }
                        });
                        file.scanResult = '100';
                        file.progress = '20';
                        addActivity('translation', `${file.name} > Text extracted from document`, 'Completed');
                        refreshServicePage('translation');

                        await waitIfPausedAsync('translation');
                        if (processState.stopped) return;

                        // ---- Translating Content - real LLM call ----
                        activeAgentId = processAgents[1] ? processAgents[1].id : null;
                        refreshServicePage('translation');
                        const translateRes = await postJSON('/api/translation/translate', {
                            text: extractRes.text,
                            targetLanguage: targetLanguage
                        });
                        file.progress = '50';
                        const methodLabel = translateRes.method === 'llm-openai' ? 'OpenAI' :
                            translateRes.method === 'llm-openrouter' ? 'OpenRouter' : 'heuristic (no LLM configured)';
                        addActivity('translation', `${file.name} > Translated to ${targetLanguage} (${methodLabel})`, 'Completed');
                        refreshServicePage('translation');

                        await waitIfPausedAsync('translation');
                        if (processState.stopped) return;

                        // ---- Applying Formatting Rules (cosmetic checkpoint -
                        // the real formatting happens in generate_translation_pdf) ----
                        activeAgentId = processAgents[2] ? processAgents[2].id : null;
                        file.progress = '65';
                        refreshServicePage('translation');
                        await sleep(300);
                        addActivity('translation', `${file.name} > Formatting applied`, 'Completed');
                        refreshServicePage('translation');

                        await waitIfPausedAsync('translation');
                        if (processState.stopped) return;

                        // ---- Prepare Output File - real save ----
                        activeAgentId = processAgents[3] ? processAgents[3].id : null;
                        refreshServicePage('translation');
                        const docName = originalFileName.replace(/\.[^.]+$/, '');
                        const saveRes = await postJSON('/api/translation/save-output', {
                            userId: CURRENT_USER_ID,
                            docName: docName,
                            originalText: extractRes.text,
                            translatedText: translateRes.translatedText,
                            targetLanguage: targetLanguage,
                            translationMethod: translateRes.method,
                            stagingPath: stagingPath,
                            originalFileName: originalFileName
                        });
                        file.progress = '85';
                        file.docName = docName;
                        addActivity('translation', `${file.name} > Output saved to ${saveRes.docFolder}`, 'Completed');
                        refreshServicePage('translation');

                        await waitIfPausedAsync('translation');
                        if (processState.stopped) return;

                        // ---- Create Download Link - real PDF ----
                        activeAgentId = processAgents[4] ? processAgents[4].id : null;
                        refreshServicePage('translation');
                        const pdfRes = await postJSON('/api/translation/generate-pdf', {
                            userId: CURRENT_USER_ID,
                            docName: docName
                        });
                        file.progress = '100';
                        addActivity('translation', `${file.name} > ${pdfRes.outputPdf} generated successfully`, 'Completed');

                        // ---- $1 processing fee ----
                        const now = new Date();
                        const txnId = 'TXN' + String(nextTransactionId++).padStart(3, '0');
                        paymentHistory.push({
                            id: txnId,
                            date: now.toISOString().split('T')[0],
                            time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }),
                            userId: CURRENT_USER_ID,
                            paymentType: 'Service Fee',
                            paymentMode: 'Wallet Balance',
                            description: `Translation - ${file.name}`,
                            credit: 0,
                            debit: 1
                        });
                        addActivity('translation', `${file.name} > Deduct $1 Balance (${txnId})`, 'Completed');

                        file.status = 'completed';
                        activeAgentId = null;
                        delete translationFileBlobs[file.id];
                        refreshServicePage('translation');
                        persistPaymentHistory();
                        persistServiceFiles('translation');

                    } catch (err) {
                        console.error('Translation processing error:', err);
                        file.status = 'error';
                        file.errorLabel = 'Error';
                        file.errorReason = 'Processing failed: ' + (err && err.message ? err.message :
                            'Unknown error. Make sure py/server.py is running with its dependencies installed (pip install -r requirements.txt).');
                        activeAgentId = null;
                        addActivity('translation', `${file.name} > Processing failed`, 'Error');
                        refreshServicePage('translation');
                        persistServiceFiles('translation');
                    }

                    await sleep(300);
                }
            }

            window.togglePause = function() {
                processState.isPaused = !processState.isPaused;
                const serviceId = activeSubItemId || 'lease-abstraction';
                const status = processState.isPaused ? 'Paused' : 'Resumed';
                addActivity(serviceId, `Process ${status}`, processState.isPaused ? 'Pending' : 'Processing');
                refreshServicePage(serviceId);
            };

            window.stopProcess = function() {
                processState.stopped = true;
                processState.isRunning = false;
                processState.isPaused = false;
                processState.isComplete = true;
                activeAgentId = null;
                const serviceId = activeSubItemId || 'lease-abstraction';
                addActivity(serviceId, 'Process Stopped', 'Error');
                showMessage('⏹️ Stopped', 'Process has been stopped.', ['OK']);
                refreshServicePage(serviceId);
                persistServiceFiles(serviceId);
            };

            window.clearFiles = function(serviceId) {
                showConfirm('🗑️ Clear Files', 'Are you sure you want to clear all uploaded files?', function(confirmed) {
                    if (confirmed) {
                        if (serviceId === 'translation') {
                            translationFiles = translationFiles.filter(f => f.userId !== CURRENT_USER_ID);
                            translationActivityLog = translationActivityLog.filter(a => a.userId !== CURRENT_USER_ID);
                            translationFileBlobs = {};
                        } else {
                            leaseFiles = leaseFiles.filter(f => f.userId !== CURRENT_USER_ID);
                            leaseActivityLog = leaseActivityLog.filter(a => a.userId !== CURRENT_USER_ID);
                            leaseFileBlobs = {};
                        }
                        refreshServicePage(serviceId);
                        persistServiceFiles(serviceId);
                        showMessage('🗑️ Cleared', 'All files and related activity log entries have been cleared.', ['OK']);
                    }
                });
            };

            // ============================================================
            // 16. ACTIVITY LOG DOWNLOAD
            // ============================================================
            window.downloadActivityLog = function() {
                const serviceId = activeSubItemId || 'lease-abstraction';
                const log = serviceId === 'translation' ? getMyTranslationActivityLog() : getMyLeaseActivityLog();

                if (log.length === 0) {
                    showWarning('No activities to download.');
                    return;
                }

                let logData = 'Date & Time | Activity | Status\n';
                logData += '='.repeat(50) + '\n';
                log.forEach(item => {
                    logData += `${item.time} | ${item.activity} | ${item.result}\n`;
                });

                const blob = new Blob([logData], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `Activity_Log_${new Date().toISOString().split('T')[0]}.txt`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);

                showMessage('✅ Downloaded', 'Activity log downloaded successfully.', ['OK']);
            };

            // ============================================================
            // 17. REFRESH SERVICE PAGE (in-place, flicker-free update)
            // ============================================================
            // While a process is running this gets called repeatedly (about once
            // per second, per step). Re-running the full loadContent() /
            // resetContentArea() pipeline here used to blank the whole page out
            // and fade it back in on every tick - that's what caused the visible
            // "blinking". Instead, when the relevant service page is the one
            // currently on screen, only the pieces that actually changed (file
            // table, activity log, agent strip, control buttons, file count,
            // connection status) are patched in place. Nothing is removed and
            // recreated, so there's no flicker and no scroll jump. If the user
            // has navigated away from this service page, the in-memory state is
            // still updated and simply renders correctly next time they open it.
            function refreshServicePage(serviceId) {
                if (serviceId !== 'lease-abstraction' && serviceId !== 'translation') return;
                if (activeSubItemId !== serviceId) return;

                const isTranslation = serviceId === 'translation';
                const files = isTranslation ? getMyTranslationFiles() : getMyLeaseFiles();
                const activityLog = isTranslation ? getMyTranslationActivityLog() : getMyLeaseActivityLog();

                const fileCountEl = document.getElementById('fileCountText');
                if (fileCountEl) {
                    fileCountEl.textContent = files.length > 0 ? `${files.length} file(s) uploaded` : 'No files uploaded yet';
                }

                const fileTableBody = document.getElementById('fileTableBody');
                if (fileTableBody) {
                    fileTableBody.innerHTML = buildFileTableRows(files) ||
                        '<tr><td colspan="4" style="text-align:center;padding:15px;color:rgba(0,0,0,0.3);">No files uploaded yet.</td></tr>';
                }

                const activityListEl = document.getElementById('activityList');
                if (activityListEl) {
                    activityListEl.innerHTML = buildActivityLogRows(activityLog) ||
                        '<tr><td colspan="3" style="text-align:center;padding:15px;color:rgba(0,0,0,0.3);">No activities recorded.</td></tr>';
                }

                const agentsRow = document.getElementById('agentsTopRow');
                if (agentsRow) {
                    agentsRow.innerHTML = buildAgentPillsHTML(serviceId);
                }

                const controlsWrap = document.getElementById('processControls');
                if (controlsWrap) {
                    controlsWrap.innerHTML = buildControlButtonsHTML(serviceId, files.length > 0);
                }

                const statusWrap = document.getElementById('connectionStatusWrap');
                if (statusWrap) {
                    statusWrap.innerHTML = buildConnectionStatusHTML();
                }

                const systemSelect = document.getElementById('systemConfigSelect');
                if (systemSelect) systemSelect.value = currentSystemConfig;
            }

            // ============================================================
            // 18. SYSTEM CONNECTION - auto-verified as soon as the user
            // picks Desktop / ShareFile / SharePoint from the dropdown.
            // ============================================================
            window.verifySystemConnection = function() {
                const select = document.getElementById('systemConfigSelect');
                const selected = select.value;

                // Desktop is the local machine - always available, no remote
                // handshake needed.
                if (selected === 'Desktop') {
                    connectionStatus = 'connected';
                    currentSystemConfig = 'Desktop';
                    refreshServicePage(activeSubItemId || 'lease-abstraction');
                    return;
                }

                // ShareFile / SharePoint: simulate a real connection attempt.
                const isConnected = Math.random() > 0.3;

                if (isConnected) {
                    connectionStatus = 'connected';
                    currentSystemConfig = selected;
                    refreshServicePage(activeSubItemId || 'lease-abstraction');
                    showMessage('✅ Connected', `Successfully connected to ${selected}.`, ['OK']);
                } else {
                    connectionStatus = 'disconnected';
                    currentSystemConfig = 'Desktop';
                    select.value = 'Desktop';
                    refreshServicePage(activeSubItemId || 'lease-abstraction');
                    showMessage('❌ Not Connected', `Failed to connect to ${selected}. Switched back to Desktop.`, ['OK']);
                    connectionStatus = 'connected';
                    refreshServicePage(activeSubItemId || 'lease-abstraction');
                }
            };

            // ============================================================
            // 19. FILE UPLOAD HANDLER
            // ============================================================
            window.handleFileUpload = function(event, serviceId) {
                const files = event.target.files;
                if (files.length === 0) return;

                const isTranslation = serviceId === 'translation';
                const idCounter = isTranslation ? nextTranslationFileId : nextLeaseFileId;

                let newFiles = [];
                for (let i = 0; i < files.length; i++) {
                    const file = files[i];

                    const newFile = {
                        id: idCounter + i,
                        userId: CURRENT_USER_ID,
                        name: file.name,
                        status: 'pending',
                        scanResult: '0',
                        progress: '0',
                        action: 'Pending',
                        savedPath: getUserClientFilePath(CURRENT_USER_ID, file.name)
                    };

                    if (isTranslation) {
                        const langSelect = document.getElementById('translationLangSelect');
                        newFile.targetLang = langSelect ? langSelect.value : 'English';
                    }

                    newFiles.push(newFile);
                }

                if (isTranslation) {
                    translationFiles = translationFiles.concat(newFiles);
                    nextTranslationFileId += newFiles.length;
                    for (let i = 0; i < files.length; i++) {
                        translationFileBlobs[newFiles[i].id] = files[i];
                    }
                } else {
                    leaseFiles = leaseFiles.concat(newFiles);
                    nextLeaseFileId += newFiles.length;
                    // Keep the real File objects in memory (JSON can't store
                    // bytes) so Start can actually upload them for real
                    // scanning/extraction - see runLeaseAbstractionPipeline().
                    for (let i = 0; i < files.length; i++) {
                        leaseFileBlobs[newFiles[i].id] = files[i];
                    }
                }

                refreshServicePage(serviceId);
                event.target.value = '';
                persistServiceFiles(serviceId);

                showMessage('✅ Upload Complete', `${newFiles.length} file(s) uploaded successfully.`, ['OK']);
            };

            // ============================================================
            // 20. PAYMENT METHODS FUNCTIONS
            // ============================================================
            function renderPaymentMethods() {
                const list = document.getElementById('paymentList');
                if (!list) return;

                const myMethods = getMyPaymentMethods();

                if (myMethods.length === 0) {
                    list.innerHTML =
                        '<li style="padding:15px; color:rgba(0,0,0,0.4); text-align:center;">No payment methods added yet.</li>';
                    populateBalancePaymentMethods();
                    return;
                }

                list.innerHTML = '';
                myMethods.forEach((method) => {
                    const li = document.createElement('li');
                    li.innerHTML = `
                        <div class="payment-info">
                            <span class="payment-icon">${method.icon}</span>
                            <div class="payment-details">
                                <span class="payment-name">${method.name} ${method.isDefault ? '<span style="color:darkblue;font-size:0.7rem;font-weight:600;">(Default)</span>' : ''}</span>
                                <span class="payment-sub">${method.details} ${method.expires ? '| Expires: ' + method.expires : ''}</span>
                            </div>
                        </div>
                        <div class="payment-actions">
                            ${!method.isDefault ? `<button class="default-btn" onclick="setDefaultPayment(${method.id})">Set Default</button>` : ''}
                            <button class="remove-btn" onclick="removePaymentMethod(${method.id})">Remove</button>
                        </div>
                    `;
                    list.appendChild(li);
                });

                populateBalancePaymentMethods();
            }

            function populateBalancePaymentMethods() {
                const select = document.getElementById('balancePaymentMethod');
                if (!select) return;

                const myMethods = getMyPaymentMethods();

                select.innerHTML = '';
                if (myMethods.length === 0) {
                    select.innerHTML = '<option value="">No payment methods available</option>';
                    return;
                }

                myMethods.forEach((method) => {
                    const option = document.createElement('option');
                    option.value = method.id;
                    option.textContent = method.name + ' (' + method.details + ')';
                    if (method.isDefault) option.selected = true;
                    select.appendChild(option);
                });
            }

            window.togglePaymentForm = function() {
                const type = document.getElementById('paymentType').value;
                const creditFields = document.getElementById('creditCardFields');
                const upiFields = document.getElementById('upiFields');

                if (type === 'credit-card') {
                    creditFields.style.display = 'block';
                    upiFields.style.display = 'none';
                } else if (type === 'upi') {
                    creditFields.style.display = 'none';
                    upiFields.style.display = 'block';
                }
            };

            window.addPaymentMethod = function() {
                const type = document.getElementById('paymentType').value;
                let name, details, icon, expires = '';

                if (type === 'credit-card') {
                    const cardNumber = document.getElementById('cardNumber').value.trim();
                    const cardName = document.getElementById('cardName').value.trim();
                    const expiry = document.getElementById('expiryDate').value.trim();
                    const cvv = document.getElementById('cvv').value.trim();

                    if (!cardNumber || !cardName) {
                        showWarning('Please fill in all required fields.');
                        return;
                    }

                    name = cardName;
                    details = '**** ' + cardNumber.slice(-4);
                    icon = '💳';
                    expires = expiry;

                } else if (type === 'upi') {
                    const upiId = document.getElementById('upiId').value.trim();
                    if (!upiId) {
                        showWarning('Please enter UPI ID.');
                        return;
                    }
                    name = 'UPI';
                    details = upiId;
                    icon = '📱';
                }

                const newMethod = {
                    id: nextPaymentId++,
                    name: name,
                    details: details,
                    icon: icon,
                    expires: expires,
                    isDefault: getMyPaymentMethods().length === 0,
                    type: type,
                    userId: CURRENT_USER_ID
                };

                paymentMethods.push(newMethod);
                renderPaymentMethods();

                document.getElementById('cardNumber').value = '';
                document.getElementById('cardName').value = '';
                document.getElementById('expiryDate').value = '';
                document.getElementById('cvv').value = '';
                document.getElementById('upiId').value = '';
                persistPaymentMethods();

                showMessage('✅ Success', 'Payment method added successfully!', ['OK']);
            };

            window.setDefaultPayment = function(id) {
                paymentMethods.forEach(m => { if (m.userId === CURRENT_USER_ID) m.isDefault = (m.id === id); });
                renderPaymentMethods();
                persistPaymentMethods();
                const method = paymentMethods.find(m => m.id === id);
                showMessage('✅ Updated', `"${method.name}" is now your default payment method.`, ['OK']);
            };

            window.removePaymentMethod = function(id) {
                const method = paymentMethods.find(m => m.id === id);
                if (method.isDefault) {
                    showWarning('Cannot remove the default payment method. Please set another as default first.');
                    return;
                }
                showConfirm('🗑️ Remove Payment Method', `Are you sure you want to remove "${method.name}"?`, function(
                confirmed) {
                    if (confirmed) {
                        paymentMethods = paymentMethods.filter(m => m.id !== id);
                        renderPaymentMethods();
                        persistPaymentMethods();
                        showMessage('🗑️ Removed', `"${method.name}" has been removed successfully.`, ['OK']);
                    }
                });
            };

            // ============================================================
            // 21. PAYMENT HISTORY FUNCTIONS
            // ============================================================
            function getDefaultHistoryRange() {
                const today = new Date();
                const fromDate = new Date();
                fromDate.setDate(today.getDate() - 4);
                const toStr = today.toISOString().split('T')[0];
                const fromStr = fromDate.toISOString().split('T')[0];
                return { from: fromStr, to: toStr };
            }

            function getFilteredHistory() {
                const fromInput = document.getElementById('historyFromDate');
                const toInput = document.getElementById('historyToDate');
                const userInput = document.getElementById('historyUserFilter');

                let base = getVisiblePaymentHistory();

                if (fromInput && toInput && fromInput.value && toInput.value) {
                    base = base.filter(t => t.date >= fromInput.value && t.date <= toInput.value);
                }
                if (userInput && userInput.value.trim()) {
                    const q = userInput.value.trim().toLowerCase();
                    base = base.filter(t => {
                        const dirEntry = getUserDirectoryEntry(t.userId);
                        const email = dirEntry ? (dirEntry.email || '').toLowerCase() : '';
                        return (t.userId || '').toLowerCase().includes(q) || email.includes(q);
                    });
                }
                return base;
            }

            function renderHistoryRows(tbody, list) {
                if (list.length === 0) {
                    tbody.innerHTML =
                        '<tr><td colspan="8" style="text-align:center;padding:20px;color:rgba(0,0,0,0.4);">No transactions found.</td></tr>';
                    return;
                }
                tbody.innerHTML = '';
                const sortedHistory = [...list].sort((a, b) => new Date(b.date) - new Date(a.date));
                sortedHistory.forEach((transaction) => {
                    const tr = document.createElement('tr');
                    const formattedDate = new Date(transaction.date).toLocaleDateString('en-US', {
                        year: 'numeric',
                        month: 'short',
                        day: '2-digit'
                    });
                    // Transaction Date & Time together in a single column
                    const dateTimeText = transaction.time ? `${formattedDate}, ${transaction.time}` : formattedDate;
                    tr.innerHTML = `
                        <td>${dateTimeText}</td>
                        <td><span style="font-weight:500;color:darkblue;">${transaction.id}</span></td>
                        <td>${escapeHtml(transaction.userId || '')}</td>
                        <td>${transaction.paymentType}</td>
                        <td>${transaction.paymentMode}</td>
                        <td>${transaction.description}</td>
                        <td class="credit">${transaction.credit > 0 ? '$' + transaction.credit.toFixed(2) : '-'}</td>
                        <td class="debit">${transaction.debit > 0 ? '$' + transaction.debit.toFixed(2) : '-'}</td>
                    `;
                    tbody.appendChild(tr);
                });
            }

            function renderPaymentHistory() {
                const tbody = document.getElementById('historyTableBody');
                if (!tbody) return;

                // Dates start blank by default - getFilteredHistory() already
                // returns every transaction for this user when no range is set.
                const filtered = getFilteredHistory();
                renderHistoryRows(tbody, filtered);
                updateSummary(filtered);
            }

            window.applyHistoryFilter = function() {
                const fromInput = document.getElementById('historyFromDate');
                const toInput = document.getElementById('historyToDate');
                if (!fromInput.value || !toInput.value) {
                    showWarning('Please select both From and To dates.');
                    return;
                }
                if (fromInput.value > toInput.value) {
                    showWarning('"From" date cannot be after "To" date.');
                    return;
                }
                const tbody = document.getElementById('historyTableBody');
                const filtered = getFilteredHistory();
                renderHistoryRows(tbody, filtered);
                updateSummary(filtered);
            };

            window.clearHistoryFilter = function() {
                document.getElementById('historyFromDate').value = '';
                document.getElementById('historyToDate').value = '';
                const tbody = document.getElementById('historyTableBody');
                const filtered = getFilteredHistory();
                renderHistoryRows(tbody, filtered);
                updateSummary(filtered);
            };

            window.downloadHistoryExcel = function() {
                const filtered = getFilteredHistory();
                if (filtered.length === 0) {
                    showWarning('No data available to download for the selected range.');
                    return;
                }
                const sorted = [...filtered].sort((a, b) => new Date(b.date) - new Date(a.date));
                const headers = ['Transaction Date & Time', 'Transaction ID', 'Payment Type', 'Payment Mode',
                    'Description', 'Credit', 'Debit'
                ];
                let table = '<table border="1"><tr>' + headers.map(h => `<th>${h}</th>`).join('') + '</tr>';
                sorted.forEach(t => {
                    const dateTimeText = t.time ? `${t.date}, ${t.time}` : t.date;
                    table += '<tr>' +
                        `<td>${dateTimeText}</td><td>${t.id}</td><td>${t.paymentType}</td>` +
                        `<td>${t.paymentMode}</td><td>${t.description}</td>` +
                        `<td>${t.credit > 0 ? t.credit.toFixed(2) : ''}</td>` +
                        `<td>${t.debit > 0 ? t.debit.toFixed(2) : ''}</td>` +
                        '</tr>';
                });
                table += '</table>';

                const blob = new Blob(['\ufeff' + table], { type: 'application/vnd.ms-excel' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'Payment_History_' + new Date().toISOString().split('T')[0] + '.xls';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            };

            function updateSummary(list) {
                const data = list || getMyPaymentHistory();
                let totalCredit = 0,
                    totalDebit = 0;
                data.forEach(t => { totalCredit += t.credit;
                    totalDebit += t.debit; });
                const balance = totalCredit - totalDebit;

                document.getElementById('totalCredit').textContent = '$' + totalCredit.toFixed(2);
                document.getElementById('totalDebit').textContent = '$' + totalDebit.toFixed(2);
                document.getElementById('currentBalance').textContent = '$' + balance.toFixed(2);
            }

            // ============================================================
            // 22. BALANCE FUNCTIONS
            // ============================================================
            function updateBalanceDisplay() {
                let totalCredit = 0,
                    totalDebit = 0;
                getMyPaymentHistory().forEach(t => { totalCredit += t.credit;
                    totalDebit += t.debit; });
                const balance = totalCredit - totalDebit;

                const creditEl = document.getElementById('totalCreditBalance');
                const debitEl = document.getElementById('totalDebitBalance');
                const balanceEl = document.getElementById('currentBalanceDisplay');

                if (creditEl) creditEl.textContent = '$' + totalCredit.toFixed(2);
                if (debitEl) debitEl.textContent = '$' + totalDebit.toFixed(2);
                if (balanceEl) balanceEl.textContent = '$' + balance.toFixed(2);
            }

            window.addBalance = function() {
                const methodSelect = document.getElementById('balancePaymentMethod');
                const amountInput = document.getElementById('balanceAmount');
                const descInput = document.getElementById('balanceDescription');

                const methodId = parseInt(methodSelect.value);
                const amount = parseFloat(amountInput.value);
                const description = descInput.value.trim();

                if (!methodId) { showWarning('Please select a payment method.'); return; }
                if (!amount || amount <= 0) { showWarning('Please enter a valid amount.'); return; }
                if (!description) { showWarning('Please enter a description.'); return; }

                const method = paymentMethods.find(m => m.id === methodId);
                if (!method) { showWarning('Selected payment method not found.'); return; }

                const now = new Date();
                const txnId = 'TXN' + String(nextTransactionId++).padStart(3, '0');
                const newTransaction = {
                    id: txnId,
                    date: now.toISOString().split('T')[0],
                    time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }),
                    userId: CURRENT_USER_ID,
                    paymentType: method.type === 'upi' ? 'UPI' : method.type === 'credit-card' ? 'Credit Card' :
                        'Bank Transfer',
                    paymentMode: method.name + ' ' + method.details,
                    description: description,
                    credit: amount,
                    debit: 0
                };

                paymentHistory.push(newTransaction);

                // Whoever adds balance, the real "money received" also
                // shows up in the Developer's own Payment History as
                // revenue - the entry above is what makes the ADDING
                // user's own spendable balance go up; this one just
                // records that the Developer's primary account is who
                // actually received it.
                const developerId = getDeveloperUserId();
                if (developerId && developerId !== CURRENT_USER_ID) {
                    const whoAdded = profileData ? `${profileData.firstName} ${profileData.lastName} (${CURRENT_USER_ID})` : CURRENT_USER_ID;
                    paymentHistory.push({
                        id: 'TXN' + String(nextTransactionId++).padStart(3, '0'),
                        date: newTransaction.date,
                        time: newTransaction.time,
                        userId: developerId,
                        paymentType: 'Balance Received',
                        paymentMode: newTransaction.paymentMode,
                        description: `Balance added by ${whoAdded}: ${description}`,
                        credit: amount,
                        debit: 0
                    });
                }

                amountInput.value = '';
                descInput.value = '';

                renderPaymentHistory();
                updateBalanceDisplay();
                persistPaymentHistory();
                addNotification(`$${amount.toFixed(2)} was added to your balance (Transaction ID: ${txnId}).`);
                showMessage('✅ Success', `$${amount.toFixed(2)} added successfully! Transaction ID: ${txnId}`, ['OK']);
            };

            // ============================================================
            // 23. MESSAGE BOX
            // ============================================================
            // Title/buttons config per message type now lives in messages.json
            // (loaded in loadAppData) instead of being hardcoded here.
            let MESSAGES = {
                success: { title: '✅ Success', buttons: ['OK'], blocking: false },
                warning: { title: '⚠️ Warning', buttons: ['OK'], blocking: false },
                error: { title: '❌ Error', buttons: ['OK'], blocking: false },
                confirm: { title: '❓ Confirm', buttons: ['Yes', 'No'], blocking: true },
                info: { title: 'ℹ️ Information', buttons: ['OK'], blocking: false }
            };

            const msgOverlay = document.getElementById('messageOverlay');
            const msgTitle = document.getElementById('msgTitle');
            const msgText = document.getElementById('msgText');
            const msgButtons = document.getElementById('msgButtons');
            let onMsgButtonClick = null;

            window.handleButtonClick = function(label) {
                if (msgOverlay) {
                    msgOverlay.style.display = 'none';
                }
                document.body.classList.remove('disable-bg');

                if (typeof onMsgButtonClick === 'function') {
                    try { onMsgButtonClick(label); } catch (e) { console.warn('MessageBox callback error:', e); }
                }
                onMsgButtonClick = null;
            };

            function renderMessageBox(cfg, callback) {
                if (typeof callback === 'function') { onMsgButtonClick = callback; } else { onMsgButtonClick = null; }

                let buttons = cfg.buttons || ['OK'];
                if (!Array.isArray(buttons)) buttons = [String(buttons)];

                msgTitle.textContent = cfg.title || 'Message';
                msgText.textContent = cfg.message || '';

                msgButtons.innerHTML = '';
                buttons.forEach((label) => {
                    const btn = document.createElement('button');
                    btn.className = 'msg-action-btn';
                    btn.textContent = label;
                    btn.addEventListener('click', function(e) {
                        e.stopPropagation();
                        handleButtonClick(label);
                    });
                    msgButtons.appendChild(btn);
                });

                msgOverlay.style.display = 'flex';
                document.body.classList.add('disable-bg');
                msgOverlay.style.animation = 'none';
                requestAnimationFrame(() => {
                    msgOverlay.style.animation = 'msgFadeIn 0.2s ease';
                });
            }

            function showMessage(title, message, buttons) {
                renderMessageBox({ title: title, message: message, buttons: buttons || ['OK'] });
            }

            window.showWarning = function(message) {
                renderMessageBox({ title: MESSAGES.warning.title, message: message, buttons: ['OK'] });
            };

            window.showConfirm = function(title, message, callback) {
                renderMessageBox({ title: title || MESSAGES.confirm.title, message: message, buttons: ['Yes', 'No'] },
                    function(label) {
                        callback(label === 'Yes');
                    });
            };

            msgOverlay.addEventListener('click', function(e) {
                if (e.target === msgOverlay) { handleButtonClick('Close'); }
            });

            document.addEventListener('keydown', function(e) {
                if (e.key === 'Escape' && msgOverlay.style.display === 'flex') { handleButtonClick('Close'); }
            });

            // ============================================================
            // 24. API KEY FUNCTIONS
            // ============================================================
            function generateRandomKey() {
                const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
                let key = 'tc_live_';
                for (let i = 0; i < 32; i++) { key += chars.charAt(Math.floor(Math.random() * chars.length)); }
                return key;
            }

            function getActiveApiKey() {
                return apiKeys.find(k => k.status !== 'revoked') || null;
            }

            window.generateApiKey = function() {
                const newKey = {
                    id: nextApiKeyId++,
                    key: generateRandomKey(),
                    createdAt: new Date().toLocaleString(),
                    status: 'active',
                    saved: false
                };
                apiKeys.unshift(newKey);
                if (profileData) profileData.apiKey = newKey.key;
                renderApiKeyDisplay();
                persistApiKeys();
                persistProfile();
                showMessage('✅ API Key Generated',
                    'Your new API key has been generated successfully. Please copy and store it securely.', ['OK']);
            };

            window.copyApiKey = function() {
                const activeKey = getActiveApiKey();
                if (!activeKey) { showWarning('No active API key to copy. Generate one first.'); return; }

                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(activeKey.key).then(() => {
                        showMessage('📋 Copied', 'API key copied to clipboard.', ['OK']);
                    }).catch(() => {
                        showMessage('📋 API Key', `Copy failed automatically — here is your key:\n${activeKey.key}`, ['OK']);
                    });
                } else {
                    showMessage('📋 API Key', `Your API key:\n${activeKey.key}`, ['OK']);
                }
            };

            window.saveApiKey = function() {
                const activeKey = getActiveApiKey();
                if (!activeKey) { showWarning('No active API key to save. Generate one first.'); return; }

                activeKey.saved = true;
                if (profileData) profileData.apiKey = activeKey.key;
                renderApiKeyDisplay();
                persistApiKeys();
                persistProfile();
                showMessage('💾 Saved', 'API key has been saved to your account record.', ['OK']);
            };

            window.revokeApiKey = function() {
                const activeKey = getActiveApiKey();
                if (!activeKey) { showWarning('No active API key to revoke.'); return; }

                showConfirm('🚫 Revoke API Key',
                    'Are you sure you want to revoke this API key? Any application using it will stop working immediately.',
                    function(confirmed) {
                        if (confirmed) {
                            activeKey.status = 'revoked';
                            activeKey.revokedAt = new Date().toLocaleString();
                            if (profileData && profileData.apiKey === activeKey.key) profileData.apiKey = null;
                            renderApiKeyDisplay();
                            persistApiKeys();
                            persistProfile();
                            showMessage('🚫 Revoked', 'The API key has been revoked and can no longer be used.', ['OK']);
                        }
                    });
            };

            function renderApiKeyDisplay() {
                const display = document.getElementById('apiKeyDisplay');
                const actionsEl = document.getElementById('apiKeyActions');
                const historyEl = document.getElementById('apiKeyHistory');
                if (!display) return;

                const activeKey = getActiveApiKey();

                if (!activeKey) {
                    display.textContent = 'No active API key. Click "Generate New API Key" to create one.';
                } else {
                    display.innerHTML = `<span style="font-family:monospace;">${activeKey.key}</span>` +
                        (activeKey.saved ?
                            ' <span style="font-size:0.7rem;color:#27ae60;font-weight:600;">(Saved)</span>' : '');
                }

                if (actionsEl) {
                    actionsEl.style.display = 'flex';
                }

                if (historyEl) {
                    const others = apiKeys.filter(k => k !== activeKey);
                    if (others.length === 0) {
                        historyEl.innerHTML = '';
                    } else {
                        historyEl.innerHTML =
                            '<div style="margin-top:14px;font-size:0.8rem;color:rgba(0,0,0,0.6);">Previous keys:</div>' +
                            '<ul style="list-style:none;padding:0;margin-top:6px;">' +
                            others.map(k =>
                                `<li style="padding:6px 0;border-bottom:1px solid rgba(0,0,139,0.05);font-family:monospace;font-size:0.8rem;">${k.key} <span style="color:rgba(0,0,0,0.4);font-family:inherit;">(${k.createdAt}${k.status === 'revoked' ? ' — Revoked' : ''})</span></li>`
                                ).join('') +
                            '</ul>';
                    }
                }
            }

            function renderServicesApiList() {
                const container = document.getElementById('servicesApiList');
                if (!container) return;

                const servicesMenu = MENU_CONFIG.mainMenu.find(m => m.id === 'services');
                if (!servicesMenu) return;

                container.innerHTML = servicesMenu.subItems.map(sub => {
                    const apiData = SERVICES_API_DATA[sub.id];
                    if (!apiData) return '';
                    return `
                        <div class="service-api-block">
                            <h4>${apiData.icon} ${apiData.label}</h4>
                            <div class="api-endpoint-row">
                                <span class="api-method get">GET</span>
                                <span class="api-endpoint-path">${apiData.get.endpoint}</span>
                            </div>
                            <p class="api-endpoint-desc">${apiData.get.description}</p>
                            <pre class="api-example">${apiData.get.example}</pre>
                            <div class="api-endpoint-row">
                                <span class="api-method post">POST</span>
                                <span class="api-endpoint-path">${apiData.post.endpoint}</span>
                            </div>
                            <p class="api-endpoint-desc">${apiData.post.description}</p>
                            <pre class="api-example">${apiData.post.example}</pre>
                        </div>
                    `;
                }).join('');
            }

            // ============================================================
            // 25. SUPPORT TABLE FUNCTIONS
            // ============================================================
            function escapeHtml(str) {
                return String(str == null ? '' : str)
                    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
            }

            let selectedSupportIds = new Set();

            function renderSupportRows(tbody, list) {
                if (list.length === 0) {
                    tbody.innerHTML =
                        '<tr><td colspan="10" style="text-align:center;padding:20px;color:rgba(0,0,0,0.4);">No submissions found.</td></tr>';
                    return;
                }
                // Defensive: backfill an id for any record that's missing one
                // (e.g. hand-edited via the Admin File Manager) so a row can
                // never silently fail to open in the message card.
                list.forEach(item => {
                    if (!item.id) item.id = generateNextSupportId();
                });
                const sorted = [...list].sort((a, b) => new Date(b.date) - new Date(a.date));
                tbody.innerHTML = sorted.map(item => `
                    <tr class="support-row ${selectedSupportIds.has(item.id) ? 'row-checked' : ''} ${selectedSupportId === item.id ? 'selected' : ''}">
                        <td onclick="event.stopPropagation();"><input type="checkbox" class="support-row-check" data-id="${item.id}" ${selectedSupportIds.has(item.id) ? 'checked' : ''} onchange="toggleSupportRowCheck('${item.id}', this)" /></td>
                        <td onclick="selectSupportRow('${item.id}')"><span style="font-weight:500;color:darkblue;">${escapeHtml(item.id)}</span></td>
                        <td onclick="selectSupportRow('${item.id}')">${item.date}</td>
                        <td onclick="selectSupportRow('${item.id}')">${item.time}</td>
                        <td onclick="selectSupportRow('${item.id}')">${escapeHtml(item.userId || '')}</td>
                        <td onclick="selectSupportRow('${item.id}')">${item.type}</td>
                        <td onclick="selectSupportRow('${item.id}')">${escapeHtml(item.subject)}</td>
                        <td onclick="selectSupportRow('${item.id}')">${escapeHtml(item.message)}</td>
                        <td onclick="selectSupportRow('${item.id}')"><span class="status-badge ${item.status === 'Resolved' ? 'status-resolved' : 'status-pending'}">${escapeHtml(item.status)}</span></td>
                        <td onclick="selectSupportRow('${item.id}')">${escapeHtml(item.response)}</td>
                    </tr>
                `).join('');
            }

            function getFilteredSupport() {
                const fromInput = document.getElementById('supportFromDate');
                const toInput = document.getElementById('supportToDate');
                const statusInput = document.getElementById('supportStatusFilter');
                const userInput = document.getElementById('supportUserFilter');

                let base = getVisibleContactSubmissions();

                if (fromInput && toInput && fromInput.value && toInput.value) {
                    base = base.filter(t => t.date >= fromInput.value && t.date <= toInput.value);
                }
                if (statusInput && statusInput.value) {
                    base = base.filter(t => t.status === statusInput.value);
                }
                if (userInput && userInput.value.trim()) {
                    const q = userInput.value.trim().toLowerCase();
                    base = base.filter(t => {
                        const dirEntry = getUserDirectoryEntry(t.userId);
                        const email = dirEntry ? (dirEntry.email || '').toLowerCase() : '';
                        return (t.userId || '').toLowerCase().includes(q) || email.includes(q);
                    });
                }
                return base;
            }

            function renderSupportTable() {
                const tbody = document.getElementById('supportTableBody');
                if (!tbody) return;

                // Deliberately no default From/To pre-fill - every submission
                // shows by default; a date range only narrows things down
                // once the user actually picks one and applies it.
                renderSupportRows(tbody, getFilteredSupport());
            }

            window.toggleSupportRowCheck = function(id, checkbox) {
                if (checkbox.checked) selectedSupportIds.add(id);
                else selectedSupportIds.delete(id);
            };

            window.toggleSupportSelectAll = function(checkbox) {
                document.querySelectorAll('.support-row-check').forEach((cb) => {
                    cb.checked = checkbox.checked;
                    if (checkbox.checked) selectedSupportIds.add(cb.dataset.id);
                    else selectedSupportIds.delete(cb.dataset.id);
                });
            };

            window.deleteSelectedSupport = function() {
                if (selectedSupportIds.size === 0) {
                    showWarning('Select at least one query first.');
                    return;
                }
                const count = selectedSupportIds.size;
                showConfirm('🗑️ Delete', `Delete ${count} selected item(s)? This cannot be undone.`, function(confirmed) {
                    if (!confirmed) return;
                    contactSubmissions = contactSubmissions.filter(c => !selectedSupportIds.has(c.id));
                    if (selectedSupportId && selectedSupportIds.has(selectedSupportId)) {
                        closeMessagePopup();
                    }
                    selectedSupportIds.clear();
                    persistContactSubmissions();
                    renderSupportRows(document.getElementById('supportTableBody'), getFilteredSupport());
                    showMessage('🗑️ Deleted', 'Selected item(s) have been deleted.', ['OK']);
                });
            };

            window.applySupportFilter = function() {
                const fromInput = document.getElementById('supportFromDate');
                const toInput = document.getElementById('supportToDate');
                if (!fromInput.value || !toInput.value) {
                    showWarning('Please select both From and To dates.');
                    return;
                }
                if (fromInput.value > toInput.value) {
                    showWarning('"From" date cannot be after "To" date.');
                    return;
                }
                renderSupportRows(document.getElementById('supportTableBody'), getFilteredSupport());
            };

            window.resetSupportFilter = function() {
                document.getElementById('supportFromDate').value = '';
                document.getElementById('supportToDate').value = '';
                renderSupportRows(document.getElementById('supportTableBody'), getFilteredSupport());
            };

            window.downloadSupportExcel = function() {
                const filtered = getFilteredSupport();
                if (filtered.length === 0) {
                    showWarning('No data available to download for the selected range.');
                    return;
                }
                const sorted = [...filtered].sort((a, b) => new Date(b.date) - new Date(a.date));
                const headers = ['ID', 'Date', 'Time', 'Type', 'Subject', 'Message', 'Status', 'Response'];
                let table = '<table border="1"><tr>' + headers.map(h => `<th>${h}</th>`).join('') + '</tr>';
                sorted.forEach(t => {
                    table += '<tr>' +
                        `<td>${t.id}</td><td>${t.date}</td><td>${t.time}</td><td>${t.type}</td>` +
                        `<td>${t.subject}</td><td>${t.message}</td>` +
                        `<td>${t.status}</td><td>${t.response}</td>` +
                        '</tr>';
                });
                table += '</table>';

                const blob = new Blob(['\ufeff' + table], { type: 'application/vnd.ms-excel' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'Support_Submissions_' + new Date().toISOString().split('T')[0] + '.xls';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            };

            // ============================================================
            // 26. CONTACT FORM FUNCTIONS
            // ============================================================
            let selectedSupportId = null;

            // ID + Status share the top row (ID narrow, Status to its
            // right); Response is full width (same width as Message),
            // placed below the button row - only the editability of
            // Type/Subject/Message and the button row change between modes.
            // Ticket IDs are YYMMDD + a 5-digit daily sequence (e.g.
            // 26070200001 for the first ticket on 2026-07-02) so they sort
            // naturally by date and are sequential within a day.
            function generateNextSupportId() {
                const now = new Date();
                const datePrefix = String(now.getFullYear()).slice(-2) +
                    String(now.getMonth() + 1).padStart(2, '0') +
                    String(now.getDate()).padStart(2, '0');
                let maxSeq = 0;
                contactSubmissions.forEach(c => {
                    const id = c.id || '';
                    if (id.startsWith(datePrefix) && id.length === 11) {
                        const n = parseInt(id.slice(6), 10);
                        if (!isNaN(n) && n > maxSeq) maxSeq = n;
                    }
                });
                return datePrefix + String(maxSeq + 1).padStart(5, '0');
            }

            // opts.mode: 'compose' (Type+Subject+Message+Create only - no
            // ID/Status/Response at all), 'view-user' (everything readonly,
            // no buttons), or 'view-admin' (Type/Subject/Message readonly,
            // but Status is a real dropdown and Response is editable, plus
            // a Submit button - Developer/Admin can respond and change
            // status but never touch what the user actually wrote).
            function buildContactCardHTML(opts) {
                if (opts.mode === 'compose') {
                    return `
                        <div class="form-row contact-type-subject-row">
                            <div class="form-group">
                                <label>Type</label>
                                <select id="contactType">
                                    <option value="Query">Query</option>
                                    <option value="Inquiry">Inquiry</option>
                                    <option value="Complaint">Complaint</option>
                                </select>
                            </div>
                            <div class="form-group">
                                <label>Subject *</label>
                                <input type="text" id="contactSubject" placeholder="Enter subject" />
                            </div>
                        </div>
                        <div class="form-group">
                            <label>Message *</label>
                            <textarea id="contactMessage" rows="5" placeholder="Type your message here..."></textarea>
                        </div>
                        <div style="display:flex;gap:10px;">
                            <button class="submit-btn" onclick="submitContactForm()">➕ Create</button>
                        </div>
                    `;
                }

                const isAdminEdit = opts.mode === 'view-admin';
                return `
                    <div class="form-row contact-id-status-row">
                        <div class="form-group">
                            <label>Ticket ID</label>
                            <div class="contact-readonly-label">${escapeHtml(opts.id)}</div>
                        </div>
                        <div class="form-group">
                            <label>Status</label>
                            ${isAdminEdit ? `
                                <select id="contactStatus">
                                    <option value="Pending" ${opts.status === 'Pending' ? 'selected' : ''}>Pending</option>
                                    <option value="WIP" ${opts.status === 'WIP' ? 'selected' : ''}>WIP</option>
                                    <option value="Resolved" ${opts.status === 'Resolved' ? 'selected' : ''}>Resolved</option>
                                </select>
                            ` : `<div class="contact-readonly-label">${escapeHtml(opts.status || '-')}</div>`}
                        </div>
                    </div>
                    <div class="form-row contact-type-subject-row">
                        <div class="form-group">
                            <label>Type</label>
                            <div class="contact-readonly-label">${escapeHtml(opts.type)}</div>
                        </div>
                        <div class="form-group">
                            <label>Subject</label>
                            <div class="contact-readonly-label">${escapeHtml(opts.subject)}</div>
                        </div>
                    </div>
                    <div class="form-group">
                        <label>Message</label>
                        <textarea rows="4" disabled style="opacity:0.7;">${escapeHtml(opts.message || '')}</textarea>
                    </div>
                    <div class="form-group">
                        <label>Response</label>
                        <textarea id="contactResponse" rows="3" ${isAdminEdit ? `placeholder="Write a response..."` : 'disabled style="opacity:0.7;"'}>${opts.response && opts.response !== '-' ? escapeHtml(opts.response) : ''}</textarea>
                    </div>
                    ${isAdminEdit ? `
                        <div style="display:flex;gap:10px;">
                            <button class="submit-btn" onclick="submitTicketUpdate('${opts.id}')">📤 Submit</button>
                        </div>
                    ` : ''}
                `;
            }

            // ---- "Send us a Message" / Ticket Details popup (triggered by
            // a row click or the "Create New" link - the log table itself
            // is full width, with no permanently-visible side card). ----
            window.openMessagePopup = function(mode, item) {
                let fieldsHtml, title;
                if (mode === 'compose') {
                    selectedSupportId = null;
                    fieldsHtml = buildContactCardHTML({ mode: 'compose' });
                    title = '✉️ Send us a Message';
                } else {
                    selectedSupportId = item.id;
                    fieldsHtml = buildContactCardHTML({
                        id: item.id, type: item.type, subject: item.subject, message: item.message,
                        response: item.response, status: item.status,
                        mode: isAdminOrDeveloper() ? 'view-admin' : 'view-user'
                    });
                    title = '🎫 Ticket Details';
                }

                const html = `
                    <div class="admin-modal-overlay" id="messagePopupOverlay">
                        <div class="admin-modal-card message-popup-card">
                            <button class="admin-modal-close" onclick="closeMessagePopup()">✕</button>
                            <h3 class="admin-modal-title">${title}</h3>
                            <div class="payment-form" id="contactCardBody">${fieldsHtml}</div>
                        </div>
                    </div>
                `;
                const existing = document.getElementById('messagePopupOverlay');
                if (existing) existing.remove();
                document.body.insertAdjacentHTML('beforeend', html);

                const tbody = document.getElementById('supportTableBody');
                if (tbody) renderSupportRows(tbody, getFilteredSupport());
            };

            window.closeMessagePopup = function() {
                const overlay = document.getElementById('messagePopupOverlay');
                if (overlay) overlay.remove();
                selectedSupportId = null;
                const tbody = document.getElementById('supportTableBody');
                if (tbody) renderSupportRows(tbody, getFilteredSupport());
            };

            window.selectSupportRow = function(id) {
                const item = contactSubmissions.find(c => c.id === id);
                if (!item) return;
                openMessagePopup('view', item);
            };

            window.submitContactForm = function() {
                const typeSelect = document.getElementById('contactType');
                const subjectInput = document.getElementById('contactSubject');
                const messageInput = document.getElementById('contactMessage');

                const type = typeSelect.value;
                const subject = subjectInput.value.trim();
                const message = messageInput.value.trim();

                if (!subject || !message) {
                    showWarning('Please fill in both Subject and Message.');
                    return;
                }

                const now = new Date();
                const ticketId = generateNextSupportId();
                contactSubmissions.push({
                    id: ticketId,
                    userId: CURRENT_USER_ID,
                    date: now.toISOString().split('T')[0],
                    time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
                    type: type,
                    subject: subject,
                    message: message,
                    status: 'Pending',
                    response: '-'
                });

                closeMessagePopup();
                persistContactSubmissions();
                sendContactAcknowledgementEmail(ticketId, type, subject, message);
                const tbody = document.getElementById('supportTableBody');
                if (tbody) renderSupportRows(tbody, getFilteredSupport());
                showMessage('✅ Ticket Created', `Thank you for reaching out! Your ticket ID is <strong>${ticketId}</strong>. Our team will get back to you shortly.`, ['OK']);
            };

            window.submitTicketUpdate = function(id) {
                const item = contactSubmissions.find(c => c.id === id);
                if (!item) return;
                const statusSelect = document.getElementById('contactStatus');
                const responseInput = document.getElementById('contactResponse');

                item.status = statusSelect.value;
                item.response = responseInput.value.trim() || '-';

                persistContactSubmissions();
                closeMessagePopup();
                sendTicketUpdateEmail(item);
                const tbody = document.getElementById('supportTableBody');
                if (tbody) renderSupportRows(tbody, getFilteredSupport());
                showMessage('✅ Updated', 'The ticket status and response have been saved.', ['OK']);
            };

            // Fires the acknowledgement email in the background via the backend's
            // SMTP endpoint (credentials in .env). Failures are logged quietly -
            // the user has already seen the "Ticket Created" confirmation, and a
            // missing/unreachable SMTP server shouldn't block the submission.
            function sendContactAcknowledgementEmail(ticketId, type, subject, message) {
                const recipient = (profileData && profileData.email) || (COMPANY_INFO && COMPANY_INFO.email);
                if (!recipient) return;

                authFetch('/api/send-acknowledgement', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        toEmail: recipient,
                        userName: profileData ? `${profileData.firstName} ${profileData.lastName}` : 'there',
                        ticketId: ticketId,
                        type: type,
                        subject: subject,
                        message: message
                    })
                }).catch(e => console.warn('Acknowledgement email could not be sent:', e));
            }

            // Notifies the ticket's original owner by email once an admin/
            // developer submits a status/response update.
            function sendTicketUpdateEmail(item) {
                const dirEntry = getUserDirectoryEntry(item.userId);
                const recipient = dirEntry ? dirEntry.email : null;
                if (!recipient) return;

                authFetch('/api/send-ticket-update', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        toEmail: recipient,
                        userName: dirEntry ? `${dirEntry.firstName} ${dirEntry.lastName}` : 'there',
                        ticketId: item.id,
                        status: item.status,
                        response: item.response,
                        subject: item.subject
                    })
                }).catch(e => console.warn('Ticket update email could not be sent:', e));
            }

            // ============================================================
            // 27. DASHBOARD FUNCTIONS
            // ============================================================
            function renderTodayTransactions() {
                const tbody = document.getElementById('todayTableBody');
                if (!tbody) return;

                const myHistory = getMyPaymentHistory();
                const todayStr = new Date().toISOString().split('T')[0];
                const todayList = myHistory.filter(t => t.date === todayStr);

                if (todayList.length === 0) {
                    tbody.innerHTML =
                        '<tr><td colspan="8" style="text-align:center;padding:20px;color:rgba(0,0,0,0.4);">No transactions today.</td></tr>';
                } else {
                    renderHistoryRows(tbody, todayList);
                }

                let totalCredit = 0,
                    totalDebit = 0;
                myHistory.forEach(t => { totalCredit += t.credit;
                    totalDebit += t.debit; });
                const balanceEl = document.getElementById('dashBalance');
                if (balanceEl) balanceEl.textContent = '$' + (totalCredit - totalDebit).toFixed(2);
            }

            // Real counts (previously hardcoded placeholder numbers) - Lease
            // Abstraction count comes from how many lease folders actually
            // exist on disk for this user (Users/<id>/LeaseAbstraction/*),
            // Translation count from completed entries in translationFiles
            // (translation is still a simulated pipeline, no real output
            // folder to count on disk).
            async function renderDashboardCounts() {
                const leaseEl = document.getElementById('dashLeaseCount');
                const translationEl = document.getElementById('dashTranslationCount');

                if (translationEl) {
                    translationEl.textContent = getMyTranslationFiles().filter(f => f.status === 'completed').length;
                }

                if (leaseEl) {
                    try {
                        const res = await authFetch('/api/lease/list?userId=' + encodeURIComponent(CURRENT_USER_ID));
                        const data = await res.json();
                        leaseEl.textContent = (data.leases || []).length;
                    } catch (e) {
                        leaseEl.textContent = '0';
                    }
                }
            }

            async function renderMyLeasesList() {
                const list = document.getElementById('myLeasesList');
                if (!list) return;

                try {
                    const res = await authFetch('/api/lease/list?userId=' + encodeURIComponent(CURRENT_USER_ID));
                    const data = await res.json();
                    const leases = data.leases || [];

                    if (leases.length === 0) {
                        list.innerHTML = '<li class="my-leases-empty">No leases processed yet - run one from Lease Abstraction.</li>';
                        return;
                    }

                    list.innerHTML = leases.map(l => `
                        <li class="my-lease-item">
                            <a class="my-lease-link" onclick="openLeaseDocsPopup('${l.leaseName.replace(/'/g, "\\'")}')">📄 ${escapeHtml(l.leaseName)}</a>
                            <span class="my-lease-meta">${l.docType ? escapeHtml(l.docType) : ''} ${l.accuracy != null ? '· ' + l.accuracy + '% accuracy' : ''}</span>
                        </li>
                    `).join('');
                } catch (e) {
                    list.innerHTML = '<li class="my-leases-empty">Could not load - make sure py/server.py is running.</li>';
                }
            }

            window.openLeaseDocsPopup = async function(leaseName) {
                try {
                    const res = await authFetch('/api/lease/documents?userId=' + encodeURIComponent(CURRENT_USER_ID) + '&leaseName=' + encodeURIComponent(leaseName));
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.error || 'Could not load lease documents.');

                    const docs = data.documents || [];
                    const rows = docs.map(d => `
                        <tr>
                            <td>${escapeHtml(d.fileName)}</td>
                            <td><button class="filter-btn download-btn" onclick="downloadFile('${d.fileName.replace(/'/g, "\\'")}', '${leaseName.replace(/'/g, "\\'")}')">⬇️ Download</button></td>
                        </tr>
                    `).join('') + (data.hasOutputPdf ? `
                        <tr>
                            <td><strong>Output.pdf</strong> (generated report)</td>
                            <td><button class="filter-btn download-btn" onclick="downloadFile('Output.pdf', '${leaseName.replace(/'/g, "\\'")}')">⬇️ Download</button></td>
                        </tr>
                    ` : '');

                    const html = `
                        <div class="admin-modal-overlay" id="leaseDocsPopupOverlay">
                            <div class="admin-modal-card message-popup-card">
                                <button class="admin-modal-close" onclick="document.getElementById('leaseDocsPopupOverlay').remove()">✕</button>
                                <h3 class="admin-modal-title">📁 ${escapeHtml(leaseName)}</h3>
                                <table class="admin-json-table" style="width:100%;">
                                    <thead><tr><th>File</th><th>Action</th></tr></thead>
                                    <tbody>${rows || '<tr><td colspan="2">No documents found.</td></tr>'}</tbody>
                                </table>
                            </div>
                        </div>
                    `;
                    const existing = document.getElementById('leaseDocsPopupOverlay');
                    if (existing) existing.remove();
                    document.body.insertAdjacentHTML('beforeend', html);
                } catch (err) {
                    showWarning(err.message || 'Could not load lease documents.');
                }
            };


            // ============================================================
            // 28. PROFILE FUNCTIONS
            // ============================================================
            function buildProfileBody() {
                return `
                    <div class="payment-layout">
                        <div class="payment-left">
                            <div class="payment-card profile-photo-card" style="height:480px;">
                                <div class="profile-photo-card-header">
                                    <h3>🖼️ Profile Photo</h3>
                                    <a class="profile-remove-photo-link" id="profileRemovePhotoLink" style="display:${profileData.photo ? 'inline-flex' : 'none'};" onclick="removeProfilePhoto()">🗑️ Remove Photo</a>
                                </div>
                                <div class="card-body profile-photo-dropzone-body">
                                    <div class="profile-photo-dropzone" id="profilePhotoDropzone"
                                         ondragover="event.preventDefault(); this.classList.add('drag-over');"
                                         ondragleave="this.classList.remove('drag-over');"
                                         ondrop="handlePhotoDrop(event)"
                                         onclick="document.getElementById('profilePhotoInput').click()">
                                        <div class="profile-photo-preview" id="profilePhotoPreview">
                                            ${profileData.photo ?
                                                `<img src="${profileData.photo}" alt="Profile" />` :
                                                '<div class="profile-photo-placeholder">👤<div>Click or drag a photo here</div></div>'}
                                        </div>
                                    </div>
                                    <input type="file" id="profilePhotoInput" accept="image/*" style="display:none;" onchange="handlePhotoUpload(event)" />
                                </div>
                            </div>
                        </div>
                        <div class="payment-right">
                            <div class="payment-card" style="height:480px;">
                                <h3>👤 Personal Information</h3>
                                <div class="card-body" style="overflow-y:auto;">
                                    <div class="payment-form">
                                        <div class="form-row">
                                            <div class="form-group">
                                                <label>First Name</label>
                                                <input type="text" id="profileFirstName" value="${profileData.firstName}" />
                                            </div>
                                            <div class="form-group">
                                                <label>Last Name</label>
                                                <input type="text" id="profileLastName" value="${profileData.lastName}" />
                                            </div>
                                        </div>
                                        <div class="form-row">
                                            <div class="form-group">
                                                <label>Gender</label>
                                                <select id="profileGender">
                                                    <option value="Male" ${profileData.gender === 'Male' ? 'selected' : ''}>Male</option>
                                                    <option value="Female" ${profileData.gender === 'Female' ? 'selected' : ''}>Female</option>
                                                    <option value="Other" ${profileData.gender === 'Other' ? 'selected' : ''}>Other</option>
                                                </select>
                                            </div>
                                            <div class="form-group">
                                                <label>Birthdate</label>
                                                <input type="date" id="profileBirthdate" value="${profileData.birthdate}" />
                                            </div>
                                        </div>
                                        <div class="form-row">
                                            <div class="form-group">
                                                <label>Mobile No</label>
                                                <input type="text" id="profileMobile" value="${profileData.mobile}" />
                                            </div>
                                            <div class="form-group">
                                                <label>Email Address</label>
                                                <input type="email" id="profileEmail" value="${profileData.email}" disabled style="opacity:0.6;cursor:not-allowed;" />
                                            </div>
                                        </div>
                                        <div class="form-row">
                                            <div class="form-group">
                                                <label>New Password</label>
                                                <div class="password-field-wrapper">
                                                    <input type="password" id="profilePassword" placeholder="Leave blank to keep current password" autocomplete="new-password" />
                                                    <span class="password-eye" onclick="togglePasswordVisibility('profilePassword', this)">👁️</span>
                                                </div>
                                            </div>
                                            <div class="form-group">
                                                <label>Confirm New Password</label>
                                                <div class="password-field-wrapper">
                                                    <input type="password" id="profileConfirmPassword" placeholder="Leave blank to keep current password" autocomplete="new-password" />
                                                    <span class="password-eye" onclick="togglePasswordVisibility('profileConfirmPassword', this)">👁️</span>
                                                </div>
                                            </div>
                                        </div>
                                        <div class="form-row">
                                            <div class="form-group" style="margin-top:-8px;">
                                                <small style="color:rgba(0,0,0,0.5);font-size:0.72rem;">Min 8 characters, with 1 uppercase, 1 lowercase, 1 number and 1 special character.</small>
                                            </div>
                                        </div>
                                        <div class="form-group profile-2fa-save-row" style="margin-top:4px;">
                                            <label class="checkbox-label">
                                                <input type="checkbox" id="profileTwoFactorAuth" ${profileData.twoFactorAuth === 'Yes' ? 'checked' : ''} />
                                                Two-Factor Authentication (2FA)
                                            </label>
                                            <button class="submit-btn" onclick="saveProfile()">💾 Save Changes</button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                `;
            }

            window.togglePasswordVisibility = function(inputId, eyeEl) {
                const input = document.getElementById(inputId);
                if (input.type === 'password') {
                    input.type = 'text';
                    eyeEl.textContent = '🙈';
                } else {
                    input.type = 'password';
                    eyeEl.textContent = '👁️';
                }
            };

            window.handlePhotoUpload = function(event) {
                const file = event.target.files[0];
                if (file) processProfilePhotoFile(file);
                // Reset so picking the exact same file again still fires 'change'
                event.target.value = '';
            };

            window.handlePhotoDrop = function(event) {
                event.preventDefault();
                const zone = document.getElementById('profilePhotoDropzone');
                if (zone) zone.classList.remove('drag-over');
                const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
                if (!file) return;
                if (!file.type.startsWith('image/')) {
                    showWarning('Please drop an image file.');
                    return;
                }
                processProfilePhotoFile(file);
            };

            function processProfilePhotoFile(file) {
                const reader = new FileReader();
                reader.onload = async function(e) {
                    const dataUrl = e.target.result;
                    // Optimistic preview while the upload completes - the
                    // dropzone shows the image filling its full width/height
                    // (cover fit, see CSS) rather than a small avatar circle.
                    document.getElementById('profilePhotoPreview').innerHTML = `<img src="${dataUrl}" alt="Profile" />`;
                    try {
                        const res = await authFetch('/api/upload-photo', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ userId: CURRENT_USER_ID, fileName: file.name, dataUrl: dataUrl })
                        });
                        const result = await res.json();
                        if (!res.ok || !result.path) throw new Error(result.error || 'Upload failed');
                        // Store the real saved path (Users/<UserID>/ProfilePhoto/...) in
                        // users.json, not the raw base64 - cache-bust so the <img> refreshes.
                        profileData.photo = result.path + '?t=' + Date.now();
                        document.getElementById('profilePhotoPreview').innerHTML = `<img src="${profileData.photo}" alt="Profile" />`;
                        updateAvatarDisplay();
                        persistProfile();
                        refreshProfilePhotoCard();
                    } catch (err) {
                        console.warn('Profile photo upload failed:', err);
                        showWarning('Could not save the profile photo to the server. Make sure py/server.py is running.');
                    }
                };
                reader.readAsDataURL(file);
            }

            function refreshProfilePhotoCard() {
                const removeLink = document.getElementById('profileRemovePhotoLink');
                if (removeLink) removeLink.style.display = profileData.photo ? 'inline-flex' : 'none';
            }

            window.removeProfilePhoto = function() {
                profileData.photo = null;
                document.getElementById('profilePhotoPreview').innerHTML =
                    '<div class="profile-photo-placeholder">👤<div>Click or drag a photo here</div></div>';
                updateAvatarDisplay();
                persistProfile();
                refreshProfilePhotoCard();
            };

            // Password policy: 8+ chars, 1 upper, 1 lower, 1 digit, 1 special char.
            function getPasswordPolicyIssues(password) {
                const issues = [];
                if (!password || password.length < 8) issues.push('at least 8 characters');
                if (!/[A-Z]/.test(password)) issues.push('1 uppercase letter');
                if (!/[a-z]/.test(password)) issues.push('1 lowercase letter');
                if (!/[0-9]/.test(password)) issues.push('1 numeric digit');
                if (!/[^A-Za-z0-9]/.test(password)) issues.push('1 special character');
                return issues;
            }

            window.saveProfile = function() {
                const password = document.getElementById('profilePassword').value;
                const confirmPassword = document.getElementById('profileConfirmPassword').value;

                if (password || confirmPassword) {
                    if (password !== confirmPassword) {
                        showWarning('Password and Confirm Password do not match.');
                        return;
                    }
                    const policyIssues = getPasswordPolicyIssues(password);
                    if (policyIssues.length > 0) {
                        showWarning('Password must contain ' + policyIssues.join(', ') + '.');
                        return;
                    }
                    profileData.password = password;
                } else {
                    delete profileData.password;
                }

                profileData.firstName = document.getElementById('profileFirstName').value.trim();
                profileData.lastName = document.getElementById('profileLastName').value.trim();
                profileData.gender = document.getElementById('profileGender').value;
                profileData.birthdate = document.getElementById('profileBirthdate').value;
                profileData.mobile = document.getElementById('profileMobile').value.trim();
                profileData.twoFactorAuth = document.getElementById('profileTwoFactorAuth').checked ? 'Yes' : 'No';

                userNameDisplay.textContent = profileData.firstName + ' ' + profileData.lastName;
                MENU_CONFIG.user.name = profileData.firstName + ' ' + profileData.lastName;
                updateAvatarDisplay();
                persistProfile();
                document.getElementById('profilePassword').value = '';
                document.getElementById('profileConfirmPassword').value = '';

                showMessage('✅ Profile Updated', 'Your profile information has been saved successfully.', ['OK']);
            };

            function updateAvatarDisplay() {
                const avatarImg = document.getElementById('avatarImg');
                const avatarTextEl = document.getElementById('avatarText');
                if (profileData.photo) {
                    avatarImg.src = profileData.photo;
                    avatarImg.style.display = 'block';
                    avatarTextEl.style.display = 'none';
                } else {
                    avatarImg.style.display = 'none';
                    avatarTextEl.style.display = 'block';
                    avatarTextEl.textContent = (profileData.firstName[0] || '') + (profileData.lastName[0] || '');
                }
            }

            // ============================================================
            // 28b. ADMIN FILE MANAGER (Developer/Admin role only)
            // Browses/manages the real project folder through the
            // /api/admin/* routes in py/server.py.
            // ============================================================
            let adminCurrentPath = '';
            let adminEntries = [];
            let adminSelectedPaths = new Set();

            // ============================================================
            // NOTIFICATIONS (generated e.g. when balance is added)
            // ============================================================
            function getMyNotifications() {
                return notifications.filter(n => n.userId === CURRENT_USER_ID);
            }

            function addNotification(description) {
                const now = new Date();
                notifications.push({
                    id: 'NOTIF' + String(nextNotificationId++).padStart(3, '0'),
                    userId: CURRENT_USER_ID,
                    date: now.toISOString().split('T')[0],
                    time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }),
                    description: description,
                    read: false
                });
                persistNotifications();
                updateNotificationBadge();
            }

            function updateNotificationBadge() {
                const badge = document.getElementById('notificationBadge');
                if (!badge) return;
                const unread = getMyNotifications().filter(n => !n.read).length;
                if (unread > 0) {
                    badge.textContent = unread > 9 ? '9+' : String(unread);
                    badge.style.display = 'inline-flex';
                } else {
                    badge.style.display = 'none';
                }
            }

            let selectedNotificationIds = new Set();

            function buildNotificationBody() {
                return `
                    <div class="history-card">
                        <h3>🔔 Notifications</h3>
                        <div class="card-body">
                            <table class="history-table" id="notificationTable">
                                <thead>
                                    <tr>
                                        <th style="width:32px;"><input type="checkbox" onchange="toggleNotificationSelectAll(this)" /></th>
                                        <th>Date &amp; Time</th>
                                        <th>Description</th>
                                    </tr>
                                </thead>
                                <tbody id="notificationTableBody"></tbody>
                            </table>
                            <div class="support-log-footer-row">
                                <button class="filter-btn" onclick="bulkMarkNotifications(true)">✅ Mark Read</button>
                                <button class="filter-btn reset-btn" onclick="bulkMarkNotifications(false)">📩 Mark Unread</button>
                                <button class="filter-btn delete-btn" onclick="bulkRemoveNotifications()">🗑️ Remove</button>
                            </div>
                        </div>
                    </div>
                `;
            }

            function renderNotificationTable() {
                const tbody = document.getElementById('notificationTableBody');
                if (!tbody) return;
                const mine = [...getMyNotifications()].sort((a, b) => new Date(b.date + ' ' + b.time) - new Date(a.date + ' ' + a.time));

                if (mine.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;padding:20px;color:rgba(0,0,0,0.4);">No notifications yet.</td></tr>';
                    updateNotificationBadge();
                    return;
                }

                tbody.innerHTML = mine.map(n => `
                    <tr class="${n.read ? '' : 'notification-unread'}">
                        <td onclick="event.stopPropagation();"><input type="checkbox" class="notification-row-check" data-id="${n.id}" ${selectedNotificationIds.has(n.id) ? 'checked' : ''} onchange="toggleNotificationRowCheck('${n.id}', this)" /></td>
                        <td>${n.date} ${n.time}</td>
                        <td><a class="notification-desc-link" onclick="openNotificationPopup('${n.id}')">${escapeHtml(n.description)}</a></td>
                    </tr>
                `).join('');
                updateNotificationBadge();
            }

            window.toggleNotificationRowCheck = function(id, checkbox) {
                if (checkbox.checked) selectedNotificationIds.add(id);
                else selectedNotificationIds.delete(id);
            };

            window.toggleNotificationSelectAll = function(checkbox) {
                document.querySelectorAll('.notification-row-check').forEach((cb) => {
                    cb.checked = checkbox.checked;
                    if (checkbox.checked) selectedNotificationIds.add(cb.dataset.id);
                    else selectedNotificationIds.delete(cb.dataset.id);
                });
            };

            window.bulkMarkNotifications = function(readValue) {
                if (selectedNotificationIds.size === 0) {
                    showWarning('Select at least one notification first.');
                    return;
                }
                notifications.forEach(n => {
                    if (selectedNotificationIds.has(n.id)) n.read = readValue;
                });
                persistNotifications();
                renderNotificationTable();
            };

            window.bulkRemoveNotifications = function() {
                if (selectedNotificationIds.size === 0) {
                    showWarning('Select at least one notification first.');
                    return;
                }
                notifications = notifications.filter(n => !selectedNotificationIds.has(n.id));
                selectedNotificationIds.clear();
                persistNotifications();
                renderNotificationTable();
            };

            window.openNotificationPopup = function(id) {
                const n = notifications.find(x => x.id === id);
                if (!n) return;
                if (!n.read) {
                    n.read = true;
                    persistNotifications();
                    renderNotificationTable();
                }
                const html = `
                    <div class="admin-modal-overlay" id="notificationPopupOverlay">
                        <div class="admin-modal-card message-popup-card">
                            <button class="admin-modal-close" onclick="document.getElementById('notificationPopupOverlay').remove()">✕</button>
                            <h3 class="admin-modal-title">🔔 Notification</h3>
                            <p style="font-size:0.75rem;color:rgba(0,0,0,0.5);margin-bottom:10px;">${n.date} ${n.time}</p>
                            <p style="font-size:0.9rem;line-height:1.6;">${escapeHtml(n.description)}</p>
                        </div>
                    </div>
                `;
                const existing = document.getElementById('notificationPopupOverlay');
                if (existing) existing.remove();
                document.body.insertAdjacentHTML('beforeend', html);
            };

            // ============================================================
            // LEASE ABSTRACTION RULES (json/rules.json workflow)
            // ============================================================
            let rulesNewRows = [];

            window.openRulesPopup = async function() {
                try {
                    const res = await authFetch('/api/rules/list');
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.error || 'Could not load rules.');
                    rulesNewRows = [];
                    renderRulesPopupHTML(data.approved || [], data.pending || []);
                } catch (err) {
                    showWarning(err.message || 'Could not load rules. Make sure py/server.py is running.');
                }
            };

            function renderRulesPopupHTML(approved, pending) {
                const isDeveloper = profileData && profileData.role === 'Developer';
                const myPending = pending.filter(r => r.userId === CURRENT_USER_ID);
                const pendingList = isDeveloper ? pending : myPending;

                const approvedRows = approved.map(r => `
                    <tr>
                        <td>${escapeHtml(r.id)}</td>
                        <td>${escapeHtml(r.fieldId)}</td>
                        <td>${escapeHtml(r.ruleType)}</td>
                        <td>${escapeHtml(r.ruleText)}</td>
                        <td>${escapeHtml(r.userId || '')}</td>
                    </tr>
                `).join('');

                const newRuleRows = rulesNewRows.map((r, idx) => `
                    <tr class="rules-new-row">
                        <td><em>(new)</em></td>
                        <td><input type="text" class="admin-json-cell-input" placeholder="e.g. tenant_legal_name" value="${escapeHtml(r.fieldId)}" onchange="updateNewRuleField(${idx}, 'fieldId', this.value)" /></td>
                        <td>
                            <select onchange="updateNewRuleField(${idx}, 'ruleType', this.value)">
                                <option value="mapping" ${r.ruleType === 'mapping' ? 'selected' : ''}>mapping</option>
                                <option value="validation" ${r.ruleType === 'validation' ? 'selected' : ''}>validation</option>
                                <option value="formatting" ${r.ruleType === 'formatting' ? 'selected' : ''}>formatting</option>
                            </select>
                        </td>
                        <td><input type="text" class="admin-json-cell-input" placeholder="Describe where/how to extract this field..." value="${escapeHtml(r.ruleText)}" onchange="updateNewRuleField(${idx}, 'ruleText', this.value)" /></td>
                        <td><span class="admin-action-icon delete" onclick="removeNewRuleRow(${idx})">🗑️</span></td>
                    </tr>
                `).join('');

                const pendingRows = pendingList.map(r => `
                    <tr>
                        <td>${escapeHtml(r.id)}</td>
                        <td>${escapeHtml(r.fieldId)}</td>
                        <td>${escapeHtml(r.ruleType)}</td>
                        <td>${escapeHtml(r.ruleText)}</td>
                        <td>${escapeHtml(r.userId || '')}</td>
                        <td>${isDeveloper ? `
                            <a class="file-action-link" onclick="approveRule('${r.id}')">✅ Approve</a>
                            &nbsp;|&nbsp;
                            <a class="file-action-link error-link" onclick="rejectRule('${r.id}')">✖ Reject</a>
                        ` : '<span class="status-badge status-pending">Awaiting approval</span>'}</td>
                    </tr>
                `).join('');

                const html = `
                    <div class="admin-modal-overlay" id="rulesPopupOverlay">
                        <div class="admin-modal-card admin-multi-table-modal">
                            <button class="admin-modal-close" onclick="document.getElementById('rulesPopupOverlay').remove()">✕</button>
                            <h3 class="admin-modal-title">📐 Lease Abstraction Rules</h3>
                            <p style="font-size:0.78rem;color:rgba(0,0,0,0.55);margin-bottom:10px;">
                                All master rules belong to the Developer account. Add a new row below and Submit -
                                new rules go into "Pending Approval" and only take effect once the Developer approves them.
                            </p>

                            <div class="admin-section-header-row">
                                <h4 class="admin-section-title">Master Rules <span class="admin-section-count">(${approved.length})</span></h4>
                                <div class="admin-section-actions">
                                    <button class="admin-btn admin-btn-add-file" onclick="addNewRuleRow()">+ Add Row</button>
                                    ${rulesNewRows.length > 0 ? `<button class="admin-btn admin-btn-save" onclick="submitNewRuleRows()">📤 Submit New Rows for Approval</button>` : ''}
                                </div>
                            </div>
                            <div class="admin-json-table-wrapper admin-section-table" style="max-height:340px;">
                                <table class="admin-json-table">
                                    <thead><tr><th>ID</th><th>Field ID</th><th>Type</th><th>Rule Text</th><th>Owner</th></tr></thead>
                                    <tbody>${newRuleRows}${approvedRows}</tbody>
                                </table>
                            </div>

                            <h4 class="admin-section-title">Pending Approval <span class="admin-section-count">(${pendingList.length})</span></h4>
                            <div class="admin-json-table-wrapper admin-section-table">
                                <table class="admin-json-table">
                                    <thead><tr><th>ID</th><th>Field ID</th><th>Type</th><th>Rule Text</th><th>Proposed By</th><th>${isDeveloper ? 'Actions' : 'Status'}</th></tr></thead>
                                    <tbody>${pendingRows || '<tr><td colspan="6" style="text-align:center;">No pending rules.</td></tr>'}</tbody>
                                </table>
                            </div>

                            <div class="admin-modal-actions">
                                <button class="admin-modal-cancel" onclick="document.getElementById('rulesPopupOverlay').remove()">Close</button>
                            </div>
                        </div>
                    </div>
                `;
                const existing = document.getElementById('rulesPopupOverlay');
                if (existing) existing.remove();
                document.body.insertAdjacentHTML('beforeend', html);
            }

            window.addNewRuleRow = function() {
                rulesNewRows.push({ fieldId: '', ruleType: 'mapping', ruleText: '' });
                refreshRulesPopup();
            };

            window.updateNewRuleField = function(idx, key, value) {
                if (rulesNewRows[idx]) rulesNewRows[idx][key] = value;
            };

            window.removeNewRuleRow = function(idx) {
                rulesNewRows.splice(idx, 1);
                refreshRulesPopup();
            };

            async function refreshRulesPopup() {
                try {
                    const res = await authFetch('/api/rules/list');
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.error || 'Could not load rules.');
                    renderRulesPopupHTML(data.approved || [], data.pending || []);
                } catch (err) {
                    showWarning(err.message || 'Could not refresh rules.');
                }
            }

            window.submitNewRuleRows = async function() {
                const validRows = rulesNewRows.filter(r => r.fieldId.trim() && r.ruleText.trim());
                if (validRows.length === 0) {
                    showWarning('Fill in at least Field ID and Rule Text for each new row before submitting.');
                    return;
                }
                try {
                    for (const row of validRows) {
                        const res = await authFetch('/api/rules/propose', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ userId: CURRENT_USER_ID, fieldId: row.fieldId.trim(), ruleType: row.ruleType, ruleText: row.ruleText.trim() })
                        });
                        const data = await res.json();
                        if (!res.ok) throw new Error(data.error || 'Could not submit a rule.');
                    }
                    rulesNewRows = [];
                    showMessage('✅ Submitted', `${validRows.length} new rule(s) submitted and pending Developer approval.`, ['OK']);
                    refreshRulesPopup();
                } catch (err) {
                    showWarning(err.message || 'Could not submit the new rules.');
                }
            };

            window.approveRule = async function(ruleId) {
                try {
                    const res = await authFetch('/api/rules/approve', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ruleId })
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.error || 'Could not approve the rule.');
                    refreshRulesPopup();
                } catch (err) {
                    showWarning(err.message || 'Could not approve the rule.');
                }
            };

            window.rejectRule = async function(ruleId) {
                try {
                    const res = await authFetch('/api/rules/reject', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ruleId })
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.error || 'Could not reject the rule.');
                    refreshRulesPopup();
                } catch (err) {
                    showWarning(err.message || 'Could not reject the rule.');
                }
            };

            function buildAdminFilesBody() {
                return `
                    <div class="admin-files-card">
                        <div class="admin-files-header">
                            <h3>📁 Files and Folder</h3>
                        </div>
                        <div class="admin-toolbar">
                            <button class="admin-btn admin-btn-add-file" onclick="document.getElementById('adminFileInput').click()">📄 Add File</button>
                            <button class="admin-btn admin-btn-add-folder" onclick="adminAddFolder()">📁 Add Folder</button>
                            <button class="admin-btn admin-btn-delete" onclick="adminDeleteSelected()">🗑️ Delete</button>
                            <button class="admin-btn admin-btn-download" onclick="adminDownloadSelected()">⬇️ Download</button>
                            <input type="file" id="adminFileInput" style="display:none;" onchange="adminUploadFile(event)" />
                        </div>
                        <div class="admin-breadcrumb" id="adminBreadcrumb"></div>
                        <div class="admin-table-wrapper">
                            <table class="admin-table">
                                <thead>
                                    <tr>
                                        <th><input type="checkbox" id="adminSelectAll" onchange="adminToggleSelectAll(this)" /></th>
                                        <th>Name</th>
                                        <th>Type</th>
                                        <th>Size</th>
                                        <th>Modified</th>
                                        <th>Actions</th>
                                    </tr>
                                </thead>
                                <tbody id="adminTableBody">
                                    <tr><td colspan="6" style="text-align:center;padding:20px;color:rgba(0,0,0,0.4);">Loading…</td></tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                `;
            }

            function buildAdminBreadcrumb(path) {
                const parts = path ? path.split('/') : [];
                let acc = '';
                let html = `<span class="admin-crumb" onclick="loadAdminDirectory('')">🗄️ Root</span>`;
                parts.forEach((part) => {
                    acc = acc ? acc + '/' + part : part;
                    html += ` <span class="admin-crumb-sep">/</span> <span class="admin-crumb" onclick="loadAdminDirectory('${acc.replace(/'/g, "\\'")}')">${part}</span>`;
                });
                return html;
            }

            window.loadAdminDirectory = async function(path) {
                adminCurrentPath = path || '';
                adminSelectedPaths = new Set();
                const tbody = document.getElementById('adminTableBody');
                const breadcrumb = document.getElementById('adminBreadcrumb');
                if (breadcrumb) breadcrumb.innerHTML = buildAdminBreadcrumb(adminCurrentPath);
                if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:20px;color:rgba(0,0,0,0.4);">Loading…</td></tr>`;

                try {
                    const res = await authFetch('/api/admin/list?path=' + encodeURIComponent(adminCurrentPath));
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.error || 'Could not load folder');
                    adminEntries = data.entries || [];
                    renderAdminTable();
                } catch (err) {
                    console.error('Admin file list failed:', err);
                    if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:20px;color:#c0392b;">Could not load this folder. Make sure py/server.py is running.</td></tr>`;
                }
            };

            function renderAdminTable() {
                const tbody = document.getElementById('adminTableBody');
                if (!tbody) return;

                if (adminEntries.length === 0) {
                    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:20px;color:rgba(0,0,0,0.4);">This folder is empty.</td></tr>`;
                    return;
                }

                tbody.innerHTML = adminEntries.map((entry) => {
                    const icon = entry.type === 'dir' ? '📁' : '📄';
                    const nameCell = entry.type === 'dir' ?
                        `<a class="admin-name-link" onclick="loadAdminDirectory('${entry.path.replace(/'/g, "\\'")}')">${icon} ${entry.name}</a>` :
                        `<a class="admin-name-link" onclick="adminOpenFile('${entry.path.replace(/'/g, "\\'")}')">${icon} ${entry.name}</a>`;
                    const downloadBtn = entry.type === 'file' ?
                        (entry.downloadBlocked ?
                            `<span class="admin-action-icon disabled" title="Protected file">🔒</span>` :
                            `<span class="admin-action-icon" title="Download" onclick="adminDownloadOne('${entry.path.replace(/'/g, "\\'")}')">⬇️</span>`) :
                        '';
                    return `
                        <tr>
                            <td><input type="checkbox" class="admin-row-check" data-path="${entry.path}" onchange="adminToggleSelectOne('${entry.path.replace(/'/g, "\\'")}', this)" /></td>
                            <td class="admin-name-cell">${nameCell}</td>
                            <td><span class="admin-type-badge">${entry.typeLabel}</span></td>
                            <td>${entry.sizeLabel || '—'}</td>
                            <td>${entry.modified || '—'}</td>
                            <td class="admin-actions-cell">
                                ${downloadBtn}
                                <span class="admin-action-icon delete" title="Delete" onclick="adminDeleteOne('${entry.path.replace(/'/g, "\\'")}')">🗑️</span>
                            </td>
                        </tr>
                    `;
                }).join('');
            }

            window.adminToggleSelectOne = function(path, checkbox) {
                if (checkbox.checked) adminSelectedPaths.add(path);
                else adminSelectedPaths.delete(path);
            };

            window.adminToggleSelectAll = function(checkbox) {
                document.querySelectorAll('.admin-row-check').forEach((cb) => {
                    cb.checked = checkbox.checked;
                    if (checkbox.checked) adminSelectedPaths.add(cb.dataset.path);
                    else adminSelectedPaths.delete(cb.dataset.path);
                });
            };

            window.adminAddFolder = function() {
                const name = prompt('New folder name:');
                if (!name || !name.trim()) return;
                authFetch('/api/admin/mkdir', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: adminCurrentPath, name: name.trim() })
                }).then(async (res) => {
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.error || 'Could not create folder');
                    loadAdminDirectory(adminCurrentPath);
                }).catch((err) => showWarning(err.message || 'Could not create folder.'));
            };

            window.adminUploadFile = function(event) {
                const file = event.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = async function(e) {
                    const dataBase64 = e.target.result.split(',')[1];
                    try {
                        const res = await authFetch('/api/admin/upload', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ path: adminCurrentPath, fileName: file.name, dataBase64: dataBase64 })
                        });
                        const data = await res.json();
                        if (!res.ok) throw new Error(data.error || 'Upload failed');
                        loadAdminDirectory(adminCurrentPath);
                    } catch (err) {
                        showWarning(err.message || 'Could not upload file.');
                    }
                };
                reader.readAsDataURL(file);
                event.target.value = '';
            };

            window.adminDeleteOne = function(path) {
                showConfirm('🗑️ Delete', `Are you sure you want to delete "${path.split('/').pop()}"? This cannot be undone.`, function(confirmed) {
                    if (!confirmed) return;
                    adminDeletePaths([path]);
                });
            };

            window.adminDeleteSelected = function() {
                const paths = Array.from(adminSelectedPaths);
                if (paths.length === 0) { showWarning('Select at least one file or folder first.'); return; }
                showConfirm('🗑️ Delete Selected', `Delete ${paths.length} selected item(s)? This cannot be undone.`, function(confirmed) {
                    if (!confirmed) return;
                    adminDeletePaths(paths);
                });
            };

            function adminDeletePaths(paths) {
                authFetch('/api/admin/delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ paths: paths })
                }).then(async (res) => {
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.error || 'Delete failed');
                    if (data.failed && data.failed.length > 0) {
                        showWarning('Some items could not be deleted: ' + data.failed.map(f => f.path + ' (' + f.error + ')').join(', '));
                    }
                    loadAdminDirectory(adminCurrentPath);
                }).catch((err) => showWarning(err.message || 'Could not delete.'));
            }

            window.adminDownloadOne = function(path) {
                window.open('/api/admin/download?path=' + encodeURIComponent(path), '_blank');
            };

            window.adminDownloadSelected = function() {
                const paths = Array.from(adminSelectedPaths);
                const fileEntry = adminEntries.find(e => paths.includes(e.path) && e.type === 'file');
                const onlyFiles = paths.every(p => {
                    const entry = adminEntries.find(e => e.path === p);
                    return entry && entry.type === 'file';
                });
                if (paths.length === 0) { showWarning('Select at least one file first.'); return; }
                if (!onlyFiles) { showWarning('Folders can\'t be downloaded directly - please select individual files.'); return; }
                paths.forEach(p => window.open('/api/admin/download?path=' + encodeURIComponent(p), '_blank'));
            };

            // ---- File name click -> view/edit modal (JSON as table, text as editor) ----
            let adminTableEditorState = { path: null, mode: null, columns: [], rows: [], selected: new Set() };

            window.adminOpenFile = async function(path) {
                try {
                    const res = await authFetch('/api/admin/read?path=' + encodeURIComponent(path));
                    const data = await res.json();
                    if (!res.ok) {
                        showWarning(res.status === 415 ?
                            'This file type can\'t be previewed here - use the download icon instead.' :
                            (data.error || 'Could not open this file.'));
                        return;
                    }

                    if (data.isJson) {
                        let parsed = null;
                        try { parsed = JSON.parse(data.content); } catch (e) { parsed = null; }

                        if (Array.isArray(parsed)) {
                            const allFlatObjects = parsed.every(item => item && typeof item === 'object' && !Array.isArray(item));
                            if (allFlatObjects) {
                                openAdminModal(buildJsonArrayTableModalHTML(path, parsed, 'array'));
                                return;
                            }
                        } else if (parsed && typeof parsed === 'object') {
                            // Smart multi-table view: any nested array-of-objects
                            // (one level of nesting deep) gets extracted into its
                            // own proper table instead of showing as a JSON blob
                            // in a single cell - e.g. rules.json's "approved"
                            // list, agents.json's
                            // "openai.keys"/"openrouter.keys", agents.json's
                            // "lease-abstraction"/"translation", menu-config.json's
                            // "mainMenu"/"profileMenu". A "dict of same-shaped
                            // sub-objects" (like messages.json's success/warning/
                            // error/confirm/info) is treated as a virtual array -
                            // each key becomes a row.
                            openAdminModal(buildJsonMultiTableModalHTML(path, parsed));
                            return;
                        }
                    }
                    openAdminModal(buildTextEditorModalHTML(path, data.content));
                } catch (err) {
                    showWarning('Could not open this file. Make sure py/server.py is running.');
                }
            };

            function openAdminModal(html) {
                const existing = document.getElementById('adminFileModalOverlay');
                if (existing) existing.remove();
                document.body.insertAdjacentHTML('beforeend', html);
            }

            window.adminCloseFileModal = function() {
                const overlay = document.getElementById('adminFileModalOverlay');
                if (overlay) overlay.remove();
                adminTableEditorState = { path: null, mode: null, rootType: 'array', columns: [], rows: [], selected: new Set(), generalRows: [], sections: [] };
            };

            function buildTextEditorModalHTML(path, content) {
                const fileName = path.split('/').pop();
                return `
                    <div class="admin-modal-overlay" id="adminFileModalOverlay">
                        <div class="admin-modal-card admin-text-modal">
                            <button class="admin-modal-close" onclick="adminCloseFileModal()">✕</button>
                            <div class="admin-modal-icon">📝</div>
                            <h3 class="admin-modal-title">✏️ ${escapeHtml(fileName)}</h3>
                            <textarea id="adminFileEditorTextarea" class="admin-text-editor" spellcheck="false">${escapeHtml(content)}</textarea>
                            <div class="admin-modal-path">📄 ${escapeHtml(path)}</div>
                            <div class="admin-modal-actions">
                                <button class="admin-modal-save" onclick="adminSaveFile('${path.replace(/'/g, "\\'")}', 'text')">💾 Save</button>
                                <button class="admin-modal-cancel" onclick="adminCloseFileModal()">Cancel</button>
                            </div>
                        </div>
                    </div>
                `;
            }

            // ---- Array-of-objects JSON (e.g. payment-methods.json) AND
            // single-object JSON (e.g. rules.json, agents.json,
            // agents.json) - the latter is rendered as a one-row table, its
            // keys becoming the column headers (see adminOpenFile above). ----
            // ---- Smart structure analysis for object-root JSON ----
            function isDictOfObjects(obj) {
                const values = Object.values(obj);
                return values.length > 0 && values.every(v => v !== null && typeof v === 'object' && !Array.isArray(v));
            }

            function analyzeJsonObject(obj) {
                if (isDictOfObjects(obj)) {
                    // e.g. messages.json: {success:{...}, warning:{...}, ...} -
                    // each top-level key becomes one row, with a locked "_key"
                    // column identifying which key it came from.
                    const rows = Object.entries(obj).map(([k, v]) => Object.assign({ _key: k }, v));
                    return { virtualArray: rows };
                }

                const generalRows = [];
                const sections = [];

                Object.keys(obj).forEach((key) => {
                    const val = obj[key];
                    if (Array.isArray(val)) {
                        sections.push({ title: key, items: val });
                    } else if (val !== null && typeof val === 'object') {
                        let hasNestedArray = false;
                        Object.keys(val).forEach((subKey) => {
                            if (Array.isArray(val[subKey])) {
                                sections.push({ title: key + '.' + subKey, items: val[subKey] });
                                hasNestedArray = true;
                            }
                        });
                        Object.keys(val).forEach((subKey) => {
                            if (!Array.isArray(val[subKey])) {
                                generalRows.push({ key: key + '.' + subKey, value: val[subKey] });
                            }
                        });
                    } else {
                        generalRows.push({ key: key, value: val });
                    }
                });

                return { generalRows, sections };
            }

            function buildJsonMultiTableModalHTML(path, obj) {
                const analysis = analyzeJsonObject(obj);

                if (analysis.virtualArray) {
                    const rows = analysis.virtualArray;
                    const columns = [];
                    rows.forEach(r => Object.keys(r).forEach(k => { if (!columns.includes(k)) columns.push(k); }));
                    adminTableEditorState = {
                        path, mode: 'multi-virtual', rootType: 'multi-virtual',
                        columns, rows: JSON.parse(JSON.stringify(rows)), selected: new Set()
                    };
                    return `
                        <div class="admin-modal-overlay" id="adminFileModalOverlay">
                            <div class="admin-modal-card admin-table-modal">
                                <button class="admin-modal-close" onclick="adminCloseFileModal()">✕</button>
                                <h3 class="admin-modal-title">${escapeHtml(path.split('/').pop())}</h3>
                                <div class="admin-json-table-wrapper">
                                    <table class="admin-json-table" id="adminJsonTable">${buildJsonArrayTableInnerHTML()}</table>
                                </div>
                                <div class="admin-modal-actions admin-json-actions">
                                    <div class="admin-json-actions-left">
                                        <button class="admin-btn admin-btn-add-file" onclick="adminJsonAddRow()">+ Add Row</button>
                                        <button class="admin-btn admin-btn-delete" onclick="adminJsonDeleteSelected()">🗑️ Delete Selected</button>
                                        <button class="admin-btn admin-btn-add-folder" onclick="adminJsonSelectAll()">☑️ Select All</button>
                                    </div>
                                    <div class="admin-json-actions-right">
                                        <button class="admin-modal-save" onclick="adminSaveFile('${path.replace(/'/g, "\\'")}', 'multi-virtual')">💾 Save</button>
                                        <button class="admin-modal-cancel" onclick="adminCloseFileModal()">Cancel</button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    `;
                }

                adminTableEditorState = {
                    path, mode: 'multi-sectioned', rootType: 'multi-sectioned',
                    generalRows: analysis.generalRows.map(r => Object.assign({}, r)),
                    sections: analysis.sections.map(s => {
                        const columns = [];
                        s.items.forEach(it => { if (it && typeof it === 'object' && !Array.isArray(it)) Object.keys(it).forEach(k => { if (!columns.includes(k)) columns.push(k); }); });
                        return { title: s.title, columns, rows: JSON.parse(JSON.stringify(s.items)), selected: new Set() };
                    })
                };

                return `
                    <div class="admin-modal-overlay" id="adminFileModalOverlay">
                        <div class="admin-modal-card admin-table-modal admin-multi-table-modal">
                            <button class="admin-modal-close" onclick="adminCloseFileModal()">✕</button>
                            <h3 class="admin-modal-title">${escapeHtml(path.split('/').pop())}</h3>
                            <div id="adminMultiTableBody">${buildMultiSectionInnerHTML()}</div>
                            <div class="admin-modal-actions">
                                <button class="admin-modal-save" onclick="adminSaveFile('${path.replace(/'/g, "\\'")}', 'multi-sectioned')">💾 Save</button>
                                <button class="admin-modal-cancel" onclick="adminCloseFileModal()">Cancel</button>
                            </div>
                        </div>
                    </div>
                `;
            }

            function buildMultiSectionInnerHTML() {
                const st = adminTableEditorState;
                let html = '';

                if (st.generalRows.length > 0) {
                    html += `
                        <h4 class="admin-section-title">General</h4>
                        <div class="admin-json-table-wrapper admin-section-table">
                            <table class="admin-json-table">
                                <thead><tr><th>Key</th><th>Value</th></tr></thead>
                                <tbody>${st.generalRows.map((row, idx) => `
                                    <tr>
                                        <td class="admin-json-key-cell">${escapeHtml(row.key)}</td>
                                        <td>${typeof row.value === 'boolean' ?
                                            `<input type="checkbox" ${row.value ? 'checked' : ''} onchange="adminMultiUpdateGeneral(${idx}, this.checked)" />` :
                                            `<input type="text" class="admin-json-cell-input" value="${escapeHtml(String(row.value === null || row.value === undefined ? '' : row.value))}" onchange="adminMultiUpdateGeneral(${idx}, this.value)" />`
                                        }</td>
                                    </tr>
                                `).join('')}</tbody>
                            </table>
                        </div>
                    `;
                }

                st.sections.forEach((section, sIdx) => {
                    html += `
                        <div class="admin-section-header-row">
                            <h4 class="admin-section-title">${escapeHtml(section.title)} <span class="admin-section-count">(${section.rows.length})</span></h4>
                            <div class="admin-section-actions">
                                <button class="admin-btn admin-btn-add-file" onclick="adminMultiAddRow(${sIdx})">+ Add Row</button>
                                <button class="admin-btn admin-btn-delete" onclick="adminMultiDeleteSelected(${sIdx})">🗑️ Delete Selected</button>
                                <button class="admin-btn admin-btn-add-folder" onclick="adminMultiSelectAll(${sIdx})">☑️ Select All</button>
                            </div>
                        </div>
                        <div class="admin-json-table-wrapper admin-section-table">
                            <table class="admin-json-table" id="adminMultiSection${sIdx}">${buildMultiSectionTableInnerHTML(sIdx)}</table>
                        </div>
                    `;
                });

                return html;
            }

            function buildMultiSectionTableInnerHTML(sIdx) {
                const section = adminTableEditorState.sections[sIdx];
                const { columns, rows, selected } = section;

                if (columns.length === 0) {
                    const header = `<thead><tr><th><input type="checkbox" onchange="adminMultiToggleSelectAllCheckbox(${sIdx}, this)" /></th><th>Row (JSON)</th><th>Del</th></tr></thead>`;
                    const body = `<tbody>${rows.map((r, idx) => `
                        <tr>
                            <td><input type="checkbox" ${selected.has(idx) ? 'checked' : ''} onchange="adminMultiToggleSelectRow(${sIdx}, ${idx}, this)" /></td>
                            <td><input type="text" class="admin-json-cell-input" value="${escapeHtml(JSON.stringify(r))}" onchange="adminMultiUpdateFreeform(${sIdx}, ${idx}, this.value)" /></td>
                            <td><span class="admin-action-icon delete" onclick="adminMultiDeleteRow(${sIdx}, ${idx})">🗑️</span></td>
                        </tr>
                    `).join('')}</tbody>`;
                    return header + body;
                }

                const header = `<thead><tr><th><input type="checkbox" onchange="adminMultiToggleSelectAllCheckbox(${sIdx}, this)" /></th>${columns.map(c => `<th>${escapeHtml(c)}</th>`).join('')}<th>Del</th></tr></thead>`;
                const body = `<tbody>${rows.map((row, idx) => `
                    <tr>
                        <td><input type="checkbox" ${selected.has(idx) ? 'checked' : ''} onchange="adminMultiToggleSelectRow(${sIdx}, ${idx}, this)" /></td>
                        ${columns.map(col => {
                            const val = row[col];
                            if (typeof val === 'boolean') {
                                return `<td style="text-align:center;"><input type="checkbox" ${val ? 'checked' : ''} onchange="adminMultiUpdateCell(${sIdx}, ${idx}, '${col}', this.checked)" /></td>`;
                            }
                            const display = (val === null || val === undefined) ? '' : (typeof val === 'object' ? JSON.stringify(val) : val);
                            return `<td><input type="text" class="admin-json-cell-input" value="${escapeHtml(String(display))}" onchange="adminMultiUpdateCell(${sIdx}, ${idx}, '${col}', this.value)" /></td>`;
                        }).join('')}
                        <td><span class="admin-action-icon delete" onclick="adminMultiDeleteRow(${sIdx}, ${idx})">🗑️</span></td>
                    </tr>
                `).join('')}</tbody>`;
                return header + body;
            }

            function refreshMultiSection(sIdx) {
                const table = document.getElementById('adminMultiSection' + sIdx);
                if (table) table.innerHTML = buildMultiSectionTableInnerHTML(sIdx);
                const header = table ? table.closest('.admin-section-table').previousElementSibling : null;
                if (header) {
                    const countEl = header.querySelector('.admin-section-count');
                    if (countEl) countEl.textContent = `(${adminTableEditorState.sections[sIdx].rows.length})`;
                }
            }

            window.adminMultiUpdateGeneral = function(idx, value) {
                const row = adminTableEditorState.generalRows[idx];
                if (typeof row.value === 'boolean') { row.value = !!value; return; }
                if (typeof row.value === 'number') {
                    const n = parseFloat(value);
                    row.value = isNaN(n) ? value : n;
                    return;
                }
                row.value = value;
            };

            window.adminMultiUpdateCell = function(sIdx, idx, col, value) {
                const section = adminTableEditorState.sections[sIdx];
                const current = section.rows[idx][col];
                if (current !== null && typeof current === 'object') {
                    try { section.rows[idx][col] = JSON.parse(value); return; } catch (e) { /* keep typing */ }
                }
                section.rows[idx][col] = value;
            };

            window.adminMultiUpdateFreeform = function(sIdx, idx, value) {
                try { adminTableEditorState.sections[sIdx].rows[idx] = JSON.parse(value); } catch (e) { /* keep old until valid JSON */ }
            };

            window.adminMultiDeleteRow = function(sIdx, idx) {
                const section = adminTableEditorState.sections[sIdx];
                section.rows.splice(idx, 1);
                section.selected.delete(idx);
                refreshMultiSection(sIdx);
            };

            window.adminMultiAddRow = function(sIdx) {
                const section = adminTableEditorState.sections[sIdx];
                if (section.columns.length === 0) {
                    section.rows.push({});
                } else {
                    const blank = {};
                    section.columns.forEach(c => { blank[c] = ''; });
                    section.rows.push(blank);
                }
                refreshMultiSection(sIdx);
            };

            window.adminMultiToggleSelectRow = function(sIdx, idx, checkbox) {
                const section = adminTableEditorState.sections[sIdx];
                if (checkbox.checked) section.selected.add(idx);
                else section.selected.delete(idx);
            };

            window.adminMultiToggleSelectAllCheckbox = function(sIdx, checkbox) {
                const section = adminTableEditorState.sections[sIdx];
                if (checkbox.checked) section.rows.forEach((_, idx) => section.selected.add(idx));
                else section.selected.clear();
                refreshMultiSection(sIdx);
            };

            window.adminMultiSelectAll = function(sIdx) {
                const section = adminTableEditorState.sections[sIdx];
                section.rows.forEach((_, idx) => section.selected.add(idx));
                refreshMultiSection(sIdx);
            };

            window.adminMultiDeleteSelected = function(sIdx) {
                const section = adminTableEditorState.sections[sIdx];
                const toDelete = Array.from(section.selected).sort((a, b) => b - a);
                toDelete.forEach(idx => section.rows.splice(idx, 1));
                section.selected.clear();
                refreshMultiSection(sIdx);
            };

            function buildJsonArrayTableModalHTML(path, arr, rootType) {
                const columns = [];
                arr.forEach(obj => Object.keys(obj).forEach(k => { if (!columns.includes(k)) columns.push(k); }));
                const isObjectRoot = rootType === 'object';
                const freeform = columns.length === 0 && !isObjectRoot;
                adminTableEditorState = {
                    path, mode: freeform ? 'array-freeform' : 'array', rootType: rootType || 'array',
                    columns,
                    rows: freeform ? arr.map(o => JSON.stringify(o)) : JSON.parse(JSON.stringify(arr)),
                    selected: new Set()
                };

                return `
                    <div class="admin-modal-overlay" id="adminFileModalOverlay">
                        <div class="admin-modal-card admin-table-modal">
                            <button class="admin-modal-close" onclick="adminCloseFileModal()">✕</button>
                            <h3 class="admin-modal-title">${escapeHtml(path.split('/').pop())}</h3>
                            ${freeform ? '<p class="admin-modal-note">This file is an empty list, so there are no columns to show yet - add a row and type a JSON object for it (e.g. {"id": 1, "name": "Example"}).</p>' : ''}
                            <div class="admin-json-table-wrapper">
                                <table class="admin-json-table" id="adminJsonTable">${buildJsonArrayTableInnerHTML()}</table>
                            </div>
                            <div class="admin-modal-actions admin-json-actions">
                                <div class="admin-json-actions-left">
                                    ${isObjectRoot ? '' : `
                                    <button class="admin-btn admin-btn-add-file" onclick="adminJsonAddRow()">+ Add Row</button>
                                    <button class="admin-btn admin-btn-delete" onclick="adminJsonDeleteSelected()">🗑️ Delete Selected</button>
                                    <button class="admin-btn admin-btn-add-folder" onclick="adminJsonSelectAll()">☑️ Select All</button>
                                    `}
                                </div>
                                <div class="admin-json-actions-right">
                                    <button class="admin-modal-save" onclick="adminSaveFile('${path.replace(/'/g, "\\'")}', '${freeform ? 'array-freeform' : 'array'}')">💾 Save</button>
                                    <button class="admin-modal-cancel" onclick="adminCloseFileModal()">Cancel</button>
                                </div>
                            </div>
                        </div>
                    </div>
                `;
            }

            function buildJsonArrayTableInnerHTML() {
                const { columns, rows, selected } = adminTableEditorState;

                if (columns.length === 0) {
                    const header = `<thead><tr><th><input type="checkbox" onchange="adminJsonToggleSelectAllCheckbox(this)" /></th><th>Row (JSON object)</th><th>Del</th></tr></thead>`;
                    const body = `<tbody>${rows.map((rowStr, idx) => `
                        <tr>
                            <td><input type="checkbox" ${selected.has(idx) ? 'checked' : ''} onchange="adminJsonToggleSelectRow(${idx}, this)" /></td>
                            <td><input type="text" class="admin-json-cell-input" value="${escapeHtml(rowStr)}" placeholder='{"key": "value"}' onchange="adminJsonUpdateFreeformRow(${idx}, this.value)" /></td>
                            <td><span class="admin-action-icon delete" onclick="adminJsonDeleteRow(${idx})">🗑️</span></td>
                        </tr>
                    `).join('')}</tbody>`;
                    return header + body;
                }

                const isObjectRoot = adminTableEditorState.rootType === 'object';
                const header = `<thead><tr>${isObjectRoot ? '' : '<th><input type="checkbox" onchange="adminJsonToggleSelectAllCheckbox(this)" /></th>'}${columns.map(c => `<th>${escapeHtml(c)}</th>`).join('')}${isObjectRoot ? '' : '<th>Del</th>'}</tr></thead>`;
                const body = `<tbody>${rows.map((row, idx) => `
                    <tr>
                        ${isObjectRoot ? '' : `<td><input type="checkbox" ${selected.has(idx) ? 'checked' : ''} onchange="adminJsonToggleSelectRow(${idx}, this)" /></td>`}
                        ${columns.map(col => {
                            const val = row[col];
                            if (typeof val === 'boolean') {
                                return `<td style="text-align:center;"><input type="checkbox" ${val ? 'checked' : ''} onchange="adminJsonUpdateCell(${idx}, '${col}', this.checked)" /></td>`;
                            }
                            const display = (val === null || val === undefined) ? '' : (typeof val === 'object' ? JSON.stringify(val) : val);
                            return `<td><input type="text" class="admin-json-cell-input" value="${escapeHtml(String(display))}" onchange="adminJsonUpdateCell(${idx}, '${col}', this.value)" /></td>`;
                        }).join('')}
                        ${isObjectRoot ? '' : `<td><span class="admin-action-icon delete" onclick="adminJsonDeleteRow(${idx})">🗑️</span></td>`}
                    </tr>
                `).join('')}</tbody>`;
                return header + body;
            }

            window.adminJsonUpdateFreeformRow = function(idx, value) {
                adminTableEditorState.rows[idx] = value;
            };

            function refreshJsonTable() {
                const table = document.getElementById('adminJsonTable');
                if (table) table.innerHTML = buildJsonArrayTableInnerHTML();
            }

            window.adminJsonUpdateCell = function(idx, col, value) {
                const current = adminTableEditorState.rows[idx][col];
                // Preserve nested object/array structure: if the cell used to
                // hold a real object/array (shown as JSON text), try to parse
                // the edited text back into one instead of storing it as a
                // plain string (which would otherwise corrupt the JSON shape
                // on save).
                if (current !== null && typeof current === 'object') {
                    try {
                        adminTableEditorState.rows[idx][col] = JSON.parse(value);
                        return;
                    } catch (e) {
                        // not valid JSON yet (e.g. still mid-edit) - fall
                        // through and store the raw text for now.
                    }
                }
                adminTableEditorState.rows[idx][col] = value;
            };

            window.adminJsonDeleteRow = function(idx) {
                adminTableEditorState.rows.splice(idx, 1);
                adminTableEditorState.selected.delete(idx);
                refreshJsonTable();
            };

            window.adminJsonAddRow = function() {
                if (adminTableEditorState.mode === 'array-freeform') {
                    adminTableEditorState.rows.push('{}');
                } else if (adminTableEditorState.mode === 'array') {
                    const blank = {};
                    adminTableEditorState.columns.forEach(c => { blank[c] = ''; });
                    adminTableEditorState.rows.push(blank);
                }
                refreshJsonTable();
            };

            window.adminJsonToggleSelectRow = function(idx, checkbox) {
                if (checkbox.checked) adminTableEditorState.selected.add(idx);
                else adminTableEditorState.selected.delete(idx);
            };

            window.adminJsonToggleSelectAllCheckbox = function(checkbox) {
                if (checkbox.checked) adminTableEditorState.rows.forEach((_, idx) => adminTableEditorState.selected.add(idx));
                else adminTableEditorState.selected.clear();
                refreshJsonTable();
            };

            window.adminJsonSelectAll = function() {
                adminTableEditorState.rows.forEach((_, idx) => adminTableEditorState.selected.add(idx));
                refreshJsonTable();
            };

            window.adminJsonDeleteSelected = function() {
                const toDelete = Array.from(adminTableEditorState.selected).sort((a, b) => b - a);
                toDelete.forEach(idx => adminTableEditorState.rows.splice(idx, 1));
                adminTableEditorState.selected.clear();
                refreshJsonTable();
            };

            window.adminSaveFile = async function(path, mode) {
                let content;
                if (mode === 'array-freeform') {
                    try {
                        content = JSON.stringify(adminTableEditorState.rows.map(r => JSON.parse(r)), null, 4);
                    } catch (err) {
                        showWarning('One or more rows are not valid JSON: ' + err.message);
                        return;
                    }
                } else if (mode === 'array') {
                    content = JSON.stringify(adminTableEditorState.rows, null, 4);
                } else if (mode === 'multi-virtual') {
                    // Reconstruct {key: {...fields}} from the "_key"-tagged rows.
                    const obj = {};
                    adminTableEditorState.rows.forEach((row) => {
                        const key = row._key;
                        if (!key) return;
                        const copy = Object.assign({}, row);
                        delete copy._key;
                        obj[key] = copy;
                    });
                    content = JSON.stringify(obj, null, 4);
                } else if (mode === 'multi-sectioned') {
                    // Reconstruct the full object from the General rows (paths
                    // like "key" or "key.subkey") plus each extracted section
                    // (title like "key" or "key.subkey") back into place.
                    const obj = {};
                    const setPath = (path2, value) => {
                        const parts = path2.split('.');
                        if (parts.length === 1) {
                            obj[parts[0]] = value;
                        } else {
                            if (typeof obj[parts[0]] !== 'object' || obj[parts[0]] === null || Array.isArray(obj[parts[0]])) {
                                obj[parts[0]] = {};
                            }
                            obj[parts[0]][parts[1]] = value;
                        }
                    };
                    adminTableEditorState.generalRows.forEach(row => setPath(row.key, row.value));
                    adminTableEditorState.sections.forEach(section => setPath(section.title, section.rows));
                    content = JSON.stringify(obj, null, 4);
                } else {
                    content = document.getElementById('adminFileEditorTextarea').value;
                }

                try {
                    const res = await authFetch('/api/admin/write', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ path: path, content: content })
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.error || 'Save failed');
                    adminCloseFileModal();
                    loadAdminDirectory(adminCurrentPath);
                    showMessage('✅ Saved', 'File saved successfully.', ['OK']);
                } catch (err) {
                    showWarning(err.message || 'Could not save file.');
                }
            };

            // ============================================================
            // 29. DOM REFS
            // ============================================================
            const mainMenu = document.getElementById('mainMenu');
            const menuWrapper = document.getElementById('menuWrapper');
            const contentArea = document.getElementById('contentArea');
            const contentBody = document.getElementById('contentBody');
            const currentMenuDisplay = document.getElementById('currentMenuDisplay');
            const centerContent = document.getElementById('centerContent');

            const userNameDisplay = document.getElementById('userNameDisplay');
            const avatarText = document.getElementById('avatarText');
            const userAvatar = document.getElementById('userAvatar');
            const userDropdown = document.getElementById('userDropdown');

            let activeItemId = null;
            let activeSubItemId = null;
            let isUserMenuOpen = false;

            // ============================================================
            // 29b. COMPANY BRANDING (logo + name from company.json)
            // ============================================================
            function applyCompanyBranding() {
                if (!COMPANY_INFO) return;

                const logoEl = document.getElementById('companyLogo');
                const nameEl = document.getElementById('companyName');
                const footerEl = document.getElementById('footerCompany');

                if (logoEl) {
                    if (COMPANY_INFO.logo) {
                        logoEl.innerHTML =
                            `<img src="${COMPANY_INFO.logo}" alt="${COMPANY_INFO.name} logo" onerror="this.onerror=null;this.src='Pictures/logo.png';" />`;
                    } else {
                        logoEl.textContent = '🏢';
                    }
                }

                if (nameEl) {
                    nameEl.innerHTML = `${COMPANY_INFO.name}\n                    <span class="separator" id="separator">|</span>`;
                }

                if (footerEl) {
                    footerEl.textContent = COMPANY_INFO.name;
                }

                document.title = COMPANY_INFO.name;
            }

            // ============================================================
            // 30. USER PROFILE SETUP
            // ============================================================
            function setupUserProfile() {
                const fallback = MENU_CONFIG.user;
                const name = profileData ? `${profileData.firstName} ${profileData.lastName}` : fallback.name;
                const avatarUrl = profileData ? profileData.photo : fallback.avatar;
                const initials = profileData ?
                    ((profileData.firstName[0] || '') + (profileData.lastName[0] || '')) :
                    (fallback.initials || fallback.name.split(' ').map(n => n[0]).join(''));

                userNameDisplay.textContent = name;

                if (avatarUrl) {
                    userAvatar.innerHTML = `<img src="${avatarUrl}" alt="${name}" />`;
                } else {
                    avatarText.textContent = initials;
                }

                renderProfileMenu();
            }

            function renderProfileMenu() {
                userDropdown.innerHTML = '';
                const profileItems = MENU_CONFIG.profileMenu;
                const myRole = profileData ? profileData.role : null;

                profileItems.forEach((item) => {
                    if (item.type === 'divider') {
                        const divider = document.createElement('div');
                        divider.className = 'dropdown-divider';
                        userDropdown.appendChild(divider);
                        return;
                    }

                    // Role-gated items (e.g. Admin) only render for allowed roles.
                    if (Array.isArray(item.rolesAllowed) && !item.rolesAllowed.includes(myRole)) {
                        return;
                    }

                    const btn = document.createElement('button');
                    btn.className = 'dropdown-item';
                    if (item.isLogout) btn.classList.add('logout');
                    btn.textContent = item.label;
                    btn.dataset.action = item.action;
                    btn.addEventListener('click', function(e) {
                        e.stopPropagation();
                        const action = this.dataset.action;
                        userDropdown.classList.remove('show');
                        isUserMenuOpen = false;
                        handleUserAction(action);
                    });
                    userDropdown.appendChild(btn);
                });
            }

            // ============================================================
            // 31. USER DROPDOWN TOGGLE
            // ============================================================
            window.toggleUserDropdown = function(e) {
                if (e) e.stopPropagation();
                closeAllSubMenus();
                userDropdown.classList.toggle('show');
                isUserMenuOpen = userDropdown.classList.contains('show');
            };

            document.addEventListener('click', function(e) {
                const profile = document.getElementById('userProfile');
                if (profile && !profile.contains(e.target)) {
                    userDropdown.classList.remove('show');
                    isUserMenuOpen = false;
                }
            });

            window.handleUserAction = function(action) {
                if (action === 'Logout') {
                    performLogout();
                    return;
                }

                const pagePath = 'User / ' + action;
                resetContentArea();

                setTimeout(() => {
                    let data;
                    if (action === 'Profile') {
                        data = { body: buildProfileBody() };
                    } else if (action === 'Admin') {
                        data = { body: buildAdminFilesBody() };
                    } else if (action === 'Notification') {
                        data = { body: buildNotificationBody() };
                    }
                    updateContent(data, pagePath);
                    contentArea.classList.remove('loading');
                    if (action === 'Admin') loadAdminDirectory('');
                    if (action === 'Notification') renderNotificationTable();
                }, 300);

                document.querySelectorAll('.menu-item > a').forEach(el => el.classList.remove('active'));
                document.querySelectorAll('.sub-menu li a').forEach(el => el.classList.remove('active'));
            };

            // ============================================================
            // 32. RESET CONTENT AREA
            // ============================================================
            function resetContentArea() {
                contentArea.classList.add('loading');
                contentBody.innerHTML = '';
                centerContent.scrollTop = 0;
            }

            // ============================================================
            // 33. UPDATE CONTENT
            // ============================================================
            function updateContent(data, breadcrumb) {
                const bodyContent = typeof data.body === 'function' ? data.body() : data.body;
                contentBody.innerHTML = bodyContent || '';
                currentMenuDisplay.textContent = breadcrumb || 'Dashboard';

                if (breadcrumb && breadcrumb.includes('Payment Mode')) {
                    setTimeout(() => {
                        renderPaymentMethods();
                        const typeSelect = document.getElementById('paymentType');
                        if (typeSelect) togglePaymentForm();
                    }, 50);
                }

                if (breadcrumb && breadcrumb.includes('Payment History')) {
                    setTimeout(renderPaymentHistory, 50);
                }

                if (breadcrumb && breadcrumb.includes('Balance')) {
                    setTimeout(() => {
                        populateBalancePaymentMethods();
                        updateBalanceDisplay();
                    }, 50);
                }

                if (breadcrumb === '📊 Dashboard') {
                    setTimeout(renderTodayTransactions, 50);
                    setTimeout(renderDashboardCounts, 50);
                    setTimeout(renderMyLeasesList, 50);
                }

                if (breadcrumb && breadcrumb.includes('API Documentation')) {
                    setTimeout(() => {
                        renderApiKeyDisplay();
                        renderServicesApiList();
                    }, 50);
                }

                if (breadcrumb && breadcrumb.includes('Support') && !breadcrumb.includes('Help Center')) {
                    setTimeout(renderSupportTable, 50);
                }

                if (breadcrumb && (breadcrumb.includes('Lease Abstraction') || breadcrumb.includes('Translation'))) {
                    setTimeout(setupDragAndDrop, 50);
                }
            }

            // ============================================================
            // 34. DRAG AND DROP SETUP
            // ============================================================
            function setupDragAndDrop() {
                const dropZone = document.getElementById('dropZone');
                const fileInput = document.getElementById('fileInput');

                if (!dropZone) return;

                const serviceId = activeSubItemId === 'translation' ? 'translation' : 'lease-abstraction';

                dropZone.addEventListener('dragover', function(e) {
                    e.preventDefault();
                    this.classList.add('dragover');
                });

                dropZone.addEventListener('dragleave', function(e) {
                    e.preventDefault();
                    this.classList.remove('dragover');
                });

                dropZone.addEventListener('drop', function(e) {
                    e.preventDefault();
                    this.classList.remove('dragover');
                    const files = e.dataTransfer.files;
                    if (files.length > 0) {
                        const mockEvent = { target: { files: files } };
                        handleFileUpload(mockEvent, serviceId);
                    }
                });
            }

            // ============================================================
            // 35. MENU RENDERER
            // ============================================================
            function renderMenu() {
                mainMenu.innerHTML = '';
                const mainMenuItems = MENU_CONFIG.mainMenu;

                mainMenuItems.forEach((item) => {
                    const li = document.createElement('li');
                    li.className = 'menu-item';

                    const a = document.createElement('a');
                    a.textContent = item.label;
                    a.dataset.id = item.id;

                    const hasSub = item.subItems && item.subItems.length > 0;
                    a.dataset.hasSub = hasSub ? 'true' : 'false';

                    if (hasSub) {
                        const arrow = document.createElement('span');
                        arrow.className = 'arrow';
                        arrow.textContent = '▼';
                        a.appendChild(arrow);
                        a.addEventListener('click', function(e) {
                            e.preventDefault();
                            if (isUserMenuOpen) {
                                userDropdown.classList.remove('show');
                                isUserMenuOpen = false;
                            }
                            toggleSubMenu(this);
                        });
                    } else {
                        a.addEventListener('click', function(e) {
                            e.preventDefault();
                            if (isUserMenuOpen) {
                                userDropdown.classList.remove('show');
                                isUserMenuOpen = false;
                            }
                            loadContent(item.id, null);
                            if (window.innerWidth <= 768) menuWrapper.classList.remove('open');
                        });
                    }

                    li.appendChild(a);

                    if (hasSub) {
                        const ul = document.createElement('ul');
                        ul.className = 'sub-menu';
                        ul.dataset.parentId = item.id;

                        item.subItems.forEach((sub) => {
                            const subLi = document.createElement('li');
                            const subA = document.createElement('a');
                            subA.textContent = sub.label;
                            subA.dataset.id = sub.id;
                            subA.dataset.parentId = item.id;

                            subA.addEventListener('click', function(e) {
                                e.preventDefault();
                                if (isUserMenuOpen) {
                                    userDropdown.classList.remove('show');
                                    isUserMenuOpen = false;
                                }
                                loadContent(item.id, sub.id);
                                closeAllSubMenus();
                                if (window.innerWidth <= 768) menuWrapper.classList.remove('open');
                            });
                            subLi.appendChild(subA);
                            ul.appendChild(subLi);
                        });

                        li.appendChild(ul);
                    }

                    mainMenu.appendChild(li);
                });
            }

            function toggleSubMenu(element) {
                const li = element.closest('.menu-item');
                const subMenu = li.querySelector('.sub-menu');
                const arrow = element.querySelector('.arrow');

                if (subMenu) {
                    document.querySelectorAll('.sub-menu.show').forEach((menu) => {
                        if (menu !== subMenu) {
                            menu.classList.remove('show');
                            const parentArrow = menu.closest('.menu-item').querySelector('.arrow');
                            if (parentArrow) parentArrow.classList.remove('open');
                        }
                    });

                    subMenu.classList.toggle('show');
                    if (arrow) arrow.classList.toggle('open');
                }
            }

            function closeAllSubMenus() {
                document.querySelectorAll('.sub-menu.show').forEach((menu) => {
                    menu.classList.remove('show');
                    const arrow = menu.closest('.menu-item').querySelector('.arrow');
                    if (arrow) arrow.classList.remove('open');
                });
            }

            // ============================================================
            // 36. LOAD CONTENT
            // ============================================================
            function loadContent(parentId, subId) {
                resetContentArea();

                setTimeout(() => {
                    const parent = MENU_CONFIG.mainMenu.find(item => item.id === parentId);
                    if (!parent) return;

                    let dataKey = parentId;
                    let breadcrumb = parent.label;

                    if (subId) {
                        const sub = parent.subItems.find(item => item.id === subId);
                        if (sub) {
                            dataKey = subId;
                            breadcrumb = parent.label + ' / ' + sub.label;
                            activeSubItemId = subId;
                        }
                    } else {
                        activeSubItemId = null;
                    }

                    activeItemId = parentId;

                    let data = CONTENT_DATA[dataKey];
                    if (!data) {
                        data = { body: '<div class="content-section"><p>Content not available for this section.</p></div>' };
                    }

                    updateContent(data, breadcrumb);

                    document.querySelectorAll('.menu-item > a').forEach((el) => {
                        el.classList.remove('active');
                        if (el.dataset.id === parentId) el.classList.add('active');
                    });

                    document.querySelectorAll('.sub-menu li a').forEach((el) => {
                        el.classList.remove('active');
                        if (el.dataset.id === subId && el.dataset.parentId === parentId) el.classList.add(
                        'active');
                    });

                    closeAllSubMenus();
                    contentArea.classList.remove('loading');
                }, 300);
            }

            // ============================================================
            // 37. MOBILE TOGGLE
            // ============================================================
            window.toggleMenu = function() {
                menuWrapper.classList.toggle('open');
            };

            document.addEventListener('click', function(e) {
                const toggle = document.querySelector('.menu-toggle');
                if (window.innerWidth <= 768) {
                    if (!menuWrapper.contains(e.target) && !toggle.contains(e.target)) {
                        menuWrapper.classList.remove('open');
                    }
                }
            });

            document.addEventListener('click', function(e) {
                if (!e.target.closest('.menu-item')) {
                    closeAllSubMenus();
                }
            });

            // ============================================================
            // 38. CONTENT DATA
            // ============================================================
            const CONTENT_DATA = {
                dashboard: {
                    body: `
                        <div class="dashboard-grid">
                            <div class="dash-card">
                                <div class="dash-card-icon">📋</div>
                                <div class="dash-card-value" id="dashCurrentPlan">Professional Plan</div>
                                <div class="dash-card-label">Current Plan</div>
                            </div>
                            <div class="dash-card">
                                <div class="dash-card-icon">💰</div>
                                <div class="dash-card-value" id="dashBalance">$0.00</div>
                                <div class="dash-card-label">Balance</div>
                            </div>
                            <div class="dash-card">
                                <div class="dash-card-icon">📄</div>
                                <div class="dash-card-value" id="dashLeaseCount">—</div>
                                <div class="dash-card-label">Total Lease Abstraction</div>
                            </div>
                            <div class="dash-card">
                                <div class="dash-card-icon">🌐</div>
                                <div class="dash-card-value" id="dashTranslationCount">—</div>
                                <div class="dash-card-label">Total Translation</div>
                            </div>
                        </div>
                        <div class="history-card" style="height:280px;margin-top:20px;">
                            <h3>📅 Today's Transactions</h3>
                            <div class="card-body">
                                <table class="history-table" id="todayTableHeader">
                                    <thead>
                                        <tr>
                                            <th>Transaction Date & Time</th>
                                            <th>Transaction ID</th>
                                            <th>User ID</th>
                                            <th>Payment Type</th>
                                            <th>Payment Mode</th>
                                            <th>Description</th>
                                            <th>Credit</th>
                                            <th>Debit</th>
                                        </tr>
                                    </thead>
                                </table>
                                <div class="history-table-wrapper" id="todayTableWrapper">
                                    <table class="history-table" id="todayTable">
                                        <tbody id="todayTableBody">
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </div>
                        <div class="history-card" style="height:240px;margin-top:20px;">
                            <h3>📁 My Processed Leases</h3>
                            <div class="card-body" style="overflow-y:auto;">
                                <ul class="my-leases-list" id="myLeasesList">
                                    <li class="my-leases-empty">Loading…</li>
                                </ul>
                            </div>
                        </div>
                    `
                },
                'lease-abstraction': {
                    body: function() {
                        return buildServiceUploadHTML('lease-abstraction', 'Lease Abstraction', '📄');
                    }
                },
                translation: {
                    body: function() {
                        return buildServiceUploadHTML('translation', 'Translation', '🌐');
                    }
                },
                'plans-offers': {
                    body: `
                        <div class="plans-grid">
                            <div class="plan-card">
                                <div class="plan-name">🆓 Free</div>
                                <div class="plan-price">$0<span>/month</span></div>
                                <ul class="plan-features">
                                    <li>✅ Unlimited Translation</li>
                                    <li>✅ Community Support</li>
                                    <li>✅ Basic Dashboard Access</li>
                                </ul>
                                <button class="plan-cta-btn">Get Started</button>
                            </div>
                            <div class="plan-card featured">
                                <div class="plan-badge">⭐ Most Popular</div>
                                <div class="plan-name">🚀 Professional</div>
                                <div class="plan-price">$79<span>/month</span></div>
                                <ul class="plan-features">
                                    <li>✅ Unlimited Translation</li>
                                    <li>✅ $10 / Lease Abstraction</li>
                                    <li>✅ Priority Support</li>
                                    <li>✅ Advanced Dashboard Access</li>
                                </ul>
                                <button class="plan-cta-btn">Upgrade Now</button>
                            </div>
                        </div>
                    `
                },
                balance: {
                    body: `
                        <div class="balance-grid" id="balanceGrid">
                            <div class="balance-card">
                                <div class="balance-number credit" id="totalCreditBalance">$0.00</div>
                                <div class="balance-label">Total Credit</div>
                            </div>
                            <div class="balance-card">
                                <div class="balance-number debit" id="totalDebitBalance">$0.00</div>
                                <div class="balance-label">Total Debit</div>
                            </div>
                            <div class="balance-card">
                                <div class="balance-number" id="currentBalanceDisplay">$0.00</div>
                                <div class="balance-label">Current Balance</div>
                            </div>
                        </div>
                        <div class="balance-add-card">
                            <h3>➕ Add Balance</h3>
                            <div class="form-row">
                                <div class="form-group">
                                    <label>Payment Method</label>
                                    <select id="balancePaymentMethod"></select>
                                </div>
                                <div class="form-group">
                                    <label>Amount</label>
                                    <input type="number" id="balanceAmount" placeholder="Enter amount" min="0.01" step="0.01" />
                                </div>
                                <div class="form-group">
                                    <label>Description</label>
                                    <input type="text" id="balanceDescription" placeholder="Enter description" />
                                </div>
                                <button class="add-btn" onclick="addBalance()">+ Add Balance</button>
                            </div>
                        </div>
                    `
                },
                'payment-mode': {
                    body: `
                        <div class="payment-layout">
                            <div class="payment-left">
                                <div class="payment-card">
                                    <h3>💳 Your Payment Methods</h3>
                                    <div class="card-body">
                                        <ul class="payment-list" id="paymentList"></ul>
                                    </div>
                                </div>
                            </div>
                            <div class="payment-right">
                                <div class="payment-card">
                                    <h3>➕ Add New Payment Method</h3>
                                    <div class="card-body">
                                        <div class="payment-form" id="paymentForm">
                                            <div class="form-group">
                                                <label>Payment Type</label>
                                                <select id="paymentType" onchange="togglePaymentForm()">
                                                    <option value="credit-card">💳 Credit Card</option>
                                                    <option value="upi">📱 UPI</option>
                                                </select>
                                            </div>
                                            <div id="creditCardFields">
                                                <div class="form-group">
                                                    <label>Card Number</label>
                                                    <input type="text" id="cardNumber" placeholder="1234 5678 9012 3456" />
                                                </div>
                                                <div class="form-group">
                                                    <label>Name on Card</label>
                                                    <input type="text" id="cardName" placeholder="John Doe" />
                                                </div>
                                                <div class="form-row">
                                                    <div class="form-group">
                                                        <label>Expiry Date</label>
                                                        <input type="text" id="expiryDate" placeholder="MM/YYYY" />
                                                    </div>
                                                    <div class="form-group">
                                                        <label>CVV</label>
                                                        <input type="text" id="cvv" placeholder="***" />
                                                    </div>
                                                </div>
                                            </div>
                                            <div id="upiFields" style="display:none;">
                                                <div class="form-group">
                                                    <label>UPI ID</label>
                                                    <input type="text" id="upiId" placeholder="john.doe@upi" />
                                                </div>
                                            </div>
                                            <button class="submit-btn" onclick="addPaymentMethod()">+ Add Payment Method</button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    `
                },
                'payment-history': {
                    body: function() {
                    return `
                        <div class="history-card">
                            <div class="history-filter-bar">
                                <div class="filter-group">
                                    <label>From</label>
                                    <input type="date" id="historyFromDate" />
                                </div>
                                <div class="filter-group">
                                    <label>To</label>
                                    <input type="date" id="historyToDate" />
                                </div>
                                <button class="filter-btn" onclick="applyHistoryFilter()">🔍 Filter</button>
                                <button class="filter-btn reset-btn" onclick="clearHistoryFilter()">✖ Clear</button>
                                ${isAdminOrDeveloper() ? `
                                    <div class="filter-group">
                                        <label>User</label>
                                        <input type="text" id="historyUserFilter" placeholder="User ID or email" oninput="applyHistoryFilter()" />
                                    </div>
                                ` : ''}
                                <button class="filter-btn download-btn" onclick="downloadHistoryExcel()">⬇️ Download Excel</button>
                            </div>
                            <div class="card-body">
                                <table class="history-table" id="historyTableHeader">
                                    <thead>
                                        <tr>
                                            <th>Transaction Date & Time</th>
                                            <th>Transaction ID</th>
                                            <th>User ID</th>
                                            <th>Payment Type</th>
                                            <th>Payment Mode</th>
                                            <th>Description</th>
                                            <th>Credit</th>
                                            <th>Debit</th>
                                        </tr>
                                    </thead>
                                </table>
                                <div class="history-table-wrapper" id="historyTableWrapper">
                                    <table class="history-table" id="historyTable">
                                        <tbody id="historyTableBody"></tbody>
                                    </table>
                                </div>
                                <div class="history-summary" id="historySummary">
                                    <div class="summary-item">
                                        <span class="summary-label">Total Credit</span>
                                        <span class="summary-value credit-value" id="totalCredit">$0.00</span>
                                    </div>
                                    <div class="summary-item">
                                        <span class="summary-label">Total Debit</span>
                                        <span class="summary-value debit-value" id="totalDebit">$0.00</span>
                                    </div>
                                    <div class="summary-item">
                                        <span class="summary-label">Current Balance</span>
                                        <span class="summary-value" id="currentBalance">$0.00</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    `;
                    }
                },
                'api-documentation': {
                    body: `
                        <div class="api-key-card">
                            <h3>🔑 API Key</h3>
                            <p style="font-size:0.85rem;color:rgba(0,0,0,0.6);margin-bottom:10px;">Generate a new API key to authenticate your requests. Keep it secret — treat it like a password.</p>
                            <div class="api-key-row">
                                <div class="api-key-box" id="apiKeyDisplay">No API key generated yet.</div>
                                <div class="api-key-actions" id="apiKeyActions">
                                    <button class="api-action-btn generate-btn" onclick="generateApiKey()">⚡ Generate New API Key</button>
                                    <button class="api-action-btn copy-btn" onclick="copyApiKey()">📋 Copy</button>
                                    <button class="api-action-btn save-btn" onclick="saveApiKey()">💾 Save</button>
                                    <button class="api-action-btn revoke-btn" onclick="revokeApiKey()">🗑️ Delete</button>
                                </div>
                            </div>
                            <div id="apiKeyHistory"></div>
                        </div>
                        <div class="api-key-card">
                            <h3>🛠️ Services API Reference</h3>
                            <p style="font-size:0.85rem;color:rgba(0,0,0,0.6);margin-bottom:10px;">GET and POST endpoints with example requests/responses for each service.</p>
                            <div id="servicesApiList"></div>
                        </div>
                    `
                },
                support: {
                    body: function() {
                    return `
                        <div class="history-card support-log-card support-log-full">
                            <div class="support-log-header-row">
                                <h3>📋 Supports: Log</h3>
                            </div>
                            <div class="history-filter-bar">
                                <div class="filter-group">
                                    <label>From</label>
                                    <input type="date" id="supportFromDate" />
                                </div>
                                <div class="filter-group">
                                    <label>To</label>
                                    <input type="date" id="supportToDate" />
                                </div>
                                <div class="filter-group">
                                    <label>Status</label>
                                    <select id="supportStatusFilter" onchange="applySupportFilter()">
                                        <option value="">All</option>
                                        <option value="Pending">Pending</option>
                                        <option value="Resolved">Resolved</option>
                                    </select>
                                </div>
                                ${isAdminOrDeveloper() ? `
                                    <div class="filter-group">
                                        <label>User</label>
                                        <input type="text" id="supportUserFilter" placeholder="User ID or email" oninput="applySupportFilter()" />
                                    </div>
                                ` : ''}
                                <button class="filter-btn" onclick="applySupportFilter()">🔍 Filter</button>
                                <button class="filter-btn reset-btn" onclick="resetSupportFilter()">↺ Reset</button>
                            </div>
                            <div class="card-body">
                                <div class="support-table-scroll" id="supportTableWrapper">
                                    <table class="support-log-table" id="supportTable">
                                        <thead>
                                            <tr>
                                                <th><input type="checkbox" onchange="toggleSupportSelectAll(this)" /></th>
                                                <th>Ticket ID</th>
                                                <th>Date</th>
                                                <th>Time</th>
                                                <th>User ID</th>
                                                <th>Type</th>
                                                <th>Subject</th>
                                                <th>Message</th>
                                                <th>Status</th>
                                                <th>Response</th>
                                            </tr>
                                        </thead>
                                        <tbody id="supportTableBody"></tbody>
                                    </table>
                                </div>
                                <div class="support-log-footer-row">
                                    <button class="filter-btn delete-btn" onclick="deleteSelectedSupport()">🗑️ Delete</button>
                                    <a class="support-create-new-link" onclick="openMessagePopup('compose')">➕ Create New</a>
                                    <button class="filter-btn download-btn" onclick="downloadSupportExcel()">⬇️ Download Excel</button>
                                </div>
                            </div>
                        </div>
                    `;
                    }
                },
                'contact-us': {
                    body: function() {
                        const c = COMPANY_INFO || {};
                        return `
                        <div class="payment-card company-details-card">
                            <h3>🏢 Company Details</h3>
                            <div class="card-body">
                                <ul class="contact-info-list">
                                    <li><span class="contact-label">Company Name</span><span class="contact-value">${c.name || '-'}</span></li>
                                    <li><span class="contact-label">Address</span><span class="contact-value">${c.address || '-'}</span></li>
                                    <li><span class="contact-label">Working Hours</span><span class="contact-value">${c.workingHours || '-'}</span></li>
                                    <li><span class="contact-label">Working Days</span><span class="contact-value">${c.workingDays || '-'}</span></li>
                                    <li><span class="contact-label">Location</span><span class="contact-value">${c.location || '-'}</span></li>
                                    <li><span class="contact-label">Email</span><span class="contact-value">${c.email || '-'}</span></li>
                                    <li><span class="contact-label">Phone</span><span class="contact-value">${c.phone || '-'}</span></li>
                                    <li><span class="contact-label">WhatsApp</span><span class="contact-value">${c.whatsapp || '-'}</span></li>
                                </ul>
                            </div>
                        </div>
                    `;
                    }
                }
            };

            // ============================================================
            // 38b. BACKEND PERSISTENCE
            // ============================================================
            // py/server.py exposes PUT /api/data/<name>, which overwrites the
            // matching json/<name>.json file on disk. Each domain (payment
            // history, users, contact submissions, ...) is saved straight
            // back to its own real json file - there's no separate "merge on
            // load" step anymore, because the json files themselves are now
            // always the live, current data (the same files load() already
            // reads on startup). If the backend isn't running (e.g. someone
            // opened this with `python3 -m http.server` instead of
            // `python3 py/server.py`), saves fail quietly in the console and
            // a single one-time warning is shown in the UI.
            let backendSaveWarningShown = false;

            async function saveJSON(name, data) {
                try {
                    const res = await authFetch('/api/data/' + name, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(data)
                    });
                    if (!res.ok) throw new Error('Save failed with status ' + res.status);
                } catch (e) {
                    console.warn(`Could not save json/${name}.json to the backend:`, e);
                    if (!backendSaveWarningShown) {
                        backendSaveWarningShown = true;
                        showWarning(
                            'Changes are not being saved to disk right now. Make sure the app is running via ' +
                            '"python3 py/server.py" (not a plain static server) so json/ files can actually be updated.'
                        );
                    }
                }
            }

            function persistPaymentHistory() { return saveJSON('payment-history', paymentHistory); }
            function persistPaymentMethods() { return saveJSON('payment-methods', paymentMethods); }
            function persistContactSubmissions() { return saveJSON('contact-submissions', contactSubmissions); }
            function persistApiKeys() { return saveJSON('api-keys', apiKeys); }
            function persistNotifications() { return saveJSON('notifications', notifications); }

            // Patches ONLY the currently logged-in user's own record via
            // /api/profile/update - replaces the old blanket "overwrite all
            // of users.json" approach, which is no longer possible now that
            // users.json holds real passwords for every account (see
            // py/server.py's ALLOWED_RESOURCES notes).
            async function persistProfile() {
                if (!profileData || !CURRENT_USER_ID) return;
                try {
                    const res = await authFetch('/api/profile/update', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ userId: CURRENT_USER_ID, fields: profileData })
                    });
                    const result = await res.json();
                    if (!res.ok) throw new Error(result.error || 'Save failed with status ' + res.status);
                    if (result.user) profileData = result.user;
                } catch (e) {
                    console.warn('Could not save profile to the backend:', e);
                    if (!backendSaveWarningShown) {
                        backendSaveWarningShown = true;
                        showWarning(
                            'Changes are not being saved to disk right now. Make sure the app is running via ' +
                            '"python3 py/server.py" (not a plain static server) so json/ files can actually be updated.'
                        );
                    }
                }
            }

            function persistServiceFiles(serviceId) {
                if (serviceId === 'translation') {
                    return Promise.all([
                        saveJSON('translation-files', translationFiles),
                        saveJSON('translation-activity-log', translationActivityLog)
                    ]);
                }
                return Promise.all([
                    saveJSON('lease-files', leaseFiles),
                    saveJSON('lease-activity-log', leaseActivityLog)
                ]);
            }

            // ============================================================
            // 39. INITIALIZE (loads all data from /json/*.json files)
            // ============================================================
            async function fetchJSON(path) {
                const res = await authFetch(path);
                if (!res.ok) throw new Error('Failed to load ' + path);
                return res.json();
            }

            async function loadAppData() {
                const [
                    menuConfig,
                    paymentMethodsData,
                    paymentHistoryData,
                    servicesApiData,
                    contactSubmissionsData,
                    meData,
                    messagesData,
                    agentsData,
                    companyData,
                    apiKeysData,
                    leaseFilesData,
                    translationFilesData,
                    leaseActivityLogData,
                    translationActivityLogData,
                    notificationsData
                ] = await Promise.all([
                    fetchJSON('json/menu-config.json'),
                    fetchJSON('json/payment-methods.json'),
                    fetchJSON('json/payment-history.json'),
                    fetchJSON('json/services-api.json'),
                    fetchJSON('json/contact-submissions.json'),
                    fetchJSON('/api/auth/me?userId=' + encodeURIComponent(CURRENT_USER_ID)),
                    fetchJSON('json/messages.json'),
                    fetchJSON('json/agents.json'),
                    fetchJSON('json/company.json'),
                    fetchJSON('json/api-keys.json'),
                    fetchJSON('json/lease-files.json'),
                    fetchJSON('json/translation-files.json'),
                    fetchJSON('json/lease-activity-log.json'),
                    fetchJSON('json/translation-activity-log.json'),
                    fetchJSON('json/notifications.json')
                ]);

                MENU_CONFIG = menuConfig;
                paymentMethods = paymentMethodsData;
                paymentHistory = paymentHistoryData;
                SERVICES_API_DATA = servicesApiData;
                contactSubmissions = contactSubmissionsData;
                MESSAGES = messagesData;
                AGENTS_BY_SERVICE = agentsData;
                COMPANY_INFO = companyData;
                apiKeys = apiKeysData;
                leaseFiles = leaseFilesData;
                translationFiles = translationFilesData;
                leaseActivityLog = leaseActivityLogData;
                translationActivityLog = translationActivityLogData;
                notifications = notificationsData;

                // The only user record the browser ever holds - just the
                // currently logged-in one, fetched fresh from the server.
                profileData = meData.user;

                // System Configuration default comes from the user's own
                // sysConfig field (users.json), not a separate json file.
                currentSystemConfig = (profileData && profileData.sysConfig) || 'Desktop';

                nextApiKeyId = apiKeys.length ? Math.max(...apiKeys.map(k => k.id)) + 1 : 1;
                nextLeaseFileId = leaseFiles.length ? Math.max(...leaseFiles.map(f => Number(f.id) || 0)) + 1 : 1;
                nextTranslationFileId = translationFiles.length ? Math.max(...translationFiles.map(f => Number(f.id) || 0)) + 1 : 1;
                nextTransactionId = paymentHistory.length + 1;
                nextPaymentId = paymentMethods.length + 1;
                nextNotificationId = notifications.length ?
                    Math.max(...notifications.map(n => parseInt((n.id || '').replace('NOTIF', '')) || 0)) + 1 : 1;
            }

            // ============================================================
            // 38c. AUTHENTICATION (login / register / 2FA / forgot password)
            // Renders into #authScreen (see index.html). Talks to the
            // /api/auth/* routes in py/server.py. A real server-issued
            // session token (not just the userId) is what's kept in
            // localStorage now - the server decides who you are from the
            // token on every request after login, instead of trusting a
            // client-supplied userId field (which used to be editable via
            // devtools/localStorage to silently act as a different user).
            // ============================================================
            const AUTH_SESSION_KEY = 'lexora_session_user_id';
            const AUTH_TOKEN_KEY = 'lexora_session_token';
            let AUTH_TOKEN = null;

            // Every authenticated request goes through this instead of a
            // raw authFetch() - it attaches "Authorization: Bearer <token>"
            // automatically. The handful of pre-login auth endpoints
            // (login/register/verify-*/forgot-password/reset-password/
            // resend-code/email-status) don't have a token yet and use
            // plain fetch/authPost below instead, since there's nothing to
            // attach until one of them succeeds.
            function authFetch(url, options) {
                options = options || {};
                const headers = Object.assign({}, options.headers || {});
                if (AUTH_TOKEN) headers['Authorization'] = 'Bearer ' + AUTH_TOKEN;
                return fetch(url, Object.assign({}, options, { headers }));
            }

            let authState = {
                step: 'login',           // login | register | forgot | verify | newPassword
                verifyPurpose: null,     // register | login | reset
                userId: null,
                email: null,
                expiresInMinutes: 4,
                codeFallback: null,      // set when the email couldn't be sent
                resetCode: null,         // the code the user just verified, needed by reset-password
                countdownInterval: null,
                countdownSecondsLeft: 0
            };

            function authPost(path, payload) {
                return authFetch(path, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                }).then(async (res) => {
                    let data = {};
                    try { data = await res.json(); } catch (e) { /* ignore */ }
                    if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
                    return data;
                });
            }

            function buildAuthLeftPanel() {
                const name = (COMPANY_INFO && COMPANY_INFO.name) || 'Lexora AI Solutions';
                const logoPath = (COMPANY_INFO && COMPANY_INFO.logo) || 'Pictures/logo.png';
                return `
                    <div class="auth-brand-icon"><img src="${logoPath}" alt="${escapeHtml(name)} logo" onerror="this.onerror=null;this.src='Pictures/logo.png';" /></div>
                    <h1 class="auth-brand-title">${name}</h1>
                    <p class="auth-brand-tagline">Lease Abstraction AI Tool</p>
                    <p class="auth-brand-sub">RAG · Structured Extraction · Review UI.<br/>RAG-grounded Claude extraction with source citations.</p>
                    <div class="auth-feature-grid">
                        <div class="auth-feature-card">
                            <div class="auth-feature-title">📄 Structured Fields</div>
                            <div class="auth-feature-desc">Insurance, CAM, Options, Late Fee</div>
                        </div>
                        <div class="auth-feature-card">
                            <div class="auth-feature-title">🔍 Rent Roll Audit</div>
                            <div class="auth-feature-desc">53% rent roll error audit — escalation &amp; CAM caps</div>
                        </div>
                        <div class="auth-feature-card">
                            <div class="auth-feature-title">✏️ Human Review UI</div>
                            <div class="auth-feature-desc">Verify or Edit every extracted field</div>
                        </div>
                        <div class="auth-feature-card">
                            <div class="auth-feature-title">🗂️ Lease Repository</div>
                            <div class="auth-feature-desc">All abstracted lease history stored</div>
                        </div>
                    </div>
                `;
            }

            function buildLoginCard() {
                return `
                    <h2 class="auth-card-title">Welcome Back</h2>
                    <div class="auth-form-group">
                        <input type="email" id="loginEmail" class="auth-input" placeholder="Email Address" />
                    </div>
                    <div class="auth-form-group auth-password-group">
                        <input type="password" id="loginPassword" class="auth-input" placeholder="Password" />
                        <span class="auth-eye" onclick="authTogglePassword('loginPassword', this)">👁️</span>
                    </div>
                    <div id="authErrorBox" class="auth-error-box" style="display:none;"></div>
                    <div class="auth-btn-row">
                        <button class="auth-btn-primary" onclick="handleAuthLogin()">Login</button>
                        <button class="auth-btn-secondary" onclick="authResetForm(['loginEmail','loginPassword'])">Reset</button>
                    </div>
                    <div class="auth-links">
                        <a onclick="authGoTo('forgot')">Forgot Password?</a>
                        <a onclick="authGoTo('register')">Create Account</a>
                    </div>
                `;
            }

            function buildRegisterCard() {
                return `
                    <h2 class="auth-card-title">Create Account</h2>
                    <p class="auth-card-note">Fill your details — verification code will be sent.</p>
                    <div class="auth-form-row">
                        <input type="text" id="regFirstName" class="auth-input" placeholder="First Name *" />
                        <input type="text" id="regLastName" class="auth-input" placeholder="Last Name *" />
                    </div>
                    <div class="auth-form-row">
                        <select id="regGender" class="auth-input">
                            <option value="">Select Gender *</option>
                            <option value="Male">Male</option>
                            <option value="Female">Female</option>
                            <option value="Other">Other</option>
                        </select>
                        <input type="date" id="regBirthdate" class="auth-input" />
                    </div>
                    <div class="auth-form-group">
                        <input type="text" id="regMobile" class="auth-input" placeholder="Mobile No *" />
                    </div>
                    <div class="auth-form-group">
                        <input type="email" id="regEmail" class="auth-input" placeholder="Email Address *" />
                    </div>
                    <div class="auth-form-row">
                        <div class="auth-password-group">
                            <input type="password" id="regPassword" class="auth-input" placeholder="Password *" />
                            <span class="auth-eye" onclick="authTogglePassword('regPassword', this)">👁️</span>
                        </div>
                        <div class="auth-password-group">
                            <input type="password" id="regConfirmPassword" class="auth-input" placeholder="Confirm *" />
                            <span class="auth-eye" onclick="authTogglePassword('regConfirmPassword', this)">👁️</span>
                        </div>
                    </div>
                    <div class="auth-hint">Min 8 characters, with 1 uppercase, 1 lowercase, 1 number and 1 special character.</div>
                    <div id="authErrorBox" class="auth-error-box" style="display:none;"></div>
                    <div class="auth-btn-row">
                        <button class="auth-btn-primary" onclick="handleAuthRegister()">Submit</button>
                        <button class="auth-btn-secondary" onclick="authGoTo('login')">Back to Login</button>
                    </div>
                `;
            }

            function buildForgotCard() {
                return `
                    <h2 class="auth-card-title">Reset Password</h2>
                    <p class="auth-card-note">Enter your email to receive a verification code.</p>
                    <div class="auth-form-group">
                        <input type="email" id="forgotEmail" class="auth-input" placeholder="Email Address" />
                    </div>
                    <div id="authErrorBox" class="auth-error-box" style="display:none;"></div>
                    <div class="auth-btn-row">
                        <button class="auth-btn-primary" onclick="handleAuthForgotSubmit()">Send Code</button>
                        <button class="auth-btn-secondary" onclick="authGoTo('login')">Back to Login</button>
                    </div>
                `;
            }

            window.copyFallbackCode = function() {
                const codeEl = document.getElementById('authFallbackCode');
                const code = codeEl ? codeEl.textContent.trim() : '';
                if (!code) return;
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(code).catch(() => {});
                }
            };

            function buildVerifyCard() {
                const titles = {
                    register: '📝 Verify Registration',
                    login: '🔒 Login Verify',
                    reset: '🔑 Reset Password'
                };
                const title = titles[authState.verifyPurpose] || 'Verify';
                const fallbackBox = authState.codeFallback ? `
                    <div class="auth-fallback-box">
                        ⚠️ Email not sent — use this code instead:
                        <span class="auth-fallback-code-row">
                            <strong id="authFallbackCode">${authState.codeFallback}</strong>
                            <button type="button" class="auth-copy-code-btn" onclick="copyFallbackCode()">📋 Copy</button>
                        </span>
                    </div>
                ` : '';
                return `
                    <h2 class="auth-card-title">${title}</h2>
                    <p class="auth-card-note">Enter the 6-digit code sent to<br/>${escapeHtml(authState.email || '')}</p>
                    ${fallbackBox}
                    <div class="auth-otp-row" id="authOtpRow">
                        ${[0, 1, 2, 3, 4, 5].map(i => `<input type="text" maxlength="1" class="auth-otp-box" data-otp-index="${i}" inputmode="numeric" autocomplete="one-time-code" />`).join('')}
                    </div>
                    <div class="auth-countdown" id="authCountdown">Expires in --:--</div>
                    <div id="authErrorBox" class="auth-error-box" style="display:none;"></div>
                    <div class="auth-btn-row">
                        <button class="auth-btn-primary" onclick="handleAuthVerifySubmit()">Verify</button>
                        <button class="auth-btn-secondary" onclick="handleAuthResend()">Resend</button>
                    </div>
                    <div class="auth-links">
                        <a onclick="authGoBackFromVerify()">← Back</a>
                    </div>
                `;
            }

            function buildNewPasswordCard() {
                return `
                    <h2 class="auth-card-title">Set New Password</h2>
                    <p class="auth-card-note">Choose a new password for your account.</p>
                    <div class="auth-form-group auth-password-group">
                        <input type="password" id="newPassword1" class="auth-input" placeholder="New Password *" />
                        <span class="auth-eye" onclick="authTogglePassword('newPassword1', this)">👁️</span>
                    </div>
                    <div class="auth-form-group auth-password-group">
                        <input type="password" id="newPassword2" class="auth-input" placeholder="Confirm New Password *" />
                        <span class="auth-eye" onclick="authTogglePassword('newPassword2', this)">👁️</span>
                    </div>
                    <div class="auth-hint">Min 8 characters, with 1 uppercase, 1 lowercase, 1 number and 1 special character.</div>
                    <div id="authErrorBox" class="auth-error-box" style="display:none;"></div>
                    <div class="auth-btn-row">
                        <button class="auth-btn-primary" onclick="handleAuthSetNewPassword()">Save New Password</button>
                    </div>
                `;
            }

            function buildAuthCard() {
                switch (authState.step) {
                    case 'register': return buildRegisterCard();
                    case 'forgot': return buildForgotCard();
                    case 'verify': return buildVerifyCard();
                    case 'newPassword': return buildNewPasswordCard();
                    default: return buildLoginCard();
                }
            }

            function renderAuthScreen() {
                const root = document.getElementById('authScreen');
                if (!root) return;
                root.innerHTML = `
                    <div class="auth-wrapper">
                        <div class="auth-left">${buildAuthLeftPanel()}</div>
                        <div class="auth-right"><div class="auth-card">${buildAuthCard()}</div></div>
                    </div>
                `;
                if (authState.step === 'verify') {
                    wireOtpBoxes();
                    startAuthCountdown();
                }
            }

            function wireOtpBoxes() {
                const boxes = Array.from(document.querySelectorAll('.auth-otp-box'));
                boxes.forEach((box, idx) => {
                    box.addEventListener('input', () => {
                        box.value = box.value.replace(/[^0-9]/g, '').slice(0, 1);
                        if (box.value && idx < boxes.length - 1) boxes[idx + 1].focus();
                    });
                    box.addEventListener('keydown', (e) => {
                        if (e.key === 'Backspace' && !box.value && idx > 0) boxes[idx - 1].focus();
                    });
                    box.addEventListener('paste', (e) => {
                        const pasted = (e.clipboardData || window.clipboardData).getData('text').replace(/[^0-9]/g, '');
                        if (pasted.length > 1) {
                            e.preventDefault();
                            pasted.slice(0, 6).split('').forEach((digit, i) => { if (boxes[i]) boxes[i].value = digit; });
                            (boxes[Math.min(pasted.length, 6) - 1] || boxes[5]).focus();
                        }
                    });
                });
                if (boxes[0]) boxes[0].focus();
            }

            function getOtpValue() {
                return Array.from(document.querySelectorAll('.auth-otp-box')).map(b => b.value || '').join('');
            }

            function startAuthCountdown() {
                clearInterval(authState.countdownInterval);
                authState.countdownSecondsLeft = Math.round((authState.expiresInMinutes || 4) * 60);
                updateCountdownDisplay();
                authState.countdownInterval = setInterval(() => {
                    authState.countdownSecondsLeft--;
                    if (authState.countdownSecondsLeft <= 0) {
                        clearInterval(authState.countdownInterval);
                        updateCountdownDisplay(true);
                        return;
                    }
                    updateCountdownDisplay();
                }, 1000);
            }

            function updateCountdownDisplay(expired) {
                const el = document.getElementById('authCountdown');
                if (!el) return;
                if (expired) {
                    el.textContent = 'Code expired - tap Resend for a new one.';
                    el.classList.add('expired');
                    return;
                }
                const m = Math.floor(authState.countdownSecondsLeft / 60);
                const s = authState.countdownSecondsLeft % 60;
                el.textContent = `Expires in ${m}:${String(s).padStart(2, '0')}`;
                el.classList.remove('expired');
            }

            window.authGoTo = function(step) {
                clearInterval(authState.countdownInterval);
                authState.step = step;
                authState.codeFallback = null;
                renderAuthScreen();
            };

            window.authGoBackFromVerify = function() {
                if (authState.verifyPurpose === 'reset') authGoTo('forgot');
                else if (authState.verifyPurpose === 'register') authGoTo('register');
                else authGoTo('login');
            };

            window.authTogglePassword = function(id, el) {
                const input = document.getElementById(id);
                if (!input) return;
                if (input.type === 'password') { input.type = 'text'; el.textContent = '🙈'; }
                else { input.type = 'password'; el.textContent = '👁️'; }
            };

            window.authResetForm = function(ids) {
                ids.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
                hideAuthError();
            };

            function showAuthError(msg) {
                const box = document.getElementById('authErrorBox');
                if (box) { box.textContent = msg; box.style.display = 'block'; }
            }

            function hideAuthError() {
                const box = document.getElementById('authErrorBox');
                if (box) box.style.display = 'none';
            }

            // Verification emails are now sent in the background (see
            // py/server.py's _send_verification_email_async) so the verify
            // card shows up immediately instead of waiting on SMTP. This
            // polls for the outcome right after, and if the send actually
            // failed, drops the fallback code into the already-visible
            // card - "immediately" in wall-clock terms, just not blocking
            // the initial screen.
            function pollEmailStatus(userId, attemptsLeft) {
                if (attemptsLeft === undefined) attemptsLeft = 8;
                setTimeout(async () => {
                    try {
                        const res = await fetch('/api/auth/email-status?userId=' + encodeURIComponent(userId));
                        const data = await res.json();
                        if (data.status === 'failed') {
                            authState.codeFallback = data.code;
                            console.log('📧 Email not sent - verification code:', data.code);
                            renderAuthScreen();
                            return;
                        }
                        if (data.status === 'sent') {
                            return;
                        }
                    } catch (e) { /* keep trying */ }
                    if (attemptsLeft > 1) pollEmailStatus(userId, attemptsLeft - 1);
                }, 1000);
            }

            window.handleAuthLogin = async function() {
                hideAuthError();
                const email = document.getElementById('loginEmail').value.trim();
                const password = document.getElementById('loginPassword').value;
                if (!email || !password) { showAuthError('Please enter both email and password.'); return; }

                try {
                    const res = await authPost('/api/auth/login', { email, password });
                    if (res.requires2FA) {
                        authState.verifyPurpose = 'login';
                        authState.userId = res.userId;
                        authState.email = res.email;
                        authState.expiresInMinutes = res.expiresInMinutes;
                        authState.codeFallback = null;
                        authGoTo('verify');
                        pollEmailStatus(res.userId);
                    } else {
                        completeLogin(res.userId, res.token);
                    }
                } catch (err) {
                    showAuthError(err.message);
                }
            };

            window.handleAuthRegister = async function() {
                hideAuthError();
                const firstName = document.getElementById('regFirstName').value.trim();
                const lastName = document.getElementById('regLastName').value.trim();
                const gender = document.getElementById('regGender').value;
                const birthdate = document.getElementById('regBirthdate').value;
                const mobile = document.getElementById('regMobile').value.trim();
                const email = document.getElementById('regEmail').value.trim();
                const password = document.getElementById('regPassword').value;
                const confirmPassword = document.getElementById('regConfirmPassword').value;

                if (!firstName || !lastName || !email || !password) {
                    showAuthError('Please fill in all required fields.');
                    return;
                }
                if (password !== confirmPassword) {
                    showAuthError('Password and Confirm do not match.');
                    return;
                }

                try {
                    const res = await authPost('/api/auth/register', {
                        firstName, lastName, gender, birthdate, mobile, email, password
                    });
                    authState.verifyPurpose = 'register';
                    authState.userId = res.userId;
                    authState.email = res.email;
                    authState.expiresInMinutes = res.expiresInMinutes;
                    authState.codeFallback = null;
                    authGoTo('verify');
                    pollEmailStatus(res.userId);
                } catch (err) {
                    showAuthError(err.message);
                }
            };

            window.handleAuthForgotSubmit = async function() {
                hideAuthError();
                const email = document.getElementById('forgotEmail').value.trim();
                if (!email) { showAuthError('Please enter your email address.'); return; }

                try {
                    const res = await authPost('/api/auth/forgot-password', { email });
                    authState.verifyPurpose = 'reset';
                    authState.userId = res.userId;
                    authState.email = res.email;
                    authState.expiresInMinutes = res.expiresInMinutes;
                    authState.codeFallback = null;
                    authGoTo('verify');
                    pollEmailStatus(res.userId);
                } catch (err) {
                    showAuthError(err.message);
                }
            };

            window.handleAuthVerifySubmit = async function() {
                hideAuthError();
                const code = getOtpValue();
                if (code.length !== 6) { showAuthError('Please enter the 6-digit code.'); return; }

                try {
                    if (authState.verifyPurpose === 'register') {
                        await authPost('/api/auth/verify-register', { userId: authState.userId, code });
                        clearInterval(authState.countdownInterval);
                        authGoTo('login');
                        showMessage('✅ Verified', 'Your account has been verified. Please log in.', ['OK']);
                    } else if (authState.verifyPurpose === 'login') {
                        const verifyRes = await authPost('/api/auth/verify-login', { userId: authState.userId, code });
                        clearInterval(authState.countdownInterval);
                        completeLogin(authState.userId, verifyRes.token);
                    } else if (authState.verifyPurpose === 'reset') {
                        await authPost('/api/auth/verify-reset-code', { userId: authState.userId, code });
                        authState.resetCode = code;
                        clearInterval(authState.countdownInterval);
                        authGoTo('newPassword');
                    }
                } catch (err) {
                    showAuthError(err.message);
                }
            };

            window.handleAuthResend = async function() {
                hideAuthError();
                try {
                    const res = await authPost('/api/auth/resend-code', { userId: authState.userId });
                    authState.expiresInMinutes = res.expiresInMinutes;
                    authState.codeFallback = null;
                    renderAuthScreen();
                    pollEmailStatus(authState.userId);
                    showMessage('📨 Code Resent', 'A new verification code has been sent.', ['OK']);
                } catch (err) {
                    showAuthError(err.message);
                }
            };

            window.handleAuthSetNewPassword = async function() {
                hideAuthError();
                const p1 = document.getElementById('newPassword1').value;
                const p2 = document.getElementById('newPassword2').value;
                if (p1 !== p2) { showAuthError('Passwords do not match.'); return; }

                try {
                    await authPost('/api/auth/reset-password', {
                        userId: authState.userId, code: authState.resetCode, newPassword: p1
                    });
                    authGoTo('login');
                    showMessage('✅ Password Updated', 'Your password has been reset. Please log in.', ['OK']);
                } catch (err) {
                    showAuthError(err.message);
                }
            };

            function completeLogin(userId, token) {
                CURRENT_USER_ID = userId;
                AUTH_TOKEN = token;
                localStorage.setItem(AUTH_SESSION_KEY, userId);
                localStorage.setItem(AUTH_TOKEN_KEY, token);
                document.getElementById('authScreen').style.display = 'none';
                document.getElementById('appShell').style.display = '';
                initializeApp();
            }

            function performLogout() {
                // Fire-and-forget - revokes the token server-side too, not
                // just locally, so it can't be replayed after logout.
                if (AUTH_TOKEN) {
                    authFetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
                        .catch(() => {});
                }
                localStorage.removeItem(AUTH_SESSION_KEY);
                localStorage.removeItem(AUTH_TOKEN_KEY);
                CURRENT_USER_ID = null;
                AUTH_TOKEN = null;
                profileData = null;
                document.getElementById('appShell').style.display = 'none';
                authState = { step: 'login', verifyPurpose: null, userId: null, email: null,
                    expiresInMinutes: 4, codeFallback: null, resetCode: null,
                    countdownInterval: null, countdownSecondsLeft: 0 };
                const authScreen = document.getElementById('authScreen');
                authScreen.style.display = '';
                renderAuthScreen();
            }

            function showAuthScreen() {
                document.getElementById('appShell').style.display = 'none';
                document.getElementById('authScreen').style.display = '';
                authState.step = 'login';
                renderAuthScreen();
            }

            async function boot() {
                try {
                    COMPANY_INFO = await fetchJSON('json/company.json');
                } catch (e) { /* auth screen falls back to a default name */ }

                const savedUserId = localStorage.getItem(AUTH_SESSION_KEY);
                const savedToken = localStorage.getItem(AUTH_TOKEN_KEY);
                if (savedUserId && savedToken) {
                    AUTH_TOKEN = savedToken;
                    try {
                        // The server derives identity from the token itself
                        // now (not the userId in the URL) - this doubles as
                        // validating the saved token is still good.
                        const res = await authFetch('/api/auth/me');
                        if (res.ok) {
                            CURRENT_USER_ID = savedUserId;
                            document.getElementById('authScreen').style.display = 'none';
                            document.getElementById('appShell').style.display = '';
                            return initializeApp();
                        }
                    } catch (e) { /* fall through to login */ }
                    AUTH_TOKEN = null;
                    localStorage.removeItem(AUTH_SESSION_KEY);
                    localStorage.removeItem(AUTH_TOKEN_KEY);
                }
                showAuthScreen();
            }
            async function initializeApp() {
                try {
                    await loadAppData();
                    await loadUserDirectory();
                } catch (err) {
                    console.error('Failed to load application data:', err);
                    document.getElementById('contentBody').innerHTML =
                        '<div class="content-section"><h3>⚠️ Unable to load data</h3>' +
                        '<p>Could not load JSON data files. Browsers block local file fetches when you open index.html ' +
                        'directly (file://) or use a plain static server. Run ' +
                        '<code>python3 py/server.py</code> in the project folder, and open ' +
                        '<code>http://localhost:8000/</code>.</p></div>';
                    return;
                }

                setupUserProfile();
                applyCompanyBranding();
                renderMenu();
                updateNotificationBadge();

                const dashboardItem = MENU_CONFIG.mainMenu.find(item => item.id === 'dashboard');
                if (dashboardItem) {
                    loadContent('dashboard', null);
                }

                console.log('✅ Menu system ready with JSON configuration!');
                console.log('Payment Methods:', paymentMethods);
                console.log('Payment History:', paymentHistory);
                console.log('Lease Files:', getMyLeaseFiles());
                console.log('Translation Files:', getMyTranslationFiles());
            }

            boot();
        })();
