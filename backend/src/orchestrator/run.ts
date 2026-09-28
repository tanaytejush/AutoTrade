import { access, appendFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fetchCandles, getCachedCandles, type Candle } from "../data/historical.js";
import { isNormalTradingDay } from "../data/nse-holidays.js";
import { getQuotes, indiaBroker, resolveInstrumentToken } from "../../broker/india.js";
import { BrokerError } from "../../broker/types.js";
import { checkTrade, type RiskState } from "../risk/engine.js";
import { calculateOpeningRange, firstOrbCandidate, getOrbSignal, quantityForOrb, runOrbBacktest, type OrbSide } from "../strategy/orb.js";
import { ORB_CONFIG } from "../strategy/orb-config.js";
import { roundTripCost } from "../risk/costs.js";

export const PAPER_SYMBOLS = ["CIPLA", "HINDUNILVR", "ICICIBANK", "NESTLEIND", "RELIANCE", "SBILIFE", "SUNPHARMA", "TATACONSUM"];
const IST = "Asia/Kolkata";
const root = resolve(process.cwd(), "..");

export interface PaperClock {
  now(): Date;
  sleep(ms: number): Promise<void>;
}

export interface PaperApi {
  funds(): Promise<{ intradayAvailable?: number }>;
  quote(symbol: string): Promise<{ price: number; timestamp?: string }>;
  quoteBatch(symbols: string[]): Promise<Map<string, { price: number; timestamp?: string }>>;
  resolve(symbol: string): Promise<string>;
  candles(symbol: string, start: Date, end: Date): Promise<Candle[]>;
}

export interface PaperRunOptions {
  replay?: boolean;
  replayDate?: string;
  clock?: PaperClock;
  api?: PaperApi;
  stopPath?: string;
  logDirectory?: string;
}

const realApi: PaperApi = {
  funds: () => indiaBroker.getMargin(),
  quote: async (symbol) => indiaBroker.getQuote(symbol),
  quoteBatch: async (symbols) => {
    const quotes = await getQuotes(symbols);
    return new Map([...quotes].map(([symbol, quote]) => [symbol, { price: quote.price, timestamp: quote.timestamp }]));
  },
  resolve: (symbol) => resolveInstrumentToken(symbol),
  candles: (symbol, start, end) => fetchCandles(symbol, "5minute", start, end)
};

const realClock: PaperClock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
};

function dayOf(value: Date | number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: IST, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}

function clockTime(value: Date | number): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: IST, hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function dateAt(day: string, time: string): Date {
  return new Date(`${day}T${time}:00+05:30`);
}

export function shouldRetry(error: unknown): boolean {
  return error instanceof BrokerError &&
    (error.code === "RATE_LIMITED" || (error.code === "REQUEST_FAILED" && (!error.status || error.status >= 500)));
}

export async function retry<T>(
  operation: () => Promise<T>,
  onError: (error: unknown) => Promise<void>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
): Promise<T> {
  let delay = 1000;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      await onError(error);
      if (!shouldRetry(error)) throw error;
      if (attempt === 5) throw error;
      await sleep(delay);
      delay *= 2;
    }
  }
  throw new Error("Retry loop failed.");
}

function authRejected(error: unknown): boolean {
  return error instanceof BrokerError && error.code === "AUTH_EXPIRED";
}

function authMessage(error: unknown): string {
  if (error instanceof Error && error.message.includes("TOKEN REJECTED / ACCESS DENIED")) return error.message;
  return `TOKEN REJECTED / ACCESS DENIED${error instanceof Error ? `: ${error.message}` : ""}`;
}

async function logger(directory: string, day: string): Promise<(event: string, data: Record<string, unknown>) => Promise<void>> {
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, `${day}.jsonl`);
  return async (event, data) => {
    await appendFile(path, `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...data })}\n`, "utf8");
    console.log(`[${event}] ${JSON.stringify(data)}`);
  };
}

interface Position {
  symbol: string;
  side: OrbSide;
  quantity: number;
  entryPrice: number;
  stopLoss: number;
  target: number;
}

function closePosition(position: Position, price: number): { pnl: number; costs: number } {
  const gross = position.side === "long"
    ? (price - position.entryPrice) * position.quantity
    : (position.entryPrice - price) * position.quantity;
  const costs = roundTripCost(position.entryPrice, position.quantity).total;
  return { pnl: gross - costs, costs };
}

async function stopRequested(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false);
}

