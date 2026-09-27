import { MAX_TRADING_CAPITAL } from "../../config.js";
import { filterCandlesForBacktest, type Candle } from "../data/historical.js";
import { isNormalTradingDay } from "../data/nse-holidays.js";
import { breakEvenMovePct, roundTripCost } from "../risk/costs.js";
import { ORB_CONFIG } from "./orb-config.js";

export type OrbSide = "long" | "short";
export type OrbSkipReason = "range-too-wide" | "range-too-narrow" | "cost-check" | "risk-cap" | "daily-limit";

export interface OpeningRange {
  high: number;
  low: number;
  referencePrice: number;
}

export interface OrbSignal {
  side: OrbSide;
  stopLoss: number;
  target: number;
  signalTimeMs: number;
}

export interface OrbTrade {
  symbol: string;
  side: OrbSide;
  entryTimeMs: number;
  exitTimeMs: number;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  grossPnl: number;
  costs: number;
  netPnl: number;
  exitReason: "stop-loss" | "target" | "forced-exit";
}

export interface OrbSkipped {
  symbol: string;
  date: string;
  reason: OrbSkipReason;
}

export interface OrbPeriodResult {
  trades: OrbTrade[];
  skipped: Record<OrbSkipReason, number>;
  tradesPerMonth: number;
  winRatePercent: number;
  averageWin: number;
  averageLoss: number;
  pnlBeforeCosts: number;
  pnlAfterCosts: number;
  totalCosts: number;
  averageProfitPerTrade: number;
  maxDrawdown: number;
  worstDay: number;
}

export interface OrbBacktestResult {
  train: Map<string, OrbPeriodResult>;
  test: Map<string, OrbPeriodResult>;
  totalTrain: OrbPeriodResult;
  totalTest: OrbPeriodResult;
  competingSignalDays: number;
}

const istDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
});
const istTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit"
});

function time(candle: Candle): string {
  return istTimeFormatter.format(new Date(candle.timeMs));
}

function date(candle: Candle): string {
  return istDateFormatter.format(new Date(candle.timeMs));
}

function sameDay(a: Candle, b: Candle): boolean {
  return date(a) === date(b);
}

export function calculateOpeningRange(candles: Candle[]): OpeningRange | null {
  if (candles.length < ORB_CONFIG.openingCandles ||
      !candles.slice(0, ORB_CONFIG.openingCandles).every((candle) => time(candle) >= "09:15" && time(candle) < "09:30")) {
    return null;
  }
  const opening = candles.slice(0, ORB_CONFIG.openingCandles);
  return {
    high: Math.max(...opening.map((candle) => candle.high)),
    low: Math.min(...opening.map((candle) => candle.low)),
    referencePrice: opening[0].close
  };
}

export function openingRangeSkip(range: OpeningRange): OrbSkipReason | null {
  const widthPercent = (range.high - range.low) / range.referencePrice * 100;
  if (widthPercent > ORB_CONFIG.openingRangeMaxPercent) return "range-too-wide";
  if (widthPercent < ORB_CONFIG.openingRangeMinPercent) return "range-too-narrow";
  return null;
}

export function getOrbSignal(candles: Candle[], range: OpeningRange, index = candles.length - 1): OrbSignal | null {
  const latest = candles[index];
  if (!latest || time(latest) < "09:30" || time(latest) > ORB_CONFIG.noEntryAfter) return null;
  if (latest.close > range.high) {
    const risk = latest.close - range.low;
    return risk > 0 ? { side: "long", stopLoss: range.low, target: latest.close + risk * ORB_CONFIG.riskReward, signalTimeMs: latest.timeMs } : null;
  }
  if (latest.close < range.low) {
    const risk = range.high - latest.close;
    return risk > 0 ? { side: "short", stopLoss: range.high, target: latest.close - risk * ORB_CONFIG.riskReward, signalTimeMs: latest.timeMs } : null;
  }
  return null;
}

export function quantityForOrb(entryPrice: number, stopLoss: number): { quantity: number; riskCapped: boolean } {
  const capitalQuantity = Math.floor(MAX_TRADING_CAPITAL / (entryPrice * ORB_CONFIG.marginEstimateRate));
  const risk = Math.abs(entryPrice - stopLoss);
  const riskQuantity = Math.floor(ORB_CONFIG.maximumRiskRupees / risk);
  return { quantity: Math.max(0, Math.min(capitalQuantity, riskQuantity)), riskCapped: riskQuantity < capitalQuantity };
}

