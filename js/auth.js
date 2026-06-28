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
  two_factor_auth: false,
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
    // Only reseed if the hash format is wrong (old SHA-256 or known bad hash)
    const admin = existing.find(function(u){ return u.role === 'admin'; });
    if (admin && (admin.passwordHash.length > 12 || admin.passwordHash === '1a73090f')) {
      console.log('[Lexora] Reseeding users (hash version mismatch)');
      saveUsers(DEFAULT_USERS);
    } else if (admin && admin.two_factor_auth === undefined) {
      // Patch: add two_factor_auth without wiping existing data (totp_secret etc.)
      admin.two_factor_auth = false;
      saveUsers(existing);
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
// ════════════════════════════════════════════════
// TOTP ENGINE (RFC 6238, WebCrypto — no external lib)
// ════════════════════════════════════════════════
const _B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function _b32decode(s) {
  s = s.toUpperCase().replace(/[^A-Z2-7]/g,'');
  let bits=0, val=0; const out=[];
  for(let i=0;i<s.length;i++){val=(val<<5)|_B32.indexOf(s[i]);bits+=5;if(bits>=8){out.push((val>>>(bits-8))&255);bits-=8;}}
  return new Uint8Array(out);
}
function _b32encode(bytes) {
  let bits=0,val=0,out='';
  for(let i=0;i<bytes.length;i++){val=(val<<8)|bytes[i];bits+=8;while(bits>=5){out+=_B32[(val>>>(bits-5))&31];bits-=5;}}
  if(bits>0) out+=_B32[(val<<(5-bits))&31];
  return out;
}
function _generateTotpSecret() { return _b32encode(crypto.getRandomValues(new Uint8Array(20))); }
async function _computeTotp(secret, slot) {
  const key=_b32decode(secret), t=slot!==undefined?slot:Math.floor(Date.now()/30000);
  const msg=new ArrayBuffer(8); new DataView(msg).setUint32(4,t,false);
  const ck=await crypto.subtle.importKey('raw',key,{name:'HMAC',hash:'SHA-1'},false,['sign']);
  const sig=new Uint8Array(await crypto.subtle.sign('HMAC',ck,msg));
  const off=sig[19]&0x0f;
  return String((((sig[off]&0x7f)<<24)|(sig[off+1]<<16)|(sig[off+2]<<8)|sig[off+3])%1000000).padStart(6,'0');
}
async function _verifyTotp(secret, code) {
  const t=Math.floor(Date.now()/30000);
  for(let d=-1;d<=1;d++) if(await _computeTotp(secret,t+d)===code) return true;
  return false;
}

// TOTP state
let _totpMode=false, _totpPendingSecret='', _totpRefreshTimer=null;

function _startTotpCountdown() {
  clearInterval(_totpRefreshTimer);
  const bar=document.getElementById('totp-progress-bar'), secs=document.getElementById('totp-seconds');
  function tick(){
    const rem=30-(Math.floor(Date.now()/1000)%30), pct=(rem/30)*100;
    if(bar){bar.style.width=pct+'%'; bar.style.background=rem<5?'#ef4444':'#22c55e';}
    if(secs) secs.textContent=rem+'s';
  }
  tick(); _totpRefreshTimer=setInterval(tick,1000);
}

async function saveTotpSecret(email, secret) {
  try { await fetch('/api/auth/save-totp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,secret})}); } catch(e){}
}

function startTotpSetup(user) {
  _totpPendingSecret = _generateTotpSecret();
  const uri = 'otpauth://totp/Lexora:'+encodeURIComponent(user.email)+'?secret='+_totpPendingSecret+'&issuer=Lexora&algorithm=SHA1&digits=6&period=30';
  authShowView('view-totp-setup');
  var qrEl=document.getElementById('totp-qr');
  if(qrEl){ qrEl.innerHTML=''; if(typeof QRCode!=='undefined') new QRCode(qrEl,{text:uri,width:180,height:180,colorDark:'#1e293b',colorLight:'#ffffff',correctLevel:QRCode.CorrectLevel.M}); }
  var keyEl=document.getElementById('totp-secret-text');
  if(keyEl) keyEl.textContent=(_totpPendingSecret.match(/.{1,4}/g)||[]).join(' ');
  var inp=document.getElementById('totp-setup-code'); if(inp) inp.value='';
  clearError('totp-setup-err');
}

async function confirmTotpSetup() {
  var code=(document.getElementById('totp-setup-code').value||'').trim();
  if(!code||code.length!==6){showError('totp-setup-err','6-digit code enter kariye.');return;}
  if(!(await _verifyTotp(_totpPendingSecret,code))){showError('totp-setup-err','Galat code. App me dobara dekhiye.');return;}
  var users=getUsers(), u=users.find(function(x){return x.id===_pendingData.user.id;});
  if(u){u.totp_secret=_totpPendingSecret;saveUsers(users);}
  await saveTotpSecret(_pendingData.user.email, _totpPendingSecret);
  _pendingData.user.totp_secret=_totpPendingSecret;
  var us=getUsers(), lu=us.find(function(x){return x.id===_pendingData.user.id;});
  if(lu){lu.lastLogin=new Date().toISOString();saveUsers(us);}
  setSession(_pendingData.user);
  window.location.reload();
}

function cancelTotpSetup() { _totpPendingSecret=''; authShowView('view-login'); }

function _startTotpVerify(secret, context, callback) {
  _totpMode=true; _totpPendingSecret=secret; _otpContext=context; _otpCallback=callback;
  var els={title:document.getElementById('verifyTitle'),sub:document.getElementById('verifySubtext'),
    instr:document.getElementById('totp-instructions'),demo:document.getElementById('verify-demo-box'),
    timerRow:document.getElementById('verify-timer-row'),resend:document.getElementById('btnResendCode')};
  if(els.title) els.title.textContent='🔐 Authenticator Verify';
  if(els.sub)   els.sub.textContent='Authenticator app se Lexora ka code enter kariye';
  if(els.instr) els.instr.style.display='block';
  if(els.demo)  els.demo.style.display='none';
  if(els.timerRow) els.timerRow.style.display='none';
  if(els.resend)   els.resend.style.display='none';
  var inp=document.getElementById('verify-code'); if(inp) inp.value='';
  clearError('verify-err');
  _startTotpCountdown();
  authShowView('view-verify');
}

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
  _totpMode    = false;  // ensure email mode

  // Reset verify view to email OTP mode
  var instrBox  = document.getElementById('totp-instructions');
  var timerRow  = document.getElementById('verify-timer-row');
  var resendBtn = document.getElementById('btnResendCode');
  if(instrBox)  instrBox.style.display  = 'none';
  if(timerRow)  timerRow.style.display  = '';
  if(resendBtn) resendBtn.style.display = '';

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
    .then(function(res){
      // Show fallback code if email was not sent (SMTP blocked on cloud / not configured)
      if(!res.success || res.emailSent === false) _showDemoCode(_otpCode);
    })
    .catch(function() { _showDemoCode(_otpCode); });

  authShowView('view-verify');
  _startOTPTimer(expiryMins);
}

function _showDemoCode(code) {
  // Show code in UI when email fails (e.g. Gmail blocks cloud IP on Render)
  console.info('%c[Lexora OTP] Code: ' + code + ' (expires soon)', 'background:#3b82f6;color:white;padding:4px 8px;border-radius:4px;font-size:14px;font-weight:bold;');
  const box     = document.getElementById('verify-demo-box');
  const codeEl  = document.getElementById('verify-demo-code');
  if (box)    box.style.display    = 'block';
  if (codeEl) codeEl.textContent   = code;
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

async function handleVerifyCode() {
  clearAllErrors();
  const code = (document.getElementById('verify-code').value||'').trim();
  if (!code) { showError('verify-err','Code enter kariye.'); return; }

  if (_totpMode) {
    // ── TOTP path ──────────────────────────────────────────────────
    if (!_totpPendingSecret) { authShowView('view-login'); return; }
    const valid = await _verifyTotp(_totpPendingSecret, code);
    if (!valid) { showError('verify-err','Galat code. App me dobara dekhiye.'); return; }
    clearInterval(_totpRefreshTimer);
    _totpMode = false;
    if (_otpCallback) _otpCallback();
  } else {
    // ── Email OTP path ─────────────────────────────────────────────
    if (!_otpCode)               { authShowView('view-login'); return; }
    if (Date.now() > _otpExpiry) { showError('verify-err','Code expire ho gaya. Resend kariye.'); return; }
    if (code !== _otpCode)       { showError('verify-err','Galat code. Dobara try kariye.'); return; }
    clearInterval(_otpTimer);
    if (_otpCallback) _otpCallback();
  }
}

function resendVerifyCode() {
  if (_totpMode) {
    // TOTP mode — no resend needed, just clear input
    document.getElementById('verify-code').value = '';
    clearError('verify-err');
    return;
  }
  if (!_pendingData.email) { authShowView('view-login'); return; }
  document.getElementById('verify-code').value = '';
  clearError('verify-err');
  startOTP(_otpContext, _pendingData.email,
    document.getElementById('verifyTitle').textContent, _otpCallback);
}

function cancelVerify() {
  clearInterval(_otpTimer);
  clearInterval(_totpRefreshTimer);
  _otpCode=null; _otpCallback=null; _totpMode=false; _totpPendingSecret='';
  if (_otpContext==='reset')         { authShowView('view-reset'); }
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
  if (!user)                                  { showError('login-email-err','No account found.'); return; }
  if (user.passwordHash !== hashPassword(pw)) { showError('login-pw-err','Incorrect password.'); return; }
  if (user.status === 'hold')                 { showError('login-email-err','Account on hold. Contact admin.'); return; }

  _pendingData = { user: user, email: user.email };

  // Show OTP method selector if mobile is verified
  var methodSel = document.getElementById('otpMethodSelector');
  if (methodSel) {
    if (user.mobile_verified && user.mobile) {
      methodSel.style.display = 'block';
      // Auto-select from user's saved preference
      var savedMethod = user.otp_method || 'email';
      var emailRad = document.getElementById('otpMethodEmail');
      var waRad    = document.getElementById('otpMethodWA');
      if (emailRad) emailRad.checked = (savedMethod !== 'whatsapp');
      if (waRad)    waRad.checked    = (savedMethod === 'whatsapp');
    } else {
      methodSel.style.display = 'none';
    }
  }

  var onVerified = function() {
    var us = getUsers();
    var u  = us.find(function(x){ return x.id === user.id; });
    if (u) { u.lastLogin = new Date().toISOString(); saveUsers(us); }
    setSession(user);
    window.location.reload();
  };

  _pendingData._onVerified = onVerified;

  // Check selected method
  var waRadio = document.getElementById('otpMethodWA');
  var useWA   = waRadio && waRadio.checked && user.mobile_verified && user.mobile;

  if (useWA) {
    _startWhatsAppLoginOTP(user, onVerified);
  } else {
    startOTP('login', user.email, '🔐 Login Verify', onVerified);
  }
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
window.startTotpSetup      = startTotpSetup;
window.confirmTotpSetup    = confirmTotpSetup;
window.cancelTotpSetup     = cancelTotpSetup;

// ════════════════════════════════════════════════════════════
// WHATSAPP LOGIN OTP
// ════════════════════════════════════════════════════════════
var _waLoginCode   = null;
var _waLoginExpiry = null;
var _waLoginTimer  = null;

function _startWhatsAppLoginOTP(user, onVerified) {
  _waLoginCode   = Math.floor(100000 + Math.random() * 900000).toString();
  _waLoginExpiry = Date.now() + 4 * 60 * 1000;
  var mobile     = (user.mobile || '').replace(/^\+91|^91/,'');

  // Reset verify view for WhatsApp mode
  var titleEl   = document.getElementById('verifyTitle');
  var subtextEl = document.getElementById('verifySubtext');
  var demoBox   = document.getElementById('verify-demo-box');
  var demoCode  = document.getElementById('verify-demo-code');
  var timerRow  = document.getElementById('verify-timer-row');
  var resendBtn = document.getElementById('btnResendCode');
  var instrBox  = document.getElementById('totp-instructions');
  if (titleEl)   titleEl.textContent   = '📱 WhatsApp Verify';
  if (subtextEl) subtextEl.textContent = 'Code sent to WhatsApp: +91' + mobile;
  if (instrBox)  instrBox.style.display = 'none';
  if (demoBox)   demoBox.style.display  = 'none';
  if (timerRow)  timerRow.style.display = '';
  if (resendBtn) resendBtn.style.display = '';
  var inp = document.getElementById('verify-code'); if (inp) inp.value = '';
  clearError('verify-err');

  _totpMode    = false;
  _otpContext  = 'login';
  _otpCallback = onVerified;
  _otpCode     = _waLoginCode;
  _otpExpiry   = _waLoginExpiry;

  authShowView('view-verify');
  _startOTPTimer(4);

  fetch('/api/whatsapp/send', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mobile: '91' + mobile, code: _waLoginCode })
  }).then(function(r){ return r.json(); })
    .then(function(res) {
      if (!res.sent) {
        if (demoBox)  demoBox.style.display  = 'block';
        if (demoCode) demoCode.textContent    = res.code || _waLoginCode;
        console.info('%c[Lexora WhatsApp OTP] ' + (res.code || _waLoginCode),
          'background:#25d366;color:white;padding:4px 8px;border-radius:4px;font-weight:bold;');
      }
    }).catch(function() {
      if (demoBox)  demoBox.style.display  = 'block';
      if (demoCode) demoCode.textContent    = _waLoginCode;
    });
}

// Called when user switches Email ↔ WhatsApp radio on verify screen
function handleOTPMethodChange() {
  var waRadio  = document.getElementById('otpMethodWA');
  var useWA    = waRadio && waRadio.checked;
  var user     = _pendingData && _pendingData.user;
  var callback = _pendingData && _pendingData._onVerified;
  if (!user || !callback) return;

  clearInterval(_otpTimer);
  if (useWA && user.mobile_verified && user.mobile) {
    _startWhatsAppLoginOTP(user, callback);
  } else {
    startOTP('login', user.email, '🔐 Login Verify', callback);
  }
}

window.handleOTPMethodChange = handleOTPMethodChange;

// ════════════════════════════════════════════════════════════
// PROFILE — INLINE MOBILE VERIFY
// ════════════════════════════════════════════════════════════
var _mobileOTPCode   = null;
var _mobileOTPExpiry = null;
var _mobileOTPTimer  = null;

// Open modal first, then send OTP
function openMobileVerifyModal() {
  var phoneEl = document.getElementById('phone');
  var mobile  = phoneEl ? phoneEl.value.trim() : '';
  if (!mobile || mobile.length < 10) {
    alert('Please enter a valid 10-digit mobile number first.');
    return;
  }
  var modal = document.getElementById('mobileVerifyModal');
  if (modal) modal.style.display = 'flex';
  var subtext = document.getElementById('mobileModalSubtext');
  if (subtext) subtext.textContent = 'Sending OTP to WhatsApp: +91 ' + mobile;
  sendMobileVerifyOTP();
}

function closeMobileVerifyModal() {
  clearInterval(_mobileOTPTimer);
  var modal = document.getElementById('mobileVerifyModal');
  if (modal) modal.style.display = 'none';
  var inp = document.getElementById('mobileModalOTPInput');
  if (inp) inp.value = '';
}

function sendMobileVerifyOTP() {
  var phoneEl = document.getElementById('phone');
  var mobile  = phoneEl ? phoneEl.value.trim() : '';
  if (!mobile || mobile.length < 10) return;

  _mobileOTPCode   = Math.floor(100000 + Math.random() * 900000).toString();
  _mobileOTPExpiry = Date.now() + 4 * 60 * 1000;

  var inp      = document.getElementById('mobileModalOTPInput');
  var demoBox  = document.getElementById('mobileModalDemoBox');
  var errEl    = document.getElementById('mobileModalErr');
  if (inp)     inp.value             = '';
  if (errEl)   errEl.style.display   = 'none';
  if (demoBox) demoBox.style.display = 'none';

  fetch('/api/whatsapp/send', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ mobile: '91' + mobile, code: _mobileOTPCode })
  }).then(function(r){ return r.json(); })
    .then(function(res) {
      if (!res.sent) {
        var demoCode = document.getElementById('mobileModalDemoCode');
        if (demoBox)  demoBox.style.display = 'block';
        if (demoCode) demoCode.textContent   = res.code || _mobileOTPCode;
        console.info('%c[Lexora Mobile OTP] ' + (res.code || _mobileOTPCode),
          'background:#25d366;color:white;padding:4px;border-radius:4px;font-weight:bold;');
      }
      _startMobileOTPTimer(4);
    }).catch(function() {
      var demoBox2 = document.getElementById('mobileModalDemoBox');
      var demoCode2 = document.getElementById('mobileModalDemoCode');
      if (demoBox2)  demoBox2.style.display = 'block';
      if (demoCode2) demoCode2.textContent   = _mobileOTPCode;
      _startMobileOTPTimer(4);
    });
}

