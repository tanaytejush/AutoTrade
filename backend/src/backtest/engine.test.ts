import assert from "node:assert/strict";
import { test } from "node:test";
import { runBacktest, type BacktestStrategy } from "./engine.js";
import type { Candle } from "../data/historical.js";

function candle(time: string, open: number, high = open, low = open, close = open): Candle {
  return { scripCode: "NSE_TEST", interval: "5minute", timeMs: new Date(time).getTime(), open, high, low, close, volume: 1000 };
}
function sessionTime(index: number): string {
  const minutes = 15 + index * 5;
  return `2025-01-02T${String(9 + Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00+05:30`;
}
const signalStrategy: BacktestStrategy = { onCandle: (candles) => candles.length === 9 ? { stopLoss: 99, target: 101 } : null };

test("enters on the next candle open, not the signal candle", () => {
  const rows = Array.from({ length: 20 }, (_, i) => candle(sessionTime(i), 100));
  rows[9] = { ...rows[9], open: 102, high: 102, close: 102 };
  const result = runBacktest(rows, signalStrategy, { testCutoffMs: 0 });
  assert.equal(result.test.trades[0].entryPrice > 100, true);
});

test("stop-loss wins when stop and target occur in the same candle", () => {
  const rows = [
    ...Array.from({ length: 10 }, (_, i) => candle(sessionTime(i), 100)),
    candle("2025-01-02T10:05:00+05:30", 100, 102, 98, 100),
    candle("2025-01-02T15:10:00+05:30", 100)
  ];
  const result = runBacktest(rows, signalStrategy, { testCutoffMs: 0 });
  assert.equal(result.test.trades[0].exitReason, "stop-loss");
});

test("forces an open position out at 15:10", () => {
  const rows = [
    ...Array.from({ length: 10 }, (_, i) => candle(sessionTime(i), 100)),
    candle("2025-01-02T15:10:00+05:30", 100)
  ];
  const result = runBacktest(rows, signalStrategy, { testCutoffMs: 0 });
  assert.equal(result.test.trades[0].exitReason, "forced-exit");
});

test("does not expose a future candle to the strategy", () => {
  let maximumSeen = 0;
  const strategy: BacktestStrategy = {
    onCandle(candles) {
      const latest = candles.at(-1)!;
      maximumSeen = Math.max(maximumSeen, ...candles.map((candle) => candle.timeMs));
      assert.equal(maximumSeen, latest.timeMs);
      return null;
    }
  };
  runBacktest(Array.from({ length: 12 }, (_, i) => candle(sessionTime(i), 100)), strategy);
});

test("stops creating trades after the daily loss limit", () => {
  const strategy: BacktestStrategy = {
    onCandle(candles) {
      return candles.length === 1 || candles.length === 3
        ? { stopLoss: 90, target: 110 }
        : null;
    }
  };
  const rows = [
    candle(sessionTime(0), 100),
    candle(sessionTime(1), 100, 100, 80, 80),
    candle(sessionTime(2), 100),
    candle(sessionTime(3), 100, 100, 80, 80),
    candle(sessionTime(4), 100)
  ];
  const result = runBacktest(rows, strategy, { testCutoffMs: 0, dailyLossLimit: 1 });
  assert.equal(result.test.totalTrades, 1);
});
