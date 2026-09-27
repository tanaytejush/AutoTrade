import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { runSignalMode, type SignalApi } from "./signal.js";
import type { PaperClock } from "./run.js";
import type { Candle } from "../data/historical.js";

function makeClock(): PaperClock {
  let current = new Date("2026-09-25T09:05:00+05:30");
  return {
    now: () => new Date(current),
    async sleep() { current = new Date(current.getTime() + 60_000); }
  };
}

function candles(symbol: string): Candle[] {
  const start = new Date("2026-09-25T09:15:00+05:30").getTime();
  return [
    { scripCode: symbol, interval: "5minute", timeMs: start, open: 100, high: 100, low: 99.5, close: 100, volume: 1 },
    { scripCode: symbol, interval: "5minute", timeMs: start + 300_000, open: 100, high: 100.2, low: 99.8, close: 100, volume: 1 },
    { scripCode: symbol, interval: "5minute", timeMs: start + 600_000, open: 100, high: 100.2, low: 99.8, close: 100, volume: 1 },
    { scripCode: symbol, interval: "5minute", timeMs: start + 900_000, open: 100, high: 101.2, low: 100, close: 101, volume: 1 }
  ];
}

test("manual signal confirmation records fill, exit, and raw positions", async () => {
  process.env.PAPER_TRADING = "true";
  const directory = await mkdtemp(join(tmpdir(), "signal-mode-"));
  const symbol = "CIPLA";
  const rows = candles(symbol);
  const api: SignalApi = {
    funds: async () => ({ intradayAvailable: 500 }),
    quote: async () => ({ price: 101 }),
    quoteBatch: async (symbols) => new Map(symbols.map((item) => [item, { price: 101 }])),
    resolve: async (item) => item,
    candles: async () => rows,
    positions: async () => ({ positions: [{ symbol, quantity: 16 }] }),
    positionsParsed: async () => [{ symbol, quantity: 16 }],
    niftyGapPercent: async () => 0
  };
  const answers = ["y", "101,16"];
  const originalWrite = process.stdout.write;
  const output: string[] = [];
  process.stdout.write = ((value: string | Uint8Array) => {
    output.push(String(value));
    return true;
  }) as typeof process.stdout.write;
  try {
    await runSignalMode({
      replay: true,
      replayDate: "2026-09-25",
      clock: makeClock(),
      api,
      input: { ask: async () => answers.shift() ?? null },
      logDirectory: directory,
      positionsDirectory: directory
    });
  } finally {
    process.stdout.write = originalWrite;
    await rm(directory, { recursive: true, force: true });
  }
  assert.ok(output.some((line) => line.includes("BUY 16 CIPLA intraday (MIS)")));
  assert.ok(output.some((line) => line.includes("EXIT NOW: SELL 16 CIPLA")));
});
