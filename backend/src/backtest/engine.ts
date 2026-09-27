import { MAX_TRADING_CAPITAL, BACKTEST_DAILY_LOSS_LIMIT, BACKTEST_SLIPPAGE_RATE, BACKTEST_TEST_MONTHS, INTRADAY_MARGIN_ESTIMATE_RATE } from "../../config.js";
import { filterCandlesForBacktest, type Candle } from "../data/historical.js";
import { isNormalTradingDay } from "../data/nse-holidays.js";
import { roundTripCost } from "../risk/costs.js";

export interface BacktestSignal {
  stopLoss: number;
  target: number;
}

export interface BacktestStrategy {
  onCandle(candles: Candle[]): BacktestSignal | null;
}

export const harnessCheckStrategy: BacktestStrategy = {
  onCandle(candles) {
    const latest = candles.at(-1);
    if (!latest) return null;
    const time = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(latest.timeMs));
    return time === "10:00" ? {
      stopLoss: latest.close * 0.99,
      target: latest.close * 1.01
    } : null;
  }
};

export interface BacktestTrade {
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

export interface BacktestResult {
  trades: BacktestTrade[];
  totalTrades: number;
  winRatePercent: number;
  averageWin: number;
  averageLoss: number;
  totalPnl: number;
  totalCosts: number;
  maxDrawdown: number;
  worstDay: number;
}

function istDate(candle: Candle): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(candle.timeMs));
}

function istTime(candle: Candle): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }).format(new Date(candle.timeMs));
}

function testCutoff(candles: Candle[]): number {
  const last = candles.at(-1);
  if (!last) return Number.POSITIVE_INFINITY;
  const date = new Date(last.timeMs);
  date.setUTCMonth(date.getUTCMonth() - BACKTEST_TEST_MONTHS);
  return date.getTime();
}

export function runBacktest(sourceCandles: Candle[], strategy: BacktestStrategy, options: {
  marginPerShare?: number;
  slippageRate?: number;
  dailyLossLimit?: number;
  testCutoffMs?: number;
} = {}): { train: BacktestResult; test: BacktestResult } {
  const candles = filterCandlesForBacktest(sourceCandles)
    .filter((candle) => isNormalTradingDay(new Date(candle.timeMs)))
    .sort((a, b) => a.timeMs - b.timeMs);
  const cutoff = options.testCutoffMs ?? testCutoff(candles);
  const byPeriod = { train: [] as BacktestTrade[], test: [] as BacktestTrade[] };
  let position: { entry: Candle; entryPrice: number; quantity: number; signal: BacktestSignal } | null = null;
  let pending: BacktestSignal | null = null;
  let day = "";
  let dayPnl = 0;
  const slippage = options.slippageRate ?? BACKTEST_SLIPPAGE_RATE;
  const margin = options.marginPerShare ?? INTRADAY_MARGIN_ESTIMATE_RATE;
  const lossLimit = options.dailyLossLimit ?? BACKTEST_DAILY_LOSS_LIMIT;

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    const currentDay = istDate(candle);
    if (currentDay !== day) {
      day = currentDay;
      dayPnl = 0;
      position = null;
      pending = null;
    }
    if (pending && !position) {
      const entryPrice = candle.open * (1 + slippage);
      const quantity = Math.max(1, Math.floor(MAX_TRADING_CAPITAL / (entryPrice * margin)));
      position = { entry: candle, entryPrice, quantity, signal: pending };
      pending = null;
    }
    if (position) {
      const stopHit = candle.low <= position.signal.stopLoss;
      const targetHit = candle.high >= position.signal.target;
      let exitPrice: number | null = null;
      let exitReason: BacktestTrade["exitReason"] | null = null;
      if (stopHit) {
        exitPrice = position.signal.stopLoss * (1 - slippage);
        exitReason = "stop-loss";
      } else if (targetHit) {
        exitPrice = position.signal.target * (1 - slippage);
        exitReason = "target";
      } else if (istTime(candle) >= "15:10") {
        exitPrice = candle.close * (1 - slippage);
        exitReason = "forced-exit";
      }
      if (exitPrice !== null) {
        const grossPnl = (exitPrice - position.entryPrice) * position.quantity;
        const costs = roundTripCost(position.entryPrice, position.quantity).total;
        const trade: BacktestTrade = {
          entryTimeMs: position.entry.timeMs,
          exitTimeMs: candle.timeMs,
          entryPrice: position.entryPrice,
          exitPrice,
          quantity: position.quantity,
          grossPnl,
          costs,
          netPnl: grossPnl - costs,
          exitReason: exitReason!
        };
        dayPnl += trade.netPnl;
        byPeriod[candle.timeMs >= cutoff ? "test" : "train"].push(trade);
        position = null;
        if (dayPnl <= -lossLimit) pending = null;
      }
    }
    if (!position && !pending && dayPnl > -lossLimit && index < candles.length - 1) {
      const signal = strategy.onCandle(candles.slice(0, index + 1));
      if (signal) pending = signal;
    }
  }
  return { train: summarize(byPeriod.train), test: summarize(byPeriod.test) };
}

function summarize(trades: BacktestTrade[]): BacktestResult {
  const wins = trades.filter((trade) => trade.netPnl > 0).map((trade) => trade.netPnl);
  const losses = trades.filter((trade) => trade.netPnl < 0).map((trade) => trade.netPnl);
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  const days = new Map<string, number>();
  for (const trade of trades) {
    equity += trade.netPnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    const date = new Date(trade.exitTimeMs).toISOString().slice(0, 10);
    days.set(date, (days.get(date) ?? 0) + trade.netPnl);
  }
  return {
    trades,
    totalTrades: trades.length,
    winRatePercent: trades.length === 0 ? 0 : wins.length / trades.length * 100,
    averageWin: wins.length === 0 ? 0 : wins.reduce((a, b) => a + b, 0) / wins.length,
    averageLoss: losses.length === 0 ? 0 : losses.reduce((a, b) => a + b, 0) / losses.length,
    totalPnl: trades.reduce((sum, trade) => sum + trade.netPnl, 0),
    totalCosts: trades.reduce((sum, trade) => sum + trade.costs, 0),
    maxDrawdown,
    worstDay: Math.min(0, ...days.values())
  };
}