function emptySkipped(): Record<OrbSkipReason, number> {
  return { "range-too-wide": 0, "range-too-narrow": 0, "cost-check": 0, "risk-cap": 0, "daily-limit": 0 };
}

function summarize(trades: OrbTrade[], skipped: Record<OrbSkipReason, number>, months: number): OrbPeriodResult {
  const wins = trades.filter((trade) => trade.netPnl > 0).map((trade) => trade.netPnl);
  const losses = trades.filter((trade) => trade.netPnl < 0).map((trade) => trade.netPnl);
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  const daily = new Map<string, number>();
  for (const trade of trades) {
    equity += trade.netPnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    daily.set(date({ timeMs: trade.exitTimeMs } as Candle), (daily.get(date({ timeMs: trade.exitTimeMs } as Candle)) ?? 0) + trade.netPnl);
  }
  return {
    trades, skipped, tradesPerMonth: months > 0 ? trades.length / months : 0,
    winRatePercent: trades.length ? wins.length / trades.length * 100 : 0,
    averageWin: wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0,
    averageLoss: losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0,
    pnlBeforeCosts: trades.reduce((sum, trade) => sum + trade.grossPnl, 0),
    pnlAfterCosts: trades.reduce((sum, trade) => sum + trade.netPnl, 0),
    totalCosts: trades.reduce((sum, trade) => sum + trade.costs, 0),
    averageProfitPerTrade: trades.length ? trades.reduce((sum, trade) => sum + trade.netPnl, 0) / trades.length : 0,
    maxDrawdown, worstDay: Math.min(0, ...daily.values())
  };
}

