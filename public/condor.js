const REFRESH_MS = 30_000;
const $ = (id) => document.getElementById(id);
const money = (x, dp = 2) => (x == null || !Number.isFinite(x) ? '—' : `${x < 0 ? '−' : ''}$${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`);
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of children) e.append(c);
  return e;
}
const svgEl = (tag, attrs = {}, text) => {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
};

async function load() {
  try {
    const res = await fetch('/api/condor');
    const d = await res.json();
    render(d);
  } catch (e) {
    $('summary').textContent = `Couldn't reach the bot: ${e.message}`;
  }
  setTimeout(load, REFRESH_MS);
}

function render(d) {
  const paper = d.mode === 'paper';
  $('mode').textContent = paper ? 'Paper trading' : 'Dry run';
  $('mode').classList.toggle('paper', paper);
  const open = (d.positions ?? []).length;
  const entry = d.entry;

  const h1 = $('headline');
  if (d.error) {
    h1.replaceChildren('SPX iron condor: ', el('span', { class: 'chip wait' }, 'data error'));
    $('summary').textContent = d.error;
  } else if (entry?.ok) {
    h1.replaceChildren('SPX iron condor: ', el('span', { class: 'chip' }, 'entry signal'));
    const c = entry.condor;
    $('summary').textContent = `Sell the ${c.expiry} ${c.strikes.longPut}/${c.strikes.shortPut} put spread and ${c.strikes.shortCall}/${c.strikes.longCall} call spread for about ${money(c.credit)} credit, ${entry.size.qty} contract${entry.size.qty === 1 ? '' : 's'}.`;
  } else {
    h1.replaceChildren('SPX iron condor: ', el('span', { class: 'chip wait' }, 'no entry'));
    const failed = (entry?.checks ?? []).filter((c) => !c.pass);
    $('summary').textContent = failed.length ? `Waiting on: ${failed.map((c) => c.label.toLowerCase()).join(', ')}.` : 'Waiting.';
  }

  const m = d.market ?? {};
  $('meta').textContent = `SPX ${m.spx?.toFixed(2) ?? '—'} · VIX ${m.vix?.toFixed(2) ?? '—'} · equity ${money(d.account?.equity, 0)} · ${open} open · option quotes: ${m.feed ?? '—'} · updated ${new Date(d.at).toLocaleTimeString()}`;
  const session = d.entry?.checks?.find((c) => c.id === 'session');
  $('status-text').textContent = session?.pass ? 'Entry window open' : 'Entry window closed';
  $('dot').classList.toggle('open', !!session?.pass);

  renderLadder(entry?.condor, d.market?.spx);
  renderChecks(entry);
  renderOpen(d.positions ?? [], d.config);
  renderClosed(d.closed ?? []);
  renderLog(d.log ?? []);
  renderRules(d.config);
}

