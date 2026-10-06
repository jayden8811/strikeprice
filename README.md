# strikeprice

Type a ticker and get two answers, refreshed every 15 seconds:

1. **Is it good to buy calls or puts on this ticker right now?**
2. **If yes, what's the setup** (contract, entry, target, stop, reward:risk). **If no, which levels to watch.**

The project has no dependencies.

## Run

```bash
ALPACA_KEY_ID=... ALPACA_SECRET_KEY=... npm start   # free real-time → http://localhost:3000
TRADIER_TOKEN=your_token npm start                  # real-time via a Tradier brokerage account
npm start                                           # free fallback (options ~15 min delayed)
npm run demo                         # synthetic data, works offline / after hours
npm test
```

You can also add `?demo=1` to the URL to use demo data for a single page.

## Data sources

**Free real-time (Alpaca):** sign up for an Alpaca paper-trading account (email only), generate an API key, and set `ALPACA_KEY_ID` and `ALPACA_SECRET_KEY`. You get real-time stock prices from the IEX exchange and Alpaca's real-time *indicative* option quotes with IV and Greeks. Indicative prices approximate the official OPRA feed and can differ from it. Daily history uses the full consolidated tape, and open interest comes from Alpaca's contracts endpoint (updated daily). VIX/VIX3M still come from Yahoo. With a paid Alpaca plan, set `ALPACA_FEED=sip` and `ALPACA_OPTIONS_FEED=opra` for the full feeds. Network hosts used: `data.alpaca.markets`, `paper-api.alpaca.markets`. If a proxy injects the `APCA-API-KEY-ID` / `APCA-API-SECRET-KEY` headers for you, set `DATA_PROVIDER=alpaca` instead of the key variables.

**Option chain from Massive:** when `MASSIVE_API_KEY` is set, the option chain (bid/ask, IV, Greeks, open interest, volume) comes from Massive's option chain snapshot (`api.massive.com`). That's official OPRA data, real-time on the Options Advanced plan. Stock prices still come from Alpaca/Tradier/Yahoo.

**Real-time via Tradier:** set `TRADIER_TOKEN` to a Tradier brokerage API token. Real-time market data is included with a Tradier brokerage account at no extra cost; check Tradier's current terms. The app then gets real-time quotes, 1-minute bars, daily history, VIX/VIX3M and full option chains with Greeks (IV, delta, gamma) from Tradier. A free developer sandbox token also works with `TRADIER_SANDBOX=1`, but its data is delayed.

**Free fallback (no token):**

| Data | Source | Notes |
|---|---|---|
| Price bars, SPY, VIX, VIX3M | Yahoo Finance chart API | near real time for most US stocks |
| Option chain (IV, Greeks, OI, volume, bid/ask) | Cboe delayed quotes | ~15 min delayed |

**Always:**

| Data | Source | Notes |
|---|---|---|
| Earnings date | Yahoo quoteSummary | best effort; shown as "Unknown" if unavailable |
| Options flow | **your feed** (see below) | without a feed, unusual volume vs. open interest from the chain is used as a weak proxy |

The Yahoo and Cboe endpoints are unofficial. They can change or rate-limit without notice. The line under the headline shows which source answered each refresh.

## Connecting your real-time options flow

**Massive (formerly Polygon.io):** set `MASSIVE_API_KEY`. The server opens Massive's real-time options WebSocket (`wss://socket.massive.com/options`, override with `MASSIVE_WS_URL`), subscribes to every options trade (`T.*`), and keeps prints of $25K+ premium (`MASSIVE_MIN_PREMIUM`). It groups trades in the same contract that hit several exchanges within 250 ms into one sweep. Massive trades don't say who was the aggressor, so each print is labeled bought (at/near the ask), sold (at/near the bid) or mid against the live chain. Prints older than 2 minutes use the tick rule recorded when they arrived. This needs a Massive plan with real-time options trades on WebSocket.

Any other feed can connect in either of two ways:

- **Push:** `POST /api/flow` with a print or an array of prints. If `FLOW_TOKEN` is set, send `Authorization: Bearer <FLOW_TOKEN>`.
- **Pull:** set `FLOW_FEED_URL` and the server polls it every 5 seconds. It expects a JSON array, or `{ data: [...] }` / `{ prints: [...] }`.

Each print, with common alternate field names accepted:

```json
{
  "ticker": "NVDA",            // or symbol / underlying
  "time": "2026-10-06T15:31:02Z",
  "type": "call",              // or put_call / option_type: "C" | "P"
  "strike": 190,
  "expiry": "2026-10-17",      // or expiration
  "side": "ask",               // ask | bid | mid  (or aggressor: buy | sell)
  "size": 1200,                // or quantity
  "price": 2.15,
  "premium": 258000,           // optional; size*price*100 if omitted
  "sweep": true                // or is_sweep
}
```

Once any print arrives, flow becomes the heaviest-weighted directional signal.

## How the answer is decided (buying options only)

**Conditions** (`src/engine/analyze.js`):
- **Liquidity:** the median bid/ask spread on near-the-money 5–45 DTE contracts. Over 10% blocks the trade.
- **Option pricing:** ATM ~30-day IV compared with forecast realized volatility (a 10/20/60-day blend). IV more than 1.3× forecast blocks the trade.
- **Events:** earnings within 2 days blocks the trade because of IV crush. The chosen expiration also avoids an upcoming earnings date when possible.
- **Dealer gamma:** net GEX and the gamma flip level. Negative gamma, which tends to amplify moves, counts in a buyer's favor.
- **Market regime:** SPY vs. its 20-day average and its VWAP, plus the VIX/VIX3M ratio.
- **Direction:** a vote across options flow, price vs. VWAP, opening-range break, daily trend and SPY.
- **Trigger:** price must already be through both VWAP and the opening range in the bias direction.

**Setup:**
- **Contract:** a ~0.50 delta call or put, 7–45 DTE (aiming for ~21), with a spread of 10% or less.
- **Stop:** the underlying moving back through the trigger level, plus a small ATR buffer.
- **Target:** the next key level (prior-day high/low, call or put wall, gamma flip), or one daily expected move if none is close.
- **Reward:risk:** the option's value at the target and stop is estimated with delta and gamma. Below 1.5:1, the app says "wait" instead of giving a setup.

## Layout

```
server.js               HTTP server + API
src/data/               massive.js, alpaca.js, tradier.js, yahoo.js, cboe.js, flowStore.js, demo.js, load.js
src/engine/             analyze.js (decision), levels, volatility, gex, flow, math, time
public/                 homepage (index.html, styles.css, app.js)
test/                   node:test suite
```

This is an educational tool, not financial advice.
