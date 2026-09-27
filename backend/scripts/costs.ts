import { breakEvenMovePct, roundTripCost } from "../src/risk/costs.js";
import { getCachedCandles } from "../src/data/historical.js";

const symbol = process.argv[2];
const quantity = Number(process.argv[3]);
if (!symbol || !Number.isFinite(quantity) || quantity <= 0) {
  throw new Error("Usage: npm run costs --workspace backend -- ITC 10");
}
const end = new Date("2026-09-28T00:00:00+05:30");
const start = new Date("2025-08-24T00:00:00+05:30");
const candles = await getCachedCandles(symbol.toUpperCase(), "1day", start, end);
const price = candles.at(-1)?.close;
if (price === undefined) throw new Error(`${symbol} daily data is not cached.`);
const breakdown = roundTripCost(price, quantity);
console.table(breakdown);
console.log(`Symbol: ${symbol}`);
console.log(`Break-even move: ${breakEvenMovePct(price, quantity).toFixed(4)}%`);
