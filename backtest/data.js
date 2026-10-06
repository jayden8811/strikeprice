// Historical data for the backtest: Alpaca (stock minute/daily bars, option minute bars
// built from OPRA trades), Massive (historical option NBBO quotes) and Yahoo (hourly VIX,
// T-bill rates, earnings dates). Responses are cached on disk so reruns are fast.
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

export async function stockBars(symbol, timeframe, start, end, feed = 'sip') {
  // Free accounts may only query the full (SIP) tape up to 15 minutes ago.
  const cap = new Date(Date.now() - 16 * 60_000).toISOString();
  if (new Date(end) > new Date(cap)) end = `${cap.slice(0, 10)}T00:00:00Z`; // stable within a day, so the cache hits
  const out = [];
  let token;
  do {
    const p = new URLSearchParams({ timeframe, start, end, feed, adjustment: 'split', limit: '10000' });
    if (token) p.set('page_token', token);
    const j = await getJson(`${DATA}/v2/stocks/${symbol}/bars?${p}`);
    out.push(...(j.bars ?? []).map(toBar));
    token = j.next_page_token;
  } while (token);
  return out;
}

// Minute bars for many option symbols; returns Map(symbol → bars[]).
export async function optionBars(symbols, start, end, timeframe = '1Min') {
  const out = new Map(symbols.map((s) => [s, []]));
  for (let i = 0; i < symbols.length; i += 100) {
    const batch = symbols.slice(i, i + 100);
    let token;
    do {
      const p = new URLSearchParams({ symbols: batch.join(','), timeframe, start, end, limit: '10000' });
      if (token) p.set('page_token', token);
      const j = await getJson(`${DATA}/v1beta1/options/bars?${p}`);
      for (const [sym, bars] of Object.entries(j.bars ?? {})) out.get(sym)?.push(...bars.map(toBar));
      token = j.next_page_token;
    } while (token);
  }
  return out;
}

// ---------- Massive: historical option NBBO ----------

const MASSIVE = 'https://api.massive.com';
const massiveHeaders = () => (process.env.MASSIVE_API_KEY ? { Authorization: `Bearer ${process.env.MASSIVE_API_KEY}` } : {});

// The last NBBO quote at or before time t (ms) for an OCC option symbol, or null.
export async function quoteAt(symbol, t) {
  const p = new URLSearchParams({ 'timestamp.lte': String(BigInt(Math.floor(t)) * 1_000_000n), order: 'desc', sort: 'timestamp', limit: '1' });
  const j = await getJson(`${MASSIVE}/v3/quotes/O:${symbol}?${p}`, massiveHeaders());
  const q = j.results?.[0];
  if (!q || !(q.ask_price > 0)) return null;
  return { bid: q.bid_price ?? 0, ask: q.ask_price, t: Number(BigInt(q.sip_timestamp) / 1_000_000n) };
}

export async function massiveAvailable() {
  try {
    await quoteAt('SPY250117C00600000', Date.parse('2025-01-10T15:00:00Z'));
    return true;
  } catch {
    return false;
  }
}

// ---------- Yahoo ----------

const YUA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' };

