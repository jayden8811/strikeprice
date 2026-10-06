// Builds backtest/out/report.html from backtest/out/results.json.
import { readFile, writeFile } from 'node:fs/promises';

const { start, end, every, results } = JSON.parse(await readFile(new URL('./out/results.json', import.meta.url), 'utf8'));

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const pct = (x, dp = 0) => (x == null || !Number.isFinite(x) ? '—' : `${x > 0 ? '+' : ''}${(x * 100).toFixed(dp)}%`);
const usd = (x) => (x == null ? '—' : `${x < 0 ? '−' : ''}$${Math.abs(x).toFixed(2)}`);
const sign = (x) => (x > 0 ? 'pos' : x < 0 ? 'neg' : '');
const etTime = (iso) => new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
const shortDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

function stats(trades) {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const gross = (xs) => xs.reduce((a, t) => a + t.pnl, 0);
  const holdDays = trades.map((t) => (t.exitTime - Date.parse(t.time)) / 86_400_000);
  const expiry = trades.filter((t) => t.contractPath.expiryReturnPct != null);
  return {
    n,
    winRate: n ? wins.length / n : null,
    avgRet: n ? trades.reduce((a, t) => a + t.returnPct, 0) / n : null,
    total: gross(trades) * 100,
    pf: losses.length && gross(losses) !== 0 ? gross(wins) / -gross(losses) : null,
    avgWin: wins.length ? wins.reduce((a, t) => a + t.returnPct, 0) / wins.length : null,
    avgLoss: losses.length ? losses.reduce((a, t) => a + t.returnPct, 0) / losses.length : null,
    avgHold: n ? holdDays.reduce((a, b) => a + b, 0) / n : null,
    expAvg: expiry.length ? expiry.reduce((a, t) => a + t.contractPath.expiryReturnPct, 0) / expiry.length : null,
    expWin: expiry.length ? expiry.filter((t) => t.contractPath.expiryReturnPct > 0).length / expiry.length : null,
    peakAvg: n ? trades.reduce((a, t) => a + t.contractPath.maxGainPct, 0) / n : null,
  };
}

