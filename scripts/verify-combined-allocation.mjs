import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

globalThis.localStorage = { getItem: () => null };

// Render the actual reading table with representative data, without connecting to Supabase.
const source = await readFile('src/pages/KanameterWorkspacePage.tsx', 'utf8');
const outfile = resolve('.tmp-runtime/verify-combined-allocation-component.mjs');
await build({
  stdin: { contents: `${source}\nexport { BasicChargeTable, CustomItemTable, SurchargeWorkspace, adjustedMeterUsage, billableContractsForSubItem, VariableUnitPriceCalculator };`, loader: 'tsx', resolveDir: resolve('src/pages') },
  bundle: true, packages: 'external', platform: 'node', format: 'esm', jsx: 'automatic',
  define: { 'import.meta.env': '{}' }, outfile,
});
const { BasicChargeTable, CustomItemTable, SurchargeWorkspace, adjustedMeterUsage, billableContractsForSubItem, VariableUnitPriceCalculator } = await import(pathToFileURL(outfile).href);
const unit = (id) => ({ unit_id: id, unit_code: id, unit_name: id, floor_label: '2', unit_type: 'office' });
const assignment = (id, weight = 1, method = 'single') => ({ unit_id: id, unit: unit(id), allocation_method: method, allocation_weight: weight });
const meter = (id, name, order, assignments) => ({
  asset_meter_id: id, meter_code: name, meter_label: null, sort_order: order,
  parent_meter_id: null, is_rate_source: false, is_allocation_source: false,
  billing_adjustment_enabled: false, allocation_common_source_meter_ids: [], assignments,
  subItem: { asset_meter_sub_item_id: 'electric', category: 'electric', input_mode: 'usage', input_decimal_digits: 1, aggregation_decimal_digits: 1, usage_rounding_mode: 'round' },
  entry: { previous_reading: 100, current_reading: 200, usage_amount: 100 },
});
const contract = (id) => ({
  lease_contract_unit_id: id, unit: unit(id), utility_amount_rounding_mode: 'round',
  contract: { lease_contract_id: id, tenant_id: id, tenant: { tenant_name: `Tenant ${id}` } },
  prices: [], categoryPrices: [], basics: [], meterBilling: [],
});
const contracts = [contract('202'), contract('201')];
const subItemFlags = contracts.map((row) => ({ ...row, meterBilling: [{ water_billable: true, items: [{ asset_meter_sub_item_id: 'water-usage', is_billable: row.unit.unit_id === '202' }] }] }));
assert.deepEqual(billableContractsForSubItem(subItemFlags, 'water-usage').map((row) => row.unit.unit_id), ['202'], 'a tenant with the subitem billing flag off is omitted');
const allocatedItem = { asset_meter_sub_item_id: 'allocated-basic', sub_item_name: '基本料', category: 'electric', calculation_mode: 'allocated_amount', tax_mode: 'inclusive', tax_rounding_mode: 'none' };
const allocatedContracts = contracts.map((row) => ({ ...row, meterTerms: [{ asset_meter_sub_item_id: 'allocated-basic', tax_mode: row.unit.unit_id === '202' ? 'inclusive' : 'exclusive' }] }));
const allocatedTable = renderToStaticMarkup(React.createElement(BasicChargeTable, {
  contracts: allocatedContracts, category: 'electric', showBasicCharge: false, monthlyFixedItems: [allocatedItem],
  monthlyFixedCharges: { '202|allocated-basic': 1100, '201|allocated-basic': 500 }, confirmed: false, onMonthlyFixedChange() {},
}));
assert.ok(allocatedTable.includes('区画ごと（税込）') && allocatedTable.includes('テナント合計（税抜）'), 'allocated charge has gross, net and tenant net columns');
assert.ok(allocatedTable.includes('value="1,100 円"') && allocatedTable.includes('>1,000 円<'), 'inclusive allocation converts to net even when unit-price tax rounding is unset');
const sharedTenantAllocation = renderToStaticMarkup(React.createElement(BasicChargeTable, {
  contracts: [allocatedContracts[0], { ...allocatedContracts[1], contract: allocatedContracts[0].contract }],
  category: 'electric', showBasicCharge: false, monthlyFixedItems: [allocatedItem],
  monthlyFixedCharges: { '202|allocated-basic': 1100, '201|allocated-basic': 500 }, confirmed: false, onMonthlyFixedChange() {},
}));
assert.ok(sharedTenantAllocation.includes('>1,454 円<'), 'tenant total adds net amounts after converting each unit with the subitem tax setting');
const surchargeWithAllocatedBasic = renderToStaticMarkup(React.createElement(SurchargeWorkspace, {
  surcharge: { asset_meter_surcharge_id: 'increase', category: 'electric', surcharge_name: '電気増額分', calculation_scope: 'tenant', recovery_inclusive_mode: 'from_exclusive' },
  assetId: 'asset', billingMonth: '2026-11', unit: 'kWh', contracts: [allocatedContracts[0]], meters: [],
  subItems: [{ ...allocatedItem, sub_item_kind: 'custom', is_monthly_fixed: true }],
  categorySettings: [{ category: 'electric', is_billable: true, is_basic_billable: false, usage_unit: 'kWh' }],
  utilitySettings: [], unitPriceCalculations: {}, monthlyFixedCharges: { '202|allocated-basic': 1100 }, onSettingsSaved() {},
}));
assert.match(surchargeWithAllocatedBasic, /金額（税抜）<\/dt><dd>1,000 円<\/dd>/, 'recovery net amount includes the net total of an allocated subitem without meters');
const meteredRecoveryItem = { ...allocatedItem, asset_meter_sub_item_id: 'metered', sub_item_name: '電気代', sub_item_kind: 'custom', is_monthly_fixed: false, calculation_mode: 'meter', price_mode: 'fixed', tax_mode: 'exclusive', default_unit_price: 10, asset_billing_line_item_id: null, amount_calculation_scope: 'unit', aggregation_decimal_digits: 1, usage_rounding_mode: 'round' };
const surchargeWithTwoSubitems = renderToStaticMarkup(React.createElement(SurchargeWorkspace, {
  surcharge: { asset_meter_surcharge_id: 'increase', category: 'electric', surcharge_name: '電気増額分', calculation_scope: 'tenant', recovery_inclusive_mode: 'from_exclusive' },
  assetId: 'asset', billingMonth: '2026-11', unit: 'kWh', contracts: [allocatedContracts[0]],
  meters: [{ ...meter('metered-meter', '電灯', 1, [assignment('202')]), subItem: meteredRecoveryItem }],
  subItems: [{ ...allocatedItem, sub_item_kind: 'custom', is_monthly_fixed: true }, meteredRecoveryItem],
  categorySettings: [{ category: 'electric', is_billable: true, is_basic_billable: false, usage_unit: 'kWh' }],
  utilitySettings: [], unitPriceCalculations: {}, monthlyFixedCharges: { '202|allocated-basic': 1100 }, onSettingsSaved() {},
}));
assert.match(surchargeWithTwoSubitems, /金額（税抜）<\/dt><dd>2,000 円<\/dd>/, 'recovery net amount sums the net totals of all subitems');
const parent = meter('light', '電灯', 10, [assignment('202', 2, 'ratio'), assignment('201', 3, 'ratio')]);
parent.meter_label = '2F按分用';
parent.allocation_common_source_meter_ids = ['power1', 'power2', 'power3', 'position40', 'position60'];
const members = [1, 2, 3].map((n) => meter(`power${n}`, `動力${n}`, 10 + n, [assignment('202')]));
const positions = ['40', '60'].map((ratio, i) => ({
  ...meter(`position${ratio}`, `${ratio}%`, 20 + i, [assignment(i ? '201' : '202')]),
  meter_label: `__kanameter_combined_position__:${ratio}%`,
  // Old input data must never contribute to the allocation.
  entry: { previous_reading: 0, current_reading: 9999, usage_amount: 9999 },
}));
const meters = [parent, ...members, ...positions];
const props = {
  billingMonth: '2026-11', meters, contracts, category: 'electric', lineItemId: null,
  defaultUnitPrice: 10, variablePriceForUnpricedOnly: false, taxMode: 'exclusive', subItemTaxMode: 'exclusive', amountCalculationScope: 'unit', taxRoundingMode: 'round',
  values: Object.fromEntries(meters.map((m) => [m.asset_meter_id, '100'])),
  saveStates: {}, confirmed: false, usageHistory: { previous: {}, previousYear: {} },
  rolloverValues: {}, columnStorageUserId: 'test', usageOnly: false, onChange() {},
};
function render(overrides = {}) {
  return renderToStaticMarkup(React.createElement(CustomItemTable, { ...props, ...overrides }));
}
function bodyRows(html) { return html.match(/<tbody>(.*?)<\/tbody>/s)[1].match(/<tr\b.*?<\/tr>/gs); }
function verifyGrid(html, columns) {
  const remaining = Array(columns).fill(0);
  for (const row of bodyRows(html)) {
    let column = 0;
    for (const cell of row.matchAll(/<td\b([^>]*)>.*?<\/td>/gs)) {
      while (remaining[column] > 0) column++;
      const rowspan = Number(cell[1].match(/rowSpan="(\d+)"/i)?.[1] ?? 1);
      assert.ok(column < columns, 'table row must not overflow');
      remaining[column++] = rowspan;
    }
    assert.ok(remaining.every((n) => n > 0), `every table column must be occupied: ${remaining.map((n) => n > 0 ? 1 : 0).join('')} ${row.slice(0, 180)}`);
    remaining.forEach((n, i) => remaining[i] = n - 1);
  }
  assert.ok(remaining.every((n) => n === 0), 'rowspans must end at the final row');
}
let html = render();
assert.equal((html.match(/<input /g) ?? []).length, 4, 'only the four physical meters accept input');
assert.equal((html.match(/└2F按分用 按分/g) ?? []).length, 2);
for (const [tenant, usage] of [['202', '160.0'], ['201', '240.0']]) {
  const row = bodyRows(html).find((r) => r.includes(`Tenant ${tenant}`));
  assert.ok(row.includes(`>${usage}</strong>`), `${tenant} must show its computed share without a regular meter`);
  assert.ok(!row.includes('<input '));
}
assert.equal(adjustedMeterUsage(parent, meters, () => 100), 400, 'usage mode sums all four physical meters, excluding position meters');
verifyGrid(html, 14);
const totals = html.match(/<tfoot>(.*?)<\/tfoot>/s)[1];
assert.equal((totals.match(/>400.0</g) ?? []).length, 3, 'meter, unit and tenant usage totals count the allocation only once');
assert.equal((totals.match(/>4,000 円</g) ?? []).length, 2, 'unit and tenant amounts count the allocation only once');

