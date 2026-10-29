import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Asset,
  AssetUtilitySetting,
  AssetMeterBuildingSetting,
  BillingPeriodPattern,
  BillingLineItem,
  ConfirmedMeterAmount,
  ContractUnit,
  MeterCategorySetting,
  MeterReadingRow,
  MeterSubItem,
  MeterSurcharge,
  MeterTag,
  MeterUnitPriceCalculation,
  MeterUnitOption,
  UtilityCategory,
  UtilityTariffTier,
  UtilityTariffVersion,
} from "../types";

export async function loadUtilityTariff(
  client: SupabaseClient,
  assetId: string,
  billingMonth: string,
): Promise<UtilityTariffVersion | null> {
  const month = `${billingMonth}-01`;
  const { data, error } = await client
    .from("utility_tariff_version")
    .select("utility_tariff_version_id, tariff_name, effective_from, effective_to, tax_rate, tiers:utility_tariff_tier(component, min_usage, max_usage, rate, deduction, sort_order)")
    .eq("asset_id", assetId)
    .eq("tariff_kind", "osaka_general_water")
    .lte("effective_from", month)
    .or(`effective_to.is.null,effective_to.gte.${month}`)
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();
  fail("料金表を読み込めませんでした", error);
  if (!data) return null;
  return {
    ...data,
    tax_rate: Number(data.tax_rate),
    tiers: ((data.tiers ?? []) as UtilityTariffTier[]).map((tier) => ({
      ...tier,
      min_usage: Number(tier.min_usage),
      max_usage: tier.max_usage == null ? null : Number(tier.max_usage),
      rate: Number(tier.rate),
      deduction: Number(tier.deduction),
      sort_order: Number(tier.sort_order),
    })).sort((left, right) => left.component.localeCompare(right.component) || left.sort_order - right.sort_order),
  } as UtilityTariffVersion;
}

export async function saveNextUtilityTariffVersion(
  client: SupabaseClient,
  assetId: string,
  billingMonth: string,
  tariffName: string,
  taxRate: number,
  tiers: UtilityTariffTier[],
) {
  const { data, error } = await client.rpc("save_next_utility_tariff_version", {
    p_asset_id: assetId,
    p_billing_month: `${billingMonth}-01`,
    p_tariff_name: tariffName,
    p_tax_rate: taxRate,
    p_tiers: tiers,
  });
  fail("翌月適用の料金表を保存できませんでした", error);
  return data as string;
}

export async function loadMeterUnitPriceCalculations(
  client: SupabaseClient,
  assetId: string,
  billingMonth: string,
): Promise<MeterUnitPriceCalculation[]> {
  const { data, error } = await client
    .from("meter_reading_month_sub_item")
    .select("asset_meter_sub_item_id, unit_price, billed_inclusive, billed_tax, billed_exclusive, billed_usage, rate_source_meter_id, tariff_code, water_inclusive, sewer_inclusive, unit_price_rounding_digits, unit_price_rounding_mode, unit_price_adjustment_enabled, unit_price_adjustment_factor")
    .eq("asset_id", assetId)
    .eq("billing_month", `${billingMonth}-01`);
  fail("月次単価計算を読み込めませんでした", error);
  return (data ?? []) as MeterUnitPriceCalculation[];
}

export async function saveMeterUnitPriceCalculation(
  client: SupabaseClient,
  assetId: string,
  billingMonth: string,
  calculation: MeterUnitPriceCalculation,
) {
  const month = `${billingMonth}-01`;
  const monthResult = await client.from("meter_reading_month").upsert(
    { asset_id: assetId, billing_month: month },
    { onConflict: "asset_id,billing_month" },
  );
  fail("月次検針データを準備できませんでした", monthResult.error);
  const { error } = await client.from("meter_reading_month_sub_item").upsert({
    asset_id: assetId,
    billing_month: month,
    ...calculation,
  }, { onConflict: "asset_id,billing_month,asset_meter_sub_item_id" });
  fail("月次単価計算を保存できませんでした", error);
}

export async function saveMeterParent(
  client: SupabaseClient,
  meterId: string,
  parentMeterId: string | null,
) {
  const { error } = await client
    .from("asset_meter")
    .update({ parent_asset_meter_id: parentMeterId })
    .eq("asset_meter_id", meterId);
  fail("親メーター設定を保存できませんでした", error);
}

export async function saveMeterTag(
  client: SupabaseClient,
  meterId: string,
  tagId: string | null,
) {
  const { error } = await client.from("asset_meter").update({ asset_meter_tag_id: tagId }).eq("asset_meter_id", meterId);
  fail("メーターのタグを保存できませんでした", error);
}

export async function createMeterTag(
  client: SupabaseClient,
  assetId: string,
  tagName: string,
  color: string,
): Promise<MeterTag> {
  const { data, error } = await client.from("asset_meter_tag").insert({
    asset_id: assetId,
    tag_name: tagName.trim(),
    color,
  }).select("asset_meter_tag_id, asset_id, tag_name, color, created_at").single();
  fail("新しいメータータグを追加できませんでした", error);
  return data as MeterTag;
}

export async function updateMeterTag(
  client: SupabaseClient,
  tagId: string,
  tagName: string,
  color: string,
): Promise<MeterTag> {
  const { data, error } = await client.from("asset_meter_tag").update({
    tag_name: tagName.trim(),
    color,
  }).eq("asset_meter_tag_id", tagId).select("asset_meter_tag_id, asset_id, tag_name, color, created_at").single();
  fail("タグを更新できませんでした", error);
  return data as MeterTag;
}

export async function saveMeterBillingAdjustment(
  client: SupabaseClient,
  meterId: string,
  adjustment: {
    enabled: boolean;
    method: "ratio" | "percent";
    percent: number | null;
    numerator: number | null;
    denominator: number | null;
    note: string;
  },
) {
  const { error } = await client
    .from("asset_meter")
    .update({
      billing_adjustment_enabled: adjustment.enabled,
      billing_adjustment_method: adjustment.enabled ? adjustment.method : null,
      billing_adjustment_percent: adjustment.enabled && adjustment.method === "percent" ? adjustment.percent : null,
      billing_adjustment_numerator: adjustment.enabled && adjustment.method === "ratio" ? adjustment.numerator : null,
      billing_adjustment_denominator: adjustment.enabled && adjustment.method === "ratio" ? adjustment.denominator : null,
      billing_adjustment_note: adjustment.note.trim() || null,
    })
    .eq("asset_meter_id", meterId);
  fail("メーター補正設定を保存できませんでした", error);
}

function withDatabaseMeterParent<T extends { asset_meter_id: string; parent_asset_meter_id?: string | null }>(meter: T) {
  const { parent_asset_meter_id: parentMeterId, ...rest } = meter;
  return {
    ...rest,
    parent_meter_id: parentMeterId ?? null,
  };
}

function fail(context: string, error: { message: string } | null) {
  if (error) throw new Error(`${context}: ${error.message}`);
}

