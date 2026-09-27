export const ORB_CONFIG = {
  openingCandles: 3,
  openingRangeMinPercent: 0.3,
  openingRangeMaxPercent: 1.5,
  noEntryAfter: "14:30",
  forcedExitAt: "15:10",
  riskReward: 2,
  maximumTradesPerStockPerDay: 1,
  maximumTradesAcrossStocksPerDay: 2,
  maximumRiskRupees: 25,
  marginEstimateRate: 0.2,
  slippageRate: 0.0005
} as const;