export async function runPaperOrchestrator(options: PaperRunOptions = {}): Promise<void> {
  const clock = options.clock ?? realClock;
  const api = options.api ?? realApi;
  const replay = options.replay === true;
  const now = clock.now();
  if (!isNormalTradingDay(now)) {
    console.log(`not a trading day (${dayOf(now)}); exiting`);
    return;
  }
  if (process.env.PAPER_TRADING !== "true") {
    console.log("PAPER_TRADING must be true; exiting");
    return;
  }
  const day = options.replayDate ?? dayOf(now);
  const log = await logger(options.logDirectory ?? resolve(root, "backend/cache/logs"), day);
  let apiErrors = 0;
  const reportError = async (error: unknown) => {
    apiErrors += 1;
    await log("api_error", { message: error instanceof Error ? error.message : String(error) });
  };
  console.log(`PC IST time: ${new Intl.DateTimeFormat("en-GB", { timeZone: IST, dateStyle: "short", timeStyle: "medium" }).format(now)}; sync the Windows clock before trading.`);

  if (replay) {
    const start = dateAt(day, "09:15");
    const end = dateAt(day, "15:11");
    const data = new Map<string, Candle[]>();
    for (const symbol of PAPER_SYMBOLS) data.set(symbol, await getCachedCandles(symbol, "5minute", start, end));
    const candidates = PAPER_SYMBOLS
      .map((symbol) => firstOrbCandidate(symbol, data.get(symbol)!))
      .filter((candidate) => candidate !== null)
      .sort((a, b) => a.signal.signalTimeMs - b.signal.signalTimeMs || a.rangePercent - b.rangePercent);
    for (const candidate of candidates) {
      await log("signal", {
        symbol: candidate.symbol,
        time: new Date(candidate.signal.signalTimeMs).toISOString(),
        side: candidate.signal.side,
        entry: candidate.entryCandle.open,
        stop: candidate.signal.stopLoss,
        target: candidate.signal.target
      });
    }
    const result = runOrbBacktest(data, end.getTime());
    const trades = [...result.totalTrain.trades, ...result.totalTest.trades];
    for (const trade of trades) await log("replay_trade", { ...trade });
    await log("summary", { signals: candidates.length, trades: trades.length, blocked: { "Daily trade limit": candidates.length - trades.length }, paperPnlAfterCosts: trades.reduce((sum, trade) => sum + trade.netPnl, 0), apiErrors: 0, peakMemoryMb: process.memoryUsage().rss / 1024 / 1024, apiCalls: 0 });
    return;
  }

  try {
    const firstQuote = await retry(() => api.quote(PAPER_SYMBOLS[0]), reportError);
    if (!replay && firstQuote.timestamp) {
      const difference = Math.abs(Date.now() - new Date(firstQuote.timestamp).getTime());
      if (difference >= 30_000) {
        console.log(`clock difference ${difference}ms exceeds 30 seconds; exiting`);
        return;
      }
    }
    await Promise.all(PAPER_SYMBOLS.map((symbol) => retry(() => api.resolve(symbol), reportError)));
    const fundsAtStartup = await retry(() => api.funds(), reportError);
    await log("startup_self_check", { token: "valid", fundsReadable: true, symbolsResolved: PAPER_SYMBOLS.length, usableCapital: Math.min(500, fundsAtStartup.intradayAvailable ?? 0) });
  } catch (error) {
    if (authRejected(error)) {
      console.log(authMessage(error));
      return;
    }
    await log("startup_failed", { message: error instanceof Error ? error.message : String(error) });
    return;
  }

  const funds = await retry(() => api.funds(), reportError);
  const eqMis = funds.intradayAvailable ?? 0;
  await log("funds", { usableCapital: Math.min(500, eqMis) });
  const riskState: RiskState = { eqMis, openPositions: 0, tradesToday: 0, dailyLoss: 0 };
  const positions = new Map<string, Position>();
  const blocked = new Map<string, number>();
  let signals = 0;
  let pnl = 0;
  let peakMemory = process.memoryUsage().rss;
  const candlesBySymbol = new Map<string, Candle[]>();
  const replayCandlesBySymbol = new Map<string, Candle[]>();
  const lastSignalBySymbol = new Map<string, number>();

  const closeAll = async (reason: string) => {
    let quotes = new Map<string, { price: number }>();
    try {
      quotes = await retry(() => api.quoteBatch([...positions.keys()]), reportError);
    } catch (error) {
      if (!authRejected(error)) throw error;
    }
    for (const [symbol, position] of positions) {
      const result = closePosition(position, quotes.get(symbol)?.price ?? position.entryPrice);
      pnl += result.pnl;
      await log("exit", { symbol, reason, price: quotes.get(symbol)?.price ?? position.entryPrice, pnl: result.pnl, costs: result.costs });
      positions.delete(symbol);
    }
    riskState.openPositions = 0;
  };

  const start = dateAt(day, "09:15");
  const end = dateAt(day, "15:11");
  if (replay) {
    for (const symbol of PAPER_SYMBOLS) replayCandlesBySymbol.set(symbol, await getCachedCandles(symbol, "5minute", start, end));
  }

  while (clockTime(clock.now()) < "15:15") {
    const current = clock.now();
    if (!replay && await stopRequested(options.stopPath ?? resolve(root, "STOP"))) {
      await log("kill_switch", { reason: "STOP file found" });
      await closeAll("kill-switch");
      return;
    }
    const currentTime = clockTime(current);
    if (currentTime >= "09:20") {
      const candleEnd = new Date(current.getTime() - 10_000);
      for (const symbol of PAPER_SYMBOLS) {
        try {
          const rows = replay
            ? replayCandlesBySymbol.get(symbol)!.filter((candle) => candle.timeMs <= candleEnd.getTime())
            : await retry(() => api.candles(symbol, start, candleEnd), reportError);
          const finished = rows.filter((candle) => candle.timeMs + 5 * 60_000 <= current.getTime());
          if (finished.length === 0) {
            await log("missing_candles", { symbol });
            continue;
          }
          if (!replay) candlesBySymbol.set(symbol, finished);
          const index = finished.length - 1;
          if (positions.has(symbol) || lastSignalBySymbol.has(symbol)) continue;
          const range = calculateOpeningRange(finished);
          const signal = range ? getOrbSignal(finished, range, index) : null;
          if (!signal) continue;
          signals += 1;
          await log("signal", { symbol, side: signal.side, signalTime: clockTime(signal.signalTimeMs) });
          lastSignalBySymbol.set(symbol, signal.signalTimeMs);
          const entryPrice = finished[index].close * (signal.side === "long" ? 1 + ORB_CONFIG.slippageRate : 1 - ORB_CONFIG.slippageRate);
          const sizing = quantityForOrb(entryPrice, signal.stopLoss);
          const decision = checkTrade({ symbol, entryPrice, stopLoss: signal.stopLoss, target: signal.target, quantity: sizing.quantity }, riskState, current);
          if (decision.decision === "block") {
            blocked.set(decision.reason, (blocked.get(decision.reason) ?? 0) + 1);
            await log("blocked", { symbol, reason: decision.reason });
            continue;
          }
          positions.set(symbol, { symbol, side: signal.side, quantity: sizing.quantity, entryPrice, stopLoss: signal.stopLoss, target: signal.target });
          riskState.openPositions += 1;
          riskState.tradesToday += 1;
          await log("fill", { symbol, side: signal.side, quantity: sizing.quantity, price: entryPrice, paper: true });
        } catch (error) {
          if (authRejected(error)) {
            console.log(authMessage(error));
            await closeAll("token-rejected");
            return;
          }
          await reportError(error);
          await log("missing_candles", { symbol, reason: "cycle failed" });
        }
      }
    }
    if (current.getSeconds() === 0 || replay) {
      const quotes = positions.size > 0
        ? await retry(() => api.quoteBatch([...positions.keys()]), reportError)
        : new Map<string, { price: number }>();
      for (const [symbol, position] of positions) {
        try {
          const quote = quotes.get(symbol);
          if (!quote) continue;
          const stop = position.side === "long" ? quote.price <= position.stopLoss : quote.price >= position.stopLoss;
          const target = position.side === "long" ? quote.price >= position.target : quote.price <= position.target;
          if (stop || target || currentTime >= "15:10") {
            const result = closePosition(position, quote.price);
            pnl += result.pnl;
            riskState.dailyLoss = Math.min(0, pnl);
            riskState.openPositions -= 1;
            positions.delete(symbol);
            await log("exit", { symbol, reason: stop ? "stop-loss" : target ? "target" : "15:10", price: quote.price, pnl: result.pnl, costs: result.costs });
          }
        } catch (error) {
          if (authRejected(error)) {
            console.log(authMessage(error));
            await closeAll("token-rejected");
            return;
          }
          await reportError(error);
        }
      }
    }
    if (current.getMinutes() % 5 === 0 && current.getSeconds() === 0) {
      await log("heartbeat", { at: currentTime, positions: positions.size });
    }
    peakMemory = Math.max(peakMemory, process.memoryUsage().rss);
    await clock.sleep(replay ? 1000 : 1000);
  }
  await closeAll("15:10");
  await log("summary", { signals, trades: riskState.tradesToday, blocked: Object.fromEntries(blocked), paperPnlAfterCosts: pnl, apiErrors, peakMemoryMb: peakMemory / 1024 / 1024 });
}

if (process.argv[1]?.endsWith("run.ts")) {
  await runPaperOrchestrator({ replay: process.env.BOT_MODE === "REPLAY" });
}
