import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

globalThis.localStorage = { getItem: () => null };

const source = await readFile('src/pages/KanameterWorkspacePage.tsx', 'utf8');
const outfile = resolve('.tmp-runtime/verify-split-billing-totals-component.mjs');
await build({
  stdin: { contents: `${source}\nexport { CustomItemTable };`, loader: 'tsx', resolveDir: resolve('src/pages') },
  bundle: true, packages: 'external', platform: 'node', format: 'esm', jsx: 'automatic',
  define: { 'import.meta.env': '{}' }, outfile,
});
const { CustomItemTable } = await import(pathToFileURL(outfile).href);

const unit = (id) => ({ unit_id: id, unit_code: id, unit_name: id, floor_label: '6', unit_type: 'office' });
const splitTenant = { lease_contract_id: 'split-contract', tenant_id: 'split-tenant', tenant: { tenant_name: '東洋熱工業(株)' } };
const contract = (unitId, billingId) => ({
  lease_contract_unit_id: unitId, unit: unit(unitId), utility_amount_rounding_mode: 'round', contract: splitTenant,
  prices: [], categoryPrices: [], basics: [], meterTerms: [],
  meterBilling: [{ meter_reading_contract_id: billingId, split_label: billingId, units: [], billingUnits: [], items: [] }],
});
const meter = (id, order, unitId) => ({
  asset_meter_id: id, meter_code: id, meter_label: null, sort_order: order,
  parent_meter_id: null, is_rate_source: false, is_allocation_source: false,
  billing_adjustment_enabled: false, allocation_common_source_meter_ids: [],
  assignments: [{ unit_id: unitId, unit: unit(unitId), allocation_method: 'single', allocation_weight: 1 }],
  subItem: { asset_meter_sub_item_id: 'electric', category: 'electric', input_mode: 'usage', input_decimal_digits: 1, aggregation_decimal_digits: 1, usage_rounding_mode: 'round' },
  entry: null,
});
const contracts = [contract('rent-a', 'rent'), contract('rent-b', 'rent'), contract('storage-a', 'storage')];
const meters = [meter('rent-meter-a', 1, 'rent-a'), meter('rent-meter-b', 2, 'rent-b'), meter('storage-meter-a', 3, 'storage-a')];
const html = renderToStaticMarkup(React.createElement(CustomItemTable, {
  billingMonth: '2026-11', meters, contracts, category: 'electric', lineItemId: null,
  defaultUnitPrice: 26.77, variablePriceForUnpricedOnly: false, taxMode: 'exclusive',
  amountCalculationScope: 'tenant', taxRoundingMode: 'round',
  values: { 'rent-meter-a': '1008', 'rent-meter-b': '1010', 'storage-meter-a': '1' },
  saveStates: {}, confirmed: false, usageHistory: { previous: {}, previousYear: {} },
  rolloverValues: {}, columnStorageUserId: 'test', usageOnly: false, onChange() {}, onBlur() {},
}));
const unitUsageTotals = [...html.matchAll(/class="numeric unit-total[^>]*><span class="merged-value">(.*?)<\/span>/g)].map((match) => match[1]);
const unitAmountTotals = [...html.matchAll(/class="numeric unit-amount[^>]*><span class="merged-value">(.*?)<\/span>/g)].map((match) => match[1]);
const tenantTotals = [...html.matchAll(/class="numeric tenant-total"[^>]*><span class="merged-value">(.*?)<\/span>/g)].map((match) => match[1]);
assert.deepEqual(unitUsageTotals, ['2,018.0', '1.0'], 'unit usage totals follow the two split billing records');
assert.deepEqual(unitAmountTotals, ['54,022 円', '27 円'], 'each displayed split usage is multiplied once and rounded once');
assert.deepEqual(tenantTotals, ['2,019.0', '54,049 円'], 'tenant total remains the sum of the displayed split records');
console.log('PASS: split records control unit totals while tenant totals remain unchanged');
