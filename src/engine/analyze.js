import { computeLevels } from './levels.js';
import { computeVolatility, computeLiquidity } from './volatility.js';
import { computeGex } from './gex.js';
import { analyzeFlow, proxyFlowFromChain } from './flow.js';
import { bsDelta, bsPrice, round, TRADING_DAYS, vwap } from './math.js';
import { addTradingDays, daysToExpiry, etDate, marketSession, tradingDaysUntil } from './time.js';

const MAX_SPREAD_GOOD = 0.05;
const MAX_SPREAD_OK = 0.10;
const IV_RV_CHEAP = 1.05;
const IV_RV_RICH = 1.3;
const EARNINGS_BLOCK_DAYS = 2;
const MIN_REWARD_RISK = 1.5;
const MIN_DTE = 1;
const MAX_DTE = 15;
const TARGET_DTE = 8;
const MAX_HOLD_DAYS = 5;

// Main entry: answers "are conditions good to buy options on this ticker right now?"
// and, if so, "what is the setup?". Input is plain data so any source can feed it.
export function analyze(input) {
  const now = input.now ?? new Date();
  const ticker = input.ticker.toUpperCase();
  const price = input.price;
  const session = input.session ?? marketSession(now);
  const chain = input.chain ?? [];

  const levels = computeLevels({ daily: input.daily, intraday: input.intraday, price, now });
  const vol = computeVolatility({ closes: levels.closes, chain, price, now });
  const liq = computeLiquidity({ chain, price, now });
  const gex = computeGex({ chain, price, now });
  const flow = input.flowPrints
    ? analyzeFlow({ prints: input.flowPrints, ticker, now })
    : proxyFlowFromChain({ chain, price, now });
  const market = marketRegime(input.market ?? {}, now);
  const earnings = earningsInfo(input.earningsDate, now);

  const direction = directionalBias({ levels, flow, market, price });
  const trigger = triggerState({ levels, price, bias: direction.bias });

  const checks = [
    checkLiquidity(liq),
    checkPricing(vol),
    checkEvents(earnings),
    checkGamma(gex, price),
    checkMarket(market, direction.bias),
    checkDirection(direction, flow),
    checkTrigger(trigger, direction.bias),
  ];

  const blockers = [];
  if (session !== 'open') blockers.push('The market is closed, so there is no live tape to act on.');
  for (const c of checks) if (c.status === 'bad' && c.blocking) blockers.push(c.reason);
  if (!direction.bias) blockers.push('Price, flow and trend do not agree on a direction yet.');
  else if (!trigger.active) blockers.push(`No confirmed ${direction.bias === 'bull' ? 'breakout' : 'breakdown'} through a key level yet.`);

  let setup = null;
  let extended = false;
  if (!blockers.length) {
    setup = buildSetup({ ticker, chain, price, now, levels, gex, vol, earnings, bias: direction.bias, trigger });
    if (setup.error) {
      blockers.push(setup.error);
      extended = setup.extended;
      setup = null;
    }
  }

  const verdict = setup ? 'good' : 'not';
  return {
    ticker,
    price: round(price),
    asOf: now.toISOString(),
    session,
    verdict,
    bias: direction.bias,
    summary: setup ? setup.sentence : watchSentence({ ticker, levels, gex, price, blockers, bias: direction.bias, trigger, extended, session }),
    setup,
    watch: setup ? null : watchLevels({ levels, gex, price }),
    reasons: blockers,
    checks,
    levels: pickLevels(levels, gex),
    metrics: {
      rv10: round(vol.rv10 * 100, 1),
      rv20: round(vol.rv20 * 100, 1),
      forecastRV: round(vol.forecastRV * 100, 1),
      atmIV: round(vol.atmIV * 100, 1),
      frontIV: round(vol.frontIV * 100, 1),
      ivToRv: round(vol.ivToRv, 2),
      medianSpreadPct: round(liq.medianSpreadPct * 100, 1),
      netGex: gex ? Math.round(gex.net) : null,
      gammaFlip: round(gex?.flip),
      vix: round(market.vix),
      vixTerm: round(market.vixTerm, 2),
      earningsDate: earnings.date,
      daysToEarnings: round(earnings.days, 1),
    },
    flow: {
      source: flow.source,
      prints: flow.prints,
      net: round(flow.net, 2),
      bullPremium: Math.round(flow.bullPremium),
      bearPremium: Math.round(flow.bearPremium),
      top: flow.top.map((p) => ({
        time: p.time ?? null,
        type: p.type,
        strike: p.strike,
        expiry: p.expiry,
        side: p.side ?? null,
        size: p.size ?? p.volume,
        premium: Math.round(p.premium ?? p.size * p.price * 100),
        sweep: !!p.sweep,
      })),
    },
  };
}

