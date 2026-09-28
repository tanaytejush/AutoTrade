import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { runSignalMode, type SignalApi } from "./signal.js";
import type { PaperClock } from "./run.js";
import type { Candle } from "../data/historical.js";

function clockAt(value: string): PaperClock {
  let current = new Date(value);
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

function testApi(rows: Candle[], symbol: string): SignalApi {
  return {
    funds: async () => ({ intradayAvailable: 500 }),
    quote: async () => ({ price: 101 }),
    quoteBatch: async (symbols) => new Map(symbols.map((item) => [item, { price: 101 }])),
    resolve: async (item) => item,
    candles: async () => rows,
    positions: async () => ({ positions: [] }),
    positionsParsed: async () => [],
    niftyGapPercent: async () => 0
  };
}

async function captureOutput<T>(operation: () => Promise<T>): Promise<{ result: T; output: string[] }> {
  const originalWrite = process.stdout.write;
  const output: string[] = [];
  process.stdout.write = ((value: string | Uint8Array) => {
    output.push(String(value));
    return true;
  }) as typeof process.stdout.write;
  try {
    return { result: await operation(), output };
  } finally {
    process.stdout.write = originalWrite;
  }
}

test("manual signal confirmation records fill, exit, and raw positions", async () => {
  const previousPaperTrading = process.env.PAPER_TRADING;
  process.env.PAPER_TRADING = "true";
  const directory = await mkdtemp(join(tmpdir(), "signal-mode-"));
  const symbol = "CIPLA";
  const rows = candles(symbol);
  const api: SignalApi = {
    ...testApi(rows, symbol),
    positions: async () => ({ positions: [{ symbol, quantity: 16 }] }),
    positionsParsed: async () => [{ symbol, quantity: 16 }]
  };
  const answers = ["y", "101,16"];
  try {
    const { output } = await captureOutput(() => runSignalMode({
      replay: true,
      replayDate: "2026-09-25",
      clock: clockAt("2026-09-25T09:05:00+05:30"),
      api,
      input: { ask: async () => answers.shift() ?? null },
      logDirectory: directory,
      positionsDirectory: directory
    }));
    assert.ok(output.some((line) => line.includes("BUY 16 CIPLA intraday (MIS)")));
    assert.ok(output.some((line) => line.includes("EXIT NOW: SELL 16 CIPLA")));
  } finally {
    await rm(directory, { recursive: true, force: true });
    if (previousPaperTrading === undefined) delete process.env.PAPER_TRADING;
    else process.env.PAPER_TRADING = previousPaperTrading;
  }
});

test("breakout signal closing at 14:35 is rejected by the live cutoff", async () => {
  const previousPaperTrading = process.env.PAPER_TRADING;
  process.env.PAPER_TRADING = "true";
  const directory = await mkdtemp(join(tmpdir(), "signal-cutoff-"));
  const symbol = "CIPLA";
  const base = new Date("2026-09-25T09:15:00+05:30").getTime();
  const rows = [
    ...candles(symbol).slice(0, 3),
    { scripCode: symbol, interval: "5minute" as const, timeMs: new Date("2026-09-25T14:25:00+05:30").getTime(), open: 100, high: 100.2, low: 99.8, close: 100, volume: 1 },
    { scripCode: symbol, interval: "5minute" as const, timeMs: new Date("2026-09-25T14:30:00+05:30").getTime(), open: 100, high: 101.2, low: 100, close: 101, volume: 1 }
  ];
  try {
    const { output } = await captureOutput(() => runSignalMode({
      replay: true,
      replayDate: "2026-09-25",
      clock: clockAt("2026-09-25T09:05:00+05:30"),
      api: testApi(rows, symbol),
      logDirectory: directory,
      positionsDirectory: directory
    }));
    assert.equal(output.some((line) => line.includes("BUY ")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
    if (previousPaperTrading === undefined) delete process.env.PAPER_TRADING;
    else process.env.PAPER_TRADING = previousPaperTrading;
  }
});

test("12:44 start misses a 10:15 breakout that is still above the range", async () => {
  const previousPaperTrading = process.env.PAPER_TRADING;
  process.env.PAPER_TRADING = "true";
  const directory = await mkdtemp(join(tmpdir(), "signal-late-start-"));
  const symbol = "CIPLA";
  const base = new Date("2026-09-25T09:15:00+05:30").getTime();
  const rows = [
    ...candles(symbol).slice(0, 3),
    { scripCode: symbol, interval: "5minute" as const, timeMs: new Date("2026-09-25T10:05:00+05:30").getTime(), open: 100, high: 100.2, low: 99.8, close: 100, volume: 1 },
    { scripCode: symbol, interval: "5minute" as const, timeMs: new Date("2026-09-25T10:10:00+05:30").getTime(), open: 100, high: 101.2, low: 100, close: 101, volume: 1 },
    { scripCode: symbol, interval: "5minute" as const, timeMs: new Date("2026-09-25T10:15:00+05:30").getTime(), open: 101, high: 101.4, low: 100.8, close: 101.2, volume: 1 }
  ];
  try {
    const { output } = await captureOutput(() => runSignalMode({
      replay: true,
      replayDate: "2026-09-25",
      clock: clockAt("2026-09-25T12:44:00+05:30"),
      api: testApi(rows, symbol),
      logDirectory: directory,
      positionsDirectory: directory
    }));
    const log = await readFile(join(directory, "2026-09-25.jsonl"), "utf8");
    assert.equal(output.some((line) => line.includes("BUY ")), false);
    assert.match(log, /"event":"missed"/);
    assert.match(log, /breakout before start/);
  } finally {
    await rm(directory, { recursive: true, force: true });
    if (previousPaperTrading === undefined) delete process.env.PAPER_TRADING;
    else process.env.PAPER_TRADING = previousPaperTrading;
  }
});
