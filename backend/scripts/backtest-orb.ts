import "dotenv/config";
import { getCachedCandles } from "../src/data/historical.js";
import { runOrbBacktest } from "../src/strategy/orb.js";

const symbols = ["CIPLA", "HINDUNILVR", "ICICIBANK", "NESTLEIND", "RELIANCE", "SBILIFE", "SUNPHARMA", "TATACONSUM"];
const cutoff = new Date("2026-01-26T00:00:00+05:30");
const end = cutoff;
const start = new Date(end.getTime() - 2 * 365 * 24 * 60 * 60 * 1000);
let peakMemoryMb = process.memoryUsage().rss / 1024 / 1024;
console.log(`memory start MB: ${peakMemoryMb.toFixed(1)}`);
const data = new Map<string, Awaited<ReturnType<typeof getCachedCandles>>>();
for (const symbol of symbols) {
  data.set(symbol, await getCachedCandles(symbol, "5minute", start, end));
}
peakMemoryMb = Math.max(peakMemoryMb, process.memoryUsage().rss / 1024 / 1024);
console.log(`memory middle MB: ${peakMemoryMb.toFixed(1)}`);
const result = runOrbBacktest(data, Number.POSITIVE_INFINITY);
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
function weekday(timeMs: number): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kolkata", weekday: "long" }).format(new Date(timeMs));
}
function breakdown(summary: typeof result.totalTrain): void {
  const longTrades = summary.trades.filter((trade) => trade.side === "long");
  const shortTrades = summary.trades.filter((trade) => trade.side === "short");
  console.log("long vs short:", {
    long: { trades: longTrades.length, pnlBeforeCosts: longTrades.reduce((s, t) => s + t.grossPnl, 0), pnlAfterCosts: longTrades.reduce((s, t) => s + t.netPnl, 0) },
    short: { trades: shortTrades.length, pnlBeforeCosts: shortTrades.reduce((s, t) => s + t.grossPnl, 0), pnlAfterCosts: shortTrades.reduce((s, t) => s + t.netPnl, 0) }
  });
  console.log("exit breakdown:", Object.fromEntries(["stop-loss", "target", "forced-exit"].map((reason) => {
    const trades = summary.trades.filter((trade) => trade.exitReason === reason);
    return [reason, { trades: trades.length, pnlBeforeCosts: trades.reduce((s, t) => s + t.grossPnl, 0), pnlAfterCosts: trades.reduce((s, t) => s + t.netPnl, 0) }];
  })));
  const byWeekday = new Map<string, number>();
  for (const trade of summary.trades) byWeekday.set(weekday(trade.exitTimeMs), (byWeekday.get(weekday(trade.exitTimeMs)) ?? 0) + trade.netPnl);
  console.log("P&L by weekday:", Object.fromEntries(byWeekday));
}
console.log(`ORB train-only after-cost result: ${result.totalTrain.pnlAfterCosts < 0 ? "loses money" : "is profitable"}.`);
for (const symbol of symbols) {
  print(`${symbol} train`, result.train.get(symbol)!);
}
print("TOTAL train", result.totalTrain);
breakdown(result.totalTrain);
console.log("days with more than 2 competing signals:", result.competingSignalDays);
