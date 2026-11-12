import assert from "node:assert/strict";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const outfile = resolve(".tmp-runtime/verify-basic-charge.mjs");
await build({
  entryPoints: ["src/lib/basicCharge.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile,
});
const { contractBasicChargeAmount, isBasicChargeBillable } = await import(pathToFileURL(outfile).href);

const contracts = [
  { basics: [{ category: "electric", amount: 1000 }] },
  { basics: [{ category: "electric", amount: 2500 }] },
];

assert.equal(isBasicChargeBillable(undefined, "basic"), true, "旧データは従来どおり基本料を載せる");
assert.equal(isBasicChargeBillable([{ asset_meter_sub_item_id: "basic", is_billable: true, fixed_amount: 0 }], "basic"), true, "保存額0でもONなら基本料を載せる");
assert.equal(isBasicChargeBillable([{ asset_meter_sub_item_id: "basic", is_billable: false, fixed_amount: 3500 }], "basic"), false, "明示的なOFFなら基本料を載せない");
assert.equal(contractBasicChargeAmount(contracts, "electric"), 3500, "基本料は保存額ではなく契約区画の金額を合計する");

console.log("PASS: basic charge ON/OFF and contract amount source");
