const paperTradingValue = process.env.PAPER_TRADING;

if (paperTradingValue !== "true" && paperTradingValue !== "false") {
  throw new Error(
    "PAPER_TRADING must be explicitly set to exactly true or false."
  );
}

export const PAPER_TRADING = paperTradingValue === "true";

const maxTradingCapitalValue = process.env.MAX_TRADING_CAPITAL;
export const MAX_TRADING_CAPITAL = maxTradingCapitalValue === undefined
  ? 500
  : Number(maxTradingCapitalValue);

if (!Number.isFinite(MAX_TRADING_CAPITAL) || MAX_TRADING_CAPITAL < 0) {
  throw new Error("MAX_TRADING_CAPITAL must be a non-negative number.");
}

export const BACKTEST_SLIPPAGE_RATE = 0.0005;
export const BACKTEST_DAILY_LOSS_LIMIT = 50;
export const BACKTEST_TEST_MONTHS = 8;
export const INTRADAY_MARGIN_ESTIMATE_RATE = 0.2;

export const SIGNAL_MAX_TRADES_PER_DAY = 1;
export const SIGNAL_DAILY_LOSS_LIMIT = 25;
export const SIGNAL_MIN_ORDER_VALUE = 1500;
export const SIGNAL_TARGET_ORDER_VALUE = 2250;
export const SIGNAL_MAX_ORDER_VALUE = 2500;
export const SIGNAL_SKIP_PRICE_BUFFER = 0.002;
export const SIGNAL_NIFTY_GAP_LIMIT_PERCENT = 1;
export const SIGNAL_CONFIRMATION_TIMEOUT_MS = 2 * 60 * 1000;
