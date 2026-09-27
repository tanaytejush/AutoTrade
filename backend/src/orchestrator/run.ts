import "dotenv/config";
import { appendFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { getCachedCandles } from "../data/historical.js";
import { isNormalTradingDay } from "../data/nse-holidays.js";
import { indiaBroker } from "../../broker/india.js";
import { checkTrade, type RiskState } from "../risk/engine.js";
import { getOrbSignal, calculateOpeningRange, type OrbSide } from "../strategy/orb.js";
import { ORB_CONFIG } from "../strategy/orb-config.js";
import { roundTripCost } from "../risk/costs.js";

const SYMBOLS = ["CIPLA", "HINDUNILVR", "ICICIBANK", "NESTLEIND", "RELIANCE", "SBILIFE", "SUNPHARMA", "TATACONSUM"];
const root = resolve(process.cwd(), "..");
const logDirectory = resolve(root, "backend/cache/logs");

interface PaperPosition {
  symbol: string;
  side: OrbSide;
  quantity: number;
  entryPrice: number;
  stopLoss: number;
  target: number;
  openedAt: number;
}

interface RunOptions {
  replay?: boolean;
  replayDate?: string;
}

function dateString(time: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(time));
}

function timeString(time: number): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }).format(new Date(time));
}

async function createLogger(day: string): Promise<(event: string, data: Record<string, unknown>) => Promise<void>> {
  await mkdir(logDirectory, { recursive: true });
  const path = resolve(logDirectory, `${day}.jsonl`);
  return async (event, data) => {
    const row = { timestamp: new Date().toISOString(), event, ...data };
    await appendFile(path, `${JSON.stringify(row)}\n`, "utf8");
    console.log(`[${event}] ${JSON.stringify(data)}`);
  };
}

function closePosition(position: PaperPosition, price: number): { pnl: number; costs: number } {
  const gross = position.side === "long"
    ? (price - position.entryPrice) * position.quantity
    : (position.entryPrice - price) * position.quantity;
  const costs = roundTripCost(position.entryPrice, position.quantity).total;
  return { pnl: gross - costs, costs };
}

