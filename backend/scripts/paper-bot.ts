import { getCachedCandles } from "../src/data/historical.js";
import { runPaperOrchestrator, PAPER_SYMBOLS, type PaperApi, type PaperClock } from "../src/orchestrator/run.js";
import { runSignalMode, type SignalApi } from "../src/orchestrator/signal.js";
import { indiaBroker, getQuotes, getRawPositions, resolveInstrumentToken } from "../broker/india.js";
import { fetchCandles } from "../src/data/historical.js";

const mode = process.env.BOT_MODE ?? "PAPER";
const replay = mode === "REPLAY" || (mode === "SIGNAL" && process.env.SIGNAL_REPLAY === "true");
if (mode === "SIGNAL") {
  if (!replay) {
    await runSignalMode({
      api: {
        funds: () => indiaBroker.getMargin(),
        quote: (symbol) => indiaBroker.getQuote(symbol),
        quoteBatch: async (symbols) => new Map([...await getQuotes(symbols)].map(([symbol, quote]) => [symbol, { price: quote.price, timestamp: quote.timestamp }])),
        resolve: resolveInstrumentToken,
        candles: (symbol, start, end) => fetchCandles(symbol, "5minute", start, end),
        positions: getRawPositions,
        positionsParsed: () => indiaBroker.getPositions(),
        niftyGapPercent: async () => null
      }
    });
  } else {
    const day = process.env.REPLAY_DATE ?? "2026-09-25";
    let current = new Date(`${day}T09:05:00+05:30`);
    const clock: PaperClock = {
      now: () => new Date(current),
      async sleep() { current = new Date(current.getTime() + 60_000); }
    };
    const start = new Date(`${day}T09:15:00+05:30`);
    const end = new Date(`${day}T15:11:00+05:30`);
    const cached = new Map<string, Awaited<ReturnType<typeof getCachedCandles>>>();
    for (const symbol of PAPER_SYMBOLS) cached.set(symbol, await getCachedCandles(symbol, "5minute", start, end));
    const api: SignalApi = {
      funds: async () => ({ intradayAvailable: 500 }),
      quote: async (symbol) => ({ price: cached.get(symbol)!.at(-1)?.close ?? 1 }),
      quoteBatch: async (symbols) => new Map(symbols.map((symbol) => [symbol, { price: cached.get(symbol)!.at(-1)?.close ?? 1 }])),
      resolve: async (symbol) => `${symbol}_REPLAY`,
      candles: async (symbol, _start, requestEnd) => cached.get(symbol)!.filter((candle) => candle.timeMs <= requestEnd.getTime()),
      positions: async () => ({ positions: [{ symbol: "CIPLA", quantity: 1 }] }),
      positionsParsed: async () => [{ symbol: "CIPLA", quantity: 1 }],
      niftyGapPercent: async () => 0
    };
    await runSignalMode({ replay: true, replayDate: day, clock, api });
  }
} else if (mode === "PAPER") {
  await runPaperOrchestrator();
} else {
  const day = process.env.REPLAY_DATE ?? "2026-09-25";
  let current = new Date(`${day}T09:05:00+05:30`);
  const clock: PaperClock = {
    now: () => new Date(current),
    async sleep() { current = new Date(current.getTime() + 60_000); }
  };
  const start = new Date(`${day}T09:15:00+05:30`);
  const end = new Date(`${day}T15:11:00+05:30`);
  const cached = new Map<string, Awaited<ReturnType<typeof getCachedCandles>>>();
  for (const symbol of PAPER_SYMBOLS) cached.set(symbol, await getCachedCandles(symbol, "5minute", start, end));
  const api: PaperApi = {
    funds: async () => ({ intradayAvailable: 500 }),
    quote: async (symbol) => ({ price: cached.get(symbol)!.at(-1)?.close ?? 1, timestamp: current.toISOString() }),
    quoteBatch: async (symbols) => new Map(symbols.map((symbol) => [symbol, { price: cached.get(symbol)!.at(-1)?.close ?? 1 }])),
    resolve: async (symbol) => `${symbol}_REPLAY`,
    candles: async (symbol, _start, requestEnd) => cached.get(symbol)!.filter((candle) => candle.timeMs <= requestEnd.getTime())
  };
  await runPaperOrchestrator({ replay: true, replayDate: day, clock, api });
}