// ---------- context ----------

function marketRegime({ spyDaily = [], spyIntraday = [], spyPrice, vix, vix3m }, now) {
  const today = etDate(now);
  const closes = spyDaily.filter((b) => etDate(new Date(b.t)) < today).map((b) => b.c);
  const sma20 = closes.length >= 20 ? closes.slice(-20).reduce((a, b) => a + b, 0) / 20 : NaN;
  const session = spyIntraday.filter((b) => etDate(new Date(b.t)) === today);
  const spyVwap = session.length ? vwap(session) : NaN;
  let trend = 0;
  if (spyPrice && Number.isFinite(sma20)) trend += spyPrice > sma20 ? 1 : -1;
  if (spyPrice && Number.isFinite(spyVwap)) trend += spyPrice > spyVwap ? 1 : -1;
  return {
    trend: trend >= 2 ? 'bull' : trend <= -2 ? 'bear' : null,
    spyPrice,
    spyVwap,
    vix,
    vixTerm: vix && vix3m ? vix / vix3m : NaN,
  };
}

function earningsInfo(date, now) {
  if (!date) return { date: null, days: NaN };
  return { date, days: daysToExpiry(date, now) };
}

function directionalBias({ levels, flow, market, price }) {
  const votes = [];
  const add = (name, v, w = 1) => votes.push({ name, v, w });
  if (Number.isFinite(levels.vwap)) add('Price vs VWAP', price > levels.vwap ? 1 : -1);
  if (levels.orHigh != null) add('Opening range', price > levels.orHigh ? 1 : price < levels.orLow ? -1 : 0);
  if (Number.isFinite(levels.sma20) && Number.isFinite(levels.sma50)) {
    add('Daily trend', price > levels.sma20 && levels.sma20 > levels.sma50 ? 1 : price < levels.sma20 && levels.sma20 < levels.sma50 ? -1 : 0);
  }
  add('Options flow', flow.net > 0.3 ? 1 : flow.net < -0.3 ? -1 : 0, flow.source === 'feed' ? 2 : 1);
  add('Market (SPY)', market.trend === 'bull' ? 1 : market.trend === 'bear' ? -1 : 0);

  const score = votes.reduce((a, x) => a + x.v * x.w, 0);
  const max = votes.reduce((a, x) => a + x.w, 0);
  const need = Math.ceil(max / 2);
  return { bias: score >= need ? 'bull' : score <= -need ? 'bear' : null, score, max, votes };
}

// A buyer needs the move to start now: price must be through VWAP and the opening range.
function triggerState({ levels, price, bias }) {
  if (!bias) return { active: false, level: null };
  const refs = [levels.vwap, bias === 'bull' ? levels.orHigh : levels.orLow].filter(Number.isFinite);
  if (!refs.length) return { active: false, level: null };
  const level = bias === 'bull' ? Math.max(...refs) : Math.min(...refs);
  return { active: bias === 'bull' ? price > level : price < level, level };
}

// ---------- checks ----------

function check(id, label, status, value, reason, blocking = false) {
  return { id, label, status, value, reason, blocking };
}

