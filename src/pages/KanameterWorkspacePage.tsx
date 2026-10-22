import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type ThHTMLAttributes } from "react";
import {
  assignMeterUnit,
  confirmMeterReadingMonth,
  createMeter,
  deleteMeter,
  loadAssetUtilitySettings,
  loadBillingAssets,
  loadBillingLineItems,
  loadContractUnits,
  loadMeteringConfiguration,
  loadMeterManagement,
  loadMeterReadings,
  loadMeterUnitPriceCalculations,
  loadSurchargeEvidence,
  loadMeterUsageHistory,
  loadMeterReadingPeriod,
  loadAvailableMeterReadingMonths,
  reorderMeters,
  saveMeterParent,
  saveMeterReading,
  saveMeterReadingDate,
  saveMeterUnitPriceCalculation,
  saveSurchargeEvidence,
  saveAssetUtilitySettings,
  saveMeteringSettings,
  updateMeterSubItemDisplaySettings,
} from "../lib/meteringRepository";
import { supabase } from "../lib/supabase";
import type {
  Asset,
  AssetUtilitySetting,
  BillingLineItem,
  BillingPeriodPattern,
  ContractUnit,
  MeterCategorySetting,
  MeterReadingRow,
  MeterSubItem,
  MeterSurcharge,
  MeterUnitPriceCalculation,
  MeterUnitOption,
  TaxMode,
  UserProfile,
  UtilityCategory,
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

function adjustedMeterUsage(
  meter: MeterReadingRow,
  meters: MeterReadingRow[],
  usageFor: (row: MeterReadingRow) => number,
) {
  const ownUsage = usageFor(meter);
  if (meter.subItem.input_mode !== "reading") return ownUsage;
  const childUsage = meters
    .filter((row) => row.parent_meter_id === meter.asset_meter_id)
    .reduce((sum, row) => sum + usageFor(row), 0);
  return ownUsage - childUsage;
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

function currentMeterUsage(
  meter: MeterReadingRow,
  values: Record<string, string>,
  rolloverValues: Record<string, number>,
) {
  const raw = values[meter.asset_meter_id];
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

function billingPeriodText(
  billingMonth: string,
  pattern: BillingPeriodPattern | undefined,
  currentMeterDate: string | null | undefined,
  previousMeterDate: string | null | undefined,
) {
  if (!pattern) return "期間未設定";
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
  const format = (date: Date | null) => date
    ? `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
    : "";
  const start = format(edge(pattern.start_month_offset, pattern.start_day_type, pattern.start_meter_day_offset ?? 0));
  const end = format(edge(pattern.end_month_offset, pattern.end_day_type, pattern.end_meter_day_offset ?? 0));
  return start && end ? `${start}～${end}` : "期間未確定";
}

export function KanameterWorkspacePage({
  profile,
  onSignOut,
}: {
  profile: UserProfile;
  onSignOut: () => Promise<unknown>;
}) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetId, setAssetId] = useState("");
  const [billingMonth, setBillingMonth] = useState(currentMonth);
  const [meterDate, setMeterDate] = useState("");
  const [previousMeterDate, setPreviousMeterDate] = useState("");
  const [availableBillingMonths, setAvailableBillingMonths] = useState<Array<{ billingMonth: string; meterDate: string | null }>>([]);
  const [mainTab, setMainTab] = useState<MainTab>("summary");
  const [selectedItemId, setSelectedItemId] = useState("");
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
  const [units, setUnits] = useState<MeterUnitOption[]>([]);
  const [meterSettingsItemId, setMeterSettingsItemId] = useState<string | null>(null);
  const [unitPriceCalculatorOpen, setUnitPriceCalculatorOpen] = useState(false);
  const [calculatedUnitPrices, setCalculatedUnitPrices] = useState<Record<string, number>>({});
  const [unitPriceCalculations, setUnitPriceCalculations] = useState<Record<string, MeterUnitPriceCalculation>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [rolloverValues, setRolloverValues] = useState<Record<string, number>>({});
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
        setAssetId(rows[0]?.asset_id ?? "");
      })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
    return () => Object.values(timers.current).forEach(clearTimeout);
  }, []);

  useEffect(() => {
    if (!assetId) return;
    setLoading(true);
    setError("");
    setNotice("");
    setMainTab("summary");
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
        setCategorySettings(config.categories.map((setting) => ({
          ...setting,
          is_billable: enabledCategories.has(setting.category),
        })));
        setSubItems(config.subItems);
        const hasSurcharge = lineItems.some((item) => item.is_surcharge);
        setSurcharges(config.surcharges.map((item) => ({
          ...item,
          is_billable: item.category === "electric" && hasSurcharge,
        })));
        setPeriodPatterns(config.periodPatterns);
        setContracts(contractRows);
        setManagedMeters(management.meters);
        setUnits(management.units);
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
          const price = storedPrice ?? (evidence?.unit_price == null ? null : Number(evidence.unit_price));
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
    if (raw.trim() === "" || !Number.isFinite(Number(raw)) || Number(raw) < 0)
      return;
    setSaveStates((current) => ({
      ...current,
      [meter.asset_meter_id]: "saving",
    }));
    timers.current[meter.asset_meter_id] = setTimeout(async () => {
      try {
        const entered = Number(raw);
        const previous = Number(meter.entry?.previous_reading);
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
      await confirmMeterReadingMonth(supabase!, assetId, billingMonth);
      setStatus("confirmed");
      setNotice("KANAME連携用の確定データとして保存しました。");
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
  const selectedSubItem = categorySubItems.find(
    (item) => item.asset_meter_sub_item_id === selectedItemId,
  );
  const selectedSurcharge = categorySurcharges.find(
    (item) => item.asset_meter_surcharge_id === selectedItemId,
  );
  useEffect(() => {
    if (!selectedSubItem || selectedSubItem.price_mode === "fixed") setUnitPriceCalculatorOpen(false);
  }, [selectedSubItem?.asset_meter_sub_item_id, selectedSubItem?.price_mode]);
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
  const billableCategoryContracts = activeCategory
    ? contracts.filter((contract) => isContractCategoryBillable(contract, activeCategory))
    : contracts;
  const selectedUnitPriceTaxMode: TaxMode = selectedSubItem
    ? billableCategoryContracts.flatMap((contract) => [
        ...contract.prices.filter((price) => price.asset_billing_line_item_id === selectedSubItem.asset_billing_line_item_id),
        ...contract.categoryPrices.filter((price) => price.category === selectedSubItem.category),
      ])[0]?.tax_mode
      ?? utilitySettings.find((setting) => setting.category === selectedSubItem.category)?.default_tax_mode
      ?? "exclusive"
    : "exclusive";
  const billableCategoryUnitCodes = new Set(billableCategoryContracts.map((contract) => contract.unit?.unit_code).filter(Boolean));
  const selectCategory = (category: UtilityCategory) => {
    setMainTab(category);
    setMeterSettingsItemId(null);
    const setting = categorySettings.find((row) => row.category === category);
    const firstSubItem = subItems.find(
      (item) => item.category === category && (item.sub_item_kind !== "basic" || setting?.is_basic_billable),
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
    if (!activeCategory || meterSettingsItemId) return;
    const selectableIds = [
      ...categorySubItems.map((item) => item.asset_meter_sub_item_id),
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
  }, [activeCategory, meterSettingsItemId, selectedItemId, categorySubItems, categorySurcharges]);

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
            const items = subItems.filter((item) => item.category === category && (item.sub_item_kind !== "basic" || basicEnabled));
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
            <label className="month-picker">
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
            </label>
            <label className="meter-date-picker">
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
            </label>
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
              className="primary compact"
              disabled={confirming || status === "confirmed"}
              onClick={() => void confirm()}
            >
              {confirming
                ? "確定中…"
                : status === "confirmed"
                  ? "確定済み"
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
            contracts={contracts}
            subItems={subItems}
            surcharges={surcharges}
            surchargePrices={summarySurchargePrices}
            unitPriceCalculations={unitPriceCalculations}
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
                  {categorySubItems.map((item) => (
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
              </div>
              {selectedSubItem?.sub_item_kind === "custom" && (
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
                units={units}
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
                  />
                ) : selectedSubItem ? (
                  <CustomItemTable
                    meters={meters.filter(
                      (meter) =>
                        meter.subItem.asset_meter_sub_item_id ===
                        selectedSubItem.asset_meter_sub_item_id &&
                        (meter.is_rate_source || billableCategoryUnitCodes.has(meter.assignments[0]?.unit?.unit_code)),
                    )}
                    contracts={billableCategoryContracts}
                    category={mainTab as UtilityCategory}
                    lineItemId={selectedSubItem.asset_billing_line_item_id}
                    unitPriceOverride={calculatedUnitPrices[selectedSubItem.asset_meter_sub_item_id]}
                    values={values}
                    saveStates={saveStates}
                    confirmed={status === "confirmed"}
                    usageHistory={usageHistory}
                    rolloverValues={rolloverValues}
                    columnStorageUserId={profile.user_id}
                    onChange={queueSave}
                    onRollover={setMeterRollover}
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
          新・・・新契約書（小数点以下を切り捨て）
        </footer>
      </main>
      {unitPriceCalculatorOpen && selectedSubItem && selectedSubItem.price_mode !== "fixed" && (
        <VariableUnitPriceCalculator
          itemName={selectedSubItem.sub_item_name}
          taxMode={selectedUnitPriceTaxMode}
          priceMode={selectedSubItem.price_mode}
          initialCalculation={unitPriceCalculations[selectedSubItem.asset_meter_sub_item_id]}
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
    return stored.unitPrice == null || !Number.isFinite(Number(stored.unitPrice)) ? null : Number(stored.unitPrice);
  } catch {
    return null;
  }
}

function VariableUnitPriceCalculator({
  itemName,
  taxMode,
  priceMode,
  initialCalculation,
  rateSourceMeters,
  onSave,
  onClose,
}: {
  itemName: string;
  taxMode: TaxMode;
  priceMode: "amount" | "master_meter";
  initialCalculation?: MeterUnitPriceCalculation;
  rateSourceMeters: Array<{ id: string; label: string; usage: number }>;
  onSave: (calculation: MeterUnitPriceCalculation) => Promise<void>;
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
  const grossAmount = evaluateAdditionExpression(grossExpression);
  const automaticTaxAmount = grossAmount == null ? null : Math.floor(grossAmount * 10 / 110);
  const enteredTaxAmount = evaluateAdditionExpression(taxExpression);
  const selectedRateSource = rateSourceMeters.find((meter) => meter.id === rateSourceMeterId);
  const tariff = priceMode === "master_meter" && selectedRateSource
    ? calculateOsakaGeneralWaterTariff(selectedRateSource.usage)
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
    if (calculatedUnitPrice == null) return;
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
        tariff_code: priceMode === "master_meter" ? OSAKA_GENERAL_WATER_TARIFF_CODE : null,
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

  const moveToNextInput = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    const inputs = Array.from(event.currentTarget.querySelectorAll("input"));
    const currentIndex = inputs.indexOf(event.target as HTMLInputElement);
    if (currentIndex < 0 || currentIndex >= inputs.length - 1) return;
    event.preventDefault();
    inputs[currentIndex + 1].focus();
  };

  return (
    <div className="calculator-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="calculator-modal" role="dialog" aria-modal="true" aria-labelledby="unit-price-calculator-title" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <p className="eyebrow">UNIT PRICE</p>
            <h2 id="unit-price-calculator-title">{itemName}の単価計算</h2>
          </div>
          <button type="button" className="calculator-modal-close" aria-label="閉じる" onClick={onClose}>×</button>
        </header>
        <div className="calculator-tax-mode">
          適用する税区分：<strong>{taxMode === "inclusive" ? "税込" : "税抜"}</strong>
        </div>
        {priceMode === "master_meter" ? (
          <div className="calculator-fields">
            <label>
              <span>大元メーター</span>
              <select value={rateSourceMeterId} onChange={(event) => setRateSourceMeterId(event.target.value)}>
                {rateSourceMeters.length === 0 && <option value="">メーター設定で大元メーターを登録してください</option>}
                {rateSourceMeters.map((meter) => <option key={meter.id} value={meter.id}>{meter.label}</option>)}
              </select>
            </label>
            <div className="calculator-result-field"><span>料金表</span><strong>大阪市・一般用・1か月</strong></div>
            <div className="calculator-result-field"><span>計算使用量</span><strong>{tariff ? `${tariff.billedUsage.toLocaleString("ja-JP")} m³` : "—"}</strong></div>
            <div className="calculator-result-field"><span>上水道料金（税込）</span><strong>{tariff ? formatYen(tariff.waterGross) : "—"}</strong></div>
            <div className="calculator-result-field"><span>下水道使用料（税込）</span><strong>{tariff ? formatYen(tariff.sewerGross) : "—"}</strong></div>
            <div className="calculator-result-field"><span>合計金額（税込）</span><strong>{tariff ? formatYen(tariff.totalGross) : "—"}</strong></div>
            <div className="calculator-result-field"><span>消費税額</span><strong>{tariff ? formatYen(tariff.tax) : "—"}</strong></div>
            <details className="tariff-details">
              <summary>段階料金表と計算方法を確認</summary>
              <p>使用量は小数点以下を切り捨てます。該当段階の「単価 × 使用量 − 控除額」で税抜額を求め、上水道・下水道をそれぞれ10%税込にして合算します。</p>
              <div className="tariff-tables">
                <TariffTable title="上水道料金" tiers={osakaGeneralWaterTiers} />
                <TariffTable title="下水道使用料" tiers={osakaGeneralSewerTiers} />
              </div>
              <small>料金表：大阪市 一般用・1か月（令和元年11月1日適用）</small>
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
        <footer>
          <button type="button" onClick={onClose}>閉じる</button>
          <button type="button" className="primary" disabled={saving || calculatedUnitPrice == null} onClick={() => void save()}>{saving ? "保存中…" : "保存して閉じる"}</button>
        </footer>
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
  columnStorageUserId: string;
}) {
  const eligibleContracts = contracts.filter((row) => (row.unit?.unit_type ?? "").toLowerCase() !== "parking");
  const categoryColumns = categories.map((category) => {
    const setting = categorySettings.find((row) => row.category === category);
    const basic = setting?.is_basic_billable ? subItems.find((item) => item.category === category && item.sub_item_kind === "basic") : undefined;
    const custom = subItems.filter((item) => item.category === category && item.sub_item_kind === "custom");
    const surcharge = category === "electric" ? surcharges.find((item) => item.category === category && item.is_billable) : undefined;
    return { category, enabled: !!setting?.is_billable, basic, custom, surcharge, showTotal: custom.length > 1 };
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
    const price = calculatedPrice ?? itemPrice?.unit_price ?? categoryPrice?.unit_price;
    return price == null ? null : Number(price);
  };
  const calculationForContracts = (billableContracts: ContractUnit[], item: MeterSubItem) => {
    const contractByUnitCode = new Map(
      billableContracts.flatMap((contract) => contract.unit?.unit_code ? [[contract.unit.unit_code, contract] as const] : []),
    );
    const chargeRows = meters.flatMap((meter) => {
      if (meter.subItem.asset_meter_sub_item_id !== item.asset_meter_sub_item_id) return [];
      const unitCode = meter.assignments[0]?.unit?.unit_code;
      const contract = unitCode ? contractByUnitCode.get(unitCode) : undefined;
      if (!contract) return [];
      return [{
        meterId: meter.asset_meter_id,
        usage: adjustedMeterUsage(meter, meters, storedMeterUsage),
        price: priceForContractItem(contract, item),
      }];
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
      const basicAmount = group.basic ? billableContracts.reduce((sum, contract) => sum + Number(contract.basics.find((row) => row.category === group.category)?.amount ?? 0), 0) : null;
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
      units: tenantContracts.map((row) => row.unit?.unit_name || row.unit?.unit_code).filter(Boolean).join("・") || "—",
      groups,
      total: groups.reduce((sum, group) => sum + group.total + (group.surchargeAmount ?? 0), 0),
    };
  });
  const summaryColumnGroups = [
    "summary-tenant",
    "summary-unit",
    ...categoryColumns.flatMap((group) => [
      ...(group.basic ? ["summary-amount"] : []),
      ...group.custom.flatMap(() => ["summary-usage", "summary-amount"]),
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
              <ColumnHeader rowSpan={3} columnGroup="summary-unit">区画</ColumnHeader>
              {categoryColumns.flatMap((group) => [
                <th className={`summary-category utility-${group.category}`} colSpan={(group.basic ? 1 : 0) + group.custom.length * 2 + (group.showTotal ? 2 : 0)} key={group.category}>{labels[group.category]}</th>,
                ...(group.surcharge ? [<ColumnHeader rowSpan={3} textAlign="amount" columnGroup="summary-amount" className="summary-surcharge" key={`${group.category}-surcharge-top`}>電気代<br />増額分</ColumnHeader>] : []),
              ])}
              <ColumnHeader rowSpan={3} textAlign="amount" columnGroup="summary-amount">合計請求額</ColumnHeader>
            </tr>
            <tr>{categoryColumns.flatMap((group) => [
              ...(group.basic ? [<ColumnHeader className={`summary-subhead utility-${group.category}`} rowSpan={2} textAlign="amount" columnGroup="summary-amount" key={`${group.category}-basic`}>基本料</ColumnHeader>] : []),
              ...group.custom.flatMap((item) => group.custom.length === 1
                ? [<ColumnHeader className={`summary-subhead utility-${group.category}`} rowSpan={2} columnGroup="summary-usage" key={`${item.asset_meter_sub_item_id}-usage-direct`}>使用量</ColumnHeader>, <ColumnHeader className={`summary-subhead utility-${group.category}`} rowSpan={2} textAlign="amount" columnGroup="summary-amount" key={`${item.asset_meter_sub_item_id}-amount-direct`}>金額</ColumnHeader>]
                : [<th className={`summary-subhead utility-${group.category}`} colSpan={2} key={item.asset_meter_sub_item_id}>{item.sub_item_name}</th>]),
              ...(group.showTotal ? [<th className={`summary-subhead utility-${group.category}`} colSpan={2} key={`${group.category}-total`}>{labels[group.category]}合計</th>] : []),
            ])}</tr>
            <tr>{categoryColumns.flatMap((group) => group.custom.length > 1 ? [
              ...group.custom.flatMap((item) => [<ColumnHeader className={`summary-subhead utility-${group.category}`} columnGroup="summary-usage" key={`${item.asset_meter_sub_item_id}-usage`}>使用量</ColumnHeader>, <ColumnHeader className={`summary-subhead utility-${group.category}`} textAlign="amount" columnGroup="summary-amount" key={`${item.asset_meter_sub_item_id}-amount`}>金額</ColumnHeader>]),
              <ColumnHeader className={`summary-subhead utility-${group.category}`} columnGroup="summary-usage" key={`${group.category}-total-usage`}>使用量</ColumnHeader>,
              <ColumnHeader className={`summary-subhead utility-${group.category}`} textAlign="amount" columnGroup="summary-amount" key={`${group.category}-total-amount`}>金額</ColumnHeader>,
            ] : [])}</tr>
          </thead>
          <tbody>
            {summaryRows.map((row) => (
              <tr key={row.tenantId}>
                <td><TenantNameWithRounding name={row.tenantName} contracts={row.tenantContracts} /></td>
                <td className="summary-unit-cell">{row.units}</td>
                {row.groups.flatMap((group, groupIndex) => [
                  ...(group.basicAmount != null ? [<td className={`numeric ${group.enabled ? "" : "summary-disabled-cell"}`} key={`${groupIndex}-basic`}>{group.enabled ? formatYen(group.basicAmount) : null}</td>] : []),
                  ...group.custom.flatMap((item, itemIndex) => [<td className={`numeric ${group.enabled ? "" : "summary-disabled-cell"}`} key={`${groupIndex}-${itemIndex}-usage`}>{group.enabled ? formatUsage(item.usage, categoryColumns[groupIndex].custom[itemIndex].aggregation_decimal_digits) : null}</td>, <td className={`numeric ${group.enabled ? "" : "summary-disabled-cell"}`} key={`${groupIndex}-${itemIndex}-amount`}>{group.enabled ? formatYen(item.amount) : null}</td>]),
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
                ...group.custom.flatMap((item, itemIndex) => [<th className="numeric" key={`${item.asset_meter_sub_item_id}-usage`}>{formatUsage(summaryRows.reduce((sum, row) => sum + row.groups[groupIndex].custom[itemIndex].usage, 0), item.aggregation_decimal_digits)}</th>, <th className="numeric" key={`${item.asset_meter_sub_item_id}-amount`}>{formatYen(summaryRows.reduce((sum, row) => sum + row.groups[groupIndex].custom[itemIndex].amount, 0))}</th>]),
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
  units,
  onChanged,
  onSubItemSettingsChanged,
  onNotice,
  onError,
  lockedSubItemId,
}: {
  assetId: string;
  subItems: MeterSubItem[];
  meters: MeterReadingRow[];
  units: MeterUnitOption[];
  onChanged: () => Promise<void>;
  onSubItemSettingsChanged: (subItem: MeterSubItem) => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
  lockedSubItemId?: string;
}) {
  const [subItemId, setSubItemId] = useState(lockedSubItemId ?? "");
  const [meterCode, setMeterCode] = useState("");
  const [unitId, setUnitId] = useState("");
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
  const [draggingMeterId, setDraggingMeterId] = useState<string | null>(null);
  useEffect(() => setOrderedMeters(meters), [meters]);
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
    if (unitId !== rateSourceUnitValue && !units.some((unit) => unit.unit_id === unitId))
      setUnitId(units[0]?.unit_id ?? "");
  }, [subItems, units, subItemId, unitId, lockedSubItemId]);

  const add = async () => {
    if (!subItemId || !unitId || !meterCode.trim()) return;
    setSaving(true);
    onError("");
    try {
      await createMeter(supabase!, assetId, subItemId, meterCode, unitId === rateSourceUnitValue ? null : unitId);
      await onChanged();
      setMeterCode("");
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
    onError("");
    try {
      await assignMeterUnit(supabase!, meterId, nextUnitId === rateSourceUnitValue ? null : nextUnitId);
      await onChanged();
      onNotice("メーターの区画を変更しました。");
    } catch (reason) {
      onError((reason as Error).message);
    }
  };
  const changeParent = async (meterId: string, parentMeterId: string) => {
    onError("");
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
    if (!window.confirm(`メーター「${meter.meter_code}」を削除しますか？`)) return;
    onError("");
    try {
      await deleteMeter(supabase!, meter.asset_meter_id);
      await onChanged();
      onNotice("メーターを削除しました。");
    } catch (reason) {
      onError((reason as Error).message);
    }
  };
  const moveMeter = async (targetMeterId: string) => {
    if (!draggingMeterId || draggingMeterId === targetMeterId || !lockedSubItemId) return;
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
    const today = new Date().toISOString().slice(0, 10);
    return [...meter.assignments]
      .filter(
        (row) =>
          row.effective_from <= today &&
          (!row.effective_to || row.effective_to >= today),
      )
      .sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0];
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

  return (
    <section className="meter-settings">
      <div className="meter-display-settings">
        <label>データ入力方法<select value={inputMode} onChange={(event) => setInputMode(event.target.value as "usage" | "reading")}><option value="reading">読取値を入力</option><option value="usage">使用量を入力</option></select></label>
        <label className={inputMode === "usage" ? "disabled-setting" : ""}>検針値入力表示桁数<input type="number" min={0} max={3} step={1} value={readingDecimalDigits} disabled={inputMode === "usage"} onChange={(event) => setReadingDecimalDigits(Math.min(3, Math.max(0, Number(event.target.value))))} /></label>
        <label>使用量入力桁数<input type="number" min={0} max={3} step={1} value={inputDecimalDigits} onChange={(event) => setInputDecimalDigits(Math.min(3, Math.max(0, Number(event.target.value))))} /></label>
        <label>使用量集計桁数<input type="number" min={0} max={3} step={1} value={aggregationDecimalDigits} onChange={(event) => setAggregationDecimalDigits(Math.min(3, Math.max(0, Number(event.target.value))))} /></label>
        <label>使用量の小数点処理<select value={usageRoundingMode} onChange={(event) => setUsageRoundingMode(event.target.value as "floor" | "round" | "ceil")}><option value="ceil">切り上げ</option><option value="round">四捨五入</option><option value="floor">切り捨て</option></select></label>
        <button type="button" className="primary compact" disabled={saving} onClick={() => void saveDisplaySettings()}>{saving ? "保存中…" : "設定を保存"}</button>
      </div>
      <div className="table-wrap">
        <ResizableTable className="workspace-data-table meter-settings-table" storageKey="meter-settings-common" columnGroups={["drag", "category", "sub-item", "meter", "unit", "parent-meter", "action"]}>
          <thead><tr><ColumnHeader columnGroup="drag" /><ColumnHeader columnGroup="category">分類</ColumnHeader><ColumnHeader columnGroup="sub-item">小分類</ColumnHeader><ColumnHeader columnGroup="meter">メーター番号</ColumnHeader><ColumnHeader columnGroup="unit">設置区画</ColumnHeader><ColumnHeader columnGroup="parent-meter">親メーター</ColumnHeader><ColumnHeader columnGroup="action" /></tr></thead>
          <tbody>
            {orderedMeters.map((meter) => {
              const assignment = activeAssignment(meter);
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
                  <td><strong>{meter.parent_meter_id && <span className="child-meter-mark">↳ 子</span>}{meter.meter_code}</strong></td>
                  <td>
                    <select value={meter.is_rate_source ? rateSourceUnitValue : assignment?.unit_id ?? ""} onChange={(event) => void changeUnit(meter.asset_meter_id, event.target.value)}>
                      <option value="" disabled>区画を選択</option>
                      <option value={rateSourceUnitValue}>大元メーター</option>
                      {units.map((unit) => (
                        <option key={unit.unit_id} value={unit.unit_id}>
                          {formatFloor(unit.floor_label)} / {unit.unit_name || unit.unit_code}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    {inputMode === "reading" && !meter.is_rate_source ? (
                      <select value={meter.parent_meter_id ?? ""} onChange={(event) => void changeParent(meter.asset_meter_id, event.target.value)}>
                        <option value="">なし（親として集計）</option>
                        {orderedMeters
                          .filter((candidate) =>
                            !candidate.is_rate_source &&
                            candidate.asset_meter_id !== meter.asset_meter_id &&
                            !wouldCreateParentCycle(meter.asset_meter_id, candidate.asset_meter_id)
                          )
                          .map((candidate) => (
                            <option key={candidate.asset_meter_id} value={candidate.asset_meter_id}>
                              {candidate.meter_code} / {candidate.assignments[0]?.unit?.unit_name || candidate.assignments[0]?.unit?.unit_code || "区画未設定"}
                            </option>
                          ))}
                      </select>
                    ) : (
                      <span className="muted-setting">検針値入力時のみ</span>
                    )}
                  </td>
                  <td><button className="danger-text" onClick={() => void remove(meter)}>削除</button></td>
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
        <label>メーター番号<input value={meterCode} onChange={(event) => setMeterCode(event.target.value)} /></label>
        <label>区画<select value={unitId} onChange={(event) => setUnitId(event.target.value)}><option value={rateSourceUnitValue}>大元メーター</option>{units.map((unit) => <option key={unit.unit_id} value={unit.unit_id}>{formatFloor(unit.floor_label)} / {unit.unit_name || unit.unit_code}</option>)}</select></label>
        <button className="primary compact" disabled={saving || !subItemId || !unitId || !meterCode.trim()} onClick={() => void add()}>{saving ? "追加中…" : "追加"}</button>
      </div>
    </section>
  );
}
function BasicChargeTable({
  contracts,
  category,
}: {
  contracts: ContractUnit[];
  category: UtilityCategory;
}) {
  const eligibleContracts = contracts.filter((row) =>
    ["office", "warehouse", "storage"].includes(row.unit?.unit_type ?? ""),
  );
  const totalAmount = eligibleContracts.reduce(
    (total, row) =>
      total + Number(row.basics.find((item) => item.category === category)?.amount ?? 0),
    0,
  );

  return (
    <DataTable
      headers={["階数", "区画", "テナント名", "基本料"]}
      rows={eligibleContracts.map((row) => [
        formatFloor(row.unit?.floor_label),
        row.unit?.unit_name || row.unit?.unit_code || "—",
        <TenantNameWithRounding
          name={row.contract?.tenant?.tenant_name ?? "—"}
          contracts={[row]}
        />,
        formatYen(
          row.basics.find((item) => item.category === category)?.amount,
        ),
      ])}
      totalRow={["合計", "", "", formatYen(totalAmount)]}
    />
  );
}
function CustomItemTable({
  meters,
  contracts,
  category,
  lineItemId,
  unitPriceOverride,
  values,
  saveStates,
  confirmed,
  usageHistory,
  rolloverValues,
  columnStorageUserId,
  onChange,
  onRollover,
}: {
  meters: MeterReadingRow[];
  contracts: ContractUnit[];
  category: UtilityCategory;
  lineItemId: string | null;
  unitPriceOverride?: number;
  values: Record<string, string>;
  saveStates: Record<string, SaveState>;
  confirmed: boolean;
  usageHistory: {
    previous: Record<string, number>;
    previousYear: Record<string, number>;
  };
  rolloverValues: Record<string, number>;
  columnStorageUserId: string;
  onChange: (meter: MeterReadingRow, value: string) => void;
  onRollover: (meter: MeterReadingRow, rolloverValue: number | null) => void;
}) {
  const unitKey = (meter: MeterReadingRow) =>
    meter.assignments[0]?.unit_id ?? `unassigned-${meter.asset_meter_id}`;
  const contractFor = (meter: MeterReadingRow) =>
    contracts.find(
      (contract) =>
        contract.unit?.unit_code === meter.assignments[0]?.unit?.unit_code,
    );
  const billingKey = (meter: MeterReadingRow) =>
    contractFor(meter)
      ? billingGroupKey(contractFor(meter))
      : `unassigned-${meter.asset_meter_id}`;
  const tenantKey = (meter: MeterReadingRow) =>
    contractFor(meter)?.contract?.tenant_id ?? `unassigned-${meter.asset_meter_id}`;
  const rawMeterUsage = (meter: MeterReadingRow) => {
    const raw = values[meter.asset_meter_id];
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
  const meterUsage = (meter: MeterReadingRow) => adjustedMeterUsage(meter, meters, rawMeterUsage);
  const inputMode = meters[0]?.subItem.input_mode ?? "usage";
  const showReadings = inputMode === "reading";
  const comparisonRatio = (current: number, comparison: number | undefined) =>
    comparison == null || comparison === 0 ? null : (current / comparison) * 100;
  const unitPrice = (meter: MeterReadingRow) => {
    if (unitPriceOverride != null) return unitPriceOverride;
    const contract = contractFor(meter);
    return (
      contract?.prices.find(
        (item) => item.asset_billing_line_item_id === lineItemId,
      )?.unit_price ??
      contract?.categoryPrices.find((item) => item.category === category)
        ?.unit_price ??
      null
    );
  };
  const contractOrder = new Map(
    contracts.map((contract, index) => [contract.unit?.unit_code, index]),
  );
  const orderedMeters = [...meters].sort((left, right) => {
    const leftUnit = left.assignments[0]?.unit;
    const rightUnit = right.assignments[0]?.unit;
    return (
      (contractOrder.get(leftUnit?.unit_code) ?? Number.MAX_SAFE_INTEGER) -
        (contractOrder.get(rightUnit?.unit_code) ?? Number.MAX_SAFE_INTEGER) ||
      (leftUnit?.floor_label ?? "").localeCompare(rightUnit?.floor_label ?? "", "ja-JP", { numeric: true }) ||
      (leftUnit?.unit_code ?? "").localeCompare(rightUnit?.unit_code ?? "", "ja-JP", { numeric: true }) ||
      left.sort_order - right.sort_order ||
      left.meter_code.localeCompare(right.meter_code, "ja-JP", { numeric: true })
    );
  });
  const rankedUnitPrices = Array.from(new Set(
    orderedMeters.map((meter) => unitPrice(meter)).filter((price): price is number => price != null),
  )).sort((left, right) => right - left);
  const unitPriceClass = (price: number | null) => {
    if (price == null) return "unit-price-unset";
    const rank = rankedUnitPrices.indexOf(price);
    return rank >= 0 && rank < 3 ? `unit-price-rank-${rank + 1}` : "";
  };
  const tenantGroups = Array.from(new Map(
    orderedMeters.map((meter) => [tenantKey(meter), orderedMeters.filter((row) => tenantKey(row) === tenantKey(meter))]),
  ).values());
  const billingGroups = Array.from(new Map(
    orderedMeters.map((meter) => [billingKey(meter), orderedMeters.filter((row) => billingKey(row) === billingKey(meter))]),
  ).values());
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
  const totalMeterUsage = orderedMeters.reduce((sum, meter) => sum + roundToDigits(
    meterUsage(meter),
    showReadings ? meter.subItem.aggregation_decimal_digits : meter.subItem.input_decimal_digits,
    meter.subItem.usage_rounding_mode,
  ), 0);
  const displayedBillingGroups = billingGroups.flatMap(displayGroupsForBilling);
  const totalUnitUsage = displayedBillingGroups.reduce((sum, group) => sum + chargeForMeters(group).usage, 0);
  const totalAmount = displayedBillingGroups.reduce((sum, group) => sum + chargeForMeters(group).amount, 0);
  const totalTenantUsage = tenantGroups.reduce((sum, group) => sum + displayedUsageForTenant(group), 0);
  const previousUsageFor = (meter: MeterReadingRow) => usageHistory.previous[meter.asset_meter_id] ?? 0;
  const previousYearUsageFor = (meter: MeterReadingRow) => usageHistory.previousYear[meter.asset_meter_id] ?? 0;
  const totalPreviousUsage = orderedMeters.reduce((sum, meter) => sum + roundToDigits(
    adjustedMeterUsage(meter, meters, previousUsageFor),
    meter.subItem.aggregation_decimal_digits,
    meter.subItem.usage_rounding_mode,
  ), 0);
  const totalPreviousYearUsage = orderedMeters.reduce((sum, meter) => sum + roundToDigits(
    adjustedMeterUsage(meter, meters, previousYearUsageFor),
    meter.subItem.aggregation_decimal_digits,
    meter.subItem.usage_rounding_mode,
  ), 0);
  const totalPreviousReading = orderedMeters.reduce((sum, meter) => sum + roundToDigits(
    Number(meter.entry?.previous_reading ?? 0),
    getReadingDecimalDigits(meter.subItem.asset_meter_sub_item_id, meter.subItem.input_decimal_digits),
    "round",
  ), 0);
  const totalCurrentReading = orderedMeters.reduce((sum, meter) => sum + Number(values[meter.asset_meter_id] || meter.entry?.current_reading || 0), 0);
  const inputTotalDigits = orderedMeters[0]?.subItem.input_decimal_digits ?? 1;
  const aggregationTotalDigits = orderedMeters[0]?.subItem.aggregation_decimal_digits ?? 1;
  return (
    <div className="table-wrap">
      <ResizableTable className="workspace-data-table" storageKey={`readings-${showReadings ? "reading" : "usage"}`} storageUserId={columnStorageUserId} columnGroups={[
        "floor", "unit", "tenant", "meter", "price",
        ...(showReadings ? ["reading", "reading"] : []),
        "usage", "usage", "amount", "usage", "amount",
        "usage", "comparison", "usage", "comparison",
      ]}>
        <thead>
          <tr>
            <ColumnHeader rowSpan={2} columnGroup="floor">階数</ColumnHeader>
            <ColumnHeader rowSpan={2} columnGroup="unit">区画</ColumnHeader>
            <ColumnHeader rowSpan={2} textAlign="tenant" columnGroup="tenant">テナント名</ColumnHeader>
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
            const currentUnitKey = unitKey(meter);
            const firstInUnit = index === 0 || unitKey(orderedMeters[index - 1]) !== currentUnitKey;
            const lastInUnit = index === orderedMeters.length - 1 || unitKey(orderedMeters[index + 1]) !== currentUnitKey;
            const unitMeterCount = orderedMeters.filter((row) => unitKey(row) === currentUnitKey).length;
            const currentTenantKey = tenantKey(meter);
            const firstInTenant = index === 0 || tenantKey(orderedMeters[index - 1]) !== currentTenantKey;
            const lastInTenant = index === orderedMeters.length - 1 || tenantKey(orderedMeters[index + 1]) !== currentTenantKey;
            const tenantMeters = orderedMeters.filter((row) => tenantKey(row) === currentTenantKey);
            const currentBillingKey = billingKey(meter);
            const firstInBillingGroup = index === 0 || billingKey(orderedMeters[index - 1]) !== currentBillingKey;
            const billingMeters = orderedMeters.filter((row) => billingKey(row) === currentBillingKey);
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
            const unitUsageRaw = orderedMeters
              .filter(
                (row) =>
                  row.assignments[0]?.unit_id &&
                  row.assignments[0]?.unit_id === meter.assignments[0]?.unit_id,
              )
              .reduce((sum, row) => {
                return sum + meterUsage(row);
              }, 0);
            const unitUsage = roundToDigits(unitUsageRaw, aggregationDigits, usageRoundingMode);
            const unitAmount =
              contract && price != null
                ? roundUtilityAmount(
                    unitUsage * Number(price),
                    contract.utility_amount_rounding_mode,
                  )
                : null;
            const tenantUsage = displayedUsageForTenant(tenantMeters);
            const billingUsage = chargeForMeters(billingMeters).usage;
            const billingAmount = chargeForMeters(billingMeters).amount;
            const tenantAmount = Array.from(new Map(
              tenantMeters.map((tenantMeter) => [billingKey(tenantMeter), tenantMeters.filter((row) => billingKey(row) === billingKey(tenantMeter))]),
            ).values()).reduce((sum, group) => sum + chargeForMeters(group).amount, 0);
            const previousUsage = usageHistory.previous[meter.asset_meter_id] == null
              ? undefined
              : adjustedMeterUsage(meter, meters, previousUsageFor);
            const previousYearUsage = usageHistory.previousYear[meter.asset_meter_id] == null
              ? undefined
              : adjustedMeterUsage(meter, meters, previousYearUsageFor);
            const currentUsage = meterUsage(meter);
            const enteredRaw = values[meter.asset_meter_id];
            const enteredReading = Number(enteredRaw);
            const previousReading = Number(meter.entry?.previous_reading);
            const rolloverCandidate = showReadings && meter.entry?.previous_reading != null && enteredRaw?.trim() !== "" && Number.isFinite(enteredReading) && Number.isFinite(previousReading) && enteredReading < previousReading;
            const rolloverValue = rolloverValues[meter.asset_meter_id];
            return (
              <tr key={meter.asset_meter_id} className={`${firstInUnit ? "unit-group-start" : ""} ${lastInUnit ? "unit-group-end" : ""} ${firstInTenant ? "tenant-group-start" : ""} ${lastInTenant ? "tenant-group-end" : ""}`}>
                {firstInUnit && (
                  <>
                    <td className={`floor-identity ${unitEndsTenant ? "tenant-boundary" : ""}`} rowSpan={unitMeterCount}><span className="merged-value">{formatFloor(unit?.floor_label)}</span></td>
                    <td className={`unit-identity ${unitEndsTenant ? "tenant-boundary" : ""}`} rowSpan={unitMeterCount}><span className="merged-value">{meter.is_rate_source ? "大元メーター" : unit?.unit_name || unit?.unit_code || "未割当"}</span></td>
                  </>
                )}
                {firstInTenant && (
                  <td className="tenant-cell tenant-identity" rowSpan={tenantMeters.length}>
                    <span className="merged-value">
                      <TenantNameWithRounding
                        name={contract?.contract?.tenant?.tenant_name ?? "—"}
                        contracts={tenantMeters.map((tenantMeter) => contractFor(tenantMeter)).filter((item): item is ContractUnit => Boolean(item))}
                      />
                    </span>
                  </td>
                )}
                <td><strong>{meter.parent_meter_id && <span className="child-meter-mark">↳ 子</span>}{meter.meter_code}</strong></td>
                <td className={`numeric unit-price-cell ${unitPriceClass(price)}`}>{formatYen(price)}</td>
                {showReadings && (
                  <td className="numeric reading-value">
                    {meter.entry?.previous_reading == null ? "—" : formatUsage(Number(meter.entry.previous_reading), getReadingDecimalDigits(meter.subItem.asset_meter_sub_item_id, meter.subItem.input_decimal_digits))}
                  </td>
                )}
                <td>
                  <div className="input-with-state">
                    <input
                      className="reading-input"
                      inputMode="decimal"
                      disabled={confirmed}
                      value={values[meter.asset_meter_id] ?? ""}
                      onChange={(event) => onChange(meter, event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        const inputs = Array.from(
                          event.currentTarget
                            .closest("table")
                            ?.querySelectorAll<HTMLInputElement>("input.reading-input:not(:disabled)") ?? [],
                        );
                        const currentIndex = inputs.indexOf(event.currentTarget);
                        inputs[currentIndex + 1]?.focus();
                        inputs[currentIndex + 1]?.select();
                      }}
                    />
                    {state === "error" && <span className="save-error" title="保存エラー" />}
                    {rolloverCandidate && (
                      <div className={`rollover-notice ${rolloverValue ? "resolved" : ""}`}>
                        <span>{rolloverValue ? `一周処理済み（${rolloverValue.toLocaleString("ja-JP")}）` : "当月値が前月値を下回っています"}</span>
                        <button
                          type="button"
                          disabled={confirmed}
                          onClick={() => {
                            if (rolloverValue) {
                              onRollover(meter, null);
                              return;
                            }
                            const suggestedDigits = Math.max(1, String(Math.trunc(previousReading)).replace("-", "").length);
                            const suggestedValue = 10 ** suggestedDigits;
                            const answer = window.prompt("一周する値を入力してください（例：4桁メーターは10000）", String(suggestedValue));
                            if (answer == null) return;
                            const nextValue = Number(answer.replace(/,/g, ""));
                            if (!Number.isFinite(nextValue) || nextValue <= previousReading || nextValue <= enteredReading) {
                              window.alert("一周する値は、前月値と当月値より大きい数値を入力してください。");
                              return;
                            }
                            onRollover(meter, nextValue);
                          }}
                        >
                          {rolloverValue ? "一周処理を解除" : "一周として処理"}
                        </button>
                      </div>
                    )}
                  </div>
                </td>
                {showReadings && (
                  <td className="numeric meter-usage">
                    <strong>{formatUsage(currentUsage, aggregationDigits)}</strong>
                  </td>
                )}
                {aggregateBilling && firstInBillingGroup ? (
                  <td className="numeric unit-total tenant-boundary" rowSpan={billingMeters.length}>
                    <span className="merged-value">{formatUsage(billingUsage, aggregationDigits)}</span>
                  </td>
                ) : !aggregateBilling && firstInUnit ? (
                  <td className={`numeric unit-total ${unitEndsTenant ? "tenant-boundary" : ""}`} rowSpan={unitMeterCount}>
                    <span className="merged-value">{unit ? formatUsage(unitUsage, aggregationDigits) : "—"}</span>
                  </td>
                ) : null}
                {aggregateBilling && firstInBillingGroup ? (
                  <td className="numeric unit-amount tenant-boundary" rowSpan={billingMeters.length}>
                    <span className="merged-value">{formatYen(billingAmount)}</span>
                  </td>
                ) : !aggregateBilling && firstInUnit ? (
                  <td className={`numeric unit-amount ${unitEndsTenant ? "tenant-boundary" : ""}`} rowSpan={unitMeterCount}>
                    <span className="merged-value">{unitAmount == null ? "未設定" : formatYen(unitAmount)}</span>
                  </td>
                ) : null}
                {firstInTenant && (
                  <>
                    <td className="numeric tenant-total" rowSpan={tenantMeters.length}><span className="merged-value">{formatUsage(tenantUsage, aggregationDigits)}</span></td>
                    <td className="numeric tenant-total" rowSpan={tenantMeters.length}><span className="merged-value">{formatYen(tenantAmount)}</span></td>
                  </>
                )}
                <td className="numeric">{previousUsage == null ? "—" : formatUsage(previousUsage, aggregationDigits)}</td>
                <td className="numeric">{formatComparison(comparisonRatio(currentUsage, previousUsage))}</td>
                <td className="numeric">{previousYearUsage == null ? "—" : formatUsage(previousYearUsage, aggregationDigits)}</td>
                <td className="numeric">{formatComparison(comparisonRatio(currentUsage, previousYearUsage))}</td>
              </tr>
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
            <tr className="table-total-row">
              <th colSpan={4}>合計</th>
              <th>—</th>
              {showReadings && <><th className="numeric">{formatUsage(totalPreviousReading, getReadingDecimalDigits(orderedMeters[0].subItem.asset_meter_sub_item_id, orderedMeters[0].subItem.input_decimal_digits))}</th><th className="numeric">{formatUsage(totalCurrentReading, getReadingDecimalDigits(orderedMeters[0].subItem.asset_meter_sub_item_id, orderedMeters[0].subItem.input_decimal_digits))}</th></>}
              <th className="numeric">{formatUsage(totalMeterUsage, showReadings ? aggregationTotalDigits : inputTotalDigits)}</th>
              <th className="numeric">{formatUsage(totalUnitUsage, aggregationTotalDigits)}</th>
              <th className="numeric">{formatYen(totalAmount)}</th>
              <th className="numeric">{formatUsage(totalTenantUsage, aggregationTotalDigits)}</th>
              <th className="numeric">{formatYen(totalAmount)}</th>
              <th className="numeric">{formatUsage(totalPreviousUsage, aggregationTotalDigits)}</th>
              <th className="numeric">{formatComparison(comparisonRatio(totalMeterUsage, totalPreviousUsage))}</th>
              <th className="numeric">{formatUsage(totalPreviousYearUsage, aggregationTotalDigits)}</th>
              <th className="numeric">{formatComparison(comparisonRatio(totalMeterUsage, totalPreviousYearUsage))}</th>
            </tr>
          </tfoot>
        )}
      </ResizableTable>
    </div>
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
      itemMeters.reduce((sum, meter) => sum + adjustedMeterUsage(
        meter,
        meters,
        storedMeterUsage,
      ), 0),
      first.subItem.aggregation_decimal_digits,
      first.subItem.usage_rounding_mode,
    );
  };
  const tenantRows = billingGroupIds.map((billingGroupId) => {
    const tenantContracts = eligibleContracts.filter((row) => billingGroupKey(row) === billingGroupId);
    const unitCodes = new Set(tenantContracts.map((row) => row.unit?.unit_code).filter(Boolean));
    const usage = subItemIds.reduce((total, subItemId) => {
      const itemMeters = meters.filter((meter) => meter.subItem.asset_meter_sub_item_id === subItemId && unitCodes.has(meter.assignments[0]?.unit?.unit_code));
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
    const unitCode = contract.unit?.unit_code;
    const customAmount = subItemIds.reduce((itemTotal, subItemId) => {
      const item = subItems.find((row) => row.asset_meter_sub_item_id === subItemId);
      if (!item || !unitCode) return itemTotal;
      const itemMeters = meters.filter((meter) =>
        meter.subItem.asset_meter_sub_item_id === subItemId &&
        meter.assignments[0]?.unit?.unit_code === unitCode
      );
      const usage = usageForMeters(itemMeters);
      const unitPrice = contract.prices.find((row) => row.asset_billing_line_item_id === item.asset_billing_line_item_id)?.unit_price
        ?? contract.categoryPrices.find((row) => row.category === "electric")?.unit_price;
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
    : recoveryShortfall / recoveryUsage;
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
  useEffect(() => setDraftSubItems(subItems), [subItems]);
  useEffect(() => setDraftSurcharges(surcharges), [surcharges]);
  const periodOrder = ["前月分", "当月分", "翌月分", "検針期間（前月検針日を含める）", "検針期間（前月検針日を含めない）"];
  const periodOptions = periodPatterns
    .filter((period) => periodOrder.includes(period.pattern_name ?? ""))
    .sort((a, b) => periodOrder.indexOf(a.pattern_name ?? "") - periodOrder.indexOf(b.pattern_name ?? ""));
  const updateCategory = (category: UtilityCategory, patch: Partial<MeterCategorySetting>) =>
    setDraftCategories((current) => current.map((row) => row.category === category ? { ...row, ...patch } : row));
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
    asset_meter_sub_item_id: crypto.randomUUID(), category, sub_item_name: "新しい小分類", sub_item_kind: "custom",
    asset_billing_line_item_id: null, sort_order: current.filter((row) => row.category === category).length,
    input_mode: "usage", input_decimal_digits: 1, aggregation_decimal_digits: 1, usage_rounding_mode: "round",
    billing_period_pattern_id: null, price_mode: "fixed", default_unit_price: null, tax_mode: "exclusive",
    tax_rounding_mode: "floor", show_unit_price_on_invoice: true,
  }]);
  const save = async () => {
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
              <header className="configuration-category-header"><strong>{labels[category]}</strong><label>使用量の単位<input value={setting.usage_unit} onChange={(event) => updateCategory(category, { usage_unit: event.target.value })} /></label><label className="checkbox-label"><input type="checkbox" checked={setting.is_basic_billable} onChange={(event) => updateCategory(category, { is_basic_billable: event.target.checked })} />基本料を請求する</label><label className="price-setting-label">既定単価設定<select value={utilitySetting.price_scope} onChange={(event) => updateUtilitySetting(category, { price_scope: event.target.value as AssetUtilitySetting["price_scope"] })}><option value="category">共通して設定</option><option value="line_item">小分類ごとに設定</option></select></label>{usesSharedPrice && <label className="price-setting-label">共通単価<input type="number" min="0" step="0.0001" value={utilitySetting.default_unit_price ?? ""} onChange={(event) => updateUtilitySetting(category, { default_unit_price: event.target.value === "" ? null : Number(event.target.value) })} /></label>}<label className="checkbox-label"><input type="checkbox" checked={utilitySetting.show_in_rent_roll} onChange={(event) => updateUtilitySetting(category, { show_in_rent_roll: event.target.checked })} />単価をレントロールに表示</label><button type="button" className="text-button" onClick={() => addSubItem(category)}>小分類を追加</button></header>
              <div className="table-wrap"><ResizableTable className="configuration-table resizable-configuration-table" storageKey={`building-settings:${assetId}:meter-configuration`} storageUserId={columnStorageUserId} columnGroups={["subitem", "line-item", "price-mode", "default-price", "invoice-price", "tax-mode", "tax-rounding", "billing-period", "actions"]}><thead><tr><ColumnHeader columnGroup="subitem">小分類</ColumnHeader><ColumnHeader columnGroup="line-item">請求明細の項目</ColumnHeader><ColumnHeader columnGroup="price-mode">単価計算方法</ColumnHeader><ColumnHeader columnGroup="default-price">既定単価</ColumnHeader><ColumnHeader columnGroup="invoice-price">請求書に単価を表示</ColumnHeader><ColumnHeader columnGroup="tax-mode">税区分</ColumnHeader><ColumnHeader columnGroup="tax-rounding">税込単価の税抜換算</ColumnHeader><ColumnHeader columnGroup="billing-period">既定の請求期間</ColumnHeader><ColumnHeader columnGroup="actions" /></tr></thead><tbody>
                {items.map((item) => <tr key={item.asset_meter_sub_item_id}>
                  <td><input value={item.sub_item_name} disabled={item.sub_item_kind === "basic"} onChange={(event) => updateSubItem(item.asset_meter_sub_item_id, { sub_item_name: event.target.value })} /></td>
                  <td className="align-left"><select value={item.asset_billing_line_item_id ?? ""} onChange={(event) => updateSubItem(item.asset_meter_sub_item_id, { asset_billing_line_item_id: event.target.value || null })}><option value="">未設定</option>{categoryLineItems.map((line) => <option key={line.asset_billing_line_item_id} value={line.asset_billing_line_item_id}>{line.display_name || line.line_item_name}</option>)}</select></td>
                  <td>{item.sub_item_kind === "basic" ? "—" : <select value={item.price_mode} onChange={(event) => updateSubItem(item.asset_meter_sub_item_id, { price_mode: event.target.value as MeterSubItem["price_mode"] })}><option value="fixed">固定</option><option value="amount">金額から計算</option><option value="master_meter">大元メーターから計算</option></select>}</td>
                  <td><input type="number" min="0" step="0.0001" disabled={item.sub_item_kind === "basic" || usesSharedPrice} value={item.default_unit_price ?? ""} onChange={(event) => updateSubItem(item.asset_meter_sub_item_id, { default_unit_price: event.target.value === "" ? null : Number(event.target.value) })} /></td>
                  <td>{item.sub_item_kind === "basic" ? "—" : <input type="checkbox" checked={item.show_unit_price_on_invoice} onChange={(event) => updateSubItem(item.asset_meter_sub_item_id, { show_unit_price_on_invoice: event.target.checked })} />}</td>
                  <td><select value={item.tax_mode} onChange={(event) => updateSubItem(item.asset_meter_sub_item_id, { tax_mode: event.target.value as TaxMode })}><option value="exclusive">税抜</option><option value="inclusive">税込</option></select></td>
                  <td>{item.tax_mode === "inclusive" ? <select value={item.tax_rounding_mode} onChange={(event) => updateSubItem(item.asset_meter_sub_item_id, { tax_rounding_mode: event.target.value as "floor" | "round" | "ceil" })}><option value="floor">切り捨て</option><option value="round">四捨五入</option><option value="ceil">切り上げ</option></select> : "—"}</td>
                  <td className="align-left"><select value={item.billing_period_pattern_id ?? ""} onChange={(event) => updateSubItem(item.asset_meter_sub_item_id, { billing_period_pattern_id: event.target.value || null })}><option value="">未設定</option>{periodOptions.map((period) => <option key={period.billing_period_pattern_id} value={period.billing_period_pattern_id}>{period.pattern_name}</option>)}</select></td>
                  <td>{item.sub_item_kind === "custom" && <button type="button" className="danger-link" onClick={() => window.confirm(`「${item.sub_item_name}」を削除しますか？`) && setDraftSubItems((current) => current.filter((row) => row.asset_meter_sub_item_id !== item.asset_meter_sub_item_id))}>削除</button>}</td>
                </tr>)}
                {categorySurcharges.filter((item) => item.is_billable && surchargeLineItems.length > 0).map((item) => <tr key={item.asset_meter_surcharge_id} className="surcharge-setting-row"><td><strong>{item.surcharge_name}</strong></td><td className="align-left"><select value={item.asset_billing_line_item_id ?? ""} onChange={(event) => updateSurcharge(item.asset_meter_surcharge_id, { asset_billing_line_item_id: event.target.value || null })}><option value="">未設定</option>{surchargeLineItems.map((line) => <option key={line.asset_billing_line_item_id} value={line.asset_billing_line_item_id}>{line.display_name || line.line_item_name}</option>)}</select></td><td colSpan={5}>—</td><td className="align-left"><select value={item.billing_period_pattern_id ?? ""} onChange={(event) => updateSurcharge(item.asset_meter_surcharge_id, { billing_period_pattern_id: event.target.value || null })}><option value="">未設定</option>{periodOptions.map((period) => <option key={period.billing_period_pattern_id} value={period.billing_period_pattern_id}>{period.pattern_name}</option>)}</select></td><td /></tr>)}
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
  const floorUnitNames = Array.from(new Set(
    floorContracts.map((contract) => contract.unit?.unit_name || contract.unit?.unit_code).filter(Boolean),
  ));
  const badgeText = hasMixedRounding && floorUnitNames.length > 0
    ? `新（${floorUnitNames.join("・")}）`
    : "新";

  return (
    <span className="tenant-name-with-rounding">
      <span>{name}</span>
      {floorContracts.length > 0 && (
        <span
          className="rounding-badge rounding-floor"
          title={hasMixedRounding ? `金額の小数点以下を切捨：${floorUnitNames.join("・")}` : "金額の小数点以下：切捨"}
        >
          {badgeText}
        </span>
      )}
    </span>
  );
}

function DataTable({
  headers,
  rows,
  totalRow,
}: {
  headers: string[];
  rows: ReactNode[][];
  totalRow?: ReactNode[];
}) {
  return (
    <div className="table-wrap">
      <ResizableTable className="workspace-data-table" storageKey={`data-${headers.join("-")}`} columnGroups={headers.map(semanticColumnKey)}>
        <thead>
          <tr>
            {headers.map((header) => (
              <ColumnHeader key={header} textAlign={columnAlignment(header)} columnGroup={semanticColumnKey(header)}>{header}</ColumnHeader>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((value, cell) => (
                <td
                  key={cell}
                  className={columnAlignment(headers[cell]) === "amount" ? "numeric" : columnAlignment(headers[cell]) === "tenant" ? "tenant-cell" : ""}
                >
                  {value}
                </td>
              ))}
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
  if (header.includes("テナント名")) return "tenant";
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