export async function runPaperOrchestrator(options: RunOptions = {}): Promise<void> {
  const replayDate = options.replayDate ?? "2026-09-25";
  const now = options.replay ? new Date(`${replayDate}T09:14:00+05:30`) : new Date();
  if (!isNormalTradingDay(now)) {
    console.log(`Not a normal trading day (${dateString(now.getTime())}); exiting.`);
    return;
  }
  const log = await createLogger(dateString(now.getTime()));
  if (!options.replay && process.env.PAPER_TRADING !== "true") {
    await log("blocked", { reason: "PAPER_TRADING must be true" });
    return;
  }
  const margin = options.replay ? { intradayAvailable: 500 } : await indiaBroker.getMargin();
  const eqMis = margin.intradayAvailable ?? 0;
  await log("startup", { mode: options.replay ? "REPLAY" : "PAPER", usableCapital: Math.min(500, eqMis) });
  const end = new Date(`${replayDate}T15:11:00+05:30`);
  const start = new Date(`${replayDate}T09:15:00+05:30`);
  const candlesBySymbol = new Map<string, Awaited<ReturnType<typeof getCachedCandles>>>();
  for (const symbol of SYMBOLS) {
    candlesBySymbol.set(symbol, await getCachedCandles(symbol, "5minute", start, end));
  }
  const positions = new Map<string, PaperPosition>();
  const riskState: RiskState = { eqMis, openPositions: 0, tradesToday: 0, dailyLoss: 0 };
  let signals = 0;
  const blocked = new Map<string, number>();
  let pnl = 0;
  let apiErrors = 0;
  let peakMemory = process.memoryUsage().rss;
  const timestamps = [...new Set([...candlesBySymbol.values()].flatMap((rows) => rows.map((row) => row.timeMs)))].sort((a, b) => a - b);
  for (const timestamp of timestamps) {
    if (!options.replay && await import("node:fs/promises").then(({ access }) => access(resolve(root, "STOP")).then(() => true).catch(() => false))) {
      await log("kill_switch", { reason: "STOP file found" });
      for (const position of positions.values()) {
        const result = closePosition(position, position.entryPrice);
        pnl += result.pnl;
        await log("exit", { symbol: position.symbol, reason: "kill-switch", pnl: result.pnl });
      }
      return;
    }
    for (const [symbol, allCandles] of candlesBySymbol) {
      const index = allCandles.findIndex((candle) => candle.timeMs === timestamp);
      if (index < ORB_CONFIG.openingCandles || positions.has(symbol)) continue;
      const dayCandles = allCandles.slice(0, index + 1);
      const range = calculateOpeningRange(dayCandles.slice(0, ORB_CONFIG.openingCandles));
      if (!range) continue;
      const signal = getOrbSignal(dayCandles, range, index);
      if (!signal) continue;
      signals += 1;
      const entry = allCandles[index + 1];
      if (!entry) continue;
      const entryPrice = entry.open * (signal.side === "long" ? 1 + ORB_CONFIG.slippageRate : 1 - ORB_CONFIG.slippageRate);
      const risk = Math.abs(entryPrice - signal.stopLoss);
      const quantity = Math.min(Math.floor(25 / risk), Math.floor(500 / (entryPrice * 0.2)));
      const decision = checkTrade({ symbol, entryPrice, stopLoss: signal.stopLoss, target: signal.target, quantity }, riskState, new Date(timestamp));
      if (decision.decision === "block") {
        blocked.set(decision.reason, (blocked.get(decision.reason) ?? 0) + 1);
        await log("blocked", { symbol, reason: decision.reason });
        continue;
      }
      const position: PaperPosition = { symbol, side: signal.side, quantity, entryPrice, stopLoss: signal.stopLoss, target: signal.target, openedAt: entry.timeMs };
      positions.set(symbol, position);
      riskState.openPositions += 1;
      riskState.tradesToday += 1;
      await log("fill", { symbol, side: signal.side, quantity, price: entryPrice, paper: true });
    }
    for (const [symbol, position] of positions) {
      const candle = candlesBySymbol.get(symbol)!.find((row) => row.timeMs === timestamp);
      if (!candle) continue;
      const stop = position.side === "long" ? candle.low <= position.stopLoss : candle.high >= position.stopLoss;
      const target = position.side === "long" ? candle.high >= position.target : candle.low <= position.target;
      if (stop || target || timeString(timestamp) >= ORB_CONFIG.forcedExitAt) {
        const price = stop ? position.stopLoss : target ? position.target : candle.close;
        const result = closePosition(position, price);
        pnl += result.pnl;
        riskState.dailyLoss = Math.min(0, pnl);
        riskState.openPositions -= 1;
        positions.delete(symbol);
        await log("exit", { symbol, reason: stop ? "stop-loss" : target ? "target" : "15:10", pnl: result.pnl, costs: result.costs });
      }
    }
    peakMemory = Math.max(peakMemory, process.memoryUsage().rss);
    await log("heartbeat", { at: timeString(timestamp), positions: positions.size });
  }
  for (const position of positions.values()) {
    const result = closePosition(position, position.entryPrice);
    pnl += result.pnl;
    await log("exit", { symbol: position.symbol, reason: "15:10", pnl: result.pnl });
  }
  await log("summary", { signals, trades: riskState.tradesToday, blocked: Object.fromEntries(blocked), paperPnlAfterCosts: pnl, apiErrors, peakMemoryMb: peakMemory / 1024 / 1024 });
}

if (process.argv[1]?.endsWith("run.ts")) {
  await runPaperOrchestrator({ replay: process.env.BOT_MODE === "REPLAY" });
}
