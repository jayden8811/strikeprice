import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAggregator, parseOptionSymbol } from '../src/data/massive.js';
import { classifySides } from '../src/engine/flow.js';

test('parses Massive option symbols, including adjusted roots', () => {
  assert.deepEqual(parseOptionSymbol('O:SPY261016P00580000'), { ticker: 'SPY', expiry: '2026-10-16', type: 'put', strike: 580 });
  assert.equal(parseOptionSymbol('O:AAPL1261016C00230000').ticker, 'AAPL');
  assert.equal(parseOptionSymbol('SPY'), null);
});

test('aggregates multi-exchange prints into one sweep and drops small ones', async () => {
  const out = [];
  const agg = createAggregator(25_000, (p) => out.push(p));
  const t = Date.now();
  agg.add({ ev: 'T', sym: 'O:NVDA261016C00190000', x: 1, p: 2.0, s: 100, t });
  agg.add({ ev: 'T', sym: 'O:NVDA261016C00190000', x: 7, p: 2.1, s: 100, t: t + 5 });
  agg.add({ ev: 'T', sym: 'O:NVDA261016P00150000', x: 1, p: 0.5, s: 10, t }); // $500, dropped
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(out.length, 1);
  const p = out[0];
  assert.equal(p.ticker, 'NVDA');
  assert.equal(p.size, 200);
  assert.equal(p.premium, 41_000);
  assert.ok(Math.abs(p.price - 2.05) < 1e-9);
  assert.equal(p.sweep, true);
  assert.equal(p.side, 'unknown');
});

test('classifies sides from fresh quotes, and by tick rule when stale', () => {
  const now = new Date('2026-10-07T15:00:00Z');
  const chain = [{ type: 'call', strike: 190, expiry: '2026-10-16', bid: 2.0, ask: 2.2 }];
  const base = { side: 'unknown', type: 'call', strike: 190, expiry: '2026-10-16', time: now.toISOString() };
  const [a, b, m, stale] = classifySides([
    { ...base, price: 2.2 },
    { ...base, price: 2.0 },
    { ...base, price: 2.1 },
    { ...base, price: 2.0, tick: 1, time: new Date(now - 10 * 60_000).toISOString() },
  ], chain, now);
  assert.deepEqual([a.side, b.side, m.side, stale.side], ['ask', 'bid', 'mid', 'ask']);
});
