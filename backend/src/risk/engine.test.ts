import assert from "node:assert/strict";
import { test } from "node:test";
import { checkTrade, type RiskOrder, type RiskState } from "./engine.js";

const order: RiskOrder = { symbol: "CIPLA", entryPrice: 100, stopLoss: 99, target: 120, quantity: 1 };
const state: RiskState = { eqMis: 1000, openPositions: 0, tradesToday: 0, dailyLoss: 0 };
const at = (hour: number, minute: number) => new Date(2026, 8, 28, hour, minute);

test("allows a paper trade within all limits", () => assert.equal(checkTrade(order, state, at(10, 0)).decision, "allow"));
for (const [name, update, reason] of [
  ["capital", { eqMis: 0 }, "capital"],
  ["open position", { openPositions: 1 }, "position"],
  ["daily trades", { tradesToday: 2 }, "trade limit"],
  ["daily loss", { dailyLoss: -50 }, "loss limit"],
  ["late entry", {}, "after 14:30"],
  ["risk cap", {}, "risk"],
  ["cost check", {}, "break-even"]
] as const) {
  test(`blocks ${name}`, () => {
    const candidate = name === "late entry" ? order
      : name === "risk cap" ? { ...order, stopLoss: 0 }
      : name === "cost check" ? { ...order, target: 100.01 }
      : order;
    const candidateState = { ...state, ...update };
    const result = checkTrade(candidate, candidateState, name === "late entry" ? at(14, 31) : at(10, 0));
    assert.match(result.reason, new RegExp(reason, "i"));
  });
}
