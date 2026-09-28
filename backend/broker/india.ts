import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import https from "node:https";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";
import { malformed, numberField, requestJson, requestText } from "./http.js";
import { BrokerError, type Broker, type Holding, type HoldingsResult, type Margin, type Position, type Quote } from "./types.js";

const provider = "INDmoney";
const cacheDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../cache");
const equityCachePath = resolve(cacheDirectory, "indstocks-equity.csv");
const equityCacheDatePath = resolve(cacheDirectory, "indstocks-equity.downloaded-at");

type EquityInstrument = {
  exchange: string;
  securityId: string;
  tradingSymbol: string;
  symbolName: string;
  series: string;
};

function baseUrl(): string {
  return process.env.INDMONEY_BASE_URL ?? "https://api.indstocks.com";
}

function headers(): HeadersInit {
  const token = process.env.INDMONEY_ACCESS_TOKEN;
  if (!token) {
    throw new Error("INDMONEY_ACCESS_TOKEN is required for read-only broker calls.");
  }

  return { Authorization: token };
}

export async function getIntradayMarginForOneShare(
  securityId: string,
  price: number,
  requestImpl: MarginRequest = requestMargin
): Promise<number> {
  const data = await requestImpl({
    url: `${baseUrl()}/margin`,
    token: String(process.env.INDMONEY_ACCESS_TOKEN ?? ""),
    body: JSON.stringify({
      segment: "EQUITY",
      exchange: "NSE",
      securityID: securityId,
      txnType: "BUY",
      quantity: "1",
      price: String(price),
      product: "INTRADAY"
    })
  });
  if (!data || typeof data !== "object" || !("status" in data) || data.status !== "success" ||
      !("data" in data) || !data.data || typeof data.data !== "object") {
    throw malformed(provider, "margin response must contain status success and data");
  }
  const margin = (data.data as Record<string, unknown>).total_margin;
  return numberField(margin, provider, "margin total_margin");
}

interface MarginRequestOptions {
  url: string;
  token: string;
  body: string;
}

type MarginRequest = (options: MarginRequestOptions) => Promise<unknown>;

const requestMargin: MarginRequest = (options) => new Promise((resolve, reject) => {
  if (!options.token) {
    reject(new Error("INDMONEY_ACCESS_TOKEN is required for read-only broker calls."));
    return;
  }
  const request = https.request(options.url, {
    method: "GET",
    headers: {
      Authorization: options.token,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(options.body)
    }
  }, (response) => {
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => { body += chunk; });
    response.on("end", () => {
      if (response.statusCode === 401 || response.statusCode === 403) {
      reject(new BrokerError(`INDmoney TOKEN REJECTED / ACCESS DENIED: ${options.url}`, "AUTH_EXPIRED", response.statusCode));
        return;
      }
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        reject(new Error(`INDmoney margin request failed with HTTP ${response.statusCode ?? "unknown"}.`));
        return;
      }
      try {
        resolve(JSON.parse(body) as unknown);
      } catch {
        reject(new Error("INDmoney returned malformed margin JSON."));
      }
    });
  });
  request.on("error", reject);
  request.write(options.body);
  request.end();
});

export function parseEquityInstruments(csv: string): EquityInstrument[] {
  let skippedRows = 0;
  const requiredColumns = [
    "EXCH",
    "SEGMENT",
    "SECURITY_ID",
    "TRADING_SYMBOL",
    "SERIES",
    "SYMBOL_NAME"
  ];
  const records = parse(csv, {
    bom: true,
    columns: (header: string[]) => {
      const missing = requiredColumns.filter((column) => !header.includes(column));
      if (missing.length > 0) {
        throw malformed(provider, `equity instrument header is missing: ${missing.join(", ")}`);
      }
      return header;
    },
    relax_column_count: true,
    skip_empty_lines: true,
    skip_records_with_error: true,
    on_skip: () => {
      skippedRows += 1;
    }
  }) as Array<Record<string, string>>;

  const instruments: EquityInstrument[] = [];
  for (const record of records) {
    if (
      !record.EXCH ||
      !record.SEGMENT ||
      !record.SECURITY_ID ||
      !record.TRADING_SYMBOL ||
      !record.SERIES ||
      !record.SYMBOL_NAME
    ) {
      skippedRows += 1;
      continue;
    }
    instruments.push({
      exchange: record.EXCH,
      securityId: record.SECURITY_ID,
      tradingSymbol: record.TRADING_SYMBOL,
      symbolName: record.SYMBOL_NAME,
      series: record.SERIES
    });
  }

  if (skippedRows > 0) {
    console.warn(`${provider}: skipped ${skippedRows} malformed equity instrument rows.`);
  }
  const totalRows = instruments.length + skippedRows;
  if (instruments.length === 0 || skippedRows > totalRows / 2) {
    throw malformed(provider, "most equity instrument rows failed validation");
  }
  return instruments;
}

