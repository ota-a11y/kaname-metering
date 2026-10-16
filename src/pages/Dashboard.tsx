import { useEffect, useMemo, useState } from 'react';
import { loadAssetUtilitySettings, loadBillingAssets, loadContractUnits } from '../lib/meteringRepository';
import { supabase } from '../lib/supabase';
import type { Asset, AssetUtilitySetting, ContractUnit, UserProfile, UtilityCategory } from '../types';

const categoryLabel: Record<UtilityCategory, string> = { electric: '電気', water: '水道', gas: 'ガス' };
const roundingLabel = { floor: '切り捨て', round: '四捨五入', ceil: '切り上げ' } as const;
const yen = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 4 });

export function Dashboard({ profile, onSignOut }: { profile: UserProfile; onSignOut: () => Promise<unknown> }) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetId, setAssetId] = useState('');
  const [settings, setSettings] = useState<AssetUtilitySetting[]>([]);
  const [contracts, setContracts] = useState<ContractUnit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => { void loadBillingAssets(supabase!).then((rows) => { setAssets(rows); setAssetId(rows[0]?.asset_id ?? ''); }).catch((reason: Error) => setError(reason.message)).finally(() => setLoading(false)); }, []);
  useEffect(() => {
    if (!assetId) { setSettings([]); setContracts([]); return; }
    setLoading(true); setError('');
    void Promise.all([loadAssetUtilitySettings(supabase!, assetId), loadContractUnits(supabase!, assetId)])
      .then(([nextSettings, nextContracts]) => { setSettings(nextSettings); setContracts(nextContracts); })
      .catch((reason: Error) => setError(reason.message)).finally(() => setLoading(false));
  }, [assetId]);
  const selected = assets.find((asset) => asset.asset_id === assetId);
  const configured = useMemo(() => contracts.filter((row) => row.prices.length || row.categoryPrices.length || row.basics.length).length, [contracts]);
  return <div className="app-shell"><aside className="sidebar"><div className="brand inverse"><span>K</span><strong>KANAME</strong></div><p className="product-name">METERING</p><nav><button className="nav-active"><i>▦</i>検針ダッシュボード</button><button disabled><i>≡</i>検針入力（準備中）</button><button disabled><i>✓</i>確定履歴（準備中）</button></nav><div className="sidebar-footer"><strong>{profile.employee?.employee_name ?? profile.email}</strong><small>{profile.employee?.department?.department_name ?? profile.role}</small><button onClick={() => void onSignOut()}>ログアウト</button></div></aside>
    <main className="content"><header><div><p className="eyebrow">METERING FOUNDATION</p><h1>検針データ管理</h1></div><label className="asset-select">対象ビル<select value={assetId} onChange={(event) => setAssetId(event.target.value)}><option value="">選択してください</option>{assets.map((asset) => <option key={asset.asset_id} value={asset.asset_id}>{asset.asset_code} / {asset.short_name || asset.asset_name}</option>)}</select></label></header>
      {error && <div className="alert">{error}</div>}
      {loading ? <div className="loading">共通DBから設定を読み込んでいます…</div> : !selected ? <Empty /> : <>
        <section className="summary-grid"><Summary label="対象ビル" value={selected.short_name || selected.asset_name} note={`Asset code ${selected.asset_code}`} /><Summary label="公共料金の分類" value={`${settings.length} 分類`} note={settings.map((row) => categoryLabel[row.category]).join(' / ') || '未設定'} /><Summary label="契約区画" value={`${contracts.length} 件`} note={`料金設定あり ${configured} 件`} /></section>
        <section className="panel"><div className="panel-heading"><div><p className="eyebrow">BUILDING SETTINGS</p><h2>ビルごとの公共料金設定</h2></div><span className="read-only">読み取り専用</span></div><div className="setting-cards">{settings.length ? settings.map((row) => <article key={row.category}><span>{categoryLabel[row.category]}</span><strong>{row.price_scope === 'category' ? '分類共通単価' : '項目別単価'}</strong><p>既定単価　{row.default_unit_price === null ? '—' : `${yen.format(row.default_unit_price)} 円`}</p><small>{row.default_tax_mode === 'exclusive' ? '税抜' : '税込'}</small></article>) : <p className="empty-inline">KANAMEでビルの公共料金設定を登録すると表示されます。</p>}</div></section>
        <section className="panel"><div className="panel-heading"><div><p className="eyebrow">CONTRACT TERMS</p><h2>契約区画ごとの計算条件</h2></div><span className="read-only">KANAMEを参照</span></div><div className="table-wrap"><table><thead><tr><th>区画</th><th>テナント</th><th>基本料</th><th>項目単価</th><th>分類単価</th><th>小数点処理</th></tr></thead><tbody>{contracts.length ? contracts.map((row) => <tr key={row.lease_contract_unit_id}><td><strong>{row.unit?.unit_name || row.unit?.unit_code || '—'}</strong><small>{row.unit?.unit_code}</small></td><td>{row.contract?.tenant?.tenant_name ?? '—'}</td><td>{listTerms(row.basics.map((item) => `${categoryLabel[item.category]} ${yen.format(item.amount)}円`))}</td><td>{listTerms(row.prices.map((item) => `${item.item?.line_item_name ?? '明細'} ${yen.format(item.unit_price)}円`))}</td><td>{listTerms(row.categoryPrices.map((item) => `${categoryLabel[item.category]} ${yen.format(item.unit_price)}円`))}</td><td>{roundingLabel[row.utility_amount_rounding_mode]}</td></tr>) : <tr><td colSpan={6} className="empty-cell">対象の契約区画はありません。</td></tr>}</tbody></table></div></section>
      </>}
    </main></div>;
}
function Summary({ label, value, note }: { label: string; value: string; note: string }) { return <article className="summary"><p>{label}</p><strong>{value}</strong><small>{note}</small></article>; }
function listTerms(items: string[]) { return items.length ? <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul> : <span className="unset">未設定</span>; }
function Empty() { return <section className="empty"><strong>請求対象ビルがありません</strong><p>KANAMEのアセット設定で「テナント請求」を有効にしてください。</p></section>; }
