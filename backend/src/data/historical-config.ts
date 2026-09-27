export const HISTORICAL_INTERVAL_LIMIT_MS = {
  "1minute": 7 * 24 * 60 * 60 * 1000,
  "2minute": 7 * 24 * 60 * 60 * 1000,
  "3minute": 7 * 24 * 60 * 60 * 1000,
  "4minute": 7 * 24 * 60 * 60 * 1000,
  "5minute": 7 * 24 * 60 * 60 * 1000,
  "10minute": 7 * 24 * 60 * 60 * 1000,
  "15minute": 7 * 24 * 60 * 60 * 1000,
  "30minute": 7 * 24 * 60 * 60 * 1000,
  "60minute": 15 * 24 * 60 * 60 * 1000,
  "120minute": 15 * 24 * 60 * 60 * 1000,
  "180minute": 15 * 24 * 60 * 60 * 1000,
  "240minute": 15 * 24 * 60 * 60 * 1000,
  "1day": 365 * 24 * 60 * 60 * 1000,
  "1week": 365 * 24 * 60 * 60 * 1000,
  "1month": 365 * 24 * 60 * 60 * 1000
} as const;

export type HistoricalInterval = keyof typeof HISTORICAL_INTERVAL_LIMIT_MS;
