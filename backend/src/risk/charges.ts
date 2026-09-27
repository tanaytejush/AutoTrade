export const NSE_INTRADAY_CHARGES = {
  // Starting value supplied for confirmation against INDmoney pricing; last verified: 2026-09-27.
  brokerageRate: 0.001,
  brokerageCapRupees: 20,
  brokerageMinimumRupees: 2,
  // Starting value from the user's INDmoney/NSE charge specification; last verified: 2026-09-27.
  sttSellRate: 0.00025,
  exchangeTransactionRate: 0.0000297,
  sebiFeePerCrore: 10,
  stampDutyBuyRate: 0.00003,
  gstRate: 0.18
} as const;
