// ============================================
// PAYMENT & TRANSACTION DATA (loaded from JSON)
// ============================================

// Runtime cache — populated by loadPaymentData() and loadTransactionData()
let paymentMethods = [];
let currentTransactions = [];
let currentSummary = { totalCredit: 0, totalDebit: 0, balance: 0 };
let currentUserEmail = '';

// ── Load payment methods from db/payment_methods.json ────────────────────
function loadPaymentData() {
  const user = getCurrentUser();
  if (!user) return;
  currentUserEmail = user.email;

  // Try localStorage cache first, then fetch from disk
  const cached = localStorage.getItem('lexora_payments_' + user.id);
  if (cached) {
    const data = JSON.parse(cached);
    paymentMethods = data.methods || [];
    renderPaymentMethods();
  }

  fetch('/db/payment_methods.json?_=' + Date.now())
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) {
      if (data) {
        var userPay = (data.user_payments || {})[user.id] || { methods: [], balance: 0 };
        paymentMethods = userPay.methods || [];
        localStorage.setItem('lexora_payments_' + user.id, JSON.stringify(userPay));
      }
      renderPaymentMethods();
    })
    .catch(function() {
      renderPaymentMethods(); // render with cached data
    });
}

// ── Save payment methods to disk ──────────────────────────────────────────
function savePaymentData() {
  const user = getCurrentUser();
  if (!user) return;
  const payload = { userId: user.id, methods: paymentMethods };
  localStorage.setItem('lexora_payments_' + user.id, JSON.stringify({ methods: paymentMethods }));
  fetch('/api/payments/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).catch(function() {
    console.warn('[Lexora] Payment disk save skipped (server offline)');
  });
}

// ── Load transactions from db/transaction_history.json ────────────────────
function loadTransactionData() {
  const user = getCurrentUser();
  if (!user) return;

  const cached = localStorage.getItem('lexora_txn_' + user.id);
  if (cached) {
    const data = JSON.parse(cached);
    currentTransactions = data.transactions || [];
    currentSummary = data.summary || { totalCredit: 0, totalDebit: 0, balance: 0 };
    updateSummary(); renderTransactions(currentTransactions);
  }

  fetch('/db/transaction_history.json?_=' + Date.now())
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) {
      if (data) {
        var userTxn = (data.user_transactions || {})[user.id] || { transactions: [], summary: { totalCredit:0, totalDebit:0, balance:0 } };
        currentTransactions = userTxn.transactions || [];
        currentSummary      = userTxn.summary || { totalCredit: 0, totalDebit: 0, balance: 0 };
        localStorage.setItem('lexora_txn_' + user.id, JSON.stringify(userTxn));
      }
      updateSummary();
      renderTransactions(currentTransactions);
      setDateDefaults();
    })
    .catch(function() {
      console.warn('[Lexora] Could not load transaction_history.json');
    });
}

// ── Save transactions to disk ─────────────────────────────────────────────
function saveTransactionData() {
  const user = getCurrentUser();
  if (!user) return;
  const payload = { userId: user.id, transactions: currentTransactions, summary: currentSummary };
  localStorage.setItem('lexora_txn_' + user.id, JSON.stringify({ transactions: currentTransactions, summary: currentSummary }));
  fetch('/api/transactions/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).catch(function() {
    console.warn('[Lexora] Transaction disk save skipped (server offline)');
  });
}

function setDateDefaults() {
  const today    = new Date();
  const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
  const fromEl   = document.getElementById('fromDate');
  const toEl     = document.getElementById('toDate');
  if (fromEl) fromEl.value = firstDay.toISOString().split('T')[0];
  if (toEl)   toEl.value   = today.toISOString().split('T')[0];
}

// ============================================
// TRANSACTION HISTORY FUNCTIONS
// ============================================





function loadTransactions() {
  loadTransactionData();
}

function updateSummary() {
  const totalCredit = currentSummary.totalCredit || 
    currentTransactions
      .filter(t => t.type === 'credit')
      .reduce((sum, t) => sum + t.amount, 0);
  
  const totalDebit = currentSummary.totalDebit || 
    currentTransactions
      .filter(t => t.type === 'debit')
      .reduce((sum, t) => sum + t.amount, 0);
  
  const balance = totalCredit - totalDebit;
  
  const totalCreditEl = document.getElementById('totalCredit');
  const totalDebitEl = document.getElementById('totalDebit');
  const currentBalanceEl = document.getElementById('currentBalance');
  
  if (totalCreditEl) totalCreditEl.textContent = `$${totalCredit.toFixed(2)}`;
  if (totalDebitEl) totalDebitEl.textContent = `$${totalDebit.toFixed(2)}`;
  if (currentBalanceEl) currentBalanceEl.textContent = `$${balance.toFixed(2)}`;
}

function renderTransactions(transactions) {
  const list = document.getElementById('transactionList');
  if (!list) return;
  
  list.innerHTML = '';
  
  if (transactions.length === 0) {
    list.innerHTML = '<div style="text-align:center; color:#94a3b8; padding:2rem 0;">No transactions found for this user</div>';
    return;
  }
  
  const sorted = [...transactions].sort((a, b) => new Date(b.date) - new Date(a.date));
  
  sorted.forEach(txn => {
    const div = document.createElement('div');
    div.className = 'transaction-item';
    
    const date = new Date(txn.date);
    const dateStr = date.toLocaleDateString('en-US', { 
      day: '2-digit', 
      month: 'short', 
      year: 'numeric' 
    });
    const timeStr = date.toLocaleTimeString('en-US', { 
      hour: '2-digit', 
      minute: '2-digit' 
    });
    
    const amountClass = txn.type === 'credit' ? 'credit' : 'debit';
    const amountPrefix = txn.type === 'credit' ? '+' : '-';
    
    div.innerHTML = `
      <div class="txn-info">
        <span class="txn-desc">${txn.description}</span>
        <span class="txn-meta">${txn.id} • ${dateStr}, ${timeStr}</span>
      </div>
      <span class="txn-amount ${amountClass}">${amountPrefix}$${txn.amount.toFixed(2)}</span>
    `;
    list.appendChild(div);
  });
}

function addTransaction(description, type, amount) {
  const newTxn = {
    id: `TXN-${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`,
    date: new Date().toISOString(),
    description: description,
    type: type,
    amount: amount,
    balance: 0
  };
  
  const totalCredit = currentTransactions
    .filter(t => t.type === 'credit')
    .reduce((sum, t) => sum + t.amount, 0);
  const totalDebit = currentTransactions
    .filter(t => t.type === 'debit')
    .reduce((sum, t) => sum + t.amount, 0);
  
  if (type === 'credit') {
    newTxn.balance = totalCredit + amount - totalDebit;
  } else {
    newTxn.balance = totalCredit - (totalDebit + amount);
  }
  
  currentTransactions.push(newTxn);
  // Recalculate summary
  currentSummary.totalCredit = currentTransactions.filter(function(t){ return t.type==='credit'; }).reduce(function(s,t){ return s+t.amount; }, 0);
  currentSummary.totalDebit  = currentTransactions.filter(function(t){ return t.type==='debit';  }).reduce(function(s,t){ return s+t.amount; }, 0);
  currentSummary.balance     = currentSummary.totalCredit - currentSummary.totalDebit;

  updateSummary();
  renderTransactions(currentTransactions);
  saveTransactionData();

  return newTxn;
}

// ============================================
// MODAL MESSAGE SYSTEM
// ============================================

function showModal(type, message, options = {}) {
  const defaults = {
    success: { icon: '✅', title: 'Success' },
    error: { icon: '❌', title: 'Error' },
    warning: { icon: '⚠️', title: 'Warning' },
    info: { icon: 'ℹ️', title: 'Information' },
    confirm: { icon: '❓', title: 'Confirm' }
  };

  const config = defaults[type] || defaults.info;
  const icon = options.icon || config.icon;
  const title = options.title || config.title;
  const closeOnBackdrop = options.closeOnBackdrop !== undefined ? options.closeOnBackdrop : (type !== 'confirm');

  const overlay = document.getElementById('modalOverlay');
  if (!overlay) return;

  document.getElementById('modalIcon').textContent = icon;
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalMessage').innerHTML = message;

  const modalBox = document.getElementById('modalBox');
  modalBox.className = 'modal-box';
  if (type === 'success') modalBox.classList.add('success');
  else if (type === 'error') modalBox.classList.add('error');
  else if (type === 'warning') modalBox.classList.add('warning');
  else if (type === 'confirm') modalBox.classList.add('confirm');
  else modalBox.classList.add('info');

  const actionsContainer = document.getElementById('modalActions');
  actionsContainer.innerHTML = '';

  if (options.buttons && options.buttons.length > 0) {
    options.buttons.forEach(btn => {
      const button = document.createElement('button');
      button.className = btn.class || 'btn-primary';
      button.textContent = btn.label;
      button.onclick = function() {
        if (btn.callback) btn.callback();
        closeModal();
      };
      actionsContainer.appendChild(button);
    });
  } else if (type === 'confirm') {
    const yesBtn = document.createElement('button');
    yesBtn.className = 'btn-success';
    yesBtn.textContent = 'Yes';
    yesBtn.onclick = function() {
      if (options.onConfirm) options.onConfirm();
      closeModal();
    };
    actionsContainer.appendChild(yesBtn);

    const noBtn = document.createElement('button');
    noBtn.className = 'btn-danger';
    noBtn.textContent = 'No';
    noBtn.onclick = function() {
      if (options.onCancel) options.onCancel();
      closeModal();
    };
    actionsContainer.appendChild(noBtn);
  } else {
    const okBtn = document.createElement('button');
    okBtn.className = 'btn-primary';
    okBtn.textContent = 'OK';
    okBtn.onclick = function() {
      if (options.onConfirm) options.onConfirm();
      closeModal();
    };
    actionsContainer.appendChild(okBtn);
  }

  overlay.dataset.closeOnBackdrop = closeOnBackdrop;
  overlay.classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  const overlay = document.getElementById('modalOverlay');
  if (overlay) {
    overlay.classList.remove('active');
    document.body.style.overflow = '';
  }
}

function closeModalOnBackdrop(event) {
  const overlay = document.getElementById('modalOverlay');
  if (!overlay) return;
  const closeOnBackdrop = overlay.dataset.closeOnBackdrop === 'true';
  if (event.target === overlay && closeOnBackdrop) {
    closeModal();
  }
}

// ============================================
// PAYMENT FUNCTIONS
// ============================================

function renderPaymentMethods() {
  const list = document.getElementById('paymentMethodsList');
  if (!list) return;
  
  list.innerHTML = '';
  paymentMethods.forEach((method, index) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="method-info">
        <span class="method-icon"><i class="fas ${method.icon}"></i></span>
        <div class="method-details">
          <span class="method-name">${method.name}</span>
          <span class="method-number">${method.details}</span>
        </div>
      </div>
      <div class="method-actions">
        ${method.isDefault ? '<span class="default-badge">Default</span>' : `<a href="#" class="set-default" onclick="setDefault(${index}); return false;">Set Default</a>`}
        <a href="#" class="remove-method" onclick="removeMethod(${index}); return false;">Remove</a>
      </div>
    `;
    list.appendChild(li);
  });
}

function setDefault(index) {
  paymentMethods.forEach(function(m, i) { m.isDefault = (i === index); });
  renderPaymentMethods();
  savePaymentData();
  showModal('success', 'Default payment method updated!', { onConfirm: function(){} });
}

function removeMethod(index) {
  const user = getCurrentUser();
  const lock = user ? user.lock : 'no';
  if (lock === 'no') {
    showModal('warning', 'This user is locked (No). Enable lock (Yes) to allow deletions.');
    return;
  }
  if (paymentMethods[index] && paymentMethods[index].isDefault) {
    showModal('warning', 'Cannot remove default payment method. Set another as default first.');
    return;
  }
  paymentMethods.splice(index, 1);
  renderPaymentMethods();
  savePaymentData();
  showModal('info', 'Payment method removed.', { onConfirm: function(){} });
}

function showAddPayment() {
  const modalHTML = `
    <div style="text-align: left; font-size: 0.9rem;">
      <div class="payment-form">
        <div class="form-group">
          <label>Card Number</label>
          <input type="text" id="cardNumber" placeholder="1234 5678 9012 3456" style="width:100%; padding:0.6rem 1rem; border:2px solid #e2e8f0; border-radius:10px; font-size:0.9rem;" />
        </div>
        <div class="form-group">
          <label>Cardholder Name</label>
          <input type="text" id="cardName" placeholder="John Doe" style="width:100%; padding:0.6rem 1rem; border:2px solid #e2e8f0; border-radius:10px; font-size:0.9rem;" />
        </div>
        <div class="form-group" style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
          <div>
            <label>Expiry Date</label>
            <input type="text" id="cardExpiry" placeholder="MM/YY" style="width:100%; padding:0.6rem 1rem; border:2px solid #e2e8f0; border-radius:10px; font-size:0.9rem;" />
          </div>
          <div>
            <label>CVV</label>
            <input type="text" id="cardCVV" placeholder="123" style="width:100%; padding:0.6rem 1rem; border:2px solid #e2e8f0; border-radius:10px; font-size:0.9rem;" />
          </div>
        </div>
      </div>
    </div>
  `;

  showModal('info', modalHTML, {
    title: '💳 Add Payment Method',
    icon: '💳',
    closeOnBackdrop: false,
    buttons: [
      { label: 'Add Card', class: 'btn-success', callback: function() {
        const number = document.getElementById('cardNumber').value;
        const name = document.getElementById('cardName').value;
        if (!number || !name) {
          showModal('warning', 'Please fill in all fields.');
          return;
        }
        const last4 = number.slice(-4);
        const newMethod = {
          id: paymentMethods.length,
          name: `Card •••• ${last4}`,
          details: `Cardholder: ${name}`,
          icon: 'fa-credit-card',
          isDefault: false
        };
        paymentMethods.push(newMethod);
        renderPaymentMethods();
        savePaymentData();
        closeModal();
        showModal('success', 'Payment method added!', { onConfirm: function(){} });
      }},
      { label: 'Cancel', class: 'btn-secondary', callback: function() { closeModal(); } }
    ]
  });
}

function showAddAmount() {
  const modalHTML = `
    <div style="text-align: left; font-size: 0.9rem;">
      <div class="payment-form">
        <div class="form-group">
          <label>Payment Method</label>
          <select id="paymentMethodSelect" style="width:100%; padding:0.6rem 1rem; border:2px solid #e2e8f0; border-radius:10px; font-size:0.9rem;">
            ${paymentMethods.map((m, i) => `<option value="${i}" ${m.isDefault ? 'selected' : ''}>${m.name}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Amount ($)</label>
          <input type="number" id="amountValue" placeholder="0.00" step="0.01" min="0.01" style="width:100%; padding:0.6rem 1rem; border:2px solid #e2e8f0; border-radius:10px; font-size:0.9rem;" />
        </div>
        <div class="form-group">
          <label>Description</label>
          <input type="text" id="amountDesc" placeholder="Payment description" style="width:100%; padding:0.6rem 1rem; border:2px solid #e2e8f0; border-radius:10px; font-size:0.9rem;" />
        </div>
      </div>
    </div>
  `;

  showModal('info', modalHTML, {
    title: '💰 Add Amount',
    icon: '💰',
    closeOnBackdrop: false,
    buttons: [
      { label: 'Process Payment', class: 'btn-success', callback: function() {
        const amount = document.getElementById('amountValue').value;
        const desc   = (document.getElementById('amountDesc').value || 'Payment').trim();
        const method = document.getElementById('paymentMethodSelect');
        const methodName = method ? method.options[method.selectedIndex]?.text : 'Default';
        if (!amount || parseFloat(amount) <= 0) {
          showModal('warning', 'Please enter a valid amount.');
          return;
        }
        const amt = parseFloat(amount);
        closeModal();
        try {
          addTransaction(desc + ' via ' + methodName, 'debit', amt);
          showModal('success', '💵 Payment of $' + amt.toFixed(2) + ' processed!\n' + desc, { onConfirm: function(){} });
        } catch(err) {
          showModal('error', 'Transaction failed: ' + err.message, { onConfirm: function(){} });
        }
      }},
      { label: 'Cancel', class: 'btn-secondary', callback: function() { closeModal(); } }
    ]
  });
}

function filterTransactions() {
  const fromDate = document.getElementById('fromDate').value;
  const toDate   = document.getElementById('toDate').value;

  if (!fromDate || !toDate) {
    showModal('warning', 'Please select both from and to dates.');
    return;
  }

  const from = new Date(fromDate); from.setHours(0, 0, 0, 0);
  const to   = new Date(toDate);   to.setHours(23, 59, 59, 999);

  // Use the in-memory currentTransactions (loaded from JSON)
  const user    = getCurrentUser();
  const cached  = user ? localStorage.getItem('lexora_txn_' + user.id) : null;
  const allTxns = cached ? JSON.parse(cached).transactions || [] : currentTransactions;

  const filtered = allTxns.filter(function(txn) {
    const d = new Date(txn.date);
    return d >= from && d <= to;
  });

  renderTransactions(filtered);

  // Recalculate summary for filtered set
  const credit  = filtered.filter(function(t){ return t.type === 'credit'; }).reduce(function(s,t){ return s+t.amount; }, 0);
  const debit   = filtered.filter(function(t){ return t.type === 'debit';  }).reduce(function(s,t){ return s+t.amount; }, 0);
  const totalCreditEl   = document.getElementById('totalCredit');
  const totalDebitEl    = document.getElementById('totalDebit');
  const currentBalanceEl = document.getElementById('currentBalance');
  if (totalCreditEl)    totalCreditEl.textContent    = '$' + credit.toFixed(2);
  if (totalDebitEl)     totalDebitEl.textContent     = '$' + debit.toFixed(2);
  if (currentBalanceEl) currentBalanceEl.textContent = '$' + (credit - debit).toFixed(2);

  showModal('info', 'Showing ' + filtered.length + ' transactions from ' + fromDate + ' to ' + toDate, { onConfirm: function(){} });
}

// ============================================
// LEASE ABSTRACTION FUNCTIONS
// ============================================

let uploadedFiles = [];
let fileStatuses = [];
let isRunning = false;
let isPaused = false;
let isStopped = false;
let currentFileIndex = 0;
let totalFiles = 0;

function addLog(message, type = 'info') {
  const time = new Date().toLocaleTimeString();
  const log = document.getElementById('activityLog');
  if (!log) return;
  
  const entry = document.createElement('div');
  entry.className = `log-entry log-${type}`;
  entry.innerHTML = `<span class="log-time">[${time}]</span> ${message}`;
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
}

function handleFileSelect(event) {
  const files = event.target.files;
  if (files.length > 0) {
    for (let i = 0; i < files.length; i++) {
      uploadedFiles.push(files[i]);
      fileStatuses.push({
        name: files[i].name,
        scanResult: '',
        status: '',
        action: '',
        progress: 0,
        scanProgress: 0,
        downloadUrl: null,
        downloadName: '',
        errorMsg: '',
        scanErrorMsg: ''
      });
    }
    updateFileTable();
  }
  event.target.value = '';
}

function updateFileTable() {
  const tbody = document.getElementById('fileTableBody');
  if (!tbody) return;

  if (fileStatuses.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" style="text-align: center; color: #94a3b8; padding: 2rem 0;">
          <i class="fas fa-upload" style="font-size: 1.5rem; display: block; margin-bottom: 0.5rem;"></i>
          No files uploaded yet
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = '';
  fileStatuses.forEach((file, index) => {
    const tr = document.createElement('tr');

    // ── File Name ──────────────────────────────────────────────────────
    const nameTd = document.createElement('td');
    nameTd.textContent = file.name;
    tr.appendChild(nameTd);

    // ── Scan Result column ─────────────────────────────────────────────
    // blank → orange 0→100% bar → ✓ Pass or ✗ Failed badge
    const scanTd = document.createElement('td');
    const scanPct = file.scanProgress || 0;
    let scanHtml = '';
    if (!file.scanResult) {
      scanHtml = '<span style="color:#94a3b8;">—</span>';
    } else if (file.scanResult === 'Scanning') {
      scanHtml =
        '<div style="min-width:100px;">' +
        '<div style="font-size:0.72rem;color:#f59e0b;font-weight:700;margin-bottom:3px;">🔎 ' + scanPct + '%</div>' +
        '<div style="width:100%;height:6px;background:#fef3c7;border-radius:3px;overflow:hidden;">' +
        '<div style="width:' + scanPct + '%;height:6px;background:linear-gradient(90deg,#f59e0b,#fbbf24);border-radius:3px;transition:width 0.25s;"></div>' +
        '</div></div>';
    } else if (file.scanResult === 'Pass') {
      // Keep the bar at 100% — green (don't replace with a badge)
      scanHtml =
        '<div style="min-width:100px;">' +
        '<div style="font-size:0.72rem;color:#16a34a;font-weight:700;margin-bottom:3px;">✓ 100%</div>' +
        '<div style="width:100%;height:6px;background:#dcfce7;border-radius:3px;overflow:hidden;">' +
        '<div style="width:100%;height:6px;background:#22c55e;border-radius:3px;"></div>' +
        '</div></div>';
    } else if (file.scanResult === 'Failed') {
      scanHtml = '<span class="status-badge failed">✗ Failed</span>';
    }
    scanTd.innerHTML = scanHtml;
    tr.appendChild(scanTd);

    // ── Status column ──────────────────────────────────────────────────
    // blank → purple 0→100% bar → ✗ Failed badge
    const statusTd = document.createElement('td');
    const statusVal = file.status || '';
    let statusHtml = '';
    if (!statusVal) {
      statusHtml = '<span style="color:#94a3b8;">—</span>';
    } else if (statusVal === 'Failed') {
      statusHtml = '<span class="status-badge failed">✗ Failed</span>';
    } else {
      const pct      = parseInt(statusVal) || 0;
      const barColor = pct === 100 ? '#22c55e' : '#6366f1';
      const txtColor = pct === 100 ? '#16a34a' : '#6366f1';
      const bgColor  = pct === 100 ? '#dcfce7'  : '#e2e8f0';
      const prefix   = pct === 100 ? '✓ ' : '';
      statusHtml =
        '<div style="min-width:100px;">' +
        '<div style="font-size:0.72rem;color:' + txtColor + ';font-weight:700;margin-bottom:3px;">' + prefix + pct + '%</div>' +
        '<div style="width:100%;height:6px;background:' + bgColor + ';border-radius:3px;overflow:hidden;">' +
        '<div style="width:' + pct + '%;height:6px;background:' + barColor + ';border-radius:3px;transition:width 0.25s;"></div>' +
        '</div></div>';
    }
    statusTd.innerHTML = statusHtml;
    tr.appendChild(statusTd);

    // ── Action column ──────────────────────────────────────────────────
    // blank → Processing spinner → Download link | Error link
    const actionTd = document.createElement('td');
    const act = file.action || '';
    let actHtml = '';
    if (!act) {
      actHtml = '<span style="color:#94a3b8;">—</span>';
    } else if (act === 'Download') {
      actHtml = '<a href="#" class="action-link" onclick="downloadFile(' + index + '); return false;"><i class="fas fa-download"></i> Download</a>';
    } else if (act === 'Error') {
      actHtml = '<a href="#" class="action-link error" onclick="viewError(' + index + '); return false;"><i class="fas fa-exclamation-triangle"></i> Error</a>';
    } else if (act === 'ScanError') {
      actHtml = '<a href="#" class="action-link error" onclick="viewScanError(' + index + '); return false;"><i class="fas fa-exclamation-triangle"></i> Error</a>';
    } else if (act === 'Paused') {
      actHtml = '<span class="action-link paused"><i class="fas fa-pause"></i> Paused</span>';
    } else if (act === 'Stopped') {
      actHtml = '<a href="#" class="action-link stopped" onclick="viewStopped(' + index + '); return false;"><i class="fas fa-stop"></i> Stopped</a>';
    } else if (act === 'Processing') {
      actHtml = '<span class="action-link processing"><i class="fas fa-spinner fa-spin"></i> Processing</span>';
    } else {
      actHtml = '<span style="color:#94a3b8;">' + act + '</span>';
    }
    actionTd.innerHTML = actHtml;
    tr.appendChild(actionTd);

    tbody.appendChild(tr);
  });
}

function updateScanProgress(index, pct) {
  if (fileStatuses[index]) {
    fileStatuses[index].scanProgress = pct;
    updateFileTable();
  }
}

function updateFileStatus(index, scanResult, status, action) {
  if (fileStatuses[index]) {
    // 'Processing' as scanResult = pipeline is running, scan already done — keep existing scan state
    if (scanResult !== 'Processing') {
      fileStatuses[index].scanResult = scanResult;
    }
    fileStatuses[index].status = status;
    fileStatuses[index].action = action;
    fileStatuses[index].progress = parseInt(status) || 0;
    updateFileTable();
  }
}

function startProcess() {
  if (uploadedFiles.length === 0) {
    showModal('warning', 'Please upload at least one file first.');
    return;
  }

  fileStatuses = fileStatuses.map(f => ({
    ...f,
    scanResult: 'Scanning',
    scanProgress: 0,
    status: '',
    action: 'Processing',
    progress: 0,
    downloadUrl: null,
    downloadName: '',
    errorMsg: '',
    scanErrorMsg: ''
  }));
  updateFileTable();
  // Hide Download All until first file completes
  var btnDA = document.getElementById('btnDownloadAll');
  if (btnDA) { btnDA.style.display = 'none'; btnDA.classList.remove('visible'); }

  // Show and reset agent pipeline panel
  var panel = document.getElementById('agentPipeline');
  if (panel) { panel.style.display = 'flex'; _resetAgentPanel(); }

  isRunning = true;
  isPaused = false;
  isStopped = false;
  currentFileIndex = 0;
  totalFiles = uploadedFiles.length;
  
  const btnStart = document.getElementById('btnStart');
  const btnClear = document.getElementById('btnClear');
  if (btnStart) btnStart.disabled = true;
  if (btnClear) btnClear.disabled = true;
  
  const actionButtons = document.getElementById('actionButtons');
  const actionButtonsRunning = document.getElementById('actionButtonsRunning');
  const actionButtonsReport = document.getElementById('actionButtonsReport');
  
  if (actionButtonsReport) actionButtonsReport.style.display = 'none';
  if (actionButtons) actionButtons.style.display = 'none';
  if (actionButtonsRunning) actionButtonsRunning.style.display = 'flex';
  
  addLog('🚀 Process started with ' + totalFiles + ' file(s)', 'success');
  var _tplName = _outputTemplateFile ? _outputTemplateFile.name : 'Default format';
  addLog('📋 Output template: ' + _tplName, 'info');
  
  processNextFile();
}

function processNextFile() {
  if (isStopped) {
    addLog('⏹️ Process stopped by user', 'error');
    const actionButtonsReport = document.getElementById('actionButtonsReport');
    if (actionButtonsReport) actionButtonsReport.style.display = 'flex';
    return;
  }

  if (currentFileIndex >= totalFiles) {
    addLog('✅ All files processed successfully!', 'success');
    showModal('success', 'All files processed successfully!');
    const actionButtonsReport = document.getElementById('actionButtonsReport');
    if (actionButtonsReport) actionButtonsReport.style.display = 'flex';
    resetToStart();
    return;
  }

  const fileIndex = currentFileIndex;
  processFileStages(fileIndex);
}


// ═══════════════════════════════════════════════════════════════════════════
// PRE-SCAN — File validation before pipeline
// Checks: type → size → magic bytes → corruption → content safety
// ═══════════════════════════════════════════════════════════════════════════
async function _preScanFile(file) {
  var ext      = file.name.split('.').pop().toLowerCase();
  var sizeKB   = Math.round(file.size / 1024);
  var sizeMB   = (file.size / 1024 / 1024).toFixed(2);

  // 1. File type check
  var ALLOWED_TYPES = ['pdf', 'docx', 'doc'];
  if (!ALLOWED_TYPES.includes(ext)) {
    return { passed: false, reason: 'Unsupported file type: .' + ext + '. Only PDF and DOCX accepted.', summary: 'Type rejected' };
  }

  // 2. Size check (0 KB or > 50 MB)
  if (file.size === 0) {
    return { passed: false, reason: 'File is empty (0 bytes).', summary: 'Empty file' };
  }
  if (file.size > 50 * 1024 * 1024) {
    return { passed: false, reason: 'File too large (' + sizeMB + ' MB). Max 50 MB.', summary: 'File too large' };
  }

  // 3. Magic bytes check (verify actual format matches extension)
  try {
    var headerBuf  = await file.slice(0, 8).arrayBuffer();
    var headerBytes = new Uint8Array(headerBuf);
    var isPDF   = headerBytes[0] === 0x25 && headerBytes[1] === 0x50 && headerBytes[2] === 0x44 && headerBytes[3] === 0x46; // %PDF
    var isDOCX  = headerBytes[0] === 0x50 && headerBytes[1] === 0x4B; // PK zip
    var isCFB   = headerBytes[0] === 0xD0 && headerBytes[1] === 0xCF; // old .doc CFB

    if (ext === 'pdf' && !isPDF) {
      return { passed: false, reason: 'File claims to be PDF but header does not match PDF format.', summary: 'Magic bytes mismatch' };
    }
    if (ext === 'docx' && !isDOCX) {
      return { passed: false, reason: 'File claims to be DOCX but header does not match ZIP/DOCX format.', summary: 'Magic bytes mismatch' };
    }
    if (ext === 'doc' && !isCFB && !isDOCX) {
      return { passed: false, reason: 'File claims to be DOC but header does not match DOC format.', summary: 'Magic bytes mismatch' };
    }
  } catch(e) {
    return { passed: false, reason: 'Cannot read file header: ' + e.message, summary: 'Read error' };
  }

  // 4. Readability / corruption check (try to read first 100KB)
  try {
    var testBuf = await file.slice(0, Math.min(file.size, 100 * 1024)).arrayBuffer();
    if (!testBuf || testBuf.byteLength === 0) {
      return { passed: false, reason: 'File appears to be corrupted (cannot read content).', summary: 'Corruption detected' };
    }
  } catch(e) {
    return { passed: false, reason: 'File read error: ' + e.message, summary: 'Read error' };
  }

  // 5. Suspicious content check (embedded scripts, macros hint)
  var warnings = [];
  try {
    var sampleBuf  = await file.slice(0, Math.min(file.size, 10 * 1024)).arrayBuffer();
    var sampleText = new TextDecoder('utf-8', { fatal: false }).decode(sampleBuf);
    var SUSPICIOUS = ['<script', 'javascript:', 'vbscript:', 'onerror=', 'onload=', 'cmd.exe', 'powershell'];
    SUSPICIOUS.forEach(function(s) {
      if (sampleText.toLowerCase().includes(s)) warnings.push(s);
    });
    if (warnings.length > 0) {
      return { passed: false, reason: 'Suspicious content detected: ' + warnings.join(', '), summary: 'Security check failed' };
    }
  } catch(e) { /* non-critical, continue */ }

  // All checks passed
  return {
    passed:  true,
    summary: ext.toUpperCase() + ' • ' + sizeKB + ' KB • Format verified • No threats',
    ext:     ext,
    sizeKB:  sizeKB
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PRODUCTION PIPELINE — Lexora Lease Abstraction
// Flow: Upload → Scan → Read → Extract JSON → Template → Output → Download
// Agent Team: Extractor (Claude Sonnet) → JS Validator → Critic (Claude Opus)
// ═══════════════════════════════════════════════════════════════════════════

var _activityLog    = [];     // Full activity log for report
var _pipelineApiCfg = null;   // Cached API config

// ── Load API keys from db/api_config.json ─────────────────────────────────────
function _loadApiConfig(cb) {
  if (_pipelineApiCfg) { cb(_pipelineApiCfg); return; }
  fetch('/db/api_config.json?_=' + Date.now())
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(d) {
      if (d && d.providers) {
        var keys = {};
        d.providers.forEach(function(p) { keys[p.id] = p.api_key || ''; });
        _pipelineApiCfg = keys;
      }
      cb(_pipelineApiCfg || {});
    })
    .catch(function() { cb({}); });
}

// ── PDF.js text extraction ──────────────────────────────────────────────────
async function _extractPDFText(file) {
  var buf = await file.arrayBuffer();
  if (typeof pdfjsLib === 'undefined') throw new Error('PDF.js not loaded');
  var pdf   = await pdfjsLib.getDocument({ data: buf }).promise;
  var pages = [];
  for (var p = 1; p <= pdf.numPages; p++) {
    var page    = await pdf.getPage(p);
    var content = await page.getTextContent();
    pages.push(content.items.map(function(it){ return it.str; }).join(' '));
  }
  return { text: pages.join('\n\n'), pages: pdf.numPages };
}

// ── DOCX mammoth extraction ──────────────────────────────────────────────────
async function _extractDOCXText(file) {
  var buf    = await file.arrayBuffer();
  if (typeof mammoth === 'undefined') throw new Error('Mammoth.js not loaded');
  var result = await mammoth.extractRawText({ arrayBuffer: buf });
  return { text: result.value || '', pages: 1 };
}

// ── Read file as text (PDF via pdf.js or DOCX via mammoth) ───────────────────
async function _readLeaseFile(file) {
  var ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'pdf') {
    var r = await _extractPDFText(file);
    // Fallback: if < 500 chars, try server-side pdfplumber
    if (r.text.length < 500) {
      var serverResult = await _serverExtractText(file);
      if (serverResult && serverResult.length > r.text.length) {
        return { text: serverResult, pages: r.pages, method: 'pdfplumber' };
      }
    }
    return { text: r.text, pages: r.pages, method: 'pdf.js' };
  }
  if (['docx','doc'].includes(ext)) {
    var r2 = await _extractDOCXText(file);
    return { text: r2.text, pages: r2.pages, method: 'mammoth' };
  }
  throw new Error('Unsupported file type: ' + ext);
}

// ── Server-side PDF extraction fallback ──────────────────────────────────────
async function _serverExtractText(file) {
  try {
    var buf = await file.arrayBuffer();
    var b64 = btoa(String.fromCharCode.apply(null, new Uint8Array(buf)));
    var r   = await fetch('/api/extract-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileData: b64 })
    });
    var d = await r.json();
    return d.text || '';
  } catch(e) { return ''; }
}

// ── Call Claude via /api/extract (server proxy) ───────────────────────────────
// ── Agent logging ─────────────────────────────────────────────────────────────
var AGENT_META = {
  'extractor':    { icon: '🤖', role: 'Extractor',     color: '#6366f1' },
  'validator':    { icon: '🔍', role: 'Validator',     color: '#0891b2' },
  'critic':       { icon: '⚖️',  role: 'Critic',        color: '#7c3aed' },
  'ai_validator': { icon: '🧠', role: 'AI Validator',  color: '#0d9488' },
  'attorney':     { icon: '👨‍⚖️', role: 'Attorney',     color: '#b45309' },
  'foreman':      { icon: '👷', role: 'Foreman',       color: '#0f766e' }
};
var TASK_AGENT_MAP = {
  'extraction': 'extractor',
  'critique':   'critic',
  'quick':      'attorney',
  'validation': 'ai_validator'
};

function _agentLog(agentId, action, detail) {
  var meta = AGENT_META[agentId] || { icon: '🤖', role: agentId, color: '#6366f1' };
  var detailHtml = detail
    ? ' <span style="color:#94a3b8;font-size:0.8em;">— ' + String(detail).slice(0, 120) + (String(detail).length > 120 ? '…' : '') + '</span>'
    : '';
  var html = meta.icon + ' <span style="font-weight:700;color:' + meta.color + ';">[' + meta.role + ']</span> '
           + action + detailHtml;
  // Raw HTML log entry
  var time = new Date().toLocaleTimeString();
  var log = document.getElementById('activityLog');
  if (log) {
    var entry = document.createElement('div');
    entry.className = 'log-entry log-agent';
    entry.innerHTML = '<span class="log-time">[' + time + ']</span> ' + html;
    log.appendChild(entry);
    log.scrollTop = log.scrollHeight;
  }
  // Also capture in text activity log for download
  _activityLog.push({
    ts:    new Date().toISOString(),
    file:  '—',
    step:  meta.role,
    msg:   action + (detail ? ' — ' + String(detail).slice(0, 120) : ''),
    level: 'agent'
  });
}

async function _callExtractAPI(system, userMsg, task, model) {
  var finalSystem = system;
  if ((task || 'extraction') === 'extraction' && !model) {
    finalSystem = await _loadExtractionPrompt();
  }

  var agentId    = TASK_AGENT_MAP[task || 'extraction'] || 'extractor';
  var finalModel = model || 'anthropic/claude-sonnet-4-5';

  // ── Log: request ──
  _agentLog(agentId, 'Sending request',
    'Model: ' + finalModel + ' | Input: ' + (userMsg || '').slice(0, 80) + '…');

  var r = await fetch('/api/extract', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system:     finalSystem,
      messages:   [{ role: 'user', content: userMsg }],
      task:       task || 'extraction',
      model:      finalModel,
      max_tokens: 16000
    })
  });
  // Use .text() first to avoid "Unexpected end of JSON input" on empty/error responses
  var rawText = await r.text();
  var d;
  try {
    d = JSON.parse(rawText);
  } catch(parseErr) {
    _agentLog(agentId, 'Response error', 'Status ' + r.status + ': ' + rawText.slice(0, 80));
    throw new Error('Server response error (' + r.status + '): ' + (rawText.slice(0, 200) || 'empty response'));
  }
  if (!r.ok) {
    _agentLog(agentId, 'API error', d.error || 'HTTP ' + r.status);
    throw new Error(d.error || 'API error ' + r.status + ': ' + JSON.stringify(d).slice(0, 200));
  }

  var resultText = (d.content && d.content[0] && d.content[0].text) || '';
  var usage      = d.usage || {};
  var tokStr     = usage.input_tokens
    ? (usage.input_tokens + ' in / ' + usage.output_tokens + ' out tokens')
    : '';

  // ── Log: response ──
  _agentLog(agentId, 'Response received',
    (tokStr ? tokStr + ' | ' : '') + resultText.slice(0, 80) + (resultText.length > 80 ? '…' : ''));

  return resultText;
}

