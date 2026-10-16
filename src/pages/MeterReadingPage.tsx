import { useEffect, useState } from "react";
import {
  loadAssetUtilitySettings,
  loadBillingAssets,
  loadContractUnits,
} from "../lib/meteringRepository";
import { supabase } from "../lib/supabase";
import type {
  Asset,
  AssetUtilitySetting,
  ContractUnit,
  UserProfile,
  UtilityCategory,
} from "../types";

const categoryLabel: Record<UtilityCategory, string> = {
  electric: "電気",
  water: "水道",
  gas: "ガス",
};

const currentMonth = new Date().toISOString().slice(0, 7);

export function MeterReadingPage({
  profile,
  onSignOut,
}: {
  profile: UserProfile;
  onSignOut: () => Promise<unknown>;
}) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetId, setAssetId] = useState("");
  const [billingMonth, setBillingMonth] = useState(currentMonth);
  const [category, setCategory] = useState<UtilityCategory>("electric");
  const [settings, setSettings] = useState<AssetUtilitySetting[]>([]);
  const [contracts, setContracts] = useState<ContractUnit[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    void loadBillingAssets(supabase!)
      .then((rows) => {
        setAssets(rows);
        setAssetId(rows[0]?.asset_id ?? "");
      })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!assetId) return;
    setLoading(true);
    setError("");
    void Promise.all([
      loadAssetUtilitySettings(supabase!, assetId),
      loadContractUnits(supabase!, assetId),
    ])
      .then(([nextSettings, nextContracts]) => {
        setSettings(nextSettings);
        setContracts(nextContracts);
        if (!nextSettings.some((row) => row.category === category)) {
          setCategory(nextSettings[0]?.category ?? "electric");
        }
      })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
  }, [assetId, category]);

  const setting = settings.find((row) => row.category === category);

  return (
    <main className="meter-page">
      <header className="meter-header">
        <div className="brand">
          <span>K</span>
          <strong>KANAMETER</strong>
        </div>
        <div className="meter-account">
          <span>{profile.employee?.employee_name ?? profile.email}</span>
          <button type="button" onClick={() => void onSignOut()}>
            ログアウト
          </button>
        </div>
      </header>

      <section className="meter-content">
        <div className="meter-title">
          <div>
            <p className="eyebrow">METER READING</p>
            <h1>検針データ入力</h1>
          </div>
          <div className="meter-actions">
            <button type="button" className="secondary">一時保存</button>
            <button type="button" className="primary compact">確定する</button>
          </div>
        </div>

        <section className="meter-filters">
          <label>
            対象ビル
            <select value={assetId} onChange={(event) => setAssetId(event.target.value)}>
              {assets.map((asset) => (
                <option key={asset.asset_id} value={asset.asset_id}>
                  {asset.asset_code} / {asset.short_name || asset.asset_name}
                </option>
              ))}
            </select>
          </label>
          <label>
            請求月
            <input type="month" value={billingMonth} onChange={(event) => setBillingMonth(event.target.value)} />
          </label>
        </section>

        <div className="category-tabs" role="tablist" aria-label="公共料金の種類">
          {(["electric", "water", "gas"] as UtilityCategory[]).map((item) => {
            const enabled = settings.some((row) => row.category === item);
            return (
              <button key={item} type="button" className={category === item ? "active" : ""} disabled={!enabled} onClick={() => setCategory(item)}>
                {categoryLabel[item]}
              </button>
            );
          })}
        </div>

        {error && <div className="alert">{error}</div>}
        {loading ? (
          <div className="loading">共通DBから契約条件を読み込んでいます…</div>
        ) : (
          <section className="reading-panel">
            <div className="reading-summary">
              <div><span>入力対象</span><strong>{categoryLabel[category]}</strong></div>
              <div><span>単価方式</span><strong>{setting?.price_scope === "category" ? "分類共通" : "項目別"}</strong></div>
              <div><span>対象区画</span><strong>{contracts.length} 件</strong></div>
            </div>
            <div className="table-wrap">
              <table className="reading-table">
                <thead><tr><th>区画</th><th>テナント</th><th>検針値</th><th>使用量</th><th>適用単価</th><th>請求金額</th></tr></thead>
                <tbody>
                  {contracts.map((row) => {
                    const key = `${row.lease_contract_unit_id}:${category}`;
                    const categoryPrice = row.categoryPrices.find((price) => price.category === category)?.unit_price;
                    const linePrice = row.prices.find((price) => price.item?.utility_kind === category)?.unit_price;
                    const unitPrice = categoryPrice ?? linePrice ?? setting?.default_unit_price ?? null;
                    return <tr key={row.lease_contract_unit_id}>
                      <td><strong>{row.unit?.unit_name || row.unit?.unit_code || "—"}</strong><small>{row.unit?.unit_code}</small></td>
                      <td>{row.contract?.tenant?.tenant_name ?? "—"}</td>
                      <td><input className="reading-input" inputMode="decimal" placeholder="0" value={values[key] ?? ""} onChange={(event) => setValues((current) => ({ ...current, [key]: event.target.value }))} /></td>
                      <td className="numeric muted-cell">—</td>
                      <td className="numeric">{unitPrice === null ? "未設定" : `${unitPrice.toLocaleString("ja-JP")} 円`}</td>
                      <td className="numeric calculated">計算待ち</td>
                    </tr>;
                  })}
                  {!contracts.length && <tr><td colSpan={6} className="empty-cell">対象の契約区画はありません。</td></tr>}
                </tbody>
              </table>
            </div>
            <p className="foundation-note">入力値の保存と計算は次の実装段階でDB処理と接続します。</p>
          </section>
        )}
      </section>
    </main>
  );
}
