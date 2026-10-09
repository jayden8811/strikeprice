// Pure rule functions for the SPX iron condor bot. No I/O here, so every rule is testable.
import { black76Delta, black76IV, round } from '../engine/math.js';
import { etParts } from '../engine/time.js';

const DAY = 86_400_000;

// Calendar days to a 4pm ET expiration close (SPXW are PM-settled).
export function dte(expiry, now) {
  return (Date.parse(`${expiry}T20:00:00Z`) - now.getTime()) / DAY;
}

const mid = (o) => (o.bid > 0 && o.ask > 0 ? (o.bid + o.ask) / 2 : NaN);

// Forward price for one expiration from put-call parity at the strikes nearest the money.
export function forwardFromParity(contracts, spotHint) {
  const byStrike = new Map();
  for (const o of contracts) {
    const s = byStrike.get(o.strike) ?? {};
    s[o.type] = o;
    byStrike.set(o.strike, s);
  }
  const pairs = [...byStrike.entries()]
    .filter(([, s]) => Number.isFinite(mid(s.call ?? {})) && Number.isFinite(mid(s.put ?? {})))
    .map(([k, s]) => ({ k, f: k + mid(s.call) - mid(s.put), gap: Math.abs(mid(s.call) - mid(s.put)) }))
    .sort((a, b) => a.gap - b.gap)
    .slice(0, 3);
  if (!pairs.length) return spotHint ?? NaN;
  return pairs.reduce((a, p) => a + p.f, 0) / pairs.length;
}

// Adds forward, IV and delta to every contract with a two-sided quote.
export function priceChain(contracts, now, rate) {
  const byExp = new Map();
  for (const o of contracts) {
    if (!byExp.has(o.expiry)) byExp.set(o.expiry, []);
    byExp.get(o.expiry).push(o);
  }
  const out = [];
  for (const [expiry, list] of byExp) {
    const days = dte(expiry, now);
    if (days <= 0) continue;
    const T = days / 365;
    const F = forwardFromParity(list);
    for (const o of list) {
      const m = mid(o);
      const iv = Number.isFinite(m) && Number.isFinite(F) ? black76IV(m, F, o.strike, T, o.type, rate) : NaN;
      out.push({ ...o, dte: days, forward: F, mid: m, iv, delta: Number.isFinite(iv) ? black76Delta(F, o.strike, T, iv, o.type, rate) : NaN });
    }
  }
  return out;
}

// Expiration with 30–45 DTE, preferring the longest (closest to 45).
export function pickExpiration(chain, cfg) {
  const expiries = [...new Set(chain.map((o) => o.expiry))]
    .map((e) => ({ e, d: chain.find((o) => o.expiry === e).dte }))
    .filter((x) => x.d >= cfg.minDte && x.d <= cfg.maxDte)
    .sort((a, b) => b.d - a.d);
  return expiries[0]?.e ?? null;
}

// Short strike with |delta| closest to the target, within the accepted band.
export function pickShort(chain, expiry, type, cfg) {
  const cands = chain
    .filter((o) => o.expiry === expiry && o.type === type && Number.isFinite(o.delta) && o.bid > 0)
    .map((o) => ({ ...o, absDelta: Math.abs(o.delta) }))
    .filter((o) => o.absDelta >= cfg.minDelta && o.absDelta <= cfg.maxDelta)
    .sort((a, b) => Math.abs(a.absDelta - cfg.targetDelta) - Math.abs(b.absDelta - cfg.targetDelta));
  return cands[0] ?? null;
}

