import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type ThHTMLAttributes } from "react";
import {
  assignMeterUnit,
  assignMeterUnits,
  clearMeterReading,
  confirmMeterReadingMonth,
  createMeterTag,
  createMeter,
  deleteMeter,
  loadAssetUtilitySettings,
  loadBillingAssets,
  loadBillingLineItems,
  loadContractUnits,
  loadMeteringConfiguration,
  loadMeterManagement,
  loadMeterReadings,
  loadMonthlyFixedCharges,
  loadMeterUnitPriceCalculations,
  loadUtilityTariff,
  loadSurchargeEvidence,
  loadMeterUsageHistory,
  loadMeterReadingPeriod,
  loadAvailableMeterReadingMonths,
  loadAllocationSourceMeterIds,
  reorderMeters,
  releaseMeterReadingMonth,
  saveMeterParent,
  saveMeterBillingAdjustment,
  saveMeterName,
  saveMeterTag,
  saveMeterReading,
  saveMeterReadingDate,
  saveMonthlyFixedCharge,
  saveMeterUnitPriceCalculation,
  saveNextUtilityTariffVersion,
  saveSurchargeEvidence,
  saveAssetUtilitySettings,
  saveMeteringSettings,
  updateMeterSubItemDisplaySettings,
  updateMeterTag,
} from "../lib/meteringRepository";
import { supabase } from "../lib/supabase";
import type {
  Asset,
  AssetUtilitySetting,
  BillingLineItem,
  ConfirmedMeterAmount,
  BillingPeriodPattern,
  ContractUnit,
  MeterCategorySetting,
  MeterReadingRow,
  MeterSubItem,
  MeterSurcharge,
  MeterTag,
  MeterUnitPriceCalculation,
  MeterUnitOption,
  TaxMode,
  UserProfile,
  UtilityCategory,
  UtilityTariffTier,
  UtilityTariffVersion,
} from "../types";
import {
  calculateOsakaGeneralWaterTariff,
  OSAKA_GENERAL_WATER_TARIFF_CODE,
  osakaGeneralSewerTiers,
  osakaGeneralWaterTiers,
  type OsakaWaterTariffTier,
} from "../lib/osakaWaterTariff";

const categories: UtilityCategory[] = ["electric", "water", "gas"];
const rateSourceUnitValue = "__rate_source__";
const labels: Record<UtilityCategory, string> = {
  electric: "電気",
  water: "水道",
  gas: "ガス",
};
function readableTextColor(color: string) {
  const hex = color.replace("#", "");
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  return red * 0.299 + green * 0.587 + blue * 0.114 > 160 ? "#17221f" : "#ffffff";
}
const meterTagPalette = [
  "#e7e6e6", "#f4cccc", "#fce4d6", "#fff2cc", "#d9ead3", "#d0e0e3", "#d9e2f3", "#e4dfec",
  "#a5a5a5", "#e06666", "#f4b183", "#ffd966", "#a9d18e", "#9cc2e5", "#8eaadb", "#c9b2d9",
  "#595959", "#990000", "#c65911", "#bf9000", "#548235", "#1f4e78", "#2f5597", "#7030a0",
];
const currentMonth = new Date().toISOString().slice(0, 7);
type MainTab = "summary" | UtilityCategory | "buildingSettings";
type SaveState = "idle" | "saving" | "saved" | "error";
type SumMode = "aggregate" | "perMeter";

function sumModeFor(contract: ContractUnit | undefined, category: UtilityCategory): SumMode {
  const key = `${category}_sum_mode` as "electric_sum_mode" | "water_sum_mode" | "gas_sum_mode";
  return contract?.meterBilling[0]?.[key] ?? "aggregate";
}

function amountRoundingFor(contract: ContractUnit | undefined) {
  return contract?.meterBilling[0]?.amount_rounding_mode ?? contract?.utility_amount_rounding_mode ?? "round";
}

function billingGroupKey(contract: ContractUnit | undefined) {
  return contract?.meterBilling[0]?.meter_reading_contract_id
    ?? contract?.contract?.tenant_id
    ?? "unassigned";
}

function billingGroupTenantName(contract: ContractUnit | undefined) {
  const name = contract?.contract?.tenant?.tenant_name ?? "—";
  const splitLabel = contract?.meterBilling[0]?.split_label?.trim();
  return splitLabel ? `${name}（${splitLabel}）` : name;
}

function contractUnitPriceForBillingMonth(
  price: { unit_price: number; billing_month_prices: Array<{ start_month: number; end_month: number; unit_price: number }> } | undefined,
  billingMonth: string,
) {
  if (!price) return null;
  const month = Number(billingMonth.slice(5, 7));
  const period = price.billing_month_prices?.find((row) => row.start_month <= row.end_month
    ? row.start_month <= month && month <= row.end_month
    : month >= row.start_month || month <= row.end_month);
  return Number(period?.unit_price ?? price.unit_price);
}

function calculateUsageCharge(
  rows: Array<{ meterId: string; usage: number; price: number | null }>,
  digits: number,
  usageRoundingMode: "floor" | "round" | "ceil",
  sumMode: SumMode,
  amountRoundingMode: "floor" | "round" | "ceil",
) {
  const buckets = new Map<string, typeof rows>();
  const priceCount = new Set(
    rows.flatMap((row) => row.price == null ? [] : [row.price]),
  ).size;
  const hasMixedPrices = sumMode === "aggregate" && priceCount > 1;
  for (const row of rows) {
    const key = sumMode === "aggregate" ? String(row.price) : row.meterId;
    buckets.set(key, [...(buckets.get(key) ?? []), row]);
  }
  const amount = Array.from(buckets.values()).reduce((sum, group) => {
    const price = group[0]?.price;
    if (price == null) return sum;
    const rawUsage = group.reduce((groupSum, row) => groupSum + row.usage, 0);
    // Excel運用に合わせ、単価が混在するときは単価別の使用量を丸めずに金額計算する。
    // 単価が1種類のときとメーターごと計算では、従来どおり集計桁数を適用する。
    const usage = hasMixedPrices
      ? rawUsage
      : roundToDigits(rawUsage, digits, usageRoundingMode);
    return sum + roundUtilityAmount(usage * price, amountRoundingMode);
  }, 0);
  return {
    usage: roundToDigits(rows.reduce((sum, row) => sum + row.usage, 0), digits, usageRoundingMode),
    amount,
  };
}

function buildConfirmedMeterAmounts({
  contracts,
  meters,
  categorySettings,
  utilitySettings,
  subItems,
  surcharges,
  surchargePrices,
  unitPriceCalculations,
  billingLineItems,
  monthlyFixedCharges,
  billingMonth,
}: {
  contracts: ContractUnit[];
  meters: MeterReadingRow[];
  categorySettings: MeterCategorySetting[];
  utilitySettings: AssetUtilitySetting[];
  subItems: MeterSubItem[];
  surcharges: MeterSurcharge[];
  surchargePrices: Record<string, number>;
  unitPriceCalculations: Record<string, MeterUnitPriceCalculation>;
  billingLineItems: BillingLineItem[];
  monthlyFixedCharges: Record<string, number>;
  billingMonth: string;
}): ConfirmedMeterAmount[] {
  const eligibleContracts = contracts.filter((row) =>
    ["office", "warehouse", "storage"].includes((row.unit?.unit_type ?? "").toLowerCase()),
  );
  const lineItemName = (id: string | null) => id
    ? billingLineItems.find((item) => item.asset_billing_line_item_id === id)?.line_item_name ?? null
    : null;
  const priceFor = (contract: ContractUnit, item: MeterSubItem) => {
    const itemPrice = contract.prices.find((row) => row.asset_billing_line_item_id === item.asset_billing_line_item_id);
    const categoryPrice = contract.categoryPrices.find((row) => row.category === item.category);
    const price = unitPriceCalculations[item.asset_meter_sub_item_id]?.unit_price
      ?? contractUnitPriceForBillingMonth(itemPrice, billingMonth)
      ?? contractUnitPriceForBillingMonth(categoryPrice, billingMonth)
      ?? utilitySettings.find((setting) => setting.category === item.category)?.default_unit_price;
    return {
      price: price == null ? null : Number(price),
      taxMode: itemPrice?.tax_mode
        ?? categoryPrice?.tax_mode
        ?? utilitySettings.find((setting) => setting.category === item.category)?.default_tax_mode
        ?? item.tax_mode,
    };
  };
  const rows: ConfirmedMeterAmount[] = [];
  const billingGroupIds = Array.from(new Set(eligibleContracts.map((contract) => billingGroupKey(contract))));
  for (const groupId of billingGroupIds) {
    const tenantContracts = eligibleContracts.filter((contract) => billingGroupKey(contract) === groupId);
    const representative = tenantContracts[0];
    const tenantId = representative?.contract?.tenant_id;
    if (!representative || !tenantId) continue;
    const billingSetting = representative.meterBilling[0];
    const shared = {
      meter_reading_contract_id: billingSetting?.meter_reading_contract_id ?? null,
      tenant_id: tenantId,
      tenant_name: billingGroupTenantName(representative),
      row_no: billingSetting?.row_no ?? 1,
      invoice_number: billingSetting?.invoice_number ?? 1,
      amount_rounding_mode: amountRoundingFor(representative),
      tax_rate: null,
    } as const;
    for (const category of categories) {
      const categorySetting = categorySettings.find((setting) => setting.category === category);
      if (!categorySetting?.is_billable) continue;
      const billableContracts = tenantContracts.filter((contract) => isContractCategoryBillable(contract, category));
      if (!billableContracts.length) continue;
      const basic = categorySetting.is_basic_billable
        ? subItems.find((item) => item.category === category && item.sub_item_kind === "basic")
        : undefined;
      if (basic) {
        const groupBasic = billingSetting?.items.find((item) => item.asset_meter_sub_item_id === basic.asset_meter_sub_item_id && item.is_billable)?.fixed_amount;
        const amount = groupBasic != null ? Number(groupBasic) : billableContracts.reduce(
          (sum, contract) => sum + Number(contract.basics.find((item) => item.category === category)?.amount ?? 0),
          0,
        );
        rows.push({
          ...shared,
          category,
          source_kind: "subItem",
          source_id: basic.asset_meter_sub_item_id,
          source_name: basic.sub_item_name,
          asset_billing_line_item_id: basic.asset_billing_line_item_id,
          line_item_name: lineItemName(basic.asset_billing_line_item_id),
          usage_amount: 0,
          usage_unit: categorySetting.usage_unit,
          unit_price: null,
          amount,
          usage_rounding_digits: basic.aggregation_decimal_digits,
          usage_rounding_mode: basic.usage_rounding_mode,
          tax_mode: basic.tax_mode,
        });
      }
      let categoryUsage = 0;
      for (const item of subItems.filter((candidate) => candidate.category === category && candidate.sub_item_kind === "custom")) {
        if (item.is_monthly_fixed) {
          const unitAmounts = billableContracts.flatMap((contract) => {
            const unitAmount = monthlyFixedCharges[`${contract.lease_contract_unit_id}|${item.asset_meter_sub_item_id}`];
            return unitAmount == null ? [] : [unitAmount];
          });
          if (!unitAmounts.length) continue;
          const amount = unitAmounts.reduce((sum, unitAmount) => sum + unitAmount, 0);
          rows.push({
            ...shared,
            category,
            source_kind: "subItem",
            source_id: item.asset_meter_sub_item_id,
            source_name: item.sub_item_name,
            asset_billing_line_item_id: item.asset_billing_line_item_id,
            line_item_name: lineItemName(item.asset_billing_line_item_id),
            usage_amount: 0,
            usage_unit: categorySetting.usage_unit,
            unit_price: null,
            amount,
            usage_rounding_digits: null,
            usage_rounding_mode: null,
            tax_mode: item.tax_mode,
          });
          continue;
        }
        const contractByUnitId = new Map(
          billableContracts.flatMap((contract) => contract.unit?.unit_id ? [[contract.unit.unit_id, contract] as const] : []),
        );
        const chargeRows = meters.flatMap((meter) => {
          if (meter.subItem.asset_meter_sub_item_id !== item.asset_meter_sub_item_id) return [];
          if (meter.is_allocation_source) return [];
          const totalUsage = billingAdjustedUsage(meter, adjustedMeterUsage(meter, meters, storedMeterUsage));
          return meter.assignments.flatMap((assignment) => {
            const contract = contractByUnitId.get(assignment.unit_id);
            if (!contract) return [];
            const price = priceFor(contract, item);
            return [{ meterId: `${meter.asset_meter_id}:${assignment.unit_id}`, usage: totalUsage * meterAllocationShare(meter, assignment.unit_id, meters), ...price }];
          });
        });
        const calculation = calculateUsageCharge(
          chargeRows,
          item.aggregation_decimal_digits,
          item.usage_rounding_mode,
          sumModeFor(representative, category),
          amountRoundingFor(representative),
        );
        categoryUsage += calculation.usage;
        const prices = Array.from(new Set(chargeRows.map((row) => row.price).filter((price): price is number => price != null)));
        const taxModes = Array.from(new Set(chargeRows.map((row) => row.taxMode)));
        rows.push({
          ...shared,
          category,
          source_kind: "subItem",
          source_id: item.asset_meter_sub_item_id,
          source_name: item.sub_item_name,
          asset_billing_line_item_id: item.asset_billing_line_item_id,
          line_item_name: lineItemName(item.asset_billing_line_item_id),
          usage_amount: calculation.usage,
          usage_unit: categorySetting.usage_unit,
          unit_price: prices.length === 1 ? prices[0] : null,
          amount: calculation.amount,
          usage_rounding_digits: item.aggregation_decimal_digits,
          usage_rounding_mode: item.usage_rounding_mode,
          tax_mode: taxModes.length === 1 ? taxModes[0] : item.tax_mode,
        });
      }
      const surcharge = category === "electric"
        ? surcharges.find((item) => item.category === category && item.is_billable)
        : undefined;
      const surchargePrice = surcharge ? surchargePrices[surcharge.asset_meter_surcharge_id] : null;
      const surchargeAmount = surcharge && surchargePrice != null
        ? roundUtilityAmount(categoryUsage * surchargePrice, amountRoundingFor(representative))
        : 0;
      if (surcharge) rows.push({
        ...shared,
        category,
        source_kind: "surcharge",
        source_id: surcharge.asset_meter_surcharge_id,
        source_name: surcharge.surcharge_name,
        asset_billing_line_item_id: surcharge.asset_billing_line_item_id,
        line_item_name: lineItemName(surcharge.asset_billing_line_item_id),
        usage_amount: categoryUsage,
        usage_unit: categorySetting.usage_unit,
        unit_price: surchargePrice,
        amount: surchargeAmount,
        usage_rounding_digits: null,
        usage_rounding_mode: null,
        tax_mode: null,
      });
    }
  }
  return rows;
}

function ensureBasicSubItems(categoriesToCheck: MeterCategorySetting[], current: MeterSubItem[]) {
  let next = current;
  for (const setting of categoriesToCheck) {
    if (!setting.is_basic_billable || next.some((item) => item.category === setting.category && item.sub_item_kind === "basic")) continue;
    const basic: MeterSubItem = {
      asset_meter_sub_item_id: crypto.randomUUID(),
      category: setting.category,
      sub_item_name: "基本料",
      sub_item_kind: "basic",
      asset_billing_line_item_id: null,
      sort_order: 0,
      input_mode: "usage",
      input_decimal_digits: 0,
      aggregation_decimal_digits: 0,
      usage_rounding_mode: "round",
      billing_period_pattern_id: null,
      price_mode: "fixed",
      default_unit_price: null,
      tax_mode: "exclusive",
      tax_rounding_mode: "floor",
      show_unit_price_on_invoice: false,
      is_monthly_fixed: false,
    };
    const firstCategoryIndex = next.findIndex((item) => item.category === setting.category);
    next = firstCategoryIndex < 0
      ? [...next, basic]
      : [...next.slice(0, firstCategoryIndex), basic, ...next.slice(firstCategoryIndex)];
  }
  return next;
}

function adjustedMeterUsage(
  meter: MeterReadingRow,
  meters: MeterReadingRow[],
  usageFor: (row: MeterReadingRow) => number,
) {
  const ownUsage = usageFor(meter);
  if (meter.subItem.input_mode !== "reading") return ownUsage;
  const unitId = meter.assignments[0]?.unit_id;
  const childUsage = meters
    .filter((row) =>
      row.parent_meter_id === meter.asset_meter_id &&
      unitId != null &&
      row.assignments[0]?.unit_id === unitId
    )
    .reduce((sum, row) => sum + usageFor(row), 0);
  return ownUsage - childUsage;
}

function billingAdjustedUsage(meter: MeterReadingRow, usage: number) {
  if (!meter.billing_adjustment_enabled) return usage;
  if (meter.billing_adjustment_method === "percent") {
    const percent = Number(meter.billing_adjustment_percent);
    return Number.isFinite(percent) && percent >= 0 ? usage * percent / 100 : usage;
  }
  if (meter.billing_adjustment_method === "ratio") {
    const numerator = Number(meter.billing_adjustment_numerator);
    const denominator = Number(meter.billing_adjustment_denominator);
    return Number.isFinite(numerator) && numerator >= 0 && Number.isFinite(denominator) && denominator > 0
      ? usage * numerator / denominator
      : usage;
  }
  return usage;
}

function storedMeterUsage(meter: MeterReadingRow) {
  const savedUsage = Number(meter.entry?.usage_amount ?? 0);
  if (meter.subItem.input_mode !== "reading") return savedUsage;
  const previous = Number(meter.entry?.previous_reading);
  const current = Number(meter.entry?.current_reading);
  if (!Number.isFinite(previous) || !Number.isFinite(current)) return savedUsage;
  // 一周処理時は補正済み使用量を使い、通常時は検針画面と同じ差分を算出する。
  return current < previous ? savedUsage : current - previous;
}

function meterAllocationShare(meter: MeterReadingRow, unitId: string, meters: MeterReadingRow[]) {
  const weightFor = (assignment: MeterReadingRow["assignments"][number]) => {
    if (assignment.allocation_method !== "meter_usage") return Number(assignment.allocation_weight ?? 1);
    const source = meters.find((candidate) => candidate.asset_meter_id === assignment.allocation_source_meter_id);
    return source ? Math.max(0, billingAdjustedUsage(source, adjustedMeterUsage(source, meters, storedMeterUsage))) : 0;
  };
  const commonWeight = meter.allocation_common_source_meter_ids.reduce((sum, sourceId) => {
    const source = meters.find((candidate) => candidate.asset_meter_id === sourceId);
    return sum + (source ? Math.max(0, billingAdjustedUsage(source, adjustedMeterUsage(source, meters, storedMeterUsage))) : 0);
  }, 0);
  const total = meter.assignments.reduce((sum, row) => sum + weightFor(row), commonWeight);
  const assignment = meter.assignments.find((row) => row.unit_id === unitId);
  return assignment && total > 0 ? weightFor(assignment) / total : 0;
}

function isMeterUsageAllocationParent(meter: MeterReadingRow) {
  return meter.assignments.length > 1 && meter.assignments.some((row) => row.allocation_method === "meter_usage");
}

function orderAllocationMeterBlocks(meters: MeterReadingRow[]) {
  const byId = new Map(meters.map((meter) => [meter.asset_meter_id, meter]));
  const sourceIds = new Set(meters.flatMap((meter) => [
    ...meter.assignments.flatMap((row) => row.allocation_source_meter_id ? [row.allocation_source_meter_id] : []),
    ...meter.allocation_common_source_meter_ids,
  ]));
  const result: MeterReadingRow[] = [];
  const appended = new Set<string>();
  const append = (meter: MeterReadingRow | undefined) => {
    if (!meter || appended.has(meter.asset_meter_id)) return;
    result.push(meter);
    appended.add(meter.asset_meter_id);
  };
  for (const meter of meters) {
    if (sourceIds.has(meter.asset_meter_id)) continue;
    append(meter);
    if (!isMeterUsageAllocationParent(meter)) continue;
    const parentSourceIds = [
      ...meter.assignments.flatMap((assignment) => assignment.allocation_source_meter_id ? [assignment.allocation_source_meter_id] : []),
      ...meter.allocation_common_source_meter_ids,
    ];
    for (const source of parentSourceIds
      .map((sourceId) => byId.get(sourceId))
      .filter((source): source is MeterReadingRow => Boolean(source))
      .sort((left, right) => left.sort_order - right.sort_order)) {
      append(source);
    }
  }
  for (const meter of meters) append(meter);
  return result;
}

function currentMeterUsage(
  meter: MeterReadingRow,
  values: Record<string, string>,
  rolloverValues: Record<string, number>,
) {
  const raw = values[meter.asset_meter_id];
  if (raw !== undefined && raw.trim() === "") return 0;
  const entered = raw !== undefined && raw !== "" ? Number(raw) : null;
  if (meter.subItem.input_mode === "usage") {
    const usage = entered ?? storedMeterUsage(meter);
    return Number.isFinite(usage) ? usage : 0;
  }
  if (entered == null) return storedMeterUsage(meter);
  const previous = Number(meter.entry?.previous_reading ?? 0);
  const rollover = rolloverValues[meter.asset_meter_id];
  const usage = entered < previous && rollover
    ? rollover - previous + entered
    : entered - previous;
  return Number.isFinite(usage) ? usage : 0;
}

function billingPeriodRange(
  billingMonth: string,
  pattern: BillingPeriodPattern | undefined,
  currentMeterDate: string | null | undefined,
  previousMeterDate: string | null | undefined,
) {
  if (!pattern) return null;
  const [year, month] = billingMonth.split("-").map(Number);
  const edge = (monthOffset: number, dayType: string, meterOffset: number) => {
    if (dayType === "meter") {
      const raw = monthOffset < 0 ? previousMeterDate : currentMeterDate;
      if (!raw) return null;
      const date = new Date(`${raw}T00:00:00`);
      date.setDate(date.getDate() + meterOffset);
      return date;
    }
    const date = new Date(year, month - 1 + monthOffset, 1);
    const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    const day = dayType === "first"
      ? 1
      : dayType === "last"
        ? lastDay
        : Math.min(Number(dayType.replace("day_", "")) || 1, lastDay);
    date.setDate(day);
    return date;
  };
  const start = edge(pattern.start_month_offset, pattern.start_day_type, pattern.start_meter_day_offset ?? 0);
  const end = edge(pattern.end_month_offset, pattern.end_day_type, pattern.end_meter_day_offset ?? 0);
  return start && end ? { start, end } : null;
}