export function runOrbBacktest(bySymbol: Map<string, Candle[]>, testCutoffMs: number): OrbBacktestResult {
  const prepared = new Map<string, Candle[]>();
  const sessions = new Map<string, Map<string, Candle[]>>();
  const allDates = new Set<string>();
  for (const [symbol, source] of bySymbol) {
    const candles = filterCandlesForBacktest(source)
      .filter((candle) => isNormalTradingDay(new Date(candle.timeMs)))
      .sort((a, b) => a.timeMs - b.timeMs);
    prepared.set(symbol, candles);
    const byDate = new Map<string, Candle[]>();
    for (const candle of candles) {
      const day = date(candle);
      const rows = byDate.get(day) ?? [];
      rows.push(candle);
      byDate.set(day, rows);
      allDates.add(day);
    }
    sessions.set(symbol, byDate);
  }
  const tradesBySymbol = new Map<string, OrbTrade[]>();
  const skippedBySymbol = new Map<string, { train: Record<OrbSkipReason, number>; test: Record<OrbSkipReason, number> }>();
  for (const symbol of bySymbol.keys()) {
    tradesBySymbol.set(symbol, []);
    skippedBySymbol.set(symbol, { train: emptySkipped(), test: emptySkipped() });
  }
  const tradesByDate = new Map<string, number>();
  let competingSignalDays = 0;
  const periodFor = (timeMs: number): "train" | "test" => timeMs < testCutoffMs ? "train" : "test";
  for (const day of [...allDates].sort()) {
    const candidates: Array<{
      symbol: string;
      candles: Candle[];
      signal: OrbSignal;
      signalIndex: number;
      entryCandle: Candle;
      rangePercent: number;
    }> = [];
    for (const symbol of prepared.keys()) {
      const dayCandles = sessions.get(symbol)!.get(day);
      if (!dayCandles) continue;
      const skipped = skippedBySymbol.get(symbol)!;
      const range = calculateOpeningRange(dayCandles);
      if (!range) continue;
      const rangeSkip = openingRangeSkip(range);
      if (rangeSkip) {
        skipped[periodFor(dayCandles[0].timeMs)][rangeSkip] += 1;
        continue;
      }
      let signalCandidate: typeof candidates[number] | null = null;
      for (let i = ORB_CONFIG.openingCandles; i < dayCandles.length - 1; i += 1) {
        const signal = getOrbSignal(dayCandles, range, i);
        if (!signal) continue;
        const entryCandle = dayCandles[i + 1];
        signalCandidate = {
          symbol, candles: dayCandles, signal, entryCandle,
          signalIndex: i,
          rangePercent: (range.high - range.low) / range.referencePrice * 100
        };
        break;
      }
      if (signalCandidate) candidates.push(signalCandidate);
    }
    if (candidates.length > ORB_CONFIG.maximumTradesAcrossStocksPerDay) competingSignalDays += 1;
    candidates.sort((a, b) => a.signal.signalTimeMs - b.signal.signalTimeMs || a.rangePercent - b.rangePercent);
    for (const candidate of candidates) {
      const { symbol, candles: dayCandles, signal, entryCandle } = candidate;
      const skipped = skippedBySymbol.get(symbol)!;
      if ((tradesByDate.get(day) ?? 0) >= ORB_CONFIG.maximumTradesAcrossStocksPerDay) {
        skipped[periodFor(entryCandle.timeMs)]["daily-limit"] += 1;
        continue;
      }
      const entryPrice = signal.side === "long"
        ? entryCandle.open * (1 + ORB_CONFIG.slippageRate)
        : entryCandle.open * (1 - ORB_CONFIG.slippageRate);
      const sizing = quantityForOrb(entryPrice, signal.stopLoss);
      if (sizing.quantity === 0) {
        skipped[periodFor(entryCandle.timeMs)]["risk-cap"] += 1;
        continue;
      }
      if (Math.abs(signal.target - entryPrice) / entryPrice * 100 < 2 * breakEvenMovePct(entryPrice, sizing.quantity)) {
        skipped[periodFor(entryCandle.timeMs)]["cost-check"] += 1;
        continue;
      }
      let exit = dayCandles[dayCandles.length - 1];
      let exitReason: OrbTrade["exitReason"] = "forced-exit";
      for (let j = candidate.signalIndex + 1; j < dayCandles.length; j += 1) {
        const exitCandle = dayCandles[j];
        const stopHit = signal.side === "long" ? exitCandle.low <= signal.stopLoss : exitCandle.high >= signal.stopLoss;
        const targetHit = signal.side === "long" ? exitCandle.high >= signal.target : exitCandle.low <= signal.target;
        if (stopHit || targetHit) {
          exit = exitCandle;
          exitReason = stopHit ? "stop-loss" : "target";
          break;
        }
        if (time(exitCandle) >= ORB_CONFIG.forcedExitAt) {
          exit = exitCandle;
          break;
        }
      }
        const exitPrice = signal.side === "long"
          ? exit.close * (1 - ORB_CONFIG.slippageRate)
          : exit.close * (1 + ORB_CONFIG.slippageRate);
        const grossPnl = signal.side === "long"
          ? (exitPrice - entryPrice) * sizing.quantity
          : (entryPrice - exitPrice) * sizing.quantity;
        const costs = roundTripCost(entryPrice, sizing.quantity).total;
        tradesBySymbol.get(symbol)!.push({
          symbol, side: signal.side, entryTimeMs: entryCandle.timeMs, exitTimeMs: exit.timeMs,
          entryPrice, exitPrice, quantity: sizing.quantity, grossPnl, costs,
          netPnl: grossPnl - costs, exitReason
        });
        tradesByDate.set(day, (tradesByDate.get(day) ?? 0) + 1);
    }
  }
  const allTrades: OrbTrade[] = [];
  const allSkipped = { train: emptySkipped(), test: emptySkipped() };
  const periodResults = { train: new Map<string, OrbPeriodResult>(), test: new Map<string, OrbPeriodResult>() };
  for (const symbol of prepared.keys()) {
    const trades = tradesBySymbol.get(symbol)!;
    const skipped = skippedBySymbol.get(symbol)!;
    allTrades.push(...trades);
    for (const period of ["train", "test"] as const) {
      for (const reason of Object.keys(skipped[period]) as OrbSkipReason[]) allSkipped[period][reason] += skipped[period][reason];
    }
    periodResults.train.set(symbol, summarize(trades.filter((trade) => trade.exitTimeMs < testCutoffMs), skipped.train, 16));
    periodResults.test.set(symbol, summarize(trades.filter((trade) => trade.exitTimeMs >= testCutoffMs), skipped.test, 8));
  }
  return {
    ...periodResults,
    totalTrain: summarize(allTrades.filter((trade) => trade.exitTimeMs < testCutoffMs), allSkipped.train, 16),
    totalTest: summarize(allTrades.filter((trade) => trade.exitTimeMs >= testCutoffMs), allSkipped.test, 8),
    competingSignalDays
  };
}
