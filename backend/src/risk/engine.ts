import { MAX_TRADING_CAPITAL } from "../../config.js";
import { assertPaperMode } from "../executionGuard.js";
import { breakEvenMovePct } from "./costs.js";

export interface RiskOrder {
  symbol: string;
  entryPrice: number;
  stopLoss: number;
  target: number;
  quantity: number;
}

export interface RiskState {
  eqMis: number;
  openPositions: number;
  tradesToday: number;
  dailyLoss: number;
}

export interface TradeDecision {
  decision: "allow" | "block";
  reason: string;
  usableCapital: number;
}

export function checkTrade(order: RiskOrder, state: RiskState, now = new Date()): TradeDecision {
  assertPaperMode();
  const usableCapital = Math.min(MAX_TRADING_CAPITAL, state.eqMis);
  if (usableCapital <= 0) return { decision: "block", reason: "No usable intraday capital", usableCapital };
  if (state.openPositions >= 1) return { decision: "block", reason: "Maximum one open position", usableCapital };
  if (state.tradesToday >= 2) return { decision: "block", reason: "Daily trade limit reached", usableCapital };
  if (state.dailyLoss <= -50) return { decision: "block", reason: "Daily loss limit reached", usableCapital };
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (minutes > 14 * 60 + 30) return { decision: "block", reason: "No entries after 14:30", usableCapital };
  if (order.quantity <= 0 || order.quantity * Math.abs(order.entryPrice - order.stopLoss) > 25) {
    return { decision: "block", reason: "Risk per trade exceeds ₹25", usableCapital };
  }
  const targetMove = Math.abs(order.target - order.entryPrice) / order.entryPrice * 100;
  if (targetMove < 2 * breakEvenMovePct(order.entryPrice, order.quantity)) {
    return { decision: "block", reason: "Target move is below 2x break-even move", usableCapital };
  }
  if (order.entryPrice * order.quantity > usableCapital / 0.2) {
    return { decision: "block", reason: "Position exceeds usable intraday capital", usableCapital };
  }
  return { decision: "allow", reason: "Risk checks passed", usableCapital };
}
