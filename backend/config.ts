import dotenv from "dotenv";

dotenv.config();

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
