// Free Cboe delayed (~15 min) option chains with IV, Greeks, OI and volume.
const INDEXES = new Set(['SPX', 'NDX', 'RUT', 'VIX', 'XSP', 'DJX']);

export function parseOccSymbol(sym) {
  const m = /^(.+?)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(sym);
  if (!m) return null;
  return {
    root: m[1],
    expiry: `20${m[2]}-${m[3]}-${m[4]}`,
    type: m[5] === 'C' ? 'call' : 'put',
    strike: Number(m[6]) / 1000,
  };
}

export async function optionChain(ticker) {
  const sym = INDEXES.has(ticker) ? `_${ticker}` : ticker;
  const res = await fetch(`https://cdn-api.cboe.com/api/global/delayed_quotes/options/${sym}.json`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (strikeprice)' },
  });
  if (!res.ok) throw new Error(`Cboe ${res.status} for ${ticker}`);
  const j = await res.json();
  const chain = [];
  for (const o of j.data?.options ?? []) {
    const p = parseOccSymbol(o.option);
    if (!p) continue;
    chain.push({
      symbol: o.option,
      type: p.type,
      strike: p.strike,
      expiry: p.expiry,
      bid: o.bid,
      ask: o.ask,
      last: o.last_trade_price,
      iv: o.iv,
      delta: o.delta,
      gamma: o.gamma,
      theta: o.theta,
      vega: o.vega,
      oi: o.open_interest,
      volume: o.volume,
    });
  }
  return { chain, price: j.data?.current_price, timestamp: j.timestamp };
}
