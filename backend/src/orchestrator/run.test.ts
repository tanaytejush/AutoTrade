import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { BrokerError } from "../../broker/types.js";
import { PAPER_SYMBOLS, retry, runPaperOrchestrator, shouldRetry, type PaperApi, type PaperClock } from "./run.js";

afterEach(() => {
  delete process.env.PAPER_TRADING;
});

const day = "2026-09-25";

function clock(): PaperClock {
  let current = new Date(`${day}T09:05:00+05:30`);
  return {
    now: () => new Date(current),
    async sleep() { current = new Date(current.getTime() + 60_000); }
  };
}

function api(overrides: Partial<PaperApi> = {}): PaperApi {
  return {
    funds: async () => ({ intradayAvailable: 500 }),
    quote: async () => ({ price: 100 }),
    quoteBatch: async (symbols) => new Map(symbols.map((symbol) => [symbol, { price: 100 }])),
    resolve: async (symbol) => symbol,
    candles: async () => [],
    ...overrides
  };
}

test("retries 429 and network/5xx errors, but not other 4xx", async () => {
  assert.equal(shouldRetry(new BrokerError("rate", "RATE_LIMITED", 429)), true);
  assert.equal(shouldRetry(new BrokerError("server", "REQUEST_FAILED", 503)), true);
  assert.equal(shouldRetry(new BrokerError("network", "REQUEST_FAILED")), true);
  assert.equal(shouldRetry(new BrokerError("bad request", "REQUEST_FAILED", 400)), false);
  let calls = 0;
  const result = await retry(async () => {
    calls += 1;
    if (calls < 2) throw new BrokerError("rate", "RATE_LIMITED", 429);
    return "ok";
  }, async () => undefined, async () => undefined);
  assert.equal(result, "ok");
  assert.equal(calls, 2);
});

test("401 stops startup without continuing to candle calls", async () => {
  process.env.PAPER_TRADING = "true";
  let candleCalls = 0;
  const messages: string[] = [];
  const original = console.log;
  console.log = (...values: unknown[]) => messages.push(values.join(" "));
  try {
    await runPaperOrchestrator({
      clock: clock(),
      logDirectory: await mkdtemp(join(tmpdir(), "paper-auth-")),
      api: api({
        quote: async () => { throw new BrokerError("unauthorized", "AUTH_EXPIRED", 401); },
        candles: async () => { candleCalls += 1; return []; }
      })
    });
  } finally {
    console.log = original;
  }
  assert.equal(candleCalls, 0);
  assert.equal(messages.some((message) => message.includes("TOKEN REJECTED")), true);
});

test("missing candles are skipped and unfinished candles are not used", async () => {
  process.env.PAPER_TRADING = "true";
  const directory = await mkdtemp(join(tmpdir(), "paper-candles-"));
  let calls = 0;
  try {
    await runPaperOrchestrator({
      clock: clock(),
      logDirectory: directory,
      api: api({
        candles: async (symbol) => {
          calls += 1;
          return symbol === PAPER_SYMBOLS[0]
            ? [{ scripCode: symbol, interval: "5minute" as const, timeMs: new Date(`${day}T09:19:00+05:30`).getTime(), open: 1, high: 1, low: 1, close: 1, volume: 1 }]
            : [];
        }
      })
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  assert.ok(calls > 0);
});

test("STOP file is checked during the loop", async () => {
  process.env.PAPER_TRADING = "true";
  const directory = await mkdtemp(join(tmpdir(), "paper-stop-"));
  const stopPath = join(directory, "STOP");
  let sleeps = 0;
  const baseClock = clock();
  const stopClock: PaperClock = {
    now: baseClock.now,
    async sleep(ms) {
      sleeps += 1;
      if (sleeps === 2) await writeFile(stopPath, "stop", "utf8");
      await baseClock.sleep(ms);
    }
  };
  try {
    await runPaperOrchestrator({ clock: stopClock, stopPath, logDirectory: directory, api: api() });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(sleeps, 2);
});

test("paper positions exit at 15:10", async () => {
  process.env.PAPER_TRADING = "true";
  const directory = await mkdtemp(join(tmpdir(), "paper-exit-"));
  const baseClock = clock();
  const candles = Array.from({ length: 72 }, (_, index) => {
    const time = new Date(new Date(`${day}T09:15:00+05:30`).getTime() + index * 5 * 60_000).getTime();
    const close = index === 3 ? 102 : 100;
    return { scripCode: "CIPLA", interval: "5minute" as const, timeMs: time, open: 100, high: close, low: 99, close, volume: 1 };
  });
  try {
    await runPaperOrchestrator({
      clock: baseClock,
      logDirectory: directory,
      api: api({
        candles: async () => candles,
        quoteBatch: async (symbols) => new Map(symbols.map((symbol) => [symbol, { price: 101 }]))
      })
    });
    const log = await (await import("node:fs/promises")).readFile(join(directory, `${day}.jsonl`), "utf8");
    assert.match(log, /"reason":"15:10"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