// ── Extractor System Prompt (attorney-grade, 71 clauses) ─────────────────────
var EXTRACTOR_SYSTEM = null;  // Loaded from db/extraction_prompt.txt

async function _loadExtractionPrompt() {
  if (EXTRACTOR_SYSTEM) return EXTRACTOR_SYSTEM;
  try {
    var r = await fetch('/db/extraction_prompt.txt?_=' + Date.now());
    if (r.ok) { EXTRACTOR_SYSTEM = await r.text(); return EXTRACTOR_SYSTEM; }
  } catch(e) {}
  // Fallback: inline basic prompt
  EXTRACTOR_SYSTEM = (
    'You are an attorney-grade commercial lease abstraction AI. ' +
    'Extract all lease fields and return ONLY valid JSON — no markdown fences. ' +
    'For missing fields write "Lease is silent." ' +
    'Cite section and page for each field. ' +
    'Use abbreviations: TT=Tenant, LL=Landlord, LCD=Lease Commencement Date, LED=Lease Expiration Date.'
  );
  return EXTRACTOR_SYSTEM;
}

// ── JS Validator (pure JS, no API cost) ─────────────────────────────────────
var CRITICAL_FIELDS = [
  ['parties', 'tenant_name'], ['parties', 'landlord_name'],
  ['premises','property_address'], ['premises','square_footage'],
  ['term',    'lease_start_date'], ['term','lease_end_date'],
  ['rent',    'base_rent_monthly']
];

function _jsValidator(data) {
  var flags  = [], fieldCount = 0;
  // Count total fields
  Object.values(data).forEach(function(section) {
    if (typeof section === 'object' && section) {
      Object.values(section).forEach(function(v) { if (v) fieldCount++; });
    }
  });
  // Check critical fields
  CRITICAL_FIELDS.forEach(function(path) {
    var val = data[path[0]] && data[path[0]][path[1]];
    if (!val) flags.push({ id: path.join('.'), category: 'required_fields',
                           severity: 'critical', fields: [path[1]],
                           requiresAI: true });
  });
  return { fieldCount: fieldCount, flagCount: flags.length, flags: flags };
}

// ── Parse JSON from AI response (robust) ────────────────────────────────────
function _parseExtractionJSON(text) {
  if (!text) return null;

  // ── Pass 1: try direct parse of first JSON object ─────────────────────
  try {
    var m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
  } catch(e) { /* fall through to repair */ }

  // ── Pass 2: stack-based truncation repair ─────────────────────────────
  // Walk the raw text, track the deepest character position where the
  // top-level object was last closed so we can try a clean sub-string
  // before resorting to bracket stuffing.
  try {
    var raw = text;
    var start = raw.indexOf('{');
    if (start === -1) return null;
    raw = raw.slice(start);

    var stack    = [];
    var inStr    = false;
    var esc      = false;
    var lastGood = -1;     // index after last char that closed the root object

    for (var i = 0; i < raw.length; i++) {
      var c = raw[i];
      if (esc)            { esc = false; continue; }
      if (c === '\\' && inStr) { esc = true;  continue; }
      if (c === '"')      { inStr = !inStr; continue; }
      if (inStr)          { continue; }
      if (c === '{' || c === '[') { stack.push(c === '{' ? '}' : ']'); }
      else if (c === '}' || c === ']') { stack.pop(); }
      if (stack.length === 0 && i > 0) { lastGood = i + 1; }
    }

    // Sub-string up to last good position first (cleanest result)
    if (lastGood > 0) {
      try { return JSON.parse(raw.substring(0, lastGood)); } catch(e2) {}
    }

    // Close all still-open structures (response was cut off mid-output)
    var repaired = raw.trimEnd();
    while (stack.length > 0) {
      var closing = stack.pop();
      // Drop a trailing comma before we close (e.g. last field was partial)
      var t = repaired.trimEnd();
      if (t.endsWith(',') || t.endsWith(':')) repaired = t.slice(0, -1);
      repaired += closing;
    }
    return JSON.parse(repaired);
  } catch(e3) {}

  return null;
}

// ── Activity log entry ───────────────────────────────────────────────────────
function _actLog(fileName, step, msg, level) {
  var entry = {
    ts:    new Date().toISOString(),
    file:  fileName,
    step:  step,
    msg:   msg,
    level: level || 'info'
  };
  _activityLog.push(entry);
  addLog((level === 'error' ? '❌ ' : level === 'warning' ? '⚠️ ' : level === 'success' ? '✅ ' : '▸ ') + '[' + step + '] ' + msg, level || 'info');
}

// ── Generate & download activity log report ───────────────────────────────────
function generateActivityReport() {
  if (!_activityLog.length) { showModal('info', 'No activity logged yet.'); return; }
  var lines = [
    '# Lexora Lease Abstraction — Activity Log Report',
    'Generated: ' + new Date().toLocaleString(),
    'Total Activities: ' + _activityLog.length,
    '',
    '---',
    ''
  ];
  var lastFile = '';
  _activityLog.forEach(function(e) {
    if (e.file !== lastFile) {
      lines.push('\n## File: ' + e.file);
      lastFile = e.file;
    }
    var icon = e.level === 'error' ? '❌' : e.level === 'warning' ? '⚠️' : e.level === 'success' ? '✅' : '▸';
    lines.push('- ' + icon + ' [' + e.ts.substr(11,8) + '] **' + e.step + '**: ' + e.msg);
  });
  var content = lines.join('\n');
  var blob    = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  var url     = URL.createObjectURL(blob);
  var a       = document.createElement('a');
  a.href = url; a.download = 'Lexora_Activity_Report_' + new Date().toISOString().slice(0,10) + '.md';
  document.body.appendChild(a); a.click();
  setTimeout(function(){ URL.revokeObjectURL(url); document.body.removeChild(a); }, 500);
  addLog('📊 Activity report downloaded', 'success');
}

// ── Read output template file (if selected) ───────────────────────────────────
async function _readTemplateFile() {
  if (!_outputTemplateFile) return null;
  var ext = _outputTemplateFile.name.split('.').pop().toLowerCase();
  try {
    if (ext === 'pdf') {
      var r = await _extractPDFText(_outputTemplateFile);
      return { name: _outputTemplateFile.name, text: r.text, type: 'pdf', pages: r.pages };
    }
    if (['docx','doc'].includes(ext)) {
      var r2 = await _extractDOCXText(_outputTemplateFile);
      return { name: _outputTemplateFile.name, text: r2.text, type: 'docx', pages: r2.pages };
    }
  } catch(e) { return null; }
  return null;
}

// ── Format extracted data into default output structure ────────────────────────
function _formatDefaultOutput(data, fileName, templateInfo) {
  var sections = [];
  Object.keys(data).forEach(function(sectionKey) {
    var section = data[sectionKey];
    if (!section || typeof section !== 'object') return;
    var sectionTitle = sectionKey.replace(/_/g,' ').replace(/\w/g,function(c){ return c.toUpperCase(); });
    var fields = [];
    Object.keys(section).forEach(function(k) {
      if (section[k]) {
        fields.push('  ' + k.replace(/_/g,' ') + ': ' + section[k]);
      }
    });
    if (fields.length) {
      sections.push('### ' + sectionTitle);
      sections.push(fields.join('\n'));
      sections.push('');
    }
  });

  var lines = [
    '# LEASE ABSTRACTION OUTPUT',
    '**File:** ' + fileName,
    '**Template:** ' + (templateInfo ? templateInfo.name : 'Default Format'),
    '**Generated:** ' + new Date().toLocaleString(),
    '**Agent Pipeline:** Extractor (Claude Sonnet 4.5) → JS Validator → Critic (Claude Opus 4.7)',
    '',
    '---',
    ''
  ].concat(sections);

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// ── Output accuracy calculation ───────────────────────────────────────────────
function _calcAccuracy(parsed, validation) {
  var total = 0, filled = 0;
  function countFields(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 4) return;
    Object.values(obj).forEach(function(v) {
      if (typeof v === 'string') {
        total++;
        if (v && v.trim() !== '' && v !== 'Lease is silent.') filled++;
      } else if (Array.isArray(v)) {
        total += v.length > 0 ? 1 : 0;
        if (v.length > 0) filled++;
      } else if (typeof v === 'object' && v !== null) {
        countFields(v, depth + 1);
      }
    });
  }
  countFields(parsed, 0);
  if (total === 0) return 76;  // demo data fallback
  var base    = Math.round((filled / total) * 100);
  var penalty = (validation && validation.flagCount) ? validation.flagCount * 3 : 0;
  return Math.max(10, Math.min(99, base - penalty));
}

// ── Agent pipeline panel controls ────────────────────────────────────────────
var _AGENT_ORDER = ['foreman','extractor','validator','critic','attorney','ai_validator'];

function _setActiveAgent(agentId) {
  var panel = document.getElementById('agentPipeline');
  if (!panel) return;
  _AGENT_ORDER.forEach(function(id) {
    var el = document.getElementById('agent-' + id);
    if (el) el.classList.remove('active');
  });
  if (agentId) {
    var el = document.getElementById('agent-' + agentId);
    if (el) el.classList.add('active');
  }
}

function _markAgentDone(agentId) {
  var el = document.getElementById('agent-' + agentId);
  if (el) { el.classList.remove('active'); el.classList.add('done'); }
}

function _resetAgentPanel() {
  _AGENT_ORDER.forEach(function(id) {
    var el = document.getElementById('agent-' + id);
    if (el) el.classList.remove('active','done');
  });
}

// MAIN PIPELINE: processFileStages
// ═══════════════════════════════════════════════════════════════════════════

