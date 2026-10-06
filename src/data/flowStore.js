// In-memory store for real-time options flow prints.
// Prints arrive by POST /api/flow, by polling FLOW_FEED_URL, or from the Massive WebSocket.

const KEEP_MS = 2 * 60 * 60_000;
const prints = [];
let connected = false;

export function normalizePrint(p) {
  const type = String(p.type ?? p.put_call ?? p.option_type ?? '').toLowerCase().startsWith('p') ? 'put' : 'call';
  const side = String(p.side ?? p.aggressor ?? 'mid').toLowerCase();
  return {
    ticker: String(p.ticker ?? p.symbol ?? p.underlying ?? '').toUpperCase(),
    time: p.time ?? p.timestamp ?? new Date().toISOString(),
    type,
    strike: Number(p.strike),
    expiry: String(p.expiry ?? p.expiration ?? ''),
    side: side.includes('ask') || side === 'buy' ? 'ask' : side.includes('bid') || side === 'sell' ? 'bid' : side === 'unknown' ? 'unknown' : 'mid',
    size: Number(p.size ?? p.quantity ?? 0),
    price: Number(p.price ?? 0),
    premium: p.premium != null ? Number(p.premium) : undefined,
    sweep: Boolean(p.sweep ?? p.is_sweep ?? false),
    ...(p.tick != null && { tick: p.tick }),
  };
}

export function addPrints(list) {
  connected = true;
  for (const p of list) {
    const n = normalizePrint(p);
    if (n.ticker && Number.isFinite(n.strike)) prints.push(n);
  }
  const cutoff = Date.now() - KEEP_MS;
  while (prints.length && new Date(prints[0].time).getTime() < cutoff) prints.shift();
}

// Returns null when no feed has ever sent data, so the engine falls back to a chain proxy.
export function getPrints() {
  return connected ? prints : null;
}

export function startPolling(url, everyMs = 5000) {
  let seen = new Set();
  const tick = async () => {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      const list = Array.isArray(body) ? body : body.data ?? body.prints ?? [];
      const fresh = list.filter((p) => {
        const key = p.id ?? JSON.stringify(p);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (seen.size > 50_000) seen = new Set();
      addPrints(fresh);
    } catch (e) {
      console.warn(`flow feed: ${e.message}`);
    }
  };
  tick();
  return setInterval(tick, everyMs);
}
