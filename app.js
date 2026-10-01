'use strict';

const STORE_KEY = 'finplan.v1';
const TRACKER_MONTHS = 24;
const PLAN_ROWS = [
  { id: 'essential', name: 'Essential expenses', pct: 45 },
  { id: 'fun', name: 'Guilt-free spending', pct: 5 },
  { id: 'debt', name: 'Debt payoff / extra investing', pct: 10 },
  { id: 'short', name: 'Short-term savings goals', pct: 0 },
  { id: 'long', name: 'Long-term investing', pct: 40 },
];
const SPEND_CATS = { essential: 'Essentials', fun: 'Guilt-free' };
const TITLES = { home: 'My Money', plan: 'Plan', tracker: 'Savings Tracker', settings: 'Settings' };

// ---------- helpers ----------
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const pad = n => String(n).padStart(2, '0');
const round = n => Math.round(n * 100) / 100;
const monthKeyOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const todayISO = () => { const d = new Date(); return `${monthKeyOf(d)}-${pad(d.getDate())}`; };
const addMonths = (key, n) => { const [y, m] = key.split('-').map(Number); return monthKeyOf(new Date(y, m - 1 + n, 1)); };
const monthLabel = key => { const [y, m] = key.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }); };
const serialToISO = n => new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000).toISOString().slice(0, 10);

function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  let s = String(v ?? '').trim();
  // iOS decimal keypads in some regions type "," as the decimal separator.
  s = s.includes(',') && !s.includes('.') ? s.replace(',', '.') : s.replace(/,/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}
const fmtUSD = n => (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtEGP = n => (n < 0 ? '-' : '') + 'EGP ' + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
const fmtMoney = (n, cur) => (cur === 'EGP' ? fmtEGP(num(n)) : fmtUSD(num(n)));

// ---------- state ----------
function defaultState() {
  const month = monthKeyOf(new Date());
  return {
    version: 1,
    settings: {
      fx: 50, fxUpdated: todayISO(),
      defaultCurrency: 'USD', defaultCategory: 'essential', rollover: true,
      budgetStart: month, trackerStart: month,
    },
    income: [], savings: [], shortTerm: [], bufferPct: 10,
    plan: PLAN_ROWS.map(r => ({ ...r })),
    expenses: [], tracker: {},
  };
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && s.version === 1) return s;
  } catch { /* corrupted storage falls back to onboarding */ }
  return null;
}
const save = () => localStorage.setItem(STORE_KEY, JSON.stringify(state));

let state = load();
let view = 'home';
let editingId = null;

// ---------- calculations ----------
const usd = (amount, cur) => (cur === 'EGP' ? num(amount) / (num(state.settings.fx) || 1) : num(amount));
const sumUSD = rows => rows.reduce((t, r) => t + usd(r.amount, r.currency), 0);

function totals() {
  const income = sumUSD(state.income);
  const savings = sumUSD(state.savings);
  const shortSub = sumUSD(state.shortTerm);
  const buffer = shortSub * num(state.bufferPct) / 100;
  const shortTotal = shortSub + buffer;
  const planAmt = id => income * num(state.plan.find(p => p.id === id)?.pct) / 100;
  return { income, savings, shortSub, buffer, shortTotal, afterAll: savings - shortTotal, planAmt };
}

function budget(cat, key = monthKeyOf(new Date())) {
  const monthly = totals().planAmt(cat);
  // Expenses dated before the budget start month are not counted.
  let m = state.settings.budgetStart;
  let carry = 0, carryIn = 0, spent = 0, left = monthly;
  while (m <= key) {
    carryIn = carry;
    spent = state.expenses
      .filter(e => e.category === cat && e.date.startsWith(m))
      .reduce((s, e) => s + usd(e.amount, e.currency), 0);
    left = monthly + carryIn - spent;
    carry = state.settings.rollover ? left : 0;
    m = addMonths(m, 1);
  }
  return { monthly, carryIn, spent, left, available: monthly + carryIn };
}

