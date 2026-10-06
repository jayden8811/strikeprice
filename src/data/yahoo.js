// Free Yahoo Finance endpoints: price bars and quotes (stocks and indexes like ^VIX).
// Yahoo rate-limits unfamiliar user agents on the crumb endpoint.
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' };

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { ...UA, ...headers } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

export async function chart(symbol, range, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
  const r = (await getJson(url)).chart?.result?.[0];
  if (!r) throw new Error(`No chart for ${symbol}`);
  const q = r.indicators.quote[0];
  const bars = [];
  (r.timestamp ?? []).forEach((t, i) => {
    if (q.close[i] == null) return;
    bars.push({ t: t * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] ?? 0 });
  });
  return { price: r.meta.regularMarketPrice, bars };
}

// Earnings date needs Yahoo's cookie + crumb handshake; failures return null.
let auth = null;
async function crumb() {
  if (auth && Date.now() - auth.at < 3_600_000) return auth;
  const r = await fetch('https://fc.yahoo.com', { headers: UA, redirect: 'manual' });
  const cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const res = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { ...UA, cookie } });
  if (!res.ok) throw new Error('crumb failed');
  auth = { cookie, crumb: await res.text(), at: Date.now() };
  return auth;
}

export async function earningsDate(symbol) {
  try {
    const a = await crumb();
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=calendarEvents&crumb=${encodeURIComponent(a.crumb)}`;
    const j = await getJson(url, { cookie: a.cookie });
    const ts = j.quoteSummary?.result?.[0]?.calendarEvents?.earnings?.earningsDate?.[0]?.raw;
    return ts ? new Date(ts * 1000).toISOString().slice(0, 10) : null;
  } catch {
    return null;
  }
}
