import assert from "node:assert/strict";
import { test } from "node:test";
import { breakEvenMovePct, roundTripCost } from "./costs.js";

test("calculates the ₹500 round-trip cost", () => {
  const cost = roundTripCost(500, 1);
  assert.equal(cost.brokerage, 4);
  assert.equal(cost.stt, 0.125);
  assert.equal(cost.exchangeCharges, 0.0297);
  assert.equal(cost.sebiFee, 0.001);
  assert.ok(Math.abs(cost.stampDuty - 0.015) < 1e-12);
  assert.ok(Math.abs(cost.gst - 0.725526) < 1e-12);
  assert.ok(Math.abs(cost.total - 4.896226) < 1e-12);
});

test("calculates the ₹2,500 round-trip cost", () => {
  const cost = roundTripCost(2500, 1);
  assert.equal(cost.brokerage, 5);
  assert.equal(cost.stt, 0.625);
  assert.equal(cost.exchangeCharges, 0.1485);
  assert.equal(cost.sebiFee, 0.005);
  assert.ok(Math.abs(cost.stampDuty - 0.075) < 1e-12);
  assert.ok(Math.abs(cost.gst - 0.92763) < 1e-12);
  assert.ok(Math.abs(cost.total - 6.78113) < 1e-12);
});

test("applies the ₹2 minimum brokerage on small orders", () => {
  assert.equal(roundTripCost(10, 1).brokerage, 4);
  assert.ok(breakEvenMovePct(10, 1) > 0);
});
