import assert from "node:assert/strict";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const outfile = resolve(".tmp-runtime/verify-unit-price-adjustment.mjs");
await build({ entryPoints: ["src/lib/unitPriceAdjustment.ts"], bundle: true, platform: "node", format: "esm", outfile });
const { latestUnitPriceAdjustments } = await import(pathToFileURL(outfile).href);

const inherited = latestUnitPriceAdjustments([
  { billing_month: "2026-10-01", asset_meter_sub_item_id: "electric", unit_price_adjustment_enabled: true, unit_price_adjustment_factor: 1.2 },
  { billing_month: "2026-09-01", asset_meter_sub_item_id: "electric", unit_price_adjustment_enabled: false, unit_price_adjustment_factor: 1 },
  { billing_month: "2026-08-01", asset_meter_sub_item_id: "water", unit_price_adjustment_enabled: true, unit_price_adjustment_factor: 0.95 },
]);
assert.deepEqual(inherited, [
  { asset_meter_sub_item_id: "electric", unit_price_adjustment_enabled: true, unit_price_adjustment_factor: 1.2 },
  { asset_meter_sub_item_id: "water", unit_price_adjustment_enabled: true, unit_price_adjustment_factor: 0.95 },
]);
console.log("PASS: latest unit-price adjustment carries forward by subitem");
