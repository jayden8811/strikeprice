// Replays past trading days through the app's own analyze() engine, unchanged.
// Every N minutes it rebuilds what the app would have seen at that moment (price
// bars up to then, an option chain priced from trades up to then, SPY, VIX), records
// the verdict, and when the verdict is "good" it trades the recommended contract
// by the setup's own rules and tracks that contract until expiration.
//
//   node backtest/run.js --tickers SPY,QQQ --start 2026-04-01 --end 2026-09-25 --every 5
import { mkdir, writeFile } from 'node:fs/promises';
import { analyze } from '../src/engine/analyze.js';
import { bsDelta, bsGamma, bsPrice, impliedVol } from '../src/engine/math.js';
import { daysToExpiry, etDate, etParts } from '../src/engine/time.js';
import { occ, optionBars, stockBars, yahooDailyCloses } from './data.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []),
);
const TICKERS = (args.tickers ?? 'SPY,QQQ').split(',');
const START = args.start ?? '2026-04-01';
const END = args.end ?? '2026-09-25';
const EVERY = Number(args.every ?? 5);
const FIRST_EVAL = 30; // minutes after 9:30 (opening range complete)
const LAST_EVAL = 375; // 15:45
const STRIKE_BAND = 0.015; // strikes within ±1.5% of the open
const STALE_MS = 30 * 60_000; // ignore option prints older than this
const FRESH_MS = 5 * 60_000; // during a trade, older prints are repriced from the stock
// SPY/QQQ options are among the tightest in the market; historical quotes aren't in
// the free data, so model the spread: max($0.01, 0.6% of price).
const spreadOf = (p) => Math.max(0.01, p * 0.006);

const dayMs = 86_400_000;
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * dayMs).toISOString().slice(0, 10);
const inSession = (b) => {
  const m = etParts(new Date(b.t)).minutes;
  return m >= 570 && m < 960;
};

function groupByDate(bars) {
  const m = new Map();
  for (const b of bars) {
    if (!inSession(b)) continue;
    const d = etDate(new Date(b.t));
    if (!m.has(d)) m.set(d, []);
    m.get(d).push(b);
  }
  return m;
}

// Latest bar at or before t (bars sorted by time), using bar end time to avoid lookahead.
function lastBefore(bars, t, from = 0) {
  let i = from;
  while (i < bars.length && bars[i].t + 60_000 <= t) i++;
  return i - 1;
}

