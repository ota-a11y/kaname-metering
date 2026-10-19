import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Asset,
  AssetUtilitySetting,
  ContractUnit,
  MeterCategorySetting,
  MeterReadingRow,
  MeterSubItem,
  MeterSurcharge,
  MeterUnitOption,
  UtilityCategory,
} from "../types";

function fail(context: string, error: { message: string } | null) {
  if (error) throw new Error(`${context}: ${error.message}`);
}

export async function loadBillingAssets(
  client: SupabaseClient,
): Promise<Asset[]> {
  const { data, error } = await client
    .from("asset_master")
    .select("asset_id, asset_code, asset_name, short_name")
    .eq("is_tenant_billing_enabled", true)
    .order("asset_code");
  fail("請求対象ビルを読み込めませんでした", error);
  return (data ?? []) as Asset[];
}

export async function loadAssetUtilitySettings(
  client: SupabaseClient,
  assetId: string,
): Promise<AssetUtilitySetting[]> {
  const { data, error } = await client
    .from("asset_utility_price_setting")
    .select("category, price_scope, default_unit_price, default_tax_mode")
    .eq("asset_id", assetId)
    .order("category");
  fail("ビルの公共料金設定を読み込めませんでした", error);
  return (data ?? []) as AssetUtilitySetting[];
}

export async function loadContractUnits(
  client: SupabaseClient,
  assetId: string,
): Promise<ContractUnit[]> {
  const [contracts, order] = await Promise.all([
    client
      .from("lease_contract_unit")
      .select(
        `lease_contract_unit_id, utility_amount_rounding_mode, unit:unit_master!inner(unit_id, unit_code, unit_name, floor_label, unit_type, property_id), contract:lease_contract!inner(lease_contract_id, tenant_id, tenant:tenant_master(tenant_name)), prices:lease_contract_unit_utility_price(asset_billing_line_item_id, unit_price, tax_mode, item:asset_billing_line_item(line_item_name)), categoryPrices:lease_contract_unit_category_price(category, unit_price, tax_mode), basics:lease_contract_unit_basic_charge(category, amount, tax_mode)`,
      )
      .eq("unit.property_id", assetId)
      .order("lease_contract_unit_id"),
    client
      .from("asset_billing_tenant_order")
      .select("tenant_id, sort_order")
      .eq("asset_id", assetId),
  ]);
  fail("契約ごとの公共料金設定を読み込めませんでした", contracts.error);
  fail("テナントの並び順を読み込めませんでした", order.error);
  const rank = new Map(
    (order.data ?? []).map((row) => [row.tenant_id, row.sort_order]),
  );
  const rows = (contracts.data ?? []) as unknown as ContractUnit[];
  return rows.sort(
    (left, right) =>
      (rank.get(left.contract?.tenant_id ?? "") ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(right.contract?.tenant_id ?? "") ?? Number.MAX_SAFE_INTEGER) ||
      (left.unit?.floor_label ?? "").localeCompare(
        right.unit?.floor_label ?? "",
        "ja-JP",
        { numeric: true },
      ) ||
      (left.unit?.unit_code ?? "").localeCompare(
        right.unit?.unit_code ?? "",
        "ja-JP",
        { numeric: true },
      ),
  );
}