function checkLiquidity(liq) {
  const s = liq.medianSpreadPct;
  if (!liq.quoted || !Number.isFinite(s)) {
    return check('liquidity', 'Liquidity', 'bad', 'No quotes', 'No live option quotes near the money.', true);
  }
  const v = `${(s * 100).toFixed(1)}% spread`;
  if (s <= MAX_SPREAD_GOOD) return check('liquidity', 'Liquidity', 'good', v, 'Tight spreads near the money.');
  if (s <= MAX_SPREAD_OK) return check('liquidity', 'Liquidity', 'neutral', v, 'Spreads are usable but costly; use limit orders at mid.');
  return check('liquidity', 'Liquidity', 'bad', v, 'Spreads are too wide; entry and exit costs eat the edge.', true);
}

function checkPricing(vol) {
  const r = vol.ivToRv;
  if (!Number.isFinite(r)) return check('pricing', 'Option pricing', 'neutral', 'n/a', 'Not enough data to compare implied and realized volatility.');
  const v = `IV ${(vol.atmIV * 100).toFixed(0)}% vs RV ${(vol.forecastRV * 100).toFixed(0)}%`;
  if (r <= IV_RV_CHEAP) return check('pricing', 'Option pricing', 'good', v, 'Options are cheap relative to how much the stock is actually moving.');
  if (r <= IV_RV_RICH) return check('pricing', 'Option pricing', 'neutral', v, 'Options are fairly priced; the move must exceed what is implied.');
  return check('pricing', 'Option pricing', 'bad', v, 'Options are expensive versus realized movement; buyers are overpaying.', true);
}

function checkEvents(e) {
  if (!e.date) return check('events', 'Events', 'neutral', 'Unknown', 'Earnings date unavailable; confirm before trading.');
  const d = e.days;
  const v = d >= 0 ? `Earnings in ${Math.ceil(d)}d` : 'Earnings passed';
  if (d >= 0 && d <= EARNINGS_BLOCK_DAYS) {
    return check('events', 'Events', 'bad', v, 'Earnings are imminent; implied volatility will likely collapse after the report (IV crush).', true);
  }
  if (d >= 0 && d <= 45) return check('events', 'Events', 'neutral', v, 'Pick an expiration before earnings or accept IV crush risk.');
  return check('events', 'Events', 'good', v, 'No earnings in the trade window.');
}

function checkGamma(gex, price) {
  if (!gex) return check('gamma', 'Dealer gamma', 'neutral', 'n/a', 'Not enough open interest to estimate dealer positioning.');
  const below = gex.flip != null && price < gex.flip;
  if (gex.net < 0 || below) {
    return check('gamma', 'Dealer gamma', 'good', 'Negative', 'Dealers are short gamma, which tends to amplify moves.');
  }
  return check('gamma', 'Dealer gamma', 'neutral', 'Positive', 'Dealers are long gamma, which tends to dampen moves; expect chop near big strikes.');
}

function checkMarket(market, bias) {
  const term = Number.isFinite(market.vixTerm) ? ` · VIX/VIX3M ${market.vixTerm.toFixed(2)}` : '';
  const v = `${market.trend === 'bull' ? 'Up' : market.trend === 'bear' ? 'Down' : 'Mixed'}${term}`;
  if (!market.trend) return check('market', 'Market regime', 'neutral', v, 'The broad market has no clear direction.');
  if (!bias) return check('market', 'Market regime', 'neutral', v, 'The broad market is trending; the ticker has no bias yet.');
  if (market.trend === bias) return check('market', 'Market regime', 'good', v, 'The broad market is moving in the same direction.');
  return check('market', 'Market regime', 'bad', v, 'The trade would fight the broad market.');
}

function checkDirection(direction, flow) {
  const label = flow.source === 'feed' ? 'Flow + trend' : 'Flow (proxy) + trend';
  const v = `${direction.score > 0 ? '+' : ''}${direction.score} of ${direction.max}`;
  if (!direction.bias) return check('direction', label, 'neutral', v, 'Signals are split; no directional edge.');
  return check('direction', label, 'good', v, `Signals lean ${direction.bias === 'bull' ? 'bullish (calls)' : 'bearish (puts)'}.`);
}

