import dotenv from "dotenv";

dotenv.config();

const paperTradingValue = process.env.PAPER_TRADING;

if (paperTradingValue !== "true" && paperTradingValue !== "false") {
  throw new Error(
    "PAPER_TRADING must be explicitly set to exactly true or false."
  );
}

export const PAPER_TRADING = paperTradingValue === "true";
