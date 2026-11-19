import { useEffect, useState } from 'react';
import { loadMeterReadings } from '../lib/meteringRepository';
import { supabase } from '../lib/supabase';
import { calculateHotelAllocation } from '../lib/hotelAllocation';
import type { Asset, MeterReadingRow } from '../types';

type Building = 'fukushima' | 'osaka' | 'kobe';
type Utility = 'electric' | 'water' | 'gas';
type MeterItem = { id: string; name: string; meterId: string; referenceMethod?: 'meter' | 'special'; specialKey?: string };
type MeterGroup = { hotel: MeterItem[]; tenant: MeterItem[] };
type SpecialDefinition = { id: string; name: string; definition: { fields: Array<{ key: string; label: string }> }; subItem: { category: Utility } };
type SpecialResult = { calculation_id: string; result_snapshot: Record<string, number> };
const names: Record<Building, string> = { fukushima: '福島', osaka: '大阪RH', kobe: '神戸' };
const utilities: Record<Building, Utility[]> = { fukushima: ['electric', 'water'], osaka: ['electric', 'water', 'gas'], kobe: ['electric'] };
const utilityNames: Record<Utility, string> = { electric: '電気', water: '水道', gas: 'ガス' };
const units: Record<Utility, string> = { electric: 'kWh', water: '㎥', gas: '㎥' };
const numeric = (raw: string) => raw.trim() === '' ? null : Number(raw.replace(/,/g, ''));
const usageOf = (meter?: MeterReadingRow): number | null => meter?.fixedValue?.usage ?? meter?.entry?.usage_amount ?? null;
const format = (value: number) => value.toLocaleString('ja-JP', { maximumFractionDigits: 12 });
const defaultGroup = (): MeterGroup => ({ hotel: [{ id: 'hotelMain', name: 'ホテル棟使用量メーター', meterId: '' }], tenant: [] });