// Target = savings today + long-term monthly × months − short-term expenses; actual is the full balance.
function trackerRows() {
  const t = totals();
  const long = t.planAmt('long');
  const rows = [];
  for (let i = 0; i < TRACKER_MONTHS; i++) {
    const key = addMonths(state.settings.trackerStart, i);
    const target = t.savings + long * i - t.shortTotal;
    const raw = state.tracker[key];
    const actual = raw === undefined || raw === null || raw === '' ? null : num(raw);
    const diff = actual === null ? null : actual - t.shortTotal - target;
    rows.push({ key, target, actual, diff });
  }
  return rows;
}

// ---------- views ----------
function render() {
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $('#title').textContent = state ? TITLES[view] : 'Welcome';
  $('#fab').hidden = !state || view !== 'home';
  document.body.classList.toggle('onboarding', !state);
  const main = $('#view');
  if (!state) { main.innerHTML = welcomeHTML(); return; }
  main.innerHTML = { home: homeHTML, plan: planHTML, tracker: trackerHTML, settings: settingsHTML }[view]();
  main.querySelectorAll('.bar > span[data-pct]').forEach(s => { s.style.width = Math.max(0, Math.min(100, +s.dataset.pct)) + '%'; });
  refreshLive();
}

function refreshLive() {
  if (view === 'plan') refreshPlan();
  if (view === 'tracker') refreshTracker();
  if (view === 'settings') $('#fx-updated').textContent = `Last updated ${state.settings.fxUpdated}`;
}

function welcomeHTML() {
  return `<section class="card">
    <h2>Let's get started</h2>
    <p>Import your <b>Financial_Plan_fixed.xlsx</b> file to load your income, savings, expenses and plan.</p>
    <p class="small muted">Your data is stored only on this device. Nothing is sent anywhere.</p>
    <button class="btn primary" data-action="import-xlsx">Import Excel file</button>
    <button class="btn" data-action="restore-json">Restore a backup</button>
    <button class="btn ghost" data-action="start-empty">Start empty</button>
  </section>`;
}

function barHTML(b) {
  const pct = b.available > 0 ? b.spent / b.available * 100 : (b.spent > 0 ? 100 : 0);
  return `<div class="bar ${pct >= 100 ? 'over' : pct >= 80 ? 'warn' : ''}"><span data-pct="${pct}"></span></div>`;
}

function expHTML(e) {
  const d = new Date(e.date + 'T00:00:00');
  return `<button class="exp" data-action="edit-exp" data-id="${esc(e.id)}">
    <span class="exp-date"><b>${d.getDate()}</b><span>${d.toLocaleDateString('en-US', { month: 'short' })}</span></span>
    <span class="exp-main"><span>${esc(e.note || SPEND_CATS[e.category])}</span><span class="exp-sub">${SPEND_CATS[e.category]}</span></span>
    <span class="exp-amt"><b>${fmtMoney(e.amount, e.currency)}</b>${e.currency === 'EGP' ? `<span class="exp-sub">${fmtUSD(usd(e.amount, 'EGP'))}</span>` : ''}</span>
  </button>`;
}

