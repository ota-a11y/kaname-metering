import { useEffect, useRef, useState } from "react";
import {
  confirmMeterReadingMonth,
  loadAssetUtilitySettings,
  loadBillingAssets,
  loadContractUnits,
  loadMeteringConfiguration,
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
    ])
      .then(([prices, config, contractRows]) => {
        setUtilitySettings(prices);
        setCategorySettings(config.categories);
        setSubItems(config.subItems);
        setSurcharges(config.surcharges);
        setContracts(contractRows);
      })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
  }, [assetId]);

  const activeCategory = categories.includes(mainTab as UtilityCategory)
    ? (mainTab as UtilityCategory)
    : null;
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
    <div className="workspace-shell">
      <aside className="building-sidebar">
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
          <SettingsView />
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
function SettingsView() {
  return (
    <section className="settings-placeholder">
      <span>⚙</span>
      <h1>KANAMETER設定</h1>
      <p>設定項目は今後追加します。</p>
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
            {[
              "階数",
              "区画",
              "テナント名",
              "メーター番号",
              "単価",
              "使用量（メーターごと）",
              "使用量（区画ごと）",
              "金額",
            ].map((header) => (
              <th key={header}>{header}</th>
            ))}
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
            return (
              <tr key={meter.asset_meter_id}>
                <td>{unit?.floor_label ?? "—"}</td>
                <td>{unit?.unit_name || unit?.unit_code || "未割当"}</td>
                <td>{contract?.contract?.tenant?.tenant_name ?? "—"}</td>
                <td>
                  <strong>{meter.meter_code}</strong>
                  <small>{meter.meter_label}</small>
                </td>
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
                    <small className={`save-state ${state}`}>
                      {state === "saving"
                        ? "保存中…"
                        : state === "saved"
                          ? "保存済み"
                          : state === "error"
                            ? "エラー"
                            : ""}
                    </small>
                  </div>
                </td>
                <td className="numeric">
                  {meter.entry
                    ? Number(meter.entry.usage_amount).toLocaleString("ja-JP")
                    : "—"}
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
