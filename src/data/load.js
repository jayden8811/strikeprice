import * as yahoo from './yahoo.js';
import * as cboe from './cboe.js';
import * as tradier from './tradier.js';
import * as alpaca from './alpaca.js';
import { demoData } from './demo.js';
import { getPrints } from './flowStore.js';

const TTL_MS = 10_000;
const cache = new Map();

async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await fn();
  cache.set(key, { value, at: Date.now() });
  return value;
}

// Real-time Tradier or Alpaca when keys are set; otherwise the free Yahoo + Cboe (delayed chain) sources.
const free = {
  name: { prices: 'Yahoo Finance', options: 'Cboe (15-min delayed)' },
  daily: async (s) => (await yahoo.chart(s, '1y', '1d')).bars,
  intraday: (s) => yahoo.chart(s, '1d', '1m'),
  chain: async (s) => (await cboe.optionChain(s)).chain,
  index: async (s) => (await yahoo.chart(`^${s}`, '1d', '5m')).price,
};

const realtime = {
  name: {
    prices: `Tradier${process.env.TRADIER_SANDBOX === '1' ? ' sandbox (delayed)' : ' (real-time)'}`,
    options: `Tradier${process.env.TRADIER_SANDBOX === '1' ? ' sandbox (delayed)' : ' (real-time)'}`,
  },
  daily: (s) => tradier.daily(s),
  intraday: async (s) => {
    const [bars, q] = await Promise.all([tradier.intraday(s), tradier.quotes([s])]);
    return { price: q[s] ?? bars.at(-1)?.c, bars };
  },
  chain: (s) => tradier.optionChain(s),
  // Tradier doesn't carry every index; fall back to Yahoo per symbol.
  index: async (s) => (await tradier.quotes([s]))[s] ?? free.index(s),
};

// Alpaca has no index data, so VIX/VIX3M still come from Yahoo.
const alpacaProvider = {
  get name() {
    return { prices: alpaca.label(), options: alpaca.optionsLabel() };
  },
  daily: (s) => alpaca.daily(s),
  intraday: (s) => alpaca.intraday(s),
  chain: (s) => alpaca.optionChain(s),
  index: (s) => free.index(s),
};

export function provider() {
  if (tradier.enabled()) return realtime;
  if (alpaca.enabled()) return alpacaProvider;
  return free;
}

// Gathers everything the engine needs for one ticker.
export async function loadTicker(ticker, { demo = false } = {}) {
  if (demo) return { ...demoData(ticker), sources: { mode: 'demo' } };
  const p = provider();

  const [daily, intraday, chain, spyDaily, spyIntraday, vix, vix3m, earnings] = await Promise.allSettled([
    cached(`d:${ticker}`, 300_000, () => p.daily(ticker)),
    cached(`i:${ticker}`, TTL_MS, () => p.intraday(ticker)),
    cached(`c:${ticker}`, p !== free ? 15_000 : 30_000, () => p.chain(ticker)),
    cached('d:SPY', 300_000, () => p.daily('SPY')),
    cached('i:SPY', TTL_MS, () => p.intraday('SPY')),
    cached('q:VIX', TTL_MS, () => p.index('VIX')),
    cached('q:VIX3M', 60_000, () => p.index('VIX3M')),
    cached(`e:${ticker}`, 6 * 3_600_000, () => yahoo.earningsDate(ticker)),
  ]);

  for (const r of [daily, intraday, chain]) if (r.status === 'rejected') console.warn(`${ticker}: ${r.reason?.message}`);
  if (daily.status === 'rejected' || intraday.status === 'rejected') {
    throw new Error(`Could not load price data for ${ticker}. Check the symbol and your data connection.`);
  }
  const ok = (r) => (r.status === 'fulfilled' ? r.value : null);
  const allPrints = getPrints();

  return {
    ticker,
    price: intraday.value.price ?? intraday.value.bars.at(-1)?.c,
    daily: daily.value,
    intraday: intraday.value.bars,
    chain: ok(chain) ?? [],
    earningsDate: ok(earnings),
    flowPrints: allPrints,
    market: {
      spyDaily: ok(spyDaily) ?? [],
      spyIntraday: ok(spyIntraday)?.bars ?? [],
      spyPrice: ok(spyIntraday)?.price,
      vix: ok(vix),
      vix3m: ok(vix3m),
    },
    sources: {
      mode: 'live',
      prices: p.name.prices,
      options: chain.status === 'fulfilled' ? p.name.options : 'unavailable',
      flow: allPrints ? 'Live feed' : 'Chain volume proxy (no feed connected)',
    },
  };
}
