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
  loadMeterReadingPeriod,
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
  const [managedMeters, setManagedMeters] = useState<MeterReadingRow[]>([]);
  const [units, setUnits] = useState<MeterUnitOption[]>([]);
  const [meterSettingsItemId, setMeterSettingsItemId] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});
  const [status, setStatus] = useState<"draft" | "confirmed" | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
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
    void loadMeterReadings(supabase!, assetId, billingMonth, activeCategory)
      .then((result) => {
        setMeters(result.rows);
        setStatus(result.status);
        setValues(
          Object.fromEntries(
            result.rows.map((meter) => [
              meter.asset_meter_id,
              meter.subItem.input_mode === "reading"
                ? (meter.entry?.current_reading?.toString() ?? "")
                : (meter.entry?.usage_amount?.toString() ?? ""),
            ]),
          ),
        );
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
    if (!assetId || activeCategory) return;
    void loadMeterReadings(supabase!, assetId, billingMonth, "electric")
      .then((result) => setStatus(result.status))
      .catch(() => setStatus(null));
  }, [assetId, billingMonth, activeCategory]);

  const queueSave = (meter: MeterReadingRow, raw: string) => {
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
        const saved = await saveMeterReading(
          supabase!,
          assetId,
          billingMonth,
          meter.asset_meter_id,
          Number(raw),
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
      setSelectedItemId(selectableIds[nextIndex]);
    };
    window.addEventListener("keydown", switchSubItem);
    return () => window.removeEventListener("keydown", switchSubItem);
  }, [activeCategory, meterSettingsItemId, selectedItemId, categorySubItems, categorySurcharges]);

  useEffect(() => {
    if (!activeCategory || meterSettingsItemId) return;
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
    const trackShift = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Shift" && !event.repeat) shiftOnly = true;
      else if (event.shiftKey) shiftOnly = false;
    };
    const switchCategory = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Shift" || !shiftOnly || availableCategories.length < 2) return;
      const currentIndex = Math.max(0, availableCategories.indexOf(activeCategory));
      setMainTab(availableCategories[(currentIndex + 1) % availableCategories.length]);
      setMeterSettingsItemId(null);
      shiftOnly = false;
    };
    window.addEventListener("keydown", trackShift);
    window.addEventListener("keyup", switchCategory);
    return () => {
      window.removeEventListener("keydown", trackShift);
      window.removeEventListener("keyup", switchCategory);
    };
  }, [activeCategory, meterSettingsItemId, categorySettings, subItems, surcharges]);

  return (
    <div className={`workspace-shell ${utilityClass}`}>
      <aside className="building-sidebar">
        <div className="sidebar-brand">
          <span>K</span>
          <div>
            <strong>KANAMETER</strong>
            <small>METER READING</small>
          </div>
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
                    setMainTab(category);
                    setMeterSettingsItemId(null);
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
                        setSelectedItemId(item.asset_meter_sub_item_id);
                        setMeterSettingsItemId(null);
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
                        setSelectedItemId(item.asset_meter_surcharge_id);
                        setMeterSettingsItemId(null);
                      }}
                    >
                      {item.surcharge_name}
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
              <input
                type="month"
                value={billingMonth}
                onChange={(event) => setBillingMonth(event.target.value)}
              />
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
        {loading ? (
          <div className="loading">共通DBから読み込んでいます…</div>
        ) : mainTab === "summary" ? (
          <SummaryView
            categorySettings={categorySettings}
            meters={meters}
            contracts={contracts}
          />
        ) : mainTab === "settings" ? (
          <SystemSettingsView contracts={contracts} />
        ) : (
          <>
            <div className="sub-navigation">
              <div className="current-location">
                <span>{activeCategory ? labels[activeCategory] : ""}</span>
                <strong>{selectedSubItem?.sub_item_name ?? selectedSurcharge?.surcharge_name ?? ""}</strong>
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
                    contracts={contracts}
                    category={mainTab as UtilityCategory}
                  />
                ) : selectedSubItem ? (
                  <CustomItemTable
                    meters={meters.filter(
                      (meter) =>
                        meter.subItem.asset_meter_sub_item_id ===
                        selectedSubItem.asset_meter_sub_item_id,
                    )}
                    contracts={contracts}
                    category={mainTab as UtilityCategory}
                    lineItemId={selectedSubItem.asset_billing_line_item_id}
                    values={values}
                    saveStates={saveStates}
                    confirmed={status === "confirmed"}
                    onChange={queueSave}
                  />
                ) : selectedSurcharge ? (
                  <SurchargeTable contracts={contracts} meters={meters} />
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
}: {
  categorySettings: MeterCategorySetting[];
  meters: MeterReadingRow[];
  contracts: ContractUnit[];
}) {
  return (
    <section className="summary-view">
      <div className="summary-title">
        <p className="eyebrow">SUMMARY</p>
        <h1>検針集計</h1>
      </div>
      <div className="summary-cards">
        {categories.map((category) => {
          const setting = categorySettings.find(
            (row) => row.category === category,
          );
          return (
            <article
              className={`utility-card utility-${category} ${!setting?.is_billable ? "disabled" : ""}`}
              key={category}
            >
              <span>{labels[category]}</span>
              <strong>
                {setting?.is_billable ? "請求対象" : "請求対象外"}
              </strong>
              <small>{setting?.usage_unit ?? "—"}</small>
            </article>
          );
        })}
      </div>
      <div className="summary-placeholder">
        <strong>区画別集計</strong>
        <p>
          {contracts.length}{" "}
          区画の使用量・請求額を、計算ロジック実装後にここへ集約します。
        </p>
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
  const [inputDecimalDigits, setInputDecimalDigits] = useState(activeSubItem?.input_decimal_digits ?? 1);
  const [aggregationDecimalDigits, setAggregationDecimalDigits] = useState(activeSubItem?.aggregation_decimal_digits ?? 1);
  const [usageRoundingDigits, setUsageRoundingDigits] = useState(activeSubItem?.usage_rounding_digits ?? 1);
  const [usageRoundingMode, setUsageRoundingMode] = useState<"floor" | "round" | "ceil">(activeSubItem?.usage_rounding_mode ?? "round");
  const [orderedMeters, setOrderedMeters] = useState(meters);
  const [draggingMeterId, setDraggingMeterId] = useState<string | null>(null);
  useEffect(() => setOrderedMeters(meters), [meters]);
  useEffect(() => {
    if (!activeSubItem) return;
    setInputMode(activeSubItem.input_mode);
    setInputDecimalDigits(activeSubItem.input_decimal_digits);
    setAggregationDecimalDigits(activeSubItem.aggregation_decimal_digits);
    setUsageRoundingDigits(activeSubItem.usage_rounding_digits);
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
        usageRoundingDigits,
        usageRoundingMode,
      });
      onSubItemSettingsChanged({
        ...activeSubItem,
        input_mode: inputMode,
        input_decimal_digits: inputDecimalDigits,
        aggregation_decimal_digits: aggregationDecimalDigits,
        usage_rounding_digits: usageRoundingDigits,
        usage_rounding_mode: usageRoundingMode,
      });
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
        <label>入力桁数<input type="number" min={0} max={3} step={1} value={inputDecimalDigits} onChange={(event) => setInputDecimalDigits(Math.min(3, Math.max(0, Number(event.target.value))))} /></label>
        <label>集計桁数<input type="number" min={0} max={3} step={1} value={aggregationDecimalDigits} onChange={(event) => setAggregationDecimalDigits(Math.min(3, Math.max(0, Number(event.target.value))))} /></label>
        <fieldset>
          <legend>使用量の小数点処理</legend>
          <label>処理する桁数<input type="number" min={1} max={3} step={1} value={usageRoundingDigits} onChange={(event) => setUsageRoundingDigits(Math.min(3, Math.max(1, Number(event.target.value))))} /></label>
          <label>処理方法<select value={usageRoundingMode} onChange={(event) => setUsageRoundingMode(event.target.value as "floor" | "round" | "ceil")}><option value="ceil">切り上げ</option><option value="round">四捨五入</option><option value="floor">切り捨て</option></select></label>
        </fieldset>
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
  onChange,
}: {
  meters: MeterReadingRow[];
  contracts: ContractUnit[];
  category: UtilityCategory;
  lineItemId: string | null;
  values: Record<string, string>;
  saveStates: Record<string, SaveState>;
  confirmed: boolean;
  onChange: (meter: MeterReadingRow, value: string) => void;
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
    const usage =
      meter.subItem.input_mode === "usage" && raw !== undefined && raw !== ""
        ? Number(raw)
        : Number(meter.entry?.usage_amount ?? 0);
    return Number.isFinite(usage) ? usage : 0;
  };
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
  return (
    <div className="table-wrap">
      <ResizableTable className="workspace-data-table" storageKey="readings-common" columnGroups={["floor", "unit", "tenant", "meter", "price", "usage", "usage", "amount", "usage", "amount"]}>
        <thead>
          <tr>
            <ColumnHeader rowSpan={2} columnGroup="floor">階数</ColumnHeader>
            <ColumnHeader rowSpan={2} columnGroup="unit">区画</ColumnHeader>
            <ColumnHeader rowSpan={2} textAlign="tenant" columnGroup="tenant">テナント名</ColumnHeader>
            <ColumnHeader rowSpan={2} columnGroup="meter">メーター番号</ColumnHeader>
            <ColumnHeader rowSpan={2} textAlign="amount" columnGroup="price">単価</ColumnHeader>
            <ColumnHeader colSpan={2} className="usage-heading">使用量</ColumnHeader>
            <ColumnHeader rowSpan={2} textAlign="amount" columnGroup="amount">金額</ColumnHeader>
            <ColumnHeader colSpan={2} className="usage-heading">テナント合計</ColumnHeader>
          </tr>
          <tr>
            <ColumnHeader columnGroup="usage">メーターごと</ColumnHeader>
            <ColumnHeader columnGroup="usage">区画ごと</ColumnHeader>
            <ColumnHeader columnGroup="usage">使用量</ColumnHeader>
            <ColumnHeader columnGroup="amount">金額</ColumnHeader>
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
            const unitUsage = orderedMeters
              .filter(
                (row) =>
                  row.assignments[0]?.unit_id &&
                  row.assignments[0]?.unit_id === meter.assignments[0]?.unit_id,
              )
              .reduce((sum, row) => {
                return sum + meterUsage(row);
              }, 0);
            const unitAmount =
              contract && price != null
                ? roundUtilityAmount(
                    unitUsage * Number(price),
                    contract.utility_amount_rounding_mode,
                  )
                : null;
            const tenantUsage = tenantMeters.reduce((sum, row) => sum + meterUsage(row), 0);
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
              const usage = unitMeters.reduce((unitSum, row) => unitSum + meterUsage(row), 0);
              return sum + roundUtilityAmount(usage * Number(priceForUnit), unitContract.utility_amount_rounding_mode);
            }, 0);
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
                  </div>
                </td>
                {firstInUnit && (
                  <td className={`numeric unit-total ${unitEndsTenant ? "tenant-boundary" : ""}`} rowSpan={unitMeterCount}>
                    <span className="merged-value">{unit ? unitUsage.toLocaleString("ja-JP") : "—"}</span>
                  </td>
                )}
                {firstInUnit && (
                  <td className={`numeric unit-amount ${unitEndsTenant ? "tenant-boundary" : ""}`} rowSpan={unitMeterCount}>
                    <span className="merged-value">{unitAmount == null ? "未設定" : formatYen(unitAmount)}</span>
                  </td>
                )}
                {firstInTenant && (
                  <>
                    <td className="numeric tenant-total" rowSpan={tenantMeters.length}><span className="merged-value">{tenantUsage.toLocaleString("ja-JP")}</span></td>
                    <td className="numeric tenant-total" rowSpan={tenantMeters.length}><span className="merged-value">{formatYen(tenantAmount)}</span></td>
                  </>
                )}
              </tr>
            );
          })}
          {!meters.length && (
            <tr>
              <td colSpan={10} className="empty-cell">
                対象メーターがありません。
              </td>
            </tr>
          )}
        </tbody>
      </ResizableTable>
    </div>
  );
}
function SurchargeTable({
  contracts,
  meters,
}: {
  contracts: ContractUnit[];
  meters: MeterReadingRow[];
}) {
  return (
    <DataTable
      headers={["階数", "区画", "テナント名", "使用量（小分類の合計）", "金額"]}
      rows={contracts.filter((row) => ["office", "warehouse", "storage"].includes(row.unit?.unit_type ?? "")).map((row) => {
        const usage = meters
          .filter(
            (meter) =>
              meter.assignments[0]?.unit?.unit_code === row.unit?.unit_code,
          )
          .reduce(
            (sum, meter) => sum + Number(meter.entry?.usage_amount ?? 0),
            0,
          );
        return [
          formatFloor(row.unit?.floor_label),
          row.unit?.unit_name || row.unit?.unit_code || "—",
          row.contract?.tenant?.tenant_name ?? "—",
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
          <dt>{surcharge.surcharge_name}単価</dt>
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

function ResizableTable({ children, className, storageKey, columnGroups }: { children: ReactNode; className: string; storageKey: string; columnGroups: string[] }) {
  const tableRef = useRef<HTMLTableElement>(null);
  const persistenceKey = `kanameter-column-widths:${storageKey}`;
  useLayoutEffect(() => {
    const table = tableRef.current;
    if (!table) return;
    try {
      const saved = JSON.parse(localStorage.getItem(persistenceKey) ?? "null") as { tableWidth?: number; widths?: number[]; columnWidths?: number[] } | null;
      if (saved?.tableWidth) {
        table.style.width = `${saved.tableWidth}px`;
        table.style.minWidth = `${saved.tableWidth}px`;
        table.style.maxWidth = `${saved.tableWidth}px`;
      }
      const headers = Array.from(table.querySelectorAll<HTMLTableCellElement>("thead th"));
      const columns = Array.from(table.querySelectorAll<HTMLTableColElement>("colgroup col"));
      const semanticWidths = JSON.parse(localStorage.getItem("kanameter-semantic-column-widths") ?? "{}") as Record<string, number>;
      const resolvedWidths = new Map<string, number>();
      headers.forEach((header, index) => {
        const group = header.dataset.columnGroup;
        if (!group || resolvedWidths.has(group)) return;
        resolvedWidths.set(group, semanticWidths[group] ?? saved?.widths?.[index] ?? header.getBoundingClientRect().width);
      });
      headers.forEach((header, index) => {
        const group = header.dataset.columnGroup;
        const width = group ? resolvedWidths.get(group) : saved?.widths?.[index];
        if (width) header.style.width = `${width}px`;
      });
      const defaultColumnWidth = (saved?.tableWidth ?? table.getBoundingClientRect().width) / Math.max(1, columns.length);
      columns.forEach((column, index) => {
        const group = column.dataset.columnGroup ?? "";
        const width = resolvedWidths.get(group) ?? semanticWidths[group] ?? saved?.columnWidths?.[index] ?? defaultColumnWidth;
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
    const startWidth = header.getBoundingClientRect().width;
    const startTableWidth = tableRef.current.getBoundingClientRect().width;
    const columnGroup = header.dataset.columnGroup;
    if (!columnGroup) return;
    const linkedHeaders = Array.from(tableRef.current.querySelectorAll<HTMLTableCellElement>(`thead th[data-column-group="${columnGroup}"]`));
    const linkedColumns = Array.from(tableRef.current.querySelectorAll<HTMLTableColElement>(`colgroup col[data-column-group="${columnGroup}"]`));
    const move = (moveEvent: globalThis.PointerEvent) => {
      const nextWidth = Math.max(72, startWidth + moveEvent.clientX - startX);
      const widthDelta = nextWidth - startWidth;
      const nextTableWidth = Math.max(320, startTableWidth + widthDelta * linkedHeaders.length);
      linkedHeaders.forEach((linkedHeader) => { linkedHeader.style.width = `${nextWidth}px`; });
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
        if (columnGroup) {
          const semanticWidths = JSON.parse(localStorage.getItem("kanameter-semantic-column-widths") ?? "{}") as Record<string, number>;
          semanticWidths[columnGroup] = header.getBoundingClientRect().width;
          localStorage.setItem("kanameter-semantic-column-widths", JSON.stringify(semanticWidths));
        }
        localStorage.setItem(persistenceKey, JSON.stringify({
          tableWidth: table.getBoundingClientRect().width,
          widths: Array.from(table.querySelectorAll<HTMLTableCellElement>("thead th"), (cell) => cell.getBoundingClientRect().width),
          columnWidths: Array.from(table.querySelectorAll<HTMLTableColElement>("colgroup col"), (column) => column.getBoundingClientRect().width),
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
