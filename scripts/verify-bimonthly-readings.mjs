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

const { latestPreviousReadings, previousReadingBillingMonth } = await import(pathToFileURL(outfile).href);
assert.equal(previousReadingBillingMonth("2026-11", 1), "2026-10-01", "毎月請求は1か月前を参照する");
assert.equal(previousReadingBillingMonth("2026-11", 2), "2026-09-01", "隔月請求は2か月前を参照する");
assert.equal(previousReadingBillingMonth("2026-01", 2), "2025-11-01", "隔月請求は年をまたいでも2か月前を参照する");
const latest = latestPreviousReadings([
  { asset_meter_id: "meter-a", billing_month: "2026-09-01", current_reading: 90 },
  { asset_meter_id: "meter-a", billing_month: "2026-10-01", current_reading: 100 },
  { asset_meter_id: "meter-b", billing_month: "2026-09-01", current_reading: 50 },
]);
assert.equal(latest.get("meter-a"), 100, "直前月に値があれば請求頻度にかかわらず最新値を使う");
assert.equal(latest.get("meter-b"), 50, "直前月がなければそれ以前の最新値を使う");
console.log("PASS: previous reading lookup uses each meter's latest saved value");
