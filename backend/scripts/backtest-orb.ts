import "dotenv/config";
import { getCachedCandles } from "../src/data/historical.js";
import { runOrbBacktest } from "../src/strategy/orb.js";

const symbols = ["CIPLA", "HINDUNILVR", "ICICIBANK", "NESTLEIND", "RELIANCE", "SBILIFE", "SUNPHARMA", "TATACONSUM"];
const end = new Date("2026-09-26T00:00:00+05:30");
const start = new Date(end.getTime() - 2 * 365 * 24 * 60 * 60 * 1000);
let peakMemoryMb = process.memoryUsage().rss / 1024 / 1024;
console.log(`memory start MB: ${peakMemoryMb.toFixed(1)}`);
const data = new Map<string, Awaited<ReturnType<typeof getCachedCandles>>>();
for (const symbol of symbols) {
  data.set(symbol, await getCachedCandles(symbol, "5minute", start, end));
}
peakMemoryMb = Math.max(peakMemoryMb, process.memoryUsage().rss / 1024 / 1024);
console.log(`memory middle MB: ${peakMemoryMb.toFixed(1)}`);
const cutoff = new Date("2026-01-26T00:00:00+05:30").getTime();
const result = runOrbBacktest(data, cutoff);
peakMemoryMb = Math.max(peakMemoryMb, process.memoryUsage().rss / 1024 / 1024);
console.log(`memory end MB: ${peakMemoryMb.toFixed(1)}`);
function print(label: string, summary: typeof result.totalTrain): void {
  console.log(label, {
    trades: summary.trades.length,
    tradesPerMonth: summary.tradesPerMonth.toFixed(2),
    winRate: `${summary.winRatePercent.toFixed(2)}%`,
    averageWin: summary.averageWin.toFixed(2),
    averageLoss: summary.averageLoss.toFixed(2),
    pnlBeforeCosts: summary.pnlBeforeCosts.toFixed(2),
    pnlAfterCosts: summary.pnlAfterCosts.toFixed(2),
    totalCosts: summary.totalCosts.toFixed(2),
    averageProfitPerTrade: summary.averageProfitPerTrade.toFixed(2),
    maxDrawdown: summary.maxDrawdown.toFixed(2),
    worstDay: summary.worstDay.toFixed(2),
    skipped: summary.skipped
    ,peakMemoryMb: peakMemoryMb.toFixed(1)
  });
}
const trainLoses = result.totalTrain.pnlAfterCosts < 0;
const testLoses = result.totalTest.pnlAfterCosts < 0;
console.log(`ORB after-cost result: train ${trainLoses ? "loses money" : "is profitable"}, test ${testLoses ? "loses money" : "is profitable"}.`);
for (const symbol of symbols) {
  print(`${symbol} train`, result.train.get(symbol)!);
  print(`${symbol} test`, result.test.get(symbol)!);
}
print("TOTAL train", result.totalTrain);
print("TOTAL test", result.totalTest);
