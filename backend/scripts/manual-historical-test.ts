import "dotenv/config";
import { fetchCandles, checkDailyGaps, type Candle } from "../src/data/historical.js";

const IST = "Asia/Kolkata";
const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: IST,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

function istDate(value: Date): string {
  return dateFormatter.format(value);
}

function atIstMidnight(date: string): Date {
  return new Date(`${date}T00:00:00+05:30`);
}

function addDays(date: string, days: number): string {
  const value = atIstMidnight(date);
  value.setUTCDate(value.getUTCDate() + days);
  return istDate(value);
}

function subtractMonths(date: string, months: number): string {
  const value = atIstMidnight(date);
  value.setUTCMonth(value.getUTCMonth() - months);
  return istDate(value);
}

function candleDate(candle: Candle): string {
  return istDate(new Date(candle.timeMs));
}

function candleTime(candle: Candle): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: IST,
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(candle.timeMs));
}

const today = istDate(new Date());
const tomorrow = addDays(today, 1);
const yearAgo = subtractMonths(today, 12);

const daily = await fetchCandles("RELIANCE", "1day", atIstMidnight(yearAgo), atIstMidnight(tomorrow));
const dailyDates = daily.map(candleDate);
const dailyGaps = checkDailyGaps(daily, atIstMidnight(yearAgo), atIstMidnight(tomorrow));
console.log(JSON.stringify({
  daily: {
    rowCount: daily.length,
    firstDate: dailyDates[0] ?? null,
    lastDate: dailyDates.at(-1) ?? null,
    lastClose: daily.at(-1)?.close ?? null,
    gaps: dailyGaps.missingDates,
    gapsUnconfirmed: dailyGaps.unconfirmed
  }
}, null, 2));

const fiveMinuteStart = addDays(today, -7);
const fiveMinute = await fetchCandles("RELIANCE", "5minute", atIstMidnight(fiveMinuteStart), atIstMidnight(tomorrow));
const byDay = new Map<string, Candle[]>();
for (const candle of fiveMinute) {
  const date = candleDate(candle);
  const rows = byDay.get(date) ?? [];
  rows.push(candle);
  byDay.set(date, rows);
}
const fiveMinuteDays = [...byDay.entries()].slice(-5).map(([date, rows]) => ({
  date,
  rowCount: rows.length,
  firstTime: candleTime(rows[0]),
  lastTime: candleTime(rows.at(-1)!)
}));
console.log(JSON.stringify({ fiveMinute: fiveMinuteDays }, null, 2));

const lookbacks: Array<{ months: number; count: number | null }> = [];
for (const months of [3, 6, 12, 24]) {
  const start = subtractMonths(today, months);
  const end = addDays(start, 7);
  const rows = await fetchCandles("RELIANCE", "5minute", atIstMidnight(start), atIstMidnight(end));
  lookbacks.push({ months, count: rows.length });
  if (rows.length === 0) break;
}
console.log(JSON.stringify({ lookbacks }, null, 2));
