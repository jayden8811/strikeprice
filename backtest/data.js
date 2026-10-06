// Historical data for the backtest, from Alpaca (stock SIP minute/daily bars and
// option minute bars built from OPRA trades) and Yahoo (daily VIX / VIX3M).
// Responses are cached on disk so reruns are fast.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const CACHE = new URL('./.cache/', import.meta.url);
const DATA = 'https://data.alpaca.markets';

function headers() {
  const h = { Accept: 'application/json' };
  if (process.env.ALPACA_KEY_ID && process.env.ALPACA_SECRET_KEY) {
    h['APCA-API-KEY-ID'] = process.env.ALPACA_KEY_ID;
    h['APCA-API-SECRET-KEY'] = process.env.ALPACA_SECRET_KEY;
  }
  return h;
}

async function getJson(url, extra = {}) {
  const key = createHash('sha1').update(url).digest('hex');
  const file = new URL(`${key}.json`, CACHE);
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {}
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { ...headers(), ...extra } });
    if (res.status === 429 && attempt < 6) {
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    const body = await res.json();
    await mkdir(CACHE, { recursive: true });
    await writeFile(file, JSON.stringify(body));
    return body;
  }
}

const toBar = (b) => ({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v ?? 0 });

export async function stockBars(symbol, timeframe, start, end) {
  // Free accounts may only query the full (SIP) tape up to 15 minutes ago.
  const cap = new Date(Date.now() - 16 * 60_000).toISOString();
  if (new Date(end) > new Date(cap)) end = `${cap.slice(0, 10)}T00:00:00Z`; // stable within a day, so the cache hits
  const out = [];
  let token;
  do {
    const p = new URLSearchParams({ timeframe, start, end, feed: 'sip', adjustment: 'split', limit: '10000' });
    if (token) p.set('page_token', token);
    const j = await getJson(`${DATA}/v2/stocks/${symbol}/bars?${p}`);
    out.push(...(j.bars ?? []).map(toBar));
    token = j.next_page_token;
  } while (token);
  return out;
}

// Minute bars for many option symbols; returns Map(symbol → bars[]).
export async function optionBars(symbols, start, end) {
  const out = new Map(symbols.map((s) => [s, []]));
  for (let i = 0; i < symbols.length; i += 100) {
    const batch = symbols.slice(i, i + 100);
    let token;
    do {
      const p = new URLSearchParams({ symbols: batch.join(','), timeframe: '1Min', start, end, limit: '10000' });
      if (token) p.set('page_token', token);
      const j = await getJson(`${DATA}/v1beta1/options/bars?${p}`);
      for (const [sym, bars] of Object.entries(j.bars ?? {})) out.get(sym)?.push(...bars.map(toBar));
      token = j.next_page_token;
    } while (token);
  }
  return out;
}

// Daily closes keyed by ET date, e.g. for ^VIX.
export async function yahooDailyCloses(symbol, range = '2y') {
  const ua = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' };
  const j = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`, ua);
  const r = j.chart.result[0];
  const closes = new Map();
  r.timestamp.forEach((t, i) => {
    const c = r.indicators.quote[0].close[i];
    if (c != null) closes.set(new Date((t + 6 * 3600) * 1000).toISOString().slice(0, 10), c);
  });
  return closes;
}

export function occ(root, expiry, type, strike) {
  return `${root}${expiry.slice(2).replaceAll('-', '')}${type === 'call' ? 'C' : 'P'}${String(Math.round(strike * 1000)).padStart(8, '0')}`;
}
