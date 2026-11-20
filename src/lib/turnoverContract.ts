import type { ContractUnit } from "../types";

export function contractOccupancyDates(contract: ContractUnit, memberPeriod?: { start: string | null; end: string | null } | null) {
  const starts = [memberPeriod?.start, contract.lease_start_date, contract.contract?.contract_start_date]
    .filter((date): date is string => Boolean(date));
  const ends = [memberPeriod?.end, contract.lease_end_date, contract.contract?.actual_end_date, contract.contract?.contract_end_date]
    .filter((date): date is string => Boolean(date));
  starts.sort();
  ends.sort();
  return { start: starts[starts.length - 1] ?? null, end: ends[0] ?? null };
}

export function contractOccupiesUnitAt(contract: ContractUnit, unitId: string, date: string) {
  const memberIndex = contract.member_unit_ids?.indexOf(unitId) ?? -1;
  const period = memberIndex >= 0 ? contract.member_periods?.[memberIndex] : null;
  if (memberIndex < 0 && contract.unit?.unit_id !== unitId) return false;
  const { start, end } = contractOccupancyDates(contract, period);
  return (!start || start <= date) && (!end || end >= date);
}

export function turnoverOwnerForDate(contracts: ContractUnit[], unitId: string, date: string) {
  return contracts.find((contract) => contractOccupiesUnitAt(contract, unitId, date));
}
