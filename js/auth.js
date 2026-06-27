// ============================================
// LEXORA — Authentication System (auth.js)
// Unified OTP for Login · Register · Reset
// ============================================

'use strict';

const AUTH_KEY  = 'lexora_auth';
const USERS_KEY = 'lexora_users';
const TEMP_KEY  = 'lexora_temp_accounts';
const VIEWS     = ['view-login','view-reset','view-create','view-verify'];

// ── Simple hash ──────────────────────────────
function hashPassword(pw) {
  let h = 5381;
  for (let i = 0; i < pw.length; i++) { h = ((h << 5) + h) + pw.charCodeAt(i); h |= 0; }
  return Math.abs(h).toString(16).padStart(8, '0');
}

// ── DB helpers ───────────────────────────────
const DEFAULT_USERS = [{
  id:'usr_001', firstName:'Himmat', lastName:'Parmar', gender:'Male', dob:'1983-05-24',
  mobile:'9904143278', email:'himmat4f1@gmail.com', passwordHash: '7dd1705a', // hashPassword('123456')
  role:'admin', account_type:'admin', plan:'Pro', balance:1247.00,
  apikey:'', lock:'yes', status:'active', session_status:'online',
  verification_code:'', profile_photo:'user_directory/usr_001/profile_photo',
  profile_photo_data:'', input_folder:'user_directory/usr_001/input',
  output_folder:'user_directory/usr_001/output',
  createdAt: new Date().toISOString(), lastLogin:null, active:true,
  system_setup:{ theme:'light', language:'en', timezone:'Asia/Kolkata', email_notifications:true }
}];

function getUsers() {
  const r = localStorage.getItem(USERS_KEY);
  return r ? JSON.parse(r) : JSON.parse(JSON.stringify(DEFAULT_USERS));
}
function saveUsers(u) { localStorage.setItem(USERS_KEY, JSON.stringify(u)); }

(function seedUsers() {
  const raw = localStorage.getItem(USERS_KEY);
  if (!raw) { saveUsers(DEFAULT_USERS); return; }
  try {
    const existing = JSON.parse(raw);
    // If admin user has a non-djb2 hash (SHA-256 = 64 chars, or old format),
    // force reseed with correct DEFAULT_USERS
    const admin = existing.find(function(u){ return u.role === 'admin'; });
    if (admin && (admin.passwordHash.length > 12 || admin.passwordHash === '1a73090f' || admin.two_factor_auth === undefined)) {
      console.log('[Lexora] Reseeding users (hash version mismatch)');
      saveUsers(DEFAULT_USERS);
    }
  } catch(e) { saveUsers(DEFAULT_USERS); }
})();

// ── Session ──────────────────────────────────
function setSession(user) {
  const s = { userId:user.id, firstName:user.firstName, lastName:user.lastName,
              email:user.email, role:user.role, plan:user.plan, loginAt:new Date().toISOString() };
  localStorage.setItem(AUTH_KEY, JSON.stringify(s));
}
function getSession() { const r=localStorage.getItem(AUTH_KEY); return r?JSON.parse(r):null; }
function clearSession() { localStorage.removeItem(AUTH_KEY); }
function isLoggedIn() { return getSession()!==null; }

function requireAuth() {
  if (!isLoggedIn()) { showAuthOverlay(); }
}
function requireGuest() {
  if (isLoggedIn()) { hideAuthOverlay(); }
}

// ── Auth overlay control ─────────────────────
function showAuthOverlay() {
  const overlay = document.getElementById('authOverlay');
  const app     = document.getElementById('mainAppWrapper');
  if (overlay) overlay.style.display = 'flex';
  if (app)     app.classList.remove('active');
  authShowView('view-login');
}

function hideAuthOverlay() {
  const overlay = document.getElementById('authOverlay');
  const app     = document.getElementById('mainAppWrapper');
  if (overlay) overlay.style.display = 'none';
  if (app)     app.classList.add('active');
}

function doLogout() {
  clearSession();
  showAuthOverlay();
}

// ── View switcher ────────────────────────────
function authShowView(id) {
  VIEWS.forEach(function(v) {
    const el = document.getElementById(v);
    if (el) el.classList.toggle('hidden', v !== id);
  });
  clearAllErrors();
}

// ── Error helpers ────────────────────────────
function showError(id, msg) { const e=document.getElementById(id); if(e){e.textContent=msg;e.style.display='block';} }
function clearError(id) { const e=document.getElementById(id); if(e){e.textContent='';e.style.display='none';} }
function clearAllErrors() { document.querySelectorAll('.auth-error').forEach(function(e){e.textContent='';e.style.display='none';}); }

