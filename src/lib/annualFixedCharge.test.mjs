import test from "node:test";
import assert from "node:assert/strict";
import { annualFixedChargeActive } from "./annualFixedCharge.ts";

test("毎年定額は契約区画に設定した請求月だけ請求対象になる", () => {
  assert.equal(annualFixedChargeActive("2026-04", 4), true);
  assert.equal(annualFixedChargeActive("2027-04", 4), true);
  assert.equal(annualFixedChargeActive("2026-05", 4), false);
  assert.equal(annualFixedChargeActive("2026-04", null), false);
});