const billingUnitValue = (id: string) => `billing:${id}`;
const billingUnitIdOf = (value: string | null) => value?.startsWith("billing:") ? value.slice(8) : null;
function normalizeAssignment<T extends { unit_id: string | null; lease_contract_billing_unit_id?: string | null; billingUnit?: { billing_unit_name: string; members?: Array<{ contractUnit: { unit: { floor_label: string | null } | Array<{ floor_label: string | null }> } | Array<{ unit: { floor_label: string | null } | Array<{ floor_label: string | null }> }> }> } | Array<{ billing_unit_name: string; members?: Array<{ contractUnit: { unit: { floor_label: string | null } | Array<{ floor_label: string | null }> } | Array<{ unit: { floor_label: string | null } | Array<{ floor_label: string | null }> }> }> }> | null }>(row: T) {
  if (!row.lease_contract_billing_unit_id) return row;
  const billingUnit = Array.isArray(row.billingUnit) ? row.billingUnit[0] : row.billingUnit;
  const member = billingUnit?.members?.[0]?.contractUnit;
  const contractUnit = Array.isArray(member) ? member[0] : member;
  const memberUnit = Array.isArray(contractUnit?.unit) ? contractUnit.unit[0] : contractUnit?.unit;
  return { ...row, unit_id: billingUnitValue(row.lease_contract_billing_unit_id), unit: { unit_id: billingUnitValue(row.lease_contract_billing_unit_id), unit_code: billingUnit?.billing_unit_name ?? "請求区画", unit_name: billingUnit?.billing_unit_name ?? "請求区画", floor_label: memberUnit?.floor_label ?? null, rentable_area_sqm: null } };
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
    .select("category, price_scope, default_unit_price, default_tax_mode, show_in_rent_roll, billing_frequency")
    .eq("asset_id", assetId)
    .order("category");
  fail("ビルの公共料金設定を読み込めませんでした", error);
  return (data ?? []) as AssetUtilitySetting[];
}

export async function saveAssetUtilitySettings(
  client: SupabaseClient,
  assetId: string,
  settings: AssetUtilitySetting[],
) {
  const { error } = await client.from("asset_utility_price_setting").upsert(
    settings.map((setting) => ({ ...setting, asset_id: assetId })),
    { onConflict: "asset_id,category" },
  );
  fail("分類ごとの既定単価設定を保存できませんでした", error);
}

export async function loadAssetMeterBuildingSetting(client: SupabaseClient, assetId: string): Promise<AssetMeterBuildingSetting> {
  const { data, error } = await client.from("asset_meter_building_setting").select("meter_date_mode").eq("asset_id", assetId).maybeSingle();
  fail("ビルの検針日設定を読み込めませんでした", error);
  return { meter_date_mode: data?.meter_date_mode === "category" ? "category" : "shared" };
}

export async function saveAssetMeterBuildingSetting(client: SupabaseClient, assetId: string, setting: AssetMeterBuildingSetting) {
  const { error } = await client.from("asset_meter_building_setting").upsert({ asset_id: assetId, ...setting }, { onConflict: "asset_id" });
  fail("ビルの検針日設定を保存できませんでした", error);
}

