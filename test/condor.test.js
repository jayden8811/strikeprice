import { test } from 'node:test';
import assert from 'node:assert/strict';
import { black76Price } from '../src/engine/math.js';
import { loadConfig } from '../src/condor/config.js';
import { buildCondor, closeCost, contractsFor, entryChecks, exitDecision, priceChain } from '../src/condor/rules.js';
import { mlegBody, signedLimit, toTick } from '../src/condor/broker.js';

const NOW = new Date('2026-10-12T15:00:00Z'); // Monday 11:00 ET
const cfg = loadConfig();

// Synthetic SPX chain priced with Black-76 and a put skew, quoted ±3% around fair value.
function chain({ F = 6000, expiries = ['2026-11-06', '2026-11-20', '2026-12-18'], baseIv = 0.16 } = {}) {
  const out = [];
  for (const expiry of expiries) {
    const T = (Date.parse(`${expiry}T20:00:00Z`) - NOW) / 86_400_000 / 365;
    for (let k = F * 0.75; k <= F * 1.25; k += 5) {
      for (const type of ['call', 'put']) {
        const iv = baseIv * (1 - 0.9 * Math.log(k / F));
        const p = black76Price(F, k, T, iv, type, 0.04);
        if (p < 0.05) continue;
        out.push({ symbol: `SPXW${expiry.slice(2).replaceAll('-', '')}${type[0].toUpperCase()}${String(k * 1000).padStart(8, '0')}`, expiry, type, strike: k, bid: +(p * 0.97).toFixed(2), ask: +(p * 1.03).toFixed(2) });
      }
    }
  }
  return priceChain(out, NOW, 0.04);
}

test('picks the longest expiration within 30–45 DTE and ~16-delta shorts', () => {
  const c = buildCondor(chain(), cfg);
  assert.equal(c.expiry, '2026-11-20'); // 39 DTE; Nov 6 is 25, Dec 18 is 67
  assert.ok(Math.abs(c.deltas.shortPut) >= 0.14 && Math.abs(c.deltas.shortPut) <= 0.18);
  assert.ok(c.deltas.shortCall >= 0.14 && c.deltas.shortCall <= 0.18);
  assert.equal(c.strikes.shortPut - c.strikes.longPut, 50);
  assert.equal(c.strikes.longCall - c.strikes.shortCall, 50);
  assert.ok(Math.abs(c.forward - 6000) < 1, 'forward recovered from put-call parity');
  assert.ok(c.natural < c.credit);
  assert.ok(Math.abs(c.maxLossPerContract - (50 - c.credit) * 100) < 1e-9);
});

test('rejects when no expiration is in the window', () => {
  assert.match(buildCondor(chain({ expiries: ['2026-11-06', '2026-12-18'] }), cfg).error, /No expiration/);
});

test('sizing uses max loss and halves risk at high VIX', () => {
  const c = { maxLossPerContract: 3900 };
  assert.deepEqual(contractsFor(400_000, 16, c, cfg), { pct: 0.02, qty: 2 });
  assert.deepEqual(contractsFor(400_000, 21, c, cfg), { pct: 0.01, qty: 1 });
  assert.equal(contractsFor(100_000, 16, c, cfg).qty, 0);
});

test('entry needs every rule; each failure is reported', () => {
  const condor = buildCondor(chain({ baseIv: 0.35 }), { ...cfg, wingWidth: 25 });
  const account = { equity: 1_000_000, lastEquity: 1_000_000, weekStartEquity: 1_000_000 };
  // Credit and spread thresholds loosened here so the other rules can be checked one at a time.
  const loose = { ...cfg, wingWidth: 25, minCreditFraction: 0.05, maxSpreadFraction: 5 };
  const base = { now: NOW, vix: 18, condor, positions: [], lastEntryAt: null, account, cfg: loose };
  assert.deepEqual(entryChecks(base).checks.filter((c) => !c.pass), []);
  const ids = (r) => r.checks.filter((c) => !c.pass).map((c) => c.id);
  assert.deepEqual(ids(entryChecks({ ...base, vix: 30 })), ['vix']);
  assert.deepEqual(ids(entryChecks({ ...base, lastEntryAt: new Date(NOW - 3 * 86_400_000).toISOString() })), ['frequency']);
  assert.deepEqual(ids(entryChecks({ ...base, positions: [{}, {}, {}] })), ['capacity']);
  assert.deepEqual(ids(entryChecks({ ...base, account: { ...account, equity: 960_000 } })), ['dailyLoss']);
  assert.deepEqual(ids(entryChecks({ ...base, account: { ...account, equity: 940_000 } })), ['dailyLoss', 'weeklyLoss']);
  assert.deepEqual(ids(entryChecks({ ...base, now: new Date('2026-10-12T13:35:00Z') })), ['session']); // 9:35 ET
  assert.deepEqual(ids(entryChecks({ ...base, cfg: { ...base.cfg, eventDays: ['2026-10-12'] } })), ['event']);
  assert.ok(entryChecks({ ...base, cfg: { ...base.cfg, minCreditFraction: 0.9 } }).checks.find((c) => c.id === 'credit').pass === false);
});

