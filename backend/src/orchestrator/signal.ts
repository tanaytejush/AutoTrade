import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  SIGNAL_CONFIRMATION_TIMEOUT_MS,
  SIGNAL_DAILY_LOSS_LIMIT,
  SIGNAL_MAX_ORDER_VALUE,
  SIGNAL_MAX_TRADES_PER_DAY,
  SIGNAL_MIN_ORDER_VALUE,
  SIGNAL_NIFTY_GAP_LIMIT_PERCENT,
  SIGNAL_SKIP_PRICE_BUFFER,
  SIGNAL_TARGET_ORDER_VALUE
} from "../../config.js";
import { getRawPositions, indiaBroker } from "../../broker/india.js";
import { BrokerError } from "../../broker/types.js";
import { checkTrade, type RiskState } from "../risk/engine.js";
import { breakEvenMovePct, roundTripCost } from "../risk/costs.js";
import { calculateOpeningRange, getOrbSignal, type OrbSide } from "../strategy/orb.js";
import { ORB_CONFIG } from "../strategy/orb-config.js";
import { isNormalTradingDay } from "../data/nse-holidays.js";
import { fetchCandles, type Candle } from "../data/historical.js";
import { PAPER_SYMBOLS, type PaperApi, type PaperClock, retry } from "./run.js";

const IST = "Asia/Kolkata";
const root = resolve(process.cwd(), "..");

export interface SignalApi extends PaperApi {
  positions(): Promise<unknown>;
  positionsParsed(): Promise<Array<{ symbol: string; quantity: number }>>;
  niftyGapPercent(): Promise<number | null>;
}

export interface SignalInput {
  ask(prompt: string, timeoutMs: number): Promise<string | null>;
}

export interface SignalOptions {
  replayDate?: string;
  replay?: boolean;
  clock?: PaperClock;
  api?: SignalApi;
  input?: SignalInput;
  logDirectory?: string;
  positionsDirectory?: string;
}

const realApi: SignalApi = {
  funds: () => indiaBroker.getMargin(),
  quote: async (symbol) => indiaBroker.getQuote(symbol),
  quoteBatch: async (symbols) => {
    const quotes = await (await import("../../broker/india.js")).getQuotes(symbols);
    return new Map([...quotes].map(([symbol, quote]) => [symbol, { price: quote.price, timestamp: quote.timestamp }]));
  },
  resolve: async (symbol) => (await import("../../broker/india.js")).resolveInstrumentToken(symbol),
  candles: (symbol, start, end) => fetchCandles(symbol, "5minute", start, end),
  positions: getRawPositions,
  positionsParsed: () => indiaBroker.getPositions(),
  niftyGapPercent: async () => {
    const end = new Date();
    const start = new Date(end.getTime() - 3 * 24 * 60 * 60 * 1000);
    const candles = await fetchCandles("NIFTY 50", "1day", start, end);
    if (candles.length < 2) return null;
    const today = candles.at(-1)!;
    const yesterday = candles.at(-2)!;
    return (today.open - yesterday.close) / yesterday.close * 100;
  }
};

const realClock: PaperClock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
};

function dayOf(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: IST, year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
}

function clockTime(value: Date | number): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: IST, hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function logPath(directory: string, day: string): string {
  return resolve(directory, `${day}.jsonl`);
}

async function createLogger(directory: string, day: string) {
  await mkdir(directory, { recursive: true });
  return async (event: string, data: Record<string, unknown>) => {
    await appendFile(logPath(directory, day), `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...data })}\n`, "utf8");
    console.log(`[${event}] ${JSON.stringify(data)}`);
  };
}

