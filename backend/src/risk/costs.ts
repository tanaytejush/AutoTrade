import { NSE_INTRADAY_CHARGES as rates } from "./charges.js";

export interface CostBreakdown {
  buyValue: number;
  sellValue: number;
  brokerageBuy: number;
  brokerageSell: number;
  brokerage: number;
  stt: number;
  exchangeCharges: number;
  sebiFee: number;
  stampDuty: number;
  gst: number;
  total: number;
}

function brokerage(orderValue: number): number {
  return Math.max(
    rates.brokerageMinimumRupees,
    Math.min(rates.brokerageCapRupees, orderValue * rates.brokerageRate)
  );
}

export function roundTripCost(price: number, quantity: number): CostBreakdown {
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(quantity) || quantity <= 0) {
    throw new Error("Price and quantity must be positive finite numbers.");
  }
  const value = price * quantity;
  const brokerageBuy = brokerage(value);
  const brokerageSell = brokerage(value);
  const exchangeCharges = value * 2 * rates.exchangeTransactionRate;
  const sebiFee = value * 2 * rates.sebiFeePerCrore / 1_00_00_000;
  const stampDuty = value * rates.stampDutyBuyRate;
  const stt = value * rates.sttSellRate;
  const gst = (brokerageBuy + brokerageSell + exchangeCharges + sebiFee) * rates.gstRate;
  return {
    buyValue: value,
    sellValue: value,
    brokerageBuy,
    brokerageSell,
    brokerage: brokerageBuy + brokerageSell,
    stt,
    exchangeCharges,
    sebiFee,
    stampDuty,
    gst,
    total: brokerageBuy + brokerageSell + stt + exchangeCharges + sebiFee + stampDuty + gst
  };
}

export function breakEvenMovePct(price: number, quantity: number): number {
  return roundTripCost(price, quantity).total / (price * quantity) * 100;
}