// Good flags per 30-minute bucket, as an SVG bar chart.
function timeOfDayChart(evals) {
  const buckets = [];
  for (let m = 600; m < 960; m += 30) buckets.push({ m, checks: 0, good: 0 });
  for (const e of evals) {
    const [h, mm] = e.time.split(':').map(Number);
    const b = buckets.find((x) => h * 60 + mm >= x.m && h * 60 + mm < x.m + 30);
    if (!b) continue;
    b.checks++;
    if (e.verdict === 'good') b.good++;
  }
  const W = 640, H = 170, padL = 34, padB = 26, padT = 12;
  const max = Math.max(1, ...buckets.map((b) => b.good));
  const niceMax = Math.max(1, Math.ceil(max / 2) * 2);
  const bw = (W - padL - 8) / buckets.length;
  const y = (v) => H - padB - ((H - padB - padT) * v) / niceMax;
  const ticks = [0, niceMax / 2, niceMax];
  const label = (m) => {
    const h = Math.floor(m / 60), mm = m % 60;
    return `${((h + 11) % 12) + 1}:${String(mm).padStart(2, '0')}`;
  };
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Good-to-trade flags by time of day">
    ${ticks.map((t) => `<line x1="${padL}" x2="${W - 4}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${padL - 6}" y="${y(t) + 4}" class="axis" text-anchor="end">${t}</text>`).join('')}
    ${buckets.map((b, i) => {
      const x = padL + i * bw + 3;
      const h = H - padB - y(b.good);
      return `<rect x="${x}" y="${y(b.good)}" width="${bw - 6}" height="${Math.max(0, h)}" rx="2" class="bar"><title>${label(b.m)}–${label(b.m + 30)}: ${b.good} of ${b.checks} checks</title></rect>
        ${b.good ? `<text x="${x + (bw - 6) / 2}" y="${y(b.good) - 4}" class="val" text-anchor="middle">${b.good}</text>` : ''}
        ${i % 2 === 0 ? `<text x="${x + (bw - 6) / 2}" y="${H - 8}" class="axis" text-anchor="middle">${label(b.m)}</text>` : ''}`;
    }).join('')}
  </svg>`;
}

function blockers(evals) {
  const counts = new Map();
  for (const e of evals) {
    const k = e.verdict === 'good' ? 'Flagged good to trade' : (e.reason ?? 'Other').replace(/\.$/, '');
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const total = evals.length;
  return `<ul class="blockers">${rows.map(([k, v]) => `<li><span class="b-label">${esc(k)}</span><span class="b-track"><span class="b-fill${k.startsWith('Flagged') ? ' good' : ''}" style="width:${(100 * v) / total}%"></span></span><span class="b-num">${((100 * v) / total).toFixed(1)}%</span></li>`).join('')}</ul>`;
}

function flagDays(evals) {
  const byDay = new Map();
  for (const e of evals) {
    if (e.verdict !== 'good') continue;
    if (!byDay.has(e.date)) byDay.set(e.date, []);
    byDay.get(e.date).push(e);
  }
  if (!byDay.size) return '<p class="muted">No good-to-trade flags in this period.</p>';
  return `<div class="table-wrap"><table><thead><tr><th>Day</th><th>Flags</th><th>First</th><th>Last</th><th>Direction</th></tr></thead><tbody>
    ${[...byDay.entries()].map(([d, es]) => `<tr><td>${shortDate(d)}</td><td class="num">${es.length}</td><td class="num">${es[0].time}</td><td class="num">${es.at(-1).time}</td><td>${[...new Set(es.map((e) => (e.bias === 'bull' ? 'Calls' : 'Puts')))].join(', ')}</td></tr>`).join('')}
  </tbody></table></div>`;
}

function tradeRows(trades) {
  if (!trades.length) return '<p class="muted">No trades.</p>';
  return `<div class="table-wrap"><table class="trades"><thead><tr>
      <th>Signal</th><th>Contract</th><th>Entry range</th><th>Stop</th><th>TP1 / TP2</th><th>Exit by</th><th>What happened</th><th>Result</th><th>Contract peak</th><th>At expiry</th>
    </tr></thead><tbody>
    ${trades.map((t) => {
      const s = t.setup;
      const exits = t.exits.map((x) => `${x.reason}${x.size < 1 ? ' (½)' : ''} ${usd(x.price)} ${shortDate(x.date)}`).join('<br>');
      return `<tr>
        <td><b>${shortDate(t.date)}</b> ${etTime(t.time)}<br><span class="chip ${t.direction}">${t.direction === 'bull' ? 'Call' : 'Put'}</span> @ ${t.underlyingAtEntry.toFixed(2)}</td>
        <td>${esc(t.contract.replace(/^\d{4}-/, ''))}</td>
        <td class="num">${usd(s.entryRange[0])}–${usd(s.entryRange[1])}<br><span class="muted">filled ${usd(t.fill)}</span></td>
        <td class="num">${s.stop.underlying.toFixed(2)}<br><span class="muted">opt ${usd(s.stop.option)}</span></td>
        <td class="num">${s.tp1.underlying.toFixed(2)} / ${s.tp2.underlying.toFixed(2)}<br><span class="muted">opt ${usd(s.tp1.option)} / ${usd(s.tp2.option)}</span></td>
        <td class="num">${shortDate(s.exitBy)}</td>
        <td class="small">${exits}</td>
        <td class="num ${sign(t.returnPct)}"><b>${pct(t.returnPct)}</b><br><span class="muted">${usd(t.pnl * 100)}</span></td>
        <td class="num">${usd(t.contractPath.maxPrice)} <span class="${sign(t.contractPath.maxGainPct)}">${pct(t.contractPath.maxGainPct)}</span><br><span class="muted">${t.contractPath.maxPriceDate ? shortDate(t.contractPath.maxPriceDate) : ''}</span></td>
        <td class="num ${sign(t.contractPath.expiryReturnPct)}">${usd(t.contractPath.atExpiry)}<br>${pct(t.contractPath.expiryReturnPct)}</td>
      </tr>`;
    }).join('')}
  </tbody></table></div>`;
}

const all = results.flatMap((r) => r.trades);
const allStats = stats(all);
const tile = (label, value, cls = '') => `<div class="tile"><dt>${label}</dt><dd class="${cls}">${value}</dd></div>`;

const sections = results.map(({ ticker, evals, trades }) => {
  const s = stats(trades);
  const good = evals.filter((e) => e.verdict === 'good').length;
  const days = new Set(evals.map((e) => e.date)).size;
  const goodDays = new Set(evals.filter((e) => e.verdict === 'good').map((e) => e.date)).size;
  return `<section class="ticker" id="${ticker.toLowerCase()}">
    <header class="t-head"><h2>${ticker}</h2><p>${days} trading days · ${evals.length.toLocaleString()} checks every ${every} min</p></header>
    <dl class="tiles">
      ${tile('Time flagged good', `${((100 * good) / evals.length).toFixed(1)}%`)}
      ${tile('Days with a flag', `${goodDays} of ${days}`)}
      ${tile('Trades taken', s.n)}
      ${tile('Win rate', s.winRate == null ? '—' : `${Math.round(s.winRate * 100)}%`)}
      ${tile('Avg return / trade', pct(s.avgRet, 1), sign(s.avgRet))}
      ${tile('Total P&amp;L (1 contract)', usd(s.total), sign(s.total))}
    </dl>
    <div class="cols">
      <div class="panel"><h3>When it said “good to trade”</h3><p class="muted">Flags per 30-minute window, all days combined (Eastern time).</p>${timeOfDayChart(evals)}</div>
      <div class="panel"><h3>What decided each check</h3><p class="muted">Share of all checks, by the first reason given.</p>${blockers(evals)}</div>
    </div>
    <details class="panel"><summary><h3>Every day it flagged</h3></summary>${flagDays(evals)}</details>
    <div class="panel"><h3>Trades and how each contract played out</h3>
      <p class="muted">One trade at a time; new flags are ignored while a trade is open. Fill at the top of the entry range; exits sell at the bid.</p>
      ${tradeRows(trades)}
    </div>
  </section>`;
}).join('');

const html = `<title>Strikeprice Backtest</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap">
<style>
/* Layout: one reading column; per-ticker sections with a stat strip, two analysis panels, then the trade ledger. */
:root {
  --bg: #f7f7f5; --surface: #ffffff; --ink: #1c1d1f; --muted: #6a6c72; --line: #e3e3e0;
  --accent: #2f6fd6; --accent-soft: #dbe7fa; --pos: #1d8a5a; --neg: #c8443a; --grid: #ececea;
  --display: "Geist", ui-sans-serif, system-ui, sans-serif;
  --body: "Geist", ui-sans-serif, system-ui, sans-serif;
  --mono: "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #111214; --surface: #1a1b1e; --ink: #ececee; --muted: #9a9ca3; --line: #2c2d31;
  --accent: #6ea2f0; --accent-soft: #1f3557; --pos: #4cc38a; --neg: #ef7a6e; --grid: #25262a; color-scheme: dark } }
:root[data-theme="dark"] {
  --bg: #111214; --surface: #1a1b1e; --ink: #ececee; --muted: #9a9ca3; --line: #2c2d31;
  --accent: #6ea2f0; --accent-soft: #1f3557; --pos: #4cc38a; --neg: #ef7a6e; --grid: #25262a; color-scheme: dark }
body { background: var(--bg); color: var(--ink); font: 15px/1.55 var(--body); }
.wrap { max-width: 1120px; margin: 0 auto; padding-inline: 20px; padding-block: 40px 64px; display: grid; gap: 40px; }
h1, h2, h3 { font-family: var(--display); text-wrap: balance; margin: 0; letter-spacing: -0.01em; }
h1 { font-size: clamp(30px, 4.4vw, 44px); font-weight: 600; line-height: 1.1; }
h1 mark { background: var(--accent-soft); color: inherit; padding: 0 .15em; border-radius: 4px; }
h2 { font-size: 26px; font-weight: 600; }
h3 { font-size: 15px; font-weight: 600; }
p { margin: 0; }
.lede { max-width: 68ch; color: var(--muted); margin-top: 12px; }
.muted { color: var(--muted); font-size: 13px; }
.num, .tiles dd, td.num { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.pos { color: var(--pos); } .neg { color: var(--neg); }
.hero { display: grid; gap: 20px; }
.verdict { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 18px 20px; display: grid; gap: 10px; max-width: 78ch; }
.verdict ul { margin: 0; padding-left: 18px; display: grid; gap: 6px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; margin: 0; }
.tile { background: var(--surface); padding: 14px 16px; }
.tile dt { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
.tile dd { margin: 4px 0 0; font-size: 22px; font-weight: 500; }
.ticker { display: grid; gap: 18px; }
.t-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 14px; }
.t-head p { color: var(--muted); font-size: 14px; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.panel { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; display: grid; gap: 10px; min-width: 0; }
details.panel summary { cursor: pointer; list-style: none; }
details.panel summary::-webkit-details-marker { display: none; }
details.panel summary h3::after { content: " +"; color: var(--muted); font-weight: 400; }
details[open].panel summary h3::after { content: " −"; }
svg { width: 100%; height: auto; display: block; }
svg .grid { stroke: var(--grid); stroke-width: 1; }
svg .bar { fill: var(--accent); }
svg .axis { fill: var(--muted); font: 11px var(--mono); }
svg .val { fill: var(--ink); font: 11px var(--mono); }
.blockers { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.blockers li { display: grid; grid-template-columns: minmax(0, 1fr) 90px 52px; gap: 10px; align-items: center; font-size: 13px; }
.b-track { height: 8px; background: var(--grid); border-radius: 4px; overflow: hidden; }
.b-fill { display: block; height: 100%; background: var(--muted); }
.b-fill.good { background: var(--pos); }
.b-num { text-align: right; font-family: var(--mono); font-variant-numeric: tabular-nums; }
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th { text-align: left; font-weight: 500; color: var(--muted); padding: 8px 10px; border-bottom: 1px solid var(--line); white-space: nowrap; }
td { padding: 10px; border-bottom: 1px solid var(--line); vertical-align: top; white-space: nowrap; }
td.small { font-size: 12px; }
.chip { display: inline-block; font-size: 11px; padding: 1px 6px; border-radius: 4px; font-weight: 600; }
.chip.bull { background: color-mix(in srgb, var(--pos) 18%, transparent); color: var(--pos); }
.chip.bear { background: color-mix(in srgb, var(--neg) 18%, transparent); color: var(--neg); }
.notes { display: grid; gap: 8px; max-width: 78ch; font-size: 14px; color: var(--muted); }
.notes ul { margin: 0; padding-left: 18px; display: grid; gap: 6px; }
@media (max-width: 760px) { .cols { grid-template-columns: 1fr; } .blockers li { grid-template-columns: minmax(0, 1fr) 60px 48px; } }
</style>
<div class="wrap">
  <header class="hero">
    <div>
      <h1>How the <mark>good-to-trade</mark> rules did on ${results.map((r) => r.ticker).join(' and ')}</h1>
      <p class="lede">${shortDate(start)} – ${shortDate(end)}, ${new Date(`${end}T12:00:00Z`).getUTCFullYear()}. Every ${every} minutes from 10:00 to 3:45 ET, the app's own engine looked at what it could have seen at that moment and answered the same two questions it answers live. Each “good” answer was traded by its own entry, stop, take-profit and hold rules, and the contract was followed to expiration.</p>
    </div>
    <dl class="tiles">
      ${tile('Trades', allStats.n)}
      ${tile('Win rate', allStats.winRate == null ? '—' : `${Math.round(allStats.winRate * 100)}%`)}
      ${tile('Avg return / trade', pct(allStats.avgRet, 1), sign(allStats.avgRet))}
      ${tile('Total P&amp;L (1 contract each)', usd(allStats.total), sign(allStats.total))}
      ${tile('If held to expiry', pct(allStats.expAvg, 1), sign(allStats.expAvg))}
      ${tile('Avg peak after entry', pct(allStats.peakAvg, 0), sign(allStats.peakAvg))}
    </dl>
    <div class="verdict" id="takeaways">__TAKEAWAYS__</div>
  </header>
  ${sections}
  <section class="notes">
    <h3>How this was tested</h3>
    <ul>
      <li>Prices: full-market 1-minute stock bars (SIP) and 1-minute option bars built from exchange (OPRA) trades, via Alpaca. VIX and VIX3M are the prior day's close.</li>
      <li>The option chain at each check was rebuilt from the last trade of each contract up to that minute (strikes within ±1.5% of the open; expirations about 5–11 and 30 days out). Implied volatility and Greeks were solved from those prices.</li>
      <li>Historical bid/ask quotes aren't in this data, so spreads are modeled at the larger of $0.01 or 0.6% of the price. Fills pay the top of the entry range and exits sell at the modeled bid.</li>
      <li>Not replayed: options flow and open interest (so the flow vote and the dealer-gamma check stay neutral), and intraday VIX. Live, the app has these, so live verdicts can differ.</li>
      <li>Stops and targets are checked on each 1-minute bar's high and low. If a stop and a target fall in the same minute, the stop counts.</li>
      <li>Past results don't guarantee future results. This is a test of the current rules, not trading advice.</li>
    </ul>
  </section>
</div>`;

await writeFile(new URL('./out/report.html', import.meta.url), html);
console.log(JSON.stringify({ all: allStats, byTicker: Object.fromEntries(results.map((r) => [r.ticker, { ...stats(r.trades), checks: r.evals.length, good: r.evals.filter((e) => e.verdict === 'good').length }])) }, null, 1));