function billingPeriodText(
  billingMonth: string,
  pattern: BillingPeriodPattern | undefined,
  currentMeterDate: string | null | undefined,
  previousMeterDate: string | null | undefined,
) {
  if (!pattern) return "期間未設定";
  const range = billingPeriodRange(billingMonth, pattern, currentMeterDate, previousMeterDate);
  const format = (date: Date) => `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
  return range ? `${format(range.start)}～${format(range.end)}` : "期間未確定";
}

export function KanameterWorkspacePage({
  profile,
  onSignOut,
}: {
  profile: UserProfile;
  onSignOut: () => Promise<unknown>;
}) {
  const workspaceStateKey = `kanameter-workspace-state:${profile.user_id}`;
  const savedWorkspaceState = (() => {
    try {
      return JSON.parse(localStorage.getItem(workspaceStateKey) ?? "{}") as {
        assetId?: string;
        billingMonth?: string;
        mainTab?: MainTab;
        selectedItemId?: string;
      };
    } catch {
      return {};
    }
  })();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetId, setAssetId] = useState(savedWorkspaceState.assetId ?? "");
  const [billingMonth, setBillingMonth] = useState(savedWorkspaceState.billingMonth ?? currentMonth);
  const [meterDate, setMeterDate] = useState("");
  const [previousMeterDate, setPreviousMeterDate] = useState("");
  const [availableBillingMonths, setAvailableBillingMonths] = useState<Array<{ billingMonth: string; meterDate: string | null }>>([]);
  const [mainTab, setMainTab] = useState<MainTab>(savedWorkspaceState.mainTab ?? "summary");
  const [selectedItemId, setSelectedItemId] = useState(savedWorkspaceState.selectedItemId ?? "");
  const [utilitySettings, setUtilitySettings] = useState<AssetUtilitySetting[]>(
    [],
  );
  const [categorySettings, setCategorySettings] = useState<
    MeterCategorySetting[]
  >([]);
  const [subItems, setSubItems] = useState<MeterSubItem[]>([]);
  const [surcharges, setSurcharges] = useState<MeterSurcharge[]>([]);
  const [periodPatterns, setPeriodPatterns] = useState<BillingPeriodPattern[]>([]);
  const [billingLineItems, setBillingLineItems] = useState<BillingLineItem[]>([]);
  const [contracts, setContracts] = useState<ContractUnit[]>([]);
  const [meters, setMeters] = useState<MeterReadingRow[]>([]);
  const [summaryMeters, setSummaryMeters] = useState<MeterReadingRow[]>([]);
  const [summarySurchargePrices, setSummarySurchargePrices] = useState<Record<string, number>>({});
  const [managedMeters, setManagedMeters] = useState<MeterReadingRow[]>([]);
  const [meterTags, setMeterTags] = useState<MeterTag[]>([]);
  const [meterTagFilter, setMeterTagFilter] = useState("");
  const [usageOnly, setUsageOnly] = useState(false);
  const [units, setUnits] = useState<MeterUnitOption[]>([]);
  const [meterSettingsItemId, setMeterSettingsItemId] = useState<string | null>(null);
  const [unitPriceCalculatorOpen, setUnitPriceCalculatorOpen] = useState(false);
  const [calculatedUnitPrices, setCalculatedUnitPrices] = useState<Record<string, number>>({});
  const [unitPriceCalculations, setUnitPriceCalculations] = useState<Record<string, MeterUnitPriceCalculation>>({});
  const [utilityTariff, setUtilityTariff] = useState<UtilityTariffVersion | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [monthlyFixedCharges, setMonthlyFixedCharges] = useState<Record<string, number>>({});
  const [rolloverValues, setRolloverValues] = useState<Record<string, number>>({});
  const [rolloverConfirmationOpen, setRolloverConfirmationOpen] = useState(false);
  const [usageHistory, setUsageHistory] = useState<{
    previous: Record<string, number>;
    previousYear: Record<string, number>;
  }>({ previous: {}, previousYear: {} });
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});
  const [status, setStatus] = useState<"draft" | "confirmed" | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [sidebarPinned, setSidebarPinned] = useState(() => localStorage.getItem("kanameter-sidebar-pinned") !== "false");
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    void loadBillingAssets(supabase!)
      .then((rows) => {
        setAssets(rows);
        setAssetId((current) => rows.some((row) => row.asset_id === current) ? current : rows[0]?.asset_id ?? "");
      })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
    return () => Object.values(timers.current).forEach(clearTimeout);
  }, []);

  useEffect(() => {
    localStorage.setItem(workspaceStateKey, JSON.stringify({ assetId, billingMonth, mainTab, selectedItemId }));
  }, [workspaceStateKey, assetId, billingMonth, mainTab, selectedItemId]);

  useEffect(() => {
    setMeterTagFilter("");
  }, [assetId]);

  useEffect(() => {
    if (!assetId) return;
    setLoading(true);
    setError("");
    setNotice("");
    void Promise.all([
      loadAssetUtilitySettings(supabase!, assetId),
      loadMeteringConfiguration(supabase!, assetId),
      loadContractUnits(supabase!, assetId),
      loadMeterManagement(supabase!, assetId),
      loadBillingLineItems(supabase!, assetId),
    ])
      .then(([prices, config, contractRows, management, lineItems]) => {
        const enabledCategories = new Set(lineItems.map((item) => item.utility_category).filter(Boolean));
        setUtilitySettings(prices);
        const effectiveCategories = config.categories.map((setting) => ({
          ...setting,
          is_billable: enabledCategories.has(setting.category),
        }));
        setCategorySettings(effectiveCategories);
        setSubItems(ensureBasicSubItems(effectiveCategories, config.subItems));
        const hasSurcharge = lineItems.some((item) => item.is_surcharge);
        setSurcharges(config.surcharges.map((item) => ({
          ...item,
          is_billable: item.category === "electric" && hasSurcharge,
        })));
        setPeriodPatterns(config.periodPatterns);
        setContracts(contractRows);
        setManagedMeters(management.meters);
        setUnits(management.units);
        setMeterTags(management.tags);
        setBillingLineItems(lineItems);
      })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
  }, [assetId]);

  useEffect(() => {
    if (!assetId || !billingMonth) return;
    void loadMeterReadingPeriod(supabase!, assetId, billingMonth)
      .then((period) => {
        setMeterDate(period.meterDate ?? "");
        setPreviousMeterDate(period.previousMeterDate ?? "");
      })
      .catch((reason: Error) => setError(reason.message));
  }, [assetId, billingMonth]);

  useEffect(() => {
    if (!assetId || !billingMonth) return;
    void loadMonthlyFixedCharges(supabase!, assetId, billingMonth)
      .then((rows) => setMonthlyFixedCharges(Object.fromEntries(rows.map((row) => [
        `${row.lease_contract_unit_id}|${row.asset_meter_sub_item_id}`,
        row.amount,
      ]))))
      .catch((reason: Error) => setError(reason.message));
  }, [assetId, billingMonth]);

  useEffect(() => {
    if (!assetId || !billingMonth) return;
    void loadUtilityTariff(supabase!, assetId, billingMonth)
      .then(setUtilityTariff)
      .catch((reason: Error) => setError(reason.message));
  }, [assetId, billingMonth]);

  useEffect(() => {
    if (!assetId || !billingMonth) return;
    void loadMeterUnitPriceCalculations(supabase!, assetId, billingMonth)
      .then((rows) => {
        setUnitPriceCalculations(Object.fromEntries(rows.map((row) => [row.asset_meter_sub_item_id, row])));
        setCalculatedUnitPrices(Object.fromEntries(rows.flatMap((row) =>
          row.unit_price == null ? [] : [[row.asset_meter_sub_item_id, Number(row.unit_price)]],
        )));
      })
      .catch((reason: Error) => setError(reason.message));
  }, [assetId, billingMonth]);

  useEffect(() => {
    if (!assetId) return;
    void loadAvailableMeterReadingMonths(supabase!, assetId)
      .then(setAvailableBillingMonths)
      .catch((reason: Error) => setError(reason.message));
  }, [assetId]);

  const activeCategory = categories.includes(mainTab as UtilityCategory)
    ? (mainTab as UtilityCategory)
    : null;
  const refreshMeterData = async () => {
    const management = await loadMeterManagement(supabase!, assetId);
    setManagedMeters(management.meters);
    setUnits(management.units);
    setMeterTags(management.tags);
    if (activeCategory) {
      const readings = await loadMeterReadings(
        supabase!,
        assetId,
        billingMonth,
        activeCategory,
      );
      setMeters(readings.rows);
    }
  };
  useEffect(() => {
    if (!assetId || !activeCategory) {
      setMeters([]);
      return;
    }
    setLoading(true);
    setError("");
    void Promise.all([
      loadMeterReadings(supabase!, assetId, billingMonth, activeCategory),
      loadMeterUsageHistory(supabase!, assetId, billingMonth),
    ])
      .then(([result, history]) => {
        setMeters(result.rows);
        setUsageHistory(history);
        setStatus(result.status);
        setValues(
          Object.fromEntries(
            result.rows.map((meter) => [
              meter.asset_meter_id,
              meter.subItem.input_mode === "reading"
                ? formatInputValue(meter.entry?.current_reading, getReadingDecimalDigits(meter.subItem.asset_meter_sub_item_id, meter.subItem.input_decimal_digits))
                : formatInputValue(meter.entry?.usage_amount, meter.subItem.input_decimal_digits),
            ]),
          ),
        );
        setRolloverValues(Object.fromEntries(result.rows.flatMap((meter) => {
          if (meter.entry?.previous_reading == null || meter.entry.current_reading == null) return [];
          const previous = Number(meter.entry?.previous_reading);
          const current = Number(meter.entry?.current_reading);
          const usage = Number(meter.entry?.usage_amount);
          if (meter.subItem.input_mode !== "reading" || !Number.isFinite(previous) || !Number.isFinite(current) || !Number.isFinite(usage) || current >= previous || usage < 0) return [];
          const rolloverValue = usage + previous - current;
          return rolloverValue > previous ? [[meter.asset_meter_id, rolloverValue]] : [];
        })));
        setSaveStates({});
        const basicEnabled =
          categorySettings.find((setting) => setting.category === activeCategory)
            ?.is_basic_billable ?? false;
        const eligibleSubItems = subItems.filter(
          (item) =>
            item.category === activeCategory &&
            !item.is_monthly_fixed &&
            (item.sub_item_kind !== "basic" || basicEnabled),
        );
        const eligibleSurcharges =
          activeCategory === "electric"
            ? surcharges.filter((item) => item.category === activeCategory)
            : [];
        const firstItem: MeterSubItem | MeterSurcharge | undefined =
          eligibleSubItems.find(() => true) ??
          eligibleSurcharges.find(() => true);
        setSelectedItemId((current) =>
          current &&
          [...eligibleSubItems, ...eligibleSurcharges].some(
            (item) =>
              ("asset_meter_sub_item_id" in item
                ? item.asset_meter_sub_item_id
                : item.asset_meter_surcharge_id) === current,
          )
            ? current
            : firstItem
              ? "asset_meter_sub_item_id" in firstItem
                ? firstItem.asset_meter_sub_item_id
                : firstItem.asset_meter_surcharge_id
              : "",
        );
      })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
  }, [assetId, billingMonth, activeCategory, subItems, surcharges, categorySettings]);

  useEffect(() => {
    if (!assetId || mainTab !== "summary") return;
    setLoading(true);
    void Promise.all([
      Promise.all(categories.map((category) => loadMeterReadings(supabase!, assetId, billingMonth, category))),
      Promise.all(surcharges.map(async (surcharge) => ({
        surchargeId: surcharge.asset_meter_surcharge_id,
        evidence: await loadSurchargeEvidence(supabase!, assetId, billingMonth, surcharge.asset_meter_surcharge_id),
      }))),
    ])
      .then(([results, surchargeRows]) => {
        setSummaryMeters(results.flatMap((result) => result.rows));
        setSummarySurchargePrices(Object.fromEntries(surchargeRows.flatMap(({ surchargeId, evidence }) => {
          const storedPrice = loadStoredSurchargeUnitPrice(assetId, billingMonth, surchargeId);
          const savedPrice = storedPrice ?? (evidence?.unit_price == null ? null : Number(evidence.unit_price));
          const price = savedPrice == null || !Number.isFinite(savedPrice) ? null : Math.max(0, savedPrice);
          return price == null ? [] : [[surchargeId, price]];
        })));
      })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
  }, [assetId, billingMonth, mainTab, surcharges]);

  useEffect(() => {
    if (!assetId || activeCategory) return;
    void loadMeterReadings(supabase!, assetId, billingMonth, "electric")
      .then((result) => setStatus(result.status))
      .catch(() => setStatus(null));
  }, [assetId, billingMonth, activeCategory]);

  const queueSave = (meter: MeterReadingRow, raw: string, rolloverValue?: number | null) => {
    const activeRolloverValue = rolloverValue === undefined ? rolloverValues[meter.asset_meter_id] : rolloverValue ?? undefined;
    setValues((current) => ({ ...current, [meter.asset_meter_id]: raw }));
    setNotice("");
    if (timers.current[meter.asset_meter_id])
      clearTimeout(timers.current[meter.asset_meter_id]);
    if (raw.trim() === "") {
      setRolloverValues((current) => {
        const next = { ...current };
        delete next[meter.asset_meter_id];
        return next;
      });
      setSaveStates((current) => ({ ...current, [meter.asset_meter_id]: "saving" }));
      timers.current[meter.asset_meter_id] = setTimeout(async () => {
        try {
          await clearMeterReading(supabase!, assetId, billingMonth, meter.asset_meter_id);
          setMeters((current) => current.map((row) => row.asset_meter_id === meter.asset_meter_id
            ? {
                ...row,
                entry: row.entry?.previous_reading == null ? null : {
                  previous_reading: row.entry.previous_reading,
                  current_reading: null,
                  usage_amount: null,
                },
              }
            : row));
          setStatus("draft");
          setSaveStates((current) => ({ ...current, [meter.asset_meter_id]: "saved" }));
        } catch (reason) {
          setSaveStates((current) => ({ ...current, [meter.asset_meter_id]: "error" }));
          setError((reason as Error).message);
        }
      }, 500);
      return;
    }
    if (!Number.isFinite(Number(raw)) || Number(raw) < 0)
      return;
    const entered = Number(raw);
    const previous = Number(meter.entry?.previous_reading);
    if (meter.subItem.input_mode === "reading" && Number.isFinite(previous) && entered < previous && !activeRolloverValue) {
      setError("");
      setSaveStates((current) => ({ ...current, [meter.asset_meter_id]: "idle" }));
      return;
    }
    setSaveStates((current) => ({
      ...current,
      [meter.asset_meter_id]: "saving",
    }));
    timers.current[meter.asset_meter_id] = setTimeout(async () => {
      try {
        const usageOverride = meter.subItem.input_mode === "reading" && Number.isFinite(previous)
          ? entered < previous
            ? activeRolloverValue
              ? activeRolloverValue - previous + entered
              : undefined
            : entered - previous
          : undefined;
        const saved = await saveMeterReading(
          supabase!,
          assetId,
          billingMonth,
          meter.asset_meter_id,
          entered,
          usageOverride,
        );
        setMeters((current) =>
          current.map((row) =>
            row.asset_meter_id === meter.asset_meter_id
              ? {
                  ...row,
                  entry: {
                    usage_amount: Number(saved.usage_amount),
                    previous_reading: meter.entry?.previous_reading ??
                      (saved.previous_reading === null
                        ? null
                        : Number(saved.previous_reading)),
                    current_reading:
                      saved.current_reading === null
                        ? null
                        : Number(saved.current_reading),
                  },
                }
              : row,
          ),
        );
        setStatus("draft");
        setSaveStates((current) => ({
          ...current,
          [meter.asset_meter_id]: "saved",
        }));
      } catch (reason) {
        setSaveStates((current) => ({
          ...current,
          [meter.asset_meter_id]: "error",
        }));
        setError((reason as Error).message);
      }
    }, 500);
  };

  const setMeterRollover = (meter: MeterReadingRow, rolloverValue: number | null) => {
    setRolloverValues((current) => {
      const next = { ...current };
      if (rolloverValue == null) delete next[meter.asset_meter_id];
      else next[meter.asset_meter_id] = rolloverValue;
      return next;
    });
    const raw = values[meter.asset_meter_id];
    if (raw != null && raw !== "") queueSave(meter, raw, rolloverValue);
  };
  const confirm = async () => {
    if (
      !assetId ||
      status === "confirmed" ||
      Object.values(saveStates).includes("saving")
    )
      return;
    setConfirming(true);
    setError("");
    setNotice("");
    try {
      const [readingResults, surchargeRows, calculationRows] = await Promise.all([
        Promise.all(categories.map((category) => loadMeterReadings(supabase!, assetId, billingMonth, category))),
        Promise.all(surcharges.map(async (surcharge) => ({
          surchargeId: surcharge.asset_meter_surcharge_id,
          evidence: await loadSurchargeEvidence(supabase!, assetId, billingMonth, surcharge.asset_meter_surcharge_id),
        }))),
        loadMeterUnitPriceCalculations(supabase!, assetId, billingMonth),
      ]);
      const freshMeters = readingResults.flatMap((result) => result.rows);
      const freshSurchargePrices = Object.fromEntries(surchargeRows.flatMap(({ surchargeId, evidence }) => {
        const storedPrice = loadStoredSurchargeUnitPrice(assetId, billingMonth, surchargeId);
        const savedPrice = storedPrice ?? (evidence?.unit_price == null ? null : Number(evidence.unit_price));
        return savedPrice == null || !Number.isFinite(savedPrice) ? [] : [[surchargeId, Math.max(0, savedPrice)]];
      }));
      const freshCalculations = Object.fromEntries(
        calculationRows.map((row) => [row.asset_meter_sub_item_id, row]),
      );
      const amounts = buildConfirmedMeterAmounts({
        contracts: periodContracts,
        meters: freshMeters,
        categorySettings,
        utilitySettings,
        subItems,
        surcharges,
        surchargePrices: freshSurchargePrices,
        unitPriceCalculations: freshCalculations,
        billingLineItems,
        monthlyFixedCharges,
        billingMonth,
      });
      await confirmMeterReadingMonth(supabase!, assetId, billingMonth, amounts);
      setSummaryMeters(freshMeters);
      setSummarySurchargePrices(freshSurchargePrices);
      setUnitPriceCalculations(freshCalculations);
      setStatus("confirmed");
      setNotice(`${amounts.length}件の確定明細をKANAME連携用に保存しました。`);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setConfirming(false);
    }
  };
  const releaseConfirmation = async () => {
    if (!assetId || status !== "confirmed" || confirming) return;
    if (!window.confirm(`${billingMonth}請求分の確定を解除しますか？\nKANAME連携用の確定明細も削除され、再編集できる状態に戻ります。`)) return;
    setConfirming(true);
    setError("");
    setNotice("");
    try {
      await releaseMeterReadingMonth(supabase!, assetId, billingMonth);
      setStatus("draft");
      setNotice("確定を解除しました。再編集後、改めて確定してください。");
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setConfirming(false);
    }
  };

  const billable = (category: UtilityCategory) =>
    categorySettings.find((row) => row.category === category)?.is_billable ??
    false;
  const categorySubItems = activeCategory
    ? subItems.filter(
        (item) =>
          item.category === activeCategory &&
          (item.sub_item_kind !== "basic" ||
            categorySettings.find((setting) => setting.category === activeCategory)
              ?.is_basic_billable),
      )
    : [];
  const categorySurcharges = activeCategory === "electric"
    ? surcharges.filter((item) => item.category === activeCategory)
    : [];
  const categoryTabItems = categorySubItems.filter((item) => !item.is_monthly_fixed);
  const selectedSubItem = categoryTabItems.find(
    (item) => item.asset_meter_sub_item_id === selectedItemId,
  );
  const selectedSurcharge = categorySurcharges.find(
    (item) => item.asset_meter_surcharge_id === selectedItemId,
  );
  useEffect(() => {
    if (!selectedSubItem || selectedSubItem.is_monthly_fixed || selectedSubItem.price_mode === "fixed") setUnitPriceCalculatorOpen(false);
  }, [selectedSubItem?.asset_meter_sub_item_id, selectedSubItem?.is_monthly_fixed, selectedSubItem?.price_mode]);
  const selectedPeriodPatternId = selectedSubItem?.billing_period_pattern_id ?? selectedSurcharge?.billing_period_pattern_id;
  const selectedPeriodPattern = periodPatterns.find((pattern) => pattern.billing_period_pattern_id === selectedPeriodPatternId);
  const billingPeriods = Array.from(
    new Map([{ billingMonth, meterDate }, ...availableBillingMonths].map((period) => [period.billingMonth, period])).values(),
  );
  const periodLabelFor = (month: string, currentDate: string | null) => {
    const [year, monthNumber] = month.split("-").map(Number);
    const previousMonth = new Date(Date.UTC(year, monthNumber - 2, 1)).toISOString().slice(0, 7);
    const previousDate = billingPeriods.find((period) => period.billingMonth === previousMonth)?.meterDate;
    return billingPeriodText(month, selectedPeriodPattern, currentDate, previousDate);
  };
  const selectedBillingPeriod = billingPeriodRange(billingMonth, selectedPeriodPattern, meterDate, previousMeterDate);
  const fallbackPeriodEnd = new Date(Number(billingMonth.slice(0, 4)), Number(billingMonth.slice(5, 7)), 0);
  const contractDate = mainTab === "summary" ? fallbackPeriodEnd : selectedBillingPeriod?.end ?? fallbackPeriodEnd;
  const contractReferenceDate = `${contractDate.getFullYear()}-${String(contractDate.getMonth() + 1).padStart(2, "0")}-${String(contractDate.getDate()).padStart(2, "0")}`;
  const kanameContractOrder = new Map(contracts.map((contract, index) => [contract.lease_contract_unit_id, index]));
  const matchingPeriodContracts = contracts
    .filter((contract) =>
      (!contract.contract?.contract_start_date || contract.contract.contract_start_date <= contractReferenceDate) &&
      (!contract.contract?.contract_end_date || contract.contract.contract_end_date >= contractReferenceDate),
    )
    .sort((left, right) =>
      (right.contract?.contract_start_date ?? "").localeCompare(left.contract?.contract_start_date ?? ""),
    );
  const latestContractByUnit = new Map<string, ContractUnit>();
  for (const contract of matchingPeriodContracts) {
    const unitKey = `${contract.unit?.floor_label ?? ""}\u0000${contract.unit?.unit_code.trim().toLowerCase() ?? contract.lease_contract_unit_id}`;
    if (!latestContractByUnit.has(unitKey)) latestContractByUnit.set(unitKey, contract);
  }
  const periodContracts = Array.from(latestContractByUnit.values()).sort(
    (left, right) =>
      (kanameContractOrder.get(left.lease_contract_unit_id) ?? Number.MAX_SAFE_INTEGER) -
      (kanameContractOrder.get(right.lease_contract_unit_id) ?? Number.MAX_SAFE_INTEGER),
  );
  const billableCategoryContracts = activeCategory
    ? periodContracts.filter((contract) => isContractCategoryBillable(contract, activeCategory))
    : periodContracts;
  const selectedUnitPriceTaxMode: TaxMode = selectedSubItem
    ? billableCategoryContracts.flatMap((contract) => [
        ...contract.prices.filter((price) => price.asset_billing_line_item_id === selectedSubItem.asset_billing_line_item_id),
        ...contract.categoryPrices.filter((price) => price.category === selectedSubItem.category),
      ])[0]?.tax_mode
      ?? utilitySettings.find((setting) => setting.category === selectedSubItem.category)?.default_tax_mode
      ?? "exclusive"
    : "exclusive";
  const billableCategoryUnitIds = new Set(billableCategoryContracts.map((contract) => contract.unit?.unit_id).filter(Boolean));
  const occupiedUnitIds = new Set(periodContracts.map((contract) => contract.unit?.unit_id).filter(Boolean));
  const displayedReadingMeters = selectedSubItem
    ? meters.filter(
        (meter) => {
          const unitIds = meter.assignments.map((assignment) => assignment.unit_id);
          return meter.subItem.asset_meter_sub_item_id === selectedSubItem.asset_meter_sub_item_id &&
            (!meterTagFilter || (meterTagFilter === "__untagged__" ? !meter.tag : meter.tag?.asset_meter_tag_id === meterTagFilter)) &&
            (meter.is_rate_source || meter.is_allocation_source || unitIds.some((unitId) => !occupiedUnitIds.has(unitId) || billableCategoryUnitIds.has(unitId)));
        },
      )
    : [];
  const rolloverCandidates = displayedReadingMeters.flatMap((meter) => {
    const raw = values[meter.asset_meter_id];
    const current = Number(raw);
    const previous = Number(meter.entry?.previous_reading);
    if (
      meter.subItem.input_mode !== "reading" ||
      raw?.trim() === "" ||
      !Number.isFinite(current) ||
      !Number.isFinite(previous) ||
      current >= previous ||
      rolloverValues[meter.asset_meter_id]
    ) return [];
    const digits = Math.max(1, String(Math.trunc(previous)).replace("-", "").length);
    const rollover = 10 ** digits;
    return [{ meter, previous, current, rollover, usage: rollover - previous + current }];
  });
  const selectCategory = (category: UtilityCategory) => {
    setMainTab(category);
    setMeterSettingsItemId(null);
    const setting = categorySettings.find((row) => row.category === category);
    const firstSubItem = subItems.find(
      (item) => item.category === category && !item.is_monthly_fixed && (item.sub_item_kind !== "basic" || setting?.is_basic_billable),
    );
    const firstSurcharge = category === "electric"
      ? surcharges.find((item) => item.category === category && item.is_billable)
      : undefined;
    setSelectedItemId(firstSubItem?.asset_meter_sub_item_id ?? firstSurcharge?.asset_meter_surcharge_id ?? "");
  };
  const selectBillingItem = (itemId: string) => {
    setSelectedItemId(itemId);
    setMeterSettingsItemId(null);
  };
  const moveBillingMonth = (offset: number) => {
    const [year, month] = billingMonth.split("-").map(Number);
    const next = new Date(Date.UTC(year, month - 1 + offset, 1));
    setBillingMonth(`${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`);
  };
  const utilityClass = activeCategory ? `utility-${activeCategory}` : "";
  useEffect(() => {
    setRolloverConfirmationOpen(false);
  }, [assetId, billingMonth, selectedItemId]);
  useEffect(() => {
    if (!activeCategory || meterSettingsItemId) return;
    const selectableIds = [
      ...categoryTabItems.map((item) => item.asset_meter_sub_item_id),
      ...categorySurcharges
        .filter((item) => item.is_billable)
        .map((item) => item.asset_meter_surcharge_id),
    ];
    const switchSubItem = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey || selectableIds.length < 2) return;
      event.preventDefault();
      const currentIndex = Math.max(0, selectableIds.indexOf(selectedItemId));
      const direction = event.shiftKey ? -1 : 1;
      const nextIndex = (currentIndex + direction + selectableIds.length) % selectableIds.length;
      selectBillingItem(selectableIds[nextIndex]);
    };
    window.addEventListener("keydown", switchSubItem);
    return () => window.removeEventListener("keydown", switchSubItem);
  }, [activeCategory, meterSettingsItemId, selectedItemId, categoryTabItems, categorySurcharges]);

  useEffect(() => {
    if (mainTab === "buildingSettings" || meterSettingsItemId) return;
    let shiftOnly = false;
    const availableCategories = categories.filter((category) => {
      const setting = categorySettings.find((row) => row.category === category);
      if (!setting?.is_billable) return false;
      const hasSubItem = subItems.some(
        (item) => item.category === category && (item.sub_item_kind !== "basic" || setting.is_basic_billable),
      );
      const hasSurcharge = category === "electric" && surcharges.some((item) => item.category === category && item.is_billable);
      return hasSubItem || hasSurcharge;
    });
    const availableViews: MainTab[] = ["summary", ...availableCategories];
    const trackShift = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Shift" && !event.repeat) shiftOnly = true;
      else if (event.shiftKey) shiftOnly = false;
    };
    const switchCategory = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Shift" || !shiftOnly || availableViews.length < 2) return;
      const currentIndex = Math.max(0, availableViews.indexOf(mainTab));
      setMainTab(availableViews[(currentIndex + 1) % availableViews.length]);
      setMeterSettingsItemId(null);
      shiftOnly = false;
    };
    window.addEventListener("keydown", trackShift);
    window.addEventListener("keyup", switchCategory);
    return () => {
      window.removeEventListener("keydown", trackShift);
      window.removeEventListener("keyup", switchCategory);
    };
  }, [mainTab, meterSettingsItemId, categorySettings, subItems, surcharges]);

  return (
    <div className={`workspace-shell ${utilityClass} ${sidebarPinned ? "sidebar-pinned" : "sidebar-unpinned"}`}>
      <aside className="building-sidebar">
        <div className="sidebar-brand">
          <span>K</span>
          <div>
            <strong>KANAMETER</strong>
            <small>METER READING</small>
          </div>
          <button
            type="button"
            className={`sidebar-pin ${sidebarPinned ? "active" : ""}`}
            aria-label={sidebarPinned ? "サイドバーのピン留めを解除" : "サイドバーをピン留め"}
            title={sidebarPinned ? "ピン留めを解除" : "ピン留めする"}
            onClick={() => {
              const next = !sidebarPinned;
              setSidebarPinned(next);
              localStorage.setItem("kanameter-sidebar-pinned", String(next));
            }}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M14.5 3.5 20.5 9.5 17.7 10.4 14.1 14 14.5 18.5 12.8 20.2 9.7 15.2 5.8 11.3.5 8.2 2.2 6.5 6.7 6.9 10.3 3.3Z" />
            </svg>
          </button>
        </div>
        <p className="sidebar-heading">メニュー</p>
        <nav className="workspace-navigation" aria-label="画面メニュー">
          <button
            type="button"
            className={`sidebar-main-link ${mainTab === "summary" ? "active" : ""}`}
            onClick={() => setMainTab("summary")}
          >
            集計
          </button>
          {categories.map((category) => {
            const basicEnabled = categorySettings.find((setting) => setting.category === category)?.is_basic_billable ?? false;
            const items = subItems.filter((item) => item.category === category && !item.is_monthly_fixed && (item.sub_item_kind !== "basic" || basicEnabled));
            const categorySurchargeItems = category === "electric"
              ? surcharges.filter((item) => item.category === category && item.is_billable)
              : [];
            if (!billable(category) || (!items.length && !categorySurchargeItems.length)) return null;
            return (
              <div className={`sidebar-category utility-${category}`} key={category}>
                <button
                  type="button"
                  className={`sidebar-category-button ${mainTab === category ? "active" : ""}`}
                  onClick={() => {
                    selectCategory(category);
                  }}
                >
                  <span aria-hidden="true" />
                  {labels[category]}
                </button>
                <div className="sidebar-subitems">
                  {items.map((item) => (
                    <button
                      key={item.asset_meter_sub_item_id}
                      type="button"
                      className={mainTab === category && selectedItemId === item.asset_meter_sub_item_id ? "active" : ""}
                      onClick={() => {
                        setMainTab(category);
                        selectBillingItem(item.asset_meter_sub_item_id);
                      }}
                    >
                      {item.sub_item_name}
                    </button>
                  ))}
                  {categorySurchargeItems.map((item) => (
                    <button
                      key={item.asset_meter_surcharge_id}
                      type="button"
                      className={mainTab === category && selectedItemId === item.asset_meter_surcharge_id ? "active" : ""}
                      onClick={() => {
                        setMainTab(category);
                        selectBillingItem(item.asset_meter_surcharge_id);
                      }}
                    >
                      {displaySurchargeName(item.surcharge_name)}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-user">
            <strong>{profile.employee?.employee_name ?? profile.email}</strong>
            <button type="button" onClick={() => void onSignOut()}>
              ログアウト
            </button>
          </div>
        </div>
      </aside>
      <main className="workspace-main">
        <header className="workspace-top">
          <div className="workspace-selectors">
            <label className="building-picker">
              ビル
              <select value={assetId} onChange={(event) => setAssetId(event.target.value)}>
                {assets.map((asset) => (
                  <option key={asset.asset_id} value={asset.asset_id}>
                    {asset.asset_code} / {asset.short_name || asset.asset_name}
                  </option>
                ))}
              </select>
            </label>
            {!meterSettingsItemId && <label className="month-picker">
              請求月
              <span className="month-control">
                <button type="button" className="month-arrow" aria-label="前月へ" onClick={() => moveBillingMonth(-1)}>◀</button>
                <input
                  type="month"
                  value={billingMonth}
                  onChange={(event) => setBillingMonth(event.target.value)}
                />
                <button type="button" className="month-arrow" aria-label="翌月へ" onClick={() => moveBillingMonth(1)}>▶</button>
              </span>
            </label>}
            {!meterSettingsItemId && <label className="meter-date-picker">
              検針日
              <input
                type="date"
                value={meterDate}
                disabled={status === "confirmed"}
                onChange={(event) => {
                  const next = event.target.value;
                  setMeterDate(next);
                  if (!next) return;
                  void saveMeterReadingDate(supabase!, assetId, billingMonth, next)
                    .then(() => setStatus((current) => current ?? "draft"))
                    .catch((reason: Error) => setError(reason.message));
                }}
              />
            </label>}
          </div>
          <div className="confirm-area">
            <span className={`month-status ${status ?? "empty"}`}>
              {status === "confirmed"
                ? "KANAME連携済み"
                : status === "draft"
                  ? "保存済み・未確定"
                  : "未入力"}
            </span>
            <button
              type="button"
              className={status === "confirmed" ? "secondary compact" : "primary compact"}
              disabled={confirming}
              onClick={() => void (status === "confirmed" ? releaseConfirmation() : confirm())}
            >
              {confirming
                ? status === "confirmed" ? "解除中…" : "確定中…"
                : status === "confirmed"
                  ? "確定を解除"
                  : "確定"}
            </button>
          </div>
        </header>
        {error && <div className="alert workspace-alert">{error}</div>}
        {notice && (
          <div className="success-notice workspace-alert">{notice}</div>
        )}
        <div className="workspace-view-tabs" aria-label="検針画面">
            <button type="button" className={mainTab === "summary" ? "active" : ""} onClick={() => { setMainTab("summary"); setMeterSettingsItemId(null); }}>集計</button>
            {categories.map((category) => (
              <button
                key={category}
                type="button"
                className={`utility-${category} ${activeCategory === category ? "active" : ""}`}
                disabled={!billable(category)}
                onClick={() => selectCategory(category)}
              >
                {labels[category]}
              </button>
            ))}
          <button type="button" className={mainTab === "buildingSettings" ? "active" : ""} onClick={() => { setMainTab("buildingSettings"); setMeterSettingsItemId(null); }}>ビル設定</button>
        </div>
        {loading ? (
          <div className="loading">共通DBから読み込んでいます…</div>
        ) : mainTab === "summary" ? (
          <SummaryView
            assetId={assetId}
            billingMonth={billingMonth}
            categorySettings={categorySettings}
            utilitySettings={utilitySettings}
            meters={summaryMeters}
            contracts={periodContracts}
            subItems={subItems}
            surcharges={surcharges}
            surchargePrices={summarySurchargePrices}
            unitPriceCalculations={unitPriceCalculations}
            monthlyFixedCharges={monthlyFixedCharges}
            columnStorageUserId={profile.user_id}
          />
        ) : mainTab === "buildingSettings" ? (
          <BuildingSettingsView
            assetId={assetId}
            contracts={contracts}
            categorySettings={categorySettings}
            utilitySettings={utilitySettings}
            subItems={subItems}
            surcharges={surcharges}
            periodPatterns={periodPatterns}
            billingLineItems={billingLineItems}
            columnStorageUserId={profile.user_id}
            onSaved={(nextCategories, nextUtilitySettings, nextSubItems, nextSurcharges) => {
              setCategorySettings(nextCategories);
              setUtilitySettings(nextUtilitySettings);
              setSubItems(nextSubItems);
              setSurcharges(nextSurcharges);
            }}
            onNotice={setNotice}
            onError={setError}
          />
        ) : (
          <>
            <div className="sub-navigation">
              <div className="inspection-navigation">
                <div className="sub-tabs" aria-label="小分類">
                  {categoryTabItems.map((item) => (
                    <button
                      key={item.asset_meter_sub_item_id}
                      type="button"
                      className={selectedItemId === item.asset_meter_sub_item_id ? "active" : ""}
                      onClick={() => selectBillingItem(item.asset_meter_sub_item_id)}
                    >
                      {item.sub_item_name}
                    </button>
                  ))}
                  {categorySurcharges.filter((item) => item.is_billable).map((item) => (
                    <button
                      key={item.asset_meter_surcharge_id}
                      type="button"
                      className={selectedItemId === item.asset_meter_surcharge_id ? "active" : ""}
                      onClick={() => selectBillingItem(item.asset_meter_surcharge_id)}
                    >
                      {displaySurchargeName(item.surcharge_name)}
                    </button>
                  ))}
                </div>
                {(selectedSubItem || selectedSurcharge) && (
                  <div className="subitem-period-display">
                    <span>対象期間</span>
                    <strong>{periodLabelFor(billingMonth, meterDate)}</strong>
                  </div>
                )}
                {selectedSubItem?.sub_item_kind === "custom" && !selectedSubItem.is_monthly_fixed && (
                  <div className="inspection-view-options">
                    <label className="inspection-tag-filter">
                      <span>タグ</span>
                      <select value={meterTagFilter} onChange={(event) => setMeterTagFilter(event.target.value)}>
                        <option value="">すべて</option>
                        <option value="__untagged__">—</option>
                        {meterTags.map((tag) => <option key={tag.asset_meter_tag_id} value={tag.asset_meter_tag_id}>{tag.tag_name}</option>)}
                      </select>
                    </label>
                    <label className="checkbox-label usage-only-toggle"><input type="checkbox" checked={usageOnly} onChange={(event) => setUsageOnly(event.target.checked)} />使用量だけを表示</label>
                  </div>
                )}
                {rolloverCandidates.length > 0 && (
                  <div className="header-rollover-alert">
                    <span>当月値が前月値を下回っているメーターがあります。</span>
                    <button type="button" disabled={status === "confirmed"} onClick={() => setRolloverConfirmationOpen(true)}>一周として処理</button>
                  </div>
                )}
              </div>
              {selectedSubItem?.sub_item_kind === "custom" && !selectedSubItem.is_monthly_fixed && (
                <div className="sub-navigation-actions">
                  {!meterSettingsItemId && selectedSubItem.price_mode !== "fixed" && (
                    <button type="button" className="unit-price-calculator-link" onClick={() => setUnitPriceCalculatorOpen(true)}>
                      単価計算
                    </button>
                  )}
                  <button
                    type="button"
                    className="meter-settings-link"
                    onClick={() => setMeterSettingsItemId((current) => current ? null : selectedSubItem.asset_meter_sub_item_id)}
                  >
                    {meterSettingsItemId ? "検針画面へ戻る" : "メーター設定"}
                  </button>
                </div>
              )}
            </div>
            {meterSettingsItemId && selectedSubItem ? (
              <SettingsView
                assetId={assetId}
                subItems={[selectedSubItem]}
                meters={managedMeters.filter((meter) => meter.subItem.asset_meter_sub_item_id === meterSettingsItemId)}
                tags={meterTags}
                units={units}
                contracts={contracts}
                billingMonth={billingMonth}
                lockedSubItemId={meterSettingsItemId}
                onChanged={refreshMeterData}
                onSubItemSettingsChanged={(updated) => {
                  setSubItems((current) => current.map((item) => item.asset_meter_sub_item_id === updated.asset_meter_sub_item_id ? updated : item));
                }}
                onNotice={setNotice}
                onError={setError}
              />
            ) : (
            <section
              className={`workspace-body ${selectedSurcharge ? "with-evidence" : ""}`}
            >
              {selectedSurcharge ? (
                <SurchargeWorkspace
                  key={`${assetId}-${billingMonth}-${selectedSurcharge.asset_meter_surcharge_id}`}
                  surcharge={selectedSurcharge}
                  assetId={assetId}
                  billingMonth={billingMonth}
                  unit={categorySettings.find((row) => row.category === activeCategory)?.usage_unit ?? ""}
                  contracts={billableCategoryContracts}
                  meters={meters}
                  subItems={categorySubItems}
                />
              ) : <div className="workspace-table-card">
                {selectedSubItem?.sub_item_kind === "basic" ? (
                  <BasicChargeTable
                    contracts={billableCategoryContracts}
                    category={mainTab as UtilityCategory}
                    monthlyFixedItems={categorySubItems.filter((item) => item.is_monthly_fixed)}
                    monthlyFixedCharges={monthlyFixedCharges}
                    confirmed={status === "confirmed"}
                    onMonthlyFixedChange={(contractId, tenantId, leaseContractUnitId, subItemId, amount) => {
                      const key = `${leaseContractUnitId}|${subItemId}`;
                      setMonthlyFixedCharges((current) => ({ ...current, [key]: amount }));
                      void saveMonthlyFixedCharge(supabase!, assetId, billingMonth, contractId, tenantId, leaseContractUnitId, subItemId, amount)
                        .then((savedContractId) => {
                          setContracts((current) => current.map((row) => row.contract?.tenant_id === tenantId && !row.meterBilling.length
                            ? { ...row, meterBilling: [{ meter_reading_contract_id: savedContractId, row_no: 1, invoice_number: 1, electric_billable: true, water_billable: true, gas_billable: true, electric_sum_mode: "aggregate", water_sum_mode: "aggregate", gas_sum_mode: "aggregate", amount_rounding_mode: "floor", split_label: null, units: [], items: [] }] }
                            : row));
                          setStatus((current) => current ?? "draft");
                          setNotice("月額定額を保存しました。");
                        })
                        .catch((reason: Error) => setError(reason.message));
                    }}
                  />
                ) : selectedSubItem ? (
                  <CustomItemTable
                    billingMonth={billingMonth}
                    meters={displayedReadingMeters}
                    contracts={billableCategoryContracts}
                    category={mainTab as UtilityCategory}
                    lineItemId={selectedSubItem.asset_billing_line_item_id}
                    unitPriceOverride={calculatedUnitPrices[selectedSubItem.asset_meter_sub_item_id]}
                    defaultUnitPrice={selectedSubItem.default_unit_price}
                    values={values}
                    saveStates={saveStates}
                    confirmed={status === "confirmed"}
                    usageHistory={usageHistory}
                    rolloverValues={rolloverValues}
                    columnStorageUserId={profile.user_id}
                    usageOnly={usageOnly}
                    onChange={queueSave}
                  />
                ) : (
                  <div className="empty-cell">小分類が設定されていません。</div>
                )}
              </div>}
            </section>
            )}
          </>
        )}
        <footer className="workspace-legend">
          <span className="rounding-badge rounding-floor">新</span><span>・・・新契約書（小数点以下を切り捨て）</span>
        </footer>
      </main>
      {rolloverConfirmationOpen && rolloverCandidates.length > 0 && (
        <div className="rollover-modal-backdrop" role="presentation" onMouseDown={() => setRolloverConfirmationOpen(false)}>
          <section className="rollover-modal" role="dialog" aria-modal="true" aria-labelledby="rollover-modal-title" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <span>検針値の確認</span>
                <h2 id="rollover-modal-title">一周として処理しますか？</h2>
              </div>
              <button type="button" className="rollover-modal-close" aria-label="閉じる" onClick={() => setRolloverConfirmationOpen(false)}>×</button>
            </header>
            <p>以下のメーターを一周として処理し、表示されている使用量で保存します。</p>
            <div className="rollover-confirmation-table-wrap">
              <table className="rollover-confirmation-table">
                <thead><tr><th>メーター番号</th><th>前月値</th><th>当月値</th><th>一周値</th><th>処理後の使用量</th></tr></thead>
                <tbody>
                  {rolloverCandidates.map(({ meter, previous, current, rollover, usage }) => (
                    <tr key={meter.asset_meter_id}>
                      <td>{meter.meter_code}</td>
                      <td>{formatUsage(previous, getReadingDecimalDigits(meter.subItem.asset_meter_sub_item_id, meter.subItem.input_decimal_digits))}</td>
                      <td>{formatUsage(current, getReadingDecimalDigits(meter.subItem.asset_meter_sub_item_id, meter.subItem.input_decimal_digits))}</td>
                      <td>{formatUsage(rollover, getReadingDecimalDigits(meter.subItem.asset_meter_sub_item_id, meter.subItem.input_decimal_digits))}</td>
                      <td><strong>{formatUsage(usage, getReadingDecimalDigits(meter.subItem.asset_meter_sub_item_id, meter.subItem.input_decimal_digits))}</strong></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <footer>
              <button type="button" className="primary" onClick={() => {
                rolloverCandidates.forEach(({ meter, rollover }) => setMeterRollover(meter, rollover));
                setRolloverConfirmationOpen(false);
              }}>一周として処理する</button>
            </footer>
          </section>
        </div>
      )}
      {unitPriceCalculatorOpen && selectedSubItem && !selectedSubItem.is_monthly_fixed && selectedSubItem.price_mode !== "fixed" && (
        <VariableUnitPriceCalculator
          itemName={selectedSubItem.sub_item_name}
          taxMode={selectedUnitPriceTaxMode}
          priceMode={selectedSubItem.price_mode}
          initialCalculation={unitPriceCalculations[selectedSubItem.asset_meter_sub_item_id]}
          tariffDefinition={utilityTariff}
          billingMonth={billingMonth}
          rateSourceMeters={meters
            .filter((meter) => meter.is_rate_source && meter.subItem.asset_meter_sub_item_id === selectedSubItem.asset_meter_sub_item_id)
            .map((meter) => ({
              id: meter.asset_meter_id,
              label: meter.meter_code,
              usage: currentMeterUsage(meter, values, rolloverValues),
            }))}
          onSave={async (calculation) => {
            const saved = { ...calculation, asset_meter_sub_item_id: selectedSubItem.asset_meter_sub_item_id };
            await saveMeterUnitPriceCalculation(supabase!, assetId, billingMonth, saved);
            setUnitPriceCalculations((current) => ({ ...current, [selectedSubItem.asset_meter_sub_item_id]: saved }));
            setCalculatedUnitPrices((current) => ({ ...current, [selectedSubItem.asset_meter_sub_item_id]: Number(saved.unit_price) }));
            setNotice("単価計算を共通DBに保存しました。");
          }}
          onSaveTariff={async (name, taxRate, tiers) => {
            await saveNextUtilityTariffVersion(supabase!, assetId, billingMonth, name, taxRate, tiers);
            setNotice(`${billingMonth}請求分から適用する料金表を保存しました。`);
            setUtilityTariff(await loadUtilityTariff(supabase!, assetId, billingMonth));
          }}
          onClose={() => setUnitPriceCalculatorOpen(false)}
        />
      )}
    </div>
  );
}

function evaluateAdditionExpression(expression: string) {
  const normalized = expression.replace(/[,，]/g, "").trim();
  if (!normalized) return null;
  const terms = normalized.split(/[+＋]/).map((term) => term.trim());
  if (terms.some((term) => term === "" || !/^\d+(?:\.\d+)?$/.test(term))) return null;
  const total = terms.reduce((sum, term) => sum + Number(term), 0);
  return Number.isFinite(total) ? total : null;
}

function formatAdditionExpression(expression: string) {
  return expression.split(/([+＋])/).map((part) => {
    if (part === "+" || part === "＋") return part;
    const compact = part.replace(/[,，\s]/g, "");
    if (!/^\d+(?:\.\d*)?$/.test(compact)) return part;
    const [integer, decimal] = compact.split(".");
    const formattedInteger = Number(integer || 0).toLocaleString("ja-JP");
    return decimal === undefined ? formattedInteger : `${formattedInteger}.${decimal}`;
  }).join("");
}

function loadStoredSurchargeUnitPrice(assetId: string, billingMonth: string, surchargeId: string) {
  try {
    const stored = JSON.parse(
      localStorage.getItem(`kanameter-surcharge-evidence:${assetId}:${billingMonth}:${surchargeId}`) ?? "{}",
    ) as { unitPrice?: number };
    return stored.unitPrice == null || !Number.isFinite(Number(stored.unitPrice)) ? null : Math.max(0, Number(stored.unitPrice));
  } catch {
    return null;
  }
}

function VariableUnitPriceCalculator({
  itemName,
  taxMode,
  priceMode,
  initialCalculation,
  tariffDefinition,
  billingMonth,
  rateSourceMeters,
  onSave,
  onSaveTariff,
  onClose,
}: {
  itemName: string;
  taxMode: TaxMode;
  priceMode: "amount" | "master_meter";
  initialCalculation?: MeterUnitPriceCalculation;
  tariffDefinition: UtilityTariffVersion | null;
  billingMonth: string;
  rateSourceMeters: Array<{ id: string; label: string; usage: number }>;
  onSave: (calculation: MeterUnitPriceCalculation) => Promise<void>;
  onSaveTariff: (name: string, taxRate: number, tiers: UtilityTariffTier[]) => Promise<void>;
  onClose: () => void;
}) {
  const [grossExpression, setGrossExpression] = useState(formatAdditionExpression(String(initialCalculation?.billed_inclusive ?? "")));
  const [taxExpression, setTaxExpression] = useState(formatAdditionExpression(String(initialCalculation?.billed_tax ?? "")));
  const [usageExpression, setUsageExpression] = useState(String(initialCalculation?.billed_usage ?? ""));
  const [rateSourceMeterId, setRateSourceMeterId] = useState(
    initialCalculation?.rate_source_meter_id && rateSourceMeters.some((meter) => meter.id === initialCalculation.rate_source_meter_id)
      ? initialCalculation.rate_source_meter_id
      : rateSourceMeters[0]?.id ?? "",
  );
  const [unitPriceDigits, setUnitPriceDigits] = useState(Math.min(4, Math.max(0, Number(initialCalculation?.unit_price_rounding_digits ?? 2))));
  const [unitPriceRoundingMode, setUnitPriceRoundingMode] = useState<"floor" | "round" | "ceil">(
    initialCalculation?.unit_price_rounding_mode ?? "round",
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [editingTariff, setEditingTariff] = useState(false);
  const [tariffSaving, setTariffSaving] = useState(false);
  const databaseWaterTiers = tariffDefinition?.tiers.filter((tier) => tier.component === "water").map((tier) => ({ min: tier.min_usage, max: tier.max_usage ?? Number.POSITIVE_INFINITY, rate: tier.rate, deduction: tier.deduction }));
  const databaseSewerTiers = tariffDefinition?.tiers.filter((tier) => tier.component === "sewer").map((tier) => ({ min: tier.min_usage, max: tier.max_usage ?? Number.POSITIVE_INFINITY, rate: tier.rate, deduction: tier.deduction }));
  const waterTiers = databaseWaterTiers?.length ? databaseWaterTiers : osakaGeneralWaterTiers;
  const sewerTiers = databaseSewerTiers?.length ? databaseSewerTiers : osakaGeneralSewerTiers;
  const [draftTariffTiers, setDraftTariffTiers] = useState<UtilityTariffTier[]>(tariffDefinition?.tiers ?? []);
  const grossAmount = evaluateAdditionExpression(grossExpression);
  const automaticTaxAmount = grossAmount == null ? null : Math.floor(grossAmount * 10 / 110);
  const enteredTaxAmount = evaluateAdditionExpression(taxExpression);
  const selectedRateSource = rateSourceMeters.find((meter) => meter.id === rateSourceMeterId);
  const tariff = priceMode === "master_meter" && selectedRateSource
    ? calculateOsakaGeneralWaterTariff(selectedRateSource.usage, waterTiers, sewerTiers, tariffDefinition?.tax_rate ?? 0.1)
    : null;
  const effectiveGrossAmount = priceMode === "master_meter" ? tariff?.totalGross ?? null : grossAmount;
  const taxAmount = priceMode === "master_meter" ? tariff?.tax ?? null : enteredTaxAmount ?? automaticTaxAmount;
  const netAmount = effectiveGrossAmount == null || taxAmount == null ? null : effectiveGrossAmount - taxAmount;
  const usage = priceMode === "master_meter" ? tariff?.billedUsage ?? null : evaluateAdditionExpression(usageExpression);
  const calculationAmount = taxMode === "inclusive" ? effectiveGrossAmount : netAmount;
  const calculatedUnitPrice = calculationAmount != null && usage != null && usage !== 0
    ? roundToDigits(calculationAmount / usage, unitPriceDigits, unitPriceRoundingMode)
    : null;

  const save = async () => {
    if (calculatedUnitPrice == null) {
      onClose();
      return;
    }
    setSaving(true);
    setSaveError("");
    try {
      await onSave({
        asset_meter_sub_item_id: initialCalculation?.asset_meter_sub_item_id ?? "",
        unit_price: calculatedUnitPrice,
        billed_inclusive: effectiveGrossAmount,
        billed_tax: taxAmount,
        billed_exclusive: netAmount,
        billed_usage: usage,
        rate_source_meter_id: priceMode === "master_meter" ? rateSourceMeterId || null : null,
        tariff_code: priceMode === "master_meter" ? tariffDefinition?.utility_tariff_version_id ?? OSAKA_GENERAL_WATER_TARIFF_CODE : null,
        water_inclusive: priceMode === "master_meter" ? tariff?.waterGross ?? null : null,
        sewer_inclusive: priceMode === "master_meter" ? tariff?.sewerGross ?? null : null,
        unit_price_rounding_digits: unitPriceDigits,
        unit_price_rounding_mode: unitPriceRoundingMode,
      });
      onClose();
    } catch (reason) {
      setSaveError((reason as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const beginTariffEdit = () => {
    setDraftTariffTiers(tariffDefinition?.tiers ?? [
      ...osakaGeneralWaterTiers.map((tier, index) => ({ component: "water" as const, min_usage: tier.min, max_usage: Number.isFinite(tier.max) ? tier.max : null, rate: tier.rate, deduction: tier.deduction, sort_order: index + 1 })),
      ...osakaGeneralSewerTiers.map((tier, index) => ({ component: "sewer" as const, min_usage: tier.min, max_usage: Number.isFinite(tier.max) ? tier.max : null, rate: tier.rate, deduction: tier.deduction, sort_order: index + 1 })),
    ]);
    setEditingTariff(true);
  };
  const saveTariff = async () => {
    setTariffSaving(true);
    setSaveError("");
    try {
      await onSaveTariff(tariffDefinition?.tariff_name ?? "大阪市・一般用・1か月", tariffDefinition?.tax_rate ?? 0.1, draftTariffTiers);
      setEditingTariff(false);
      onClose();
    } catch (reason) {
      setSaveError((reason as Error).message);
    } finally {
      setTariffSaving(false);
    }
  };

  const moveToNextInput = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    const inputs = Array.from(event.currentTarget.querySelectorAll("input"));
    const currentIndex = inputs.indexOf(event.target as HTMLInputElement);
    if (currentIndex < 0 || currentIndex >= inputs.length - 1) return;
    event.preventDefault();
    inputs[currentIndex + 1].focus();
  };

  return (
    <div className="calculator-modal-backdrop" role="presentation" onMouseDown={() => { if (!editingTariff) void save(); }}>
      <section className="calculator-modal" role="dialog" aria-modal="true" aria-labelledby="unit-price-calculator-title" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <p className="eyebrow">UNIT PRICE</p>
            <h2 id="unit-price-calculator-title">{itemName}の単価計算</h2>
          </div>
          <button type="button" className="calculator-modal-close" aria-label="閉じる" onClick={() => { if (editingTariff) onClose(); else void save(); }}>×</button>
        </header>
        <div className="calculator-tax-mode">
          適用する税区分：<strong>{taxMode === "inclusive" ? "税込" : "税抜"}</strong>
        </div>
        {priceMode === "master_meter" ? (
          <div className="calculator-master-meter-fields">
            <div className="calculator-master-overview">
              <label>
                <span>大元メーター</span>
                <select value={rateSourceMeterId} onChange={(event) => setRateSourceMeterId(event.target.value)}>
                  {rateSourceMeters.length === 0 && <option value="">メーター設定で大元メーターを登録してください</option>}
                  {rateSourceMeters.map((meter) => <option key={meter.id} value={meter.id}>{meter.label}</option>)}
                </select>
              </label>
              <div className="calculator-result-field"><span>料金表</span><strong>{tariffDefinition?.tariff_name ?? "大阪市・一般用・1か月"}</strong></div>
            </div>
            <div className="calculator-result-field calculator-usage-field"><span>計算使用量</span><strong>{tariff ? `${tariff.billedUsage.toLocaleString("ja-JP")} m³` : "—"}</strong></div>
            <table className="calculator-amount-breakdown">
              <thead><tr><th>料金区分</th><th>税込</th><th>消費税</th><th>税抜</th></tr></thead>
              <tbody>
                <tr><th>上水道料金</th><td>{tariff ? formatYen(tariff.waterGross) : "—"}</td><td>{tariff ? formatYen(tariff.waterGross - tariff.waterNet) : "—"}</td><td>{tariff ? formatYen(tariff.waterNet) : "—"}</td></tr>
                <tr><th>下水道料金</th><td>{tariff ? formatYen(tariff.sewerGross) : "—"}</td><td>{tariff ? formatYen(tariff.sewerGross - tariff.sewerNet) : "—"}</td><td>{tariff ? formatYen(tariff.sewerNet) : "—"}</td></tr>
                <tr className="total"><th>合計料金</th><td>{tariff ? formatYen(tariff.totalGross) : "—"}</td><td>{tariff ? formatYen(tariff.tax) : "—"}</td><td>{tariff ? formatYen(tariff.totalNet) : "—"}</td></tr>
              </tbody>
            </table>
            <details className="tariff-details">
              <summary>段階料金表と計算方法を確認</summary>
              <div className="tariff-details-header">
                <p>使用量は小数点以下を切り捨てます。該当段階の「単価 × 使用量 − 控除額」で税抜額を求め、上水道・下水道をそれぞれ{((tariffDefinition?.tax_rate ?? 0.1) * 100).toLocaleString("ja-JP")}%税込にして合算します。</p>
                {!editingTariff && <button type="button" onClick={beginTariffEdit}>編集</button>}
              </div>
              <div className="tariff-tables">
                {editingTariff ? <>
                  <TariffEditorTable title="上水道料金" component="water" tiers={draftTariffTiers} onChange={setDraftTariffTiers} />
                  <TariffEditorTable title="下水道使用料" component="sewer" tiers={draftTariffTiers} onChange={setDraftTariffTiers} />
                </> : <>
                  <TariffTable title="上水道料金" tiers={waterTiers} />
                  <TariffTable title="下水道使用料" tiers={sewerTiers} />
                </>}
              </div>
              {editingTariff ? <div className="tariff-edit-actions">
                <span>{billingMonth}請求分から適用されます。</span>
                <button type="button" onClick={() => setEditingTariff(false)}>キャンセル</button>
              </div> : <small>適用期間：{tariffDefinition?.effective_from ?? "2019-11-01"} ～ {tariffDefinition?.effective_to ?? "現在"}</small>}
            </details>
          </div>
        ) : <div className="calculator-fields" onKeyDown={moveToNextInput}>
          <label>
            <span>水道局からの請求金額（税込）</span>
            <input value={grossExpression} onChange={(event) => setGrossExpression(formatAdditionExpression(event.target.value))} inputMode="decimal" placeholder="例：100,000＋25,000" autoFocus />
          </label>
          <label>
            <span>消費税額</span>
            <input value={taxExpression || (automaticTaxAmount?.toLocaleString("ja-JP") ?? "")} onChange={(event) => setTaxExpression(formatAdditionExpression(event.target.value))} inputMode="decimal" placeholder="未入力時は自動計算" />
          </label>
          <div className="calculator-result-field">
            <span>請求金額（税抜）</span>
            <strong>{netAmount == null ? "—" : formatYen(netAmount)}</strong>
          </div>
          <label>
            <span>使用量</span>
            <input value={usageExpression} onChange={(event) => setUsageExpression(event.target.value)} inputMode="decimal" placeholder="例：100＋200" />
          </label>
        </div>}
        <div className="calculator-unit-price-result">
          <span>計算単価（{taxMode === "inclusive" ? "税込" : "税抜"}）</span>
          <strong>{calculatedUnitPrice == null ? "—" : `${calculatedUnitPrice.toLocaleString("ja-JP", { minimumFractionDigits: unitPriceDigits, maximumFractionDigits: unitPriceDigits })} 円`}</strong>
          <div className="calculator-unit-price-settings">
            <label>
              <span>表示桁数</span>
              <select value={unitPriceDigits} onChange={(event) => setUnitPriceDigits(Number(event.target.value))}>
                {[0, 1, 2, 3, 4].map((digits) => <option key={digits} value={digits}>小数第{digits}位</option>)}
              </select>
            </label>
            <label>
              <span>表示以下処理</span>
              <select value={unitPriceRoundingMode} onChange={(event) => setUnitPriceRoundingMode(event.target.value as "floor" | "round" | "ceil")}>
                <option value="floor">切り捨て</option>
                <option value="round">四捨五入</option>
                <option value="ceil">切り上げ</option>
              </select>
            </label>
          </div>
        </div>
        {saveError && <p className="calculator-save-error">{saveError}</p>}
        {editingTariff && <footer>
          <button type="button" className="primary" disabled={tariffSaving} onClick={() => void saveTariff()}>{tariffSaving ? "保存中…" : "保存して閉じる"}</button>
        </footer>}
      </section>
    </div>
  );
}

function TariffTable({ title, tiers }: { title: string; tiers: OsakaWaterTariffTier[] }) {
  return (
    <table>
      <caption>{title}</caption>
      <thead><tr><th>使用量</th><th>単価</th><th>控除額</th></tr></thead>
      <tbody>{tiers.map((tier) => (
        <tr key={tier.min}>
          <td>{Number.isFinite(tier.max) ? `${tier.min}～${tier.max}m³` : `${tier.min.toLocaleString("ja-JP")}m³以上`}</td>
          <td>{tier.rate.toLocaleString("ja-JP")}円</td>
          <td>{tier.deduction < 0 ? `＋${Math.abs(tier.deduction).toLocaleString("ja-JP")}円` : `${tier.deduction.toLocaleString("ja-JP")}円`}</td>
        </tr>
      ))}</tbody>
    </table>
  );
}

function TariffEditorTable({ title, component, tiers, onChange }: {
  title: string;
  component: "water" | "sewer";
  tiers: UtilityTariffTier[];
  onChange: (tiers: UtilityTariffTier[]) => void;
}) {
  const rows = tiers.filter((tier) => tier.component === component).sort((left, right) => left.sort_order - right.sort_order);
  const update = (sortOrder: number, patch: Partial<UtilityTariffTier>) => onChange(tiers.map((tier) =>
    tier.component === component && tier.sort_order === sortOrder ? { ...tier, ...patch } : tier,
  ));
  return (
    <table className="tariff-editor-table">
      <caption>{title}</caption>
      <thead><tr><th>使用量</th><th>単価</th><th>控除額</th></tr></thead>
      <tbody>{rows.map((tier) => (
        <tr key={tier.sort_order}>
          <td>{tier.max_usage == null ? `${tier.min_usage.toLocaleString("ja-JP")}m³以上` : `${tier.min_usage}～${tier.max_usage}m³`}</td>
          <td><input type="number" min="0" step="0.01" value={tier.rate} onChange={(event) => update(tier.sort_order, { rate: Number(event.target.value) })} /></td>
          <td><input type="number" step="1" value={tier.deduction} onChange={(event) => update(tier.sort_order, { deduction: Number(event.target.value) })} /></td>
        </tr>
      ))}</tbody>
    </table>
  );
}

function SummaryView({
  assetId,
  billingMonth,
  categorySettings,
  utilitySettings,
  contracts,
  meters,
  subItems,
  surcharges,
  surchargePrices,
  unitPriceCalculations,
  monthlyFixedCharges,
  columnStorageUserId,
}: {
  assetId: string;
  billingMonth: string;
  categorySettings: MeterCategorySetting[];
  utilitySettings: AssetUtilitySetting[];
  meters: MeterReadingRow[];
  contracts: ContractUnit[];
  subItems: MeterSubItem[];
  surcharges: MeterSurcharge[];
  surchargePrices: Record<string, number>;
  unitPriceCalculations: Record<string, MeterUnitPriceCalculation>;
  monthlyFixedCharges: Record<string, number>;
  columnStorageUserId: string;
}) {
  const eligibleContracts = contracts.filter((row) =>
    ["office", "warehouse", "storage"].includes((row.unit?.unit_type ?? "").toLowerCase()),
  );
  const categoryColumns = categories.map((category) => {
    const setting = categorySettings.find((row) => row.category === category);
    const basic = setting?.is_basic_billable ? subItems.find((item) => item.category === category && item.sub_item_kind === "basic") : undefined;
    const custom = subItems.filter((item) => item.category === category && item.sub_item_kind === "custom");
    const surcharge = category === "electric" ? surcharges.find((item) => item.category === category && item.is_billable) : undefined;
    const subItemCount = (basic ? 1 : 0) + custom.length;
    return { category, enabled: !!setting?.is_billable, basic, custom, surcharge, showTotal: subItemCount >= 2 };
  }).filter((group) => group.enabled);
  const billingGroupIds = Array.from(new Set(eligibleContracts.map((row) => billingGroupKey(row))));
  const priceForContractItem = (contract: ContractUnit, item: MeterSubItem) => {
    const itemPrice = contract.prices.find((row) => row.asset_billing_line_item_id === item.asset_billing_line_item_id);
    const categoryPrice = contract.categoryPrices.find((row) => row.category === item.category);
    const taxMode = itemPrice?.tax_mode
      ?? categoryPrice?.tax_mode
      ?? utilitySettings.find((setting) => setting.category === item.category)?.default_tax_mode
      ?? "exclusive";
    const calculatedPrice = unitPriceCalculations[item.asset_meter_sub_item_id]?.unit_price;
    const price = calculatedPrice
      ?? contractUnitPriceForBillingMonth(itemPrice, billingMonth)
      ?? contractUnitPriceForBillingMonth(categoryPrice, billingMonth);
    return price == null ? null : Number(price);
  };
  const calculationForContracts = (billableContracts: ContractUnit[], item: MeterSubItem) => {
    if (item.is_monthly_fixed) {
      const amount = billableContracts.reduce(
        (sum, contract) => sum + (monthlyFixedCharges[`${contract.lease_contract_unit_id}|${item.asset_meter_sub_item_id}`] ?? 0),
        0,
      );
      return { usage: 0, amount };
    }
    const contractByUnitId = new Map(
      billableContracts.flatMap((contract) => contract.unit?.unit_id ? [[contract.unit.unit_id, contract] as const] : []),
    );
    const chargeRows = meters.flatMap((meter) => {
      if (meter.subItem.asset_meter_sub_item_id !== item.asset_meter_sub_item_id) return [];
      if (meter.is_allocation_source) return [];
      const totalUsage = billingAdjustedUsage(meter, adjustedMeterUsage(meter, meters, storedMeterUsage));
      return meter.assignments.flatMap((assignment) => {
        const contract = contractByUnitId.get(assignment.unit_id);
        if (!contract) return [];
        return [{
          meterId: `${meter.asset_meter_id}:${assignment.unit_id}`,
          usage: totalUsage * meterAllocationShare(meter, assignment.unit_id, meters),
          price: priceForContractItem(contract, item),
        }];
      });
    });
    const representative = billableContracts[0];
    return calculateUsageCharge(
      chargeRows,
      item.aggregation_decimal_digits,
      item.usage_rounding_mode,
      sumModeFor(representative, item.category),
      amountRoundingFor(representative),
    );
  };
  const summaryRows = billingGroupIds.map((billingGroupId) => {
    const tenantContracts = eligibleContracts.filter((row) => billingGroupKey(row) === billingGroupId);
    const groups = categoryColumns.map((group) => {
      const billableContracts = tenantContracts.filter((contract) => isContractCategoryBillable(contract, group.category));
      const enabled = billableContracts.length > 0;
      const groupBasic = group.basic ? billableContracts[0]?.meterBilling[0]?.items.find((item) => item.asset_meter_sub_item_id === group.basic?.asset_meter_sub_item_id && item.is_billable)?.fixed_amount : null;
      const basicAmount = group.basic ? groupBasic != null ? Number(groupBasic) : billableContracts.reduce((sum, contract) => sum + Number(contract.basics.find((row) => row.category === group.category)?.amount ?? 0), 0) : null;
      const custom = group.custom.map((item) => {
        return calculationForContracts(billableContracts, item);
      });
      const totalUsage = custom.reduce((sum, item) => sum + item.usage, 0);
      const surchargePrice = group.surcharge ? surchargePrices[group.surcharge.asset_meter_surcharge_id] : null;
      const surchargeAmount = group.surcharge
        ? surchargePrice == null
          ? 0
          : roundUtilityAmount(totalUsage * surchargePrice, billableContracts[0]?.utility_amount_rounding_mode ?? "round")
        : null;
      const total = (basicAmount ?? 0) + custom.reduce((sum, item) => sum + item.amount, 0);
      return { enabled, basicAmount, custom, surchargeAmount, totalUsage, total };
    });
    return {
      tenantId: billingGroupId,
      tenantName: billingGroupTenantName(tenantContracts[0]),
      tenantContracts,
      floors: Array.from(new Set(tenantContracts.map((row) => formatFloor(row.unit?.floor_label)).filter((value) => value && value !== "—"))).join("・") || "—",
      groups,
      total: groups.reduce((sum, group) => sum + group.total + (group.surchargeAmount ?? 0), 0),
    };
  });
  const summaryColumnGroups = [
    "summary-tenant",
    "summary-unit",
    ...categoryColumns.flatMap((group) => [
      ...(group.basic ? ["summary-amount"] : []),
      ...group.custom.flatMap((item) => item.is_monthly_fixed ? ["summary-amount"] : ["summary-usage", "summary-amount"]),
      ...(group.showTotal ? ["summary-usage", "summary-amount"] : []),
      ...(group.surcharge ? ["summary-amount"] : []),
    ]),
    "summary-amount",
  ];
  return (
    <section className="summary-view">
      <div className="table-wrap summary-billing-table">
        <ResizableTable className="summary-table" storageKey="summary-billing" storageUserId={columnStorageUserId} columnGroups={summaryColumnGroups}>
          <thead>
            <tr>
              <ColumnHeader rowSpan={3} textAlign="tenant" columnGroup="summary-tenant">テナント名</ColumnHeader>
              <ColumnHeader rowSpan={3} columnGroup="summary-unit">階</ColumnHeader>
              {categoryColumns.flatMap((group) => [
                <th className={`summary-category utility-${group.category}`} colSpan={(group.basic ? 1 : 0) + group.custom.reduce((sum, item) => sum + (item.is_monthly_fixed ? 1 : 2), 0) + (group.showTotal ? 2 : 0)} key={group.category}>{labels[group.category]}</th>,
                ...(group.surcharge ? [<ColumnHeader rowSpan={3} textAlign="amount" columnGroup="summary-amount" className="summary-surcharge" key={`${group.category}-surcharge-top`}>電気代<br />増額分</ColumnHeader>] : []),
              ])}
              <ColumnHeader rowSpan={3} textAlign="amount" columnGroup="summary-amount">合計請求額</ColumnHeader>
            </tr>
            <tr>{categoryColumns.flatMap((group) => [
              ...(group.basic ? [<ColumnHeader className={`summary-subhead utility-${group.category}`} rowSpan={2} textAlign="amount" columnGroup="summary-amount" key={`${group.category}-basic`}>基本料</ColumnHeader>] : []),
              ...group.custom.flatMap((item) => !group.showTotal
                ? item.is_monthly_fixed
                  ? [<ColumnHeader className={`summary-subhead utility-${group.category}`} rowSpan={2} textAlign="amount" columnGroup="summary-amount" key={`${item.asset_meter_sub_item_id}-amount-direct`}>{item.sub_item_name}</ColumnHeader>]
                  : [<ColumnHeader className={`summary-subhead utility-${group.category}`} rowSpan={2} columnGroup="summary-usage" key={`${item.asset_meter_sub_item_id}-usage-direct`}>使用量</ColumnHeader>, <ColumnHeader className={`summary-subhead utility-${group.category}`} rowSpan={2} textAlign="amount" columnGroup="summary-amount" key={`${item.asset_meter_sub_item_id}-amount-direct`}>金額</ColumnHeader>]
                : item.is_monthly_fixed
                  ? [<ColumnHeader className={`summary-subhead utility-${group.category}`} rowSpan={2} textAlign="amount" columnGroup="summary-amount" key={item.asset_meter_sub_item_id}>{item.sub_item_name}</ColumnHeader>]
                  : [<th className={`summary-subhead utility-${group.category}`} colSpan={2} key={item.asset_meter_sub_item_id}>{item.sub_item_name}</th>]),
              ...(group.showTotal ? [<th className={`summary-subhead utility-${group.category}`} colSpan={2} key={`${group.category}-total`}>{labels[group.category]}合計</th>] : []),
            ])}</tr>
            <tr>{categoryColumns.flatMap((group) => group.showTotal ? [
              ...group.custom.flatMap((item) => item.is_monthly_fixed
                ? []
                : [<ColumnHeader className={`summary-subhead utility-${group.category}`} columnGroup="summary-usage" key={`${item.asset_meter_sub_item_id}-usage`}>使用量</ColumnHeader>, <ColumnHeader className={`summary-subhead utility-${group.category}`} textAlign="amount" columnGroup="summary-amount" key={`${item.asset_meter_sub_item_id}-amount`}>金額</ColumnHeader>]),
              <ColumnHeader className={`summary-subhead utility-${group.category}`} columnGroup="summary-usage" key={`${group.category}-total-usage`}>使用量</ColumnHeader>,
              <ColumnHeader className={`summary-subhead utility-${group.category}`} textAlign="amount" columnGroup="summary-amount" key={`${group.category}-total-amount`}>金額</ColumnHeader>,
            ] : [])}</tr>
          </thead>
          <tbody>
            {summaryRows.map((row) => (
              <tr key={row.tenantId}>
                <td><TenantNameWithRounding name={row.tenantName} contracts={row.tenantContracts} /></td>
                <td className="summary-unit-cell">{row.floors}</td>
                {row.groups.flatMap((group, groupIndex) => [
                  ...(group.basicAmount != null ? [<td className={`numeric ${group.enabled ? "" : "summary-disabled-cell"}`} key={`${groupIndex}-basic`}>{group.enabled ? formatYen(group.basicAmount) : null}</td>] : []),
                  ...group.custom.flatMap((item, itemIndex) => categoryColumns[groupIndex].custom[itemIndex].is_monthly_fixed
                    ? [<td className={`numeric ${group.enabled ? "" : "summary-disabled-cell"}`} key={`${groupIndex}-${itemIndex}-amount`}>{group.enabled ? formatYen(item.amount) : null}</td>]
                    : [<td className={`numeric ${group.enabled ? "" : "summary-disabled-cell"}`} key={`${groupIndex}-${itemIndex}-usage`}>{group.enabled ? formatUsage(item.usage, categoryColumns[groupIndex].custom[itemIndex].aggregation_decimal_digits) : null}</td>, <td className={`numeric ${group.enabled ? "" : "summary-disabled-cell"}`} key={`${groupIndex}-${itemIndex}-amount`}>{group.enabled ? formatYen(item.amount) : null}</td>]),
                  ...(categoryColumns[groupIndex].showTotal ? [
                    <td className={`numeric ${group.enabled ? "" : "summary-disabled-cell"}`} key={`${groupIndex}-total-usage`}>{group.enabled ? <strong>{formatUsage(group.totalUsage, Math.max(0, ...categoryColumns[groupIndex].custom.map((item) => item.aggregation_decimal_digits)))}</strong> : null}</td>,
                    <td className={`numeric ${group.enabled ? "" : "summary-disabled-cell"}`} key={`${groupIndex}-total-amount`}>{group.enabled ? <strong>{formatYen(group.total)}</strong> : null}</td>,
                  ] : []),
                  ...(group.surchargeAmount != null ? [<td className={`numeric ${group.enabled ? "" : "summary-disabled-cell"}`} key={`${groupIndex}-surcharge`}>{group.enabled ? formatYen(group.surchargeAmount) : null}</td>] : []),
                ])}
                <td className="numeric"><strong>{formatYen(row.total)}</strong></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th colSpan={2}>合計</th>
              {categoryColumns.flatMap((group, groupIndex) => [
                ...(group.basic ? [<th className="numeric" key={`${group.category}-basic`}>{formatYen(summaryRows.reduce((sum, row) => sum + (row.groups[groupIndex].basicAmount ?? 0), 0))}</th>] : []),
                ...group.custom.flatMap((item, itemIndex) => item.is_monthly_fixed
                  ? [<th className="numeric" key={`${item.asset_meter_sub_item_id}-amount`}>{formatYen(summaryRows.reduce((sum, row) => sum + row.groups[groupIndex].custom[itemIndex].amount, 0))}</th>]
                  : [<th className="numeric" key={`${item.asset_meter_sub_item_id}-usage`}>{formatUsage(summaryRows.reduce((sum, row) => sum + row.groups[groupIndex].custom[itemIndex].usage, 0), item.aggregation_decimal_digits)}</th>, <th className="numeric" key={`${item.asset_meter_sub_item_id}-amount`}>{formatYen(summaryRows.reduce((sum, row) => sum + row.groups[groupIndex].custom[itemIndex].amount, 0))}</th>]),
                ...(group.showTotal ? [
                  <th className="numeric" key={`${group.category}-total-usage`}>{formatUsage(summaryRows.reduce((sum, row) => sum + row.groups[groupIndex].totalUsage, 0), Math.max(0, ...group.custom.map((item) => item.aggregation_decimal_digits)))}</th>,
                  <th className="numeric" key={`${group.category}-total-amount`}>{formatYen(summaryRows.reduce((sum, row) => sum + row.groups[groupIndex].total, 0))}</th>,
                ] : []),
                ...(group.surcharge ? [<th className="numeric" key={`${group.category}-surcharge`}>{formatYen(summaryRows.reduce((sum, row) => sum + (row.groups[groupIndex].surchargeAmount ?? 0), 0))}</th>] : []),
              ])}
              <th className="numeric">{formatYen(summaryRows.reduce((sum, row) => sum + row.total, 0))}</th>
            </tr>
          </tfoot>
        </ResizableTable>
      </div>
    </section>
  );
}
function SettingsView({
  assetId,
  subItems,
  meters,
  tags,
  units,
  contracts,
  billingMonth,
  onChanged,
  onSubItemSettingsChanged,
  onNotice,
  onError,
  lockedSubItemId,
}: {
  assetId: string;
  subItems: MeterSubItem[];
  meters: MeterReadingRow[];
  tags: MeterTag[];
  units: MeterUnitOption[];
  contracts: ContractUnit[];
  billingMonth: string;
  onChanged: () => Promise<void>;
  onSubItemSettingsChanged: (subItem: MeterSubItem) => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
  lockedSubItemId?: string;
}) {
  const [subItemId, setSubItemId] = useState(lockedSubItemId ?? "");
  const [meterCode, setMeterCode] = useState("");
  const [unitId, setUnitId] = useState("");
  const [newMeterTagId, setNewMeterTagId] = useState("");
  const [saving, setSaving] = useState(false);
  const activeSubItem = subItems.find((item) => item.asset_meter_sub_item_id === subItemId) ?? subItems[0];
  const [inputMode, setInputMode] = useState<"usage" | "reading">(activeSubItem?.input_mode ?? "usage");
  const [readingDecimalDigits, setReadingDecimalDigits] = useState(
    activeSubItem ? getReadingDecimalDigits(activeSubItem.asset_meter_sub_item_id, activeSubItem.input_decimal_digits) : 1,
  );
  const [inputDecimalDigits, setInputDecimalDigits] = useState(activeSubItem?.input_decimal_digits ?? 1);
  const [aggregationDecimalDigits, setAggregationDecimalDigits] = useState(activeSubItem?.aggregation_decimal_digits ?? 1);
  const [usageRoundingMode, setUsageRoundingMode] = useState<"floor" | "round" | "ceil">(activeSubItem?.usage_rounding_mode ?? "round");
  const [orderedMeters, setOrderedMeters] = useState(meters);
  const commonAllocationSourceIds = new Set(orderedMeters.flatMap((meter) => meter.allocation_common_source_meter_ids));
  const settingsVisibleMeters = orderedMeters.filter((meter) => !commonAllocationSourceIds.has(meter.asset_meter_id));
  const [meterNameDrafts, setMeterNameDrafts] = useState<Record<string, string>>({});
  const [tagMeterId, setTagMeterId] = useState<string | null>(null);
  const [editingTagId, setEditingTagId] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState({ name: "", color: "#8eaadb" });
  const allowsRateSource = activeSubItem?.price_mode === "master_meter";
  const [adjustmentMeterId, setAdjustmentMeterId] = useState<string | null>(null);
  const [allocationMeterId, setAllocationMeterId] = useState<string | null>(null);
  const [allocationMethod, setAllocationMethod] = useState<"area" | "ratio" | "meter_usage">("area");
  const [allocationWeights, setAllocationWeights] = useState<Record<string, string>>({});
  const emptyAllocationSourceRow = () => ({ key: crypto.randomUUID(), sourceMeterId: "", name: "", tagId: "", unitId: "" });
  const [allocationSourceRows, setAllocationSourceRows] = useState<Array<{ key: string; sourceMeterId: string; name: string; tagId: string; unitId: string }>>([]);
  const [removedAllocationSourceMeterIds, setRemovedAllocationSourceMeterIds] = useState<string[]>([]);
  const [adjustmentDraft, setAdjustmentDraft] = useState({
    method: "ratio" as "ratio" | "percent",
    percent: "",
    numerator: "",
    denominator: "",
    note: "",
  });
  const monthStart = `${billingMonth}-01`;
  const monthEnd = new Date(Date.UTC(Number(billingMonth.slice(0, 4)), Number(billingMonth.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const activeContracts = contracts.filter((contract) =>
    (!contract.contract?.contract_start_date || contract.contract.contract_start_date <= monthEnd)
    && (!contract.contract?.contract_end_date || contract.contract.contract_end_date >= monthStart),
  );
  const logicalUnitKey = (unit: Pick<MeterUnitOption, "unit_id" | "billing_unit_id" | "floor_label" | "unit_code">) => unit.billing_unit_id ? `billing:${unit.billing_unit_id}` : `${unit.floor_label ?? ""}\u0000${unit.unit_code.trim().toLowerCase()}`;
  const activeContractByUnitKey = new Map<string, ContractUnit>();
  for (const contract of [...activeContracts].sort((left, right) =>
    (right.contract?.contract_start_date ?? "").localeCompare(left.contract?.contract_start_date ?? ""),
  )) {
    if (!contract.unit) continue;
    const key = logicalUnitKey(contract.unit);
    if (!activeContractByUnitKey.has(key)) activeContractByUnitKey.set(key, contract);
  }
  const uniqueUnitsByKey = new Map<string, MeterUnitOption>();
  for (const unit of units) {
    const key = logicalUnitKey(unit);
    const activeUnitId = activeContractByUnitKey.get(key)?.unit?.unit_id;
    if (!uniqueUnitsByKey.has(key) || unit.unit_id === activeUnitId) uniqueUnitsByKey.set(key, unit);
  }
  const sortedUnits = Array.from(uniqueUnitsByKey.values()).sort((left, right) =>
    floorSortOrder(left.floor_label) - floorSortOrder(right.floor_label)
    || (left.source_sort_order ?? Number.MAX_SAFE_INTEGER) - (right.source_sort_order ?? Number.MAX_SAFE_INTEGER)
    || left.unit_code.localeCompare(right.unit_code, "ja-JP", { numeric: true }),
  );
  const unitOptionLabel = (unit: MeterUnitOption) => {
    const tenantName = unit.tenant_name ?? activeContractByUnitKey.get(logicalUnitKey(unit))?.contract?.tenant?.tenant_name;
    const occupant = unit.unit_type === "equipment" || unit.unit_type === "other" ? "共用部" : tenantName || "空室";
    return `${formatFloor(unit.floor_label)} / ${unit.unit_name || unit.unit_code} / ${occupant}`;
  };
  const [draggingMeterId, setDraggingMeterId] = useState<string | null>(null);
  useEffect(() => {
    setOrderedMeters(meters);
    setMeterNameDrafts(Object.fromEntries(meters.map((meter) => [meter.asset_meter_id, meter.meter_code])));
  }, [meters]);
  useEffect(() => {
    if (!activeSubItem) return;
    setInputMode(activeSubItem.input_mode);
    setReadingDecimalDigits(getReadingDecimalDigits(activeSubItem.asset_meter_sub_item_id, activeSubItem.input_decimal_digits));
    setInputDecimalDigits(activeSubItem.input_decimal_digits);
    setAggregationDecimalDigits(activeSubItem.aggregation_decimal_digits);
    setUsageRoundingMode(activeSubItem.usage_rounding_mode);
  }, [activeSubItem]);
  useEffect(() => {
    if (lockedSubItemId) setSubItemId(lockedSubItemId);
    else if (!subItems.some((item) => item.asset_meter_sub_item_id === subItemId))
      setSubItemId(subItems[0]?.asset_meter_sub_item_id ?? "");
    if ((unitId === rateSourceUnitValue && !allowsRateSource) || (unitId !== rateSourceUnitValue && unitId !== "__multiple__" && !units.some((unit) => unit.unit_id === unitId)))
      setUnitId(sortedUnits[0]?.unit_id ?? "");
  }, [subItems, units, subItemId, unitId, lockedSubItemId, allowsRateSource]);

  const add = async () => {
    if (!subItemId || !unitId || !meterCode.trim()) return;
    if (unitId === "__multiple__") {
      setAllocationMeterId("__new_meter__");
      setAllocationMethod("area");
      setAllocationWeights({});
      setAllocationSourceRows([emptyAllocationSourceRow(), emptyAllocationSourceRow()]);
      return;
    }
    setSaving(true);
    onError("");
    try {
      const newMeterId = await createMeter(supabase!, assetId, subItemId, meterCode, unitId === rateSourceUnitValue ? null : unitId);
      if (newMeterTagId) await saveMeterTag(supabase!, newMeterId, newMeterTagId);
      const existingMeterIds = orderedMeters
        .filter((meter) => meter.subItem.asset_meter_sub_item_id === subItemId)
        .map((meter) => meter.asset_meter_id);
      await reorderMeters(
        supabase!,
        assetId,
        subItemId,
        unitId === rateSourceUnitValue ? [newMeterId, ...existingMeterIds] : [...existingMeterIds, newMeterId],
      );
      await onChanged();
      setMeterCode("");
      setNewMeterTagId("");
      onNotice("メーターを追加しました。");
    } catch (reason) {
      onError((reason as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const saveDisplaySettings = async () => {
    if (!activeSubItem) return;
    setSaving(true);
    onError("");
    try {
      await updateMeterSubItemDisplaySettings(supabase!, activeSubItem.asset_meter_sub_item_id, {
        inputMode,
        inputDecimalDigits,
        aggregationDecimalDigits,
        usageRoundingMode,
      });
      onSubItemSettingsChanged({
        ...activeSubItem,
        input_mode: inputMode,
        input_decimal_digits: inputDecimalDigits,
        aggregation_decimal_digits: aggregationDecimalDigits,
        usage_rounding_mode: usageRoundingMode,
      });
      localStorage.setItem(readingDigitsStorageKey(activeSubItem.asset_meter_sub_item_id), String(readingDecimalDigits));
      await onChanged();
      onNotice("桁数と小数点処理の設定を保存しました。");
    } catch (reason) {
      onError((reason as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const changeUnit = async (meterId: string, nextUnitId: string) => {
    if (nextUnitId === "__multiple__") {
      const meter = orderedMeters.find((row) => row.asset_meter_id === meterId);
      const currentAssignments = meter ? activeAssignments(meter) : [];
      setAllocationMeterId(meterId);
      const method = currentAssignments[0]?.allocation_method;
      setAllocationMethod(method === "ratio" || method === "meter_usage" ? method : "area");
      setAllocationWeights(Object.fromEntries(currentAssignments.map((row) => [row.unit_id, String(row.allocation_weight ?? 1)])));
      setRemovedAllocationSourceMeterIds([]);
      setAllocationSourceRows(currentAssignments[0]?.allocation_method === "meter_usage"
        ? [...currentAssignments.map((row) => {
            const source = orderedMeters.find((meter) => meter.asset_meter_id === row.allocation_source_meter_id);
            return { key: row.asset_meter_unit_assignment_id, sourceMeterId: row.allocation_source_meter_id ?? "", name: source?.meter_label ?? source?.meter_code ?? "", tagId: source?.tag?.asset_meter_tag_id ?? "", unitId: row.unit_id };
          }), ...(meter?.allocation_common_source_meter_ids.map((sourceId) => {
            const source = orderedMeters.find((candidate) => candidate.asset_meter_id === sourceId);
            return { key: `common:${sourceId}`, sourceMeterId: sourceId, name: source?.meter_label ?? source?.meter_code ?? "", tagId: "", unitId: "__common__" };
          }) ?? [])]
        : [emptyAllocationSourceRow(), emptyAllocationSourceRow()]);
      return;
    }
    if (nextUnitId === rateSourceUnitValue && !allowsRateSource) return;
    onError("");
    try {
      const assignedUnitId = nextUnitId === rateSourceUnitValue ? null : nextUnitId;
      await assignMeterUnit(supabase!, meterId, assignedUnitId, monthStart);
      const meter = orderedMeters.find((row) => row.asset_meter_id === meterId);
      const invalidRelationMeterIds = new Set<string>();
      if (meter?.parent_meter_id) {
        const parent = orderedMeters.find((row) => row.asset_meter_id === meter.parent_meter_id);
        if (!assignedUnitId || (parent && activeAssignment(parent)?.unit_id) !== assignedUnitId) invalidRelationMeterIds.add(meterId);
      }
      for (const child of orderedMeters.filter((row) => row.parent_meter_id === meterId)) {
        if (!assignedUnitId || activeAssignment(child)?.unit_id !== assignedUnitId) invalidRelationMeterIds.add(child.asset_meter_id);
      }
      await Promise.all(Array.from(invalidRelationMeterIds).map((id) => saveMeterParent(supabase!, id, null)));
      await onChanged();
      onNotice(invalidRelationMeterIds.size
        ? "メーターの区画を変更し、区画をまたぐ親子設定を解除しました。"
        : "メーターの区画を変更しました。");
    } catch (reason) {
      onError((reason as Error).message);
    }
  };
  const renameMeter = async (meter: MeterReadingRow) => {
    const nextName = (meterNameDrafts[meter.asset_meter_id] ?? "").trim();
    if (!nextName) {
      setMeterNameDrafts((current) => ({ ...current, [meter.asset_meter_id]: meter.meter_code }));
      onError("メーター名を入力してください。");
      return;
    }
    if (nextName === meter.meter_code) return;
    setSaving(true);
    onError("");
    try {
      await saveMeterName(supabase!, meter.asset_meter_id, nextName);
      setOrderedMeters((current) => current.map((row) => row.asset_meter_id === meter.asset_meter_id
        ? { ...row, meter_code: nextName }
        : row));
      await onChanged();
      onNotice("メーター名を保存しました。");
    } catch (reason) {
      setMeterNameDrafts((current) => ({ ...current, [meter.asset_meter_id]: meter.meter_code }));
      onError((reason as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const changeTag = async (meter: MeterReadingRow, value: string) => {
    if (value === "__new__") {
      setTagMeterId(meter.asset_meter_id);
      setTagDraft({ name: "", color: "#8eaadb" });
      return;
    }
    setSaving(true);
    onError("");
    try {
      await saveMeterTag(supabase!, meter.asset_meter_id, value || null);
      await onChanged();
      onNotice(value ? "メーターのタグを変更しました。" : "メーターのタグを解除しました。");
    } catch (reason) {
      onError((reason as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const changeNewMeterTag = (value: string) => {
    if (value === "__new__") {
      setTagMeterId("__new_meter__");
      setTagDraft({ name: "", color: "#8eaadb" });
      return;
    }
    setNewMeterTagId(value);
  };
  const openTagEditor = (tagId = tags[0]?.asset_meter_tag_id) => {
    const tag = tags.find((candidate) => candidate.asset_meter_tag_id === tagId);
    if (!tag) return;
    setEditingTagId(tagId);
    setTagDraft({ name: tag.tag_name, color: tag.color });
  };
  const closeTagModal = () => {
    if (saving) return;
    setTagMeterId(null);
    setEditingTagId(null);
  };
  const saveTagDraft = async () => {
    if ((!tagMeterId && !editingTagId) || !tagDraft.name.trim()) {
      onError("タグ名を入力してください。");
      return;
    }
    setSaving(true);
    onError("");
    try {
      const tag = editingTagId
        ? await updateMeterTag(supabase!, editingTagId, tagDraft.name, tagDraft.color)
        : await createMeterTag(supabase!, assetId, tagDraft.name, tagDraft.color);
      if (!editingTagId) {
        if (tagMeterId === "__new_meter__") setNewMeterTagId(tag.asset_meter_tag_id);
        else if (tagMeterId) await saveMeterTag(supabase!, tagMeterId, tag.asset_meter_tag_id);
      }
      await onChanged();
      setTagMeterId(null);
      setEditingTagId(null);
      onNotice(editingTagId ? `タグ「${tag.tag_name}」を更新しました。` : `タグ「${tag.tag_name}」を追加しました。`);
    } catch (reason) {
      onError((reason as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const changeParent = async (meterId: string, parentMeterId: string) => {
    onError("");
    const meter = orderedMeters.find((row) => row.asset_meter_id === meterId);
    const parent = orderedMeters.find((row) => row.asset_meter_id === parentMeterId);
    if (parentMeterId && (meter && activeAssignment(meter)?.unit_id) !== (parent && activeAssignment(parent)?.unit_id)) {
      onError("親メーターは同じ設置区画のメーターから選択してください。");
      return;
    }
    try {
      await saveMeterParent(supabase!, meterId, parentMeterId || null);
      setOrderedMeters((current) => current.map((meter) =>
        meter.asset_meter_id === meterId
          ? { ...meter, parent_meter_id: parentMeterId || null }
          : meter,
      ));
      await onChanged();
      onNotice(parentMeterId ? "親メーターを設定しました。" : "親メーター設定を解除しました。");
    } catch (reason) {
      onError((reason as Error).message);
    }
  };
  const remove = async (meter: MeterReadingRow) => {
    const isAllocationParent = isMeterUsageAllocationParent(meter);
    if (!window.confirm(`メーター「${meter.meter_code}」${isAllocationParent ? "と紐づく按分用メーターを削除しますか？" : "を削除しますか？"}`)) return;
    setSaving(true);
    onError("");
    try {
      const sourceMeterIds = isAllocationParent
        ? await loadAllocationSourceMeterIds(supabase!, meter.asset_meter_id)
        : [];
      await deleteMeter(supabase!, meter.asset_meter_id);
      await Promise.all(sourceMeterIds.map((sourceMeterId) => deleteMeter(supabase!, sourceMeterId)));
      await onChanged();
      onNotice(isAllocationParent ? "メーターと紐づく按分用メーターを削除しました。" : "メーターを削除しました。");
    } catch (reason) {
      onError((reason as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const moveMeter = async (targetMeterId: string) => {
    if (!draggingMeterId || draggingMeterId === targetMeterId || !lockedSubItemId) return;
    const draggedMeter = orderedMeters.find((meter) => meter.asset_meter_id === draggingMeterId);
    const targetMeter = orderedMeters.find((meter) => meter.asset_meter_id === targetMeterId);
    const next = [...orderedMeters];
    const sourceIndex = next.findIndex((meter) => meter.asset_meter_id === draggingMeterId);
    const targetIndex = next.findIndex((meter) => meter.asset_meter_id === targetMeterId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const [moved] = next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, moved);
    setOrderedMeters(next);
    setDraggingMeterId(null);
    onError("");
    try {
      await reorderMeters(supabase!, assetId, lockedSubItemId, next.map((meter) => meter.asset_meter_id));
      await onChanged();
      onNotice("メーターの並び順を保存しました。");
    } catch (reason) {
      setOrderedMeters(meters);
      onError((reason as Error).message);
    }
  };
  const activeAssignment = (meter: MeterReadingRow) => {
    return activeAssignments(meter)[0];
  };
  const activeAssignments = (meter: MeterReadingRow) => {
    return [...meter.assignments]
      .filter(
        (row) =>
          row.effective_from <= monthEnd &&
          (!row.effective_to || row.effective_to >= monthStart),
      )
      .sort((a, b) => b.effective_from.localeCompare(a.effective_from) || a.unit_id.localeCompare(b.unit_id));
  };
  const saveAllocations = async () => {
    if (!allocationMeterId) return;
    const selected = sortedUnits.filter((unit) => allocationWeights[unit.unit_id] !== undefined);
    const sourceRows = allocationSourceRows.filter((row) => row.name.trim() || row.unitId);
    const allocationCount = allocationMethod === "meter_usage" ? sourceRows.length : selected.length;
    if (allocationCount < 2) {
      onError("複数区画を2区画以上選択してください。");
      return;
    }
    if (allocationMethod === "area" && selected.some((unit) => Number(unit.rentable_area_sqm) <= 0)) {
      onError("面積未登録の区画は面積按分に使用できません。");
      return;
    }
    if (allocationMethod === "ratio" && selected.some((unit) => !/^\d+$/.test(allocationWeights[unit.unit_id]) || Number(allocationWeights[unit.unit_id]) < 1)) {
      onError("比率は1以上の自然数で入力してください。");
      return;
    }
    if (allocationMethod === "meter_usage" && sourceRows.some((row) => !row.name.trim() || !row.unitId)) {
      onError("すべての按分用メーターに按分名・紐づけ先を設定してください。");
      return;
    }
    if (allocationMethod === "meter_usage" && new Set(sourceRows.map((row) => row.name.trim())).size !== sourceRows.length) {
      onError("同じ按分用メーター名を複数の区画には指定できません。");
      return;
    }
    if (allocationMethod === "meter_usage" && new Set(sourceRows.map((row) => row.unitId)).size !== sourceRows.length) {
      onError("同じ紐づけ先を複数の按分用メーターには指定できません。");
      return;
    }
    const allocations = allocationMethod === "meter_usage"
      ? sourceRows.map((row) => ({ unitId: row.unitId, weight: 1, sourceMeterId: row.sourceMeterId || null, sourceMeterName: row.name, sourceMeterLabel: row.name, sourceMeterTagId: row.unitId === "__common__" ? null : row.tagId || null }))
      : selected.map((unit) => ({
          unitId: unit.unit_id,
          weight: allocationMethod === "area" ? Number(unit.rentable_area_sqm) : Number(allocationWeights[unit.unit_id]),
          sourceMeterId: null,
          sourceMeterName: null,
        }));
    setSaving(true);
    onError("");
    try {
      let targetMeterId = allocationMeterId;
      if (allocationMeterId === "__new_meter__") {
        targetMeterId = await createMeter(supabase!, assetId, subItemId, meterCode, allocations[0].unitId);
        if (newMeterTagId) await saveMeterTag(supabase!, targetMeterId, newMeterTagId);
      }
      await assignMeterUnits(supabase!, targetMeterId, allocationMethod, allocations, monthStart);
      await Promise.all(removedAllocationSourceMeterIds.map((sourceMeterId) => deleteMeter(supabase!, sourceMeterId)));
      setRemovedAllocationSourceMeterIds([]);
      if (allocationMeterId !== "__new_meter__" && allocationMethod === "meter_usage") {
        const linkedSourceIds = await loadAllocationSourceMeterIds(supabase!, targetMeterId);
        const sourceOrder = [
          ...sourceRows.map((row) => row.sourceMeterId).filter((sourceMeterId) => linkedSourceIds.includes(sourceMeterId)),
          ...linkedSourceIds.filter((sourceMeterId) => !sourceRows.some((row) => row.sourceMeterId === sourceMeterId)),
        ];
        const meterIds = orderedMeters
          .filter((meter) => meter.subItem.asset_meter_sub_item_id === subItemId)
          .map((meter) => meter.asset_meter_id);
        const sourcePositions = meterIds
          .map((meterId, index) => sourceOrder.includes(meterId) ? index : -1)
          .filter((index) => index >= 0);
        if (sourcePositions.length > 1) {
          const reorderedMeterIds = [...meterIds];
          sourcePositions.forEach((position, index) => { reorderedMeterIds[position] = sourceOrder[index]; });
          await reorderMeters(supabase!, assetId, subItemId, reorderedMeterIds);
        }
      }
      if (allocationMeterId === "__new_meter__") {
        const sourceMeterIds = allocationMethod === "meter_usage"
          ? await loadAllocationSourceMeterIds(supabase!, targetMeterId)
          : [];
        const existingMeterIds = orderedMeters
          .filter((meter) => meter.subItem.asset_meter_sub_item_id === subItemId)
          .map((meter) => meter.asset_meter_id);
        await reorderMeters(supabase!, assetId, subItemId, [...existingMeterIds, targetMeterId, ...sourceMeterIds]);
        setMeterCode("");
        setNewMeterTagId("");
      }
      await onChanged();
      setAllocationMeterId(null);
      onNotice(allocationMeterId === "__new_meter__" ? "複数区画を設定してメーターを追加しました。" : "複数区画と按分方法を保存しました。");
    } catch (reason) {
      onError((reason as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const wouldCreateParentCycle = (meterId: string, candidateId: string) => {
    let currentId: string | null = candidateId;
    const visited = new Set<string>();
    while (currentId && !visited.has(currentId)) {
      if (currentId === meterId) return true;
      visited.add(currentId);
      currentId = orderedMeters.find((row) => row.asset_meter_id === currentId)?.parent_meter_id ?? null;
    }
    return false;
  };
  const openAdjustment = (meter: MeterReadingRow) => {
    setAdjustmentMeterId(meter.asset_meter_id);
    setAdjustmentDraft({
      method: meter.billing_adjustment_method ?? "ratio",
      percent: meter.billing_adjustment_percent == null ? "" : String(meter.billing_adjustment_percent),
      numerator: meter.billing_adjustment_numerator == null ? "" : String(meter.billing_adjustment_numerator),
      denominator: meter.billing_adjustment_denominator == null ? "" : String(meter.billing_adjustment_denominator),
      note: meter.billing_adjustment_note ?? "",
    });
  };
  const saveAdjustment = async () => {
    if (!adjustmentMeterId) return;
    const percent = adjustmentDraft.percent === "" ? null : Number(adjustmentDraft.percent);
    const numerator = adjustmentDraft.numerator === "" ? null : Number(adjustmentDraft.numerator);
    const denominator = adjustmentDraft.denominator === "" ? null : Number(adjustmentDraft.denominator);
    if (adjustmentDraft.method === "percent" && (percent == null || !Number.isFinite(percent) || percent < 0)) {
      onError("0以上の割合（％）を入力してください。");
      return;
    }
    if (adjustmentDraft.method === "ratio" && (
      numerator == null || !Number.isFinite(numerator) || numerator < 0 ||
      denominator == null || !Number.isFinite(denominator) || denominator <= 0
    )) {
      onError("割合計算の分子は0以上、分母は0より大きい値を入力してください。");
      return;
    }
    setSaving(true);
    onError("");
    try {
      await saveMeterBillingAdjustment(supabase!, adjustmentMeterId, {
        enabled: true,
        method: adjustmentDraft.method,
        percent,
        numerator,
        denominator,
        note: adjustmentDraft.note,
      });
      await onChanged();
      setAdjustmentMeterId(null);
      onNotice("メーターの補正設定を保存しました。");
    } catch (reason) {
      onError((reason as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const disableAdjustment = async (meter: MeterReadingRow) => {
    setSaving(true);
    onError("");
    try {
      await saveMeterBillingAdjustment(supabase!, meter.asset_meter_id, {
        enabled: false,
        method: meter.billing_adjustment_method ?? "ratio",
        percent: meter.billing_adjustment_percent,
        numerator: meter.billing_adjustment_numerator,
        denominator: meter.billing_adjustment_denominator,
        note: meter.billing_adjustment_note ?? "",
      });
      await onChanged();
      onNotice("メーターの補正を無効にしました。");
    } catch (reason) {
      onError((reason as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
    <section className="meter-settings">
      <div className="meter-settings-toolbar">
        <strong>メーター設定</strong>
        <button type="button" disabled={saving || tags.length === 0} onClick={() => openTagEditor()}>タグ編集</button>
      </div>
      <div className="meter-display-settings">
        <label>データ入力方法<select value={inputMode} onChange={(event) => setInputMode(event.target.value as "usage" | "reading")}><option value="reading">読取値を入力</option><option value="usage">使用量を入力</option></select></label>
        <label className={inputMode === "usage" ? "disabled-setting" : ""}>検針値入力表示桁数<input type="number" min={0} max={3} step={1} value={readingDecimalDigits} disabled={inputMode === "usage"} onChange={(event) => setReadingDecimalDigits(Math.min(3, Math.max(0, Number(event.target.value))))} /></label>
        <label>使用量入力桁数<input type="number" min={0} max={3} step={1} value={inputDecimalDigits} onChange={(event) => setInputDecimalDigits(Math.min(3, Math.max(0, Number(event.target.value))))} /></label>
        <label>使用量集計桁数<input type="number" min={0} max={3} step={1} value={aggregationDecimalDigits} onChange={(event) => setAggregationDecimalDigits(Math.min(3, Math.max(0, Number(event.target.value))))} /></label>
        <label>使用量の小数点処理<select value={usageRoundingMode} onChange={(event) => setUsageRoundingMode(event.target.value as "floor" | "round" | "ceil")}><option value="ceil">切り上げ</option><option value="round">四捨五入</option><option value="floor">切り捨て</option></select></label>
        <button type="button" className="primary compact" disabled={saving} onClick={() => void saveDisplaySettings()}>{saving ? "保存中…" : "設定を保存"}</button>
      </div>
      <div className="table-wrap">
        <ResizableTable className="workspace-data-table meter-settings-table" storageKey="meter-settings-common" columnGroups={["drag", "category", "sub-item", "tag", "meter", "unit", "parent-meter", "adjustment", "action"]}>
          <thead><tr><ColumnHeader columnGroup="drag" /><ColumnHeader columnGroup="category">分類</ColumnHeader><ColumnHeader columnGroup="sub-item">小分類</ColumnHeader><ColumnHeader columnGroup="tag">タグ</ColumnHeader><ColumnHeader columnGroup="meter">メーター名</ColumnHeader><ColumnHeader columnGroup="unit">設置区画</ColumnHeader><ColumnHeader columnGroup="parent-meter">親メーター</ColumnHeader><ColumnHeader columnGroup="adjustment">補正設定</ColumnHeader><ColumnHeader columnGroup="action" /></tr></thead>
          <tbody>
            {settingsVisibleMeters.map((meter) => {
              const assignment = activeAssignment(meter);
              const allocationParentMeter = meter.is_allocation_source
                ? orderedMeters.find((candidate) =>
                    candidate.assignments.some((row) => row.allocation_source_meter_id === meter.asset_meter_id) ||
                    candidate.allocation_common_source_meter_ids.includes(meter.asset_meter_id),
                  )
                : undefined;
              return (
                <tr
                  key={meter.asset_meter_id}
                  className={draggingMeterId === meter.asset_meter_id ? "is-dragging" : ""}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => void moveMeter(meter.asset_meter_id)}
                >
                  <td className="drag-cell">
                    <span
                      className="drag-handle"
                      draggable
                      title="ドラッグして並べ替え"
                      onDragStart={() => setDraggingMeterId(meter.asset_meter_id)}
                      onDragEnd={() => setDraggingMeterId(null)}
                    >⠿</span>
                  </td>
                  <td><span className={`utility-label utility-${meter.subItem.category}`}>{labels[meter.subItem.category]}</span></td>
                  <td>{meter.subItem.sub_item_name}</td>
                  <td>
                    <select className="meter-tag-select" value={meter.tag?.asset_meter_tag_id ?? ""} style={meter.tag ? { backgroundColor: meter.tag.color, color: readableTextColor(meter.tag.color) } : undefined} disabled={saving || meter.is_allocation_source} title={meter.is_allocation_source ? "按分用メーターでは編集できません" : undefined} onChange={(event) => void changeTag(meter, event.target.value)}>
                      <option value="">—</option>
                      {tags.map((tag) => <option key={tag.asset_meter_tag_id} value={tag.asset_meter_tag_id}>{tag.tag_name}</option>)}
                      <option value="__new__">＋ 新規タグを追加</option>
                    </select>
                  </td>
                  {meter.is_allocation_source ? (
                    <>
                      <td>
                        <div className="meter-name-editor">
                          <input aria-label={`${meter.meter_label ?? meter.meter_code}の按分名`} value={meter.meter_label ?? meter.meter_code} disabled />
                        </div>
                      </td>
                      <td colSpan={3} className="allocation-source-settings-note">（メーター「{allocationParentMeter?.meter_code ?? "未設定"}」の使用量から按分）</td>
                    </>
                  ) : <>
                  <td>
                    <div className="meter-name-editor">
                      {meter.parent_meter_id && <span className="child-meter-mark">↳ 子</span>}
                      <input
                        aria-label={`${meter.meter_code}のメーター名`}
                        value={meterNameDrafts[meter.asset_meter_id] ?? meter.meter_code}
                        disabled={saving}
                        onChange={(event) => setMeterNameDrafts((current) => ({ ...current, [meter.asset_meter_id]: event.target.value }))}
                        onBlur={() => void renameMeter(meter)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                          if (event.key === "Escape") {
                            setMeterNameDrafts((current) => ({ ...current, [meter.asset_meter_id]: meter.meter_code }));
                            event.currentTarget.blur();
                          }
                        }}
                      />
                    </div>
                  </td>
                  <td>
                    <div className="unit-assignment-control">
                      <select disabled={meter.is_allocation_source} title={meter.is_allocation_source ? "按分設定から変更してください" : undefined} value={meter.is_rate_source && allowsRateSource ? rateSourceUnitValue : activeAssignments(meter).length > 1 ? "__multiple__" : assignment?.unit_id ?? ""} onChange={(event) => void changeUnit(meter.asset_meter_id, event.target.value)}>
                        {allowsRateSource && <option value={rateSourceUnitValue}>大元メーター</option>}
                        <option value="__multiple__">複数区画を選択</option>
                        <option value="" disabled>区画を選択</option>
                        {sortedUnits.map((unit) => (
                          <option key={unit.unit_id} value={unit.unit_id}>
                            {unitOptionLabel(unit)}
                          </option>
                        ))}
                      </select>
                    </div>
                  </td>
                  <td>
                    {activeAssignments(meter).length > 1 && !meter.is_allocation_source ? (
                      <div className="allocation-settings-cell"><button type="button" onClick={() => void changeUnit(meter.asset_meter_id, "__multiple__")}>按分設定</button></div>
                    ) : inputMode === "reading" && !meter.is_rate_source && activeAssignments(meter).length <= 1 ? (
                      <select disabled={meter.is_allocation_source} title={meter.is_allocation_source ? "按分用メーターでは編集できません" : undefined} value={meter.parent_meter_id ?? ""} onChange={(event) => void changeParent(meter.asset_meter_id, event.target.value)}>
                        <option value="">なし（親として集計）</option>
                        {orderedMeters
                          .filter((candidate) =>
                            !candidate.is_rate_source &&
                            candidate.asset_meter_id !== meter.asset_meter_id &&
                            activeAssignment(candidate)?.unit_id != null &&
                            activeAssignment(candidate)?.unit_id === assignment?.unit_id &&
                            !wouldCreateParentCycle(meter.asset_meter_id, candidate.asset_meter_id)
                          )
                          .map((candidate) => (
                            <option key={candidate.asset_meter_id} value={candidate.asset_meter_id}>
                              {candidate.meter_code} / {candidate.assignments[0]?.unit?.unit_name || candidate.assignments[0]?.unit?.unit_code || "区画未設定"}
                            </option>
                          ))}
                      </select>
                    ) : null}
                  </td>
                  <td>
                    <div className="meter-adjustment-control">
                      <input
                        type="checkbox"
                        aria-label={`${meter.meter_code}の使用量補正`}
                        checked={meter.billing_adjustment_enabled}
                        disabled={saving || meter.is_allocation_source}
                        title={meter.is_allocation_source ? "按分用メーターでは編集できません" : undefined}
                        onChange={(event) => event.target.checked ? openAdjustment(meter) : void disableAdjustment(meter)}
                      />
                      {meter.billing_adjustment_enabled && (
                        <button type="button" className="meter-adjustment-status" disabled={meter.is_allocation_source} onClick={() => openAdjustment(meter)}>設定済み</button>
                      )}
                    </div>
                  </td>
                  </>}
                  <td>{!meter.is_allocation_source && <button className="danger-text" onClick={() => void remove(meter)}>削除</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </ResizableTable>
      </div>
      <div className={`meter-add-form ${lockedSubItemId ? "is-locked" : ""}`}>
        {!lockedSubItemId && <label>
          小分類
          <select value={subItemId} onChange={(event) => setSubItemId(event.target.value)}>
            {subItems.map((item) => (
              <option key={item.asset_meter_sub_item_id} value={item.asset_meter_sub_item_id}>
                {labels[item.category]} / {item.sub_item_name}
              </option>
            ))}
          </select>
        </label>}
        <label>タグ<select value={newMeterTagId} disabled={saving} onChange={(event) => changeNewMeterTag(event.target.value)}><option value="">—</option>{tags.map((tag) => <option key={tag.asset_meter_tag_id} value={tag.asset_meter_tag_id}>{tag.tag_name}</option>)}<option value="__new__">＋ 新規タグを追加</option></select></label>
        <label>メーター番号<input value={meterCode} onChange={(event) => setMeterCode(event.target.value)} /></label>
        <label>区画<select value={unitId} onChange={(event) => setUnitId(event.target.value)}>{allowsRateSource && <option value={rateSourceUnitValue}>大元メーター</option>}<option value="__multiple__">複数区画を選択</option>{sortedUnits.map((unit) => <option key={unit.unit_id} value={unit.unit_id}>{unitOptionLabel(unit)}</option>)}</select></label>
        <button className="primary compact" disabled={saving || !subItemId || !unitId || !meterCode.trim()} onClick={() => void add()}>{saving ? "追加中…" : "追加"}</button>
      </div>
    </section>
    {(tagMeterId || editingTagId) && (
      <div className="rollover-modal-backdrop" role="presentation" onMouseDown={closeTagModal}>
        <section className="rollover-modal meter-tag-modal" role="dialog" aria-modal="true" aria-labelledby="meter-tag-title" onMouseDown={(event) => event.stopPropagation()}>
          <header>
            <div><span>メーター設定</span><h2 id="meter-tag-title">{editingTagId ? "タグを編集" : "新規タグを追加"}</h2></div>
            <button type="button" className="rollover-modal-close" aria-label="閉じる" disabled={saving} onClick={closeTagModal}>×</button>
          </header>
          <div className="meter-tag-form">
            {editingTagId && <label>編集するタグ<select value={editingTagId} onChange={(event) => openTagEditor(event.target.value)}>{tags.map((tag) => <option key={tag.asset_meter_tag_id} value={tag.asset_meter_tag_id}>{tag.tag_name}</option>)}</select></label>}
            <label>タグ名<input autoFocus maxLength={40} value={tagDraft.name} placeholder="例：動力" onChange={(event) => setTagDraft((current) => ({ ...current, name: event.target.value }))} /></label>
            <fieldset className="meter-tag-color-field"><legend>色</legend><div className="meter-tag-palette" role="radiogroup" aria-label="タグの色">{meterTagPalette.map((color, index) => <button key={`${color}-${index}`} type="button" role="radio" aria-checked={tagDraft.color === color} aria-label={`色 ${color}`} className={tagDraft.color === color ? "selected" : ""} style={{ backgroundColor: color }} onClick={() => setTagDraft((current) => ({ ...current, color }))} />)}</div><span className="meter-tag-preview" style={{ backgroundColor: tagDraft.color, color: readableTextColor(tagDraft.color) }}>{tagDraft.name.trim() || "タグ"}</span></fieldset>
          </div>
          <footer>
            <button type="button" className="primary" disabled={saving || !tagDraft.name.trim()} onClick={() => void saveTagDraft()}>{saving ? "保存中…" : editingTagId ? "変更を保存" : "追加して選択"}</button>
          </footer>
        </section>
      </div>
    )}
    {allocationMeterId && (
      <div className="rollover-modal-backdrop" role="presentation" onMouseDown={() => !saving && setAllocationMeterId(null)}>
        <section className="rollover-modal meter-allocation-modal" role="dialog" aria-modal="true" aria-labelledby="meter-allocation-title" onMouseDown={(event) => event.stopPropagation()}>
          <header>
            <div><span>メーター設定</span><h2 id="meter-allocation-title">複数区画への按分設定</h2></div>
            <button type="button" className="rollover-modal-close" aria-label="閉じる" disabled={saving} onClick={() => setAllocationMeterId(null)}>×</button>
          </header>
          <div className="meter-allocation-form">
            <label>按分方法<select value={allocationMethod} onChange={(event) => { const method = event.target.value as "area" | "ratio" | "meter_usage"; setAllocationMethod(method); if (method === "meter_usage" && allocationSourceRows.length < 2) setAllocationSourceRows([emptyAllocationSourceRow(), emptyAllocationSourceRow()]); }}><option value="area">面積（㎡）で按分</option><option value="ratio">任意の比率で按分</option><option value="meter_usage">按分用メーターの使用量で按分</option></select></label>
            {allocationMethod === "meter_usage" ? <>
              <div className="meter-allocation-list meter-source-list">
                <div className="meter-source-head"><span>按分名</span><span>タグ</span><span>紐づけ先（区画・共用部）</span><span /></div>
                {allocationSourceRows.map((row, rowIndex) => <div className="meter-source-row" key={row.key}>
                  <input type="text" maxLength={80} value={row.name} placeholder="例：按分用①" onChange={(event) => setAllocationSourceRows((current) => current.map((candidate) => candidate.key === row.key ? { ...candidate, name: event.target.value } : candidate))} />
                  <select disabled={row.unitId === "__common__"} value={row.tagId} onChange={(event) => setAllocationSourceRows((current) => current.map((candidate) => candidate.key === row.key ? { ...candidate, tagId: event.target.value } : candidate))}><option value="">—</option>{tags.map((tag) => <option key={tag.asset_meter_tag_id} value={tag.asset_meter_tag_id}>{tag.tag_name}</option>)}</select>
                  <select value={row.unitId} onChange={(event) => setAllocationSourceRows((current) => current.map((candidate) => candidate.key === row.key ? { ...candidate, unitId: event.target.value, ...(event.target.value === "__common__" ? { tagId: "" } : {}) } : candidate))}><option value="">選択してください</option><option value="__common__">共用部</option>{sortedUnits.map((unit) => <option key={unit.unit_id} value={unit.unit_id}>{unitOptionLabel(unit)}</option>)}</select>
                  <span className="meter-source-actions">
                    <button type="button" disabled={rowIndex === 0} aria-label={`${row.name || "按分用メーター"}を上へ移動`} onClick={() => setAllocationSourceRows((current) => { const next = [...current]; [next[rowIndex - 1], next[rowIndex]] = [next[rowIndex], next[rowIndex - 1]]; return next; })}>↑</button>
                    <button type="button" disabled={rowIndex === allocationSourceRows.length - 1} aria-label={`${row.name || "按分用メーター"}を下へ移動`} onClick={() => setAllocationSourceRows((current) => { const next = [...current]; [next[rowIndex], next[rowIndex + 1]] = [next[rowIndex + 1], next[rowIndex]]; return next; })}>↓</button>
                    <button type="button" className="danger-text" disabled={allocationSourceRows.length <= 2} onClick={() => {
                      if (row.sourceMeterId) setRemovedAllocationSourceMeterIds((current) => [...current, row.sourceMeterId]);
                      setAllocationSourceRows((current) => current.filter((candidate) => candidate.key !== row.key));
                    }}>削除</button>
                  </span>
                </div>)}
              </div>
              <button type="button" className="meter-source-add" onClick={() => setAllocationSourceRows((current) => [...current, emptyAllocationSourceRow()])}>＋ メーターを追加</button>
            </> : <div className="meter-allocation-list">
              <div className="meter-allocation-head"><span>選択</span><span>区画</span><span>{allocationMethod === "area" ? "面積（㎡）" : "比率"}</span></div>
              {sortedUnits.map((unit) => {
                const selected = allocationWeights[unit.unit_id] !== undefined;
                return <div className="meter-allocation-row" key={unit.unit_id}>
                  <input type="checkbox" aria-label={`${unitOptionLabel(unit)}を選択`} checked={selected} onChange={(event) => setAllocationWeights((current) => { const next = { ...current }; if (event.target.checked) next[unit.unit_id] = allocationMethod === "area" ? String(unit.rentable_area_sqm ?? "") : "1"; else delete next[unit.unit_id]; return next; })} />
                  <span>{unitOptionLabel(unit)}</span>
                  {allocationMethod === "area" ? <strong className={Number(unit.rentable_area_sqm) > 0 ? "" : "allocation-missing"}>{unit.rentable_area_sqm == null ? "未登録" : Number(unit.rentable_area_sqm).toLocaleString("ja-JP")}</strong> : <input type="number" min="1" step="1" disabled={!selected} value={selected ? allocationWeights[unit.unit_id] : ""} onChange={(event) => setAllocationWeights((current) => ({ ...current, [unit.unit_id]: event.target.value }))} />}
                </div>;
              })}
            </div>}
            <p>{allocationMethod === "meter_usage" ? "各区画に対応する按分用メーターの当月使用量合計を100%として、対象メーターの使用量と金額を按分します。" : `選択した区画の${allocationMethod === "area" ? "面積合計" : "比率合計"}を100%として使用量と金額を按分します。端数は最後の区画へ加算します。`}</p>
          </div>
          <footer><button type="button" className="primary" disabled={saving} onClick={() => void saveAllocations()}>{saving ? "保存中…" : "按分設定を保存"}</button></footer>
        </section>
      </div>
    )}
    {adjustmentMeterId && (
      <div className="rollover-modal-backdrop" role="presentation" onMouseDown={() => !saving && setAdjustmentMeterId(null)}>
        <section className="rollover-modal meter-adjustment-modal" role="dialog" aria-modal="true" aria-labelledby="meter-adjustment-title" onMouseDown={(event) => event.stopPropagation()}>
          <header>
            <div><span>メーター設定</span><h2 id="meter-adjustment-title">使用量の補正設定</h2></div>
            <button type="button" className="rollover-modal-close" aria-label="閉じる" disabled={saving} onClick={() => setAdjustmentMeterId(null)}>×</button>
          </header>
          <p>親子メーターの集計後の使用量に、この補正を適用します。</p>
          <div className="meter-adjustment-form">
            <label>補正方法
              <select value={adjustmentDraft.method} onChange={(event) => setAdjustmentDraft((current) => ({ ...current, method: event.target.value as "ratio" | "percent" }))}>
                <option value="ratio">割合計算</option>
                <option value="percent">％計算</option>
              </select>
            </label>
            {adjustmentDraft.method === "percent" ? (
              <label>割合（％）<input type="number" min="0" step="0.01" value={adjustmentDraft.percent} onChange={(event) => setAdjustmentDraft((current) => ({ ...current, percent: event.target.value }))} /></label>
            ) : (
              <div className="meter-adjustment-ratio">
                <label>分子<input type="number" min="0" step="0.01" value={adjustmentDraft.numerator} onChange={(event) => setAdjustmentDraft((current) => ({ ...current, numerator: event.target.value }))} /></label>
                <span>／</span>
                <label>分母<input type="number" min="0.01" step="0.01" value={adjustmentDraft.denominator} onChange={(event) => setAdjustmentDraft((current) => ({ ...current, denominator: event.target.value }))} /></label>
              </div>
            )}
            <label>備考<textarea rows={4} value={adjustmentDraft.note} onChange={(event) => setAdjustmentDraft((current) => ({ ...current, note: event.target.value }))} /></label>
          </div>
          <footer>
            <button type="button" className="primary" disabled={saving} onClick={() => void saveAdjustment()}>{saving ? "保存中…" : "補正を有効にして保存"}</button>
          </footer>
        </section>
      </div>
    )}
    </>
  );
}
function BasicChargeTable({
  contracts,
  category,
  monthlyFixedItems,
  monthlyFixedCharges,
  confirmed,
  onMonthlyFixedChange,
}: {
  contracts: ContractUnit[];
  category: UtilityCategory;
  monthlyFixedItems: MeterSubItem[];
  monthlyFixedCharges: Record<string, number>;
  confirmed: boolean;
  onMonthlyFixedChange: (contractId: string | null, tenantId: string, leaseContractUnitId: string, subItemId: string, amount: number) => void;
}) {
  const eligibleContractsInBillingOrder = contracts.filter((row) =>
    ["office", "warehouse", "storage"].includes(row.unit?.unit_type ?? ""),
  );
  const tenantKey = (contract: ContractUnit) => contract.contract?.tenant_id ?? billingGroupKey(contract);
  const tenantOrder = new Map<string, number>();
  eligibleContractsInBillingOrder.forEach((contract) => {
    const key = tenantKey(contract);
    if (!tenantOrder.has(key)) tenantOrder.set(key, tenantOrder.size);
  });
  const compareText = (left: string | null | undefined, right: string | null | undefined) =>
    (left ?? "").localeCompare(right ?? "", "ja-JP", { numeric: true });
  const eligibleContracts = [...eligibleContractsInBillingOrder].sort((left, right) =>
    (tenantOrder.get(tenantKey(left)) ?? Number.MAX_SAFE_INTEGER) -
      (tenantOrder.get(tenantKey(right)) ?? Number.MAX_SAFE_INTEGER) ||
    compareText(left.unit?.floor_label, right.unit?.floor_label) ||
    compareText(
      left.unit?.unit_name || left.unit?.unit_code,
      right.unit?.unit_name || right.unit?.unit_code,
    ),
  );
  const tenantContractsFor = (contract: ContractUnit) =>
    eligibleContracts.filter((row) => tenantKey(row) === tenantKey(contract));
  const basicAmountFor = (contract: ContractUnit) =>
    Number(contract.basics.find((item) => item.category === category)?.amount ?? 0);
  const tenantBasicAmountFor = (contract: ContractUnit) =>
    tenantContractsFor(contract).reduce((sum, row) => sum + basicAmountFor(row), 0);
  const fixedAmountFor = (contract: ContractUnit, item: MeterSubItem) =>
    monthlyFixedCharges[`${contract.lease_contract_unit_id}|${item.asset_meter_sub_item_id}`];
  const tenantFixedAmountFor = (contract: ContractUnit, item: MeterSubItem) =>
    tenantContractsFor(contract).reduce((sum, row) => sum + (fixedAmountFor(row, item) ?? 0), 0);
  const headers = [
    "テナント",
    "階数",
    "区画",
    "基本料（区画ごと）",
    "基本料（テナント合計）",
    ...monthlyFixedItems.flatMap((item) => [
      `${item.sub_item_name}（区画ごと）`,
      `${item.sub_item_name}（テナント合計）`,
    ]),
  ];

  return (
    <DataTable
      headers={headers}
      storageKey="basic-charge"
      columnGroups={headers.map((_, index) => {
        if (index === 0) return "tenant";
        if (index === 1) return "floor";
        if (index === 2) return "unit";
        return "amount";
      })}
      groupedHeaders={{
        leadingCount: 3,
        groups: ["基本料", ...monthlyFixedItems.map((item) => item.sub_item_name)],
        subheaders: ["区画ごと", "テナント合計", ...monthlyFixedItems.flatMap(() => ["区画ごと", "テナント合計"])],
      }}
      rows={eligibleContracts.map((contract, index) => {
        const firstInTenant = index === 0 || tenantKey(eligibleContracts[index - 1]) !== tenantKey(contract);
        const tenantRowSpan = tenantContractsFor(contract).length;
        const floor = contract.unit?.floor_label ?? "";
        const firstOnFloor = firstInTenant || (eligibleContracts[index - 1]?.unit?.floor_label ?? "") !== floor;
        let floorRowSpan = 1;
        while (
          index + floorRowSpan < eligibleContracts.length &&
          tenantKey(eligibleContracts[index + floorRowSpan]) === tenantKey(contract) &&
          (eligibleContracts[index + floorRowSpan].unit?.floor_label ?? "") === floor
        ) {
          floorRowSpan += 1;
        }
        return [
          firstInTenant
            ? mergedTableCell(
              <TenantNameWithRounding
                name={billingGroupTenantName(contract)}
                contracts={tenantContractsFor(contract)}
              />,
              tenantRowSpan,
            )
            : skippedTableCell(),
          firstOnFloor
            ? mergedTableCell(formatFloor(contract.unit?.floor_label), floorRowSpan)
            : skippedTableCell(),
          contract.unit?.unit_name || contract.unit?.unit_code || "—",
          formatYen(basicAmountFor(contract)),
          firstInTenant
            ? mergedTableCell(formatYen(tenantBasicAmountFor(contract)), tenantRowSpan)
            : skippedTableCell(),
          ...monthlyFixedItems.flatMap((item) => {
            const contractId = contract.meterBilling[0]?.meter_reading_contract_id;
            const tenantId = contract.contract?.tenant_id;
            const amount = fixedAmountFor(contract, item);
            const unitAmount = tenantId ? (
              <MonthlyFixedInput
                key={`${contract.lease_contract_unit_id}-${item.asset_meter_sub_item_id}`}
                amount={amount}
                disabled={confirmed}
                onCommit={(next) => {
                  onMonthlyFixedChange(
                    contractId ?? null,
                    tenantId,
                    contract.lease_contract_unit_id,
                    item.asset_meter_sub_item_id,
                    next,
                  );
                }}
              />
            ) : "—";
            return [
              unitAmount,
              firstInTenant
                ? mergedTableCell(formatYen(tenantFixedAmountFor(contract, item)), tenantRowSpan)
                : skippedTableCell(),
            ];
          }),
        ];
      })}
      totalRow={[
        "合計", "", "", formatYen(eligibleContracts.reduce((sum, row) => sum + basicAmountFor(row), 0)), "",
        ...monthlyFixedItems.flatMap((item) => [
          formatYen(eligibleContracts.reduce((sum, contract) => sum + (fixedAmountFor(contract, item) ?? 0), 0)),
          "",
        ]),
      ]}
    />
  );
}

function MonthlyFixedInput({
  amount,
  disabled,
  onCommit,
}: {
  amount: number | undefined;
  disabled: boolean;
  onCommit: (amount: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(amount == null ? "" : formatYen(amount));
  useEffect(() => {
    if (!editing) setValue(amount == null ? "" : formatYen(amount));
  }, [amount, editing]);
  return (
    <input
      className="reading-input monthly-fixed-input"
      type="text"
      inputMode="numeric"
      value={value}
      disabled={disabled}
      onChange={(event) => setValue(event.target.value)}
      onFocus={(event) => {
        setEditing(true);
        setValue(amount == null ? "" : String(amount));
        requestAnimationFrame(() => event.currentTarget.select());
      }}
      onBlur={() => {
        const rawValue = value.replace(/[,円\s]/g, "");
        const next = Number(rawValue);
        setEditing(false);
        if (rawValue !== "" && Number.isFinite(next) && next >= 0) {
          setValue(formatYen(next));
          if (next !== amount) onCommit(next);
        } else {
          setValue(amount == null ? "" : formatYen(amount));
        }
      }}
    />
  );
}

function CustomItemTable({
  billingMonth,
  meters,
  contracts,
  category,
  lineItemId,
  unitPriceOverride,
  defaultUnitPrice,
  values,
  saveStates,
  confirmed,
  usageHistory,
  rolloverValues,
  columnStorageUserId,
  usageOnly,
  onChange,
}: {
  billingMonth: string;
  meters: MeterReadingRow[];
  contracts: ContractUnit[];
  category: UtilityCategory;
  lineItemId: string | null;
  unitPriceOverride?: number;
  defaultUnitPrice: number | null;
  values: Record<string, string>;
  saveStates: Record<string, SaveState>;
  confirmed: boolean;
  usageHistory: {
    previous: Record<string, number>;
    previousYear: Record<string, number>;
  };
  rolloverValues: Record<string, number>;
  columnStorageUserId: string;
  usageOnly: boolean;
  onChange: (meter: MeterReadingRow, value: string) => void;
}) {
  const contractFor = (meter: MeterReadingRow) =>
    contracts.find(
      (contract) =>
        contract.unit?.unit_id === meter.assignments[0]?.unit_id,
    );
  const unitKey = (meter: MeterReadingRow) => {
    if (isMeterUsageAllocationParent(meter)) return `allocation-parent-${meter.asset_meter_id}`;
    if (meter.is_allocation_source) return `allocation-source-${meter.asset_meter_id}`;
    if (!meter.is_rate_source && !contractFor(meter)) return `vacant-${meter.asset_meter_id}`;
    return meter.assignments[0]?.unit_id ?? `unassigned-${meter.asset_meter_id}`;
  };
  const billingKey = (meter: MeterReadingRow) =>
    isMeterUsageAllocationParent(meter)
      ? `allocation-parent-${meter.asset_meter_id}`
      : meter.is_allocation_source
      ? `allocation-source-${meter.asset_meter_id}`
      : contractFor(meter)
      ? billingGroupKey(contractFor(meter))
      : `unassigned-${meter.asset_meter_id}`;
  const tenantKey = (meter: MeterReadingRow) =>
    isMeterUsageAllocationParent(meter)
      ? `allocation-parent-${meter.asset_meter_id}`
      : meter.is_allocation_source
      ? `allocation-source-${meter.asset_meter_id}`
      : contractFor(meter)?.contract?.tenant_id ?? `unassigned-${meter.asset_meter_id}`;
  const rawMeterUsage = (meter: MeterReadingRow) => {
    const raw = values[meter.asset_meter_id];
    if (raw !== undefined && raw.trim() === "") return 0;
    const entered = raw !== undefined && raw !== "" ? Number(raw) : null;
    const previous = Number(meter.entry?.previous_reading ?? 0);
    const rolloverValue = rolloverValues[meter.asset_meter_id];
    const usage = meter.subItem.input_mode === "reading"
      ? entered === null
        ? storedMeterUsage(meter)
        : entered < previous && rolloverValue
          ? rolloverValue - previous + entered
          : entered - previous
      : entered ?? storedMeterUsage(meter);
    return Number.isFinite(usage) ? usage : 0;
  };
  const meterUsage = (meter: MeterReadingRow) => billingAdjustedUsage(meter, adjustedMeterUsage(meter, meters, rawMeterUsage));
  const inputMode = meters[0]?.subItem.input_mode ?? "usage";
  const showReadings = inputMode === "reading";
  const comparisonRatio = (current: number, comparison: number | undefined) =>
    comparison == null || comparison === 0 ? null : (current / comparison) * 100;
  const unitPrice = (meter: MeterReadingRow) => {
    if (unitPriceOverride != null) return unitPriceOverride;
    const contract = contractFor(meter);
    if (!contract) return defaultUnitPrice;
    return (
      contractUnitPriceForBillingMonth(contract?.prices.find(
        (item) => item.asset_billing_line_item_id === lineItemId,
      ), billingMonth) ??
      contractUnitPriceForBillingMonth(
        contract?.categoryPrices.find((item) => item.category === category),
        billingMonth,
      ) ??
      null
    );
  };
  const allocationResults = meters.flatMap((parent) => {
    if (!isMeterUsageAllocationParent(parent)) return [];
    return parent.assignments.flatMap((assignment) => {
      if (!assignment.allocation_source_meter_id) return [];
      const source = meters.find((candidate) => candidate.asset_meter_id === assignment.allocation_source_meter_id);
      const contract = contracts.find((candidate) => candidate.unit?.unit_id === assignment.unit_id);
      if (!source || !contract) return [];
      const share = meterAllocationShare(parent, assignment.unit_id, meters);
      const digits = parent.subItem.aggregation_decimal_digits;
      const roundingMode = parent.subItem.usage_rounding_mode;
      const usage = roundToDigits(meterUsage(parent) * share, digits, roundingMode);
      const previous = usageHistory.previous[parent.asset_meter_id] == null
        ? undefined
        : roundToDigits(billingAdjustedUsage(parent, adjustedMeterUsage(parent, meters, (candidate) => usageHistory.previous[candidate.asset_meter_id] ?? 0)) * share, digits, roundingMode);
      const previousYear = usageHistory.previousYear[parent.asset_meter_id] == null
        ? undefined
        : roundToDigits(billingAdjustedUsage(parent, adjustedMeterUsage(parent, meters, (candidate) => usageHistory.previousYear[candidate.asset_meter_id] ?? 0)) * share, digits, roundingMode);
      const price = unitPrice(source);
      const amount = price == null ? null : roundUtilityAmount(usage * Number(price), contract.utility_amount_rounding_mode);
      return [{ parent, source, assignment, contract, usage, previous, previousYear, price, amount, digits }];
    });
  });
  const displayGroupKey = (meter: MeterReadingRow) => {
    if (meter.is_rate_source) return `rate-source-${meter.asset_meter_id}`;
    const tenantId = contractFor(meter)?.contract?.tenant_id;
    return tenantId ? `tenant-${tenantId}` : `vacant-${meter.asset_meter_id}`;
  };
  const displayGroupOrder = new Map<string, number>();
  for (const meter of meters) {
    const key = displayGroupKey(meter);
    const current = displayGroupOrder.get(key);
    if (current == null || meter.sort_order < current) displayGroupOrder.set(key, meter.sort_order);
  }
  const orderedMeters = orderAllocationMeterBlocks([...meters].sort((left, right) =>
    Number(right.is_rate_source) - Number(left.is_rate_source) ||
    left.sort_order - right.sort_order ||
    left.meter_code.localeCompare(right.meter_code, "ja-JP", { numeric: true }),
  ));
  const allocationOwnerFor = (meter: MeterReadingRow) => isMeterUsageAllocationParent(meter)
    ? meter
    : meter.is_allocation_source
      ? meters.find((candidate) =>
          candidate.assignments.some((row) => row.allocation_source_meter_id === meter.asset_meter_id) ||
          candidate.allocation_common_source_meter_ids.includes(meter.asset_meter_id),
        )
      : undefined;
  const billableMeters = orderedMeters.filter((meter) => !meter.is_rate_source && !meter.is_allocation_source && !isMeterUsageAllocationParent(meter));
  const rankedUnitPrices = Array.from(new Set(
    orderedMeters.map((meter) => unitPrice(meter)).filter((price): price is number => price != null),
  )).sort((left, right) => right - left);
  const unitPriceClass = (price: number | null) => {
    if (price == null) return "unit-price-unset";
    const rank = rankedUnitPrices.indexOf(price);
    return rank >= 0 && rank < 3 ? `unit-price-rank-${rank + 1}` : "";
  };
  const chargeForMeters = (targetMeters: MeterReadingRow[]) => {
    const first = targetMeters[0];
    return calculateUsageCharge(
      targetMeters.map((targetMeter) => ({
        meterId: targetMeter.asset_meter_id,
        usage: meterUsage(targetMeter),
        price: unitPrice(targetMeter),
      })),
      first.subItem.aggregation_decimal_digits,
      first.subItem.usage_rounding_mode,
      sumModeFor(contractFor(first), category),
      amountRoundingFor(contractFor(first)),
    );
  };
  const displayGroupsForBilling = (billingMeters: MeterReadingRow[]) =>
    sumModeFor(contractFor(billingMeters[0]), category) === "aggregate"
      ? [billingMeters]
      : Array.from(new Map(
          billingMeters.map((meter) => [unitKey(meter), billingMeters.filter((row) => unitKey(row) === unitKey(meter))]),
        ).values());
  const displayedUsageForTenant = (tenantMeters: MeterReadingRow[]) => {
    const tenantBillingGroups = Array.from(new Map(
      tenantMeters.map((meter) => [billingKey(meter), tenantMeters.filter((row) => billingKey(row) === billingKey(meter))]),
    ).values());
    return tenantBillingGroups.reduce((tenantSum, billingMeters) =>
      tenantSum + displayGroupsForBilling(billingMeters)
        .reduce((groupSum, group) => groupSum + chargeForMeters(group).usage, 0), 0);
  };
  const previousUsageFor = (meter: MeterReadingRow) => usageHistory.previous[meter.asset_meter_id] ?? 0;
  const previousYearUsageFor = (meter: MeterReadingRow) => usageHistory.previousYear[meter.asset_meter_id] ?? 0;
  const totalsFor = (targetMeters: MeterReadingRow[]) => {
    const targetBillingGroups = Array.from(new Map(
      targetMeters.map((meter) => [billingKey(meter), targetMeters.filter((row) => billingKey(row) === billingKey(meter))]),
    ).values());
    const targetTenantGroups = Array.from(new Map(
      targetMeters.map((meter) => [tenantKey(meter), targetMeters.filter((row) => tenantKey(row) === tenantKey(meter))]),
    ).values());
    const displayedGroups = targetBillingGroups.flatMap(displayGroupsForBilling);
    return {
      meterUsage: targetMeters.reduce((sum, meter) => sum + roundToDigits(
        meterUsage(meter),
        showReadings ? meter.subItem.aggregation_decimal_digits : meter.subItem.input_decimal_digits,
        meter.subItem.usage_rounding_mode,
      ), 0),
      unitUsage: displayedGroups.reduce((sum, group) => sum + chargeForMeters(group).usage, 0),
      amount: displayedGroups.reduce((sum, group) => sum + chargeForMeters(group).amount, 0),
      tenantUsage: targetTenantGroups.reduce((sum, group) => sum + displayedUsageForTenant(group), 0),
      previousUsage: targetMeters.reduce((sum, meter) => sum + roundToDigits(
        billingAdjustedUsage(meter, adjustedMeterUsage(meter, meters, previousUsageFor)),
        meter.subItem.aggregation_decimal_digits,
        meter.subItem.usage_rounding_mode,
      ), 0),
      previousYearUsage: targetMeters.reduce((sum, meter) => sum + roundToDigits(
        billingAdjustedUsage(meter, adjustedMeterUsage(meter, meters, previousYearUsageFor)),
        meter.subItem.aggregation_decimal_digits,
        meter.subItem.usage_rounding_mode,
      ), 0),
    };
  };
  const allocationTotals = {
    // 共用部の按分用メーターは分母だけに使い、請求先へ配賦しない。
    // 合計も親メーターの実測値ではなく、区画へ配賦した使用量を基準にして
    // 「メーターごと」と「区画ごと」を一致させる。
    meterUsage: allocationResults.reduce((sum, result) => sum + result.usage, 0),
    unitUsage: allocationResults.reduce((sum, result) => sum + result.usage, 0),
    amount: allocationResults.reduce((sum, result) => sum + (result.amount ?? 0), 0),
    tenantUsage: allocationResults.reduce((sum, result) => sum + result.usage, 0),
    previousUsage: allocationResults.reduce((sum, result) => sum + (result.previous ?? 0), 0),
    previousYearUsage: allocationResults.reduce((sum, result) => sum + (result.previousYear ?? 0), 0),
  };
  const addTotals = (base: ReturnType<typeof totalsFor>, extra: typeof allocationTotals) => ({
    meterUsage: base.meterUsage + extra.meterUsage,
    unitUsage: base.unitUsage + extra.unitUsage,
    amount: base.amount + extra.amount,
    tenantUsage: base.tenantUsage + extra.tenantUsage,
    previousUsage: base.previousUsage + extra.previousUsage,
    previousYearUsage: base.previousYearUsage + extra.previousYearUsage,
  });
  // 按分用メーターは計算根拠の表示専用で、合計には入れない。請求先への按分結果のみ加算する。
  const vacantMeters = billableMeters.filter((meter) => !contractFor(meter));
  const totalRows = vacantMeters.length
    ? [
        { label: "総合計", totals: addTotals(totalsFor(billableMeters), allocationTotals) },
        { label: "空室合計", totals: totalsFor(vacantMeters) },
        { label: "テナント合計", totals: addTotals(totalsFor(billableMeters.filter((meter) => Boolean(contractFor(meter)))), allocationTotals) },
      ]
    : [
        { label: "テナント合計", totals: addTotals(totalsFor(billableMeters), allocationTotals) },
      ];
  const inputTotalDigits = orderedMeters[0]?.subItem.input_decimal_digits ?? 1;
  const aggregationTotalDigits = orderedMeters[0]?.subItem.aggregation_decimal_digits ?? 1;
  const usageOnlyRows = Array.from(new Map(
    billableMeters.map((meter) => [unitKey(meter), billableMeters.filter((row) => unitKey(row) === unitKey(meter))]),
  ).values()).map((unitMeters) => {
    const meter = unitMeters[0];
    const unit = meter.assignments[0]?.unit;
    const contract = contractFor(meter);
    const tenantMeters = billableMeters.filter((row) => tenantKey(row) === tenantKey(meter));
    const prices = Array.from(new Set(unitMeters.map((row) => unitPrice(row)).filter((value): value is number => value != null)));
    const charge = chargeForMeters(unitMeters);
    const allocationResultsForUnit = unit?.unit_id
      ? allocationResults.filter((result) => result.assignment.unit_id === unit.unit_id)
      : [];
    const allocationResultsForTenant = contract?.contract?.tenant_id
      ? allocationResults.filter((result) => result.contract.contract?.tenant_id === contract.contract?.tenant_id)
      : [];
    const previousUsage = unitMeters.reduce((sum, row) => sum + billingAdjustedUsage(row, adjustedMeterUsage(row, meters, previousUsageFor)), 0)
      + allocationResultsForUnit.reduce((sum, result) => sum + (result.previous ?? 0), 0);
    const previousYearUsage = unitMeters.reduce((sum, row) => sum + billingAdjustedUsage(row, adjustedMeterUsage(row, meters, previousYearUsageFor)), 0)
      + allocationResultsForUnit.reduce((sum, result) => sum + (result.previousYear ?? 0), 0);
    const tenantBillingGroups = Array.from(new Map(
      tenantMeters.map((row) => [billingKey(row), tenantMeters.filter((item) => billingKey(item) === billingKey(row))]),
    ).values());
    return {
      key: unitKey(meter),
      tenantKey: tenantKey(meter),
      tenantName: contract?.contract?.tenant?.tenant_name ?? "空室",
      floor: formatFloor(unit?.floor_label),
      unitName: meter.is_rate_source ? "大元メーター" : unit?.unit_name || unit?.unit_code || "未割当",
      unitPrice: prices.length === 1 ? formatYen(prices[0]) : prices.length > 1 ? "複数" : "未設定",
      usage: charge.usage + allocationResultsForUnit.reduce((sum, result) => sum + result.usage, 0),
      amount: charge.amount + allocationResultsForUnit.reduce((sum, result) => sum + (result.amount ?? 0), 0),
      tenantUsage: displayedUsageForTenant(tenantMeters) + allocationResultsForTenant.reduce((sum, result) => sum + result.usage, 0),
      tenantAmount: tenantBillingGroups.reduce((sum, group) => sum + chargeForMeters(group).amount, 0) + allocationResultsForTenant.reduce((sum, result) => sum + (result.amount ?? 0), 0),
      previousUsage: roundToDigits(previousUsage, meter.subItem.aggregation_decimal_digits, meter.subItem.usage_rounding_mode),
      previousYearUsage: roundToDigits(previousYearUsage, meter.subItem.aggregation_decimal_digits, meter.subItem.usage_rounding_mode),
      digits: meter.subItem.aggregation_decimal_digits,
    };
  });
  return (
    <>
      {usageOnly ? <div className="table-wrap"><table className="workspace-data-table usage-only-table">
        <thead><tr><th rowSpan={2}>テナント名</th><th rowSpan={2}>階数</th><th rowSpan={2}>区画</th><th rowSpan={2}>単価</th><th rowSpan={2}>使用量</th><th rowSpan={2}>金額</th><th colSpan={2}>テナント合計</th><th colSpan={2}>前月</th><th colSpan={2}>前年同月</th></tr><tr><th>使用量</th><th>金額</th><th>使用量</th><th>当月比</th><th>使用量</th><th>当月比</th></tr></thead>
        <tbody>{usageOnlyRows.map((row, index) => { const firstInTenant = index === 0 || usageOnlyRows[index - 1].tenantKey !== row.tenantKey; let tenantRowCount = 1; while (index + tenantRowCount < usageOnlyRows.length && usageOnlyRows[index + tenantRowCount].tenantKey === row.tenantKey) tenantRowCount += 1; return <tr key={row.key}>{firstInTenant && <td className="tenant-cell tenant-identity" rowSpan={tenantRowCount}><strong>{row.tenantName}</strong></td>}<td>{row.floor}</td><td>{row.unitName}</td><td className="numeric">{row.unitPrice}</td><td className="numeric"><strong>{formatUsage(row.usage, row.digits)}</strong></td><td className="numeric">{formatYen(row.amount)}</td><td className="numeric">{formatUsage(row.tenantUsage, row.digits)}</td><td className="numeric">{formatYen(row.tenantAmount)}</td><td className="numeric">{formatUsage(row.previousUsage, row.digits)}</td><td className="numeric">{formatComparison(comparisonRatio(row.usage, row.previousUsage))}</td><td className="numeric">{formatUsage(row.previousYearUsage, row.digits)}</td><td className="numeric">{formatComparison(comparisonRatio(row.usage, row.previousYearUsage))}</td></tr>; })}{!usageOnlyRows.length && <tr><td colSpan={12} className="empty-cell">対象メーターがありません。</td></tr>}</tbody>
        {!!usageOnlyRows.length && <tfoot><tr className="table-total-row"><th colSpan={4}>合計</th><th className="numeric">{formatUsage(usageOnlyRows.reduce((sum, row) => sum + row.usage, 0), aggregationTotalDigits)}</th><th className="numeric">{formatYen(usageOnlyRows.reduce((sum, row) => sum + row.amount, 0))}</th><th className="numeric">—</th><th className="numeric">—</th><th className="numeric">{formatUsage(usageOnlyRows.reduce((sum, row) => sum + row.previousUsage, 0), aggregationTotalDigits)}</th><th className="numeric">{formatComparison(comparisonRatio(usageOnlyRows.reduce((sum, row) => sum + row.usage, 0), usageOnlyRows.reduce((sum, row) => sum + row.previousUsage, 0)))}</th><th className="numeric">{formatUsage(usageOnlyRows.reduce((sum, row) => sum + row.previousYearUsage, 0), aggregationTotalDigits)}</th><th className="numeric">{formatComparison(comparisonRatio(usageOnlyRows.reduce((sum, row) => sum + row.usage, 0), usageOnlyRows.reduce((sum, row) => sum + row.previousYearUsage, 0)))}</th></tr></tfoot>}
      </table></div> : <div className="table-wrap">
      <ResizableTable className="workspace-data-table" storageKey={`readings-${showReadings ? "reading" : "usage"}`} storageUserId={columnStorageUserId} columnGroups={[
        "tenant", "floor", "unit", "meter", "price",
        ...(showReadings ? ["reading", "reading"] : []),
        "usage", "usage", "amount", "usage", "amount",
        "usage", "comparison", "usage", "comparison",
      ]}>
        <thead>
          <tr>
            <ColumnHeader rowSpan={2} textAlign="tenant" columnGroup="tenant">テナント名</ColumnHeader>
            <ColumnHeader rowSpan={2} columnGroup="floor">階数</ColumnHeader>
            <ColumnHeader rowSpan={2} columnGroup="unit">区画</ColumnHeader>
            <ColumnHeader rowSpan={2} columnGroup="meter">メーター番号</ColumnHeader>
            <ColumnHeader rowSpan={2} textAlign="amount" columnGroup="price">単価</ColumnHeader>
            {showReadings && <ColumnHeader colSpan={2} className="usage-heading">検針値</ColumnHeader>}
            <ColumnHeader colSpan={2} className="usage-heading">使用量</ColumnHeader>
            <ColumnHeader rowSpan={2} textAlign="amount" columnGroup="amount">金額</ColumnHeader>
            <ColumnHeader colSpan={2} className="usage-heading">テナント合計</ColumnHeader>
            <ColumnHeader colSpan={2} className="usage-heading">前月</ColumnHeader>
            <ColumnHeader colSpan={2} className="usage-heading">前年同月</ColumnHeader>
          </tr>
          <tr>
            {showReadings && <><ColumnHeader columnGroup="reading">前月</ColumnHeader><ColumnHeader columnGroup="reading">当月</ColumnHeader></>}
            <ColumnHeader columnGroup="usage">メーターごと</ColumnHeader>
            <ColumnHeader columnGroup="usage">区画ごと</ColumnHeader>
            <ColumnHeader columnGroup="usage">使用量</ColumnHeader>
            <ColumnHeader columnGroup="amount">金額</ColumnHeader>
            <ColumnHeader columnGroup="usage">使用量</ColumnHeader>
            <ColumnHeader columnGroup="comparison">当月比</ColumnHeader>
            <ColumnHeader columnGroup="usage">使用量</ColumnHeader>
            <ColumnHeader columnGroup="comparison">当月比</ColumnHeader>
          </tr>
        </thead>
        <tbody>
          {orderedMeters.map((meter, index) => {
            const unit = meter.assignments[0]?.unit;
            const isVacant = !meter.is_rate_source && !contractFor(meter);
            const allocationOwner = allocationOwnerFor(meter);
            const displayUnitKey = (candidate: MeterReadingRow) => {
              const owner = allocationOwnerFor(candidate);
              return owner ? `allocation-block-${owner.asset_meter_id}` : unitKey(candidate);
            };
            const displayTenantKey = displayUnitKey;
            const currentUnitKey = displayUnitKey(meter);
            const firstInUnit = index === 0 || displayUnitKey(orderedMeters[index - 1]) !== currentUnitKey;
            const lastInUnit = index === orderedMeters.length - 1 || displayUnitKey(orderedMeters[index + 1]) !== currentUnitKey;
            let unitMeterCount = 1;
            while (index + unitMeterCount < orderedMeters.length && displayUnitKey(orderedMeters[index + unitMeterCount]) === currentUnitKey) unitMeterCount += 1;
            const currentTenantKey = displayTenantKey(meter);
            const firstInTenant = index === 0 || displayTenantKey(orderedMeters[index - 1]) !== currentTenantKey;
            const lastInTenant = index === orderedMeters.length - 1 || displayTenantKey(orderedMeters[index + 1]) !== currentTenantKey;
            let tenantStartIndex = index;
            while (tenantStartIndex > 0 && displayTenantKey(orderedMeters[tenantStartIndex - 1]) === currentTenantKey) tenantStartIndex -= 1;
            let tenantEndIndex = index;
            while (tenantEndIndex + 1 < orderedMeters.length && displayTenantKey(orderedMeters[tenantEndIndex + 1]) === currentTenantKey) tenantEndIndex += 1;
            const tenantMeters = orderedMeters.slice(tenantStartIndex, tenantEndIndex + 1);
            const currentBillingKey = billingKey(meter);
            const firstInBillingGroup = index === 0 || billingKey(orderedMeters[index - 1]) !== currentBillingKey;
            let billingStartIndex = index;
            while (billingStartIndex > 0 && billingKey(orderedMeters[billingStartIndex - 1]) === currentBillingKey) billingStartIndex -= 1;
            let billingEndIndex = index;
            while (billingEndIndex + 1 < orderedMeters.length && billingKey(orderedMeters[billingEndIndex + 1]) === currentBillingKey) billingEndIndex += 1;
            const billingMeters = orderedMeters.slice(billingStartIndex, billingEndIndex + 1);
            let billingMeterCount = 1;
            while (index + billingMeterCount < orderedMeters.length && billingKey(orderedMeters[index + billingMeterCount]) === currentBillingKey) billingMeterCount += 1;
            const unitEndIndex = index + unitMeterCount - 1;
            const unitEndsTenant =
              firstInUnit &&
              (unitEndIndex === orderedMeters.length - 1 ||
                tenantKey(orderedMeters[unitEndIndex + 1]) !== currentTenantKey);
            const contract = contractFor(meter);
            const price = unitPrice(meter);
            const aggregateBilling = sumModeFor(contract, category) === "aggregate";
            const state =
              saveStates[meter.asset_meter_id] ??
              (meter.entry ? "saved" : "idle");
            const aggregationDigits = meter.subItem.aggregation_decimal_digits ?? 1;
            const usageRoundingMode = meter.subItem.usage_rounding_mode ?? "round";
            const allocationResultsForUnit = unit?.unit_id
              ? allocationResults.filter((result) => result.assignment.unit_id === unit.unit_id)
              : [];
            const allocationResultsForBilling = allocationResults.filter((result) => billingGroupKey(result.contract) === currentBillingKey);
            const allocationResultsForTenant = contract?.contract?.tenant_id
              ? allocationResults.filter((result) => result.contract.contract?.tenant_id === contract.contract?.tenant_id)
              : [];
            const unitUsageRaw = orderedMeters
              .filter((row) => unitKey(row) === currentUnitKey)
              .reduce((sum, row) => {
                return sum + meterUsage(row);
              }, 0) + allocationResultsForUnit.reduce((sum, result) => sum + result.usage, 0);
            const unitUsage = roundToDigits(unitUsageRaw, aggregationDigits, usageRoundingMode);
            const unitAmount =
              contract && price != null
                ? roundUtilityAmount(
                    unitUsage * Number(price),
                    contract.utility_amount_rounding_mode,
                  )
                : null;
            const tenantUsage = displayedUsageForTenant(tenantMeters) + allocationResultsForTenant.reduce((sum, result) => sum + result.usage, 0);
            const billingUsage = chargeForMeters(billingMeters).usage + allocationResultsForBilling.reduce((sum, result) => sum + result.usage, 0);
            const billingAmount = chargeForMeters(billingMeters).amount + allocationResultsForBilling.reduce((sum, result) => sum + (result.amount ?? 0), 0);
            const tenantAmount = Array.from(new Map(
              tenantMeters.map((tenantMeter) => [billingKey(tenantMeter), tenantMeters.filter((row) => billingKey(row) === billingKey(tenantMeter))]),
            ).values()).reduce((sum, group) => sum + chargeForMeters(group).amount, 0) + allocationResultsForTenant.reduce((sum, result) => sum + (result.amount ?? 0), 0);
            const previousUsage = usageHistory.previous[meter.asset_meter_id] == null
              ? undefined
              : billingAdjustedUsage(meter, adjustedMeterUsage(meter, meters, previousUsageFor));
            const previousYearUsage = usageHistory.previousYear[meter.asset_meter_id] == null
              ? undefined
              : billingAdjustedUsage(meter, adjustedMeterUsage(meter, meters, previousYearUsageFor));
            const currentUsage = meterUsage(meter);
            const isUnentered = (values[meter.asset_meter_id] ?? "").trim() === "";
            const allocationParent = isMeterUsageAllocationParent(meter);
            const allocationOwnerId = allocationOwner?.asset_meter_id;
            const lastAllocationSource = allocationOwnerId != null && (
              index === orderedMeters.length - 1 ||
              allocationOwnerFor(orderedMeters[index + 1])?.asset_meter_id !== allocationOwnerId
            );
            const calculationOnly = meter.is_rate_source || meter.is_allocation_source || allocationParent;
            const currentTenantId = contract?.contract?.tenant_id;
            const lastRegularMeterForTenant = Boolean(currentTenantId) && !orderedMeters.slice(index + 1).some((candidate) =>
              !candidate.is_allocation_source && !isMeterUsageAllocationParent(candidate) && contractFor(candidate)?.contract?.tenant_id === currentTenantId,
            );
            const tenantAllocationResults = lastRegularMeterForTenant
              ? allocationResults.filter((result) => result.contract.contract?.tenant_id === currentTenantId)
              : [];
            const tenantAllocationResultCount = firstInTenant && currentTenantId && !meter.is_allocation_source && !allocationParent
              ? allocationResults.filter((result) => result.contract.contract?.tenant_id === currentTenantId).length
              : 0;
            const unitAllocationResultCount = firstInUnit && unit?.unit_id && !meter.is_allocation_source && !allocationParent
              ? allocationResults.filter((result) => result.assignment.unit_id === unit.unit_id).length
              : 0;
            return (
              <Fragment key={meter.asset_meter_id}>
              <tr className={`${firstInUnit ? "unit-group-start" : ""} ${lastInUnit && !tenantAllocationResults.length ? "unit-group-end" : ""} ${firstInTenant ? "tenant-group-start" : ""} ${lastInTenant && !tenantAllocationResults.length ? "tenant-group-end" : ""} ${isVacant ? "vacant-meter-row" : ""} ${meter.is_allocation_source ? "allocation-source-input-row" : ""} ${allocationParent ? "allocation-parent-input-row allocation-block-start" : ""} ${allocationParent || allocationOwner ? "allocation-block-row" : ""} ${lastAllocationSource ? "allocation-block-end" : ""}`}>
                {firstInTenant && (
                  <td className="tenant-cell tenant-identity" rowSpan={tenantMeters.length + tenantAllocationResultCount}>
                    <span className="merged-value">
                      {allocationOwner ? allocationOwner.meter_code : <TenantNameWithRounding
                        name={contract?.contract?.tenant?.tenant_name ?? "空室"}
                        contracts={tenantMeters.map((tenantMeter) => contractFor(tenantMeter)).filter((item): item is ContractUnit => Boolean(item))}
                      />}
                    </span>
                  </td>
                )}
                {firstInUnit && (
                  <>
                    <td className={`floor-identity ${unitEndsTenant ? "tenant-boundary" : ""}`} rowSpan={unitMeterCount + unitAllocationResultCount}><span className="merged-value">{formatFloor(allocationOwner?.assignments[0]?.unit?.floor_label ?? unit?.floor_label)}</span></td>
                    <td className={`unit-identity ${unitEndsTenant ? "tenant-boundary" : ""}`} rowSpan={unitMeterCount + unitAllocationResultCount}><span className="merged-value">{allocationOwner ? "—" : meter.is_rate_source ? "大元メーター" : unit?.unit_name || unit?.unit_code || "未割当"}</span></td>
                  </>
                )}
                <td><strong className="meter-code-with-tag">{allocationParent ? <>{meter.tag && <span className="meter-tag-badge" style={{ backgroundColor: meter.tag.color, color: readableTextColor(meter.tag.color) }}>{meter.tag.tag_name}</span>}按分用親メーター</> : meter.is_allocation_source ? <span className="allocation-source-meter-code">{meter.meter_label ?? meter.meter_code}</span> : <>{meter.tag && <span className="meter-tag-badge" style={{ backgroundColor: meter.tag.color, color: readableTextColor(meter.tag.color) }}>{meter.tag.tag_name}</span>}{meter.parent_meter_id && <span className="child-meter-mark">↳ 子</span>}{meter.meter_code}</>}</strong></td>
                <td className={`numeric unit-price-cell ${calculationOnly ? "" : unitPriceClass(price)}`}>{calculationOnly ? "—" : formatYen(price)}</td>
                {showReadings && (
                  <td className="numeric reading-value">
                    {meter.entry?.previous_reading == null ? "—" : formatUsage(Number(meter.entry.previous_reading), getReadingDecimalDigits(meter.subItem.asset_meter_sub_item_id, meter.subItem.input_decimal_digits))}
                  </td>
                )}
                <td className="reading-entry-cell">
                  <div className="input-with-state">
                    <div className="reading-input-actions">
                      <input
                        className="reading-input"
                        inputMode="decimal"
                        disabled={confirmed}
                        value={values[meter.asset_meter_id] ?? ""}
                        onChange={(event) => onChange(meter, event.target.value)}
                        onKeyDown={(event) => {
                          if (!["Enter", "ArrowUp", "ArrowDown"].includes(event.key)) return;
                          event.preventDefault();
                          const inputs = Array.from(
                            event.currentTarget
                              .closest("table")
                              ?.querySelectorAll<HTMLInputElement>("input.reading-input:not(:disabled)") ?? [],
                          );
                          const currentIndex = inputs.indexOf(event.currentTarget);
                          const offset = event.key === "ArrowUp" ? -1 : 1;
                          const nextInput = inputs[currentIndex + offset];
                          nextInput?.focus();
                          nextInput?.select();
                        }}
                      />
                    </div>
                    {state === "error" && <span className="save-error" title="保存エラー" />}
                  </div>
                </td>
                {showReadings && (
                  <td className={`numeric meter-usage ${meter.is_allocation_source || allocationParent ? "allocation-source-usage" : ""}`}>
                    <strong>{meter.is_rate_source || isUnentered ? "—" : formatUsage(currentUsage, aggregationDigits)}</strong>
                  </td>
                )}
                {calculationOnly ? (
                  <td className="numeric">—</td>
                ) : aggregateBilling && firstInBillingGroup ? (
                  <td className="numeric unit-total tenant-boundary" rowSpan={billingMeterCount + allocationResultsForBilling.length}>
                    <span className="merged-value">{formatUsage(billingUsage, aggregationDigits)}</span>
                  </td>
                ) : !aggregateBilling && firstInUnit ? (
                  <td className={`numeric unit-total ${unitEndsTenant ? "tenant-boundary" : ""}`} rowSpan={unitMeterCount + allocationResultsForUnit.length}>
                    <span className="merged-value">{unit ? formatUsage(unitUsage, aggregationDigits) : "—"}</span>
                  </td>
                ) : null}
                {calculationOnly ? (
                  <td className="numeric">—</td>
                ) : aggregateBilling && firstInBillingGroup ? (
                  <td className="numeric unit-amount tenant-boundary" rowSpan={billingMeterCount + allocationResultsForBilling.length}>
                    <span className="merged-value">{formatYen(billingAmount)}</span>
                  </td>
                ) : !aggregateBilling && firstInUnit ? (
                  <td className={`numeric unit-amount ${unitEndsTenant ? "tenant-boundary" : ""}`} rowSpan={unitMeterCount + allocationResultsForUnit.length}>
                    <span className="merged-value">{unitAmount == null ? "未設定" : formatYen(unitAmount)}</span>
                  </td>
                ) : null}
                {calculationOnly ? (
                  <><td className="numeric">—</td><td className="numeric">—</td></>
                ) : firstInTenant && (
                  <>
                    <td className="numeric tenant-total" rowSpan={tenantMeters.length + allocationResultsForTenant.length}><span className="merged-value">{formatUsage(tenantUsage, aggregationDigits)}</span></td>
                    <td className="numeric tenant-total" rowSpan={tenantMeters.length + allocationResultsForTenant.length}><span className="merged-value">{formatYen(tenantAmount)}</span></td>
                  </>
                )}
                <td className="numeric">{calculationOnly || previousUsage == null ? "—" : formatUsage(previousUsage, aggregationDigits)}</td>
                <td className="numeric">{calculationOnly ? "—" : formatComparison(comparisonRatio(currentUsage, previousUsage))}</td>
                <td className="numeric">{calculationOnly || previousYearUsage == null ? "—" : formatUsage(previousYearUsage, aggregationDigits)}</td>
                <td className="numeric">{calculationOnly ? "—" : formatComparison(comparisonRatio(currentUsage, previousYearUsage))}</td>
              </tr>
              {tenantAllocationResults.map((result) => (
                <tr className="allocation-result-row tenant-allocation-result-row unit-group-end tenant-group-end" key={`allocation-result:${result.parent.asset_meter_id}:${result.assignment.unit_id}`}>
                  <td className="allocation-result-label"><strong className="meter-code-with-tag">{result.source.tag && <span className="meter-tag-badge" style={{ backgroundColor: result.source.tag.color, color: readableTextColor(result.source.tag.color) }}>{result.source.tag.tag_name}</span>}<span>↳ {result.parent.meter_code} 按分</span></strong></td>
                  <td className={`numeric unit-price-cell ${unitPriceClass(result.price)}`}>{formatYen(result.price)}</td>
                  {showReadings && <><td className="numeric reading-value">—</td><td className="numeric reading-value">—</td></>}
                  <td className="numeric meter-usage"><strong>{formatUsage(result.usage, result.digits)}</strong></td>
                  <td className="numeric">{result.previous == null ? "—" : formatUsage(result.previous, result.digits)}</td>
                  <td className="numeric">{formatComparison(comparisonRatio(result.usage, result.previous))}</td>
                  <td className="numeric">{result.previousYear == null ? "—" : formatUsage(result.previousYear, result.digits)}</td>
                  <td className="numeric">{formatComparison(comparisonRatio(result.usage, result.previousYear))}</td>
                </tr>
              ))}
              </Fragment>
            );
          })}
          {!meters.length && (
            <tr>
              <td colSpan={showReadings ? 16 : 14} className="empty-cell">
                対象メーターがありません。
              </td>
            </tr>
          )}
        </tbody>
        {!!orderedMeters.length && (
          <tfoot>
            {totalRows.map(({ label, totals }) => (
              <tr className="table-total-row" key={label}>
                <th colSpan={4}>{label}</th>
                <th>—</th>
                {showReadings && <><th className="numeric">—</th><th className="numeric">—</th></>}
                <th className="numeric">{formatUsage(totals.meterUsage, showReadings ? aggregationTotalDigits : inputTotalDigits)}</th>
                <th className="numeric">{formatUsage(totals.unitUsage, aggregationTotalDigits)}</th>
                <th className="numeric">{formatYen(totals.amount)}</th>
                <th className="numeric">{formatUsage(totals.tenantUsage, aggregationTotalDigits)}</th>
                <th className="numeric">{formatYen(totals.amount)}</th>
                <th className="numeric">{formatUsage(totals.previousUsage, aggregationTotalDigits)}</th>
                <th className="numeric">{formatComparison(comparisonRatio(totals.meterUsage, totals.previousUsage))}</th>
                <th className="numeric">{formatUsage(totals.previousYearUsage, aggregationTotalDigits)}</th>
                <th className="numeric">{formatComparison(comparisonRatio(totals.meterUsage, totals.previousYearUsage))}</th>
              </tr>
            ))}
          </tfoot>
        )}
      </ResizableTable>
    </div>}
    </>
  );
}

function formatComparison(value: number | null) {
  return value == null || !Number.isFinite(value) ? "—" : `${value.toFixed(1)}%`;
}
function SurchargeWorkspace({
  surcharge,
  assetId,
  billingMonth,
  unit,
  contracts,
  meters,
  subItems,
}: {
  surcharge: MeterSurcharge;
  assetId: string;
  billingMonth: string;
  unit: string;
  contracts: ContractUnit[];
  meters: MeterReadingRow[];
  subItems: MeterSubItem[];
}) {
  const storageKey = `kanameter-surcharge-evidence:${assetId}:${billingMonth}:${surcharge.asset_meter_surcharge_id}`;
  const storedEvidence = (() => {
    try {
      return JSON.parse(localStorage.getItem(storageKey) ?? "{}") as { periodFrom?: string; periodTo?: string; purchaseUsage?: string; purchaseInvoice?: string };
    } catch {
      return {};
    }
  })();
  const [periodFrom, setPeriodFrom] = useState(storedEvidence.periodFrom ?? "");
  const [periodTo, setPeriodTo] = useState(storedEvidence.periodTo ?? "");
  const [purchaseUsage, setPurchaseUsage] = useState(storedEvidence.purchaseUsage ?? "");
  const [purchaseInvoice, setPurchaseInvoice] = useState(storedEvidence.purchaseInvoice ?? "");
  const [evidenceLoaded, setEvidenceLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    void loadSurchargeEvidence(supabase!, assetId, billingMonth, surcharge.asset_meter_surcharge_id)
      .then((saved) => {
        if (!active || !saved) return;
        setPeriodFrom(saved.purchase_period_start ?? "");
        setPeriodTo(saved.purchase_period_end ?? "");
        setPurchaseUsage(saved.purchase_usage == null ? "" : String(saved.purchase_usage));
        setPurchaseInvoice(saved.purchase_amount_inclusive == null ? "" : String(saved.purchase_amount_inclusive));
      })
      .catch((reason) => console.error(reason))
      .finally(() => { if (active) setEvidenceLoaded(true); });
    return () => { active = false; };
  }, [assetId, billingMonth, surcharge.asset_meter_surcharge_id]);
  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify({ periodFrom, periodTo, purchaseUsage, purchaseInvoice }));
  }, [storageKey, periodFrom, periodTo, purchaseUsage, purchaseInvoice]);
  const moveToNextEvidenceInput = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const inputs = Array.from(event.currentTarget.closest("aside")?.querySelectorAll<HTMLInputElement>("input:not(:disabled)") ?? []);
    const currentIndex = inputs.indexOf(event.currentTarget);
    inputs[currentIndex + 1]?.focus();
    inputs[currentIndex + 1]?.select();
  };
  const eligibleContracts = contracts.filter((row) => ["office", "warehouse", "storage"].includes(row.unit?.unit_type ?? ""));
  const billingGroupIds = Array.from(new Set(eligibleContracts.map((row) => billingGroupKey(row))));
  const subItemIds = Array.from(new Set(meters.map((meter) => meter.subItem.asset_meter_sub_item_id)));
  const aggregationDigits = Math.max(0, ...meters.map((meter) => meter.subItem.aggregation_decimal_digits));
  const usageForMeters = (itemMeters: MeterReadingRow[]) => {
    const first = itemMeters[0];
    if (!first) return 0;
    return roundToDigits(
      itemMeters.reduce((sum, meter) => sum + billingAdjustedUsage(
        meter,
        adjustedMeterUsage(meter, meters, storedMeterUsage),
      ), 0),
      first.subItem.aggregation_decimal_digits,
      first.subItem.usage_rounding_mode,
    );
  };
  const tenantRows = billingGroupIds.map((billingGroupId) => {
    const tenantContracts = eligibleContracts.filter((row) => billingGroupKey(row) === billingGroupId);
    const unitIds = new Set(tenantContracts.map((row) => row.unit?.unit_id).filter(Boolean));
    const usage = subItemIds.reduce((total, subItemId) => {
      const itemMeters = meters.filter((meter) => meter.subItem.asset_meter_sub_item_id === subItemId && unitIds.has(meter.assignments[0]?.unit_id));
      return total + usageForMeters(itemMeters);
    }, 0);
    return {
      tenantContracts,
      usage,
    };
  });
  const recoveryUsage = tenantRows.reduce((total, row) => total + row.usage, 0);
  const recoveryAmountExcludingTax = eligibleContracts.reduce((contractTotal, contract) => {
    const basicAmount = Number(contract.basics.find((row) => row.category === "electric")?.amount ?? 0);
    const unitId = contract.unit?.unit_id;
    const customAmount = subItemIds.reduce((itemTotal, subItemId) => {
      const item = subItems.find((row) => row.asset_meter_sub_item_id === subItemId);
      if (!item || !unitId) return itemTotal;
      const itemMeters = meters.filter((meter) =>
        meter.subItem.asset_meter_sub_item_id === subItemId &&
        meter.assignments[0]?.unit_id === unitId
      );
      const usage = usageForMeters(itemMeters);
      const unitPrice = contractUnitPriceForBillingMonth(
        contract.prices.find((row) => row.asset_billing_line_item_id === item.asset_billing_line_item_id),
        billingMonth,
      ) ?? contractUnitPriceForBillingMonth(
        contract.categoryPrices.find((row) => row.category === "electric"),
        billingMonth,
      );
      return unitPrice == null
        ? itemTotal
        : itemTotal + roundUtilityAmount(usage * Number(unitPrice), contract.utility_amount_rounding_mode);
    }, 0);
    return contractTotal + basicAmount + customAmount;
  }, 0);
  const recoveryAmountIncludingTax = Math.round(recoveryAmountExcludingTax * 1.1);
  const purchaseInvoiceValue = purchaseInvoice.trim() === "" ? null : Number(purchaseInvoice);
  const recoveryShortfall = purchaseInvoiceValue == null || !Number.isFinite(purchaseInvoiceValue)
    ? null
    : purchaseInvoiceValue - recoveryAmountIncludingTax;
  const tenantUnitPriceIncludingTax = recoveryShortfall == null || recoveryUsage === 0
    ? null
    : Math.max(0, recoveryShortfall / recoveryUsage);
  const tenantUnitPriceExcludingTax = tenantUnitPriceIncludingTax == null
    ? null
    : Math.ceil((tenantUnitPriceIncludingTax / 1.1) * 100) / 100;
  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify({
      periodFrom,
      periodTo,
      purchaseUsage,
      purchaseInvoice,
      unitPrice: tenantUnitPriceExcludingTax,
    }));
  }, [periodFrom, periodTo, purchaseInvoice, purchaseUsage, storageKey, tenantUnitPriceExcludingTax]);
  useEffect(() => {
    if (!evidenceLoaded || (purchaseUsage.trim() === "" && purchaseInvoice.trim() === "")) return;
    const timer = window.setTimeout(() => {
      void saveSurchargeEvidence(supabase!, {
        assetId,
        billingMonth,
        surchargeId: surcharge.asset_meter_surcharge_id,
        unitPrice: tenantUnitPriceExcludingTax ?? 0,
        periodStart: periodFrom || null,
        periodEnd: periodTo || null,
        purchaseUsage: Number(purchaseUsage || 0),
        purchaseAmountInclusive: Number(purchaseInvoice || 0),
      }).catch((reason) => console.error(reason));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [assetId, billingMonth, evidenceLoaded, periodFrom, periodTo, purchaseInvoice, purchaseUsage, surcharge.asset_meter_surcharge_id, tenantUnitPriceExcludingTax]);
  const rows = tenantRows.map(({ tenantContracts, usage }) => {
    const amount = tenantUnitPriceExcludingTax == null
      ? null
      : roundUtilityAmount(
          usage * tenantUnitPriceExcludingTax,
          tenantContracts[0]?.utility_amount_rounding_mode ?? "round",
        );
    return [
      Array.from(new Set(tenantContracts.map((row) => formatFloor(row.unit?.floor_label)))).join("・"),
      tenantContracts.map((row) => row.unit?.unit_name || row.unit?.unit_code).filter(Boolean).join("・") || "—",
      <TenantNameWithRounding
        name={billingGroupTenantName(tenantContracts[0])}
        contracts={tenantContracts}
      />,
      formatUsage(usage, aggregationDigits),
      amount == null ? "—" : formatYen(amount),
    ] as ReactNode[];
  });
  const totalSurchargeAmount = tenantRows.reduce((total, row) => {
    if (tenantUnitPriceExcludingTax == null) return total;
    return total + roundUtilityAmount(
      row.usage * tenantUnitPriceExcludingTax,
      row.tenantContracts[0]?.utility_amount_rounding_mode ?? "round",
    );
  }, 0);

  return (
    <>
      <div className="workspace-table-card">
        <DataTable
          headers={["階数", "区画", "テナント名", "使用量", "金額"]}
          rows={rows}
          totalRow={["合計", "", "", formatUsage(recoveryUsage, aggregationDigits), tenantUnitPriceExcludingTax == null ? "—" : formatYen(totalSurchargeAmount)]}
        />
      </div>
      <aside className="evidence-panel">
        <p className="eyebrow">SURCHARGE</p>
        <h2>{displaySurchargeName(surcharge.surcharge_name)}単価計算</h2>
        <h3>＜仕入＞</h3>
        <label>
          対象期間
          <div className="period-fields">
            <input type="date" value={periodFrom} onChange={(event) => setPeriodFrom(event.target.value)} onKeyDown={moveToNextEvidenceInput} />
            <span>～</span>
            <input type="date" value={periodTo} onChange={(event) => setPeriodTo(event.target.value)} onKeyDown={moveToNextEvidenceInput} />
          </div>
        </label>
        <label>使用量（{unit || "単位未設定"}）<input type="number" min="0" value={purchaseUsage} onChange={(event) => setPurchaseUsage(event.target.value)} onKeyDown={moveToNextEvidenceInput} placeholder="0" /></label>
        <label>請求額（税込）<input type="number" min="0" value={purchaseInvoice} onChange={(event) => setPurchaseInvoice(event.target.value)} onKeyDown={moveToNextEvidenceInput} placeholder="0" /></label>
        <h3>＜回収＞</h3>
        <dl>
          <div><dt>使用量</dt><dd>{formatUsage(recoveryUsage, aggregationDigits)} {unit}</dd></div>
          <div><dt>金額（税抜）</dt><dd>{formatYen(recoveryAmountExcludingTax)}</dd></div>
          <div><dt>金額（税込）</dt><dd>{formatYen(recoveryAmountIncludingTax)}</dd></div>
        </dl>
        <dl className="surcharge-result-list">
          <div><dt>回収不足分（税込）</dt><dd>{recoveryShortfall == null ? "—" : formatYen(recoveryShortfall)}</dd></div>
          <div><dt>テナント使用量単価（税込）</dt><dd>{tenantUnitPriceIncludingTax == null ? "—" : `${tenantUnitPriceIncludingTax.toLocaleString("ja-JP", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 円`}</dd></div>
          <div><dt>テナント使用量単価（税抜）</dt><dd>{tenantUnitPriceExcludingTax == null ? "—" : `${tenantUnitPriceExcludingTax.toLocaleString("ja-JP", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 円`}</dd></div>
        </dl>
      </aside>
    </>
  );
}

function BuildingSettingsView({
  assetId,
  contracts,
  categorySettings,
  utilitySettings,
  subItems,
  surcharges,
  periodPatterns,
  billingLineItems,
  columnStorageUserId,
  onSaved,
  onNotice,
  onError,
}: {
  assetId: string;
  contracts: ContractUnit[];
  categorySettings: MeterCategorySetting[];
  utilitySettings: AssetUtilitySetting[];
  subItems: MeterSubItem[];
  surcharges: MeterSurcharge[];
  periodPatterns: BillingPeriodPattern[];
  billingLineItems: BillingLineItem[];
  columnStorageUserId: string;
  onSaved: (categories: MeterCategorySetting[], utilitySettings: AssetUtilitySetting[], subItems: MeterSubItem[], surcharges: MeterSurcharge[]) => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [tab, setTab] = useState<"meter" | "tenant">("meter");
  const [draftCategories, setDraftCategories] = useState(categorySettings);
  const [draftUtilitySettings, setDraftUtilitySettings] = useState(utilitySettings);
  const [draftSubItems, setDraftSubItems] = useState(subItems);
  const [draftSurcharges, setDraftSurcharges] = useState(surcharges);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraftCategories(categorySettings), [categorySettings]);
  useEffect(() => setDraftUtilitySettings(utilitySettings), [utilitySettings]);
  useEffect(() => setDraftSubItems(ensureBasicSubItems(categorySettings, subItems)), [categorySettings, subItems]);
  useEffect(() => setDraftSurcharges(surcharges), [surcharges]);
  const periodOrder = ["前月分", "当月分", "翌月分", "検針期間（前月検針日を含める）", "検針期間（前月検針日を含めない）"];
  const periodOptions = periodPatterns
    .filter((period) => periodOrder.includes(period.pattern_name ?? ""))
    .sort((a, b) => periodOrder.indexOf(a.pattern_name ?? "") - periodOrder.indexOf(b.pattern_name ?? ""));
  const updateCategory = (category: UtilityCategory, patch: Partial<MeterCategorySetting>) =>
    setDraftCategories((current) => current.map((row) => row.category === category ? { ...row, ...patch } : row));
  const updateBasicBillable = (category: UtilityCategory, checked: boolean) => {
    setDraftCategories((current) => current.map((row) => row.category === category ? { ...row, is_basic_billable: checked } : row));
    if (checked) setDraftSubItems((current) => ensureBasicSubItems([{
      category,
      usage_unit: "",
      is_billable: true,
      is_basic_billable: true,
      basic_charge_method: "fixed",
      basic_charge_fixed_amount: null,
      basic_charge_area_unit_price: null,
    }], current));
  };
  const updateUtilitySetting = (category: UtilityCategory, patch: Partial<AssetUtilitySetting>) =>
    setDraftUtilitySettings((current) => {
      const existing = current.find((row) => row.category === category) ?? {
        category, price_scope: "category" as const, default_unit_price: null, default_tax_mode: "exclusive" as const, show_in_rent_roll: true,
      };
      return [...current.filter((row) => row.category !== category), { ...existing, ...patch }];
    });
  const updateSubItem = (id: string, patch: Partial<MeterSubItem>) =>
    setDraftSubItems((current) => current.map((row) => row.asset_meter_sub_item_id === id ? { ...row, ...patch } : row));
  const updateSurcharge = (id: string, patch: Partial<MeterSurcharge>) =>
    setDraftSurcharges((current) => current.map((row) => row.asset_meter_surcharge_id === id ? { ...row, ...patch } : row));
  const addSubItem = (category: UtilityCategory) => setDraftSubItems((current) => [...current, {
    asset_meter_sub_item_id: crypto.randomUUID(), category, sub_item_name: "", sub_item_kind: "custom",
    asset_billing_line_item_id: null, sort_order: current.filter((row) => row.category === category).length,
    input_mode: "usage", input_decimal_digits: 1, aggregation_decimal_digits: 1, usage_rounding_mode: "round",
    billing_period_pattern_id: null, price_mode: "fixed", default_unit_price: null, tax_mode: "exclusive",
    tax_rounding_mode: "floor", show_unit_price_on_invoice: true,
    is_monthly_fixed: false,
  }]);
  const save = async () => {
    if (draftSubItems.some((item) => !item.sub_item_name.trim())) {
      onError("小分類名を入力してください。");
      return;
    }
    setSaving(true); onError("");
    try {
      const removed = subItems.filter((row) => !draftSubItems.some((next) => next.asset_meter_sub_item_id === row.asset_meter_sub_item_id)).map((row) => row.asset_meter_sub_item_id);
      await Promise.all([
        saveMeteringSettings(supabase!, assetId, draftCategories, draftSubItems, draftSurcharges, removed),
        saveAssetUtilitySettings(supabase!, assetId, draftUtilitySettings),
      ]);
      onSaved(draftCategories, draftUtilitySettings, draftSubItems, draftSurcharges);
      onNotice("検針設定を保存しました。");
    } catch (reason) { onError((reason as Error).message); }
    finally { setSaving(false); }
  };
  const roundingLabels: Record<ContractUnit["utility_amount_rounding_mode"], string> = {
    floor: "切り捨て",
    round: "四捨五入",
    ceil: "切り上げ",
  };
  return (
    <section className="building-settings">
      <nav className="settings-tabs" aria-label="設定項目">
        <button type="button" className={tab === "meter" ? "active" : ""} onClick={() => setTab("meter")}>検針設定</button>
        <button type="button" className={tab === "tenant" ? "active" : ""} onClick={() => setTab("tenant")}>テナント一覧</button>
      </nav>
      {tab === "meter" ? (
        <div className="meter-configuration-panel">
          <div className="tenant-settings-heading"><div><h2>検針設定</h2><p>分類・小分類と請求書への連携方法を設定します。使用量の丸めと入力桁数は各小分類の「メーター設定」で管理します。</p></div><button type="button" className="primary compact" disabled={saving} onClick={() => void save()}>{saving ? "保存中…" : "設定を保存"}</button></div>
          {categories.map((category) => {
            const setting = draftCategories.find((row) => row.category === category);
            if (!setting?.is_billable) return null;
            const items = draftSubItems.filter((row) => row.category === category && (row.sub_item_kind !== "basic" || setting.is_basic_billable));
            const categoryLineItems = billingLineItems.filter((line) => line.utility_category === category);
            const surchargeLineItems = categoryLineItems.filter((line) => line.is_surcharge);
            const categorySurcharges = category === "electric" ? draftSurcharges.filter((row) => row.category === category) : [];
            const utilitySetting = draftUtilitySettings.find((row) => row.category === category) ?? { category, price_scope: "category" as const, default_unit_price: null, default_tax_mode: "exclusive" as const, show_in_rent_roll: true };
            const usesSharedPrice = utilitySetting.price_scope === "category";
            return <section className={`configuration-category utility-${category}`} key={category}>
              <header className="configuration-category-header"><strong>{labels[category]}</strong><label>使用量の単位<input value={setting.usage_unit} onChange={(event) => updateCategory(category, { usage_unit: event.target.value })} /></label><label className="checkbox-label"><input type="checkbox" checked={setting.is_basic_billable} onChange={(event) => updateBasicBillable(category, event.target.checked)} />基本料を請求する</label>{setting.is_basic_billable && <><label className="basic-charge-setting">算定方法<select value={setting.basic_charge_method} onChange={(event) => updateCategory(category, { basic_charge_method: event.target.value as MeterCategorySetting["basic_charge_method"] })}><option value="fixed">定額</option><option value="sqm">㎡ × 単価</option><option value="tsubo">坪数 × 単価</option></select></label>{setting.basic_charge_method !== "fixed" && <label className="basic-charge-setting">面積単価<input type="number" min="0" step="0.01" value={setting.basic_charge_area_unit_price ?? ""} placeholder="未設定" onChange={(event) => updateCategory(category, { basic_charge_area_unit_price: event.target.value === "" ? null : Number(event.target.value) })} /><span>{setting.basic_charge_method === "sqm" ? "円/㎡" : "円/坪"}</span></label>}</>}<label className="price-setting-label price-setting-separator">既定単価設定<select value={utilitySetting.price_scope} onChange={(event) => updateUtilitySetting(category, { price_scope: event.target.value as AssetUtilitySetting["price_scope"] })}><option value="category">共通して設定</option><option value="line_item">小分類ごとに設定</option></select></label>{usesSharedPrice && <label className="price-setting-label">共通単価<input type="number" min="0" step="0.0001" value={utilitySetting.default_unit_price ?? ""} onChange={(event) => updateUtilitySetting(category, { default_unit_price: event.target.value === "" ? null : Number(event.target.value) })} /></label>}<label className="checkbox-label"><input type="checkbox" checked={utilitySetting.show_in_rent_roll} onChange={(event) => updateUtilitySetting(category, { show_in_rent_roll: event.target.checked })} />単価をレントロールに表示</label><button type="button" className="text-button" onClick={() => addSubItem(category)}>小分類を追加</button></header>
              <div className="table-wrap"><ResizableTable className="configuration-table resizable-configuration-table" storageKey={`building-settings:${assetId}:meter-configuration`} storageUserId={columnStorageUserId} columnGroups={["subitem", "line-item", "monthly-fixed", "price-mode", "default-price", "invoice-price", "tax-mode", "tax-rounding", "billing-period", "actions"]}><thead><tr><ColumnHeader columnGroup="subitem">小分類</ColumnHeader><ColumnHeader columnGroup="line-item">請求明細の項目</ColumnHeader><ColumnHeader columnGroup="monthly-fixed">毎月定額</ColumnHeader><ColumnHeader columnGroup="price-mode">単価計算方法</ColumnHeader><ColumnHeader columnGroup="default-price">既定単価</ColumnHeader><ColumnHeader columnGroup="invoice-price">請求書に単価を表示</ColumnHeader><ColumnHeader columnGroup="tax-mode">税区分</ColumnHeader><ColumnHeader columnGroup="tax-rounding">税込単価の税抜換算</ColumnHeader><ColumnHeader columnGroup="billing-period">既定の請求期間</ColumnHeader><ColumnHeader columnGroup="actions" /></tr></thead><tbody>
                {items.map((item) => <tr key={item.asset_meter_sub_item_id}>
                  <td>{item.sub_item_kind === "basic"
                    ? <strong>{item.sub_item_name}</strong>
                    : <input value={item.sub_item_name} placeholder="新しい小分類" onChange={(event) => updateSubItem(item.asset_meter_sub_item_id, { sub_item_name: event.target.value })} />}</td>
                  <td className="align-left"><select value={item.asset_billing_line_item_id ?? ""} onChange={(event) => updateSubItem(item.asset_meter_sub_item_id, { asset_billing_line_item_id: event.target.value || null })}><option value="">未設定</option>{categoryLineItems.map((line) => <option key={line.asset_billing_line_item_id} value={line.asset_billing_line_item_id}>{line.line_item_name}</option>)}</select></td>
                  <td>{item.sub_item_kind === "basic" ? "—" : <input type="checkbox" checked={item.is_monthly_fixed} onChange={(event) => updateSubItem(item.asset_meter_sub_item_id, { is_monthly_fixed: event.target.checked })} />}</td>
                  <td>{item.sub_item_kind === "basic" || item.is_monthly_fixed ? "—" : <select value={item.price_mode} onChange={(event) => updateSubItem(item.asset_meter_sub_item_id, { price_mode: event.target.value as MeterSubItem["price_mode"] })}><option value="fixed">固定</option><option value="amount">金額から計算</option><option value="master_meter">大元メーターから計算</option></select>}</td>
                  <td>{item.is_monthly_fixed ? "—" : <input type="number" min="0" step="0.0001" disabled={item.sub_item_kind === "basic" || usesSharedPrice} value={item.default_unit_price ?? ""} onChange={(event) => updateSubItem(item.asset_meter_sub_item_id, { default_unit_price: event.target.value === "" ? null : Number(event.target.value) })} />}</td>
                  <td>{item.sub_item_kind === "basic" || item.is_monthly_fixed ? "—" : <input type="checkbox" checked={item.show_unit_price_on_invoice} onChange={(event) => updateSubItem(item.asset_meter_sub_item_id, { show_unit_price_on_invoice: event.target.checked })} />}</td>
                  <td><select value={item.tax_mode} onChange={(event) => updateSubItem(item.asset_meter_sub_item_id, { tax_mode: event.target.value as TaxMode })}><option value="exclusive">税抜</option><option value="inclusive">税込</option></select></td>
                  <td>{item.tax_mode === "inclusive" ? <select value={item.tax_rounding_mode} onChange={(event) => updateSubItem(item.asset_meter_sub_item_id, { tax_rounding_mode: event.target.value as "floor" | "round" | "ceil" })}><option value="floor">切り捨て</option><option value="round">四捨五入</option><option value="ceil">切り上げ</option></select> : "—"}</td>
                  <td className="align-left"><select value={item.billing_period_pattern_id ?? ""} onChange={(event) => updateSubItem(item.asset_meter_sub_item_id, { billing_period_pattern_id: event.target.value || null })}><option value="">未設定</option>{periodOptions.map((period) => <option key={period.billing_period_pattern_id} value={period.billing_period_pattern_id}>{period.pattern_name}</option>)}</select></td>
                  <td>{item.sub_item_kind === "custom" && <button type="button" className="danger-link" onClick={() => window.confirm(`「${item.sub_item_name}」を削除しますか？`) && setDraftSubItems((current) => current.filter((row) => row.asset_meter_sub_item_id !== item.asset_meter_sub_item_id))}>削除</button>}</td>
                </tr>)}
                {categorySurcharges.filter((item) => item.is_billable && surchargeLineItems.length > 0).map((item) => <tr key={item.asset_meter_surcharge_id} className="surcharge-setting-row"><td><strong>{item.surcharge_name}</strong></td><td className="align-left"><select value={item.asset_billing_line_item_id ?? ""} onChange={(event) => updateSurcharge(item.asset_meter_surcharge_id, { asset_billing_line_item_id: event.target.value || null })}><option value="">未設定</option>{surchargeLineItems.map((line) => <option key={line.asset_billing_line_item_id} value={line.asset_billing_line_item_id}>{line.line_item_name}</option>)}</select></td><td colSpan={6}>—</td><td className="align-left"><select value={item.billing_period_pattern_id ?? ""} onChange={(event) => updateSurcharge(item.asset_meter_surcharge_id, { billing_period_pattern_id: event.target.value || null })}><option value="">未設定</option>{periodOptions.map((period) => <option key={period.billing_period_pattern_id} value={period.billing_period_pattern_id}>{period.pattern_name}</option>)}</select></td><td /></tr>)}
              </tbody></ResizableTable></div>
            </section>;
          })}
        </div>
      ) : (
      <div className="tenant-settings-panel">
          <div className="tenant-settings-heading">
            <div>
              <h2>テナント一覧</h2>
              <p>KANAMEで設定された公共料金の条件を区画ごとに表示します。</p>
            </div>
            <span>読み取り専用</span>
          </div>
          <DataTable
            headers={["階数", "区画", "テナント名", "端数処理", "基本料", "単価設定"]}
            rows={contracts
              .filter((contract) => ["office", "warehouse", "storage"].includes(contract.unit?.unit_type ?? ""))
              .map((contract) => [
              formatFloor(contract.unit?.floor_label),
              contract.unit?.unit_name || contract.unit?.unit_code || "—",
              contract.contract?.tenant?.tenant_name ?? "—",
              roundingLabels[contract.utility_amount_rounding_mode],
              contract.basics.length
                ? contract.basics.map((item) => `${labels[item.category]} ${formatYen(item.amount)}`).join(" / ")
                : "未設定",
              formatContractPrices(contract),
            ])}
          />
      </div>
      )}
    </section>
  );
}

function formatContractPrices(contract: ContractUnit) {
  const itemPrices = contract.prices.map(
    (price) => `${price.item?.line_item_name ?? "項目"} ${formatYen(price.unit_price)}`,
  );
  const categoryPrices = contract.categoryPrices.map(
    (price) => `${labels[price.category]} ${formatYen(price.unit_price)}`,
  );
  return [...itemPrices, ...categoryPrices].join(" / ") || "未設定";
}

function TenantNameWithRounding({
  name,
  contracts,
}: {
  name: string;
  contracts: ContractUnit[];
}) {
  const uniqueContracts = Array.from(
    new Map(contracts.map((contract) => [contract.lease_contract_unit_id, contract])).values(),
  );
  const floorContracts = uniqueContracts.filter((contract) => contract.utility_amount_rounding_mode === "floor");
  const hasMixedRounding = floorContracts.length > 0 && floorContracts.length < uniqueContracts.length;
  const floorUnitLabels = Array.from(new Set(
    floorContracts.map((contract) => {
      const unitName = contract.unit?.unit_name || contract.unit?.unit_code;
      return unitName ? `${formatFloor(contract.unit?.floor_label)} ${unitName}` : null;
    }).filter(Boolean),
  ));
  const badgeText = hasMixedRounding && floorUnitLabels.length > 0
    ? `新（${floorUnitLabels.join("・")}）`
    : "新";

  return (
    <span className="tenant-name-with-rounding">
      <span>{name}</span>
      {floorContracts.length > 0 && (
        <span
          className="rounding-badge rounding-floor"
          title={hasMixedRounding ? `金額の小数点以下を切捨：${floorUnitLabels.join("・")}` : "金額の小数点以下：切捨"}
        >
          {badgeText}
        </span>
      )}
    </span>
  );
}

type DataTableCell = ReactNode | {
  kind: "data-table-cell";
  content: ReactNode;
  rowSpan?: number;
  skipped?: boolean;
};

function mergedTableCell(content: ReactNode, rowSpan: number): DataTableCell {
  return { kind: "data-table-cell", content, rowSpan };
}

function skippedTableCell(): DataTableCell {
  return { kind: "data-table-cell", content: null, skipped: true };
}

function isDataTableCell(value: DataTableCell): value is Exclude<DataTableCell, ReactNode> {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "data-table-cell";
}

function DataTable({
  headers,
  groupedHeaders,
  storageKey,
  columnGroups,
  rows,
  totalRow,
}: {
  headers: string[];
  groupedHeaders?: {
    leadingCount: number;
    groups: string[];
    subheaders: string[];
  };
  storageKey?: string;
  columnGroups?: string[];
  rows: DataTableCell[][];
  totalRow?: ReactNode[];
}) {
  return (
    <div className="table-wrap">
      <ResizableTable
        className="workspace-data-table"
        storageKey={storageKey ?? `data-${headers.join("-")}`}
        columnGroups={columnGroups ?? headers.map(semanticColumnKey)}
      >
        <thead>
          <tr>
            {(groupedHeaders ? headers.slice(0, groupedHeaders.leadingCount) : headers).map((header, index) => (
              <ColumnHeader
                key={`${header}-${index}`}
                rowSpan={groupedHeaders ? 2 : undefined}
                textAlign={columnAlignment(header)}
                columnGroup={columnGroups?.[index] ?? semanticColumnKey(header)}
              >
                {header}
              </ColumnHeader>
            ))}
            {groupedHeaders?.groups.map((header, index) => (
              <ColumnHeader key={`${header}-${index}`} colSpan={2}>{header}</ColumnHeader>
            ))}
          </tr>
          {groupedHeaders && (
            <tr>
              {groupedHeaders.subheaders.map((header, index) => {
                const sourceIndex = groupedHeaders.leadingCount + index;
                const sourceHeader = headers[sourceIndex];
                return (
                  <ColumnHeader
                    key={`${header}-${index}`}
                    textAlign={columnAlignment(sourceHeader)}
                    columnGroup={columnGroups?.[sourceIndex] ?? semanticColumnKey(sourceHeader)}
                  >
                    {header}
                  </ColumnHeader>
                );
              })}
            </tr>
          )}
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((value, cell) => {
                const descriptor = isDataTableCell(value) ? value : null;
                if (descriptor?.skipped) return null;
                const content = descriptor ? descriptor.content : value as ReactNode;
                return (
                  <td
                    key={cell}
                    rowSpan={descriptor?.rowSpan}
                    className={columnAlignment(headers[cell]) === "amount" ? "numeric" : columnAlignment(headers[cell]) === "tenant" ? "tenant-cell" : ""}
                  >
                    {content}
                  </td>
                );
              })}
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td colSpan={headers.length} className="empty-cell">
                対象データがありません。
              </td>
            </tr>
          )}
        </tbody>
        {totalRow && rows.length > 0 && (
          <tfoot>
            <tr className="table-total-row">
              {totalRow.map((value, cell) => (
                <th
                  key={cell}
                  className={columnAlignment(headers[cell]) === "amount" ? "numeric" : columnAlignment(headers[cell]) === "tenant" ? "tenant-cell" : ""}
                >
                  {value}
                </th>
              ))}
            </tr>
          </tfoot>
        )}
      </ResizableTable>
    </div>
  );
}
function formatYen(value: number | null | undefined) {
  return value == null
    ? "未設定"
    : `${Number(value).toLocaleString("ja-JP")} 円`;
}

function roundUtilityAmount(
  value: number,
  mode: ContractUnit["utility_amount_rounding_mode"],
) {
  if (mode === "ceil") return Math.ceil(value);
  if (mode === "round") return Math.round(value);
  return Math.floor(value);
}

function roundToDigits(value: number, digits: number, mode: "floor" | "round" | "ceil") {
  const factor = 10 ** digits;
  if (mode === "ceil") return Math.ceil(value * factor) / factor;
  if (mode === "floor") return Math.floor(value * factor) / factor;
  return Math.round(value * factor) / factor;
}

function formatUsage(value: number, digits: number) {
  return value.toLocaleString("ja-JP", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatInputValue(value: number | null | undefined, digits: number) {
  if (value == null || !Number.isFinite(Number(value))) return "";
  return Number(value).toFixed(digits);
}

function displaySurchargeName(name: string) {
  return name === "電気増額分" ? "増額分" : name;
}

function isContractCategoryBillable(contract: ContractUnit, category: UtilityCategory) {
  if (!contract.meterBilling.length) return true;
  const key = `${category}_billable` as "electric_billable" | "water_billable" | "gas_billable";
  return contract.meterBilling.some((setting) => setting[key]);
}

function readingDigitsStorageKey(subItemId: string) {
  return `kanameter-reading-decimal-digits:${subItemId}`;
}

function getReadingDecimalDigits(subItemId: string, fallback: number) {
  const stored = Number(localStorage.getItem(readingDigitsStorageKey(subItemId)));
  return Number.isInteger(stored) && stored >= 0 && stored <= 3 ? stored : fallback;
}

function formatFloor(value: string | null | undefined) {
  return value ? value.replace(/[FＦ]$/i, "") : "—";
}

function floorSortOrder(value: string | null | undefined) {
  const floor = (value ?? "").trim().toUpperCase().replace(/[ＦF階]/g, "");
  const basement = floor.match(/^(?:B|地下)\s*(\d+)/);
  if (basement) return -Number(basement[1]);
  const aboveGround = floor.match(/-?\d+/);
  if (aboveGround) return Number(aboveGround[0]);
  if (/^(?:R|RF|屋上)$/.test(floor)) return 10000;
  return 20000;
}

function formatMeterPeriod(previousMeterDate: string, meterDate: string) {
  if (!meterDate) return "検針日を入力してください";
  if (!previousMeterDate) return `開始日未設定 ～ ${formatShortDate(meterDate)}`;
  const start = new Date(`${previousMeterDate}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() + 1);
  return `${formatShortDate(start.toISOString().slice(0, 10))} ～ ${formatShortDate(meterDate)}`;
}

function formatShortDate(value: string) {
  const [year, month, day] = value.split("-");
  return `${year}/${month}/${day}`;
}

type ColumnAlignment = "tenant" | "amount" | "center";
function columnAlignment(header: string): ColumnAlignment {
  if (header === "テナント" || header.includes("テナント名")) return "tenant";
  if (header.includes("金額") || header.includes("料") || header.includes("単価")) return "amount";
  return "center";
}

function semanticColumnKey(header: string) {
  if (header.includes("階数")) return "floor";
  if (header === "区画" || header.includes("設置区画")) return "unit";
  if (header.includes("テナント")) return "tenant";
  if (header.includes("メーター番号")) return "meter";
  if (header.includes("使用量")) return "usage";
  if (header.includes("単価")) return "price";
  if (header.includes("金額") || header.includes("基本料")) return "amount";
  return header;
}

function ColumnHeader({ children, textAlign = "center", columnGroup, className = "", ...props }: ThHTMLAttributes<HTMLTableCellElement> & { textAlign?: ColumnAlignment; columnGroup?: string }) {
  return (
    <th {...props} className={`${className} align-${textAlign}`} data-column-group={columnGroup}>
      {children}
      {columnGroup && <span className="column-resizer" aria-hidden="true" />}
    </th>
  );
}

function ResizableTable({ children, className, storageKey, columnGroups, storageUserId = "shared" }: { children: ReactNode; className: string; storageKey: string; columnGroups: string[]; storageUserId?: string }) {
  const tableRef = useRef<HTMLTableElement>(null);
  const persistenceKey = `kanameter-column-widths:${storageUserId}:${storageKey}`;
  const columnSignature = columnGroups.join("|");
  useLayoutEffect(() => {
    const table = tableRef.current;
    if (!table) return;
    try {
      const saved = JSON.parse(localStorage.getItem(persistenceKey) ?? "null") as { groupWidths?: Record<string, number> } | null;
      const columns = Array.from(table.querySelectorAll<HTMLTableColElement>("colgroup col"));
      const availableWidth = Math.max(880, table.parentElement?.getBoundingClientRect().width ?? 0, table.scrollWidth);
      const defaultColumnWidth = Math.max(72, availableWidth / Math.max(1, columns.length));
      columns.forEach((column) => {
        const group = column.dataset.columnGroup ?? "";
        const width = saved?.groupWidths?.[group] ?? defaultColumnWidth;
        column.style.width = `${width}px`;
      });
      const linkedTableWidth = columns.reduce((sum, column) => sum + (Number.parseFloat(column.style.width) || defaultColumnWidth), 0);
      if (linkedTableWidth) {
        const width = Math.max(availableWidth, linkedTableWidth);
        table.style.width = `${width}px`;
        table.style.minWidth = `${width}px`;
        table.style.maxWidth = `${width}px`;
      }
    } catch {
      localStorage.removeItem(persistenceKey);
    }
  }, [persistenceKey, columnSignature]);
  const beginResize = (event: PointerEvent<HTMLTableElement>) => {
    const handle = (event.target as HTMLElement).closest(".column-resizer");
    const header = handle?.parentElement as HTMLTableCellElement | null;
    if (!header || !tableRef.current) return;
    event.preventDefault();
    const startX = event.clientX;
    const columnGroup = header.dataset.columnGroup;
    if (!columnGroup) return;
    const linkedColumns = Array.from(tableRef.current.querySelectorAll<HTMLTableColElement>(`colgroup col[data-column-group="${columnGroup}"]`));
    if (!linkedColumns.length) return;
    const startWidth = linkedColumns[0].getBoundingClientRect().width;
    const startTableWidth = tableRef.current.getBoundingClientRect().width;
    const syncLinkedColumnWidth = (width: number) => {
      document.querySelectorAll<HTMLTableElement>("table[data-column-persistence-key]").forEach((linkedTable) => {
        if (linkedTable === tableRef.current || linkedTable.dataset.columnPersistenceKey !== persistenceKey) return;
        const column = linkedTable.querySelector<HTMLTableColElement>(`colgroup col[data-column-group="${columnGroup}"]`);
        if (!column) return;
        column.style.width = `${width}px`;
        const tableWidth = Array.from(linkedTable.querySelectorAll<HTMLTableColElement>("colgroup col"))
          .reduce((sum, item) => sum + (Number.parseFloat(item.style.width) || item.getBoundingClientRect().width), 0);
        linkedTable.style.width = `${tableWidth}px`;
        linkedTable.style.minWidth = `${tableWidth}px`;
        linkedTable.style.maxWidth = `${tableWidth}px`;
      });
    };
    handle?.setPointerCapture?.(event.pointerId);
    const move = (moveEvent: globalThis.PointerEvent) => {
      const nextWidth = Math.max(72, startWidth + moveEvent.clientX - startX);
      const widthDelta = nextWidth - startWidth;
      const nextTableWidth = Math.max(320, startTableWidth + widthDelta * linkedColumns.length);
      linkedColumns.forEach((linkedColumn) => { linkedColumn.style.width = `${nextWidth}px`; });
      syncLinkedColumnWidth(nextWidth);
      tableRef.current!.style.width = `${nextTableWidth}px`;
      tableRef.current!.style.minWidth = `${nextTableWidth}px`;
      tableRef.current!.style.maxWidth = `${nextTableWidth}px`;
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      const table = tableRef.current;
      if (table) {
        const groupWidths = Object.fromEntries(
          Array.from(table.querySelectorAll<HTMLTableColElement>("colgroup col")).map((column) => [
            column.dataset.columnGroup ?? "",
            column.getBoundingClientRect().width,
          ]),
        );
        localStorage.setItem(persistenceKey, JSON.stringify({
          groupWidths,
        }));
        document.querySelectorAll<HTMLTableElement>("table[data-column-persistence-key]").forEach((linkedTable) => {
          if (linkedTable === table || linkedTable.dataset.columnPersistenceKey !== persistenceKey) return;
          const linkedColumns = Array.from(linkedTable.querySelectorAll<HTMLTableColElement>("colgroup col"));
          linkedColumns.forEach((column) => {
            const width = groupWidths[column.dataset.columnGroup ?? ""];
            if (width) column.style.width = `${width}px`;
          });
          const linkedWidth = linkedColumns.reduce((sum, column) => sum + column.getBoundingClientRect().width, 0);
          linkedTable.style.width = `${linkedWidth}px`;
          linkedTable.style.minWidth = `${linkedWidth}px`;
          linkedTable.style.maxWidth = `${linkedWidth}px`;
        });
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };
  return (
    <table ref={tableRef} className={className} data-column-persistence-key={persistenceKey} onPointerDown={beginResize}>
      <colgroup>{columnGroups.map((group, index) => <col key={`${group}-${index}`} data-column-group={group} />)}</colgroup>
      {children}
    </table>
  );
}
