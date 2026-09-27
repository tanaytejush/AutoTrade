import { getCachedCandles } from "../src/data/historical.js";
import { runPaperOrchestrator, PAPER_SYMBOLS, type PaperApi, type PaperClock } from "../src/orchestrator/run.js";

const replay = process.env.BOT_MODE === "REPLAY";
if (!replay) {
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
