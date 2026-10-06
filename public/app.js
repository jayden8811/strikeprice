const REFRESH_MS = 15_000;
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const demo = params.get('demo') === '1';
let ticker = (params.get('t') ?? '').toUpperCase();
let timer = null;

const money = (x) => (x == null ? '—' : `$${Number(x).toFixed(2)}`);
const pct = (x) => (x == null ? '—' : `${x}%`);
const compact = (x) => {
  if (x == null) return '—';
  const a = Math.abs(x);
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(0)}K` : a.toFixed(0);
  return `${x < 0 ? '-' : ''}$${s}`;
};

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of children) e.append(c);
  return e;
}

function sizeInput() {
  const input = $('ticker');
  input.style.width = `${Math.max(4.2, (input.value || input.placeholder).length + 0.4)}ch`;
}

async function run() {
  if (!ticker) return;
  clearTimeout(timer);
  $('meta').textContent = 'Analyzing…';
  try {
    const res = await fetch(`/api/analyze?ticker=${encodeURIComponent(ticker)}${demo ? '&demo=1' : ''}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Request failed');
    render(data);
  } catch (e) {
    $('summary').textContent = e.message;
    $('meta').textContent = '';
    $('setup').hidden = true;
  }
  if (!document.hidden) timer = setTimeout(run, REFRESH_MS);
}

function render(d) {
  const good = d.verdict === 'good';
  // Once answered, "Is [T] good to trade right now?" becomes "[T] is [good] to trade right now".
  $('headline').firstChild.textContent = '';
  $('verdict-text').replaceChildren(
    ' is ',
    el('span', { class: good ? 'chip' : 'chip bad' }, good ? 'good' : 'not good'),
    ' to trade right now',
  );

  $('summary').textContent = d.summary;
  renderSetup(d.setup);

  const time = new Date(d.asOf).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const src = d.sources?.mode === 'demo' ? 'Demo data' : `${d.sources?.prices} · ${d.sources?.options} · Flow: ${d.sources?.flow}`;
  $('meta').textContent = `${d.ticker} ${money(d.price)} · updated ${time} · ${src}`;

  const open = d.session === 'open';
  $('status-text').textContent = open ? 'Market open' : d.session === 'pre' ? 'Pre-market' : d.session === 'post' ? 'After hours' : 'Market closed';
  document.querySelector('.dot').classList.toggle('open', open);

  $('panel').hidden = false;
  renderChecks(d.checks);
  renderKv('levels', [
    ['VWAP', money(d.levels.vwap)],
    ['Opening range', d.levels.orHigh ? `${money(d.levels.orLow)} – ${money(d.levels.orHigh)}` : '—'],
    ['Prior day high / low', `${money(d.levels.priorHigh)} / ${money(d.levels.priorLow)}`],
    ['Day high / low', `${money(d.levels.dayHigh)} / ${money(d.levels.dayLow)}`],
    ['Call wall', money(d.levels.callWall)],
    ['Put wall', money(d.levels.putWall)],
    ['Gamma flip', money(d.levels.gammaFlip)],
    ['ATR (14d)', money(d.levels.atr)],
  ]);
  const m = d.metrics;
  renderKv('metrics', [
    ['ATM IV (~30d)', pct(m.atmIV)],
    ['Front-week IV', pct(m.frontIV)],
    ['Realized vol 10d / 20d', `${pct(m.rv10)} / ${pct(m.rv20)}`],
    ['Forecast realized vol', pct(m.forecastRV)],
    ['IV ÷ forecast RV', m.ivToRv ?? '—'],
    ['Median spread (ATM)', pct(m.medianSpreadPct)],
    ['Net dealer gamma (per 1%)', compact(m.netGex)],
    ['VIX · VIX/VIX3M', `${m.vix ?? '—'} · ${m.vixTerm ?? '—'}`],
    ['Next earnings', m.earningsDate ?? 'Unknown'],
  ]);
  renderFlow(d.flow);
}

function renderSetup(s) {
  const box = $('setup');
  if (!s) {
    box.hidden = true;
    return;
  }
  const c = s.contract;
  const cell = (k, v) => el('div', {}, el('dt', {}, k), el('dd', {}, v));
  box.replaceChildren(
    cell('Contract', `${c.expiry.slice(5)} $${c.strike} ${c.type}`),
    cell('Entry (option mid)', `${money(c.mid)}`),
    cell('Option target / stop', `${money(s.optionTarget)} / ${money(s.optionStop)}`),
    cell('Reward : risk', `${s.rewardRisk} : 1`),
    cell('Delta · IV', `${c.delta} · ${c.iv}%`),
    cell('Breakeven at expiry', money(s.breakeven)),
    cell('Spread', `${c.spreadPct}%`),
    cell('Days to expiry', String(c.dte)),
    el('div', { class: 'wide' }, `${s.timeStop} ${s.sizing}`),
  );
  box.hidden = false;
}

function renderChecks(checks) {
  $('checks').replaceChildren(
    ...checks.map((c) =>
      el('li', {},
        el('div', { class: 'top' },
          el('span', { class: 'name' }, el('span', { class: `pill ${c.status}` }), c.label),
          el('span', { class: 'val' }, c.value)),
        el('p', {}, c.reason)),
    ),
  );
}

function renderKv(id, rows) {
  $(id).replaceChildren(...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));
}

function renderFlow(f) {
  const total = f.bullPremium + f.bearPremium;
  $('flow-bull').style.width = total ? `${(100 * f.bullPremium) / total}%` : '0';
  $('flow-bear').style.width = total ? `${(100 * f.bearPremium) / total}%` : '0';
  $('flow-sub').textContent =
    f.source === 'feed'
      ? `last 60 min · ${compact(f.bullPremium)} bullish vs ${compact(f.bearPremium)} bearish`
      : `no live feed connected · showing contracts trading above open interest`;
  const rows = f.top.map((p) =>
    el('tr', {},
      el('td', {}, p.time ? new Date(p.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'Today'),
      el('td', { class: p.type }, `${p.expiry.slice(5)} $${p.strike} ${p.type}${p.sweep ? ' · sweep' : ''}`),
      el('td', {}, p.side ?? '—'),
      el('td', {}, String(p.size ?? '—')),
      el('td', {}, compact(p.premium))),
  );
  $('flow-rows').replaceChildren(...(rows.length ? rows : [el('tr', {}, el('td', { colspan: '5', class: 'empty' }, 'No large prints yet.'))]));
}

$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('ticker').value.trim().toUpperCase();
  if (!v) return;
  ticker = v;
  params.set('t', v);
  history.replaceState(null, '', `?${params}`);
  $('ticker').blur();
  run();
});
$('ticker').addEventListener('input', sizeInput);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && ticker) run();
});

if (ticker) $('ticker').value = ticker;
sizeInput();
if (ticker) run();
else $('ticker').focus();
