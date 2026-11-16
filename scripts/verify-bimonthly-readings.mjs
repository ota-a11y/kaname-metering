import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const source = await readFile("src/lib/meteringRepository.ts", "utf8");
const outfile = resolve(".tmp-runtime/verify-bimonthly-readings.mjs");
await build({
  stdin: { contents: source, loader: "ts", resolveDir: resolve("src/lib") },
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  outfile,
});

const { previousReadingBillingMonth } = await import(pathToFileURL(outfile).href);
assert.equal(previousReadingBillingMonth("2026-11", 1), "2026-10-01", "毎月請求は1か月前を参照する");
assert.equal(previousReadingBillingMonth("2026-11", 2), "2026-09-01", "隔月請求は2か月前を参照する");
assert.equal(previousReadingBillingMonth("2026-01", 2), "2025-11-01", "隔月請求は年をまたいでも2か月前を参照する");
console.log("PASS: monthly and bimonthly previous reading months");
