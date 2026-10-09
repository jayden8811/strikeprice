// Alpaca paper-trading account: account state and multi-leg (mleg) option orders.
// Only the paper endpoint is used; this module cannot reach a live account.
import { alpacaHeaders } from './market.js';

const PAPER = 'https://paper-api.alpaca.markets';

async function call(method, path, body) {
  const res = await fetch(`${PAPER}${path}`, {
    method,
    headers: { ...alpacaHeaders(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`Alpaca ${res.status}: ${json?.message ?? text}`);
  return json;
}

export async function account() {
  const a = await call('GET', '/v2/account');
  return { equity: Number(a.equity), lastEquity: Number(a.last_equity), optionsLevel: a.options_trading_level, status: a.status };
}

export const positions = () => call('GET', '/v2/positions');
export const order = (id) => call('GET', `/v2/orders/${id}`);
export const cancel = (id) => call('DELETE', `/v2/orders/${id}`);

// Complex orders on SPX trade in $0.05 increments.
export const toTick = (x, dir) => (dir === 'down' ? Math.floor(x * 20 + 1e-9) : Math.ceil(x * 20 - 1e-9)) / 20;

// Signed limit price for a net amount. Alpaca takes credits as negative limit prices and
// debits as positive: verified on the paper account on 2026-10-09 with an unfillable
// condor (npm run condor -- --verify-sign), which Alpaca accepted at -47.50.
export function signedLimit(amount, kind) {
  return (kind === 'credit' ? -amount : amount).toFixed(2);
}

export function mlegBody({ legs, qty, limitPrice, open }) {
  return {
    order_class: 'mleg',
    type: 'limit',
    time_in_force: 'day',
    qty: String(qty),
    limit_price: limitPrice,
    legs: legs.map((l) => {
      const side = open ? l.side : l.side === 'sell' ? 'buy' : 'sell';
      return {
        symbol: l.symbol,
        ratio_qty: '1',
        side,
        position_intent: `${side}_to_${open ? 'open' : 'close'}`,
      };
    }),
  };
}

export const submit = (body) => call('POST', '/v2/orders', body);