function quantityForSignal(price: number, stop: number): { quantity: number; orderValue: number; risk: number } {
  const riskPerShare = Math.abs(price - stop);
  if (riskPerShare <= 0) return { quantity: 0, orderValue: 0, risk: 0 };
  const maxByRisk = Math.floor(ORB_CONFIG.maximumRiskRupees / riskPerShare);
  let quantity = Math.floor(SIGNAL_TARGET_ORDER_VALUE / price);
  quantity = Math.min(quantity, maxByRisk);
  while (quantity > 0 && quantity * price > SIGNAL_MAX_ORDER_VALUE) quantity -= 1;
  return { quantity, orderValue: quantity * price, risk: quantity * riskPerShare };
}

function alertText(symbol: string, price: number, stop: number, target: number, quantity: number): string {
  const orderValue = price * quantity;
  const risk = Math.abs(price - stop) * quantity;
  const breakEven = breakEvenMovePct(price, quantity);
  const skipPrice = price * (1 + SIGNAL_SKIP_PRICE_BUFFER);
  return `BUY ${quantity} ${symbol} intraday (MIS) | LIMIT ₹${price.toFixed(2)} | STOP ₹${stop.toFixed(2)} | TARGET ₹${target.toFixed(2)} | order ₹${orderValue.toFixed(0)} | risk ₹${risk.toFixed(2)} | break-even ${breakEven.toFixed(2)}% | SKIP if price is already above ₹${skipPrice.toFixed(2)} (0.2%)`;
}

function closePnl(side: OrbSide, entry: number, exit: number, quantity: number) {
  const gross = side === "long" ? (exit - entry) * quantity : (entry - exit) * quantity;
  const costs = roundTripCost(entry, quantity).total;
  return { gross, costs, net: gross - costs };
}

function firstSignal(rows: Candle[]) {
  const range = calculateOpeningRange(rows);
  if (!range) return null;
  for (let index = ORB_CONFIG.openingCandles; index < rows.length; index += 1) {
    const signal = getOrbSignal(rows, range, index);
    if (signal) return { signal, candle: rows[index] };
  }
  return null;
}

