import type { MeterUnitPriceCalculation } from "../types";

export type UnitPriceAdjustment = Pick<
  MeterUnitPriceCalculation,
  "asset_meter_sub_item_id" | "unit_price_adjustment_enabled" | "unit_price_adjustment_factor"
>;

type DatedUnitPriceAdjustment = UnitPriceAdjustment & { billing_month: string };

// 新しい月から順に受け取り、小分類ごとの直近設定だけを返す。
export function latestUnitPriceAdjustments(rows: DatedUnitPriceAdjustment[]): UnitPriceAdjustment[] {
  const latest = new Map<string, UnitPriceAdjustment>();
  for (const row of rows) {
    if (latest.has(row.asset_meter_sub_item_id)) continue;
    latest.set(row.asset_meter_sub_item_id, {
      asset_meter_sub_item_id: row.asset_meter_sub_item_id,
      unit_price_adjustment_enabled: row.unit_price_adjustment_enabled,
      unit_price_adjustment_factor: Number(row.unit_price_adjustment_factor),
    });
  }
  return [...latest.values()];
}
