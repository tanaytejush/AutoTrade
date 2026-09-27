import Database from "better-sqlite3";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveInstrumentToken } from "../../broker/india.js";
import { BrokerError } from "../../broker/types.js";
import {
  HISTORICAL_INTERVAL_LIMIT_MS,
  type HistoricalInterval
} from "./historical-config.js";
import { isNseMuhuratDate, NSE_HOLIDAYS_BY_YEAR } from "./nse-holidays.js";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const REQUEST_SPACING_MS = 250;
const MAX_RETRIES = 5;
const cachePath = resolve(dirname(fileURLToPath(import.meta.url)), "../../cache/market-data.sqlite");
const istDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

export interface Candle {
  scripCode: string;
  interval: HistoricalInterval;
  timeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface HistoricalRequest {
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  databasePath?: string;
  resolveInstrumentToken?: (symbol: string) => Promise<string>;
  accessToken?: string;
}

export interface GapReport {
  missingDates: string[];
  unconfirmed: boolean;
}

export function filterCandlesForBacktest(candles: Candle[]): Candle[] {
  return candles.filter((candle) => {
    const date = istDateFormatter.format(new Date(candle.timeMs));
    return !isNseMuhuratDate(date);
  });
}

function getDatabase(path: string): Database.Database {
  const database = new Database(path);
  database.exec(`
    CREATE TABLE IF NOT EXISTS market_candles (
      scrip_code TEXT NOT NULL,
      interval TEXT NOT NULL,
      candle_time_ms INTEGER NOT NULL,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      volume REAL NOT NULL,
      PRIMARY KEY (scrip_code, interval, candle_time_ms)
    );
    CREATE TABLE IF NOT EXISTS historical_ranges (
      scrip_code TEXT NOT NULL,
      interval TEXT NOT NULL,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      PRIMARY KEY (scrip_code, interval, start_ms, end_ms)
    );
  `);
  return database;
}

function requestHeaders(accessToken?: string): HeadersInit {
  const token = accessToken ?? process.env.INDMONEY_ACCESS_TOKEN;
  if (!token) {
    throw new Error("INDMONEY_ACCESS_TOKEN is required for historical data calls.");
  }
  return { Authorization: token };
}

function epochMilliseconds(date: Date): number {
  const value = date.getTime();
  if (!Number.isFinite(value)) {
    throw new Error("Invalid historical date.");
  }
  return value;
}

function splitRange(startMs: number, endMs: number, limitMs: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (let cursor = startMs; cursor < endMs; cursor += limitMs) {
    ranges.push([cursor, Math.min(cursor + limitMs, endMs)]);
  }
  return ranges;
}

function validateCandle(
  raw: unknown,
  scripCode: string,
  interval: HistoricalInterval,
  startMs: number,
  endMs: number
): Candle {
  if (!raw || typeof raw !== "object") {
    throw new Error("Historical response contains a non-object candle.");
  }
  const record = raw as Record<string, unknown>;
  const timestampSeconds = typeof record.ts === "number" ? record.ts : Number(record.ts);
  const timeMs = timestampSeconds * 1000;
  if (!Number.isFinite(timeMs) || timeMs < startMs || timeMs >= endMs) {
    throw new Error(`Historical candle timestamp ${String(record.ts)} is outside the requested range.`);
  }
  const number = (field: string): number => {
    const value = typeof record[field] === "number" ? record[field] : Number(record[field]);
    if (!Number.isFinite(value)) {
      throw new Error(`Historical candle field ${field} is not numeric.`);
    }
    return value;
  };
  return {
    scripCode,
    interval,
    timeMs,
    open: number("o"),
    high: number("h"),
    low: number("l"),
    close: number("c"),
    volume: number("v")
  };
}

class RequestThrottle {
  private nextRequestAt = 0;

  constructor(private readonly sleep: (milliseconds: number) => Promise<void>) {}

  async wait(): Promise<void> {
    const delay = Math.max(0, this.nextRequestAt - Date.now());
    if (delay > 0) {
      await this.sleep(delay);
    }
    this.nextRequestAt = Math.max(Date.now(), this.nextRequestAt) + REQUEST_SPACING_MS;
  }
}

async function fetchWindow(
  scripCode: string,
  interval: HistoricalInterval,
  startMs: number,
  endMs: number,
  request: HistoricalRequest,
  throttle: RequestThrottle
): Promise<Candle[]> {
  const doFetch = request.fetch ?? fetch;
  const sleep = request.sleep ?? ((milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)));
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    await throttle.wait();
    const baseUrl = process.env.INDMONEY_BASE_URL ?? "https://api.indstocks.com";
    const url = `${baseUrl}/market/historical/${interval}?scrip-codes=${encodeURIComponent(scripCode)}&start_time=${startMs}&end_time=${endMs}`;
    const response = await doFetch(url, { headers: requestHeaders(request.accessToken) });
    if (response.status === 429) {
      if (attempt === MAX_RETRIES) {
        throw new BrokerError("INDmoney historical data rate limit persisted after 5 attempts.", "RATE_LIMITED", 429);
      }
      await sleep(250 * 2 ** (attempt - 1));
      continue;
    }
    if (!response.ok) {
      throw new BrokerError(`INDmoney historical request failed with HTTP ${response.status}.`, "REQUEST_FAILED", response.status);
    }
    const data = await response.json() as unknown;
    if (!data || typeof data !== "object" || !("success" in data) || data.success !== true ||
        !("data" in data) || !data.data || typeof data.data !== "object" ||
        !(scripCode in data.data)) {
      throw new Error(`Historical response is missing data for ${scripCode}.`);
    }
    const entries = data.data as Record<string, unknown>;
    const entry = entries[scripCode];
    if (!entry || typeof entry !== "object") {
      throw new Error(`Historical response is missing candles for ${scripCode}.`);
    }
    if (!("candles" in entry)) return [];
    if (entry.candles === null) return [];
    if (!Array.isArray(entry.candles)) {
      throw new Error(`Historical response contains invalid candles for ${scripCode}.`);
    }
    return entry.candles.map((candle: unknown) => validateCandle(candle, scripCode, interval, startMs, endMs));
  }
  throw new Error("Historical request retry loop ended unexpectedly.");
}