test('exits: profit at 50%, stop at 200%, time at 21 DTE, in that order', () => {
  const pos = { credit: 10, expiry: '2026-11-20' };
  assert.equal(exitDecision(pos, { mid: 5 }, NOW, cfg).reason, 'profit');
  assert.equal(exitDecision(pos, { mid: 20 }, NOW, cfg).reason, 'stop');
  assert.equal(exitDecision(pos, { mid: 12 }, NOW, cfg), null);
  assert.equal(exitDecision(pos, { mid: 12 }, new Date('2026-10-30T15:00:00Z'), cfg), null); // 21.2 DTE: still open
  assert.equal(exitDecision(pos, { mid: 12 }, new Date('2026-10-31T15:00:00Z'), cfg).reason, 'time');
});

test('cost to close buys back shorts and sells longs', () => {
  const pos = { legs: [{ symbol: 'LP', side: 'buy' }, { symbol: 'SP', side: 'sell' }, { symbol: 'SC', side: 'sell' }, { symbol: 'LC', side: 'buy' }] };
  const q = new Map([['LP', { bid: 1, ask: 1.2 }], ['SP', { bid: 4, ask: 4.4 }], ['SC', { bid: 3, ask: 3.2 }], ['LC', { bid: 0.8, ask: 1 }]]);
  const c = closeCost(pos, q);
  assert.ok(Math.abs(c.mid - (4.2 + 3.1 - 1.1 - 0.9)) < 1e-9);
  assert.ok(Math.abs(c.natural - (4.4 + 3.2 - 1 - 0.8)) < 1e-9);
  assert.equal(closeCost(pos, new Map()), null);
});

test('orders: credits negative, closing flips sides, $0.05 ticks', () => {
  assert.equal(signedLimit(10.8, 'credit'), '-10.80');
  assert.equal(signedLimit(5.25, 'debit'), '5.25');
  assert.equal(toTick(10.83, 'down'), 10.8);
  assert.equal(toTick(5.21, 'up'), 5.25);
  const legs = [{ symbol: 'A', side: 'buy' }, { symbol: 'B', side: 'sell' }];
  assert.deepEqual(mlegBody({ legs, qty: 2, limitPrice: '-10.80', open: true }).legs.map((l) => [l.side, l.position_intent]), [['buy', 'buy_to_open'], ['sell', 'sell_to_open']]);
  const close = mlegBody({ legs, qty: 2, limitPrice: '5.25', open: false });
  assert.deepEqual(close.legs.map((l) => [l.side, l.position_intent]), [['sell', 'sell_to_close'], ['buy', 'buy_to_close']]);
  assert.equal(close.order_class, 'mleg');
  assert.equal(close.qty, '2');
});

test('wings are never wider than the rule; a missing strike narrows by up to 5 points', () => {
  const full = chain();
  const c0 = buildCondor(full, cfg);
  const missing = full.filter((o) => !(o.type === 'call' && o.strike === c0.strikes.shortCall + 50 && o.expiry === c0.expiry));
  const c = buildCondor(missing, cfg);
  assert.equal(c.strikes.longCall - c.strikes.shortCall, 45);
  assert.equal(c.width, 50);
  assert.ok(Math.abs(c.maxLossPerContract - (50 - c.credit) * 100) < 1e-9);
});
