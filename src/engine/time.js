// US equity market clock (America/New_York).

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  weekday: 'short',
  hourCycle: 'h23',
});

export function etParts(date) {
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
    weekday: p.weekday,
  };
}

export function etDate(date) {
  return etParts(date).date;
}

// Regular session only; holidays are not modeled.
export function marketSession(now = new Date()) {
  const { minutes, weekday } = etParts(now);
  if (weekday === 'Sat' || weekday === 'Sun') return 'closed';
  if (minutes < 9 * 60 + 30) return minutes >= 4 * 60 ? 'pre' : 'closed';
  if (minutes < 16 * 60) return 'open';
  return minutes < 20 * 60 ? 'post' : 'closed';
}

// Days until an expiration (YYYY-MM-DD), using the 4pm ET close.
export function daysToExpiry(expiry, now = new Date()) {
  const close = new Date(`${expiry}T20:00:00Z`); // 4pm EDT; 1h off in EST is negligible here
  return (close - now) / 86_400_000;
}