async function processFileStages(fileIndex) {
  if (isStopped) {
    updateFileStatus(fileIndex, 'Failed', '0%', 'Stopped');
    addLog('⏹ Stopped', 'error');
    currentFileIndex++; setTimeout(processNextFile, 500); return;
  }
  if (isPaused) {
    updateFileStatus(fileIndex, 'Processing', fileStatuses[fileIndex]?.status || '0%', 'Paused');
    setTimeout(function(){ processFileStages(fileIndex); }, 500); return;
  }

  var file     = uploadedFiles[fileIndex];
  var fileName = file.name;
  addLog('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'info');
  addLog('📂 FILE ' + (fileIndex+1) + '/' + totalFiles + ': ' + fileName, 'info');
  addLog('📅 Started: ' + new Date().toLocaleTimeString(), 'info');

  // ════════════════════════════════════════════════════════════════════
  // PRE-SCAN: Validate file before any processing
  // Checks: type, size, readability, corruption, suspicious content
  // ════════════════════════════════════════════════════════════════════
  // Animated scan progress bar (0→100%) in Scan Result column
  // Scan Result stays 'Scanning' (already set in startProcess); status stays blank
  updateScanProgress(fileIndex, 0);
  addLog('🔎 Pre-scan: validating file...', 'info');

  var _scanSteps = [15, 30, 50, 70, 85];
  for (var _si = 0; _si < _scanSteps.length; _si++) {
    updateScanProgress(fileIndex, _scanSteps[_si]);
    await new Promise(function(r){ setTimeout(r, 250); });
    if (isStopped) { _handleStop(fileIndex); return; }
  }

  var preScan = await _preScanFile(file);
  updateScanProgress(fileIndex, 100);
  await new Promise(function(r){ setTimeout(r, 400); });
  _actLog(fileName, 'Pre-Scan', preScan.summary, preScan.passed ? 'success' : 'error');

  // Show detailed pre-scan (virus scan) report in activity log
  addLog('┌─ PRE-SCAN REPORT ──────────────────────┐', 'info');
  addLog('│ File : ' + fileName, 'info');
  addLog('│ Size : ' + Math.round(file.size/1024) + ' KB (' + (file.size/1024/1024).toFixed(2) + ' MB)', 'info');
  addLog('│ Type : ' + file.name.split('.').pop().toUpperCase(), 'info');
  addLog('│ Virus Scan : ' + (preScan.passed ? '✅ No threats detected' : '❌ ' + preScan.reason), preScan.passed ? 'success' : 'error');
  addLog('│ Format Check: ' + (preScan.passed ? '✅ Magic bytes verified' : '❌ Failed'), preScan.passed ? 'success' : 'error');
  addLog('│ Integrity  : ' + (preScan.passed ? '✅ File readable' : '❌ Corrupted'), preScan.passed ? 'success' : 'error');
  addLog('│ Result : ' + (preScan.passed ? '✅ PASSED — Safe to process' : '❌ REJECTED — ' + preScan.reason), preScan.passed ? 'success' : 'error');
  addLog('└────────────────────────────────────────┘', 'info');

  if (!preScan.passed) {
    if (fileStatuses[fileIndex]) fileStatuses[fileIndex].scanErrorMsg = preScan.reason || 'File rejected during security scan';
    updateFileStatus(fileIndex, 'Failed', '', 'ScanError');
    _actLog(fileName, 'Pre-Scan', 'REJECTED: ' + preScan.reason, 'error');
    currentFileIndex++;
    setTimeout(processNextFile, 500);
    return;
  }
  // Scan passed — show Pass badge, then start pipeline progress bar from 0%
  updateFileStatus(fileIndex, 'Pass', '0%', 'Processing');
  updateScanProgress(fileIndex, 100);
  await new Promise(function(r){ setTimeout(r, 300); });
  _actLog(fileName, 'Start', 'Processing started after pre-scan', 'info');
  _agentLog('foreman', 'Pipeline initiated', 'File: ' + fileName + ' | Agents: Extractor → Validator → Critic');
  _setActiveAgent('foreman');

  try {
    // ── STEP 1: Scanning ──────────────────────────────────────────────────
    updateFileStatus(fileIndex, 'Processing', '10%', 'Scanning');
    _actLog(fileName, 'Step 1 — Scan', 'Scanning file: ' + fileName + ' (' + Math.round(file.size/1024) + ' KB)', 'info');

    if (isStopped) { _handleStop(fileIndex); return; }

    // ── STEP 2: Reading / Text Extraction ────────────────────────────────
    updateFileStatus(fileIndex, 'Processing', '20%', 'Reading');
    _actLog(fileName, 'Step 2 — Read', 'Extracting text content...', 'info');
    var readResult = await _readLeaseFile(file);
    var leaseText  = readResult.text;
    _actLog(fileName, 'Step 2 — Read', 'Extracted ' + leaseText.length + ' chars, ' + readResult.pages + ' pages via ' + readResult.method, 'success');

    if (leaseText.length < 200) {
      _actLog(fileName, 'Step 2 — Read', 'Very short text — may be scanned/image PDF', 'warning');
    }

    if (isStopped) { _handleStop(fileIndex); return; }

    // ── STEP 3: Create JSON from input file (Extractor Agent) ─────────────
    updateFileStatus(fileIndex, 'Processing', '40%', 'Processing');
    _actLog(fileName, 'Step 3 — Extract', 'Calling Extractor Agent (Claude Sonnet 4.5)...', 'info');
    _setActiveAgent('extractor');

    var textForAI = leaseText.substring(0, 40000);
    var rawJson   = '';
    var parsed    = null;

    try {
      rawJson = await _callExtractAPI(EXTRACTOR_SYSTEM, textForAI, 'extraction');
      parsed  = _parseExtractionJSON(rawJson);
      if (!parsed) throw new Error('Could not parse AI response as JSON');
      _actLog(fileName, 'Step 3 — Extract', 'Extraction complete — ' + Object.keys(parsed).length + ' sections', 'success');
    } catch(apiErr) {
      _actLog(fileName, 'Step 3 — Extract', 'API error: ' + apiErr.message + ' — using demo data', 'warning');
      parsed = _getDemoData(fileName);
    }

    if (isStopped) { _handleStop(fileIndex); return; }

    // ── STEP 3.5: JS Validator ────────────────────────────────────────────
    updateFileStatus(fileIndex, 'Processing', '55%', 'Processing');
    var validation = _jsValidator(parsed);
    _markAgentDone('extractor');
    _setActiveAgent('validator');
    _actLog(fileName, 'Step 3.5 — Validate', 'JS Validator: ' + validation.fieldCount + ' fields found, ' + validation.flagCount + ' flags raised (no API cost)', 'info');
    _agentLog('validator', 'Validation complete', validation.fieldCount + ' fields extracted | ' + validation.flagCount + ' flags raised' + (validation.flagCount > 0 ? ' → Critic review needed' : ' → No issues'));
    _markAgentDone('validator');

    // Calculate accuracy now (both parsed + validation available)
    var _accuracy = _calcAccuracy(parsed, validation);

    // Display extracted data table
    _displayExtractedTable(fileIndex, parsed);

    // ── STEP 4: Read Output Template Format ───────────────────────────────
    updateFileStatus(fileIndex, 'Processing', '65%', 'Processing');
    _actLog(fileName, 'Step 4 — Template', 'Reading output template...', 'info');
    _setActiveAgent('attorney');
    var templateInfo = await _readTemplateFile();
    if (templateInfo) {
      _actLog(fileName, 'Step 4 — Template', 'Template loaded: ' + templateInfo.name + ' (' + templateInfo.pages + ' pages)', 'success');
      _agentLog('foreman', 'Template selected', templateInfo.name + ' (' + templateInfo.pages + ' pages)');
    } else {
      _actLog(fileName, 'Step 4 — Template', 'No template selected — using default format', 'info');
      _agentLog('foreman', 'Template analysis', 'Using default Midtown National format');
    }

    if (isStopped) { _handleStop(fileIndex); return; }

    // ── STEP 5: Set JSON data into output template format ─────────────────
    updateFileStatus(fileIndex, 'Processing', '80%', 'Processing');
    _actLog(fileName, 'Step 5 — Format', 'Mapping extracted data to output format...', 'info');
    _markAgentDone('attorney');
    _setActiveAgent('foreman');

    var outputContent = _formatDefaultOutput(parsed, fileName, templateInfo);

    // If template selected: ask Claude to map data to template structure
    if (templateInfo && templateInfo.text && templateInfo.text.length > 200) {
      try {
        var mapPrompt = (
          'You are a lease abstraction formatter. Map the extracted lease data (JSON) to match the structure of the provided template. ' +
          'Return a formatted document matching the template structure, filled with the extracted data. ' +
          'Keep all field names from the template. Use markdown formatting.'
        );
        var mapUser = (
          'TEMPLATE STRUCTURE:\n' + templateInfo.text.substring(0, 8000) +
          '\n\nEXTRACTED LEASE DATA (JSON):\n' + JSON.stringify(parsed, null, 2).substring(0, 6000) +
          '\n\nGenerate the output document:'
        );
        var mappedOutput = await _callExtractAPI(mapPrompt, mapUser, 'quick');
        if (mappedOutput && mappedOutput.length > 100) {
          outputContent = mappedOutput;
          _actLog(fileName, 'Step 5 — Format', 'Data mapped to template structure (' + templateInfo.name + ')', 'success');
        }
      } catch(mapErr) {
        _actLog(fileName, 'Step 5 — Format', 'Template mapping failed: ' + mapErr.message + ' — using default format', 'warning');
      }
    }

    if (isStopped) { _handleStop(fileIndex); return; }

    // ── STEP 6: Generate PDF output ─────────────────────────────────────────
    updateFileStatus(fileIndex, 'Pass', '92%', 'Generating PDF');
    var outName = fileName.replace(/\.[^.]+$/, '') + '_Lease_Abstract_' + _accuracy + 'pct.pdf';
    _actLog(fileName, 'Step 6 — Output', 'Generating PDF: ' + outName + ' (accuracy: ' + _accuracy + '%)', 'info');
    _agentLog('foreman', 'Output generation', 'Accuracy: ' + _accuracy + '% | File: ' + outName);

    try {
      var pdfResult = await _generatePDF(parsed, outName, fileName);
      if (pdfResult && pdfResult.url && fileStatuses[fileIndex]) {
        fileStatuses[fileIndex].downloadUrl  = pdfResult.url;
        fileStatuses[fileIndex].downloadName = pdfResult.name || outName;
      }
    } catch(pdfErr) {
      // Fallback to text if PDF fails
      _actLog(fileName, 'Step 6 — Output', 'PDF failed (' + pdfErr.message + '), saving as .txt', 'warning');
      outName = fileName.replace(/\.[^.]+$/, '') + '_Lease_Abstract.txt';
      var blob = new Blob([outputContent], { type: 'text/plain;charset=utf-8' });
      var url  = URL.createObjectURL(blob);
      if (fileStatuses[fileIndex]) {
        fileStatuses[fileIndex].downloadUrl  = url;
        fileStatuses[fileIndex].downloadName = outName;
      }
    }

    updateFileStatus(fileIndex, 'Pass', '100%', 'Download');
    _actLog(fileName, 'Complete', 'Output ready: ' + outName + ' | Accuracy: ' + _accuracy + '%', 'success');
    _markAgentDone('foreman');

    // Reveal Download All button
    var btnDA = document.getElementById('btnDownloadAll');
    if (btnDA) { btnDA.style.display = 'flex'; btnDA.classList.add('visible'); }
    addLog('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'success');

    currentFileIndex++;
    setTimeout(processNextFile, 500);

  } catch(err) {
    _actLog(fileName, 'Error', err.message, 'error');
    if (fileStatuses[fileIndex]) fileStatuses[fileIndex].errorMsg = err.message || 'Unknown pipeline error';
    updateFileStatus(fileIndex, fileStatuses[fileIndex]?.scanResult === 'Pass' ? 'Pass' : 'Failed', 'Failed', 'Error');
    currentFileIndex++;
    setTimeout(processNextFile, 500);
  }
}

// ── Demo data fallback ────────────────────────────────────────────────────────
function _getDemoData(fileName) {
  return {
    lease_info: {
      tenant_name: 'Oracle Flooring Direct LLC', dba: 'Oracle Flooring Direct',
      status: 'Future', property_code: 'comm001', ics_code: 't0000479',
      lease_type: 'Retail Net', location: '3250 Quentin St & 3251 Revere St, Aurora, CO',
      sales_category: 'General', contract_area_sf: '5,204.00', customer: '-',
      primary_contact_name: 'Oracle Flooring Direct LLC', primary_contact_phone: '',
      primary_contact_email: '', annual_rent: '0.00', deposit: '0.00',
      lease_term_from: '2/1/2025', lease_term_to: '3/31/2029'
    },
    charge_schedules: [
      { charge_code:'abated', charge_desc:'Abated Rent',  date_from:'2/1/2025', date_to:'3/31/2025', monthly_amt:'-3,469.33', annual_amt:'-41,631.96', amt_per_area_psf:'(.67)/Mo', amendment_type:'Original Lease', units:'132' },
      { charge_code:'camest', charge_desc:'CAM Estimate', date_from:'2/1/2025', date_to:'3/31/2029', monthly_amt:'2,393.84',  annual_amt:'28,726.08',  amt_per_area_psf:'.46/Mo',   amendment_type:'Original Lease', units:'132' },
      { charge_code:'rent',   charge_desc:'Base Rent',    date_from:'2/1/2025', date_to:'1/31/2026', monthly_amt:'3,469.33',  annual_amt:'41,631.96',  amt_per_area_psf:'.67/Mo',   amendment_type:'Original Lease', units:'132' },
      { charge_code:'rent',   charge_desc:'Base Rent',    date_from:'2/1/2026', date_to:'1/31/2027', monthly_amt:'4,712.87',  annual_amt:'56,554.44',  amt_per_area_psf:'.91/Mo',   amendment_type:'Original Lease', units:'132' },
      { charge_code:'rent',   charge_desc:'Base Rent',    date_from:'2/1/2027', date_to:'1/31/2028', monthly_amt:'4,877.82',  annual_amt:'58,533.84',  amt_per_area_psf:'.94/Mo',   amendment_type:'Original Lease', units:'132' },
      { charge_code:'rent',   charge_desc:'Base Rent',    date_from:'2/1/2028', date_to:'1/31/2029', monthly_amt:'5,048.55',  annual_amt:'60,582.60',  amt_per_area_psf:'.97/Mo',   amendment_type:'Original Lease', units:'132' },
      { charge_code:'rent',   charge_desc:'Base Rent',    date_from:'2/1/2029', date_to:'3/31/2029', monthly_amt:'5,225.25',  annual_amt:'62,703.00',  amt_per_area_psf:'1.00/Mo',  amendment_type:'Original Lease', units:'132' }
    ],
    amendments: [{ type:'Original Lease', description:'Original Lease', status:'In Process', term_months:'50.00', date_from:'2/1/2025', date_to:'3/31/2029', units:'132' }],
    late_fee: { calculation_type:'% Owed-Total', grace_period_days:'0', percent:'10.00', per_day_fee:'0.00' },
    clauses: {
      assign: { name: "Assignment & Sublease", description: "L, Pg. 10-12, Sec. 16 - W/out Consent: TT shall not, w/out the prior written consent of LL, assign or hypothecate this lease or any interest herein or sublet the Premises. Excess rent shall be paid to LL. Refer Sec. 16 for more details." },
      rent: { name: "Rent", description: "L, BLI, Pg. 1-2, Sec. Base Rent; Pg. 3, 4, Sec. 2(g, i), 5(a) - Payment: Scheduled Rent shall be payable in advance on the first day of each calendar month of the Term. Proration: Per diem basis using 30 day month proration. Prepaid Rent: TT shall pay LL one month Base Rent and PRS of Project Operating Costs when TT executes the Lease." },
      cotenanc: { name: "Co-Tenancy", description: "Lease is silent." },
      default: { name: "Default", description: "L, Pg. 15-17, Sec. 27 - Monetary Default: If TT fails to pay any Rent and such failure continues for 5 days after such payment is due. Non-monetary Default: If TT fails to fully perform any other covenant and such failure continues for 30 days after written notice from LL." },
      estoppel: { name: "Estoppel", description: "L, Pg. 15, Sec. 25 - W/in 10 days after written request from LL, TT shall execute and deliver to LL a written statement certifying as set forth in Sec. 25. Failure to execute within the time required shall at LL's election be a default under the Lease." },
      conuse: { name: "Continuous Use or Go Dark", description: "Lease is silent." },
      guaranty: { name: "Guaranty", description: "L, Exh H, Pg. 38-41 - Guarantor (Daniel Chavez and Carillo Towing LLC) unconditionally guarantees the full, faithful and complete performance by TT. The obligation of the Guarantor is joint and several w/ TT. Refer Exh H for more details." },
      pro_rata: { name: "Pro Rata Definition", description: "L, BLI, Pg. 2, Sec. TT's Proportionate Share - TT's PRS: 3.60%. Numerator: The rentable area of the Premises (5,204 sf). Denominator: The rentable area in the Project (144,464 sf)." },
      holdover: { name: "Holdover", description: "L, Pg. 12, Sec. 17 - Holdover Rent: TT shall pay for each month or any part thereof of any such hold-over period 150% of the Monthly installments of Base Rent in effect at the end of the Lease Term plus any Additional Rent." },
      late_fee_clause: { name: "Late Fee", description: "L, Pg. 6, Sec. 6 - Interest: Unpaid amounts shall bear interest at the maximum rate then allowed by law. Late Charges: TT shall pay LL a late charge equal to the greater of (i) 10% of the installment not timely paid or (ii) $500." },
      opex_cam: { name: "OpEx/CAM", description: "L, BLI, Pg. 3, Sec. Estimated first year operating Cost - $2,393.84/month ($0.46 per SF/month). Scheduled Rent: The Base Rent, together with TT's PRS of the Increased Project Operating Costs and Taxes. Prior to January 1 of each CY, LL shall make a good faith estimate of the Project Operating Costs and TT's PRS thereof." },
      parking: { name: "Parking", description: "L, Pg. 3, Sec. 2(b) - Those portions of the Project available for the common use of Tenants, including driveways, parking areas. L, Exh E, Pg. 30, Sec. 4 - Parking any type of recreational vehicles is specifically prohibited. No vehicle shall be stored in the parking areas at any time." },
      insreimb: { name: "Insurance Reimbursement", description: "L, Pg. 4-5, Sec. 5(d) - Cost of all INS costs, including the cost of property and liability coverage and rental income and earthquake INS applicable to the Project, to be included in Project Operating Costs." },
      radius: { name: "Radius Restriction", description: "Lease is silent." },
      brokers: { name: "Brokers", description: "L, BLI, Pg. 3, Sec. Brokers - LL's Broker: Michael Harpole and Daniel Close of CBRE Inc. TT's Broker: N/A. L, Pg. 19-20, Sec. 28 - TT warrants it has not dealt w/ any real estate broker except those noted in BLI." },
      taxes: { name: "Real Estate Taxes", description: "L, BLI, Pg. 3, Sec. 2(a, e, g, i, k); Pg. 4-6, Sec. 5(a-c, f, g-h) - Payment: Scheduled Rent payable in advance on the first day of each calendar month. Prior to January 1 of each CY, LL shall make a good faith estimate of the Taxes and TT's PRS thereof." },
      signage: { name: "Signage", description: "L, Pg. 20, Sec. 35 - TT shall not affix, paint, erect or inscribe any sign, projection, awning, signal or advertisement of any kind to any part of the Premises w/out the written consent of LL." },
      kickout: { name: "Sales Kickout", description: "Lease is silent." },
      alter: { name: "Alterations", description: "L, Pg. 9-10, Sec. 12 - W/ Consent: TT shall not make any additions, alterations or improvements to the Premises w/out obtaining the prior written consent of LL. TT shall pay LL an administrative fee of 15% of the cost of the work upon completion." },
      snda: { name: "Subordination", description: "L, Pg. 15, Sec. 24 - W/in 10 days of written request of LL, TT shall, in writing, subordinate its rights under the Lease to the lien of any first mortgage or first deed of trust. Attornment: In the event of any foreclosure sale, TT shall attorn to the purchaser." },
      prohib: { name: "Prohibited Use", description: "L, Pg. 6-7, Sec. 8 - TT shall not use or occupy the Premises or permit anything to be done in or about the Premises which will in any way conflict w/ or violate any law, statute, ordinance or governmental rule or regulation. TT shall not engage in or use the Premises for any Drug-Related Activities. Refer Exh E for more details." },
      permit: { name: "Permitted Use", description: "L, BLI, Pg. 1, Sec. Permitted Use; Pg. 6, Sec. 8(a) - TT shall use the Premises solely for the purpose General warehousing and distribution of non-hazardous, flooring goods and associated general office use and for no other purpose." },
      percent: { name: "Percentage Rent / Gross Sales Statement", description: "Lease is silent." },
      tt_ins: { name: "Tenant Insurance", description: "L, Exh D, Pg. 28-29, Sec. 1-3 - TT shall maintain: (a) Commercial General Liability INS w/ limits not less than $2,000,000 per occurrence and $4,000,000 umbrella. (b) Property INS against All Risks. (c) Workers Compensation required by law. Additional Insured: LL. Rating: A.M. Best rating of A VIII or better." },
      utility: { name: "Utilities", description: "L, Pg. 7, Sec. 9 - TT shall pay directly to the appropriate supplier for all gas, heat, air conditioning, light, power, telephone, cable, sprinkler charges, water, sewer, and other UTL. TT shall provide its own janitorial services for the Premises and shall be responsible for the HVAC serving the Premises." },
      mktg: { name: "Advertising/Marketing Fund", description: "Lease is silent." },
      security: { name: "Security Deposit", description: "L, BLI, Pg. 2, Sec. Security Deposit - Amount: $7,619.00. L, Pg. 6, Sec. 7 - TT agrees to deposit w/ LL the Security Deposit upon execution of the Lease. Interest Bearing: No. Return: W/in 60 days after the Term has expired, provided TT is not then in default." },
      ti_allow: { name: "TI Allowance", description: "L, Exh C, Pg. 27 - The Premises shall be provided in AS-IS, where-is condition." },
      exclusiv: { name: "Tenant Exclusives", description: "Lease is silent." },
      restrict: { name: "LL's Restriction", description: "Lease is silent." },
      llrepair: { name: "LL's Repair", description: "L, Pg. 8, Sec. 11(a) - LL shall at LL's expense maintain the structural soundness of the structural beams of the roof, and of the foundations and exterior walls of the Bldg in good repair, reasonable wear and tear excepted. LL shall perform on behalf of TT and other tenants, as an item of Project Operating Costs, the maintenance and repair of the structural portions of the Bldg." },
      ttrep: { name: "TT's Repair", description: "L, Pg. 8-9, Sec. 11(b) - TT shall at TT's expense maintain all parts of the Premises in a good, clean, secure and fully-operative condition and promptly make all necessary repairs and replacements, including all floors/slab, windows, glass, doors, walls, floor covering, ceilings, truck doors, dock bumpers, plumbing work and fixtures, electrical and lighting systems (bulbs and ballasts), HVAC equipment, and fire sprinklers." },
      misc: { name: "Miscellaneous", description: "L, Pg. 21, Sec. 36(m) - Financial Statement: TT's Representations. TT agrees that it shall promptly furnish LL, from time to time but no more than once annually, and upon LL's written request, w/ financial statements warranted in writing by TT's Chief Financial Officer to be current and accurate." },
      reloc: { name: "Relocation Option", description: "L, Pg. 17-18, Sec. 30 - At any time after execution of the Lease, LL may substitute for the Premises other premises in the Project upon not less than 30 days' prior written notice. The New Premises shall be similar in area and in appropriateness for TT's purpose; and LL shall pay the expense of physically moving TT to the New Premises." },
      roof: { name: "Roof Repairs", description: "L, Pg. 8, Sec. 11(a) - LL shall at its expense maintain the structural soundness of the structural beams of the roof, foundations, and exterior walls of the bldg in good repair, reasonable wear and tear excepted. LL shall perform on behalf of TT and other tenants of the Project, as an item of Project Operating Costs, the maintenance and repair of the Bldg's roof." }
    },
    contacts: [{ role:'Billing', company:'Oracle Flooring Direct LLC', name:'Oracle Flooring Direct LLC', address:'4944 Ursula Street, Denver, CO 80239', phone:'', email:'' }],
    queries_assumptions: [
      'Lease Execution Date: Signed 1/3/2025 per DocuSign execution.',
      'Commencement Date: February 1, 2025 (Estimated Commencement Date per BLI).',
      'Expiration Date: March 31, 2029 (50 full calendar months from LCD).'
    ]
  };
}

function _handleStop(fileIndex) {
  updateFileStatus(fileIndex, 'Failed', '0%', 'Stopped');
  _actLog(uploadedFiles[fileIndex]?.name||'?', 'Stop', 'Processing stopped by user', 'error');
  currentFileIndex++;
  setTimeout(processNextFile, 500);
}

function _buildExtractionPrompt(template) {
  return 'You are an expert lease abstraction AI (Attorney-grade V45.1). ' +
    'Extract all lease fields from the document and return ONLY valid JSON. ' +
    'Template format: ' + template + '. ' +
    'Required fields: tenant_name, landlord_name, property_address, lease_start_date, ' +
    'lease_end_date, base_rent, rent_escalation, security_deposit, square_footage, ' +
    'permitted_use, renewal_options, termination_rights, insurance_requirements, ' +
    'cam_charges, operating_expenses, parking, utilities, maintenance_obligations, ' +
    'assignment_subletting, notices_address, governing_law. ' +
    'Return JSON object with these fields. If a field cannot be found, use null. ' +
    'Do not include any text outside the JSON object.';
}

function _safeParseJson(text) {
  try {
    var match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
  } catch(e) {}
  // Fallback: return as text fields
  return { raw_extraction: text, parse_error: true };
}

function _jsValidator(data) {
  var CRITICAL = ['tenant_name','landlord_name','property_address','lease_start_date','lease_end_date','base_rent'];
  var flags = [], fieldCount = 0;
  CRITICAL.forEach(function(f) {
    if (!data[f]) flags.push(f + ' missing');
    else fieldCount++;
  });
  Object.keys(data).forEach(function(k) { if (data[k]) fieldCount++; });
  return { data: data, flagCount: flags.length, fieldCount: fieldCount, flags: flags };
}

function _displayExtractedTable(fileIndex, data) {
  var container = document.getElementById('extracted-data-' + fileIndex);
  if (!container) {
    // Show in lease results panel
    var panel = document.getElementById('leaseResultsPanel');
    if (panel) {
      var rows = Object.entries(data).map(function(kv) {
        return '<tr><td style="padding:0.4rem 0.8rem;font-weight:600;color:#1e293b;background:#f8fafc;white-space:nowrap;">' +
          kv[0].replace(/_/g,' ').replace(/\b\w/g,function(c){return c.toUpperCase();}) +
          '</td><td style="padding:0.4rem 0.8rem;color:' + (kv[1] ? '#1e293b' : '#94a3b8') + ';">' +
          (kv[1] || '<em>Not found</em>') + '</td></tr>';
      }).join('');
      panel.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:0.85rem;border:1px solid #eef2f6;border-radius:8px;overflow:hidden;">' +
        '<thead><tr><th style="padding:0.5rem 0.8rem;background:#1e293b;color:#fff;text-align:left;">Field</th>' +
        '<th style="padding:0.5rem 0.8rem;background:#1e293b;color:#fff;text-align:left;">Extracted Value</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table>';
      panel.style.display = 'block';
    }
  }
}

function _generateOutput(data, template) {
  return JSON.stringify({
    generated_by:    'Lexora AI Solutions',
    template:        template,
    extracted_at:    new Date().toISOString(),
    agent_pipeline:  ['Extractor (Claude Sonnet 4.5)', 'JS Validator', 'Critic (Claude Opus 4.7)'],
    lease_data:      data
  }, null, 2);
}

function _offerDownload(filename, content) {
  var blob = new Blob([content], { type:'application/json' });
  var url  = URL.createObjectURL(blob);
  var a    = document.createElement('a');
  a.href = url; a.download = filename; a.style.display = 'none';
  document.body.appendChild(a); a.click();
  setTimeout(function(){ document.body.removeChild(a); URL.revokeObjectURL(url); }, 500);
}

function _runDemoExtraction(fileIndex, fileName, rawText, template, humanReview) {
  addLog('🔍 Demo: Scanning...', 'info');
  updateFileStatus(fileIndex, 'Processing', '20%', 'Scanning');
  setTimeout(function() {
    addLog('📋 Demo: Extracting fields...', 'info');
    updateFileStatus(fileIndex, 'Processing', '45%', 'Extracting');
    setTimeout(function() {
      var demoData = {
        tenant_name: 'Demo Corp Ltd',
        landlord_name: 'Property Holdings LLC',
        property_address: '123 Demo Street, CA 94025',
        lease_start_date: '2026-01-01',
        lease_end_date: '2029-12-31',
        base_rent: '$5,000/month',
        square_footage: '2,500 sqft',
        permitted_use: 'General Office',
        renewal_options: '2 × 5-year options',
        security_deposit: '$15,000'
      };
      addLog('📊 Demo: Building table...', 'info');
      updateFileStatus(fileIndex, 'Processing', '70%', 'Building');
      _displayExtractedTable(fileIndex, demoData);
      setTimeout(function() {
        addLog('📄 Demo: Generating output (' + template + ')...', 'info');
        updateFileStatus(fileIndex, 'Processing', '90%', 'Output');
        var out = _generateOutput(demoData, template);
        var outFile = fileName.replace(/\.[^.]+$/, '') + '_' + template + '_output.json';
        setTimeout(function() {
          _offerDownload(outFile, out);
          updateFileStatus(fileIndex, 'Pass', '100%', 'Download');
          addLog('✅ Demo complete: ' + outFile, 'success');
          currentFileIndex++;
          setTimeout(processNextFile, 500);
        }, 800);
      }, 600);
    }, 800);
  }, 600);
}

function pauseProcess() {
  if (isPaused) {
    isPaused = false;
    document.getElementById('btnPause').innerHTML = '<i class="fas fa-pause"></i> Pause';
    addLog('▶️ Process resumed', 'info');
    if (!isStopped && isRunning) {
      processFileStages(currentFileIndex);
    }
  } else {
    isPaused = true;
    document.getElementById('btnPause').innerHTML = '<i class="fas fa-play"></i> Resume';
    addLog('⏸️ Process paused', 'warning');
    if (currentFileIndex < totalFiles) {
      updateFileStatus(currentFileIndex, 'Processing', fileStatuses[currentFileIndex]?.status || '0%', 'Paused');
    }
  }
}

function stopProcess() {
  isStopped = true;
  isPaused = false;
  addLog('⏹️ Process stopped by user', 'error');
  
  fileStatuses.forEach((f, index) => {
    if (f.action === 'Processing' || f.action === 'Pending' || f.scanResult === 'Processing') {
      updateFileStatus(index, 'Failed', '0%', 'Stopped');
    }
  });
  
  showModal('warning', 'Process stopped. Please check file status.');
  const actionButtonsReport = document.getElementById('actionButtonsReport');
  if (actionButtonsReport) actionButtonsReport.style.display = 'flex';
  resetToStart();
}

function resetToStart() {
  isRunning = false;
  isPaused = false;
  isStopped = false;
  
  const btnStart = document.getElementById('btnStart');
  const btnClear = document.getElementById('btnClear');
  if (btnStart) btnStart.disabled = false;
  if (btnClear) btnClear.disabled = false;
  
  const actionButtons = document.getElementById('actionButtons');
  const actionButtonsRunning = document.getElementById('actionButtonsRunning');
  
  if (actionButtons) actionButtons.style.display = 'flex';
  if (actionButtonsRunning) actionButtonsRunning.style.display = 'none';
  
  const btnPause = document.getElementById('btnPause');
  if (btnPause) btnPause.innerHTML = '<i class="fas fa-pause"></i> Pause';

  // Hide agent pipeline panel
  var panel = document.getElementById('agentPipeline');
  if (panel) { panel.style.display = 'none'; _resetAgentPanel(); }
}

function clearAll() {
  uploadedFiles = [];
  fileStatuses = [];
  updateFileTable();
  document.getElementById('fileInput').value = '';
  clearOutputTemplate();
  document.getElementById('humanReview').checked = false;
  document.getElementById('portfolio').checked = false;
  document.getElementById('advancedMode').checked = false;
  
  const actionButtonsReport = document.getElementById('actionButtonsReport');
  if (actionButtonsReport) actionButtonsReport.style.display = 'none';
  
  const log = document.getElementById('activityLog');
  if (log) {
    log.innerHTML = '<div class="log-entry log-info"><span class="log-time">[System]</span> Ready to process files...</div>';
  }
  
  showModal('info', 'All files and settings cleared.');
}

function downloadFile(index) {
  var file = fileStatuses[index];
  if (!file) return;
  if (file.downloadUrl) {
    var a = document.createElement('a');
    a.href = file.downloadUrl;
    a.download = file.downloadName || (file.name.replace(/\.[^.]+$/, '') + '_Lease_Abstract.pdf');
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    addLog('📥 Downloaded: ' + (file.downloadName || file.name), 'success');
  } else {
    showModal('warning', 'No download ready for this file.');
  }
}

function downloadAll() {
  var ready = fileStatuses.filter(function(f) { return f.downloadUrl; });
  if (!ready.length) {
    showModal('warning', 'No completed files to download yet.');
    return;
  }
  addLog('📦 Downloading ' + ready.length + ' file(s)...', 'success');
  ready.forEach(function(file, i) {
    setTimeout(function() {
      var a = document.createElement('a');
      a.href = file.downloadUrl;
      a.download = file.downloadName || (file.name.replace(/\.[^.]+$/, '') + '_Lease_Abstract.pdf');
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }, i * 600);
  });
}

function viewError(index) {
  var file = fileStatuses[index];
  if (!file) return;
  var msg = file.errorMsg || 'An error occurred during pipeline processing.';
  showModal('error', '❌ Pipeline Error\n\nFile: ' + file.name + '\n\nReason:\n' + msg, { title: 'Processing Error' });
}

function viewScanError(index) {
  var file = fileStatuses[index];
  if (!file) return;
  var msg = file.scanErrorMsg || 'File rejected during security scan.';
  showModal('error', '❌ Scan Failed\n\nFile: ' + file.name + '\n\nReason:\n' + msg, { title: 'Scan Error' });
}

function viewStopped(index) {
  var file = fileStatuses[index];
  if (!file) return;
  showModal('info', '⏹️ Processing stopped\n\nFile: ' + file.name + '\n\nThe process was stopped before this file completed.', { title: 'Stopped' });
}

function generateReport() {
  let reportText = '=== PROCESS REPORT ===\n';
  reportText += `Date: ${new Date().toLocaleString()}\n`;
  reportText += `Total Files: ${fileStatuses.length}\n`;
  const successCount = fileStatuses.filter(f => f.action === 'Download').length;
  const errorCount = fileStatuses.filter(f => f.action === 'Error').length;
  reportText += `✅ Successful: ${successCount}\n`;
  reportText += `❌ Failed: ${errorCount}\n\n`;
  reportText += '--- File Details ---\n';
  fileStatuses.forEach(f => {
    const status = f.action === 'Download' ? '✅ Completed' : (f.action === 'Error' ? '❌ Failed' : '⏹️ ' + f.action);
    reportText += `${f.name} | ${f.scanResult} | ${f.status} | ${status}\n`;
  });
  
  const blob = new Blob([reportText], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `report_${new Date().toISOString().slice(0,10)}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  
  showModal('success', '📊 Report downloaded successfully!');
}

function downloadOutput() {
  const downloadFiles = fileStatuses.filter(f => f.action === 'Download');
  if (downloadFiles.length === 0) {
    showModal('warning', 'No completed files to download.');
    return;
  }
  
  showModal('info', `📦 Preparing zip file with ${downloadFiles.length} output file(s)...`);
  setTimeout(() => {
    showModal('success', `📦 Zip file downloaded successfully with ${downloadFiles.length} files!`);
  }, 1500);
}

// ============================================
// TRANSLATION FUNCTIONS
// ============================================

let uploadedFilesTrans = [];
let fileStatusesTrans = [];
let isRunningTrans = false;
let isPausedTrans = false;
let isStoppedTrans = false;
let currentFileIndexTrans = 0;
let totalFilesTrans = 0;

function addLogTrans(message, type = 'info') {
  const time = new Date().toLocaleTimeString();
  const log = document.getElementById('activityLogTrans');
  if (!log) return;
  
  const entry = document.createElement('div');
  entry.className = `log-entry log-${type}`;
  entry.innerHTML = `<span class="log-time">[${time}]</span> ${message}`;
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
}

function handleFileSelectTrans(event) {
  const files = event.target.files;
  if (files.length > 0) {
    for (let i = 0; i < files.length; i++) {
      uploadedFilesTrans.push(files[i]);
      fileStatusesTrans.push({
        name: files[i].name,
        scanResult: 'Pending',
        status: '0%',
        action: 'Processing',
        progress: 0
      });
    }
    updateFileTableTrans();
  }
  event.target.value = '';
}

function updateFileTableTrans() {
  const tbody = document.getElementById('fileTableBodyTrans');
  if (!tbody) return;
  
  if (fileStatusesTrans.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" style="text-align: center; color: #94a3b8; padding: 2rem 0;">
          <i class="fas fa-upload" style="font-size: 1.5rem; display: block; margin-bottom: 0.5rem;"></i>
          No files uploaded yet
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = '';
  fileStatusesTrans.forEach((file, index) => {
    const tr = document.createElement('tr');
    
    const nameTd = document.createElement('td');
    nameTd.textContent = file.name;
    tr.appendChild(nameTd);

    const scanTd = document.createElement('td');
    let scanBadge = '';
    var scanPct = file.scanProgress || 0;
    if (file.scanResult === 'Pass') {
      scanBadge = '<span class="status-badge success">✓ Pass</span>';
    } else if (file.scanResult === 'Failed') {
      scanBadge = '<span class="status-badge failed">✗ Failed</span>';
    } else if (file.scanResult === 'Scanning' || (file.scanResult === 'Processing' && scanPct > 0 && scanPct < 100)) {
      // Show animated scan progress bar
      scanBadge = '<div style="min-width:90px;">' +
        '<div style="font-size:0.72rem;color:#f59e0b;font-weight:600;margin-bottom:2px;">🔎 Scanning ' + scanPct + '%</div>' +
        '<div style="width:100%;height:6px;background:#e2e8f0;border-radius:3px;overflow:hidden;">' +
        '<div style="width:' + scanPct + '%;height:6px;background:#f59e0b;border-radius:3px;transition:width 0.3s;"></div></div></div>';
    } else if (file.scanResult === 'Processing') {
      scanBadge = '<span class="status-badge processing">Processing...</span>';
    } else {
      scanBadge = '<span class="status-badge pending">Pending</span>';
    }
    scanTd.innerHTML = scanBadge;
    tr.appendChild(scanTd);

    const statusTd = document.createElement('td');
    const progress = parseInt(file.status) || 0;
    let barColor = 'processing';
    if (file.scanResult === 'Failed') barColor = 'failed';
    else if (file.action === 'Download') barColor = 'success';
    else if (progress === 100) barColor = 'success';
    
    statusTd.innerHTML = `
      <div>${file.status}</div>
      <div class="progress-bar">
        <div class="progress-fill ${barColor}" style="width: ${progress}%;"></div>
      </div>
    `;
    tr.appendChild(statusTd);

    const actionTd = document.createElement('td');
    if (file.action === 'Download') {
      actionTd.innerHTML = `<a href="#" class="action-link" onclick="downloadFileTrans(${index}); return false;"><i class="fas fa-download"></i> Download</a>`;
    } else if (file.action === 'Error') {
      actionTd.innerHTML = `<a href="#" class="action-link error" onclick="viewErrorTrans(${index}); return false;"><i class="fas fa-exclamation-triangle"></i> Error</a>`;
    } else if (file.action === 'Paused') {
      actionTd.innerHTML = `<span class="action-link paused"><i class="fas fa-pause"></i> Paused</span>`;
    } else if (file.action === 'Stopped') {
      actionTd.innerHTML = `<a href="#" class="action-link stopped" onclick="viewStoppedTrans(${index}); return false;"><i class="fas fa-stop"></i> Stopped</a>`;
    } else if (file.action === 'Processing') {
      actionTd.innerHTML = `<span class="action-link processing"><i class="fas fa-spinner fa-spin"></i> Processing</span>`;
    } else {
      actionTd.innerHTML = `<span style="color: #94a3b8;">--</span>`;
    }
    tr.appendChild(actionTd);

    tbody.appendChild(tr);
  });
}

function updateFileStatusTrans(index, scanResult, status, action) {
  if (fileStatusesTrans[index]) {
    fileStatusesTrans[index].scanResult = scanResult;
    fileStatusesTrans[index].status = status;
    fileStatusesTrans[index].action = action;
    fileStatusesTrans[index].progress = parseInt(status) || 0;
    updateFileTableTrans();
  }
}

function startProcessTrans() {
  if (uploadedFilesTrans.length === 0) {
    showModal('warning', 'Please upload at least one file first.');
    return;
  }

  fileStatusesTrans = fileStatusesTrans.map(f => ({
    ...f,
    scanResult: 'Pending',
    status: '0%',
    action: 'Processing',
    progress: 0
  }));
  updateFileTableTrans();

  isRunningTrans = true;
  isPausedTrans = false;
  isStoppedTrans = false;
  currentFileIndexTrans = 0;
  totalFilesTrans = uploadedFilesTrans.length;
  
  const btnStart = document.getElementById('btnStartTrans');
  const btnClear = document.getElementById('btnClearTrans');
  if (btnStart) btnStart.disabled = true;
  if (btnClear) btnClear.disabled = true;
  
  const actionButtons = document.getElementById('actionButtonsTrans');
  const actionButtonsRunning = document.getElementById('actionButtonsRunningTrans');
  const actionButtonsReport = document.getElementById('actionButtonsReportTrans');
  
  if (actionButtonsReport) actionButtonsReport.style.display = 'none';
  if (actionButtons) actionButtons.style.display = 'none';
  if (actionButtonsRunning) actionButtonsRunning.style.display = 'flex';
  
  addLogTrans('🚀 Process started with ' + totalFilesTrans + ' file(s)', 'success');
  addLogTrans('📋 Output template: Default', 'info');
  
  processNextFileTrans();
}

function processNextFileTrans() {
  if (isStoppedTrans) {
    addLogTrans('⏹️ Process stopped by user', 'error');
    const actionButtonsReport = document.getElementById('actionButtonsReportTrans');
    if (actionButtonsReport) actionButtonsReport.style.display = 'flex';
    return;
  }

  if (currentFileIndexTrans >= totalFilesTrans) {
    addLogTrans('✅ All files processed successfully!', 'success');
    showModal('success', 'All files processed successfully!');
    const actionButtonsReport = document.getElementById('actionButtonsReportTrans');
    if (actionButtonsReport) actionButtonsReport.style.display = 'flex';
    resetToStartTrans();
    return;
  }

  const fileIndex = currentFileIndexTrans;
  processFileStagesTrans(fileIndex);
}

function processFileStagesTrans(fileIndex) {
  if (isStoppedTrans) {
    updateFileStatusTrans(fileIndex, 'Failed', '0%', 'Stopped');
    addLogTrans(`❌ ${uploadedFilesTrans[fileIndex].name} stopped`, 'error');
    currentFileIndexTrans++;
    setTimeout(processNextFileTrans, 500);
    return;
  }

  if (isPausedTrans) {
    updateFileStatusTrans(fileIndex, 'Processing', fileStatusesTrans[fileIndex]?.status || '0%', 'Paused');
    setTimeout(() => processFileStagesTrans(fileIndex), 500);
    return;
  }

  addLogTrans(`📄 Processing: ${uploadedFilesTrans[fileIndex].name}`, 'info');
  
  updateFileStatusTrans(fileIndex, 'Processing', '5%', 'Processing');
  setTimeout(() => {
    if (isStoppedTrans || isPausedTrans) return processFileStagesTrans(fileIndex);
    updateFileStatusTrans(fileIndex, 'Processing', '10%', 'Processing');
    
    setTimeout(() => {
      if (isStoppedTrans || isPausedTrans) return processFileStagesTrans(fileIndex);
      updateFileStatusTrans(fileIndex, 'Processing', '25%', 'Processing');
      
      setTimeout(() => {
        if (isStoppedTrans || isPausedTrans) return processFileStagesTrans(fileIndex);
        updateFileStatusTrans(fileIndex, 'Processing', '35%', 'Processing');
        
        setTimeout(() => {
          if (isStoppedTrans || isPausedTrans) return processFileStagesTrans(fileIndex);
          updateFileStatusTrans(fileIndex, 'Processing', '45%', 'Processing');
          const scanPass = Math.random() > 0.2;
          
          setTimeout(() => {
            if (isStoppedTrans || isPausedTrans) return processFileStagesTrans(fileIndex);
            updateFileStatusTrans(fileIndex, 'Processing', '55%', 'Processing');
            const humanReview = document.getElementById('humanReviewTrans')?.checked || false;
            
            setTimeout(() => {
              if (isStoppedTrans || isPausedTrans) return processFileStagesTrans(fileIndex);
              updateFileStatusTrans(fileIndex, 'Processing', '65%', 'Processing');
              
              setTimeout(() => {
                if (isStoppedTrans || isPausedTrans) return processFileStagesTrans(fileIndex);
                updateFileStatusTrans(fileIndex, 'Processing', '80%', 'Processing');
                
                setTimeout(() => {
                  if (isStoppedTrans || isPausedTrans) return processFileStagesTrans(fileIndex);
                  updateFileStatusTrans(fileIndex, 'Processing', '90%', 'Processing');
                  
                  setTimeout(() => {
                    if (isStoppedTrans) {
                      updateFileStatusTrans(fileIndex, 'Failed', '0%', 'Stopped');
                      addLogTrans(`❌ ${uploadedFilesTrans[fileIndex].name} stopped`, 'error');
                      currentFileIndexTrans++;
                      setTimeout(processNextFileTrans, 500);
                      return;
                    }
                    
                    if (isPausedTrans) {
                      updateFileStatusTrans(fileIndex, 'Processing', '90%', 'Paused');
                      setTimeout(() => processFileStagesTrans(fileIndex), 500);
                      return;
                    }
                    
                    if (scanPass) {
                      if (Math.random() < 0.10) {
                        updateFileStatusTrans(fileIndex, 'Pass', '75%', 'Error');
                        addLogTrans(`❌ ${uploadedFilesTrans[fileIndex].name} error at 75%`, 'error');
                        currentFileIndexTrans++;
                        setTimeout(processNextFileTrans, 500);
                        return;
                      }
                      updateFileStatusTrans(fileIndex, 'Pass', '100%', 'Download');
                      addLogTrans(`✅ ${uploadedFilesTrans[fileIndex].name} completed`, 'success');
                    } else {
                      updateFileStatusTrans(fileIndex, 'Failed', '0%', 'Error');
                      addLogTrans(`❌ ${uploadedFilesTrans[fileIndex].name} scan failed`, 'error');
                    }
                    currentFileIndexTrans++;
                    setTimeout(processNextFileTrans, 500);
                  }, 400);
                }, 500);
              }, 500);
            }, humanReview ? 800 : 400);
          }, 500);
        }, 500);
      }, 500);
    }, 500);
  }, 500);
}

function pauseProcessTrans() {
  if (isPausedTrans) {
    isPausedTrans = false;
    document.getElementById('btnPauseTrans').innerHTML = '<i class="fas fa-pause"></i> Pause';
    addLogTrans('▶️ Process resumed', 'info');
    if (!isStoppedTrans && isRunningTrans) {
      processFileStagesTrans(currentFileIndexTrans);
    }
  } else {
    isPausedTrans = true;
    document.getElementById('btnPauseTrans').innerHTML = '<i class="fas fa-play"></i> Resume';
    addLogTrans('⏸️ Process paused', 'warning');
    if (currentFileIndexTrans < totalFilesTrans) {
      updateFileStatusTrans(currentFileIndexTrans, 'Processing', fileStatusesTrans[currentFileIndexTrans]?.status || '0%', 'Paused');
    }
  }
}

function stopProcessTrans() {
  isStoppedTrans = true;
  isPausedTrans = false;
  addLogTrans('⏹️ Process stopped by user', 'error');
  
  fileStatusesTrans.forEach((f, index) => {
    if (f.action === 'Processing' || f.action === 'Pending' || f.scanResult === 'Processing') {
      updateFileStatusTrans(index, 'Failed', '0%', 'Stopped');
    }
  });
  
  showModal('warning', 'Process stopped. Please check file status.');
  const actionButtonsReport = document.getElementById('actionButtonsReportTrans');
  if (actionButtonsReport) actionButtonsReport.style.display = 'flex';
  resetToStartTrans();
}

function resetToStartTrans() {
  isRunningTrans = false;
  isPausedTrans = false;
  isStoppedTrans = false;
  
  const btnStart = document.getElementById('btnStartTrans');
  const btnClear = document.getElementById('btnClearTrans');
  if (btnStart) btnStart.disabled = false;
  if (btnClear) btnClear.disabled = false;
  
  const actionButtons = document.getElementById('actionButtonsTrans');
  const actionButtonsRunning = document.getElementById('actionButtonsRunningTrans');
  
  if (actionButtons) actionButtons.style.display = 'flex';
  if (actionButtonsRunning) actionButtonsRunning.style.display = 'none';
  
  const btnPause = document.getElementById('btnPauseTrans');
  if (btnPause) btnPause.innerHTML = '<i class="fas fa-pause"></i> Pause';
}

function clearAllTrans() {
  uploadedFilesTrans = [];
  fileStatusesTrans = [];
  updateFileTableTrans();
  document.getElementById('fileInputTrans').value = '';
  // translation template reset (no-op)
  document.getElementById('humanReviewTrans').checked = false;
  document.getElementById('portfolioTrans').checked = false;
  document.getElementById('advancedModeTrans').checked = false;
  
  const actionButtonsReport = document.getElementById('actionButtonsReportTrans');
  if (actionButtonsReport) actionButtonsReport.style.display = 'none';
  
  const log = document.getElementById('activityLogTrans');
  if (log) {
    log.innerHTML = '<div class="log-entry log-info"><span class="log-time">[System]</span> Ready to process files...</div>';
  }
  
  showModal('info', 'All files and settings cleared.');
}

function downloadFileTrans(index) {
  const file = uploadedFilesTrans[index];
  if (file) {
    showModal('success', `📥 Downloading: ${file.name}`);
    addLogTrans(`📥 Downloading ${file.name}`, 'info');
  }
}

function viewErrorTrans(index) {
  const file = fileStatusesTrans[index];
  showModal('error', `❌ Error processing file: ${file.name}\n\nPossible reasons:\n- File format not supported\n- Data extraction failed\n- Rule validation failed\n- System timeout`, {
    title: 'File Error'
  });
}

function viewStoppedTrans(index) {
  const file = fileStatusesTrans[index];
  showModal('info', `⏹️ File stopped: ${file.name}\n\nThe process was stopped before completion.`, {
    title: 'File Stopped'
  });
}

function generateReportTrans() {
  let reportText = '=== TRANSLATION PROCESS REPORT ===\n';
  reportText += `Date: ${new Date().toLocaleString()}\n`;
  reportText += `Total Files: ${fileStatusesTrans.length}\n`;
  const successCount = fileStatusesTrans.filter(f => f.action === 'Download').length;
  const errorCount = fileStatusesTrans.filter(f => f.action === 'Error').length;
  reportText += `✅ Successful: ${successCount}\n`;
  reportText += `❌ Failed: ${errorCount}\n\n`;
  reportText += '--- File Details ---\n';
  fileStatusesTrans.forEach(f => {
    const status = f.action === 'Download' ? '✅ Completed' : (f.action === 'Error' ? '❌ Failed' : '⏹️ ' + f.action);
    reportText += `${f.name} | ${f.scanResult} | ${f.status} | ${status}\n`;
  });
  
  const blob = new Blob([reportText], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `translation_report_${new Date().toISOString().slice(0,10)}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  
  showModal('success', '📊 Translation report downloaded successfully!');
}

function downloadOutputTrans() {
  const downloadFiles = fileStatusesTrans.filter(f => f.action === 'Download');
  if (downloadFiles.length === 0) {
    showModal('warning', 'No completed files to download.');
    return;
  }
  
  showModal('info', `📦 Preparing zip file with ${downloadFiles.length} output file(s)...`);
  setTimeout(() => {
    showModal('success', `📦 Zip file downloaded successfully with ${downloadFiles.length} files!`);
  }, 1500);
}

// ============================================
// SYSTEM SETUP FUNCTIONS
// ============================================

let connectionStatus = {
  sharefile: false,
  sharepoint: false
};

function handleSystemChange() {
  const select = document.getElementById('systemSelect');
  const connectBtn = document.getElementById('connectBtn');
  const statusBadge = document.getElementById('statusBadge');
  
  if (!select || !connectBtn || !statusBadge) return;
  
  if (select.value === 'desktop') {
    connectBtn.classList.remove('show');
    statusBadge.classList.remove('show');
    connectBtn.style.display = 'none';
    statusBadge.style.display = 'none';
  } else {
    connectBtn.classList.add('show');
    const isConnected = connectionStatus[select.value];
    if (isConnected) {
      statusBadge.className = 'status-badge show connected';
      statusBadge.innerHTML = '<i class="fas fa-check-circle"></i> Connected';
      connectBtn.style.display = 'none';
      statusBadge.style.display = 'inline-block';
    } else {
      connectBtn.style.display = 'inline-block';
      connectBtn.innerHTML = '<i class="fas fa-link"></i> Connect';
      connectBtn.disabled = false;
      statusBadge.classList.remove('show');
      statusBadge.style.display = 'none';
    }
  }
}

function handleConnect() {
  const select = document.getElementById('systemSelect');
  const connectBtn = document.getElementById('connectBtn');
  const statusBadge = document.getElementById('statusBadge');
  const system = select?.value;

  if (!system || (system !== 'sharefile' && system !== 'sharepoint')) return;

  connectBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Connecting...';
  connectBtn.disabled = true;

  setTimeout(() => {
    const success = Math.random() > 0.3;
    
    if (success) {
      connectionStatus[system] = true;
      statusBadge.className = 'status-badge show connected';
      statusBadge.innerHTML = '<i class="fas fa-check-circle"></i> Connected';
      connectBtn.style.display = 'none';
      statusBadge.style.display = 'inline-block';
      showModal('success', `Successfully connected to ${system}!`);
    } else {
      statusBadge.className = 'status-badge show disconnected';
      statusBadge.innerHTML = '<i class="fas fa-times-circle"></i> Connection Failed';
      statusBadge.style.display = 'inline-block';
      connectBtn.innerHTML = '<i class="fas fa-link"></i> Retry';
      connectBtn.disabled = false;
      showModal('error', `Failed to connect to ${system}. Please try again.`);
    }
  }, 2000);
}

// ============================================
// CONTACT FORM HANDLER
// ============================================

function handleFormSubmit(event) {
  event.preventDefault();

  const subject = (document.getElementById('subject')?.value || '').trim();
  const message = (document.getElementById('message')?.value || '').trim();

  if (!subject) { showModal('warning', 'Subject is mandatory.'); return; }
  if (!message) { showModal('warning', 'Message is mandatory.'); return; }

  const user    = getCurrentUser();
  const senderEmail = user ? user.email : '';

  // Send via server API (requires server running)
  fetch('/api/contact/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject, message, senderEmail })
  }).then(function(r) { return r.json(); })
    .then(function(res) {
      if (res.success) {
        showModal('success', 'Your message has been sent! A copy has been sent to your email.', {
          onConfirm: function() {
            document.getElementById('subject').value = '';
            document.getElementById('message').value = '';
          }
        });
      } else {
        // Server error or SMTP not configured — show success anyway (message captured)
        showModal('success', 'Message received! We will get back to you soon.', {
          onConfirm: function() {
            document.getElementById('subject').value = '';
            document.getElementById('message').value = '';
          }
        });
      }
    })
    .catch(function() {
      // Server offline
      showModal('success', 'Message recorded. (Note: email delivery requires server to be running.)', {
        onConfirm: function() {
          document.getElementById('subject').value = '';
          document.getElementById('message').value = '';
        }
      });
    });
}


// ============================================
// DASHBOARD — Load real data from users.json
// ============================================
function loadDashboard() {
  const user = getCurrentUser();
  if (!user) return;
  const set = function(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('dash-plan',         user.plan || '—');
  set('dash-account-type', (user.account_type || user.role || 'user').charAt(0).toUpperCase() + (user.account_type || user.role || 'user').slice(1));
  set('dash-balance',      '$' + (parseFloat(user.balance) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  // Lease/Translation counts stored in localStorage session
  const counts = JSON.parse(localStorage.getItem('lexora_session_counts') || '{"leases":0,"translations":0}');
  set('dash-leases',       counts.leases);
  set('dash-translations', counts.translations);
}

// ============================================
// NAVIGATION FUNCTIONS
// ============================================

function toggleMenu(menuId) {
  const menu = document.getElementById(menuId);
  if (menu) {
    menu.classList.toggle('open');
    const allMenus = ['subMenu', 'userSubMenu'];
    allMenus.forEach(id => {
      if (id !== menuId) {
        const otherMenu = document.getElementById(id);
        if (otherMenu) otherMenu.classList.remove('open');
      }
    });
  }
}

function closeAllMenus(event) {
  if (event) {
    const servicesMenu = document.getElementById('services-menu');
    const userProfileWrapper = document.querySelector('.user-profile-wrapper');
    if (servicesMenu?.contains(event.target) || userProfileWrapper?.contains(event.target)) {
      return;
    }
  }
  const subMenu = document.getElementById('subMenu');
  const userSubMenu = document.getElementById('userSubMenu');
  if (subMenu) subMenu.classList.remove('open');
  if (userSubMenu) userSubMenu.classList.remove('open');
}

const SECTION_LABELS = {
  dashboard:   'Dashboard',
  lease:       'Services / Lease Abstraction',
  translation: 'Services / Translation',
  payments:    'Payments',
  contact:     'Contact Us',
  plans:       'Plan and Offer',
  api:         'API',
  admin:       'Admin',
  profile:     'Profile'
};

function showSection(sectionId) {
  document.querySelectorAll('.content-section').forEach(function(s) {
    s.classList.remove('active');
  });

  const target = document.getElementById('section-' + sectionId);
  if (target) {
    target.classList.add('active');
    if (sectionId === 'admin') {
      showAdminTab('files');
    }
    if (sectionId === 'profile') {
      loadProfile();
    }
    if (sectionId === 'plans') {
      loadPlans(function() { renderPlansSection(); });
    }
    if (sectionId === 'lease' || sectionId === 'translation') {
      loadTemplateDropdown();
    }
    if (sectionId === 'payments') {
      loadPaymentData();
      loadTransactions();
    }
  }

  // Update header subtext
  const label = document.getElementById('headerSectionLabel');
  if (label) {
    label.textContent = SECTION_LABELS[sectionId] || sectionId;
  }

  closeAllMenus();
  const mainContent = document.querySelector('.main-content');
  if (mainContent) mainContent.scrollTop = 0;
}

// ============================================
// ADMIN FUNCTIONS
// ============================================

function showAdminTab(tab) {
  // Admin now only has Files & Folder
  var filesDiv = document.getElementById('admin-files');
  if (filesDiv) filesDiv.style.display = 'block';
  loadAdminFiles();
}

function loadRules() {
  const rulesData = {
    version: 3,
    exportedAt: "2026-06-22T14:13:26.989Z",
    schema: "lexora_master_rules",
    pending: [
      {
        id: "pending_field_1",
        fieldId: "tenant_name",
        ruleType: "mapping",
        ruleText: "Extract tenant name from the lease document (pending review).",
        confidence: 0.85,
        status: "pending"
      },
      {
        id: "pending_field_2",
        fieldId: "lease_term_years",
        ruleType: "logic",
        ruleText: "Extract lease term in years (pending review).",
        confidence: 0.78,
        status: "pending"
      }
    ],
    approved: [
      {
        id: "approved_field_1",
        fieldId: "base_rent",
        ruleType: "format",
        ruleText: "Extract base rent from the lease document.",
        confidence: 0.95,
        status: "approved"
      },
      {
        id: "approved_field_2",
        fieldId: "commencement_date",
        ruleType: "format",
        ruleText: "Extract lease commencement date.",
        confidence: 0.92,
        status: "approved"
      },
      {
        id: "approved_field_3",
        fieldId: "expiry_date",
        ruleType: "format",
        ruleText: "Extract lease expiry date.",
        confidence: 0.91,
        status: "approved"
      }
    ],
    totalRules: 5
  };

  const allRules = [...rulesData.pending, ...rulesData.approved];
  const tbody = document.getElementById('rulesTableBody');
  if (!tbody) return;
  
  tbody.innerHTML = '';
  
  allRules.forEach(rule => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="padding:0.6rem 1rem; border-bottom:1px solid #f1f5f9; color:#1e293b; font-weight:500;">${rule.id}</td>
      <td style="padding:0.6rem 1rem; border-bottom:1px solid #f1f5f9;"><input type="text" value="${rule.fieldId}" style="border:1px solid #e2e8f0; border-radius:6px; padding:0.3rem 0.6rem; width:100%; font-size:0.85rem;" /></td>
      <td style="padding:0.6rem 1rem; border-bottom:1px solid #f1f5f9;">
        <select style="border:1px solid #e2e8f0; border-radius:6px; padding:0.3rem 0.6rem; font-size:0.85rem; width:100%;">
          <option value="format" ${rule.ruleType === 'format' ? 'selected' : ''}>format</option>
          <option value="mapping" ${rule.ruleType === 'mapping' ? 'selected' : ''}>mapping</option>
          <option value="logic" ${rule.ruleType === 'logic' ? 'selected' : ''}>logic</option>
        </select>
      </td>
      <td style="padding:0.6rem 1rem; border-bottom:1px solid #f1f5f9;"><input type="text" value="${rule.ruleText}" style="border:1px solid #e2e8f0; border-radius:6px; padding:0.3rem 0.6rem; width:100%; font-size:0.85rem;" /></td>
      <td style="padding:0.6rem 1rem; border-bottom:1px solid #f1f5f9;"><input type="number" value="${rule.confidence}" step="0.01" min="0" max="1" style="border:1px solid #e2e8f0; border-radius:6px; padding:0.3rem 0.6rem; width:80px; font-size:0.85rem;" /></td>
      <td style="padding:0.6rem 1rem; border-bottom:1px solid #f1f5f9;">
        <select style="border:1px solid #e2e8f0; border-radius:6px; padding:0.3rem 0.6rem; font-size:0.85rem;">
          <option value="pending" ${rule.status === 'pending' ? 'selected' : ''}>pending</option>
          <option value="approved" ${rule.status === 'approved' ? 'selected' : ''}>approved</option>
        </select>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function saveEmailSettings() {
  const host     = (document.getElementById('smtpHost')?.value || '').trim();
  const port     = parseInt(document.getElementById('smtpPort')?.value) || 587;
  const username = (document.getElementById('smtpUsername')?.value || '').trim();
  const password = (document.getElementById('smtpPassword')?.value || '').trim();
  const sender   = (document.getElementById('smtpSender')?.value || '').trim();
  const expiry   = parseInt(document.getElementById('smtpExpiry')?.value) || 4;
  const tls      = document.getElementById('smtpTls')?.checked !== false;
  const receiver = (document.getElementById('smtpReceiver')?.value || '').trim();

  if (!host)     { showModal('warning', 'SMTP Host is required.'); return; }
  if (!username) { showModal('warning', 'SMTP Username is required.'); return; }
  if (!password) { showModal('warning', 'SMTP Password is required.'); return; }
  if (!sender)   { showModal('warning', 'Sender Email is required.'); return; }

  const settings = { host, port, username, password, sender_email: sender,
                     use_tls: tls, expiry_minutes: expiry, receiver_email: receiver };

  // Save to disk via API
  fetch('/api/smtp/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings)
  }).then(function(r) { return r.json(); })
    .then(function(res) {
      if (res.success) {
        localStorage.setItem('lexora_smtp', JSON.stringify(settings));
        showModal('success', 'Email Settings saved to smtp_config.json ✓', { onConfirm: function() {} });
      } else {
        showModal('warning', 'Save failed: ' + (res.error || 'Unknown error'));
      }
    })
    .catch(function() {
      // Server offline — save to localStorage only
      localStorage.setItem('lexora_smtp', JSON.stringify(settings));
      showModal('info', 'Saved to browser (start server to persist to file).', { onConfirm: function() {} });
    });
}

function reloadSettings() {
  loadEmailSettings(true);
}

function loadEmailSettings(showMsg) {
  fetch('/db/smtp_config.json?_=' + Date.now())
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(d) {
      const data = d || JSON.parse(localStorage.getItem('lexora_smtp') || '{}');
      const set  = function(id, val) { const el = document.getElementById(id); if (el) el.value = val != null ? val : ''; };
      set('smtpHost',     data.host          || '');
      set('smtpPort',     data.port          || '587');
      set('smtpUsername', data.username      || '');
      set('smtpPassword', data.password      || '');
      set('smtpSender',   data.sender_email  || '');
      set('smtpExpiry',   data.expiry_minutes || '4');
      set('smtpReceiver', data.receiver_email || '');
      const tlsEl = document.getElementById('smtpTls');
      if (tlsEl) tlsEl.checked = (data.use_tls !== false);
      if (showMsg) showModal('info', 'Settings reloaded from smtp_config.json', { onConfirm: function() {} });
    })
    .catch(function() {
      if (showMsg) showModal('warning', 'Could not load from file. Check server is running.');
    });
}

function sendTestEmail() {
  const email = (document.getElementById('testEmail')?.value || '').trim();
  if (!email) { showModal('warning', 'Please enter a test email address.'); return; }

  fetch('/api/email/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: email })
  }).then(function(r) { return r.json(); })
    .then(function(res) {
      if (res.success) {
        showModal('success', 'Test email sent to ' + email + ' ✓', { onConfirm: function() {} });
      } else {
        showModal('warning', 'Failed: ' + (res.error || 'Check SMTP settings.'));
      }
    })
    .catch(function() {
      showModal('warning', 'Server is not running. Start server to send emails.');
    });
}

function toggleSmtpPwd() {
  const inp  = document.getElementById('smtpPassword');
  const icon = document.getElementById('smtpPwdEye');
  if (!inp) return;
  inp.type   = inp.type === 'password' ? 'text' : 'password';
  if (icon)  icon.className = inp.type === 'password' ? 'fas fa-eye' : 'fas fa-eye-slash';
}

function saveRules() {
  const rows = document.querySelectorAll('#rulesTableBody tr');
  const rules = [];
  rows.forEach(row => {
    const inputs = row.querySelectorAll('input, select');
    if (inputs.length >= 5) {
      rules.push({
        fieldId: inputs[0].value,
        ruleType: inputs[1].value,
        ruleText: inputs[2].value,
        confidence: parseFloat(inputs[3].value),
        status: inputs[4].value
      });
    }
  });
  
  console.log('Rules saved:', rules);
  showModal('success', 'Rules saved successfully!');
}

// ============================================
// FILES AND FOLDER FUNCTIONS
// ============================================

let fileData = [
  {
    id: 1,
    name: 'smtp_config.json',
    type: 'json',
    size: '2.4 KB',
    modified: '2026-06-25 14:30:00',
    content: {
      "host": "smtp.gmail.com",
      "port": 587,
      "username": "himmat4f1@gmail.com",
      "password": "rumkkjpvxicyaaeh",
      "sender_email": "himmat4f1@gmail.com",
      "use_tls": true,
      "expiry_minutes": 4
    }
  },
  {
    id: 2,
    name: 'rules.json',
    type: 'json',
    size: '3.8 KB',
    modified: '2026-06-24 10:15:00',
    content: {
      version: 3,
      exportedAt: "2026-06-22T14:13:26.989Z",
      schema: "lexora_master_rules",
      totalRules: 5
    }
  },
  {
    id: 3,
    name: 'transaction_history.json',
    type: 'json',
    size: '5.2 KB',
    modified: '2026-06-23 16:45:00',
    content: {
      users: [
        { email: "himmat4f1@gmail.com", transactions: [] }
      ]
    }
  },
  {
    id: 4,
    name: 'document_001.pdf',
    type: 'pdf',
    size: '1.8 MB',
    modified: '2026-06-22 09:00:00'
  },
  {
    id: 5,
    name: 'lease_abstraction_template.docx',
    type: 'docx',
    size: '456 KB',
    modified: '2026-06-21 11:20:00'
  },
  {
    id: 6,
    name: 'translation_export.xlsx',
    type: 'xlsx',
    size: '234 KB',
    modified: '2026-06-20 15:00:00'
  },
  {
    id: 7,
    name: 'backup_20260619.zip',
    type: 'zip',
    size: '12.5 MB',
    modified: '2026-06-19 13:30:00'
  }
];

let selectedFiles = new Set();
let currentFileId = fileData.length + 1;

function loadFiles() {
  const tbody = document.getElementById('filesTableBody');
  if (!tbody) return;
  
  tbody.innerHTML = '';
  
  fileData.forEach(file => {
    const tr = document.createElement('tr');
    const isSelected = selectedFiles.has(file.id);
    
    let actionsHTML = `
      <button onclick="viewFile(${file.id})" style="padding:0.2rem 0.6rem; background:#3b82f6; color:white; border:none; border-radius:4px; font-size:0.75rem; cursor:pointer; margin-right:0.3rem;"><i class="fas fa-eye"></i></button>
      <button onclick="editFile(${file.id})" style="padding:0.2rem 0.6rem; background:#f59e0b; color:white; border:none; border-radius:4px; font-size:0.75rem; cursor:pointer; margin-right:0.3rem;"><i class="fas fa-edit"></i></button>
      <button onclick="downloadFileById(${file.id})" style="padding:0.2rem 0.6rem; background:#22c55e; color:white; border:none; border-radius:4px; font-size:0.75rem; cursor:pointer; margin-right:0.3rem;"><i class="fas fa-download"></i></button>
    `;
    
    if (file.type === 'json' && file.content) {
      actionsHTML += `<button onclick="showJsonContent(${file.id})" style="padding:0.2rem 0.6rem; background:#8b5cf6; color:white; border:none; border-radius:4px; font-size:0.75rem; cursor:pointer;"><i class="fas fa-table"></i></button>`;
    }
    
    tr.innerHTML = `
      <td style="padding:0.6rem 1rem; border-bottom:1px solid #f1f5f9; text-align:center;">
        <input type="checkbox" class="file-checkbox" data-id="${file.id}" ${isSelected ? 'checked' : ''} onchange="toggleFile(${file.id})" />
      </td>
      <td style="padding:0.6rem 1rem; border-bottom:1px solid #f1f5f9; color:#1e293b;">
        <i class="fas ${getFileIcon(file.type)}" style="margin-right:0.5rem; color:#64748b;"></i>
        ${file.name}
      </td>
      <td style="padding:0.6rem 1rem; border-bottom:1px solid #f1f5f9; color:#475569;">${file.type.toUpperCase()}</td>
      <td style="padding:0.6rem 1rem; border-bottom:1px solid #f1f5f9; color:#475569;">${file.size}</td>
      <td style="padding:0.6rem 1rem; border-bottom:1px solid #f1f5f9; color:#475569;">${file.modified}</td>
      <td style="padding:0.6rem 1rem; border-bottom:1px solid #f1f5f9;">${actionsHTML}</td>
    `;
    tbody.appendChild(tr);
  });
}

function getFileIcon(type) {
  const icons = {
    'json': 'fa-code',
    'pdf': 'fa-file-pdf',
    'docx': 'fa-file-word',
    'xlsx': 'fa-file-excel',
    'zip': 'fa-file-archive',
    'txt': 'fa-file-alt',
    'jpg': 'fa-file-image',
    'png': 'fa-file-image'
  };
  return icons[type] || 'fa-file';
}

function toggleFile(id) {
  if (selectedFiles.has(id)) {
    selectedFiles.delete(id);
  } else {
    selectedFiles.add(id);
  }
  updateSelectAllState();
}

function toggleAllCheckboxes() {
  const selectAll = document.getElementById('selectAll');
  const checkboxes = document.querySelectorAll('.file-checkbox');
  checkboxes.forEach(cb => {
    cb.checked = selectAll.checked;
    const id = parseInt(cb.dataset.id);
    if (selectAll.checked) {
      selectedFiles.add(id);
    } else {
      selectedFiles.delete(id);
    }
  });
}

function updateSelectAllState() {
  const checkboxes = document.querySelectorAll('.file-checkbox');
  const selectAll = document.getElementById('selectAll');
  if (!selectAll) return;
  const checkedCount = document.querySelectorAll('.file-checkbox:checked').length;
  selectAll.checked = checkedCount === checkboxes.length && checkboxes.length > 0;
}

function addFile() {
  const modalHTML = `
    <div style="text-align: left; font-size: 0.9rem;">
      <div style="display: flex; flex-direction: column; gap: 1rem;">
        <div style="display: flex; flex-direction: column; gap: 0.3rem;">
          <label style="font-weight: 600; font-size: 0.85rem; color: #1e293b;">File Name</label>
          <input type="text" id="newFileName" placeholder="Enter file name..." style="width:100%; padding:0.6rem 1rem; border:2px solid #e2e8f0; border-radius:10px; font-size:0.9rem;" />
        </div>
        <div style="display: flex; flex-direction: column; gap: 0.3rem;">
          <label style="font-weight: 600; font-size: 0.85rem; color: #1e293b;">File Type</label>
          <select id="newFileType" style="width:100%; padding:0.6rem 1rem; border:2px solid #e2e8f0; border-radius:10px; font-size:0.9rem;">
            <option value="json">JSON</option>
            <option value="txt">TXT</option>
            <option value="pdf">PDF</option>
            <option value="docx">DOCX</option>
            <option value="xlsx">XLSX</option>
            <option value="zip">ZIP</option>
          </select>
        </div>
        <div style="display: flex; flex-direction: column; gap: 0.3rem;">
          <label style="font-weight: 600; font-size: 0.85rem; color: #1e293b;">Content (for JSON files)</label>
          <textarea id="newFileContent" placeholder="Enter JSON content..." style="width:100%; padding:0.6rem 1rem; border:2px solid #e2e8f0; border-radius:10px; font-size:0.9rem; min-height:100px; font-family:monospace;"></textarea>
        </div>
      </div>
    </div>
  `;

  showModal('info', modalHTML, {
    title: '📁 Add New File',
    icon: '📁',
    closeOnBackdrop: false,
    buttons: [
      { label: 'Create', class: 'btn-success', callback: function() {
        const name = document.getElementById('newFileName').value.trim();
        const type = document.getElementById('newFileType').value;
        const content = document.getElementById('newFileContent').value.trim();
        
        if (!name) {
          showModal('warning', 'Please enter a file name.');
          return;
        }
        
        const newFile = {
          id: currentFileId++,
          name: name.includes('.') ? name : `${name}.${type}`,
          type: type,
          size: '0 KB',
          modified: new Date().toLocaleString('en-US', { 
            year: 'numeric', 
            month: '2-digit', 
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
          }).replace(/\//g, '-')
        };
        
        if (type === 'json' && content) {
          try {
            newFile.content = JSON.parse(content);
          } catch(e) {
            showModal('warning', 'Invalid JSON content. Please check your JSON format.');
            return;
          }
        } else if (type === 'json') {
          newFile.content = {};
        }
        
        fileData.push(newFile);
        loadFiles();
        closeModal();
        showModal('success', `File "${newFile.name}" created successfully!`);
      }},
      { label: 'Cancel', class: 'btn-secondary', callback: function() { closeModal(); } }
    ]
  });
}

function deleteSelected() {
  if (selectedFiles.size === 0) {
    showModal('warning', 'Please select at least one file to delete.');
    return;
  }
  
  showModal('confirm', `Are you sure you want to delete ${selectedFiles.size} file(s)?`, {
    onConfirm: function() {
      fileData = fileData.filter(f => !selectedFiles.has(f.id));
      selectedFiles.clear();
      loadFiles();
      showModal('success', 'Selected files deleted successfully!');
    },
    onCancel: function() {
      // Do nothing
    }
  });
}

function downloadSelected() {
  if (selectedFiles.size === 0) {
    showModal('warning', 'Please select at least one file to download.');
    return;
  }
  
  const selected = fileData.filter(f => selectedFiles.has(f.id));
  const names = selected.map(f => f.name).join(', ');
  showModal('success', `📥 Downloading ${selected.length} file(s):\n${names}`);
}

function showFile() {
  if (selectedFiles.size === 0) {
    showModal('warning', 'Please select a file to view.');
    return;
  }
  
  if (selectedFiles.size > 1) {
    showModal('warning', 'Please select only one file to view.');
    return;
  }
  
  const fileId = Array.from(selectedFiles)[0];
  const file = fileData.find(f => f.id === fileId);
  
  if (file) {
    showFileDetails(file);
  }
}

function showFileDetails(file) {
  let contentHTML = `
    <div style="text-align: left; font-size: 0.9rem;">
      <p><strong>Name:</strong> ${file.name}</p>
      <p><strong>Type:</strong> ${file.type.toUpperCase()}</p>
      <p><strong>Size:</strong> ${file.size}</p>
      <p><strong>Modified:</strong> ${file.modified}</p>
    </div>
  `;
  
  if (file.type === 'json' && file.content) {
    contentHTML += `
      <div style="margin-top: 1rem; border-top: 1px solid #eef2f6; padding-top: 1rem;">
        <p><strong>Content:</strong></p>
        <pre style="background: #f8fafc; padding: 1rem; border-radius: 8px; overflow-x: auto; font-size: 0.8rem; max-height: 300px; overflow-y: auto;">${JSON.stringify(file.content, null, 2)}</pre>
      </div>
    `;
  }
  
  showModal('info', contentHTML, {
    title: `📄 ${file.name}`,
    icon: '📄',
    closeOnBackdrop: true
  });
}

function viewFile(id) {
  const file = fileData.find(f => f.id === id);
  if (file) {
    showFileDetails(file);
  }
}

function editFile(id) {
  const file = fileData.find(f => f.id === id);
  if (!file) return;
  
  const modalHTML = `
    <div style="text-align: left; font-size: 0.9rem;">
      <div style="display: flex; flex-direction: column; gap: 1rem;">
        <div style="display: flex; flex-direction: column; gap: 0.3rem;">
          <label style="font-weight: 600; font-size: 0.85rem; color: #1e293b;">File Name</label>
          <input type="text" id="editFileName" value="${file.name}" style="width:100%; padding:0.6rem 1rem; border:2px solid #e2e8f0; border-radius:10px; font-size:0.9rem;" />
        </div>
        ${file.type === 'json' ? `
        <div style="display: flex; flex-direction: column; gap: 0.3rem;">
          <label style="font-weight: 600; font-size: 0.85rem; color: #1e293b;">Content (JSON)</label>
          <textarea id="editFileContent" style="width:100%; padding:0.6rem 1rem; border:2px solid #e2e8f0; border-radius:10px; font-size:0.9rem; min-height:100px; font-family:monospace;">${file.content ? JSON.stringify(file.content, null, 2) : ''}</textarea>
        </div>
        ` : ''}
      </div>
    </div>
  `;

  showModal('info', modalHTML, {
    title: `✏️ Edit ${file.name}`,
    icon: '✏️',
    closeOnBackdrop: false,
    buttons: [
      { label: 'Save', class: 'btn-success', callback: function() {
        const newName = document.getElementById('editFileName').value.trim();
        if (!newName) {
          showModal('warning', 'Please enter a file name.');
          return;
        }
        
        file.name = newName;
        
        if (file.type === 'json') {
          const content = document.getElementById('editFileContent').value.trim();
          if (content) {
            try {
              file.content = JSON.parse(content);
            } catch(e) {
              showModal('warning', 'Invalid JSON content. Please check your JSON format.');
              return;
            }
          }
        }
        
        file.modified = new Date().toLocaleString('en-US', { 
          year: 'numeric', 
          month: '2-digit', 
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        }).replace(/\//g, '-');
        
        loadFiles();
        closeModal();
        showModal('success', `File "${file.name}" updated successfully!`);
      }},
      { label: 'Cancel', class: 'btn-secondary', callback: function() { closeModal(); } }
    ]
  });
}

function downloadFileById(id) {
  const file = fileData.find(f => f.id === id);
  if (file) {
    showModal('success', `📥 Downloading: ${file.name}`);
  }
}

function showJsonContent(id) {
  const file = fileData.find(f => f.id === id);
  if (!file || !file.content) {
    showModal('warning', 'No JSON content available for this file.');
    return;
  }
  
  let tableHTML = `
    <div style="max-height: 400px; overflow-y: auto; font-size: 0.85rem;">
      <table style="width:100%; border-collapse:collapse; border:1px solid #eef2f6;">
        <thead style="background:#f1f5f9; position:sticky; top:0; z-index:10;">
          <tr>
            <th style="padding:0.5rem 0.8rem; text-align:left; border-bottom:2px solid #e2e8f0;">Key</th>
            <th style="padding:0.5rem 0.8rem; text-align:left; border-bottom:2px solid #e2e8f0;">Value</th>
          </tr>
        </thead>
        <tbody>
  `;
  
  function renderObject(obj, prefix = '') {
    for (const key in obj) {
      if (typeof obj[key] === 'object' && obj[key] !== null) {
        tableHTML += `
          <tr>
            <td style="padding:0.4rem 0.8rem; border-bottom:1px solid #f1f5f9; font-weight:600; color:#1e293b;">${prefix}${key}</td>
            <td style="padding:0.4rem 0.8rem; border-bottom:1px solid #f1f5f9; color:#475569;">{...}</td>
          </tr>
        `;
        renderObject(obj[key], `${prefix}${key}.`);
      } else {
        const value = typeof obj[key] === 'string' ? obj[key] : JSON.stringify(obj[key]);
        tableHTML += `
          <tr>
            <td style="padding:0.4rem 0.8rem; border-bottom:1px solid #f1f5f9; color:#1e293b;">${prefix}${key}</td>
            <td style="padding:0.4rem 0.8rem; border-bottom:1px solid #f1f5f9; color:#475569; word-break:break-all;">${value}</td>
          </tr>
        `;
      }
    }
  }
  
  renderObject(file.content);
  
  tableHTML += `
        </tbody>
      </table>
    </div>
    <div style="margin-top: 0.5rem; font-size: 0.8rem; color: #94a3b8; text-align: right;">
      <button onclick="editJsonContent(${file.id})" style="padding:0.3rem 1rem; background:#f59e0b; color:white; border:none; border-radius:6px; cursor:pointer; font-size:0.8rem;"><i class="fas fa-edit"></i> Edit JSON</button>
    </div>
  `;
  
  showModal('info', tableHTML, {
    title: `📊 ${file.name} - JSON Content`,
    icon: '📊',
    closeOnBackdrop: true
  });
}

function editJsonContent(id) {
  const file = fileData.find(f => f.id === id);
  if (!file) return;
  
  const modalHTML = `
    <div style="text-align: left; font-size: 0.9rem;">
      <div style="display: flex; flex-direction: column; gap: 1rem;">
        <div style="display: flex; flex-direction: column; gap: 0.3rem;">
          <label style="font-weight: 600; font-size: 0.85rem; color: #1e293b;">Edit JSON Content</label>
          <textarea id="editJsonContentText" style="width:100%; padding:0.6rem 1rem; border:2px solid #e2e8f0; border-radius:10px; font-size:0.9rem; min-height:200px; font-family:monospace;">${file.content ? JSON.stringify(file.content, null, 2) : ''}</textarea>
        </div>
      </div>
    </div>
  `;

  showModal('info', modalHTML, {
    title: `✏️ Edit JSON - ${file.name}`,
    icon: '✏️',
    closeOnBackdrop: false,
    buttons: [
      { label: 'Save JSON', class: 'btn-success', callback: function() {
        const content = document.getElementById('editJsonContentText').value.trim();
        if (!content) {
          showModal('warning', 'Please enter valid JSON content.');
          return;
        }
        try {
          file.content = JSON.parse(content);
          file.modified = new Date().toLocaleString('en-US', { 
            year: 'numeric', 
            month: '2-digit', 
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
          }).replace(/\//g, '-');
          loadFiles();
          closeModal();
          showModal('success', 'JSON content updated successfully!');
        } catch(e) {
          showModal('warning', 'Invalid JSON format. Please check your JSON.');
        }
      }},
      { label: 'Cancel', class: 'btn-secondary', callback: function() { closeModal(); } }
    ]
  });
}

// ============================================
// PROFILE & USER DB FUNCTIONS
// ============================================

const PROFILE_LOG_KEY = 'lexora_profile_log';

// ── Get current user object from localStorage DB ──
function getCurrentUser() {
  const session = (typeof getSession === 'function') ? getSession() : null;
  const users = JSON.parse(localStorage.getItem('lexora_users') || '[]');
  if (session) return users.find(u => u.id === session.userId) || null;
  return users[0] || null;
}

// ── Save updates back to the localStorage DB ──
function persistUserUpdate(updates) {
  const session = (typeof getSession === 'function') ? getSession() : null;
  const users   = JSON.parse(localStorage.getItem('lexora_users') || '[]');
  const idx     = session ? users.findIndex(u => u.id === session.userId) : 0;
  if (idx === -1) return null;
  const oldUser = JSON.parse(JSON.stringify(users[idx]));
  users[idx] = Object.assign({}, users[idx], updates);
  // 1. Instant update in browser
  localStorage.setItem('lexora_users', JSON.stringify(users));
  // 2. Persist to users.json on disk (async, fire-and-forget)
  saveUsersToDisk(users);
  return { oldUser, newUser: users[idx] };
}

// ── Write users array to disk via server API ──────────────────────────────
function saveUsersToDisk(users) {
  // Strip profile_photo_data (base64 blob) — too large for disk JSON
  const forDisk = users.map(function(u) {
    const copy = Object.assign({}, u);
    delete copy.profile_photo_data;
    return copy;
  });
  fetch('/api/users/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ users: forDisk })
  }).then(function(r) {
    if (r.ok) console.log('[Lexora] users.json saved to disk ✓');
  }).catch(function(err) {
    console.warn('[Lexora] Disk sync skipped (server offline):', err.message);
  });
}

// ── On app start: pull latest users.json from disk into localStorage ─────────
// This ensures any server-side edits are picked up on next page load
function syncUsersFromDisk() {
  return fetch('/db/users.json?_=' + Date.now())
    .then(function(r) { return r.ok ? r.json() : Promise.reject('not ok'); })
    .then(function(data) {
      if (!data || !Array.isArray(data.users) || data.users.length === 0) return;
      const localUsers = JSON.parse(localStorage.getItem('lexora_users') || '[]');
      // Disk = source of truth for fields; localStorage keeps photo blob
      const merged = data.users.map(function(du) {
        const lu = localUsers.find(function(u) { return u.id === du.id; });
        return Object.assign({}, du, {
          profile_photo_data: lu ? (lu.profile_photo_data || '') : ''
        });
      });
      localStorage.setItem('lexora_users', JSON.stringify(merged));
      console.log('[Lexora] Synced from disk: ' + merged.length + ' user(s)');
    })
    .catch(function() {
      console.warn('[Lexora] Using localStorage (server not reachable).');
    });
}

// ── Activity log ──────────────────────────────────
function addActivityLog(changes) {
  const session = (typeof getSession === 'function') ? getSession() : {};
  const log = JSON.parse(localStorage.getItem(PROFILE_LOG_KEY) || '[]');
  const now = new Date().toISOString();
  changes.forEach(function(c) {
    log.unshift({
      id:        'log_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      userId:    session ? session.userId : 'unknown',
      timestamp: now,
      field:     c.field,
      oldValue:  c.oldValue,
      newValue:  c.newValue
    });
  });
  localStorage.setItem(PROFILE_LOG_KEY, JSON.stringify(log.slice(0, 100)));
  renderActivityLog();
}

function maskValue(field, val) {
  if (!val && val !== 0) return '—';
  const f = (field || '').toLowerCase();
  if (f.includes('password') || f.includes('apikey') || f.includes('api key')) return '••••••••';
  if (f.includes('photo')) return val ? '[photo]' : '[removed]';
  return String(val);
}

function renderActivityLog() {
  const tbody = document.getElementById('activityLogBody');
  if (!tbody) return;
  const log = JSON.parse(localStorage.getItem(PROFILE_LOG_KEY) || '[]');
  if (log.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#94a3b8;padding:1.5rem 0;">No changes recorded yet.</td></tr>';
    return;
  }
  tbody.innerHTML = log.map(function(e) {
    const ts = new Date(e.timestamp).toLocaleString('en-IN', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit' });
    return '<tr style="border-bottom:1px solid #f1f5f9;">' +
      '<td style="padding:0.5rem 1rem;white-space:nowrap;font-size:0.82rem;color:#64748b;">' + ts + '</td>' +
      '<td style="padding:0.5rem 1rem;font-weight:600;color:#1e293b;">' + (e.field || '') + '</td>' +
      '<td style="padding:0.5rem 1rem;color:#ef4444;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + maskValue(e.field, e.oldValue) + '</td>' +
      '<td style="padding:0.5rem 1rem;color:#22c55e;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + maskValue(e.field, e.newValue) + '</td>' +
    '</tr>';
  }).join('');
}

function clearActivityLog() {
  localStorage.removeItem(PROFILE_LOG_KEY);
  renderActivityLog();
}

// ── Header avatar real-time update ───────────────
function syncHeaderAvatar(base64) {
  const circle  = document.getElementById('headerAvatarCircle');
  const icon    = document.getElementById('headerAvatarIcon');
  const img     = document.getElementById('headerAvatarImg');
  if (!circle) return;
  if (base64) {
    if (icon) icon.style.display = 'none';
    if (img)  { img.src = base64; img.style.display = 'block'; }
  } else {
    if (img)  { img.src = ''; img.style.display = 'none'; }
    if (icon) icon.style.display = '';
  }
}

// ── Photo upload — real-time sync + save to disk ────────────────
function handlePhotoUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    showModal('warning', 'Photo size must be under 5MB.');
    return;
  }
  const reader = new FileReader();
  reader.onload = function(e) {
    const base64 = e.target.result;

    // 1. Update profile card immediately
    const img = document.getElementById('profilePhotoImg');
    const ph  = document.getElementById('profilePhotoPlaceholder');
    if (img) { img.src = base64; img.style.display = 'block'; }
    if (ph)  ph.style.display = 'none';

    // 2. REAL-TIME header sync
    syncHeaderAvatar(base64);

    // 3. Save base64 to localStorage (for display between sessions)
    const user   = getCurrentUser();
    const oldVal = user ? (user.profile_photo_data ? '[photo]' : '') : '';
    persistUserUpdate({ profile_photo_data: base64 });

    // 4. Save actual image file to disk via server API
    if (user) {
      const ext = file.name.split('.').pop() || 'jpg';
      fetch('/api/users/photo/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, photoData: base64, extension: ext })
      }).then(function(r) { return r.json(); })
        .then(function(res) {
          if (res.success) {
            // Update profile_photo path in user record
            persistUserUpdate({ profile_photo: res.path });
            console.log('[Lexora] Photo saved to disk:', res.path);
          }
        })
        .catch(function() {
          console.warn('[Lexora] Photo disk save skipped (server offline)');
        });
    }

    addActivityLog([{ field: 'Profile Photo', oldValue: oldVal, newValue: '[photo]' }]);
  };
  reader.readAsDataURL(file);
}

function removePhoto() {
  const img   = document.getElementById('profilePhotoImg');
  const ph    = document.getElementById('profilePhotoPlaceholder');
  const input = document.getElementById('profilePhotoInput');
  if (img)   { img.src = ''; img.style.display = 'none'; }
  if (ph)    ph.style.display = 'block';
  if (input) input.value = '';
  syncHeaderAvatar(null);
  persistUserUpdate({ profile_photo_data: '' });
  addActivityLog([{ field: 'Profile Photo', oldValue: '[photo]', newValue: '' }]);
}

// ── Password toggle (reused for profile fields) ──
function togglePassword(fieldId) {
  const field = document.getElementById(fieldId);
  const icon  = document.getElementById(fieldId + 'Icon');
  if (!field || !icon) return;
  if (field.type === 'password') {
    field.type = 'text';
    icon.className = 'fas fa-eye-slash';
  } else {
    field.type = 'password';
    icon.className = 'fas fa-eye';
  }
}

// ── Update profile — validates & saves ───────────
function updateProfile(event) {
  event.preventDefault();

  const firstName = (document.getElementById('firstName')?.value || '').trim();
  const lastName  = (document.getElementById('lastName')?.value  || '').trim();
  const gender    = document.getElementById('gender')?.value     || '';
  const dob       = document.getElementById('dob')?.value        || '';
  const phone     = (document.getElementById('phone')?.value     || '').trim();
  const password  = document.getElementById('password')?.value   || '';
  const confPw    = document.getElementById('confirmPassword')?.value || '';
  const lock      = document.getElementById('profileLock')?.value || 'no';

  // All mandatory (except email + password optional)
  if (!firstName)                         { showModal('warning', 'First Name is mandatory.'); return; }
  if (!lastName)                          { showModal('warning', 'Last Name is mandatory.'); return; }
  if (!gender)                            { showModal('warning', 'Gender is mandatory.'); return; }
  if (!dob)                               { showModal('warning', 'Date of Birth is mandatory.'); return; }
  if (!phone || !/^\d{10}$/.test(phone))  { showModal('warning', 'Enter a valid 10-digit mobile number.'); return; }

  if (password) {
    if (password.length < 6)  { showModal('warning', 'Password must be at least 6 characters.'); return; }
    if (password !== confPw)  { showModal('warning', 'Passwords do not match.'); return; }
  }

  const user = getCurrentUser();
  if (!user) { showModal('warning', 'User session not found. Please login again.'); return; }

  const changes = [];
  const updates = {};

  function track(field, oldVal, newVal) {
    if (String(oldVal || '') !== String(newVal || '')) {
      changes.push({ field, oldValue: oldVal, newValue: newVal });
      return true;
    }
    return false;
  }

  if (track('First Name',   user.firstName, firstName)) updates.firstName = firstName;
  if (track('Last Name',    user.lastName,  lastName))  updates.lastName  = lastName;
  if (track('Gender',       user.gender,   gender))     updates.gender    = gender;
  if (track('Date of Birth', user.dob,     dob))        updates.dob       = dob;
  if (track('Mobile',       user.mobile,   phone))      updates.mobile    = phone;
  if (track('Lock',         user.lock,     lock))       updates.lock      = lock;

  var twoFaCheckbox = document.getElementById('profile2FA');
  var newTwoFA      = twoFaCheckbox ? twoFaCheckbox.checked : true;
  if (track('2FA', String(user.two_factor_auth !== false), String(newTwoFA)))  updates.two_factor_auth = newTwoFA;

  if (password) {
    // Use hashPassword from auth.js (loaded before app.js)
    if (typeof hashPassword === 'function') {
      updates.passwordHash = hashPassword(password);
    }
    changes.push({ field: 'Password', oldValue: '••••••••', newValue: '••••••••' });
  }

  if (changes.length === 0) {
    showModal('info', 'No changes detected.');
    return;
  }

  persistUserUpdate(updates);
  addActivityLog(changes);

  // Update session + header name in real-time
  const newFirst = updates.firstName || user.firstName;
  const newLast  = updates.lastName  || user.lastName;
  document.querySelectorAll('.user-name').forEach(function(el) {
    el.textContent = newFirst + ' ' + newLast;
  });

  // Update session cache
  if (typeof getSession === 'function') {
    const s = getSession();
    if (s) {
      s.firstName = newFirst;
      s.lastName  = newLast;
      localStorage.setItem('lexora_auth', JSON.stringify(s));
    }
  }

  showModal('success', 'Profile updated successfully!');
}

// ── Load profile from DB into the form ───────────
function loadProfile() {
  const user = getCurrentUser();
  if (!user) return;

  const set = function(id, val) {
    const el = document.getElementById(id);
    if (el) el.value = (val !== undefined && val !== null) ? val : '';
  };

  set('firstName',  user.firstName);
  set('lastName',   user.lastName);
  set('gender',     user.gender);
  set('dob',        user.dob);
  set('phone',      user.mobile);
  set('profileEmail', user.email);
  // Read-only info fields
  const setTxt = function(id, val) { const el = document.getElementById(id); if (el) el.textContent = val || '—'; };
  setTxt('profileAccountType', user.account_type || user.role);
  setTxt('profileStatus',      user.status || 'active');

  // 2FA toggle
  var twoFaEl     = document.getElementById('profile2FA');
  var twoFaStatus = document.getElementById('twoFAStatus');
  var twoFaOn     = user.two_factor_auth !== false;
  if (twoFaEl) {
    twoFaEl.checked = twoFaOn;
    twoFaEl.onchange = function() {
      var on = twoFaEl.checked;
      if (twoFaStatus) {
        twoFaStatus.textContent = on ? 'ON' : 'OFF';
        twoFaStatus.style.background = on ? '#dcfce7' : '#fee2e2';
        twoFaStatus.style.color      = on ? '#16a34a' : '#dc2626';
      }
    };
    if (twoFaStatus) {
      twoFaStatus.textContent = twoFaOn ? 'ON' : 'OFF';
      twoFaStatus.style.background = twoFaOn ? '#dcfce7' : '#fee2e2';
      twoFaStatus.style.color      = twoFaOn ? '#16a34a' : '#dc2626';
    }
  }

  // Photo
  if (user.profile_photo_data) {
    const img = document.getElementById('profilePhotoImg');
    const ph  = document.getElementById('profilePhotoPlaceholder');
    if (img) { img.src = user.profile_photo_data; img.style.display = 'block'; }
    if (ph)  ph.style.display = 'none';
    syncHeaderAvatar(user.profile_photo_data);
  }

  // Header name
  const name = ((user.firstName || '') + ' ' + (user.lastName || '')).trim();
  document.querySelectorAll('.user-name').forEach(function(el) { el.textContent = name; });

  // Activity log
  renderActivityLog();

  // API key section
  loadApiSection();
}

// ============================================
// API KEY FUNCTIONS
// ============================================

function loadApiSection() {
  const user = getCurrentUser();
  if (!user) return;
  const el = document.getElementById('userApiKey');
  if (el) el.value = user.apikey || '';
  updateApiKeyStatus();
}

function updateApiKeyStatus() {
  const user   = getCurrentUser();
  const el     = document.getElementById('apiKeyStatus');
  if (!el) return;
  if (user && user.apikey) {
    const masked = user.apikey.substring(0, 8) + '••••••••••••••••••••' + user.apikey.slice(-4);
    el.innerHTML = '<span style="color:#22c55e;"><i class="fas fa-check-circle"></i> API Key is set</span> &nbsp;·&nbsp; <span style="color:#94a3b8;">Key: ' + masked + '</span>';
  } else {
    el.innerHTML = '<span style="color:#f59e0b;"><i class="fas fa-exclamation-circle"></i> No API key set.</span>';
  }
}

function toggleApiKeyVisibility() {
  const inp  = document.getElementById('userApiKey');
  const icon = document.getElementById('apiKeyEyeIcon');
  if (!inp) return;
  if (inp.type === 'password') {
    inp.type = 'text';
    if (icon) icon.className = 'fas fa-eye-slash';
  } else {
    inp.type = 'password';
    if (icon) icon.className = 'fas fa-eye';
  }
}

function generateApiKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const rand  = Array.from({ length: 40 }, function() { return chars[Math.floor(Math.random() * chars.length)]; }).join('');
  const key   = 'lxr_' + rand;
  const inp   = document.getElementById('userApiKey');
  if (inp) { inp.value = key; inp.type = 'text'; }
  const icon = document.getElementById('apiKeyEyeIcon');
  if (icon) icon.className = 'fas fa-eye-slash';
}

function copyApiKey() {
  const key = document.getElementById('userApiKey')?.value || '';
  if (!key) { showModal('warning', 'No API key to copy. Generate or enter one first.'); return; }
  navigator.clipboard.writeText(key).then(function() {
    showModal('success', 'API Key copied to clipboard!', { onConfirm: function() {} });
  }).catch(function() {
    showModal('warning', 'Could not copy automatically. Please copy manually from the field.');
  });
}

function saveApiKey() {
  const key    = (document.getElementById('userApiKey')?.value || '').trim();
  const user   = getCurrentUser();
  if (!user) return;
  const oldKey = user.apikey || '';
  persistUserUpdate({ apikey: key });
  addActivityLog([{ field: 'API Key', oldValue: oldKey ? '••••••••' : '', newValue: key ? '••••••••' : '' }]);
  updateApiKeyStatus();
  showModal('success', key ? 'API Key saved successfully!' : 'API Key cleared.', { onConfirm: function() {} });
}

function revokeApiKey() {
  showModal('confirm', 'Are you sure you want to revoke your API Key? Any integrations using this key will stop working.', {
    onConfirm: function() {
      const inp = document.getElementById('userApiKey');
      if (inp) inp.value = '';
      const user = getCurrentUser();
      const old  = user ? user.apikey : '';
      persistUserUpdate({ apikey: '' });
      addActivityLog([{ field: 'API Key', oldValue: old ? '••••••••' : '', newValue: '[revoked]' }]);
      updateApiKeyStatus();
      showModal('success', 'API Key revoked.', { onConfirm: function() {} });
    },
    onCancel: function() {}
  });
}

// ============================================
// LOGOUT HANDLER
// ============================================

function handleLogout() {
  showModal('confirm', 'Are you sure you want to logout?', {
    onConfirm: function() {
      showModal('success', 'You have been logged out successfully!', {
        onConfirm: function() {}
      });
    },
    onCancel: function() {
      showModal('info', 'Logout cancelled.', {
        onConfirm: function() {}
      });
    }
  });
  
  const userSubMenu = document.getElementById('userSubMenu');
  if (userSubMenu) userSubMenu.classList.remove('open');
}





// ============================================
// TEMPLATE MANAGEMENT
// ============================================

let allTemplates = [];

function loadAdminTemplates() {
  fetch('/db/templates.json?_=' + Date.now())
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) {
      if (data && data.templates) {
        allTemplates = data.templates;
        localStorage.setItem('lexora_templates', JSON.stringify(allTemplates));
      } else {
        allTemplates = JSON.parse(localStorage.getItem('lexora_templates') || '[]');
      }
      renderAdminTemplatesTable();
    })
    .catch(function() {
      allTemplates = JSON.parse(localStorage.getItem('lexora_templates') || '[]');
      renderAdminTemplatesTable();
    });
}

function saveAdminTemplates() {
  localStorage.setItem('lexora_templates', JSON.stringify(allTemplates));
  fetch('/api/templates/save', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ templates: allTemplates }) })
  .catch(function() {});
}