async function runTicker(ticker, vix, vix3m) {
  console.log(`\n${ticker}: loading bars…`);
  const histStart = addDays(START, -420);
  const futureEnd = addDays(END, 25);
  const [daily, spyDaily, minute, spyMinute] = await Promise.all([
    stockBars(ticker, '1Day', histStart, futureEnd),
    stockBars('SPY', '1Day', histStart, futureEnd),
    stockBars(ticker, '1Min', `${START}T00:00:00Z`, `${futureEnd}T23:59:00Z`),
    stockBars('SPY', '1Min', `${START}T00:00:00Z`, `${futureEnd}T23:59:00Z`),
  ]);
  const byDate = groupByDate(minute);
  const spyByDate = groupByDate(spyMinute);
  const tradingDays = daily.map((b) => etDate(new Date(b.t)));
  const testDays = tradingDays.filter((d) => d >= START && d <= END && byDate.get(d)?.length >= 300);
  const vixDates = [...vix.keys()].sort();
  const prevClose = (series, d) => {
    let v = null;
    for (const k of vixDates) if (k < d) v = series.get(k) ?? v;
    return v;
  };

  const evals = [];
  const trades = [];
  let busyUntil = 0;

  for (const D of testDays) {
    const dayBars = byDate.get(D);
    const spyBars = spyByDate.get(D) ?? [];
    const openT = dayBars[0].t - (etParts(new Date(dayBars[0].t)).minutes - 570) * 60_000;
    const open = dayBars[0].o;

    // Contracts the app would look at: expirations around 8 days (setup) and ~30 days (IV),
    // strikes near the money. SPY/QQQ list daily expirations on trading days.
    const future = tradingDays.filter((d) => d > D);
    const setupExp = future.filter((d) => d >= addDays(D, 5) && d <= addDays(D, 11));
    const ivExp = future.reduce((a, d) => (Math.abs(Date.parse(d) - Date.parse(addDays(D, 30))) < Math.abs(Date.parse(a) - Date.parse(addDays(D, 30))) ? d : a), future[0]);
    const strikes = [];
    for (let k = Math.ceil(open * (1 - STRIKE_BAND)); k <= Math.floor(open * (1 + STRIKE_BAND)); k++) strikes.push(k);
    const contracts = [];
    for (const expiry of [...setupExp, ivExp]) {
      for (const strike of strikes) {
        for (const type of ['call', 'put']) contracts.push({ symbol: occ(ticker, expiry, type, strike), expiry, strike, type });
      }
    }
    const optBars = await optionBars(contracts.map((c) => c.symbol), `${D}T13:00:00Z`, `${D}T21:00:00Z`);
    const daily0 = daily.filter((b) => etDate(new Date(b.t)) < D);
    const spyDaily0 = spyDaily.filter((b) => etDate(new Date(b.t)) < D);
    const vixPrev = prevClose(vix, D);
    const vix3mPrev = prevClose(vix3m, D);

    for (let m = FIRST_EVAL; m <= LAST_EVAL; m += EVERY) {
      const T = openT + m * 60_000;
      const now = new Date(T);
      const intraday = dayBars.filter((b) => b.t + 60_000 <= T);
      const spyIntraday = spyBars.filter((b) => b.t + 60_000 <= T);
      const price = intraday.at(-1).c;

      const chain = [];
      for (const c of contracts) {
        const bars = optBars.get(c.symbol) ?? [];
        const i = lastBefore(bars, T);
        if (i < 0 || T - bars[i].t > STALE_MS) continue;
        const p = bars[i].c;
        const dte = daysToExpiry(c.expiry, now);
        const iv = impliedVol(p, price, c.strike, dte / 365, c.type);
        if (!Number.isFinite(iv)) continue;
        const half = spreadOf(p) / 2;
        let volume = 0;
        for (let j = 0; j <= i; j++) volume += bars[j].v;
        chain.push({
          ...c,
          bid: Math.max(0.01, p - half),
          ask: p + half,
          last: p,
          iv,
          delta: bsDelta(price, c.strike, dte / 365, iv, c.type),
          gamma: bsGamma(price, c.strike, dte / 365, iv),
          oi: 0, // historical open interest isn't available; dealer-gamma check stays neutral
          volume,
        });
      }

      const r = analyze({
        ticker,
        now,
        session: 'open',
        price,
        daily: daily0,
        intraday,
        chain,
        earningsDate: null, // ETFs have no earnings
        flowPrints: [], // historical flow isn't replayed; flow vote stays neutral
        market: { spyDaily: spyDaily0, spyIntraday, spyPrice: spyIntraday.at(-1)?.c, vix: vixPrev, vix3m: vix3mPrev },
      });

      evals.push({
        date: D,
        time: `${String(Math.floor((570 + m) / 60)).padStart(2, '0')}:${String((570 + m) % 60).padStart(2, '0')}`,
        verdict: r.verdict,
        bias: r.bias,
        reason: r.reasons[0] ?? null,
        checks: Object.fromEntries(r.checks.map((c) => [c.id, c.status])),
      });

      if (r.verdict === 'good' && T >= busyUntil) {
        const trade = await simulate({ ticker, D, T, setup: r.setup, price, byDate, tradingDays });
        if (trade) {
          trades.push(trade);
          busyUntil = trade.exitTime;
        }
      }
    }
    const goodToday = evals.filter((e) => e.date === D && e.verdict === 'good').length;
    process.stdout.write(`${D} ${goodToday ? `good×${goodToday}` : '·'}  `);
  }
  return { ticker, evals, trades };
}