// Builds the four legs and their prices. Credit is the mid; natural is sell-at-bid / buy-at-ask.
export function buildCondor(chain, cfg) {
  const expiry = pickExpiration(chain, cfg);
  if (!expiry) return { error: `No expiration between ${cfg.minDte} and ${cfg.maxDte} days.` };
  const shortPut = pickShort(chain, expiry, 'put', cfg);
  const shortCall = pickShort(chain, expiry, 'call', cfg);
  if (!shortPut || !shortCall) {
    return { error: `No ${!shortPut ? 'put' : 'call'} with a ${Math.round(cfg.minDelta * 100)}–${Math.round(cfg.maxDelta * 100)} delta in the ${expiry} expiration.`, expiry };
  }
  // Wing: the quoted strike at the target width, or up to 5 points narrower if that strike
  // isn't quoted (never wider than the rule allows).
  const wing = (type, target) => chain
    .filter((o) => o.expiry === expiry && o.type === type && o.ask > 0)
    .filter((o) => (type === 'put' ? o.strike >= target && o.strike <= target + 5 : o.strike <= target && o.strike >= target - 5))
    .sort((a, b) => Math.abs(a.strike - target) - Math.abs(b.strike - target))[0];
  const longPut = wing('put', shortPut.strike - cfg.wingWidth);
  const longCall = wing('call', shortCall.strike + cfg.wingWidth);
  if (!longPut || !longCall) return { error: `No quoted ${cfg.wingWidth}-point wing strikes in ${expiry}.`, expiry };
  const width = Math.max(shortPut.strike - longPut.strike, longCall.strike - shortCall.strike);

  const legs = [
    { role: 'longPut', side: 'buy', ...longPut },
    { role: 'shortPut', side: 'sell', ...shortPut },
    { role: 'shortCall', side: 'sell', ...shortCall },
    { role: 'longCall', side: 'buy', ...longCall },
  ];
  const credit = shortPut.mid + shortCall.mid - longPut.mid - longCall.mid;
  const natural = shortPut.bid + shortCall.bid - longPut.ask - longCall.ask;
  const spreadSum = legs.reduce((a, l) => a + (l.ask - l.bid), 0);
  return {
    expiry,
    dte: shortPut.dte,
    forward: shortPut.forward,
    legs,
    strikes: { longPut: longPut.strike, shortPut: shortPut.strike, shortCall: shortCall.strike, longCall: longCall.strike },
    deltas: { shortPut: round(shortPut.delta, 3), shortCall: round(shortCall.delta, 3) },
    width,
    credit,
    natural,
    spreadFraction: credit > 0 ? spreadSum / credit : Infinity,
    maxLossPerContract: (width - credit) * 100,
  };
}

export function contractsFor(equity, vix, condor, cfg) {
  const pct = vix >= cfg.highVix ? cfg.riskPctHighVix : cfg.riskPct;
  return { pct, qty: Math.max(0, Math.floor((equity * pct) / condor.maxLossPerContract)) };
}