function homeHTML() {
  const t = totals();
  const key = monthKeyOf(new Date());
  const ess = budget('essential', key);
  const fun = budget('fun', key);
  const now = new Date();
  const daysLeft = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() - now.getDate() + 1;
  const tr = trackerRows().find(r => r.key === key);
  const list = state.expenses
    .filter(e => e.date.startsWith(key))
    .sort((a, b) => b.date.localeCompare(a.date) || (b.created || 0) - (a.created || 0));

  const trackerHTMLPart = !tr ? '' : `
    <div class="stat"><span>Savings target (${monthLabel(key)})</span><b>${fmtUSD(tr.target)}</b></div>
    ${tr.diff === null
      ? '<div class="small muted">Enter this month\'s balance in the Tracker tab.</div>'
      : `<div class="stat"><span>Tracker</span><b class="${tr.diff >= 0 ? 'pos' : 'neg'}">${tr.diff >= 0 ? 'On track +' : 'Behind '}${fmtUSD(tr.diff)}</b></div>`}`;

  return `
  <section class="card hero ${ess.left < 0 ? 'neg' : ''}">
    <div class="label">Essentials left · ${monthLabel(key)}</div>
    <div class="big">${fmtUSD(ess.left)}</div>
    <div class="small muted">≈ ${fmtEGP(ess.left * num(state.settings.fx))}</div>
    ${barHTML(ess)}
    <div class="row-between small">
      <span>Spent ${fmtUSD(ess.spent)} of ${fmtUSD(ess.available)}</span>
      <span>${ess.left > 0 ? `${fmtUSD(ess.left / daysLeft)}/day · ${daysLeft}d left` : ''}</span>
    </div>
    ${ess.carryIn ? `<div class="small muted">Includes ${fmtUSD(ess.carryIn)} rolled over</div>` : ''}
  </section>

  <section class="card">
    <div class="row-between"><span class="label">Guilt-free left</span><b class="${fun.left < 0 ? 'neg' : ''}">${fmtUSD(fun.left)}</b></div>
    ${barHTML(fun)}
    <div class="small muted">Spent ${fmtUSD(fun.spent)} of ${fmtUSD(fun.available)}</div>
  </section>

  <section class="card">
    <h3>Financial status</h3>
    <div class="stat first"><span>Monthly income</span><b>${fmtUSD(t.income)}</b></div>
    <div class="stat"><span>Current savings</span><b>${fmtUSD(t.savings)}</b></div>
    <div class="stat"><span>Short-term expenses (incl. ${num(state.bufferPct)}% buffer)</span><b>${fmtUSD(t.shortTotal)}</b></div>
    <div class="stat total"><span>Left after paying everything</span><b class="${t.afterAll < 0 ? 'neg' : 'pos'}">${fmtUSD(t.afterAll)}</b></div>
    ${trackerHTMLPart}
  </section>

  <section class="card">
    <div class="row-between"><h3>This month's expenses</h3><span class="small muted">${list.length}</span></div>
    ${list.length ? list.map(expHTML).join('') : '<p class="small muted">No expenses yet. Tap + to add one.</p>'}
  </section>`;
}

function listSection(key, title, extra = '') {
  const rows = state[key].map(r => `
    <div class="item" data-list="${key}" data-id="${esc(r.id)}">
      <input data-field="name" value="${esc(r.name)}" placeholder="Name">
      <div class="item-row">
        <input class="amt" data-field="amount" inputmode="decimal" value="${esc(r.amount)}" placeholder="0">
        <select data-field="currency">
          <option ${r.currency === 'USD' ? 'selected' : ''}>USD</option>
          <option ${r.currency === 'EGP' ? 'selected' : ''}>EGP</option>
        </select>
        <button class="icon" data-action="del-row" aria-label="Delete">&times;</button>
      </div>
    </div>`).join('');
  return `<section class="card">
    <div class="row-between"><h3>${title}</h3><b id="tot-${key}"></b></div>
    ${rows}
    ${extra}
    <button class="btn ghost" data-action="add-row" data-target="${key}">+ Add</button>
  </section>`;
}

function planHTML() {
  const bufferField = `
    <div class="inline-field"><span>Contingency buffer</span><input data-scalar="bufferPct" inputmode="decimal" value="${esc(state.bufferPct)}"><span class="small">%</span></div>
    <div class="small muted" id="short-detail"></div>`;
  const split = state.plan.map(p => `
    <div class="split">
      <span>${esc(p.name)}</span>
      <input data-plan="${p.id}" inputmode="decimal" value="${esc(p.pct)}">
      <span class="small">%</span>
      <b id="amt-${p.id}"></b>
    </div>`).join('');
  return `
    ${listSection('income', 'Monthly income')}
    ${listSection('savings', 'Current savings')}
    ${listSection('shortTerm', 'Short-term expenses', bufferField)}
    <section class="card">
      <div class="row-between"><h3>Monthly split</h3><b id="tot-pct"></b></div>
      ${split}
      <div class="small neg" id="pct-warn"></div>
    </section>`;
}

