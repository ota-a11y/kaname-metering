import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { splitMeterReading } from '../src/lib/turnoverMeterSplit.ts';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

globalThis.localStorage = { getItem: () => null };
const source = await readFile('src/pages/KanameterWorkspacePage.tsx', 'utf8');
await mkdir('.tmp-runtime', { recursive: true });
const outfile = resolve('.tmp-runtime/verify-three-part-turnover.mjs');
await build({
  stdin: { contents: `${source}\nexport { buildConfirmedMeterAmounts, expandTurnoverMeterRows, turnoverDatesForMeter, CustomItemTable };\nexport { saveMeterReading, saveTurnoverMeterBreak } from '../lib/meteringRepository';`, loader: 'tsx', resolveDir: resolve('src/pages') },
  bundle: true, packages: 'external', platform: 'node', format: 'esm', jsx: 'automatic',
  define: { 'import.meta.env': '{}' }, outfile,
});
const { buildConfirmedMeterAmounts, expandTurnoverMeterRows, turnoverDatesForMeter, CustomItemTable, saveMeterReading, saveTurnoverMeterBreak } = await import(pathToFileURL(outfile).href);
const unit = { unit_id: '601', unit_code: '601', unit_name: '601', floor_label: '6', unit_type: 'office' };
const contract = (id, start, end) => ({
  lease_contract_unit_id: id, unit, lease_start_date: start, lease_end_date: end,
  contract: { lease_contract_id: id, tenant_id: id, tenant: { tenant_name: id }, contract_start_date: start, actual_end_date: end },
  prices: [], categoryPrices: [], basics: [], meterTerms: [], meterBilling: [{ meter_reading_contract_id: id, electric_billable: true, items: [] }],
});
const contracts = [contract('former', '2026-01-01', '2026-10-10'), contract('incoming', '2026-10-21', null)];
const subItem = {
  asset_meter_sub_item_id: 'electric', sub_item_name: '電灯', category: 'electric', sub_item_kind: 'custom',
  is_monthly_fixed: false, calculation_mode: 'meter', price_mode: 'fixed', tax_mode: 'exclusive',
  default_unit_price: 10, asset_billing_line_item_id: null, amount_calculation_scope: 'unit',
  aggregation_decimal_digits: 0, usage_rounding_mode: 'round', input_mode: 'reading', input_decimal_digits: 0,
};
const breaks = [{ date: '2026-10-10', reading: 120, usage: null }, { date: '2026-10-20', reading: 140, usage: null }];
const meter = {
  asset_meter_id: 'meter-601', meter_code: '電灯', meter_label: null, sort_order: 1,
  parent_meter_id: null, child_meter_ids: [], is_rate_source: false, is_allocation_source: false,
  allocation_common_source_meter_ids: [], assignments: [{ unit_id: '601', unit, tenant_id: 'former', allocation_method: 'single', allocation_weight: 1 }],
  subItem, turnoverBreaks: breaks, entry: { previous_reading: 100, current_reading: 170, usage_amount: 70 },
};
const period = { start: '2026-10-01', end: '2026-10-31' };
assert.throws(() => splitMeterReading('reading', period, 100, 170, breaks.map((row, index) => index === 1 ? { ...row, reading: null } : row)), /中間検針値/);
const persisted = { breaks: new Map(), reading: null };
const fakeClient = {
  from: () => ({
    select: () => ({ eq() { return this; }, maybeSingle: async () => ({ data: { status: 'draft' }, error: null }) }),
    upsert: async (row) => { persisted.breaks.set(row.break_date, row); return { error: null }; },
  }),
  rpc: async (_name, args) => {
    persisted.reading = args.p_value;
    return { data: [{ previous_reading: 100, current_reading: args.p_value, usage_amount: args.p_value - 100 }], error: null };
  },
};
await saveTurnoverMeterBreak(fakeClient, 'asset', '2026-11', meter.asset_meter_id, '2026-10-10', 'reading', 120);
await saveTurnoverMeterBreak(fakeClient, 'asset', '2026-11', meter.asset_meter_id, '2026-10-20', 'reading', 140);
await saveMeterReading(fakeClient, 'asset', '2026-11', meter.asset_meter_id, 170);
const reloadedMeter = {
  ...meter,
  turnoverBreaks: [...persisted.breaks.values()].map((row) => ({ date: row.break_date, reading: row.reading, usage: row.usage_amount })),
  entry: { previous_reading: 100, current_reading: persisted.reading, usage_amount: persisted.reading - 100 },
};
assert.deepEqual(expandTurnoverMeterRows([reloadedMeter], contracts, period, {}, false).map((row) => row.entry.usage_amount), [20, 20, 30]);
assert.deepEqual(turnoverDatesForMeter(meter, contracts, period), ['2026-10-10', '2026-10-20']);
const displayed = expandTurnoverMeterRows([meter], contracts, period, {}, false);
assert.deepEqual(displayed.map((row) => [row.turnoverPart.start, row.turnoverPart.end, row.assignments[0].tenant_id, row.entry.usage_amount]), [
  ['2026-10-01', '2026-10-10', 'former', 20],
  ['2026-10-11', '2026-10-20', null, 20],
  ['2026-10-21', '2026-10-31', 'incoming', 30],
]);
const secondMeter = { ...meter, asset_meter_id: 'air-601', meter_code: '空調', sort_order: 2 };
const sixRows = expandTurnoverMeterRows([meter, secondMeter], contracts, period, {}, false);
const html = renderToStaticMarkup(React.createElement(CustomItemTable, {
  billingMonth: '2026-11', meters: sixRows, contracts, turnoverContracts: contracts, turnoverPeriod: period,
  category: 'electric', lineItemId: null, defaultUnitPrice: 10, defaultPriceMode: 'fixed',
  variablePriceForUnpricedOnly: false, taxMode: 'exclusive', amountCalculationScope: 'unit', taxRoundingMode: 'none',
  values: {}, saveStates: {}, confirmed: false, usageHistory: { previous: {}, previousYear: {} },
  rolloverValues: {}, columnStorageUserId: 'test', usageOnly: false, onChange() {}, onBlur() {},
}));
const visibleRows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)]
  .map(([, markup]) => markup.replace(/<[^>]+>/g, ''))
  .filter((row) => row.includes('電灯') || row.includes('空調'));
assert.deepEqual(visibleRows.map((row) => row.includes('空調') ? '空調' : '電灯'), ['電灯', '空調', '電灯', '空調', '電灯', '空調']);
assert.equal((html.match(/※～10\/10/g) ?? []).length, 1);
assert.equal((html.match(/※10\/11～10\/20/g) ?? []).length, 1);
assert.equal((html.match(/※10\/21～/g) ?? []).length, 1);
const confirmed = buildConfirmedMeterAmounts({
  contracts, meters: [meter], categorySettings: [{ category: 'electric', is_billable: true, is_basic_billable: false, usage_unit: 'kWh' }],
  utilitySettings: [], subItems: [subItem], surcharges: [], surchargePrices: {}, unitPriceCalculations: {},
  billingLineItems: [], monthlyFixedCharges: {}, billingMonth: '2026-11', turnoverPeriod: period,
});
assert.deepEqual(confirmed.filter((row) => row.source_kind === 'subItem').map((row) => [row.tenant_id, row.usage_amount, row.amount]), [
  ['former', 20, 200], ['incoming', 30, 300],
]);
console.log('3区間表示・入力保存と再読込・確定明細の旧/新テナント振り分けを確認しました。');