// Trades one contract by the setup's rules: fill at the top of the entry range, sell half
// at TP1 (then stop at entry), the rest at TP2; stop on the underlying; time exit on the
// exit-by date. Same-minute stop and target count as the stop (conservative).
async function simulate({ ticker, D, T, setup, price, byDate, tradingDays }) {
  const c = setup.contract;
  const sym = occ(ticker, c.expiry, c.type, c.strike);
  const opt = (await optionBars([sym], new Date(T - 60_000).toISOString(), `${c.expiry}T21:00:00Z`)).get(sym) ?? [];
  if (!opt.length) return null;
  const dir = setup.direction === 'bull' ? 1 : -1;
  const fill = setup.entry.optionHigh;
  const [tp1, tp2] = setup.takeProfits;
  const days = tradingDays.filter((d) => d >= D && d <= c.expiry);
  const path = days.flatMap((d) => (byDate.get(d) ?? []).map((b) => ({ ...b, d }))).filter((b) => b.t >= T);

  // Option value at the end of minute bar b. Use the option's own trade when it's recent;
  // otherwise (e.g. at the open, before it trades) reprice it from the stock's price
  // with the IV implied by its last trade, so stale prints don't leak into exits.
  const stockClose = new Map(days.flatMap((d) => (byDate.get(d) ?? []).map((x) => [x.t, x.c])));
  let oi = -1;
  const optAt = (b) => {
    oi = lastBefore(opt, b.t + 60_000, Math.max(0, oi));
    if (oi < 0) return null;
    const last = opt[oi];
    if (b.t - last.t <= FRESH_MS) return last.c;
    const sThen = stockClose.get(last.t);
    if (sThen == null) return last.c;
    const tThen = daysToExpiry(c.expiry, new Date(last.t + 60_000)) / 365;
    const iv = impliedVol(last.c, sThen, c.strike, tThen, c.type);
    if (!Number.isFinite(iv)) return last.c;
    return bsPrice(b.c, c.strike, Math.max(daysToExpiry(c.expiry, new Date(b.t + 60_000)), 0.001) / 365, iv, c.type);
  };
  const sell = (p) => Math.max(0, p - spreadOf(p) / 2);

  let open = 1;
  let proceeds = 0;
  let tp1Done = false;
  const exits = [];
  let exitTime = null;
  for (const b of path) {
    if (b.d > setup.hold.exitBy) break;
    const p = optAt(b);
    if (p == null) continue;
    const hitStop = dir > 0 ? b.l <= setup.stopLoss.underlying : b.h >= setup.stopLoss.underlying;
    const hitTp1 = dir > 0 ? b.h >= tp1.underlying : b.l <= tp1.underlying;
    const hitTp2 = dir > 0 ? b.h >= tp2.underlying : b.l <= tp2.underlying;
    const lastBarOfExitDay = b.d === setup.hold.exitBy && etParts(new Date(b.t)).minutes >= 959;

    if (hitStop || (tp1Done && p <= fill)) {
      proceeds += open * sell(p);
      exits.push({ reason: tp1Done ? 'stop at entry' : 'stop', size: open, price: sell(p), date: b.d, t: b.t });
      open = 0;
    } else {
      if (!tp1Done && hitTp1) {
        proceeds += 0.5 * sell(p);
        exits.push({ reason: 'TP1', size: 0.5, price: sell(p), date: b.d, t: b.t });
        open = 0.5;
        tp1Done = true;
      }
      if (tp1Done && open > 0 && hitTp2) {
        proceeds += open * sell(p);
        exits.push({ reason: 'TP2', size: open, price: sell(p), date: b.d, t: b.t });
        open = 0;
      }
      if (open > 0 && lastBarOfExitDay) {
        proceeds += open * sell(p);
        exits.push({ reason: 'time', size: open, price: sell(p), date: b.d, t: b.t });
        open = 0;
      }
    }
    if (open === 0) {
      exitTime = b.t;
      break;
    }
  }
  if (open > 0) {
    // Data ran out before the exit date; close at the last known price.
    const p = opt.at(-1).c;
    proceeds += open * sell(p);
    exits.push({ reason: 'data end', size: open, price: sell(p), date: etDate(new Date(opt.at(-1).t)), t: opt.at(-1).t });
    exitTime = opt.at(-1).t;
  }

  // How the contract itself played out to expiration.
  const after = opt.filter((b) => b.t >= T);
  const expBars = byDate.get(c.expiry) ?? [];
  const sExp = expBars.at(-1)?.c;
  const atExpiry = sExp != null ? Math.max(0, dir > 0 ? sExp - c.strike : c.strike - sExp) : null;
  const maxPrice = Math.max(...after.map((b) => b.h));
  const maxBar = after.find((b) => b.h === maxPrice);

  return {
    ticker,
    date: D,
    time: new Date(T).toISOString(),
    direction: setup.direction,
    contract: `${c.expiry} ${c.strike} ${c.type}`,
    expiry: c.expiry,
    underlyingAtEntry: price,
    setup: {
      entryRange: [setup.entry.optionLow, setup.entry.optionHigh],
      stop: setup.stopLoss,
      tp1: { underlying: tp1.underlying, option: tp1.option },
      tp2: { underlying: tp2.underlying, option: tp2.option },
      exitBy: setup.hold.exitBy,
      rewardRisk: setup.rewardRisk,
    },
    fill,
    exits,
    exitTime,
    pnl: proceeds - fill,
    returnPct: (proceeds - fill) / fill,
    contractPath: {
      maxPrice,
      maxPriceDate: maxBar ? etDate(new Date(maxBar.t)) : null,
      maxGainPct: (maxPrice - fill) / fill,
      minPrice: Math.min(...after.map((b) => b.l)),
      atExpiry,
      expiryReturnPct: atExpiry != null ? (atExpiry - fill) / fill : null,
    },
  };
}

const [vix, vix3m] = await Promise.all([yahooDailyCloses('^VIX'), yahooDailyCloses('^VIX3M')]);
const results = [];
for (const t of TICKERS) results.push(await runTicker(t, vix, vix3m));
await mkdir(new URL('./out/', import.meta.url), { recursive: true });
await writeFile(new URL('./out/results.json', import.meta.url), JSON.stringify({ start: START, end: END, every: EVERY, results }, null, 1));

for (const { ticker, evals, trades } of results) {
  const good = evals.filter((e) => e.verdict === 'good').length;
  const wins = trades.filter((t) => t.pnl > 0).length;
  const total = trades.reduce((a, t) => a + t.pnl, 0);
  console.log(`\n\n${ticker}: ${evals.length} checks, ${good} good (${((100 * good) / evals.length).toFixed(1)}%), ${trades.length} trades, ` +
    `${wins} wins, avg return ${(100 * trades.reduce((a, t) => a + t.returnPct, 0) / Math.max(1, trades.length)).toFixed(1)}%, ` +
    `total P&L $${(total * 100).toFixed(0)} per 1-contract trade`);
}
