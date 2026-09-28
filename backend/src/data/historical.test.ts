import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  checkDailyGaps,
  fetchCandles,
  filterCandlesForBacktest,
  type Candle
} from "./historical.js";
import { BrokerError } from "../../broker/types.js";

function response(scripCode: string, candles: unknown[]) {
  return new Response(JSON.stringify({
    success: true,
    data: { [scripCode]: { candles } }
  }), { status: 200 });
}

async function withDatabase<T>(callback: (path: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "historical-test-"));
  const path = join(directory, "market-data.sqlite");
  try {
    return await callback(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("splits a range at the interval limit", async () => {
  await withDatabase(async (databasePath) => {
    const calls: string[] = [];
    const start = new Date("2026-01-01T00:00:00+05:30");
    const end = new Date("2026-01-17T00:00:00+05:30");
    const candles = (ts: number) => [{ ts, o: 1, h: 2, l: 1, c: 2, v: 10 }];
    const result = await fetchCandles("RELIANCE", "60minute", start, end, {
      databasePath,
      accessToken: "test-token",
      resolveInstrumentToken: async () => "NSE_2885",
      sleep: async () => undefined,
      fetch: async (url) => {
        const requestUrl = String(url);
        calls.push(requestUrl);
        const query = new URL(requestUrl).searchParams;
        return response("NSE_2885", candles(Math.floor(Number(query.get("start_time")) / 1000)));
      }
    });
    assert.equal(calls.length, 2);
    assert.equal(result.length, 2);
  });
});

test("converts candle seconds to stored milliseconds and rejects out-of-range candles", async () => {
  await withDatabase(async (databasePath) => {
    const start = new Date("2026-01-01T00:00:00+05:30");
    const end = new Date("2026-01-02T00:00:00+05:30");
    const startSeconds = Math.floor(start.getTime() / 1000);
    const candles = [{
      ts: startSeconds,
      o: 1,
      h: 2,
      l: 1,
      c: 2,
      v: 10
    }];
    const rows = await fetchCandles("RELIANCE", "1day", start, end, {
      databasePath,
      accessToken: "test-token",
      resolveInstrumentToken: async () => "NSE_2885",
      sleep: async () => undefined,
      fetch: async () => response("NSE_2885", candles)
    });
    assert.equal(rows[0].timeMs, start.getTime());
    await assert.rejects(
      fetchCandles("RELIANCE", "1day", start, end, {
        databasePath: join(databasePath, "..", "out-of-range.sqlite"),
        accessToken: "test-token",
        resolveInstrumentToken: async () => "NSE_2885",
        sleep: async () => undefined,
        fetch: async () => response("NSE_2885", [{
          ts: Math.floor(end.getTime() / 1000),
          o: 1,
          h: 2,
          l: 1,
          c: 2,
          v: 10
        }])
      }),
      /outside the requested range/
    );
  });
});

test("uses IST day boundaries for daily gap checking", () => {
  const candles: Candle[] = [{
    scripCode: "NSE_2885",
    interval: "1day",
    timeMs: new Date("2026-01-02T00:00:00+05:30").getTime(),
    open: 1,
    high: 2,
    low: 1,
    close: 2,
    volume: 10
  }];
  const report = checkDailyGaps(
    candles,
    new Date("2026-01-01T00:00:00+05:30"),
    new Date("2026-01-05T00:00:00+05:30")
  );
  assert.deepEqual(report.missingDates, ["2026-01-01"]);
});

test("does not report Muhurat dates as gaps and excludes their candles from backtests", () => {
  const muhuratCandle: Candle = {
    scripCode: "NSE_2885",
    interval: "1day",
    timeMs: new Date("2025-10-21T18:00:00+05:30").getTime(),
    open: 1,
    high: 2,
    low: 1,
    close: 2,
    volume: 10
  };
  const report = checkDailyGaps(
    [],
    new Date("2025-10-21T00:00:00+05:30"),
    new Date("2025-10-22T00:00:00+05:30")
  );
  assert.deepEqual(report.missingDates, []);
  assert.deepEqual(filterCandlesForBacktest([muhuratCandle]), []);
});

test("retries 429 responses with backoff", async () => {
  await withDatabase(async (databasePath) => {
    let calls = 0;
    let sleeps = 0;
    const rows = await fetchCandles(
      "RELIANCE",
      "1day",
      new Date("2026-01-01T00:00:00+05:30"),
      new Date("2026-01-02T00:00:00+05:30"),
      {
        databasePath,
        accessToken: "test-token",
        resolveInstrumentToken: async () => "NSE_2885",
        sleep: async () => {
          sleeps += 1;
        },
        fetch: async () => {
          calls += 1;
          return calls < 3
            ? new Response("", { status: 429 })
            : response("NSE_2885", [{ ts: 1767205800, o: 1, h: 2, l: 1, c: 2, v: 10 }]);
        }
      }
    );
    assert.equal(calls, 3);
    assert.ok(sleeps >= 2);
    assert.equal(rows.length, 1);
  });

  test("stops on historical 401/403 with the endpoint in the auth error", async () => {
    await withDatabase(async (databasePath) => {
      await assert.rejects(
        fetchCandles(
          "RELIANCE",
          "1day",
          new Date("2026-01-01T00:00:00+05:30"),
          new Date("2026-01-02T00:00:00+05:30"),
          {
            databasePath,
            accessToken: "test-token",
            resolveInstrumentToken: async () => "NSE_2885",
            sleep: async () => undefined,
            fetch: async () => new Response("", { status: 403 })
          }
        ),
        (error: unknown) => {
          assert.ok(error instanceof BrokerError);
          assert.equal(error.code, "AUTH_EXPIRED");
          assert.equal(error.status, 403);
          assert.match(error.message, /TOKEN REJECTED \/ ACCESS DENIED/);
          assert.match(error.message, /market\/historical/);
          return true;
        }
      );
    });
  });
});

test("a second fetch of the same range makes no API calls", async () => {
  await withDatabase(async (databasePath) => {
    let calls = 0;
    const request = {
      databasePath,
      accessToken: "test-token",
      resolveInstrumentToken: async () => "NSE_2885",
      sleep: async () => undefined,
      fetch: async () => {
        calls += 1;
        return response("NSE_2885", [{ ts: 1767205800, o: 1, h: 2, l: 1, c: 2, v: 10 }]);
      }
    };
    const start = new Date("2026-01-01T00:00:00+05:30");
    const end = new Date("2026-01-02T00:00:00+05:30");
    await fetchCandles("RELIANCE", "1day", start, end, request);
    await fetchCandles("RELIANCE", "1day", start, end, request);
    assert.equal(calls, 1);
  });
});
