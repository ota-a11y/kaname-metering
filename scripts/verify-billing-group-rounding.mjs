import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const source = await readFile('src/pages/KanameterWorkspacePage.tsx', 'utf8');
const outfile = resolve('.tmp-runtime/verify-billing-group-rounding-component.mjs');
await build({
  stdin: { contents: `${source}\nexport { calculateUsageCharge, fractionDigits, formatUsage, formatUsagePreservingFraction, roundedMeterUsage };`, loader: 'tsx', resolveDir: resolve('src/pages') },
  bundle: true, packages: 'external', platform: 'node', format: 'esm', jsx: 'automatic',
  define: { 'import.meta.env': '{}' }, outfile,
});
const { calculateUsageCharge, fractionDigits, formatUsage, formatUsagePreservingFraction, roundedMeterUsage } = await import(pathToFileURL(outfile).href);

const rows = [
  { meterId: '503', unitId: '503', chargeGroupId: 'invoice-1', usage: 41.87, price: 34 },
  { meterId: '502', unitId: '502', chargeGroupId: 'invoice-2', usage: 130.45, price: 34 },
];
const first = calculateUsageCharge([rows[0]], 2, 'round', 'tenant');
const second = calculateUsageCharge([rows[1]], 2, 'round', 'tenant');
const tenant = calculateUsageCharge(rows, 2, 'round', 'tenant');
assert.equal(tenant.amount, first.amount + second.amount);
assert.equal(tenant.amount, 5860);
const fixedUsage = calculateUsageCharge([
  { meterId: 'sign', unitId: 'sign', usage: 0.33, usageDigits: fractionDigits(0.33), price: null },
], 0, 'round', 'unit');
assert.equal(fixedUsage.usage, 0.33);
assert.equal(roundedMeterUsage({ subItem: { aggregation_decimal_digits: 0, usage_rounding_mode: 'round' }, fixedValue: { usage: 0.33 } }, 0.33), 0.33);
assert.equal(formatUsage(fixedUsage.usage, fractionDigits(0.33)), '0.33');
assert.equal(formatUsagePreservingFraction(8032.33, 0), '8,032.33');
assert.equal(formatUsagePreservingFraction(0.1 + 0.2, 0), '0.3');
console.log('Split billing group amounts sum to the tenant amount: 5860 yen.');
