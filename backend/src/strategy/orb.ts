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

function time(candle: Candle): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }).format(new Date(candle.timeMs));
}

function date(candle: Candle): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(candle.timeMs));
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

export function getOrbSignal(candles: Candle[], range: OpeningRange): OrbSignal | null {
  const latest = candles.at(-1);
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

export function runOrbBacktest(bySymbol: Map<string, Candle[]>, testCutoffMs: number): { train: Map<string, OrbPeriodResult>; test: Map<string, OrbPeriodResult>; totalTrain: OrbPeriodResult; totalTest: OrbPeriodResult } {
  const allTrades: OrbTrade[] = [];
  const allSkipped = { train: emptySkipped(), test: emptySkipped() };
  const tradesByDate = new Map<string, number>();
  const periodResults = { train: new Map<string, OrbPeriodResult>(), test: new Map<string, OrbPeriodResult>() };
  for (const [symbol, source] of bySymbol) {
    const candles = filterCandlesForBacktest(source).filter((candle) => isNormalTradingDay(new Date(candle.timeMs))).sort((a, b) => a.timeMs - b.timeMs);
    const trades: OrbTrade[] = [];
    const skipped = { train: emptySkipped(), test: emptySkipped() };
    const periodFor = (timeMs: number): "train" | "test" => timeMs < testCutoffMs ? "train" : "test";
    const sessions: Candle[][] = [];
    for (const candle of candles) {
      const session = sessions.at(-1);
      if (!session || !sameDay(candle, session[0])) sessions.push([candle]);
      else session.push(candle);
    }
    for (const dayCandles of sessions) {
      const range = calculateOpeningRange(dayCandles);
      if (!range) continue;
      const rangeSkip = openingRangeSkip(range);
      if (rangeSkip) { skipped[periodFor(dayCandles[0].timeMs)][rangeSkip] += 1; continue; }
      let entered = false;
      for (let i = ORB_CONFIG.openingCandles; i < dayCandles.length - 1; i += 1) {
        if (entered) break;
        const signal = getOrbSignal(dayCandles.slice(0, i + 1), range);
        if (!signal) continue;
        const entryCandle = dayCandles[i + 1];
        const day = date(entryCandle);
        if ((tradesByDate.get(day) ?? 0) >= ORB_CONFIG.maximumTradesAcrossStocksPerDay) {
          skipped[periodFor(entryCandle.timeMs)]["daily-limit"] += 1; continue;
        }
        const entryPrice = signal.side === "long" ? entryCandle.open * (1 + ORB_CONFIG.slippageRate) : entryCandle.open * (1 - ORB_CONFIG.slippageRate);
        const sizing = quantityForOrb(entryPrice, signal.stopLoss);
        if (sizing.quantity === 0) { skipped[periodFor(entryCandle.timeMs)]["risk-cap"] += 1; continue; }
        if (sizing.riskCapped) skipped[periodFor(entryCandle.timeMs)]["risk-cap"] += 1;
        const targetMove = Math.abs(signal.target - entryPrice) / entryPrice * 100;
        if (targetMove < 2 * breakEvenMovePct(entryPrice, sizing.quantity)) {
          skipped[periodFor(entryCandle.timeMs)]["cost-check"] += 1; continue;
        }
        let exit = dayCandles.at(-1)!;
        let exitReason: OrbTrade["exitReason"] = "forced-exit";
        for (const candidate of dayCandles.slice(i + 1)) {
          const stopHit = signal.side === "long" ? candidate.low <= signal.stopLoss : candidate.high >= signal.stopLoss;
          const targetHit = signal.side === "long" ? candidate.high >= signal.target : candidate.low <= signal.target;
          if (stopHit || targetHit) { exit = candidate; exitReason = stopHit ? "stop-loss" : "target"; break; }
          if (time(candidate) >= ORB_CONFIG.forcedExitAt) { exit = candidate; break; }
        }
        const exitPrice = signal.side === "long" ? exit.close * (1 - ORB_CONFIG.slippageRate) : exit.close * (1 + ORB_CONFIG.slippageRate);
        const grossPnl = signal.side === "long" ? (exitPrice - entryPrice) * sizing.quantity : (entryPrice - exitPrice) * sizing.quantity;
        const costs = roundTripCost(entryPrice, sizing.quantity).total;
        trades.push({ symbol, side: signal.side, entryTimeMs: entryCandle.timeMs, exitTimeMs: exit.timeMs, entryPrice, exitPrice, quantity: sizing.quantity, grossPnl, costs, netPnl: grossPnl - costs, exitReason });
        tradesByDate.set(day, (tradesByDate.get(day) ?? 0) + 1);
        entered = true;
      }
    }
    for (const trade of trades) allTrades.push(trade);
    const train = trades.filter((trade) => trade.exitTimeMs < testCutoffMs);
    const test = trades.filter((trade) => trade.exitTimeMs >= testCutoffMs);
    for (const period of ["train", "test"] as const) {
      for (const reason of Object.keys(skipped[period]) as OrbSkipReason[]) allSkipped[period][reason] += skipped[period][reason];
    }
    periodResults.train.set(symbol, summarize(train, skipped.train, 16));
    periodResults.test.set(symbol, summarize(test, skipped.test, 8));
  }
  return {
    ...periodResults,
    totalTrain: summarize(allTrades.filter((trade) => trade.exitTimeMs < testCutoffMs), allSkipped.train, 16),
    totalTest: summarize(allTrades.filter((trade) => trade.exitTimeMs >= testCutoffMs), allSkipped.test, 8)
  };
}
