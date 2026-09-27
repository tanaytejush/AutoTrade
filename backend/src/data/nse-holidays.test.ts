import assert from "node:assert/strict";
import { test } from "node:test";
import { isNormalTradingDay } from "./nse-holidays.js";

test("recognizes a normal weekday", () => {
  assert.equal(isNormalTradingDay("2025-09-29"), true);
});

test("rejects Saturday", () => {
  assert.equal(isNormalTradingDay("2025-09-27"), false);
});

test("rejects an NSE holiday", () => {
  assert.equal(isNormalTradingDay("2025-10-02"), false);
});

test("rejects a Muhurat date", () => {
  assert.equal(isNormalTradingDay("2025-10-21"), false);
});
