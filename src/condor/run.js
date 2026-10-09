// CLI: npm run condor -- [--once | --loop MINUTES | --verify-sign]
import * as broker from './broker.js';
import { loadConfig } from './config.js';
import { snapshot } from './market.js';
import { buildCondor } from './rules.js';
import { cycle, mode } from './bot.js';
import { log } from './state.js';
import { marketSession } from '../engine/time.js';

const args = process.argv.slice(2);

// Places one iron condor on the paper account at a credit of 95% of the wing width, a price
// no market will pay, so it cannot fill. If Alpaca accepts a negative limit for it, credits
// are negative. The order is cancelled right away. Never sends a positive price, because
// under the other convention a large positive price is a debit and would fill.
async function verifySign() {
  const cfg = loadConfig();
  const snap = await snapshot(cfg);
  const condor = buildCondor(snap.chain, cfg);
  if (condor.error) throw new Error(condor.error);
  const unfillable = (condor.width * 0.95).toFixed(2);
  const body = broker.mlegBody({ legs: condor.legs, qty: 1, limitPrice: `-${unfillable}`, open: true });
  let o;
  try {
    o = await broker.submit(body);
  } catch (e) {
    console.log(`Negative limit rejected: ${e.message}`);
    console.log('Credits may use positive prices. Update signedLimit() in broker.js only after confirming with Alpaca.');
    await log({ type: 'verify-sign', result: 'negative-rejected', message: e.message });
    return;
  }
  const back = await broker.order(o.id);
  await broker.cancel(o.id).catch(() => {});
  const after = await broker.order(o.id);
  console.log(`Accepted: status ${back.status}, limit_price ${back.limit_price}; after cancel: ${after.status}.`);
  console.log('Credits are negative, which is what broker.js uses.');
  await log({ type: 'verify-sign', result: 'negative-accepted', orderId: o.id, limit: back.limit_price, finalStatus: after.status });
}

async function once() {
  const r = await cycle();
  console.log(JSON.stringify({ at: r.at, mode: r.mode, market: r.market, actions: r.actions, entry: r.entry && { ok: r.entry.ok, failed: r.entry.checks.filter((c) => !c.pass).map((c) => `${c.label}: ${c.detail}`) }, error: r.error }, null, 1));
}

if (args.includes('--verify-sign')) {
  await verifySign();
} else if (args.includes('--loop')) {
  const minutes = Number(args[args.indexOf('--loop') + 1] ?? 2);
  console.log(`Condor bot (${mode()} mode), checking every ${minutes} min during market hours.`);
  const tick = async () => {
    if (marketSession() === 'open') await once().catch((e) => console.error(e.message));
  };
  await tick();
  setInterval(tick, minutes * 60_000);
} else {
  await once();
}
