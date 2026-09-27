import { getCachedCandles, filterCandlesForBacktest, type Candle } from "../data/historical.js";
import { isNormalTradingDay } from "../data/nse-holidays.js";
import { ANALYZER_THRESHOLDS as thresholds } from "./thresholds.js";

export interface AnalysisResult {
  symbol: string;
  metrics: {
    returns: Record<"1Week" | "1Month" | "3Months" | "1Year", number | null>;
    averageDailyRangePercent20: number;
    averageDailyRangePercent60: number;
    dailyReturnStandardDeviationPercent: number;
    averageDailyVolume20: number;
    averageDailyTradedValueRupees20: number;
    closeVsMovingAverage20Percent: number;
    closeVsMovingAverage50Percent: number;
    gapRiskPercent: number;
    maxDrawdownPercent: number;
    costFit: "not checked yet";
  };
  verdict: "TRADEABLE" | "WATCH" | "AVOID";
  reasons: string[];
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: number[]): number {
  if (values.length === 0) return 0;
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

function asOf(candles: Candle[], days: number): Candle[] {
  return candles.slice(Math.max(0, candles.length - days));
}

function istDate(candle: Candle): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(candle.timeMs));
}

function targetDate(date: string, days: number, months: number, years: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  value.setUTCMonth(value.getUTCMonth() - months);
  value.setUTCFullYear(value.getUTCFullYear() - years);
  return value.toISOString().slice(0, 10);
}

function returnFor(candles: Candle[], days: number, months = 0, years = 0): number | null {
  if (candles.length < 2) return null;
  const current = candles.at(-1)!;
  const target = targetDate(istDate(current), days, months, years);
  const prior = [...candles].reverse().find((candle) => istDate(candle) <= target);
  if (!prior) return null;
  return ((current.close / prior.close) - 1) * 100;
}

function movingAverage(candles: Candle[], days: number): number {
  return mean(asOf(candles, days).map((candle) => candle.close));
}

function calculateMaxDrawdown(candles: Candle[]): number {
  let peak = 0;
  let maximum = 0;
  for (const candle of candles) {
    peak = Math.max(peak, candle.close);
    maximum = Math.max(maximum, peak === 0 ? 0 : ((peak - candle.close) / peak) * 100);
  }
  return maximum;
}

export function analyzeCandles(symbol: string, sourceCandles: Candle[]): AnalysisResult {
  const candles = filterCandlesForBacktest(sourceCandles)
    .filter((candle) => isNormalTradingDay(new Date(candle.timeMs)))
    .sort((a, b) => a.timeMs - b.timeMs);
  const recent20 = asOf(candles, 20);
  const recent60 = asOf(candles, 60);
  const returns = candles.slice(1).map((candle, index) => (candle.close / candles[index].close - 1) * 100);
  const gapDays = candles.slice(1).filter((candle, index) =>
    Math.abs((candle.open / candles[index].close - 1) * 100) > 1
  ).length;
  const last = candles.at(-1);
  const reasons: string[] = [];
  if (candles.length < thresholds.minimumHistoryDays) reasons.push("Not enough history");
  if (mean(recent20.map((candle) => candle.volume * candle.close)) < thresholds.minimumAverageTradedValueRupees) {
    reasons.push("Average daily traded value below ₹50 crore");
  }
  if (candles.length > 1 && (gapDays / (candles.length - 1)) * 100 > thresholds.maximumGapRiskPercent) {
    reasons.push("Gap risk is elevated");
  }
  const averageRange20 = mean(recent20.map((candle) => ((candle.high - candle.low) / candle.close) * 100));
  if (averageRange20 < thresholds.minimumAverageDailyRangePercent) {
    reasons.push("Average daily range may be too small to cover costs");
  } else if (averageRange20 > thresholds.maximumVolatilityPercent) {
    reasons.push("Average daily range volatility is elevated");
  }
  const verdict = candles.length < thresholds.minimumHistoryDays
    ? "AVOID"
    : reasons.includes("Average daily traded value below ₹50 crore")
      ? "AVOID"
      : reasons.length === 0 ? "TRADEABLE" : "WATCH";
  return {
    symbol,
    metrics: {
      returns: {
        "1Week": returnFor(candles, 7),
        "1Month": returnFor(candles, 0, 1),
        "3Months": returnFor(candles, 0, 3),
        "1Year": returnFor(candles, 0, 0, 1)
      },
      averageDailyRangePercent20: mean(recent20.map((candle) => ((candle.high - candle.low) / candle.close) * 100)),
      averageDailyRangePercent60: mean(recent60.map((candle) => ((candle.high - candle.low) / candle.close) * 100)),
      dailyReturnStandardDeviationPercent: standardDeviation(returns),
      averageDailyVolume20: mean(recent20.map((candle) => candle.volume)),
      averageDailyTradedValueRupees20: mean(recent20.map((candle) => candle.volume * candle.close)),
      closeVsMovingAverage20Percent: last ? ((last.close / movingAverage(candles, 20)) - 1) * 100 : 0,
      closeVsMovingAverage50Percent: last ? ((last.close / movingAverage(candles, 50)) - 1) * 100 : 0,
      gapRiskPercent: candles.length > 1 ? (gapDays / (candles.length - 1)) * 100 : 0,
      maxDrawdownPercent: calculateMaxDrawdown(candles),
      costFit: "not checked yet"
    },
    verdict,
    reasons
  };
}

export async function analyzeSymbol(symbol: string, options: { databasePath?: string } = {}): Promise<AnalysisResult> {
  const end = new Date();
  const start = new Date(end.getTime() - 366 * 24 * 60 * 60 * 1000);
  const candles = await getCachedCandles(symbol, "1day", start, end, options);
  if (candles.length === 0) {
    throw new Error(`${symbol} daily data is not cached; real historical calls require authorization.`);
  }
  return analyzeCandles(symbol, candles);
}
