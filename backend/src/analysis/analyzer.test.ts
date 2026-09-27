import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeCandles } from "./analyzer.js";

function candles(count: number, close: (index: number) => number, volume = 1_000_000) {
  const dates: number[] = [];
  let day = 1;
  while (dates.length < count) {
    const date = new Date(Date.UTC(2025, 0, day));
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) dates.push(date.getTime());
    day += 1;
  }
  return dates.map((timeMs, index) => {
    const value = close(index);
    return {
      scripCode: "NSE_TEST",
      interval: "1day" as const,
      timeMs,
      open: value,
      high: value * 1.01,
      low: value * 0.99,
      close: value,
      volume
    };
  });
}

test("returns TRADEABLE for liquid stable data", () => {
  const data = candles(80, () => 1000, 10_000_000).map((candle) => ({
    ...candle,
    high: 1020,
    low: 980
  }));
  assert.equal(analyzeCandles("TEST", data).verdict, "TRADEABLE");
});

test("returns WATCH for sufficient but gappy data", () => {
  const data = candles(80, (index) => index % 2 === 0 ? 100 : 98, 10_000_000);
  assert.equal(analyzeCandles("TEST", data).verdict, "WATCH");
});

test("returns AVOID for insufficient history", () => {
  const result = analyzeCandles("TEST", candles(30, () => 100));
  assert.equal(result.verdict, "AVOID");
  assert.ok(result.reasons.includes("Not enough history"));
});

test("calculates one-month return from the prior calendar date", () => {
  const result = analyzeCandles("TEST", candles(30, (index) => index < 9 ? 100 : 110, 10_000_000));
  assert.ok(Math.abs(result.metrics.returns["1Month"]! - 10) < 0.000001);
});

test("returns AVOID for very low traded value", () => {
  const result = analyzeCandles("TEST", candles(80, () => 100, 1_000));
  assert.equal(result.verdict, "AVOID");
  assert.ok(result.reasons.includes("Average daily traded value below ₹50 crore"));
});

test("uses calendar dates and nearest prior candle for one-year return", () => {
  const data = candles(500, (index) => index < 250 ? 100 : 110, 10_000_000);
  const result = analyzeCandles("TEST", data);
  assert.ok(Math.abs(result.metrics.returns["1Year"]! - 10) < 0.000001);
});

test("trend information does not change the verdict", () => {
  const data = candles(80, (index) => index < 40 ? 1000 : 2000, 10_000_000);
  const result = analyzeCandles("TEST", data);
  assert.equal(result.verdict, "TRADEABLE");
  assert.equal(result.reasons.some((reason) => reason.includes("moving averages")), false);
});

test("marks a stock unaffordable when one-share margin exceeds capital", () => {
  const result = analyzeCandles("TEST", candles(80, () => 100, 10_000_000), {
    marginForOneShare: 501
  });
  assert.equal(result.verdict, "AVOID");
  assert.ok(result.reasons.includes("Can't afford 1 share at current capital"));
});

test("drawdown uses only the fixed one-year window", () => {
  const data = candles(600, (index) => index === 0 ? 1_000 : 100, 10_000_000);
  const result = analyzeCandles("TEST", data);
  assert.ok(result.metrics.maxDrawdownPercent < 1);
});

test("flags a daily range that is below three times break-even cost", () => {
  const result = analyzeCandles("TEST", candles(80, () => 100, 10_000_000));
  assert.equal(result.verdict, "WATCH");
  assert.ok(result.reasons.includes("Daily move too small to beat costs"));
});