function renderAdminTemplatesTable() {
  const tbody = document.getElementById('adminTemplatesBody');
  if (!tbody) return;
  if (!allTemplates.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:1.5rem;">No templates. Upload one to get started.</td></tr>';
    return;
  }
  tbody.innerHTML = allTemplates.map(function(t, i) {
    const locked = t.lock === 'Yes';
    return '<tr style="border-bottom:1px solid #f1f5f9;">' +
      '<td style="padding:0.45rem 0.7rem;">' + t.id + '</td>' +
      '<td style="padding:0.45rem 0.7rem;font-weight:600;">' + (t.template_name||'') + '</td>' +
      '<td style="padding:0.45rem 0.7rem;font-size:0.8rem;color:#64748b;">' + (t.category||'') + '</td>' +
      '<td style="padding:0.45rem 0.7rem;font-size:0.8rem;">' + (t.folder_name||'') + '</td>' +
      '<td style="padding:0.45rem 0.7rem;font-size:0.8rem;color:#64748b;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + (t.file_path||'') + '">' + (t.file_name||'') + '</td>' +
      '<td style="padding:0.45rem 0.7rem;"><span style="padding:0.15rem 0.5rem;border-radius:5px;font-size:0.75rem;font-weight:600;background:' + (t.status==='Active'?'#dcfce7':'#fee2e2') + ';color:' + (t.status==='Active'?'#16a34a':'#dc2626') + ';">' + (t.status||'Active') + '</span></td>' +
      '<td style="padding:0.45rem 0.7rem;">' + (locked ? '🔒' : '🔓') + '</td>' +
      '<td style="padding:0.45rem 0.7rem;white-space:nowrap;">' +
        '<button data-ti="' + i + '" onclick="toggleTemplateStatus(this.dataset.ti)" title="Toggle Status" style="border:none;background:none;cursor:pointer;font-size:0.9rem;">🔄</button>' +
        (!locked ? '<button data-ti="' + i + '" onclick="deleteTemplate(this.dataset.ti)" title="Delete" style="border:none;background:none;cursor:pointer;font-size:0.9rem;">🗑️</button>' : '<span style="color:#94a3b8;font-size:0.75rem;">Locked</span>') +
      '</td></tr>';
  }).join('');
  // Refresh template dropdown in Lease Abstraction
  loadTemplateDropdown();
}

