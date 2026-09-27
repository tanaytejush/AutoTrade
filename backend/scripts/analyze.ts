import "dotenv/config";
import { analyzeSymbol } from "../src/analysis/analyzer.js";
import { ANALYZER_THRESHOLDS } from "../src/analysis/thresholds.js";

const symbol = process.argv[2];
if (!symbol) throw new Error("Usage: npm run analyze --workspace backend -- RELIANCE");

const result = await analyzeSymbol(symbol.toUpperCase());
function inr(value: number): string {
  if (value >= 1_00_00_000) return `₹${(value / 1_00_00_000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} Cr`;
  return `₹${(value / 1_00_000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} L`;
}
console.table({
  "1 week return %": result.metrics.returns["1Week"],
  "1 month return %": result.metrics.returns["1Month"],
  "3 month return %": result.metrics.returns["3Months"],
  "1 year return %": result.metrics.returns["1Year"],
  "range % (20d)": result.metrics.averageDailyRangePercent20,
  "range % (60d)": result.metrics.averageDailyRangePercent60,
  "return std dev %": result.metrics.dailyReturnStandardDeviationPercent,
  "avg volume (20d)": result.metrics.averageDailyVolume20,
  "avg traded value (20d)": inr(result.metrics.averageDailyTradedValueRupees20),
  "close vs MA20 %": result.metrics.closeVsMovingAverage20Percent,
  "close vs MA50 %": result.metrics.closeVsMovingAverage50Percent,
  "gap risk": `${result.metrics.gapDays} of ${result.metrics.gapObservationDays} (${result.metrics.gapRiskPercent.toFixed(1)}%)`,
  "max drawdown % (1y)": result.metrics.maxDrawdownPercent,
  "cost fit": result.metrics.costFit
});
console.log(`Verdict: ${result.verdict}`);
console.log(`Reasons: ${result.reasons.length > 0 ? result.reasons.join("; ") : "None"}`);
console.log("Thresholds:", {
  minimumHistoryDays: ANALYZER_THRESHOLDS.minimumHistoryDays,
  minimumAverageTradedValue: inr(ANALYZER_THRESHOLDS.minimumAverageTradedValueRupees),
  minimumAverageDailyRangePercent: ANALYZER_THRESHOLDS.minimumAverageDailyRangePercent,
  maximumAverageDailyRangePercent: ANALYZER_THRESHOLDS.maximumVolatilityPercent,
  maximumGapRiskPercent: ANALYZER_THRESHOLDS.maximumGapRiskPercent
});