const readingMeters = meters.map((m) => ({ ...m, subItem: { ...m.subItem, input_mode: 'reading' } }));
html = render({ meters: readingMeters, values: Object.fromEntries(meters.map((m) => [m.asset_meter_id, '200'])) });
assert.equal((html.match(/<input /g) ?? []).length, 4);
assert.ok(html.includes('>160.0</strong>') && html.includes('>240.0</strong>'));
assert.ok(bodyRows(html).find((r) => r.includes('>電灯</strong>')).includes('>100.0</strong>'), 'representative input shows its own usage');
verifyGrid(html, 16);

const regular = meter('regular', '通常メーター', 19, [assignment('202')]);
html = render({ meters: [...meters, regular] });
assert.ok(html.indexOf('通常メーター') < html.indexOf('└2F按分用 按分'), 'allocation result follows the configured position within the tenant');
assert.equal((html.match(/└2F按分用 按分/g) ?? []).length, 2, 'result is not duplicated after a regular meter');
verifyGrid(html, 14);
verifyGrid(render({ meters: [...meters, regular], taxMode: 'inclusive' }), 15);
const meterScope = render({ meters: [...meters, regular], amountCalculationScope: 'meter' });
verifyGrid(meterScope, 13);
assert.ok(!meterScope.includes('区画ごと</th>'), 'meter scope hides unit usage');
const tenantScope = render({ meters: [...meters, regular], amountCalculationScope: 'tenant' });
verifyGrid(tenantScope, 12);
assert.ok(!tenantScope.includes('区画ごと</th>'), 'tenant scope hides unit usage');
const inclusiveTenantScope = render({ meters: [...meters, regular], amountCalculationScope: 'tenant', taxMode: 'inclusive', subItemTaxMode: 'inclusive' });
verifyGrid(inclusiveTenantScope, 13);
assert.ok(inclusiveTenantScope.includes('金額（税込）') && inclusiveTenantScope.includes('金額（税抜）'), 'tenant scope shows both tax amounts');

