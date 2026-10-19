import { useEffect, useRef, useState } from 'react';
import { confirmMeterReadingMonth, loadAssetUtilitySettings, loadBillingAssets, loadMeterReadings, saveMeterReading } from '../lib/meteringRepository';
import { supabase } from '../lib/supabase';
import type { Asset, AssetUtilitySetting, MeterReadingRow, UserProfile, UtilityCategory } from '../types';

const labels: Record<UtilityCategory, string> = { electric: '電気', water: '水道', gas: 'ガス' };
const currentMonth = new Date().toISOString().slice(0, 7);
type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export function KanameterInputPage({ profile, onSignOut }: { profile: UserProfile; onSignOut: () => Promise<unknown> }) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetId, setAssetId] = useState('');
  const [billingMonth, setBillingMonth] = useState(currentMonth);
  const [category, setCategory] = useState<UtilityCategory>('electric');
  const [settings, setSettings] = useState<AssetUtilitySetting[]>([]);
  const [meters, setMeters] = useState<MeterReadingRow[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});
  const [status, setStatus] = useState<'draft' | 'confirmed' | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    void loadBillingAssets(supabase!).then((rows) => { setAssets(rows); setAssetId(rows[0]?.asset_id ?? ''); }).catch((reason: Error) => setError(reason.message)).finally(() => setLoading(false));
    return () => Object.values(timers.current).forEach(clearTimeout);
  }, []);

  useEffect(() => {
    if (!assetId) return;
    setLoading(true); setError(''); setNotice('');
    void loadAssetUtilitySettings(supabase!, assetId).then((rows) => {
      setSettings(rows);
      if (!rows.some((row) => row.category === category)) setCategory(rows[0]?.category ?? 'electric');
    }).catch((reason: Error) => setError(reason.message)).finally(() => setLoading(false));
  }, [assetId]);

  const reload = async () => {
    if (!assetId || !billingMonth) return;
    setLoading(true); setError('');
    try {
      const result = await loadMeterReadings(supabase!, assetId, billingMonth, category);
      setMeters(result.rows); setStatus(result.status);
      setValues(Object.fromEntries(result.rows.map((meter) => [meter.asset_meter_id, meter.subItem.input_mode === 'reading' ? meter.entry?.current_reading?.toString() ?? '' : meter.entry?.usage_amount?.toString() ?? ''])));
      setSaveStates({});
    } catch (reason) { setError((reason as Error).message); }
    finally { setLoading(false); }
  };

  useEffect(() => { void reload(); }, [assetId, billingMonth, category]);

  const queueSave = (meter: MeterReadingRow, raw: string) => {
    setValues((current) => ({ ...current, [meter.asset_meter_id]: raw }));
    setNotice('');
    if (timers.current[meter.asset_meter_id]) clearTimeout(timers.current[meter.asset_meter_id]);
    if (raw.trim() === '' || !Number.isFinite(Number(raw)) || Number(raw) < 0) { setSaveStates((current) => ({ ...current, [meter.asset_meter_id]: 'idle' })); return; }
    setSaveStates((current) => ({ ...current, [meter.asset_meter_id]: 'saving' }));
    timers.current[meter.asset_meter_id] = setTimeout(async () => {
      try {
        const saved = await saveMeterReading(supabase!, assetId, billingMonth, meter.asset_meter_id, Number(raw));
        setMeters((current) => current.map((row) => row.asset_meter_id === meter.asset_meter_id ? { ...row, entry: { usage_amount: Number(saved.usage_amount), previous_reading: saved.previous_reading === null ? null : Number(saved.previous_reading), current_reading: saved.current_reading === null ? null : Number(saved.current_reading) } } : row));
        setStatus('draft'); setSaveStates((current) => ({ ...current, [meter.asset_meter_id]: 'saved' }));
      } catch (reason) { setSaveStates((current) => ({ ...current, [meter.asset_meter_id]: 'error' })); setError((reason as Error).message); }
    }, 500);
  };

  const confirm = async () => {
    if (!assetId || status === 'confirmed' || Object.values(saveStates).includes('saving')) return;
    setConfirming(true); setError(''); setNotice('');
    try { await confirmMeterReadingMonth(supabase!, assetId, billingMonth); setStatus('confirmed'); setNotice('KANAMEに連携する確定データとして保存しました。'); }
    catch (reason) { setError((reason as Error).message); }
    finally { setConfirming(false); }
  };

  const setting = settings.find((row) => row.category === category);
  return <main className="meter-page">
    <header className="meter-header"><div className="brand"><span>K</span><strong>KANAMETER</strong></div><div className="meter-account"><span>{profile.employee?.employee_name ?? profile.email}</span><button type="button" onClick={() => void onSignOut()}>ログアウト</button></div></header>
    <section className="meter-content">
      <div className="meter-title"><div><p className="eyebrow">METER READING</p><h1>検針データ入力</h1><p className="autosave-explanation">入力内容は自動保存されます。</p></div><div className="meter-actions"><span className={`month-status ${status ?? 'empty'}`}>{status === 'confirmed' ? 'KANAME連携済み' : status === 'draft' ? '保存済み・未確定' : '未入力'}</span><button type="button" className="primary compact" disabled={confirming || status === 'confirmed' || !meters.some((meter) => meter.entry)} onClick={() => void confirm()}>{confirming ? '確定中…' : status === 'confirmed' ? '確定済み' : 'KANAMEに連携して確定'}</button></div></div>
      <section className="meter-filters"><label>対象ビル<select value={assetId} onChange={(event) => setAssetId(event.target.value)}>{assets.map((asset) => <option key={asset.asset_id} value={asset.asset_id}>{asset.asset_code} / {asset.short_name || asset.asset_name}</option>)}</select></label><label>請求月<input type="month" value={billingMonth} onChange={(event) => setBillingMonth(event.target.value)} /></label></section>
      <div className="category-tabs" role="tablist">{(['electric', 'water', 'gas'] as UtilityCategory[]).map((item) => <button key={item} type="button" className={category === item ? 'active' : ''} disabled={!settings.some((row) => row.category === item)} onClick={() => setCategory(item)}>{labels[item]}</button>)}</div>
      {error && <div className="alert">{error}</div>}{notice && <div className="success-notice">{notice}</div>}
      {loading ? <div className="loading">共通DBから検針データを読み込んでいます…</div> : <section className="reading-panel">
        <div className="reading-summary"><div><span>入力対象</span><strong>{labels[category]}</strong></div><div><span>単価方式</span><strong>{setting?.price_scope === 'category' ? '分類共通' : '項目別'}</strong></div><div><span>対象メーター</span><strong>{meters.length} 件</strong></div></div>
        <div className="table-wrap"><table className="reading-table"><thead><tr><th>設置区画</th><th>メーター</th><th>入力方式</th><th>前回指針</th><th>今回入力</th><th>使用量</th><th>保存状態</th></tr></thead><tbody>
          {meters.map((meter) => { const saveState = saveStates[meter.asset_meter_id] ?? (meter.entry ? 'saved' : 'idle'); const unit = meter.assignments[0]?.unit; return <tr key={meter.asset_meter_id}><td><strong>{unit?.unit_name || unit?.unit_code || '未割当'}</strong><small>{unit?.unit_code}</small></td><td><strong>{meter.meter_code}</strong><small>{meter.meter_label || meter.subItem.sub_item_name}</small></td><td>{meter.subItem.input_mode === 'reading' ? '指針' : '使用量'}</td><td className="numeric">{meter.subItem.input_mode === 'reading' ? meter.entry?.previous_reading?.toLocaleString('ja-JP') ?? '—' : '—'}</td><td><input className="reading-input" inputMode="decimal" placeholder="0" disabled={status === 'confirmed'} value={values[meter.asset_meter_id] ?? ''} onChange={(event) => queueSave(meter, event.target.value)} /></td><td className="numeric">{meter.entry ? Number(meter.entry.usage_amount).toLocaleString('ja-JP') : '—'}</td><td><span className={`save-state ${saveState}`}>{saveState === 'saving' ? '保存中…' : saveState === 'saved' ? '保存済み' : saveState === 'error' ? '保存エラー' : '未入力'}</span></td></tr>; })}
          {!meters.length && <tr><td colSpan={7} className="empty-cell">この分類にメーターが登録されていません。</td></tr>}
        </tbody></table></div>
      </section>}
    </section>
  </main>;
}
