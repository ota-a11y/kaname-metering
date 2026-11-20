import test from 'node:test';
import assert from 'node:assert/strict';
import { contractOccupancyDates, turnoverOwnerForDate } from './turnoverContract.ts';

const contract = (tenantId, start, end) => ({
  unit: { unit_id: 'koriyama-north-202' },
  lease_start_date: start,
  lease_end_date: null,
  contract: { tenant_id: tenantId, contract_start_date: start, contract_end_date: '2027-12-31', actual_end_date: end },
});

test('9/1解約後の9/2は空室として扱う', () => {
  const former = contract('persol', '2026-01-01', '2026-09-01');
  assert.equal(contractOccupancyDates(former).end, '2026-09-01');
  assert.equal(turnoverOwnerForDate([former], 'koriyama-north-202', '2026-09-01')?.contract.tenant_id, 'persol');
  assert.equal(turnoverOwnerForDate([former], 'koriyama-north-202', '2026-09-02'), undefined);
});

test('9/2から新テナントがいれば後半を新テナントへ割り当てる', () => {
  const former = contract('persol', '2026-01-01', '2026-09-01');
  const incoming = contract('next-tenant', '2026-09-02', null);
  assert.equal(turnoverOwnerForDate([former, incoming], 'koriyama-north-202', '2026-09-02')?.contract.tenant_id, 'next-tenant');
});

test('10/10解約・10/21入居では中間区間を空室に割り当てる', () => {
  const former = contract('former', '2026-01-01', '2026-10-10');
  const incoming = contract('incoming', '2026-10-21', null);
  const contracts = [former, incoming];
  assert.equal(turnoverOwnerForDate(contracts, 'koriyama-north-202', '2026-10-01')?.contract.tenant_id, 'former');
  assert.equal(turnoverOwnerForDate(contracts, 'koriyama-north-202', '2026-10-11'), undefined);
  assert.equal(turnoverOwnerForDate(contracts, 'koriyama-north-202', '2026-10-21')?.contract.tenant_id, 'incoming');
});
