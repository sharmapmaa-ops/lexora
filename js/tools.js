/* tools.js — Other Services: pure-JS utilities (batch 1).
 *
 * Everything here is self-contained: no PDF libraries, no network, no API
 * calls. Each tool is a single card that recalculates live as the user
 * types, matching the EMI/Gratuity calculator style already in use.
 *
 * Registered into FreeServices via FreeServices.registerTool().
 */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function slugifyTitle(title) {
    return String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  }

  function card(icon, title, bodyHtml, note) {
    const slug = slugifyTitle(title);
    const displayTitle = (window.SERVICES_CATALOG && window.SERVICES_CATALOG[slug] && window.SERVICES_CATALOG[slug].name && window.SERVICES_CATALOG[slug].name.trim())
      || title;
    return `
      <div class="service-split-layout">
        <div class="service-visual-panel" aria-hidden="true">
          <img class="service-visual-img" src="Pictures/service-images/${slug}.jpg" alt=""
               onerror="this.style.display='none'; this.parentElement.classList.add('is-fallback');" />
          <span class="service-visual-icon">${icon}</span>
        </div>
        <div class="service-card">
          <h3>${icon} ${esc(displayTitle)}</h3>
          <div class="card-body">
            ${bodyHtml}
            ${note ? `<p style="font-size:0.76rem;color:rgba(0,0,0,0.45);margin-top:14px;">${note}</p>` : ''}
          </div>
        </div>
      </div>`;
  }

  function field(label, inner) {
    return `<div class="setup-group" style="flex:1;min-width:190px;">
      <label>${esc(label)}</label>${inner}
    </div>`;
  }

  function row(label, value, strong) {
    return `<div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid rgba(0,0,0,0.06);">
      <span style="color:#6b7280;">${esc(label)}</span>
      <span style="${strong ? 'font-weight:700;' : ''}color:#3d4a5c;">${value}</span>
    </div>`;
  }

  const val = (id) => (document.getElementById(id) || {}).value;
  const numVal = (id) => parseFloat(val(id));
  const out = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
  const err = (id, msg) => out(id, `<div style="color:#b3261e;font-size:0.86rem;">${esc(msg)}</div>`);

  // ══════════════════════════════════════════════════════════════════
  // AGE CALCULATOR
  // ══════════════════════════════════════════════════════════════════
  function renderAge() {
    setTimeout(runAge, 0);
    const today = new Date().toISOString().slice(0, 10);
    return card('🎂', 'Age Calculator', `
      <div style="display:flex;gap:14px;flex-wrap:wrap;">
        ${field('Date of birth', `<input type="date" id="tAgeDob" value="1990-01-01" max="${today}" oninput="Tools.runAge()" style="width:100%;" />`)}
        ${field('Age as on', `<input type="date" id="tAgeOn" value="${today}" oninput="Tools.runAge()" style="width:100%;" />`)}
      </div>
      <div id="tAgeOut" style="margin-top:14px;"></div>`);
  }

  function runAge() {
    const dob = new Date(val('tAgeDob')), on = new Date(val('tAgeOn'));
    if (isNaN(dob) || isNaN(on)) return err('tAgeOut', 'Pick both dates.');
    if (on < dob) return err('tAgeOut', '"Age as on" cannot be before the date of birth.');

    // Calendar-accurate years/months/days.
    // Naive "borrow days from the previous month" arithmetic breaks when the
    // birth day-of-month doesn't exist in the target month - e.g. 31 Jan to
    // 1 Mar would come out as a NEGATIVE day count, because "31 Feb" isn't a
    // date. So: work out the whole months first, step the birth date forward
    // by exactly that many months (clamped to the end of a short month), and
    // measure the leftover days from there.
    let y = on.getFullYear() - dob.getFullYear();
    let m = on.getMonth() - dob.getMonth();
    if (on.getDate() < dob.getDate()) m--;
    if (m < 0) { y--; m += 12; }

    const totalMonths = y * 12 + m;
    const rawMonth = dob.getMonth() + totalMonths;
    const anchorYear = dob.getFullYear() + Math.floor(rawMonth / 12);
    const anchorMonth = ((rawMonth % 12) + 12) % 12;
    const daysInAnchorMonth = new Date(anchorYear, anchorMonth + 1, 0).getDate();
    const anchor = new Date(anchorYear, anchorMonth, Math.min(dob.getDate(), daysInAnchorMonth));
    // Round, not floor: daylight-saving shifts make the gap 23 or 25 hours.
    const d = Math.round((on - anchor) / 86400000);

    const totalDays = Math.floor((on - dob) / 86400000);
    // Next birthday: this year's, or next year's if it has already passed.
    let nb = new Date(on.getFullYear(), dob.getMonth(), dob.getDate());
    if (nb < on) nb = new Date(on.getFullYear() + 1, dob.getMonth(), dob.getDate());
    const daysToBirthday = Math.ceil((nb - on) / 86400000);

    out('tAgeOut',
      row('Age', `${y} years, ${m} months, ${d} days`, true) +
      row('Total months', (y * 12 + m).toLocaleString()) +
      row('Total weeks', Math.floor(totalDays / 7).toLocaleString()) +
      row('Total days', totalDays.toLocaleString()) +
      row('Next birthday in', daysToBirthday === 0 ? 'Today 🎉' : `${daysToBirthday} day(s)`));
  }

  // ══════════════════════════════════════════════════════════════════
  // TIMEZONE
  // ══════════════════════════════════════════════════════════════════
  // A useful subset rather than the full IANA list, which would be a
  // 400-entry dropdown nobody scrolls through.
  const ZONES = [
    'UTC', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Karachi', 'Asia/Dhaka', 'Asia/Singapore',
    'Asia/Hong_Kong', 'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Seoul', 'Asia/Jakarta',
    'Australia/Sydney', 'Australia/Perth', 'Pacific/Auckland',
    'Europe/London', 'Europe/Dublin', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid',
    'Europe/Rome', 'Europe/Amsterdam', 'Europe/Zurich', 'Europe/Moscow', 'Europe/Istanbul',
    'Africa/Cairo', 'Africa/Johannesburg', 'Africa/Lagos', 'Africa/Nairobi',
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
    'America/Toronto', 'America/Vancouver', 'America/Mexico_City', 'America/Sao_Paulo',
    'America/Argentina/Buenos_Aires'
  ];

  function renderTimezone() {
    setTimeout(runTimezone, 0);
    const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const opts = (sel) => ZONES.map(function (z) {
      return `<option value="${z}" ${z === sel ? 'selected' : ''}>${z.replace(/_/g, ' ')}</option>`;
    }).join('');
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return card('🌍', 'Timezone Converter', `
      <div style="display:flex;gap:14px;flex-wrap:wrap;">
        ${field('Date & time', `<input type="datetime-local" id="tTzWhen"
          value="${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}"
          oninput="Tools.runTimezone()" style="width:100%;" />`)}
        ${field('From timezone', `<select id="tTzFrom" onchange="Tools.runTimezone()" style="width:100%;">${opts(ZONES.indexOf(localZone) !== -1 ? localZone : 'UTC')}</select>`)}
        ${field('To timezone', `<select id="tTzTo" onchange="Tools.runTimezone()" style="width:100%;">${opts('America/New_York')}</select>`)}
      </div>
      <div id="tTzOut" style="margin-top:14px;"></div>`,
      'Daylight-saving changes are handled automatically by your browser\'s timezone database.');
  }

  // Reads a wall-clock time in a given zone and returns the real instant.
  // Intl only formats a known instant into a zone, so this inverts it:
  // guess, format the guess back into the zone, and correct by the drift.
  function zonedToUtc(localString, zone) {
    const naive = new Date(localString + ':00Z');       // treat input as UTC first
    if (isNaN(naive)) return null;
    const shown = new Date(naive.toLocaleString('en-US', { timeZone: zone }));
    const asUtc = new Date(naive.toLocaleString('en-US', { timeZone: 'UTC' }));
    return new Date(naive.getTime() + (asUtc - shown));
  }

  function runTimezone() {
    const when = val('tTzWhen'), from = val('tTzFrom'), to = val('tTzTo');
    if (!when) return err('tTzOut', 'Pick a date and time.');
    const instant = zonedToUtc(when, from);
    if (!instant || isNaN(instant)) return err('tTzOut', 'That date/time could not be read.');

    const fmt = (zone) => instant.toLocaleString('en-GB', {
      timeZone: zone, weekday: 'short', year: 'numeric', month: 'short',
      day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: true
    });
    const offset = (zone) => {
      const p = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' })
        .formatToParts(instant).find(function (x) { return x.type === 'timeZoneName'; });
      return p ? p.value : '';
    };
    out('tTzOut',
      row(from.replace(/_/g, ' ') + ' (' + offset(from) + ')', fmt(from)) +
      row(to.replace(/_/g, ' ') + ' (' + offset(to) + ')', fmt(to), true) +
      row('UTC', fmt('UTC')));
  }

  // ══════════════════════════════════════════════════════════════════
  // UNIT CONVERTER
  // ══════════════════════════════════════════════════════════════════
  // Every unit is expressed as a factor to one base unit per category, so a
  // conversion is just (value x fromFactor) / toFactor. Temperature can't
  // work that way (it has offsets), so it's handled separately below.
  const UNITS = {
    Length: { base: 'm', units: { Millimetre: 0.001, Centimetre: 0.01, Metre: 1, Kilometre: 1000, Inch: 0.0254, Foot: 0.3048, Yard: 0.9144, Mile: 1609.344, 'Nautical mile': 1852 } },
    Weight: { base: 'kg', units: { Milligram: 0.000001, Gram: 0.001, Kilogram: 1, Tonne: 1000, Ounce: 0.028349523125, Pound: 0.45359237, Stone: 6.35029318 } },
    Area: { base: 'm2', units: { 'Square metre': 1, 'Square kilometre': 1000000, 'Square foot': 0.09290304, 'Square yard': 0.83612736, Acre: 4046.8564224, Hectare: 10000 } },
    Volume: { base: 'L', units: { Millilitre: 0.001, Litre: 1, 'Cubic metre': 1000, 'Gallon (US)': 3.785411784, 'Gallon (UK)': 4.54609, 'Pint (US)': 0.473176473, Cup: 0.24 } },
    Speed: { base: 'm/s', units: { 'Metre/second': 1, 'Kilometre/hour': 0.277777778, 'Mile/hour': 0.44704, Knot: 0.514444444, 'Foot/second': 0.3048 } },
    Time: { base: 's', units: { Millisecond: 0.001, Second: 1, Minute: 60, Hour: 3600, Day: 86400, Week: 604800 } },
    'Data storage': { base: 'byte', units: { Byte: 1, Kilobyte: 1024, Megabyte: 1048576, Gigabyte: 1073741824, Terabyte: 1099511627776 } },
    Temperature: { base: 'C', units: { Celsius: 1, Fahrenheit: 1, Kelvin: 1 } }
  };

  function renderUnit() {
    setTimeout(runUnit, 0);
    const cats = Object.keys(UNITS).map(function (c) {
      return `<option value="${c}" ${c === 'Length' ? 'selected' : ''}>${c}</option>`;
    }).join('');
    return card('📏', 'Unit Converter', `
      <div style="display:flex;gap:14px;flex-wrap:wrap;">
        ${field('Category', `<select id="tUnCat" onchange="Tools.onUnitCategory()" style="width:100%;">${cats}</select>`)}
        ${field('Value', `<input type="number" id="tUnVal" value="1" step="any" oninput="Tools.runUnit()" style="width:100%;" />`)}
      </div>
      <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:4px;">
        ${field('From', `<select id="tUnFrom" onchange="Tools.runUnit()" style="width:100%;"></select>`)}
        ${field('To', `<select id="tUnTo" onchange="Tools.runUnit()" style="width:100%;"></select>`)}
      </div>
      <div id="tUnOut" style="margin-top:14px;"></div>`);
  }

  function onUnitCategory() {
    const cat = val('tUnCat') || 'Length';
    const names = Object.keys(UNITS[cat].units);
    const build = (sel) => names.map(function (n) {
      return `<option value="${n}" ${n === sel ? 'selected' : ''}>${n}</option>`;
    }).join('');
    const f = document.getElementById('tUnFrom'), t = document.getElementById('tUnTo');
    if (f) f.innerHTML = build(names[0]);
    if (t) t.innerHTML = build(names[1] || names[0]);
    runUnit();
  }

  function toCelsius(v, unit) {
    if (unit === 'Fahrenheit') return (v - 32) * 5 / 9;
    if (unit === 'Kelvin') return v - 273.15;
    return v;
  }
  function fromCelsius(c, unit) {
    if (unit === 'Fahrenheit') return c * 9 / 5 + 32;
    if (unit === 'Kelvin') return c + 273.15;
    return c;
  }

  function runUnit() {
    const cat = val('tUnCat') || 'Length';
    const v = numVal('tUnVal');
    const from = val('tUnFrom'), to = val('tUnTo');
    if (!from || !to) return;
    if (!Number.isFinite(v)) return err('tUnOut', 'Enter a number.');

    let result;
    if (cat === 'Temperature') {
      result = fromCelsius(toCelsius(v, from), to);
    } else {
      const u = UNITS[cat].units;
      result = (v * u[from]) / u[to];
    }
    const pretty = Math.abs(result) >= 1e-4 && Math.abs(result) < 1e15
      ? Number(result.toPrecision(10)).toLocaleString(undefined, { maximumFractionDigits: 8 })
      : result.toExponential(6);
    out('tUnOut', row(`${v} ${from}`, `= <b>${pretty} ${esc(to)}</b>`, true));
  }

  // ══════════════════════════════════════════════════════════════════
  // PASSWORD GENERATOR
  // ══════════════════════════════════════════════════════════════════
  function renderPassword() {
    setTimeout(runPassword, 0);
    return card('🔑', 'Password Generator', `
      <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end;">
        ${field('Length', `<input type="number" id="tPwLen" value="16" min="4" max="128" oninput="Tools.runPassword()" style="width:100%;" />`)}
        <div class="setup-group" style="flex:2;min-width:260px;">
          <label>Include</label>
          <div style="display:flex;gap:16px;flex-wrap:wrap;padding-top:4px;">
            <label style="font-weight:normal;display:flex;align-items:center;gap:6px;"><input type="checkbox" id="tPwUpper" checked style="width:auto;" onchange="Tools.runPassword()" /> A-Z</label>
            <label style="font-weight:normal;display:flex;align-items:center;gap:6px;"><input type="checkbox" id="tPwLower" checked style="width:auto;" onchange="Tools.runPassword()" /> a-z</label>
            <label style="font-weight:normal;display:flex;align-items:center;gap:6px;"><input type="checkbox" id="tPwDigit" checked style="width:auto;" onchange="Tools.runPassword()" /> 0-9</label>
            <label style="font-weight:normal;display:flex;align-items:center;gap:6px;"><input type="checkbox" id="tPwSym" checked style="width:auto;" onchange="Tools.runPassword()" /> Symbols</label>
            <label style="font-weight:normal;display:flex;align-items:center;gap:6px;"><input type="checkbox" id="tPwAmb" style="width:auto;" onchange="Tools.runPassword()" /> Avoid look-alikes</label>
          </div>
        </div>
      </div>
      <div class="process-controls" style="margin-top:14px;">
        <button class="process-btn start-btn" onclick="Tools.runPassword()">🔄 Generate</button>
        <button class="process-btn clear-btn" onclick="Tools.copyPassword()">📋 Copy</button>
      </div>
      <div id="tPwOut" style="margin-top:14px;"></div>`,
      'Generated with your browser\'s cryptographic random generator, and never sent anywhere.');
  }

  function runPassword() {
    const len = Math.max(4, Math.min(128, parseInt(val('tPwLen'), 10) || 16));
    const chk = (id) => { const el = document.getElementById(id); return el ? el.checked : false; };
    const avoidAmbiguous = chk('tPwAmb');

    let upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', lower = 'abcdefghijklmnopqrstuvwxyz';
    let digits = '0123456789', symbols = '!@#$%^&*()-_=+[]{};:,.?';
    if (avoidAmbiguous) {
      // Characters people misread when typing a password off a screen.
      upper = upper.replace(/[IO]/g, ''); lower = lower.replace(/[lo]/g, '');
      digits = digits.replace(/[01]/g, '');
    }

    const pools = [];
    if (chk('tPwUpper')) pools.push(upper);
    if (chk('tPwLower')) pools.push(lower);
    if (chk('tPwDigit')) pools.push(digits);
    if (chk('tPwSym')) pools.push(symbols);
    if (!pools.length) return err('tPwOut', 'Tick at least one character type.');

    const all = pools.join('');
    const rand = (n) => {
      const a = new Uint32Array(1);
      crypto.getRandomValues(a);
      return a[0] % n;
    };
    // Seed one character from each selected pool so the result actually
    // satisfies every rule the user ticked, then fill the rest freely.
    const chars = pools.map(function (p) { return p[rand(p.length)]; });
    while (chars.length < len) chars.push(all[rand(all.length)]);
    // Fisher-Yates, so the seeded characters aren't always at the front.
    for (let i = chars.length - 1; i > 0; i--) {
      const j = rand(i + 1);
      const t = chars[i]; chars[i] = chars[j]; chars[j] = t;
    }
    const pw = chars.slice(0, len).join('');

    const bits = Math.round(len * Math.log2(all.length));
    const strength = bits < 50 ? ['Weak', '#b3261e'] : bits < 80 ? ['Reasonable', '#b58900'] : ['Strong', '#1b5e20'];
    out('tPwOut', `
      <div style="background:#e8f6f0;border-radius:6px;padding:14px;font-family:monospace;font-size:1.15rem;word-break:break-all;color:#12a37a;font-weight:700;">${esc(pw)}</div>
      ${row('Strength', `<span style="color:${strength[1]};font-weight:700;">${strength[0]}</span> (~${bits} bits)`)}
      ${row('Character pool', all.length + ' possible characters')}`);
  }

  function copyPassword() {
    const el = document.querySelector('#tPwOut div');
    if (!el) return;
    navigator.clipboard.writeText(el.textContent).then(function () {
      const o = document.getElementById('tPwOut');
      if (o) o.insertAdjacentHTML('beforeend', '<div id="tPwCopied" style="color:#1b5e20;font-size:0.84rem;margin-top:6px;">Copied to clipboard.</div>');
      setTimeout(function () { const c = document.getElementById('tPwCopied'); if (c) c.remove(); }, 1800);
    }).catch(function () {});
  }

  // ══════════════════════════════════════════════════════════════════
  // CURRENCY CONVERTER
  // ══════════════════════════════════════════════════════════════════
  // Live rates need a paid/rate-limited API, so rates are user-editable and
  // stored locally. The card states plainly that they are manual - a
  // converter that silently uses stale rates would be worse than one that
  // says so.
  const RATE_KEY = 'lexora_fx_rates';
  const DEFAULT_RATES = { USD: 1, EUR: 0.92, GBP: 0.79, INR: 83.2, AED: 3.67, SGD: 1.35, AUD: 1.52, CAD: 1.36, JPY: 157.0, CHF: 0.89, CNY: 7.24, SAR: 3.75 };

  function loadRates() {
    try {
      const raw = localStorage.getItem(RATE_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (p && p.rates && typeof p.rates === 'object') return p;
      }
    } catch (e) { /* fall through to defaults */ }
    return { rates: Object.assign({}, DEFAULT_RATES), updated: null };
  }

  function renderCurrency() {
    setTimeout(runCurrency, 0);
    const store = loadRates();
    const codes = Object.keys(store.rates);
    const opts = (sel) => codes.map(function (c) { return `<option value="${c}" ${c === sel ? 'selected' : ''}>${c}</option>`; }).join('');
    return card('💱', 'Currency Converter', `
      <div style="display:flex;gap:14px;flex-wrap:wrap;">
        ${field('Amount', `<input type="number" id="tFxAmt" value="100" step="any" oninput="Tools.runCurrency()" style="width:100%;" />`)}
        ${field('From', `<select id="tFxFrom" onchange="Tools.runCurrency()" style="width:100%;">${opts('USD')}</select>`)}
        ${field('To', `<select id="tFxTo" onchange="Tools.runCurrency()" style="width:100%;">${opts('INR')}</select>`)}
      </div>
      <div id="tFxOut" style="margin-top:14px;"></div>
      <div style="margin-top:16px;border-top:1px solid rgba(0,0,0,0.08);padding-top:12px;">
        <label style="font-weight:600;">Exchange rates (per 1 USD)</label>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:8px;">
          ${codes.map(function (c) {
            return `<div style="display:flex;align-items:center;gap:6px;">
              <span style="font-size:0.82rem;color:#6b7280;width:38px;">${c}</span>
              <input type="number" id="tFxR_${c}" value="${store.rates[c]}" step="any"
                     oninput="Tools.runCurrency()" style="width:92px;" />
            </div>`;
          }).join('')}
        </div>
        <div class="process-controls" style="margin-top:12px;">
          <button class="process-btn start-btn" onclick="Tools.saveRates()">💾 Save Rates</button>
          <button class="process-btn clear-btn" onclick="Tools.resetRates()">↩️ Reset</button>
          <span style="font-size:0.78rem;color:rgba(0,0,0,0.5);align-self:center;margin-left:6px;">
            ${store.updated ? 'Last saved ' + esc(store.updated) : 'Using built-in reference rates'}
          </span>
        </div>
      </div>`,
      'Rates are entered manually, not fetched live - update them yourself before relying on a conversion for anything financial.');
  }

  function currentRates() {
    const store = loadRates();
    const rates = {};
    Object.keys(store.rates).forEach(function (c) {
      const v = parseFloat(val('tFxR_' + c));
      rates[c] = Number.isFinite(v) && v > 0 ? v : store.rates[c];
    });
    return rates;
  }

  function runCurrency() {
    const amt = numVal('tFxAmt'), from = val('tFxFrom'), to = val('tFxTo');
    if (!Number.isFinite(amt)) return err('tFxOut', 'Enter an amount.');
    const rates = currentRates();
    if (!rates[from] || !rates[to]) return err('tFxOut', 'Set a rate for both currencies.');
    // Rates are quoted per 1 USD, so convert through USD.
    const inUsd = amt / rates[from];
    const result = inUsd * rates[to];
    const fmt = (v) => v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
    out('tFxOut',
      row(`${fmt(amt)} ${from}`, `= <b>${fmt(result)} ${esc(to)}</b>`, true) +
      row('Rate used', `1 ${from} = ${fmt(rates[to] / rates[from])} ${to}`));
  }

  function saveRates() {
    try {
      localStorage.setItem(RATE_KEY, JSON.stringify({
        rates: currentRates(),
        updated: new Date().toISOString().slice(0, 10)
      }));
      if (window.FreeServices) FreeServices.open('currency-converter');
    } catch (e) { err('tFxOut', 'Your browser blocked local storage, so the rates could not be saved.'); }
  }

  function resetRates() {
    try { localStorage.removeItem(RATE_KEY); } catch (e) { /* nothing to clear */ }
    if (window.FreeServices) FreeServices.open('currency-converter');
  }

  // ── registration ───────────────────────────────────────────────────
  const CARDS = {
    'age-calculator': { label: 'Age Calculator', icon: '🎂', desc: 'Exact age in years, months and days.', render: renderAge },
    'timezone': { label: 'Timezone', icon: '🌍', desc: 'Convert a time between two timezones.', render: renderTimezone },
    'unit-converter': { label: 'Unit Converter', icon: '📏', desc: 'Length, weight, area, volume, speed and more.', render: renderUnit },
    'password-generator': { label: 'Password Generator', icon: '🔑', desc: 'Strong random passwords, generated locally.', render: renderPassword },
    'currency-converter': { label: 'Currency Converter', icon: '💱', desc: 'Convert amounts using your own saved rates.', render: renderCurrency }
  };

  window.Tools = {
    cards: CARDS,
    runAge: runAge,
    runTimezone: runTimezone,
    runUnit: runUnit,
    onUnitCategory: onUnitCategory,
    runPassword: runPassword,
    copyPassword: copyPassword,
    runCurrency: runCurrency,
    saveRates: saveRates,
    resetRates: resetRates
  };
})();
