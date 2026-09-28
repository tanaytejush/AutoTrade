import { fetchCandles } from "../src/data/historical.js";
import { runSignalMode, type SignalApi } from "../src/orchestrator/signal.js";
import { getQuotes, getRawPositions, indiaBroker, resolveInstrumentToken } from "../broker/india.js";

const api: SignalApi = {
  funds: () => indiaBroker.getMargin(),
  quote: (symbol) => indiaBroker.getQuote(symbol),
  quoteBatch: async (symbols) => new Map([...await getQuotes(symbols)].map(([symbol, quote]) => [
    symbol,
    { price: quote.price, timestamp: quote.timestamp }
  ])),
  resolve: resolveInstrumentToken,
  candles: (symbol, start, end) => fetchCandles(symbol, "5minute", start, end),
  positions: getRawPositions,
  positionsParsed: () => indiaBroker.getPositions(),
  niftyGapPercent: async () => null
};

await runSignalMode({ api });