// The existing meter-usage allocation (e.g. Sakaisuji-Hommachi) still appends
// results below the tenant's physical meters and keeps source inputs separate.
const legacyParent = { ...parent, allocation_common_source_meter_ids: [], assignments: [
  { ...assignment('202', 1, 'meter_usage'), allocation_source_meter_id: 'legacySource1' },
  { ...assignment('201', 1, 'meter_usage'), allocation_source_meter_id: 'legacySource2' },
] };
const legacySources = [1, 2].map((n) => ({ ...meter(`legacySource${n}`, `按分用${n}`, 11 + n, [assignment(n === 1 ? '202' : '201')]), is_allocation_source: true }));
html = render({ meters: [legacyParent, ...legacySources, regular, meter('regular201', '通常201', 22, [assignment('201')])] });
assert.equal((html.match(/└2F按分用 按分/g) ?? []).length, 2);
verifyGrid(html, 14);

html = render({ usageOnly: true });
assert.ok(html.includes('160.0') && html.includes('240.0'), 'usage-only view includes tenants with allocation meters only');
const mixedContracts = contracts.map((row) => ({ ...row,
  prices: [{ asset_billing_line_item_id: null, unit_price: 12, tax_mode: 'exclusive', billing_month_prices: [] }],
  meterTerms: [{ asset_meter_sub_item_id: 'electric', price_mode: row.unit.unit_id === '202' ? 'fixed' : 'amount', tax_mode: row.unit.unit_id === '202' ? 'exclusive' : 'inclusive' }],
}));
html = render({ contracts: mixedContracts, unitPriceOverride: 20, taxMode: 'inclusive' });
assert.ok(bodyRows(html).find((row) => row.includes('Tenant 202')).includes('>12 円<'), 'fixed tenant keeps its contract price');
assert.ok(bodyRows(html).find((row) => row.includes('Tenant 201')).includes('>20 円<'), 'variable tenant receives the calculated price');
verifyGrid(html, 15);
assert.ok(html.includes('税込<span') && html.includes('税抜<span'), 'unit scope displays gross and net columns when an inclusive contract exists');
assert.ok(bodyRows(html).find((row) => row.includes('Tenant 201')).includes('>4,800 円</span>'), 'inclusive unit amount is displayed before tax conversion');
assert.ok(html.match(/<tfoot>.*?<\/tfoot>/s)[0].includes('>6,284 円</th>'), 'tenant totals add converted net amounts');
const calculatorProps = { itemName: '電気代', category: 'electric', priceMode: 'amount', billingMonth: '2026-11', tariffDefinition: null, rateSourceMeters: [], initialCalculation: {
  billed_inclusive: 110000, billed_tax: 10000, billed_exclusive: 100000, billed_usage: 1000,
  unit_price_adjustment_enabled: true, unit_price_adjustment_factor: 1.2,
  unit_price_rounding_digits: 2, unit_price_rounding_mode: 'round',
}, onSave() {}, onSaveTariff() {}, onClose() {} };
const inclusiveCalculator = renderToStaticMarkup(React.createElement(VariableUnitPriceCalculator, { ...calculatorProps, taxMode: 'inclusive' }));
assert.ok(inclusiveCalculator.includes('132.00 円'), 'inclusive unit price uses gross / usage × adjustment');
assert.ok(!inclusiveCalculator.includes('消費税額') && !inclusiveCalculator.includes('請求金額（税抜）'), 'inclusive mode hides tax and net amount');
const basicChargeCalculator = renderToStaticMarkup(React.createElement(VariableUnitPriceCalculator, { ...calculatorProps, taxMode: 'inclusive', initialCalculation: { ...calculatorProps.initialCalculation, billed_basic_charge: 20000 } }));
assert.ok(basicChargeCalculator.includes('108.00 円'), 'inclusive basic charge is deducted before division and adjustment');
assert.ok(basicChargeCalculator.includes('差し引く基本料（税込）'));
const invalidBasicChargeCalculator = renderToStaticMarkup(React.createElement(VariableUnitPriceCalculator, { ...calculatorProps, taxMode: 'inclusive', initialCalculation: { ...calculatorProps.initialCalculation, billed_basic_charge: 120000 } }));
assert.match(invalidBasicChargeCalculator, /計算単価（税込）<\/span><strong>—<\/strong>/, 'basic charge above gross does not produce a price');
const exclusiveCalculator = renderToStaticMarkup(React.createElement(VariableUnitPriceCalculator, { ...calculatorProps, taxMode: 'exclusive' }));
assert.ok(exclusiveCalculator.includes('120.00 円') && exclusiveCalculator.includes('消費税額'), 'exclusive mode retains tax calculation');
console.log('PASS: combined allocation inputs, usage/reading calculations, tenant positions, totals table layout, inclusive tax layout, usage-only view');
