import * as yahoo from './yahoo.js';
import { optionChain } from './cboe.js';
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

// Gathers everything the engine needs for one ticker from free sources.
export async function loadTicker(ticker, { demo = false } = {}) {
  if (demo) return { ...demoData(ticker), sources: { mode: 'demo' } };

  const [daily, intraday, chain, spyDaily, spyIntraday, vix, vix3m, earnings] = await Promise.allSettled([
    cached(`d:${ticker}`, 300_000, () => yahoo.chart(ticker, '1y', '1d')),
    cached(`i:${ticker}`, TTL_MS, () => yahoo.chart(ticker, '1d', '1m')),
    cached(`c:${ticker}`, 30_000, () => optionChain(ticker)),
    cached('d:SPY', 300_000, () => yahoo.chart('SPY', '3mo', '1d')),
    cached('i:SPY', TTL_MS, () => yahoo.chart('SPY', '1d', '1m')),
    cached('q:^VIX', TTL_MS, () => yahoo.chart('^VIX', '1d', '5m')),
    cached('q:^VIX3M', 60_000, () => yahoo.chart('^VIX3M', '1d', '5m')),
    cached(`e:${ticker}`, 6 * 3_600_000, () => yahoo.earningsDate(ticker)),
  ]);

  if (daily.status === 'rejected' || intraday.status === 'rejected') {
    throw new Error(`Could not load price data for ${ticker}. Check the symbol.`);
  }
  const ok = (r) => (r.status === 'fulfilled' ? r.value : null);
  const allPrints = getPrints();

  return {
    ticker,
    price: intraday.value.price ?? intraday.value.bars.at(-1)?.c,
    daily: daily.value.bars,
    intraday: intraday.value.bars,
    chain: ok(chain)?.chain ?? [],
    earningsDate: ok(earnings),
    flowPrints: allPrints,
    market: {
      spyDaily: ok(spyDaily)?.bars ?? [],
      spyIntraday: ok(spyIntraday)?.bars ?? [],
      spyPrice: ok(spyIntraday)?.price,
      vix: ok(vix)?.price,
      vix3m: ok(vix3m)?.price,
    },
    sources: {
      mode: 'live',
      prices: 'Yahoo Finance',
      options: chain.status === 'fulfilled' ? 'Cboe (15-min delayed)' : 'unavailable',
      flow: allPrints ? 'Live feed' : 'Chain volume proxy (no feed connected)',
    },
  };
}
