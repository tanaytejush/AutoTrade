import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const backendDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configUrl = pathToFileURL(resolve(backendDirectory, "config.ts")).href;
const guardUrl = pathToFileURL(
  resolve(backendDirectory, "src", "executionGuard.ts")
).href;

function runModule(moduleUrl: string, paperTrading: string | undefined): void {
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx/esm",
      "--eval",
      `import("${moduleUrl}").then((module) => module.assertPaperMode?.())`
    ],
    {
      cwd: resolve(backendDirectory, ".."),
      env: { ...process.env, PAPER_TRADING: paperTrading },
      stdio: "pipe"
    }
  );
}

test("missing PAPER_TRADING refuses to continue", () => {
  assert.throws(() => runModule(configUrl, undefined), /PAPER_TRADING/);
});

test("invalid PAPER_TRADING refuses to continue", () => {
  assert.throws(() => runModule(configUrl, "yes"), /PAPER_TRADING/);
});

test("PAPER_TRADING=true allows paper-mode guard execution", () => {
  assert.doesNotThrow(() => runModule(guardUrl, "true"));
});

test("PAPER_TRADING=false blocks order-related execution", () => {
  assert.throws(
    () => runModule(guardUrl, "false"),
    /Order execution requires PAPER_TRADING=true/
  );
});
