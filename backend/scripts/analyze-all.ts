import "dotenv/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadNifty50 } from "../src/data/universe/nifty50.js";
import { resolveInstrumentToken, getIntradayMarginForOneShare, indiaBroker } from "../broker/india.js";
import { fetchCandles, getCachedCandles } from "../src/data/historical.js";
import { analyzeCandles, type AnalysisResult } from "../src/analysis/analyzer.js";

const universePath = resolve(fileURLToPath(new URL("../src/data/universe/nifty50.csv", import.meta.url)));
const constituents = await loadNifty50(universePath);
const end = new Date("2026-09-28T00:00:00+05:30");
const start = new Date("2025-08-24T00:00:00+05:30");
const results: Array<{ symbol: string; result: AnalysisResult }> = [];
const failures: Array<{ symbol: string; step: string; error: string }> = [];
const estimatedMarginPercent = 20;
const cacheOnly = process.env.ANALYZE_CACHE_ONLY === "true";

for (const constituent of constituents) {
  try {
    const candles = cacheOnly
      ? await getCachedCandles(constituent.symbol, "1day", start, end)
      : await fetchCandles(constituent.symbol, "1day", start, end);
    if (candles.length === 0) throw new Error("daily data is not cached");
    const token = cacheOnly ? "" : await resolveInstrumentToken(constituent.symbol);
    const quote = cacheOnly
      ? { price: candles.at(-1)!.close }
      : await indiaBroker.getQuote(constituent.symbol);
    const securityId = token.split("_")[1];
    let margin: number;
    let marginLabel = "live";
    try {
      if (cacheOnly) throw new Error("cache-only run: margin estimate required");
      margin = await getIntradayMarginForOneShare(securityId, quote.price);
      if (!Number.isFinite(margin) || margin <= 0) throw new Error("margin returned zero or a non-positive value");
    } catch (error) {
      margin = quote.price * estimatedMarginPercent / 100;
      marginLabel = `estimate (${estimatedMarginPercent}%)`;
      failures.push({
        symbol: constituent.symbol,
        step: "margin (estimate used)",
        error: error instanceof Error ? error.message : String(error)
      });
    }
    const result = analyzeCandles(constituent.symbol, candles, {
      currentPrice: quote.price,
      marginForOneShare: margin
    });
    results.push({ symbol: constituent.symbol, result: { ...result, marginLabel } as AnalysisResult & { marginLabel: string } });
  } catch (error) {
    failures.push({
      symbol: constituent.symbol,
      step: "resolution/history/quote",
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

const order = { TRADEABLE: 0, WATCH: 1, AVOID: 2 };
function inr(value: number | null): string {
  if (value === null) return "n/a";
  if (value >= 1_00_00_000) return `₹${(value / 1_00_00_000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} Cr`;
  if (value < 1_00_000) return `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
  return `₹${(value / 1_00_000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} L`;
}
console.table(results
  .sort((a, b) => order[a.result.verdict] - order[b.result.verdict])
  .map(({ symbol, result }) => ({
    symbol,
    price: result.metrics.currentPrice,
    verdict: result.verdict,
    averageTradedValue: inr(result.metrics.averageDailyTradedValueRupees20),
    range20Percent: result.metrics.averageDailyRangePercent20.toFixed(2),
    marginOneShare: `${inr(result.metrics.marginForOneShare)} (${(result as AnalysisResult & { marginLabel?: string }).marginLabel ?? "live"})`,
    topReason: result.reasons[0] ?? "None"
  })));
const counts = results.reduce((summary, item) => {
  summary[item.result.verdict] += 1;
  if (item.result.verdict === "AVOID" &&
      item.result.reasons.length === 1 &&
      item.result.reasons[0] === "Can't afford 1 share at current capital") {
    summary.unaffordable += 1;
  }
  return summary;
}, { TRADEABLE: 0, WATCH: 0, AVOID: 0, unaffordable: 0 });
console.log("Summary:", counts);
console.log("Failures:", failures.length > 0 ? failures : "None");