function checkTrigger(trigger, bias) {
  if (!bias) return check('trigger', 'Entry trigger', 'neutral', 'Waiting', 'Needs a direction first.');
  const lvl = trigger.level != null ? `$${trigger.level.toFixed(2)}` : 'n/a';
  if (trigger.active) return check('trigger', 'Entry trigger', 'good', `Through ${lvl}`, 'Price has broken through VWAP and the opening range.');
  return check('trigger', 'Entry trigger', 'neutral', `Watch ${lvl}`, 'Price has not confirmed the move yet.');
}

// ---------- setup ----------

function buildSetup({ ticker, chain, price, now, levels, gex, vol, earnings, bias, trigger }) {
  const type = bias === 'bull' ? 'call' : 'put';
  const dir = bias === 'bull' ? 1 : -1;
  const atrV = Number.isFinite(levels.atr) ? levels.atr : price * 0.02;
  const $ = (x) => `$${round(x).toFixed(2)}`; // same rounding as the returned fields

  // Expiration: MIN_DTE–MAX_DTE days, closest to TARGET_DTE, preferring ones before earnings.
  let expiries = [...new Set(chain.map((o) => o.expiry))]
    .map((e) => ({ e, dte: daysToExpiry(e, now) }))
    // At least one full trading day before expiry, so there's room to exit before expiration day.
    .filter((x) => x.dte >= MIN_DTE && x.dte <= MAX_DTE && tradingDaysUntil(now, x.e) >= 1);
  const preEarnings = earnings.date && earnings.days >= 0 ? expiries.filter((x) => x.e < earnings.date) : expiries;
  if (preEarnings.length) expiries = preEarnings;
  if (!expiries.length) return { error: `No expiration within ${MAX_DTE} days with usable quotes.` };
  expiries.sort((a, b) => Math.abs(a.dte - TARGET_DTE) - Math.abs(b.dte - TARGET_DTE));

  let pick = null;
  for (const { e, dte } of expiries) {
    const cands = chain
      .filter((o) => o.expiry === e && o.type === type && o.bid > 0 && o.ask > o.bid)
      .map((o) => {
        const iv = o.iv > 0 ? o.iv : vol.atmIV;
        const delta = Number.isFinite(o.delta) && o.delta !== 0 ? o.delta : bsDelta(price, o.strike, dte / 365, iv, type);
        const mid = (o.bid + o.ask) / 2;
        return { ...o, iv, delta, mid, dte, spread: (o.ask - o.bid) / mid };
      })
      .filter((o) => o.spread <= MAX_SPREAD_OK);
    if (!cands.length) continue;
    // ~0.50 delta: enough leverage to the move without paying for far-OTM decay.
    cands.sort((a, b) => Math.abs(Math.abs(a.delta) - 0.5) - Math.abs(Math.abs(b.delta) - 0.5));
    pick = cands[0];
    break;
  }
  if (!pick) return { error: `No contract with a tight enough spread expiring within ${MAX_DTE} days.` };

  const iv = pick.iv || vol.atmIV;
  const dailyMove = (price * iv) / Math.sqrt(TRADING_DAYS);

  // Stop: the underlying moving back through the trigger level, with a small ATR buffer.
  const stop = trigger.level - dir * 0.15 * atrV;

  // Take profits: the next two key levels in the trade direction, else expected-move multiples.
  const levelsAhead = [levels.priorHigh, levels.priorLow, levels.dayHigh, levels.dayLow, gex?.callWall, gex?.putWall, gex?.flip]
    .filter((x) => Number.isFinite(x) && dir * (x - price) >= 0.25 * atrV)
    .sort((a, b) => dir * (a - b));
  const tp1 = levelsAhead[0] ?? price + dir * Math.max(dailyMove, 0.5 * atrV);
  const tp2 = levelsAhead.find((x) => dir * (x - tp1) >= 0.25 * atrV) ?? tp1 + dir * Math.max(dailyMove, 0.5 * atrV);

  // Hold time: a random walk covers distance d in about (d / dailyMove)^2 days. Short-dated
  // options decay fast, so cap the hold and never hold into the final trading day.
  const daysFor = (target) => Math.ceil((Math.abs(target - price) / dailyMove) ** 2);
  const maxHold = Math.min(MAX_HOLD_DAYS, tradingDaysUntil(now, pick.expiry));
  const hold1 = Math.min(maxHold, Math.max(1, daysFor(tp1)));
  const hold2 = Math.min(maxHold, Math.max(hold1, daysFor(tp2)));

  // Option values via Black-Scholes repricing (includes time decay), anchored to the live mid.
  const offset = pick.mid - bsPrice(price, pick.strike, pick.dte / 365, iv, type);
  const optAt = (s, daysLater) =>
    Math.max(0.01, bsPrice(s, pick.strike, Math.max(pick.dte - daysLater * 1.4, 0.05) / 365, iv, type) + offset);
  const optTp1 = optAt(tp1, hold1);
  const optTp2 = optAt(tp2, hold2);
  const optStop = optAt(stop, 0);

  const rrAt = (paid) => (paid > optStop ? (optTp1 - paid) / (paid - optStop) : NaN);
  const rr = rrAt(pick.mid);
  if (!(rr >= MIN_REWARD_RISK)) {
    return { extended: true, error: `Reward-to-risk to the first target is only ${Number.isFinite(rr) ? rr.toFixed(1) : 'n/a'}:1; not worth buying premium.` };
  }

  // Entry range: work a limit order from just under mid; never pay more than keeps reward:risk >= MIN.
  const quarter = (pick.ask - pick.bid) / 4;
  const rrCap = (optTp1 + MIN_REWARD_RISK * optStop) / (1 + MIN_REWARD_RISK);
  const entryLow = Math.max(pick.bid, pick.mid - quarter);
  const entryHigh = Math.max(entryLow, Math.min(pick.ask, pick.mid + quarter, rrCap));
  // Underlying zone: from the trigger level up to half an ATR beyond it; past that, don't chase.
  const zoneFar = trigger.level + dir * 0.5 * atrV;
  const underlyingZone = dir > 0 ? [trigger.level, zoneFar] : [zoneFar, trigger.level];

  const exitBy = addTradingDays(now, hold2);
  const breakeven = pick.strike + dir * pick.mid;
  const exp = fmtExpiry(pick.expiry);
  const days = (n) => `${n} trading day${n > 1 ? 's' : ''}`;
  const sentence =
    `Buy the ${ticker} ${exp} $${fmtStrike(pick.strike)} ${type} between ${$(entryLow)} and ${$(entryHigh)} ` +
    `while ${ticker} holds ${bias === 'bull' ? 'above' : 'below'} ${$(trigger.level)}. ` +
    `Take profit at ${$(tp1)} and ${$(tp2)}; stop if ${ticker} ${bias === 'bull' ? 'loses' : 'reclaims'} ${$(stop)}. ` +
    `Hold up to ${days(hold2)}.`;

  return {
    sentence,
    direction: bias,
    contract: {
      type,
      strike: pick.strike,
      expiry: pick.expiry,
      dte: Math.round(pick.dte),
      bid: pick.bid,
      ask: pick.ask,
      mid: round(pick.mid),
      delta: round(pick.delta, 2),
      iv: round(iv * 100, 1),
      spreadPct: round(pick.spread * 100, 1),
      oi: pick.oi,
      volume: pick.volume,
    },
    entry: {
      optionLow: round(entryLow),
      optionHigh: round(entryHigh),
      underlyingLow: round(underlyingZone[0]),
      underlyingHigh: round(underlyingZone[1]),
      trigger: round(trigger.level),
    },
    stopLoss: { underlying: round(stop), option: round(optStop) },
    takeProfits: [
      { label: 'TP1', underlying: round(tp1), option: round(optTp1), days: hold1, action: 'Sell half; move the stop to your entry price.' },
      { label: 'TP2', underlying: round(tp2), option: round(optTp2), days: hold2, action: 'Sell the rest.' },
    ],
    hold: {
      expectedDays: hold1,
      maxDays: hold2,
      exitBy,
      text: `Expect TP1 within about ${days(hold1)}. Exit everything by the close on ${fmtDate(exitBy)} if targets aren't hit; don't hold into expiration day.`,
    },
    breakeven: round(breakeven),
    rewardRisk: round(rr, 1),
    sizing: 'Premium paid is the max loss. Risk 1–2% of the account at most.',
  };
}

