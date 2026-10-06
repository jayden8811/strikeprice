import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoData } from '../src/data/demo.js';

// Serves a demo market in Alpaca's documented response shapes (Yahoo blocked),
// and splits results across pages to exercise next_page_token handling.
function alpacaStub(d) {
  const occ = (o) => `${d.ticker}${o.expiry.slice(2).replaceAll('-', '')}${o.type === 'call' ? 'C' : 'P'}${String(Math.round(o.strike * 1000)).padStart(8, '0')}`;
  const iso = (t) => new Date(t).toISOString();
  const bar = (b) => ({ t: iso(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
  const page = (items, token, size) => {
    const start = Number(token ?? 0);
    const next = start + size < items.length ? String(start + size) : null;
    return { slice: items.slice(start, start + size), next };
  };
  return (url, headers) => {
    const u = new URL(url);
    if (!u.hostname.endsWith('alpaca.markets')) return new Response('blocked', { status: 403 });
    assert.equal(headers['APCA-API-KEY-ID'], 'kid');
    const sym = u.pathname.split('/')[3];
    const isSpy = sym === 'SPY';
    let body;
    if (u.pathname.endsWith('/bars')) {
      const src = u.searchParams.get('timeframe') === '1Day'
        ? (isSpy ? d.market.spyDaily : d.daily)
        : (isSpy ? d.market.spyIntraday : d.intraday);
      if (u.searchParams.get('timeframe') === '1Day') assert.equal(u.searchParams.get('feed'), 'sip');
      const p = page(src.map(bar), u.searchParams.get('page_token'), 100);
      body = { bars: p.slice, next_page_token: p.next };
    } else if (u.pathname.endsWith('/trades/latest')) {
      body = { trade: { p: isSpy ? d.market.spyPrice : d.price } };
    } else if (u.pathname.startsWith('/v1beta1/options/snapshots/')) {
      assert.equal(u.searchParams.get('feed'), 'indicative');
      const p = page(d.chain, u.searchParams.get('page_token'), 150);
      body = {
        snapshots: Object.fromEntries(p.slice.map((o) => [occ(o), {
          latestQuote: { bp: o.bid, ap: o.ask }, latestTrade: { p: o.last },
          greeks: { delta: o.delta, gamma: o.gamma }, impliedVolatility: o.iv, dailyBar: { v: o.volume },
        }])),
        next_page_token: p.next,
      };
    } else if (u.pathname === '/v2/options/contracts') {
      assert.equal(u.hostname, 'paper-api.alpaca.markets');
      body = { option_contracts: d.chain.map((o) => ({ symbol: occ(o), open_interest: String(o.oi) })), next_page_token: null };
    } else {
      return new Response('not found', { status: 404 });
    }
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  };
}

test('Alpaca provider feeds the engine end to end', async (t) => {
  const d = demoData('AMD');
  const realFetch = globalThis.fetch;
  const stub = alpacaStub(d);
  globalThis.fetch = async (url, opts) => stub(String(url), opts?.headers ?? {});
  process.env.ALPACA_KEY_ID = 'kid';
  process.env.ALPACA_SECRET_KEY = 'secret';
  t.after(() => {
    globalThis.fetch = realFetch;
    delete process.env.ALPACA_KEY_ID;
    delete process.env.ALPACA_SECRET_KEY;
  });

  const { loadTicker } = await import('../src/data/load.js');
  const { analyze } = await import('../src/engine/analyze.js');
  const data = await loadTicker('AMD');

  assert.equal(data.sources.prices, 'Alpaca (real-time IEX)');
  assert.equal(data.sources.options, 'Alpaca (real-time indicative)');
  assert.equal(data.price, d.price);
  assert.equal(data.daily.length, d.daily.length);
  assert.equal(data.chain.length, d.chain.length);
  assert.ok(data.chain.every((o) => o.oi > 0 || d.chain.some((x) => x.strike === o.strike && x.oi === 0)));

  // The demo session is fully inside 9:30–16:00 ET, so no bars are dropped by the session filter.
  assert.equal(data.intraday.length, d.intraday.length);

  // VIX comes from Yahoo (blocked in the stub) and earnings/flow from other sources; reuse the demo's.
  const r = analyze({ ...data, market: { ...data.market, vix: d.market.vix, vix3m: d.market.vix3m },
    earningsDate: d.earningsDate, flowPrints: d.flowPrints, now: d.now, session: 'open' });
  const fromDemo = analyze(d);
  assert.equal(r.verdict, fromDemo.verdict);
  assert.equal(r.metrics.atmIV, fromDemo.metrics.atmIV);
  assert.equal(r.levels.callWall, fromDemo.levels.callWall);
});