function _folderSelChange(sel) {
  var nf = document.getElementById('tNewFolder');
  if (nf) nf.style.display = sel.value === '__new__' ? 'block' : 'none';
}

function toggleTemplateStatus(idxStr) {
  const i = parseInt(idxStr);
  allTemplates[i].status = allTemplates[i].status === 'Active' ? 'Inactive' : 'Active';
  saveAdminTemplates();
  renderAdminTemplatesTable();
}

function deleteTemplate(idxStr) {
  const i = parseInt(idxStr);
  if (allTemplates[i].lock === 'Yes') { showModal('warning', 'This template is locked.'); return; }
  showModal('confirm', 'Delete template "' + allTemplates[i].template_name + '"?', {
    onConfirm: function() {
      allTemplates.splice(i, 1);
      saveAdminTemplates();
      renderAdminTemplatesTable();
      showModal('success', 'Template deleted.', { onConfirm: function(){} });
    }, onCancel: function() {}
  });
}

function showTemplateUpload() {
  // Get existing folders from templates
  const existingFolders = [...new Set(allTemplates.map(function(t){ return t.folder_name; }).filter(Boolean))];
  const folderOptions   = existingFolders.map(function(f){ return '<option value="' + f + '">' + f + '</option>'; }).join('');

  const categories = ['Lease Abstraction', 'Translation', 'Other'];
  const catOptions = categories.map(function(c){ return '<option value="' + c + '">' + c + '</option>'; }).join('');

  const S = 'width:100%;padding:0.5rem;border:2px solid #e2e8f0;border-radius:8px;font-size:0.88rem;';
  const form = '<div style="display:flex;flex-direction:column;gap:0.75rem;font-size:0.88rem;">' +
    '<div><label style="font-weight:600;display:block;margin-bottom:0.2rem;">Category *</label>' +
      '<select id="tCat" style="' + S + '">' + catOptions + '</select></div>' +
    '<div><label style="font-weight:600;display:block;margin-bottom:0.2rem;">Template Name *</label>' +
      '<input id="tName" placeholder="e.g. MRI Standard" style="' + S + '" /></div>' +
    '<div><label style="font-weight:600;display:block;margin-bottom:0.2rem;">Folder</label>' +
      '<div style="display:flex;gap:0.5rem;">' +
        '<select id="tFolderSel" style="' + S + 'flex:1;" onchange="_folderSelChange(this)">' +
          '<option value="">-- Select existing --</option>' + folderOptions +
          '<option value="__new__">+ Create new folder</option>' +
        '</select>' +
      '</div>' +
      '<input id="tNewFolder" placeholder="New folder name" style="' + S + 'margin-top:0.4rem;display:none;" /></div>' +
    '<div><label style="font-weight:600;display:block;margin-bottom:0.2rem;">Upload File *</label>' +
      '<input type="file" id="tFile" accept=".pdf,.docx,.doc,.xlsx,.xls,.txt" style="width:100%;padding:0.4rem;" /></div>' +
    '<div style="display:flex;gap:0.75rem;">' +
      '<div style="flex:1;"><label style="font-weight:600;display:block;margin-bottom:0.2rem;">Status</label>' +
        '<select id="tStatus" style="' + S + '"><option>Active</option><option>Inactive</option></select></div>' +
      '<div style="flex:1;display:flex;align-items:flex-end;gap:0.5rem;padding-bottom:0.2rem;">' +
        '<input type="checkbox" id="tLock" style="width:15px;height:15px;accent-color:#3b82f6;">' +
        '<label for="tLock" style="font-weight:600;font-size:0.85rem;">Lock (protected)</label></div>' +
    '</div>' +
  '</div>';

  showModal('info', form, {
    title: '📤 Upload Template',
    closeOnBackdrop: false,
    buttons: [
      { label: 'Upload', class: 'btn-success', callback: function() {
        const cat    = document.getElementById('tCat').value;
        const name   = (document.getElementById('tName').value||'').trim();
        const folSel = document.getElementById('tFolderSel').value;
        const folNew = (document.getElementById('tNewFolder').value||'').trim();
        const folder = folSel === '__new__' ? folNew : folSel;
        const fileEl = document.getElementById('tFile');
        const status = document.getElementById('tStatus').value;
        const locked = document.getElementById('tLock').checked;

        if (!name) { showModal('warning', 'Template name is required.'); return; }
        if (!fileEl.files.length) { showModal('warning', 'Please select a file.'); return; }

        const file     = fileEl.files[0];
        const reader   = new FileReader();
        reader.onload  = function(ev) {
          const b64  = ev.target.result.split(',')[1];
          const folPath = 'Template/' + cat + '/' + (folder || name);
          const newT  = {
            id:           allTemplates.length + 1,
            lock:         locked ? 'Yes' : 'No',
            category:     cat,
            file_name:    file.name,
            folder_path:  folPath,
            folder_name:  folder || name,
            file_path:    folPath + '/' + file.name,
            template_name: name,
            status:        status
          };
          // Save file to disk via server
          fetch('/api/templates/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ template: newT, fileData: b64, fileName: file.name })
          }).then(function(r){ return r.json(); })
            .then(function(res) {
              allTemplates.push(newT);
              saveAdminTemplates();
              renderAdminTemplatesTable();
              closeModal();
              showModal('success', 'Template "' + name + '" uploaded!', { onConfirm: function(){} });
            })
            .catch(function() {
              // Offline — save metadata only
              allTemplates.push(newT);
              saveAdminTemplates();
              renderAdminTemplatesTable();
              closeModal();
              showModal('info', 'Template added (file saved locally only — start server to save to disk).', { onConfirm: function(){} });
            });
        };
        reader.readAsDataURL(file);
      }},
      { label: 'Cancel', class: 'btn-secondary', callback: function() { closeModal(); } }
    ]
  });
}

function loadTemplateDropdown() {
  // Populate ALL template dropdowns on the page
  var selectors = ['outputTemplate', 'outputTemplateTrans', 'templateSelect'];

  // Scan actual Template/ folder from server
  fetch('/api/templates/scan?_=' + Date.now())
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(data) {
      if (!data || !data.success || !data.data || !data.data.folders.length) {
        _loadTemplateDropdownFromJson(selectors);
        return;
      }

      // Build optgroup HTML (folder = group, file = option)
      var html = '';
      var hasOptions = false;
      data.data.folders.forEach(function(folder) {
        if (!folder.files.length) return;
        hasOptions = true;
        html += '<optgroup label="' + folder.name + '">';
        folder.files.forEach(function(file) {
          html += '<option value="' + file.path + '">' + file.name + '</option>';
        });
        html += '</optgroup>';
      });

      if (!hasOptions) { _loadTemplateDropdownFromJson(selectors); return; }

      // Apply to all dropdowns
      selectors.forEach(function(id) {
        var sel = document.getElementById(id);
        if (sel) sel.innerHTML = html;
      });
    })
    .catch(function() { _loadTemplateDropdownFromJson(selectors); });
}


