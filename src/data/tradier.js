// Tradier market data: real-time quotes, 1-minute bars and option chains with Greeks.
// Real-time data is free with a Tradier brokerage account; set TRADIER_TOKEN.
// Set TRADIER_SANDBOX=1 to use a (delayed) developer sandbox token instead.

const MAX_DTE = 60;

function base() {
  return process.env.TRADIER_SANDBOX === '1' ? 'https://sandbox.tradier.com/v1' : 'https://api.tradier.com/v1';
}

export function enabled() {
  return Boolean(process.env.TRADIER_TOKEN);
}

async function get(path, params) {
  const url = `${base()}${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.TRADIER_TOKEN}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Tradier ${res.status} ${path}`);
  return res.json();
}

// Tradier returns a bare object instead of a one-element array.
const list = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

export async function quotes(symbols) {
  const j = await get('/markets/quotes', { symbols: symbols.join(','), greeks: 'false' });
  const out = {};
  for (const q of list(j.quotes?.quote)) out[q.symbol] = q.last ?? q.close ?? q.prevclose;
  return out;
}

export async function daily(symbol, days = 400) {
  const start = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const j = await get('/markets/history', { symbol, interval: 'daily', start });
  // Daily bars are dated in ET; stamp them at the 4pm close so date math matches the other sources.
  return list(j.history?.day).map((d) => ({
    t: new Date(`${d.date}T20:00:00Z`).getTime(),
    o: d.open, h: d.high, l: d.low, c: d.close, v: d.volume ?? 0,
  }));
}

export async function intraday(symbol) {
  const start = new Date(Date.now() - 24 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ');
  const j = await get('/markets/timesales', { symbol, interval: '1min', start, session_filter: 'open' });
  return list(j.series?.data).map((b) => ({
    t: b.timestamp * 1000, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume ?? 0,
  }));
}

export async function optionChain(symbol, now = new Date()) {
  const ex = await get('/markets/options/expirations', { symbol, includeAllRoots: 'false' });
  const cutoff = new Date(now.getTime() + MAX_DTE * 86_400_000).toISOString().slice(0, 10);
  const expiries = list(ex.expirations?.date).filter((d) => d <= cutoff);
  const chains = await Promise.all(
    expiries.map((expiration) => get('/markets/options/chains', { symbol, expiration, greeks: 'true' })),
  );
  return chains.flatMap((j) => list(j.options?.option)).map(toContract);
}

export function toContract(o) {
  const g = o.greeks ?? {};
  return {
    symbol: o.symbol,
    type: o.option_type,
    strike: o.strike,
    expiry: o.expiration_date,
    bid: o.bid ?? 0,
    ask: o.ask ?? 0,
    last: o.last,
    iv: g.mid_iv ?? g.smv_vol ?? 0,
    delta: g.delta,
    gamma: g.gamma,
    theta: g.theta,
    vega: g.vega,
    oi: o.open_interest ?? 0,
    volume: o.volume ?? 0,
  };
}