export async function runSignalMode(options: SignalOptions = {}): Promise<void> {
  const clock = options.clock ?? realClock;
  const api = options.api ?? realApi;
  const replay = options.replay === true;
  const now = clock.now();
  const startedAtMs = now.getTime();
  if (!isNormalTradingDay(now)) {
    console.log(`not a trading day (${dayOf(now)}); exiting`);
    return;
  }
  if (process.env.PAPER_TRADING !== "true") {
    console.log("PAPER_TRADING must be true; exiting");
    return;
  }
  const day = options.replayDate ?? dayOf(now);
  const log = await createLogger(options.logDirectory ?? resolve(root, "backend/cache/logs"), day);
  const input = options.input ?? {
    ask: async (prompt: string, timeoutMs: number) => {
      process.stdout.write(`${prompt} `);
      return new Promise<string | null>((resolveAnswer) => {
        const timer = setTimeout(() => resolveAnswer(null), timeoutMs);
        process.stdin.once("data", (data) => {
          clearTimeout(timer);
          resolveAnswer(String(data).trim());
        });
      });
    }
  };
  const start = new Date(`${day}T09:15:00+05:30`);
  const end = new Date(`${day}T15:11:00+05:30`);
  const data = new Map<string, Candle[]>();
  let apiCalls = 0;
  const call = async <T>(operation: () => Promise<T>): Promise<T> => {
    apiCalls += 1;
    return retry(operation, async (error) => log("api_error", { message: error instanceof Error ? error.message : String(error) }), clock.sleep);
  };
  if (replay) {
    for (const symbol of PAPER_SYMBOLS) data.set(symbol, await api.candles(symbol, start, end));
  } else {
    await Promise.all(PAPER_SYMBOLS.map((symbol) => call(() => api.resolve(symbol))));
  }
  let gap: number | null = replay ? 0 : null;
  if (!replay) {
    try {
      gap = await call(() => api.niftyGapPercent());
    } catch (error) {
      await log("nifty_gap_error", { message: error instanceof Error ? error.message : String(error) });
      gap = Number.POSITIVE_INFINITY;
    }
    await log("nifty_gap_check", { gapPercent: gap, checkedAtStartup: true });
    if (gap !== null && Math.abs(gap) > SIGNAL_NIFTY_GAP_LIMIT_PERCENT) {
      console.log("Big gap day: no trades today");
      await log("big_gap_day", { gapPercent: gap });
      return;
    }
  }
  if (clockTime(now) > "14:30") {
    console.log("Too late for new entries today");
    await log("late_start", { startedAt: clockTime(now), entriesDisabled: true });
  }
  const funds = replay ? { intradayAvailable: 500 } : await call(() => api.funds());
  const state: RiskState = { eqMis: funds.intradayAvailable ?? 0, openPositions: 0, tradesToday: 0, dailyLoss: 0 };
  let signals = 0;
  let trades = 0;
  let pnl = 0;
  let slippage = 0;
  let position: { symbol: string; entry: number; stop: number; target: number; quantity: number } | null = null;
  const expectedSignals: Array<Record<string, unknown>> = [];
  let finishedDay = false;
  const seenSignals = new Set<string>();
  const missedBeforeStart = new Set<string>();
  while (!finishedDay && clockTime(clock.now()) < "15:15") {
    const current = clock.now();
    const tooLateForEntries = clockTime(current) > "14:30";
    if (!position && state.tradesToday < SIGNAL_MAX_TRADES_PER_DAY && clockTime(current) >= "09:20") {
      for (const symbol of PAPER_SYMBOLS) {
        const rows = replay
          ? data.get(symbol)!.filter((candle) => candle.timeMs + 5 * 60_000 <= current.getTime())
          : await call(() => api.candles(symbol, start, new Date(current.getTime() - 10_000)));
        if (rows.length < ORB_CONFIG.openingCandles + 1) continue;
        const candidate = firstSignal(rows);
        if (!candidate) continue;
        const { signal, candle } = candidate;
        if (candle.timeMs + 5 * 60_000 <= startedAtMs) {
          if (!missedBeforeStart.has(symbol)) {
            missedBeforeStart.add(symbol);
            seenSignals.add(symbol);
            await log("missed", { symbol, reason: "breakout before start", signalTime: clockTime(signal.signalTimeMs) });
          }
          continue;
        }
        if (tooLateForEntries) continue;
        if (seenSignals.has(symbol)) continue;
        seenSignals.add(symbol);
        expectedSignals.push({
          symbol,
          side: signal.side,
          signalTime: clockTime(signal.signalTimeMs),
          stop: signal.stopLoss,
          target: signal.target
        });
        signals += 1;
        const entry = rows.at(-1)!.close;
        await log("signal", { symbol, side: signal.side, signalTime: clockTime(signal.signalTimeMs) });
        if (signal.side === "short") {
          await log("skipped", { symbol, reason: "long only" });
          continue;
        }
        const quote = replay ? { price: entry } : await call(() => api.quote(symbol));
        const sizing = quantityForSignal(quote.price, signal.stopLoss);
        if (sizing.quantity === 0 || sizing.orderValue < SIGNAL_MIN_ORDER_VALUE) {
          await log("skipped", { symbol, reason: "too small to beat costs", orderValue: sizing.orderValue, risk: sizing.risk });
          continue;
        }
        const decision = checkTrade(
          { symbol, entryPrice: quote.price, stopLoss: signal.stopLoss, target: signal.target, quantity: sizing.quantity },
          state,
          current,
          { maximumTradesPerDay: SIGNAL_MAX_TRADES_PER_DAY, dailyLossLimit: SIGNAL_DAILY_LOSS_LIMIT }
        );
        if (decision.decision === "block") {
          await log("blocked", { symbol, reason: decision.reason });
          continue;
        }
        const alert = alertText(symbol, quote.price, signal.stopLoss, signal.target, sizing.quantity);
        process.stdout.write("\x07\n" + `\n${alert}\n`);
        const answer = replay ? "y" : await input.ask("Placed? (y/n)", SIGNAL_CONFIRMATION_TIMEOUT_MS);
        if (answer?.toLowerCase() !== "y") {
          await log("cancelled", { symbol, reason: answer === null ? "confirmation timeout" : "not placed" });
          continue;
        }
        const fillAnswer = replay ? `${quote.price},${sizing.quantity}` : await input.ask("Fill price and quantity (price,quantity):", SIGNAL_CONFIRMATION_TIMEOUT_MS);
        const [fillPriceText, quantityText] = (fillAnswer ?? "").split(",");
        const fillPrice = Number(fillPriceText);
        const quantity = Number(quantityText);
        if (!Number.isFinite(fillPrice) || !Number.isInteger(quantity) || quantity <= 0) {
          await log("cancelled", { symbol, reason: "invalid fill confirmation" });
          continue;
        }
        slippage += (fillPrice - quote.price) * quantity;
        const raw = replay ? { replay: true, positions: [{ symbol, quantity }] } : await call(() => api.positions());
        await writeFile(resolve(options.positionsDirectory ?? resolve(root, "backend/cache"), `${day}-positions.json`), JSON.stringify(raw, null, 2), "utf8");
        const parsedPositions = replay ? [{ symbol, quantity }] : await call(() => api.positionsParsed());
        const matchingPosition = parsedPositions.find((item) => item.symbol === symbol && item.quantity >= quantity);
        if (!matchingPosition) await log("position_mismatch", { symbol, expectedQuantity: quantity, parsedPositions });
        await log("fill_confirmed", { symbol, signalPrice: quote.price, fillPrice, quantity, slippage: (fillPrice - quote.price) * quantity });
        position = { symbol, entry: fillPrice, stop: signal.stopLoss, target: signal.target, quantity };
        state.openPositions = 1;
        state.tradesToday = 1;
        trades = 1;
        break;
      }
    }
    if (position) {
      const openPosition = position;
      const quote = replay
        ? { price: data.get(openPosition.symbol)!.filter((candle) => candle.timeMs <= current.getTime()).at(-1)?.close ?? openPosition.entry }
        : (await call(() => api.quoteBatch([openPosition.symbol]))).get(openPosition.symbol);
      if (quote) {
        const hitStop = quote.price <= openPosition.stop;
        const hitTarget = quote.price >= openPosition.target;
        if (hitStop || hitTarget || clockTime(current) >= "15:10") {
          process.stdout.write("\x07\nEXIT NOW: SELL " + `${openPosition.quantity} ${openPosition.symbol}\n`);
          const exitAnswer = replay ? String(quote.price) : await input.ask("Exit price:", SIGNAL_CONFIRMATION_TIMEOUT_MS);
          const exitPrice = Number(exitAnswer);
          if (Number.isFinite(exitPrice)) {
            const result = closePnl("long", openPosition.entry, exitPrice, openPosition.quantity);
            pnl += result.net;
            state.dailyLoss = Math.min(0, pnl);
            const raw = replay ? { replay: true, positions: [] } : await call(() => api.positions());
            await writeFile(resolve(options.positionsDirectory ?? resolve(root, "backend/cache"), `${day}-positions-after-exit.json`), JSON.stringify(raw, null, 2), "utf8");
            const parsedPositions = replay ? [] : await call(() => api.positionsParsed());
            if (parsedPositions.some((item) => item.symbol === openPosition.symbol && item.quantity !== 0)) {
              await log("position_mismatch", { symbol: openPosition.symbol, expectedQuantity: 0, parsedPositions });
            }
            await log("exit_confirmed", { symbol: openPosition.symbol, exitPrice, reason: hitStop ? "stop-loss" : hitTarget ? "target" : "15:10", pnl: result.net, costs: result.costs });
            position = null;
            finishedDay = true;
          }
        }
      }
    }
    await clock.sleep(replay ? 60_000 : 60_000);
  }
  await log("summary", { signals, trades, realPnlAfterCosts: pnl, slippage, expectedBacktest: expectedSignals, apiCalls });
}
