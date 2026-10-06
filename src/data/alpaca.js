// Alpaca market data with a free (paper) account: real-time IEX stock data and the
// real-time "indicative" options feed. Set ALPACA_KEY_ID and ALPACA_SECRET_KEY.
// ALPACA_FEED=sip / ALPACA_OPTIONS_FEED=opra unlock the paid full feeds.

const DATA = 'https://data.alpaca.markets';
const TRADING = 'https://paper-api.alpaca.markets';
const MAX_DTE = 60;
const SIP_DELAY_MS = 16 * 60_000; // free plans may query the full tape only 15+ min back

export function enabled() {
  return Boolean(process.env.ALPACA_KEY_ID && process.env.ALPACA_SECRET_KEY);
}

const stockFeed = () => process.env.ALPACA_FEED ?? 'iex';
const optionsFeed = () => process.env.ALPACA_OPTIONS_FEED ?? 'indicative';
export const label = () => `Alpaca (${stockFeed() === 'iex' ? 'real-time IEX' : 'real-time SIP'})`;
export const optionsLabel = () => `Alpaca (${optionsFeed() === 'opra' ? 'real-time OPRA' : 'real-time indicative'})`;

async function get(base, path, params = {}) {
  const url = `${base}${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, {
    headers: {
      'APCA-API-KEY-ID': process.env.ALPACA_KEY_ID,
      'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Alpaca ${res.status} ${path}`);
  return res.json();
}

async function paged(base, path, params, key, maxPages = 20) {
  const out = [];
  let token;
  for (let i = 0; i < maxPages; i++) {
    const j = await get(base, path, { ...params, ...(token ? { page_token: token } : {}) });
    const page = j[key];
    if (Array.isArray(page)) out.push(...page);
    else if (page) out.push(...Object.entries(page));
    token = j.next_page_token;
    if (!token) break;
  }
  return out;
}

const toBar = (b) => ({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v ?? 0 });

export async function daily(symbol, days = 400) {
  const start = new Date(Date.now() - days * 86_400_000).toISOString();
  // Free accounts can use the full (SIP) tape for history as long as it ends 15+ min ago.
  const end = new Date(Date.now() - SIP_DELAY_MS).toISOString();
  const bars = await paged(DATA, `/v2/stocks/${encodeURIComponent(symbol)}/bars`,
    { timeframe: '1Day', start, end, feed: 'sip', adjustment: 'split', limit: 10000 }, 'bars');
  return bars.map(toBar);
}

export async function intraday(symbol) {
  const start = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const [bars, latest] = await Promise.all([
    paged(DATA, `/v2/stocks/${encodeURIComponent(symbol)}/bars`, { timeframe: '1Min', start, feed: stockFeed(), limit: 10000 }, 'bars'),
    get(DATA, `/v2/stocks/${encodeURIComponent(symbol)}/trades/latest`, { feed: stockFeed() }),
  ]);
  // Bars include extended hours; keep the regular session (9:30–16:00 ET) only.
  const session = bars.map(toBar).filter((b) => {
    const m = etMinutes(b.t);
    return m >= 570 && m < 960;
  });
  return { price: latest.trade?.p ?? session.at(-1)?.c, bars: session };
}

const etFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function etMinutes(t) {
  const [h, m] = etFmt.format(new Date(t)).split(':').map(Number);
  return h * 60 + m;
}

export function parseOcc(sym) {
  const m = /^(.+?)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(sym);
  if (!m) return null;
  return { expiry: `20${m[2]}-${m[3]}-${m[4]}`, type: m[5] === 'C' ? 'call' : 'put', strike: Number(m[6]) / 1000 };
}

export async function optionChain(symbol, now = new Date()) {
  const lte = new Date(now.getTime() + MAX_DTE * 86_400_000).toISOString().slice(0, 10);
  const gte = now.toISOString().slice(0, 10);
  const [snaps, contracts] = await Promise.all([
    paged(DATA, `/v1beta1/options/snapshots/${encodeURIComponent(symbol)}`,
      { feed: optionsFeed(), expiration_date_gte: gte, expiration_date_lte: lte, limit: 1000 }, 'snapshots'),
    // Open interest isn't in snapshots; it comes from the contracts endpoint (updated daily).
    paged(TRADING, '/v2/options/contracts',
      { underlying_symbols: symbol, expiration_date_gte: gte, expiration_date_lte: lte, limit: 10000 }, 'option_contracts')
      .catch(() => []),
  ]);
  const oi = new Map(contracts.map((c) => [c.symbol, Number(c.open_interest) || 0]));

  const chain = [];
  for (const [sym, s] of snaps) {
    const p = parseOcc(sym);
    if (!p) continue;
    const g = s.greeks ?? {};
    chain.push({
      symbol: sym,
      ...p,
      bid: s.latestQuote?.bp ?? 0,
      ask: s.latestQuote?.ap ?? 0,
      last: s.latestTrade?.p,
      iv: s.impliedVolatility ?? 0,
      delta: g.delta,
      gamma: g.gamma,
      theta: g.theta,
      vega: g.vega,
      oi: oi.get(sym) ?? 0,
      volume: s.dailyBar?.v ?? 0,
    });
  }
  return chain;
}