function refreshPlan() {
  const t = totals();
  const set = (id, text, cls) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    if (cls !== undefined) el.className = cls;
  };
  set('tot-income', fmtUSD(t.income));
  set('tot-savings', fmtUSD(t.savings));
  set('tot-shortTerm', fmtUSD(t.shortTotal));
  set('short-detail', `Items ${fmtUSD(t.shortSub)} + buffer ${fmtUSD(t.buffer)}`);
  const pct = round(state.plan.reduce((s, p) => s + num(p.pct), 0));
  state.plan.forEach(p => set('amt-' + p.id, fmtUSD(t.planAmt(p.id))));
  set('tot-pct', pct + '%', pct === 100 ? 'pos' : 'neg');
  set('pct-warn', pct === 100 ? '' : 'The split should add up to 100%.');
}

function trackerHTML() {
  const t = totals();
  const current = monthKeyOf(new Date());
  const rows = trackerRows().map(r => `
    <div class="trow ${r.key === current ? 'current' : ''}" data-key="${r.key}">
      <div class="tmonth">${monthLabel(r.key)}</div>
      <div class="ttarget"><span class="small muted">Target</span><span class="tval">${fmtUSD(r.target)}</span></div>
      <input data-track="${r.key}" inputmode="decimal" placeholder="Balance" value="${r.actual ?? ''}">
      <div class="tstatus"></div>
    </div>`).join('');
  return `
    <section class="card small muted">
      Target = current savings (${fmtUSD(t.savings)}) + ${fmtUSD(t.planAmt('long'))}/month long-term investing
      − short-term expenses (${fmtUSD(t.shortTotal)}).<br>
      Type your <b>full savings balance</b> each month; the short-term expenses are subtracted for you.
    </section>
    <section class="card">${rows}</section>`;
}

function refreshTracker() {
  trackerRows().forEach(r => {
    const el = document.querySelector(`.trow[data-key="${r.key}"] .tstatus`);
    if (!el) return;
    el.className = 'tstatus ' + (r.diff === null ? '' : r.diff >= 0 ? 'pos' : 'neg');
    el.textContent = r.diff === null ? '' : `${r.diff >= 0 ? 'On track +' : 'Behind '}${fmtUSD(r.diff)}`;
  });
}

function seg(key, options) {
  const cur = String(state.settings[key]);
  return `<div class="seg">${options.map(([v, label]) =>
    `<button type="button" class="${String(v) === cur ? 'on' : ''}" data-action="set" data-key="${key}" data-value="${v}">${label}</button>`).join('')}</div>`;
}

function settingsHTML() {
  const s = state.settings;
  return `
  <section class="card">
    <h3>Exchange rate</h3>
    <div class="field"><label>EGP per 1 USD</label><input data-setting="fx" inputmode="decimal" value="${esc(s.fx)}"></div>
    <div class="small muted" id="fx-updated"></div>
  </section>
  <section class="card">
    <h3>Quick add defaults</h3>
    <div class="field"><label>Currency</label>${seg('defaultCurrency', [['USD', 'USD'], ['EGP', 'EGP']])}</div>
    <div class="field"><label>Category</label>${seg('defaultCategory', [['essential', 'Essentials'], ['fun', 'Guilt-free']])}</div>
  </section>
  <section class="card">
    <h3>Budget</h3>
    <div class="field"><label>Roll over unspent money to next month</label>${seg('rollover', [[true, 'On'], [false, 'Off']])}</div>
    <div class="field"><label>Budget start month</label><input type="month" data-setting="budgetStart" value="${esc(s.budgetStart)}"></div>
    <div class="field"><label>Savings tracker start month</label><input type="month" data-setting="trackerStart" value="${esc(s.trackerStart)}"></div>
  </section>
  <section class="card">
    <h3>Data</h3>
    <p class="small muted">Everything is stored only on this device. Back up regularly: removing the app from your Home Screen deletes its data.</p>
    <button class="btn primary" data-action="backup">Back up now</button>
    <button class="btn" data-action="restore-json">Restore a backup</button>
    <button class="btn" data-action="import-xlsx">Re-import Excel file</button>
    <button class="btn danger" data-action="erase">Erase all data</button>
  </section>`;
}

