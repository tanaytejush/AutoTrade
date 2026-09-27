import dotenv from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getBroker } from "../broker/router.js";
import { getIntradayMarginForOneShare, resolveInstrumentToken } from "../broker/india.js";
import { requestJson, requestText } from "../broker/http.js";

dotenv.config({
  path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env")
});

if (process.env.RUN_REAL_BROKER_TESTS !== "true") {
  throw new Error("Set RUN_REAL_BROKER_TESTS=true to make real read-only broker calls.");
}

const symbol = process.env.INDIA_TEST_SYMBOL ?? "RELIANCE";

const token = process.env.INDMONEY_ACCESS_TOKEN;
const baseUrl = process.env.INDMONEY_BASE_URL ?? "https://api.indstocks.com";
if (!token) {
  throw new Error("INDMONEY_ACCESS_TOKEN is required for read-only broker calls.");
}
const headers = { Authorization: token };
const broker = getBroker();

async function check(name: string, action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
    console.log(`${name}: PASS`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    console.log(`${name}: FAIL (${message})`);
  }
}

await check("instruments", async () => {
  await requestText(
    `${baseUrl}/market/instruments?source=equity`,
    { headers },
    "INDmoney"
  );
});
await check("LTP", async () => {
  await broker.getQuote(symbol);
});
await check("margin calculator (1 share intraday)", async () => {
  const tokenForMargin = await resolveInstrumentToken(symbol);
  const quote = await broker.getQuote(symbol);
  await getIntradayMarginForOneShare(tokenForMargin.split("_")[1], quote.price);
});
await check("holdings", async () => {
  await broker.getHoldings();
});
await check("equity positions", async () => {
  await requestJson(
    `${baseUrl}/portfolio/positions?segment=equity&product=cnc`,
    { headers },
    "INDmoney"
  );
});
await check("derivative positions", async () => {
  await requestJson(
    `${baseUrl}/portfolio/positions?segment=derivative&product=margin`,
    { headers },
    "INDmoney"
  );
});
await check("funds", async () => {
  await broker.getMargin();
});
