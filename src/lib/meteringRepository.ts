import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Asset,
  AssetUtilitySetting,
  BillingPeriodPattern,
  BillingLineItem,
  ContractUnit,
  MeterCategorySetting,
  MeterReadingRow,
  MeterSubItem,
  MeterSurcharge,
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
    .select("asset_meter_sub_item_id, unit_price, billed_inclusive, billed_tax, billed_exclusive, billed_usage, rate_source_meter_id, tariff_code, water_inclusive, sewer_inclusive, unit_price_rounding_digits, unit_price_rounding_mode")
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
    .select("category, price_scope, default_unit_price, default_tax_mode, show_in_rent_roll")
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

export async function loadContractUnits(
  client: SupabaseClient,
  assetId: string,
): Promise<ContractUnit[]> {
  const [contracts, order, meterBilling] = await Promise.all([
    client
      .from("lease_contract_unit")
      .select(
        `lease_contract_unit_id, utility_amount_rounding_mode, unit:unit_master!inner(unit_id, unit_code, unit_name, floor_label, unit_type, property_id), contract:lease_contract!inner(lease_contract_id, tenant_id, contract_status, contract_start_date, contract_end_date, tenant:tenant_master(tenant_name)), prices:lease_contract_unit_utility_price(asset_billing_line_item_id, unit_price, tax_mode, item:asset_billing_line_item(line_item_name)), categoryPrices:lease_contract_unit_category_price(category, unit_price, tax_mode), basics:lease_contract_unit_basic_charge(category, amount, tax_mode)`,
      )
      .eq("unit.property_id", assetId)
      .order("lease_contract_unit_id"),
    client
      .from("asset_billing_tenant_order")
      .select("tenant_id, sort_order")
      .eq("asset_id", assetId),
    client
      .from("meter_reading_contract")
      .select("meter_reading_contract_id, tenant_id, row_no, split_label, electric_billable, water_billable, gas_billable, electric_sum_mode, water_sum_mode, gas_sum_mode, amount_rounding_mode, units:meter_reading_contract_unit(unit_id)")
      .eq("asset_id", assetId),
  ]);
  fail("契約ごとの公共料金設定を読み込めませんでした", contracts.error);
  fail("テナントの並び順を読み込めませんでした", order.error);
  fail("テナントの請求設定を読み込めませんでした", meterBilling.error);
  const rank = new Map(
    (order.data ?? []).map((row) => [row.tenant_id, row.sort_order]),
  );
  const rows = (contracts.data ?? []) as unknown as ContractUnit[];
  for (const row of rows) {
    const tenantSettings = (meterBilling.data ?? [])
      .filter((setting) => setting.tenant_id === row.contract?.tenant_id)
      .sort((left, right) => left.row_no - right.row_no);
    const matchingSetting = tenantSettings.find((setting) =>
      setting.units?.some((unit: { unit_id: string }) => unit.unit_id === row.unit?.unit_id),
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
): Promise<{ rows: MeterReadingRow[]; status: "draft" | "confirmed" | null }> {
  const month = `${billingMonth}-01`;
  const previousMonth = new Date(Date.UTC(
    Number(billingMonth.slice(0, 4)),
    Number(billingMonth.slice(5, 7)) - 2,
    1,
  ))
    .toISOString()
    .slice(0, 10);
  const monthEnd = new Date(Date.UTC(
    Number(billingMonth.slice(0, 4)),
    Number(billingMonth.slice(5, 7)),
    0,
  ))
    .toISOString()
    .slice(0, 10);
  const [metersResult, entriesResult, previousEntriesResult, monthResult] = await Promise.all([
    client
      .from("asset_meter")
      .select(
        `asset_meter_id, parent_asset_meter_id, is_rate_source, sort_order, meter_code, meter_label, subItem:asset_meter_sub_item!inner(asset_meter_sub_item_id, category, sub_item_name, input_mode, input_decimal_digits, aggregation_decimal_digits, usage_rounding_mode), assignments:asset_meter_unit_assignment(asset_meter_unit_assignment_id, unit_id, effective_from, effective_to, unit:unit_master(unit_id, unit_code, unit_name, floor_label))`,
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
  ]);
  fail("メーターを読み込めませんでした", metersResult.error);
  fail("保存済みの検針値を読み込めませんでした", entriesResult.error);
  fail("前月の検針値を読み込めませんでした", previousEntriesResult.error);
  fail("対象月の状態を読み込めませんでした", monthResult.error);
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
      return withDatabaseMeterParent({
        ...meter,
        assignments: (meter.assignments ?? []).filter(
          (assignment: { effective_from: string; effective_to: string | null }) =>
            assignment.effective_from <= monthEnd &&
            (!assignment.effective_to || assignment.effective_to >= month),
        ),
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
): Promise<{
  previous: Record<string, number>;
  previousYear: Record<string, number>;
}> {
  const year = Number(billingMonth.slice(0, 4));
  const monthIndex = Number(billingMonth.slice(5, 7)) - 1;
  const previousMonth = new Date(Date.UTC(year, monthIndex - 1, 1))
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
): Promise<{ meters: MeterReadingRow[]; units: MeterUnitOption[] }> {
  const [meters, units] = await Promise.all([
    client
      .from("asset_meter")
      .select(
        `asset_meter_id, parent_asset_meter_id, is_rate_source, sort_order, meter_code, meter_label, subItem:asset_meter_sub_item!inner(asset_meter_sub_item_id, category, sub_item_name, input_mode, input_decimal_digits, aggregation_decimal_digits, usage_rounding_mode), assignments:asset_meter_unit_assignment(asset_meter_unit_assignment_id, unit_id, effective_from, effective_to, unit:unit_master(unit_id, unit_code, unit_name, floor_label))`,
      )
      .eq("asset_id", assetId)
      .eq("is_active", true)
      .order("sort_order"),
    client
      .from("unit_master")
      .select("unit_id, unit_code, unit_name, floor_label, unit_type")
      .eq("property_id", assetId)
      .eq("is_active", true)
      .in("unit_type", ["office", "warehouse", "storage"])
      .order("floor_label")
      .order("unit_code"),
  ]);
  fail("メーター設定を読み込めませんでした", meters.error);
  fail("区画を読み込めませんでした", units.error);
  return {
    meters: (meters.data ?? []).map((meter) => withDatabaseMeterParent(meter)) as unknown as MeterReadingRow[],
    units: (units.data ?? []) as MeterUnitOption[],
  };
}

export async function createMeter(
  client: SupabaseClient,
  assetId: string,
  subItemId: string,
  meterCode: string,
  unitId: string | null,
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
  unitId: string | null,
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

export async function loadAvailableMeterReadingMonths(
  client: SupabaseClient,
  assetId: string,
): Promise<Array<{ billingMonth: string; meterDate: string | null }>> {
  const { data, error } = await client
    .from("meter_reading_month")
    .select("billing_month, meter_date")
    .eq("asset_id", assetId)
    .order("billing_month", { ascending: false });
  fail("KANAMEの対象期間を読み込めませんでした", error);
  return (data ?? []).map((row) => ({
    billingMonth: String(row.billing_month).slice(0, 7),
    meterDate: row.meter_date ?? null,
  }));
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
    { category: "electric", usage_unit: "kWh", is_billable: true, is_basic_billable: false },
    { category: "water", usage_unit: "m³", is_billable: true, is_basic_billable: false },
    { category: "gas", usage_unit: "m³", is_billable: true, is_basic_billable: false },
  ];
  const defaultPeriods = [
    { pattern_name: "前月分", start_month_offset: -1, start_day_type: "first", start_meter_day_offset: 0, end_month_offset: -1, end_day_type: "last", end_meter_day_offset: 0, sort_order: 0 },
    { pattern_name: "当月分", start_month_offset: 0, start_day_type: "first", start_meter_day_offset: 0, end_month_offset: 0, end_day_type: "last", end_meter_day_offset: 0, sort_order: 1 },
    { pattern_name: "翌月分", start_month_offset: 1, start_day_type: "first", start_meter_day_offset: 0, end_month_offset: 1, end_day_type: "last", end_meter_day_offset: 0, sort_order: 2 },
    { pattern_name: "検針期間（前月検針日を含める）", start_month_offset: -1, start_day_type: "meter", start_meter_day_offset: 0, end_month_offset: 0, end_day_type: "meter", end_meter_day_offset: 0, sort_order: 3 },
    { pattern_name: "検針期間（前月検針日を含めない）", start_month_offset: -1, start_day_type: "meter", start_meter_day_offset: 1, end_month_offset: 0, end_day_type: "meter", end_meter_day_offset: 0, sort_order: 4 },
  ];
  const currentPeriods = await client
    .from("asset_billing_period_pattern")
    .select("pattern_name, start_month_offset, start_day_type, start_meter_day_offset, end_month_offset, end_day_type, end_meter_day_offset")
    .eq("asset_id", assetId);
  fail("請求期間パターンを確認できませんでした", currentPeriods.error);
  const signatures = (rows: Array<Record<string, unknown>>) => rows.map((row) => [row.pattern_name, row.start_month_offset, row.start_day_type, row.start_meter_day_offset, row.end_month_offset, row.end_day_type, row.end_meter_day_offset].join("|")).sort();
  if (JSON.stringify(signatures((currentPeriods.data ?? []) as Array<Record<string, unknown>>)) !== JSON.stringify(signatures(defaultPeriods))) {
    const removed = await client.from("asset_billing_period_pattern").delete().eq("asset_id", assetId);
    fail("既存の請求期間パターンを削除できませんでした", removed.error);
    const created = await client.from("asset_billing_period_pattern").insert(defaultPeriods.map((row) => ({ ...row, asset_id: assetId })));
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
      .select("category, usage_unit, is_billable, is_basic_billable")
      .eq("asset_id", assetId)
      .order("category"),
    client
      .from("asset_meter_sub_item")
      .select(
        "asset_meter_sub_item_id, category, sub_item_name, sub_item_kind, asset_billing_line_item_id, sort_order, input_mode, input_decimal_digits, aggregation_decimal_digits, usage_rounding_mode, billing_period_pattern_id, price_mode, default_unit_price, tax_mode, tax_rounding_mode, show_unit_price_on_invoice",
      )
      .eq("asset_id", assetId)
      .order("sort_order"),
    client
      .from("asset_meter_surcharge")
      .select("asset_meter_surcharge_id, category, surcharge_name, asset_billing_line_item_id, is_billable, billing_period_pattern_id")
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
  return {
    categories: (categories.data ?? []) as MeterCategorySetting[],
    subItems: (subItems.data ?? []) as MeterSubItem[],
    surcharges: (surcharges.data ?? []) as MeterSurcharge[],
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
    categories.map((row) => ({ asset_id: assetId, category: row.category, usage_unit: row.usage_unit, is_billable: row.is_billable, is_basic_billable: row.is_basic_billable })),
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
