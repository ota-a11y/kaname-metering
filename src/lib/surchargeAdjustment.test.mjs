import test from "node:test";
import assert from "node:assert/strict";
import { surchargeAdjustmentShortfallExclusive } from "./surchargeAdjustment.ts";

test("調整前後の請求額差を税抜の回収不足額にする", () => {
  assert.equal(surchargeAdjustmentShortfallExclusive(544_486, 412_013), 132_473);
  assert.equal(surchargeAdjustmentShortfallExclusive(100_000, 110_000), 0);
});
