// One decision cycle of the SPX iron condor bot. Run it every few minutes during market hours.
//
// Modes (CONDOR_MODE):
//   dry   (default) decides and logs what it would do; fills are simulated at the limit price
//   paper submits real orders to the Alpaca paper account
//
// Order handling: entries are limit orders at the mid credit (rounded down to $0.05). An entry
// that hasn't filled after ENTRY_TIMEOUT is cancelled and retried next cycle at the new mid.
// Profit-target exits use a limit at the mid cost; stop and time exits use the natural price
// (marketable) so they get out. All four legs always trade together as one order.
import * as broker from './broker.js';
import { loadConfig } from './config.js';
import { quotesFor, snapshot } from './market.js';
import { buildCondor, closeCost, contractsFor, entryChecks, exitDecision } from './rules.js';
import { loadState, log, saveState } from './state.js';
import { etParts } from '../engine/time.js';

const ENTRY_TIMEOUT_MS = 10 * 60_000;
const EXIT_REPRICE_MS = 5 * 60_000;

export const mode = () => (process.env.CONDOR_MODE === 'paper' ? 'paper' : 'dry');

function mondayOf(date) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

async function accountState(state) {
  const a = await broker.account();
  const today = etParts(new Date()).date;
  const week = mondayOf(today);
  if (state.week?.start !== week) state.week = { start: week, equity: a.lastEquity || a.equity };
  return { ...a, weekStartEquity: state.week.equity };
}

// Settles pending orders: fills become positions/closes, stale entries are cancelled.
async function reconcile(state, now) {
  for (const p of state.positions) {
    if (p.status === 'opening' && mode() === 'paper') {
      const o = await broker.order(p.orderId);
      if (o.status === 'filled') {
        p.status = 'open';
        p.credit = Math.abs(Number(o.filled_avg_price));
        p.openedAt = o.filled_at;
        state.lastEntryAt = o.filled_at;
        await log({ type: 'entry-filled', id: p.id, credit: p.credit, qty: p.qty });
      } else if (['canceled', 'expired', 'rejected'].includes(o.status) || now - new Date(p.submittedAt) > ENTRY_TIMEOUT_MS) {
        if (!['canceled', 'expired', 'rejected'].includes(o.status)) await broker.cancel(p.orderId).catch(() => {});
        p.status = 'dropped';
        await log({ type: 'entry-cancelled', id: p.id, orderStatus: o.status });
      }
    }
    if (p.status === 'closing' && mode() === 'paper') {
      const o = await broker.order(p.closeOrderId);
      if (o.status === 'filled') {
        settle(state, p, Math.abs(Number(o.filled_avg_price)), o.filled_at);
        await log({ type: 'exit-filled', id: p.id, reason: p.exitReason, debit: p.closeDebit, pnl: p.pnl });
      } else if (['canceled', 'expired', 'rejected'].includes(o.status) || now - new Date(p.closeSubmittedAt) > EXIT_REPRICE_MS) {
        if (!['canceled', 'expired', 'rejected'].includes(o.status)) await broker.cancel(p.closeOrderId).catch(() => {});
        p.status = 'open'; // re-evaluated and re-sent this cycle at a fresh price
        await log({ type: 'exit-repricing', id: p.id, orderStatus: o.status });
      }
    }
  }
  state.positions = state.positions.filter((p) => p.status !== 'dropped' && p.status !== 'closed');
}

function settle(state, p, debit, at) {
  p.status = 'closed';
  p.closeDebit = debit;
  p.closedAt = at;
  p.pnl = (p.credit - debit) * 100 * p.qty;
  state.closed.push(p);
}