function uncoveredRanges(
  database: Database.Database,
  scripCode: string,
  interval: HistoricalInterval,
  startMs: number,
  endMs: number
): Array<[number, number]> {
  const rows = database.prepare(
    "SELECT start_ms AS startMs, end_ms AS endMs FROM historical_ranges WHERE scrip_code = ? AND interval = ? AND end_ms > ? AND start_ms < ? ORDER BY start_ms"
  ).all(scripCode, interval, startMs, endMs) as Array<{ startMs: number; endMs: number }>;
  const missing: Array<[number, number]> = [];
  let cursor = startMs;
  for (const row of rows) {
    if (row.startMs > cursor) {
      missing.push([cursor, Math.min(row.startMs, endMs)]);
    }
    cursor = Math.max(cursor, row.endMs);
    if (cursor >= endMs) break;
  }
  if (cursor < endMs) missing.push([cursor, endMs]);
  return missing;
}

export async function fetchCandles(
  symbol: string,
  interval: HistoricalInterval,
  startDate: Date,
  endDate: Date,
  request: HistoricalRequest = {}
): Promise<Candle[]> {
  const startMs = epochMilliseconds(startDate);
  const endMs = epochMilliseconds(endDate);
  if (startMs >= endMs) throw new Error("Historical start date must be before end date.");
  const resolveToken = request.resolveInstrumentToken ?? resolveInstrumentToken;
  const scripCode = await resolveToken(symbol);
  const sleep = request.sleep ?? ((milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)));
  const throttle = new RequestThrottle(sleep);
  const database = getDatabase(request.databasePath ?? cachePath);
  try {
    const missing = uncoveredRanges(database, scripCode, interval, startMs, endMs);
    const windows = missing.flatMap(([start, end]) =>
      splitRange(start, end, HISTORICAL_INTERVAL_LIMIT_MS[interval])
    );
    const insert = database.prepare(
      "INSERT OR REPLACE INTO market_candles VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const markRange = database.prepare(
      "INSERT OR REPLACE INTO historical_ranges VALUES (?, ?, ?, ?)"
    );
    const transaction = database.transaction((candles: Candle[], start: number, end: number) => {
      for (const candle of candles) {
        insert.run(candle.scripCode, candle.interval, candle.timeMs, candle.open, candle.high, candle.low, candle.close, candle.volume);
      }
      markRange.run(scripCode, interval, start, end);
    });
    for (const [start, end] of windows) {
      const candles = await fetchWindow(scripCode, interval, start, end, request, throttle);
      transaction(candles, start, end);
    }

    return database.prepare(
      "SELECT scrip_code AS scripCode, interval, candle_time_ms AS timeMs, open, high, low, close, volume FROM market_candles WHERE scrip_code = ? AND interval = ? AND candle_time_ms >= ? AND candle_time_ms < ? ORDER BY candle_time_ms"
    ).all(scripCode, interval, startMs, endMs) as Candle[];
  } finally {
    database.close();
  }
}

export async function getCachedCandles(
  symbol: string,
  interval: HistoricalInterval,
  startDate: Date,
  endDate: Date,
  request: Pick<HistoricalRequest, "databasePath" | "resolveInstrumentToken"> = {}
): Promise<Candle[]> {
  const startMs = epochMilliseconds(startDate);
  const endMs = epochMilliseconds(endDate);
  const resolveToken = request.resolveInstrumentToken ?? resolveInstrumentToken;
  const scripCode = await resolveToken(symbol);
  const database = getDatabase(request.databasePath ?? cachePath);
  try {
    return database.prepare(
      "SELECT scrip_code AS scripCode, interval, candle_time_ms AS timeMs, open, high, low, close, volume FROM market_candles WHERE scrip_code = ? AND interval = ? AND candle_time_ms >= ? AND candle_time_ms < ? ORDER BY candle_time_ms"
    ).all(scripCode, interval, startMs, endMs) as Candle[];
  } finally {
    database.close();
  }
}

export function checkDailyGaps(candles: Candle[], startDate: Date, endDate: Date): GapReport {
  const dates = new Set(candles.map((candle) => new Date(candle.timeMs).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })));
  const missingDates: string[] = [];
  const start = new Date(startDate.getTime() + IST_OFFSET_MS);
  const end = new Date(endDate.getTime() + IST_OFFSET_MS);
  for (let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())); cursor < end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const day = cursor.getUTCDay();
    const date = cursor.toISOString().slice(0, 10);
    const holidays = NSE_HOLIDAYS_BY_YEAR[cursor.getUTCFullYear()] ?? [];
    if (day !== 0 && day !== 6 && !holidays.includes(date) &&
        !isNseMuhuratDate(date) && !dates.has(date)) {
      missingDates.push(date);
    }
  }
  return { missingDates, unconfirmed: Object.keys(NSE_HOLIDAYS_BY_YEAR).length === 0 };
}
