export type OsakaWaterTariffResult = {
  billedUsage: number;
  waterNet: number;
  sewerNet: number;
  waterGross: number;
  sewerGross: number;
  totalNet: number;
  totalGross: number;
  tax: number;
};

export type OsakaWaterTariffTier = { min: number; max: number; rate: number; deduction: number };

export const OSAKA_GENERAL_WATER_TARIFF_CODE = "osaka_general_2019_11_monthly";

export const osakaGeneralWaterTiers: OsakaWaterTariffTier[] = [
  { min: 0, max: 10, rate: 10, deduction: -850 },
  { min: 11, max: 20, rate: 97, deduction: 20 },
  { min: 21, max: 30, rate: 124, deduction: 560 },
  { min: 31, max: 50, rate: 168, deduction: 1880 },
  { min: 51, max: 100, rate: 230, deduction: 4980 },
  { min: 101, max: 200, rate: 293, deduction: 11280 },
  { min: 201, max: 1000, rate: 342, deduction: 21080 },
  { min: 1001, max: Number.POSITIVE_INFINITY, rate: 358, deduction: 37080 },
];

export const osakaGeneralSewerTiers: OsakaWaterTariffTier[] = [
  { min: 0, max: 10, rate: 0, deduction: -550 },
  { min: 11, max: 20, rate: 61, deduction: 60 },
  { min: 21, max: 30, rate: 83, deduction: 500 },
  { min: 31, max: 50, rate: 103, deduction: 1100 },
  { min: 51, max: 100, rate: 119, deduction: 1900 },
  { min: 101, max: 200, rate: 136, deduction: 3600 },
  { min: 201, max: 500, rate: 159, deduction: 8200 },
  { min: 501, max: 1000, rate: 180, deduction: 18700 },
  { min: 1001, max: 5000, rate: 215, deduction: 53700 },
  { min: 5001, max: Number.POSITIVE_INFINITY, rate: 234, deduction: 148700 },
];

function netAmount(usage: number, tiers: OsakaWaterTariffTier[]) {
  const tier = tiers.find((candidate) => usage <= candidate.max) ?? tiers[tiers.length - 1];
  return Math.max(0, tier.rate * usage - tier.deduction);
}

// 大阪市の一般用・1か月分（令和元年11月1日適用）の料金式です。
export function calculateOsakaGeneralWaterTariff(usage: number): OsakaWaterTariffResult {
  const billedUsage = Math.max(0, Math.floor(usage));
  const waterNet = netAmount(billedUsage, osakaGeneralWaterTiers);
  const sewerNet = netAmount(billedUsage, osakaGeneralSewerTiers);
  const waterGross = Math.floor(waterNet * 1.1);
  const sewerGross = Math.floor(sewerNet * 1.1);
  const totalNet = waterNet + sewerNet;
  const totalGross = waterGross + sewerGross;
  return {
    billedUsage,
    waterNet,
    sewerNet,
    waterGross,
    sewerGross,
    totalNet,
    totalGross,
    tax: totalGross - totalNet,
  };
}