// ---------- quick add sheet ----------
function setSeg(id, value) {
  const el = document.getElementById(id);
  el.dataset.value = value;
  el.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === value));
}

function updateEq() {
  const amount = num($('#expAmount').value);
  const cur = $('#expCurrency').dataset.value;
  const fx = num(state.settings.fx) || 1;
  $('#expEq').textContent = !amount ? '' : cur === 'EGP' ? `≈ ${fmtUSD(amount / fx)}` : `≈ ${fmtEGP(amount * fx)}`;
}

function openSheet(exp) {
  editingId = exp ? exp.id : null;
  $('#sheetTitle').textContent = exp ? 'Edit expense' : 'Add expense';
  $('#expAmount').value = exp ? exp.amount : '';
  setSeg('expCurrency', exp ? exp.currency : state.settings.defaultCurrency);
  setSeg('expCategory', exp ? exp.category : state.settings.defaultCategory);
  $('#expNote').value = exp ? exp.note : '';
  $('#expDate').value = exp ? exp.date : todayISO();
  $('#expDelete').hidden = !exp;
  updateEq();
  $('#sheet').hidden = false;
  $('#expAmount').focus();
}

function closeSheet() {
  document.activeElement?.blur();
  $('#sheet').hidden = true;
  editingId = null;
}

// ---------- xlsx import (no libraries: minimal zip reader + DOMParser) ----------
async function readZip(buf) {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This is not a valid .xlsx file.');
  const dec = new TextDecoder();
  const files = {};
  let p = dv.getUint32(eocd + 16, true);
  for (let i = 0, n = dv.getUint16(eocd + 10, true); i < n; i++) {
    const nameLen = dv.getUint16(p + 28, true);
    files[dec.decode(u8.subarray(p + 46, p + 46 + nameLen))] = {
      method: dv.getUint16(p + 10, true),
      size: dv.getUint32(p + 20, true),
      offset: dv.getUint32(p + 42, true),
    };
    p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  return async name => {
    const f = files[name];
    if (!f) return null;
    const start = f.offset + 30 + dv.getUint16(f.offset + 26, true) + dv.getUint16(f.offset + 28, true);
    const data = u8.subarray(start, start + f.size);
    if (f.method === 0) return dec.decode(data);
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).text();
  };
}