export function HotelUtilityAllocation({ assets, initialMonth, initialBuilding = 'kobe', initialUtility = 'electric', onOpenMetering }: { assets: Asset[]; initialMonth: string; initialBuilding?: Building; initialUtility?: Utility; onOpenMetering: (assetId: string, month: string, utility: Utility) => void }) {
  const [building, setBuilding] = useState<Building>(initialBuilding);
  const [utility, setUtility] = useState<Utility>(initialUtility);
  const [editingMeters, setEditingMeters] = useState(false);
  const [months, setMonths] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem('kanameter-hotel-allocation-draft') ?? '{}') as Record<string, string>; }
    catch { return {}; }
  });
  const [groups, setGroups] = useState<Record<string, MeterGroup>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('kanameter-hotel-allocation-meters') ?? '{}') as Record<string, MeterGroup>;
      if (saved['kobe:electric']) return saved;
      const legacy = (role: string) => draft[`kobe:electric:meter:${role}`] ?? '';
      if (!['hotelMain', 'sevenEleven', 'kudo', 'taisei'].some(legacy)) return saved;
      return { ...saved, 'kobe:electric': {
        hotel: [{ id: 'hotelMain', name: 'ホテル棟使用量メーター', meterId: legacy('hotelMain') }],
        tenant: [['sevenEleven', 'セブン-イレブン'], ['kudo', 'クドウ'], ['taisei', '大成観光開発']]
          .filter(([role]) => legacy(role))
          .map(([role, name]) => ({ id: role, name, meterId: legacy(role) })),
      } };
    } catch { return {}; }
  });
  const [meters, setMeters] = useState<MeterReadingRow[]>([]);
  const [meterLoadedKey, setMeterLoadedKey] = useState('');
  const [specialDefinitions, setSpecialDefinitions] = useState<SpecialDefinition[]>([]);
  const [specialResults, setSpecialResults] = useState<SpecialResult[]>([]);
  const [specialLoadedKey, setSpecialLoadedKey] = useState('');
  const [specialError, setSpecialError] = useState('');
  const [specialLoading, setSpecialLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const monthKey = `${building}:${utility}`;
  const month = months[monthKey] ?? initialMonth;
  const group = groups[monthKey] ?? defaultGroup();
  const updateGroup = (next: MeterGroup) => setGroups(current => ({ ...current, [monthKey]: next }));
  const updateMeter = (section: keyof MeterGroup, id: string, patch: Partial<MeterItem>) => updateGroup({ ...group, [section]: group[section].map(row => row.id === id ? { ...row, ...patch } : row) });
  const addMeter = (section: keyof MeterGroup) => updateGroup({ ...group, [section]: [...group[section], { id: crypto.randomUUID(), name: '', meterId: '' }] });
  const removeMeter = (section: keyof MeterGroup, id: string) => updateGroup({ ...group, [section]: group[section].filter(row => row.id !== id) });
  const fieldKey = (field: string) => field.startsWith('meter:') ? `${building}:${utility}:${field}` : `${building}:${utility}:${month}:${field}`;
  const get = (field: string) => draft[fieldKey(field)] ?? '';
  const set = (field: string, value: string) => setDraft(current => ({ ...current, [fieldKey(field)]: value }));
  const asset = assets.find(row => building === 'kobe' ? /神戸.*ツイン|ツイン.*神戸/.test(row.asset_name) : building === 'fukushima' ? /福島/.test(row.asset_name) : /リバーサイド|大阪RH/.test(row.asset_name));
  useEffect(() => { localStorage.setItem('kanameter-hotel-allocation-draft', JSON.stringify(draft)); }, [draft]);
  useEffect(() => { localStorage.setItem('kanameter-hotel-allocation-meters', JSON.stringify(groups)); }, [groups]);
  useEffect(() => {
    if (utility !== 'electric' || !asset) { setMeters([]); setMeterLoadedKey(''); return; }
    let active = true;
    setLoading(true); setError(''); setMeters([]); setMeterLoadedKey('');
    void loadMeterReadings(supabase!, asset.asset_id, month, utility)
      .then(result => { if (active) { setMeters(result.rows); setMeterLoadedKey(`${asset.asset_id}:${utility}:${month}`); } })
      .catch((reason: Error) => { if (active) setError(reason.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [asset?.asset_id, building, utility, month]);
  useEffect(() => {
    if (utility !== 'electric' || !asset) { setSpecialDefinitions([]); setSpecialResults([]); setSpecialLoadedKey(''); return; }
    let active = true;
    setSpecialLoading(true); setSpecialError(''); setSpecialDefinitions([]); setSpecialResults([]); setSpecialLoadedKey('');
    void Promise.all([
      supabase!.from('asset_meter_special_calculation').select('id,name,definition,subItem:asset_meter_sub_item!inner(category)').eq('asset_id', asset.asset_id).eq('subItem.category', utility),
      supabase!.from('meter_reading_month_special_calculation').select('calculation_id,result_snapshot').eq('asset_id', asset.asset_id).eq('billing_month', `${month}-01`),
    ]).then(([definitions, results]) => {
      if (definitions.error) throw definitions.error;
      if (results.error) throw results.error;
      if (!active) return;
      setSpecialDefinitions((definitions.data ?? []) as unknown as SpecialDefinition[]);
      setSpecialResults((results.data ?? []) as SpecialResult[]);
      setSpecialLoadedKey(`${asset.asset_id}:${utility}:${month}`);
    }).catch((reason: Error) => { if (active) setSpecialError(reason.message); })
      .finally(() => { if (active) setSpecialLoading(false); });
    return () => { active = false; };
  }, [asset?.asset_id, building, utility, month]);

  const amount = numeric(get('amount'));
  const totalUsage = numeric(get('totalUsage'));
  const unitPrice = amount !== null && Number.isInteger(amount) && amount >= 0 && totalUsage !== null && totalUsage > 0 ? amount / totalUsage : null;
  const selectedRows = [...group.hotel, ...group.tenant];
  const selectedIds = selectedRows.filter(row => row.referenceMethod !== 'special').map(row => row.meterId).filter(Boolean);
  const usageFor = (row: MeterItem): number | null => {
    if (row.referenceMethod === 'special') {
      if (specialLoadedKey !== `${asset?.asset_id}:${utility}:${month}`) return null;
      const [calculationId, fieldKey] = (row.specialKey ?? '').split(':');
      const value = specialResults.find(result => result.calculation_id === calculationId)?.result_snapshot?.[fieldKey];
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }
    if (meterLoadedKey !== `${asset?.asset_id}:${utility}:${month}`) return null;
    return usageOf(meters.find(meter => meter.asset_meter_id === row.meterId));
  };
  const hotelValues = group.hotel.map(row => (row.referenceMethod === 'special' ? row.specialKey : row.meterId) ? usageFor(row) : null);
  const tenantValues = group.tenant.map(row => row.meterId ? usageFor(row) : null);
  const hotelUsage = utility === 'electric' && group.hotel.length > 0 && [...hotelValues, ...tenantValues].every(value => value !== null)
    ? hotelValues.reduce<number>((sum, value) => sum + (value ?? 0), 0) - tenantValues.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null;
  const duplicateMeter = new Set(selectedIds).size !== selectedIds.length;
  const selectedSpecialKeys = group.hotel.filter(row => row.referenceMethod === 'special').map(row => row.specialKey).filter(Boolean);
  const duplicateSpecialKey = new Set(selectedSpecialKeys).size !== selectedSpecialKeys.length;
  const allocation = calculateHotelAllocation(
    building, utility, month, draft, group,
    meterLoadedKey === `${asset?.asset_id}:${utility}:${month}` ? meters : [],
    specialLoadedKey === `${asset?.asset_id}:${utility}:${month}` ? specialResults : [],
  );
  const valid = allocation !== null;
  const hotelAmount = allocation?.hotelAmount ?? null;
  const buildingAmount = allocation?.buildingAmount ?? null;
  const displayedHotelUsage = allocation?.hotelUsage ?? null;
  const displayedBuildingUsage = allocation?.buildingUsage ?? null;

  const meterSection = (section: keyof MeterGroup, title: string) => <div className="hotel-allocation-meter-section">
    <div className="hotel-allocation-meter-heading"><h4>{title}</h4>{editingMeters && <button type="button" onClick={() => addMeter(section)}>＋ メーターを追加</button>}</div>
    {editingMeters && <div className={`hotel-allocation-meter-columns ${section === 'hotel' ? 'with-method' : ''}`} aria-hidden="true"><span>識別名</span>{section === 'hotel' && <span>参照方法</span>}<span>参照先（参照メーター）</span><span>使用量</span><span /></div>}
    {group[section].map(row => editingMeters ? <div className={`hotel-allocation-meter-row ${section === 'hotel' ? 'with-method' : ''}`} key={row.id}>
      <input aria-label="識別名" value={row.name} placeholder="例：ホテル主メーター" onChange={event => updateMeter(section, row.id, { name: event.target.value })} />
      {section === 'hotel' && <select aria-label="参照方法" value={row.referenceMethod ?? 'meter'} onChange={event => updateMeter(section, row.id, { referenceMethod: event.target.value as 'meter' | 'special', meterId: '', specialKey: '' })}>
        <option value="meter">メーターの使用量を参照</option><option value="special">特殊計算の結果を参照</option>
      </select>}
      {section === 'hotel' && row.referenceMethod === 'special' ? <select aria-label="参照先" value={row.specialKey ?? ''} onChange={event => updateMeter(section, row.id, { specialKey: event.target.value })}>
        <option value="">特殊計算の結果キーを選択</option>
        {specialDefinitions.map(calculation => <optgroup key={calculation.id} label={calculation.name}>
          {calculation.definition.fields.map(field => <option key={field.key} value={`${calculation.id}:${field.key}`}>{field.label}（{field.key}）</option>)}
        </optgroup>)}
      </select> : <select aria-label="参照メーター" value={row.meterId} onChange={event => updateMeter(section, row.id, { meterId: event.target.value })}>
        <option value="">メーターを選択</option>
        {meters.map(meter => <option key={meter.asset_meter_id} value={meter.asset_meter_id}>
          {meter.subItem.sub_item_name} / {meter.meter_code}{meter.assignments.length ? '' : '（テナント紐づけなし）'} — {usageOf(meter) === null ? '使用量未入力' : `${format(usageOf(meter)!)} ${units[utility]}`}
        </option>)}
      </select>}
      <span className="hotel-allocation-meter-value">{usageFor(row) !== null ? `${format(usageFor(row)!)} ${units[utility]}` : '—'}</span>
      <button type="button" className="hotel-allocation-remove" onClick={() => removeMeter(section, row.id)}>削除</button>
    </div> : <div className="hotel-allocation-meter-summary" key={row.id}><span>{row.name || '名称未設定'}</span><strong>{usageFor(row) !== null ? `${format(usageFor(row)!)} ${units[utility]}` : '—'}</strong></div>)}
  </div>;

  return <section className="hotel-allocation">
    <div className="hotel-allocation-heading"><div><h2>ホテル棟公共料金按分</h2><p>公共料金会社からの請求内容と検針メーターを使用します。</p></div>
      <div className="hotel-allocation-heading-actions"><label className="hotel-allocation-building-picker"><span>対象棟</span><select value={building} onChange={event => { const next = event.target.value as Building; setBuilding(next); setUtility(utilities[next][0]); setEditingMeters(false); }}>
        {(Object.keys(names) as Building[]).map(key => <option key={key} value={key}>{names[key]}</option>)}
      </select></label><button type="button" className="hotel-allocation-open-metering" disabled={!asset} onClick={() => asset && onOpenMetering(asset.asset_id, month, utility)}>検針画面へ移動</button></div></div>
    <div className="hotel-allocation-switches">{utilities[building].map(key => <button type="button" key={key} className={`utility-${key} ${utility === key ? 'active' : ''}`} onClick={() => { setUtility(key); setEditingMeters(false); }}>{utilityNames[key]}</button>)}</div>
    <label className="hotel-allocation-month-picker">精算月 <span className="month-control"><button type="button" className="month-arrow" aria-label="前月へ" onClick={() => { const [y, m] = month.split('-').map(Number); const next = new Date(Date.UTC(y, m - 2, 1)); setMonths(current => ({ ...current, [monthKey]: `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}` })); }}>◀</button><input type="month" value={month} onChange={event => setMonths(current => ({ ...current, [monthKey]: event.target.value }))} /><button type="button" className="month-arrow" aria-label="翌月へ" onClick={() => { const [y, m] = month.split('-').map(Number); const next = new Date(Date.UTC(y, m, 1)); setMonths(current => ({ ...current, [monthKey]: `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}` })); }}>▶</button></span></label>
    <section className="hotel-allocation-card"><h3>請求項目</h3>
      <div className="hotel-allocation-fields">
        <label>使用期間 開始<input type="date" value={get('periodStart')} onChange={event => set('periodStart', event.target.value)} /></label>
        <label>使用期間 終了<input type="date" value={get('periodEnd')} onChange={event => set('periodEnd', event.target.value)} /></label>
        <label>使用量<span><input type="number" min="0" step="any" value={get('totalUsage')} onChange={event => set('totalUsage', event.target.value)} /> {units[utility]}</span></label>
        <label>引落額（税込）<span><input type="number" min="0" step="1" value={get('amount')} onChange={event => set('amount', event.target.value)} /> 円</span></label>
      </div><div className="hotel-allocation-unit-price"><span>原単価（引落額 ÷ 使用量）</span><strong>{unitPrice === null ? '—' : `${unitPrice} 円/${units[utility]}`}</strong></div>
      <p className="hotel-allocation-note">原単価は丸めずに計算します。入力値はこのブラウザーに下書き保存されます。</p>
    </section>
    <section className="hotel-allocation-card"><div className="hotel-allocation-card-heading"><h3>計算</h3>{utility === 'electric' && <button type="button" onClick={() => setEditingMeters(current => !current)}>{editingMeters ? '編集を完了' : 'メーター設定を編集'}</button>}</div>
      {utility === 'electric' ? <>
        <p className="hotel-allocation-note">ホテル棟使用量メーターの合計から、ホテル棟内テナントメーターの合計を差し引きます。テナントに紐づかないメーターも選択できます。</p>
        {(loading || specialLoading) && <p>参照データを読み込んでいます…</p>}{error && <p className="hotel-allocation-error">{error}</p>}{specialError && <p className="hotel-allocation-error">{specialError}</p>}{!asset && <p className="hotel-allocation-error">{names[building]}のビルが見つかりません。</p>}
        {meterSection('hotel', 'ホテル棟使用量メーター')}
        {meterSection('tenant', 'ホテル棟内テナントメーター（控除）')}
        {duplicateMeter && <p className="hotel-allocation-error">同じメーターを複数の項目に選択できません。</p>}
        {duplicateSpecialKey && <p className="hotel-allocation-error">同じ特殊計算の結果キーを複数の項目に選択できません。</p>}
        {group.hotel.some(row => row.referenceMethod === 'special' && row.specialKey && usageFor(row) === null) && !specialLoading && <p className="hotel-allocation-error">選択した精算月の特殊計算結果が保存されていないか、参照キーがありません。</p>}
        {hotelUsage !== null && !valid && <p className="hotel-allocation-error">ホテル棟使用量は0以上、請求使用量以下にしてください。</p>}
      </> : <p className="hotel-allocation-note">{names[building]}のメーター参照ルールを確認中です。請求内容は入力できます。</p>}
      <div className="hotel-allocation-results"><div><span>ホテル</span><small>使用量</small><strong>{displayedHotelUsage === null ? '—' : `${format(displayedHotelUsage)} ${units[utility]}`}</strong><small>金額</small><strong>{hotelAmount === null ? '—' : `${format(hotelAmount)} 円`}</strong></div>
        <div><span>ビル</span><small>使用量</small><strong>{displayedBuildingUsage === null ? '—' : `${format(displayedBuildingUsage)} ${units[utility]}`}</strong><small>金額</small><strong>{buildingAmount === null ? '—' : `${format(buildingAmount)} 円`}</strong></div></div>
    </section>
  </section>;
}