// Every entry rule, each with a pass/fail and the reason. Entry only if all pass.
export function entryChecks({ now, vix, condor, positions, lastEntryAt, account, cfg, recentResults = [] }) {
  const { date, minutes, weekday } = etParts(now);
  const checks = [];
  const add = (id, label, pass, detail) => checks.push({ id, label, pass, detail });

  add('session', 'Market hours', !['Sat', 'Sun'].includes(weekday) && minutes >= cfg.entryWindow[0] && minutes <= cfg.entryWindow[1],
    'Entries only between 9:45 AM and 3:30 PM ET on trading days.');
  add('vix', 'VIX 15–22', Number.isFinite(vix) && vix >= cfg.vixMin && vix <= cfg.vixMax,
    Number.isFinite(vix) ? `VIX ${vix.toFixed(2)}` : 'VIX unavailable');
  add('event', 'No major event today', !cfg.eventDays.includes(date), cfg.eventDays.includes(date) ? 'Event day.' : 'No listed event.');
  const daysSince = lastEntryAt ? (now - new Date(lastEntryAt)) / DAY : Infinity;
  add('frequency', `≥ ${cfg.minDaysBetweenEntries} days since last entry`, daysSince >= cfg.minDaysBetweenEntries,
    lastEntryAt ? `Last entry ${daysSince.toFixed(1)} days ago.` : 'No previous entry.');
  add('capacity', `≤ ${cfg.maxOpen} open condors`, positions.length < cfg.maxOpen, `${positions.length} open.`);

  const dayLoss = account ? (account.lastEquity - account.equity) / account.lastEquity : 0;
  add('dailyLoss', 'Daily loss limit', dayLoss < cfg.dailyLossLimit, `Today ${(-dayLoss * 100).toFixed(2)}%.`);
  const weekLoss = account?.weekStartEquity ? (account.weekStartEquity - account.equity) / account.weekStartEquity : 0;
  add('weeklyLoss', 'Weekly loss limit', weekLoss < cfg.weeklyLossLimit, `This week ${(-weekLoss * 100).toFixed(2)}%.`);
  if (cfg.pauseAfterLosses > 0) {
    const streak = recentResults.slice(-cfg.pauseAfterLosses);
    add('streak', `Pause after ${cfg.pauseAfterLosses} losses`, !(streak.length === cfg.pauseAfterLosses && streak.every((p) => p < 0)), 'Recent closes.');
  }

  if (condor.error) {
    add('structure', 'Strikes found', false, condor.error);
  } else {
    add('structure', 'Strikes found', true,
      `${condor.expiry} (${Math.round(condor.dte)} DTE): ${condor.strikes.longPut}/${condor.strikes.shortPut}p · ${condor.strikes.shortCall}/${condor.strikes.longCall}c, deltas ${condor.deltas.shortPut}/${condor.deltas.shortCall}`);
    const minCredit = condor.width * cfg.minCreditFraction;
    add('credit', `Credit ≥ ${(cfg.minCreditFraction * 100).toFixed(0)}% of width`, condor.credit >= minCredit,
      `Mid credit $${condor.credit.toFixed(2)} vs required $${minCredit.toFixed(2)}.`);
    add('spread', 'Bid-ask not too wide', condor.spreadFraction <= cfg.maxSpreadFraction,
      `Leg spreads total ${(condor.spreadFraction * 100).toFixed(0)}% of the credit (max ${(cfg.maxSpreadFraction * 100).toFixed(0)}%).`);
    if (account && Number.isFinite(vix)) {
      const { qty, pct } = contractsFor(account.equity, vix, condor, cfg);
      add('size', 'Position size ≥ 1', qty >= 1, `${qty} contract(s) at ${(pct * 100).toFixed(0)}% risk; max loss $${condor.maxLossPerContract.toFixed(0)} each.`);
    }
  }
  return { ok: checks.every((c) => c.pass), checks };
}

// Cost to close (mid and natural) for an open condor from current quotes.
export function closeCost(position, quotes) {
  let midCost = 0;
  let naturalCost = 0;
  for (const leg of position.legs) {
    const q = quotes.get(leg.symbol);
    if (!q || !(q.ask > 0)) return null;
    const m = (q.bid + q.ask) / 2;
    if (leg.side === 'sell') {
      midCost += m;
      naturalCost += q.ask;
    } else {
      midCost -= m;
      naturalCost -= q.bid;
    }
  }
  return { mid: midCost, natural: naturalCost };
}

// The first exit rule that triggers, or null. Checked against the mid cost to close.
export function exitDecision(position, cost, now, cfg) {
  const days = dte(position.expiry, now);
  if (cost && cost.mid <= position.credit * cfg.profitTarget) {
    return { reason: 'profit', detail: `Cost to close $${cost.mid.toFixed(2)} ≤ ${cfg.profitTarget * 100}% of $${position.credit.toFixed(2)} credit.` };
  }
  if (cost && cost.mid >= position.credit * cfg.stopMultiple) {
    return { reason: 'stop', detail: `Cost to close $${cost.mid.toFixed(2)} ≥ ${cfg.stopMultiple * 100}% of $${position.credit.toFixed(2)} credit.` };
  }
  if (days <= cfg.exitDte) {
    return { reason: 'time', detail: `${days.toFixed(1)} days to expiration (≤ ${cfg.exitDte}).` };
  }
  return null;
}
