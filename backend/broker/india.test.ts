import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseEquityInstruments,
  parseHoldingsResponse,
  parseLtpResponse,
  resolveInstrumentTokenFromRows
} from "./india.js";

const sampleCsv = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "instruments-equity-sample.csv"),
  "utf8"
);
const relianceRow = "NSE,E,2885,EQUITY,,RELIANCE,1,RELIANCE,,0,,,1,ES,EQ,RELIANCE";

test("resolves RELIANCE on NSE to NSE_2885 and prefers EQ", () => {
  const instruments = parseEquityInstruments(`${sampleCsv.trimEnd()}\r\n${relianceRow}`);
  assert.equal(resolveInstrumentTokenFromRows("RELIANCE", "NSE", instruments), "NSE_2885");
});

test("rejects an instrument lookup with no matches", () => {
  const instruments = parseEquityInstruments(sampleCsv);
  assert.throws(
    () => resolveInstrumentTokenFromRows("MISSING", "NSE", instruments),
    /No INDmoney equity instrument/
  );
});

test("rejects an instrument lookup with multiple EQ matches", () => {
  const instruments = parseEquityInstruments(
    `${sampleCsv.trimEnd()}\r\n${relianceRow}\r\n${relianceRow.replace("2885", "7777")}`
  );
  assert.throws(
    () => resolveInstrumentTokenFromRows("RELIANCE", "NSE", instruments),
    /Multiple INDmoney equity instruments/
  );
});

test("parses documented holdings fields", () => {
  const holdings = parseHoldingsResponse({
    status: "success",
    data: [
      {
        security_id: "18520",
        symbol: "CUPID",
        total_qty: 1,
        avg_price: 217.3,
        used_qty: 0,
        t1_qty: 1,
        t1_avg_price: 217.3,
        dp_qty: 0,
        dp_avg_price: 0
      }
    ]
  });

  assert.deepEqual(holdings, [
    {
      securityId: "18520",
      symbol: "CUPID",
      quantity: 1,
      averagePrice: 217.3
    }
  ]);
});

test("accepts an empty holdings list", () => {
  assert.deepEqual(parseHoldingsResponse({ status: "success", data: [] }), []);
});

test("parses the real LTP response shape", () => {
  const response = JSON.parse(
    readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "ltp-sample.json"),
      "utf8"
    )
  );
  assert.deepEqual(parseLtpResponse(response, "NSE_2885", "RELIANCE"), {
    symbol: "RELIANCE",
    price: 1226
  });
});

test("rejects an LTP response without the requested scrip code", () => {
  assert.throws(
    () => parseLtpResponse({ status: "success", data: {} }, "NSE_2885", "RELIANCE"),
    /missing data for NSE_2885/
  );
});
