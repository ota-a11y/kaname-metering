import type { UtilityCategory } from "../types";

type BasicBillingItem = {
  asset_meter_sub_item_id: string;
  is_billable: boolean;
};

type ContractWithBasics = {
  basics: Array<{ category: UtilityCategory; amount: number }>;
};

// 設定行が無い旧データは従来どおり請求対象。明示的な false だけを除外する。
export function isBasicChargeBillable(items: BasicBillingItem[] | undefined, subItemId: string): boolean {
  return items?.find((item) => item.asset_meter_sub_item_id === subItemId)?.is_billable !== false;
}

// 基本料の金額は契約区画・請求区画の設定を正とする。
// meter_reading_contract_item.fixed_amount は移行用の保存値であり、金額計算には使わない。
export function contractBasicChargeAmount(contracts: ContractWithBasics[], category: UtilityCategory): number {
  return contracts.reduce(
    (sum, contract) => sum + Number(contract.basics.find((item) => item.category === category)?.amount ?? 0),
    0,
  );
}