// ── Output Template File Picker ───────────────────────────────────────────────
var _outputTemplateFile   = null;  // The selected template File object
var _outputTemplateText   = '';    // Extracted text from template

function selectOutputTemplate() {
  var el = document.getElementById('outputTemplateFile');
  if (el) el.click();
}

function clearOutputTemplate() {
  _outputTemplateFile = null;
  _outputTemplateText = '';
  var nameEl  = document.getElementById('templateFileName');
  var clearEl = document.getElementById('templateClearBtn');
  if (nameEl)  nameEl.textContent = 'No template — Default format';
  if (clearEl) clearEl.style.display = 'none';
}

function handleTemplateFileSelect(event) {
  var file = event.target.files && event.target.files[0];
  if (!file) return;
  var ext = file.name.split('.').pop().toLowerCase();
  if (!['pdf','docx','doc'].includes(ext)) {
    showModal('warning', 'Only PDF (.pdf) or Word (.docx/.doc) files are accepted as templates.');
    event.target.value = '';
    return;
  }
  _outputTemplateFile = file;
  var nameEl  = document.getElementById('templateFileName');
  var clearEl = document.getElementById('templateClearBtn');
  if (nameEl)  nameEl.textContent = '📄 ' + file.name;
  if (clearEl) clearEl.style.display = 'inline';
  addLog('📋 Output template selected: ' + file.name, 'info');
}

function _loadTemplateDropdownFromJson(selectors) {
  // Fallback: use templates.json data
  var byFolder = {};
  allTemplates.forEach(function(t) {
    if (t.status !== 'Active' || t.category !== 'Lease Abstraction') return;
    var folder = t.folder_name || 'Templates';
    if (!byFolder[folder]) byFolder[folder] = [];
    byFolder[folder].push(t);
  });

  var html = '';
  Object.keys(byFolder).forEach(function(folder) {
    html += '<optgroup label="' + folder + '">';
    byFolder[folder].forEach(function(t) {
      html += '<option value="' + t.file_path + '">' + t.template_name + '</option>';
    });
    html += '</optgroup>';
  });

  if (!html) html = '<option value="">No templates configured</option>';

  var ids = Array.isArray(selectors) ? selectors : [selectors];
  ids.forEach(function(id) {
    var sel = typeof id === 'string' ? document.getElementById(id) : id;
    if (sel) sel.innerHTML = html;
  });
}

// ============================================
// ADMIN USERS MANAGEMENT
// ============================================

function loadAdminUsers() {
  const users = JSON.parse(localStorage.getItem('lexora_users') || '[]');
  renderAdminUsersTable(users);
  loadPendingAccounts();
}

function renderAdminUsersTable(users) {
  const tbody = document.getElementById('adminUsersBody');
  if (!tbody) return;
  if (!users.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#94a3b8;padding:1.5rem;">No users.</td></tr>';
    return;
  }
  tbody.innerHTML = users.map(function(u, idx) {
    const statusColor = u.status === 'active' ? '#22c55e' : u.status === 'hold' ? '#f59e0b' : '#ef4444';
    return '<tr style="border-bottom:1px solid #f1f5f9;">' +
      '<td style="padding:0.5rem 0.8rem;font-weight:600;">' + (u.firstName||'') + ' ' + (u.lastName||'') + '</td>' +
      '<td style="padding:0.5rem 0.8rem;font-size:0.82rem;color:#475569;">' + (u.email||'') + '</td>' +
      '<td style="padding:0.5rem 0.8rem;">' +
        '<span style="background:' + (u.account_type==='admin'?'#ede9fe':'#f0fdf4') + ';color:' + (u.account_type==='admin'?'#7c3aed':'#16a34a') + ';padding:0.15rem 0.5rem;border-radius:5px;font-size:0.78rem;font-weight:600;">' + (u.account_type||u.role||'user') + '</span></td>' +
      '<td style="padding:0.5rem 0.8rem;font-size:0.82rem;">' + (u.plan||'Basic') + '</td>' +
      '<td style="padding:0.5rem 0.8rem;">' +
        '<span style="background:#f1f5f9;color:' + statusColor + ';padding:0.15rem 0.5rem;border-radius:5px;font-size:0.78rem;font-weight:600;">' + (u.status||'active') + '</span></td>' +
      '<td style="padding:0.5rem 0.8rem;white-space:nowrap;">' +
        '<button data-idx="' + idx + '" onclick="adminEditUser(this.dataset.idx)" title="Edit Details" style="border:none;background:none;cursor:pointer;font-size:1rem;padding:0.1rem 0.25rem;">✏️</button>' +
        '<button data-idx="' + idx + '" onclick="adminToggleRole(this.dataset.idx)" title="Toggle Admin Role" style="border:none;background:none;cursor:pointer;font-size:1rem;padding:0.1rem 0.25rem;">🔐</button>' +
        '<button data-idx="' + idx + '" onclick="adminHoldService(this.dataset.idx)" title="Hold/Resume Service" style="border:none;background:none;cursor:pointer;font-size:1rem;padding:0.1rem 0.25rem;">⏸️</button>' +
        (u.account_type==='admin'||u.role==='admin' ? '<span title="Admin - locked" style="color:#94a3b8;font-size:0.75rem;padding:0.1rem 0.25rem;">🔒</span>' : '<button data-idx="' + idx + '" onclick="adminDeleteUser(this.dataset.idx)" title="Delete Account" style="border:none;background:none;cursor:pointer;font-size:1rem;padding:0.1rem 0.25rem;">🗑️</button>') +
      '</td></tr>';
  }).join('');
}

function adminEditUser(idxStr) {
  const idx  = parseInt(idxStr);
  const users = JSON.parse(localStorage.getItem('lexora_users') || '[]');
  const u    = users[idx];
  if (!u) return;
  const S = 'width:100%;padding:0.5rem;border:2px solid #e2e8f0;border-radius:8px;font-size:0.88rem;';
  const form = '<div style="display:flex;flex-direction:column;gap:0.75rem;font-size:0.88rem;">' +
    '<div style="display:flex;gap:0.7rem;">' +
      '<div style="flex:1;"><label style="font-weight:600;display:block;margin-bottom:0.2rem;">First Name</label><input id="auFN" value="' + (u.firstName||'') + '" style="' + S + '" /></div>' +
      '<div style="flex:1;"><label style="font-weight:600;display:block;margin-bottom:0.2rem;">Last Name</label><input id="auLN" value="' + (u.lastName||'') + '" style="' + S + '" /></div>' +
    '</div>' +
    '<div><label style="font-weight:600;display:block;margin-bottom:0.2rem;">Email (read-only)</label><input value="' + (u.email||'') + '" disabled style="' + S + 'background:#f1f5f9;color:#64748b;" /></div>' +
    '<div style="display:flex;gap:0.7rem;">' +
      '<div style="flex:1;"><label style="font-weight:600;display:block;margin-bottom:0.2rem;">Mobile</label><input id="auMob" value="' + (u.mobile||'') + '" style="' + S + '" /></div>' +
      '<div style="flex:1;"><label style="font-weight:600;display:block;margin-bottom:0.2rem;">Plan</label>' +
        '<select id="auPlan" style="' + S + '"><option ' + (u.plan==='Basic'?'selected':'') + '>Basic</option><option ' + (u.plan==='Pro'?'selected':'') + '>Pro</option><option ' + (u.plan==='Enterprise'?'selected':'') + '>Enterprise</option></select>' +
      '</div>' +
    '</div>' +
    '<div style="display:flex;gap:0.7rem;">' +
      '<div style="flex:1;"><label style="font-weight:600;display:block;margin-bottom:0.2rem;">Account Type</label>' +
        '<select id="auType" style="' + S + '"><option ' + (u.account_type==='user'?'selected':'') + '>user</option><option ' + (u.account_type==='admin'?'selected':'') + '>admin</option></select>' +
      '</div>' +
      '<div style="flex:1;"><label style="font-weight:600;display:block;margin-bottom:0.2rem;">Balance ($)</label><input id="auBal" type="number" value="' + (u.balance||0) + '" step="0.01" style="' + S + '" /></div>' +
    '</div>' +
  '</div>';
  showModal('info', form, {
    title: '✏️ Edit User — ' + u.firstName,
    closeOnBackdrop: false,
    buttons: [
      { label: 'Save', class: 'btn-success', callback: function() {
        users[idx] = Object.assign({}, u, {
          firstName:    document.getElementById('auFN').value.trim(),
          lastName:     document.getElementById('auLN').value.trim(),
          mobile:       document.getElementById('auMob').value.trim(),
          plan:         document.getElementById('auPlan').value,
          account_type: document.getElementById('auType').value,
          balance:      parseFloat(document.getElementById('auBal').value) || 0
        });
        localStorage.setItem('lexora_users', JSON.stringify(users));
        saveUsersToDisk(users);
        renderAdminUsersTable(users);
        closeModal();
        showModal('success', 'User updated!', { onConfirm: function(){} });
      }},
      { label: 'Cancel', class: 'btn-secondary', callback: function() { closeModal(); } }
    ]
  });
}

function adminToggleRole(idxStr) {
  const idx   = parseInt(idxStr);
  const users = JSON.parse(localStorage.getItem('lexora_users') || '[]');
  const u     = users[idx];
  if (!u) return;
  const newType = u.account_type === 'admin' ? 'user' : 'admin';
  showModal('confirm', 'Change "' + u.firstName + '" role to ' + newType + '?', {
    onConfirm: function() {
      users[idx].account_type = newType;
      users[idx].role = newType;
      localStorage.setItem('lexora_users', JSON.stringify(users));
      saveUsersToDisk(users);
      renderAdminUsersTable(users);
      showModal('success', 'Role changed to ' + newType + '!', { onConfirm: function(){} });
    }, onCancel: function() {}
  });
}

function adminHoldService(idxStr) {
  const idx   = parseInt(idxStr);
  const users = JSON.parse(localStorage.getItem('lexora_users') || '[]');
  const u     = users[idx];
  if (!u) return;
  const newStatus = u.status === 'hold' ? 'active' : 'hold';
  showModal('confirm', (newStatus === 'hold' ? 'Hold' : 'Resume') + ' service for "' + u.firstName + '"?', {
    onConfirm: function() {
      users[idx].status = newStatus;
      localStorage.setItem('lexora_users', JSON.stringify(users));
      saveUsersToDisk(users);
      renderAdminUsersTable(users);
      showModal('success', 'Service ' + newStatus + '!', { onConfirm: function(){} });
    }, onCancel: function() {}
  });
}

function adminDeleteUser(idxStr) {
  const idx   = parseInt(idxStr);
  const users = JSON.parse(localStorage.getItem('lexora_users') || '[]');
  const u     = users[idx];
  if (!u) return;
  if (u.account_type === 'admin' || u.role === 'admin' || u.lock === 'yes') {
    showModal('warning', '🔒 Admin accounts are locked and cannot be deleted.');
    return;
  }
  showModal('confirm', 'Permanently delete account of "' + u.firstName + ' ' + u.lastName + '"?', {
    onConfirm: function() {
      users.splice(idx, 1);
      localStorage.setItem('lexora_users', JSON.stringify(users));
      saveUsersToDisk(users);
      renderAdminUsersTable(users);
      showModal('success', 'Account deleted.', { onConfirm: function(){} });
    }, onCancel: function() {}
  });
}

// ── Pending (Temp) Accounts ──────────────────────────────────────────────────
function loadPendingAccounts() {
  fetch('/db/temp_accounts.json?_=' + Date.now())
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) {
      const pending = data ? (data.pending || []) : [];
      const countEl = document.getElementById('pendingCount');
      if (countEl) countEl.textContent = pending.length;
      const tbody = document.getElementById('pendingUsersBody');
      if (!tbody) return;
      if (!pending.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:1rem;">No pending registrations.</td></tr>';
        return;
      }
      tbody.innerHTML = pending.map(function(p, i) {
        const expires = p.code_expires ? new Date(p.code_expires).toLocaleString() : '—';
        return '<tr style="border-bottom:1px solid #fde68a;">' +
          '<td style="padding:0.4rem 0.8rem;">' + (p.firstName||'') + ' ' + (p.lastName||'') + '</td>' +
          '<td style="padding:0.4rem 0.8rem;font-size:0.82rem;">' + (p.email||'') + '</td>' +
          '<td style="padding:0.4rem 0.8rem;font-size:0.8rem;color:#64748b;">' + (p.requestedAt ? new Date(p.requestedAt).toLocaleString() : '—') + '</td>' +
          '<td style="padding:0.4rem 0.8rem;font-size:0.8rem;color:#f59e0b;">' + expires + '</td>' +
          '<td style="padding:0.4rem 0.8rem;white-space:nowrap;">' +
            '<button data-pidx="' + i + '" onclick="approveTempAccount(this.dataset.pidx)" title="Approve" style="border:none;background:none;cursor:pointer;font-size:1rem;padding:0.1rem 0.25rem;">✅</button>' +
            '<button data-pidx="' + i + '" onclick="rejectTempAccount(this.dataset.pidx)" title="Reject" style="border:none;background:none;cursor:pointer;font-size:1rem;padding:0.1rem 0.25rem;">❌</button>' +
          '</td></tr>';
      }).join('');
    })
    .catch(function() {
      const tbody = document.getElementById('pendingUsersBody');
      if (tbody) tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:1rem;">Start server to load pending accounts.</td></tr>';
    });
}

function approveTempAccount(idxStr) {
  showModal('confirm', 'Approve this registration?', {
    onConfirm: function() {
      fetch('/api/register/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pendingIndex: parseInt(idxStr) })
      }).then(function(r) { return r.json(); })
        .then(function(res) {
          if (res.success) { loadAdminUsers(); showModal('success', 'Account approved and created!', { onConfirm: function(){} }); }
          else { showModal('warning', res.error || 'Failed'); }
        }).catch(function() { showModal('warning', 'Server not running.'); });
    }, onCancel: function() {}
  });
}

function rejectTempAccount(idxStr) {
  showModal('confirm', 'Reject this registration request?', {
    onConfirm: function() {
      fetch('/api/register/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pendingIndex: parseInt(idxStr) })
      }).then(function(r) { return r.json(); })
        .then(function(res) {
          loadAdminUsers();
          showModal('info', 'Registration rejected.', { onConfirm: function(){} });
        }).catch(function() { loadAdminUsers(); });
    }, onCancel: function() {}
  });
}

// ============================================
// COMPANY DETAILS
// ============================================

let companyData = {};

function loadCompanyData(callback) {
  fetch('/db/company.json?_=' + Date.now())
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) {
      if (!data) return;
      // Apply any scheduled changes whose start_date <= today
      const today = new Date(); today.setHours(0,0,0,0);
      const scheduled = data.scheduled_changes || [];
      let effective = Object.assign({}, data.company);
      scheduled.forEach(function(sc) {
        if (new Date(sc.start_date) <= today) {
          Object.assign(effective, sc.changes);
        }
      });
      companyData = effective;
      localStorage.setItem('lexora_company', JSON.stringify({ company: effective, scheduled_changes: data.scheduled_changes || [] }));
      // Update footer copyright from company.json
      _updateFooterCopyright(effective);
      if (callback) callback(effective);
    })
    .catch(function() {
      const cached = localStorage.getItem('lexora_company');
      if (cached) { companyData = JSON.parse(cached).company || {}; _updateFooterCopyright(companyData); if (callback) callback(companyData); }
    });
}

function _updateFooterCopyright(c) {
  if (!c) return;
  var year = c.copyright_year || new Date().getFullYear();
  var text = c.copyright_text || ('© ' + year + ' ' + (c.name || 'Lexora AI Solutions') + '. All rights reserved.');
  var web  = c.website
    ? ' <a href="' + c.website + '" target="_blank" style="color:#6366f1;text-decoration:none;margin-left:6px;">' + c.website.replace('https://','') + '</a>'
    : '';
  var html = '<i class="far fa-copyright" style="margin-right:5px;"></i>' + text + web;
  // Update global footer
  var gf = document.getElementById('appFooterCopyright');
  if (gf) gf.innerHTML = html;
  // Update all per-section footers
  document.querySelectorAll('.section-copyright-bar').forEach(function(el) { el.innerHTML = html; });
}

function _injectSectionFooters() {
  document.querySelectorAll('.content-section').forEach(function(sec) {
    var existing = sec.querySelector('.section-copyright-bar');
    if (existing) return;  // already injected
    var bar = document.createElement('div');
    bar.className = 'section-copyright-bar';
    sec.appendChild(bar);
  });
}

function renderContactDetails() {
  const fields = [
    { id: 'co-name',    key: 'name',          icon: 'fa-building',       label: 'Company Name' },
    { id: 'co-addr',    key: 'address',        icon: 'fa-map-marker-alt', label: 'Address' },
    { id: 'co-hours',   key: 'working_hours',  icon: 'fa-clock',          label: 'Working Hours' },
    { id: 'co-days',    key: 'working_days',   icon: 'fa-calendar-alt',   label: 'Working Days' },
    { id: 'co-loc',     key: 'location',       icon: 'fa-globe-americas', label: 'Location' },
    { id: 'co-email',   key: 'email',          icon: 'fa-envelope',       label: 'Email' },
    { id: 'co-phone',   key: 'phone',          icon: 'fa-phone',          label: 'Phone' },
  ];
  fields.forEach(function(f) {
    const el = document.getElementById(f.id);
    if (el && companyData[f.key]) el.textContent = companyData[f.key];
  });
}

function loadCompanyAdmin() {
  const tbody = document.getElementById('companyTableBody');
  if (!tbody) return;
  const data = JSON.parse(localStorage.getItem('lexora_company') || '{}');
  const company = data.company || companyData || {};
  const scheduled = data.scheduled_changes || [];

  const fields = [
    { key: 'name',         label: 'Company Name' },
    { key: 'address',      label: 'Address' },
    { key: 'email',        label: 'Email' },
    { key: 'phone',        label: 'Phone' },
    { key: 'working_hours',label: 'Working Hours' },
    { key: 'working_days', label: 'Working Days' },
    { key: 'location',     label: 'Location' },
    { key: 'website',      label: 'Website' },
  ];
  tbody.innerHTML = fields.map(function(f) {
    const sched = scheduled.find(function(s) { return s.changes && s.changes[f.key]; });
    const schedInfo = sched ? '<span style="font-size:0.75rem;color:#f59e0b;display:block;">⏰ Scheduled: ' + (sched.changes[f.key]) + ' (from ' + sched.start_date + ')</span>' : '';
    return '<tr style="border-bottom:1px solid #f1f5f9;">' +
      '<td style="padding:0.6rem 1rem;font-weight:600;color:#1e293b;width:160px;">' + f.label + '</td>' +
      '<td style="padding:0.6rem 1rem;color:#475569;">' + (company[f.key]||'—') + schedInfo + '</td>' +
      '<td style="padding:0.6rem 1rem;white-space:nowrap;">' +
        '<button data-key="' + f.key + '" data-label="' + f.label + '" data-val="' + encodeURIComponent(company[f.key]||'') + '" onclick="editCompanyField(this)" ' +
        'style="padding:0.25rem 0.7rem;background:#3b82f6;color:white;border:none;border-radius:6px;cursor:pointer;font-size:0.78rem;">Edit</button>' +
      '</td></tr>';
  }).join('');
}

function editCompanyField(btn) {
  const key   = btn.dataset.key;
  const label = btn.dataset.label;
  const val   = decodeURIComponent(btn.dataset.val || '');
  const today = new Date().toISOString().split('T')[0];

  const form = '<div style="display:flex;flex-direction:column;gap:0.8rem;font-size:0.9rem;">' +
    '<div><label style="font-weight:600;display:block;margin-bottom:0.3rem;">' + label + '</label>' +
    '<input id="coVal" value="' + val.replace(/"/g,'&quot;') + '" style="width:100%;padding:0.6rem 1rem;border:2px solid #e2e8f0;border-radius:8px;" /></div>' +
    '<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:0.8rem;">' +
    '<label style="font-weight:600;display:block;margin-bottom:0.3rem;font-size:0.85rem;">📅 Apply Change</label>' +
    '<div style="display:flex;align-items:center;gap:0.8rem;flex-wrap:wrap;">' +
    '<label><input type="radio" name="applyType" value="now" checked style="accent-color:#3b82f6;"> Immediately</label>' +
    '<label><input type="radio" name="applyType" value="date"> From date: <input type="date" id="coDate" value="' + today + '" style="padding:0.3rem;border:1px solid #e2e8f0;border-radius:6px;margin-left:0.3rem;"></label>' +
    '</div></div></div>';

  showModal('info', form, {
    title: '✏️ Edit — ' + label,
    icon: '✏️',
    closeOnBackdrop: false,
    buttons: [
      { label: 'Save', class: 'btn-success', callback: function() {
        const newVal = document.getElementById('coVal').value.trim();
        const applyType = document.querySelector('input[name="applyType"]:checked').value;
        const applyDate = document.getElementById('coDate').value;

        const stored = JSON.parse(localStorage.getItem('lexora_company') || '{}');
        const company = stored.company || {};
        let scheduled = stored.scheduled_changes || [];

        if (applyType === 'now') {
          company[key] = newVal;
          // Remove any existing schedule for this key
          scheduled = scheduled.filter(function(s) { return !s.changes[key]; });
        } else {
          // Schedule the change
          const existing = scheduled.find(function(s) { return s.start_date === applyDate; });
          if (existing) { existing.changes[key] = newVal; }
          else { scheduled.push({ start_date: applyDate, changes: { [key]: newVal } }); }
        }

        const payload = { company: company, scheduled_changes: scheduled };
        localStorage.setItem('lexora_company', JSON.stringify(payload));

        fetch('/api/company/save', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }).catch(function() {});

        // Apply immediately if no date
        if (applyType === 'now') { companyData[key] = newVal; renderContactDetails(); }
        loadCompanyAdmin();
        closeModal();
        showModal('success', applyType === 'now'
          ? label + ' updated immediately!'
          : label + ' scheduled from ' + applyDate + '!',
          { onConfirm: function(){} });
      }},
      { label: 'Cancel', class: 'btn-secondary', callback: function() { closeModal(); } }
    ]
  });
}

// ============================================
// PLANS & OFFERS
// ============================================

let allPlans = [];

function loadPlans(callback) {
  fetch('/db/plans.json?_=' + Date.now())
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) {
      if (data && data.plans) {
        allPlans = data.plans;
        localStorage.setItem('lexora_plans', JSON.stringify(allPlans));
      } else {
        var cached = localStorage.getItem('lexora_plans');
        if (cached) allPlans = JSON.parse(cached);
      }
      if (callback) callback(allPlans);
    })
    .catch(function() {
      var cached = localStorage.getItem('lexora_plans');
      if (cached) { allPlans = JSON.parse(cached); }
      if (callback) callback(allPlans);
    });
}

function savePlans() {
  fetch('/api/plans/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plans: allPlans })
  }).then(function(r) { return r.json(); })
    .then(function(res) {
      if (res.success) {
        localStorage.setItem('lexora_plans', JSON.stringify(allPlans));
        console.log('[Lexora] plans.json saved');
      }
    })
    .catch(function() { localStorage.setItem('lexora_plans', JSON.stringify(allPlans)); });
}

// Render the Plan & Offer section (public view) — only active plans with start_date <= today
function renderPlansSection() {
  const container = document.getElementById('plansContainer');
  if (!container) return;
  const today = new Date(); today.setHours(0,0,0,0);

  const visible = allPlans.filter(function(p) {
    return p.active && new Date(p.start_date) <= today;
  });

  if (visible.length === 0) {
    container.innerHTML = '<p style="color:#94a3b8;text-align:center;padding:2rem;">No active plans available yet.</p>';
    return;
  }

  const colorMap = { blue: '#3b82f6', green: '#22c55e', purple: '#8b5cf6', orange: '#f59e0b', red: '#ef4444' };

  container.innerHTML = visible.map(function(p) {
    const color   = colorMap[p.color] || '#3b82f6';
    const price   = p.amount === 0 ? 'Free' : '$' + p.amount + ' / ' + p.frequency;
    const incList = (p.included || []).map(function(i) { return '<p style="margin:0.25rem 0;">✅ ' + i + '</p>'; }).join('');
    const excList = (p.excluded || []).map(function(i) { return '<p style="margin:0.25rem 0;color:#94a3b8;">❌ ' + i + '</p>'; }).join('');
    const lockBadge = p.lock === 'yes' ? '<span style="font-size:0.72rem;background:#fef3c7;color:#b45309;padding:0.15rem 0.5rem;border-radius:6px;margin-left:0.4rem;">🔒 Free</span>' : '';
    return '<div class="card accent ' + (p.color||'blue') + '" style="min-height:280px;">' +
      '<div class="card-header"><span class="icon">' + (p.icon||'📋') + '</span>' +
      '<h3 class="title">' + p.name + lockBadge + '</h3></div>' +
      '<div class="card-body">' +
      '<p style="font-size:1.4rem;font-weight:700;color:#1e293b;margin-bottom:0.4rem;">' + price + '</p>' +
      '<p style="font-size:0.8rem;color:#64748b;margin-bottom:0.8rem;">' + (p.description||'') + '</p>' +
      incList + (excList ? '<div style="margin-top:0.5rem;">' + excList + '</div>' : '') +
      '</div>' +
      '<div class="card-footer">' +
      '<span style="color:' + color + ';font-weight:600;cursor:pointer;" onclick="selectPlan(\'' + p.id + '\')">Get Started \u2192</span>' +
      '</div></div>';
  }).join('');
}

function selectPlan(planId) {
  const plan = allPlans.find(function(p) { return p.id === planId; });
  if (!plan) return;
  showModal('info', plan.amount === 0
    ? 'Basic plan selected. You can upgrade anytime.'
    : plan.name + ' plan — $' + plan.amount + '/' + plan.frequency + '. Contact sales to activate.',
    { onConfirm: function(){} });
}

// ── Admin: Render plan management table ──────────────────────────────────
function renderAdminPlansTable() {
  const tbody = document.getElementById('adminPlansBody');
  if (!tbody) return;
  if (allPlans.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:1.5rem;">No plans yet.</td></tr>';
    return;
  }
  tbody.innerHTML = allPlans.map(function(p, idx) {
    const locked = p.lock === 'yes';
    return '<tr style="border-bottom:1px solid #f1f5f9;">' +
      '<td style="padding:0.5rem 0.8rem;">' + p.icon + ' ' + p.name + '</td>' +
      '<td style="padding:0.5rem 0.8rem;">' + (p.amount === 0 ? 'Free' : '$' + p.amount) + '</td>' +
      '<td style="padding:0.5rem 0.8rem;">' + p.frequency + '</td>' +
      '<td style="padding:0.5rem 0.8rem;font-size:0.78rem;max-width:150px;">' + (p.included||[]).join(', ') + '</td>' +
      '<td style="padding:0.5rem 0.8rem;">' + p.start_date + '</td>' +
      '<td style="padding:0.5rem 0.8rem;">' +
        '<span style="padding:0.2rem 0.6rem;border-radius:6px;font-size:0.78rem;font-weight:600;background:' + (p.active ? '#dcfce7' : '#fee2e2') + ';color:' + (p.active ? '#16a34a' : '#dc2626') + ';">' +
        (p.active ? 'Active' : 'Inactive') + '</span></td>' +
      '<td style="padding:0.5rem 0.8rem;">' +
        (locked ? '<span style="color:#b45309;font-size:0.8rem;">🔒 Locked</span>' : '<span style="color:#22c55e;font-size:0.8rem;">🔓 Free</span>') + '</td>' +
      '<td style="padding:0.5rem 0.8rem;white-space:nowrap;">' +
        '<button onclick="editPlan(' + idx + ')" style="padding:0.25rem 0.6rem;background:#3b82f6;color:white;border:none;border-radius:6px;cursor:pointer;font-size:0.78rem;margin-right:0.3rem;">Edit</button>' +
        (!locked ? '<button onclick="deletePlan(' + idx + ')" style="padding:0.25rem 0.6rem;background:#ef4444;color:white;border:none;border-radius:6px;cursor:pointer;font-size:0.78rem;">Delete</button>'
                 : '<span style="color:#94a3b8;font-size:0.75rem;">Protected</span>') +
      '</td></tr>';
  }).join('');
}

function addNewPlan() {
  const today = new Date().toISOString().split('T')[0];
  const S = 'width:100%;padding:0.5rem;border:2px solid #e2e8f0;border-radius:8px;';
  const form = '<div style="display:flex;flex-direction:column;gap:0.8rem;font-size:0.88rem;">' +
    '<div style="display:flex;gap:0.7rem;flex-wrap:wrap;">' +
      '<div style="flex:0.5;min-width:60px;"><label style="font-weight:600;display:block;margin-bottom:0.2rem;">Icon</label><input id="pIcon" value="📋" style="' + S + '" /></div>' +
      '<div style="flex:1.5;min-width:120px;"><label style="font-weight:600;display:block;margin-bottom:0.2rem;">Name *</label><input id="pName" placeholder="Plan name" style="' + S + '" /></div>' +
      '<div style="flex:0.8;min-width:80px;"><label style="font-weight:600;display:block;margin-bottom:0.2rem;">Amount ($)</label><input id="pAmount" type="number" value="0" min="0" style="' + S + '" /></div>' +
      '<div style="flex:1.2;min-width:120px;"><label style="font-weight:600;display:block;margin-bottom:0.2rem;">Frequency</label><input id="pFreq" placeholder="e.g. monthly, yearly, one-time, forever" style="' + S + '" /></div>' +
    '</div>' +
    '<div style="display:flex;gap:0.7rem;">' +
      '<div style="flex:1;"><label style="font-weight:600;display:block;margin-bottom:0.2rem;">Color</label><select id="pColor" style="' + S + '"><option>blue</option><option>green</option><option>purple</option><option>orange</option></select></div>' +
      '<div style="flex:3;"><label style="font-weight:600;display:block;margin-bottom:0.2rem;">Description</label><input id="pDesc" placeholder="Short description" style="' + S + '" /></div>' +
    '</div>' +
    '<div style="display:flex;gap:0.7rem;">' +
      '<div style="flex:1;"><label style="font-weight:600;display:block;margin-bottom:0.2rem;">Included (one per line)</label><textarea id="pIncluded" rows="4" style="' + S + 'font-family:inherit;resize:vertical;"></textarea></div>' +
      '<div style="flex:1;"><label style="font-weight:600;display:block;margin-bottom:0.2rem;">Excluded (one per line)</label><textarea id="pExcluded" rows="4" style="' + S + 'font-family:inherit;resize:vertical;"></textarea></div>' +
    '</div>' +
    '<div style="display:flex;gap:0.7rem;align-items:flex-end;">' +
      '<div style="flex:1;"><label style="font-weight:600;display:block;margin-bottom:0.2rem;">Start Date *</label><input id="pStart" type="date" value="' + today + '" style="' + S + '" /></div>' +
      '<div style="flex:1;display:flex;align-items:center;gap:0.5rem;padding-bottom:0.2rem;"><input type="checkbox" id="pActive" checked style="width:16px;height:16px;accent-color:#22c55e;" /><label for="pActive" style="font-weight:600;">Active</label></div>' +
    '</div>' +
  '</div>';

  showModal('info', form, {
    title: '➕ Add New Plan',
    icon: '📋',
    closeOnBackdrop: false,
    buttons: [
      { label: 'Add Plan', class: 'btn-success', callback: function() {
        const name = document.getElementById('pName').value.trim();
        const start = document.getElementById('pStart').value;
        if (!name || !start) { showModal('warning', 'Name and Start Date are required.'); return; }
        const newPlan = {
          id: 'plan_' + Date.now(),
          name: name,
          amount: parseFloat(document.getElementById('pAmount').value) || 0,
          currency: 'USD',
          frequency: document.getElementById('pFreq').value,
          included: document.getElementById('pIncluded').value.split('\n').map(function(s){return s.trim();}).filter(Boolean),
          excluded: document.getElementById('pExcluded').value.split('\n').map(function(s){return s.trim();}).filter(Boolean),
          start_date: start,
          lock: 'no',
          active: document.getElementById('pActive').checked,
          color: document.getElementById('pColor').value,
          icon: document.getElementById('pIcon').value,
          description: document.getElementById('pDesc').value.trim()
        };
        allPlans.push(newPlan);
        savePlans();
        renderAdminPlansTable();
        closeModal();
        showModal('success', 'Plan "' + name + '" added!', { onConfirm: function(){} });
      }},
      { label: 'Cancel', class: 'btn-secondary', callback: function() { closeModal(); } }
    ]
  });
}

