import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/engine/analyze.js';
import { analyzeFlow } from '../src/engine/flow.js';
import { computeGex } from '../src/engine/gex.js';
import { bsPrice, normCdf } from '../src/engine/math.js';
import { parseOccSymbol } from '../src/data/cboe.js';
import { normalizePrint } from '../src/data/flowStore.js';
import { demoData } from '../src/data/demo.js';

const TICKERS = 'AAPL NVDA TSLA SPY AMD META MSFT GOOGL AMZN JPM XOM QQQ'.split(' ');

test('Black-Scholes sanity: put-call parity and N(0)', () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-6);
  const c = bsPrice(100, 100, 0.25, 0.3, 'call');
  const p = bsPrice(100, 100, 0.25, 0.3, 'put');
  assert.ok(Math.abs(c - p) < 1e-6); // r = 0, S = K
});

test('parses OCC option symbols', () => {
  assert.deepEqual(parseOccSymbol('AAPL261016C00230000'), { root: 'AAPL', expiry: '2026-10-16', type: 'call', strike: 230 });
  assert.equal(parseOccSymbol('SPXW261016P05800500').strike, 5800.5);
});

test('every verdict is either a full setup or levels to watch', () => {
  let sawSetup = false;
  for (const t of TICKERS) {
    const r = analyze(demoData(t, new Date('2026-10-06T18:00:00Z')));
    assert.ok(['good', 'not'].includes(r.verdict));
    assert.equal(typeof r.summary, 'string');
    if (r.verdict === 'good') {
      const s = r.setup;
      const dir = s.direction === 'bull' ? 1 : -1;
      assert.ok(s.rewardRisk >= 1.5);
      assert.ok(s.contract.dte >= 1 && s.contract.dte <= 15);
      // Stop is behind the entry trigger; TP2 is beyond TP1, which is beyond the current price.
      assert.ok(dir * (s.stopLoss.underlying - s.entry.trigger) < 0);
      assert.ok(dir * (s.takeProfits[0].underlying - r.price) > 0);
      assert.ok(dir * (s.takeProfits[1].underlying - s.takeProfits[0].underlying) > 0);
      // Option prices: stop < entry range < TP1 < TP2, and the range sits inside the quote.
      assert.ok(s.stopLoss.option < s.entry.optionLow);
      assert.ok(s.entry.optionLow <= s.entry.optionHigh && s.entry.optionHigh < s.takeProfits[0].option);
      assert.ok(s.takeProfits[0].option <= s.takeProfits[1].option);
      assert.ok(s.entry.optionLow >= s.contract.bid && s.entry.optionHigh <= s.contract.ask);
      // Hold ends before the expiration date.
      assert.ok(s.hold.exitBy < s.contract.expiry);
      assert.ok(s.hold.expectedDays <= s.hold.maxDays);
      sawSetup = true;
    } else {
      assert.equal(r.setup, null);
      assert.ok(r.reasons.length > 0);
    }
  }
  assert.ok(sawSetup, 'at least one demo ticker should produce a setup');
});

test('closed market is never "good"', () => {
  const d = { ...demoData('AAPL'), session: 'closed' };
  const r = analyze(d);
  assert.equal(r.verdict, 'not');
  assert.match(r.reasons[0], /closed/);
});

test('imminent earnings blocks buying', () => {
  const d = demoData('AAPL');
  d.earningsDate = new Date(d.now.getTime() + 86_400_000).toISOString().slice(0, 10);
  const r = analyze(d);
  assert.equal(r.checks.find((c) => c.id === 'events').status, 'bad');
  assert.equal(r.verdict, 'not');
});

test('wide spreads block buying', () => {
  const d = demoData('AAPL');
  d.chain = d.chain.map((o) => ({ ...o, bid: o.last * 0.7, ask: o.last * 1.3 }));
  const r = analyze(d);
  assert.equal(r.checks.find((c) => c.id === 'liquidity').status, 'bad');
  assert.equal(r.verdict, 'not');
});

test('flow: calls bought at the ask are bullish, puts bought at the ask bearish', () => {
  const now = new Date();
  const mk = (type, side) => ({ ticker: 'X', time: now.toISOString(), type, side, size: 100, price: 2 });
  assert.equal(analyzeFlow({ prints: [mk('call', 'ask'), mk('put', 'bid')], ticker: 'X', now }).net, 1);
  assert.equal(analyzeFlow({ prints: [mk('put', 'ask')], ticker: 'X', now }).net, -1);
});

test('normalizes common flow field names', () => {
  const p = normalizePrint({ symbol: 'nvda', put_call: 'P', strike: '120', expiration: '2026-10-16', aggressor: 'buy', quantity: 50, price: 1.2, is_sweep: true });
  assert.deepEqual(
    { ticker: p.ticker, type: p.type, side: p.side, size: p.size, sweep: p.sweep },
    { ticker: 'NVDA', type: 'put', side: 'ask', size: 50, sweep: true },
  );
});

test('GEX: call-only open interest is positive, put-only negative', () => {
  const now = new Date('2026-10-06T15:00:00Z');
  const base = { strike: 100, expiry: '2026-10-30', iv: 0.3, oi: 1000, gamma: 0.03 };
  assert.ok(computeGex({ chain: [{ ...base, type: 'call' }], price: 100, now }).net > 0);
  assert.ok(computeGex({ chain: [{ ...base, type: 'put' }], price: 100, now }).net < 0);
});

test('short-dated picks always leave a trading day before expiry', async () => {
  const { tradingDaysUntil, addTradingDays } = await import('../src/engine/time.js');
  const fri = new Date('2026-10-09T15:00:00Z');
  assert.equal(addTradingDays(fri, 1), '2026-10-12'); // Friday → Monday
  assert.equal(tradingDaysUntil(fri, '2026-10-12'), 0);
  assert.equal(tradingDaysUntil(fri, '2026-10-16'), 4);
  // Sweep across a week of start times; any setup must exit before expiration day.
  for (let day = 0; day < 7; day++) {
    for (const t of TICKERS) {
      const d = demoData(t, new Date(Date.UTC(2026, 9, 5 + day, 18)));
      const r = analyze(d);
      if (r.setup) assert.ok(r.setup.hold.exitBy < r.setup.contract.expiry, `${t} day ${day}`);
    }
  }
});