function confirmMobileVerifyOTP() {
  var inp   = document.getElementById('mobileModalOTPInput');
  var code  = inp ? inp.value.trim() : '';
  var errEl = document.getElementById('mobileModalErr');
  var showErr = function(m){ if(errEl){ errEl.textContent=m; errEl.style.display='block'; } };

  if (!code)                         { showErr('Please enter the OTP.'); return; }
  if (!_mobileOTPCode)               { showErr('Please send OTP first.'); return; }
  if (Date.now() > _mobileOTPExpiry) { showErr('OTP expired. Please resend.'); return; }
  if (code !== _mobileOTPCode)       { showErr('Incorrect OTP. Try again.'); return; }

  clearInterval(_mobileOTPTimer);
  var phone   = (document.getElementById('phone') || {}).value || '';
  var session = getSession();
  var userId  = session ? session.id : null;
  if (!userId) return;

  fetch('/api/whatsapp/mark-verified', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ userId: userId, mobile: phone })
  }).then(function(r){ return r.json(); })
    .then(function(res) {
      if (res.success) {
        var s = getSession(); if (s) { s.mobile_verified=true; s.mobile=phone; setSession(s); }
        closeMobileVerifyModal();
        var badge = document.getElementById('mobileVerifiedBadge');
        if (badge) badge.style.display = 'inline';
        var hint = document.getElementById('waOTPMethodHint');
        if (hint) hint.style.display = 'none';
        if (typeof showModal === 'function')
          showModal('success', '✅ Mobile verified! WhatsApp OTP available for login.');
      }
    }).catch(function(){});
}

function _startMobileOTPTimer(mins) {
  clearInterval(_mobileOTPTimer);
  var rem = mins * 60;
  var el  = document.getElementById('mobileModalTimer');
  _mobileOTPTimer = setInterval(function() {
    rem--;
    if (el) {
      var m=Math.floor(rem/60), s=rem%60;
      el.textContent = m+':'+(s<10?'0':'')+s;
      el.style.color = rem<60?'#ef4444':'#f59e0b';
    }
    if (rem<=0){ clearInterval(_mobileOTPTimer); if(el){el.textContent='Expired';el.style.color='#ef4444';} }
  }, 1000);
}

window.openMobileVerifyModal  = openMobileVerifyModal;
window.closeMobileVerifyModal = closeMobileVerifyModal;
window.sendMobileVerifyOTP    = sendMobileVerifyOTP;
window.confirmMobileVerifyOTP = confirmMobileVerifyOTP;
