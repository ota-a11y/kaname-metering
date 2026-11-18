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

const {
  billingServiceMonths,
  latestPreviousReadings,
  loadAdditionalMeterReadingDates,
  previousReadingBillingMonth,
  saveMeterReadingDate,
  saveSharedMeterReadingDate,
} = await import(pathToFileURL(outfile).href);
assert.deepEqual(billingServiceMonths("2026-04", -3), ["2026-01", "2026-02"], "3カ月前から2カ月分を解決する");
assert.deepEqual(billingServiceMonths("2026-04", -2), ["2026-02", "2026-03"], "前々月から2カ月分を解決する");
assert.deepEqual(billingServiceMonths("2026-04", -1), ["2026-03", "2026-04"], "前月から2カ月分を解決する");
assert.deepEqual(billingServiceMonths("2026-12", 0), ["2026-12", "2027-01"], "当月から2カ月分は年をまたげる");
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

const additionalDateRows = [
  { billing_month: "2026-11-01", asset_meter_date_setting_id: "water-date", meter_date: "2026-11-20" },
  { billing_month: "2026-09-01", asset_meter_date_setting_id: "water-date", meter_date: "2026-09-20" },
];
let queriedMonths = [];
const dateQuery = {
  select() { return this; },
  eq() { return this; },
  async in(_column, months) { queriedMonths = months; return { data: additionalDateRows, error: null }; },
};
const dateClient = { from() { return dateQuery; } };
const additionalDates = await loadAdditionalMeterReadingDates(dateClient, "asset-a", "2026-11");
assert.deepEqual(queriedMonths, ["2026-11-01", "2026-10-01", "2026-09-01"], "追加検針日も前々月まで読み込む");
assert.equal(additionalDates.byMonth["2026-09"]["water-date"], "2026-09-20", "隔月検針は追加検針日の前々月値を参照できる");

const savedRows = [];
const saveClient = {
  from() {
    return {
      async upsert(row) { savedRows.push(row); return { error: null }; },
    };
  },
};
await saveMeterReadingDate(saveClient, "asset-a", "2026-11", "water", "");
await saveSharedMeterReadingDate(saveClient, "asset-a", "2026-11", "");
assert.equal(savedRows[0].meter_date_water, null, "分類別検針日のクリアはnullで保存する");
assert.deepEqual(
  [savedRows[1].meter_date, savedRows[1].meter_date_electric, savedRows[1].meter_date_water, savedRows[1].meter_date_gas],
  [null, null, null, null],
  "標準検針日のクリアは全分類をnullで保存する",
);
console.log("PASS: previous reading lookup uses each meter's latest saved value");
