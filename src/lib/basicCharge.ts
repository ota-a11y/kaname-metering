import type { UtilityCategory } from "../types";

type BasicBillingItem = {
  asset_meter_sub_item_id: string;
  is_billable: boolean;
};

type ContractWithBasics = {
  basics: Array<{ category: UtilityCategory; amount: number; tax_mode?: "exclusive" | "inclusive" }>;
  lease_start_date?: string | null;
  lease_end_date?: string | null;
  member_periods?: Array<{ start: string | null; end: string | null }>;
  contract?: { contract_start_date: string | null; contract_end_date: string | null; actual_end_date: string | null } | null;
};

const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000;

export function prorateUtilityFixedAmount(amount: number, contract: ContractWithBasics, period: { start: string; end: string }): number {
  const periods = contract.member_periods?.length ? contract.member_periods : [{
    start: contract.lease_start_date ?? contract.contract?.contract_start_date ?? null,
    end: contract.lease_end_date ?? contract.contract?.actual_end_date ?? contract.contract?.contract_end_date ?? null,
  }];
  const occupiedDays = new Set<number>();
  for (const item of periods) {
    const start = Math.max(dayNumber(period.start), item.start ? dayNumber(item.start) : dayNumber(period.start));
    const end = Math.min(dayNumber(period.end), item.end ? dayNumber(item.end) : dayNumber(period.end));
    for (let day = start; day <= end; day++) occupiedDays.add(day);
  }
  const totalDays = dayNumber(period.end) - dayNumber(period.start) + 1;
  if (totalDays <= 0) throw new Error("公共料金の請求期間が正しくありません。");
  return Math.floor(amount * occupiedDays.size / totalDays);
}

// 設定行が無い旧データは従来どおり請求対象。明示的な false だけを除外する。
export function isBasicChargeBillable(items: BasicBillingItem[] | undefined, subItemId: string): boolean {
  return items?.find((item) => item.asset_meter_sub_item_id === subItemId)?.is_billable !== false;
}

// 基本料の金額は契約区画・請求区画の設定を正とする。
// meter_reading_contract_item.fixed_amount は移行用の保存値であり、金額計算には使わない。
// 集計・請求連携へ渡す金額は常に税抜とし、税込契約は区画ごとに割り戻して1円未満を切り上げる。
export function contractBasicChargeAmount(contracts: ContractWithBasics[], category: UtilityCategory, period?: { start: string; end: string }): number {
  return contracts.reduce(
    (sum, contract) => {
      const basic = contract.basics.find((item) => item.category === category);
      if (!basic) return sum;
      const amount = Number(basic.amount ?? 0);
      const exclusive = basic.tax_mode === "inclusive" ? Math.ceil(amount / 1.1) : amount;
      return sum + (period ? prorateUtilityFixedAmount(exclusive, contract, period) : exclusive);
    },
    0,
  );
}
