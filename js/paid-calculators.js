/* paid-calculators.js — Lexora paid calculator services.
 *
 * SIP Calculator, Income Tax Calculator (India slabs), Compound Interest
 * Calculator, Loan Eligibility Calculator. These don't process an
 * uploaded file - the "job" is one calculation - so instead of
 * ServiceRunner's upload shell, each is a single card with inputs and a
 * Calculate button. Billing charges the plan's flat per-document rate
 * once per calculation, through the same window.LexoraBilling used by
 * every other paid service.
 */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  // Item 16 - Services Catalog "Image" column can hold a full path;
  // falls back to the naming-convention path when not set.
  function catalogImageSrc(id, fallbackPath) {
    const entry = window.SERVICES_CATALOG && window.SERVICES_CATALOG[id];
    return (entry && entry.image && entry.image.trim()) || fallbackPath;
  }
  const val = (id) => (document.getElementById(id) || {}).value || '';
  const num = (id) => parseFloat(val(id));
  const chk = (id) => !!(document.getElementById(id) || {}).checked;
  // Item 9 - no currency symbol in the client UI (receipt is server-side
  // and unaffected). Was `... || '\u20b9'`, but that '||' fallback
  // treats an intentionally empty symbol as falsy and silently puts the
  // symbol back - call the function directly with no fallback instead.
  const AMT = (v) => (
    (window.LexoraBilling ? window.LexoraBilling.currencySymbol() : '')
  ) + Math.round(v).toLocaleString('en-IN');

  function fld(label, inner) {
    return `<div class="setup-group" style="flex:1;min-width:200px;"><label>${esc(label)}</label>${inner}</div>`;
  }

  function resultRow(label, value, strong) {
    return `<div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid rgba(0,0,0,0.06);">
      <span style="color:#6b7280;">${esc(label)}</span>
      <span style="${strong ? 'font-weight:700;' : ''}color:#3d4a5c;">${value}</span>
    </div>`;
  }

  function backButton() {
    return `<button class="process-btn clear-btn card-back-btn" onclick="goBackToServices()">\u2190 Back to Services</button>`;
  }

  function backButtonFree() {
    return `<button class="process-btn clear-btn card-back-btn" onclick="goBackToServices()">\u2190 Back to Services</button>`;
  }

  function billingRow(calcId) {
    const b = window.LexoraBilling;
    const rate = b ? b.perPageRate() : 0;
    const unit = b && b.isPerDocument() ? 'per calculation' : 'per use';
    return `
      <div id="${calcId}Billing" style="margin-top:6px;font-size:0.8rem;color:rgba(0,0,0,0.55);">
        \ud83d\udcb0 Rate: ${AMT(rate)} ${unit} - charged when you press Calculate.
      </div>
      <div id="${calcId}Status" style="margin-top:6px;font-size:0.86rem;min-height:1.1em;"></div>`;
  }

  // No wallet involved at all - just a status line for validation errors.
  function freeStatusRow(calcId) {
    return `<div id="${calcId}Status" style="margin-top:6px;font-size:0.86rem;min-height:1.1em;"></div>`;
  }

  // Every calculator's Calculate button routes through this - checks
  // balance, charges once, then runs the calculator-specific compute
  // function. Nothing is charged if the balance is insufficient or the
  // inputs are invalid (compute() returning false means "don't charge").
  function chargeAndRun(calcId, label, compute) {
    const b = window.LexoraBilling;
    const statusEl = document.getElementById(calcId + 'Status');
    if (!b) { if (statusEl) statusEl.textContent = 'Billing is unavailable - please reload the page.'; return; }
    const rate = b.perPageRate();
    if (rate > 0 && b.balance() < rate) {
      if (statusEl) { statusEl.style.color = '#b3261e'; statusEl.textContent = `Insufficient balance. ${AMT(rate)} is needed for this calculation.`; }
      return;
    }
    const ok = compute();
    if (ok === false) return; // invalid inputs - compute() already showed its own message
    if (rate > 0) {
      b.charge(`${label} - calculation`, rate);
      if (window.notifyProcessCompletion) window.notifyProcessCompletion(label, 'Calculation', rate, '');
    }
    if (statusEl) { statusEl.style.color = '#1b5e20'; statusEl.textContent = rate > 0 ? `${AMT(rate)} charged.` : 'Done.'; }
  }

  // No API key, no server cost - these tools run entirely client-side, so
  // there's nothing to charge for. Still routes through the same
  // status-line UI/error-handling shape as chargeAndRun, just without the
  // balance check/charge step.
  function runFree(calcId, compute) {
    const statusEl = document.getElementById(calcId + 'Status');
    const ok = compute();
    if (ok === false) return;
    if (statusEl) { statusEl.style.color = '#1b5e20'; statusEl.textContent = 'Done.'; }
  }

  async function runFreeAsync(calcId, computeAsync) {
    const statusEl = document.getElementById(calcId + 'Status');
    let ok;
    try {
      ok = await computeAsync();
    } catch (e) {
      if (statusEl) { statusEl.style.color = '#b3261e'; statusEl.textContent = e.message || 'Something went wrong - please try again.'; }
      return;
    }
    if (ok === false) return;
    if (statusEl) { statusEl.style.color = '#1b5e20'; statusEl.textContent = 'Done.'; }
  }

  // ══════════════════════════════════════════════════════════════════
  // SIP CALCULATOR
  // ══════════════════════════════════════════════════════════════════
  function renderSip() {
    return `
      <div class="service-split-layout">
        <div class="service-visual-panel" aria-hidden="true"><img class="service-visual-img" src="${esc(catalogImageSrc('sip-calculator', 'Pictures/service-images/sip-calculator.jpg'))}" alt="" onerror="this.style.display='none'; this.parentElement.classList.add('is-fallback');" /><span class="service-visual-icon">\ud83d\udcc8</span></div>
        <div class="service-card">
        <h3 class="card-head-row"><span>\ud83d\udcc8 SIP Calculator</span>${backButtonFree()}</h3>
        <div class="card-body">
          <div style="display:flex;gap:12px;flex-wrap:wrap;">
            ${fld('Monthly investment', `<input type="number" id="tSipAmt" value="10000" min="100" style="width:100%;" />`)}
            ${fld('Expected annual return (%)', `<input type="number" id="tSipRate" value="12" min="0" step="0.1" style="width:100%;" />`)}
            ${fld('Investment duration (years)', `<input type="number" id="tSipYears" value="10" min="1" style="width:100%;" />`)}
          </div>
          <div class="process-controls" style="margin-top:14px;">
            <button class="process-btn start-btn" onclick="PaidCalculators.runSip()">Calculate</button>
          </div>
          ${freeStatusRow('tSip')}
          <div id="tSipResult" style="margin-top:10px;"></div>
          <p style="font-size:0.76rem;color:rgba(0,0,0,0.45);margin-top:12px;">
            Estimate assuming a constant monthly return - actual mutual fund/SIP returns vary and are not guaranteed.
          </p>
        </div>
      </div>
      </div>`;
  }

  function runSip() {
    runFree('tSip', function () {
      const P = num('tSipAmt'), annual = num('tSipRate'), years = num('tSipYears');
      const res = document.getElementById('tSipResult');
      if (!Number.isFinite(P) || P <= 0 || !Number.isFinite(annual) || annual < 0 || !Number.isFinite(years) || years < 1) {
        res.innerHTML = '<div style="color:#b3261e;font-size:0.86rem;">Enter a monthly investment above 0, a return of 0 or more, and a duration of at least 1 year.</div>';
        return false;
      }
      const n = Math.round(years * 12);
      const r = annual / 12 / 100;
      const fv = r === 0 ? P * n : P * ((Math.pow(1 + r, n) - 1) / r) * (1 + r);
      const invested = P * n;
      res.innerHTML =
        resultRow('Invested amount', AMT(invested)) +
        resultRow('Estimated returns', AMT(fv - invested)) +
        resultRow('Maturity value', AMT(fv), true);
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // INCOME TAX CALCULATOR (INDIA - NEW REGIME SLABS)
  // ══════════════════════════════════════════════════════════════════
  const TAX_SLABS = [
    { upTo: 300000, rate: 0 },
    { upTo: 700000, rate: 0.05 },
    { upTo: 1000000, rate: 0.10 },
    { upTo: 1200000, rate: 0.15 },
    { upTo: 1500000, rate: 0.20 },
    { upTo: Infinity, rate: 0.30 }
  ];

  function renderIncomeTax() {
    return `
      <div class="service-split-layout">
        <div class="service-visual-panel" aria-hidden="true"><img class="service-visual-img" src="${esc(catalogImageSrc('income-tax-calculator', 'Pictures/service-images/income-tax-calculator.jpg'))}" alt="" onerror="this.style.display='none'; this.parentElement.classList.add('is-fallback');" /><span class="service-visual-icon">\ud83e\uddfe</span></div>
        <div class="service-card">
        <h3 class="card-head-row"><span>\ud83e\uddfe Income Tax Calculator (India)</span>${backButtonFree()}</h3>
        <div class="card-body">
          <div style="display:flex;gap:12px;flex-wrap:wrap;">
            ${fld('Annual income (gross)', `<input type="number" id="tTaxIncome" value="1200000" min="0" style="width:100%;" />`)}
            ${fld('Other deductions (80C, etc.)', `<input type="number" id="tTaxDeduct" value="0" min="0" style="width:100%;" />`)}
          </div>
          <label class="checkbox-label" style="margin-top:8px;">
            <input type="checkbox" id="tTaxSalaried" checked />
            Salaried (standard deduction \u20b975,000)
          </label>
          <div class="process-controls" style="margin-top:14px;">
            <button class="process-btn start-btn" onclick="PaidCalculators.runIncomeTax()">Calculate</button>
          </div>
          ${freeStatusRow('tTax')}
          <div id="tTaxResult" style="margin-top:10px;"></div>
          <p style="font-size:0.76rem;color:rgba(0,0,0,0.45);margin-top:12px;">
            New tax regime slabs, plus 4% health & education cess. Includes the Section 87A rebate
            (tax reduced to zero when taxable income is \u20b97,00,000 or less). Estimate only - your
            actual liability depends on regime choice, other deductions, and your specific situation.
            Consult a tax professional for filing purposes.
          </p>
        </div>
      </div>
      </div>`;
  }

  function runIncomeTax() {
    runFree('tTax', function () {
      const gross = num('tTaxIncome'), deduct = num('tTaxDeduct') || 0;
      const salaried = chk('tTaxSalaried');
      const res = document.getElementById('tTaxResult');
      if (!Number.isFinite(gross) || gross < 0) {
        res.innerHTML = '<div style="color:#b3261e;font-size:0.86rem;">Enter an annual income of 0 or more.</div>';
        return false;
      }
      const stdDeduction = salaried ? 75000 : 0;
      const taxable = Math.max(0, gross - stdDeduction - deduct);

      let tax = 0, lastCap = 0;
      TAX_SLABS.forEach(function (slab) {
        if (taxable > lastCap) {
          tax += (Math.min(taxable, slab.upTo) - lastCap) * slab.rate;
        }
        lastCap = slab.upTo;
      });

      // Section 87A rebate: taxable income up to 7L pays no tax under the new regime.
      const rebateApplied = taxable <= 700000;
      if (rebateApplied) tax = 0;

      const cess = tax * 0.04;
      const totalTax = tax + cess;

      res.innerHTML =
        resultRow('Taxable income', AMT(taxable)) +
        resultRow('Income tax (before cess)', AMT(tax)) +
        (rebateApplied ? resultRow('Section 87A rebate', 'Applied - tax reduced to \u20b90') : '') +
        resultRow('Health & education cess (4%)', AMT(cess)) +
        resultRow('Total tax payable', AMT(totalTax), true) +
        resultRow('Net take-home (annual)', AMT(gross - totalTax), true);
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // COMPOUND INTEREST CALCULATOR
  // ══════════════════════════════════════════════════════════════════
  function renderCompoundInterest() {
    return `
      <div class="service-split-layout">
        <div class="service-visual-panel" aria-hidden="true"><img class="service-visual-img" src="${esc(catalogImageSrc('compound-interest-calculator', 'Pictures/service-images/compound-interest-calculator.jpg'))}" alt="" onerror="this.style.display='none'; this.parentElement.classList.add('is-fallback');" /><span class="service-visual-icon">\ud83d\udcb9</span></div>
        <div class="service-card">
        <h3 class="card-head-row"><span>\ud83d\udcb9 Compound Interest Calculator</span>${backButtonFree()}</h3>
        <div class="card-body">
          <div style="display:flex;gap:12px;flex-wrap:wrap;">
            ${fld('Principal amount', `<input type="number" id="tCiPrincipal" value="100000" min="0" style="width:100%;" />`)}
            ${fld('Annual interest rate (%)', `<input type="number" id="tCiRate" value="8" min="0" step="0.1" style="width:100%;" />`)}
            ${fld('Time (years)', `<input type="number" id="tCiYears" value="5" min="1" style="width:100%;" />`)}
            ${fld('Compounding frequency', `<select id="tCiFreq" style="width:100%;">
                <option value="1">Yearly</option>
                <option value="2">Half-yearly</option>
                <option value="4" selected>Quarterly</option>
                <option value="12">Monthly</option>
              </select>`)}
          </div>
          <div class="process-controls" style="margin-top:14px;">
            <button class="process-btn start-btn" onclick="PaidCalculators.runCompoundInterest()">Calculate</button>
          </div>
          ${freeStatusRow('tCi')}
          <div id="tCiResult" style="margin-top:10px;"></div>
        </div>
      </div>
      </div>`;
  }

  function runCompoundInterest() {
    runFree('tCi', function () {
      const P = num('tCiPrincipal'), annual = num('tCiRate'), years = num('tCiYears');
      const n = parseInt(val('tCiFreq'), 10) || 1;
      const res = document.getElementById('tCiResult');
      if (!Number.isFinite(P) || P <= 0 || !Number.isFinite(annual) || annual < 0 || !Number.isFinite(years) || years < 1) {
        res.innerHTML = '<div style="color:#b3261e;font-size:0.86rem;">Enter a principal above 0, a rate of 0 or more, and a time of at least 1 year.</div>';
        return false;
      }
      const r = annual / 100;
      const amount = P * Math.pow(1 + r / n, n * years);
      res.innerHTML =
        resultRow('Principal amount', AMT(P)) +
        resultRow('Total interest earned', AMT(amount - P)) +
        resultRow('Maturity amount', AMT(amount), true);
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // LOAN ELIGIBILITY CALCULATOR
  // ══════════════════════════════════════════════════════════════════
  function renderLoanEligibility() {
    return `
      <div class="service-split-layout">
        <div class="service-visual-panel" aria-hidden="true"><img class="service-visual-img" src="${esc(catalogImageSrc('loan-eligibility-calculator', 'Pictures/service-images/loan-eligibility-calculator.jpg'))}" alt="" onerror="this.style.display='none'; this.parentElement.classList.add('is-fallback');" /><span class="service-visual-icon">\ud83c\udfe6</span></div>
        <div class="service-card">
        <h3 class="card-head-row"><span>\ud83c\udfe6 Loan Eligibility Calculator</span>${backButtonFree()}</h3>
        <div class="card-body">
          <div style="display:flex;gap:12px;flex-wrap:wrap;">
            ${fld('Monthly net income', `<input type="number" id="tLeIncome" value="80000" min="0" style="width:100%;" />`)}
            ${fld('Existing monthly EMIs', `<input type="number" id="tLeExisting" value="0" min="0" style="width:100%;" />`)}
            ${fld('Interest rate (% p.a.)', `<input type="number" id="tLeRate" value="9" min="0" step="0.1" style="width:100%;" />`)}
            ${fld('Loan tenure (years)', `<input type="number" id="tLeYears" value="20" min="1" style="width:100%;" />`)}
            ${fld('Max EMI-to-income ratio (%)', `<input type="number" id="tLeRatio" value="50" min="10" max="80" style="width:100%;" />`)}
          </div>
          <div class="process-controls" style="margin-top:14px;">
            <button class="process-btn start-btn" onclick="PaidCalculators.runLoanEligibility()">Calculate</button>
          </div>
          ${freeStatusRow('tLe')}
          <div id="tLeResult" style="margin-top:10px;"></div>
          <p style="font-size:0.76rem;color:rgba(0,0,0,0.45);margin-top:12px;">
            Estimate based on a simple EMI-to-income ratio - actual eligibility also depends on your
            credit score, employment type, existing liabilities, and the lender's own policy.
          </p>
        </div>
      </div>
      </div>`;
  }

  function runLoanEligibility() {
    runFree('tLe', function () {
      const income = num('tLeIncome'), existing = num('tLeExisting') || 0;
      const annual = num('tLeRate'), years = num('tLeYears'), ratio = num('tLeRatio');
      const res = document.getElementById('tLeResult');
      if (!Number.isFinite(income) || income <= 0 || !Number.isFinite(annual) || annual <= 0 ||
          !Number.isFinite(years) || years < 1 || !Number.isFinite(ratio) || ratio <= 0) {
        res.innerHTML = '<div style="color:#b3261e;font-size:0.86rem;">Enter a monthly income above 0, a rate above 0, a tenure of at least 1 year, and a valid ratio.</div>';
        return false;
      }
      const maxEmi = Math.max(0, income * ratio / 100 - existing);
      const n = Math.round(years * 12);
      const r = annual / 12 / 100;
      // Reverse-EMI formula: loan amount that produces exactly maxEmi as
      // the monthly instalment at this rate/tenure.
      const maxLoan = r === 0 ? maxEmi * n : maxEmi * (Math.pow(1 + r, n) - 1) / (r * Math.pow(1 + r, n));
      res.innerHTML =
        resultRow('Maximum affordable EMI', AMT(maxEmi)) +
        resultRow('Estimated maximum loan amount', AMT(maxLoan), true);
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // CONTENT WRITING TOOL
  // ══════════════════════════════════════════════════════════════════
  // Reuses window.__calculatorsEngine.lexoraProxyJson (js/engine-calculators.js,
  // this service's own fully-separate engine copy) - the same underlying
  // secure OpenRouter proxy mechanism Translation/OCR/Data Extraction each
  // have their own separate copy of.
  // The endpoint is generic ({model, messages} -> OpenRouter chat
  // completion), so a plain-text prompt works the same as a vision one.
  const CONTENT_MODEL = 'openai/gpt-4o-mini';

  function renderContentWriting() {
    return `
      <div class="service-split-layout">
        <div class="service-visual-panel" aria-hidden="true"><img class="service-visual-img" src="${esc(catalogImageSrc('content-writing-tool', 'Pictures/service-images/content-writing-tool.jpg'))}" alt="" onerror="this.style.display='none'; this.parentElement.classList.add('is-fallback');" /><span class="service-visual-icon">✍️</span></div>
        <div class="service-card">
        <h3 class="card-head-row"><span>✍️ Content Writing Tool</span>${backButton()}</h3>
        <div class="card-body">
          <div style="display:flex;gap:12px;flex-wrap:wrap;">
            ${fld('Content type', `<select id="tCwType" style="width:100%;">
                <option value="blog post">Blog post</option>
                <option value="social media caption">Social media caption</option>
                <option value="product description">Product description</option>
                <option value="marketing email">Marketing email</option>
                <option value="ad copy">Ad copy</option>
              </select>`)}
            ${fld('Tone', `<select id="tCwTone" style="width:100%;">
                <option value="professional">Professional</option>
                <option value="casual">Casual</option>
                <option value="persuasive">Persuasive</option>
                <option value="friendly">Friendly</option>
              </select>`)}
            ${fld('Length', `<select id="tCwLength" style="width:100%;">
                <option value="short (~100 words)">Short</option>
                <option value="medium (~250 words)" selected>Medium</option>
                <option value="long (~500 words)">Long</option>
              </select>`)}
          </div>
          <div class="setup-group" style="margin-top:10px;">
            <label>Topic / what it's about</label>
            <textarea id="tCwTopic" rows="3" style="width:100%;" placeholder="e.g. Launching a new noise-cancelling headphone for remote workers"></textarea>
          </div>
          <div class="process-controls" style="margin-top:12px;">
            <button class="process-btn start-btn" onclick="PaidCalculators.runContentWriting()">Generate</button>
          </div>
          ${billingRow('tCw')}
          <div class="setup-group" style="margin-top:10px;">
            <label>Generated content</label>
            <textarea id="tCwOut" rows="12" style="width:100%;" readonly></textarea>
          </div>
          <div class="process-controls" style="margin-top:10px;">
            <button class="process-btn clear-btn" onclick="PaidCalculators.downloadContent('tCwOut', 'content.txt')">⬇️ Download</button>
          </div>
        </div>
      </div>
      </div>`;
  }

  function runContentWriting() {
    chargeAndRunAsync('tCw', 'Content Writing Tool', async function () {
      const type = val('tCwType') || 'blog post';
      const tone = val('tCwTone') || 'professional';
      const length = val('tCwLength') || 'medium (~250 words)';
      const topic = val('tCwTopic').trim();
      const outEl = document.getElementById('tCwOut');
      if (!topic) { outEl.value = ''; say2('tCwStatus', 'Describe the topic first.', 'error'); return false; }

      const template = window.getAiPrompt ? window.getAiPrompt('Content Writing Tool', 1) : null;
      if (!template) { outEl.value = ''; say2('tCwStatus', 'AI Prompt for Content Writing Tool is not configured - add it in Admin > AI Prompts, or run migration first.', 'error'); return false; }
      const prompt = template.replace('{tone}', tone).replace('{type}', type).replace('{length}', length).replace('{topic}', topic);

      const data = await window.__calculatorsEngine.lexoraProxyJson({
        model: CONTENT_MODEL,
        messages: [{ role: 'user', content: prompt }]
      });
      const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
      if (!text.trim()) { outEl.value = ''; say2('tCwStatus', 'The model returned no content - please try again.', 'error'); return false; }
      outEl.value = text.trim();
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // HUMANIZE DOCUMENT TOOL
  // ══════════════════════════════════════════════════════════════════
  function renderHumanize() {
    return `
      <div class="service-split-layout">
        <div class="service-visual-panel" aria-hidden="true"><img class="service-visual-img" src="${esc(catalogImageSrc('humanize-document-tool', 'Pictures/service-images/humanize-document-tool.jpg'))}" alt="" onerror="this.style.display='none'; this.parentElement.classList.add('is-fallback');" /><span class="service-visual-icon">🧑</span></div>
        <div class="service-card">
        <h3 class="card-head-row"><span>🧑 Humanize Document Tool</span>${backButton()}</h3>
        <div class="card-body">
          <div class="setup-group">
            <label>Text to humanize</label>
            <textarea id="tHzIn" rows="8" style="width:100%;" placeholder="Paste AI-generated or stiff-sounding text here…"></textarea>
          </div>
          <div class="process-controls" style="margin-top:12px;">
            <button class="process-btn start-btn" onclick="PaidCalculators.runHumanize()">Humanize</button>
          </div>
          ${billingRow('tHz')}
          <div class="setup-group" style="margin-top:10px;">
            <label>Humanized version</label>
            <textarea id="tHzOut" rows="8" style="width:100%;" readonly></textarea>
          </div>
          <div class="process-controls" style="margin-top:10px;">
            <button class="process-btn clear-btn" onclick="PaidCalculators.downloadContent('tHzOut', 'humanized.txt')">⬇️ Download</button>
          </div>
          <p style="font-size:0.76rem;color:rgba(0,0,0,0.45);margin-top:12px;">
            Rewrites the text to read more naturally (varied sentence rhythm, less
            repetitive phrasing) - it does not claim to defeat any specific AI-detection tool.
          </p>
        </div>
      </div>
      </div>`;
  }

  function runHumanize() {
    chargeAndRunAsync('tHz', 'Humanize Document Tool', async function () {
      const input = val('tHzIn').trim();
      const outEl = document.getElementById('tHzOut');
      if (!input) { outEl.value = ''; say2('tHzStatus', 'Paste some text first.', 'error'); return false; }

      const template = window.getAiPrompt ? window.getAiPrompt('Humanize Document Tool', 1) : null;
      if (!template) { outEl.value = ''; say2('tHzStatus', 'AI Prompt for Humanize Document Tool is not configured - add it in Admin > AI Prompts, or run migration first.', 'error'); return false; }
      const prompt = template.replace('{input}', input);

      const data = await window.__calculatorsEngine.lexoraProxyJson({
        model: CONTENT_MODEL,
        messages: [{ role: 'user', content: prompt }]
      });
      const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
      if (!text.trim()) { outEl.value = ''; say2('tHzStatus', 'The model returned no content - please try again.', 'error'); return false; }
      outEl.value = text.trim();
    });
  }

  function downloadContent(id, filename) {
    const text = (document.getElementById(id) || {}).value || '';
    if (!text) return;
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  // Async counterpart to chargeAndRun (the calculators are all synchronous
  // math; these two need an awaited API call before deciding whether the
  // result is good enough to actually charge for).
  function say2(id, msg, kind) {
    const el = document.getElementById(id);
    if (el) { el.style.color = kind === 'error' ? '#b3261e' : '#1b5e20'; el.textContent = msg; }
  }

  async function chargeAndRunAsync(calcId, label, computeAsync) {
    const b = window.LexoraBilling;
    const statusEl = document.getElementById(calcId + 'Status');
    if (!b) { if (statusEl) statusEl.textContent = 'Billing is unavailable - please reload the page.'; return; }
    const rate = b.perPageRate();
    if (rate > 0 && b.balance() < rate) {
      if (statusEl) { statusEl.style.color = '#b3261e'; statusEl.textContent = `Insufficient balance. ${AMT(rate)} is needed.`; }
      return;
    }
    if (statusEl) { statusEl.style.color = '#1b5e20'; statusEl.textContent = 'Generating…'; }
    let ok;
    try {
      ok = await computeAsync();
    } catch (e) {
      if (statusEl) { statusEl.style.color = '#b3261e'; statusEl.textContent = e.message || 'Something went wrong - please try again.'; }
      return;
    }
    if (ok === false) return; // computeAsync already showed its own message
    if (rate > 0) {
      b.charge(`${label} - generation`, rate);
      if (window.notifyProcessCompletion) window.notifyProcessCompletion(label, 'Generation', rate, '');
    }
    if (statusEl) { statusEl.style.color = '#1b5e20'; statusEl.textContent = rate > 0 ? `${AMT(rate)} charged.` : 'Done.'; }
  }

  // ══════════════════════════════════════════════════════════════════
  // BACKGROUND REMOVER
  // ══════════════════════════════════════════════════════════════════
  // Uses @imgly/background-removal, a client-side segmentation model
  // (ONNX + WASM) - loaded on demand via dynamic import so nothing extra
  // is downloaded unless someone actually opens this tool. Runs entirely
  // in the browser (no image data leaves the machine), but the model
  // itself (~40MB, cached after first use) has to come from imgly's CDN
  // the first time - that's the one external dependency this tool has.
  let bgRemoveFile = null;

  function renderBackgroundRemover() {
    return `
      <div class="service-split-layout">
        <div class="service-visual-panel" aria-hidden="true"><img class="service-visual-img" src="${esc(catalogImageSrc('background-remover', 'Pictures/service-images/background-remover.jpg'))}" alt="" onerror="this.style.display='none'; this.parentElement.classList.add('is-fallback');" /><span class="service-visual-icon">🪄</span></div>
        <div class="service-card">
        <h3 class="card-head-row"><span>🪄 Background Remover</span>${backButtonFree()}</h3>
        <div class="card-body">
          <div class="setup-group">
            <label>Upload an image</label>
            <input type="file" id="tBgFile" accept="image/*" onchange="PaidCalculators.onBgFilePick(this.files[0])" />
          </div>
          <div id="tBgPreview" style="margin-top:10px;display:flex;gap:16px;flex-wrap:wrap;"></div>
          <div class="process-controls" style="margin-top:12px;">
            <button class="process-btn start-btn" onclick="PaidCalculators.runBackgroundRemover()">Remove Background</button>
          </div>
          ${freeStatusRow('tBg')}
          <div class="process-controls" style="margin-top:10px;" id="tBgDownloadRow"></div>
          <p style="font-size:0.76rem;color:rgba(0,0,0,0.45);margin-top:12px;">
            First use on this device downloads a one-time ~40MB model (cached afterwards) -
            the initial run can take a little longer than later ones.
          </p>
        </div>
      </div>
      </div>`;
  }

  function onBgFilePick(file) {
    bgRemoveFile = file || null;
    const box = document.getElementById('tBgPreview');
    const dl = document.getElementById('tBgDownloadRow');
    if (dl) dl.innerHTML = '';
    if (!box) return;
    box.innerHTML = '';
    if (file) {
      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      img.style.cssText = 'max-width:220px;max-height:220px;border-radius:8px;border:1px solid rgba(0,0,0,0.1);';
      box.appendChild(img);
    }
  }

  function runBackgroundRemover() {
    runFreeAsync('tBg', async function () {
      const statusEl = document.getElementById('tBgStatus');
      if (!bgRemoveFile) { say2('tBgStatus', 'Upload an image first.', 'error'); return false; }

      if (window.FreeServices && window.FreeServices.isPaidInCatalog('background-remover')) {
        const okToProceed = await window.FreeServices.confirmPaidAccess('background-remover');
        if (!okToProceed) return false; // insufficient balance or cancelled - nothing charged
      }

      if (statusEl) say2('tBgStatus', 'Loading model (first use can take a moment)…', 'ok');

      let removeBackground;
      try {
        const mod = await import('https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.4.5/dist/browser.mjs');
        removeBackground = mod.removeBackground;
      } catch (e) {
        say2('tBgStatus', 'Could not load the background-removal model - check your connection and try again.', 'error');
        return false;
      }

      say2('tBgStatus', 'Removing background…', 'ok');
      let resultBlob;
      try {
        resultBlob = await removeBackground(bgRemoveFile);
      } catch (e) {
        say2('tBgStatus', 'Background removal failed for this image - please try a different one.', 'error');
        return false;
      }

      // Only now that the image has genuinely finished processing -
      // charges nothing at all if this is still a free service.
      if (window.FreeServices) window.FreeServices.chargeForPaidAccess('background-remover');

      const box = document.getElementById('tBgPreview');
      if (box) {
        const img = document.createElement('img');
        img.src = URL.createObjectURL(resultBlob);
        img.style.cssText = 'max-width:220px;max-height:220px;border-radius:8px;border:1px solid rgba(0,0,0,0.1);' +
          'background-image:linear-gradient(45deg,#eee 25%,transparent 25%),linear-gradient(-45deg,#eee 25%,transparent 25%),' +
          'linear-gradient(45deg,transparent 75%,#eee 75%),linear-gradient(-45deg,transparent 75%,#eee 75%);' +
          'background-size:16px 16px;background-position:0 0,0 8px,8px -8px,-8px 0;';
        box.appendChild(img);
      }
      const dl = document.getElementById('tBgDownloadRow');
      if (dl) {
        const url = URL.createObjectURL(resultBlob);
        dl.innerHTML = `<a class="process-btn clear-btn" href="${url}" download="background_removed.png">⬇️ Download PNG</a>`;
      }
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // TEXT-TO-SPEECH
  // ══════════════════════════════════════════════════════════════════
  // Uses the browser's built-in Web Speech API (speechSynthesis) - no
  // external API call, works offline once voices are loaded. Playback
  // happens live in the browser; MediaRecorder captures it (via the
  // browser's own audio output routed through a silent <audio> sink) so
  // it can be downloaded as a file too.
  function renderTextToSpeech() {
    setTimeout(populateVoiceList, 0);
    return `
      <div class="service-split-layout">
        <div class="service-visual-panel" aria-hidden="true"><img class="service-visual-img" src="${esc(catalogImageSrc('text-to-speech', 'Pictures/service-images/text-to-speech.jpg'))}" alt="" onerror="this.style.display='none'; this.parentElement.classList.add('is-fallback');" /><span class="service-visual-icon">🔊</span></div>
        <div class="service-card">
        <h3 class="card-head-row"><span>🔊 Text-to-Speech</span>${backButtonFree()}</h3>
        <div class="card-body">
          <div class="setup-group">
            <label>Text to read aloud</label>
            <textarea id="tTtsIn" rows="6" style="width:100%;" placeholder="Type or paste text here…"></textarea>
          </div>
          <div style="display:flex;gap:12px;flex-wrap:wrap;">
            ${fld('Voice', `<select id="tTtsVoice" style="width:100%;"><option>Loading voices…</option></select>`)}
            ${fld('Speed', `<input type="range" id="tTtsRate" min="0.5" max="2" step="0.1" value="1" style="width:100%;" />`)}
          </div>
          <div class="process-controls" style="margin-top:12px;">
            <button class="process-btn start-btn" onclick="PaidCalculators.playTts()">▶️ Play</button>
            <button class="process-btn clear-btn" onclick="PaidCalculators.stopTts()">⏹️ Stop</button>
          </div>
          ${freeStatusRow('tTts')}
          <p style="font-size:0.76rem;color:rgba(0,0,0,0.45);margin-top:12px;">
            Uses your browser/device's built-in voices - available voices and quality vary by
            browser and operating system. Playback only (no file download in this version).
          </p>
        </div>
      </div>
      </div>`;
  }

  function populateVoiceList() {
    const sel = document.getElementById('tTtsVoice');
    if (!sel || typeof speechSynthesis === 'undefined') return;
    const fill = function () {
      const voices = speechSynthesis.getVoices();
      if (!voices.length) return;
      sel.innerHTML = voices.map(function (v, i) {
        return `<option value="${i}">${esc(v.name)} (${esc(v.lang)})</option>`;
      }).join('');
    };
    fill();
    speechSynthesis.onvoiceschanged = fill;
  }

  function playTts() {
    runFree('tTts', function () {
      const text = val('tTtsIn').trim();
      const statusEl = document.getElementById('tTtsStatus');
      if (typeof speechSynthesis === 'undefined') {
        if (statusEl) { statusEl.style.color = '#b3261e'; statusEl.textContent = 'This browser does not support text-to-speech.'; }
        return false;
      }
      if (!text) {
        if (statusEl) { statusEl.style.color = '#b3261e'; statusEl.textContent = 'Enter some text first.'; }
        return false;
      }
      speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      const voices = speechSynthesis.getVoices();
      const voiceIdx = parseInt(val('tTtsVoice'), 10);
      if (voices[voiceIdx]) utter.voice = voices[voiceIdx];
      utter.rate = parseFloat(val('tTtsRate')) || 1;
      speechSynthesis.speak(utter);
    });
  }

  function stopTts() {
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  }

  window.PaidCalculators = {
    render: function (id) {
      if (id === 'content-writing-tool') return renderContentWriting();
      if (id === 'humanize-document-tool') return renderHumanize();
      return '<div class="content-section"><p>This calculator is not available.</p></div>';
    },
    // Client-side, no API key needed - shown in Free Services (via
    // cardModule() in free-services.js), not the Paid Services page.
    freeCards: {
      'sip-calculator': { label: 'SIP Calculator', icon: '📈', desc: 'Estimate the maturity value of a monthly SIP investment.', render: renderSip },
      'income-tax-calculator': { label: 'Income Tax Calculator', icon: '🧾', desc: 'India new-regime slabs, cess, and Section 87A rebate.', render: renderIncomeTax },
      'compound-interest-calculator': { label: 'Compound Interest Calculator', icon: '💹', desc: 'Maturity value at any compounding frequency.', render: renderCompoundInterest },
      'loan-eligibility-calculator': { label: 'Loan Eligibility Calculator', icon: '🏦', desc: 'Estimate the maximum loan you could qualify for.', render: renderLoanEligibility },
      'background-remover': { label: 'Background Remover', icon: '🪄', desc: 'Remove the background from a photo, right in your browser.', render: renderBackgroundRemover },
      'text-to-speech': { label: 'Text-to-Speech', icon: '🔊', desc: 'Have any text read aloud in a natural voice.', render: renderTextToSpeech }
    },
    runSip: runSip,
    runIncomeTax: runIncomeTax,
    runCompoundInterest: runCompoundInterest,
    runLoanEligibility: runLoanEligibility,
    runContentWriting: runContentWriting,
    runHumanize: runHumanize,
    downloadContent: downloadContent,
    onBgFilePick: onBgFilePick,
    runBackgroundRemover: runBackgroundRemover,
    playTts: playTts,
    stopTts: stopTts
  };
})();