export function resolveInstrumentTokenFromRows(
  symbol: string,
  exchange: string,
  instruments: EquityInstrument[]
): string {
  const normalizedSymbol = symbol.toUpperCase();
  const normalizedExchange = exchange.toUpperCase();
  const matches = instruments.filter(
    (instrument) =>
      instrument.exchange.toUpperCase() === normalizedExchange &&
      (instrument.tradingSymbol.toUpperCase() === normalizedSymbol ||
        instrument.symbolName.toUpperCase() === normalizedSymbol)
  );
  const equityMatches = matches.filter((instrument) => instrument.series.toUpperCase() === "EQ");
  const candidates = equityMatches.length > 0 ? equityMatches : matches;

  if (candidates.length === 0) {
    throw new Error(`No INDmoney equity instrument found for ${symbol} on ${exchange}.`);
  }
  if (candidates.length > 1) {
    throw new Error(`Multiple INDmoney equity instruments found for ${symbol} on ${exchange}.`);
  }
  return `${candidates[0].exchange}_${candidates[0].securityId}`;
}

async function loadEquityInstruments(): Promise<EquityInstrument[]> {
  let cacheIsFresh = false;
  try {
    const downloadedAt = await readFile(equityCacheDatePath, "utf8");
    cacheIsFresh = Date.now() - new Date(downloadedAt.trim()).getTime() < 24 * 60 * 60 * 1000;
    await stat(equityCachePath);
  } catch {
    cacheIsFresh = false;
  }

  if (!cacheIsFresh) {
    const csv = await requestText(
      `${baseUrl()}/market/instruments?source=equity`,
      { headers: headers() },
      provider
    );
    await mkdir(cacheDirectory, { recursive: true });
    await writeFile(equityCachePath, csv, "utf8");
    await writeFile(equityCacheDatePath, new Date().toISOString(), "utf8");
  }

  return parseEquityInstruments(await readFile(equityCachePath, "utf8"));
}

export async function resolveInstrumentToken(symbol: string, exchange = "NSE"): Promise<string> {
  return resolveInstrumentTokenFromRows(symbol, exchange, await loadEquityInstruments());
}

function responseItems(data: unknown): unknown[] {
  if (Array.isArray(data)) {
    return data;
  }
  if (data && typeof data === "object" && "data" in data && Array.isArray(data.data)) {
    return data.data;
  }
  throw malformed(provider, "expected an array or data array");
}

function positionFromItem(item: unknown): Position {
  if (!item || typeof item !== "object" || !("symbol" in item)) {
    throw malformed(provider, "position symbol is missing");
  }
  const record = item as Record<string, unknown>;
  const quantity = record.quantity ?? record.qty;
  return {
    symbol: String(record.symbol),
    quantity: numberField(quantity, provider, "position quantity"),
    averagePrice: record.averagePrice === undefined
      ? undefined
      : numberField(record.averagePrice, provider, "average price")
  };
}

export function parseHoldingsResponse(data: unknown): Array<{
  symbol: string;
  securityId: string;
  quantity: number;
  averagePrice: number;
}> {
  if (!data || typeof data !== "object" || !("status" in data) || data.status !== "success" ||
      !("data" in data) || !Array.isArray(data.data)) {
    throw malformed(provider, "holdings response must contain status success and a data array");
  }

  return data.data.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw malformed(provider, `holding ${index + 1} must be an object`);
    }
    const record = item as Record<string, unknown>;
    if (typeof record.symbol !== "string" || typeof record.security_id !== "string") {
      throw malformed(provider, `holding ${index + 1} is missing symbol or security_id`);
    }
    return {
      symbol: record.symbol,
      securityId: record.security_id,
      quantity: numberField(record.total_qty, provider, "holding total_qty"),
      averagePrice: numberField(record.avg_price, provider, "holding avg_price")
    };
  });
}

