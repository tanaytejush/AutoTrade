import "dotenv/config";
import { fetchCandles } from "../src/data/historical.js";
import { isNormalTradingDay, NSE_HOLIDAYS_BY_YEAR, isNseMuhuratDate } from "../src/data/nse-holidays.js";
import type { Candle } from "../src/data/historical.js";

const symbols = [
  "CIPLA", "HINDUNILVR", "ICICIBANK", "NESTLEIND",
  "RELIANCE", "SBILIFE", "SUNPHARMA", "TATACONSUM"
];
const end = new Date();
const start = new Date(end.getTime() - 2 * 365 * 24 * 60 * 60 * 1000);

function istDate(timeMs: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(timeMs));
}

function report(symbol: string, candles: Candle[]): void {
  const byDate = new Map<string, Candle[]>();
  for (const candle of candles) {
    const date = istDate(candle.timeMs);
    const rows = byDate.get(date) ?? [];
    rows.push(candle);
    byDate.set(date, rows);
  }
  const incomplete: Array<{ date: string; count: number }> = [];
  for (const [date, rows] of byDate) {
    if (isNormalTradingDay(date) && rows.length < 75) incomplete.push({ date, count: rows.length });
  }
  const expectedMissing: string[] = [];
  for (let cursor = new Date(start); cursor < end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = istDate(cursor.getTime());
    if (isNormalTradingDay(date) && !byDate.has(date)) expectedMissing.push(date);
  }
  console.log(JSON.stringify({
    symbol,
    candles: candles.length,
    firstDate: candles.length ? istDate(candles[0].timeMs) : null,
    lastDate: candles.length ? istDate(candles.at(-1)!.timeMs) : null,
    incompleteDays: incomplete,
    possibleHolidayGaps: expectedMissing.filter((date) => !(NSE_HOLIDAYS_BY_YEAR[Number(date.slice(0, 4))] ?? []).includes(date) && !isNseMuhuratDate(date))
  }, null, 2));
}

for (const symbol of symbols) {
  try {
    const candles = await fetchCandles(symbol, "5minute", start, end);
    report(symbol, candles);
  } catch (error) {
    console.error(`FAILED ${symbol}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
