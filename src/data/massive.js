// Massive (formerly Polygon.io) real-time options trades over WebSocket.
// Every options trade in the market streams in; only large prints are kept.
// Massive trades carry no aggressor side, so load.js classifies each print
// against the live chain's bid/ask.
//
// MASSIVE_API_KEY       required
// MASSIVE_WS_URL        default wss://socket.massive.com/options (real-time: Options Advanced plan);
//                       wss://delayed.massive.com/options for 15-min delayed plans
// MASSIVE_MIN_PREMIUM   default 25000 ($ premium per print to keep)
// MASSIVE_SUBSCRIBE     default T.* (all options trades)

import { addPrints } from './flowStore.js';

const SWEEP_WINDOW_MS = 250;

export function enabled() {
  return Boolean(process.env.MASSIVE_API_KEY);
}

export function parseOptionSymbol(sym) {
  const m = /^O:(.+?)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(sym ?? '');
  if (!m) return null;
  return {
    ticker: m[1].replace(/\d+$/, ''), // adjusted roots like AAPL1 → AAPL
    expiry: `20${m[2]}-${m[3]}-${m[4]}`,
    type: m[5] === 'C' ? 'call' : 'put',
    strike: Number(m[6]) / 1000,
  };
}

// Prints of the same contract hitting several exchanges within a few hundred ms are
// treated as one sweep order, as flow services do.
export function createAggregator(minPremium, emit) {
  const open = new Map();
  const last = new Map(); // sym → { price, tick } for the tick rule
  const tickOf = (sym, price) => {
    const prev = last.get(sym);
    const tick = !prev ? 0 : price > prev.price ? 1 : price < prev.price ? -1 : prev.tick;
    last.set(sym, { price, tick });
    if (last.size > 500_000) last.clear();
    return tick;
  };
  const flush = (sym) => {
    const o = open.get(sym);
    open.delete(sym);
    const premium = o.notional * 100;
    if (premium < minPremium) return;
    emit({
      ...o.contract,
      time: new Date(o.t).toISOString(),
      size: o.size,
      price: o.notional / o.size,
      premium,
      sweep: o.exchanges.size > 1,
      side: 'unknown',
      tick: o.tick,
    });
  };
  return {
    add(msg) {
      const contract = parseOptionSymbol(msg.sym);
      if (!contract || !(msg.s > 0) || !(msg.p > 0)) return;
      let o = open.get(msg.sym);
      if (!o) {
        o = { contract, t: msg.t, size: 0, notional: 0, exchanges: new Set(), tick: tickOf(msg.sym, msg.p) };
        open.set(msg.sym, o);
        setTimeout(() => flush(msg.sym), SWEEP_WINDOW_MS);
      } else {
        tickOf(msg.sym, msg.p);
      }
      o.size += msg.s;
      o.notional += msg.p * msg.s;
      o.exchanges.add(msg.x);
    },
  };
}

export function start() {
  const url = process.env.MASSIVE_WS_URL ?? 'wss://socket.massive.com/options';
  const minPremium = Number(process.env.MASSIVE_MIN_PREMIUM ?? 25_000);
  const channels = process.env.MASSIVE_SUBSCRIBE ?? 'T.*';
  const agg = createAggregator(minPremium, (p) => addPrints([p]));
  let retry = 1000;
  let stopped = false;

  const connect = () => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ action: 'auth', params: process.env.MASSIVE_API_KEY }));
    });
    ws.addEventListener('message', (e) => {
      for (const m of JSON.parse(e.data)) {
        if (m.ev === 'T') agg.add(m);
        else if (m.ev === 'status') {
          console.log(`massive: ${m.status} ${m.message ?? ''}`);
          if (m.status === 'auth_success') {
            retry = 1000;
            ws.send(JSON.stringify({ action: 'subscribe', params: channels }));
          }
          if (m.status === 'max_connections') {
            console.warn('massive: max connections reached; another app or session is using this key. Retrying with backoff.');
          }
          if (m.status === 'auth_failed') {
            console.error('massive: authentication failed; check MASSIVE_API_KEY. Not reconnecting.');
            stopped = true;
            ws.close();
          }
        }
      }
    });
    ws.addEventListener('close', () => {
      if (stopped) return;
      console.warn(`massive: disconnected, retrying in ${retry / 1000}s`);
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 60_000);
    });
    ws.addEventListener('error', (e) => console.warn(`massive: ${e.message ?? 'socket error'}`));
  };
  connect();
}

// ---------- REST option chain (official OPRA quotes, real-time on Options Advanced) ----------

const REST = 'https://api.massive.com';
const CHAIN_MAX_DTE = 60;

async function restGet(url) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.MASSIVE_API_KEY}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Massive ${res.status} ${new URL(url).pathname}`);
  return res.json();
}

export async function optionChain(symbol, now = new Date(), maxPages = 40) {
  const params = new URLSearchParams({
    'expiration_date.gte': now.toISOString().slice(0, 10),
    'expiration_date.lte': new Date(now.getTime() + CHAIN_MAX_DTE * 86_400_000).toISOString().slice(0, 10),
    limit: '250',
  });
  let url = `${REST}/v3/snapshot/options/${encodeURIComponent(symbol)}?${params}`;
  const results = [];
  for (let i = 0; url && i < maxPages; i++) {
    const j = await restGet(url);
    results.push(...(j.results ?? []));
    url = j.next_url;
  }
  return results.map(toContract).filter(Boolean);
}

export function toContract(r) {
  const d = r.details ?? {};
  if (!d.expiration_date || !Number.isFinite(d.strike_price)) return null;
  const g = r.greeks ?? {};
  return {
    symbol: d.ticker,
    type: d.contract_type,
    strike: d.strike_price,
    expiry: d.expiration_date,
    bid: r.last_quote?.bid ?? 0,
    ask: r.last_quote?.ask ?? 0,
    last: r.last_trade?.price,
    iv: r.implied_volatility ?? 0,
    delta: g.delta,
    gamma: g.gamma,
    theta: g.theta,
    vega: g.vega,
    oi: r.open_interest ?? 0,
    volume: r.day?.volume ?? 0,
  };
}
