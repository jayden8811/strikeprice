// Live SPX inputs: option chain (Alpaca OPRA quotes), SPX and VIX levels (Yahoo).
import { priceChain } from './rules.js';

const DATA = 'https://data.alpaca.markets';
const YUA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' };

export function alpacaHeaders() {
  const h = { Accept: 'application/json' };
  if (process.env.ALPACA_KEY_ID && process.env.ALPACA_SECRET_KEY) {
    h['APCA-API-KEY-ID'] = process.env.ALPACA_KEY_ID;
    h['APCA-API-SECRET-KEY'] = process.env.ALPACA_SECRET_KEY;
  }
  return h;
}

async function getJson(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${res.status} ${new URL(url).host}${new URL(url).pathname}`);
  return res.json();
}

export async function yahooLast(symbol) {
  const j = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m`, YUA);
  return j.chart.result[0].meta.regularMarketPrice;
}

export function parseSymbol(sym) {
  const m = /^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(sym);
  if (!m) return null;
  return { root: m[1], expiry: `20${m[2]}-${m[3]}-${m[4]}`, type: m[5] === 'C' ? 'call' : 'put', strike: Number(m[6]) / 1000 };
}

const toContract = ([symbol, s]) => {
  const p = parseSymbol(symbol);
  if (!p) return null;
  return { symbol, ...p, bid: s.latestQuote?.bp ?? 0, ask: s.latestQuote?.ap ?? 0, quoteTime: s.latestQuote?.t ?? null };
};

// SPX chain for expirations in [fromDays, toDays], strikes within ±band of the index.
// The third-Friday date lists both SPX (AM-settled) and SPXW (PM-settled); keep SPXW so
// all four legs settle the same way.
export async function spxChain({ now = new Date(), spot, fromDays = 20, toDays = 50, band = 0.2 }) {
  const day = (n) => new Date(now.getTime() + n * 86_400_000).toISOString().slice(0, 10);
  const params = {
    feed: process.env.ALPACA_OPTIONS_FEED ?? 'opra',
    expiration_date_gte: day(fromDays),
    expiration_date_lte: day(toDays),
    strike_price_gte: String(Math.floor(spot * (1 - band))),
    strike_price_lte: String(Math.ceil(spot * (1 + band))),
    limit: '1000',
  };
  // Alpaca lists SPXW (weeklies/dailies) under its own root, so query both.
  const rows = [];
  for (const root of ['SPXW', 'SPX']) {
    let token;
    for (let i = 0; i < 50; i++) {
      const q = new URLSearchParams({ ...params, ...(token ? { page_token: token } : {}) });
      let j;
      try {
        j = await getJson(`${DATA}/v1beta1/options/snapshots/${root}?${q}`, alpacaHeaders());
      } catch (e) {
        // The free plan only serves the "indicative" feed; fall back to it if OPRA is refused.
        if (params.feed === 'opra' && /^40[13]/.test(e.message)) {
          params.feed = 'indicative';
          i--;
          continue;
        }
        throw e;
      }
      rows.push(...Object.entries(j.snapshots ?? {}));
      token = j.next_page_token;
      if (!token) break;
    }
  }
  const all = rows.map(toContract).filter(Boolean);
  const weeklyDates = new Set(all.filter((o) => o.root === 'SPXW').map((o) => o.expiry));
  const contracts = all.filter((o) => o.root === 'SPXW' || !weeklyDates.has(o.expiry));
  return { contracts, feed: params.feed };
}

// Current quotes for specific option symbols (for managing open positions).
export async function quotesFor(symbols) {
  const out = new Map();
  for (let i = 0; i < symbols.length; i += 100) {
    const q = new URLSearchParams({ symbols: symbols.slice(i, i + 100).join(','), feed: process.env.ALPACA_OPTIONS_FEED ?? 'opra' });
    let j;
    try {
      j = await getJson(`${DATA}/v1beta1/options/quotes/latest?${q}`, alpacaHeaders());
    } catch (e) {
      if (!/^40[13]/.test(e.message)) throw e;
      q.set('feed', 'indicative');
      j = await getJson(`${DATA}/v1beta1/options/quotes/latest?${q}`, alpacaHeaders());
    }
    for (const [sym, x] of Object.entries(j.quotes ?? {})) out.set(sym, { bid: x.bp ?? 0, ask: x.ap ?? 0, t: x.t });
  }
  return out;
}

// Everything one bot cycle needs.
export async function snapshot(cfg, now = new Date()) {
  const [spot, vix] = await Promise.all([yahooLast('^GSPC'), yahooLast('^VIX')]);
  const { contracts, feed } = await spxChain({ now, spot, fromDays: cfg.minDte - 3, toDays: cfg.maxDte + 3 });
  const chain = priceChain(contracts, now, cfg.rate);
  return { now, spot, vix, chain, feed };
}
