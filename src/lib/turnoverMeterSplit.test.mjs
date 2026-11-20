import test from 'node:test';
import assert from 'node:assert/strict';
import { splitMeterReading, turnoverBoundary } from './turnoverMeterSplit.ts';

test('入居日を境界に指針を2区間へ分け、後半の前月指針を中間指針にする', () => {
  const date = turnoverBoundary('2026-11-20', 'move_in');
  assert.equal(date, '2026-11-19');
  const rows = splitMeterReading('reading', { start: '2026-11-01', end: '2026-11-30' }, 100, 180, [{ date, reading: 130, usage: null }]);
  assert.deepEqual(rows.map(({ label, previousReading, currentReading, usage }) => ({ label, previousReading, currentReading, usage })), [
    { label: '※～11/19', previousReading: 100, currentReading: 130, usage: 30 },
    { label: '※11/20～', previousReading: 130, currentReading: 180, usage: 50 },
  ]);
});

test('使用量入力は前半と後半を個別入力し、未入力では分割できない', () => {
  const period = { start: '2026-11-01', end: '2026-11-30' };
  const breaks = [{ date: '2026-11-19', reading: null, usage: 20 }];
  assert.deepEqual(splitMeterReading('usage', period, null, 35, breaks).map((row) => row.usage), [20, 35]);
  assert.throws(() => splitMeterReading('usage', period, null, null, breaks), /後半の使用量/);
  assert.throws(() => splitMeterReading('usage', period, null, 35, [{ ...breaks[0], usage: null }]), /中間検針値または使用量/);
});

test('10月15日退去・16日入居では同じ境界で二つの請求期間に分かれる', () => {
  const moveOut = turnoverBoundary('2026-10-15', 'move_out');
  const moveIn = turnoverBoundary('2026-10-16', 'move_in');
  assert.equal(moveOut, moveIn);
  const rows = splitMeterReading('reading', { start: '2026-10-01', end: '2026-10-31' }, 100, 200, [{ date: moveOut, reading: 145, usage: null }]);
  assert.deepEqual(rows.map(({ start, end, label, usage }) => ({ start, end, label, usage })), [
    { start: '2026-10-01', end: '2026-10-15', label: '※～10/15', usage: 45 },
    { start: '2026-10-16', end: '2026-10-31', label: '※10/16～', usage: 55 },
  ]);
});

test('10月10日退去・21日入居では空室を挟む三つの請求期間に分かれる', () => {
  const period = { start: '2026-10-01', end: '2026-10-31' };
  const breaks = [
    { date: turnoverBoundary('2026-10-10', 'move_out'), reading: 120, usage: null },
    { date: turnoverBoundary('2026-10-21', 'move_in'), reading: 140, usage: null },
  ];
  assert.deepEqual(splitMeterReading('reading', period, 100, 170, breaks).map(({ start, end, usage }) => ({ start, end, usage })), [
    { start: '2026-10-01', end: '2026-10-10', usage: 20 },
    { start: '2026-10-11', end: '2026-10-20', usage: 20 },
    { start: '2026-10-21', end: '2026-10-31', usage: 30 },
  ]);
  assert.deepEqual(splitMeterReading('usage', period, null, 30, breaks.map((row) => ({ ...row, reading: null, usage: 20 }))).map((row) => row.usage), [20, 20, 30]);
  assert.throws(() => splitMeterReading('reading', period, 100, 170, breaks.slice(0, 1).concat({ ...breaks[1], reading: null })), /中間検針値/);
});