async function parseWorkbook(buf) {
  const get = await readZip(buf);
  const xml = s => new DOMParser().parseFromString(s, 'application/xml');
  const wbText = await get('xl/workbook.xml');
  if (!wbText) throw new Error('This is not an Excel workbook.');
  const relMap = {};
  for (const r of xml(await get('xl/_rels/workbook.xml.rels')).getElementsByTagName('Relationship')) {
    relMap[r.getAttribute('Id')] = r.getAttribute('Target');
  }
  const ssText = await get('xl/sharedStrings.xml');
  const shared = ssText ? [...xml(ssText).getElementsByTagName('si')].map(si =>
    [...si.getElementsByTagName('t')].filter(t => t.parentNode.nodeName !== 'rPh').map(t => t.textContent).join('')) : [];
  const paths = {};
  for (const s of xml(wbText).getElementsByTagName('sheet')) {
    const target = relMap[s.getAttribute('r:id')] || '';
    paths[s.getAttribute('name')] = target.startsWith('/') ? target.slice(1) : 'xl/' + target;
  }

  async function sheet(name) {
    if (!paths[name]) return null;
    const cells = {};
    for (const c of xml(await get(paths[name])).getElementsByTagName('c')) {
      const t = c.getAttribute('t');
      const v = c.getElementsByTagName('v')[0];
      const f = c.getElementsByTagName('f')[0];
      let val = v ? v.textContent : null;
      if (t === 's') val = shared[+val] ?? null;
      else if (t === 'inlineStr') val = [...c.getElementsByTagName('t')].map(x => x.textContent).join('');
      else if (val !== null && val !== '' && t !== 'str' && t !== 'e') val = Number(val);
      cells[c.getAttribute('r')] = { v: val === '' ? null : val, f: f ? f.textContent : null };
    }
    return { v: r => cells[r]?.v ?? null, f: r => cells[r]?.f ?? null };
  }

  const se = await sheet('Savings & Expenses');
  if (!se) throw new Error('Sheet "Savings & Expenses" was not found.');
  const fx = num(se.v('B5')) || 50;
  const rows = (from, to) => {
    const out = [];
    for (let r = from; r <= to; r++) {
      const name = se.v('A' + r);
      if (name === null || String(name).trim() === '') continue;
      out.push({ id: uid(), name: String(name).trim(), amount: num(se.v('B' + r)), currency: se.v('C' + r) === 'EGP' ? 'EGP' : 'USD' });
    }
    return out;
  };
  const income = rows(10, 13);
  const savings = rows(19, 26);
  const shortTerm = rows(31, 49);
  const shortSub = shortTerm.reduce((t, r) => t + (r.currency === 'EGP' ? r.amount / fx : r.amount), 0);
  const bufferMatch = /\*\s*([\d.]+)\s*$/.exec(se.f('B50') || '');
  const bufferPct = bufferMatch ? round(num(bufferMatch[1]) * 100) : shortSub > 0 ? round(num(se.v('B50')) / shortSub * 100) : 0;
  const b6 = se.v('B6');

  const mp = await sheet('Monthly Plan');
  const plan = PLAN_ROWS.map((p, i) => {
    const pct = mp ? mp.v('C' + (9 + i)) : null;
    return { ...p, pct: typeof pct === 'number' ? round(pct * 100) : p.pct };
  });

  const st = await sheet('Savings Tracker');
  let trackerStart = monthKeyOf(new Date());
  const tracker = {};
  if (st) {
    const dateMatch = /DATE\((\d{4}),\s*(\d{1,2})/.exec(st.f('B4') || '');
    if (dateMatch) trackerStart = `${dateMatch[1]}-${pad(dateMatch[2])}`;
    else if (typeof st.v('B4') === 'number') trackerStart = serialToISO(st.v('B4')).slice(0, 7);
    for (let i = 0; i < TRACKER_MONTHS; i++) {
      const v = st.v('D' + (13 + i));
      if (typeof v === 'number') tracker[addMonths(trackerStart, i)] = v;
    }
  }

  return {
    settings: { fx, fxUpdated: typeof b6 === 'number' ? serialToISO(b6) : String(b6 || todayISO()), trackerStart },
    income, savings, shortTerm, bufferPct, plan, tracker,
  };
}

function applyImport(data) {
  if (state && !confirm('Replace income, savings, short-term expenses, plan % and tracker with the Excel file?\n\nYour daily expenses and settings are kept.')) return;
  const base = state || defaultState();
  state = { ...base, ...data, settings: { ...base.settings, ...data.settings } };
  save();
  view = 'home';
  render();
}

// ---------- backup / restore ----------
async function backup() {
  const name = `finplan-backup-${todayISO()}.json`;
  const file = new File([JSON.stringify(state, null, 2)], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; }
    catch (err) { if (err.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function restore(text) {
  const s = JSON.parse(text);
  const ok = s && s.version === 1 && typeof s.settings === 'object' && typeof s.tracker === 'object'
    && ['income', 'savings', 'shortTerm', 'plan', 'expenses'].every(k => Array.isArray(s[k]));
  if (!ok) throw new Error('This is not a Financial Plan backup file.');
  if (state && !confirm('Replace ALL current data with this backup?')) return;
  state = s;
  save();
  view = 'home';
  render();
}

// ---------- events ----------
const actions = {
  'add-exp': () => openSheet(),
  'edit-exp': btn => openSheet(state.expenses.find(e => e.id === btn.dataset.id)),
  'close-sheet': closeSheet,
  'import-xlsx': () => $('#fileXlsx').click(),
  'restore-json': () => $('#fileJson').click(),
  'backup': backup,
  'start-empty': () => { state = defaultState(); save(); render(); },
  'add-row': btn => {
    const key = btn.dataset.target;
    state[key].push({ id: uid(), name: '', amount: 0, currency: state.settings.defaultCurrency });
    save();
    render();
    const names = document.querySelectorAll(`[data-list="${key}"] [data-field="name"]`);
    names[names.length - 1]?.focus();
  },
  'del-row': btn => {
    const item = btn.closest('[data-list]');
    const list = item.dataset.list;
    const row = state[list].find(r => r.id === item.dataset.id);
    if (!confirm(`Delete "${row.name || 'this row'}"?`)) return;
    state[list] = state[list].filter(r => r !== row);
    save();
    render();
  },
  'set': btn => {
    const { key, value } = btn.dataset;
    state.settings[key] = key === 'rollover' ? value === 'true' : value;
    save();
    render();
  },
  'erase': () => {
    if (!confirm('Erase ALL data on this device? Make a backup first.')) return;
    if (!confirm('Are you sure? This cannot be undone.')) return;
    localStorage.removeItem(STORE_KEY);
    state = null;
    view = 'home';
    render();
  },
};

document.addEventListener('click', e => {
  const tab = e.target.closest('[data-view]');
  if (tab && state) { view = tab.dataset.view; render(); window.scrollTo(0, 0); return; }
  const btn = e.target.closest('[data-action]');
  if (btn && actions[btn.dataset.action]) actions[btn.dataset.action](btn);
});

$('#view').addEventListener('input', e => {
  const el = e.target;
  const d = el.dataset;
  const item = el.closest('[data-list]');
  if (item && d.field) {
    const row = state[item.dataset.list].find(r => r.id === item.dataset.id);
    row[d.field] = d.field === 'amount' ? num(el.value) : el.value;
  } else if (d.scalar) {
    state[d.scalar] = num(el.value);
  } else if (d.plan) {
    state.plan.find(p => p.id === d.plan).pct = num(el.value);
  } else if (d.track) {
    if (el.value.trim() === '') delete state.tracker[d.track];
    else state.tracker[d.track] = num(el.value);
  } else if (d.setting === 'fx') {
    state.settings.fx = num(el.value) || state.settings.fx;
    state.settings.fxUpdated = todayISO();
  } else if (d.setting && /^\d{4}-\d{2}$/.test(el.value)) {
    state.settings[d.setting] = el.value;
  } else {
    return;
  }
  save();
  refreshLive();
});

$('#sheet').addEventListener('click', e => {
  if (e.target.id === 'sheet') return closeSheet();
  const b = e.target.closest('.seg button[data-v]');
  if (b) { setSeg(b.parentElement.id, b.dataset.v); updateEq(); }
});
$('#expAmount').addEventListener('input', updateEq);

$('#expForm').addEventListener('submit', e => {
  e.preventDefault();
  const amount = num($('#expAmount').value);
  if (amount <= 0) { $('#expAmount').focus(); return; }
  const date = $('#expDate').value;
  const data = {
    amount,
    currency: $('#expCurrency').dataset.value,
    category: $('#expCategory').dataset.value,
    note: $('#expNote').value.trim().slice(0, 80),
    date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : todayISO(),
  };
  const existing = editingId && state.expenses.find(x => x.id === editingId);
  if (existing) Object.assign(existing, data);
  else state.expenses.push({ id: uid(), created: Date.now(), ...data });
  save();
  closeSheet();
  render();
});

$('#expDelete').addEventListener('click', () => {
  if (!confirm('Delete this expense?')) return;
  state.expenses = state.expenses.filter(x => x.id !== editingId);
  save();
  closeSheet();
  render();
});

$('#fileXlsx').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try { applyImport(await parseWorkbook(await file.arrayBuffer())); }
  catch (err) { alert('Could not import: ' + err.message); }
});

$('#fileJson').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try { restore(await file.text()); }
  catch (err) { alert('Could not restore: ' + err.message); }
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');
navigator.storage?.persist?.();
render();
