import { atr, sma, vwap } from './math.js';
import { etDate } from './time.js';

const OPENING_RANGE_MIN = 30;

// Price levels a buyer uses for triggers, stops and targets.
export function computeLevels({ daily, intraday, price, now }) {
  const today = etDate(now);
  // Yahoo includes today's partial bar in daily data during the session.
  const completed = daily.filter((b) => etDate(new Date(b.t)) < today);
  const prior = completed.at(-1);
  const closes = completed.map((b) => b.c);

  const session = intraday.filter((b) => etDate(new Date(b.t)) === today);
  const or = session.slice(0, OPENING_RANGE_MIN);
  const hasOR = or.length >= OPENING_RANGE_MIN;

  return {
    price,
    priorHigh: prior?.h ?? null,
    priorLow: prior?.l ?? null,
    priorClose: prior?.c ?? null,
    vwap: session.length ? vwap(session) : null,
    orHigh: hasOR ? Math.max(...or.map((b) => b.h)) : null,
    orLow: hasOR ? Math.min(...or.map((b) => b.l)) : null,
    dayHigh: session.length ? Math.max(...session.map((b) => b.h)) : null,
    dayLow: session.length ? Math.min(...session.map((b) => b.l)) : null,
    atr: atr(completed, 14),
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    closes,
  };
}
