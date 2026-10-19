import { useEffect, useRef, useState } from "react";
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
  saveMeterReading,
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
  const [sidebarPinned, setSidebarPinned] = useState(
    () => localStorage.getItem("kanameter-sidebar-pinned") !== "false",
  );
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
        const firstItem =
          subItems.find((item) => item.category === activeCategory) ??
          surcharges.find((item) => item.category === activeCategory);
        setSelectedItemId((current) =>
          current &&
          [...subItems, ...surcharges].some(
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
  }, [assetId, billingMonth, activeCategory, subItems, surcharges]);

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

  const selectedAsset = assets.find((asset) => asset.asset_id === assetId);
  const billable = (category: UtilityCategory) =>
    categorySettings.find((row) => row.category === category)?.is_billable ??
    false;
  const categorySubItems = activeCategory
    ? subItems.filter((item) => item.category === activeCategory)
    : [];
  const categorySurcharges = activeCategory
    ? surcharges.filter((item) => item.category === activeCategory)
    : [];
  const selectedSubItem = categorySubItems.find(
    (item) => item.asset_meter_sub_item_id === selectedItemId,
  );
  const selectedSurcharge = categorySurcharges.find(
    (item) => item.asset_meter_surcharge_id === selectedItemId,
  );

  return (
    <div
      className={`workspace-shell ${sidebarPinned ? "sidebar-pinned" : "sidebar-unpinned"}`}
    >
      <aside className="building-sidebar">
        <button
          type="button"
          className={`kanameter-sidebar-pin ${sidebarPinned ? "is-pinned" : "is-unpinned"}`}
          aria-pressed={sidebarPinned}
          aria-label={sidebarPinned ? "サイドバーのピン留めを解除" : "サイドバーをピン留め"}
          title={sidebarPinned ? "ピン留め中（クリックで解除）" : "ピン留めする"}
          onClick={() => {
            const next = !sidebarPinned;
            setSidebarPinned(next);
            localStorage.setItem("kanameter-sidebar-pinned", String(next));
          }}
        >
          <span aria-hidden="true">📌</span>
        </button>
        <div className="sidebar-brand">
          <span>K</span>
          <div>
            <strong>KANAMETER</strong>
            <small>METER READING</small>
          </div>
        </div>
        <p className="sidebar-heading">請求対象ビル</p>
        <nav className="building-list">
          {assets.map((asset) => (
            <button
              key={asset.asset_id}
              type="button"
              className={asset.asset_id === assetId ? "active" : ""}
              onClick={() => setAssetId(asset.asset_id)}
            >
              <span>{asset.asset_code}</span>
              <strong>{asset.short_name || asset.asset_name}</strong>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            type="button"
            className="sidebar-settings"
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
          <div>
            <p className="eyebrow">
              {selectedAsset?.asset_code} / {selectedAsset?.asset_name}
            </p>
            <label className="month-picker">
              請求月
              <input
                type="month"
                value={billingMonth}
                onChange={(event) => setBillingMonth(event.target.value)}
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
        <nav className="main-tabs">
          <button
            className={mainTab === "summary" ? "active" : ""}
            onClick={() => setMainTab("summary")}
          >
            集計
          </button>
          {categories.map((category) => (
            <button
              key={category}
              className={mainTab === category ? "active" : ""}
              disabled={!billable(category)}
              onClick={() => setMainTab(category)}
            >
              {labels[category]}
            </button>
          ))}
          <button
            className={mainTab === "settings" ? "active" : ""}
            onClick={() => setMainTab("settings")}
          >
            設定
          </button>
        </nav>
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
          <SettingsView
            assetId={assetId}
            subItems={subItems.filter((item) => item.sub_item_kind === "custom")}
            meters={managedMeters}
            units={units}
            onChanged={refreshMeterData}
            onNotice={setNotice}
            onError={setError}
          />
        ) : (
          <>
            <nav className="sub-tabs">
              {categorySubItems.map((item) => (
                <button
                  key={item.asset_meter_sub_item_id}
                  className={
                    selectedItemId === item.asset_meter_sub_item_id
                      ? "active"
                      : ""
                  }
                  onClick={() =>
                    setSelectedItemId(item.asset_meter_sub_item_id)
                  }
                >
                  {item.sub_item_name}
                </button>
              ))}
              {categorySurcharges.map((item) => (
                <button
                  key={item.asset_meter_surcharge_id}
                  className={
                    selectedItemId === item.asset_meter_surcharge_id
                      ? "active"
                      : ""
                  }
                  disabled={!item.is_billable}
                  onClick={() =>
                    setSelectedItemId(item.asset_meter_surcharge_id)
                  }
                >
                  {item.surcharge_name}
                </button>
              ))}
            </nav>
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
              className={!setting?.is_billable ? "disabled" : ""}
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
  onNotice,
  onError,
}: {
  assetId: string;
  subItems: MeterSubItem[];
  meters: MeterReadingRow[];
  units: MeterUnitOption[];
  onChanged: () => Promise<void>;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [subItemId, setSubItemId] = useState("");
  const [meterCode, setMeterCode] = useState("");
  const [unitId, setUnitId] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!subItems.some((item) => item.asset_meter_sub_item_id === subItemId))
      setSubItemId(subItems[0]?.asset_meter_sub_item_id ?? "");
    if (!units.some((unit) => unit.unit_id === unitId))
      setUnitId(units[0]?.unit_id ?? "");
  }, [subItems, units, subItemId, unitId]);

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
      <header>
        <p className="eyebrow">METER SETTINGS</p>
        <h1>メーター設定</h1>
        <p>メーターの追加・削除と、設置区画の紐づけを管理します。</p>
      </header>
      <div className="meter-add-form">
        <label>
          小分類
          <select value={subItemId} onChange={(event) => setSubItemId(event.target.value)}>
            {subItems.map((item) => (
              <option key={item.asset_meter_sub_item_id} value={item.asset_meter_sub_item_id}>
                {labels[item.category]} / {item.sub_item_name}
              </option>
            ))}
          </select>
        </label>
        <label>
          メーター番号
          <input value={meterCode} onChange={(event) => setMeterCode(event.target.value)} />
        </label>
        <label>
          区画
          <select value={unitId} onChange={(event) => setUnitId(event.target.value)}>
            {units.map((unit) => (
              <option key={unit.unit_id} value={unit.unit_id}>
                {unit.floor_label ?? "—"} / {unit.unit_name || unit.unit_code}
              </option>
            ))}
          </select>
        </label>
        <button className="primary compact" disabled={saving || !subItemId || !unitId || !meterCode.trim()} onClick={() => void add()}>
          {saving ? "追加中…" : "追加"}
        </button>
      </div>
      <div className="table-wrap">
        <table className="workspace-data-table meter-settings-table">
          <thead><tr><th>分類</th><th>小分類</th><th>メーター番号</th><th>設置区画</th><th /></tr></thead>
          <tbody>
            {meters.map((meter) => {
              const assignment = activeAssignment(meter);
              return (
                <tr key={meter.asset_meter_id}>
                  <td>{labels[meter.subItem.category]}</td>
                  <td>{meter.subItem.sub_item_name}</td>
                  <td><strong>{meter.meter_code}</strong></td>
                  <td>
                    <select value={assignment?.unit_id ?? ""} onChange={(event) => void changeUnit(meter.asset_meter_id, event.target.value)}>
                      <option value="" disabled>区画を選択</option>
                      {units.map((unit) => (
                        <option key={unit.unit_id} value={unit.unit_id}>
                          {unit.floor_label ?? "—"} / {unit.unit_name || unit.unit_code}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td><button className="danger-text" onClick={() => void remove(meter)}>削除</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
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
      rows={contracts.map((row) => [
        row.unit?.floor_label ?? "—",
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
  return (
    <div className="table-wrap">
      <table className="workspace-data-table">
        <thead>
          <tr>
            <th rowSpan={2}>階数</th>
            <th rowSpan={2}>区画</th>
            <th rowSpan={2}>テナント名</th>
            <th rowSpan={2}>メーター番号</th>
            <th rowSpan={2}>単価</th>
            <th colSpan={2} className="usage-heading">使用量</th>
            <th rowSpan={2}>金額</th>
          </tr>
          <tr>
            <th>メーターごと</th>
            <th>区画ごと</th>
          </tr>
        </thead>
        <tbody>
          {meters.map((meter) => {
            const unit = meter.assignments[0]?.unit;
            const contract = contracts.find(
              (row) => row.unit?.unit_code === unit?.unit_code,
            );
            const price =
              contract?.prices.find(
                (item) => item.asset_billing_line_item_id === lineItemId,
              )?.unit_price ??
              contract?.categoryPrices.find(
                (item) => item.category === category,
              )?.unit_price ?? null;
            const state =
              saveStates[meter.asset_meter_id] ??
              (meter.entry ? "saved" : "idle");
            const unitUsage = meters
              .filter(
                (row) =>
                  row.assignments[0]?.unit_id &&
                  row.assignments[0]?.unit_id === meter.assignments[0]?.unit_id,
              )
              .reduce((sum, row) => {
                const raw = values[row.asset_meter_id];
                const usage =
                  row.subItem.input_mode === "usage" && raw !== undefined && raw !== ""
                    ? Number(raw)
                    : Number(row.entry?.usage_amount ?? 0);
                return sum + (Number.isFinite(usage) ? usage : 0);
              }, 0);
            return (
              <tr key={meter.asset_meter_id}>
                <td>{unit?.floor_label ?? "—"}</td>
                <td>{unit?.unit_name || unit?.unit_code || "未割当"}</td>
                <td>{contract?.contract?.tenant?.tenant_name ?? "—"}</td>
                <td><strong>{meter.meter_code}</strong></td>
                <td className="numeric">{formatYen(price)}</td>
                <td>
                  <div className="input-with-state">
                    <input
                      className="reading-input"
                      inputMode="decimal"
                      disabled={confirmed}
                      value={values[meter.asset_meter_id] ?? ""}
                      onChange={(event) => onChange(meter, event.target.value)}
                    />
                    {state === "error" && <span className="save-error" title="保存エラー" />}
                  </div>
                </td>
                <td className="numeric">
                  {unit ? unitUsage.toLocaleString("ja-JP") : "—"}
                </td>
                <td className="numeric">—</td>
              </tr>
            );
          })}
          {!meters.length && (
            <tr>
              <td colSpan={8} className="empty-cell">
                対象メーターがありません。
              </td>
            </tr>
          )}
        </tbody>
      </table>
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
      rows={contracts.map((row) => {
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
          row.unit?.floor_label ?? "—",
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
function DataTable({
  headers,
  rows,
}: {
  headers: string[];
  rows: Array<Array<string | number>>;
}) {
  return (
    <div className="table-wrap">
      <table className="workspace-data-table">
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((value, cell) => (
                <td
                  key={cell}
                  className={cell >= row.length - 2 ? "numeric" : ""}
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
      </table>
    </div>
  );
}
function formatYen(value: number | null | undefined) {
  return value == null
    ? "未設定"
    : `${Number(value).toLocaleString("ja-JP")} 円`;
}