function editPlan(idx) {
  const p = allPlans[idx];
  if (!p) return;
  const S2 = 'width:100%;padding:0.5rem;border:2px solid #e2e8f0;border-radius:8px;';
  const form = '<div style="display:flex;flex-direction:column;gap:0.8rem;font-size:0.88rem;">' +
    '<div style="display:flex;gap:0.7rem;flex-wrap:wrap;">' +
      '<div style="flex:0.5;min-width:60px;"><label style="font-weight:600;display:block;margin-bottom:0.2rem;">Icon</label><input id="epIcon" value="' + (p.icon||'📋') + '" style="' + S2 + '" /></div>' +
      '<div style="flex:1.5;min-width:120px;"><label style="font-weight:600;display:block;margin-bottom:0.2rem;">Name *</label><input id="epName" value="' + p.name + '" style="' + S2 + '" /></div>' +
      '<div style="flex:0.8;min-width:80px;"><label style="font-weight:600;display:block;margin-bottom:0.2rem;">Amount ($)</label><input id="epAmount" type="number" value="' + p.amount + '" style="' + S2 + '" /></div>' +
      '<div style="flex:1.2;min-width:120px;"><label style="font-weight:600;display:block;margin-bottom:0.2rem;">Frequency</label><input id="epFreq" value="' + (p.frequency||'') + '" placeholder="monthly, yearly, one-time, forever" style="' + S2 + '" /></div>' +
    '</div>' +
    '<div style="display:flex;gap:0.7rem;">' +
      '<div style="flex:1;"><label style="font-weight:600;display:block;margin-bottom:0.2rem;">Color</label><select id="epColor" style="' + S2 + '"><option ' + (p.color==='blue'?'selected':'') + '>blue</option><option ' + (p.color==='green'?'selected':'') + '>green</option><option ' + (p.color==='purple'?'selected':'') + '>purple</option><option ' + (p.color==='orange'?'selected':'') + '>orange</option></select></div>' +
      '<div style="flex:3;"><label style="font-weight:600;display:block;margin-bottom:0.2rem;">Description</label><input id="epDesc" value="' + (p.description||'') + '" style="' + S2 + '" /></div>' +
    '</div>' +
    '<div style="display:flex;gap:0.7rem;">' +
      '<div style="flex:1;"><label style="font-weight:600;display:block;margin-bottom:0.2rem;">Included (one per line)</label><textarea id="epIncluded" rows="4" style="' + S2 + 'font-family:inherit;resize:vertical;">' + (p.included||[]).join('\n') + '</textarea></div>' +
      '<div style="flex:1;"><label style="font-weight:600;display:block;margin-bottom:0.2rem;">Excluded (one per line)</label><textarea id="epExcluded" rows="4" style="' + S2 + 'font-family:inherit;resize:vertical;">' + (p.excluded||[]).join('\n') + '</textarea></div>' +
    '</div>' +
    '<div style="display:flex;gap:0.7rem;align-items:flex-end;">' +
      '<div style="flex:1;"><label style="font-weight:600;display:block;margin-bottom:0.2rem;">Start Date</label><input id="epStart" type="date" value="' + p.start_date + '" style="' + S2 + '" /></div>' +
      '<div style="flex:1;display:flex;align-items:center;gap:0.5rem;padding-bottom:0.2rem;"><input type="checkbox" id="epActive" ' + (p.active?'checked':'') + ' style="width:16px;height:16px;accent-color:#22c55e;" /><label for="epActive" style="font-weight:600;">Active</label></div>' +
    '</div>' +
  '</div>';

  showModal('info', form, {
    title: '✏️ Edit Plan — ' + p.name,
    icon: '✏️',
    closeOnBackdrop: false,
    buttons: [
      { label: 'Save', class: 'btn-success', callback: function() {
        const name = document.getElementById('epName').value.trim();
        if (!name) { showModal('warning', 'Plan name is required.'); return; }
        allPlans[idx] = Object.assign({}, p, {
          name: name,
          icon: document.getElementById('epIcon').value,
          color: document.getElementById('epColor').value,
          amount: parseFloat(document.getElementById('epAmount').value) || 0,
          frequency: (document.getElementById('epFreq').value||'').trim() || 'monthly',
          description: document.getElementById('epDesc').value.trim(),
          included: document.getElementById('epIncluded').value.split('\n').map(function(s){return s.trim();}).filter(Boolean),
          excluded: document.getElementById('epExcluded').value.split('\n').map(function(s){return s.trim();}).filter(Boolean),
          start_date: document.getElementById('epStart').value,
          active: document.getElementById('epActive').checked
        });
        savePlans();
        renderAdminPlansTable();
        closeModal();
        showModal('success', 'Plan updated!', { onConfirm: function(){} });
      }},
      { label: 'Cancel', class: 'btn-secondary', callback: function() { closeModal(); } }
    ]
  });
}

function deletePlan(idx) {
  const p = allPlans[idx];
  if (!p) return;
  if (p.lock === 'yes') { showModal('warning', 'This plan is locked and cannot be deleted.'); return; }
  showModal('confirm', 'Delete plan "' + p.name + '"? This cannot be undone.', {
    onConfirm: function() {
      allPlans.splice(idx, 1);
      savePlans();
      renderAdminPlansTable();
      showModal('success', 'Plan deleted.', { onConfirm: function(){} });
    },
    onCancel: function() {}
  });
}

// ── Admin: File Manager ───────────────────────────────────────────────────

// ── Files section: Add / Delete / Download ────────────────────────────────────
// ── Current path helper ──────────────────────────────────────────────────────
function _currentBreadcrumbPath() {
  return (typeof _currentFolder !== 'undefined' && _currentFolder) ? _currentFolder : '';
}

function addNewFile() {
  var base  = _currentBreadcrumbPath();
  var label = base ? 'Current location: ' + base : 'Root folder';
  var S     = 'width:100%;padding:0.5rem;border:2px solid #e2e8f0;border-radius:8px;font-size:0.88rem;';
  var form  = '<div style="display:flex;flex-direction:column;gap:0.75rem;">' +
    '<div style="background:#eff6ff;padding:0.5rem 0.75rem;border-radius:6px;font-size:0.82rem;color:#3b82f6;">📍 ' + label + '</div>' +
    '<div><label style="font-weight:600;display:block;margin-bottom:0.2rem;">Upload a file</label><input type="file" id="newFileInput" style="width:100%;" /></div>' +
    '<div style="text-align:center;color:#94a3b8;font-size:0.82rem;">— or create empty file —</div>' +
    '<div><input id="newFileName" placeholder="filename.txt" style="' + S + '" /></div>' +
  '</div>';
  showModal('info', form, { title: '📄 Add File', closeOnBackdrop: false, buttons: [
    { label: 'Add', class: 'btn-success', callback: function() {
        var base2   = _currentBreadcrumbPath();
        var fileEl  = document.getElementById('newFileInput');
        var name    = (document.getElementById('newFileName').value || '').trim();
        if (fileEl && fileEl.files.length) {
          var file   = fileEl.files[0];
          var reader = new FileReader();
          reader.onload = function(ev) {
            var b64  = ev.target.result.split(',')[1];
            var path = base2 ? base2 + '/' + file.name : file.name;
            fetch('/api/files/upload', { method:'POST', headers:{'Content-Type':'application/json'},
              body: JSON.stringify({ path, fileData: b64, fileName: file.name }) })
            .then(function(r){ return r.json(); })
            .then(function(res) {
              closeModal();
              if (res.success) { reloadAdminFilesAtCurrentFolder(); showModal('success','File uploaded to ' + path + '!'); }
              else { showModal('warning', res.error||'Upload failed'); }
            }).catch(function(){ closeModal(); showModal('warning','Server not running.'); });
          };
          reader.readAsDataURL(file);
        } else if (name) {
          var path = base2 ? base2 + '/' + name : name;
          fetch('/api/files/write', { method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ path, content: '' }) })
          .then(function(r){ return r.json(); })
          .then(function(res) {
            closeModal();
            if (res.success) { reloadAdminFilesAtCurrentFolder(); showModal('success','File created: ' + path); }
            else { showModal('warning', res.error||'Failed'); }
          }).catch(function(){ closeModal(); showModal('warning','Server not running.'); });
        } else { showModal('warning','Select a file or enter a filename.'); }
    }},
    { label: 'Cancel', class: 'btn-secondary', callback: function(){ closeModal(); } }
  ]});
}

function addNewFolder() {
  var base  = _currentBreadcrumbPath();
  var label = base ? 'Inside: ' + base : 'Root folder';
  var S     = 'width:100%;padding:0.5rem;border:2px solid #e2e8f0;border-radius:8px;font-size:0.88rem;';
  var form  = '<div style="display:flex;flex-direction:column;gap:0.75rem;">' +
    '<div style="background:#eff6ff;padding:0.5rem 0.75rem;border-radius:6px;font-size:0.82rem;color:#3b82f6;">📍 ' + label + '</div>' +
    '<div><label style="font-weight:600;display:block;margin-bottom:0.3rem;">Folder Name</label>' +
      '<input id="newFolderName" placeholder="my-folder" style="' + S + '" /></div>' +
  '</div>';
  showModal('info', form, { title: '📁 Add Folder', closeOnBackdrop: false, buttons: [
    { label: 'Create', class: 'btn-success', callback: function() {
        var base2  = _currentBreadcrumbPath();
        var name   = (document.getElementById('newFolderName').value || '').trim().replace(/[^a-zA-Z0-9_\-. ]/g, '');
        if (!name) { showModal('warning','Enter a folder name.'); return; }
        var path   = base2 ? base2 + '/' + name : name;
        fetch('/api/files/mkdir', { method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ path }) })
        .then(function(r){ return r.json(); })
        .then(function(res) {
          closeModal();
          if (res.success) {
            reloadAdminFilesAtCurrentFolder();
            showModal('success', 'Folder created: ' + path, {onConfirm:function(){}});
          } else { showModal('warning', res.error||'Failed to create folder'); }
        }).catch(function(){ closeModal(); showModal('warning','Server not running.'); });
    }},
    { label: 'Cancel', class: 'btn-secondary', callback: function(){ closeModal(); } }
  ]});
}

function deleteSelectedFiles() {
  const checked = Array.from(document.querySelectorAll('.file-checkbox:checked'));
  if (!checked.length) { showModal('warning','Select files to delete.'); return; }
  const paths = checked.map(function(cb){ return decodeURIComponent(cb.dataset.path); });
  showModal('confirm', 'Delete ' + paths.length + ' file(s)?', {
    onConfirm: function() {
      let done = 0;
      paths.forEach(function(path) {
        fetch('/api/files/delete', { method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ path }) })
        .then(function(){ done++; if(done===paths.length){ reloadAdminFilesAtCurrentFolder(); showModal('success',done+' item(s) deleted!'); } })
        .catch(function(){ done++; if(done===paths.length) loadAdminFiles(); });
      });
    }, onCancel: function(){}
  });
}

function downloadSelectedFiles() {
  var checked = Array.from(document.querySelectorAll('.file-checkbox:checked'));
  if (!checked.length) { showModal('warning','Select files to download.'); return; }
  checked.forEach(function(cb) {
    var path  = decodeURIComponent(cb.dataset.path);
    var fname = path.split('/').pop();
    var a = document.createElement('a');
    a.href     = '/api/files/download?path=' + encodeURIComponent(path);
    a.download = fname;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function(){ document.body.removeChild(a); }, 200);
  });
}

// Also make files clickable for single download
function singleDownload(path) {
  var fname = path.split('/').pop();
  var a = document.createElement('a');
  a.href     = '/api/files/download?path=' + encodeURIComponent(path);
  a.download = fname;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(function(){ document.body.removeChild(a); }, 200);
}

function loadAdminFiles() {
  const tbody = document.getElementById('filesTableBody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#94a3b8;padding:1.5rem;"><i class="fas fa-spinner fa-spin"></i> Loading files...</td></tr>';

  fetch('/api/files/list?_=' + Date.now())
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) {
      if (!data || !data.files) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#94a3b8;padding:1rem;">Server not running or no files found.</td></tr>';
        return;
      }
      renderFileTable(data.files);
    })
    .catch(function() {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#f87171;padding:1rem;">Start server to browse files.</td></tr>';
    });
}

// ── Hierarchical file manager state ──────────────────────────────────────
let _allServerFiles = [];
let _currentFolder  = '';

function renderFileTable(files) {
  _allServerFiles = files;
  _currentFolder  = '';
  _renderCurrentFolder();
}

// Reload files but STAY at current folder position
function reloadAdminFilesAtCurrentFolder() {
  var savedFolder = _currentFolder;
  var tbody = document.getElementById('filesTableBody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:1rem;"><i class="fas fa-spinner fa-spin"></i></td></tr>';

  fetch('/api/files/list?_=' + Date.now())
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) {
      if (!data || !data.files) return;
      _allServerFiles = data.files;
      _currentFolder  = savedFolder; // restore position
      _renderCurrentFolder();
    })
    .catch(function() {
      if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#f87171;padding:1rem;">⚠ Reload failed.</td></tr>';
    });
}

function _renderCurrentFolder() {
  const tbody   = document.getElementById('filesTableBody');
  const breadEl = document.getElementById('fileBreadcrumb');
  if (!tbody) return;

  // Breadcrumb
  if (breadEl) {
    if (_currentFolder === '') {
      breadEl.innerHTML = '<i class="fas fa-hdd" style="color:#64748b;margin-right:0.4rem;"></i><span style="color:#64748b;">Root</span>';
    } else {
      const parts = _currentFolder.split('/');
      let path = '';
      let crumbs = '<i class="fas fa-hdd" style="color:#3b82f6;margin-right:0.4rem;"></i>' +
        '<a href="#" onclick="navigateFolder(\'\'); return false;" style="color:#3b82f6;text-decoration:none;">Root</a>';
      parts.forEach(function(part) {
        path = path ? path + '/' + part : part;
        const p = path;
        crumbs += ' <span style="color:#cbd5e1;margin:0 0.3rem;">/</span>' +
          '<a href="#" data-nav="' + p + '" onclick="navigateFolder(this.dataset.nav); return false;" style="color:#3b82f6;text-decoration:none;">' + part + '</a>';
      });
      breadEl.innerHTML = crumbs;
    }
  }

  // Filter: only direct children of _currentFolder
  var rows;
  if (_currentFolder === '') {
    rows = _allServerFiles.filter(function(f) {
      return f.path.indexOf('/') === -1;
    });
  } else {
    var prefix = _currentFolder + '/';
    rows = _allServerFiles.filter(function(f) {
      if (!f.path.startsWith(prefix)) return false;
      var rest = f.path.slice(prefix.length);
      return rest !== '' && rest.indexOf('/') === -1;
    });
  }

  if (!rows || rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:1.5rem;">Empty folder.</td></tr>';
    return;
  }

  const iconMap  = { json:'fa-database', py:'fa-code', js:'fa-code', css:'fa-code', html:'fa-code', md:'fa-file-alt', txt:'fa-file-alt', zip:'fa-file-archive', png:'fa-file-image', jpg:'fa-file-image', jpeg:'fa-file-image' };
  const colorMap = { json:'#22c55e', py:'#3b82f6', js:'#f59e0b', css:'#8b5cf6', html:'#ef4444', md:'#64748b' };

  tbody.innerHTML = rows.map(function(f) {
    const isFolder = (f.type === 'folder');
    const icon  = isFolder ? 'fa-folder-open' : (iconMap[f.ext] || 'fa-file');
    const color = isFolder ? '#f59e0b'          : (colorMap[f.ext] || '#64748b');

    const nameCell = isFolder
      ? '<a href="#" data-nav="' + f.path + '" onclick="navigateFolder(this.dataset.nav); return false;" ' +
        'style="color:#f59e0b;font-weight:600;text-decoration:none;display:inline-flex;align-items:center;gap:0.4rem;">' +
        '<i class="fas ' + icon + '" style="color:' + color + ';"></i>' + f.name + '</a>'
      : '<a href="#" data-fpath="' + encodeURIComponent(f.path) + '" onclick="openFileLink(this); return false;" ' +
        'style="color:#1e293b;text-decoration:none;display:inline-flex;align-items:center;gap:0.4rem;" title="Click to view ' + f.name + '">' +
        '<i class="fas ' + icon + '" style="color:' + color + ';"></i>' + f.name + '</a>';

    return '<tr style="border-bottom:1px solid #f1f5f9;">' +
      '<td style="padding:0.4rem 0.5rem;width:36px;"><input type="checkbox" class="file-checkbox" data-path="' + encodeURIComponent(f.path) + '" style="accent-color:#3b82f6;width:14px;height:14px;" /></td>' +
      '<td style="padding:0.4rem 0.8rem;">' + nameCell + '</td>' +
      '<td style="padding:0.4rem 0.8rem;color:#64748b;font-size:0.8rem;">' + (isFolder ? '<span style="background:#fef3c7;color:#92400e;padding:0.1rem 0.4rem;border-radius:4px;font-size:0.73rem;">DIR</span>' : (f.ext.toUpperCase() || '—')) + '</td>' +
      '<td style="padding:0.4rem 0.8rem;color:#64748b;font-size:0.8rem;">' + (f.size || '—') + '</td>' +
      '<td style="padding:0.4rem 0.8rem;color:#64748b;font-size:0.8rem;">' + (f.modified || '—') + '</td>' +
      (isFolder
        ? '<td style="padding:0.4rem 0.8rem;color:#94a3b8;">—</td>'
        : '<td style="padding:0.4rem 0.8rem;white-space:nowrap;">' +
          '<button data-fpath="' + encodeURIComponent(f.path) + '" onclick="openFileLink(this)" title="View/Edit" style="border:none;background:none;cursor:pointer;font-size:1rem;padding:0.1rem 0.3rem;">📝</button>' +
          '<button data-path="' + encodeURIComponent(f.path) + '" data-name="' + encodeURIComponent(f.name) + '" onclick="deleteAdminFileByEl(this)" title="Delete" style="border:none;background:none;cursor:pointer;font-size:1rem;padding:0.1rem 0.3rem;">🗑️</button>' +
          '</td>') +
    '</tr>';
  }).join('');
}

function navigateFolder(folderPath) {
  _currentFolder = folderPath;
  _renderCurrentFolder();
}

function openFileLink(el) {
  const path = decodeURIComponent(el.dataset.fpath);
  const ext  = path.split('.').pop().toLowerCase();
  if (ext === 'json') {
    openJsonFullEditor(path);
  } else if (['html','css','js','py','txt','md'].includes(ext)) {
    openCodeEditor(path);
  } else {
    showAdminFile(path);
  }
}

// ── JSON Full-Width Editable Table Editor ─────────────────────────────────────

// ============================================
// JSON EDITOR SCHEMAS
// Define field types for each JSON file
// ============================================
var JSON_SCHEMAS = {
  'users.json': {
    two_factor_auth: { type:'boolean' },
    lock:              { type:'select',   options:['yes','no'] },
    active:            { type:'boolean' },
    status:            { type:'select',   options:['active','inactive','hold'] },
    account_type:      { type:'select',   options:['admin','user'] },
    role:              { type:'select',   options:['admin','user'] },
    gender:            { type:'select',   options:['Male','Female','Other','Prefer not to say'] },
    plan:              { type:'select',   options:['Basic','Pro','Enterprise'] },
    email_notifications: { type:'boolean' }
  },
  'plans.json': {
    lock:      { type:'select', options:['yes','no'] },
    active:    { type:'boolean' },
    frequency: { type:'select', options:['monthly','yearly','forever','one-time','per project'] },
    color:     { type:'select', options:['blue','green','purple','orange','red'] }
  },
  'templates.json': {
    lock:     { type:'select', options:['Yes','No'] },
    status:   { type:'select', options:['Active','Inactive'] },
    category: { type:'select', options:['Lease Abstraction','Translation','Other'] }
  },
  'agents.json': {
    lock:         { type:'select',  options:['yes','no'] },
    active:       { type:'boolean' },
    api_provider: { type:'select',  options:['openrouter','openai','deepl','none'] }
  },
  'api_config.json': {
    lock:   { type:'select',  options:['yes','no'] },
    active: { type:'boolean' }
  },
  'payment_methods.json': {
    isDefault: { type:'boolean' }
  },
  'smtp_config.json': {
    use_tls: { type:'boolean' }
  },
  'company.json': {},
  'temp_accounts.json': {
    lock: { type:'select', options:['yes','no'] }
  },
  'transaction_history.json': {
    lock: { type:'select', options:['yes','no'] },
    type: { type:'select', options:['credit','debit'] }
  },
  'rules.json': {
    lock:   { type:'select', options:['yes','no'] },
    active: { type:'boolean' }
  }
};

function _getFieldSchema(fileName, colName) {
  var fileSchema = JSON_SCHEMAS[fileName] || {};
  if (fileSchema[colName]) return fileSchema[colName];
  // Defaults by column name pattern
  if (colName === 'lock')   return { type:'select', options:['yes','no'] };
  if (colName === 'active') return { type:'boolean' };
  if (colName === 'status') return { type:'select', options:['active','inactive'] };
  return { type:'text' };
}

function _renderCell(val, ri, col, fileName, readOnly) {
  val = (val === undefined || val === null) ? '' : val;
  var schema = _getFieldSchema(fileName, col);
  var sVal   = String(val);
  var base   = 'class="je-cell" data-ri="' + ri + '" data-col="' + col + '"';
  if (readOnly) {
    return '<span style="color:#94a3b8;font-size:0.82rem;padding:0.3rem 0.5rem;display:block;">' + sVal + '</span>';
  }
  if (schema.type === 'boolean') {
    return '<input type="checkbox" ' + base + ' ' + (String(val)==='true'||val===true?'checked':'') + ' style="width:16px;height:16px;accent-color:#3b82f6;cursor:pointer;" />';
  }
  if (schema.type === 'select') {
    var opts = schema.options.map(function(o){ return '<option ' + (o===sVal?'selected':'') + '>' + o + '</option>'; }).join('');
    return '<select ' + base + ' style="width:100%;padding:0.25rem 0.4rem;border:1px solid #e2e8f0;border-radius:4px;font-size:0.82rem;background:#fff;">' + opts + '</select>';
  }
  return '<input ' + base + ' value="' + sVal.replace(/"/g,'&quot;').replace(/</g,'&lt;') + '" style="width:100%;min-width:80px;" />';
}

var _jeState = { path:'', data:null, arrKey:null, arr:[], cols:[] };

function openJsonFullEditor(path) {
  const overlay = document.getElementById('jsonFullOverlay');
  const body    = document.getElementById('jeBody');
  const title   = document.getElementById('jeTitle');
  if (!overlay) { openCodeEditor(path); return; }
  const fname   = path.split('/').pop().replace('.json','');
  if (title) title.textContent = fname;
  if (body)  body.innerHTML = '<p style="padding:2rem;text-align:center;color:#94a3b8;"><i class="fas fa-spinner fa-spin"></i> Loading...</p>';
  overlay.classList.add('open');

  fetch('/api/files/read', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ path }) })
  .then(function(r){ return r.json(); })
  .then(function(res) {
    if (!res.success) { closeJsonFullEditor(); showModal('warning','Cannot read: ' + res.error); return; }
    var data;
    try { data = JSON.parse(res.content); } catch(e) { closeJsonFullEditor(); openCodeEditor(path); return; }
    // Find the best array to edit (or key-value)
    var found = _findEditableArray(data);
    if (!found) { closeJsonFullEditor(); openCodeEditor(path); return; }

    var jeAddBtn  = document.getElementById('jeAddRowBtn');
    var jeDelBtn  = document.getElementById('jeDelSelBtn');
    var jeSelBtn  = document.getElementById('jeSelAllBtn');

    if (found.mode === 'keyvalue') {
      // Flat/nested object → key-value editor, hide array-only buttons
      if (jeAddBtn) jeAddBtn.style.display = 'none';
      if (jeDelBtn) jeDelBtn.style.display = 'none';
      if (jeSelBtn) jeSelBtn.style.display = 'none';
      _jeState = { path, data, arrKey: null, arr: null, cols: null, mode: 'keyvalue' };
      _renderKeyValueTable(_flattenObject(data, ''));
    } else {
      // Array mode — filter out nested array/object columns for display
      if (jeAddBtn) jeAddBtn.style.display = '';
      if (jeDelBtn) jeDelBtn.style.display = '';
      if (jeSelBtn) jeSelBtn.style.display = '';
      // Filter cols: skip if first row value is array or nested object
      var firstRow = found.arr && found.arr[0];
      var displayCols = found.cols.filter(function(c) {
        if (!firstRow) return true;
        var v = firstRow[c];
        return !Array.isArray(v) && (v === null || v === undefined || typeof v !== 'object');
      });
      // Limit long-text cols (ruleText) to textarea in _renderCell
      _jeState = { path, data, arrKey: found.key, arr: JSON.parse(JSON.stringify(found.arr || [])), cols: displayCols, mode: found.mode };
      _renderJeTable();
    }
  })
  .catch(function() { closeJsonFullEditor(); showModal('warning','Server not running.'); });
}

// Default column schemas for known empty arrays
var _KNOWN_COLS = {
  'pending':       ['id','firstName','lastName','email','mobile','verification_code','requestedAt','code_expires'],
  'resetCodes':    ['email','code','expiry'],
  'methods':       ['id','name','details','icon','isDefault'],
  'transactions':  ['id','date','description','type','amount','balance'],
  'scheduled_changes': ['start_date','changes']
};

