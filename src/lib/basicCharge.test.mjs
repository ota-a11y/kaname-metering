import test from 'node:test';
import assert from 'node:assert/strict';
import { prorateUtilityFixedAmount } from './basicCharge.ts';

test('公共料金の定額は請求期間の入居日数で日割りし小数点以下を切り捨てる', () => {
  const period = { start: '2026-11-01', end: '2026-11-30' };
  const contract = { lease_start_date: '2026-11-20', lease_end_date: null };
  assert.equal(prorateUtilityFixedAmount(100000, contract, period), 36666);
});

test('退去後の日数は公共料金の定額から除く', () => {
  const period = { start: '2026-11-01', end: '2026-11-30' };
  const contract = { lease_start_date: '2026-10-01', lease_end_date: '2026-11-19' };
  assert.equal(prorateUtilityFixedAmount(30000, contract, period), 19000);
});