export async function loadMeterReadings(
  client: SupabaseClient,
  assetId: string,
  billingMonth: string,
  category: UtilityCategory,
): Promise<{ rows: MeterReadingRow[]; status: "draft" | "confirmed" | null }> {
  const month = `${billingMonth}-01`;
  const monthEnd = new Date(Date.UTC(
    Number(billingMonth.slice(0, 4)),
    Number(billingMonth.slice(5, 7)),
    0,
  ))
    .toISOString()
    .slice(0, 10);
  const [metersResult, entriesResult, monthResult] = await Promise.all([
    client
      .from("asset_meter")
      .select(
        `asset_meter_id, sort_order, meter_code, meter_label, subItem:asset_meter_sub_item!inner(asset_meter_sub_item_id, category, sub_item_name, input_mode, input_decimal_digits, aggregation_decimal_digits, usage_rounding_mode), assignments:asset_meter_unit_assignment(asset_meter_unit_assignment_id, unit_id, effective_from, effective_to, unit:unit_master(unit_id, unit_code, unit_name, floor_label))`,
      )
      .eq("asset_id", assetId)
      .eq("is_active", true)
      .eq("subItem.category", category)
      .order("sort_order"),
    client
      .from("meter_reading_entry")
      .select("asset_meter_id, usage_amount, previous_reading, current_reading")
      .eq("asset_id", assetId)
      .eq("billing_month", month),
    client
      .from("meter_reading_month")
      .select("status")
      .eq("asset_id", assetId)
      .eq("billing_month", month)
      .maybeSingle(),
  ]);
  fail("メーターを読み込めませんでした", metersResult.error);
  fail("保存済みの検針値を読み込めませんでした", entriesResult.error);
  fail("対象月の状態を読み込めませんでした", monthResult.error);
  const entries = new Map(
    (entriesResult.data ?? []).map((entry) => [entry.asset_meter_id, entry]),
  );
  return {
    rows: (metersResult.data ?? []).map((meter) => ({
      ...meter,
      assignments: (meter.assignments ?? []).filter(
        (assignment: { effective_from: string; effective_to: string | null }) =>
          assignment.effective_from <= monthEnd &&
          (!assignment.effective_to || assignment.effective_to >= month),
      ),
      entry: entries.get(meter.asset_meter_id) ?? null,
    })) as unknown as MeterReadingRow[],
    status:
      (monthResult.data?.status as "draft" | "confirmed" | undefined) ?? null,
  };
}

export async function loadMeterManagement(
  client: SupabaseClient,
  assetId: string,
): Promise<{ meters: MeterReadingRow[]; units: MeterUnitOption[] }> {
  const [meters, units] = await Promise.all([
    client
      .from("asset_meter")
      .select(
        `asset_meter_id, sort_order, meter_code, meter_label, subItem:asset_meter_sub_item!inner(asset_meter_sub_item_id, category, sub_item_name, input_mode, input_decimal_digits, aggregation_decimal_digits, usage_rounding_mode), assignments:asset_meter_unit_assignment(asset_meter_unit_assignment_id, unit_id, effective_from, effective_to, unit:unit_master(unit_id, unit_code, unit_name, floor_label))`,
      )
      .eq("asset_id", assetId)
      .eq("is_active", true)
      .order("sort_order"),
    client
      .from("unit_master")
      .select("unit_id, unit_code, unit_name, floor_label")
      .eq("property_id", assetId)
      .eq("is_active", true)
      .order("floor_label")
      .order("unit_code"),
  ]);
  fail("メーター設定を読み込めませんでした", meters.error);
  fail("区画を読み込めませんでした", units.error);
  return {
    meters: (meters.data ?? []) as unknown as MeterReadingRow[],
    units: (units.data ?? []) as MeterUnitOption[],
  };
}

export async function createMeter(
  client: SupabaseClient,
  assetId: string,
  subItemId: string,
  meterCode: string,
  unitId: string,
) {
  const { error } = await client.rpc("create_kanameter_meter", {
    p_asset_id: assetId,
    p_asset_meter_sub_item_id: subItemId,
    p_meter_code: meterCode,
    p_unit_id: unitId,
  });
  fail("メーターを追加できませんでした", error);
}

export async function assignMeterUnit(
  client: SupabaseClient,
  meterId: string,
  unitId: string,
) {
  const { error } = await client.rpc("assign_kanameter_meter_unit", {
    p_asset_meter_id: meterId,
    p_unit_id: unitId,
  });
  fail("区画を変更できませんでした", error);
}

export async function deleteMeter(client: SupabaseClient, meterId: string) {
  const { error } = await client.rpc("delete_kanameter_meter", {
    p_asset_meter_id: meterId,
  });
  fail("メーターを削除できませんでした", error);
}

export async function reorderMeters(
  client: SupabaseClient,
  assetId: string,
  subItemId: string,
  meterIds: string[],
) {
  const { error } = await client.rpc("reorder_kanameter_meters", {
    p_asset_id: assetId,
    p_asset_meter_sub_item_id: subItemId,
    p_asset_meter_ids: meterIds,
  });
  fail("メーターの並び順を保存できませんでした", error);
}