// ---------- wait state ----------

function watchLevels({ levels, gex, price }) {
  const all = [
    ['VWAP', levels.vwap],
    ['opening range high', levels.orHigh],
    ['opening range low', levels.orLow],
    ['prior day high', levels.priorHigh],
    ['prior day low', levels.priorLow],
    ['call wall', gex?.callWall],
    ['put wall', gex?.putWall],
    ['gamma flip', gex?.flip],
  ].filter(([, v]) => Number.isFinite(v));
  const minGap = price * 0.001;
  const above = all.filter(([, v]) => v > price + minGap).sort((a, b) => a[1] - b[1])[0];
  const below = all.filter(([, v]) => v < price - minGap).sort((a, b) => b[1] - a[1])[0];
  return {
    above: above ? { label: above[0], price: round(above[1]) } : null,
    below: below ? { label: below[0], price: round(below[1]) } : null,
  };
}

function watchSentence({ ticker, levels, gex, price, blockers, bias, trigger, extended, session }) {
  const w = watchLevels({ levels, gex, price });
  const $ = (x) => `$${x.toFixed(2)}`;
  const reason = blockers.length ? `${blockers[0]} ` : '';
  if (bias && trigger.level != null) {
    const side = bias === 'bull' ? 'calls' : 'puts';
    if (trigger.active && extended) {
      return `${reason}${ticker} is extended from its entry level; for ${side}, wait for a pullback toward ${$(trigger.level)} that holds.`;
    }
    if (trigger.active) {
      const when = session === 'open' ? '' : ' at the open';
      return `${reason}Leaning ${bias === 'bull' ? 'bullish' : 'bearish'}: ${side} stay in play${when} while ${ticker} holds ${bias === 'bull' ? 'above' : 'below'} ${$(trigger.level)}.`;
    }
    return `${reason}Leaning ${bias === 'bull' ? 'bullish' : 'bearish'}: watch for a ${bias === 'bull' ? 'break above' : 'break below'} ${$(trigger.level)} for ${side}.`;
  }
  const parts = [];
  if (w.above) parts.push(`a break above ${$(w.above.price)} (${w.above.label}) for calls`);
  if (w.below) parts.push(`a break below ${$(w.below.price)} (${w.below.label}) for puts`);
  const watch = parts.length ? `Watch for ${parts.join(', or ')}.` : `No clear levels to watch on ${ticker} yet.`;
  return `${reason}${watch}`;
}

function pickLevels(levels, gex) {
  return {
    vwap: round(levels.vwap),
    orHigh: round(levels.orHigh),
    orLow: round(levels.orLow),
    priorHigh: round(levels.priorHigh),
    priorLow: round(levels.priorLow),
    priorClose: round(levels.priorClose),
    dayHigh: round(levels.dayHigh),
    dayLow: round(levels.dayLow),
    atr: round(levels.atr),
    callWall: round(gex?.callWall),
    putWall: round(gex?.putWall),
    gammaFlip: round(gex?.flip),
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtExpiry(e) {
  const [, m, d] = e.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}
function fmtDate(ymd) {
  const d = new Date(`${ymd}T12:00:00Z`);
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]} ${fmtExpiry(ymd)}`;
}
function fmtStrike(k) {
  return Number.isInteger(k) ? String(k) : k.toFixed(2);
}
