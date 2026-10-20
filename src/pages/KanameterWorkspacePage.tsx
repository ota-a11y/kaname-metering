import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode, type ThHTMLAttributes } from "react";
import {
  assignMeterUnit,
  confirmMeterReadingMonth,
  createMeter,
  deleteMeter,
  loadAssetUtilitySettings,
  loadBillingAssets,
  loadContractUnits,
  loadMeteringConfiguration,
  loadMeterManagement,
  loadMeterReadings,
  loadMeterUsageHistory,
  loadMeterReadingPeriod,
  loadAvailableMeterReadingMonths,
  reorderMeters,
  saveMeterReading,
  saveMeterReadingDate,
  updateMeterSubItemDisplaySettings,
} from "../lib/meteringRepository";
import { supabase } from "../lib/supabase";
import type {
  Asset,
  AssetUtilitySetting,
  ContractUnit,
  MeterCategorySetting,
  MeterReadingRow,
  MeterSubItem,
  MeterSurcharge,
  MeterUnitOption,
  UserProfile,
  UtilityCategory,
} from "../types";

const categories: UtilityCategory[] = ["electric", "water", "gas"];
const labels: Record<UtilityCategory, string> = {
  electric: "電気",
  water: "水道",
  gas: "ガス",
};
const currentMonth = new Date().toISOString().slice(0, 7);
type MainTab = "summary" | UtilityCategory | "settings";
type SaveState = "idle" | "saving" | "saved" | "error";

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
  const [subItemBillingMonths, setSubItemBillingMonths] = useState<Record<string, string>>({});
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
  const [contracts, setContracts] = useState<ContractUnit[]>([]);
  const [meters, setMeters] = useState<MeterReadingRow[]>([]);
  const [summaryMeters, setSummaryMeters] = useState<MeterReadingRow[]>([]);
  const [managedMeters, setManagedMeters] = useState<MeterReadingRow[]>([]);
  const [units, setUnits] = useState<MeterUnitOption[]>([]);
  const [meterSettingsItemId, setMeterSettingsItemId] = useState<string | null>(null);
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
    ])
      .then(([prices, config, contractRows, management]) => {
        setUtilitySettings(prices);
        setCategorySettings(config.categories);
        setSubItems(config.subItems);
        setSurcharges(config.surcharges);
        setContracts(contractRows);
        setManagedMeters(management.meters);
        setUnits(management.units);
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
    void Promise.all(categories.map((category) => loadMeterReadings(supabase!, assetId, billingMonth, category)))
      .then((results) => setSummaryMeters(results.flatMap((result) => result.rows)))
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
  }, [assetId, billingMonth, mainTab]);

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
        const usageOverride = meter.subItem.input_mode === "reading" && Number.isFinite(previous) && entered < previous && activeRolloverValue
          ? activeRolloverValue - previous + entered
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
                    previous_reading:
                      saved.previous_reading === null
                        ? null
                        : Number(saved.previous_reading),
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
  const billableCategoryContracts = activeCategory
    ? contracts.filter((contract) => isContractCategoryBillable(contract, activeCategory))
    : contracts;
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
    const selectedMonth = subItemBillingMonths[itemId];
    if (selectedMonth) setBillingMonth(selectedMonth);
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
    if (mainTab === "settings" || meterSettingsItemId) return;
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
          <button
            type="button"
            className={`sidebar-settings ${mainTab === "settings" ? "active" : ""}`}
            onClick={() => setMainTab("settings")}
          >
            <span>⚙</span>設定
          </button>
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
            <div className="meter-period">
              <span>検針期間</span>
              <strong>{formatMeterPeriod(previousMeterDate, meterDate)}</strong>
            </div>
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
        {mainTab !== "settings" && (
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
          </div>
        )}
        {loading ? (
          <div className="loading">共通DBから読み込んでいます…</div>
        ) : mainTab === "summary" ? (
          <SummaryView
            categorySettings={categorySettings}
            meters={summaryMeters}
            contracts={contracts}
            subItems={subItems}
            surcharges={surcharges}
            columnStorageUserId={profile.user_id}
          />
        ) : mainTab === "settings" ? (
          <SystemSettingsView contracts={contracts} />
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
                  <label className="subitem-period-picker">
                    対象期間
                    <select
                      value={subItemBillingMonths[selectedItemId] ?? billingMonth}
                      onChange={(event) => {
                        const next = event.target.value;
                        setSubItemBillingMonths((current) => ({ ...current, [selectedItemId]: next }));
                        setBillingMonth(next);
                      }}
                    >
                      {Array.from(new Map([{ billingMonth, meterDate }, ...availableBillingMonths].map((period) => [period.billingMonth, period])).values()).map((period) => (
                        <option key={period.billingMonth} value={period.billingMonth}>
                          {period.billingMonth.replace("-", "年")}月{period.meterDate ? `（検針日 ${formatShortDate(period.meterDate)}）` : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              {selectedSubItem?.sub_item_kind === "custom" && (
                <button
                  type="button"
                  className="meter-settings-link"
                  onClick={() => setMeterSettingsItemId((current) => current ? null : selectedSubItem.asset_meter_sub_item_id)}
                >
                  {meterSettingsItemId ? "検針画面へ戻る" : "メーター設定"}
                </button>
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
              <div className="workspace-table-card">
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
                        billableCategoryUnitCodes.has(meter.assignments[0]?.unit?.unit_code),
                    )}
                    contracts={billableCategoryContracts}
                    category={mainTab as UtilityCategory}
                    lineItemId={selectedSubItem.asset_billing_line_item_id}
                    values={values}
                    saveStates={saveStates}
                    confirmed={status === "confirmed"}
                    usageHistory={usageHistory}
                    rolloverValues={rolloverValues}
                    columnStorageUserId={profile.user_id}
                    onChange={queueSave}
                    onRollover={setMeterRollover}
                  />
                ) : selectedSurcharge ? (
                  <SurchargeTable contracts={billableCategoryContracts} meters={meters} />
                ) : (
                  <div className="empty-cell">小分類が設定されていません。</div>
                )}
              </div>
              {selectedSurcharge && (
                <EvidencePanel
                  surcharge={selectedSurcharge}
                  unit={
                    categorySettings.find(
                      (row) => row.category === activeCategory,
                    )?.usage_unit ?? ""
                  }
                />
              )}
            </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function SummaryView({
  categorySettings,
  contracts,
  meters,
  subItems,
  surcharges,
  columnStorageUserId,
}: {
  categorySettings: MeterCategorySetting[];
  meters: MeterReadingRow[];
  contracts: ContractUnit[];
  subItems: MeterSubItem[];
  surcharges: MeterSurcharge[];
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
  const tenantIds = Array.from(new Set(eligibleContracts.map((row) => row.contract?.tenant_id).filter(Boolean))) as string[];
  const usageForContractItem = (contract: ContractUnit, item: MeterSubItem) => roundToDigits(
    meters.filter(
      (meter) => meter.subItem.asset_meter_sub_item_id === item.asset_meter_sub_item_id && meter.assignments[0]?.unit?.unit_code === contract.unit?.unit_code,
    ).reduce((sum, meter) => sum + Number(meter.entry?.usage_amount ?? 0), 0),
    item.aggregation_decimal_digits,
    item.usage_rounding_mode,
  );
  const amountForContractItem = (contract: ContractUnit, item: MeterSubItem, usage: number) => {
    const price = contract.prices.find((row) => row.asset_billing_line_item_id === item.asset_billing_line_item_id)?.unit_price ?? contract.categoryPrices.find((row) => row.category === item.category)?.unit_price;
    return price == null ? 0 : roundUtilityAmount(usage * Number(price), contract.utility_amount_rounding_mode);
  };
  const summaryRows = tenantIds.map((tenantId) => {
    const tenantContracts = eligibleContracts.filter((row) => row.contract?.tenant_id === tenantId);
    const groups = categoryColumns.map((group) => {
      const billableContracts = tenantContracts.filter((contract) => isContractCategoryBillable(contract, group.category));
      const enabled = billableContracts.length > 0;
      const basicAmount = group.basic ? billableContracts.reduce((sum, contract) => sum + Number(contract.basics.find((row) => row.category === group.category)?.amount ?? 0), 0) : null;
      const custom = group.custom.map((item) => {
        const usage = billableContracts.reduce((sum, contract) => sum + usageForContractItem(contract, item), 0);
        const amount = billableContracts.reduce((sum, contract) => {
          const contractUsage = usageForContractItem(contract, item);
          return sum + amountForContractItem(contract, item, contractUsage);
        }, 0);
        return { usage, amount };
      });
      const surchargeAmount = group.surcharge ? 0 : null;
      const totalUsage = custom.reduce((sum, item) => sum + item.usage, 0);
      const total = (basicAmount ?? 0) + custom.reduce((sum, item) => sum + item.amount, 0);
      return { enabled, basicAmount, custom, surchargeAmount, totalUsage, total };
    });
    return {
      tenantId,
      tenantName: tenantContracts[0]?.contract?.tenant?.tenant_name ?? "—",
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
                <td>{row.tenantName}</td>
                <td className="summary-unit-cell">{row.units}</td>
                {row.groups.flatMap((group, groupIndex) => [
                  ...(group.basicAmount != null ? [<td className={`numeric ${group.enabled ? "" : "summary-disabled-cell"}`} key={`${groupIndex}-basic`}>{formatYen(group.basicAmount)}</td>] : []),
                  ...group.custom.flatMap((item, itemIndex) => [<td className={`numeric ${group.enabled ? "" : "summary-disabled-cell"}`} key={`${groupIndex}-${itemIndex}-usage`}>{item.usage.toLocaleString("ja-JP")}</td>, <td className={`numeric ${group.enabled ? "" : "summary-disabled-cell"}`} key={`${groupIndex}-${itemIndex}-amount`}>{formatYen(item.amount)}</td>]),
                  ...(categoryColumns[groupIndex].showTotal ? [
                    <td className={`numeric ${group.enabled ? "" : "summary-disabled-cell"}`} key={`${groupIndex}-total-usage`}><strong>{group.totalUsage.toLocaleString("ja-JP")}</strong></td>,
                    <td className={`numeric ${group.enabled ? "" : "summary-disabled-cell"}`} key={`${groupIndex}-total-amount`}><strong>{formatYen(group.total)}</strong></td>,
                  ] : []),
                  ...(group.surchargeAmount != null ? [<td className={`numeric ${group.enabled ? "" : "summary-disabled-cell"}`} key={`${groupIndex}-surcharge`}>{formatYen(group.surchargeAmount)}</td>] : []),
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
                ...group.custom.flatMap((item, itemIndex) => [<th className="numeric" key={`${item.asset_meter_sub_item_id}-usage`}>{summaryRows.reduce((sum, row) => sum + row.groups[groupIndex].custom[itemIndex].usage, 0).toLocaleString("ja-JP")}</th>, <th className="numeric" key={`${item.asset_meter_sub_item_id}-amount`}>{formatYen(summaryRows.reduce((sum, row) => sum + row.groups[groupIndex].custom[itemIndex].amount, 0))}</th>]),
                ...(group.showTotal ? [
                  <th className="numeric" key={`${group.category}-total-usage`}>{summaryRows.reduce((sum, row) => sum + row.groups[groupIndex].totalUsage, 0).toLocaleString("ja-JP")}</th>,
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
    if (!units.some((unit) => unit.unit_id === unitId))
      setUnitId(units[0]?.unit_id ?? "");
  }, [subItems, units, subItemId, unitId, lockedSubItemId]);

  const add = async () => {
    if (!subItemId || !unitId || !meterCode.trim()) return;
    setSaving(true);
    onError("");
    try {
      await createMeter(supabase!, assetId, subItemId, meterCode, unitId);
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
      await assignMeterUnit(supabase!, meterId, nextUnitId);
      await onChanged();
      onNotice("メーターの区画を変更しました。");
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

  return (
    <section className="meter-settings">
      <div className="meter-display-settings">
        <label>データ入力方法<select value={inputMode} onChange={(event) => setInputMode(event.target.value as "usage" | "reading")}><option value="reading">読取値を入力</option><option value="usage">使用量を入力</option></select></label>
        <label>検針値入力表示桁数<input type="number" min={0} max={3} step={1} value={readingDecimalDigits} onChange={(event) => setReadingDecimalDigits(Math.min(3, Math.max(0, Number(event.target.value))))} /></label>
        <label>使用量入力桁数<input type="number" min={0} max={3} step={1} value={inputDecimalDigits} onChange={(event) => setInputDecimalDigits(Math.min(3, Math.max(0, Number(event.target.value))))} /></label>
        <label>使用量集計桁数<input type="number" min={0} max={3} step={1} value={aggregationDecimalDigits} onChange={(event) => setAggregationDecimalDigits(Math.min(3, Math.max(0, Number(event.target.value))))} /></label>
        <label>使用量の小数点処理<select value={usageRoundingMode} onChange={(event) => setUsageRoundingMode(event.target.value as "floor" | "round" | "ceil")}><option value="ceil">切り上げ</option><option value="round">四捨五入</option><option value="floor">切り捨て</option></select></label>
        <button type="button" className="primary compact" disabled={saving} onClick={() => void saveDisplaySettings()}>{saving ? "保存中…" : "設定を保存"}</button>
      </div>
      <div className="table-wrap">
        <ResizableTable className="workspace-data-table meter-settings-table" storageKey="meter-settings-common" columnGroups={["drag", "category", "sub-item", "meter", "unit", "action"]}>
          <thead><tr><ColumnHeader columnGroup="drag" /><ColumnHeader columnGroup="category">分類</ColumnHeader><ColumnHeader columnGroup="sub-item">小分類</ColumnHeader><ColumnHeader columnGroup="meter">メーター番号</ColumnHeader><ColumnHeader columnGroup="unit">設置区画</ColumnHeader><ColumnHeader columnGroup="action" /></tr></thead>
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
                  <td><strong>{meter.meter_code}</strong></td>
                  <td>
                    <select value={assignment?.unit_id ?? ""} onChange={(event) => void changeUnit(meter.asset_meter_id, event.target.value)}>
                      <option value="" disabled>区画を選択</option>
                      {units.map((unit) => (
                        <option key={unit.unit_id} value={unit.unit_id}>
                          {formatFloor(unit.floor_label)} / {unit.unit_name || unit.unit_code}
                        </option>
                      ))}
                    </select>
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
        <label>区画<select value={unitId} onChange={(event) => setUnitId(event.target.value)}>{units.map((unit) => <option key={unit.unit_id} value={unit.unit_id}>{formatFloor(unit.floor_label)} / {unit.unit_name || unit.unit_code}</option>)}</select></label>
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
  return (
    <DataTable
      headers={["階数", "区画", "テナント名", "基本料（区画ごと）"]}
      rows={contracts.filter((row) => ["office", "warehouse", "storage"].includes(row.unit?.unit_type ?? "")).map((row) => [
        formatFloor(row.unit?.floor_label),
        row.unit?.unit_name || row.unit?.unit_code || "—",
        row.contract?.tenant?.tenant_name ?? "—",
        formatYen(
          row.basics.find((item) => item.category === category)?.amount,
        ),
      ])}
    />
  );
}
function CustomItemTable({
  meters,
  contracts,
  category,
  lineItemId,
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
  const tenantKey = (meter: MeterReadingRow) =>
    contractFor(meter)?.contract?.tenant_id ?? `unassigned-${meter.asset_meter_id}`;
  const meterUsage = (meter: MeterReadingRow) => {
    const raw = values[meter.asset_meter_id];
    const entered = raw !== undefined && raw !== "" ? Number(raw) : null;
    const previous = Number(meter.entry?.previous_reading ?? 0);
    const rolloverValue = rolloverValues[meter.asset_meter_id];
    const usage = meter.subItem.input_mode === "reading"
      ? entered === null
        ? Number(meter.entry?.usage_amount ?? 0)
        : entered < previous && rolloverValue
          ? rolloverValue - previous + entered
          : entered - previous
      : entered ?? Number(meter.entry?.usage_amount ?? 0);
    return Number.isFinite(usage) ? usage : 0;
  };
  const inputMode = meters[0]?.subItem.input_mode ?? "usage";
  const showReadings = inputMode === "reading";
  const comparisonRatio = (current: number, comparison: number | undefined) =>
    comparison == null || comparison === 0 ? null : (current / comparison) * 100;
  const unitPrice = (meter: MeterReadingRow) => {
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
  const unitGroups = Array.from(new Map(
    orderedMeters.map((meter) => [unitKey(meter), orderedMeters.filter((row) => unitKey(row) === unitKey(meter))]),
  ).values());
  const tenantGroups = Array.from(new Map(
    orderedMeters.map((meter) => [tenantKey(meter), orderedMeters.filter((row) => tenantKey(row) === tenantKey(meter))]),
  ).values());
  const totalMeterUsage = orderedMeters.reduce((sum, meter) => sum + meterUsage(meter), 0);
  const totalUnitUsage = unitGroups.reduce((sum, group) => {
    const first = group[0];
    return sum + roundToDigits(group.reduce((value, meter) => value + meterUsage(meter), 0), first.subItem.aggregation_decimal_digits, first.subItem.usage_rounding_mode);
  }, 0);
  const totalAmount = unitGroups.reduce((sum, group) => {
    const first = group[0];
    const contract = contractFor(first);
    const price = unitPrice(first);
    if (!contract || price == null) return sum;
    const usage = roundToDigits(group.reduce((value, meter) => value + meterUsage(meter), 0), first.subItem.aggregation_decimal_digits, first.subItem.usage_rounding_mode);
    return sum + roundUtilityAmount(usage * Number(price), contract.utility_amount_rounding_mode);
  }, 0);
  const totalTenantUsage = tenantGroups.reduce((sum, group) => sum + group.reduce((value, meter) => value + meterUsage(meter), 0), 0);
  const totalPreviousUsage = orderedMeters.reduce((sum, meter) => sum + (usageHistory.previous[meter.asset_meter_id] ?? 0), 0);
  const totalPreviousYearUsage = orderedMeters.reduce((sum, meter) => sum + (usageHistory.previousYear[meter.asset_meter_id] ?? 0), 0);
  const totalPreviousReading = orderedMeters.reduce((sum, meter) => sum + Number(meter.entry?.previous_reading ?? 0), 0);
  const totalCurrentReading = orderedMeters.reduce((sum, meter) => sum + Number(values[meter.asset_meter_id] || meter.entry?.current_reading || 0), 0);
  const totalDigits = orderedMeters[0]?.subItem.aggregation_decimal_digits ?? 1;
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
            const unitEndIndex = index + unitMeterCount - 1;
            const unitEndsTenant =
              firstInUnit &&
              (unitEndIndex === orderedMeters.length - 1 ||
                tenantKey(orderedMeters[unitEndIndex + 1]) !== currentTenantKey);
            const contract = contractFor(meter);
            const price = unitPrice(meter);
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
            const tenantUsage = roundToDigits(
              tenantMeters.reduce((sum, row) => sum + meterUsage(row), 0),
              aggregationDigits,
              usageRoundingMode,
            );
            const tenantUnitGroups = new Map<string, MeterReadingRow[]>();
            tenantMeters.forEach((row) => {
              const key = unitKey(row);
              tenantUnitGroups.set(key, [...(tenantUnitGroups.get(key) ?? []), row]);
            });
            const tenantAmount = Array.from(tenantUnitGroups.values()).reduce((sum, unitMeters) => {
              const firstMeter = unitMeters[0];
              const unitContract = contractFor(firstMeter);
              const priceForUnit = unitPrice(firstMeter);
              if (!unitContract || priceForUnit == null) return sum;
              const usage = roundToDigits(
                unitMeters.reduce((unitSum, row) => unitSum + meterUsage(row), 0),
                firstMeter.subItem.aggregation_decimal_digits ?? 1,
                firstMeter.subItem.usage_rounding_mode ?? "round",
              );
              return sum + roundUtilityAmount(usage * Number(priceForUnit), unitContract.utility_amount_rounding_mode);
            }, 0);
            const previousUsage = usageHistory.previous[meter.asset_meter_id];
            const previousYearUsage = usageHistory.previousYear[meter.asset_meter_id];
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
                    <td className={`unit-identity ${unitEndsTenant ? "tenant-boundary" : ""}`} rowSpan={unitMeterCount}><span className="merged-value">{unit?.unit_name || unit?.unit_code || "未割当"}</span></td>
                  </>
                )}
                {firstInTenant && (
                  <td className="tenant-cell tenant-identity" rowSpan={tenantMeters.length}><span className="merged-value">{contract?.contract?.tenant?.tenant_name ?? "—"}</span></td>
                )}
                <td><strong>{meter.meter_code}</strong></td>
                <td>{formatYen(price)}</td>
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
                {firstInUnit && (
                  <td className={`numeric unit-total ${unitEndsTenant ? "tenant-boundary" : ""}`} rowSpan={unitMeterCount}>
                    <span className="merged-value">{unit ? formatUsage(unitUsage, aggregationDigits) : "—"}</span>
                  </td>
                )}
                {firstInUnit && (
                  <td className={`numeric unit-amount ${unitEndsTenant ? "tenant-boundary" : ""}`} rowSpan={unitMeterCount}>
                    <span className="merged-value">{unitAmount == null ? "未設定" : formatYen(unitAmount)}</span>
                  </td>
                )}
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
              <th className="numeric">{formatUsage(totalMeterUsage, totalDigits)}</th>
              <th className="numeric">{formatUsage(totalUnitUsage, totalDigits)}</th>
              <th className="numeric">{formatYen(totalAmount)}</th>
              <th className="numeric">{formatUsage(totalTenantUsage, totalDigits)}</th>
              <th className="numeric">{formatYen(totalAmount)}</th>
              <th className="numeric">{formatUsage(totalPreviousUsage, totalDigits)}</th>
              <th className="numeric">{formatComparison(comparisonRatio(totalMeterUsage, totalPreviousUsage))}</th>
              <th className="numeric">{formatUsage(totalPreviousYearUsage, totalDigits)}</th>
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
function SurchargeTable({
  contracts,
  meters,
}: {
  contracts: ContractUnit[];
  meters: MeterReadingRow[];
}) {
  const eligibleContracts = contracts.filter((row) => ["office", "warehouse", "storage"].includes(row.unit?.unit_type ?? ""));
  const tenantIds = Array.from(new Set(eligibleContracts.map((row) => row.contract?.tenant_id).filter(Boolean))) as string[];
  const subItemIds = Array.from(new Set(meters.map((meter) => meter.subItem.asset_meter_sub_item_id)));
  return (
    <DataTable
      headers={["階数", "区画", "テナント名", "使用量（小分類の合計）", "金額"]}
      rows={tenantIds.map((tenantId) => {
        const tenantContracts = eligibleContracts.filter((row) => row.contract?.tenant_id === tenantId);
        const unitCodes = new Set(tenantContracts.map((row) => row.unit?.unit_code).filter(Boolean));
        const usage = subItemIds.reduce((total, subItemId) => {
          const itemMeters = meters.filter((meter) => meter.subItem.asset_meter_sub_item_id === subItemId && unitCodes.has(meter.assignments[0]?.unit?.unit_code));
          const first = itemMeters[0];
          if (!first) return total;
          const tenantItemUsage = roundToDigits(
            itemMeters.reduce((sum, meter) => sum + Number(meter.entry?.usage_amount ?? 0), 0),
            first.subItem.aggregation_decimal_digits,
            first.subItem.usage_rounding_mode,
          );
          return total + tenantItemUsage;
        }, 0);
        return [
          Array.from(new Set(tenantContracts.map((row) => formatFloor(row.unit?.floor_label)))).join("・"),
          tenantContracts.map((row) => row.unit?.unit_name || row.unit?.unit_code).filter(Boolean).join("・") || "—",
          tenantContracts[0]?.contract?.tenant?.tenant_name ?? "—",
          usage.toLocaleString("ja-JP"),
          "—",
        ];
      })}
    />
  );
}
function EvidencePanel({
  surcharge,
  unit,
}: {
  surcharge: MeterSurcharge;
  unit: string;
}) {
  return (
    <aside className="evidence-panel">
      <p className="eyebrow">PRICE EVIDENCE</p>
      <h2>単価計算の根拠</h2>
      <label>
        対象期間
        <div className="period-fields">
          <input type="date" />
          <span>〜</span>
          <input type="date" />
        </div>
      </label>
      <label>
        仕入請求額（税込）
        <input type="number" placeholder="0" />
      </label>
      <label>
        仕入使用量（{unit || "単位未設定"}）
        <input type="number" placeholder="0" />
      </label>
      <dl>
        <div>
          <dt>小分類合計</dt>
          <dd>—</dd>
        </div>
        <div>
          <dt>{displaySurchargeName(surcharge.surcharge_name)}単価</dt>
          <dd>—</dd>
        </div>
      </dl>
      <p>根拠データの保存とDB計算は計算ロジック実装時に接続します。</p>
    </aside>
  );
}

function SystemSettingsView({ contracts }: { contracts: ContractUnit[] }) {
  const roundingLabels: Record<ContractUnit["utility_amount_rounding_mode"], string> = {
    floor: "切り捨て",
    round: "四捨五入",
    ceil: "切り上げ",
  };
  return (
    <section className="system-settings">
      <nav className="settings-tabs" aria-label="設定項目">
        <button type="button" className="active">テナント一覧</button>
      </nav>
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

function DataTable({
  headers,
  rows,
}: {
  headers: string[];
  rows: Array<Array<string | number>>;
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
  useLayoutEffect(() => {
    const table = tableRef.current;
    if (!table) return;
    try {
      const saved = JSON.parse(localStorage.getItem(persistenceKey) ?? "null") as { groupWidths?: Record<string, number> } | null;
      const columns = Array.from(table.querySelectorAll<HTMLTableColElement>("colgroup col"));
      const defaultColumnWidth = Math.max(72, table.getBoundingClientRect().width / Math.max(1, columns.length));
      columns.forEach((column) => {
        const group = column.dataset.columnGroup ?? "";
        const width = saved?.groupWidths?.[group] ?? defaultColumnWidth;
        column.style.width = `${width}px`;
      });
      const linkedTableWidth = columns.reduce((sum, column) => sum + (Number.parseFloat(column.style.width) || defaultColumnWidth), 0);
      if (linkedTableWidth) {
        const width = Math.max(880, linkedTableWidth);
        table.style.width = `${width}px`;
        table.style.minWidth = `${width}px`;
        table.style.maxWidth = `${width}px`;
      }
    } catch {
      localStorage.removeItem(persistenceKey);
    }
  }, [persistenceKey]);
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
    handle?.setPointerCapture?.(event.pointerId);
    const move = (moveEvent: globalThis.PointerEvent) => {
      const nextWidth = Math.max(72, startWidth + moveEvent.clientX - startX);
      const widthDelta = nextWidth - startWidth;
      const nextTableWidth = Math.max(320, startTableWidth + widthDelta * linkedColumns.length);
      linkedColumns.forEach((linkedColumn) => { linkedColumn.style.width = `${nextWidth}px`; });
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
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };
  return (
    <table ref={tableRef} className={className} onPointerDown={beginResize}>
      <colgroup>{columnGroups.map((group, index) => <col key={`${group}-${index}`} data-column-group={group} />)}</colgroup>
      {children}
    </table>
  );
}
