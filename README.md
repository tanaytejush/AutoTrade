# AutoTrade

Small monorepo skeleton for a trading bot. The backend uses **Node.js, Express, and TypeScript** because the frontend already uses TypeScript, so the initial project has one language and a small shared toolchain. No broker, database, authentication, strategy, or order code is included.

## Setup

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env` and adjust local values. Keep real credentials out of source control.
3. Install dependencies from the repository root:

   ```bash
   npm install
   ```

4. Start the backend in one terminal:

   ```bash
   npm run dev:backend
   ```

5. Start the frontend in another terminal:

   ```bash
   npm run dev:frontend
   ```

Open <http://localhost:5173>. The page polls `GET http://localhost:3001/health` every five seconds and displays whether the backend is reachable.

The backend reads `PAPER_TRADING` once at startup and refuses to start unless it is explicitly `true` or `false`. Set it to `true` for the health response to report `paperTrading: true`. Future order-related functions must call the centralized `assertPaperMode()` guard; this project currently has no order placement.

## Read-only broker modules

`backend/broker/india.ts` targets INDmoney/INDstocks and is the active India-only adapter. Credentials are read only from environment variables. Generate the INDmoney token through the API trading flow at <https://indstocks.com/app/api-trading>, then set `INDMONEY_ACCESS_TOKEN` in `backend/.env`. Keep `INDMONEY_BASE_URL` aligned with the endpoint documented for your INDstocks account.

The manual account check is disabled unless explicitly enabled:

```bash
RUN_REAL_BROKER_TESTS=true npm run manual:brokers --workspace backend
```

It calls only INDmoney quote, positions, and funds endpoints. The margin result includes the raw funds response and maps `eq_cnc` to delivery cash, `eq_mis` to intraday availability, and `option_buy` to F&O availability. It never places, modifies, or cancels orders. Never put credentials in source files or command history; use `backend/.env`. The real-account flag is opt-in.

TODO: Holdings and positions row parsing is unverified against a real non-empty response. Must verify before enabling live orders (Step K).
TODO: Backtester (Step F) must use filterCandlesForBacktest().
Orchestrator (Step G) must use isNormalTradingDay().
