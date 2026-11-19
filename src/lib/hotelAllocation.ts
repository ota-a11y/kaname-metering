import type { MeterReadingRow } from '../types';

export type HotelAllocationBuilding = 'fukushima' | 'osaka' | 'kobe';
export type HotelAllocationUtility = 'electric' | 'water' | 'gas';
export type HotelAllocationMeterItem = { id: string; name: string; meterId: string; referenceMethod?: 'meter' | 'special'; specialKey?: string };
export type HotelAllocationMeterGroup = { hotel: HotelAllocationMeterItem[]; tenant: HotelAllocationMeterItem[] };
export type HotelAllocationSpecialResult = { calculation_id: string; result_snapshot: Record<string, number> };

export function calculateHotelAllocation(
  building: HotelAllocationBuilding,
  utility: HotelAllocationUtility,
  month: string,
  draft: Record<string, string>,
  group: HotelAllocationMeterGroup | undefined,
  meters: MeterReadingRow[],
  specialResults: HotelAllocationSpecialResult[],
) {
  if (utility !== 'electric' || !group?.hotel.length) return null;
  const amountRaw = draft[`${building}:${utility}:${month}:amount`] ?? '';
  const totalRaw = draft[`${building}:${utility}:${month}:totalUsage`] ?? '';
  const amount = amountRaw.trim() ? Number(amountRaw.replace(/,/g, '')) : NaN;
  const totalUsage = totalRaw.trim() ? Number(totalRaw.replace(/,/g, '')) : NaN;
  if (!Number.isInteger(amount) || amount < 0 || !Number.isFinite(totalUsage) || totalUsage <= 0) return null;
  const rows = [...group.hotel, ...group.tenant];
  const selectedMeterIds = rows.filter(row => row.referenceMethod !== 'special').map(row => row.meterId).filter(Boolean);
  if (new Set(selectedMeterIds).size !== selectedMeterIds.length) return null;
  const selectedSpecialKeys = group.hotel.filter(row => row.referenceMethod === 'special').map(row => row.specialKey).filter(Boolean);
  if (new Set(selectedSpecialKeys).size !== selectedSpecialKeys.length) return null;
  const usageFor = (row: HotelAllocationMeterItem): number | null => {
    if (row.referenceMethod === 'special') {
      const [calculationId, key] = (row.specialKey ?? '').split(':');
      const value = specialResults.find(result => result.calculation_id === calculationId)?.result_snapshot?.[key];
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }
    const meter = meters.find(candidate => candidate.asset_meter_id === row.meterId);
    const value = meter?.fixedValue?.usage ?? meter?.entry?.usage_amount;
    return value == null ? null : Number(value);
  };
  const hotelValues = group.hotel.map(row => (row.referenceMethod === 'special' ? row.specialKey : row.meterId) ? usageFor(row) : null);
  const tenantValues = group.tenant.map(row => row.meterId ? usageFor(row) : null);
  if ([...hotelValues, ...tenantValues].some(value => value == null || !Number.isFinite(value))) return null;
  const rawHotelUsage = hotelValues.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    - tenantValues.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  if (rawHotelUsage < 0 || rawHotelUsage > totalUsage) return null;
  const hotelAmount = Math.round(amount / totalUsage * rawHotelUsage);
  return {
    rawHotelUsage,
    hotelUsage: Math.round(rawHotelUsage),
    buildingUsage: Math.round(totalUsage - rawHotelUsage),
    hotelAmount,
    buildingAmount: amount - hotelAmount,
  };
}
