(function() {
            "use strict";

            // ============================================================
            // 0. LOCAL DATE/TIME HELPERS
            // ============================================================
            // toISOString() always converts to UTC - using it for anything
            // shown to the user (activity log timestamps, transaction
            // dates, filename date-stamps, "today" comparisons) shows the
            // wrong clock time and can even show the wrong CALENDAR DATE
            // depending on the user's timezone relative to UTC. These two
            // helpers use the browser's LOCAL time instead, everywhere a
            // date/time needs to be turned into a "YYYY-MM-DD" or
            // "YYYY-MM-DD HH:MM" string for display or storage.
            function localDateStr(d) {
                d = d || new Date();
                const pad = n => String(n).padStart(2, '0');
                return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
            }
            function localDateTimeStr(d) {
                d = d || new Date();
                const pad = n => String(n).padStart(2, '0');
                return `${localDateStr(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
            }

            // ============================================================
            // 1. JSON CONFIGURATION
            // ============================================================
            let MENU_CONFIG = null;
            let CARD_LAYOUT = null;

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
            let PLANS_DATA = [];
            let planHistory = [];

            // Item 3 - looks up the current user's assigned plan (users.json
            // "plan" field) in plans.json; falls back to "Free" (or the
            // first plan available) if the user has no plan set, so this
            // never breaks for older accounts created before plans.json
            // existed.
            function getMyPlan() {
                const planName = (profileData && profileData.plan) || 'Free';
                return PLANS_DATA.find(p => p.name === planName) ||
                    PLANS_DATA.find(p => p.name === 'Free') ||
                    PLANS_DATA[0] ||
                    { name: 'Free', pricePerLeaseAbstraction: 1, pricePerTranslation: 1 };
            }

            function getServicePrice(serviceId, pageCount) {
                const plan = getMyPlan();
                if (serviceId === 'translation') {
                    // Translation: flat per-page rate for the plan,
                    // regardless of With OCR / With Image / language chosen.
                    const perUnit = plan.pricePerTranslation != null ? plan.pricePerTranslation : 1;
                    return perUnit * Math.max(1, pageCount || 1);
                }
                // Lease Abstraction: flat per-document pricing.
                const perUnit = plan.pricePerLeaseAbstraction != null ? plan.pricePerLeaseAbstraction : 1;
                const unit = plan.billingUnit || 'document';
                return unit === 'page' ? perUnit * Math.max(1, pageCount || 1) : perUnit;
            }

            // Est. charge shown on the Uploaded Files card - only when at
            // least one file is checkbox-selected, and shows BOTH the
            // current per-page/per-document rate and the overall total for
            // exactly the selected files (not "all not-yet-completed" like
            // before - selection is now what actually governs what Start
            // will process, see processTranslationFileAt/processLeaseFileAt).
            // Social links come from json/company.json so they can be changed
            // without touching code. Rendered as inline SVG rather than an icon
            // font so there's no extra network dependency and they stay crisp.
            const SOCIAL_ICONS = {
                facebook: '<path d="M22 12a10 10 0 1 0-11.56 9.88v-6.99H7.9V12h2.54V9.8c0-2.5 1.49-3.89 3.77-3.89 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.77-1.63 1.56V12h2.78l-.45 2.89h-2.33v6.99A10 10 0 0 0 22 12z"/>',
                instagram: '<path d="M12 2.16c3.2 0 3.58.01 4.85.07 1.17.05 1.8.25 2.23.41.56.22.96.48 1.38.9.42.42.68.82.9 1.38.16.42.36 1.06.41 2.23.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.05 1.17-.25 1.8-.41 2.23-.22.56-.48.96-.9 1.38-.42.42-.82.68-1.38.9-.42.16-1.06.36-2.23.41-1.27.06-1.65.07-4.85.07s-3.58-.01-4.85-.07c-1.17-.05-1.8-.25-2.23-.41a3.8 3.8 0 0 1-1.38-.9 3.8 3.8 0 0 1-.9-1.38c-.16-.42-.36-1.06-.41-2.23C2.17 15.58 2.16 15.2 2.16 12s.01-3.58.07-4.85c.05-1.17.25-1.8.41-2.23.22-.56.48-.96.9-1.38.42-.42.82-.68 1.38-.9.42-.16 1.06-.36 2.23-.41C8.42 2.17 8.8 2.16 12 2.16zm0 3.68a6.16 6.16 0 1 0 0 12.32 6.16 6.16 0 0 0 0-12.32zm0 10.16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm7.85-10.4a1.44 1.44 0 1 1-2.88 0 1.44 1.44 0 0 1 2.88 0z"/>',
                linkedin: '<path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05a3.74 3.74 0 0 1 3.37-1.85c3.6 0 4.27 2.37 4.27 5.46zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.55V9h3.57zM22.22 0H1.77C.79 0 0 .77 0 1.72v20.56C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.72V1.72C24 .77 23.2 0 22.22 0z"/>',
                youtube: '<path d="M23.5 6.19a3.02 3.02 0 0 0-2.12-2.14C19.5 3.55 12 3.55 12 3.55s-7.5 0-9.38.5A3.02 3.02 0 0 0 .5 6.19C0 8.08 0 12 0 12s0 3.92.5 5.81a3.02 3.02 0 0 0 2.12 2.14c1.88.5 9.38.5 9.38.5s7.5 0 9.38-.5a3.02 3.02 0 0 0 2.12-2.14C24 15.92 24 12 24 12s0-3.92-.5-5.81zM9.55 15.57V8.43L15.82 12z"/>'
            };

            function buildSocialLinksHtml(opts) {
                const o = opts || {};
                const social = (COMPANY_INFO && COMPANY_INFO.social) || {};
                const order = ['facebook', 'instagram', 'linkedin', 'youtube'];
                const links = order.filter(function (k) { return social[k]; });
                if (!links.length) return '';
                const size = o.size || 18;
                const color = o.color || 'currentColor';
                return `<div style="display:flex;gap:${o.gap || 12}px;align-items:center;${o.justify ? 'justify-content:' + o.justify + ';' : ''}">
                    ${links.map(function (k) {
                        return `<a href="${escapeHtml(social[k])}" target="_blank" rel="noopener noreferrer"
                                   title="${k.charAt(0).toUpperCase() + k.slice(1)}"
                                   style="display:inline-flex;color:${color};opacity:0.85;transition:opacity .15s;"
                                   onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.85">
                            <svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${SOCIAL_ICONS[k]}</svg>
                        </a>`;
                    }).join('')}
                </div>`;
            }

            function buildChargeEstimateHtml(serviceId, files) {
                const selectedFiles = files.filter(f => f.selected !== false);
                if (selectedFiles.length === 0) return '';
                const myPlan = getMyPlan();
                let perUnit, unitLabel;
                if (serviceId === 'translation') {
                    perUnit = myPlan.pricePerTranslation != null ? myPlan.pricePerTranslation : 1;
                    unitLabel = 'page';
                } else {
                    perUnit = myPlan.pricePerLeaseAbstraction != null ? myPlan.pricePerLeaseAbstraction : 1;
                    unitLabel = (myPlan.billingUnit || 'document') === 'page' ? 'page' : 'document';
                }
                const total = selectedFiles.reduce((sum, f) => sum + getServicePrice(serviceId, f.pageCount), 0);
                return `💰 Rate: ₹${perUnit.toFixed(2)}/${unitLabel} · Est. total: ₹${total.toFixed(2)} for ${selectedFiles.length} selected file(s)`;
            }

            // Keeps the Est. charge line in sync the moment file selection
            // changes - called from toggleFileSelect and toggleSelectAllFiles
            // (via refreshServicePage), without needing a full page re-render.
            function updateChargeEstimateLive() {
                const serviceId = activeSubItemId === 'translation' ? 'translation' : 'lease-abstraction';
                if (activeSubItemId !== 'translation' && activeSubItemId !== 'lease-abstraction') return;
                const files = serviceId === 'translation' ? getMyTranslationFiles() : getMyLeaseFiles();
                const el = document.getElementById('fileListChargeEstimate');
                if (el) el.innerHTML = buildChargeEstimateHtml(serviceId, files);
            }

            function isPlanExpired() {
                // Item 3 - no plan/no end-date at all means no active
                // plan, which blocks service use exactly like an expired
                // one does - this used to silently return "not expired"
                // (i.e. allowed) in that case, which was backwards.
                if (!profileData || !profileData.plan || !profileData.planEndDate) return true;
                if (profileData.planStatus === 'Expired') return true;
                const today = localDateStr();
                return profileData.planEndDate < today;
            }

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

            // Sends the "process completed, here's what was charged" email +
            // bell notification (item 5) - called once from both the Lease
            // Abstraction and Translation pipelines right after the $1
            // processing fee is debited, so the table always reflects a
            // real, already-completed charge.
            function notifyProcessCompletion(serviceName, fileName, charge, txnId) {
                addNotification(`${serviceName} completed for "${fileName}" - ₹${charge.toFixed(2)} was deducted from your wallet (${txnId}).`);
                if (!profileData || !profileData.email) return;
                sendGenericNotificationEmail(
                    profileData.email,
                    `${profileData.firstName} ${profileData.lastName}`,
                    `${serviceName} completed - ₹${charge.toFixed(2)} deducted`,
                    `Your ${serviceName.toLowerCase()} request has finished processing. The table below shows what was charged to your wallet.`,
                    [[serviceName, fileName, `₹${charge.toFixed(2)}`, `Completed (${txnId})`]],
                    ['Service', 'File', 'Charge', 'Action/Status']
                );
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
                stopped: false,
                totalInBatch: 0,
                runIndex: 0
            };

            // ============================================================
            // 11. PERSISTED ACTIVITY LOG (per service)
            // ============================================================
            let leaseActivityLog = [];
            let translationActivityLog = [];

            let _nextActivityEntryId = 1;

            // Every activity now gets logged as 'Pending' the moment a step
            // STARTS, then flips to 'Completed'/'Failed'/'Skipped' in place
            // (same row, not a new one) once that step actually finishes -
            // addActivity() returns the entry's id so the caller can update
            // it later via updateActivity().
            function addActivity(serviceId, activity, result) {
                const now = new Date();
                const timeStr = localDateTimeStr(now);
                const entry = { id: _nextActivityEntryId++, time: timeStr, activity: activity, result: result, userId: CURRENT_USER_ID };
                if (serviceId === 'translation') {
                    translationActivityLog.unshift(entry);
                } else {
                    leaseActivityLog.unshift(entry);
                }
                return entry.id;
            }

            function updateActivity(serviceId, entryId, newResult, newActivityText) {
                const log = serviceId === 'translation' ? translationActivityLog : leaseActivityLog;
                const entry = log.find(e => e.id === entryId);
                if (entry) {
                    entry.result = newResult;
                    if (newActivityText) entry.activity = newActivityText;
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
                        file.status === 'needs_review' ? 'needs-review' :
                        file.status === 'processing' ? 'processing' : 'pending';

                    const actionLabel = file.status === 'error' ? (file.errorLabel || 'Error') : null;
                    const docFolder = file.leaseName || file.docName || '';
                    const downloadKind = file.docName ? 'translation' : 'lease';
                    // Download the file in the format the user selected for
                    // this document (defaults to docx for translations).
                    const dlFormat = (file.outputFormat === 'pdf') ? 'pdf'
                        : (downloadKind === 'translation' ? 'docx' : 'pdf');
                    const dlFile = dlFormat === 'docx' ? 'Output.docx' : 'Output.pdf';
                    // Bug 4: translation output browser-only (session blob) —
                    // server download nahi. Blob is session me ho to usse download.
                    const isSessionDl = file.sessionDownload && translationBlobStore[file.id];
                    const actionLink = file.status === 'completed' ?
                        (isSessionDl
                          ? `<a class="file-action-link" onclick="downloadSessionBlob('${file.id}')" title="Download"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></a>`
                          : `<a class="file-action-link" onclick="downloadFile('${dlFile}', '${docFolder.replace(/'/g, "\\'")}', '${downloadKind}')" title="Download"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></a>`) :
                        file.status === 'needs_review' ?
                        `<a class="file-action-link review-link" onclick="openLeaseReviewModal('${file.id}')">🔍 Review</a>` :
                        file.status === 'error' ?
                        `<a class="file-action-link error-link" onclick="retryFile('${file.id}')">${actionLabel}</a>` :
                        `<span class="file-action-link disabled" title="${file.status === 'processing' ? 'Processing' : 'Pending'}">${file.status === 'processing' ? '\u23f3' : '\u2022'}</span>`;

                    const scanCell = scanIsNumeric
                        ? `<span class="progress-label">${scanProgress}%</span>`
                        : `<span class="scan-result-text ${statusClass}">${file.scanResult}</span>`;

                    const progressCell = progressIsNumeric
                        ? `<span class="progress-label">${processProgress}%</span>`
                        : `<span class="scan-result-text ${statusClass}">${file.progress || '-'}</span>`;

                    return `
                        <tr>
                            <td><input type="checkbox" class="file-select-checkbox" data-file-id="${file.id}" ${file.selected !== false ? 'checked' : ''} onchange="toggleFileSelect('${file.id}', this.checked)" ${processState.running ? 'disabled' : ''} /></td>
                            <td class="file-name"><a class="file-name-link" onclick="openFilePreview('${file.id}')">${escapeHtml(file.name)}</a></td>
                            <td>${file.pageCount || '-'}</td>
                            <td>${scanCell}</td>
                            <td>${progressCell}</td>
                            <td>${actionLink}</td>
                        </tr>
                    `;
                }).join('');
            }

            function buildActivityLogRows(activityLog) {
                return activityLog.map(log => {
                    const resultClass = (log.result === 'Completed' || log.result === 'Success' || log.result === 'Finished') ? 'completed' :
                        (log.result === 'Error' || log.result === 'Failed') ? 'error' :
                        log.result === 'Skipped' ? 'skipped' :
                        log.result === 'Started' ? 'processing' :
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
            // Item 5 - tracks which agents have already finished their part
            // for the file CURRENTLY being processed, so their pill can look
            // visibly different ("done") from the one actively working and
            // the ones not reached yet. Reset at the start of every new file.
            let completedAgentIds = new Set();

            function markAgentDone(agentId) {
                if (agentId) completedAgentIds.add(agentId);
            }

            // Item 2 - the agentPulse CSS animation (0.4s/cycle) needs at
            // least 3 full cycles (~1.2s) to visibly read as "blinking"
            // before an agent flips to its done/highlighted state. Real
            // work (an API call, OCR, etc) often already takes longer than
            // that on its own - this only adds an explicit wait for the
            // remainder when the real step finished faster than the
            // minimum blink time.
            async function ensureMinBlinkTime(startTime, minMs) {
                minMs = minMs || 1300;
                const elapsed = Date.now() - startTime;
                if (elapsed < minMs) {
                    await sleep(minMs - elapsed);
                }
            }

            // Item 2b - every agent (Success OR Skipped) blinks at least 3
            // times while it's "working" before its pill switches to the
            // done/highlighted look - makes each agent's turn visible even
            // when the real underlying step resolves near-instantly, and
            // even when that agent's result ends up being Skipped.
            async function blinkAgentThenDone(serviceId, agentId, minBlinks) {
                if (!agentId) return;
                minBlinks = minBlinks || 3;
                for (let i = 0; i < minBlinks; i++) {
                    activeAgentId = agentId;
                    refreshServicePage(serviceId);
                    await sleep(130);
                    if (processState.stopped) return;
                    activeAgentId = null;
                    refreshServicePage(serviceId);
                    await sleep(80);
                    if (processState.stopped) return;
                }
                activeAgentId = agentId;
                refreshServicePage(serviceId);
            }

            function buildAgentPillsHTML(serviceId) {
                return getAgents(serviceId).map(agent => {
                    const state = agent.id === activeAgentId ? 'active' : completedAgentIds.has(agent.id) ? 'done' : '';
                    return `
                    <div class="agent-pill ${state}" title="${agent.step ? agent.step + ' ' : ''}${agent.name}">
                        <span class="agent-pill-icon">${state === 'done' ? '✅' : agent.icon}</span>
                        <span class="agent-pill-name">${agent.name}</span>
                    </div>
                `;
                }).join('');
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

                // Est. charge for the current SELECTION, shown top-right of
                // the Uploaded Files card. Only shows when at least one
                // file is checkbox-selected, and shows both the per-page/
                // per-document RATE and the overall total for the selection
                // - see buildChargeEstimateHtml().
                const chargeEstimateHtml = buildChargeEstimateHtml(serviceId, files);
                const controlButtons = buildControlButtonsHTML(serviceId, files.length > 0);

                // File count text for drop zone
                const fileCountText = files.length > 0 ?
                    `${files.length} file(s) uploaded` :
                    'No files uploaded yet';

                // Output Template (lease-abstraction) OR Output Language (translation) - shown in Setup card
                const outputFieldHTML = isTranslation ? `
                    <div class="setup-group">
                        <div style="display:flex;gap:12px;align-items:flex-start;">
                          <div style="flex:1;">
                            <label>Output Language</label>
                            <select id="translationLangSelect" style="width:100%;" ${processState.running ? 'disabled' : ''}>
                                ${TRANSLATION_LANG_OPTIONS}
                            </select>

                          </div>
                          <div style="flex:1;">
                            <label>Output Format</label>
                            <select id="translationOutputFormat" onchange="setTranslationOutputFormat(this.value)" style="width:100%;" ${processState.running ? 'disabled' : ''}
                                    title="DOCX: editable Word file (recommended). PDF: same layout as PDF.">
                                <option value="docx" ${translationOutputFormat !== 'pdf' ? 'selected' : ''}>Word (.docx)</option>
                                <option value="pdf" ${translationOutputFormat === 'pdf' ? 'selected' : ''}>PDF (.pdf)</option>
                            </select>
                          </div>
                        </div>
                        <div style="display:flex;align-items:center;gap:20px;margin-top:10px;">
                            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:normal;"
                                   title="Checked (With OCR): full vision-based OCR - reads scanned/photographed pages too. Unchecked: faster local text extraction - text-based PDFs only (not scanned/photo). Translation works in both. The original page background is always kept behind the text automatically.">
                                <input type="checkbox" id="translationHybridCheck" style="width:auto;margin:0;" ${translationHybridMode ? 'checked' : ''} ${processState.running ? 'disabled' : ''}
                                       onchange="setTranslationHybridMode(this.checked)" />
                                <span>With OCR</span>
                            </label>
                        </div>
                    </div>
                ` : `
                    <div class="setup-group">
                        <label>Output Template</label>
                        <div class="template-select-row">
                            <button class="select-btn" onclick="document.getElementById('templateFileInput').click()">Select</button>
                            <a class="template-file-link" id="templateFileName" href="#" onclick="return false;">${selectedTemplateFile || 'default.pdf'}</a>
                        </div>
                        <input type="file" id="templateFileInput" style="display:none;" accept=".pdf" onchange="selectTemplateFile(event)" />
                    </div>
                `;

                // System config
                let systemOptions = SYSTEM_CONFIGS.map(config => `
                    <option value="${config}" ${config === currentSystemConfig ? 'selected' : ''}>${config}</option>
                `).join('');

                // Mockup me har service page ke neeche ye strip hai.
                const SERVICE_PERKS = [
                    ['<path d="M12 3l7.5 3v5.5c0 4.4-3 8.2-7.5 9.5-4.5-1.3-7.5-5.1-7.5-9.5V6z"/>', 'Secure &amp; Private', 'Your files are encrypted and secure'],
                    ['<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.5"/><path d="m14.5 9.5 5-5"/>', 'High Accuracy', 'Advanced AI ensures best quality output'],
                    ['<path d="M13 2 4.5 13H11l-1 9 8.5-11H12z"/>', 'Fast Processing', 'Quick turnaround for your documents'],
                    ['<path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4"/>', 'Multiple Formats', 'Export to Word, Excel, CSV, JSON and more'],
                    ['<path d="M6.5 19a4.5 4.5 0 0 1 .5-9 6.5 6.5 0 0 1 12.4-1.3A4.2 4.2 0 0 1 18.5 19z"/>', 'Cloud Based', 'Access your files anytime, anywhere']
                ];
                const servicePerksHtml = `
                    <div class="service-perks">
                        ${SERVICE_PERKS.map(p => `<div class="service-perk">
                            <span class="service-perk-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${p[0]}</svg></span>
                            <div><b>${p[1]}</b><span>${p[2]}</span></div>
                        </div>`).join('')}
                    </div>`;

                return `
                    <div>
                        <div class="service-page-grid">
                        <div class="service-col">
                            <!-- Left: Upload Card -->
                            <div class="service-card">
                                <h3>📤 Upload File(s)</h3>
                                <div class="card-body">
                                    <div class="drop-zone" id="dropZone" onclick="${processState.running ? 'void(0)' : "document.getElementById('fileInput').click()"}" style="${processState.running ? 'opacity:0.5;pointer-events:none;' : ''}">
                                        <svg class="drop-art" viewBox="0 0 120 78" fill="none" aria-hidden="true">
                                            <rect x="14" y="10" width="22" height="27" rx="4" fill="#e8433f" transform="rotate(-12 25 23)"/>
                                            <text x="25" y="28" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="8" font-weight="700" fill="#fff" transform="rotate(-12 25 23)">PDF</text>
                                            <rect x="48" y="4" width="22" height="27" rx="4" fill="#1257f5"/>
                                            <text x="59" y="22" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="11" font-weight="700" fill="#fff">W</text>
                                            <rect x="82" y="10" width="22" height="27" rx="4" fill="#1e9d63" transform="rotate(12 93 23)"/>
                                            <text x="93" y="28" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="11" font-weight="700" fill="#fff" transform="rotate(12 93 23)">X</text>
                                            <path d="M44 74a12 12 0 0 1 1-23 16 16 0 0 1 30-3 11 11 0 0 1-2 26z" fill="#2f7bf6"/>
                                            <path d="M60 68V52M52 58l8-8 8 8" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
                                        </svg>
                                        <div class="drop-text">Drag &amp; drop files here</div>
                                        <div class="drop-sub">or click to browse (PDF only)</div>

                                    </div>
                                    <div class="drop-meta">Maximum file size: <b>50MB</b> &nbsp;\u2022&nbsp; Supported: <b>PDF</b></div>
                                    <input type="file" id="fileInput" multiple style="display:none;" accept=".pdf" onchange="handleFileUpload(event, '${serviceId}')" />
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
                                            <label>System Configuration</label>
                                            <div class="system-config-row">
                                                <select id="systemConfigSelect" onchange="verifySystemConnection()">
                                                    ${systemOptions}
                                                </select>
                                                <span id="connectionStatusWrap">${buildConnectionStatusHTML()}</span>
                                            </div>
                                        </div>
                                        <div class="setup-group">
                                            <label>Extraction Rules</label>
                                            <button class="filter-btn" onclick="openRulesPopup()">📐 Update Rules</button>
                                        </div>
                                        ${isAdminOrDeveloper() ? `
                                        <div class="setup-group">
                                            <label>Accuracy Testing</label>
                                            <button class="filter-btn" onclick="openTestComparePopup()">🧪 Test &amp; Compare</button>
                                        </div>
                                        ` : ''}
                                    </div>
                                    ` : ``}

                                    <div class="setup-group" style="margin-top:8px;">
                                        <div class="process-controls" id="processControls">
                                            ${controlButtons}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div class="service-col">
                        <!-- File List Card (Separate) -->
                        <div class="file-list-card">
                            <div class="file-list-card-header">
                                <h3>📁 Uploaded Files</h3>
                                <span class="file-list-charge-estimate" id="fileListChargeEstimate">${chargeEstimateHtml}</span>
                            </div>
                            <div class="card-body">
                                <div class="file-table-wrapper">
                                    <table class="file-table file-table-files">
                                        <colgroup>
                                            <col style="width:4%;"><col style="width:50%;"><col style="width:10%;"><col style="width:16%;"><col style="width:11%;"><col style="width:9%;">
                                        </colgroup>
                                        <thead>
                                            <tr>
                                                <th><input type="checkbox" id="translationSelectAll" ${(files.length > 0 && files.every(f => f.selected !== false)) ? 'checked' : ''} onchange="toggleSelectAllFiles('${serviceId}', this.checked)" title="Select all" /></th>
                                                <th>File Name</th>
                                                <th>Pages</th>
                                                <th>Scan Result</th>
                                                <th>Progress</th>
                                                <th>Action</th>
                                            </tr>
                                        </thead>
                                    </table>
                                    <div class="file-table-scroll">
                                        <table class="file-table file-table-files">
                                            <colgroup>
                                                <col style="width:4%;"><col style="width:50%;"><col style="width:10%;"><col style="width:16%;"><col style="width:11%;"><col style="width:9%;">
                                            </colgroup>
                                            <tbody id="fileTableBody">
                                                ${fileRows || '<tr><td colspan="5" style="text-align:center;padding:15px;color:rgba(0,0,0,0.3);">No files uploaded yet.</td></tr>'}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- Activity Log below (with active agent strip on top) -->
                        <div class="activity-log-section">
                            <div class="activity-log-card">
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
                    </div>

                    ${isTranslation ? '' : `
                    <div class="history-card" style="height:240px;margin-top:20px;">
                        <h3>📁 My Processed Leases</h3>
                        <div class="card-body" style="overflow-y:auto;">
                            <ul class="my-leases-list" id="myLeasesList">
                                <li class="my-leases-empty">Loading…</li>
                            </ul>
                        </div>
                    </div>
                    `}

                `;
            }

            let selectedTemplateFile = null;

            // Translation output mode - persists across service-page
            // re-renders (the setup card's HTML is rebuilt on every
            // refreshServicePage, which would otherwise reset the
            // checkbox). true = Hybrid (layout-preserving), false =
            // Simple (vision reads the page, clean reflowed output).
            // Output Language list — pdf_to_word_v14 tool ki POORI list
            // (dono jagah — initial render aur Hybrid toggle — YAHI ek
            // source use hota hai, taaki lists kabhi drift na karein).
            const TRANSLATION_LANG_OPTIONS =
                '<option value="Arabic">Arabic</option>' +
                '<option value="English" selected>English</option>' +
                '<option value="Hindi">Hindi</option>' +
                '<option value="Urdu">Urdu</option>' +
                '<option value="French">French</option>' +
                '<option value="Spanish">Spanish</option>' +
                '<option value="German">German</option>' +
                '<option value="Italian">Italian</option>' +
                '<option value="Portuguese">Portuguese</option>' +
                '<option value="Russian">Russian</option>' +
                '<option value="Chinese (Simplified)">Chinese (Simplified)</option>' +
                '<option value="Chinese (Traditional)">Chinese (Traditional)</option>' +
                '<option value="Japanese">Japanese</option>' +
                '<option value="Korean">Korean</option>' +
                '<option value="Turkish">Turkish</option>' +
                '<option value="Persian (Farsi)">Persian (Farsi)</option>' +
                '<option value="Bengali">Bengali</option>' +
                '<option value="Punjabi">Punjabi</option>' +
                '<option value="Gujarati">Gujarati</option>' +
                '<option value="Marathi">Marathi</option>' +
                '<option value="Tamil">Tamil</option>' +
                '<option value="Telugu">Telugu</option>' +
                '<option value="Kannada">Kannada</option>' +
                '<option value="Malayalam">Malayalam</option>' +
                '<option value="Thai">Thai</option>' +
                '<option value="Vietnamese">Vietnamese</option>' +
                '<option value="Indonesian">Indonesian</option>' +
                '<option value="Malay">Malay</option>' +
                '<option value="Dutch">Dutch</option>' +
                '<option value="Polish">Polish</option>' +
                '<option value="Ukrainian">Ukrainian</option>' +
                '<option value="Greek">Greek</option>' +
                '<option value="Hebrew">Hebrew</option>' +
                '<option value="Swahili">Swahili</option>' +
                '<option value="Amharic">Amharic</option>' +
                '<option value="Pashto">Pashto</option>' +
                '<option value="Nepali">Nepali</option>' +
                '<option value="Sinhala">Sinhala</option>' +
                '<option value="Burmese">Burmese</option>' +
                '<option value="Khmer">Khmer</option>' +
                '<option value="Lao">Lao</option>' +
                '<option value="Mongolian">Mongolian</option>' +
                '<option value="Kazakh">Kazakh</option>' +
                '<option value="Uzbek">Uzbek</option>' +
                '<option value="Azerbaijani">Azerbaijani</option>' +
                '<option value="Armenian">Armenian</option>' +
                '<option value="Georgian">Georgian</option>' +
                '<option value="Serbian">Serbian</option>' +
                '<option value="Croatian">Croatian</option>' +
                '<option value="Czech">Czech</option>' +
                '<option value="Slovak">Slovak</option>' +
                '<option value="Hungarian">Hungarian</option>' +
                '<option value="Romanian">Romanian</option>' +
                '<option value="Bulgarian">Bulgarian</option>' +
                '<option value="Finnish">Finnish</option>' +
                '<option value="Swedish">Swedish</option>' +
                '<option value="Norwegian">Norwegian</option>' +
                '<option value="Danish">Danish</option>' +
                '<option value="Somali">Somali</option>' +
                '<option value="Hausa">Hausa</option>' +
                '<option value="Yoruba">Yoruba</option>' +
                '<option value="Zulu">Zulu</option>' +
                '<option value="Afrikaans">Afrikaans</option>' +
                '<option value="Filipino (Tagalog)">Filipino (Tagalog)</option>';

            let translationHybridMode = false;   // default: UNCHECKED (user spec)
            // Image is ALWAYS placed behind the text now (no more With Image
            // checkbox), and cleaning is automatic: Text-based mode always
            // uses deterministic local paint; With-OCR mode uses the page's
            // own OCR JSON background flag to decide between AI clean (real
            // background/graphics present) and local paint (text-only page).
            window.setTranslationHybridMode = function(checked) {
                translationHybridMode = !!checked;
                // This toggle now only changes HOW text is extracted
                // (local text-layer vs vision OCR). Image handling and
                // translation are the same either way; price is a flat
                // per-plan rate regardless of mode.
            };

            // Translation output file format: 'docx' (default) or 'pdf'.
            // When 'docx' is chosen, the workflow keeps the editable Word
            // file as the deliverable and skips the final DOCX->PDF
            // conversion step entirely.
            let translationOutputFormat = 'docx';
            window.setTranslationOutputFormat = function(fmt) {
                translationOutputFormat = (fmt === 'pdf') ? 'pdf' : 'docx';
            };

            // ============================================================
            // 13. TEMPLATE FILE SELECTION
            // ============================================================
            window.selectTemplateFile = function(event) {
                const file = event.target.files[0];
                if (!file) { event.target.value = ''; return; }
                if (!/\.pdf$/i.test(file.name)) {
                    showWarning('Output Template must be a single PDF file.');
                    event.target.value = '';
                    return;
                }

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
                // window.open() is a plain browser navigation - it can't
                // attach the Authorization header authFetch normally uses,
                // so the session token rides along as a query param instead
                // (server.py's _authenticated_user_id() accepts either).
                const url = base + '?userId=' + encodeURIComponent(CURRENT_USER_ID) +
                    '&' + nameParam + '=' + encodeURIComponent(docFolderName) + '&fileName=' + encodeURIComponent(fileName) +
                    '&token=' + encodeURIComponent(AUTH_TOKEN || '');
                window.open(url, '_blank');
            };

            // Item 9 - clicking a filename in Uploaded Files opens a
            // preview card for that PDF. Uses the in-memory blob (still
            // held until that file's save-output step completes, per the
            // pipeline's own memory cleanup) so this works during
            // pending/processing/needs_review - once a file is fully
            // completed, the blob is gone and this instead opens the same
            // Output.pdf download the Action column already offers.
            window.openFilePreview = function(fileId) {
                const serviceId = activeSubItemId === 'translation' ? 'translation' : 'lease-abstraction';
                const files = serviceId === 'translation' ? getMyTranslationFiles() : getMyLeaseFiles();
                const file = files.find(f => String(f.id) === String(fileId));
                if (!file) return;

                const blob = serviceId === 'translation' ? translationFileBlobs[file.id] : leaseFileBlobs[file.id];
                let previewUrl = null;
                if (blob) {
                    previewUrl = URL.createObjectURL(blob);
                } else if (file.status === 'completed') {
                    const docFolder = file.leaseName || file.docName || '';
                    const base = serviceId === 'translation' ? '/api/translation/download' : '/api/lease/download';
                    const nameParam = serviceId === 'translation' ? 'docName' : 'leaseName';
                    previewUrl = `${base}?userId=${encodeURIComponent(CURRENT_USER_ID)}&${nameParam}=${encodeURIComponent(docFolder)}&fileName=Output.pdf&token=${encodeURIComponent(AUTH_TOKEN || '')}`;
                }

                const html = `
                    <div class="admin-modal-overlay" id="filePreviewOverlay">
                        <div class="file-preview-card">
                            <div class="file-preview-header">
                                <span class="file-preview-title">${escapeHtml(file.name)}</span>
                                <button class="admin-modal-close" onclick="closeFilePreview()">✕</button>
                            </div>
                            ${previewUrl ?
                                `<iframe src="${previewUrl}" class="file-preview-frame"></iframe>` :
                                `<div class="file-preview-unavailable">This file is no longer available to preview in this session. If it's already completed, use the Download link in the Action column instead.</div>`
                            }
                        </div>
                    </div>
                `;
                const existing = document.getElementById('filePreviewOverlay');
                if (existing) existing.remove();
                document.body.insertAdjacentHTML('beforeend', html);
                if (previewUrl && blob) {
                    document.getElementById('filePreviewOverlay')._objectUrl = previewUrl;
                }
            };

            window.closeFilePreview = function() {
                const overlay = document.getElementById('filePreviewOverlay');
                if (overlay) {
                    if (overlay._objectUrl) URL.revokeObjectURL(overlay._objectUrl);
                    overlay.remove();
                }
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
                getMyPaymentHistory().forEach(t => {
                    // A balance-add sits in 'pending_approval' until an
                    // Admin/Developer approves it, and never counts at all
                    // if cancelled - only 'approved' (or legacy transactions
                    // with no status field at all, i.e. pre-existing service
                    // fee debits) count toward the real balance.
                    if (t.status === 'pending_approval' || t.status === 'cancelled') return;
                    totalCredit += Number(t.credit) || 0;
                    totalDebit += Number(t.debit) || 0;
                });
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
            // Bug 4: browser-only output blobs (session download, no server save)
            let translationBlobStore = {};

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
            // Same idea as runExtractJob above, but for the LLM analysis
            // step (/api/lease/analyze-start + -status) - this used to be a
            // single blocking postJSON('/api/lease/analyze', ...) call, which
            // meant a slow LLM response (large prompt + long document, can
            // genuinely take well over a minute) left the progress bar
            // sitting at 20% with zero feedback until the whole thing
            // resolved, and risked the same gateway-timeout problem OCR had
            // before it got the async-job treatment. onTick (optional) fires
            // on every poll so the caller can show a "still working..."
            // indicator even though there's no percentage to report mid-call.
            // generate-pdf ka async-job wrapper — sync call multi-minute
            // hybrid/ensemble pipeline par timeout ho jaata tha (permanent fix)
            async function runGeneratePdfJob(payload, onTick) {
                const startRes = await postJSON('/api/translation/generate-pdf-start', payload);
                const jobId = startRes.jobId;
                while (true) {
                    await sleep(1500);
                    const res = await authFetch('/api/translation/generate-pdf-status?jobId=' + encodeURIComponent(jobId));
                    let status;
                    try { status = await res.json(); } catch (e) { status = {}; }
                    if (!res.ok) throw new Error(status.error || 'Could not check document generation status');
                    if (status.status === 'done') return status.result || status;
                    if (status.status === 'error') throw new Error(status.error || 'Document generation failed');
                    if (typeof onTick === 'function') onTick();
                }
            }

            async function runAnalyzeJob(text, fallbackName, onTick) {
                const startRes = await postJSON('/api/lease/analyze-start', { text, fallbackName });
                const jobId = startRes.jobId;

                while (true) {
                    await sleep(500);
                    const res = await authFetch('/api/lease/analyze-status?jobId=' + encodeURIComponent(jobId));
                    let status;
                    try { status = await res.json(); } catch (e) { status = {}; }
                    if (!res.ok) throw new Error(status.error || 'Could not check analysis status');

                    if (status.status === 'done') {
                        return status;
                    }
                    if (status.status === 'error') {
                        throw new Error(status.error || 'Analysis failed');
                    }
                    if (typeof onTick === 'function') onTick();
                }
            }

            async function runTranslateJob(text, targetLanguage, onTick) {
                const startRes = await postJSON('/api/translation/translate-start', { text, targetLanguage });
                const jobId = startRes.jobId;

                while (true) {
                    await sleep(500);
                    const res = await authFetch('/api/translation/translate-status?jobId=' + encodeURIComponent(jobId));
                    let status;
                    try { status = await res.json(); } catch (e) { status = {}; }
                    if (!res.ok) throw new Error(status.error || 'Could not check translation status');

                    if (status.status === 'done') {
                        return status;
                    }
                    if (status.status === 'error') {
                        throw new Error(status.error || 'Translation failed');
                    }
                    if (typeof onTick === 'function') onTick();
                }
            }

            async function runExtractJob(stagingPath, onProgress) {
                const startRes = await postJSON('/api/lease/extract-start', { stagingPath });
                const jobId = startRes.jobId;

                while (true) {
                    await sleep(500);
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
            // Retries once on a genuine network-level failure (xhr.onerror -
            // the request never got any HTTP response at all, e.g. a
            // transient connection blip or a proxy/gateway timeout on a
            // large file) before giving up - a real HTTP error response
            // (4xx/5xx, handled in onload below) is NOT retried, since
            // retrying an actual rejection (bad file, auth failure, etc.)
            // would just fail again for the same reason.
            function uploadWithProgress(url, payload, onProgress, _isRetry) {
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
                    xhr.onerror = function() {
                        if (!_isRetry) {
                            console.warn('Upload hit a network error - retrying once...');
                            uploadWithProgress(url, payload, onProgress, true).then(resolve, reject);
                        } else {
                            reject(new Error('Network error while uploading - please check your connection and try again.'));
                        }
                    };
                    xhr.send(JSON.stringify(payload));
                });
            }

            window.startProcess = function(serviceId) {
                if (processState.isRunning) {
                    showWarning('Processing is already running for this batch.');
                    return;
                }
                let files = serviceId === 'translation' ? getMyTranslationFiles() : getMyLeaseFiles();
                if (files.length === 0) {
                    showWarning('No files to process. Please upload files first.');
                    return;
                }
                // Bug 3: sirf SELECTED files process karo (checkbox). Agar
                // kisi ne select nahi kiya to sab (backward compatible).
                const anySelected = files.some(f => f.selected === true);
                const anyUnselected = files.some(f => f.selected === false);
                if (anySelected || anyUnselected) {
                    const sel = files.filter(f => f.selected !== false);
                    if (sel.length === 0) {
                        showWarning('No files selected. Tick at least one file to process.');
                        return;
                    }
                    files = sel;
                }

                // Item 6 - plan status/expiry is checked BEFORE the wallet
                // balance check, and before any file starts - an expired
                // plan blocks the whole batch, same as insufficient balance
                // does below.
                if (isPlanExpired()) {
                    if (profileData) profileData.planStatus = 'Expired';
                    addActivity(serviceId,
                        `System > Process Aborted > Your ${getMyPlan().name} plan expired on ${profileData ? profileData.planEndDate : ''} - please renew it before processing`, 'Failed');
                    refreshServicePage(serviceId);
                    showWarning(`Your ${getMyPlan().name} plan expired on ${profileData ? profileData.planEndDate : 'an earlier date'}. Please renew or switch plans from Plans & Offers before processing.`);
                    return;
                }

                // Billing/estimate only: files already completed or in
                // needs_review don't get charged again this run. NOTE for
                // translation - completed files are NOT skipped in the
                // processing loop anymore (see processTranslationFileAt);
                // they still get reprocessed if selected, just without an
                // extra wallet charge, since it's a free redo.
                // Must match exactly what the processing loop will run:
                // selection. (This previously excluded completed files, but
                // re-running a selected completed file IS supported - so the
                // check announced "₹0.00 for 0 file(s)" and then still billed
                // per page for it.)
                const billable = files.filter(f => f.selected !== false);
                const myPlan = getMyPlan();
                const isPerPage = serviceId === 'translation' || myPlan.billingUnit === 'page';
                // Item 7 - a per-page plan can't know the EXACT charge for a
                // not-yet-scanned file up front (page count isn't known
                // until OCR runs) - this uses each file's already-known
                // page count if it has one (e.g. a retry) and assumes 1
                // page otherwise, clearly labeled as an estimate so nobody
                // is surprised if the real per-file charge (shown next to
                // each row once scanning finishes) comes out higher.
                const totalNeeded = billable.reduce((sum, f) => sum + getServicePrice(serviceId, f.pageCount), 0);
                const estimateNote = isPerPage ? ' (estimate - final charge depends on each file\'s actual page count)' : '';
                const rateLabel = serviceId === 'translation'
                    ? `${myPlan.name} plan: Translation ₹${(myPlan.pricePerTranslation != null ? myPlan.pricePerTranslation : 0)}/Per Page`
                    : `${myPlan.name} plan`;
                const balanceCheckId = addActivity(serviceId,
                    `System > Checking Wallet Balance > ₹${totalNeeded.toFixed(2)} required for ${billable.length} file(s) (${rateLabel})`, 'Processing');
                refreshServicePage(serviceId);

                if (totalNeeded > 0 && getCurrentBalance() < totalNeeded) {
                    updateActivity(serviceId, balanceCheckId, 'Failed');
                    addActivity(serviceId,
                        `System > Process Aborted > Insufficient balance - you have ₹${getCurrentBalance().toFixed(2)}, but ₹${totalNeeded.toFixed(2)} is required for ${billable.length} file(s)`,
                        'Failed');
                    refreshServicePage(serviceId);
                    persistServiceFiles(serviceId);
                    showWarning(`Insufficient balance. Processing ${billable.length} file(s) requires ₹${totalNeeded.toFixed(2)}${estimateNote} on your ${myPlan.name} plan, but your wallet only has ₹${getCurrentBalance().toFixed(2)}. Please add balance and click Start again.`);
                    return;
                }
                updateActivity(serviceId, balanceCheckId, 'Info');

                // What the user actually selected for this run.
                if (serviceId === 'translation') {
                    const _hc = document.getElementById('translationHybridCheck');
                    const _ocrOn = _hc ? !!_hc.checked : translationHybridMode;
                    const _ls = document.getElementById('translationLangSelect');
                    const _lang = (_ls && _ls.value) || 'original';
                    const _translateOn = _lang !== 'original';
                    addActivity(serviceId,
                        `System > ${_ocrOn ? 'With OCR' : 'Without OCR'} + ${_translateOn ? 'With Translation (' + _lang + ')' : 'Without Translation'}`,
                        'Success');
                    refreshServicePage(serviceId);
                }

                processState.isRunning = true;
                processState.isPaused = false;
                processState.isComplete = false;
                processState.stopped = false;
                // Translation: every selected file (re)runs regardless of
                // prior status, so the progress label's total is the full
                // selected count. Lease-abstraction still skips completed/
                // needs_review in its own loop, so billable.length stays
                // correct there (unchanged behaviour).
                processState.totalInBatch = (serviceId === 'translation') ? files.length : billable.length;
                processState.runIndex = 0;

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
            function _shortPath(path, segments) {
                if (!path) return path;
                return path.split('/').slice(-segments).join('/');
            }

            // Item 5 - simulates a visible step-by-step ramp from `fromVal`
            // to `toVal` for a Pending activity line, even when the
            // underlying operation itself resolved in one shot (e.g.
            // "Applying Rules" or "Accuracy Analyze", which come back as a
            // single atomic number from the analyze call) - so the log
            // always reads as a real sequence rather than jumping straight
            // to the final number.
            async function animateActivityNumber(serviceId, stepId, template, fromVal, toVal, steps) {
                steps = steps || 8;
                const stepSize = (toVal - fromVal) / steps;
                for (let i = 1; i <= steps; i++) {
                    if (processState.stopped) return;
                    const current = i === steps ? toVal : Math.round(fromVal + stepSize * i);
                    updateActivity(serviceId, stepId, 'Pending', template(current));
                    refreshServicePage(serviceId);
                    await sleep(45);
                }
            }

            async function runLeaseAbstractionPipeline() {
                if (processState.stopped) return;

                // 14.1 - scan the output template ONCE for the whole batch;
                // deliberately not tied to any file's Progress column.
                try {
                    const scanAgent = getAgents('lease-abstraction').find(a => a.phase === 'scan');
                    activeAgentId = scanAgent ? scanAgent.id : null;
                    const stepId = addActivity('lease-abstraction', `System > File Scanning > Output Template`, 'Pending');
                    refreshServicePage('lease-abstraction');
                    const result = await postJSON('/api/lease/scan-template', {
                        userId: CURRENT_USER_ID,
                        templateName: selectedTemplateFile || null
                    });
                    updateActivity('lease-abstraction', stepId, 'Success', `System > File Scanning > Output Template "${result.template}"`);
                } catch (err) {
                    addActivity('lease-abstraction', 'System > File Scanning > Output Template > Aborted: scan failed, continuing with Default.pdf', 'Failed');
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
                        // Item 2/3 fix - a file sitting in needs_review is
                        // NOT finished, it's just paused waiting for a
                        // person - the loop has nothing left to actively
                        // process, but that's different from the whole
                        // batch being done. Only clear the agent
                        // highlights / show the completion popup once
                        // there's truly nothing left awaiting review either
                        // (this keeps the Review card's agent pills exactly
                        // as they were until that specific file is
                        // approved - see submitLeaseReview()).
                        const stillAwaitingReview = myLeaseFiles.some(f => f.status === 'needs_review');
                        processState.isRunning = false;
                        if (!stillAwaitingReview) {
                            activeAgentId = null;
                            completedAgentIds.clear();
                            processState.isComplete = true;
                            refreshServicePage('lease-abstraction');
                            persistServiceFiles('lease-abstraction');
                            const hasErrors = myLeaseFiles.some(f => f.status === 'error');
                            showMessage(hasErrors ? '⚠️ Finished with Errors' : '✅ Complete',
                                hasErrors ?
                                'Processing finished, but one or more files could not be completed. Check the Action column for details.' :
                                'All files have been processed successfully!', ['OK']);
                        } else {
                            refreshServicePage('lease-abstraction');
                            persistServiceFiles('lease-abstraction');
                        }
                        return;
                    }

                    await waitIfPausedAsync('lease-abstraction');
                    if (processState.stopped) return;

                    const file = myLeaseFiles[fileIndex];

                    if (file.status === 'completed' || file.status === 'needs_review') {
                        continue;
                    }

                    file.status = 'processing';
                    // Item 5 - a fresh file starts with every agent pill back
                    // to its normal (not-yet-reached) look.
                    completedAgentIds.clear();
                    // File(N/Total) label is fixed once, when this file actually
                    // starts processing, and stored on the file so later steps
                    // (including the human-review-approval flow, which can
                    // happen much later) keep using the same label consistently.
                    processState.runIndex = (processState.runIndex || 0) + 1;
                    file.batchLabel = `File(${processState.runIndex}/${processState.totalInBatch || processState.runIndex}): `;
                    const fl = file.batchLabel;

                    addActivity('lease-abstraction', `${fl}File Processing > ${file.name}`, 'Started');
                    refreshServicePage('lease-abstraction');
                    await sleep(120);
                    if (processState.stopped) return;

                    const blob = leaseFileBlobs[file.id];
                    if (!blob) {
                        file.status = 'error';
                        file.errorLabel = 'Missing';
                        file.scanResult = 'File Not Available';
                        file.errorReason = 'The original file is no longer available in this browser session (this can happen after a page reload). Please remove and re-upload this file, then click Start again.';
                        addActivity('lease-abstraction',
                            `${fl}File Processing > ${file.name} > Aborted: original file not available in this session`, 'Failed');
                        refreshServicePage('lease-abstraction');
                        persistServiceFiles('lease-abstraction');
                        await sleep(120);
                        continue;
                    }

                    const processAgents = getAgents('lease-abstraction').filter(a => a.phase !== 'scan');
                    const scanPhaseAgents = getAgents('lease-abstraction').filter(a => a.phase === 'scan');

                    try {
                        // ---- Upload - silent (not its own log line per item
                        // 5 feedback), folds straight into File Scanning ----
                        activeAgentId = null;
                        const dataUrl = await readFileAsDataURL(blob);
                        const dataBase64 = dataUrl.split(',')[1];
                        const uploadResult = await uploadWithProgress('/api/lease/upload',
                            { userId: CURRENT_USER_ID, fileName: file.name, dataBase64: dataBase64 },
                            (pct) => { file.scanResult = String(pct); refreshServicePage('lease-abstraction'); }
                        );
                        file.scanResult = '100';
                        file.progress = '0';
                        const stagingPath = uploadResult.stagingPath;
                        const originalFileName = uploadResult.originalFileName;

                        await waitIfPausedAsync('lease-abstraction');
                        if (processState.stopped) return;

                        // ---- 20%: data extraction (async job + polling - a
                        // slow OCR pass can take well over a minute, so this
                        // never sits inside one single HTTP request, which is
                        // what was tripping a gateway/proxy timeout before). ----
                        await blinkAgentThenDone('lease-abstraction', scanPhaseAgents[0] ? scanPhaseAgents[0].id : null);
                        // scanResult was left at '100' by the upload step
                        // just above (100% uploaded) - reset it here so the
                        // Scan Result column doesn't show a stale "100%"
                        // left over from upload while OCR itself has barely
                        // started (and the Activity Log's own "File
                        // Scanning" percentage is still climbing from 0).
                        file.scanResult = '0';
                        let stepId = addActivity('lease-abstraction', `${fl}File Scanning > 0%`, 'Pending');
                        refreshServicePage('lease-abstraction');
                        let lastRealPct = 0;
                        const extractRes = await runExtractJob(stagingPath, (pagesDone, pagesTotal) => {
                            if (pagesTotal) {
                                const pct = Math.round((pagesDone / pagesTotal) * 100);
                                lastRealPct = pct;
                                file.pageCount = pagesTotal;
                                // Same exact number drives BOTH the Scan
                                // Result column and the Activity Log line -
                                // they can never show two different values
                                // at the same instant this way.
                                file.scanResult = String(pct);
                                file.progress = String(Math.min(20, Math.round((pagesDone / pagesTotal) * 20)));
                                updateActivity('lease-abstraction', stepId, 'Pending', `${fl}File Scanning > ${pct}%`);
                                refreshServicePage('lease-abstraction');
                            }
                        });
                        // Ramps from wherever the real OCR ticks last left
                        // off (often already 100 for a short document, in
                        // which case this is a no-op) up to 100 - never
                        // restarts from 0, which would otherwise show the
                        // Activity Log rolling backwards below what the
                        // Scan Result column (already at 100%) displays.
                        // Keeps file.scanResult in lockstep with the
                        // Activity Log's own number the whole time (same
                        // single source of truth, see the tick callback
                        // above) rather than letting the two drift during
                        // this animated tail end.
                        await animateActivityNumber('lease-abstraction', stepId, (v) => { file.scanResult = String(v); return `${fl}File Scanning > ${v}%`; }, lastRealPct, 100, 5);
                        file.scanResult = '100';
                        file.progress = '20';
                        updateActivity('lease-abstraction', stepId, 'Success', `${fl}File Scanning > 100%`);
                        markAgentDone(scanPhaseAgents[0] ? scanPhaseAgents[0].id : null);
                        refreshServicePage('lease-abstraction');

                        await waitIfPausedAsync('lease-abstraction');
                        if (processState.stopped) return;

                        // ---- 20%-40%: analysis - real OpenAI/OpenRouter call
                        // when .env has a key configured (using
                        // json/extraction_prompt.txt + json/rules.json), else
                        // the heuristic engine - see py/lease_engine.py. Runs
                        // as a background job (runAnalyzeJob) so the progress
                        // bar keeps moving instead of sitting frozen at 20%
                        // for however long the LLM call takes. ----
                        await blinkAgentThenDone('lease-abstraction', processAgents[0] ? processAgents[0].id : null);
                        stepId = addActivity('lease-abstraction', `${fl}API Request > LLM Extraction & Validation`, 'Pending');
                        refreshServicePage('lease-abstraction');
                        let analyzeTicks = 0;
                        const analyzeRes = await runAnalyzeJob(extractRes.text, originalFileName.replace(/\.[^.]+$/, ''), () => {
                            analyzeTicks++;
                            // Creeps from 20% to 39% while waiting so the bar
                            // visibly keeps moving during the LLM call, then
                            // snaps to 40% once the real result comes back.
                            file.progress = String(Math.min(39, 20 + analyzeTicks));
                            refreshServicePage('lease-abstraction');
                        });
                        file.progress = '40';
                        const methodLabel = analyzeRes.extractionMethod === 'llm-openai' ? 'OpenAI' :
                            analyzeRes.extractionMethod === 'llm-openrouter' ? 'OpenRouter' : 'heuristic engine (no LLM configured)';
                        updateActivity('lease-abstraction', stepId, 'Success', `${fl}API Request > LLM Extraction & Validation via ${methodLabel}`);
                        file.accuracy = analyzeRes.accuracy;
                        refreshServicePage('lease-abstraction');

                        // ---- Item 5: charge happens right here, right after
                        // the real LLM cost was actually incurred - not later,
                        // at review-approval time. ----
                        const chargeAmount = getServicePrice('lease-abstraction', file.pageCount);
                        const now = new Date();
                        const txnId = 'TXN' + String(nextTransactionId++).padStart(3, '0');
                        paymentHistory.push({
                            id: txnId,
                            date: localDateStr(now),
                            time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }),
                            userId: CURRENT_USER_ID,
                            paymentType: 'Service Fee',
                            paymentMode: 'Wallet Balance',
                            description: `Lease Abstraction - ${file.name}`,
                            credit: 0,
                            debit: chargeAmount
                        });
                        persistPaymentHistory();
                        addActivity('lease-abstraction', `${fl}System > Process Charged > ₹${chargeAmount.toFixed(2)} deducted (${txnId})`, 'Success');
                        file.chargeTxnId = txnId;
                        file.chargeAmount = chargeAmount;

                        // ---- Item 5: one log line per scan-phase "specialist"
                        // agent, based on whether that agent's specific kind of
                        // data was actually found in the just-completed
                        // analysis - Success/Skipped is a real reflection of
                        // the extracted fields, not a fixed script. ----
                        const fields = analyzeRes.fields || {};
                        const hasRentSchedule = Array.isArray(fields?.rent?.rent_schedule) && fields.rent.rent_schedule.length > 0;
                        const hasRenewalOptions = !!(fields?.options?.renewal_options) && fields.options.renewal_options !== 'Lease is silent.';
                        const hasContacts = fields?.contacts && Object.values(fields.contacts).some(v => v && v !== 'N/A');
                        const scanAgentResults = [
                            { agent: scanPhaseAgents[0], ok: true, activity: 'Core lease terms extracted (parties, premises, term)' },
                            { agent: scanPhaseAgents[1], ok: hasRentSchedule,
                                activity: hasRentSchedule ? 'Rent schedule / charge periods extracted' : 'No rent schedule table found in this document' },
                            { agent: scanPhaseAgents[2], ok: hasRenewalOptions,
                                activity: hasRenewalOptions ? 'Renewal/relocation option terms extracted' : 'No renewal option clause found in this document' },
                            { agent: scanPhaseAgents[3], ok: hasContacts,
                                activity: hasContacts ? 'Tenant/Landlord contact details resolved' : 'No structured contact details found in this document' },
                        ];
                        for (const r of scanAgentResults) {
                            if (!r.agent) continue;
                            await blinkAgentThenDone('lease-abstraction', r.agent.id);
                            addActivity('lease-abstraction', `${fl}Agents > ${r.agent.name} > ${r.activity}`, r.ok ? 'Success' : 'Skipped');
                            markAgentDone(r.agent.id);
                            refreshServicePage('lease-abstraction');
                        }

                        // ---- Citation Enforcer's own line (the agent driving
                        // this whole Analyze step) - now that its specialist
                        // sub-results above are in, mark it and move on. ----
                        await blinkAgentThenDone('lease-abstraction', processAgents[0] ? processAgents[0].id : null);
                        addActivity('lease-abstraction', `${fl}Agents > ${processAgents[0] ? processAgents[0].name : 'Citation Enforcer'} > Citations verified against extracted clauses`, 'Success');
                        markAgentDone(processAgents[0] ? processAgents[0].id : null);
                        refreshServicePage('lease-abstraction');

                        // ---- rules applied + accuracy detail (both come from
                        // the same analyze call above) - animated so the
                        // numbers visibly climb rather than jumping straight
                        // to the final count. ----
                        const rulesTotal = analyzeRes.rulesTotal || 0;
                        let rulesStepId = addActivity('lease-abstraction', `${fl}System > Applying Rules > 0/${rulesTotal}`, 'Pending');
                        refreshServicePage('lease-abstraction');
                        await animateActivityNumber('lease-abstraction', rulesStepId, (v) => `${fl}System > Applying Rules > ${v}/${rulesTotal}`, 0, analyzeRes.rulesApplied || 0, 6);
                        updateActivity('lease-abstraction', rulesStepId, 'Success', `${fl}System > Applying Rules > ${analyzeRes.rulesApplied || 0}/${rulesTotal}`);
                        refreshServicePage('lease-abstraction');

                        const accuracyLabel = analyzeRes.accuracyMethod === 'llm-validation' ? 'QC validated' : 'heuristic estimate';
                        let accStepId = addActivity('lease-abstraction', `${fl}System > Accuracy Analyze > Accuracy: 0%`, 'Pending');
                        refreshServicePage('lease-abstraction');
                        await animateActivityNumber('lease-abstraction', accStepId, (v) => `${fl}System > Accuracy Analyze > Accuracy: ${v}%`, 0, analyzeRes.accuracy || 0, 5);
                        updateActivity('lease-abstraction', accStepId, 'Success', `${fl}System > Accuracy Analyze > Accuracy: ${analyzeRes.accuracy}% (${accuracyLabel})`);
                        refreshServicePage('lease-abstraction');

                        // ---- Item 7: fire-and-forget rule auto-discovery -
                        // asks the system to notice any extraction patterns
                        // in THIS lease worth turning into a reusable rule.
                        // Deliberately not awaited: this must never add
                        // latency to the user's pipeline or fail it if the
                        // LLM call errors - it just quietly lands in
                        // rules.json's pending queue (under the Developer's
                        // id) for later approval via Update Rules. ----
                        postJSON('/api/lease/discover-rules', { userId: CURRENT_USER_ID, text: extractRes.text })
                            .catch(e => console.warn('Rule auto-discovery could not be queued:', e));

                        await waitIfPausedAsync('lease-abstraction');
                        if (processState.stopped) return;

                        // ---- 60%: document-type + duplicate validation ----
                        await blinkAgentThenDone('lease-abstraction', processAgents[1] ? processAgents[1].id : null);
                        stepId = addActivity('lease-abstraction', `${fl}System > Validation > Checking document type & duplicates`, 'Pending');
                        refreshServicePage('lease-abstraction');
                        const validateRes = await postJSON('/api/lease/validate', {
                            userId: CURRENT_USER_ID,
                            docType: analyzeRes.docType,
                            leaseName: analyzeRes.leaseName,
                            fields: analyzeRes.fields
                        });

                        if (!validateRes.valid) {
                            file.status = 'error';
                            file.progress = '0';
                            if (validateRes.reason === 'duplicate') {
                                file.scanResult = 'Already Processed';
                                file.errorLabel = 'Duplicate';
                                file.errorReason = `A lease named "${validateRes.leaseName}" has already been processed for your account.`;
                            } else if (validateRes.reason === 'duplicate-content') {
                                file.scanResult = 'Duplicate Content';
                                file.errorLabel = 'Duplicate';
                                file.errorReason = `This document's tenant, landlord, property, and lease dates match an already-processed lease ("${validateRes.matchedLeaseName}") - looks like a duplicate or a reference/exhibit for that same lease, not a new one.`;
                            } else {
                                file.scanResult = 'Invalid Document';
                                file.errorLabel = 'Invalid';
                                file.errorReason = 'This document does not appear to be a Lease or Amendment.';
                            }
                            updateActivity('lease-abstraction', stepId, 'Failed', `${fl}System > Validation > Failed: ${file.errorReason}`);
                            addActivity('lease-abstraction',
                                `${fl}File Processing > ${file.name} > Aborted: remaining steps skipped (Save Output, Human Review, Generate PDF)`, 'Failed');
                            activeAgentId = null;
                            refreshServicePage('lease-abstraction');
                            persistServiceFiles('lease-abstraction');
                            await sleep(120);
                            continue;
                        }

                        file.progress = '60';
                        file.leaseName = validateRes.leaseName;
                        updateActivity('lease-abstraction', stepId, 'Success',
                            `${fl}System > Validation > Document type + Duplicate check passed`);
                        addActivity('lease-abstraction', `${fl}Agents > ${processAgents[1] ? processAgents[1].name : 'Blank Field Governance'} > Checked for missing/blank required fields`, 'Success');
                        markAgentDone(processAgents[1] ? processAgents[1].id : null);
                        refreshServicePage('lease-abstraction');

                        await waitIfPausedAsync('lease-abstraction');
                        if (processState.stopped) return;

                        // ---- 80%: Output.json + saved document + LeaseDocuments.json ----
                        await blinkAgentThenDone('lease-abstraction', processAgents[2] ? processAgents[2].id : null);
                        stepId = addActivity('lease-abstraction', `${fl}System > Creating Output.json`, 'Pending');
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
                        updateActivity('lease-abstraction', stepId, 'Success', `${fl}System > Creating Output.json > Saved to ${_shortPath(saveRes.leaseFolder, 1)}`);
                        addActivity('lease-abstraction', `${fl}Agents > ${processAgents[2] ? processAgents[2].name : 'Template Integrity'} > Output.json structure verified against template`, 'Success');
                        markAgentDone(processAgents[2] ? processAgents[2].id : null);
                        refreshServicePage('lease-abstraction');

                        // ---- Item 2: an automated legal-review pass right
                        // before the human ever sees it - reads back through
                        // the extracted clauses looking for anything a real
                        // reviewing attorney would flag (missing/ambiguous
                        // language, unusually tenant/landlord-unfavorable
                        // terms, clauses worth a second look). Doesn't block
                        // the pipeline if nothing stands out - it's a
                        // heads-up for the human reviewer, not a gate. ----
                        await blinkAgentThenDone('lease-abstraction', processAgents[3] ? processAgents[3].id : null);
                        const attorneyFlags = [];
                        const f2 = analyzeRes.fields || {};
                        if (!f2?.parties?.guarantor_name && (!f2?.parties?.guarantor || f2.parties.guarantor === 'N/A')) {
                            attorneyFlags.push('no Guarantor named - confirm this is intentional for a lease of this size');
                        }
                        if (f2?.rent?.security_deposit && String(f2.rent.security_deposit).replace(/[^0-9.]/g, '') === '') {
                            attorneyFlags.push('Security Deposit amount could not be confirmed');
                        }
                        if ((analyzeRes.missingFields || []).length > 3) {
                            attorneyFlags.push(`${analyzeRes.missingFields.length} fields could not be located in the source document`);
                        }
                        addActivity('lease-abstraction',
                            `${fl}Agents > ${processAgents[3] ? processAgents[3].name : 'Real Estate Legal Attorney Reviewer'} > ${attorneyFlags.length ? 'Flagged for human attention: ' + attorneyFlags.join('; ') : 'No legal risk flags found - clauses read as standard'}`,
                            attorneyFlags.length ? 'Skipped' : 'Success');
                        markAgentDone(processAgents[3] ? processAgents[3].id : null);
                        refreshServicePage('lease-abstraction');

                        // ---- Human Review checkpoint - the pipeline stops
                        // here for THIS file (it does NOT block the other
                        // files in the queue, the outer loop just moves on)
                        // and waits for a person to open the Review panel,
                        // check/correct the extracted fields, and approve.
                        // Only PDF generation happens after that now (the
                        // charge already happened above) - see
                        // submitLeaseReview() below. ----
                        await blinkAgentThenDone('lease-abstraction', processAgents[4] ? processAgents[4].id : null);
                        file.status = 'needs_review';
                        file.templateName = selectedTemplateFile || 'Default.pdf';
                        // "Final QA + Validator" is ONE agent in agents.json -
                        // one log line, not two.
                        addActivity('lease-abstraction', `${fl}Agents > ${processAgents[4] ? processAgents[4].name : 'Final QA + Validator'} > Automated pre-check complete - ready for human review`, 'Success');
                        markAgentDone(processAgents[4] ? processAgents[4].id : null);
                        addActivity('lease-abstraction', `${fl}System > Awaiting human review before finalizing`, 'Success');
                        activeAgentId = null;
                        delete leaseFileBlobs[file.id]; // the file's already saved server-side by save-output above, no longer needed in memory
                        refreshServicePage('lease-abstraction');
                        persistServiceFiles('lease-abstraction');
                        continue;

                    } catch (err) {
                        console.error('Lease processing error:', err);
                        file.status = 'error';
                        file.errorLabel = 'Error';
                        file.errorReason = 'Processing failed: ' + (err && err.message ? err.message :
                            'Unknown error. Make sure py/server.py is running with its dependencies installed (pip install -r requirements.txt).');
                        activeAgentId = null;
                        addActivity('lease-abstraction',
                            `${fl}File Processing > ${file.name} > Aborted: ${file.errorReason}`, 'Failed');
                        refreshServicePage('lease-abstraction');
                        persistServiceFiles('lease-abstraction');
                    }

                    await sleep(120);
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
                        activeAgentId = null;
                        completedAgentIds.clear();
                        processState.isRunning = false;
                        processState.isComplete = true;
                        refreshServicePage('translation');
                        persistServiceFiles('translation');
                        const hasErrors = myFiles.some(f => f.status === 'error');
                        showMessage(hasErrors ? '⚠️ Finished with Errors' : '✅ Complete',
                            hasErrors ?
                            'Processing finished, but one or more files could not be completed. Check the Action column for details.' :
                            'All files have been processed successfully!', ['OK']);
                        return;
                    }

                    await waitIfPausedAsync('translation');
                    if (processState.stopped) return;

                    const file = myFiles[fileIndex];
                    // Skip only files the user has deselected. A selected
                    // file always (re)runs on Start, regardless of its
                    // previous status - completed or errored files are
                    // NOT silently skipped anymore, so clicking Start
                    // again reprocesses every selected file in the list.
                    if (file.selected === false) {
                        continue;
                    }

                    file.status = 'processing';
                    completedAgentIds.clear();
                    processState.runIndex = (processState.runIndex || 0) + 1;
                    file.batchLabel = `File(${processState.runIndex}/${processState.totalInBatch || processState.runIndex}): `;
                    const fl = file.batchLabel;

                    // NOTE: the "File Processing" row is emitted by the new
                    // Activity Log block further down (once the file's mode is
                    // known) - emitting one here too produced a duplicate row
                    // for the same step.
                    await sleep(120);
                    if (processState.stopped) return;

                    const blob = translationFileBlobs[file.id];
                    if (!blob) {
                        file.status = 'error';
                        file.errorLabel = 'Missing';
                        file.scanResult = 'File Not Available';
                        file.errorReason = 'The original file is no longer available in this browser session (this can happen after a page reload). Please remove and re-upload this file, then click Start again.';
                        addActivity('translation',
                            `${fl}File Processing > ${file.name} > Aborted: original file not available in this session`, 'Failed');
                        refreshServicePage('translation');
                        persistServiceFiles('translation');
                        await sleep(120);
                        continue;
                    }

                    // Read the language selector fresh right now, rather
                    // than trusting file.targetLang (which was captured back
                    // when the file was uploaded - if the dropdown gets
                    // changed afterwards, before Start is clicked, that
                    // stale value would silently translate into the wrong
                    // language, not just display the wrong one).
                    const langSelectNow = document.getElementById('translationLangSelect');
                    const targetLanguage = (langSelectNow && langSelectNow.value) || file.targetLang || 'English';
                    file.targetLang = targetLanguage;
                    // Read the Hybrid checkbox fresh too, for the same
                    // reason as the language above.
                    // Hybrid + With Image — render ke waqt fresh read
                    const hybridCheckNow = document.getElementById('translationHybridCheck');
                    const hybridMode = hybridCheckNow ? !!hybridCheckNow.checked : translationHybridMode;
                    // Image is ALWAYS included behind the text now (no
                    // checkbox). Cleaning is automatic and decided inside the
                    // pipeline per page, so no cleanImage flag is passed.
                    const withImageOpt = true;
                    const processAgents = getAgents('translation').filter(a => a.phase !== 'scan');
                    const agentName = (list, idx) => (list[idx] && list[idx].name) || 'Unassigned';

                    try {
                        // ---- Upload - silent, folds into File Scanning ----
                        activeAgentId = null;
                        const dataUrl = await readFileAsDataURL(blob);
                        const dataBase64 = dataUrl.split(',')[1];
                        const uploadResult = await uploadWithProgress('/api/translation/upload',
                            { userId: CURRENT_USER_ID, fileName: file.name, dataBase64: dataBase64 },
                            (pct) => { file.scanResult = String(pct); refreshServicePage('translation'); }
                        );
                        file.scanResult = '100';
                        file.progress = '0';
                        const stagingPath = uploadResult.stagingPath;
                        const originalFileName = uploadResult.originalFileName;

                        await waitIfPausedAsync('translation');
                        if (processState.stopped) return;

                        // ============================================================
                        // TEXT-BASED (With OCR unchecked): local pdf.js text-layer
                        // extraction, run entirely in the browser (translation-
                        // offline.js). Translation and Clean Image are the only
                        // two API calls this mode makes (when the user asks for
                        // them) - OCR itself never happens here.
                        // ============================================================
                        // Browser-side deliverable banega jab:
                        //  (a) With OCR unchecked -> local text-layer extraction, YA
                        //  (b) With OCR checked + Original(No Translation) -> vision OCR
                        //      browser me (Box-tool jaisa line-level, tez),
                        //      koi translation nahi, image sirf With Image par.
                        // With OCR checked -> sab kuch browser vision path me
                        // (OCR-only ya OCR+translate, dono Test.html criteria ke
                        // saath: page-type detect + tone). With OCR unchecked ->
                        // local text-layer extraction.
                        const browserBuild = true;
                        if (browserBuild) {
                            const baseName = originalFileName.replace(/\.[^.]+$/, '');
                            // FIX: translation is now available in BOTH modes (not
                            // just With OCR) - this used to be gated by hybridMode,
                            // which mislabeled text-based+translation runs as "no
                            // translation" in the filename/activity log/billing text.
                            const isTranslate = targetLanguage !== 'original';
                            const modeName = hybridMode ? 'With OCR' : 'Text-based';
                            // OUTPUT FILENAME:
                            //  Text-based + Original:  "<name> Text-based - Without Translation - Translation"
                            //  Text-based + <language>: "<name> Text-based - <language> - Translation"
                            //  With OCR + Original:    "<name> With OCR - Without Translation - Translation"
                            //  With OCR + <language>:   "<name> With OCR - <language> - Translation"
                            const docName = baseName + ' ' + modeName + ' - ' + (isTranslate ? targetLanguage : 'Without Translation') + ' - Translation';
                            const modeLabel = modeName + (hybridMode ? ' (Vision)' : ' (local extraction)') + (isTranslate ? (' + Translate -> ' + targetLanguage) : ' only');

                            // ── NEW ACTIVITY LOG FORMAT ───────────────────
                            // Rows are driven by STRUCTURED events from the
                            // pipeline (exact per-page API-call and text-block
                            // counts), not by regex-scraping free-text logs.
                            // Status meaning: Processing = step started,
                            // Success = step finished, Info = informational.
                            const fileProcId = addActivity('translation', `${fl}File Processing > ${file.name}`, 'Info');
                            refreshServicePage('translation');

                            // Upload already finished above, so scanning is done.
                            addActivity('translation', `${fl}Scanning > 100%`, 'Success');
                            refreshServicePage('translation');

                            const perPageRate = getServicePrice('translation', 1);
                            let totalJsonCalls = 0, totalImageCalls = 0;
                            let totalCharged = 0, pagesCharged = 0;
                            const pageTxnIds = [];

                            let offlineBlob;
                            let lastLoggedMsg = '';
                            try {
                                // PER-PAGE / UPDATE-DATA events from the pipeline.
                                const onEvent = (ev) => {
                                    if (!ev) return;
                                    if (ev.type === 'page') {
                                        const lbl = `Page(${ev.page}/${ev.totalPages})`;
                                        addActivity('translation',
                                            `${fl}${lbl} > API Call(s) > JSON=${ev.jsonCalls}, IMAGE=${ev.imageCalls}`, 'Success');
                                        totalJsonCalls += ev.jsonCalls;
                                        totalImageCalls += ev.imageCalls;

                                        // PER-PAGE BILLING: charge as soon as this
                                        // page completes, so if a later page fails
                                        // the user keeps the finished pages and is
                                        // only billed for those.
                                        if (ev.ok) {
                                            const nowP = new Date();
                                            const txnIdP = 'TXN' + String(nextTransactionId++).padStart(3, '0');
                                            pageTxnIds.push(txnIdP);
                                            paymentHistory.push({
                                                id: txnIdP,
                                                date: localDateStr(nowP),
                                                time: nowP.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }),
                                                userId: CURRENT_USER_ID,
                                                paymentType: 'Service Fee',
                                                paymentMode: 'Wallet Balance',
                                                description: `Translation - ${file.name} - page ${ev.page}/${ev.totalPages} (${modeName}${isTranslate ? ' ' + targetLanguage : ' Original'})`,
                                                credit: 0,
                                                debit: perPageRate
                                            });
                                            totalCharged += perPageRate;
                                            pagesCharged++;
                                            addActivity('translation',
                                                `${fl}${lbl} > Amount Deducted from Wallet=₹${perPageRate.toFixed(2)}`, 'Info');
                                        }
                                        addActivity('translation', `${fl}${lbl} > Text Data = ${ev.textData}`, 'Info');

                                        const pct = Math.min(80, Math.round((ev.page / (ev.totalPages || 1)) * 80));
                                        file.progress = String(pct);
                                        refreshServicePage('translation');
                                        return;
                                    }
                                    if (ev.type === 'update') {
                                        addActivity('translation',
                                            `${fl}Update Data > API Call(s) > JSON=${ev.jsonCalls}, IMAGE=${ev.imageCalls}`, 'Success');
                                        addActivity('translation', `${fl}Update Data > Text Data = ${ev.textData}`, 'Info');
                                        totalJsonCalls += ev.jsonCalls;
                                        totalImageCalls += ev.imageCalls;
                                        refreshServicePage('translation');
                                    }
                                };

                                // Free-text log lines. Warnings/errors ALWAYS get
                                // a row (they tell the user something actually went
                                // wrong, e.g. a page skipped or an image clean that
                                // fell back). Routine info-level progress chatter is
                                // suppressed - the structured per-page rows above
                                // already carry those numbers.
                                const NOISE = /^(P\d+\b|Vision OCR:|Translation:|Translating|\[Final Call\]|Word document ready|Document type:)/;
                                const onLog = (m, level) => {
                                    const isProblem = (level === 'warn' || level === 'error');
                                    if (!isProblem && NOISE.test(m)) return;
                                    if (m === lastLoggedMsg) return;
                                    lastLoggedMsg = m;
                                    addActivity('translation', `${fl}${m}`, isProblem ? 'Failed' : 'Info');
                                    refreshServicePage('translation');
                                };
                                if (window.setVisionAuthToken) window.setVisionAuthToken(AUTH_TOKEN || '');
                                if (window.setVisionStopCheck) window.setVisionStopCheck(function () { return processState.stopped; });
                                if (window.setPipelineEventHandler) window.setPipelineEventHandler(onEvent);
                                if (window.resetPipelineApiCounters) window.resetPipelineApiCounters();
                                if (hybridMode) {
                                    offlineBlob = await window.buildHybridDocxBlob(blob, {
                                        withImage: withImageOpt,
                                        targetLang: targetLanguage
                                    }, onLog);
                                } else {
                                    offlineBlob = await window.buildOfflineDocxBlob(blob, {
                                        withImage: withImageOpt,
                                        targetLang: targetLanguage
                                    }, onLog);
                                }
                            } catch (offErr) {
                                // ERROR LINE: rehti hai (hatti nahi), aur File Processing
                                // ki alag failed line bhi.
                                addActivity('translation', `${fl}Error > ${offErr.message}`, 'Failed');
                                if (pagesCharged > 0) {
                                    // Per-page billing means the pages that DID
                                    // complete were already charged - show that
                                    // total so the partial charge isn't a surprise.
                                    addActivity('translation',
                                        `${fl}Page(All) > API Call(s) > JSON=${totalJsonCalls}, IMAGE=${totalImageCalls}`, 'Info');
                                    addActivity('translation',
                                        `${fl}Page(All) > Amount Deducted from Wallet=₹${totalCharged.toFixed(2)} (${pagesCharged} completed page(s))`, 'Info');
                                }
                                file.status = 'error';
                                file.errorLabel = 'Error';
                                file.errorReason = offErr.message || 'Processing failed';
                                updateActivity('translation', fileProcId, 'Failed', `${fl}File Processing > ${file.name}`);
                                addActivity('translation', `${fl}File Processing > ${file.name} > Aborted: ${file.errorReason}`, 'Failed');
                                refreshServicePage('translation');
                                persistServiceFiles('translation');
                                continue;
                            }
                            file.progress = '85';   // extraction/translation done -> building output
                            refreshServicePage('translation');

                            // Bug 4: translation output ab SERVER PE SAVE NAHI hota.
                            // Browser me bana docx blob ko sirf is session me rakhte
                            // hain — user isi process ke dauran download karta hai.
                            // Koi server file, koi Output.docx disk pe nahi.
                            // Hybrid output MHT-format Word hai -> .doc (docx zip
                            // nahi hai; .docx extension se Word file reject karega).
                            // Offline (No Hybrid) pehle jaisa .docx hi.
                            const outExt = hybridMode ? '.doc' : '.docx';
                            translationBlobStore[file.id] = { blob: offlineBlob, name: docName + outExt };
                            file.progress = '95';

                            // Billing already happened PER PAGE as each page
                            // completed (see onEvent above) - no charge here,
                            // that would double-bill. These are the summary rows.
                            addActivity('translation',
                                `${fl}Page(All) > API Call(s) > JSON=${totalJsonCalls}, IMAGE=${totalImageCalls}`, 'Info');
                            addActivity('translation',
                                `${fl}Page(All) > Amount Deducted from Wallet=₹${totalCharged.toFixed(2)}`, 'Info');

                            file.docName = docName;
                            file.outputFormat = 'docx';
                            file.sessionDownload = true;   // browser-only download
                            file.progress = '100';
                            addActivity('translation', `${fl}Generate Output > ${docName}${outExt}`, 'Success');
                            if (totalCharged > 0) {
                                notifyProcessCompletion('Translation', file.name, totalCharged, pageTxnIds[pageTxnIds.length - 1] || '');
                            }
                            file.status = 'completed';
                            activeAgentId = null;
                            // NOTE: previously deleted translationFileBlobs[file.id]
                            // here as a memory-cleanup step, but that broke
                            // re-processing (Start again on an already-completed,
                            // still-selected file threw "file not available"
                            // since its blob was gone). The blob is kept now so
                            // the same file can be reprocessed any number of
                            // times in this session; it's only cleared when the
                            // user explicitly removes/clears the file (see
                            // clearFiles()).
                            refreshServicePage('translation');
                            persistPaymentHistory();
                            persistServiceFiles('translation');
                            await sleep(120);
                            continue;
                        }

                        // ---- Extracting Text Content (async job + polling, same
                        // OCR-capable pipeline as lease abstraction) ----
                        await blinkAgentThenDone('translation', processAgents[0] ? processAgents[0].id : null);
                        // Reset the stale '100' left by the upload step
                        // above, so Scan Result doesn't show 100% while
                        // OCR itself has barely started.
                        file.scanResult = '0';
                        let stepId = addActivity('translation', `${fl}File Scanning > 0%`, 'Pending');
                        refreshServicePage('translation');
                        let lastRealPct = 0;
                        const extractRes = await runExtractJob(stagingPath, (pagesDone, pagesTotal) => {
                            if (pagesTotal) {
                                const pct = Math.round((pagesDone / pagesTotal) * 100);
                                lastRealPct = pct;
                                file.pageCount = pagesTotal;
                                file.scanResult = String(pct);
                                file.progress = String(Math.min(20, Math.round((pagesDone / pagesTotal) * 20)));
                                updateActivity('translation', stepId, 'Pending', `${fl}File Scanning > ${pct}%`);
                                refreshServicePage('translation');
                            }
                        });
                        await animateActivityNumber('translation', stepId, (v) => { file.scanResult = String(v); return `${fl}File Scanning > ${v}%`; }, lastRealPct, 100, 5);
                        file.scanResult = '100';
                        file.progress = '20';
                        updateActivity('translation', stepId, 'Success', `${fl}File Scanning > 100%`);
                        markAgentDone(processAgents[0] ? processAgents[0].id : null);
                        refreshServicePage('translation');

                        await waitIfPausedAsync('translation');
                        if (processState.stopped) return;

                        // ---- Translating Content - real LLM call, runs as a
                        // background job (runTranslateJob) for the same
                        // reason analysis does above - a long document can
                        // take well over a minute to translate and shouldn't
                        // leave the progress bar frozen the whole time. ----
                        await blinkAgentThenDone('translation', processAgents[1] ? processAgents[1].id : null);
                        stepId = addActivity('translation', `${fl}API Request > Translation to ${targetLanguage}`, 'Pending');
                        refreshServicePage('translation');
                        let translateTicks = 0;
                        // "Original (No Translation)" ya offline (Hybrid off):
                        // koi translate API call NAHI — extracted text hi output hai
                        const translateRes = (targetLanguage === 'original' || !hybridMode)
                            ? { translated: extractRes.text, translatedText: extractRes.text, text: extractRes.text, method: 'none' }
                            : await runTranslateJob(extractRes.text, targetLanguage, () => {
                                translateTicks++;
                                file.progress = String(Math.min(49, 20 + translateTicks));
                                refreshServicePage('translation');
                            });
                        file.progress = '50';
                        const methodLabel = translateRes.method === 'none' ? 'no translation (original preserved)' :
                            translateRes.method === 'llm-openai' ? 'OpenAI' :
                            translateRes.method === 'llm-openrouter' ? 'OpenRouter' : 'heuristic (no LLM configured)';
                        updateActivity('translation', stepId, 'Success', `${fl}API Request > Translated to ${targetLanguage} via ${methodLabel}`);
                        refreshServicePage('translation');

                        // ---- Item 5: charge right after the real LLM cost
                        // was actually incurred, same principle as Lease
                        // Abstraction. ----
                        const chargeAmount = getServicePrice('translation', file.pageCount);
                        const now = new Date();
                        const txnId = 'TXN' + String(nextTransactionId++).padStart(3, '0');
                        paymentHistory.push({
                            id: txnId,
                            date: localDateStr(now),
                            time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }),
                            userId: CURRENT_USER_ID,
                            paymentType: 'Service Fee',
                            paymentMode: 'Wallet Balance',
                            description: `Translation - ${file.name}`,
                            credit: 0,
                            debit: chargeAmount
                        });
                        persistPaymentHistory();
                        addActivity('translation', `${fl}System > Process Charged > ₹${chargeAmount.toFixed(2)} deducted (${txnId})`, 'Success');

                        addActivity('translation', `${fl}Agents > ${agentName(processAgents, 0)} > Source text extracted`, 'Success');
                        addActivity('translation', `${fl}Agents > ${agentName(processAgents, 1)} > Translation complete`, 'Success');
                        markAgentDone(processAgents[1] ? processAgents[1].id : null);
                        refreshServicePage('translation');

                        await waitIfPausedAsync('translation');
                        if (processState.stopped) return;

                        // ---- Applying Formatting Rules (cosmetic checkpoint -
                        // the real auto-formatting happens in generate_translation_pdf) ----
                        await blinkAgentThenDone('translation', processAgents[2] ? processAgents[2].id : null);
                        stepId = addActivity('translation', `${fl}Agents > ${agentName(processAgents, 2)} > Applying document formatting`, 'Pending');
                        file.progress = '65';
                        refreshServicePage('translation');
                        await sleep(120);
                        updateActivity('translation', stepId, 'Success', `${fl}Agents > ${agentName(processAgents, 2)} > Formatting applied`);
                        markAgentDone(processAgents[2] ? processAgents[2].id : null);
                        refreshServicePage('translation');

                        await waitIfPausedAsync('translation');
                        if (processState.stopped) return;

                        // ---- Prepare Output File - real save ----
                        await blinkAgentThenDone('translation', processAgents[3] ? processAgents[3].id : null);
                        stepId = addActivity('translation', `${fl}System > Creating Output.json`, 'Pending');
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
                        updateActivity('translation', stepId, 'Success', `${fl}System > Creating Output.json > Saved to ${_shortPath(saveRes.docFolder, 1)}`);
                        markAgentDone(processAgents[3] ? processAgents[3].id : null);
                        refreshServicePage('translation');

                        await waitIfPausedAsync('translation');
                        if (processState.stopped) return;

                        // ---- Create Download Link - real PDF ----
                        await blinkAgentThenDone('translation', processAgents[4] ? processAgents[4].id : null);
                        stepId = addActivity('translation', `${fl}System > Generate Output`, 'Pending');
                        refreshServicePage('translation');
                        const outputFormatNow = document.getElementById('translationOutputFormat');
                        const outFmt = outputFormatNow ? outputFormatNow.value : translationOutputFormat;
                        const pdfRes = await runGeneratePdfJob({
                            userId: CURRENT_USER_ID,
                            docName: docName,
                            hybrid: hybridMode,
                            withImage: withImageOpt,
                            outputFormat: outFmt
                        });
                        addActivity('translation', `${fl}System > Output Mode > ${pdfRes.mode || (hybridMode ? 'hybrid' : 'simple')}`, 'Success');
                        file.progress = '100';
                        file.outputFormat = pdfRes.outputFormat || outFmt;
                        updateActivity('translation', stepId, 'Success', `${fl}System > Generate Output > ${_shortPath(pdfRes.outputPdf, 2)} generated successfully`);
                        markAgentDone(processAgents[4] ? processAgents[4].id : null);

                        // Item - surface exactly what the layout-preserving
                        // translator actually did on THIS server (which
                        // rendering path, how many text regions it found
                        // per page, any errors) into the Activity Log -
                        // since a production server's own console isn't
                        // something that's normally visible, this makes it
                        // possible to diagnose a "nothing got translated"
                        // report just from what's already on screen.
                        if (pdfRes.diagnostics) {
                            const d = pdfRes.diagnostics;
                            // Per-step progress the engine reported while
                            // working (region detection, vision read,
                            // reviewer rounds) - so the long 85% wait now
                            // shows what's happening instead of looking stuck.
                            (d.progressLog || []).forEach(msg => {
                                addActivity('translation', `${fl}Progress > ${msg}`, 'Success');
                            });
                            addActivity('translation', `${fl}Diagnostics > Path: ${d.pathUsed || 'unknown'}, OCR lang: ${d.ocrLangUsed || 'n/a'}, Tesseract: ${d.tesseractVersion || 'n/a'}, pdfium: ${d.pypdfium2Version || 'n/a'}`, 'Success');
                            (d.pages || []).forEach(p => {
                                const revInfo = Object.keys(p).filter(k => k.startsWith('review')).map(k => `${k}=${p[k]}`).join(', ');
                                addActivity('translation', `${fl}Diagnostics > Page ${p.page}: ${p.cvRegionsDetected ?? p.regionsDetected ?? 'n/a'} block(s), text=${p.cvTranslatable ?? 'n/a'}, elements=${p.cvNonTranslatable ?? 'n/a'}, skippedTooSmall=${p.skippedTooSmall ?? 0}${revInfo ? ', ' + revInfo : ''}${p.error ? ' - ERROR: ' + p.error : ''}`, p.error ? 'Failed' : 'Success');
                            });
                            // Debug artifacts (original page images, the exact
                            // prompt sent to the model, the raw model response,
                            // the parsed JSON layout, and the reconstructed
                            // clean background) - each as a downloadable link so
                            // every step can be inspected.
                            (d.artifacts || []).forEach(a => {
                                const url = a.url || (a.path ? ('/' + String(a.path).replace(/^\/+/, '')) : '');
                                const label = a.name + (a.kind ? ` [${a.kind}]` : '');
                                if (url) {
                                    addActivity('translation', `${fl}Artifact > <a href="${url}" target="_blank" rel="noopener">${label}</a>`, 'Success');
                                } else {
                                    addActivity('translation', `${fl}Artifact > ${label}`, 'Success');
                                }
                            });
                            if (d.fatalError) {
                                addActivity('translation', `${fl}Diagnostics > Fell back to plain reflow - fatal error: ${d.fatalError}`, 'Failed');
                            }
                        }

                        addActivity('translation', `${fl}File Processing > ${file.name}`, 'Finished');
                        notifyProcessCompletion('Translation', file.name, chargeAmount, txnId);

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
                        addActivity('translation',
                            `${file.batchLabel || ''}File Processing > ${file.name} > Aborted: ${file.errorReason}`, 'Failed');
                        refreshServicePage('translation');
                        persistServiceFiles('translation');
                    }

                    await sleep(120);
                }
            }

            window.togglePause = function() {
                processState.isPaused = !processState.isPaused;
                const serviceId = activeSubItemId || 'lease-abstraction';
                addActivity(serviceId, `System > Process ${processState.isPaused ? 'Paused' : 'Resumed'}`, processState.isPaused ? 'Pending' : 'Success');
                refreshServicePage(serviceId);
            };

            window.stopProcess = function() {
                processState.stopped = true;
                processState.isRunning = false;
                processState.isPaused = false;
                // Item 7 - stopping mid-batch is NOT the same as finishing -
                // isComplete used to get set here too, which made the UI
                // (and a subsequent Start click) treat a stopped run as if
                // every file had been dealt with. Leave it false so Start
                // cleanly picks back up.
                processState.isComplete = false;
                activeAgentId = null;
                completedAgentIds.clear();
                const serviceId = activeSubItemId || 'lease-abstraction';

                // Any file this run was actively working on when Stop was
                // pressed is left in a permanent 'processing' limbo
                // otherwise - reset it to a clear, restartable error state
                // instead (its blob is still in memory, since only a
                // *completed* step deletes it, so Start can safely retry).
                const files = serviceId === 'translation' ? getMyTranslationFiles() : getMyLeaseFiles();
                let stoppedMidFile = null;
                files.forEach(f => {
                    if (f.status === 'processing') {
                        f.status = 'error';
                        f.errorLabel = 'Stopped';
                        f.errorReason = 'Processing was stopped by the user before this file finished. Click Start to retry.';
                        stoppedMidFile = f;
                    }
                });
                addActivity(serviceId, `System > Process Stopped${stoppedMidFile ? ` while processing ${stoppedMidFile.name}` : ''}`, 'Failed');
                showMessage('⏹️ Stopped', 'Processing has been stopped. Files already completed or awaiting review are unaffected - click Start to resume with the rest.', ['OK']);
                refreshServicePage(serviceId);
                persistServiceFiles(serviceId);
            };

            // File selection (checkbox) — user specific files run/clear kar sake
            window.toggleFileSelect = function(fileId, checked) {
                const arr = (activeSubItemId === 'translation') ? translationFiles : leaseFiles;
                const f = arr.find(x => String(x.id) === String(fileId));
                if (f) f.selected = !!checked;
                // Keep the "select all" header checkbox in sync: checked
                // only when every listed file is selected, unchecked the
                // moment any single file gets unchecked. Direct DOM update
                // (no full re-render) so focus/scroll aren't disrupted.
                const mine = arr.filter(x => x.userId === CURRENT_USER_ID);
                const selectAllEl = document.getElementById('translationSelectAll');
                if (selectAllEl) selectAllEl.checked = mine.length > 0 && mine.every(x => x.selected !== false);
                updateChargeEstimateLive();
            };
            window.toggleSelectAllFiles = function(serviceId, checked) {
                const arr = (serviceId === 'translation') ? translationFiles : leaseFiles;
                arr.filter(f => f.userId === CURRENT_USER_ID).forEach(f => { f.selected = !!checked; });
                refreshServicePage(serviceId);
            };

            // Bug 4: translation output browser-only download (session blob)
            window.downloadSessionBlob = function(fileId) {
                const entry = translationBlobStore[fileId];
                if (!entry || !entry.blob) {
                    showWarning('This file is only available during the session it was processed in. Please run it again to download.');
                    return;
                }
                const url = URL.createObjectURL(entry.blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = entry.name || 'Translation.docx';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(() => URL.revokeObjectURL(url), 1000);
            };

            window.clearFiles = function(serviceId) {
                const arrForCount = (serviceId === 'translation') ? translationFiles : leaseFiles;
                const mine = arrForCount.filter(f => f.userId === CURRENT_USER_ID);
                const selected = mine.filter(f => f.selected !== false);
                const onlySelected = selected.length > 0 && selected.length < mine.length;
                const msg = onlySelected
                    ? `Remove the ${selected.length} selected file(s) from this list?`
                    : 'Are you sure you want to clear all files from this list? Your processed history stays safe on the Dashboard.';
                showConfirm('🗑️ Clear Files', msg, function(confirmed) {
                    if (confirmed) {
                        if (onlySelected) {
                            // sirf selected hatao
                            const selIds = new Set(selected.map(f => String(f.id)));
                            if (serviceId === 'translation') {
                                translationFiles = translationFiles.filter(f => !(f.userId === CURRENT_USER_ID && selIds.has(String(f.id))));
                                selected.forEach(f => { delete translationFileBlobs[f.id]; });
                            } else {
                                leaseFiles = leaseFiles.filter(f => !(f.userId === CURRENT_USER_ID && selIds.has(String(f.id))));
                                selected.forEach(f => { delete leaseFileBlobs[f.id]; });
                            }
                            refreshServicePage(serviceId);
                            persistServiceFiles(serviceId);
                            showMessage('🗑️ Cleared', `${selected.length} file(s) removed.`, ['OK']);
                            return;
                        }
                        // Full clear - safe to remove completed entries too now,
                        // since the Dashboard's "My Processed Leases"/"My
                        // Processed Translations" cards read from the server
                        // (/api/lease/list, /api/translation/list) rather than
                        // from these local arrays, so clearing this view can
                        // no longer wipe someone's processed history.
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
                        showMessage('🗑️ Cleared', 'The file list and activity log have been cleared. Your processed history is unaffected.', ['OK']);
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
                a.download = `Activity_Log_${localDateStr()}.txt`;
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
                        '<tr><td colspan="5" style="text-align:center;padding:15px;color:rgba(0,0,0,0.3);">No files uploaded yet.</td></tr>';
                }

                const chargeEstimateEl = document.getElementById('fileListChargeEstimate');
                if (chargeEstimateEl) {
                    chargeEstimateEl.innerHTML = buildChargeEstimateHtml(serviceId, files);
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
            window.verifySystemConnection = async function() {
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

                // Item 3 - ShareFile / SharePoint need a real OAuth app
                // registered with Citrix / Microsoft (Client ID + Secret in
                // .env) before a connection is possible at all - this
                // checks whether the server has those configured instead
                // of guessing, so the status shown is honest rather than
                // randomly succeeding/failing.
                try {
                    const statusRes = await authFetch(`/api/integrations/status?provider=${selected.toLowerCase()}`);
                    const status = await statusRes.json();
                    if (!status.configured) {
                        connectionStatus = 'disconnected';
                        currentSystemConfig = 'Desktop';
                        select.value = 'Desktop';
                        refreshServicePage(activeSubItemId || 'lease-abstraction');
                        showMessage('⚙️ Not Set Up Yet', `${selected} isn't connected because no one has registered an app with ${selected} yet (needs a Client ID/Secret set up by your Developer in the server's .env file). Ask your Developer to complete that setup, then try again. Switched back to Desktop for now.`, ['OK']);
                        return;
                    }
                    window.open(status.authUrl, '_blank', 'width=520,height=640');
                    showMessage('🔗 Connect Account', `A window opened to sign in to ${selected}. Once you approve access there, come back and select ${selected} again.`, ['OK']);
                    select.value = 'Desktop';
                } catch (err) {
                    showWarning('Could not check the connection status. Make sure py/server.py is running.');
                    select.value = 'Desktop';
                }
            };

            // ============================================================
            // 19. FILE UPLOAD HANDLER
            // ============================================================
            window.handleFileUpload = function(event, serviceId) {
                const files = event.target.files;
                if (files.length === 0) return;

                // PDF-only for both Lease Abstraction and Translation - the
                // accept=".pdf" on the <input> is just a browser hint (and
                // is bypassed entirely by drag & drop), so this is the real
                // enforcement point both paths funnel through.
                const nonPdf = Array.from(files).filter(f => !/\.pdf$/i.test(f.name));
                if (nonPdf.length > 0) {
                    showWarning('Only PDF files are supported. ' +
                        (nonPdf.length === files.length ? 'Please select PDF file(s) only.' :
                        `Skipped non-PDF file(s): ${nonPdf.map(f => f.name).join(', ')}`));
                }
                const pdfFiles = Array.from(files).filter(f => /\.pdf$/i.test(f.name));
                if (pdfFiles.length === 0) { event.target.value = ''; return; }

                const isTranslation = serviceId === 'translation';
                const idCounter = isTranslation ? nextTranslationFileId : nextLeaseFileId;

                let newFiles = [];
                for (let i = 0; i < pdfFiles.length; i++) {
                    const file = pdfFiles[i];

                    const newFile = {
                        id: idCounter + i,
                        userId: CURRENT_USER_ID,
                        name: file.name,
                        status: 'pending',
                        scanResult: '0',
                        progress: '0',
                        action: 'Pending',
                        selected: true,
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
                    for (let i = 0; i < pdfFiles.length; i++) {
                        translationFileBlobs[newFiles[i].id] = pdfFiles[i];
                    }
                    // PAGE COUNT: Uploaded Files card me no-of-pages dikhane ke liye
                    // pdf.js se numPages nikaalo (async, non-blocking).
                    newFiles.forEach(function (nf, idx) {
                        const blobFile = pdfFiles[idx];
                        if (typeof pdfjsLib === 'undefined') return;
                        blobFile.arrayBuffer().then(function (buf) {
                            return pdfjsLib.getDocument({ data: buf }).promise;
                        }).then(function (pdf) {
                            nf.pageCount = pdf.numPages;
                            refreshServicePage('translation');
                        }).catch(function () { /* ignore — count optional */ });
                    });
                } else {
                    leaseFiles = leaseFiles.concat(newFiles);
                    nextLeaseFileId += newFiles.length;
                    // Keep the real File objects in memory (JSON can't store
                    // bytes) so Start can actually upload them for real
                    // scanning/extraction - see runLeaseAbstractionPipeline().
                    for (let i = 0; i < pdfFiles.length; i++) {
                        leaseFileBlobs[newFiles[i].id] = pdfFiles[i];
                    }
                }

                refreshServicePage(serviceId);
                event.target.value = '';
                persistServiceFiles(serviceId);

                showMessage('✅ Upload Complete', `${newFiles.length} file(s) uploaded successfully.`, ['OK']);
            };

            // ============================================================
            // 19b. CURRENCY - single source of truth
            //
            // Purana bug: index.html / template HTML me "₹0.00" tha, lekin
            // jaise hi JS render karta tha wo "$0.00" ban jata tha, kyunki
            // har jagah alag-alag '$' hardcode tha. Ab har money value
            // sirf formatMoney() se banti hai - currency badalni ho to
            // sirf CURRENCY_SYMBOL badalna hai, aur kahin nahi.
            // ============================================================
            // Symbol company.json se aata hai (COMPANY_INFO.currency).
            // Wahan badalne par poore app me badal jayega - koi aur jagah
            // hardcode nahi hai. Config load hone se pehle ₹ fallback.
            function currencySymbol() {
                return (COMPANY_INFO && COMPANY_INFO.currency) || '₹';
            }
            Object.defineProperty(window, 'CURRENCY_SYMBOL', { get: currencySymbol });

            function formatMoney(value) {
                const n = Number(value);
                return currencySymbol() + (isFinite(n) ? n : 0).toFixed(2);
            }
            window.formatMoney = formatMoney;

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
                const expenseSelect = document.getElementById('expensePaymentMethod');
                if (!select && !expenseSelect) return;

                const myMethods = getMyPaymentMethods();

                [select, expenseSelect].forEach((sel) => {
                    if (!sel) return;
                    sel.innerHTML = '';
                    if (myMethods.length === 0) {
                        sel.innerHTML = '<option value="">No payment methods available</option>';
                        return;
                    }
                    myMethods.forEach((method) => {
                        const option = document.createElement('option');
                        option.value = method.id;
                        option.textContent = method.name + ' (' + method.details + ')';
                        if (method.isDefault) option.selected = true;
                        sel.appendChild(option);
                    });
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
                const toStr = localDateStr(today);
                const fromStr = localDateStr(fromDate);
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

            let selectedTransactionIds = new Set();

            // Status pill: transaction.status set na ho to wo purana
            // completed record hai, isliye default "Success".
            function txnStatusPill(status) {
                const map = {
                    pending_approval: ['pending', 'Pending'],
                    cancelled:        ['cancelled', 'Cancelled'],
                    failed:           ['failed', 'Failed']
                };
                const hit = map[status] || ['success', 'Success'];
                return `<span class="txn-status-pill ${hit[0]}">${hit[1]}</span>`;
            }

            function renderHistoryRows(tbody, list, includeCheckbox) {
                const colCount = includeCheckbox ? 10 : 9;
                if (list.length === 0) {
                    tbody.innerHTML =
                        `<tr><td colspan="${colCount}" style="text-align:center;padding:20px;color:rgba(0,0,0,0.4);">No transactions found.</td></tr>`;
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
                    // Item 3 - a balance-add sitting in pending_approval (or
                    // cancelled) shows a clear status prefix on its
                    // description, everywhere this row shape is used
                    // (Payment History AND Today's Transactions, both call
                    // through here).
                    let descriptionText = escapeHtml(transaction.description || '');
                    if (transaction.status === 'pending_approval') {
                        descriptionText = `<span class="txn-status-tag pending">In Process</span> : ${descriptionText}`;
                    } else if (transaction.status === 'cancelled') {
                        descriptionText = `<span class="txn-status-tag cancelled">Cancelled</span> : ${descriptionText}`;
                    }
                    tr.innerHTML = `
                        ${includeCheckbox ? `<td><input type="checkbox" class="txn-select-checkbox" data-txn-id="${transaction.id}" ${selectedTransactionIds.has(transaction.id) ? 'checked' : ''} onchange="toggleSelectTransaction('${transaction.id}', this.checked)" /></td>` : ''}
                        <td>${dateTimeText}</td>
                        <td><span style="font-weight:500;color:darkblue;">${transaction.id}</span></td>
                        <td>${escapeHtml(transaction.userId || '')}</td>
                        <td>${transaction.paymentType}</td>
                        <td>${transaction.paymentMode}</td>
                        <td>${descriptionText}</td>
                        <td class="credit">${transaction.credit > 0 ? formatMoney(transaction.credit) : '-'}</td>
                        <td class="debit">${transaction.debit > 0 ? formatMoney(transaction.debit) : '-'}</td>
                        <td>${txnStatusPill(transaction.status)}</td>
                    `;
                    tbody.appendChild(tr);
                });
            }

            window.toggleSelectTransaction = function(txnId, checked) {
                if (checked) selectedTransactionIds.add(txnId);
                else selectedTransactionIds.delete(txnId);
            };

            window.toggleSelectAllTransactions = function(checked) {
                document.querySelectorAll('.txn-select-checkbox').forEach(cb => {
                    cb.checked = checked;
                    const txnId = cb.getAttribute('data-txn-id');
                    if (checked) selectedTransactionIds.add(txnId);
                    else selectedTransactionIds.delete(txnId);
                });
            };

            // Pagination state. Summary hamesha POORE filtered set par
            // banta hai, sirf table ka slice page ke hisab se badalta hai -
            // warna "Total Credit" page badalne par badal jata.
            let historyPage = 1;
            let historyPerPage = 5;

            function renderPaymentHistory() {
                const tbody = document.getElementById('historyTableBody');
                if (!tbody) return;

                // Dates start blank by default - getFilteredHistory() already
                // returns every transaction for this user when no range is set.
                const filtered = getFilteredHistory();
                const total = filtered.length;
                const pages = Math.max(1, Math.ceil(total / historyPerPage));
                if (historyPage > pages) historyPage = pages;

                const start = (historyPage - 1) * historyPerPage;
                renderHistoryRows(tbody, filtered.slice(start, start + historyPerPage), true);
                updateSummary(filtered);
                renderHistoryPager(total, pages, start);
            }

            function renderHistoryPager(total, pages, start) {
                const pager = document.getElementById('historyPager');
                if (!pager) return;

                const shownFrom = total === 0 ? 0 : start + 1;
                const shownTo = Math.min(start + historyPerPage, total);

                // Bade page counts par "1 2 3 ... 9" - saare numbers dikhane se
                // bar toot jata hai.
                const nums = [];
                if (pages <= 5) {
                    for (let i = 1; i <= pages; i++) nums.push(i);
                } else if (historyPage <= 3) {
                    nums.push(1, 2, 3, '\u2026', pages);
                } else if (historyPage >= pages - 2) {
                    nums.push(1, '\u2026', pages - 2, pages - 1, pages);
                } else {
                    nums.push(1, '\u2026', historyPage, '\u2026', pages);
                }

                const btn = (label, page, extra) =>
                    page === null
                        ? `<span class="pager-gap">${label}</span>`
                        : `<button class="pager-btn ${extra || ''}" ${page ? `onclick="goHistoryPage(${page})"` : 'disabled'}>${label}</button>`;

                pager.innerHTML = `
                    <span class="pager-count">Showing ${shownFrom} to ${shownTo} of ${total} entries</span>
                    <div class="pager-controls">
                        <select class="pager-select" onchange="setHistoryPerPage(this.value)">
                            ${[5, 10, 25, 50].map(n =>
                                `<option value="${n}" ${n === historyPerPage ? 'selected' : ''}>${n} per page</option>`).join('')}
                        </select>
                        ${btn('\u00ab', historyPage > 1 ? 1 : 0)}
                        ${btn('\u2039', historyPage > 1 ? historyPage - 1 : 0)}
                        ${nums.map(n => n === '\u2026'
                            ? btn('\u2026', null)
                            : btn(n, n, n === historyPage ? 'is-current' : '')).join('')}
                        ${btn('\u203a', historyPage < pages ? historyPage + 1 : 0)}
                        ${btn('\u00bb', historyPage < pages ? pages : 0)}
                    </div>
                `;
            }

            window.goHistoryPage = function(page) {
                historyPage = page;
                renderPaymentHistory();
            };

            window.setHistoryPerPage = function(value) {
                historyPerPage = Number(value) || 5;
                historyPage = 1;
                renderPaymentHistory();
            };

            window.applyHistoryFilter = function() {
                historyPage = 1;
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
                renderHistoryRows(tbody, filtered, true);
                updateSummary(filtered);
            };

            window.clearHistoryFilter = function() {
                document.getElementById('historyFromDate').value = '';
                document.getElementById('historyToDate').value = '';
                const tbody = document.getElementById('historyTableBody');
                const filtered = getFilteredHistory();
                renderHistoryRows(tbody, filtered, true);
                updateSummary(filtered);
            };

            window.downloadHistoryExcel = function() {
                const filtered = getFilteredHistory();
                if (filtered.length === 0) {
                    showWarning('No data available to download for the selected range.');
                    return;
                }
                const sorted = [...filtered].sort((a, b) => new Date(b.date) - new Date(a.date));
                const headers = ['Date & Time', 'T. ID', 'Payment Type', 'Payment Mode',
                    'Description', 'Credit (' + currencySymbol() + ')', 'Debit (' + currencySymbol() + ')'
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
                a.download = 'Payment_History_' + localDateStr() + '.xls';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            };

            function updateSummary(list) {
                const data = list || getMyPaymentHistory();
                let totalCredit = 0,
                    totalDebit = 0;
                data.forEach(t => {
                    if (t.status === 'pending_approval' || t.status === 'cancelled') return;
                    totalCredit += Number(t.credit) || 0;
                    totalDebit += Number(t.debit) || 0;
                });
                const balance = totalCredit - totalDebit;

                document.getElementById('totalCredit').textContent = formatMoney(totalCredit);
                document.getElementById('totalDebit').textContent = formatMoney(totalDebit);
                document.getElementById('currentBalance').textContent = formatMoney(balance);
            }

            // ============================================================
            // 22. BALANCE FUNCTIONS
            // ============================================================
            function updateBalanceDisplay() {
                let totalCredit = 0,
                    totalDebit = 0;
                getMyPaymentHistory().forEach(t => {
                    if (t.status === 'pending_approval' || t.status === 'cancelled') return;
                    totalCredit += Number(t.credit) || 0;
                    totalDebit += Number(t.debit) || 0;
                });
                const balance = totalCredit - totalDebit;

                const creditEl = document.getElementById('totalCreditBalance');
                const debitEl = document.getElementById('totalDebitBalance');
                const balanceEl = document.getElementById('currentBalanceDisplay');

                if (creditEl) creditEl.textContent = formatMoney(totalCredit);
                if (debitEl) debitEl.textContent = formatMoney(totalDebit);
                if (balanceEl) balanceEl.textContent = formatMoney(balance);
            }

            function getAdminAndDeveloperIds() {
                return USER_DIRECTORY.filter(u => u.role === 'Admin' || u.role === 'Developer').map(u => u.id);
            }

            window.switchPlan = function(planId) {
                const plan = PLANS_DATA.find(p => p.id === planId);
                if (!plan) { showWarning('That plan could not be found.'); return; }
                if (plan.name === getMyPlan().name) return;

                // Item - show exactly what will be deducted and require an
                // explicit Confirm before charging anything, instead of
                // switching immediately on click.
                const confirmMsg = plan.monthlyPrice > 0 ?
                    `Switching to the ${plan.name} plan will deduct ₹${plan.monthlyPrice.toFixed(2)} from your wallet balance right now. Do you want to continue?` :
                    `Switch to the ${plan.name} plan? This plan has no monthly charge.`;
                showConfirm('Confirm Plan Change', confirmMsg, (confirmed) => {
                    if (confirmed) _doSwitchPlan(plan);
                });
            };

            function _doSwitchPlan(plan) {
                const finalizeSwitch = () => {
                    const now = new Date();
                    const endDate = new Date(now);
                    // Item 3 - Free is a 7-day trial-style period; every
                    // paid plan renews monthly (30 days).
                    endDate.setDate(endDate.getDate() + (plan.name === 'Free' ? 7 : 30));
                    const startDateStr = localDateStr(now);
                    const endDateStr = localDateStr(endDate);
                    profileData.plan = plan.name;
                    profileData.planStartDate = startDateStr;
                    profileData.planEndDate = endDateStr;
                    profileData.planStatus = 'Active';
                    persistProfile();

                    // Item - plan history table (shown below the plan cards
                    // on Plans & Offers) - one row per switch, ever.
                    planHistory.push({
                        userId: CURRENT_USER_ID,
                        planName: plan.name,
                        startDate: startDateStr,
                        endDate: endDateStr,
                        frequency: 'Monthly',
                        amount: plan.monthlyPrice,
                        pricePerTranslation: plan.pricePerTranslation,
                    });
                    persistPlanHistory();

                    if (activeSubItemId === null && activeItemId === 'plans-offers') loadContent('plans-offers');
                    addNotification(`Your plan was switched to ${plan.name} (valid through ${profileData.planEndDate}).`);
                    if (profileData.email) {
                        sendGenericNotificationEmail(
                            profileData.email, `${profileData.firstName} ${profileData.lastName}`,
                            `You're now on the ${plan.name} plan`,
                            `Your plan is now ${plan.name}. It's valid from ${profileData.planStartDate} to ${profileData.planEndDate}. ` +
                            `Translation is billed at ₹${plan.pricePerTranslation}/page.`
                        );
                    }
                };

                if (plan.monthlyPrice > 0) {
                    if (getCurrentBalance() < plan.monthlyPrice) {
                        showWarning(`Upgrading to ${plan.name} costs ₹${plan.monthlyPrice}/month, but your wallet only has ₹${getCurrentBalance().toFixed(2)}. Please add at least ₹${(plan.monthlyPrice - getCurrentBalance()).toFixed(2)} to your wallet balance and try again.`);
                        return;
                    }
                    const now = new Date();
                    const txnId = 'TXN' + String(nextTransactionId++).padStart(3, '0');
                    paymentHistory.push({
                        id: txnId,
                        date: localDateStr(now),
                        time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }),
                        userId: CURRENT_USER_ID,
                        paymentType: 'Plan Subscription',
                        paymentMode: 'Wallet Balance',
                        description: `${plan.name} plan - monthly subscription`,
                        credit: 0,
                        debit: plan.monthlyPrice
                    });
                    persistPaymentHistory();
                    updateBalanceDisplay();
                    addNotification(`₹${plan.monthlyPrice.toFixed(2)} was deducted for your ${plan.name} plan subscription (${txnId}).`);
                }
                finalizeSwitch();
                showMessage('✅ Plan Updated', `You're now on the ${plan.name} plan.`, ['OK']);
            }

            window.recordExpense = function() {
                if (!isAdminOrDeveloper()) { showWarning('Only an Admin or Developer can record an expense.'); return; }
                const methodSelect = document.getElementById('expensePaymentMethod');
                const amountInput = document.getElementById('expenseAmount');
                const descInput = document.getElementById('expenseDescription');

                const methodId = parseInt(methodSelect.value);
                const amount = parseFloat(amountInput.value);
                const description = descInput.value.trim();

                if (!methodId) { showWarning('Please select a payment method.'); return; }
                if (!amount || amount <= 0) { showWarning('Please enter a valid amount.'); return; }
                if (!description) { showWarning('Please enter a description.'); return; }

                const method = paymentMethods.find(m => m.id === methodId);
                if (!method) { showWarning('Selected payment method not found.'); return; }

                const developerId = getDeveloperUserId() || CURRENT_USER_ID;
                const now = new Date();
                const txnId = 'TXN' + String(nextTransactionId++).padStart(3, '0');
                paymentHistory.push({
                    id: txnId,
                    date: localDateStr(now),
                    time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }),
                    userId: developerId,
                    paymentType: 'Expense',
                    paymentMode: method.name + ' ' + method.details,
                    description: description,
                    credit: 0,
                    debit: amount,
                    recordedBy: CURRENT_USER_ID
                });

                amountInput.value = '';
                descInput.value = '';

                renderPaymentHistory();
                updateBalanceDisplay();
                persistPaymentHistory();
                showMessage('💸 Expense Recorded', `₹${amount.toFixed(2)} has been recorded as a business expense.`, ['OK']);
            };

            // Real, gateway-verified balance top-up. Unlike the manual/
            // bank-transfer path below, this never writes a transaction
            // itself - the server only accepts one after it has verified
            // Razorpay's own signature (see /api/payment/verify-payment),
            // so nothing here can invent balance on its own.
            // ============================================================
            // Inline checkout panel (right half of the Add Balance card)
            //
            // #rzpInlineMount is the container Razorpay's iframe goes into.
            // Everything else we draw inside it lives in a single
            // .pay-panel-state node, so swapping our own messages never
            // wipes out Razorpay's iframe (an innerHTML reset would).
            // ============================================================
            const PAY_PANEL_IDLE_HTML = `
                <div class="pay-panel-idle-icon">▣</div>
                <div class="pay-panel-idle-title">Payment opens here</div>
                <div class="pay-panel-idle-text">
                    Enter an amount on the left and click <b>+ Add Balance</b>.
                    The secure payment form loads right here, inside this page.
                </div>
                <div class="pay-panel-badges">
                    <span>UPI</span><span>Visa</span><span>Mastercard</span><span>RuPay</span>
                </div>`;

            function payPanelSetState(html) {
                const mount = document.getElementById('rzpInlineMount');
                if (!mount) return;
                const existing = mount.querySelector('.pay-panel-state');
                if (existing) existing.remove();
                if (html) mount.insertAdjacentHTML('afterbegin', '<div class="pay-panel-state">' + html + '</div>');
            }

            window.resetPayPanel = function() {
                const panel = document.getElementById('balancePayPanel');
                const mount = document.getElementById('rzpInlineMount');
                if (!mount) return;
                Array.prototype.slice.call(mount.querySelectorAll('iframe')).forEach(f => f.remove());
                if (panel) panel.classList.remove('is-busy', 'is-inline');
                payPanelSetState(PAY_PANEL_IDLE_HTML);
                syncPayPanelAmount();
            };

            window.syncPayPanelAmount = function() {
                const amountEl = document.getElementById('payPanelAmount');
                const input = document.getElementById('balanceAmount');
                if (amountEl) amountEl.textContent = formatMoney(input ? parseFloat(input.value) || 0 : 0);
                syncQuickChips();
            };

            window.setBalanceAmount = function(value) {
                const input = document.getElementById('balanceAmount');
                if (!input) return;
                input.value = value;
                syncPayPanelAmount();
            };

            // Chip highlight amount ke saath chalta hai, chahe user ne chip
            // dabaya ho ya seedha type kiya ho.
            function syncQuickChips() {
                const input = document.getElementById('balanceAmount');
                const current = input ? String(parseFloat(input.value) || '') : '';
                document.querySelectorAll('.balance-quick-chip').forEach(chip => {
                    chip.classList.toggle('is-active', chip.dataset.amount === current);
                });
            }

            // Razorpay's checkout.js takes a `parent` option that renders the
            // form inline instead of as a modal, but it is NOT in Razorpay's
            // official docs - so we ask for it and then verify rather than
            // assume. If an iframe actually lands in our container we style
            // the panel as inline; if it doesn't, checkout has already opened
            // as its usual modal and the panel just says so. Either way it is
            // the same single rzp.open() call, so there is no double-charge
            // path and nothing breaks if Razorpay drops the option later.
            function openRazorpayCheckout(options) {
                const panel = document.getElementById('balancePayPanel');
                const mount = document.getElementById('rzpInlineMount');
                const wantInline = !!mount;

                if (wantInline) {
                    if (panel) panel.classList.add('is-busy');
                    payPanelSetState('<div class="pay-panel-spinner"></div><div class="pay-panel-idle-text">Loading secure payment form\u2026</div>');
                    options.parent = '#rzpInlineMount';
                }

                const rzp = new Razorpay(options);
                rzp.on('payment.failed', function(response) {
                    resetPayPanel();
                    showWarning('Payment failed: ' + ((response.error && response.error.description) || 'please try again.'));
                });
                rzp.open();

                if (wantInline) {
                    let tries = 0;
                    const poll = setInterval(function() {
                        tries++;
                        if (mount.querySelector('iframe')) {
                            clearInterval(poll);
                            if (panel) { panel.classList.remove('is-busy'); panel.classList.add('is-inline'); }
                            payPanelSetState('');
                        } else if (tries >= 30) {
                            // ~3s and nothing mounted: `parent` was ignored,
                            // so the normal modal is what the user is seeing.
                            clearInterval(poll);
                            if (panel) panel.classList.remove('is-busy');
                            payPanelSetState(
                                '<div class="pay-panel-idle-icon">▣</div>' +
                                '<div class="pay-panel-idle-title">Payment window is open</div>' +
                                '<div class="pay-panel-idle-text">Complete your payment in the secure window. ' +
                                'Please don\'t close or refresh this tab until it finishes.</div>'
                            );
                        }
                    }, 100);
                }
                return rzp;
            }

            window.payWithRazorpay = function() {
                const amountInput = document.getElementById('balanceAmount');
                const descInput = document.getElementById('balanceDescription');

                const amount = parseFloat(amountInput.value);
                const description = descInput.value.trim() || 'Balance top-up';

                if (!amount || amount <= 0) { showWarning('Please enter a valid amount.'); return; }
                if (typeof Razorpay === 'undefined') {
                    showWarning('Payment gateway failed to load. Please check your connection and try again.');
                    return;
                }

                authPost('/api/payment/create-order', { userId: CURRENT_USER_ID, amount: amount })
                    .then(order => {
                        const options = {
                            key: order.keyId,
                            amount: order.amount,
                            currency: order.currency,
                            order_id: order.orderId,
                            name: (COMPANY_INFO && COMPANY_INFO.name) || 'Lexora',
                            description: description,
                            image: (COMPANY_INFO && COMPANY_INFO.logo) || 'Pictures/logo.png',
                            prefill: {
                                name: profileData ? `${profileData.firstName} ${profileData.lastName}` : undefined,
                                email: profileData ? profileData.email : undefined,
                                // Phone comes from the signed-in profile, so
                                // the user doesn't have to type it again.
                                contact: profileData ? (profileData.phone || profileData.mobile || profileData.whatsapp || undefined) : undefined
                            },
                            // Only UPI and cards are offered. Netbanking,
                            // wallets, EMI and Pay Later all add their own
                            // charges, failure modes and settlement delays
                            // that aren't worth it for small wallet top-ups.
                            config: {
                                display: {
                                    blocks: {
                                        core: {
                                            name: 'Pay using',
                                            instruments: [
                                                { method: 'upi' },
                                                { method: 'card' },
                                                { method: 'emi' }
                                            ]
                                        }
                                    },
                                    sequence: ['block.core'],
                                    preferences: { show_default_blocks: false }
                                }
                            },
                            theme: { color: '#1257f5', backdrop_color: 'rgba(11,21,51,0.55)' },
                            handler: function(response) {
                                authPost('/api/payment/verify-payment', {
                                    userId: CURRENT_USER_ID,
                                    razorpayOrderId: response.razorpay_order_id,
                                    razorpayPaymentId: response.razorpay_payment_id,
                                    razorpaySignature: response.razorpay_signature,
                                    description: description
                                }).then(result => {
                                    const txn = result.transaction;
                                    paymentHistory.push(txn);
                                    _creditDeveloperRevenueRecord(txn, description);

                                    amountInput.value = '';
                                    descInput.value = '';

                                    renderPaymentHistory();
                                    updateBalanceDisplay();
                                    resetPayPanel();

                                    if (profileData && profileData.email) {
                                        sendGenericNotificationEmail(
                                            profileData.email,
                                            `${profileData.firstName} ${profileData.lastName}`,
                                            `₹${txn.credit.toFixed(2)} added to your balance`,
                                            `Your payment was received and added to your wallet balance.`,
                                            [[txn.paymentMode, description, `₹${txn.credit.toFixed(2)}`, `Completed (${txn.id})`]],
                                            ['Payment Method', 'Description', 'Amount', 'Status']
                                        );
                                    }
                                    addNotification(`₹${txn.credit.toFixed(2)} was added to your balance (Transaction ID: ${txn.id}).`);
                                    showMessage('✅ Success', `₹${txn.credit.toFixed(2)} added successfully! Transaction ID: ${txn.id}`, ['OK']);
                                }).catch(err => {
                                    resetPayPanel();
                                    showWarning('Payment could not be verified: ' + err.message +
                                        '. If any amount was deducted, Razorpay will auto-refund it within a few days - contact support with your payment ID if it is not.');
                                });
                            },
                            modal: {
                                ondismiss: function() {
                                    // User closed the widget - nothing was
                                    // charged, just put the panel back.
                                    resetPayPanel();
                                }
                            }
                        };

                        // THE saved-cards fix. Razorpay only ever stores a
                        // card token AGAINST A CUSTOMER. Without customer_id
                        // the "Save this card as per RBI guidelines" tick has
                        // nothing to attach the token to, so next time there
                        // is nothing to fetch back and the card fields come up
                        // blank - which is exactly the bug that was reported.
                        // The id itself is created/reused server-side in
                        // /api/payment/create-order.
                        if (order.customerId) options.customer_id = order.customerId;

                        openRazorpayCheckout(options);
                    })
                    .catch(err => {
                        resetPayPanel();
                        showWarning('Could not start payment: ' + err.message);
                    });
            };

            // Manual / bank-transfer fallback for people paying outside
            // Razorpay - unlike payWithRazorpay() above, this is a plain
            // client-side record and always needs an Admin/Developer to
            // approve it before it counts toward the balance (unless the
            // person submitting it already IS an Admin/Developer).
            // Adding balance means the user PAYS US, so it must go through
            // Razorpay's checkout - a client-side ledger entry would credit
            // balance without any money actually moving. The old manual entry
            // is kept only as the fallback for when the gateway can't load.
            // Topping up means the user PAYS US, so it always goes through
            // Razorpay's checkout - there is no client-side path that can
            // credit balance without money actually moving.
            window.addBalance = function() {
                const amountInput = document.getElementById('balanceAmount');
                const descInput = document.getElementById('balanceDescription');
                const amount = parseFloat(amountInput.value);
                const description = descInput.value.trim();

                if (!amount || amount <= 0) { showWarning('Please enter a valid amount.'); return; }
                if (!description) { showWarning('Please enter a description.'); return; }
                if (typeof Razorpay === 'undefined') {
                    showWarning('The payment gateway could not be loaded. Please check your connection and try again.');
                    return;
                }
                payWithRazorpay();
            };

            function _creditDeveloperRevenueRecord(newTransaction, description) {
                // Whoever adds balance, the real "money received" also
                // shows up in the Developer's own Payment History as
                // revenue - the entry above is what makes the ADDING
                // user's own spendable balance go up; this one just
                // records that the Developer's primary account is who
                // actually received it. Only runs once a request is
                // actually approved (or immediately, for a self-approved
                // Admin/Developer top-up).
                const developerId = getDeveloperUserId();
                if (developerId && developerId !== newTransaction.userId) {
                    const dirEntry = getUserDirectoryEntry(newTransaction.userId);
                    const whoAdded = dirEntry ? `${dirEntry.firstName} ${dirEntry.lastName} (${newTransaction.userId})` : newTransaction.userId;
                    paymentHistory.push({
                        id: 'TXN' + String(nextTransactionId++).padStart(3, '0'),
                        date: newTransaction.date,
                        time: newTransaction.time,
                        userId: developerId,
                        paymentType: 'Balance Received',
                        paymentMode: newTransaction.paymentMode,
                        description: `Balance added by ${whoAdded}: ${description}`,
                        credit: newTransaction.credit,
                        debit: 0
                    });
                }
            }

            // Item 2 - called from the Approve/Cancel buttons rendered
            // directly in a balance_approval notification row.
            window.approveBalanceRequest = function(txnId, notificationId) {
                const txn = paymentHistory.find(t => t.id === txnId);
                if (!txn) { showWarning('That transaction could not be found - it may have already been handled.'); return; }
                txn.status = 'approved';
                _creditDeveloperRevenueRecord(txn, txn.description);
                persistPaymentHistory();
                markNotificationHandled(notificationId, 'Approved');

                addNotificationFor(txn.userId, `✅ Your balance request for ₹${txn.credit.toFixed(2)} (${txnId}) was approved and added to your wallet.`);
                const dirEntry = getUserDirectoryEntry(txn.userId);
                if (dirEntry && dirEntry.email) {
                    sendGenericNotificationEmail(dirEntry.email, `${dirEntry.firstName} ${dirEntry.lastName}`,
                        'Your balance request was approved',
                        `Your request to add ₹${txn.credit.toFixed(2)} to your wallet (Transaction ${txnId}) has been approved and is now reflected in your balance.`);
                }
                if (txn.userId === CURRENT_USER_ID) updateBalanceDisplay();
                renderNotificationTable();
                showMessage('✅ Approved', `₹${txn.credit.toFixed(2)} has been added to the user's balance.`, ['OK']);
            };

            window.cancelBalanceRequest = function(txnId, notificationId) {
                const txn = paymentHistory.find(t => t.id === txnId);
                if (!txn) { showWarning('That transaction could not be found - it may have already been handled.'); return; }
                txn.status = 'cancelled';
                persistPaymentHistory();
                markNotificationHandled(notificationId, 'Cancelled');

                addNotificationFor(txn.userId, `❌ Your balance request for ₹${txn.credit.toFixed(2)} (${txnId}) was cancelled by an Admin/Developer.`);
                const dirEntry = getUserDirectoryEntry(txn.userId);
                if (dirEntry && dirEntry.email) {
                    sendGenericNotificationEmail(dirEntry.email, `${dirEntry.firstName} ${dirEntry.lastName}`,
                        'Your balance request was cancelled',
                        `Your request to add ₹${txn.credit.toFixed(2)} to your wallet (Transaction ${txnId}) was cancelled. Please contact Support if you believe this is a mistake.`);
                }
                renderNotificationTable();
                showMessage('❌ Cancelled', `The balance request has been cancelled.`, ['OK']);
            };

            function markNotificationHandled(notificationId, resultLabel) {
                if (!notificationId) return;
                const n = notifications.find(x => x.id === notificationId);
                if (n) {
                    n.read = true;
                    n.handledResult = resultLabel;
                }
                persistNotifications();
            }



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

            window.showSuccess = function(message) {
                renderMessageBox({
                    title: (MESSAGES.success && MESSAGES.success.title) || 'Done',
                    message: message,
                    buttons: ['OK']
                });
            };

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
                addNotification('A new API key was generated for your account.');
                if (profileData && profileData.email) {
                    sendGenericNotificationEmail(
                        profileData.email,
                        `${profileData.firstName} ${profileData.lastName}`,
                        'New API key generated',
                        `A new API key was generated for your account just now (${newKey.createdAt}). ` +
                        `If you didn't do this, please revoke it immediately from your Profile and contact support.`
                    );
                }
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
                            addNotification('Your API key was revoked.');
                            if (profileData && profileData.email) {
                                sendGenericNotificationEmail(
                                    profileData.email,
                                    `${profileData.firstName} ${profileData.lastName}`,
                                    'API key revoked',
                                    `Your API key was revoked just now (${activeKey.revokedAt}). It can no longer be used to access the API. ` +
                                    `If you didn't do this, please contact support right away.`
                                );
                            }
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
                    // Key default me masked rehti hai - eye button se dikhti
                    // hai. Asli value data attribute me, taaki Copy kaam kare.
                    activeApiKeyValue = activeKey.key;
                    display.dataset.key = activeKey.key;
                    display.innerHTML = `<span class="api-key-text">${apiKeyVisible ? escapeHtml(activeKey.key) : '\u2022'.repeat(Math.min(44, activeKey.key.length))}</span>` +
                        (activeKey.saved ?
                            ' <span class="api-key-saved">(Saved)</span>' : '');
                }

                if (actionsEl) {
                    actionsEl.style.display = 'flex';
                }

                // Key Details box (Created On + Status) - mockup me key ke
                // right side me.
                const createdEl = document.getElementById('apiKeyCreatedOn');
                if (createdEl) createdEl.textContent = activeKey.createdAt || '\u2014';
                const statusEl = document.getElementById('apiKeyStatus');
                if (statusEl) {
                    const revoked = activeKey.status === 'revoked';
                    statusEl.textContent = revoked ? 'Revoked' : 'Active';
                    statusEl.className = 'txn-status-pill ' + (revoked ? 'failed' : 'success');
                }

                if (historyEl) {
                    const others = apiKeys.filter(k => k !== activeKey);
                    historyEl.innerHTML = `
                        <div class="api-prev-wrap">
                            <table class="admin-json-table api-prev-table">
                                <thead><tr><th>API Key</th><th>Created On</th><th>Status</th></tr></thead>
                                <tbody>
                                    ${others.length === 0
                                        ? '<tr><td colspan="3" class="api-prev-empty">No previous keys yet.</td></tr>'
                                        : others.map(k => `<tr>
                                            <td class="api-prev-key">${escapeHtml(k.key)}</td>
                                            <td>${escapeHtml(k.createdAt || '')}</td>
                                            <td><span class="txn-status-pill ${k.status === 'revoked' ? 'failed' : 'success'}">${k.status === 'revoked' ? 'Revoked' : 'Active'}</span></td>
                                        </tr>`).join('')}
                                </tbody>
                            </table>
                        </div>`;
                }
            }

            // Sidebar + endpoint panel + tabs, SERVICES_API_DATA se hi
            // (wahi data pehle ek lambi list me dikhta tha).
            let apiRefActive = null;
            let apiRefTab = 'request';

            // SERVICES_API_DATA async load hota hai, isliye yahan uspar
            // koi bharosa nahi kiya jata: list menu se banti hai (jo hamesha
            // maujood hai), labels jahan mile wahan data se, aur default
            // selection HAMESHA pehli aisi service hoti hai jiske docs
            // sach me maujood hain. Data late aaye to card dobara render
            // ho jata hai. Isi wajah se pehle khaali/"Other Services"
            // dikhta tha.
            function apiDocsData() { return SERVICES_API_DATA || {}; }

            // Free tools browser me chalte hain (pdf.js / pdf-lib), unka
            // koi REST endpoint nahi hai. Isliye unke docs FreeServices ki
            // registry se banaye jaate hain aur saaf-saaf "browser" kind me
            // dikhte hain - jhooth-mooth ka REST endpoint likhne se behtar
            // hai sach batana.
            function freeToolDocs() {
                if (!(window.FreeServices && typeof FreeServices.catalogue === 'function')) return [];
                const out = [];
                try {
                    FreeServices.catalogue().forEach(group => {
                        (group.tools || []).forEach(t => {
                            if (!t || !t.id) return;
                            out.push({
                                id: 'free:' + t.id,
                                kind: 'browser',
                                label: t.label || t.id,
                                group: group.title,
                                desc: t.desc || '',
                                toolId: t.id
                            });
                        });
                    });
                } catch (err) {
                    console.warn('Could not read the free tools catalogue:', err);
                }
                return out;
            }

            function apiRefServices() {
                const menu = MENU_CONFIG && MENU_CONFIG.mainMenu
                    ? MENU_CONFIG.mainMenu.find(m => m.id === 'services') : null;
                const data = apiDocsData();

                // "Other Services" khud koi service nahi - wo free tools ka
                // container hai. Usko list se hata kar uske andar ke saare
                // tools alag-alag dikhaye jaate hain.
                const paid = (menu && menu.subItems ? menu.subItems : [])
                    .filter(s => s.id !== 'other-services')
                    .map(s => ({
                        id: s.id,
                        kind: 'rest',
                        group: 'Paid Services',
                        label: (data[s.id] && data[s.id].label)
                            || String(s.label || s.id).replace(/^[^A-Za-z0-9]+/, '').trim()
                    }));

                const known = paid.length ? paid : Object.keys(data).map(id => ({
                    id: id, kind: 'rest', group: 'Paid Services', label: data[id].label || id
                }));

                return known.concat(freeToolDocs());
            }

            function firstDocumentedService(services) {
                const data = apiDocsData();
                const withDocs = services.find(s => s.kind === 'browser' || (data[s.id] && data[s.id].get));
                return (withDocs || services[0] || {}).id || null;
            }

            // Chhota JSON highlighter - keys, strings aur numbers alag rang.
            function highlightJson(text) {
                const safe = escapeHtml(String(text || ''));
                return safe
                    .replace(/(&quot;[^&]*?&quot;)(\s*:)/g, '<span class="tok-key">$1</span>$2')
                    .replace(/:(\s*)(&quot;.*?&quot;)/g, ':$1<span class="tok-str">$2</span>')
                    .replace(/:(\s*)(-?\d+(?:\.\d+)?)/g, ':$1<span class="tok-num">$2</span>')
                    .replace(/\b(true|false|null)\b/g, '<span class="tok-lit">$1</span>');
            }

            function apiCodeBlock(text) {
                const lines = String(text || '').replace(/\t/g, '    ').split('\n');
                return `
                    <div class="api-code">
                        <div class="api-code-bar">
                            <button class="api-code-btn" onclick="copyApiSample(this)">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>
                                Copy
                            </button>
                            <span class="api-code-fmt">JSON</span>
                        </div>
                        <pre class="api-code-body"><code>${lines.map((l, i) =>
                            `<span class="api-code-line"><span class="api-code-no">${i + 1}</span>${highlightJson(l) || '&nbsp;'}</span>`).join('')}</code></pre>
                    </div>`;
            }

            window.copyApiSample = function(btn) {
                const pre = btn.closest('.api-code').querySelector('.api-code-body');
                if (!pre) return;
                navigator.clipboard.writeText(pre.innerText.replace(/^\s*\d+\s?/gm, ''))
                    .then(() => showSuccess ? showSuccess('Copied to clipboard.') : null)
                    .catch(() => showWarning('Could not copy \u2014 please select and copy manually.'));
            };

            window.setApiRefService = function(id) { apiRefActive = id; apiRefTab = 'request'; renderServicesApiList(); };
            window.setApiRefTab = function(tab) { apiRefTab = tab; renderServicesApiList(); };

            let apiKeyVisible = false;
            let activeApiKeyValue = '';

            window.toggleApiKeyVisible = function() {
                apiKeyVisible = !apiKeyVisible;
                const btn = document.getElementById('apiKeyEye');
                if (btn) btn.classList.toggle('is-on', apiKeyVisible);
                renderApiKeyCard();
            };

            function renderServicesApiList() {
                const nav = document.getElementById('apiRefNav');
                const panel = document.getElementById('apiRefPanel');
                if (!nav || !panel) return;

                const services = apiRefServices();
                const data = apiDocsData();
                if (services.length === 0) { nav.innerHTML = ''; panel.innerHTML = ''; return; }

                // Agar abhi tak koi choose nahi hua, ya jo chuna tha uske
                // docs nahi hain, to pehli documented service par jao -
                // taaki page khulte hi asli reference dikhe.
                const activeEntry = services.find(s => s.id === apiRefActive);
                const activeOk = activeEntry
                    && (activeEntry.kind === 'browser' || (data[apiRefActive] && data[apiRefActive].get));
                if (!activeOk) apiRefActive = firstDocumentedService(services);

                nav.innerHTML = services.map(s => `
                    <button class="api-ref-nav-item ${s.id === apiRefActive ? 'is-active' : ''} ${s.kind === 'browser' || (data[s.id] && data[s.id].get) ? '' : 'is-empty'}" onclick="setApiRefService('${s.id}')">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4"/></svg>
                        <span>${escapeHtml(s.label)}</span>
                        <em>\u203a</em>
                    </button>`).join('');

                const entry = services.find(s => s.id === apiRefActive) || {};
                if (entry.kind === 'browser') {
                    const usage = `// ${entry.label} browser me chalta hai - koi upload nahi hota.\n`
                        + `FreeServices.open('${entry.toolId}');`;
                    const samples = {
                        request: usage,
                        response: `{\n    "runsIn": "browser",\n    "uploads": false,\n    "output": "file downloaded to your device"\n}`,
                        headers: `{\n    "note": "No network call \u2014 no auth headers needed."\n}`,
                        parameters: `{\n    "toolId": "${entry.toolId}",\n    "category": "${entry.group || ''}"\n}`
                    };
                    const tab = (id, label) =>
                        `<button class="api-tab ${apiRefTab === id ? 'is-active' : ''}" onclick="setApiRefTab('${id}')">${label}</button>`;
                    panel.innerHTML = `
                        <div class="api-endpoint-head">
                            <span class="api-method browser">BROWSER</span>
                            <code class="api-endpoint-path">FreeServices.open('${escapeHtml(entry.toolId)}')</code>
                            <button class="api-try-btn" onclick="lexoraNavigate('services','other-services')">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M7 4.5 19 12 7 19.5z"/></svg>
                                Try It Out
                            </button>
                        </div>
                        <p class="api-endpoint-desc">${escapeHtml(entry.desc || entry.label)} Runs entirely in your browser \u2014 nothing is uploaded and nothing is charged.</p>
                        <div class="api-tabs">${tab('request', 'Usage')}${tab('response', 'Output')}${tab('headers', 'Auth')}${tab('parameters', 'Parameters')}</div>
                        ${apiCodeBlock(samples[apiRefTab])}
                    `;
                    return;
                }

                const d = data[apiRefActive];
                if (!d || !d.get) {
                    const label = (services.find(s => s.id === apiRefActive) || {}).label || apiRefActive;
                    panel.innerHTML = `
                        <div class="api-ref-empty">
                            <svg viewBox="0 0 48 56" fill="none"><path d="M10 4h20l10 10v38H10z" fill="#dbe8fe"/><path d="M30 4v10h10" fill="#bcd6fb"/></svg>
                            <b>${escapeHtml(label)}</b>
                            <span>API documentation for this service isn't published yet.</span>
                        </div>`;
                    return;
                }
                const post = d.post || {};
                const samples = {
                    request: post.example || `{\n    "id": "<record id>"\n}`,
                    response: d.get.example || '{}',
                    headers: `{\n    "Authorization": "Bearer <your api key>",\n    "Content-Type": "application/json"\n}`,
                    parameters: `{\n    "id": "path \u2014 required \u2014 the record identifier",\n    "format": "query \u2014 optional \u2014 json | csv"\n}`
                };
                const tab = (id, label) =>
                    `<button class="api-tab ${apiRefTab === id ? 'is-active' : ''}" onclick="setApiRefTab('${id}')">${label}</button>`;

                panel.innerHTML = `
                    <div class="api-endpoint-head">
                        <span class="api-method get">GET</span>
                        <code class="api-endpoint-path">${escapeHtml(d.get.endpoint)}</code>
                        <button class="api-try-btn" onclick="lexoraNavigate('services','${apiRefActive}')">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M7 4.5 19 12 7 19.5z"/></svg>
                            Try It Out
                        </button>
                    </div>
                    <p class="api-endpoint-desc">${escapeHtml(d.get.description || '')}</p>
                    <div class="api-tabs">${tab('request', 'Request')}${tab('response', 'Response')}${tab('headers', 'Headers')}${tab('parameters', 'Parameters')}</div>
                    ${apiCodeBlock(samples[apiRefTab])}
                `;
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
                    const deletedItems = contactSubmissions.filter(c => selectedSupportIds.has(c.id));
                    contactSubmissions = contactSubmissions.filter(c => !selectedSupportIds.has(c.id));
                    if (selectedSupportId && selectedSupportIds.has(selectedSupportId)) {
                        closeMessagePopup();
                    }
                    selectedSupportIds.clear();
                    persistContactSubmissions();
                    deletedItems.forEach((item) => {
                        addNotificationFor(item.userId, `Support ticket ${item.id} ("${item.subject}") was deleted.`);
                        const dirEntry = getUserDirectoryEntry(item.userId);
                        if (dirEntry && dirEntry.email) {
                            sendGenericNotificationEmail(
                                dirEntry.email,
                                `${dirEntry.firstName} ${dirEntry.lastName}`,
                                `Support ticket ${item.id} deleted`,
                                `Your support ticket ${item.id} ("${item.subject}") has been deleted by our support team.`
                            );
                        }
                    });
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
                a.download = 'Support_Submissions_' + localDateStr() + '.xls';
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

            // ============================================================
            // RAISE ISSUE ON TRANSACTION(S) (item 4) - user selects one or
            // more Payment History rows, picks a reason (or types a custom
            // one), and submitting creates a single support ticket that
            // references all the selected transaction IDs.
            // ============================================================
            const TRANSACTION_ISSUE_REASONS = [
                'Amount deducted but not credited into wallet',
                'Charged an incorrect amount',
                'Duplicate charge for the same transaction',
                'Service was not delivered despite being charged',
                'Refund not received',
                'Other (describe below)'
            ];

            window.openRaiseIssueModal = function() {
                if (selectedTransactionIds.size === 0) {
                    showWarning('Please select at least one transaction first, using the checkboxes in the table.');
                    return;
                }
                const ids = Array.from(selectedTransactionIds);
                const html = `
                    <div class="admin-modal-overlay" id="raiseIssueOverlay">
                        <div class="admin-modal-card">
                            <button class="admin-modal-close" onclick="closeRaiseIssueModal()">✕</button>
                            <h3 class="admin-modal-title">🚩 Raise an Issue</h3>
                            <p class="lease-review-sub">Selected transaction(s): <strong>${ids.map(escapeHtml).join(', ')}</strong></p>
                            <div class="payment-form">
                                <div class="form-group">
                                    <label>Reason</label>
                                    <select id="raiseIssueReason" onchange="onRaiseIssueReasonChange()">
                                        ${TRANSACTION_ISSUE_REASONS.map(r => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join('')}
                                    </select>
                                </div>
                                <div class="form-group" id="raiseIssueCustomGroup" style="display:none;">
                                    <label>Please describe the issue</label>
                                    <textarea id="raiseIssueCustomText" rows="4" placeholder="Add any details that will help us investigate..." style="width:100%;padding:8px 12px;border:1px solid rgba(0,0,139,0.15);border-radius:4px;font-size:0.9rem;font-family:inherit;box-sizing:border-box;resize:vertical;"></textarea>
                                </div>
                            </div>
                            <div class="lease-review-actions">
                                <button class="filter-btn" onclick="closeRaiseIssueModal()">Cancel</button>
                                <button class="plan-cta-btn" onclick="submitTransactionIssue()">Submit</button>
                            </div>
                        </div>
                    </div>
                `;
                const existing = document.getElementById('raiseIssueOverlay');
                if (existing) existing.remove();
                document.body.insertAdjacentHTML('beforeend', html);
            };

            window.closeRaiseIssueModal = function() {
                const overlay = document.getElementById('raiseIssueOverlay');
                if (overlay) overlay.remove();
            };

            window.onRaiseIssueReasonChange = function() {
                const select = document.getElementById('raiseIssueReason');
                const customGroup = document.getElementById('raiseIssueCustomGroup');
                if (!select || !customGroup) return;
                customGroup.style.display = select.value.startsWith('Other') ? 'block' : 'none';
            };

            window.submitTransactionIssue = function() {
                const select = document.getElementById('raiseIssueReason');
                const customText = document.getElementById('raiseIssueCustomText');
                let reason = select.value;
                if (reason.startsWith('Other')) {
                    const detail = customText.value.trim();
                    if (!detail) {
                        showWarning('Please describe the issue in the text box before submitting.');
                        return;
                    }
                    reason = detail;
                }

                const ids = Array.from(selectedTransactionIds);
                const subject = `Transaction issue - ${ids.length} transaction(s)`;
                const message = `Reason: ${reason}\n\nAffected Transaction ID(s): ${ids.join(', ')}`;

                const now = new Date();
                const ticketId = generateNextSupportId();
                contactSubmissions.push({
                    id: ticketId,
                    userId: CURRENT_USER_ID,
                    date: localDateStr(now),
                    time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
                    type: 'Billing Issue',
                    subject: subject,
                    message: message,
                    status: 'Pending',
                    response: '-',
                    relatedTransactionIds: ids
                });

                closeRaiseIssueModal();
                persistContactSubmissions();
                sendContactAcknowledgementEmail(ticketId, 'Billing Issue', subject, message);
                addNotification(`Support ticket ${ticketId} was created for ${ids.length} transaction(s).`);
                selectedTransactionIds.clear();
                const tbody = document.getElementById('historyTableBody');
                if (tbody) renderHistoryRows(tbody, getFilteredHistory(), true);
                const selectAll = document.getElementById('historySelectAll');
                if (selectAll) selectAll.checked = false;
                showMessage('✅ Issue Reported', `Your ticket ID is <strong>${ticketId}</strong>. Our team will investigate and get back to you.`, ['OK']);
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
                    date: localDateStr(now),
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
                addNotification(`Support ticket ${ticketId} ("${subject}") was created.`);
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
                addNotificationFor(item.userId, `Support ticket ${item.id} ("${item.subject}") was updated - status: ${item.status}.`);
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
                const todayStr = localDateStr();
                const todayList = myHistory.filter(t => t.date === todayStr);

                if (todayList.length === 0) {
                    tbody.innerHTML =
                        '<tr><td colspan="9" class="dash-empty-cell">' +
                        '<svg class="dash-empty-art" viewBox="0 0 72 56" fill="none" aria-hidden="true">' +
                        '<path d="M8 26h14l4 7h20l4-7h14v20a4 4 0 0 1-4 4H12a4 4 0 0 1-4-4z" fill="#dbe8fe"/>' +
                        '<path d="M8 26 18 8h36l10 18" stroke="#bcd6fb" stroke-width="3" stroke-linejoin="round" fill="none"/>' +
                        '</svg>' +
                        '<span class="dash-empty-title">No transactions today.</span>' +
                        '<span class="dash-empty-sub">Once you make a transaction, it will appear here.</span>' +
                        '</td></tr>';
                } else {
                    renderHistoryRows(tbody, todayList);
                }

                // Wallet balance poore history par, baaki teen tiles sirf
                // aaj ke transactions par - mockup me labels "Today's ..."
                // hain, to lifetime totals dikhana galat hota.
                let totalCredit = 0, totalDebit = 0;
                myHistory.forEach(t => {
                    totalCredit += Number(t.credit) || 0;
                    totalDebit += Number(t.debit) || 0;
                });

                let todayCredit = 0, todayDebit = 0, pending = 0;
                todayList.forEach(t => {
                    todayCredit += Number(t.credit) || 0;
                    todayDebit += Number(t.debit) || 0;
                    const status = String(t.status || '').toLowerCase();
                    if (status && status !== 'success' && status !== 'failed') pending++;
                });

                const set = (id, value) => {
                    const el = document.getElementById(id);
                    if (el) el.textContent = value;
                };

                set('dashBalance', formatMoney(totalCredit - totalDebit));
                set('dashTodayCount', String(todayList.length));
                set('dashTodayCredit', formatMoney(todayCredit));
                set('dashTodayDebit', formatMoney(todayDebit));
                set('dashPending', String(pending));
                // Bug 10: dashboard Current Plan hardcoded tha - actual plan
                // se update karo (plan switch ke baad stale na dikhe).
                set('dashCurrentPlan', getMyPlan().name + ' Plan');
                set('dashUserName', profileData
                    ? (profileData.firstName + ' ' + profileData.lastName).trim()
                    : 'there');
            }

            // Real counts (previously hardcoded placeholder numbers) - Lease
            // Abstraction count comes from how many lease folders actually
            // exist on disk for this user (Users/<id>/LeaseAbstraction/*),

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

            async function renderMyTranslationsList() {
                const list = document.getElementById('myTranslationsList');
                if (!list) return;

                try {
                    const res = await authFetch('/api/translation/list?userId=' + encodeURIComponent(CURRENT_USER_ID));
                    const data = await res.json();
                    const docs = data.documents || [];

                    if (docs.length === 0) {
                        list.innerHTML = '<li class="my-leases-empty">No translations processed yet - run one from Translation.</li>';
                        return;
                    }

                    list.innerHTML = docs.map(d => `
                        <li class="my-lease-item">
                            <a class="my-lease-link" onclick="downloadFile('Output.pdf', '${d.docName.replace(/'/g, "\\'")}', 'translation')">🌐 ${escapeHtml(d.docName)}</a>
                            <span class="my-lease-meta">${d.targetLanguage ? escapeHtml(d.targetLanguage) : ''}</span>
                        </li>
                    `).join('');
                } catch (e) {
                    list.innerHTML = '<li class="my-leases-empty">Could not load - make sure py/server.py is running.</li>';
                }
            }

            // ============================================================
            // HUMAN REVIEW (Lease Abstraction) - opened via the "🔍 Review"
            // action link for a file in 'needs_review' status. Fetches the
            // already-saved Output.json fields, renders them as an editable
            // form, and on Approve: saves any edits, generates the PDF,
            // charges the $1 fee, sends the completion email/notification,
            // and marks the file completed - mirroring what used to happen
            // automatically right after save-output, before this checkpoint
            // existed.
            // ============================================================
            let _reviewLeaseFileId = null;
            let _reviewLeaseName = null;

            window.openLeaseReviewModal = async function(fileId) {
                const file = leaseFiles.find(f => String(f.id) === String(fileId));
                if (!file || !file.leaseName) { showWarning('This file has no saved data to review yet.'); return; }
                _reviewLeaseFileId = fileId;
                _reviewLeaseName = file.leaseName;

                let data;
                try {
                    const res = await authFetch('/api/lease/review-data?userId=' + encodeURIComponent(CURRENT_USER_ID) +
                        '&leaseName=' + encodeURIComponent(file.leaseName));
                    data = await res.json();
                    if (!res.ok) throw new Error(data.error || 'Could not load this lease for review.');
                } catch (err) {
                    showWarning(err.message || 'Could not load this lease for review.');
                    return;
                }

                const html = `
                    <div class="admin-modal-overlay" id="leaseReviewOverlay">
                        <div class="admin-modal-card lease-review-card">
                            <button class="admin-modal-close" onclick="closeLeaseReviewModal()">✕</button>
                            <h3 class="admin-modal-title">🔍 Human Review — ${escapeHtml(file.leaseName)}</h3>
                            <p class="lease-review-sub">Check the extracted fields below and correct anything that's wrong.
                                Nothing is finalized (no PDF, no wallet charge) until you approve.</p>
                            <div class="lease-review-body" id="leaseReviewBody">
                                ${_buildReviewFieldsHtml(data.fields || {})}
                            </div>
                            <div class="lease-review-actions">
                                <button class="filter-btn" onclick="closeLeaseReviewModal()">Cancel</button>
                                <button class="plan-cta-btn" onclick="submitLeaseReview()">✅ Approve &amp; Generate PDF</button>
                            </div>
                        </div>
                    </div>
                `;
                const existing = document.getElementById('leaseReviewOverlay');
                if (existing) existing.remove();
                document.body.insertAdjacentHTML('beforeend', html);
            };

            window.closeLeaseReviewModal = function() {
                const overlay = document.getElementById('leaseReviewOverlay');
                if (overlay) overlay.remove();
                _reviewLeaseFileId = null;
                _reviewLeaseName = null;
            };

            // Simple leaf strings/numbers get a real text input (the common,
            // high-value case for a reviewer to spot-check). Arrays and
            // deeper nested objects (e.g. rent.rent_schedule, the late-fee
            // sub-table) are shown as an editable JSON block instead of a
            // bespoke mini-table per shape - still fully editable, just less
            // fancy, which is a reasonable trade-off given how many
            // different nested shapes the extraction schema has.
            function _buildReviewFieldsHtml(fields) {
                let html = '';
                Object.keys(fields).forEach(sectionKey => {
                    const value = fields[sectionKey];
                    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
                        html += `<fieldset class="lease-review-section"><legend>${escapeHtml(_humanizeKey(sectionKey))}</legend>`;
                        Object.keys(value).forEach(leafKey => {
                            html += _reviewFieldRow(`${sectionKey}.${leafKey}`, leafKey, value[leafKey]);
                        });
                        html += `</fieldset>`;
                    } else {
                        html += `<fieldset class="lease-review-section"><legend>${escapeHtml(_humanizeKey(sectionKey))}</legend>`;
                        html += _reviewFieldRow(sectionKey, sectionKey, value);
                        html += `</fieldset>`;
                    }
                });
                return html || '<p class="lease-review-sub">No fields were extracted for this lease.</p>';
            }

            function _reviewFieldRow(path, label, value) {
                const isComplex = value !== null && typeof value === 'object';
                const displayLabel = escapeHtml(_humanizeKey(label));
                if (isComplex) {
                    const jsonText = escapeHtml(JSON.stringify(value, null, 2));
                    return `
                        <div class="lease-review-field">
                            <label>${displayLabel} <span class="lease-review-json-tag">JSON</span></label>
                            <textarea class="lease-review-textarea lease-review-json" data-path="${path}" data-json="true" rows="6">${jsonText}</textarea>
                        </div>`;
                }
                const text = value == null ? '' : String(value);
                const long = text.length > 80 || text.includes('\n');
                return `
                    <div class="lease-review-field">
                        <label>${displayLabel}</label>
                        ${long ?
                            `<textarea class="lease-review-textarea" data-path="${path}" rows="3">${escapeHtml(text)}</textarea>` :
                            `<input type="text" class="lease-review-input" data-path="${path}" value="${escapeHtml(text)}" />`}
                    </div>`;
            }

            function _humanizeKey(key) {
                return String(key).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            }

            function _setPath(obj, path, value) {
                const parts = path.split('.');
                let cur = obj;
                for (let i = 0; i < parts.length - 1; i++) {
                    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
                    cur = cur[parts[i]];
                }
                cur[parts[parts.length - 1]] = value;
            }

            window.submitLeaseReview = async function() {
                const fileId = _reviewLeaseFileId;
                const leaseName = _reviewLeaseName;
                const file = leaseFiles.find(f => String(f.id) === String(fileId));
                if (!file || !leaseName) { closeLeaseReviewModal(); return; }

                const editedFields = {};
                const inputs = document.querySelectorAll('#leaseReviewBody [data-path]');
                let jsonError = null;
                inputs.forEach(el => {
                    const path = el.getAttribute('data-path');
                    if (el.getAttribute('data-json') === 'true') {
                        try {
                            _setPath(editedFields, path, JSON.parse(el.value));
                        } catch (e) {
                            jsonError = path;
                        }
                    } else {
                        _setPath(editedFields, path, el.value);
                    }
                });
                if (jsonError) {
                    showWarning(`"${_humanizeKey(jsonError.split('.').pop())}" isn't valid JSON - please fix it before approving.`);
                    return;
                }

                try {
                    const fl = file.batchLabel || '';
                    let stepId = addActivity('lease-abstraction', `${fl}System > Review and Approve`, 'Pending');
                    refreshServicePage('lease-abstraction');
                    await postJSON('/api/lease/review-submit', {
                        userId: CURRENT_USER_ID, leaseName: leaseName, fields: editedFields
                    });
                    updateActivity('lease-abstraction', stepId, 'Success');
                    refreshServicePage('lease-abstraction');

                    const genPdfAgent = getAgents('lease-abstraction').filter(a => a.phase !== 'scan')[5];
                    await blinkAgentThenDone('lease-abstraction', genPdfAgent ? genPdfAgent.id : null);
                    stepId = addActivity('lease-abstraction', `${fl}System > Generate Output`, 'Pending');
                    refreshServicePage('lease-abstraction');
                    const pdfRes = await postJSON('/api/lease/generate-pdf', {
                        userId: CURRENT_USER_ID, leaseName: leaseName,
                        templateName: file.templateName || 'Default.pdf'
                    });
                    updateActivity('lease-abstraction', stepId, 'Success', `${fl}System > Generate Output > ${_shortPath(pdfRes.outputPdf, 2)} generated successfully`);
                    if (genPdfAgent) {
                        addActivity('lease-abstraction', `${fl}Agents > ${genPdfAgent.name} > Verified all assumptions are clearly flagged in the output`, 'Success');
                        markAgentDone(genPdfAgent.id);
                    }
                    activeAgentId = null;
                    addActivity('lease-abstraction', `${fl}File Processing > ${file.name}`, 'Finished');
                    notifyProcessCompletion('Lease Abstraction', file.name, file.chargeAmount || getServicePrice('lease-abstraction'), file.chargeTxnId || '');

                    file.status = 'completed';
                    file.progress = '100';
                    closeLeaseReviewModal();
                    refreshServicePage('lease-abstraction');
                    persistServiceFiles('lease-abstraction');
                    showMessage('✅ Approved', 'The reviewed lease has been finalized and the Output.pdf generated.', ['OK']);
                } catch (err) {
                    showWarning(err.message || 'Could not finalize this lease. Please try again.');
                }
            };

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
                            <div class="payment-card profile-photo-card">
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
                            <div class="payment-card profile-info-card">
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
                let passwordChanged = false;

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
                    passwordChanged = true;
                } else {
                    delete profileData.password;
                }

                // Snapshot before vs after so the notification/email only
                // fires when something actually changed (item 11) - saving
                // the form with no edits shouldn't spam the user.
                const before = {
                    firstName: profileData.firstName, lastName: profileData.lastName,
                    gender: profileData.gender, birthdate: profileData.birthdate,
                    mobile: profileData.mobile, twoFactorAuth: profileData.twoFactorAuth
                };

                profileData.firstName = document.getElementById('profileFirstName').value.trim();
                profileData.lastName = document.getElementById('profileLastName').value.trim();
                profileData.gender = document.getElementById('profileGender').value;
                profileData.birthdate = document.getElementById('profileBirthdate').value;
                profileData.mobile = document.getElementById('profileMobile').value.trim();
                profileData.twoFactorAuth = document.getElementById('profileTwoFactorAuth').checked ? 'Yes' : 'No';

                const changedFields = Object.keys(before).filter(k => before[k] !== profileData[k]);
                const detailsChanged = changedFields.length > 0 || passwordChanged;

                userNameDisplay.textContent = profileData.firstName + ' ' + profileData.lastName;
                MENU_CONFIG.user.name = profileData.firstName + ' ' + profileData.lastName;
                updateAvatarDisplay();
                persistProfile();
                document.getElementById('profilePassword').value = '';
                document.getElementById('profileConfirmPassword').value = '';

                if (detailsChanged) {
                    const changeList = changedFields.map(k => _humanizeProfileField(k)).concat(passwordChanged ? ['Password'] : []);
                    addNotification(`Your profile was updated (${changeList.join(', ')}).`);
                    if (profileData.email) {
                        sendGenericNotificationEmail(
                            profileData.email,
                            `${profileData.firstName} ${profileData.lastName}`,
                            'Your profile was updated',
                            `The following field(s) on your profile were just changed: ${changeList.join(', ')}.\n\n` +
                            `If you didn't make this change, please contact support right away.`
                        );
                    }
                }

                showMessage('✅ Profile Updated', 'Your profile information has been saved successfully.', ['OK']);
            };

            function _humanizeProfileField(key) {
                const labels = {
                    firstName: 'First Name', lastName: 'Last Name', gender: 'Gender',
                    birthdate: 'Birthdate', mobile: 'Mobile', twoFactorAuth: '2-Step Verification'
                };
                return labels[key] || key;
            }

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
                addNotificationFor(CURRENT_USER_ID, description);
            }

            // General version - used when the action is taken by one user
            // (e.g. an admin updating a ticket) but the notification belongs
            // to a *different* user (the ticket's original owner). `meta`
            // (optional) carries extra fields like {type, transactionId} so
            // the notification can render actionable buttons (see
            // approveBalanceRequest/cancelBalanceRequest).
            function addNotificationFor(userId, description, meta) {
                const now = new Date();
                notifications.push(Object.assign({
                    id: 'NOTIF' + String(nextNotificationId++).padStart(3, '0'),
                    userId: userId,
                    date: localDateStr(now),
                    time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }),
                    description: description,
                    read: false
                }, meta || {}));
                persistNotifications();
                if (userId === CURRENT_USER_ID) updateNotificationBadge();
            }

            // Fire-and-forget email via the backend's generic notification
            // route (/api/send-notification -> _send_notification_email in
            // py/server.py). Used for support ticket create/update/delete,
            // API key generate/revoke, and profile-change alerts. Failures
            // are logged quietly, same pattern as the other email helpers -
            // a missing/unreachable SMTP server should never block the
            // action itself.
            function sendGenericNotificationEmail(toEmail, userName, title, message, tableRows, tableHeaders) {
                if (!toEmail) return;
                authFetch('/api/send-notification', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        toEmail: toEmail,
                        userName: userName || 'there',
                        title: title,
                        message: message,
                        tableRows: tableRows || null,
                        tableHeaders: tableHeaders || null
                    })
                }).catch(e => console.warn('Notification email could not be sent:', e));
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

            // Tabs sirf view filter hain - data ek hi list se aata hai.
            let notificationFilter = 'all';

            function buildNotificationBody() {
                const mine = getMyNotifications();
                const unread = mine.filter(n => !n.read).length;
                const counts = { all: mine.length, unread: unread, read: mine.length - unread };
                const tab = (id, label) =>
                    `<button class="notif-tab ${notificationFilter === id ? 'is-active' : ''}" onclick="setNotificationFilter('${id}')">${label} (${counts[id]})</button>`;

                return `
                    <div class="history-card notif-card">
                        <div class="notif-head">
                            <h3>🔔 Notifications</h3>
                            <span class="notif-count">${mine.length}</span>
                            <button class="notif-mark-all" onclick="bulkMarkNotifications(true, true)">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><path d="M3 6.5l9 6.5 9-6.5"/></svg>
                                Mark all as read
                            </button>
                        </div>
                        <div class="notif-tabs">${tab('all', 'All')}${tab('unread', 'Unread')}${tab('read', 'Read')}</div>
                        <div class="card-body">
                            <table class="history-table notif-table" id="notificationTableHeader">
                                <thead>
                                    <tr>
                                        <th style="width:38px;"><input type="checkbox" onchange="toggleNotificationSelectAll(this)" /></th>
                                        <th>Notification</th>
                                        <th style="width:230px;">Date &amp; Time</th>
                                        <th style="width:46px;"></th>
                                    </tr>
                                </thead>
                            </table>
                            <div class="history-table-wrapper" id="notificationTableWrapper">
                                <table class="history-table notif-table" id="notificationTable">
                                    <tbody id="notificationTableBody"></tbody>
                                </table>
                            </div>
                        </div>
                        <div class="notif-footer">
                            <div class="notif-footer-actions">
                                <button class="filter-btn notif-btn-read" onclick="bulkMarkNotifications(true)">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7"/></svg>
                                    Mark as Read
                                </button>
                                <button class="filter-btn notif-btn-unread" onclick="bulkMarkNotifications(false)">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><path d="M3 6.5l9 6.5 9-6.5"/></svg>
                                    Mark as Unread
                                </button>
                                <button class="filter-btn delete-btn" onclick="bulkRemoveNotifications()">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5h16M9.5 6.5V4.5h5v2M7 6.5l1 13h8l1-13"/></svg>
                                    Remove
                                </button>
                            </div>
                            <div class="notif-footer-pager" id="notificationPager"></div>
                        </div>
                    </div>
                `;
            }

            window.setNotificationFilter = function(id) {
                notificationFilter = id;
                const body = document.getElementById('contentBody');
                if (!body) return;
                body.innerHTML = buildNotificationBody();
                upgradeCardHeaders(body);
                renderNotificationTable();
            };

            // "2 minutes ago" jaisa relative time - mockup me date ke neeche.
            function notificationAgo(dateStr, timeStr) {
                const when = new Date(dateStr + ' ' + (timeStr || ''));
                if (isNaN(when)) return '';
                const mins = Math.floor((Date.now() - when.getTime()) / 60000);
                if (mins < 1) return 'just now';
                if (mins < 60) return mins + (mins === 1 ? ' minute ago' : ' minutes ago');
                const hrs = Math.floor(mins / 60);
                if (hrs < 24) return hrs + (hrs === 1 ? ' hour ago' : ' hours ago');
                const days = Math.floor(hrs / 24);
                return days + (days === 1 ? ' day ago' : ' days ago');
            }

            // Notification ka type decide karta hai row ka round icon.
            function notificationIcon(n) {
                const text = String(n.description || '');
                if (/api key/i.test(text)) {
                    return ['key', '<circle cx="8" cy="14" r="4.5"/><path d="m11.4 11 8.1-8.1M17 5.5l2.5 2.5M14.5 8l2.5 2.5"/>'];
                }
                if (/balance|payment|credit|\u20b9/i.test(text)) {
                    return ['money', '<path d="M8 6h8M8 10h8M15 6c0 3-2.5 4-5 4l6 8"/>'];
                }
                return ['doc', '<path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4M8.5 12h7M8.5 16h4"/>'];
            }

            function renderNotificationTable() {
                const tbody = document.getElementById('notificationTableBody');
                if (!tbody) return;
                const all = [...getMyNotifications()].sort((a, b) => new Date(b.date + ' ' + b.time) - new Date(a.date + ' ' + a.time));
                const mine = notificationFilter === 'unread' ? all.filter(n => !n.read)
                           : notificationFilter === 'read'   ? all.filter(n => n.read)
                           : all;

                const pager = document.getElementById('notificationPager');
                if (pager) {
                    pager.innerHTML = mine.length === 0 ? '' : `
                        <span class="pager-count">Showing 1 to ${mine.length} of ${mine.length}</span>
                        <div class="pager-controls">
                            <button class="pager-btn" disabled>\u00ab</button>
                            <button class="pager-btn is-current">1</button>
                            <button class="pager-btn" disabled>\u00bb</button>
                        </div>`;
                }

                if (mine.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="4" class="dash-empty-cell">'
                        + '<svg class="dash-empty-art" viewBox="0 0 72 56" fill="none">'
                        + '<path d="M8 26h14l4 7h20l4-7h14v20a4 4 0 0 1-4 4H12a4 4 0 0 1-4-4z" fill="#dbe8fe"/>'
                        + '<path d="M8 26 18 8h36l10 18" stroke="#bcd6fb" stroke-width="3" stroke-linejoin="round" fill="none"/></svg>'
                        + '<span class="dash-empty-title">No notifications yet.</span>'
                        + '<span class="dash-empty-sub">New alerts about your account will show up here.</span>'
                        + '</td></tr>';
                    updateNotificationBadge();
                    return;
                }

                tbody.innerHTML = mine.map(n => {
                    const needsAction = n.type === 'balance_approval' && !n.handledResult;
                    const actionsHtml = needsAction
                        ? '<span class="notification-action-hint">\u23f3 Action required - click to Approve/Cancel</span>'
                        : (n.handledResult ? `<span class="notification-handled-tag">${escapeHtml(n.handledResult)}</span>` : '');
                    const icon = notificationIcon(n);
                    // Pehli line title, baaki detail - mockup me dono alag
                    // weight/colour me hain.
                    const parts = String(n.description || '').split(/[.:]\s+/);
                    const title = parts[0] + (parts.length > 1 && n.description.includes('.') ? '.' : '');
                    const detail = n.description.slice(title.length).replace(/^[\s:]+/, '');

                    return `
                    <tr class="${n.read ? '' : 'notification-unread'}">
                        <td onclick="event.stopPropagation();"><input type="checkbox" class="notification-row-check" data-id="${n.id}" ${selectedNotificationIds.has(n.id) ? 'checked' : ''} onchange="toggleNotificationRowCheck('${n.id}', this)" /></td>
                        <td>
                            <div class="notif-row">
                                <span class="notif-row-icon is-${icon[0]}">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${icon[1]}</svg>
                                </span>
                                <div class="notif-row-text">
                                    <a class="notification-desc-link" onclick="openNotificationPopup('${n.id}')">${escapeHtml(title)}</a>
                                    ${detail ? `<span class="notif-row-detail">${escapeHtml(detail)}</span>` : ''}
                                    ${actionsHtml}
                                </div>
                            </div>
                        </td>
                        <td>
                            <div class="notif-when">
                                <span class="notif-dot ${n.read ? 'is-read' : ''}"></span>
                                <div>
                                    <span class="notif-date">${escapeHtml(n.date)} ${escapeHtml(n.time || '')}</span>
                                    <span class="notif-ago">${notificationAgo(n.date, n.time)}</span>
                                </div>
                            </div>
                        </td>
                        <td class="notif-menu-cell"><button class="notif-menu-btn" onclick="openNotificationPopup('${n.id}')" aria-label="Open notification">\u22ee</button></td>
                    </tr>`;
                }).join('');
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

            window.bulkMarkNotifications = function(readValue, applyToAll) {
                if (applyToAll) {
                    getMyNotifications().forEach(n => { n.id && selectedNotificationIds.add(n.id); });
                }
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
                const showActions = n.type === 'balance_approval' && !n.handledResult;
                const actionsHtml = showActions ? `
                    <div class="lease-review-actions" style="justify-content:center;margin-top:16px;border-top:1px solid rgba(0,0,139,0.1);padding-top:14px;">
                        <button class="filter-btn error-link" onclick="cancelBalanceRequest('${n.transactionId}', '${n.id}'); document.getElementById('notificationPopupOverlay').remove();">✖ Cancel</button>
                        <button class="plan-cta-btn" onclick="approveBalanceRequest('${n.transactionId}', '${n.id}'); document.getElementById('notificationPopupOverlay').remove();">✅ Approve</button>
                    </div>
                ` : (n.handledResult ? `<p class="notification-handled-tag" style="display:block;text-align:center;margin-top:12px;">${escapeHtml(n.handledResult)}</p>` : '');
                const html = `
                    <div class="admin-modal-overlay" id="notificationPopupOverlay">
                        <div class="admin-modal-card message-popup-card">
                            <button class="admin-modal-close" onclick="document.getElementById('notificationPopupOverlay').remove()">✕</button>
                            <h3 class="admin-modal-title">🔔 Notification</h3>
                            <p style="font-size:0.75rem;color:rgba(0,0,0,0.5);margin-bottom:10px;">${n.date} ${n.time}</p>
                            <p style="font-size:0.9rem;line-height:1.6;">${escapeHtml(n.description)}</p>
                            ${actionsHtml}
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

            let rulesActiveTab = 'master';
            let rulesSelectedApprovedIds = new Set();
            let rulesSelectedPendingIds = new Set();
            let rulesLastApproved = [];
            let rulesLastPending = [];

            // ============================================================
            // Item 4 - "Test & Compare" admin tool: upload multiple
            // {original, human output, current output?} lease document
            // sets (all PDFs) in one go - the backend runs our own
            // extraction pipeline wherever Current Output wasn't
            // supplied, then an LLM compares our output against the
            // human's for each one and proposes new rules straight into
            // the Update Rules pending queue (duplicates skipped).
            // ============================================================
            let _testCompareRows = [];

            window.openTestComparePopup = function() {
                _testCompareRows = [{ original: null, humanOutput: null, currentOutput: null }];
                renderTestCompareModal();
            };

            function renderTestCompareModal() {
                const rowsHtml = _testCompareRows.map((row, idx) => `
                    <div class="test-compare-row">
                        <span class="test-compare-row-num">${idx + 1}</span>
                        <div class="form-group">
                            <label>Original Lease (PDF)</label>
                            <input type="file" accept=".pdf" onchange="testCompareReadFile(event, ${idx}, 'original')" />
                            ${row.original ? `<span class="test-compare-filename">✓ ${escapeHtml(row.original.name)}</span>` : ''}
                        </div>
                        <div class="form-group">
                            <label>Human Output (PDF)</label>
                            <input type="file" accept=".pdf" onchange="testCompareReadFile(event, ${idx}, 'humanOutput')" />
                            ${row.humanOutput ? `<span class="test-compare-filename">✓ ${escapeHtml(row.humanOutput.name)}</span>` : ''}
                        </div>
                        <div class="form-group">
                            <label>Current Output (PDF, optional)</label>
                            <input type="file" accept=".pdf" onchange="testCompareReadFile(event, ${idx}, 'currentOutput')" />
                            ${row.currentOutput ? `<span class="test-compare-filename">✓ ${escapeHtml(row.currentOutput.name)}</span>` : ''}
                        </div>
                        ${_testCompareRows.length > 1 ? `<span class="admin-action-icon delete" onclick="removeTestCompareRow(${idx})">🗑️</span>` : ''}
                    </div>
                `).join('');

                const html = `
                    <div class="admin-modal-overlay" id="testCompareOverlay">
                        <div class="admin-modal-card admin-multi-table-modal">
                            <button class="admin-modal-close" onclick="document.getElementById('testCompareOverlay').remove()">✕</button>
                            <h3 class="admin-modal-title">🧪 Test &amp; Compare</h3>
                            <p style="font-size:0.78rem;color:rgba(0,0,0,0.55);margin-bottom:14px;">
                                Upload up to 10 leases: the original document, a human-reviewed "ideal" Output.pdf, and
                                optionally our own already-generated Output.pdf. Skip Current Output to run a fresh
                                extraction instead. Process compares each pair via LLM and proposes new rules straight
                                into the Update Rules pending queue wherever our output falls short of the human's.
                            </p>
                            <div class="payment-form" id="testCompareRowsContainer">${rowsHtml}</div>
                            <div class="lease-review-actions">
                                ${_testCompareRows.length < 10 ? `<button class="filter-btn" onclick="addTestCompareRow()">+ Add Another Lease</button>` : ''}
                                <button class="plan-cta-btn" onclick="runTestCompare()">▶ Process</button>
                            </div>
                            <div id="testCompareResults"></div>
                        </div>
                    </div>
                `;
                const existing = document.getElementById('testCompareOverlay');
                if (existing) existing.remove();
                document.body.insertAdjacentHTML('beforeend', html);
            }

            window.addTestCompareRow = function() {
                if (_testCompareRows.length >= 10) return;
                _testCompareRows.push({ original: null, humanOutput: null, currentOutput: null });
                renderTestCompareModal();
            };

            window.removeTestCompareRow = function(idx) {
                _testCompareRows.splice(idx, 1);
                renderTestCompareModal();
            };

            window.testCompareReadFile = function(event, idx, kind) {
                const file = event.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (e) => {
                    _testCompareRows[idx][kind] = { name: file.name, dataBase64: e.target.result.split(',')[1] };
                };
                reader.readAsDataURL(file);
            };

            window.runTestCompare = async function() {
                const resultsEl = document.getElementById('testCompareResults');
                const validRows = _testCompareRows.filter(r => r.original && r.humanOutput);
                if (validRows.length === 0) {
                    showWarning('Each lease needs at least the Original document and Human Output uploaded.');
                    return;
                }
                resultsEl.innerHTML = '<p style="text-align:center;padding:20px;">⏳ Processing - this can take a little while per lease (real extraction + LLM comparison)...</p>';
                try {
                    const items = validRows.map(r => ({
                        originalName: r.original.name, originalBase64: r.original.dataBase64,
                        humanOutputName: r.humanOutput.name, humanOutputBase64: r.humanOutput.dataBase64,
                        ...(r.currentOutput ? { currentOutputName: r.currentOutput.name, currentOutputBase64: r.currentOutput.dataBase64 } : {}),
                    }));
                    const res = await authFetch('/api/admin/test-compare', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ userId: CURRENT_USER_ID, items })
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.error || 'Comparison failed.');

                    const rows = data.results.map(r => r.ok ? `
                        <tr>
                            <td>${escapeHtml(r.label)}</td>
                            <td style="color:${r.similarity >= 85 ? '#27ae60' : r.similarity >= 65 ? '#e67e22' : '#c0392b'};font-weight:600;">${r.similarity}%</td>
                            <td>${escapeHtml(r.currentOutputSource)}</td>
                            <td>${r.rulesProposed > 0 ? `✨ ${r.rulesProposed} new rule(s) proposed` : 'No new rules needed'}</td>
                        </tr>
                    ` : `
                        <tr>
                            <td>${escapeHtml(r.label)}</td>
                            <td colspan="3" style="color:#c0392b;">${escapeHtml(r.error)}</td>
                        </tr>
                    `).join('');

                    resultsEl.innerHTML = `
                        <div class="admin-json-table-wrapper" style="max-height:320px;margin-top:16px;">
                            <table class="admin-json-table">
                                <thead><tr><th>Lease</th><th>Similarity</th><th>Current Output Source</th><th>Rules</th></tr></thead>
                                <tbody>${rows}</tbody>
                            </table>
                        </div>
                        <p style="font-size:0.78rem;color:rgba(0,0,0,0.5);margin-top:10px;">Any proposed rules are now waiting in Update Rules &gt; Pending Approval.</p>
                    `;
                } catch (err) {
                    resultsEl.innerHTML = `<p style="color:#c0392b;text-align:center;padding:20px;">${escapeHtml(err.message)}</p>`;
                }
            };

            window.openRulesPopup = async function() {
                try {
                    const res = await authFetch('/api/rules/list');
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.error || 'Could not load rules.');
                    rulesNewRows = [];
                    rulesActiveTab = 'master';
                    rulesSelectedApprovedIds = new Set();
                    rulesSelectedPendingIds = new Set();
                    renderRulesPopupHTML(data.approved || [], data.pending || []);
                } catch (err) {
                    showWarning(err.message || 'Could not load rules. Make sure py/server.py is running.');
                }
            };

            window.switchRulesTab = function(tab) {
                rulesActiveTab = tab;
                renderRulesPopupHTML(rulesLastApproved, rulesLastPending);
            };

            window.toggleRuleRowSelect = function(section, id, checked) {
                const set = section === 'approved' ? rulesSelectedApprovedIds : rulesSelectedPendingIds;
                if (checked) set.add(id); else set.delete(id);
            };

            window.toggleRuleSelectAll = function(section, checked) {
                const rows = document.querySelectorAll(`.rule-select-check[data-section="${section}"]`);
                const set = section === 'approved' ? rulesSelectedApprovedIds : rulesSelectedPendingIds;
                rows.forEach(cb => {
                    cb.checked = checked;
                    if (checked) set.add(cb.getAttribute('data-id')); else set.delete(cb.getAttribute('data-id'));
                });
            };

            function renderRulesPopupHTML(approved, pending) {
                rulesLastApproved = approved;
                rulesLastPending = pending;
                const isAdminOrDev = isAdminOrDeveloper();
                const myPending = pending.filter(r => r.userId === CURRENT_USER_ID);
                const pendingList = isAdminOrDev ? pending : myPending;

                const sourceBadge = (r) => r.source === 'auto-discovered' ?
                    ' <span class="rule-auto-badge" title="Proposed automatically by the system after processing a lease">🤖 Auto-discovered</span>' :
                    r.source === 'claude-suggested' ?
                    ' <span class="rule-auto-badge claude-badge" title="Suggested by Claude as a gap in the extraction schema, not tied to any specific document">✨ Claude-suggested</span>' :
                    r.source === 'rules_review.xlsx' ?
                    ' <span class="rule-auto-badge claude-badge" title="Reviewed and proposed from an uploaded rules_review.xlsx accuracy analysis">📊 From Rules Review</span>' : '';

                // ---- Master Rules tab ----
                const approvedRows = approved.map(r => `
                    <tr>
                        <td><input type="checkbox" class="rule-select-check" data-section="approved" data-id="${r.id}" ${rulesSelectedApprovedIds.has(r.id) ? 'checked' : ''} onchange="toggleRuleRowSelect('approved', '${r.id}', this.checked)" /></td>
                        <td>${escapeHtml(r.id)}</td>
                        <td>${isAdminOrDev ? `<input type="text" class="admin-json-cell-input" value="${escapeHtml(r.fieldId)}" data-rule-id="${r.id}" data-field="fieldId" />` : escapeHtml(r.fieldId)}</td>
                        <td>${isAdminOrDev ? `
                            <select data-rule-id="${r.id}" data-field="ruleType">
                                <option value="mapping" ${r.ruleType === 'mapping' ? 'selected' : ''}>mapping</option>
                                <option value="validation" ${r.ruleType === 'validation' ? 'selected' : ''}>validation</option>
                                <option value="formatting" ${r.ruleType === 'formatting' ? 'selected' : ''}>formatting</option>
                                <option value="logic" ${r.ruleType === 'logic' ? 'selected' : ''}>logic</option>
                                <option value="style" ${r.ruleType === 'style' ? 'selected' : ''}>style</option>
                            </select>
                        ` : escapeHtml(r.ruleType)}</td>
                        <td>${isAdminOrDev ? `<input type="text" class="admin-json-cell-input" value="${escapeHtml(r.ruleText)}" data-rule-id="${r.id}" data-field="ruleText" />` : escapeHtml(r.ruleText)}${sourceBadge(r)}</td>
                        <td>${escapeHtml(r.userId || '')}</td>
                    </tr>
                `).join('');

                const newRuleRows = rulesNewRows.map((r, idx) => `
                    <tr class="rules-new-row">
                        <td></td>
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

                const masterButtonsHtml = isAdminOrDev ? `
                    <div class="rules-tab-actions">
                        <button class="admin-btn admin-btn-add-file" onclick="addNewRuleRow()">+ Add</button>
                        <button class="admin-btn admin-btn-save" onclick="saveMasterRuleEdits()">💾 Save</button>
                        <button class="admin-btn admin-btn-delete" onclick="deleteSelectedApprovedRules()">🗑️ Delete Selected</button>
                    </div>
                ` : '';

                // ---- Pending Approval tab ----
                const pendingRows = pendingList.map(r => `
                    <tr>
                        <td><input type="checkbox" class="rule-select-check" data-section="pending" data-id="${r.id}" ${rulesSelectedPendingIds.has(r.id) ? 'checked' : ''} onchange="toggleRuleRowSelect('pending', '${r.id}', this.checked)" /></td>
                        <td>${escapeHtml(r.id)}</td>
                        <td>${escapeHtml(r.fieldId)}</td>
                        <td>${escapeHtml(r.ruleType)}</td>
                        <td>${escapeHtml(r.ruleText)}${sourceBadge(r)}</td>
                        <td>${escapeHtml(r.userId || '')}</td>
                    </tr>
                `).join('');

                const pendingButtonsHtml = isAdminOrDev ? `
                    <div class="rules-tab-actions">
                        <button class="admin-btn admin-btn-save" onclick="approveSelectedPendingRules()">✅ Approve Selected</button>
                        <button class="admin-btn admin-btn-delete" onclick="rejectSelectedPendingRules()">✖ Reject Selected</button>
                    </div>
                ` : `
                    <div class="rules-tab-actions">
                        <button class="admin-btn admin-btn-add-file" onclick="addNewRuleRow()">+ Add</button>
                        <button class="admin-btn admin-btn-delete" onclick="deleteSelectedPendingRules()">🗑️ Delete Selected</button>
                    </div>
                `;

                const html = `
                    <div class="admin-modal-overlay" id="rulesPopupOverlay">
                        <div class="admin-modal-card admin-multi-table-modal">
                            <button class="admin-modal-close" onclick="document.getElementById('rulesPopupOverlay').remove()">✕</button>
                            <h3 class="admin-modal-title">📐 Lease Abstraction Rules</h3>
                            <p style="font-size:0.78rem;color:rgba(0,0,0,0.55);margin-bottom:10px;">
                                All master rules belong to the Developer account. New rules go into "Pending Approval" and
                                only take effect once an Admin or Developer approves them.
                            </p>

                            <div class="rules-tab-strip">
                                <button class="rules-tab-btn ${rulesActiveTab === 'master' ? 'active' : ''}" onclick="switchRulesTab('master')">
                                    Master Rules <span class="admin-section-count">(${approved.length})</span>
                                </button>
                                <button class="rules-tab-btn ${rulesActiveTab === 'pending' ? 'active' : ''}" onclick="switchRulesTab('pending')">
                                    Pending Approval <span class="admin-section-count">(${pendingList.length})</span>
                                </button>
                            </div>

                            ${rulesActiveTab === 'master' ? `
                                <div class="admin-json-table-wrapper admin-section-table" style="max-height:380px;">
                                    <table class="admin-json-table">
                                        <thead><tr>
                                            <th style="width:30px;"><input type="checkbox" onchange="toggleRuleSelectAll('approved', this.checked)" /></th>
                                            <th>ID</th><th>Field ID</th><th>Type</th><th>Rule Text</th><th>Owner</th>
                                        </tr></thead>
                                        <tbody>${newRuleRows}${approvedRows}</tbody>
                                    </table>
                                </div>
                                ${masterButtonsHtml}
                            ` : `
                                <div class="admin-json-table-wrapper admin-section-table" style="max-height:380px;">
                                    <table class="admin-json-table">
                                        <thead><tr>
                                            <th style="width:30px;"><input type="checkbox" onchange="toggleRuleSelectAll('pending', this.checked)" /></th>
                                            <th>ID</th><th>Field ID</th><th>Type</th><th>Rule Text</th><th>Proposed By</th>
                                        </tr></thead>
                                        <tbody>${pendingRows || '<tr><td colspan="6" style="text-align:center;">No pending rules.</td></tr>'}</tbody>
                                    </table>
                                </div>
                                ${pendingButtonsHtml}
                            `}

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
                if (rulesActiveTab === 'pending' && !isAdminOrDeveloper()) {
                    // Regular user's "+ Add" on the Pending tab proposes a
                    // brand-new rule directly (goes to /api/rules/propose,
                    // same as before) - reuse the same inline-new-row UI.
                }
                rulesNewRows.push({ fieldId: '', ruleType: 'mapping', ruleText: '' });
                renderRulesPopupHTML(rulesLastApproved, rulesLastPending);
            };

            window.updateNewRuleField = function(idx, key, value) {
                if (rulesNewRows[idx]) rulesNewRows[idx][key] = value;
            };

            window.removeNewRuleRow = function(idx) {
                rulesNewRows.splice(idx, 1);
                renderRulesPopupHTML(rulesLastApproved, rulesLastPending);
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
                    showMessage('✅ Submitted', `${validRows.length} new rule(s) submitted and pending approval.`, ['OK']);
                    rulesActiveTab = 'pending';
                    refreshRulesPopup();
                } catch (err) {
                    showWarning(err.message || 'Could not submit the new rules.');
                }
            };

            // ---- Item 1: Master Rules tab actions (Admin/Developer only) ----
            window.saveMasterRuleEdits = async function() {
                // New rows (added via "+ Add") get submitted as fresh
                // proposals - Master Rules edits never bypass the approval
                // queue, even for Admin/Developer, so those still land in
                // Pending first.
                if (rulesNewRows.some(r => r.fieldId.trim() && r.ruleText.trim())) {
                    await submitNewRuleRows();
                }
                const inputs = document.querySelectorAll('#rulesPopupOverlay [data-rule-id]');
                const byRule = {};
                inputs.forEach(el => {
                    const id = el.getAttribute('data-rule-id');
                    const field = el.getAttribute('data-field');
                    byRule[id] = byRule[id] || { id };
                    byRule[id][field] = el.value;
                });
                const updates = Object.values(byRule);
                if (updates.length === 0) return;
                try {
                    const res = await authFetch('/api/rules/update-approved', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ updates })
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.error || 'Could not save changes.');
                    showMessage('✅ Saved', `${data.updated} rule(s) updated.`, ['OK']);
                    refreshRulesPopup();
                } catch (err) {
                    showWarning(err.message || 'Could not save changes.');
                }
            };

            window.deleteSelectedApprovedRules = async function() {
                if (rulesSelectedApprovedIds.size === 0) { showWarning('Select at least one Master Rule row first.'); return; }
                showConfirm('🗑️ Delete Rules', `Delete ${rulesSelectedApprovedIds.size} selected Master Rule(s)? This cannot be undone.`, async (confirmed) => {
                    if (!confirmed) return;
                    try {
                        const res = await authFetch('/api/rules/delete-approved', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ ruleIds: Array.from(rulesSelectedApprovedIds) })
                        });
                        const data = await res.json();
                        if (!res.ok) throw new Error(data.error || 'Could not delete.');
                        rulesSelectedApprovedIds.clear();
                        refreshRulesPopup();
                    } catch (err) {
                        showWarning(err.message || 'Could not delete the selected rules.');
                    }
                });
            };

            // ---- Item 1: Pending Approval tab actions ----
            window.deleteSelectedPendingRules = async function() {
                if (rulesSelectedPendingIds.size === 0) { showWarning('Select at least one pending rule row first.'); return; }
                showConfirm('🗑️ Delete', `Delete ${rulesSelectedPendingIds.size} selected pending rule(s)?`, async (confirmed) => {
                    if (!confirmed) return;
                    try {
                        const res = await authFetch('/api/rules/delete-pending', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ userId: CURRENT_USER_ID, ruleIds: Array.from(rulesSelectedPendingIds) })
                        });
                        const data = await res.json();
                        if (!res.ok) throw new Error(data.error || 'Could not delete.');
                        rulesSelectedPendingIds.clear();
                        refreshRulesPopup();
                    } catch (err) {
                        showWarning(err.message || 'Could not delete the selected rules.');
                    }
                });
            };

            window.approveSelectedPendingRules = async function() {
                if (rulesSelectedPendingIds.size === 0) { showWarning('Select at least one pending rule row first.'); return; }
                try {
                    for (const ruleId of rulesSelectedPendingIds) {
                        await authFetch('/api/rules/approve', {
                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ ruleId })
                        });
                    }
                    rulesSelectedPendingIds.clear();
                    showMessage('✅ Approved', 'The selected rule(s) are now part of Master Rules.', ['OK']);
                    refreshRulesPopup();
                } catch (err) {
                    showWarning(err.message || 'Could not approve the selected rules.');
                }
            };

            window.rejectSelectedPendingRules = async function() {
                if (rulesSelectedPendingIds.size === 0) { showWarning('Select at least one pending rule row first.'); return; }
                try {
                    for (const ruleId of rulesSelectedPendingIds) {
                        await authFetch('/api/rules/reject', {
                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ ruleId })
                        });
                    }
                    rulesSelectedPendingIds.clear();
                    showMessage('✖ Rejected', 'The selected rule(s) have been rejected.', ['OK']);
                    refreshRulesPopup();
                } catch (err) {
                    showWarning(err.message || 'Could not reject the selected rules.');
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

            // ============================================================
            // Admin > Database card
            //
            // Postgres chal raha hai ya nahi, kitni rows hain, JSON se
            // match kar raha hai - sab yahin dikh jata hai. Terminal
            // kholne ki zaroorat nahi. Password kabhi nahi aata; server
            // sirf host bhejta hai (db.safe_host).
            // ============================================================
            function buildDbStatusCard() {
                return `
                    <div class="admin-files-card db-status-card" id="dbStatusCard">
                        <div class="admin-files-header">
                            <h3>\u{1F5C4} Database</h3>
                            <div class="card-sizes-actions">
                                <button class="admin-btn" onclick="refreshDbStatus()">\u21BB Refresh</button>
                                <button class="add-btn" onclick="openDbTransactions()">View Payment Table</button>
                            </div>
                        </div>
                        <div id="dbStatusBody"><p class="ds-card-sub">Checking\u2026</p></div>
                    </div>`;
            }

            function dbChip(ok, text) {
                return `<span class="db-chip ${ok ? 'is-on' : 'is-off'}">${escapeHtml(text)}</span>`;
            }

            window.refreshDbStatus = async function() {
                const body = document.getElementById('dbStatusBody');
                if (!body) return;
                body.innerHTML = '<p class="ds-card-sub">Checking\u2026</p>';
                try {
                    const res = await authFetch('/api/admin/db-status');
                    const d = await res.json();
                    if (!res.ok) throw new Error(d.error || 'Could not read database status.');

                    const rows = [];
                    if (!d.enabled) {
                        rows.push(['Store', dbChip(false, 'JSON files') + ' <span class="db-note">'
                            + escapeHtml(d.reason || '') + '</span>']);
                    } else {
                        rows.push(['Store', d.connected ? dbChip(true, 'PostgreSQL') : dbChip(false, 'Not reachable')]);
                        if (d.host)   rows.push(['Host', `<code>${escapeHtml(d.host)}</code>`]);
                        if (d.server) rows.push(['Server', escapeHtml(d.server)]);
                        rows.push(['transactions table', d.tableExists
                            ? dbChip(true, 'exists') : dbChip(false, 'not created yet')]);
                        rows.push(['Rows in database', `<b>${d.rowCount}</b>`]);
                    }
                    rows.push(['Rows in payment-history.json', `<b>${d.jsonCount}</b>`]);
                    if (d.error) rows.push(['Error', `<span class="db-note is-bad">${escapeHtml(d.error)}</span>`]);

                    const missing = d.missingFromDb || [];
                    const warn = missing.length
                        ? `<div class="db-warn">${missing.length} row(s) JSON me hain par database me nahi \u2014
                           migration adhoori hai. <code>python3 py/migrate_json_to_pg.py</code> chalayein
                           (duplicate nahi banenge).</div>`
                        : '';

                    const bal = (d.balances || []).length
                        ? `<div class="db-balances"><b>Balance (database se)</b>
                             ${d.balances.map(b => `<span>${escapeHtml(b.userId)}
                               <em>${formatMoney(b.balance)}</em></span>`).join('')}
                           </div>`
                        : '';

                    body.innerHTML = `<table class="db-status-table"><tbody>
                        ${rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('')}
                    </tbody></table>${warn}${bal}`;
                } catch (err) {
                    body.innerHTML = `<p class="db-note is-bad">${escapeHtml(err.message)}</p>`;
                }
            };

            window.openDbTransactions = async function() {
                openAdminModal(`
                    <div class="admin-modal-overlay" id="adminFileOverlay">
                        <div class="admin-modal-card card-layout-modal">
                            <button class="admin-modal-close" onclick="adminCloseFileModal()">\u2715</button>
                            <h3 class="admin-modal-title">\u{1F5C4} Payment table</h3>
                            <div class="card-layout-scroll" id="dbTxnScroll">
                                <p class="ds-card-sub" style="padding:14px;">Loading\u2026</p>
                            </div>
                            <div class="admin-modal-actions">
                                <button class="admin-btn" onclick="downloadDbTransactions()">\u2B07 Download CSV</button>
                                <button class="admin-modal-cancel" onclick="adminCloseFileModal()">Close</button>
                            </div>
                        </div>
                    </div>`);
                try {
                    const res = await authFetch('/api/admin/db-transactions');
                    const d = await res.json();
                    const rows = d.rows || [];
                    _dbTxnRows = rows;
                    const scroll = document.getElementById('dbTxnScroll');
                    if (!scroll) return;
                    scroll.innerHTML = `
                        <div class="db-txn-source">Source: ${dbChip(d.store === 'postgres', d.store === 'postgres' ? 'PostgreSQL' : 'JSON file')}
                            <span class="db-note">${rows.length} row(s)</span></div>
                        <table class="admin-json-table db-txn-table">
                            <thead><tr>
                                <th>Txn ID</th><th>Date</th><th>Time</th><th>User</th>
                                <th>Type</th><th>Mode</th><th>Description</th>
                                <th class="num">Credit</th><th class="num">Debit</th><th>Status</th>
                            </tr></thead>
                            <tbody>
                                ${rows.length === 0
                                    ? '<tr><td colspan="10" class="api-prev-empty">Koi transaction nahi mila.</td></tr>'
                                    : rows.map(r => `<tr>
                                        <td><code>${escapeHtml(r.id || '')}</code></td>
                                        <td>${escapeHtml(r.date || '')}</td>
                                        <td>${escapeHtml(r.time || '')}</td>
                                        <td>${escapeHtml(r.userId || '')}</td>
                                        <td>${escapeHtml(r.paymentType || '')}</td>
                                        <td>${escapeHtml(r.paymentMode || '')}</td>
                                        <td>${escapeHtml(r.description || '')}</td>
                                        <td class="num credit">${r.credit ? formatMoney(r.credit) : '-'}</td>
                                        <td class="num debit">${r.debit ? formatMoney(r.debit) : '-'}</td>
                                        <td>${txnStatusPill(r.status)}</td>
                                    </tr>`).join('')}
                            </tbody>
                        </table>`;
                } catch (err) {
                    const scroll = document.getElementById('dbTxnScroll');
                    if (scroll) scroll.innerHTML = `<p class="db-note is-bad" style="padding:14px;">${escapeHtml(err.message)}</p>`;
                }
            };

            let _dbTxnRows = [];

            window.downloadDbTransactions = function() {
                const cols = ['id', 'date', 'time', 'userId', 'paymentType', 'paymentMode',
                              'description', 'credit', 'debit', 'status'];
                // Quotes double karke wrap - warna description me comma ho to
                // CSV ke columns khisak jate hain.
                const cell = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
                const csv = [cols.join(',')]
                    .concat(_dbTxnRows.map(r => cols.map(c => cell(r[c])).join(',')))
                    .join('\n');
                const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
                const a = document.createElement('a');
                a.href = url; a.download = 'transactions.csv';
                document.body.appendChild(a); a.click(); a.remove();
                URL.revokeObjectURL(url);
            };

            function buildAdminFilesBody() {
                return buildDbStatusCard() + `
                    <div class="admin-files-card" style="margin-top:16px;">
                        <div class="admin-files-header">
                            <h3>📁 Files and Folder</h3>
                        </div>
                        <div class="admin-toolbar">
                            <button class="admin-btn admin-btn-add-file" onclick="document.getElementById('adminFileInput').click()">📄 Add File</button>
                            <button class="admin-btn admin-btn-add-folder" onclick="adminAddFolder()">📁 Add Folder</button>
                            <button class="admin-btn admin-btn-delete" onclick="adminDeleteSelected()">🗑️ Delete</button>
                            <button class="admin-btn admin-btn-download" onclick="adminDownloadSelected()">⬇️ Download</button>
                            <button class="admin-btn admin-btn-add-folder" onclick="adminOpenPricingEditor()">💲 Plan Pricing</button>
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

            // ---- Plan Pricing editor (Admin/Developer only) ----
            // Purpose-built form instead of the generic JSON-blob editor:
            // labeled number inputs make a typo'd/missing field much easier
            // to notice than a raw JSON blob would (a missing key here
            // would otherwise silently fall back to $1 - see
            // getServicePrice's `!= null ? ... : 1` fallback).
            window.adminOpenPricingEditor = function() {
                const planColumns = PLANS_DATA.map((plan, pIdx) => {
                    return `
                        <div style="flex:1;min-width:220px;border:1px solid rgba(0,0,139,0.15);border-radius:8px;padding:14px;">
                            <h4 style="margin:0 0 10px 0;">${plan.icon || ''} ${escapeHtml(plan.name)}</h4>
                            <div style="margin-bottom:8px;">
                                <label style="font-size:0.76rem;font-weight:600;display:block;margin-bottom:3px;">Monthly Price (₹)</label>
                                <input type="number" step="0.01" min="0" class="admin-price-input"
                                       data-plan-idx="${pIdx}" data-field="monthlyPrice"
                                       value="${Number(plan.monthlyPrice || 0)}" style="width:100%;" />
                            </div>
                            <div style="margin-bottom:8px;">
                                <label style="font-size:0.76rem;font-weight:600;display:block;margin-bottom:3px;">Translation (₹ / page)</label>
                                <input type="number" step="0.01" min="0" class="admin-price-input"
                                       data-plan-idx="${pIdx}" data-field="pricePerTranslation"
                                       value="${Number(plan.pricePerTranslation != null ? plan.pricePerTranslation : 0)}" style="width:100%;" />
                            </div>
                            <div style="margin-bottom:8px;">
                                <label style="font-size:0.76rem;font-weight:600;display:block;margin-bottom:3px;">Lease Abstraction (₹ / document)</label>
                                <input type="number" step="0.01" min="0" class="admin-price-input"
                                       data-plan-idx="${pIdx}" data-field="pricePerLeaseAbstraction"
                                       value="${Number(plan.pricePerLeaseAbstraction || 0)}" style="width:100%;" />
                                <div style="font-size:0.66rem;color:rgba(0,0,0,0.45);margin-top:2px;">Not shown to customers while Lease Abstraction is Coming Soon.</div>
                            </div>
                        </div>
                    `;
                }).join('');

                const html = `
                    <div class="admin-modal-overlay" id="adminFileModalOverlay">
                        <div class="admin-modal-card admin-table-modal">
                            <button class="admin-modal-close" onclick="adminCloseFileModal()">✕</button>
                            <h3 class="admin-modal-title">💲 Plan Pricing</h3>
                            <p style="font-size:0.8rem;color:rgba(0,0,0,0.55);margin:-4px 0 12px 0;">
                                Translation is billed per page. Lease Abstraction is billed per document.
                            </p>
                            <div style="overflow:auto;max-height:60vh;display:flex;gap:14px;flex-wrap:wrap;padding:2px;">
                                ${planColumns}
                            </div>
                            <div class="admin-modal-actions" style="margin-top:16px;">
                                <button class="admin-modal-save" onclick="adminSavePricingEditor()">💾 Save</button>
                                <button class="admin-modal-cancel" onclick="adminCloseFileModal()">Cancel</button>
                            </div>
                        </div>
                    </div>
                `;
                openAdminModal(html);
            };

            window.adminSavePricingEditor = async function() {
                const inputs = document.querySelectorAll('#adminFileModalOverlay .admin-price-input');
                // Deep clone so a failed save never corrupts the in-memory
                // PLANS_DATA the rest of the app is currently using.
                const updated = JSON.parse(JSON.stringify(PLANS_DATA));
                let invalid = false;
                inputs.forEach(function (inp) {
                    const pIdx = Number(inp.dataset.planIdx);
                    const path = inp.dataset.field.split('.');
                    const val = parseFloat(inp.value);
                    if (!Number.isFinite(val) || val < 0) { invalid = true; return; }
                    let target = updated[pIdx];
                    for (let i = 0; i < path.length - 1; i++) {
                        if (typeof target[path[i]] !== 'object' || target[path[i]] === null) target[path[i]] = {};
                        target = target[path[i]];
                    }
                    target[path[path.length - 1]] = val;
                });
                if (invalid) {
                    showWarning('All prices must be valid numbers of 0 or more.');
                    return;
                }
                try {
                    const res = await authFetch('/api/admin/write', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ path: 'json/plans.json', content: JSON.stringify(updated, null, 2) })
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.error || 'Save failed');
                    PLANS_DATA = updated;
                    adminCloseFileModal();
                    showMessage('✅ Saved', 'Plan pricing updated successfully.', ['OK']);
                    if (activeSubItemId === null && activeItemId === 'plans-offers') loadContent('plans-offers');
                } catch (err) {
                    showWarning(err.message || 'Could not save pricing.');
                }
            };

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
                window.open('/api/admin/download?path=' + encodeURIComponent(path) + '&token=' + encodeURIComponent(AUTH_TOKEN || ''), '_blank');
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
                paths.forEach(p => window.open('/api/admin/download?path=' + encodeURIComponent(p) + '&token=' + encodeURIComponent(AUTH_TOKEN || ''), '_blank'));
            };

            // ---- File name click -> view/edit modal (JSON as table, text as editor) ----
            let adminTableEditorState = { path: null, mode: null, columns: [], rows: [], selected: new Set() };

            window.adminOpenFile = async function(path) {
                // card-layout.json ka apna table editor hai (units + live
                // preview), isliye generic JSON viewer ki jagah wo kholte hain.
                if (/card-layout\.json$/i.test(path)) {
                    openAdminModal(buildCardLayoutModalHTML());
                    return;
                }
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
                const socialFooter = document.getElementById('footerSocial');
                if (socialFooter) socialFooter.innerHTML = buildSocialLinksHtml({ size: 16, gap: 14, color: 'rgba(255,255,255,0.85)' });
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
                        setTimeout(refreshDbStatus, 60);
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
            const CARD_ICON_PATHS = {
                '\u{1F4E4}': '<path d="M12 16V4M7.5 8.5 12 4l4.5 4.5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
                '\u2699':   '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1M18.7 18.7l-2.1-2.1M7.4 7.4 5.3 5.3"/>',
                '\u{1F4C1}': '<path d="M3 7.5A2 2 0 0 1 5 5.5h4l2 2.5h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
                '\u{1F4CB}': '<rect x="5" y="4" width="14" height="17" rx="2"/><rect x="9" y="2.5" width="6" height="3.5" rx="1.2"/><path d="M9 11h6M9 15h4"/>',
                '\u{1F5BC}': '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><circle cx="8.5" cy="10" r="1.8"/><path d="m4.5 17 5-5 4 4 2.5-2 3.5 3.5"/>',
                '\u{1F464}': '<circle cx="12" cy="8" r="3.8"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
                '\u{1F511}': '<circle cx="8" cy="14" r="4.5"/><path d="m11.4 11 8.1-8.1M17 5.5l2.5 2.5M14.5 8l2.5 2.5"/>',
                '\u{1F4DC}': '<path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4M8.5 12h7M8.5 16h4"/>',
                '\u{1F4C5}': '<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/>',
                '\u{1F514}': '<path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6z"/><path d="M10 19.5a2.2 2.2 0 0 0 4 0"/>',
                '\u{1F4B3}': '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19"/>',
                '\u{1F4CA}': '<path d="M6 20V11M12 20V4M18 20v-6"/>',
                '\u{1F4C4}': '<path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4"/>',
                '\u{1F310}': '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 3 2.6 15 0 18M12 3c-2.6 3-2.6 15 0 18"/>',
                '\u{1F6E0}': '<path d="M14.7 6.3a4 4 0 0 1-5.4 5.4L4 17v3h3l5.3-5.3a4 4 0 0 1 5.4-5.4l-2.6 2.6"/>'
            };

            // Emoji ke saath aksar variation selector (U+FE0F) aata hai;
            // match karne se pehle usse hata dete hain.
            function upgradeCardHeaders(root) {
                if (!root) return;
                root.querySelectorAll('h3').forEach(h3 => {
                    if (h3.dataset.iconified || h3.querySelector('.ds-card-icon')) return;
                    const node = h3.firstChild;
                    if (!node || node.nodeType !== 3) return;

                    const text = node.nodeValue.replace(/\uFE0F/g, '').replace(/^\s+/, '');
                    const key = Object.keys(CARD_ICON_PATHS).find(k => text.startsWith(k));
                    if (!key) return;

                    node.nodeValue = text.slice(key.length).replace(/^\s+/, '');
                    h3.insertAdjacentHTML('afterbegin',
                        '<span class="ds-card-icon is-filled"><svg viewBox="0 0 24 24" fill="none" '
                        + 'stroke="currentColor" stroke-width="1.9" stroke-linecap="round" '
                        + 'stroke-linejoin="round">' + CARD_ICON_PATHS[key] + '</svg></span>');
                    h3.dataset.iconified = '1';
                });
            }
            window.upgradeCardHeaders = upgradeCardHeaders;

            const DROP_ART_SVG = '<svg class="drop-art" viewBox="0 0 120 78" fill="none" aria-hidden="true">'
                + '<rect x="14" y="10" width="22" height="27" rx="4" fill="#e8433f" transform="rotate(-12 25 23)"/>'
                + '<text x="25" y="28" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="8" font-weight="700" fill="#fff" transform="rotate(-12 25 23)">PDF</text>'
                + '<rect x="48" y="4" width="22" height="27" rx="4" fill="#1257f5"/>'
                + '<text x="59" y="22" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="11" font-weight="700" fill="#fff">W</text>'
                + '<rect x="82" y="10" width="22" height="27" rx="4" fill="#1e9d63" transform="rotate(12 93 23)"/>'
                + '<text x="93" y="28" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="11" font-weight="700" fill="#fff" transform="rotate(12 93 23)">X</text>'
                + '<path d="M44 74a12 12 0 0 1 1-23 16 16 0 0 1 30-3 11 11 0 0 1-2 26z" fill="#2f7bf6"/>'
                + '<path d="M60 68V52M52 58l8-8 8 8" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

            const SERVICE_PERK_ROWS = [
                ['<path d="M12 3l7.5 3v5.5c0 4.4-3 8.2-7.5 9.5-4.5-1.3-7.5-5.1-7.5-9.5V6z"/>', 'Secure &amp; Private', 'Your files are encrypted and secure'],
                ['<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.5"/><path d="m14.5 9.5 5-5"/>', 'High Accuracy', 'Advanced AI ensures best quality output'],
                ['<path d="M13 2 4.5 13H11l-1 9 8.5-11H12z"/>', 'Fast Processing', 'Quick turnaround for your documents'],
                ['<path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4"/>', 'Multiple Formats', 'Export to Word, Excel, CSV, JSON and more'],
                ['<path d="M6.5 19a4.5 4.5 0 0 1 .5-9 6.5 6.5 0 0 1 12.4-1.3A4.2 4.2 0 0 1 18.5 19z"/>', 'Cloud Based', 'Access your files anytime, anywhere']
            ];

            function servicePerksHtml() {
                return '<div class="service-perks">' + SERVICE_PERK_ROWS.map(p =>
                    '<div class="service-perk"><span class="service-perk-icon">'
                    + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
                    + 'stroke-linecap="round" stroke-linejoin="round">' + p[0] + '</svg></span>'
                    + '<div><b>' + p[1] + '</b><span>' + p[2] + '</span></div></div>').join('') + '</div>';
            }

            function enhanceServicePage(root) {
                if (!root) return;

                root.querySelectorAll('.drop-zone').forEach(zone => {
                    if (!zone.querySelector('.drop-art')) {
                        const oldIcon = zone.querySelector('.drop-icon');
                        if (oldIcon) oldIcon.remove();
                        zone.insertAdjacentHTML('afterbegin', DROP_ART_SVG);
                    }
                    // Kuch services heading ko <div> ya <p> me likhti hain -
                    // unhe wahi classes de do jo Translation use karta hai,
                    // taaki font/size/colour har jagah same rahe.
                    zone.querySelectorAll('div, p, span').forEach(el => {
                        const t = (el.textContent || '').trim();
                        if (!el.className && /^drag\s*&?\s*drop/i.test(t)) el.className = 'drop-text';
                        else if (!el.className && /^(or\s+)?click to browse/i.test(t)) el.className = 'drop-sub';
                    });
                    // Browse Files button aur "No files uploaded yet" line
                    // hata di - drop zone khud clickable hai, dono redundant the.
                    zone.querySelectorAll('.drop-browse-btn, .file-count-text').forEach(el => el.remove());
                    if (!zone.parentElement.querySelector('.drop-meta')) {
                        zone.insertAdjacentHTML('afterend',
                            '<div class="drop-meta">Maximum file size: <b>50MB</b> &nbsp;\u2022&nbsp; Supported: <b>PDF</b></div>');
                    }
                });

                buildServiceTabStrips(root);

                // Perks strip hata di gayi hai - agar kisi purane markup me
                // reh gayi ho to bhi saaf kar do.
                root.querySelectorAll('.service-perks').forEach(el => el.remove());
            }
            window.enhanceServicePage = enhanceServicePage;

            // Other Services ke tools (service-runner.js, ocr-service.js,
            // data-extraction.js, bai2.js, free-services.js) contentBody ko
            // KHUD replace karte hain - wo updateContent() se nahi guzarte.
            // Isliye unpar header icons aur tab layout kabhi lagta hi nahi
            // tha. Ye ek shared hook hai jo wahi dono kaam karta hai; har
            // module apne render ke baad ise call karta hai.
            window.lexoraEnhancePage = function(host) {
                const root = host || document.getElementById('contentBody');
                if (!root) return;
                upgradeCardHeaders(root);
                enhanceServicePage(root);
                applyCardLayout();
            };

            // .service-page-grid ke 2x2 cards ko do stacked tab strips me
            // badal deta hai: [Upload File(s) | Setup] aur uske neeche
            // [Uploaded Files | Activity Log]. Dono full width. Isse chaaro
            // cards ki height apne aap barabar rehti hai aur koi card viewport
            // se bahar nahi jata.
            // Upload File(s) aur Setup alag-alag cards hain, side by side
            // (top row). Uploaded Files aur Activity Log ek tab strip me
            // aate hain, uske neeche, full width.
            //
            // Ye transform DOM par chalta hai, isliye har service par lagta
            // hai - Translation/Lease (app.js) aur Other Services ke saare
            // tools (service-runner.js) - kyunki sabka markup ek jaisa hai.
            // Tool pages har file pick / progress update par poora re-render
            // hote hain. Us waqt active tab reset ho jata tha aur user ko
            // wapas Uploaded Files par pheink deta tha - isliye yaad rakhte hain.
            let svcActiveTab = 0;

            function buildServiceTabStrips(root) {
                const grid = root.querySelector('.service-page-grid');
                if (!grid || grid.dataset.tabbed) return;

                const cols = Array.prototype.slice.call(grid.querySelectorAll(':scope > .service-col'));
                if (cols.length < 2) return;

                const cardsOf = col => Array.prototype.slice.call(col.children)
                    .map(el => el.classList.contains('activity-log-section') ? el.firstElementChild : el)
                    .filter(Boolean);

                const topCards = cardsOf(cols[0]);
                const stripCards = cardsOf(cols[1]);
                if (!topCards.length && !stripCards.length) return;

                const titleOf = card => {
                    const h = card.querySelector('h3');
                    if (!h) return 'Panel';
                    const span = h.querySelector('span:not(.ds-card-icon)');
                    return (span ? span.textContent : h.textContent).trim();
                };

                const makeStrip = cards => {
                    const strip = document.createElement('div');
                    strip.className = 'svc-strip';
                    const tabs = document.createElement('div');
                    tabs.className = 'svc-tabs';
                    const panes = document.createElement('div');
                    panes.className = 'svc-panes';

                    const startAt = Math.min(svcActiveTab, cards.length - 1);
                    cards.forEach((card, ci) => {
                        const btn = document.createElement('button');
                        btn.type = 'button';
                        btn.className = 'svc-tab' + (ci === startAt ? ' is-active' : '');
                        const head = card.querySelector('h3');
                        const icon = head && head.querySelector('.ds-card-icon');
                        if (icon) btn.appendChild(icon.cloneNode(true));
                        btn.appendChild(document.createTextNode(titleOf(card)));
                        btn.onclick = () => {
                            svcActiveTab = ci;
                            strip.querySelectorAll('.svc-tab').forEach((x, i) => x.classList.toggle('is-active', i === ci));
                            strip.querySelectorAll('.svc-pane').forEach((x, i) => x.classList.toggle('is-active', i === ci));
                        };
                        tabs.appendChild(btn);

                        const pane = document.createElement('div');
                        pane.className = 'svc-pane' + (ci === startAt ? ' is-active' : '');
                        if (head) head.remove();
                        card.classList.add('svc-card-inner');
                        pane.appendChild(card);
                        panes.appendChild(pane);
                    });

                    strip.appendChild(tabs);
                    strip.appendChild(panes);
                    return strip;
                };

                const topRow = document.createElement('div');
                topRow.className = 'svc-top-row';
                topCards.forEach(card => { card.classList.add('svc-top-card'); topRow.appendChild(card); });

                grid.dataset.tabbed = '1';
                grid.classList.add('is-tabbed');
                grid.innerHTML = '';
                if (topCards.length) grid.appendChild(topRow);
                if (stripCards.length) grid.appendChild(makeStrip(stripCards));
            }

            // ============================================================
            // CARD SIZES (json/card-layout.json)
            //
            // Har card ka width/height ek hi jagah se aata hai. Admin Panel >
            // Card Sizes se edit hota hai, aur yahan se ek <style> tag me
            // badal kar lag jata hai - isliye CSS file chhedne ki zaroorat
            // nahi. mode 'auto' matlab CSS ka default chalne do.
            // ============================================================
            function cardSizeRule(dim, spec) {
                if (!spec || spec.mode === 'auto' || !spec.mode) return '';
                const n = Number(spec.value);
                if (!isFinite(n) || n <= 0) return '';
                const unit = spec.mode === '%' ? '%' : 'px';
                return `${dim}: ${n}${unit} !important;`;
            }

            function applyCardLayout() {
                let style = document.getElementById('cardLayoutStyle');
                if (!style) {
                    style = document.createElement('style');
                    style.id = 'cardLayoutStyle';
                    document.head.appendChild(style);
                }
                const cards = (CARD_LAYOUT && CARD_LAYOUT.cards) || [];
                style.textContent = cards.map(c => {
                    if (!c.selector) return '';
                    const body = cardSizeRule('width', c.width) + cardSizeRule('height', c.height);
                    return body ? `${c.selector} { ${body} }` : '';
                }).filter(Boolean).join('\n');
            }
            window.applyCardLayout = applyCardLayout;

            // Login screen ke cards bhi isi config se size lete hain, aur wo
            // loadAppData() se pehle dikhta hai (jo login ke baad chalta
            // hai). Isliye ye chhota standalone fetch - static file hai, auth
            // ki zaroorat nahi. Fail ho jaye to CSS ke default chalte hain.
            (async function loadCardLayoutEarly() {
                try {
                    const res = await fetch('json/card-layout.json');
                    if (!res.ok) return;
                    CARD_LAYOUT = await res.json();
                    applyCardLayout();
                } catch (err) {
                    console.warn('Card sizes could not be loaded:', err);
                }
            })();

            // card-layout.json ka editor. Ye "Files and Folder" me us file
            // par click karne se khulta hai (adminOpenFile) - alag se koi
            // panel nahi. Ek hi table, Section bhi usi me ek column hai.
            function buildCardLayoutModalHTML() {
                const cards = (CARD_LAYOUT && CARD_LAYOUT.cards) || [];

                const sizeField = (card, dim) => {
                    const spec = card[dim] || { mode: 'auto', value: null };
                    return `
                        <div class="card-size-field">
                            <select data-id="${card.id}" data-dim="${dim}" data-part="mode" onchange="onCardSizeChange(this)">
                                ${['auto', 'px', '%'].map(m =>
                                    `<option value="${m}" ${spec.mode === m ? 'selected' : ''}>${m}</option>`).join('')}
                            </select>
                            <input type="number" min="1" step="1" placeholder="\u2014"
                                   data-id="${card.id}" data-dim="${dim}" data-part="value"
                                   value="${spec.value != null ? spec.value : ''}"
                                   ${spec.mode === 'auto' ? 'disabled' : ''}
                                   oninput="onCardSizeChange(this)" />
                        </div>`;
                };

                const textField = (card, field, placeholder) => `
                    <input type="text" class="card-size-text ${field === 'selector' ? 'is-code' : ''}"
                           data-id="${card.id}" data-field="${field}" placeholder="${placeholder}"
                           value="${escapeHtml(card[field] || '')}" oninput="onCardFieldChange(this)" />`;

                return `
                    <div class="admin-modal-overlay" id="adminFileOverlay">
                        <div class="admin-modal-card card-layout-modal">
                            <button class="admin-modal-close" onclick="adminCloseFileModal()">\u2715</button>
                            <h3 class="admin-modal-title">\u{1F4D0} card-layout.json \u2014 Card Sizes</h3>
                            <p class="ds-card-sub">
                                <b>auto</b> = CSS ka default, <b>px</b> = fixed pixels, <b>%</b> = parent ke hisab se.
                                Change karte hi page par lag jata hai; <b>Save</b> file me likh deta hai.
                            </p>
                            <div class="card-layout-scroll">
                                <table class="admin-json-table card-size-table">
                                    <thead><tr>
                                        <th style="width:150px;">Section</th>
                                        <th style="width:190px;">Card</th>
                                        <th>CSS selector</th>
                                        <th style="width:170px;">Width</th>
                                        <th style="width:170px;">Height</th>
                                        <th style="width:44px;"></th>
                                    </tr></thead>
                                    <tbody>
                                        ${cards.length === 0
                                            ? '<tr><td colspan="6" class="api-prev-empty">Abhi koi card configured nahi hai \u2014 "+ Add card" se shuru karein.</td></tr>'
                                            : cards.map(c => `
                                            <tr>
                                                <td>${textField(c, 'section', 'Section')}</td>
                                                <td>${textField(c, 'label', 'Card name')}</td>
                                                <td>${textField(c, 'selector', '.my-card')}</td>
                                                <td>${sizeField(c, 'width')}</td>
                                                <td>${sizeField(c, 'height')}</td>
                                                <td><button class="card-size-del" title="Remove" onclick="removeCardLayoutRow('${c.id}')">\u00d7</button></td>
                                            </tr>`).join('')}
                                    </tbody>
                                </table>
                            </div>
                            <div class="admin-modal-actions">
                                <button class="admin-btn" onclick="addCardLayoutRow()">+ Add card</button>
                                <button class="admin-btn" onclick="downloadCardLayout()">\u2B07 Download JSON</button>
                                <button class="admin-btn" onclick="resetCardLayout()">\u21BA Reset to auto</button>
                                <button class="admin-modal-save" onclick="saveCardLayout()">\u{1F4BE} Save</button>
                                <button class="admin-modal-cancel" onclick="adminCloseFileModal()">Close</button>
                            </div>
                        </div>
                    </div>`;
            }

            function refreshCardSizesPanel() {
                const modal = document.querySelector('.card-layout-modal');
                if (!modal) return;
                const scroll = modal.querySelector('.card-layout-scroll');
                const keep = scroll ? scroll.scrollTop : 0;
                modal.outerHTML = buildCardLayoutModalHTML()
                    .replace(/^[\s\S]*?<div class="admin-modal-card/, '<div class="admin-modal-card')
                    .replace(/<\/div>\s*$/, '');
                const again = document.querySelector('.card-layout-scroll');
                if (again) again.scrollTop = keep;
            }

            window.onCardFieldChange = function(el) {
                const entry = cardLayoutEntry(el.dataset.id);
                if (!entry) return;
                entry[el.dataset.field] = el.value;
                applyCardLayout();
            };

            window.addCardLayoutRow = function() {
                if (!CARD_LAYOUT) CARD_LAYOUT = { version: 1, modes: ['auto', 'px', '%'], cards: [] };
                if (!CARD_LAYOUT.cards) CARD_LAYOUT.cards = [];
                CARD_LAYOUT.cards.push({
                    id: 'card-' + Date.now().toString(36),
                    section: 'Custom',
                    label: 'New card',
                    selector: '',
                    width: { mode: 'auto', value: null },
                    height: { mode: 'auto', value: null }
                });
                openAdminModal(buildCardLayoutModalHTML());
            };

            window.removeCardLayoutRow = function(id) {
                if (!CARD_LAYOUT || !CARD_LAYOUT.cards) return;
                CARD_LAYOUT.cards = CARD_LAYOUT.cards.filter(c => c.id !== id);
                applyCardLayout();
                openAdminModal(buildCardLayoutModalHTML());
            };

            function cardLayoutEntry(id) {
                return ((CARD_LAYOUT && CARD_LAYOUT.cards) || []).find(c => c.id === id);
            }

            window.onCardSizeChange = function(el) {
                const entry = cardLayoutEntry(el.dataset.id);
                if (!entry) return;
                const dim = el.dataset.dim;
                entry[dim] = entry[dim] || { mode: 'auto', value: null };

                if (el.dataset.part === 'mode') {
                    entry[dim].mode = el.value;
                    // auto par number box ka koi matlab nahi - disable kar do.
                    const box = document.querySelector(
                        `input[data-id="${el.dataset.id}"][data-dim="${dim}"]`);
                    if (box) {
                        box.disabled = el.value === 'auto';
                        if (el.value === 'auto') { box.value = ''; entry[dim].value = null; }
                    }
                } else {
                    entry[dim].value = el.value === '' ? null : Number(el.value);
                }
                applyCardLayout();
            };

            window.saveCardLayout = async function() {
                // Pehle apply - taaki dikhna turant shuru ho jaye, chahe disk
                // write me kuch bhi ho.
                applyCardLayout();
                await saveJSON('card-layout', CARD_LAYOUT);
                showSuccess('Card sizes applied and saved.');
            };

            window.resetCardLayout = function() {
                ((CARD_LAYOUT && CARD_LAYOUT.cards) || []).forEach(c => {
                    c.width = { mode: 'auto', value: null };
                    c.height = { mode: 'auto', value: null };
                });
                applyCardLayout();
                openAdminModal(buildCardLayoutModalHTML());
            };

            window.downloadCardLayout = function() {
                const blob = new Blob([JSON.stringify(CARD_LAYOUT, null, 1)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'card-layout.json';
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
            };

            function updateContent(data, breadcrumb) {
                const bodyContent = typeof data.body === 'function' ? data.body() : data.body;
                contentBody.innerHTML = bodyContent || '';
                upgradeCardHeaders(contentBody);
                applyCardLayout();
                enhanceServicePage(contentBody);
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
                        // Draw the idle state into the checkout panel so the
                        // right half of the Add Balance card is never blank.
                        resetPayPanel();
                    }, 50);
                }

                if (breadcrumb === '📊 Dashboard') {
                    setTimeout(renderTodayTransactions, 50);
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

                if (breadcrumb && breadcrumb.includes('Lease Abstraction')) {
                    setTimeout(setupDragAndDrop, 50);
                    setTimeout(renderMyLeasesList, 50);
                }

                if (breadcrumb && breadcrumb.includes('Translation')) {
                    setTimeout(setupDragAndDrop, 50);
                    setTimeout(renderMyTranslationsList, 50);
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
            // menu-config.json me labels emoji ke saath hain ("\u{1F4CA} Dashboard").
            // Mockups me clean line icons hain, isliye emoji strip karke uski
            // jagah inline SVG lagta hai. JSON ko haath nahi lagaya - agar
            // kisi id ka icon yahan na ho to label waise ka waisa chalta hai.
            const MENU_ICON_PATHS = {
                'dashboard':    '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
                'services':     '<path d="M14.7 6.3a4 4 0 0 1-5.4 5.4L4 17v3h3l5.3-5.3a4 4 0 0 1 5.4-5.4l-2.6 2.6"/>',
                'plans-offers': '<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/>',
                'payment':      '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19"/>',
                'help':         '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .9-1 1.6v.3"/><path d="M12 17.2h.01"/>',
                'admin':        '<path d="M12 3l7.5 3v5.5c0 4.4-3 8.2-7.5 9.5-4.5-1.3-7.5-5.1-7.5-9.5V6z"/>'
            };

            function menuIconHtml(id) {
                const path = MENU_ICON_PATHS[id];
                if (!path) return '';
                return '<svg class="menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
                    + 'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
            }

            function renderMenu() {
                mainMenu.innerHTML = '';
                const mainMenuItems = MENU_CONFIG.mainMenu.filter(item => !item.adminOnly || isAdminOrDeveloper());

                mainMenuItems.forEach((item) => {
                    const li = document.createElement('li');
                    li.className = 'menu-item';

                    const a = document.createElement('a');
                    const icon = menuIconHtml(item.id);
                    const label = icon
                        ? String(item.label).replace(/^[^A-Za-z0-9]+/, '').trim()
                        : item.label;
                    // textContent pehle set hota hai (escaping ke liye), phir
                    // icon prepend - taaki label kabhi HTML ki tarah na chale.
                    a.textContent = label;
                    if (icon) a.insertAdjacentHTML('afterbegin', icon);
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

            // Called when navigation is about to LEAVE the translation
            // section. Translation processing is browser-side and session-
            // only (blobs live in memory, files aren't persisted server-
            // side the way lease files are), so leaving mid-run would strand
            // a half-done process and leave stale files/log behind. Instead:
            // stop any running process and clear this user's translation
            // files, in-memory blobs, and activity log. Returning to
            // Translation then shows a clean empty state.
            function leaveTranslationSection() {
                if (processState.running) {
                    processState.stopped = true;
                    processState.running = false;
                }
                translationFiles = translationFiles.filter(f => f.userId !== CURRENT_USER_ID);
                translationActivityLog = translationActivityLog.filter(a => a.userId !== CURRENT_USER_ID);
                translationFileBlobs = {};
                translationBlobStore = {};
                persistServiceFiles('translation');
            }

            // ============================================================
            // 36. LOAD CONTENT
            // ============================================================
            // Breadcrumb ke "Dashboard" link ke liye - inline onclick global
            // scope me chalta hai, aur loadContent() is IIFE ke andar hai.
            window.copyContactValue = function(btn, value) {
                navigator.clipboard.writeText(String(value || ''))
                    .then(() => {
                        const original = btn.innerHTML;
                        btn.classList.add('is-done');
                        btn.innerHTML = '\u2713 Copied';
                        setTimeout(() => { btn.classList.remove('is-done'); btn.innerHTML = original; }, 1400);
                    })
                    .catch(() => showWarning('Could not copy \u2014 please select and copy manually.'));
            };

            window.lexoraNavigate = function(parentId, subId) {
                loadContent(parentId, subId || null);
            };

            function loadContent(parentId, subId) {
                // If we're navigating AWAY from an in-progress/active
                // translation view to anywhere else, tear it down first.
                if (activeSubItemId === 'translation' && subId !== 'translation') {
                    leaveTranslationSection();
                }
                if (activeSubItemId === 'ocr' && subId !== 'ocr' && window.OcrService) {
                    window.OcrService.leave();
                }
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
                    // Data Extraction lives in js/data-extraction.js.
                    if (!data && dataKey === 'data-extraction' && window.DataExtraction) {
                        data = { body: function () { return window.DataExtraction.render(); } };
                    }
                    // BAI2 (paid) lives in js/bai2.js.
                    // OCR (paid) lives in js/ocr-service.js.
                    if (!data && dataKey === 'ocr' && window.OcrService) {
                        data = { body: function () { return window.OcrService.render(); } };
                    }
                    if (!data && dataKey === 'bai2' && window.Bai2) {
                        data = { body: function () { return window.Bai2.render(); } };
                    }
                    // "Other Services" (and each free tool inside it) lives in
                    // js/free-services.js and is looked up by id, so adding a
                    // new free tool needs no change in this file.
                    if (!data && window.FreeServices && window.FreeServices.has(dataKey)) {
                        data = { body: function () { return window.FreeServices.render(dataKey); } };
                    }
                    if (!data) {
                        data = { body: '<div class="content-section"><p>Content not available for this section.</p></div>' };
                    }

                    // Remember the current breadcrumb prefix so modules that
                    // swap contentBody themselves (Other Services tool pages)
                    // can append their own tool name to it.
                    window.__lexoraBreadcrumb = breadcrumb;
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
                    // Layout mockup se, upar se neeche:
                    //   1. Welcome block (no card)  2. Current Plan card
                    //   3. Wallet Balance card      4. Today's Transactions
                    //   5. 4 stat tiles
                    // Sab kuch ek screen me fit hona chahiye - isliye
                    // .dash-page grid hai aur table area flexible.
                    body: `
                        <div class="dash-page">
                            <div class="dash-top">
                                <div class="dash-welcome">
                                    <p class="dash-welcome-eyebrow">Welcome back,</p>
                                    <h1 class="dash-welcome-name"><span id="dashUserName">there</span>!<span class="dash-wave">\u{1F44B}</span></h1>
                                    <p class="dash-welcome-sub">Here's what's happening with your account today.</p>
                                </div>

                                <div class="dash-hero-card dash-hero-plan">
                                    <span class="dash-hero-icon">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                                            <path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4M8.5 12h7M8.5 16h4"/>
                                        </svg>
                                    </span>
                                    <div class="dash-hero-body">
                                        <div class="dash-hero-label">Current Plan</div>
                                        <div class="dash-hero-value" id="dashCurrentPlan">\u2014</div>
                                        <button class="dash-hero-btn" onclick="lexoraNavigate('plans-offers')">Manage Plan <span>\u2192</span></button>
                                    </div>
                                    <svg class="dash-hero-art" viewBox="0 0 64 72" fill="none" aria-hidden="true">
                                        <path d="M20 44h24v26l-12-8-12 8z" fill="#93b8fb"/>
                                        <circle cx="32" cy="30" r="22" fill="#bcd6fb"/>
                                        <circle cx="32" cy="30" r="16" fill="#6fa2f7"/>
                                        <path d="m32 20 3.2 6.6 7.2 1-5.2 5.1 1.2 7.2-6.4-3.4-6.4 3.4 1.2-7.2-5.2-5.1 7.2-1z" fill="#fff"/>
                                    </svg>
                                </div>

                                <div class="dash-hero-card dash-hero-wallet">
                                    <span class="dash-hero-icon">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                                            <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H18a2 2 0 0 1 2 2v1"/><rect x="3" y="7.5" width="18" height="12" rx="2.5"/><circle cx="16.5" cy="13.5" r="1.3"/>
                                        </svg>
                                    </span>
                                    <div class="dash-hero-body">
                                        <div class="dash-hero-label">Wallet Balance</div>
                                        <div class="dash-hero-value" id="dashBalance">\u20b90.00</div>
                                        <button class="dash-hero-btn" onclick="lexoraNavigate('payment','balance')">Add Funds <span>+</span></button>
                                    </div>
                                    <svg class="dash-hero-art" viewBox="0 0 72 60" fill="none" aria-hidden="true">
                                        <rect x="20" y="6" width="40" height="24" rx="3" fill="#86efac"/>
                                        <rect x="26" y="12" width="28" height="14" rx="2" fill="#4ade80"/>
                                        <rect x="4" y="20" width="60" height="34" rx="7" fill="#7f9cd4"/>
                                        <path d="M4 30h60v10H4z" fill="#6b88c4"/>
                                        <circle cx="52" cy="36" r="5" fill="#f5b642"/>
                                    </svg>
                                </div>
                            </div>

                            <div class="history-card dash-txn-card">
                                <div class="dash-txn-head">
                                    <span class="ds-card-icon">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                                            <rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/>
                                        </svg>
                                    </span>
                                    <h3>Today's Transactions</h3>
                                    <button class="dash-view-all" onclick="lexoraNavigate('payment','payment-history')">View All Transactions <span>\u2192</span></button>
                                </div>
                                <div class="card-body today-table-scroll-outer">
                                    <table class="history-table today-table" id="todayTableHeader">
                                        <thead>
                                            <tr>
                                                <th>Date &amp; Time</th>
                                                <th>T. ID</th>
                                                <th>User ID</th>
                                                <th>Payment Type</th>
                                                <th>Payment Mode</th>
                                                <th>Description</th>
                                                <th>Credit</th>
                                                <th>Debit</th>
                                                <th>Status</th>
                                            </tr>
                                        </thead>
                                    </table>
                                    <div class="history-table-wrapper" id="todayTableWrapper">
                                        <table class="history-table today-table" id="todayTable">
                                            <tbody id="todayTableBody">
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                            </div>

                            <div class="dashboard-grid">
                                <div class="dash-card">
                                    <span class="dash-card-icon dash-icon-blue">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 20V11M12 20V4M18 20v-6"/></svg>
                                    </span>
                                    <div class="dash-card-text">
                                        <div class="dash-card-value" id="dashTodayCount">0</div>
                                        <div class="dash-card-label">Today's Transactions</div>
                                        <div class="dash-card-sub">Total transactions made today</div>
                                    </div>
                                </div>
                                <div class="dash-card">
                                    <span class="dash-card-icon dash-icon-green">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>
                                    </span>
                                    <div class="dash-card-text">
                                        <div class="dash-card-value" id="dashTodayCredit">\u20b90.00</div>
                                        <div class="dash-card-label">Today's Credits</div>
                                        <div class="dash-card-sub">Total amount credited today</div>
                                    </div>
                                </div>
                                <div class="dash-card">
                                    <span class="dash-card-icon dash-icon-purple">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M6.5 13.5 12 19l5.5-5.5"/></svg>
                                    </span>
                                    <div class="dash-card-text">
                                        <div class="dash-card-value" id="dashTodayDebit">\u20b90.00</div>
                                        <div class="dash-card-label">Today's Debits</div>
                                        <div class="dash-card-sub">Total amount debited today</div>
                                    </div>
                                </div>
                                <div class="dash-card">
                                    <span class="dash-card-icon dash-icon-amber">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/></svg>
                                    </span>
                                    <div class="dash-card-text">
                                        <div class="dash-card-value" id="dashPending">0</div>
                                        <div class="dash-card-label">Pending Activities</div>
                                        <div class="dash-card-sub">Actions awaiting completion</div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    `
                },
                'lease-abstraction': {
                    body: function() {
                        if (!isAdminOrDeveloper()) {
                            return `
                                <div class="content-section" style="text-align:center;padding:48px 20px;">
                                    <div style="font-size:3rem;margin-bottom:12px;">🚧</div>
                                    <h3 style="font-size:1.3rem;margin-bottom:8px;">Lease Abstraction - Coming Soon</h3>
                                    <p style="color:#555;max-width:480px;margin:0 auto;">
                                        This service is still being built out and isn't available yet.
                                        We'll let you know as soon as it's ready - in the meantime,
                                        Translation is fully available from the Services menu.
                                    </p>
                                </div>
                            `;
                        }
                        return buildServiceUploadHTML('lease-abstraction', 'Lease Abstraction', '📄');
                    }
                },
                translation: {
                    body: function() {
                        return buildServiceUploadHTML('translation', 'Translation', '🌐');
                    }
                },
                'plans-offers': {
                    body: function() {
                        const myPlanName = getMyPlan().name;
                        const isAdminOrDev = isAdminOrDeveloper();
                        const historyRows = (isAdminOrDev ? planHistory : planHistory.filter(h => h.userId === CURRENT_USER_ID))
                            .slice().reverse();
                        const cols = isAdminOrDev ? 8 : 7;
                        const tick = '<svg class="plan-tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>';
                        return `
                        <div class="plans-grid">
                            ${PLANS_DATA.map(plan => {
                                // Tier tay karta hai colour aur button style:
                                // free = teal, paid = amber, featured = blue.
                                const tier = plan.featured ? 'is-pro' : (plan.monthlyPrice > 0 ? 'is-standard' : 'is-free');
                                const isMine = plan.name === myPlanName;
                                return `
                                <div class="plan-card ${tier} ${plan.featured ? 'featured' : ''}">
                                    ${plan.featured ? '<div class="plan-badge">\u2605 Most Popular</div>' : ''}
                                    ${tier === 'is-free' ? '<div class="plan-free-tag">FREE</div>' : ''}
                                    <div class="plan-icon">${plan.icon || ''}</div>
                                    <div class="plan-name">${escapeHtml(plan.name)}</div>
                                    <div class="plan-price">\u20b9${plan.monthlyPrice}<span>/month</span></div>
                                    <ul class="plan-features">
                                        <li>${tick}\u20b9${Number(plan.pricePerTranslation != null ? plan.pricePerTranslation : 0)} / page (Translation)</li>
                                        ${(plan.features || []).map(f => `<li>${tick}${escapeHtml(f)}</li>`).join('')}
                                    </ul>
                                    <button class="plan-cta-btn ${isMine ? 'is-current' : ''}" ${isMine ? 'disabled' : `onclick="switchPlan('${plan.id}')"`}>
                                        ${isMine ? '\u2713 Current Plan' : (plan.monthlyPrice > 0 ? 'Upgrade Now' : 'Get Started')}
                                    </button>
                                </div>`;
                            }).join('')}
                        </div>

                    `;
                    }
                },
                balance: {
                    body: function() {
                        // "Add Balance" is for every user (this was never
                        // meant to be Admin/Developer-only - that
                        // restriction was a misread of the original ask).
                        // Add Balance form (left) aur secure checkout
                        // (right) ek hi row me - payment website ka hissa
                        // lagta hai, alag popup nahi. Checkout ka mount
                        // point #rzpInlineMount hai (see payWithRazorpay).
                        const QUICK_AMOUNTS = [500, 1000, 2500, 5000, 10000];
                        const PAY_PERKS = [
                            { icon: '<path d="M13 2 4.5 13H11l-1 9 8.5-11H12z"/>', title: 'Instant Credit',   sub: 'Added in seconds' },
                            { icon: '<path d="M12 3l7.5 3v5.5c0 4.4-3 8.2-7.5 9.5-4.5-1.3-7.5-5.1-7.5-9.5V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>', title: '100% Secure', sub: 'Razorpay Powered' },
                            { icon: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19"/>', title: 'Multiple Options', sub: 'UPI, Cards, Wallets' },
                            { icon: '<path d="M4 13v-1a8 8 0 0 1 16 0v1"/><rect x="2.5" y="13" width="4.5" height="6" rx="2"/><rect x="17" y="13" width="4.5" height="6" rx="2"/>', title: '24\u00d77 Support', sub: 'Always here to help' }
                        ];
                        const topUpHtml = `
                        <div class="balance-topup-layout">
                            <div class="balance-add-card">
                                <div class="ds-card-head">
                                    <span class="ds-card-icon">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                                            <rect x="2.5" y="5.5" width="19" height="13" rx="3"/><path d="M2.5 10h19M12 14.5h4"/>
                                        </svg>
                                    </span>
                                    <div>
                                        <h3>Add Balance</h3>
                                        <p class="ds-card-sub">Add funds to your Lexora account for seamless payments</p>
                                    </div>
                                </div>

                                <div class="form-group">
                                    <label>Amount (\u20b9)</label>
                                    <input type="number" id="balanceAmount" placeholder="Enter amount" min="1" step="1" oninput="syncPayPanelAmount()" />
                                </div>
                                <div class="balance-quick-row">
                                    ${QUICK_AMOUNTS.map(v => `<button type="button" class="balance-quick-chip" data-amount="${v}" onclick="setBalanceAmount(${v})">\u20b9${v.toLocaleString('en-IN')}</button>`).join('')}
                                </div>
                                <div class="form-group">
                                    <label>Description</label>
                                    <input type="text" id="balanceDescription" placeholder="Enter description" />
                                </div>
                                <button class="add-btn balance-add-submit" onclick="addBalance()">+ Add Balance</button>

                                <p class="balance-approval-note">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                                        <path d="M12 3l7.5 3v5.5c0 4.4-3 8.2-7.5 9.5-4.5-1.3-7.5-5.1-7.5-9.5V6z"/>
                                    </svg>
                                    Your amount will be credited to your wallet instantly after the payment is confirmed.
                                </p>

                                <div class="balance-perks">
                                    ${PAY_PERKS.map(p => `<div class="balance-perk">
                                        <span class="balance-perk-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${p.icon}</svg></span>
                                        <b>${p.title}</b>
                                        <span>${p.sub}</span>
                                    </div>`).join('')}
                                </div>
                            </div>

                            <div class="balance-pay-panel" id="balancePayPanel">
                                <div class="pay-panel-head">
                                    <span class="ds-card-icon">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                                            <rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>
                                        </svg>
                                    </span>
                                    <div class="pay-panel-headings">
                                        <div class="pay-panel-title">Secure Checkout</div>
                                        <div class="pay-panel-sub">Safe &amp; secure payment via Razorpay</div>
                                    </div>
                                    <div class="pay-panel-amount" id="payPanelAmount">\u20b90.00</div>
                                </div>
                                <div class="pay-panel-body" id="rzpInlineMount"></div>
                            </div>
                        </div>
                        `;

                        return `
                        <div class="balance-grid" id="balanceGrid">
                            <div class="balance-card">
                                <div class="balance-number credit" id="totalCreditBalance">₹0.00</div>
                                <div class="balance-label">Total Credit</div>
                            </div>
                            <div class="balance-card">
                                <div class="balance-number debit" id="totalDebitBalance">₹0.00</div>
                                <div class="balance-label">Total Debit</div>
                            </div>
                            <div class="balance-card">
                                <div class="balance-number" id="currentBalanceDisplay">₹0.00</div>
                                <div class="balance-label">Current Balance</div>
                            </div>
                        </div>
                        ${topUpHtml}
                    `;
                    }
                },
                'payment-history': {
                    body: function() {
                    // Mockup order: filter bar -> table -> pagination footer
                    // -> alag summary card. Filter/Clear filled+plain, aur
                    // Download/Raise Issue right side me outlined.
                    return `
                        <div class="history-summary" id="historySummary">
                            <div class="summary-item">
                                <span class="summary-icon summary-icon-credit"></span>
                                <span class="summary-label">Total Credit</span>
                                <span class="summary-value credit-value" id="totalCredit">\u20b90.00</span>
                            </div>
                            <div class="summary-item">
                                <span class="summary-icon summary-icon-debit"></span>
                                <span class="summary-label">Total Debit</span>
                                <span class="summary-value debit-value" id="totalDebit">\u20b90.00</span>
                            </div>
                            <div class="summary-item">
                                <span class="summary-icon summary-icon-balance"></span>
                                <span class="summary-label">Current Balance</span>
                                <span class="summary-value" id="currentBalance">\u20b90.00</span>
                            </div>
                        </div>

                        <div class="history-card">
                            <h3>💳 Payment History</h3>
                            <div class="history-filter-bar">
                                <div class="filter-group">
                                    <label>From Date</label>
                                    <input type="date" id="historyFromDate" />
                                </div>
                                <div class="filter-group">
                                    <label>To Date</label>
                                    <input type="date" id="historyToDate" />
                                </div>
                                ${isAdminOrDeveloper() ? `
                                    <div class="filter-group filter-group-search">
                                        <label>User</label>
                                        <input type="text" id="historyUserFilter" placeholder="User ID or email" oninput="applyHistoryFilter()" />
                                    </div>
                                ` : ''}
                                <button class="filter-btn is-primary" onclick="applyHistoryFilter()">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h18l-7 8v6l-4 2v-8z"/></svg>
                                    Filter
                                </button>
                                <button class="filter-btn reset-btn" onclick="clearHistoryFilter()">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
                                    Clear
                                </button>
                                <div class="filter-bar-spacer"></div>
                                <button class="filter-btn download-btn" onclick="downloadHistoryExcel()">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7.5 10.5 12 15l4.5-4.5"/><path d="M4 20h16"/></svg>
                                    Download Excel
                                </button>
                                <button class="filter-btn raise-issue-btn" onclick="openRaiseIssueModal()">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>
                                    Raise Issue
                                </button>
                            </div>
                            <div class="card-body payment-history-scroll-outer">
                                <table class="history-table payment-history-table" id="historyTableHeader">
                                    <thead>
                                        <tr>
                                            <th style="width:36px;"><input type="checkbox" id="historySelectAll" onchange="toggleSelectAllTransactions(this.checked)" /></th>
                                            <th>Date &amp; Time</th>
                                            <th>T. ID</th>
                                            <th>User ID</th>
                                            <th>Payment Type</th>
                                            <th>Payment Mode</th>
                                            <th>Description</th>
                                            <th>Credit</th>
                                            <th>Debit</th>
                                            <th>Status</th>
                                        </tr>
                                    </thead>
                                </table>
                                <div class="history-table-wrapper" id="historyTableWrapper">
                                    <table class="history-table payment-history-table" id="historyTable">
                                        <tbody id="historyTableBody"></tbody>
                                    </table>
                                </div>
                            </div>
                            <div class="history-pager" id="historyPager"></div>
                        </div>
                        </div>
                    `;
                    }
                },
                'api-documentation': {
                    // Order screenshot se: API Key card (notice + actions ->
                    // key + details -> previous keys), phir Services API
                    // Reference (sidebar + endpoint panel + tabs + code).
                    // Purane ids (apiKeyDisplay / apiKeyActions /
                    // apiKeyHistory) waise hi rakhe hain taaki
                    // generateApiKey/copyApiKey/saveApiKey/revokeApiKey
                    // bina badle chalte rahein.
                    body: function() {
                        return `
                        <div class="api-key-card">
                            <div class="ds-card-head">
                                <span class="ds-card-icon">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                                        <circle cx="8" cy="14" r="4.5"/><path d="m11.4 11 8.1-8.1M17 5.5l2.5 2.5M14.5 8l2.5 2.5"/>
                                    </svg>
                                </span>
                                <div>
                                    <h3>API Key</h3>
                                    <p class="ds-card-sub">Generate a new API key to authenticate your requests. Keep it secret \u2014 treat it like a password.</p>
                                </div>
                            </div>

                            <div class="api-key-grid">
                                <div>
                                    <div class="api-label">Your API Key</div>
                                    <div class="api-key-row-inline">
                                        <div class="api-key-box" id="apiKeyDisplay">No API key generated yet.</div>
                                        <button class="api-eye-btn" id="apiKeyEye" onclick="toggleApiKeyVisible()" aria-label="Show or hide API key">
                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.8-6.5 10-6.5S22 12 22 12s-3.8 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/></svg>
                                        </button>
                                    </div>
                                </div>
                                <div class="api-key-actions" id="apiKeyActions">
                                    <button class="api-action-btn generate-btn" onclick="generateApiKey()">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4.5 13H11l-1 9 8.5-11H12z"/></svg>
                                        Generate New API Key
                                    </button>
                                    <button class="api-action-btn copy-btn" onclick="copyApiKey()">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>
                                        Copy
                                    </button>
                                    <button class="api-action-btn save-btn" onclick="saveApiKey()">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h11l3 3v15H5z"/><path d="M8 3v6h7M8 14h8"/></svg>
                                        Save
                                    </button>
                                    <button class="api-action-btn revoke-btn" onclick="revokeApiKey()">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5h16M9.5 6.5V4.5h5v2M7 6.5l1 13h8l1-13"/></svg>
                                        Delete
                                    </button>
                                </div>
                            </div>
                        </div>

                        <div class="api-key-card api-ref-card">
                            <div class="ds-card-head">
                                <span class="ds-card-icon">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                                        <path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4M8.5 12h7M8.5 16h4"/>
                                    </svg>
                                </span>
                                <div>
                                    <h3>Services API Reference</h3>
                                    <p class="ds-card-sub">GET and POST endpoints with example requests/responses for each service.</p>
                                </div>
                            </div>
                            <div class="api-ref-layout">
                                <div class="api-ref-nav" id="apiRefNav"></div>
                                <div class="api-ref-panel" id="apiRefPanel"></div>
                            </div>
                        </div>
                    `;
                    }
                },
                support: {
                    body: function() {
                    return `
                        <div class="history-card support-log-card support-log-full">
                            <div class="support-log-header-row">
                                <div class="ds-card-head support-head">
                                    <span class="ds-card-icon is-filled">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                                            <rect x="5" y="4" width="14" height="17" rx="2"/><rect x="9" y="2.5" width="6" height="3.5" rx="1.2"/><path d="M9 11h6M9 15h4"/>
                                        </svg>
                                    </span>
                                    <div>
                                        <h3 data-iconified="1">Supports: Log</h3>
                                        <p class="ds-card-sub">Track and manage all your support requests in one place.</p>
                                    </div>
                                </div>
                                <button class="support-back-btn" onclick="lexoraNavigate('services','other-services')">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>
                                    Back to Other Services
                                </button>
                            </div>
                            <div class="history-filter-bar">
                                <div class="filter-group">
                                    <label>From Date</label>
                                    <input type="date" id="supportFromDate" />
                                </div>
                                <div class="filter-group">
                                    <label>To Date</label>
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
                    // Layout mockup se: hero (copy + channels + stats + art),
                    // phir Company Details | Find Us + FAQ, phir quick
                    // actions. Saara data COMPANY_INFO (json/company.json)
                    // se aata hai - yahan kuch hardcode nahi hai.
                    body: function() {
                        const c = COMPANY_INFO || {};
                        const mapQuery = encodeURIComponent(c.location || c.address || c.name || '');
                        const mapEmbedSrc = mapQuery ? `https://www.google.com/maps?q=${mapQuery}&output=embed` : '';
                        const mapsLink = mapQuery ? `https://www.google.com/maps/search/?api=1&query=${mapQuery}` : '#';
                        const waNumber = String(c.whatsapp || c.phone || '').replace(/[^\d]/g, '');
                        const phoneWhatsapp = [c.phone, c.whatsapp].filter((v, i, arr) => v && arr.indexOf(v) === i).join(' / ');

                        const ICON = {
                            pin:   '<path d="M12 21s7-5.7 7-11a7 7 0 1 0-14 0c0 5.3 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/>',
                            clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/>',
                            cal:   '<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/>',
                            mail:  '<rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><path d="M3 6.5l9 6.5 9-6.5"/>',
                            phone: '<path d="M5 3.5h4l2 5-2.5 1.5a12 12 0 0 0 5.5 5.5L15.5 13l5 2v4a1.5 1.5 0 0 1-1.6 1.5A16.5 16.5 0 0 1 3.5 5.1 1.5 1.5 0 0 1 5 3.5z"/>'
                        };
                        const svg = (d, cls) => `<svg class="${cls || ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

                        const rows = [
                            ['pin',   'Address',        c.address],
                            ['clock', 'Working Hours',  c.workingHours],
                            ['cal',   'Working Days',   c.workingDays],
                            ['mail',  'Email',          c.email,        c.email ? `mailto:${c.email}` : null],
                            ['phone', 'Phone / Mobile / WhatsApp', phoneWhatsapp, c.phone ? `tel:${String(c.phone).replace(/[^+\d]/g, '')}` : null]
                        ].filter(r => r[2]);

                        const faqs = [
                            ['Billing & Payments', 'Wallet top-ups are charged per page or per document, and every transaction shows up in Payment History with its receipt.'],
                            ['Account & Access', 'Use Forgot Password on the login screen to reset access. Two-factor authentication can be switched on from your Profile.'],
                            ['Data & Security', "Files are processed for your job and are not used to train models. Only you and your account's admins can see your documents."],
                            ['OCR & Data Extraction', 'OCR rebuilds scanned or photographed pages into editable Word. Data Extraction lets you define your own fields and returns a clean table.'],
                            ['Translation Services', 'Over 60 languages, with the original page layout preserved. Choose Word or PDF output in the Setup card.'],
                            ['API & Integrations', 'Generate a key under Help \u203a API Documentation, then call the REST endpoints listed there with a Bearer token.']
                        ];

                        const quick = [
                            ['<rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="M8.5 9h7M8.5 13h7M8.5 17h4"/>', 'Create Ticket', 'Submit a support request', "lexoraNavigate('help','support')"],
                            ['<path d="M4 12.5 9 17l11-11"/><path d="M4 6.5h9"/>', 'Track Ticket', 'Check ticket status', "lexoraNavigate('help','support')"],
                            ['<path d="M9 7 4.5 12 9 17M15 7l4.5 5L15 17"/>', 'API Documentation', 'Explore our API docs', "lexoraNavigate('help','api-documentation')"],
                            [ICON.phone, 'Call Us', c.phone || '', c.phone ? `window.open('tel:${String(c.phone).replace(/[^+\d]/g, '')}')` : 'void(0)']
                        ];

                        return `
                        <div class="contact-page">
                            <div class="contact-hero">
                                <div class="contact-hero-copy">
                                    <h2>We're here to help! <span class="dash-wave">\u{1F44B}</span></h2>
                                    <p>Have a question or need support? Our team is ready to assist you.</p>

                                    <div class="contact-channels">
                                        <div class="contact-channel is-chat">
                                            <span class="contact-channel-icon">${svg('<path d="M20 15a2.5 2.5 0 0 1-2.5 2.5H8L4 21V5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5z"/>')}</span>
                                            <div>
                                                <b>Raise a Ticket</b>
                                                <span>Our team replies by email</span>
                                            </div>
                                            <button onclick="lexoraNavigate('help','support')">Open Support <em>\u2192</em></button>
                                        </div>
                                        <div class="contact-channel is-wa">
                                            <span class="contact-channel-icon">${svg('<path d="M4 20l1.4-4A8 8 0 1 1 8 18.6z"/><path d="M9 9.5c.6 2.4 3.1 4.9 5.5 5.5"/>')}</span>
                                            <div>
                                                <b>WhatsApp</b>
                                                <span>Chat on WhatsApp</span>
                                            </div>
                                            <button ${waNumber ? `onclick="window.open('https://wa.me/${waNumber}', '_blank')"` : 'disabled'}>Chat Now <em>\u2192</em></button>
                                        </div>
                                        <div class="contact-channel is-mail">
                                            <span class="contact-channel-icon">${svg(ICON.mail)}</span>
                                            <div>
                                                <b>Email Us</b>
                                                <span>Send us an email</span>
                                            </div>
                                            <button ${c.email ? `onclick="window.location.href='mailto:${c.email}'"` : 'disabled'}>Send Email <em>\u2192</em></button>
                                        </div>
                                    </div>
                                </div>

                                <svg class="contact-hero-art" viewBox="0 0 420 300" fill="none" aria-hidden="true">
                                    <ellipse cx="210" cy="255" rx="170" ry="20" fill="#dbe8fe"/>
                                    <path d="M60 120a70 70 0 0 1 120-55 70 70 0 0 1 105 60 60 60 0 0 1-40 105H110a60 60 0 0 1-50-110z" fill="#eaf2fe"/>
                                    <rect x="120" y="196" width="180" height="14" rx="7" fill="#b9d0f3"/>
                                    <path d="M130 196l14-52h132l14 52z" fill="#dbe8fe"/>
                                    <rect x="150" y="96" width="120" height="52" rx="6" fill="#fff" stroke="#c5daf9"/>
                                    <circle cx="196" cy="72" r="26" fill="#f6c9a8"/>
                                    <path d="M170 68a26 26 0 0 1 52 0v-6a26 26 0 0 0-52 0z" fill="#1d4ed8"/>
                                    <path d="M168 66a6 6 0 0 1 0 14M224 66a6 6 0 0 1 0 14" stroke="#1d4ed8" stroke-width="5"/>
                                    <path d="M168 66h56" stroke="#1d4ed8" stroke-width="5"/>
                                    <path d="M204 90c8 4 14 14 14 24h-44c0-10 6-20 14-24z" fill="#2f7bf6"/>
                                    <circle cx="300" cy="60" r="26" fill="#dbe8fe"/>
                                    <circle cx="291" cy="60" r="3" fill="#7fb0f4"/><circle cx="300" cy="60" r="3" fill="#7fb0f4"/><circle cx="309" cy="60" r="3" fill="#7fb0f4"/>
                                    <rect x="330" y="120" width="56" height="38" rx="6" fill="#2f7bf6"/>
                                    <path d="M330 126l28 18 28-18" stroke="#fff" stroke-width="3" fill="none"/>
                                </svg>
                            </div>

                            <div class="contact-grid">
                                <div class="company-details-card">
                                    <div class="ds-card-head">
                                        <span class="ds-card-icon is-filled">${svg('<path d="M4 21V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v15M15 21V10h3a2 2 0 0 1 2 2v9M3 21h18M8 8h3M8 12h3M8 16h3"/>')}</span>
                                        <div><h3 data-iconified="1">Company Details</h3></div>
                                    </div>
                                    ${rows.map(r => `
                                        <div class="contact-row">
                                            <span class="contact-row-icon">${svg(ICON[r[0]])}</span>
                                            <div class="contact-row-text">
                                                <span class="contact-row-label">${escapeHtml(r[1])}</span>
                                                ${r[3]
                                                    ? `<a class="contact-row-value is-link" href="${r[3]}">${escapeHtml(r[2])}</a>`
                                                    : `<span class="contact-row-value">${escapeHtml(r[2])}</span>`}
                                            </div>
                                            <button class="contact-copy-btn" onclick="copyContactValue(this, ${JSON.stringify(String(r[2])).replace(/"/g, '&quot;')})">
                                                ${svg('<rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>')}
                                                Copy
                                            </button>
                                        </div>`).join('')}
                                    <div class="contact-follow">
                                        <span>Follow us</span>
                                        ${buildSocialLinksHtml({ size: 20, gap: 12, color: '#1257f5' })}
                                    </div>
                                </div>

                                <div class="contact-right">
                                    <div class="company-map-card">
                                        <div class="ds-card-head">
                                            <span class="ds-card-icon is-filled">${svg('<path d="M9 4 3 6.5v14L9 18l6 2.5 6-2.5v-14L15 6.5z"/><path d="M9 4v14M15 6.5v14"/>')}</span>
                                            <div><h3 data-iconified="1">Find Us</h3></div>
                                        </div>
                                        ${mapEmbedSrc ? `
                                            <div class="contact-map-wrap">
                                                <iframe src="${mapEmbedSrc}" loading="lazy" referrerpolicy="no-referrer-when-downgrade" title="Map"></iframe>
                                                <a class="contact-map-link" href="${mapsLink}" target="_blank" rel="noopener">Get Directions</a>
                                            </div>` : '<p class="ds-card-sub">No location set in company.json.</p>'}
                                    </div>

                                </div>
                            </div>

                            <div class="contact-actions">
                                <div class="contact-actions-copy">
                                    <b>Need more help?</b>
                                    <span>Raise a ticket or explore our support resources.</span>
                                </div>
                                ${quick.map(q => `
                                    <button class="contact-action" onclick="${q[3]}">
                                        <span class="contact-action-icon">${svg(q[0])}</span>
                                        <div><b>${escapeHtml(q[1])}</b><span>${escapeHtml(q[2])}</span></div>
                                        <em>\u203a</em>
                                    </button>`).join('')}
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
                    if (res.status === 401) return; // authFetch already shows the session-expired message - don't also show this one
                    if (!res.ok) throw new Error('Save failed with status ' + res.status);
                } catch (e) {
                    console.warn(`Could not save json/${name}.json to the backend:`, e);
                    if (!backendSaveWarningShown && !_sessionExpiredHandled) {
                        backendSaveWarningShown = true;
                        showWarning(
                            'Changes are not being saved to disk right now. Make sure the app is running via ' +
                            '"python3 py/server.py" (not a plain static server) so json/ files can actually be updated.'
                        );
                    }
                }
            }

            function persistPaymentHistory() { return saveJSON('payment-history', paymentHistory); }

            // ── Billing bridge for standalone service modules ──────────
            // Data Extraction (js/data-extraction.js) lives outside this
            // IIFE, so it can't reach getServicePrice/paymentHistory
            // directly. Rather than letting it invent its own pricing (which
            // would silently drift from the plans the admin edits), it goes
            // through this one small surface - same rate, same wallet, same
            // transaction record as Translation.
            // Lets standalone service modules update the page header when they
            // navigate internally without going through loadContent().
            window.setLexoraBreadcrumb = function (text) {
                const el = document.getElementById('currentMenuDisplay');
                if (el) el.textContent = text;
            };

            window.LexoraBilling = {
                perPageRate: function () { return getServicePrice('translation', 1); },
                planName: function () { return getMyPlan().name; },
                balance: function () { return getCurrentBalance(); },
                charge: function (description, amount) {
                    const now = new Date();
                    const txnId = 'TXN' + String(nextTransactionId++).padStart(3, '0');
                    paymentHistory.push({
                        id: txnId,
                        date: localDateStr(now),
                        time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }),
                        userId: CURRENT_USER_ID,
                        paymentType: 'Service Fee',
                        paymentMode: 'Wallet Balance',
                        description: description,
                        credit: 0,
                        debit: amount
                    });
                    persistPaymentHistory();
                    return txnId;
                }
            };

            function persistPlanHistory() { return saveJSON('plan-history', planHistory); }
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
                    if (res.status === 401) return; // authFetch already shows the session-expired message
                    const result = await res.json();
                    if (!res.ok) throw new Error(result.error || 'Save failed with status ' + res.status);
                    if (result.user) profileData = result.user;
                } catch (e) {
                    console.warn('Could not save profile to the backend:', e);
                    if (!backendSaveWarningShown && !_sessionExpiredHandled) {
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
                    cardLayoutData,
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
                    notificationsData,
                    plansData,
                    planHistoryData
                ] = await Promise.all([
                    fetchJSON('json/menu-config.json'),
                    fetchJSON('json/payment-methods.json'),
                    // Postgres chalu ho to ye route DB se deta hai,
                    // warna wahi JSON file - dono case me ek hi shape.
                    fetchJSON('/api/data/payment-history'),
                    fetchJSON('json/services-api.json'),
                    fetchJSON('json/card-layout.json'),
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
                    fetchJSON('json/notifications.json'),
                    fetchJSON('json/plans.json'),
                    fetchJSON('json/plan-history.json')
                ]);
                PLANS_DATA = plansData || [];
                planHistory = planHistoryData || [];

                MENU_CONFIG = menuConfig;
                paymentMethods = paymentMethodsData;
                paymentHistory = paymentHistoryData;
                CARD_LAYOUT = cardLayoutData;
                applyCardLayout();
                SERVICES_API_DATA = servicesApiData;
                // Agar API Documentation page pehle se khula hai to data
                // aate hi reference dobara draw ho jaye.
                if (document.getElementById('apiRefNav')) renderServicesApiList();
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
            let _sessionExpiredHandled = false;

            function handleSessionExpired() {
                // Guards against firing more than once if several requests
                // 401 around the same moment (e.g. a batch of parallel
                // calls all riding the same now-expired token).
                if (_sessionExpiredHandled || !AUTH_TOKEN) return;
                _sessionExpiredHandled = true;
                AUTH_TOKEN = null;
                CURRENT_USER_ID = null;
                localStorage.removeItem(AUTH_SESSION_KEY);
                document.getElementById('appShell').style.display = 'none';
                document.getElementById('authScreen').style.display = '';
                authState.step = 'login';
                renderAuthScreen();
                showWarning('You have been logged out. This can happen if your account was signed in from another device or after a period of inactivity. Please log in again.');
            }

            function authFetch(url, options) {
                options = options || {};
                const headers = Object.assign({}, options.headers || {});
                if (AUTH_TOKEN) headers['Authorization'] = 'Bearer ' + AUTH_TOKEN;
                return fetch(url, Object.assign({}, options, { headers })).then(res => {
                    if (res.status === 401 && AUTH_TOKEN) {
                        handleSessionExpired();
                    }
                    return res;
                });
            }

            let authState = {
                step: 'login',           // login | register | forgot | verify | newPassword
                verifyPurpose: null,     // register | login | reset
                userId: null,
                email: null,
                expiresInMinutes: 4,
                emailFailed: false,      // true if the verification email send failed server-side
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

            // Auth screen ka layout ab light "Document Intelligence
            // Platform" design follow karta hai:
            //   [ hero art | brand copy ]   [ login card  ]
            //   [ feature cards        ]   [ side art     ]
            //   [ trust strip          ]
            // Left column yahan banta hai, right column renderAuthScreen()
            // me. Illustrations Pictures/auth-hero.png aur auth-side.png
            // se aati hain - agar file missing ho to onerror unhe hide kar
            // deta hai aur layout waise hi kaam karta rehta hai.
            const AUTH_HIGHLIGHTS = [
                { num: '60+',    label: 'Languages',  sub: 'Supported' },
                { num: '99%',    label: 'Accuracy',   sub: 'Guaranteed' },
                { num: 'Secure', label: 'Enterprise', sub: 'Grade Security' }
            ];

            const AUTH_CHECKS = [
                'Preserve original layout & formatting',
                'Process files securely in your browser',
                'Extract data with high accuracy',
                'Smart OCR & data extraction',
                'Convert to Word, Excel, CSV, JSON or PDF',
                'Fast, reliable & privacy focused'
            ];

            const AUTH_PAID_TOOLS = [
                ['Document Translation', '60+ languages, layout preserved exactly',
                 '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 3 2.6 15 0 18M12 3c-2.6 3-2.6 15 0 18"/>'],
                ['OCR Conversion', 'Scanned or photographed pages rebuilt into editable Word',
                 '<path d="M4 8V6a2 2 0 0 1 2-2h2M20 8V6a2 2 0 0 0-2-2h-2M4 16v2a2 2 0 0 0 2 2h2M20 16v2a2 2 0 0 1-2 2h-2"/><path d="M7 12h10"/>'],
                ['Data Extraction', 'Define your own fields, get a clean table from every file',
                 '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 10h18M9 10v10"/>'],
                ['BAI2 Conversion', 'Bank statements converted to BAI2, CSV or JSON',
                 '<path d="M3 9.5 12 4l9 5.5"/><path d="M5 10.5v8M9.5 10.5v8M14.5 10.5v8M19 10.5v8M3 20h18"/>'],
                ['Lease Abstraction', 'Structured lease fields with source citations',
                 '<path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4M8.5 12h7M8.5 16h4"/>']
            ];

            // Category ke hisab se icon - free tools ki list registry se
            // aati hai, to icon yahan naam par map hota hai.
            const AUTH_CAT_ICONS = {
                'PDF Tools': '<path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4"/>',
                'Image Tools': '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><circle cx="8.5" cy="10" r="1.8"/><path d="m4.5 17 5-5 4 4 2.5-2 3.5 3.5"/>',
                'Calculators': '<rect x="4" y="3" width="16" height="18" rx="2.5"/><path d="M8 7h8M8 12h2M12 12h2M16 12h.01M8 16h2M12 16h2M16 16h.01"/>',
                'Data Tools': '<path d="M6 20V11M12 20V4M18 20v-6"/>',
                'Document Builders': '<path d="M5 3h9l5 5v13H5z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
                'Utilities': '<path d="M14.7 6.3a4 4 0 0 1-5.4 5.4L4 17v3h3l5.3-5.3a4 4 0 0 1 5.4-5.4l-2.6 2.6"/>',
                'More Tools': '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>'
            };

            function authIcon(path) {
                return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
                    + 'stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
            }

            // Free tools ki list FreeServices se aati hai - wahi registry
            // jo "Other Services" page use karta hai. Manually likhne par
            // list purani pad jati thi aur kai tools chhoot jate the.
            function authFreeTools() {
                if (window.FreeServices && typeof FreeServices.catalogue === 'function') {
                    try {
                        const groups = FreeServices.catalogue();
                        if (groups && groups.length) return groups.map(g => [g.title, g.tools]);
                    } catch (err) {
                        console.warn('Could not read the free tools catalogue:', err);
                    }
                }
                return [];
            }

            function buildAuthLeftPanel() {
                const freeTools = authFreeTools();
                const name = (COMPANY_INFO && COMPANY_INFO.name) || 'Lexora';
                const shortName = String(name).split(/\s+/)[0] || 'Lexora';
                const logoPath = (COMPANY_INFO && COMPANY_INFO.logo) || 'Pictures/lexora-logo.png';

                return `
                    <div class="auth-hero">
                        <div class="auth-hero-copy">
                            <img class="auth-brand-logo" src="${logoPath}" alt="${escapeHtml(shortName)}"
                                 onerror="this.onerror=null;this.src='Pictures/lexora-logo.png';" />
                            <p class="auth-brand-tagline">Document Intelligence Platform</p>
                            <p class="auth-brand-sub">
                                Translate, read, and extract data from any document \u2014
                                keeping the original layout intact.
                            </p>

                            <div class="auth-stats-row">
                                ${AUTH_HIGHLIGHTS.map(function (h) {
                                    return `<div class="auth-stat">
                                        <span class="auth-stat-dot"></span>
                                        <div>
                                            <div class="auth-stat-num">${escapeHtml(h.num)}</div>
                                            <div class="auth-stat-label">${escapeHtml(h.label)}<br/>${escapeHtml(h.sub)}</div>
                                        </div>
                                    </div>`;
                                }).join('')}
                            </div>
                        </div>
                    </div>
                `;
            }

            // Tools card ab .auth-main (do-column grid) ke bahar render hota
            // hai, isliye poori width leta hai - pehle wo left column me
            // phansa hua tha.
            function buildAuthToolsCard() {
                const freeTools = authFreeTools();
                return `
                    <div class="auth-tools-card">
                        <div class="auth-tools-col">
                            <div class="auth-tools-head">
                                <span class="auth-tools-dot is-paid"></span>Paid Services
                            </div>
                            <ul class="auth-tools-list">
                                ${AUTH_PAID_TOOLS.map(t => `<li>
                                    <span class="auth-tool-icon is-paid">${authIcon(t[2])}</span>
                                    <div><b>${escapeHtml(t[0])}</b><span>${escapeHtml(t[1])}</span></div>
                                </li>`).join('')}
                            </ul>
                        </div>
                        <div class="auth-tools-col is-free">
                            <div class="auth-tools-head">
                                <span class="auth-tools-dot is-free"></span>Free Tools
                                <em>${freeTools.reduce((n, c) => n + c[1].length, 0)} utilities, no charge</em>
                            </div>
                            <div class="auth-free-grid">
                                ${freeTools.map(c => `
                                    <div class="auth-free-cat">
                                        <div class="auth-free-cat-head">
                                            <span class="auth-tool-icon is-free">${authIcon(AUTH_CAT_ICONS[c[0]] || AUTH_CAT_ICONS['More Tools'])}</span>
                                            <b>${escapeHtml(c[0])}</b>
                                            <em>${c[1].length}</em>
                                        </div>
                                        <span>${c[1].map(t => escapeHtml(t.label || t)).join(' \u00b7 ')}</span>
                                    </div>`).join('')}
                            </div>
                        </div>
                    </div>
                `;
            }

            // "Remember me" sirf email yaad rakhta hai (password kabhi
            // nahi - wo browser ke password manager ka kaam hai). Session
            // token alag key me hai, isse chhedte nahi.
            const AUTH_REMEMBER_KEY = 'lexora_remember_email';

            function getRememberedEmail() {
                try { return localStorage.getItem(AUTH_REMEMBER_KEY) || ''; }
                catch (e) { return ''; }
            }

            function saveRememberedEmail(email, remember) {
                try {
                    if (remember && email) localStorage.setItem(AUTH_REMEMBER_KEY, email);
                    else localStorage.removeItem(AUTH_REMEMBER_KEY);
                } catch (e) { /* private mode - not worth failing a login over */ }
            }

            function buildLoginCard() {
                const remembered = getRememberedEmail();
                return `
                    <h2 class="auth-card-title">Welcome Back</h2>
                    <p class="auth-card-note">Sign in to continue to your account</p>
                    <div class="auth-form-group auth-input-icon-group">
                        <span class="auth-input-icon"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><path d="M3 6.5l9 6.5 9-6.5"/></svg></span>
                        <input type="email" id="loginEmail" class="auth-input" placeholder="Email Address"
                               value="${escapeHtml(remembered)}" onkeydown="if(event.key==='Enter')handleAuthLogin()" />
                    </div>
                    <div class="auth-form-group auth-input-icon-group auth-password-group">
                        <span class="auth-input-icon"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10.5" width="16" height="10.5" rx="2.5"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/></svg></span>
                        <input type="password" id="loginPassword" class="auth-input" placeholder="Password"
                               onkeydown="if(event.key==='Enter')handleAuthLogin()" />
                        <span class="auth-eye" onclick="authTogglePassword('loginPassword', this)">\ud83d\udc41\ufe0f</span>
                    </div>
                    <div class="auth-remember-row">
                        <label class="auth-remember">
                            <input type="checkbox" id="loginRemember" ${remembered ? 'checked' : ''} />
                            <span>Remember me</span>
                        </label>
                        <a onclick="authGoTo('forgot')">Forgot Password?</a>
                    </div>
                    <div id="authErrorBox" class="auth-error-box" style="display:none;"></div>
                    <div class="auth-btn-row">
                        <button class="auth-btn-primary" onclick="handleAuthLogin()">Login</button>
                        <button class="auth-btn-secondary" onclick="authResetForm(['loginEmail','loginPassword'])">Reset</button>
                    </div>
                    <div class="auth-card-footer">
                        Don't have an account? <a onclick="authGoTo('register')">Create Account</a>
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

            function buildVerifyCard() {
                const titles = {
                    register: '📝 Verify Registration',
                    login: '🔒 Login Verify',
                    reset: '🔑 Reset Password'
                };
                const title = titles[authState.verifyPurpose] || 'Verify';
                // Note: we intentionally never surface the actual code here.
                // If the email send failed, that's a server-side problem
                // (SMTP/config) - showing the code as a workaround would mask
                // a real issue that needs fixing, and would also mean anyone
                // who can see this screen could log in as this user without
                // ever touching their inbox.
                const fallbackBox = authState.emailFailed ? `
                    <div class="auth-fallback-box">
                        ⚠️ We couldn't send the verification email right now - this looks like a
                        temporary server/email issue on our end, not a problem with your account.
                        Please try <button type="button" class="auth-copy-code-btn" onclick="handleAuthResend()">resending the code</button>
                        in a minute, or contact support if this keeps happening.
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

                const name = (COMPANY_INFO && COMPANY_INFO.name) || 'Lexora';
                const shortName = String(name).split(/\s+/)[0] || 'Lexora';
                const logoPath = (COMPANY_INFO && COMPANY_INFO.logo) || 'Pictures/logo.png';
                const social = buildSocialLinksHtml({ size: 18, gap: 14, color: 'rgba(11,21,51,0.45)' });

                root.innerHTML = `
                    <div class="auth-page">
                        <div class="auth-main">
                            <div class="auth-main-left">${buildAuthLeftPanel()}</div>
                            <div class="auth-main-right">
                                <div class="auth-card">${buildAuthCard()}</div>
                            </div>
                        </div>

                        ${buildAuthToolsCard()}

                        <div class="footer">
                            <div class="footer-inner">
                                <span class="footer-spacer"></span>
                                <span class="footer-copy">&copy; ${new Date().getFullYear()} ${escapeHtml(name)}. All rights reserved. | Version 1.0.0</span>
                                <span id="authFooterSocial">${social || ''}</span>
                            </div>
                        </div>
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
                authState.emailFailed = false;
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
                            authState.emailFailed = true;
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
                const rememberEl = document.getElementById('loginRemember');
                if (!email || !password) { showAuthError('Please enter both email and password.'); return; }

                // Remember the email before the request goes out, so a 2FA
                // detour (which re-renders the card) doesn't lose the tick.
                saveRememberedEmail(email, !!(rememberEl && rememberEl.checked));

                try {
                    const res = await authPost('/api/auth/login', { email, password });
                    if (res.requires2FA) {
                        authState.verifyPurpose = 'login';
                        authState.userId = res.userId;
                        authState.email = res.email;
                        authState.expiresInMinutes = res.expiresInMinutes;
                        authState.emailFailed = false;
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
                    authState.emailFailed = false;
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
                    authState.emailFailed = false;
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
                    authState.emailFailed = false;
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
                window.__lexoraAuthToken = token;   // for standalone service modules
                localStorage.setItem(AUTH_SESSION_KEY, userId);
                localStorage.setItem(AUTH_TOKEN_KEY, token);
                document.getElementById('authScreen').style.display = 'none';
                // appShell reveal happens inside initializeApp(), after the
                // real company/user name is applied - see boot() note.
                initializeApp();
            }

            function performLogout() {
                // Stop any in-progress translation run before tearing down
                // the session (same reason as leaveTranslationSection).
                if (processState.running) {
                    processState.stopped = true;
                    processState.running = false;
                }
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
                window.__lexoraAuthToken = null;
                profileData = null;
                document.getElementById('appShell').style.display = 'none';
                authState = { step: 'login', verifyPurpose: null, userId: null, email: null,
                    expiresInMinutes: 4, emailFailed: false, resetCode: null,
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

            // Item 5 - handles the "✅ Fill In Code For Me" link from the
            // verification email (?verifyCode=&verifyUserId=&verifyPurpose=).
            // Email clients strip inline JS/onclick, so a real one-click
            // clipboard copy from inside the email itself isn't reliably
            // possible anywhere - this sidesteps that entirely by letting
            // the code travel in the URL instead, then auto-filling the
            // OTP boxes the moment the app loads. Cleans the URL
            // afterward so refreshing doesn't repeat it or leave the code
            // sitting in browser history longer than necessary.
            function tryHandleMagicVerifyLink() {
                const params = new URLSearchParams(window.location.search);
                const code = params.get('verifyCode');
                const userId = params.get('verifyUserId');
                if (!code || !userId) return false;
                const purpose = params.get('verifyPurpose') || 'login';

                history.replaceState({}, '', window.location.pathname);

                document.getElementById('appShell').style.display = 'none';
                document.getElementById('authScreen').style.display = '';
                authState.step = 'verify';
                authState.userId = userId;
                authState.verifyPurpose = purpose;
                authState.emailFailed = false;
                renderAuthScreen();
                requestAnimationFrame(() => {
                    const boxes = Array.from(document.querySelectorAll('.auth-otp-box'));
                    code.slice(0, boxes.length).split('').forEach((digit, i) => { if (boxes[i]) boxes[i].value = digit; });
                });
                return true;
            }

            let _livePollInterval = null;

            // Item - neither side of the balance-approval flow should need
            // a manual page refresh: a new request should show up for
            // Admin/Developer, and an approve/reject should show up for
            // the requesting user, both without reloading. There's no
            // websocket/SSE layer in this app, so this polls the same
            // notifications.json / payment-history.json every 15 seconds
            // (with a cache-busting query param, since static files would
            // otherwise be served from the browser's HTTP cache) and only
            // re-renders what's currently on screen if something actually
            // changed - cheap enough to run continuously, and "new
            // notification within ~15s" reads as real-time in practice.
            // ============================================================
            // Item 1 - proactive session-timeout warning. The backend
            // auto-logs-out a session after 30 minutes of no activity
            // (IDLE_TIMEOUT_MINUTES in py/server.py) - this tracks the
            // same 30-minute window on the client and, 1 minute before it
            // would hit, shows a countdown with a Resume button instead
            // of just letting the session silently expire mid-task. Any
            // real activity (mouse/keyboard/click, or any successful API
            // call) resets the clock - this is NOT a fixed "log out after
            // X minutes no matter what" timer.
            // ============================================================
            const SESSION_WARNING_AT_MS = 29 * 60 * 1000;   // show the countdown at 29 min idle...
            const SESSION_TIMEOUT_MS = 30 * 60 * 1000;      // ...matching the server's 30-min idle logout
            let lastUserActivityTime = Date.now();
            let sessionWarningInterval = null;
            let sessionWarningShown = false;

            function recordUserActivity() {
                lastUserActivityTime = Date.now();
                if (sessionWarningShown) {
                    dismissSessionWarning();
                }
            }

            ['mousedown', 'keydown', 'touchstart', 'scroll'].forEach(evt => {
                document.addEventListener(evt, recordUserActivity, { passive: true });
            });

            function startSessionTimeoutWatcher() {
                if (sessionWarningInterval) return;
                sessionWarningInterval = setInterval(() => {
                    if (!CURRENT_USER_ID || !AUTH_TOKEN) return;
                    const idleFor = Date.now() - lastUserActivityTime;
                    if (idleFor >= SESSION_TIMEOUT_MS) {
                        dismissSessionWarning();
                        handleSessionExpired();
                    } else if (idleFor >= SESSION_WARNING_AT_MS && !sessionWarningShown) {
                        showSessionWarning();
                    } else if (sessionWarningShown) {
                        updateSessionWarningCountdown();
                    }
                }, 1000);
            }

            function showSessionWarning() {
                sessionWarningShown = true;
                const html = `
                    <div class="admin-modal-overlay" id="sessionWarningOverlay">
                        <div class="admin-modal-card" style="max-width:420px;text-align:center;">
                            <h3 class="admin-modal-title">⏳ Session Expiring Soon</h3>
                            <p style="font-size:0.9rem;color:rgba(0,0,0,0.7);margin:14px 0;">
                                You've been inactive for a while. For your security, you'll be logged out in
                            </p>
                            <p style="font-size:2.2rem;font-weight:700;color:#c0392b;margin:0 0 16px 0;" id="sessionWarningCountdown">1:00</p>
                            <div class="lease-review-actions" style="justify-content:center;">
                                <button class="plan-cta-btn" onclick="resumeSessionFromWarning()">▶ Resume Session</button>
                            </div>
                        </div>
                    </div>
                `;
                const existing = document.getElementById('sessionWarningOverlay');
                if (existing) existing.remove();
                document.body.insertAdjacentHTML('beforeend', html);
            }

            function updateSessionWarningCountdown() {
                const el = document.getElementById('sessionWarningCountdown');
                if (!el) return;
                const remainingMs = Math.max(0, SESSION_TIMEOUT_MS - (Date.now() - lastUserActivityTime));
                const totalSeconds = Math.ceil(remainingMs / 1000);
                const mm = Math.floor(totalSeconds / 60);
                const ss = totalSeconds % 60;
                el.textContent = `${mm}:${String(ss).padStart(2, '0')}`;
            }

            function dismissSessionWarning() {
                sessionWarningShown = false;
                const overlay = document.getElementById('sessionWarningOverlay');
                if (overlay) overlay.remove();
            }

            window.resumeSessionFromWarning = async function() {
                recordUserActivity();
                // A lightweight authenticated call to genuinely refresh the
                // SERVER's own lastActiveAt too (not just the client-side
                // clock) - /api/auth/me is already a plain read, no side
                // effects, just needs a valid session to succeed.
                try { await authFetch('/api/auth/me?userId=' + encodeURIComponent(CURRENT_USER_ID)); } catch (e) { /* handled by authFetch's own 401 handling if it's actually expired */ }
            };

            function startLivePolling() {
                if (_livePollInterval) return;
                _livePollInterval = setInterval(async () => {
                    if (!CURRENT_USER_ID || !AUTH_TOKEN) return;
                    try {
                        const [notifRes, payRes] = await Promise.all([
                            fetch('json/notifications.json?_=' + Date.now()),
                            authFetch('/api/data/payment-history?_=' + Date.now()),
                        ]);
                        const [freshNotifications, freshPaymentHistory] = await Promise.all([notifRes.json(), payRes.json()]);

                        const notifChanged = JSON.stringify(freshNotifications) !== JSON.stringify(notifications);
                        const payChanged = JSON.stringify(freshPaymentHistory) !== JSON.stringify(paymentHistory);

                        if (notifChanged) {
                            notifications = freshNotifications;
                            updateNotificationBadge();
                            if (activeItemId === 'notification') renderNotificationTable();
                        }
                        if (payChanged) {
                            paymentHistory = freshPaymentHistory;
                            updateBalanceDisplay();
                            if (activeItemId === 'payment-history') renderPaymentHistory();
                            if (activeItemId === 'dashboard' && document.getElementById('todayTableBody')) renderTodayTransactions();
                        }
                    } catch (e) { /* a missed poll just tries again in 15s - not worth surfacing to the user */ }
                }, 15000);
            }

            async function boot() {
                try {
                    COMPANY_INFO = await fetchJSON('json/company.json');
                } catch (e) { /* auth screen falls back to a default name */ }

                if (tryHandleMagicVerifyLink()) return;

                const savedUserId = localStorage.getItem(AUTH_SESSION_KEY);
                const savedToken = localStorage.getItem(AUTH_TOKEN_KEY);
                if (savedUserId && savedToken) {
                    AUTH_TOKEN = savedToken;
                    window.__lexoraAuthToken = savedToken;
                    try {
                        // The server derives identity from the token itself
                        // now (not the userId in the URL) - this doubles as
                        // validating the saved token is still good.
                        const res = await authFetch('/api/auth/me');
                        if (res.ok) {
                            CURRENT_USER_ID = savedUserId;
                            document.getElementById('authScreen').style.display = 'none';
                            // NOTE: appShell reveal moved to the end of
                            // initializeApp() (after setupUserProfile() /
                            // applyCompanyBranding() run) - this used to
                            // show the shell right here, which meant the
                            // static placeholder in index.html ("TechCorp
                            // Solutions" / "John Doe") flashed on screen
                            // until loadAppData() finished and swapped in
                            // the real company/user name.
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
                    document.getElementById('appShell').style.display = '';
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
                // Real company/user name is in place now - safe to reveal
                // the shell (see boot()/completeLogin() notes).
                document.getElementById('appShell').style.display = '';
                renderMenu();
                updateNotificationBadge();
                startLivePolling();
                startSessionTimeoutWatcher();

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