export async function updateMeterSubItemDisplaySettings(
  client: SupabaseClient,
  subItemId: string,
  settings: {
    inputMode: "usage" | "reading";
    inputDecimalDigits: number;
    aggregationDecimalDigits: number;
    usageRoundingMode: "floor" | "round" | "ceil";
  },
) {
  const { error } = await client
    .from("asset_meter_sub_item")
    .update({
      input_mode: settings.inputMode,
      input_decimal_digits: settings.inputDecimalDigits,
      aggregation_decimal_digits: settings.aggregationDecimalDigits,
      usage_rounding_mode: settings.usageRoundingMode,
      updated_at: new Date().toISOString(),
    })
    .eq("asset_meter_sub_item_id", subItemId);
  fail("メーターの桁数設定を保存できませんでした", error);
}

export async function loadMeterReadingPeriod(
  client: SupabaseClient,
  assetId: string,
  billingMonth: string,
): Promise<{ meterDate: string | null; previousMeterDate: string | null }> {
  const month = `${billingMonth}-01`;
  const previousMonth = new Date(Date.UTC(Number(billingMonth.slice(0, 4)), Number(billingMonth.slice(5, 7)) - 2, 1))
    .toISOString()
    .slice(0, 10);
  const [current, previous] = await Promise.all([
    client.from("meter_reading_month").select("meter_date").eq("asset_id", assetId).eq("billing_month", month).maybeSingle(),
    client.from("meter_reading_month").select("meter_date").eq("asset_id", assetId).eq("billing_month", previousMonth).maybeSingle(),
  ]);
  fail("検針日を読み込めませんでした", current.error);
  fail("前月の検針日を読み込めませんでした", previous.error);
  return {
    meterDate: current.data?.meter_date ?? null,
    previousMeterDate: previous.data?.meter_date ?? null,
  };
}

export async function saveMeterReadingDate(
  client: SupabaseClient,
  assetId: string,
  billingMonth: string,
  meterDate: string,
) {
  const { error } = await client.from("meter_reading_month").upsert(
    { asset_id: assetId, billing_month: `${billingMonth}-01`, meter_date: meterDate },
    { onConflict: "asset_id,billing_month" },
  );
  fail("検針日を保存できませんでした", error);
}

export async function loadMeteringConfiguration(
  client: SupabaseClient,
  assetId: string,
): Promise<{
  categories: MeterCategorySetting[];
  subItems: MeterSubItem[];
  surcharges: MeterSurcharge[];
}> {
  const [categories, subItems, surcharges] = await Promise.all([
    client
      .from("asset_meter_category_setting")
      .select("category, usage_unit, is_billable, is_basic_billable")
      .eq("asset_id", assetId)
      .order("category"),
    client
      .from("asset_meter_sub_item")
      .select(
        "asset_meter_sub_item_id, category, sub_item_name, sub_item_kind, asset_billing_line_item_id, sort_order, input_mode, input_decimal_digits, aggregation_decimal_digits, usage_rounding_mode",
      )
      .eq("asset_id", assetId)
      .order("sort_order"),
    client
      .from("asset_meter_surcharge")
      .select("asset_meter_surcharge_id, category, surcharge_name, is_billable")
      .eq("asset_id", assetId)
      .order("created_at"),
  ]);
  fail("請求対象の分類設定を読み込めませんでした", categories.error);
  fail("小分類を読み込めませんでした", subItems.error);
  fail("増額分設定を読み込めませんでした", surcharges.error);
  return {
    categories: (categories.data ?? []) as MeterCategorySetting[],
    subItems: (subItems.data ?? []) as MeterSubItem[],
    surcharges: (surcharges.data ?? []) as MeterSurcharge[],
  };
}

export async function saveMeterReading(
  client: SupabaseClient,
  assetId: string,
  billingMonth: string,
  meterId: string,
  value: number,
) {
  const { data, error } = await client.rpc("save_kanameter_reading", {
    p_asset_id: assetId,
    p_billing_month: `${billingMonth}-01`,
    p_asset_meter_id: meterId,
    p_value: value,
  });
  fail("検針値を保存できませんでした", error);
  return data?.[0] as {
    usage_amount: number;
    previous_reading: number | null;
    current_reading: number | null;
    month_status: "draft";
    saved_at: string;
  };
}

export async function confirmMeterReadingMonth(
  client: SupabaseClient,
  assetId: string,
  billingMonth: string,
) {
  const { data, error } = await client.rpc("confirm_kanameter_month", {
    p_asset_id: assetId,
    p_billing_month: `${billingMonth}-01`,
  });
  fail("検針データを確定できませんでした", error);
  return data as string;
}