function renderLadder(c, spx) {
  const box = $('ladder');
  if (!c || c.error) {
    box.hidden = true;
    return;
  }
  const s = c.strikes;
  const lo = s.longPut - c.width * 0.6;
  const hi = s.longCall + c.width * 0.6;
  const W = 760;
  const x = (v) => 20 + ((v - lo) / (hi - lo)) * (W - 40);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} 92`, role: 'img', 'aria-label': 'Proposed condor strikes' });
  svg.append(
    svgEl('line', { x1: 20, x2: W - 20, y1: 46, y2: 46, class: 'axis' }),
    svgEl('rect', { x: x(s.longPut), y: 36, width: x(s.shortPut) - x(s.longPut), height: 20, rx: 3, class: 'wing' }),
    svgEl('rect', { x: x(s.shortPut), y: 36, width: x(s.shortCall) - x(s.shortPut), height: 20, rx: 3, class: 'body' }),
    svgEl('rect', { x: x(s.shortCall), y: 36, width: x(s.longCall) - x(s.shortCall), height: 20, rx: 3, class: 'wing' }),
  );
  [['longPut', 'long put'], ['shortPut', `short put Δ${Math.abs(c.deltas.shortPut).toFixed(2)}`], ['shortCall', `short call Δ${c.deltas.shortCall.toFixed(2)}`], ['longCall', 'long call']].forEach(([k, label], i) => {
    const xx = x(s[k]);
    const above = i % 2 === 1;
    svg.append(
      svgEl('line', { x1: xx, x2: xx, y1: 32, y2: 60, class: 'tick' }),
      svgEl('text', { x: xx, y: above ? 22 : 80, 'text-anchor': 'middle' }, String(s[k])),
      svgEl('text', { x: xx, y: above ? 9 : 91, 'text-anchor': 'middle', class: 'muted' }, label),
    );
  });
  if (Number.isFinite(spx) && spx > lo && spx < hi) {
    svg.append(svgEl('line', { x1: x(spx), x2: x(spx), y1: 30, y2: 62, class: 'spot' }),
      svgEl('text', { x: x(spx), y: 74, 'text-anchor': 'middle', class: 'muted' }, `SPX ${spx.toFixed(0)}`));
  }
  box.replaceChildren(svg, el('p', { class: 'meta' }, `${c.expiry} · ${c.dte} DTE · ${c.width}-point wings · mid credit ${money(c.credit)} (natural ${money(c.natural)}) · max loss ${money(c.maxLossPerContract, 0)} per contract`));
  box.hidden = false;
}

function renderChecks(entry) {
  $('entry-sub').textContent = entry ? (entry.ok ? 'all rules pass' : `${entry.checks.filter((c) => !c.pass).length} of ${entry.checks.length} failing`) : '';
  $('checks').replaceChildren(...(entry?.checks ?? []).map((c) =>
    el('li', {},
      el('div', { class: 'top' }, el('span', { class: 'name' }, el('span', { class: `pill ${c.pass ? 'pass' : 'fail'}` }), c.label), el('span', { class: 'val' }, c.pass ? 'Pass' : 'Fail')),
      el('p', {}, c.detail))));
}

const strikesText = (s) => `${s.longPut}/${s.shortPut}p · ${s.shortCall}/${s.longCall}c`;

function renderOpen(rows, cfg) {
  const tr = rows.map((p) => {
    const pnl = p.unrealized;
    return el('tr', {},
      el('td', {}, p.expiry), el('td', {}, strikesText(p.strikes)), el('td', {}, String(p.qty)), el('td', {}, money(p.credit)),
      el('td', {}, p.cost ? money(p.cost.mid) : '—'),
      el('td', { class: pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : '' }, money(pnl, 0)),
      el('td', {}, money(p.credit * (cfg?.profitTarget ?? 0.5))),
      el('td', {}, money(p.credit * (cfg?.stopMultiple ?? 2))),
      el('td', {}, p.exit ? `Exit: ${p.exit.reason}` : p.status));
  });
  $('open').replaceChildren(...(tr.length ? tr : [el('tr', {}, el('td', { colspan: '9', class: 'empty' }, 'No open condors.'))]));
}

function renderClosed(rows) {
  const tr = [...rows].reverse().map((p) => el('tr', {},
    el('td', {}, fmtTime(p.closedAt)), el('td', {}, p.expiry), el('td', {}, strikesText(p.strikes)), el('td', {}, String(p.qty)),
    el('td', {}, money(p.credit)), el('td', {}, money(p.closeDebit)), el('td', {}, p.exitReason ?? '—'),
    el('td', { class: p.pnl > 0 ? 'pos' : p.pnl < 0 ? 'neg' : '' }, money(p.pnl, 0))));
  $('closed').replaceChildren(...(tr.length ? tr : [el('tr', {}, el('td', { colspan: '8', class: 'empty' }, 'No closed condors yet.'))]));
}

const LOG_TEXT = {
  entry: (e) => `${e.mode === 'paper' ? 'Sent' : 'Simulated'} entry: ${e.qty} × ${strikesText(e.strikes)} ${e.expiry} for ${money(e.credit)} credit`,
  'entry-filled': (e) => `Entry filled at ${money(e.credit)} credit`,
  'entry-cancelled': () => 'Entry not filled in time; cancelled',
  exit: (e) => `${e.mode === 'paper' ? 'Sent' : 'Simulated'} ${e.reason} exit at ${money(e.debit)}: ${e.detail}`,
  'exit-filled': (e) => `Exit filled at ${money(e.debit)} (${e.reason}), P&L ${money(e.pnl, 0)}`,
  'exit-repricing': () => 'Exit not filled; repricing',
  'verify-sign': (e) => `Order sign check: ${e.result}`,
  error: (e) => `Error: ${e.message}`,
};

function renderLog(rows) {
  const items = rows.map((e) => el('li', {}, el('span', {}, fmtTime(e.at)), el('b', {}, (LOG_TEXT[e.type] ?? ((x) => x.type))(e))));
  $('log').replaceChildren(...(items.length ? items : [el('li', {}, el('span', {}, ''), el('span', {}, 'Nothing yet.'))]));
}

function renderRules(c) {
  if (!c) return;
  const pct = (x) => `${(x * 100).toFixed(0)}%`;
  const rows = [
    ['Expiration', `${c.minDte}–${c.maxDte} DTE, longest available`],
    ['Short strikes', `${Math.round(c.targetDelta * 100)} delta (${Math.round(c.minDelta * 100)}–${Math.round(c.maxDelta * 100)})`],
    ['Wings', `${c.wingWidth} points`],
    ['Minimum credit', `${pct(c.minCreditFraction)} of wing width`],
    ['VIX', `${c.vixMin}–${c.vixMax}`],
    ['Frequency', `≥ ${c.minDaysBetweenEntries} days apart, ≤ ${c.maxOpen} open`],
    ['Size', `${pct(c.riskPct)} of equity at max loss (${pct(c.riskPctHighVix)} when VIX ≥ ${c.highVix})`],
    ['Take profit', `cost to close ≤ ${pct(c.profitTarget)} of credit`],
    ['Stop', `cost to close ≥ ${pct(c.stopMultiple)} of credit`],
    ['Time stop', `${c.exitDte} DTE`],
    ['Account limits', `stop entries at −${pct(c.dailyLossLimit)} day / −${pct(c.weeklyLossLimit)} week`],
  ];
  $('rules').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));
}

load();
