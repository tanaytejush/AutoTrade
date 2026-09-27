import "dotenv/config";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWriteStream } from "node:fs";
import { getCachedCandles } from "../src/data/historical.js";
import { harnessCheckStrategy, runBacktest } from "../src/backtest/engine.js";

const symbol = (process.argv[2] ?? "CIPLA").toUpperCase();
const end = new Date();
const start = new Date(end.getTime() - 2 * 365 * 24 * 60 * 60 * 1000);
const candles = await getCachedCandles(symbol, "5minute", start, end);
if (candles.length === 0) {
  throw new Error(`No cached 5-minute candles for ${symbol}; fetch them before running the harness.`);
}
const outputDirectory = resolve(fileURLToPath(new URL(".", import.meta.url)), "../cache/backtests");
await mkdir(outputDirectory, { recursive: true });
const streams = {
  train: createWriteStream(resolve(outputDirectory, `${symbol}-harness-train.csv`)),
  test: createWriteStream(resolve(outputDirectory, `${symbol}-harness-test.csv`))
};
const header = "entryTimeMs,exitTimeMs,entryPrice,exitPrice,quantity,grossPnl,costs,netPnl,exitReason\n";
streams.train.write(header);
streams.test.write(header);
console.log("memory start MB:", (process.memoryUsage().rss / 1024 / 1024).toFixed(1));
const result = runBacktest(candles, harnessCheckStrategy, {
  onProgress() {
    console.log("memory middle MB:", (process.memoryUsage().rss / 1024 / 1024).toFixed(1));
  },
  onTrade(trade, period) {
    streams[period].write([
    trade.entryTimeMs, trade.exitTimeMs, trade.entryPrice, trade.exitPrice,
    trade.quantity, trade.grossPnl, trade.costs, trade.netPnl, trade.exitReason
    ].join(",") + "\n");
  }
});
for (const stream of Object.values(streams)) stream.end();
await Promise.all(Object.values(streams).map((stream) => new Promise<void>((resolveStream, reject) => {
  stream.once("finish", resolveStream);
  stream.once("error", reject);
})));
for (const [period, summary] of Object.entries(result)) {
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
console.log("memory end MB:", (process.memoryUsage().rss / 1024 / 1024).toFixed(1));
console.log(`Trade CSVs: backend/cache/backtests/${symbol}-harness-{train,test}.csv`);