export async function loadContractUnits(
  client: SupabaseClient,
  assetId: string,
): Promise<ContractUnit[]> {
  const [contracts, billingUnits, order, meterBilling] = await Promise.all([
    client
      .from("lease_contract_unit")
      .select(
        `lease_contract_unit_id, utility_amount_rounding_mode, unit:unit_master!inner(unit_id, unit_code, unit_name, floor_label, unit_type, property_id), contract:lease_contract!inner(lease_contract_id, tenant_id, contract_status, contract_start_date, contract_end_date, tenant:tenant_master(tenant_name)), prices:lease_contract_unit_utility_price(asset_billing_line_item_id, unit_price, tax_mode, billing_month_prices, item:asset_billing_line_item(line_item_name)), categoryPrices:lease_contract_unit_category_price(category, unit_price, tax_mode, billing_month_prices), basics:lease_contract_unit_basic_charge(category, amount, tax_mode)`,
      )
      .eq("unit.property_id", assetId)
      .order("lease_contract_unit_id"),
    client
      .from("lease_contract_billing_unit")
      .select(`lease_contract_billing_unit_id, billing_unit_name, contract:lease_contract!inner(lease_contract_id, tenant_id, contract_status, contract_start_date, contract_end_date, tenant:tenant_master(tenant_name)), members:lease_contract_billing_unit_member!inner(contractUnit:lease_contract_unit!inner(lease_contract_unit_id, utility_amount_rounding_mode, unit:unit_master!inner(unit_id, floor_label, property_id))), prices:lease_contract_billing_unit_utility_price(asset_billing_line_item_id, unit_price, tax_mode, billing_month_prices, item:asset_billing_line_item(line_item_name)), categoryPrices:lease_contract_billing_unit_category_price(category, unit_price, tax_mode, billing_month_prices), basics:lease_contract_billing_unit_basic_charge(category, amount, tax_mode)`)
      .eq("members.contractUnit.unit.property_id", assetId)
      .order("sort_order"),
    client
      .from("asset_billing_tenant_order")
      .select("tenant_id, sort_order")
      .eq("asset_id", assetId),
    client
      .from("meter_reading_contract")
      .select("meter_reading_contract_id, tenant_id, row_no, invoice_number, split_label, electric_billable, water_billable, gas_billable, electric_sum_mode, water_sum_mode, gas_sum_mode, amount_rounding_mode, units:meter_reading_contract_unit(unit_id), items:meter_reading_contract_item(asset_meter_sub_item_id, is_billable, fixed_amount)")
      .eq("asset_id", assetId),
  ]);
  fail("契約ごとの公共料金設定を読み込めませんでした", contracts.error);
  fail("請求区画ごとの公共料金設定を読み込めませんでした", billingUnits.error);
  fail("テナントの並び順を読み込めませんでした", order.error);
  fail("テナントの請求設定を読み込めませんでした", meterBilling.error);
  const rank = new Map(
    (order.data ?? []).map((row) => [row.tenant_id, row.sort_order]),
  );
  type BillingMemberUnit = { lease_contract_unit_id: string; utility_amount_rounding_mode: ContractUnit["utility_amount_rounding_mode"]; unit: { unit_id: string; floor_label: string | null } | Array<{ unit_id: string; floor_label: string | null }> };
  const asArray = <T>(value: T | T[] | null | undefined): T[] => value == null ? [] : Array.isArray(value) ? value : [value];
  const billingRows = ((billingUnits.data ?? []) as unknown as Array<{ lease_contract_billing_unit_id: string; billing_unit_name: string; contract: ContractUnit["contract"] | ContractUnit["contract"][]; members: Array<{ contractUnit: BillingMemberUnit | BillingMemberUnit[] }>; prices: ContractUnit["prices"]; categoryPrices: ContractUnit["categoryPrices"]; basics: ContractUnit["basics"] }>).filter((row) => row.members.length > 0);
  const groupedContractUnitIds = new Set(billingRows.flatMap((row) => row.members.flatMap((member) => asArray(member.contractUnit).map((unit) => unit.lease_contract_unit_id))));
  const rows = ((contracts.data ?? []) as unknown as ContractUnit[]).filter((row) => !groupedContractUnitIds.has(row.lease_contract_unit_id));
  for (const billing of billingRows) {
    const members = billing.members.flatMap((member) => asArray(member.contractUnit));
    const contract = Array.isArray(billing.contract) ? billing.contract[0] : billing.contract;
    rows.push({
      lease_contract_unit_id: billing.lease_contract_billing_unit_id,
      lease_contract_billing_unit_id: billing.lease_contract_billing_unit_id,
      member_unit_ids: members.flatMap((member) => asArray(member.unit).map((unit) => unit.unit_id)),
      utility_amount_rounding_mode: members[0]?.utility_amount_rounding_mode ?? "floor",
      unit: { unit_id: billingUnitValue(billing.lease_contract_billing_unit_id), unit_code: billing.billing_unit_name, unit_name: billing.billing_unit_name, floor_label: asArray(members[0]?.unit)[0]?.floor_label ?? null, unit_type: "office" },
      contract: contract ?? null,
      prices: billing.prices ?? [], categoryPrices: billing.categoryPrices ?? [], basics: billing.basics ?? [], meterBilling: [],
    });
  }
  for (const row of rows) {
    const tenantSettings = (meterBilling.data ?? [])
      .filter((setting) => setting.tenant_id === row.contract?.tenant_id)
      .sort((left, right) => left.row_no - right.row_no);
    const matchingSetting = tenantSettings.find((setting) =>
      setting.units?.some((unit: { unit_id: string }) => (row.member_unit_ids ?? [row.unit?.unit_id]).includes(unit.unit_id)),
    );
    // 分割行のどこにも明示されていない区画は、KANAMEと同じく1行目へ含める。
    row.meterBilling = matchingSetting ? [matchingSetting] : tenantSettings.slice(0, 1);
  }
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
  comparisonMonthOffset = 1,
): Promise<{ rows: MeterReadingRow[]; status: "draft" | "confirmed" | null }> {
  const month = `${billingMonth}-01`;
  const previousMonth = new Date(Date.UTC(
    Number(billingMonth.slice(0, 4)),
    Number(billingMonth.slice(5, 7)) - 1 - comparisonMonthOffset,
    1,
  ))
    .toISOString()
    .slice(0, 10);
  const [metersResult, entriesResult, previousEntriesResult, monthResult, allocationSourcesResult, commonSourcesResult] = await Promise.all([
    client
      .from("asset_meter")
      .select(
        `asset_meter_id, use_reading_input, parent_asset_meter_id, is_rate_source, sort_order, meter_code, meter_label, billing_adjustment_enabled, billing_adjustment_method, billing_adjustment_percent, billing_adjustment_numerator, billing_adjustment_denominator, billing_adjustment_note, tag:asset_meter_tag(asset_meter_tag_id, asset_id, tag_name, color), subItem:asset_meter_sub_item!inner(asset_meter_sub_item_id, category, sub_item_name, input_mode, input_decimal_digits, aggregation_decimal_digits, usage_rounding_mode), assignments:asset_meter_unit_assignment!asset_meter_unit_assignment_asset_meter_id_fkey(asset_meter_unit_assignment_id, unit_id, lease_contract_billing_unit_id, effective_from, effective_to, allocation_method, allocation_weight, area_sqm_snapshot, allocation_source_meter_id, unit:unit_master(unit_id, unit_code, unit_name, floor_label, rentable_area_sqm), billingUnit:lease_contract_billing_unit(billing_unit_name, members:lease_contract_billing_unit_member(contractUnit:lease_contract_unit(unit:unit_master(floor_label)))))`,
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
      .from("meter_reading_entry")
      .select("asset_meter_id, current_reading")
      .eq("asset_id", assetId)
      .eq("billing_month", previousMonth),
    client
      .from("meter_reading_month")
      .select("status")
      .eq("asset_id", assetId)
      .eq("billing_month", month)
      .maybeSingle(),
    client
      .from("asset_meter_unit_assignment")
      .select("allocation_source_meter_id")
      .not("allocation_source_meter_id", "is", null),
    client.from("asset_meter_allocation_common_source").select("asset_meter_id, source_asset_meter_id"),
  ]);
  fail("メーターを読み込めませんでした", metersResult.error);
  fail("保存済みの検針値を読み込めませんでした", entriesResult.error);
  fail("前月の検針値を読み込めませんでした", previousEntriesResult.error);
  fail("対象月の状態を読み込めませんでした", monthResult.error);
  fail("按分用メーターを読み込めませんでした", allocationSourcesResult.error);
  fail("共用部の按分用メーターを読み込めませんでした", commonSourcesResult.error);
  const allocationSourceIds = new Set([
    ...(allocationSourcesResult.data ?? []).map((row) => row.allocation_source_meter_id),
    ...(commonSourcesResult.data ?? []).map((row) => row.source_asset_meter_id),
  ]);
  const entries = new Map(
    (entriesResult.data ?? []).map((entry) => [entry.asset_meter_id, entry]),
  );
  const previousReadings = new Map(
    (previousEntriesResult.data ?? []).map((entry) => [
      entry.asset_meter_id,
      entry.current_reading,
    ]),
  );
  return {
    rows: (metersResult.data ?? []).map((meter) => {
      const currentEntry = entries.get(meter.asset_meter_id);
      const previousReading = previousReadings.get(meter.asset_meter_id);
      const normalizedAssignments = (meter.assignments ?? []).map(normalizeAssignment);
      const latestEffectiveFrom = normalizedAssignments.reduce(
        (latest: string, assignment: { effective_from: string }) => assignment.effective_from > latest ? assignment.effective_from : latest,
        "",
      );
      // 実装検証中は適用開始日を遡って、常に最新の紐づけ・按分設定で過去月も表示・計算する。
      // 本運用の確定月は、ここを請求月時点の設定を読むスナップショット方式へ戻す。
      const displayAssignments = normalizedAssignments.filter(
        (assignment: { effective_from: string }) => assignment.effective_from === latestEffectiveFrom,
      ).sort(
        (left: { effective_from: string }, right: { effective_from: string }) => right.effective_from.localeCompare(left.effective_from),
      );
      return withDatabaseMeterParent({
        ...meter,
        is_allocation_source: allocationSourceIds.has(meter.asset_meter_id),
        allocation_common_source_meter_ids: (commonSourcesResult.data ?? []).filter((row) => row.asset_meter_id === meter.asset_meter_id).map((row) => row.source_asset_meter_id),
        assignments: displayAssignments,
        entry: currentEntry
          ? {
              ...currentEntry,
              previous_reading: previousReading ?? null,
            }
          : previousReading == null
            ? null
            : {
                asset_meter_id: meter.asset_meter_id,
                usage_amount: null,
                previous_reading: previousReading,
                current_reading: null,
              },
      });
    }) as unknown as MeterReadingRow[],
    status:
      (monthResult.data?.status as "draft" | "confirmed" | undefined) ?? null,
  };
}

export async function loadMeterUsageHistory(
  client: SupabaseClient,
  assetId: string,
  billingMonth: string,
  comparisonMonthOffset = 1,
): Promise<{
  previous: Record<string, number>;
  previousYear: Record<string, number>;
}> {
  const year = Number(billingMonth.slice(0, 4));
  const monthIndex = Number(billingMonth.slice(5, 7)) - 1;
  const previousMonth = new Date(Date.UTC(year, monthIndex - comparisonMonthOffset, 1))
    .toISOString()
    .slice(0, 10);
  const previousYearMonth = new Date(Date.UTC(year - 1, monthIndex, 1))
    .toISOString()
    .slice(0, 10);
  const { data, error } = await client
    .from("meter_reading_entry")
    .select("asset_meter_id, billing_month, usage_amount")
    .eq("asset_id", assetId)
    .in("billing_month", [previousMonth, previousYearMonth]);
  fail("比較用の検針値を読み込めませんでした", error);

  const previous: Record<string, number> = {};
  const previousYear: Record<string, number> = {};
  for (const row of data ?? []) {
    const target = row.billing_month === previousMonth ? previous : previousYear;
    target[row.asset_meter_id] = Number(row.usage_amount ?? 0);
  }
  return { previous, previousYear };
}

export async function loadMeterManagement(
  client: SupabaseClient,
  assetId: string,
): Promise<{ meters: MeterReadingRow[]; units: MeterUnitOption[]; tags: MeterTag[] }> {
  const [meters, units, billingUnits, tags, allocationSources, commonSources] = await Promise.all([
    client
      .from("asset_meter")
      .select(
        `asset_meter_id, use_reading_input, parent_asset_meter_id, is_rate_source, sort_order, meter_code, meter_label, billing_adjustment_enabled, billing_adjustment_method, billing_adjustment_percent, billing_adjustment_numerator, billing_adjustment_denominator, billing_adjustment_note, tag:asset_meter_tag(asset_meter_tag_id, asset_id, tag_name, color), subItem:asset_meter_sub_item!inner(asset_meter_sub_item_id, category, sub_item_name, input_mode, input_decimal_digits, aggregation_decimal_digits, usage_rounding_mode), assignments:asset_meter_unit_assignment!asset_meter_unit_assignment_asset_meter_id_fkey(asset_meter_unit_assignment_id, unit_id, lease_contract_billing_unit_id, effective_from, effective_to, allocation_method, allocation_weight, area_sqm_snapshot, allocation_source_meter_id, unit:unit_master(unit_id, unit_code, unit_name, floor_label, rentable_area_sqm), billingUnit:lease_contract_billing_unit(billing_unit_name, members:lease_contract_billing_unit_member(contractUnit:lease_contract_unit(unit:unit_master(floor_label)))))`,
      )
      .eq("asset_id", assetId)
      .eq("is_active", true)
      .order("sort_order"),
    client
      .from("unit_master")
      .select("unit_id, unit_code, unit_name, floor_label, unit_type, rentable_area_sqm")
      .eq("property_id", assetId)
      .eq("is_active", true)
      .in("unit_type", ["office", "warehouse", "storage", "equipment", "other"])
      .order("floor_label")
      .order("unit_code"),
    client.from("lease_contract_billing_unit").select("lease_contract_billing_unit_id, billing_unit_name, sort_order, contract:lease_contract!inner(tenant:tenant_master(tenant_name)), members:lease_contract_billing_unit_member!inner(contractUnit:lease_contract_unit!inner(unit_id, unit:unit_master!inner(unit_id, unit_code, unit_name, floor_label, rentable_area_sqm, property_id)))").eq("members.contractUnit.unit.property_id", assetId).order("sort_order"),
    client.from("asset_meter_tag").select("asset_meter_tag_id, asset_id, tag_name, color, created_at").eq("asset_id", assetId).order("created_at").order("asset_meter_tag_id"),
    client.from("asset_meter_unit_assignment").select("allocation_source_meter_id").not("allocation_source_meter_id", "is", null),
    client.from("asset_meter_allocation_common_source").select("asset_meter_id, source_asset_meter_id"),
  ]);
  fail("メーター設定を読み込めませんでした", meters.error);
  fail("区画を読み込めませんでした", units.error);
  fail("請求区画を読み込めませんでした", billingUnits.error);
  fail("メータータグを読み込めませんでした", tags.error);
  fail("按分用メーターを読み込めませんでした", allocationSources.error);
  fail("共用部の按分用メーターを読み込めませんでした", commonSources.error);
  const allocationSourceIds = new Set([
    ...(allocationSources.data ?? []).map((row) => row.allocation_source_meter_id),
    ...(commonSources.data ?? []).map((row) => row.source_asset_meter_id),
  ]);
  type BillingPhysicalUnit = { unit_id: string; unit: { unit_id: string; unit_code: string; unit_name: string | null; floor_label: string | null; rentable_area_sqm: number | null } | Array<{ unit_id: string; unit_code: string; unit_name: string | null; floor_label: string | null; rentable_area_sqm: number | null }> };
  const billingRows = ((billingUnits.data ?? []) as unknown as Array<{ lease_contract_billing_unit_id: string; billing_unit_name: string; sort_order: number; contract: { tenant: { tenant_name: string } | Array<{ tenant_name: string }> | null } | Array<{ tenant: { tenant_name: string } | Array<{ tenant_name: string }> | null }>; members: Array<{ contractUnit: BillingPhysicalUnit | BillingPhysicalUnit[] }> }>).filter((row) => row.members.length > 0);
  const asArray = <T>(value: T | T[] | null | undefined): T[] => value == null ? [] : Array.isArray(value) ? value : [value];
  const physicalUnits = (units.data ?? []) as MeterUnitOption[];
  const groupedPhysicalUnitIds = new Set(billingRows.flatMap((row) => row.members.flatMap((member) => asArray(member.contractUnit).map((unit) => unit.unit_id))));
  const billingOptions = billingRows.map((row) => {
    const memberUnits = row.members.flatMap((member) => asArray(member.contractUnit)).flatMap((contractUnit) => asArray(contractUnit.unit));
    const firstUnit = memberUnits.slice().sort((left, right) => physicalUnits.findIndex((unit) => unit.unit_id === left.unit_id) - physicalUnits.findIndex((unit) => unit.unit_id === right.unit_id))[0];
    const contract = asArray(row.contract)[0];
    const tenant = asArray(contract?.tenant)[0];
    const baseOrder = Math.max(0, physicalUnits.findIndex((unit) => unit.unit_id === firstUnit?.unit_id));
    const area = memberUnits.every((unit) => Number(unit.rentable_area_sqm) > 0) ? memberUnits.reduce((sum, unit) => sum + Number(unit.rentable_area_sqm), 0) : null;
    return { unit_id: billingUnitValue(row.lease_contract_billing_unit_id), billing_unit_id: row.lease_contract_billing_unit_id, unit_code: firstUnit?.unit_code ?? row.billing_unit_name, unit_name: row.billing_unit_name, floor_label: firstUnit?.floor_label ?? null, rentable_area_sqm: area, unit_type: "office" as const, tenant_name: tenant?.tenant_name ?? null, source_sort_order: baseOrder * 1000 + row.sort_order };
  });
  return {
    meters: (meters.data ?? []).map((meter) => withDatabaseMeterParent({ ...meter, is_allocation_source: allocationSourceIds.has(meter.asset_meter_id), allocation_common_source_meter_ids: (commonSources.data ?? []).filter((row) => row.asset_meter_id === meter.asset_meter_id).map((row) => row.source_asset_meter_id), assignments: (meter.assignments ?? []).map(normalizeAssignment) })) as unknown as MeterReadingRow[],
    units: [
      ...physicalUnits.map((row, index) => ({ ...row, source_sort_order: index * 1000 })).filter((row) => !groupedPhysicalUnitIds.has(row.unit_id)),
      ...billingOptions,
    ],
    tags: (tags.data ?? []) as MeterTag[],
  };
}

export async function createMeter(
  client: SupabaseClient,
  assetId: string,
  subItemId: string,
  meterCode: string,
  unitId: string | null,
) {
  const billingUnitId = unitId ? billingUnitIdOf(unitId) : null;
  const { data, error } = billingUnitId
    ? await client.rpc("create_kanameter_meter_for_billing_unit", { p_asset_id: assetId, p_asset_meter_sub_item_id: subItemId, p_meter_code: meterCode, p_lease_contract_billing_unit_id: billingUnitId })
    : await client.rpc("create_kanameter_meter", { p_asset_id: assetId, p_asset_meter_sub_item_id: subItemId, p_meter_code: meterCode, p_unit_id: unitId });
  fail("メーターを追加できませんでした", error);
  return data as string;
}

export async function assignMeterUnit(
  client: SupabaseClient,
  meterId: string,
  unitId: string | null,
  effectiveFrom: string,
) {
  const billingUnitId = unitId ? billingUnitIdOf(unitId) : null;
  if (billingUnitId) {
    const { error } = await client.rpc("assign_kanameter_meter_billing_unit_from", { p_asset_meter_id: meterId, p_lease_contract_billing_unit_id: billingUnitId, p_effective_from: effectiveFrom });
    fail("請求区画を変更できませんでした", error);
    return;
  }
  const { error } = await client.rpc("assign_kanameter_meter_unit_from", {
    p_asset_meter_id: meterId,
    p_unit_id: unitId,
    p_effective_from: effectiveFrom,
  });
  fail("区画を変更できませんでした", error);
}

export async function assignMeterUnits(
  client: SupabaseClient,
  meterId: string,
  method: "area" | "ratio" | "meter_usage",
  allocations: Array<{ unitId: string; weight: number; sourceMeterId?: string | null; sourceMeterName?: string | null; sourceMeterLabel?: string | null; sourceMeterTagId?: string | null }>,
  effectiveFrom: string,
) {
  const { error } = await client.rpc("assign_kanameter_meter_units_with_sources_from", {
    p_asset_meter_id: meterId,
    p_method: method,
    p_allocations: allocations.map((row) => ({ unit_id: billingUnitIdOf(row.unitId) || row.unitId === "__common__" ? null : row.unitId, billing_unit_id: billingUnitIdOf(row.unitId), common_area: row.unitId === "__common__", weight: row.weight, source_meter_id: row.sourceMeterId ?? null, source_meter_name: row.sourceMeterName?.trim() || null, source_meter_label: row.sourceMeterLabel?.trim() || null, source_meter_tag_id: row.sourceMeterTagId ?? null })),
    p_effective_from: effectiveFrom,
  });
  fail("複数区画の按分設定を保存できませんでした", error);
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

export async function loadAllocationSourceMeterIds(
  client: SupabaseClient,
  meterId: string,
) {
  const [assignments, commonSources] = await Promise.all([
    client
      .from("asset_meter_unit_assignment")
      .select("allocation_source_meter_id")
      .eq("asset_meter_id", meterId)
      .not("allocation_source_meter_id", "is", null),
    client
      .from("asset_meter_allocation_common_source")
      .select("source_asset_meter_id")
      .eq("asset_meter_id", meterId),
  ]);
  fail("按分用メーターを読み込めませんでした", assignments.error ?? commonSources.error);
  return [
    ...(assignments.data ?? []).flatMap((row) => row.allocation_source_meter_id ? [row.allocation_source_meter_id] : []),
    ...(commonSources.data ?? []).map((row) => row.source_asset_meter_id),
  ];
}

export async function updateMeterSubItemDisplaySettings(
  client: SupabaseClient,
  subItemId: string,
  settings: {
    inputMode: "usage" | "reading" | "mixed";
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
): Promise<{ meterDates: Record<UtilityCategory, string | null>; previousMeterDates: Record<UtilityCategory, string | null> }> {
  const month = `${billingMonth}-01`;
  const previousMonth = new Date(Date.UTC(Number(billingMonth.slice(0, 4)), Number(billingMonth.slice(5, 7)) - 2, 1))
    .toISOString()
    .slice(0, 10);
  const [current, previous] = await Promise.all([
    client.from("meter_reading_month").select("meter_date, meter_date_electric, meter_date_water, meter_date_gas").eq("asset_id", assetId).eq("billing_month", month).maybeSingle(),
    client.from("meter_reading_month").select("meter_date, meter_date_electric, meter_date_water, meter_date_gas").eq("asset_id", assetId).eq("billing_month", previousMonth).maybeSingle(),
  ]);
  fail("検針日を読み込めませんでした", current.error);
  fail("前月の検針日を読み込めませんでした", previous.error);
  const dates = (row: typeof current.data) => ({
    electric: row?.meter_date_electric ?? row?.meter_date ?? null,
    water: row?.meter_date_water ?? row?.meter_date ?? null,
    gas: row?.meter_date_gas ?? row?.meter_date ?? null,
  });
  return { meterDates: dates(current.data), previousMeterDates: dates(previous.data) };
}

export async function loadAvailableMeterReadingMonths(
  client: SupabaseClient,
  assetId: string,
): Promise<Array<{ billingMonth: string; meterDates: Record<UtilityCategory, string | null> }>> {
  const { data, error } = await client
    .from("meter_reading_month")
    .select("billing_month, meter_date, meter_date_electric, meter_date_water, meter_date_gas")
    .eq("asset_id", assetId)
    .order("billing_month", { ascending: false });
  fail("KANAMEの対象期間を読み込めませんでした", error);
  return (data ?? []).map((row) => ({
    billingMonth: String(row.billing_month).slice(0, 7),
    meterDates: { electric: row.meter_date_electric ?? row.meter_date ?? null, water: row.meter_date_water ?? row.meter_date ?? null, gas: row.meter_date_gas ?? row.meter_date ?? null },
  }));
}

export async function saveMeterReadingDate(
  client: SupabaseClient,
  assetId: string,
  billingMonth: string,
  category: UtilityCategory,
  meterDate: string,
) {
  const column = `meter_date_${category}`;
  const { error } = await client.from("meter_reading_month").upsert(
    { asset_id: assetId, billing_month: `${billingMonth}-01`, [column]: meterDate },
    { onConflict: "asset_id,billing_month" },
  );
  fail("検針日を保存できませんでした", error);
}

export async function saveSharedMeterReadingDate(client: SupabaseClient, assetId: string, billingMonth: string, meterDate: string) {
  const { error } = await client.from("meter_reading_month").upsert({ asset_id: assetId, billing_month: `${billingMonth}-01`, meter_date: meterDate, meter_date_electric: meterDate, meter_date_water: meterDate, meter_date_gas: meterDate }, { onConflict: "asset_id,billing_month" });
  fail("共通検針日を保存できませんでした", error);
}

export async function saveMeterInputOverride(client: SupabaseClient, meterId: string, useReadingInput: boolean) {
  const { error } = await client.from("asset_meter").update({ use_reading_input: useReadingInput, updated_at: new Date().toISOString() }).eq("asset_meter_id", meterId);
  fail("メーターの入力方法を保存できませんでした", error);
}

export async function loadMonthlyFixedCharges(
  client: SupabaseClient,
  assetId: string,
  billingMonth: string,
): Promise<Array<{ meter_reading_contract_id: string; lease_contract_unit_id: string; asset_meter_sub_item_id: string; amount: number }>> {
  const { data, error } = await client
    .from("meter_reading_month_fixed_charge")
    .select("billing_month, meter_reading_contract_id, lease_contract_unit_id, asset_meter_sub_item_id, amount")
    .eq("asset_id", assetId)
    .lte("billing_month", `${billingMonth}-01`)
    .order("billing_month", { ascending: false });
  fail("月額定額を読み込めませんでした", error);
  const latest = new Map<string, { meter_reading_contract_id: string; lease_contract_unit_id: string; asset_meter_sub_item_id: string; amount: number }>();
  for (const row of data ?? []) {
    const key = `${row.lease_contract_unit_id}|${row.asset_meter_sub_item_id}`;
    if (!latest.has(key)) latest.set(key, {
      meter_reading_contract_id: row.meter_reading_contract_id,
      lease_contract_unit_id: row.lease_contract_unit_id,
      asset_meter_sub_item_id: row.asset_meter_sub_item_id,
      amount: Number(row.amount),
    });
  }
  return Array.from(latest.values());
}

export async function saveMonthlyFixedCharge(
  client: SupabaseClient,
  assetId: string,
  billingMonth: string,
  contractId: string | null,
  tenantId: string,
  leaseContractUnitId: string,
  subItemId: string,
  amount: number,
): Promise<string> {
  let effectiveContractId = contractId;
  if (!effectiveContractId) {
    const existing = await client
      .from("meter_reading_contract")
      .select("meter_reading_contract_id")
      .eq("asset_id", assetId)
      .eq("tenant_id", tenantId)
      .order("row_no")
      .limit(1)
      .maybeSingle();
    fail("請求グループを確認できませんでした", existing.error);
    effectiveContractId = existing.data?.meter_reading_contract_id ?? null;
    if (!effectiveContractId) {
      const created = await client
        .from("meter_reading_contract")
        .insert({ asset_id: assetId, tenant_id: tenantId, row_no: 1 })
        .select("meter_reading_contract_id")
        .single();
      fail("請求グループを準備できませんでした", created.error);
      effectiveContractId = created.data!.meter_reading_contract_id;
    }
  }
  const month = `${billingMonth}-01`;
  const monthResult = await client.from("meter_reading_month").upsert(
    { asset_id: assetId, billing_month: month },
    { onConflict: "asset_id,billing_month" },
  );
  fail("月次検針データを準備できませんでした", monthResult.error);
  const { error } = await client.from("meter_reading_month_fixed_charge").upsert({
    asset_id: assetId,
    billing_month: month,
    meter_reading_contract_id: effectiveContractId,
    lease_contract_unit_id: leaseContractUnitId,
    asset_meter_sub_item_id: subItemId,
    amount,
  }, { onConflict: "asset_id,billing_month,lease_contract_unit_id,asset_meter_sub_item_id" });
  fail("月額定額を保存できませんでした", error);
  return effectiveContractId as string;
}

export async function loadSurchargeEvidence(
  client: SupabaseClient,
  assetId: string,
  billingMonth: string,
  surchargeId: string,
) {
  const { data, error } = await client
    .from("meter_reading_month_surcharge")
    .select("unit_price, purchase_period_start, purchase_period_end, purchase_usage, purchase_amount_inclusive")
    .eq("asset_id", assetId)
    .eq("billing_month", `${billingMonth}-01`)
    .eq("asset_meter_surcharge_id", surchargeId)
    .maybeSingle();
  fail("増額分の仕入データを読み込めませんでした", error);
  return data as { unit_price: number | null; purchase_period_start: string | null; purchase_period_end: string | null; purchase_usage: number | null; purchase_amount_inclusive: number | null } | null;
}

export async function saveSurchargeEvidence(
  client: SupabaseClient,
  values: {
    assetId: string;
    billingMonth: string;
    surchargeId: string;
    unitPrice: number;
    periodStart: string | null;
    periodEnd: string | null;
    purchaseUsage: number;
    purchaseAmountInclusive: number;
  },
) {
  const { error } = await client.from("meter_reading_month_surcharge").upsert({
    asset_id: values.assetId,
    billing_month: `${values.billingMonth}-01`,
    asset_meter_surcharge_id: values.surchargeId,
    unit_price: values.unitPrice,
    purchase_period_start: values.periodStart,
    purchase_period_end: values.periodEnd,
    purchase_usage: values.purchaseUsage,
    purchase_amount_inclusive: values.purchaseAmountInclusive,
  }, { onConflict: "asset_id,billing_month,asset_meter_surcharge_id" });
  fail("増額分の仕入データを保存できませんでした", error);
}

export async function saveSurchargeCalculationSettings(
  client: SupabaseClient,
  surchargeId: string,
  calculationScope: "tenant" | "unit",
  recoveryInclusiveMode: "from_exclusive" | "use_calculated_inclusive",
) {
  const { error } = await client.from("asset_meter_surcharge").update({ calculation_scope: calculationScope }).eq("asset_meter_surcharge_id", surchargeId);
  fail("増額分の計算設定を保存できませんでした", error);
  const recoveryModeResult = await client.from("asset_meter_surcharge").update({
    recovery_inclusive_mode: recoveryInclusiveMode,
  }).eq("asset_meter_surcharge_id", surchargeId);
  // DBマイグレーション適用前はブラウザー保存を利用する。列追加後は自動的にDB保存へ切り替わる。
  if (recoveryModeResult.error && !["42703", "PGRST204"].includes(recoveryModeResult.error.code ?? "")) {
    fail("回収税込金額の算出方法を保存できませんでした", recoveryModeResult.error);
  }
}

export async function loadMeteringConfiguration(
  client: SupabaseClient,
  assetId: string,
): Promise<{
  categories: MeterCategorySetting[];
  subItems: MeterSubItem[];
  surcharges: MeterSurcharge[];
  periodPatterns: BillingPeriodPattern[];
}> {
  const defaultCategories: MeterCategorySetting[] = [
    { category: "electric", usage_unit: "kWh", is_billable: true, is_basic_billable: false, basic_charge_method: "fixed", basic_charge_fixed_amount: null, basic_charge_area_unit_price: null },
    { category: "water", usage_unit: "m³", is_billable: true, is_basic_billable: false, basic_charge_method: "fixed", basic_charge_fixed_amount: null, basic_charge_area_unit_price: null },
    { category: "gas", usage_unit: "m³", is_billable: true, is_basic_billable: false, basic_charge_method: "fixed", basic_charge_fixed_amount: null, basic_charge_area_unit_price: null },
  ];
  const defaultPeriods = [
    { pattern_name: "前月分", start_month_offset: -1, start_day_type: "first", start_meter_day_offset: 0, end_month_offset: -1, end_day_type: "last", end_meter_day_offset: 0, sort_order: 0 },
    { pattern_name: "当月分", start_month_offset: 0, start_day_type: "first", start_meter_day_offset: 0, end_month_offset: 0, end_day_type: "last", end_meter_day_offset: 0, sort_order: 1 },
    { pattern_name: "翌月分", start_month_offset: 1, start_day_type: "first", start_meter_day_offset: 0, end_month_offset: 1, end_day_type: "last", end_meter_day_offset: 0, sort_order: 2 },
    { pattern_name: "検針期間（前月検針日を含める）", start_month_offset: -1, start_day_type: "meter", start_meter_day_offset: 0, end_month_offset: 0, end_day_type: "meter", end_meter_day_offset: 0, sort_order: 3 },
    { pattern_name: "検針期間（前月検針日を含めない）", start_month_offset: -1, start_day_type: "meter", start_meter_day_offset: 1, end_month_offset: 0, end_day_type: "meter", end_meter_day_offset: 0, sort_order: 4 },
    { pattern_name: "前々月から2か月分", start_month_offset: -2, start_day_type: "first", start_meter_day_offset: 0, end_month_offset: -1, end_day_type: "last", end_meter_day_offset: 0, sort_order: 5 },
    { pattern_name: "前月から2か月分", start_month_offset: -1, start_day_type: "first", start_meter_day_offset: 0, end_month_offset: 0, end_day_type: "last", end_meter_day_offset: 0, sort_order: 6 },
    { pattern_name: "当月から2か月分", start_month_offset: 0, start_day_type: "first", start_meter_day_offset: 0, end_month_offset: 1, end_day_type: "last", end_meter_day_offset: 0, sort_order: 7 },
    { pattern_name: "検針期間（前々月検針日を含める）", start_month_offset: -2, start_day_type: "meter", start_meter_day_offset: 0, end_month_offset: 0, end_day_type: "meter", end_meter_day_offset: 0, sort_order: 8 },
    { pattern_name: "検針期間（前々月検針日を含めない）", start_month_offset: -2, start_day_type: "meter", start_meter_day_offset: 1, end_month_offset: 0, end_day_type: "meter", end_meter_day_offset: 0, sort_order: 9 },
  ];
  const currentPeriods = await client
    .from("asset_billing_period_pattern")
    .select("pattern_name, start_month_offset, start_day_type, start_meter_day_offset, end_month_offset, end_day_type, end_meter_day_offset")
    .eq("asset_id", assetId);
  fail("請求期間パターンを確認できませんでした", currentPeriods.error);
  const currentPeriodNames = new Set((currentPeriods.data ?? []).map((row) => row.pattern_name));
  const missingPeriods = defaultPeriods.filter((row) => !currentPeriodNames.has(row.pattern_name));
  if (missingPeriods.length) {
    const created = await client.from("asset_billing_period_pattern").insert(missingPeriods.map((row) => ({ ...row, asset_id: assetId })));
    fail("既定の請求期間パターンを作成できませんでした", created.error);
  }
  const currentCategories = await client
    .from("asset_meter_category_setting")
    .select("category")
    .eq("asset_id", assetId);
  fail("請求対象の分類設定を確認できませんでした", currentCategories.error);
  const configuredCategories = new Set(
    (currentCategories.data ?? []).map((row) => row.category),
  );
  const missingCategories = defaultCategories.filter(
    (row) => !configuredCategories.has(row.category),
  );
  if (missingCategories.length) {
    const created = await client.from("asset_meter_category_setting").insert(
      missingCategories.map((row) => ({ ...row, asset_id: assetId })),
    );
    fail("既定の分類設定を作成できませんでした", created.error);
  }
  const currentSurcharges = await client
    .from("asset_meter_surcharge")
    .select("asset_meter_surcharge_id")
    .eq("asset_id", assetId)
    .eq("category", "electric")
    .eq("surcharge_name", "増額分")
    .limit(1);
  fail("増額分設定を確認できませんでした", currentSurcharges.error);
  if (!currentSurcharges.data?.length) {
    const created = await client.from("asset_meter_surcharge").insert({
      asset_id: assetId,
      category: "electric",
      surcharge_name: "増額分",
      is_billable: false,
    });
    fail("既定の増額分設定を作成できませんでした", created.error);
  }
  const [categories, subItems, surcharges, periodPatterns] = await Promise.all([
    client
      .from("asset_meter_category_setting")
      .select("category, usage_unit, is_billable, is_basic_billable, basic_charge_method, basic_charge_fixed_amount, basic_charge_area_unit_price")
      .eq("asset_id", assetId)
      .order("category"),
    client
      .from("asset_meter_sub_item")
      .select(
        "asset_meter_sub_item_id, category, sub_item_name, sub_item_kind, asset_billing_line_item_id, sort_order, input_mode, input_decimal_digits, aggregation_decimal_digits, usage_rounding_mode, billing_period_pattern_id, price_mode, default_unit_price, tax_mode, tax_rounding_mode, show_unit_price_on_invoice, is_monthly_fixed",
      )
      .eq("asset_id", assetId)
      .order("sort_order"),
    client
      .from("asset_meter_surcharge")
      .select("asset_meter_surcharge_id, category, surcharge_name, asset_billing_line_item_id, is_billable, billing_period_pattern_id, calculation_scope")
      .eq("asset_id", assetId)
      .order("created_at"),
    client
      .from("asset_billing_period_pattern")
      .select("billing_period_pattern_id, pattern_name, start_month_offset, start_day_type, start_meter_day_offset, end_month_offset, end_day_type, end_meter_day_offset")
      .eq("asset_id", assetId),
  ]);
  fail("請求対象の分類設定を読み込めませんでした", categories.error);
  fail("小分類を読み込めませんでした", subItems.error);
  fail("増額分設定を読み込めませんでした", surcharges.error);
  fail("請求期間パターンを読み込めませんでした", periodPatterns.error);
  const recoveryModes = await client
    .from("asset_meter_surcharge")
    .select("asset_meter_surcharge_id, recovery_inclusive_mode")
    .eq("asset_id", assetId);
  if (recoveryModes.error && !["42703", "PGRST204"].includes(recoveryModes.error.code ?? "")) {
    fail("回収税込金額の算出方法を読み込めませんでした", recoveryModes.error);
  }
  const recoveryModeById = new Map((recoveryModes.data ?? []).map((row) => [row.asset_meter_surcharge_id, row.recovery_inclusive_mode]));
  return {
    categories: (categories.data ?? []) as MeterCategorySetting[],
    subItems: (subItems.data ?? []) as MeterSubItem[],
    surcharges: (surcharges.data ?? []).map((row) => {
      const recoveryInclusiveMode = recoveryModeById.get(row.asset_meter_surcharge_id);
      return recoveryInclusiveMode ? { ...row, recovery_inclusive_mode: recoveryInclusiveMode } : row;
    }) as MeterSurcharge[],
    periodPatterns: (periodPatterns.data ?? []) as BillingPeriodPattern[],
  };
}

export async function loadBillingLineItems(client: SupabaseClient, assetId: string): Promise<BillingLineItem[]> {
  const { data, error } = await client
    .from("asset_billing_line_item")
    .select("asset_billing_line_item_id, line_item_name, display_name, charge:billing_charge_type!inner(charge_type_name, utility_kind)")
    .eq("asset_id", assetId)
    .eq("is_active", true)
    .order("sort_order");
  fail("請求明細項目を読み込めませんでした", error);
  return (data ?? []).map((row) => {
    const charge = Array.isArray(row.charge) ? row.charge[0] : row.charge;
    const utilityKind = charge?.utility_kind;
    const isSurcharge = charge?.charge_type_name === "電気代増額分";
    const utilityCategory = isSurcharge || utilityKind === "electricity" || charge?.charge_type_name === "電気代"
      ? "electric"
      : utilityKind === "water" || charge?.charge_type_name === "水道代"
        ? "water"
        : utilityKind === "gas" || charge?.charge_type_name === "ガス代"
          ? "gas"
          : null;
    return {
      asset_billing_line_item_id: row.asset_billing_line_item_id,
      line_item_name: row.line_item_name,
      display_name: row.display_name,
      utility_category: utilityCategory,
      charge_type_name: charge?.charge_type_name ?? "",
      is_surcharge: Boolean(isSurcharge),
    } as BillingLineItem;
  });
}

export async function saveMeteringSettings(
  client: SupabaseClient,
  assetId: string,
  categories: MeterCategorySetting[],
  subItems: MeterSubItem[],
  surcharges: MeterSurcharge[],
  removedSubItemIds: string[] = [],
) {
  const categoryResult = await client.from("asset_meter_category_setting").upsert(
    categories.map((row) => ({
      asset_id: assetId,
      category: row.category,
      usage_unit: row.usage_unit,
      is_billable: row.is_billable,
      is_basic_billable: row.is_basic_billable,
      basic_charge_method: row.basic_charge_method,
      basic_charge_fixed_amount: null,
      basic_charge_area_unit_price: row.basic_charge_method === "sqm" || row.basic_charge_method === "tsubo" ? row.basic_charge_area_unit_price : null,
    })),
    { onConflict: "asset_id,category" },
  );
  fail("分類設定を保存できませんでした", categoryResult.error);
  if (removedSubItemIds.length) {
    const removed = await client.from("asset_meter_sub_item").delete().in("asset_meter_sub_item_id", removedSubItemIds);
    fail("削除した小分類を保存できませんでした", removed.error);
  }
  const subItemResult = await client.from("asset_meter_sub_item").upsert(
    subItems.map((row) => ({
      asset_meter_sub_item_id: row.asset_meter_sub_item_id,
      asset_id: assetId,
      category: row.category,
      sub_item_name: row.sub_item_name,
      sub_item_kind: row.sub_item_kind,
      asset_billing_line_item_id: row.asset_billing_line_item_id,
      sort_order: row.sort_order,
      input_mode: row.input_mode,
      input_decimal_digits: row.input_decimal_digits,
      aggregation_decimal_digits: row.aggregation_decimal_digits,
      usage_rounding_mode: row.usage_rounding_mode,
      billing_period_pattern_id: row.billing_period_pattern_id,
      price_mode: row.sub_item_kind === "basic" ? "fixed" : row.price_mode,
      default_unit_price: row.sub_item_kind === "basic" ? null : row.default_unit_price,
      tax_mode: row.tax_mode,
      tax_rounding_mode: row.tax_rounding_mode,
      show_unit_price_on_invoice: row.show_unit_price_on_invoice,
      is_monthly_fixed: row.sub_item_kind === "custom" && row.is_monthly_fixed,
    })),
  );
  fail("小分類設定を保存できませんでした", subItemResult.error);
  const surchargeResult = await client.from("asset_meter_surcharge").upsert(
    surcharges.map((row) => ({
      asset_meter_surcharge_id: row.asset_meter_surcharge_id,
      asset_id: assetId,
      category: row.category,
      surcharge_name: row.surcharge_name,
      asset_billing_line_item_id: row.asset_billing_line_item_id,
      is_billable: row.is_billable,
      billing_period_pattern_id: row.billing_period_pattern_id,
      calculation_scope: row.calculation_scope,
      recovery_inclusive_mode: row.recovery_inclusive_mode,
    })),
  );
  fail("増額分設定を保存できませんでした", surchargeResult.error);
}

export async function saveMeterReading(
  client: SupabaseClient,
  assetId: string,
  billingMonth: string,
  meterId: string,
  value: number,
  usageOverride?: number,
) {
  const { data, error } = await client.rpc("save_kanameter_reading", {
    p_asset_id: assetId,
    p_billing_month: `${billingMonth}-01`,
    p_asset_meter_id: meterId,
    p_value: value,
  });
  fail("検針値を保存できませんでした", error);
  const saved = data?.[0] as {
    usage_amount: number;
    previous_reading: number | null;
    current_reading: number | null;
    month_status: "draft";
    saved_at: string;
  };
  if (usageOverride !== undefined) {
    const { error: overrideError } = await client
      .from("meter_reading_entry")
      .update({ usage_amount: usageOverride })
      .eq("asset_id", assetId)
      .eq("billing_month", `${billingMonth}-01`)
      .eq("asset_meter_id", meterId);
    fail("一周補正後の使用量を保存できませんでした", overrideError);
    saved.usage_amount = usageOverride;
  }
  return saved;
}

export async function clearMeterReading(
  client: SupabaseClient,
  assetId: string,
  billingMonth: string,
  meterId: string,
) {
  const { error } = await client
    .from("meter_reading_entry")
    .delete()
    .eq("asset_id", assetId)
    .eq("billing_month", `${billingMonth}-01`)
    .eq("asset_meter_id", meterId);
  fail("検針値を未入力に戻せませんでした", error);
}

export async function saveMeterName(
  client: SupabaseClient,
  meterId: string,
  meterName: string,
) {
  const { error } = await client
    .from("asset_meter")
    .update({ meter_code: meterName.trim() })
    .eq("asset_meter_id", meterId);
  fail("メーター名を保存できませんでした", error);
}

export async function confirmMeterReadingMonth(
  client: SupabaseClient,
  assetId: string,
  billingMonth: string,
  amounts: ConfirmedMeterAmount[],
) {
  const { data, error } = await client.rpc("confirm_kanameter_month_with_amounts", {
    p_asset_id: assetId,
    p_billing_month: `${billingMonth}-01`,
    p_amounts: amounts,
  });
  fail("検針データを確定できませんでした", error);
  return data as string;
}

export async function releaseMeterReadingMonth(
  client: SupabaseClient,
  assetId: string,
  billingMonth: string,
) {
  const { error } = await client.rpc("release_kanameter_month", {
    p_asset_id: assetId,
    p_billing_month: `${billingMonth}-01`,
  });
  fail("検針データの確定を解除できませんでした", error);
}
