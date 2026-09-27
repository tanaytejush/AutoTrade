export const ANALYZER_THRESHOLDS = {
  // Fewer than three months of sessions is too little context for the analyzer.
  minimumHistoryDays: 60,
  // ₹50 crore/day is a conservative minimum for practical entry/exit liquidity.
  minimumAverageTradedValueRupees: 50_00_00_000,
  // Below 0.25% average daily range, normal transaction costs can dominate movement.
  minimumAverageDailyRangePercent: 0.25,
  // More than one in ten sessions with a >1% overnight gap is elevated gap risk.
  maximumGapRiskPercent: 10,
  // Exposed as a review threshold for unusually wide daily ranges.
  maximumVolatilityPercent: 5,
  costFitRangeMultiplier: 3,
  // Small deviations are noise; larger deviations from both averages merit review.
  movingAverageTolerancePercent: 1
} as const;
