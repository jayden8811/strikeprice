import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoData } from '../src/data/demo.js';

// Serves a demo market in Tradier's documented response shapes, so the whole
// Tradier → engine path is exercised without network access.
function tradierStub(d) {
  const ymd = (t) => new Date(t).toISOString().slice(0, 10);
  const expiries = [...new Set(d.chain.map((o) => o.expiry))].sort();
  const quote = { [d.ticker]: d.price, SPY: d.market.spyPrice, VIX: d.market.vix, VIX3M: d.market.vix3m };
  return async (url) => {
    const u = new URL(url);
    const sym = u.searchParams.get('symbol');
    let body;
    if (u.hostname.includes('yahoo')) return new Response('blocked', { status: 403 });
    if (u.pathname.endsWith('/markets/quotes')) {
      const qs = u.searchParams.get('symbols').split(',').map((s) => ({ symbol: s, last: quote[s] }));
      body = { quotes: { quote: qs.length === 1 ? qs[0] : qs } };
    } else if (u.pathname.endsWith('/markets/history')) {
      const bars = sym === 'SPY' ? d.market.spyDaily : d.daily;
      body = { history: { day: bars.map((b) => ({ date: ymd(b.t), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v })) } };
    } else if (u.pathname.endsWith('/markets/timesales')) {
      const bars = sym === 'SPY' ? d.market.spyIntraday : d.intraday;
      body = { series: { data: bars.map((b) => ({ timestamp: b.t / 1000, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v })) } };
    } else if (u.pathname.endsWith('/options/expirations')) {
      body = { expirations: { date: expiries } };
    } else if (u.pathname.endsWith('/options/chains')) {
      const e = u.searchParams.get('expiration');
      body = {
        options: {
          option: d.chain.filter((o) => o.expiry === e).map((o) => ({
            symbol: `${d.ticker}${e}${o.type}${o.strike}`, option_type: o.type, strike: o.strike, expiration_date: e,
            bid: o.bid, ask: o.ask, last: o.last, volume: o.volume, open_interest: o.oi,
            greeks: { delta: o.delta, gamma: o.gamma, mid_iv: o.iv },
          })),
        },
      };
    } else {
      return new Response('not found', { status: 404 });
    }
    assert.match(url, /^https:\/\/api\.tradier\.com\/v1\//);
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  };
}

test('Tradier provider feeds the engine end to end', async (t) => {
  const d = demoData('NVDA');
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), auth: opts?.headers?.Authorization });
    return tradierStub(d)(String(url));
  };
  // These tests cover the provider's own option chain, not Massive's.
  const massiveKey = process.env.MASSIVE_API_KEY;
  delete process.env.MASSIVE_API_KEY;
  process.env.TRADIER_TOKEN = 'test-token';
  t.after(() => {
    if (massiveKey) process.env.MASSIVE_API_KEY = massiveKey;
    globalThis.fetch = realFetch;
    delete process.env.TRADIER_TOKEN;
  });

  const { loadTicker } = await import('../src/data/load.js');
  const { analyze } = await import('../src/engine/analyze.js');
  const data = await loadTicker('NVDA');

  assert.equal(data.sources.prices, 'Tradier (real-time)');
  assert.equal(data.price, d.price);
  assert.equal(data.chain.length, d.chain.length);
  assert.equal(data.market.vix, d.market.vix);
  assert.ok(calls.filter((c) => c.url.includes('tradier')).every((c) => c.auth === 'Bearer test-token'));

  assert.equal(data.earningsDate, null); // Yahoo is blocked in the stub; earnings degrade to unknown
  // Earnings and flow come from other sources, so reuse the demo's for an apples-to-apples check.
  const r = analyze({ ...data, earningsDate: d.earningsDate, flowPrints: d.flowPrints, now: d.now, session: 'open' });
  const fromDemo = analyze(d);
  assert.equal(r.verdict, fromDemo.verdict);
  assert.equal(r.metrics.atmIV, fromDemo.metrics.atmIV);
});
