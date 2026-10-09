// Iron condor rules. Every number here is a hard rule the bot follows mechanically.
// Environment variables override the defaults (CONDOR_<NAME>, e.g. CONDOR_WING_WIDTH=25).

const num = (name, dflt) => {
  const v = process.env[`CONDOR_${name}`];
  return v != null && v !== '' ? Number(v) : dflt;
};
const list = (name, dflt) => {
  const v = process.env[`CONDOR_${name}`];
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : dflt;
};

export function loadConfig() {
  return {
    underlying: 'SPX',

    // Entry
    minDte: num('MIN_DTE', 30),
    maxDte: num('MAX_DTE', 45),
    targetDelta: num('TARGET_DELTA', 0.16),
    minDelta: num('MIN_DELTA', 0.14),
    maxDelta: num('MAX_DELTA', 0.18),
    wingWidth: num('WING_WIDTH', 50), // points; 25–50
    minCreditFraction: num('MIN_CREDIT_FRACTION', 1 / 3), // of wing width
    vixMin: num('VIX_MIN', 15),
    vixMax: num('VIX_MAX', 22),
    minDaysBetweenEntries: num('MIN_DAYS_BETWEEN_ENTRIES', 7),
    maxOpen: num('MAX_OPEN', 3), // 2–4
    eventDays: list('EVENT_DAYS', []), // YYYY-MM-DD; no new entries on these days (e.g. FOMC, CPI)
    maxSpreadFraction: num('MAX_SPREAD_FRACTION', 0.3), // sum of leg bid-ask widths ÷ mid credit
    entryWindow: [num('ENTRY_START_MIN', 9 * 60 + 45), num('ENTRY_END_MIN', 15 * 60 + 30)], // ET minutes

    // Sizing
    riskPct: num('RISK_PCT', 0.02), // of equity, on max loss
    riskPctHighVix: num('RISK_PCT_HIGH_VIX', 0.01),
    highVix: num('HIGH_VIX', 20), // at or above this (but within vixMax), use riskPctHighVix

    // Exits (first that triggers closes all four legs together)
    profitTarget: num('PROFIT_TARGET', 0.5), // close when cost to close ≤ 50% of credit
    stopMultiple: num('STOP_MULTIPLE', 2), // close when cost to close ≥ 200% of credit
    exitDte: num('EXIT_DTE', 21), // close at or below 21 DTE

    // Account-level overrides
    dailyLossLimit: num('DAILY_LOSS_LIMIT', 0.03), // stop new entries if equity is down 3% today
    weeklyLossLimit: num('WEEKLY_LOSS_LIMIT', 0.05),
    pauseAfterLosses: num('PAUSE_AFTER_LOSSES', 0), // 0 = off; else pause entries after N losses in a row

    // Pricing
    rate: num('RATE', 0.04), // discount rate for Black-76; the forward comes from put-call parity
  };
}