// ── Toggle password ──────────────────────────
function togglePwd(inputId, btnId) {
  const inp=document.getElementById(inputId), btn=document.getElementById(btnId);
  if (!inp||!btn) return;
  if (inp.type==='password') { inp.type='text'; btn.innerHTML='<i class="fas fa-eye-slash"></i>'; }
  else { inp.type='password'; btn.innerHTML='<i class="fas fa-eye"></i>'; }
}

// ════════════════════════════════════════════════
// UNIFIED OTP SYSTEM
// ════════════════════════════════════════════════
let _otpCode     = null;
let _otpExpiry   = null;
let _otpTimer    = null;
let _otpContext  = null; // 'login' | 'register' | 'reset'
let _otpCallback = null; // called on successful verification
let _pendingData = {};   // stores pending login user / registration data / reset email

function startOTP(context, email, title, onSuccess) {
  _otpContext  = context;
  _otpCallback = onSuccess;

  const smtpCfg    = JSON.parse(localStorage.getItem('lexora_smtp') || '{}');
  const expiryMins = parseInt(smtpCfg.expiry_minutes) || 4;
  _otpCode   = Math.floor(100000 + Math.random() * 900000).toString();
  _otpExpiry = Date.now() + expiryMins * 60 * 1000;

  // Set OTP card text (null-safe)
  const titleEl   = document.getElementById('verifyTitle');
  const subtextEl = document.getElementById('verifySubtext');
  const demoBox   = document.getElementById('verify-demo-box');
  const inp       = document.getElementById('verify-code');
  if (titleEl)   titleEl.textContent   = title || 'Verify Code';
  if (subtextEl) subtextEl.textContent = 'Enter the 6-digit code sent to ' + email;
  if (demoBox)   demoBox.style.display = 'none';
  if (inp)       inp.value = '';
  clearError('verify-err');

  // Send email
  fetch('/api/auth/sendcode', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ email, code: _otpCode, expiryMins })
  }).then(function(r){return r.json();})
    .then(function(res){ if(!res.success) _showDemoCode(_otpCode); })
    .catch(function() { _showDemoCode(_otpCode); });

  authShowView('view-verify');
  _startOTPTimer(expiryMins);
}

function _showDemoCode(code) {
  // Demo mode: log to browser console ONLY (not shown in UI)
  // Configure SMTP in Admin > Email Settings to send real emails
  console.info('%c[Lexora OTP] Code: ' + code + ' (expires soon)', 'background:#3b82f6;color:white;padding:4px 8px;border-radius:4px;font-size:14px;font-weight:bold;');
  // Hide demo box if it exists (no visible fallback)
  const box = document.getElementById('verify-demo-box');
  if (box) box.style.display = 'none';
}

function _startOTPTimer(mins) {
  clearInterval(_otpTimer);
  let remaining = mins * 60;
  const timerEl = document.getElementById('verify-timer');
  _otpTimer = setInterval(function() {
    remaining--;
    if (timerEl) {
      const m=Math.floor(remaining/60), s=remaining%60;
      timerEl.textContent = m+':'+(s<10?'0':'')+s;
      timerEl.style.color = remaining<60 ? '#ef4444' : '#f59e0b';
    }
    if (remaining<=0) { clearInterval(_otpTimer); if(timerEl){timerEl.textContent='Expired';timerEl.style.color='#ef4444';} }
  }, 1000);
}

function handleVerifyCode() {
  clearAllErrors();
  const code = (document.getElementById('verify-code').value||'').trim();
  if (!code)                    { showError('verify-err','Enter the verification code.'); return; }
  if (!_otpCode)                { authShowView('view-login'); return; }
  if (Date.now() > _otpExpiry)  { showError('verify-err','Code expired. Click Resend.'); return; }
  if (code !== _otpCode)        { showError('verify-err','Incorrect code. Try again.'); return; }

  clearInterval(_otpTimer);
  if (_otpCallback) _otpCallback();
}

function resendVerifyCode() {
  if (!_pendingData.email) { authShowView('view-login'); return; }
  document.getElementById('verify-code').value = '';
  clearError('verify-err');
  startOTP(_otpContext, _pendingData.email,
    document.getElementById('verifyTitle').textContent, _otpCallback);
}

function cancelVerify() {
  clearInterval(_otpTimer);
  _otpCode=null; _otpCallback=null;
  if (_otpContext==='reset')    { authShowView('view-reset'); }
  else if (_otpContext==='register') { authShowView('view-create'); }
  else                               { authShowView('view-login'); }
}

