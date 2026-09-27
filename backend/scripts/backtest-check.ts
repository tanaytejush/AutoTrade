import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getCachedCandles } from "../src/data/historical.js";
import { harnessCheckStrategy, runBacktest } from "../src/backtest/engine.js";

const symbol = (process.argv[2] ?? "CIPLA").toUpperCase();
const end = new Date();
const start = new Date(end.getTime() - 2 * 365 * 24 * 60 * 60 * 1000);
const candles = await getCachedCandles(symbol, "5minute", start, end);
if (candles.length === 0) {
  throw new Error(`No cached 5-minute candles for ${symbol}; fetch them before running the harness.`);
}
const result = runBacktest(candles, harnessCheckStrategy);
const outputDirectory = resolve(fileURLToPath(new URL(".", import.meta.url)), "../cache/backtests");
await mkdir(outputDirectory, { recursive: true });
for (const [period, summary] of Object.entries(result)) {
  const header = "entryTimeMs,exitTimeMs,entryPrice,exitPrice,quantity,grossPnl,costs,netPnl,exitReason";
  const rows = summary.trades.map((trade) => [
    trade.entryTimeMs, trade.exitTimeMs, trade.entryPrice, trade.exitPrice,
    trade.quantity, trade.grossPnl, trade.costs, trade.netPnl, trade.exitReason
  ].join(","));
  await writeFile(resolve(outputDirectory, `${symbol}-harness-${period}.csv`), `${header}\n${rows.join("\n")}\n`);
  console.log(`${period}:`, {
    strategy: "harness check, not a real strategy",
    totalTrades: summary.totalTrades,
    winRatePercent: summary.winRatePercent,
    averageWin: summary.averageWin,
    averageLoss: summary.averageLoss,
    totalPnlAfterCosts: summary.totalPnl,
    totalCosts: summary.totalCosts,
    maxDrawdown: summary.maxDrawdown,
    worstDay: summary.worstDay
  });
}
console.log(`Trade CSVs: backend/cache/backtests/${symbol}-harness-{train,test}.csv`);
