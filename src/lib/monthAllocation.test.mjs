import assert from "node:assert/strict";
import test from "node:test";
import { calculateMonthAllocation, evaluateAllocationAmountExpression, formatAllocationAmountInput, parseMonthAllocationRatio, ratioForAllocationMode } from "./monthAllocation.ts";

test("配賦率の合計を1に補正せず、各区画に設定率を掛ける", () => {
  const result = calculateMonthAllocation("1000", [
    { id: "A", ratio: { mode: "multiplier", value: "0.5" }, roundingMode: "floor" },
    { id: "B", ratio: { mode: "fraction", numerator: "4", denominator: "5" }, roundingMode: "floor" },
    { id: "C", ratio: { mode: "multiplier", value: "" }, roundingMode: "floor" },
  ]);
  assert.deepEqual(result.rows, [
    { id: "A", ratio: 0.5, amount: 500 },
    { id: "B", ratio: 0.8, amount: 800 },
    { id: "C", ratio: 0, amount: 0 },
  ]);
});

test("区画の丸め設定を使い、不正な入力は保存前に拒否する", () => {
  assert.equal(calculateMonthAllocation("101", [{ id: "A", ratio: { mode: "fraction", numerator: "1", denominator: "2" }, roundingMode: "ceil" }]).rows[0].amount, 51);
  assert.throws(() => calculateMonthAllocation("100", [{ id: "A", ratio: { mode: "multiplier", value: "-0.1" }, roundingMode: "floor" }]));
  assert.throws(() => calculateMonthAllocation("100", [{ id: "A", ratio: { mode: "fraction", numerator: "1", denominator: "0" }, roundingMode: "floor" }]));
});

test("保存済みの数値配賦率を乗率として読み込む", () => {
  assert.deepEqual(parseMonthAllocationRatio(0.4), { mode: "multiplier", value: "0.4" });
  assert.deepEqual(parseMonthAllocationRatio({ mode: "fraction", numerator: "2", denominator: "5" }), { mode: "fraction", numerator: "2", denominator: "5" });
});

test("按分元金額をカンマ区切りで表示し、入力途中の小数を保つ", () => {
  assert.equal(formatAllocationAmountInput("1234567.50"), "1,234,567.50");
  assert.equal(formatAllocationAmountInput("1234."), "1,234.");
  assert.equal(calculateMonthAllocation("1,234", [{ id: "A", ratio: { mode: "multiplier", value: "0.5" }, roundingMode: "floor" }]).rows[0].amount, 617);
});

test("按分元金額の数式を計算し、配賦額に反映する", () => {
  assert.equal(formatAllocationAmountInput("100000＋25000*2"), "100,000＋25,000*2");
  assert.equal(evaluateAllocationAmountExpression("100,000＋25,000×2"), 150000);
  assert.equal(evaluateAllocationAmountExpression("(100,000+25,000)/5"), 25000);
  assert.equal(calculateMonthAllocation("100,000＋25,000×2", [{ id: "A", ratio: { mode: "multiplier", value: "0.4" }, roundingMode: "floor" }]).rows[0].amount, 60000);
  assert.equal(evaluateAllocationAmountExpression("100/0"), null);
});

test("全区画の配賦方法を切り替えても乗率を保つ", () => {
  assert.deepEqual(ratioForAllocationMode(0.4, "fraction"), { mode: "fraction", numerator: "0.4", denominator: "1" });
  assert.deepEqual(ratioForAllocationMode({ mode: "fraction", numerator: "2", denominator: "5" }, "multiplier"), { mode: "multiplier", value: "0.4" });
});