export function parseLtpResponse(data: unknown, scripCode: string, symbol: string): Quote {
  if (!data || typeof data !== "object" || !("status" in data) || data.status !== "success" ||
      !("data" in data) || !data.data || typeof data.data !== "object") {
    throw malformed(provider, `LTP response is missing data for ${scripCode}`);
  }

  const entries = data.data as Record<string, unknown>;
  const value = entries[scripCode];
  if (!value || typeof value !== "object") {
    throw malformed(provider, `LTP response is missing data for ${scripCode}`);
  }
  const entry = value as Record<string, unknown>;
  const price = numberField(entry.live_price, provider, `${scripCode}.live_price`);
  if (price <= 0) {
    throw malformed(provider, `${scripCode}.live_price must be a positive number`);
  }
  return { symbol, price };
}

export async function getQuotes(symbols: string[]): Promise<Map<string, Quote>> {
  const resolved = await Promise.all(symbols.map(async (symbol) => ({
    symbol,
    scripCode: await resolveInstrumentToken(symbol)
  })));
  const data = await requestJson(
    `${baseUrl()}/market/quotes/ltp?scrip-codes=${encodeURIComponent(resolved.map((item) => item.scripCode).join(","))}`,
    { headers: headers() },
    provider
  );
  const quotes = new Map<string, Quote>();
  for (const item of resolved) quotes.set(item.symbol, parseLtpResponse(data, item.scripCode, item.symbol));
  return quotes;
}

export const indiaBroker: Broker = {
  async getQuote(symbol: string): Promise<Quote> {
    const scripCode = await resolveInstrumentToken(symbol);
    const data = await requestJson(
      `${baseUrl()}/market/quotes/ltp?scrip-codes=${encodeURIComponent(scripCode)}`,
      { headers: headers() },
      provider
    );
    return parseLtpResponse(data, scripCode, symbol);
  },

  async getHoldings(): Promise<HoldingsResult> {
    const raw = await requestJson(`${baseUrl()}/portfolio/holdings`, { headers: headers() }, provider);
    const holdings = await Promise.all(
      parseHoldingsResponse(raw).map(async (holding): Promise<Holding> => {
        const quote = await this.getQuote(holding.symbol);
        return {
          ...holding,
          currentPrice: quote.price,
          pnl: (quote.price - holding.averagePrice) * holding.quantity
        };

      })
    );
    return { holdings, raw };
  },

  async getPositions(): Promise<Position[]> {
    const [equity, derivative] = await Promise.all([
      requestJson(
        `${baseUrl()}/portfolio/positions?segment=equity&product=cnc`,
        { headers: headers() },
        provider
      ),
      requestJson(
        `${baseUrl()}/portfolio/positions?segment=derivative&product=margin`,
        { headers: headers() },
        provider
      )
    ]);
    return [...responseItems(equity), ...responseItems(derivative)].map(positionFromItem);
  },

  async getMargin(): Promise<Margin> {
    const data = await requestJson(`${baseUrl()}/funds`, { headers: headers() }, provider);
    if (!data || typeof data !== "object" || !("status" in data) || data.status !== "success" ||
        !("data" in data) || !data.data || typeof data.data !== "object" ||
        !("detailed_avl_balance" in data.data) || !data.data.detailed_avl_balance ||
        typeof data.data.detailed_avl_balance !== "object") {
      throw malformed(provider, "funds response is missing a successful detailed_avl_balance object");
    }

    const funds = data.data as Record<string, unknown>;
    const detailed = funds.detailed_avl_balance as Record<string, unknown>;
    const eqCnc = numberField(detailed.eq_cnc, provider, "eq_cnc");
    const eqMis = numberField(detailed.eq_mis, provider, "eq_mis");
    const optionBuy = numberField(detailed.option_buy, provider, "option_buy");

    return {
      currency: "INR",
      available: eqCnc,
      intradayAvailable: eqMis,
      derivativeAvailable: optionBuy,
      raw: data
    };
  }
};

export async function getRawPositions(): Promise<unknown> {
  const [equity, derivative] = await Promise.all([
    requestJson(
      `${baseUrl()}/portfolio/positions?segment=equity&product=cnc`,
      { headers: headers() },
      provider
    ),
    requestJson(
      `${baseUrl()}/portfolio/positions?segment=derivative&product=margin`,
      { headers: headers() },
      provider
    )
  ]);
  return { equity, derivative };
}