// Hourly bars [{t, c}] (Yahoo keeps ~2 years of 60-minute history).
export async function yahooHourly(symbol) {
  const j = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=60m`, YUA);
  const r = j.chart.result[0];
  return r.timestamp.map((t, i) => ({ t: t * 1000, c: r.indicators.quote[0].close[i] })).filter((b) => b.c != null);
}

// Past and scheduled earnings dates (YYYY-MM-DD, ET) from Yahoo's earnings calendar.
let yahooAuth = null;
export async function earningsDates(ticker) {
  const key = createHash('sha1').update(`earnings:${ticker}`).digest('hex');
  const file = new URL(`${key}.json`, CACHE);
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {}
  if (!yahooAuth) {
    const r = await fetch('https://fc.yahoo.com', { headers: YUA, redirect: 'manual' });
    const cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const crumb = await (await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { ...YUA, cookie } })).text();
    yahooAuth = { cookie, crumb };
  }
  // The sort order isn't honored, so page through every row.
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
  const all = new Set();
  for (let offset = 0; ; offset += 100) {
    const body = {
      size: 100, offset,
      query: { operator: 'and', operands: [{ operator: 'eq', operands: ['ticker', ticker] }, { operator: 'eq', operands: ['eventtype', '2'] }] },
      sortField: 'startdatetime', sortType: 'DESC', entityIdType: 'earnings', includeFields: ['startdatetime'],
    };
    const res = await fetch(`https://query1.finance.yahoo.com/v1/finance/visualization?lang=en-US&region=US&crumb=${encodeURIComponent(yahooAuth.crumb)}`, {
      method: 'POST', headers: { ...YUA, cookie: yahooAuth.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Yahoo earnings ${res.status} ${ticker}`);
    const doc = (await res.json()).finance.result[0].documents[0];
    const col = doc.columns.findIndex((c) => c.id === 'startdatetime');
    for (const r of doc.rows) all.add(fmt.format(new Date(r[col])));
    if (doc.rows.length < 100) break;
  }
  const dates = [...all].sort();
  await mkdir(CACHE, { recursive: true });
  await writeFile(file, JSON.stringify(dates));
  return dates;
}

// Daily closes keyed by ET date, e.g. for ^VIX.
export async function yahooDailyCloses(symbol, range = '2y') {
  const j = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`, YUA);
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

// Fills in report dates after Yahoo's history ends, from the implied-volatility crush that
// follows every report: short-dated at-the-money IV collapses the session after the report.
// Companies report in nearly the same week each year, so each quarter it searches ±10 days
// around the same quarter's report a year earlier for the largest one-day IV drop. These mega-caps report after the close, so the report date is the day
// before the drop.
export async function inferEarnings(ticker, known, daily, untilYmd, iv) {
  const ymd = (b) => new Date(b.t).toISOString().slice(0, 10);
  const days = daily.map((b) => ({ d: ymd(b), c: b.c }));
  const out = [...known];
  let last = known.at(-1);
  for (;;) {
    const yearAgo = out.at(-4);
    const center = yearAgo ? Date.parse(`${yearAgo}T12:00:00Z`) + 364 * 86_400_000 : Date.parse(`${last}T12:00:00Z`) + 91 * 86_400_000;
    const idx = days.map((x, i) => i).filter((i) => i > 0 && Math.abs(Date.parse(`${days[i].d}T12:00:00Z`) - center) <= 10 * 86_400_000);
    if (!idx.length || days[idx.at(-1)].d > untilYmd) break;
    // ATM call on the first Friday at least 2 days after the pre-report session.
    const pairs = idx.map((i) => {
      const pre = days[i - 1];
      const f = new Date(Date.parse(`${pre.d}T12:00:00Z`) + 2 * 86_400_000);
      while (f.getUTCDay() !== 5) f.setUTCDate(f.getUTCDate() + 1);
      const expiry = f.toISOString().slice(0, 10);
      const strikes = [-2, -1, 0, 1, 2].map((k) => Math.round(pre.c) + k).concat([Math.round(pre.c / 5) * 5, Math.round(pre.c / 2.5) * 2.5]);
      return { i, pre, post: days[i], expiry, symbols: [...new Set(strikes)].map((k) => occ(ticker, expiry, 'call', k)) };
    });
    const bars = await optionBars([...new Set(pairs.flatMap((p) => p.symbols))], `${pairs[0].pre.d}T00:00:00Z`, `${pairs.at(-1).post.d}T23:59:00Z`, '1Day');
    let best = null;
    for (const p of pairs) {
      for (const sym of p.symbols) {
        const b = bars.get(sym) ?? [];
        const a = b.find((x) => ymd(x) === p.pre.d);
        const z = b.find((x) => ymd(x) === p.post.d);
        if (!a || !z) continue;
        const K = Number(sym.slice(-8)) / 1000;
        const T1 = (Date.parse(`${p.expiry}T20:00:00Z`) - Date.parse(`${p.pre.d}T20:00:00Z`)) / 86_400_000 / 365;
        const T2 = T1 - (Date.parse(`${p.post.d}T12:00:00Z`) - Date.parse(`${p.pre.d}T12:00:00Z`)) / 86_400_000 / 365;
        const v1 = iv(a.c, p.pre.c, K, T1, 'call');
        const v2 = iv(z.c, p.post.c, K, T2, 'call');
        if (!(v1 > 0 && v2 > 0)) continue;
        const ratio = v1 / v2;
        if (!best || ratio > best.ratio) best = { ratio, report: p.pre.d };
      }
    }
    if (!best) break;
    out.push(best.report);
    last = best.report;
  }
  return out;
}