export async function cycle({ now = new Date() } = {}) {
  const cfg = loadConfig();
  const state = await loadState();
  const report = { at: now.toISOString(), mode: mode(), actions: [] };
  try {
    const account = await accountState(state);
    await reconcile(state, now);
    const snap = await snapshot(cfg, now);
    report.market = { spx: snap.spot, vix: snap.vix, feed: snap.feed };

    // 1. Manage open positions: first exit rule that triggers closes the whole condor.
    const open = state.positions.filter((p) => p.status === 'open');
    const quotes = open.length ? await quotesFor(open.flatMap((p) => p.legs.map((l) => l.symbol))) : new Map();
    report.positions = [];
    for (const p of open) {
      const cost = closeCost(p, quotes);
      const exit = exitDecision(p, cost, now, cfg);
      report.positions.push({ id: p.id, expiry: p.expiry, strikes: p.strikes, qty: p.qty, credit: p.credit, cost, exit });
      if (!exit || !cost) continue;
      const price = broker.toTick(exit.reason === 'profit' ? cost.mid : cost.natural, 'up');
      p.exitReason = exit.reason;
      if (mode() === 'paper') {
        const o = await broker.submit(broker.mlegBody({ legs: p.legs, qty: p.qty, limitPrice: broker.signedLimit(price, 'debit'), open: false }));
        p.status = 'closing';
        p.closeOrderId = o.id;
        p.closeSubmittedAt = now.toISOString();
      } else {
        settle(state, p, price, now.toISOString());
      }
      report.actions.push({ type: 'exit', id: p.id, reason: exit.reason, detail: exit.detail, debit: price });
      await log({ type: 'exit', mode: mode(), id: p.id, reason: exit.reason, detail: exit.detail, debit: price, cost });
    }
    state.positions = state.positions.filter((p) => p.status !== 'closed');

    // 2. Entry: every rule must pass.
    const condor = buildCondor(snap.chain, cfg);
    const active = state.positions.filter((p) => ['open', 'opening', 'closing'].includes(p.status));
    const decision = entryChecks({
      now, vix: snap.vix, condor, positions: active, lastEntryAt: state.lastEntryAt, account, cfg,
      recentResults: state.closed.map((c) => c.pnl),
    });
    report.entry = { ...decision, condor: condor.error ? { error: condor.error } : summarize(condor) };
    if (decision.ok && !state.positions.some((p) => p.status === 'opening')) {
      const { qty } = contractsFor(account.equity, snap.vix, condor, cfg);
      const credit = broker.toTick(condor.credit, 'down');
      const pos = {
        id: `ic-${now.toISOString().slice(0, 16)}`,
        expiry: condor.expiry,
        strikes: condor.strikes,
        legs: condor.legs.map((l) => ({ symbol: l.symbol, side: l.side, type: l.type, strike: l.strike })),
        qty,
        credit,
        width: condor.width,
        vixAtEntry: snap.vix,
        deltas: condor.deltas,
        submittedAt: now.toISOString(),
      };
      if (mode() === 'paper') {
        const o = await broker.submit(broker.mlegBody({ legs: pos.legs, qty, limitPrice: broker.signedLimit(credit, 'credit'), open: true }));
        pos.status = 'opening';
        pos.orderId = o.id;
      } else {
        pos.status = 'open';
        pos.openedAt = now.toISOString();
        state.lastEntryAt = pos.openedAt;
      }
      state.positions.push(pos);
      report.actions.push({ type: 'entry', id: pos.id, qty, credit, strikes: pos.strikes, expiry: pos.expiry });
      await log({ type: 'entry', mode: mode(), ...pos });
    }
  } catch (e) {
    report.error = e.message;
    await log({ type: 'error', message: e.message });
  }
  await saveState(state);
  report.state = { open: state.positions, closed: state.closed.slice(-50), lastEntryAt: state.lastEntryAt };
  return report;
}

function summarize(c) {
  return {
    expiry: c.expiry,
    dte: Math.round(c.dte * 10) / 10,
    forward: Math.round(c.forward * 100) / 100,
    strikes: c.strikes,
    deltas: c.deltas,
    width: c.width,
    credit: Math.round(c.credit * 100) / 100,
    natural: Math.round(c.natural * 100) / 100,
    maxLossPerContract: Math.round(c.maxLossPerContract),
  };
}

// Read-only view for the dashboard: current entry checks, proposed condor and open positions
// with live marks. Never places orders.
export async function preview({ now = new Date() } = {}) {
  const cfg = loadConfig();
  const state = await loadState();
  const out = { at: now.toISOString(), mode: mode(), config: cfg };
  try {
    const [account, snap] = await Promise.all([accountState(state), snapshot(cfg, now)]);
    out.account = account;
    out.market = { spx: snap.spot, vix: snap.vix, feed: snap.feed };
    const condor = buildCondor(snap.chain, cfg);
    const active = state.positions.filter((p) => ['open', 'opening', 'closing'].includes(p.status));
    out.entry = {
      ...entryChecks({ now, vix: snap.vix, condor, positions: active, lastEntryAt: state.lastEntryAt, account, cfg, recentResults: state.closed.map((c) => c.pnl) }),
      condor: condor.error ? { error: condor.error } : summarize(condor),
      size: condor.error ? null : contractsFor(account.equity, snap.vix, condor, cfg),
    };
    const quotes = active.length ? await quotesFor(active.flatMap((p) => p.legs.map((l) => l.symbol))) : new Map();
    out.positions = active.map((p) => {
      const cost = closeCost(p, quotes);
      return { ...p, cost, exit: exitDecision(p, cost, now, cfg), unrealized: cost ? (p.credit - cost.mid) * 100 * p.qty : null };
    });
  } catch (e) {
    out.error = e.message;
  }
  out.closed = state.closed.slice(-50);
  out.lastEntryAt = state.lastEntryAt;
  return out;
}