// ════════════════════════════════════════════════
// LOGIN
// ════════════════════════════════════════════════
function handleLogin(e) {
  e.preventDefault();
  clearAllErrors();
  const email = document.getElementById('login-email').value.trim().toLowerCase();
  const pw    = document.getElementById('login-password').value;
  if (!email) { showError('login-email-err','Email is required.'); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showError('login-email-err','Enter valid email.'); return; }
  if (!pw)    { showError('login-pw-err','Password is required.'); return; }

  const users = getUsers();
  const user  = users.find(function(u){ return u.email===email && u.active; });
  if (!user)                                   { showError('login-email-err','No account found.'); return; }
  if (user.passwordHash !== hashPassword(pw))  { showError('login-pw-err','Incorrect password.'); return; }
  if (user.status === 'hold')                  { showError('login-email-err','Account on hold. Contact admin.'); return; }

  _pendingData = { user };

  // Check if user has 2FA enabled (default: true)
  if (user.two_factor_auth === false) {
    // 2FA disabled — skip OTP, login directly
    var us = getUsers();
    var u  = us.find(function(x){ return x.id===user.id; });
    if (u) { u.lastLogin=new Date().toISOString(); saveUsers(us); }
    setSession(user);
    hideAuthOverlay();
    if (typeof loadDashboard==='function') loadDashboard();
    if (typeof loadProfile==='function')   loadProfile();
    return;
  }

  // 2FA enabled — send OTP
  startOTP('login', email, 'Verify Login', function() {
    var us = getUsers();
    var u  = us.find(function(x){ return x.id===_pendingData.user.id; });
    if (u) { u.lastLogin=new Date().toISOString(); saveUsers(us); }
    setSession(_pendingData.user);
    hideAuthOverlay();
    if (typeof loadDashboard==='function') loadDashboard();
    if (typeof loadProfile==='function')   loadProfile();
  });
}

// ════════════════════════════════════════════════
// RESET PASSWORD
// ════════════════════════════════════════════════
let _resetEmail = '';

function handleResetStep1(e) {
  e.preventDefault();
  clearAllErrors();
  const email = document.getElementById('reset-email').value.trim().toLowerCase();
  if (!email) { showError('reset-email-err','Email is required.'); return; }

  const users = getUsers();
  const user  = users.find(function(u){ return u.email===email && u.active; });
  if (!user) { showError('reset-email-err','No account with this email.'); return; }

  _resetEmail = email;
  _pendingData = { email };
  startOTP('reset', email, 'Reset Password', function() {
    // OTP verified → show new password form
    authShowView('view-reset');
    document.getElementById('reset-step1').style.display = 'none';
    document.getElementById('reset-step3').style.display = 'block';
  });
}

function handleResetNewPwd(e) {
  e.preventDefault();
  clearAllErrors();
  const newPw   = document.getElementById('reset-newpw').value;
  const confirm = document.getElementById('reset-confirmpw').value;
  if (!newPw || newPw.length<6) { showError('reset-newpw-err','Min 6 characters.'); return; }
  if (newPw !== confirm)         { showError('reset-confirmpw-err','Passwords do not match.'); return; }

  const users = getUsers();
  const user  = users.find(function(u){ return u.email===_resetEmail; });
  if (user) { user.passwordHash=hashPassword(newPw); saveUsers(users); }

  document.getElementById('reset-step3').style.display = 'none';
  document.getElementById('reset-success').style.display = 'block';
  setTimeout(function() {
    document.getElementById('reset-step1').style.display = 'block';
    document.getElementById('reset-step3').style.display = 'none';
    document.getElementById('reset-success').style.display = 'none';
    authShowView('view-login');
  }, 2500);
}

