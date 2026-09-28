import assert from "node:assert/strict";
import { test } from "node:test";
import type { Candle } from "../data/historical.js";
import { calculateOpeningRange, getOrbSignal, quantityForOrb, runOrbBacktest } from "./orb.js";

function candle(minutes: number, open: number, high = open, low = open, close = open): Candle {
  const hour = 9 + Math.floor((15 + minutes) / 60);
  const minute = (15 + minutes) % 60;
  return { scripCode: "TEST", interval: "5minute", timeMs: new Date(`2025-01-02T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+05:30`).getTime(), open, high, low, close, volume: 100 };
}

test("calculates the first three-candle opening range", () => {
  const range = calculateOpeningRange([candle(0, 100, 102, 99), candle(5, 101, 103, 100), candle(10, 102, 104, 101)]);
  assert.deepEqual(range, { high: 104, low: 99, referencePrice: 100 });
});

test("signals only after a candle closes outside the range", () => {
  const range = { high: 104, low: 99, referencePrice: 100 };
  assert.equal(getOrbSignal([candle(0, 100), candle(5, 100), candle(10, 100), candle(15, 104, 104, 103, 104)], range), null);
  assert.equal(getOrbSignal([candle(0, 100), candle(5, 100), candle(10, 100), candle(15, 104, 105, 103, 105)], range)?.side, "long");
  assert.equal(getOrbSignal([candle(0, 100), candle(5, 100), candle(10, 100), candle(15, 98, 100, 98, 98)], range)?.side, "short");
});

test("sets long stop at range low and target at two times risk", () => {
  const signal = getOrbSignal([candle(0, 100), candle(5, 100), candle(10, 100), candle(15, 105, 106, 104, 105)], { high: 104, low: 99, referencePrice: 100 });
  assert.equal(signal?.stopLoss, 99);
  assert.equal(signal?.target, 117);
});

test("does not signal again while price remains outside the range", () => {
  const rows = [
    candle(0, 100),
    candle(5, 100),
    candle(10, 105, 106, 104, 105),
    candle(15, 105, 106, 104, 105)
  ];
  assert.equal(getOrbSignal(rows, { high: 104, low: 99, referencePrice: 100 }, 3), null);
});

test("risk cap reduces quantity", () => {
  const sizing = quantityForOrb(100, 90);
  assert.equal(sizing.quantity, 2);
  assert.equal(sizing.riskCapped, true);
});

test("caps at two trades across stocks per day", () => {
  const rows = Array.from({ length: 20 }, (_, index) => candle(index * 5, index < 3 ? 100 : index === 3 ? 101 : 100, index < 3 ? 100.5 : 101, index < 3 ? 99.5 : 100, index < 3 ? 100 : index === 3 ? 101 : 100));
  const data = new Map([["A", rows], ["B", rows], ["C", rows]]);
  const result = runOrbBacktest(data, 0);
  assert.equal(result.totalTest.trades.length, 2);
});