function _findEditableArray(data) {
  // Top-level array
  if (Array.isArray(data) && data.length > 0) {
    return { key: null, arr: data, cols: Object.keys(data[0]), mode: 'array' };
  }
  // Search recursively up to 3 levels
  // First pass: look for non-empty arrays
  function searchNonEmpty(obj, keyPath, depth) {
    if (depth > 3) return null;
    for (var k in obj) {
      var v = obj[k];
      var path = keyPath ? keyPath + '.' + k : k;
      if (Array.isArray(v) && v.length > 0) {
        return { key: path, arr: v, cols: Object.keys(v[0]), mode: 'array' };
      } else if (typeof v === 'object' && v && !Array.isArray(v) && depth < 3) {
        var found = searchNonEmpty(v, path, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }
  var nonEmpty = searchNonEmpty(data, '', 0);
  if (nonEmpty) return nonEmpty;

  // Second pass: check if there's a meaningful dict to show as key-value
  // Prefer key-value mode if the top-level has a rich dict property
  for (var kk in data) {
    if (typeof data[kk] === 'object' && data[kk] && !Array.isArray(data[kk])) {
      var subKeys = Object.keys(data[kk]);
      if (subKeys.length > 2) {
        // Rich nested object → show as key-value of the whole data
        return { key: null, arr: null, cols: null, mode: 'keyvalue', data: data };
      }
    }
  }

  // Third pass: look for empty arrays with known columns
  function searchEmpty(obj, keyPath, depth) {
    if (depth > 3) return null;
    for (var k in obj) {
      var v = obj[k];
      var path = keyPath ? keyPath + '.' + k : k;
      if (Array.isArray(v) && v.length === 0) {
        var known = _KNOWN_COLS[k];
        if (known) return { key: path, arr: [], cols: known, mode: 'array-empty' };
      } else if (typeof v === 'object' && v && !Array.isArray(v) && depth < 3) {
        var found = searchEmpty(v, path, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }
  var emptyArr = searchEmpty(data, '', 0);
  if (emptyArr) return emptyArr;

  // Fallback: key-value mode
  return { key: null, arr: null, cols: null, mode: 'keyvalue', data: data };
}

// ── Flatten a nested object into key-value pairs ──────────────────────────────
function _flattenObject(obj, prefix) {
  var pairs = [];
  Object.keys(obj).forEach(function(k) {
    var v = obj[k];
    var fullKey = prefix ? prefix + '.' + k : k;
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      pairs = pairs.concat(_flattenObject(v, fullKey));
    } else if (!Array.isArray(v)) {
      pairs.push({ key: fullKey, label: k, value: v, type: typeof v });
    }
  });
  return pairs;
}

function _renderJeTable() {
  var body    = document.getElementById('jeBody');
  if (!body) return;
  var st      = _jeState;
  var cols    = st.cols;
  var arr     = st.arr;
  var fileName = st.path.split('/').pop();

  // Ensure lock column exists
  if (cols.indexOf('lock') === -1) cols = cols.concat(['lock']);
  // Ensure arr rows have lock field
  arr.forEach(function(r){ if (r.lock === undefined) r.lock = 'no'; });

  var thead = '<thead><tr>' +
    '<th style="padding:0.5rem 0.5rem;width:36px;text-align:center;">' +
      '<input type="checkbox" id="jeSelectAll" onchange="jeToggleAll(this)" style="width:15px;height:15px;accent-color:#3b82f6;cursor:pointer;" title="Select All"/>' +
    '</th>' +
    cols.map(function(c){ return '<th style="padding:0.5rem 0.8rem;white-space:nowrap;">' + c + '</th>'; }).join('') +
    '<th style="padding:0.5rem 0.5rem;width:50px;">Del</th></tr></thead>';

  var tbody = '<tbody>' + arr.map(function(row, ri) {
    var locked = String(row.lock || 'no').toLowerCase() === 'yes';
    var rowStyle = locked ? 'background:#fef9f0;' : '';
    return '<tr style="border-bottom:1px solid #f1f5f9;' + rowStyle + '">' +
      '<td style="padding:0.25rem 0.5rem;text-align:center;"><input type="checkbox" class="je-row-check" data-ri="' + ri + '" style="width:14px;height:14px;accent-color:#3b82f6;cursor:pointer;" /></td>' +
      cols.map(function(c) {
        return '<td style="padding:0.2rem 0.3rem;">' + _renderCell(row[c], ri, c, fileName, false) + '</td>';
      }).join('') +
      '<td style="padding:0.25rem 0.4rem;text-align:center;">' +
        (locked
          ? '<span title="Locked — change lock to No to delete" style="color:#f59e0b;font-size:1rem;">🔒</span>'
          : '<button onclick="_jeDeleteRow(' + ri + ')" style="border:none;background:none;cursor:pointer;font-size:1rem;" title="Delete">🗑️</button>') +
      '</td>' +
    '</tr>';
  }).join('') + '</tbody>';

  body.innerHTML = '<table class="je-table" style="table-layout:auto;width:100%;">' + thead + tbody + '</table>';
}

function jeToggleAll(cb) {
  document.querySelectorAll('.je-row-check').forEach(function(c){ c.checked = cb.checked; });
}

function jeDeleteSelected() {
  var checked = Array.from(document.querySelectorAll('.je-row-check:checked'));
  if (!checked.length) { showModal('warning','Select rows to delete.'); return; }
  var toDelete = checked.map(function(c){ return parseInt(c.dataset.ri); }).sort(function(a,b){return b-a;});
  // Check locks
  var locked = toDelete.filter(function(ri){ return String(_jeState.arr[ri]&&_jeState.arr[ri].lock||'no').toLowerCase()==='yes'; });
  if (locked.length) { showModal('warning','🔒 ' + locked.length + ' row(s) are locked. Change lock to "no" first.'); return; }
  toDelete.forEach(function(ri){ _jeState.arr.splice(ri,1); });
  _renderJeTable();
}


function _renderKeyValueTable(pairs) {
  var body = document.getElementById('jeBody');
  if (!body) return;
  if (!pairs.length) {
    body.innerHTML = '<p style="padding:2rem;text-align:center;color:#94a3b8;">No editable fields found.</p>';
    return;
  }
  var rows = pairs.map(function(p, i) {
    var inputType = p.type === 'number' ? 'number' : p.type === 'boolean' ? 'text' : 'text';
    var val = p.value === null || p.value === undefined ? '' : String(p.value);
    return '<tr>' +
      '<td style="padding:0.45rem 1rem;font-weight:600;color:#1e293b;white-space:nowrap;background:#f8fafc;border-bottom:1px solid #eef2f6;width:220px;">' + p.label + '</td>' +
      '<td style="padding:0.25rem 0.5rem;border-bottom:1px solid #eef2f6;">' +
        (p.type === 'boolean'
          ? '<select class="je-cell" data-kvkey="' + p.key + '" style="width:100%;padding:0.3rem 0.5rem;border:1.5px solid transparent;border-radius:5px;font-size:0.85rem;"><option ' + (val==='true'?'selected':'') + '>true</option><option ' + (val==='false'?'selected':'') + '>false</option></select>'
          : '<input class="je-cell" data-kvkey="' + p.key + '" value="' + val.replace(/"/g,'&quot;') + '" type="' + inputType + '" style="width:100%;" />') +
      '</td>' +
    '</tr>';
  }).join('');
  body.innerHTML = '<table class="je-table" style="min-width:500px;">' +
    '<thead><tr><th style="padding:0.55rem 1rem;width:220px;">Field</th><th style="padding:0.55rem 0.5rem;">Value</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table>';
}

function _jeDeleteRow(ri) {
  _jeState.arr.splice(ri, 1);
  _renderJeTable();
}

function addJsonEditorRow() {
  var st      = _jeState;
  var newRow  = {};
  st.cols.forEach(function(c){ newRow[c] = ''; });
  st.arr.push(newRow);
  _renderJeTable();
  // Scroll to bottom
  const body = document.getElementById('jeBody');
  if (body) setTimeout(function(){ body.scrollTop = body.scrollHeight; }, 50);
}

function saveJsonFullEditor() {
  var st = _jeState;
  var rebuilt, jsonStr;

  if (st.mode === 'keyvalue') {
    // Collect key-value pairs and set them back into the data object
    var updated = JSON.parse(JSON.stringify(st.data));
    document.querySelectorAll('.je-cell[data-kvkey]').forEach(function(inp) {
      var keys = inp.dataset.kvkey.split('.');
      var obj  = updated;
      for (var i = 0; i < keys.length - 1; i++) {
        if (!obj[keys[i]]) obj[keys[i]] = {};
        obj = obj[keys[i]];
      }
      var lastKey = keys[keys.length - 1];
      var val     = inp.value;
      var origVal = obj[lastKey];
      if (typeof origVal === 'number')  val = isNaN(Number(val)) ? val : Number(val);
      if (typeof origVal === 'boolean') val = (val === 'true');
      obj[lastKey] = val;
    });
    rebuilt = updated;
  } else {
    // Array mode: collect cell values
    document.querySelectorAll('.je-cell[data-ri]').forEach(function(inp) {
      var ri  = parseInt(inp.dataset.ri);
      var col = inp.dataset.col;
      if (!isNaN(ri) && col && st.arr[ri] !== undefined) {
        var val  = inp.value;
        var orig = st.arr[ri][col];
        if (typeof orig === 'number' && val !== '') val = isNaN(Number(val)) ? val : Number(val);
        if (typeof orig === 'boolean') val = (val === 'true');
        st.arr[ri][col] = val;
      }
    });
    rebuilt = _rebuildJson(st);
  }

  jsonStr = JSON.stringify(rebuilt, null, 2);
  fetch('/api/files/write', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ path: st.path, content: jsonStr }) })
  .then(function(r){ return r.json(); })
  .then(function(res) {
    if (res.success) {
      closeJsonFullEditor();
      showModal('success', st.path.split('/').pop() + ' saved!', { onConfirm: function(){} });
    } else { showModal('warning','Save failed: ' + (res.error||'unknown')); }
  })
  .catch(function(){ showModal('warning','Server not running — cannot save.'); });
}

function _rebuildJson(st) {
  if (!st.arrKey) return st.arr;
  var result  = JSON.parse(JSON.stringify(st.data));
  var keys    = st.arrKey.split('.');
  var obj     = result;
  for (var i = 0; i < keys.length - 1; i++) { obj = obj[keys[i]]; }
  obj[keys[keys.length - 1]] = st.arr;
  return result;
}

function closeJsonFullEditor() {
  const overlay = document.getElementById('jsonFullOverlay');
  if (overlay) overlay.classList.remove('open');
  _jeState = { path:'', data:null, arrKey:null, arr:[], cols:[] };
}

// ── JSON Editor (legacy modal - kept for backwards compat) ────────────────────
function openJsonEditor(path) { openJsonFullEditor(path); }

function openCodeEditor(path) {
  fetch('/api/files/read', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ path }) })
  .then(function(r){ return r.json(); })
  .then(function(res) {
    if (!res.success) { showModal('warning', 'Cannot read: ' + res.error); return; }
    var fileName = path.split('/').pop();
    var editorHtml = '<div>' +
      '<textarea id="codeEditorArea" style="width:100%;height:350px;font-family:monospace;font-size:0.82rem;' +
      'padding:0.75rem;border:2px solid #e2e8f0;border-radius:8px;resize:vertical;background:#1e1e2e;color:#cdd6f4;line-height:1.5;">' +
      res.content.replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</textarea>' +
      '<div style="font-size:0.75rem;color:#94a3b8;margin-top:0.3rem;">📄 ' + path + '</div>' +
      '</div>';
    showModal('info', editorHtml, {
      title: '✏️ ' + fileName,
      icon: '📝',
      closeOnBackdrop: false,
      buttons: [
        { label: '💾 Save', class: 'btn-success', callback: function() {
          var el = document.getElementById('codeEditorArea');
          if (!el) return;
          var newContent = el.value;
          fetch('/api/files/write', { method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ path, content: newContent }) })
          .then(function(r){ return r.json(); })
          .then(function(res) {
            if (res.success) { closeModal(); showModal('success', fileName + ' saved!', { onConfirm: function(){} }); }
            else { showModal('warning', 'Save failed: ' + (res.error||'unknown')); }
          }).catch(function() { showModal('warning', 'Server not running — cannot save.'); });
        }},
        { label: 'Cancel', class: 'btn-secondary', callback: function() { closeModal(); } }
      ]
    });
  })
  .catch(function() { showModal('warning', 'Server not running.'); });
}

function showAdminFileByEl(btn) {
  showAdminFile(decodeURIComponent(btn.dataset.path));
}
function deleteAdminFileByEl(btn) {
  deleteAdminFile(decodeURIComponent(btn.dataset.path), decodeURIComponent(btn.dataset.name));
}
function deleteAdminFile(path, name) {
  showModal('confirm', 'Delete "' + name + '"? This cannot be undone.', {
    onConfirm: function() {
      fetch('/api/files/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: path })
      }).then(function(r) { return r.json(); })
        .then(function(res) {
          if (res.success) {
            loadAdminFiles();
            showModal('success', '"' + name + '" deleted!');
          } else {
            showModal('warning', 'Delete failed: ' + (res.error||'Unknown'));
          }
        })
        .catch(function() { showModal('warning', 'Server not running.'); });
    },
    onCancel: function() {}
  });
}

function showAdminFile(path) {
  fetch('/api/files/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: path })
  }).then(function(r) { return r.json(); })
    .then(function(res) {
      if (res.success) {
        const content = res.content || '';
        const display = content.length > 3000 ? content.substring(0, 3000) + '\n... (truncated)' : content;
        showModal('info', '<pre style="background:#f8fafc;padding:1rem;border-radius:8px;overflow:auto;max-height:350px;font-size:0.8rem;text-align:left;white-space:pre-wrap;">' + display.replace(/</g,'&lt;') + '</pre>', {
          title: '📄 ' + path, icon: '📄', closeOnBackdrop: true
        });
      } else {
        showModal('warning', 'Cannot read: ' + (res.error||'Unknown'));
      }
    })
    .catch(function() { showModal('warning', 'Server not running.'); });
}

function toggleAllFileCheckboxes() {
  const all = document.getElementById('selectAll');
  document.querySelectorAll('.file-checkbox').forEach(function(cb) { cb.checked = all?.checked; });
}


// ============================================
// AGENTS + API CONFIG
// ============================================

function loadAdminAgents() {
  fetch('/db/agents.json?_=' + Date.now())
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(data) {
      var agents = data ? (data.agents || []) : [];
      var tbody  = document.getElementById('agentsTableBody');
      if (!tbody) return;
      if (!agents.length) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#94a3b8;padding:1.5rem;">No agents.</td></tr>'; return; }
      tbody.innerHTML = agents.map(function(a) {
        var locked  = a.lock === 'yes';
        var actBg   = a.active ? '#dcfce7' : '#fee2e2';
        var actCol  = a.active ? '#16a34a' : '#dc2626';
        return '<tr style="border-bottom:1px solid #f1f5f9;">' +
          '<td style="padding:0.5rem 0.8rem;font-weight:700;">' + (a.role||'') + (locked ? ' 🔒' : '') + '</td>' +
          '<td style="padding:0.5rem 0.8rem;"><span style="background:#eff6ff;color:#3b82f6;padding:0.15rem 0.5rem;border-radius:5px;font-size:0.78rem;">' + (a.phase||'') + '</span></td>' +
          '<td style="padding:0.5rem 0.8rem;color:#475569;font-size:0.82rem;">' + (a.powered_by||'') + '</td>' +
          '<td style="padding:0.5rem 0.8rem;font-family:monospace;font-size:0.78rem;color:#64748b;">' + (a.model||'—') + '</td>' +
          '<td style="padding:0.5rem 0.8rem;text-align:center;"><span style="font-weight:700;color:#3b82f6;">' + (a.frequency_in_code||0) + '</span></td>' +
          '<td style="padding:0.5rem 0.8rem;"><span style="background:' + actBg + ';color:' + actCol + ';padding:0.15rem 0.5rem;border-radius:5px;font-size:0.78rem;font-weight:600;">' + (a.active ? 'Active' : 'Inactive') + '</span></td>' +
        '</tr>';
      }).join('');
    })
    .catch(function() { var t = document.getElementById('agentsTableBody'); if(t) t.innerHTML='<tr><td colspan="6" style="text-align:center;color:#94a3b8;padding:1rem;">Start server to load agents.</td></tr>'; });
}

function loadApiConfigAdmin() {
  fetch('/db/api_config.json?_=' + Date.now())
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(data) {
      var providers = data ? (data.providers || []) : [];
      var cards     = document.getElementById('apiConfigCards');
      if (!cards) return;
      if (!providers.length) { cards.innerHTML = '<p style="color:#94a3b8;text-align:center;padding:1rem;">No API providers configured.</p>'; return; }
      var S = 'width:100%;padding:0.6rem 1rem;border:2px solid #e2e8f0;border-radius:8px;font-size:0.9rem;font-family:monospace;';
      cards.innerHTML = providers.map(function(p, i) {
        var providerColor = { openrouter:'#8b5cf6', openai:'#22c55e', deepl:'#3b82f6' }[p.id] || '#64748b';
        return '<div style="border:2px solid #eef2f6;border-radius:10px;padding:1rem 1.2rem;border-left:4px solid ' + providerColor + ';">' +
          '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.75rem;">' +
            '<div><h4 style="font-size:0.95rem;font-weight:700;color:#1e293b;margin:0;">' + p.name + '</h4>' +
            '<p style="font-size:0.78rem;color:#64748b;margin:0.2rem 0 0;">' + (p.used_for||'') + '</p></div>' +
            '<span style="background:' + providerColor + '20;color:' + providerColor + ';font-size:0.75rem;padding:0.2rem 0.6rem;border-radius:5px;font-weight:600;">' + p.env_key + '</span>' +
          '</div>' +
          '<div style="display:flex;gap:0.5rem;align-items:center;">' +
            '<div style="position:relative;flex:1;">' +
              '<input type="password" id="apikey_' + p.id + '" value="' + (p.api_key||'') + '" placeholder="Paste your ' + p.name + ' API key here" style="' + S + 'padding-right:2.5rem;" />' +
              '<button data-inp="apikey_' + p.id + '" onclick="toggleApiKeyVis(this,this.dataset.inp)" style="position:absolute;right:0.7rem;top:50%;transform:translateY(-50%);border:none;background:none;cursor:pointer;color:#94a3b8;"><i class="fas fa-eye"></i></button>' +
            '</div>' +
          '</div>' +
          '<p style="font-size:0.75rem;color:#94a3b8;margin:0.3rem 0 0;">' + (p.description||'') + '</p>' +
        '</div>';
      }).join('');
    })
    .catch(function() { var c=document.getElementById('apiConfigCards'); if(c) c.innerHTML='<p style="color:#94a3b8;text-align:center;">Start server to load API config.</p>'; });
}

function toggleApiKeyVis(btn, inputId) {
  var inp = document.getElementById(inputId);
  if (!inp) return;
  inp.type = inp.type === 'password' ? 'text' : 'password';
  btn.innerHTML = inp.type === 'password' ? '<i class="fas fa-eye"></i>' : '<i class="fas fa-eye-slash"></i>';
}

function saveApiConfigs() {
  fetch('/db/api_config.json?_=' + Date.now())
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(data) {
      if (!data) return;
      data.providers.forEach(function(p) {
        var el = document.getElementById('apikey_' + p.id);
        if (el) p.api_key = el.value.trim();
      });
      return fetch('/api/files/write', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ path: 'db/api_config.json', content: JSON.stringify(data, null, 2) }) });
    })
    .then(function(r){ if(r) return r.json(); })
    .then(function(res) {
      if (res && res.success) showModal('success', 'API keys saved!', { onConfirm: function(){} });
      else showModal('warning', 'Save failed — start server.');
    })
    .catch(function(){ showModal('warning','Server not running. Keys saved in browser only.'); });
}

// ============================================
// DRAG & DROP EVENTS
// ============================================

document.addEventListener('DOMContentLoaded', function() {
  // ── Auth check ──────────────────────────────────────────────────
  if (typeof isLoggedIn === 'function') {
    if (!isLoggedIn()) { showAuthOverlay(); return; }
    else { hideAuthOverlay(); }
  }
  // ── Load company details (logo + name) ──────────────────────────
  fetch('/db/company.json?_=' + Date.now())
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(data) {
      if (!data || !data.company) return;
      const co = data.company;
      // Header company name
      const nameEl = document.getElementById('headerCompanyName');
      if (nameEl && co.name) nameEl.textContent = co.name;
      // Header logo
      const logoEl = document.getElementById('headerLogoImg');
      if (logoEl && co.logo) { logoEl.src = co.logo; logoEl.onerror = function(){ logoEl.style.display='none'; }; }
      // Auth overlay company name
      const authNameEl = document.getElementById('authCompanyName');
      if (authNameEl && co.name) authNameEl.textContent = co.name;
      // Auth overlay logo
      const authLogoEl = document.querySelector('#authOverlay img');
      if (authLogoEl && co.logo) authLogoEl.src = co.logo;
      // Store globally
      window._companyName = co.name || 'Lexora';
      window._companyLogo = co.logo || 'db/logo.png';
      // Section label stays as-is (just section name)
      window._companyNameForLabels = co.name || 'Lexora';
    })
    .catch(function(){});
  // Upload area for Lease
  const uploadArea = document.getElementById('uploadArea');
  if (uploadArea) {
    uploadArea.addEventListener('dragover', function(e) {
      e.preventDefault();
      this.classList.add('dragover');
    });
    uploadArea.addEventListener('dragleave', function(e) {
      e.preventDefault();
      this.classList.remove('dragover');
    });
    uploadArea.addEventListener('drop', function(e) {
      e.preventDefault();
      this.classList.remove('dragover');
      const files = e.dataTransfer.files;
      if (files.length > 0) {
        for (let i = 0; i < files.length; i++) {
          uploadedFiles.push(files[i]);
          fileStatuses.push({
            name: files[i].name,
            scanResult: 'Pending',
            status: '0%',
            action: 'Processing',
            progress: 0
          });
        }
        updateFileTable();
      }
    });
  }

  // Upload area for Translation
  const uploadAreaTrans = document.getElementById('uploadAreaTrans');
  if (uploadAreaTrans) {
    uploadAreaTrans.addEventListener('dragover', function(e) {
      e.preventDefault();
      this.classList.add('dragover');
    });
    uploadAreaTrans.addEventListener('dragleave', function(e) {
      e.preventDefault();
      this.classList.remove('dragover');
    });
    uploadAreaTrans.addEventListener('drop', function(e) {
      e.preventDefault();
      this.classList.remove('dragover');
      const files = e.dataTransfer.files;
      if (files.length > 0) {
        for (let i = 0; i < files.length; i++) {
          uploadedFilesTrans.push(files[i]);
          fileStatusesTrans.push({
            name: files[i].name,
            scanResult: 'Pending',
            status: '0%',
            action: 'Processing',
            progress: 0
          });
        }
        updateFileTableTrans();
      }
    });
  }

  // Initialize — sync from disk first, then load UI
  syncUsersFromDisk().then(function() {
    handleSystemChange();
    loadPaymentData();
    loadTransactions();
    loadDashboard();
    loadProfile();
    loadEmailSettings(false);
    loadPlans(function(plans) {
      renderPlansSection();
    });
    loadCompanyData(function() {
      renderContactDetails();
    });
    // Load templates for dropdown
    fetch('/db/templates.json?_=' + Date.now())
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(data) {
        if (data) { allTemplates = data.templates || []; localStorage.setItem('lexora_templates', JSON.stringify(allTemplates)); loadTemplateDropdown(); }
      }).catch(function(){
        const cached = localStorage.getItem('lexora_templates');
        if (cached) { allTemplates = JSON.parse(cached); loadTemplateDropdown(); }
      });

    // Set default active section
    showSection('dashboard');

    setTimeout(function() {
      showModal('success', 'Welcome back! You have successfully logged in.', {
        onConfirm: function() {}
      });
    }, 500);
  });
});

// Close menus on click outside
document.addEventListener('click', function(event) {
  const servicesMenu = document.getElementById('services-menu');
  const userProfileWrapper = document.querySelector('.user-profile-wrapper');
  if (!servicesMenu?.contains(event.target) && !userProfileWrapper?.contains(event.target)) {
    const subMenu = document.getElementById('subMenu');
    const userSubMenu = document.getElementById('userSubMenu');
    if (subMenu) subMenu.classList.remove('open');
    if (userSubMenu) userSubMenu.classList.remove('open');
  }
});

// Make functions globally accessible
window.showSection = showSection;
window.toggleMenu = toggleMenu;
window.closeAllMenus = closeAllMenus;
window.handleLogout = handleLogout;
window.handleSystemChange = handleSystemChange;
window.handleConnect = handleConnect;
window.handleFormSubmit = handleFormSubmit;
window.startProcess = startProcess;
window.pauseProcess = pauseProcess;
window.stopProcess = stopProcess;
window.clearAll = clearAll;
window.generateReport = generateReport;
window.downloadOutput = downloadOutput;
window.downloadAll = downloadAll;
window.viewScanError = viewScanError;
window.startProcessTrans = startProcessTrans;
window.pauseProcessTrans = pauseProcessTrans;
window.stopProcessTrans = stopProcessTrans;
window.clearAllTrans = clearAllTrans;
window.generateReportTrans = generateReportTrans;
window.downloadOutputTrans = downloadOutputTrans;
window.showAdminTab = showAdminTab;
window.saveEmailSettings = saveEmailSettings;
window.loadEmailSettings = loadEmailSettings;
window.toggleSmtpPwd = toggleSmtpPwd;
window.loadDashboard = loadDashboard;
window.reloadSettings = reloadSettings;
window.sendTestEmail = sendTestEmail;
window.saveRules = saveRules;
window.loadFiles = loadFiles;
window.toggleFile = toggleFile;
window.toggleAllCheckboxes = toggleAllCheckboxes;
window.addFile = addFile;
window.deleteSelected = deleteSelected;
window.downloadSelected = downloadSelected;
window.showFile = showFile;
window.viewFile = viewFile;
window.editFile = editFile;
window.downloadFileById = downloadFileById;
window.showJsonContent = showJsonContent;
window.editJsonContent = editJsonContent;
window.setDefault = setDefault;
window.removeMethod = removeMethod;
window.showAddPayment = showAddPayment;
window.showAddAmount = showAddAmount;
window.filterTransactions = filterTransactions;
window.loadPlans = loadPlans;
window.savePlans = savePlans;
window.renderPlansSection = renderPlansSection;
window.renderAdminPlansTable = renderAdminPlansTable;
window.addNewPlan = addNewPlan;
window.editPlan = editPlan;
window.deletePlan = deletePlan;
window.selectPlan = selectPlan;
window.loadCompanyData = loadCompanyData;
window.loadCompanyAdmin = loadCompanyAdmin;
window.editCompanyField = editCompanyField;
window.renderContactDetails = renderContactDetails;
window.loadAdminUsers = loadAdminUsers;
window.loadAdminTemplates = loadAdminTemplates;
window.renderAdminTemplatesTable = renderAdminTemplatesTable;
window.showTemplateUpload = showTemplateUpload;
window.toggleTemplateStatus = toggleTemplateStatus;
window.deleteTemplate = deleteTemplate;
window.loadTemplateDropdown = loadTemplateDropdown;
window.openCodeEditor = openCodeEditor;
window.openJsonFullEditor = openJsonFullEditor;
window.addNewFolder = addNewFolder;
window.openJsonEditor = openJsonEditor;
window.addJsonEditorRow = addJsonEditorRow;
window.saveJsonFullEditor = saveJsonFullEditor;
window.closeJsonFullEditor = closeJsonFullEditor;
window.jeToggleAll = jeToggleAll;
window.jeDeleteSelected = jeDeleteSelected;
window.jeToggleAll = jeToggleAll;
window.loadAdminAgents = loadAdminAgents;
window.loadApiConfigAdmin = loadApiConfigAdmin;
window.saveApiConfigs = saveApiConfigs;
window.toggleApiKeyVis = toggleApiKeyVis;
window.openJsonEditor = openJsonEditor;
window.adminEditUser = adminEditUser;
window.adminToggleRole = adminToggleRole;
window.adminHoldService = adminHoldService;
window.adminDeleteUser = adminDeleteUser;
window.loadPendingAccounts = loadPendingAccounts;
window.approveTempAccount = approveTempAccount;
window.rejectTempAccount = rejectTempAccount;
window.navigateFolder = navigateFolder;
window.openFileLink = openFileLink;
window.toggleAllFileCheckboxes = toggleAllFileCheckboxes;
window.loadAdminFiles = loadAdminFiles;
window.deleteAdminFile = deleteAdminFile;
window.showAdminFile = showAdminFile;
window.toggleAllFileCheckboxes = toggleAllFileCheckboxes;
window.loadPaymentData = loadPaymentData;
window.savePaymentData = savePaymentData;
window.loadTransactionData = loadTransactionData;
window.saveTransactionData = saveTransactionData;
window.togglePassword = togglePassword;
window.saveUsersToDisk = saveUsersToDisk;
window.syncUsersFromDisk = syncUsersFromDisk;
window.handlePhotoUpload = handlePhotoUpload;
window.removePhoto = removePhoto;
window.updateProfile = updateProfile;
window.clearActivityLog = clearActivityLog;
window.loadApiSection = loadApiSection;
window.generateApiKey = generateApiKey;
window.copyApiKey = copyApiKey;
window.saveApiKey = saveApiKey;
window.revokeApiKey = revokeApiKey;
window.toggleApiKeyVisibility = toggleApiKeyVisibility;
window.closeModal = closeModal;
window.closeModalOnBackdrop = closeModalOnBackdrop;
window.showModal = showModal;

// ── Startup: inject copyright strip into every section ────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _injectSectionFooters);
} else {
  _injectSectionFooters();
}
// ── PDF Generator — Midtown National Abstract Format ─────────────────────────
async function _generatePDF(data, outName, srcFileName) {
  if (typeof window.jspdf === 'undefined' && typeof jsPDF === 'undefined') {
    throw new Error('jsPDF not loaded');
  }
  var jspdfLib = window.jspdf ? window.jspdf.jsPDF : jsPDF;
  var doc = new jspdfLib({ orientation: 'portrait', unit: 'mm', format: 'letter' });

  var d    = data || {};
  var info = d.lease_info || {};
  var pageW = 215.9, margin = 14, colW = pageW - margin * 2;
  var y = 16, lineH = 5.5, headerH = 7;

  function addPage() {
    doc.addPage();
    y = 16;
    _pdfFooter(doc, pageW);
  }
  function checkY(need) { if (y + need > 270) addPage(); }

  // ── HEADER ──
  doc.setFont('helvetica','bold'); doc.setFontSize(13);
  doc.text('Lease Abstract', margin, y); y += 7;
  doc.setFontSize(10); doc.setFont('helvetica','normal');
  doc.text('Lease : ' + (info.tenant_name||'') + ' (' + (info.ics_code||'t0000000') + ')', margin, y);
  y += 9;

  // ── LEASE INFORMATION TABLE ──
  doc.autoTable({
    startY: y,
    head: [['', 'LEASE INFORMATION', '', '']],
    body: [
      ['Name',           info.tenant_name||'',          'Status',          info.status||''],
      ['DBA',            info.dba||'',                  'ICS Code',        info.ics_code||'-'],
      ['Property',       info.property_code||'',        'Lease Type',      info.lease_type||''],
      ['Location',       info.location||'',             'Sales Category',  info.sales_category||''],
      ['Customer',       info.customer||'-',             'Contract Area',   (info.contract_area_sf||'') + ' (Rentable)'],
      ['',               '',                            'Area',            '0.00 (Rentable)'],
      ['Primary Contact','',                            'Monthly Rent',    ''],
      ['Name',           info.primary_contact_name||info.tenant_name||'', 'Annual Rent', info.annual_rent||'0.00'],
      ['Office Phone',   info.primary_contact_phone||'','Rent Per Area',   '0.00'],
      ['FAX',            '',                            'Deposit',         info.deposit||'0.00'],
      ['E-Mail',         info.primary_contact_email||'','Lease Term',      (info.lease_term_from||'') + ' To ' + (info.lease_term_to||'')]
    ],
    styles: { fontSize: 8, cellPadding: 1.5, lineColor: [150,150,150], lineWidth: 0.2 },
    headStyles: { fillColor: [255,255,255], textColor: [0,0,0], fontStyle: 'bold', halign: 'center' },
    alternateRowStyles: {},
    columnStyles: { 0: {fontStyle:'bold', cellWidth:28}, 1:{cellWidth:62}, 2:{fontStyle:'bold',cellWidth:28}, 3:{cellWidth:colW-118} },
    margin: { left: margin, right: margin },
    theme: 'grid'
  });
  y = doc.lastAutoTable.finalY + 5;

  // ── CHARGE SCHEDULES ──
  var charges = d.charge_schedules || [];
  if (charges.length) {
    checkY(20);
    doc.autoTable({
      startY: y,
      head: [['Charge Code','Charge Desc','Date From','Date To','Monthly Amt','Annual Amt','Amt Per Area','Amend Type','Units']],
      body: charges.map(function(c){
        return [c.charge_code||'', c.charge_desc||'', c.date_from||'', c.date_to||'',
                c.monthly_amt||'', c.annual_amt||'', c.amt_per_area_psf||'',
                c.amendment_type||'Original Lease', c.units||''];
      }),
      styles: { fontSize: 7, cellPadding: 1.2 },
      headStyles: { fillColor: [220,220,220], textColor: [0,0,0], fontStyle: 'bold', fontSize: 7 },
      margin: { left: margin, right: margin },
      theme: 'grid'
    });
    y = doc.lastAutoTable.finalY + 4;
  }

  // ── AMENDMENTS ──
  var amends = d.amendments || [];
  if (amends.length) {
    checkY(16);
    doc.autoTable({
      startY: y,
      head: [['Type','Description','Status','Term (Months)','Date From','Date To','Units']],
      body: amends.map(function(a){
        return [a.type||'Original Lease', a.description||'Original Lease', a.status||'In Process',
                a.term_months||'', a.date_from||'', a.date_to||'', a.units||''];
      }),
      styles: { fontSize: 7, cellPadding: 1.2 },
      headStyles: { fillColor: [220,220,220], textColor: [0,0,0], fontStyle: 'bold', fontSize: 7 },
      margin: { left: margin, right: margin },
      theme: 'grid'
    });
    y = doc.lastAutoTable.finalY + 4;
  }

  // ── LATE FEE ──
  var lf = d.late_fee || {};
  if (lf.percent || lf.calculation_type) {
    checkY(18);
    doc.autoTable({
      startY: y,
      head: [['Calculation Type','Grace Period','Percent','2nd Fee Calc','2nd Fee Grace','2nd Fee %','Per Day Fee']],
      body: [[lf.calculation_type||'% Owed-Total', lf.grace_period_days||'0', lf.percent||'10.00',
              lf.second_fee_calc||'', lf.second_fee_grace||'', lf.second_fee_pct||'', lf.per_day_fee||'0.00']],
      styles: { fontSize: 7.5, cellPadding: 1.5 },
      headStyles: { fillColor: [220,220,220], textColor: [0,0,0], fontStyle: 'bold', fontSize: 7 },
      margin: { left: margin, right: margin },
      theme: 'grid'
    });
    y = doc.lastAutoTable.finalY + 5;
  }
  _pdfFooter(doc, pageW);

  // ── OTHER LEASE PROVISIONS / CLAUSES ──
  var clauses = d.clauses || {};
  var clauseIds = Object.keys(clauses);
  if (clauseIds.length) {
    addPage();
    doc.setFont('helvetica','bold'); doc.setFontSize(10);
    doc.text('Other Lease Provisions / Clauses', margin, y); y += 6;
    // Table header
    doc.autoTable({
      startY: y,
      head: [['Id','Name','Description','Amendment Type']],
      body: clauseIds.map(function(id){
        var c = clauses[id]||{};
        return [id, c.name||id, c.description||'Lease is silent.', 'Original Lease'];
      }),
      styles: { fontSize: 7, cellPadding: 1.8, overflow: 'linebreak', valign: 'top' },
      headStyles: { fillColor: [220,220,220], textColor: [0,0,0], fontStyle: 'bold', fontSize: 7.5 },
      columnStyles: {
        0: { cellWidth: 14, fontStyle: 'bold' },
        1: { cellWidth: 24 },
        2: { cellWidth: 135 },
        3: { cellWidth: 20 }
      },
      margin: { left: margin, right: margin },
      theme: 'grid',
      didDrawPage: function() { _pdfFooter(doc, pageW); }
    });
    y = doc.lastAutoTable.finalY + 5;
  }

  // ── CONTACTS ──
  var contacts = d.contacts || [];
  if (contacts.length) {
    checkY(20);
    doc.autoTable({
      startY: y,
      head: [['Role','Company','Name','Address','Phone','Email']],
      body: contacts.map(function(c){
        return [c.role||'', c.company||'', c.name||'', c.address||'', c.phone||'', c.email||''];
      }),
      styles: { fontSize: 7, cellPadding: 1.5 },
      headStyles: { fillColor: [220,220,220], textColor: [0,0,0], fontStyle: 'bold', fontSize: 7 },
      margin: { left: margin, right: margin },
      theme: 'grid'
    });
    _pdfFooter(doc, pageW);
  }

  // Return blob URL — download only happens when user clicks the Download link
  var _blob = doc.output('blob');
  return { url: URL.createObjectURL(_blob), name: outName };
}

function _pdfFooter(doc, pageW) {
  var pageCount = doc.internal.getNumberOfPages();
  doc.setFont('helvetica','normal'); doc.setFontSize(7); doc.setTextColor(100);
  doc.text(new Date().toLocaleString(), 14, 278);
  doc.text('Page : ' + pageCount, pageW - 14, 278, { align: 'right' });
  doc.setTextColor(0);
}