// ════════════════════════════════════════════════
// CREATE ACCOUNT → temp_accounts → OTP → users
// ════════════════════════════════════════════════
function handleCreateAccount(e) {
  e.preventDefault();
  clearAllErrors();
  const firstName  = (document.getElementById('reg-firstname').value||'').trim();
  const lastName   = (document.getElementById('reg-lastname').value||'').trim();
  const gender     = document.getElementById('reg-gender').value;
  const dob        = document.getElementById('reg-dob').value;
  const mobile     = (document.getElementById('reg-mobile').value||'').trim();
  const email      = (document.getElementById('reg-email').value||'').trim().toLowerCase();
  const pw         = document.getElementById('reg-password').value;
  const confirm    = document.getElementById('reg-confirmpw').value;
  let valid = true;
  if (!firstName) { showError('reg-firstname-err','Required.'); valid=false; }
  if (!lastName)  { showError('reg-lastname-err','Required.'); valid=false; }
  if (!gender)    { showError('reg-gender-err','Required.'); valid=false; }
  if (!dob)       { showError('reg-dob-err','Required.'); valid=false; }
  if (!mobile||!/^\d{10}$/.test(mobile)) { showError('reg-mobile-err','Valid 10-digit number.'); valid=false; }
  if (!email||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showError('reg-email-err','Valid email required.'); valid=false; }
  if (!pw||pw.length<6) { showError('reg-pw-err','Min 6 characters.'); valid=false; }
  if (pw!==confirm)     { showError('reg-confirmpw-err','Passwords do not match.'); valid=false; }
  if (!valid) return;

  const users = getUsers();
  if (users.find(function(u){ return u.email===email; })) { showError('reg-email-err','Email already registered.'); return; }

  const newUserId = 'usr_'+Date.now();
  _pendingData = {
    email, id: newUserId,
    pendingUser: {
      id:newUserId, firstName, lastName, gender, dob, mobile, email,
      passwordHash:hashPassword(pw), role:'user', account_type:'user',
      plan:'Basic', balance:0, apikey:'', lock:'no', status:'active',
      session_status:'offline', verification_code:'', profile_photo:'', profile_photo_data:'',
      input_folder:'user_directory/'+newUserId+'/input',
      output_folder:'user_directory/'+newUserId+'/output',
      createdAt:new Date().toISOString(), lastLogin:null, active:true,
      system_setup:{ theme:'light', language:'en', timezone:'UTC', email_notifications:true }
    }
  };

  // Save to temp_accounts first
  _saveTempAccount(_pendingData.pendingUser, function() {
    startOTP('register', email, 'Verify Registration', function() {
      // OTP verified → move to users.json
      const us = getUsers();
      us.push(_pendingData.pendingUser);
      saveUsers(us);
      // Remove from temp_accounts
      _removeTempAccount(email);
      // Also try server
      fetch('/api/register/approve-direct', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ email })
      }).catch(function(){});

      authShowView('view-login');
      setTimeout(function(){
        document.getElementById('reg-success') && (document.getElementById('reg-success').style.display='none');
      }, 100);
      showError('login-email-err', '');
      clearAllErrors();
      // Show success on login view
      const loginForm = document.querySelector('#view-login');
      if (loginForm) {
        const msg = document.createElement('div');
        msg.className = 'auth-success-msg';
        msg.style.display = 'block';
        msg.textContent = '✅ Account created! You can now login.';
        loginForm.prepend(msg);
        setTimeout(function(){ msg.remove(); }, 4000);
      }
    });
  });
}

function _saveTempAccount(userData, callback) {
  const temp = JSON.parse(localStorage.getItem(TEMP_KEY) || '{"pending":[]}');
  temp.pending.push(Object.assign({}, userData, { requestedAt: new Date().toISOString(), code_expires: new Date(Date.now() + 15*60*1000).toISOString() }));
  localStorage.setItem(TEMP_KEY, JSON.stringify(temp));
  fetch('/api/register/request', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(userData)
  }).catch(function(){});
  if (callback) callback();
}

function _removeTempAccount(email) {
  const temp = JSON.parse(localStorage.getItem(TEMP_KEY) || '{"pending":[]}');
  temp.pending = temp.pending.filter(function(p){ return p.email!==email; });
  localStorage.setItem(TEMP_KEY, JSON.stringify(temp));
}

// ── Expose globals ────────────────────────────
window.hashPassword        = hashPassword;
window.getUsers            = getUsers;
window.saveUsers           = saveUsers;
window.getSession          = getSession;
window.setSession          = setSession;
window.clearSession        = clearSession;
window.isLoggedIn          = isLoggedIn;
window.requireAuth         = requireAuth;
window.doLogout            = doLogout;
window.showAuthOverlay     = showAuthOverlay;
window.hideAuthOverlay     = hideAuthOverlay;
window.authShowView        = authShowView;
window.togglePwd           = togglePwd;
window.handleLogin         = handleLogin;
window.handleVerifyCode    = handleVerifyCode;
window.resendVerifyCode    = resendVerifyCode;
window.cancelVerify        = cancelVerify;
window.handleResetStep1    = handleResetStep1;
window.handleResetNewPwd   = handleResetNewPwd;
window.handleCreateAccount = handleCreateAccount;
