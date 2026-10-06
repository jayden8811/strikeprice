import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoData } from '../src/data/demo.js';

// Massive option chain snapshot in its documented shape, paged via next_url.
test('option chain comes from Massive when MASSIVE_API_KEY is set', async (t) => {
  const d = demoData('META');
  const occ = (o) => `O:META${o.expiry.slice(2).replaceAll('-', '')}${o.type === 'call' ? 'C' : 'P'}${String(o.strike * 1000).padStart(8, '0')}`;
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    const u = new URL(String(url));
    if (u.hostname !== 'api.massive.com') return new Response('blocked', { status: 403 });
    seen.push({ path: u.pathname, auth: opts?.headers?.Authorization, lte: u.searchParams.get('expiration_date.lte') });
    const cursor = Number(u.searchParams.get('cursor') ?? 0);
    const page = d.chain.slice(cursor, cursor + 250);
    const next = cursor + 250 < d.chain.length ? `https://api.massive.com/v3/snapshot/options/META?cursor=${cursor + 250}` : undefined;
    const results = page.map((o) => ({
      details: { ticker: occ(o), contract_type: o.type, expiration_date: o.expiry, strike_price: o.strike },
      greeks: { delta: o.delta, gamma: o.gamma }, implied_volatility: o.iv, open_interest: o.oi,
      last_quote: { bid: o.bid, ask: o.ask }, last_trade: { price: o.last }, day: { volume: o.volume },
    }));
    return new Response(JSON.stringify({ status: 'OK', results, next_url: next }));
  };
  process.env.MASSIVE_API_KEY = 'mk';
  t.after(() => {
    globalThis.fetch = realFetch;
    delete process.env.MASSIVE_API_KEY;
  });

  const { optionChain } = await import('../src/data/massive.js');
  const chain = await optionChain('META', d.now);
  assert.equal(chain.length, d.chain.length);
  assert.ok(seen.length > 1, 'follows next_url pages');
  assert.ok(seen.every((s) => s.auth === 'Bearer mk'));
  assert.ok(seen[0].lte);
  const a = chain.find((o) => o.strike === d.chain[0].strike && o.type === d.chain[0].type && o.expiry === d.chain[0].expiry);
  assert.deepEqual([a.bid, a.ask, a.oi, a.iv], [d.chain[0].bid, d.chain[0].ask, d.chain[0].oi, d.chain[0].iv]);

  const { analyze } = await import('../src/engine/analyze.js');
  assert.equal(analyze({ ...d, chain }).verdict, analyze(d).verdict);
});
