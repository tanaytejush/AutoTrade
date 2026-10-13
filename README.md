# AutoTrade

AutoTrade is a TypeScript monorepo for researching and testing an India-focused trading workflow. It includes:

- A Vite + React frontend with backend health monitoring
- An Express + TypeScript backend
- Read-only INDmoney/INDstocks broker integration
- Historical data utilities, an opening-range breakout strategy, risk/cost calculations, and backtesting
- Paper-trading safeguards and fixture-based tests

> **Safety:** This project is for research and paper trading. It is not financial advice. The broker adapter currently does not place, modify, or cancel orders. Review and test any future execution changes independently before using real funds.

## Requirements

- Node.js 20 or newer
- npm

## Local setup

1. Install dependencies from the repository root:

   ```bash
   npm install
   ```

2. Create the local backend configuration:

   ```bash
   Copy-Item .env.example backend/.env
   ```

   Edit `backend/.env` for local values. Keep real broker credentials in that file only; it is ignored by Git.

3. Start the backend:

   ```bash
   npm run dev:backend
   ```

4. Start the frontend in a second terminal:

   ```bash
   npm run dev:frontend
   ```

Open <http://localhost:5173>. The frontend polls `GET http://localhost:3001/health` every five seconds.

The backend requires `PAPER_TRADING` to be explicitly `true` or `false`. Use `true` during development. The centralized paper-mode guard must remain in place before any future order functionality is added.

## Useful commands

```bash
npm run build
npm test --workspace backend
npm run analyze --workspace backend
npm run backtest:orb --workspace backend
```

The test suite uses local fixtures and does not require broker credentials. The optional manual broker check is read-only and must be explicitly enabled:

```bash
RUN_REAL_BROKER_TESTS=true npm run manual:brokers --workspace backend
```

## Project layout

| Path | Purpose |
| --- | --- |
| `frontend/` | Vite + React client |
| `backend/src/` | Application, strategy, risk, data, and backtest code |
| `backend/broker/` | Read-only broker adapter and fixtures |
| `backend/scripts/` | Development and analysis commands |
| `shared/` | Shared workspace package |
| `docs/` | Broker/API notes |

## Configuration and security

Copy `.env.example` rather than committing secrets. The repository ignores `.env` files, local databases, caches, logs, dependencies, and build output. Never paste broker tokens into source files, commits, issues, or shell history. If a credential is exposed, revoke it immediately and issue a replacement.

## License

No license has been selected yet. Until one is added, all rights are reserved by the copyright holder.

---

`@tanaytejush`
