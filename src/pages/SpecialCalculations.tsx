import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { supabase } from '../lib/supabase';
import { calculateSpecial, type CalculationDefinition, type CalculationField } from '../lib/specialCalculation';
import { createMeter, reorderMeters } from '../lib/meteringRepository';

type Saved = { id: string; name: string; definition: CalculationDefinition; output_asset_meter_id?: string | null; amount_mode?: 'fixed_unit_price' | 'special' };
type Meter = { id: string; label: string };
const normalizeNumberInput = (value: string) => value.replace(/,/g, '').replace(/[^0-9.-]/g, '');
const formatNumberInput = (value: string | undefined) => {
  if (!value?.trim()) return '';
  const normalized = normalizeNumberInput(value);
  const [integer, decimal] = normalized.split('.');
  const numeric = Number(integer);
  if (!Number.isFinite(numeric)) return value;
  return `${numeric.toLocaleString('ja-JP')}${decimal === undefined ? '' : `.${decimal}`}`;
};
export function SpecialCalculations({ assetId, subItemId, month, settings, confirmed, onNotice, onSaved }: { assetId: string; subItemId: string; month: string; settings: boolean; confirmed: boolean; onNotice?: (message: string) => void; onSaved?: () => void | Promise<void> }) {
  const [items, setItems] = useState<Saved[]>([]);
  const [meters, setMeters] = useState<Meter[]>([]);
  const [editing, setEditing] = useState<Saved | null>(null);
  const [managing, setManaging] = useState(false);
  const [running, setRunning] = useState<Saved | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [meterValues, setMeterValues] = useState<Record<string, number | null>>({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Record<string, { usage_amount: number; billed_amount: number | null }>>({});
  const [tags, setTags] = useState<Array<{ asset_meter_tag_id: string; tag_name: string }>>([]);
  const [rowTags, setRowTags] = useState<Record<string, string>>({});
  useEffect(() => { let active = true; void (async () => {
    const [r, t, d] = await Promise.all([
      supabase!.from('meter_reading_month_special_calculation').select('calculation_id,usage_amount,billed_amount').eq('asset_id', assetId).eq('billing_month', `${month}-01`),
      supabase!.from('asset_meter_tag').select('asset_meter_tag_id,tag_name').eq('asset_id', assetId),
      supabase!.from('asset_meter_special_calculation').select('id,asset_meter_tag_id').eq('asset_id', assetId).eq('asset_meter_sub_item_id', subItemId),
    ]);
    if (!active) return;
    setResults(Object.fromEntries((r.data ?? []).map(row => [row.calculation_id, row])));
    setTags(t.data ?? []); setRowTags(Object.fromEntries((d.data ?? []).map(row => [row.id, row.asset_meter_tag_id ?? ''])));
  })(); return () => { active = false; }; }, [assetId, subItemId, month]);
  useEffect(() => {
    let active = true;
    setItems([]); setEditing(null); setManaging(false); setRunning(null); setMessage('');
    void (async () => {
      const [definitions, registered] = await Promise.all([
        supabase!.from('asset_meter_special_calculation').select('id,name,definition,output_asset_meter_id,amount_mode').eq('asset_id', assetId).eq('asset_meter_sub_item_id', subItemId).order('name'),
        supabase!.from('asset_meter').select('asset_meter_id,meter_code,subItem:asset_meter_sub_item(sub_item_name)').eq('asset_id', assetId).eq('is_active', true),
      ]);
      if (!active) return;
      if (definitions.error || registered.error) { setMessage((definitions.error || registered.error)!.message); return; }
      setItems(definitions.data as Saved[]);
      setMeters((registered.data ?? []).map(row => ({ id: row.asset_meter_id, label: `${(row.subItem as unknown as { sub_item_name: string })?.sub_item_name ?? ''} / ${row.meter_code}` })));
    })();
    return () => { active = false; };
  }, [assetId, subItemId, month]);
  const changeField = (index: number, patch: Partial<CalculationField>) => setEditing(current => current && ({ ...current, definition: { ...current.definition, fields: current.definition.fields.map((field, i) => i === index ? { ...field, ...patch } : field) } }));
  const saveDefinition = async () => {
    if (!editing?.name.trim()) { setMessage('特殊計算名を入力してください。'); return; }
    const keys = editing.definition.fields.map(f => f.key);
    const amountMode = editing.definition.amountMode ?? editing.amount_mode ?? 'special';
    if (new Set(keys).size !== keys.length || keys.some(k => !/^[A-Za-z][A-Za-z0-9_]*$/.test(k)) || !keys.includes(editing.definition.usageKey) || (amountMode === 'special' && !keys.includes(editing.definition.amountKey)) || editing.definition.fields.some(f => !f.label.trim() || (!['input', 'reading'].includes(f.source) && !f.expression.trim()) || (f.source === 'reading' && (!Number.isInteger(f.multiplier ?? 1) || (f.multiplier ?? 1) < 1)))) { setMessage('キー・名称・計算式・参照メーター・出力キー・乗率を正しく指定してください。'); return; }
    setBusy(true);
    let outputMeterId = editing.output_asset_meter_id ?? null;
    try {
      if (!outputMeterId) {
        outputMeterId = await createMeter(supabase!, assetId, subItemId, editing.name.trim(), null);
        const meters = await supabase!.from('asset_meter').select('asset_meter_id').eq('asset_id', assetId).eq('asset_meter_sub_item_id', subItemId).eq('is_active', true).order('sort_order');
        if (meters.error) throw meters.error;
        await reorderMeters(supabase!, assetId, subItemId, (meters.data ?? []).map(row => row.asset_meter_id));
      }
      const meterUpdate = await supabase!.from('asset_meter').update({ meter_code: editing.name.trim(), use_reading_input: false }).eq('asset_meter_id', outputMeterId);
      if (meterUpdate.error) throw meterUpdate.error;
    } catch (reason) {
      setBusy(false); setMessage((reason as Error).message); return;
    }
    const savedItem = { ...editing, output_asset_meter_id: outputMeterId, amount_mode: amountMode, definition: { ...editing.definition, amountMode } };
    const { error } = await supabase!.from('asset_meter_special_calculation').upsert({ id: savedItem.id, name: savedItem.name, definition: savedItem.definition, output_asset_meter_id: outputMeterId, amount_mode: amountMode, asset_id: assetId, asset_meter_sub_item_id: subItemId });
    setBusy(false);
    if (error) { setMessage(error.message); return; }
    setItems(current => [...current.filter(i => i.id !== editing.id), savedItem]); setEditing(null); setManaging(false); setMessage(''); await onSaved?.(); onNotice?.('特殊計算を登録しました。');
  };
  const openRun = async (item: Saved) => {
    setBusy(true); setMessage('');
    const [year, monthNumber] = month.split('-').map(Number);
    const previousMonth = new Date(Date.UTC(year, monthNumber - 2, 1)).toISOString().slice(0, 10);
    const [entries, saved, previousReadings] = await Promise.all([
      supabase!.from('meter_reading_entry').select('asset_meter_id,usage_amount').eq('asset_id', assetId).eq('billing_month', `${month}-01`),
      supabase!.from('meter_reading_month_special_calculation').select('inputs,definition_snapshot').eq('calculation_id', item.id).eq('billing_month', `${month}-01`).maybeSingle(),
      supabase!.from('meter_special_calculation_reading').select('field_key,current_reading').eq('calculation_id', item.id).eq('billing_month', previousMonth),
    ]);
    setBusy(false);
    if (entries.error || saved.error || previousReadings.error) { setMessage((entries.error || saved.error || previousReadings.error)!.message); return; }
    setMeterValues(Object.fromEntries((entries.data ?? []).map(e => [e.asset_meter_id, e.usage_amount == null ? null : Number(e.usage_amount)])));
    const nextInputs = { ...(saved.data?.inputs ?? {}) };
    const carryovers = Object.fromEntries((previousReadings.data ?? []).map(row => [row.field_key, row.current_reading]));
    if (!saved.data && !previousReadings.data?.length) {
      const previous = await supabase!.from('meter_reading_month_special_calculation').select('inputs').eq('calculation_id', item.id).lt('billing_month', `${month}-01`).order('billing_month', { ascending: false }).limit(1).maybeSingle();
      for (const field of item.definition.fields.filter(f => f.source === 'reading')) {
        const value = previous.data?.inputs?.[`${field.key}_current`];
        if (value != null) nextInputs[`${field.key}_previous`] = value;
      }
    }
    for (const field of item.definition.fields.filter(f => f.source === 'reading')) {
      if (carryovers[field.key] != null) nextInputs[`${field.key}_previous`] = String(carryovers[field.key]);
    }
    setInputs(nextInputs);
    setRunning({ ...item, definition: saved.data?.definition_snapshot ?? item.definition });
  };
  let result: ReturnType<typeof calculateSpecial> | null = null;
  let calculationError = '';
  if (running) { try { result = calculateSpecial(running.definition, inputs, meterValues); } catch (error) { calculationError = (error as Error).message; } }
  const saveResult = async () => {
    if (!running || !result) return;
    setBusy(true);
    const billedAmount = result.amount ?? 0;
    let { error } = await supabase!.from('meter_reading_month_special_calculation').upsert({ asset_id: assetId, calculation_id: running.id, billing_month: `${month}-01`, inputs, definition_snapshot: running.definition, result_snapshot: result.values, usage_amount: result.usage, billed_amount: billedAmount }, { onConflict: 'calculation_id,billing_month' });
    if (!error && running.output_asset_meter_id) {
      const entry = await supabase!.from('meter_reading_entry').upsert({ asset_id: assetId, asset_meter_id: running.output_asset_meter_id, billing_month: `${month}-01`, usage_amount: result.usage, previous_reading: null, current_reading: null, previous_reading_manual: false, updated_at: new Date().toISOString() }, { onConflict: 'asset_id,billing_month,asset_meter_id' });
      error = entry.error;
      if (!error) error = (await supabase!.from('meter_reading_month').upsert({ asset_id: assetId, billing_month: `${month}-01`, status: 'draft' }, { onConflict: 'asset_id,billing_month' })).error;
    }
    if (!error) {
      const readingRows = running.definition.fields.filter(field => field.source === 'reading' && inputs[`${field.key}_current`]?.trim()).map(field => ({ calculation_id: running.id, asset_id: assetId, billing_month: `${month}-01`, field_key: field.key, current_reading: Number(inputs[`${field.key}_current`]), updated_at: new Date().toISOString() }));
      if (readingRows.length) error = (await supabase!.from('meter_special_calculation_reading').upsert(readingRows, { onConflict: 'calculation_id,billing_month,field_key' })).error;
    }
    if (!error) error = (await supabase!.from('asset_meter_special_calculation').update({ definition: running.definition }).eq('id', running.id)).error;
    if (!error) setResults(current => ({ ...current, [running.id]: { usage_amount: result.usage, billed_amount: result.amount } }));
    setBusy(false);
    if (error) setMessage(error.message);
    else { setMessage(''); await onSaved?.(); onNotice?.('月次の計算結果と計算根拠を保存しました。'); }
  };
  return <div className="special-calculations">
    {settings && <button type="button" onClick={() => { setMessage(''); setManaging(true); }}>特殊計算を管理</button>}
    {!settings && items.map(item => <span key={item.id}><button type="button" className="meter-settings-link" disabled={busy} onClick={() => void openRun(item)}>{item.name}</button></span>)}
    {message && <p role="status">{message}</p>}
    {managing && !editing && <div className="calculator-modal-backdrop" role="presentation" onMouseDown={() => setManaging(false)}><section className="calculator-modal special-calculation-manager-modal" role="dialog" aria-modal="true" aria-label="特殊計算の管理" onMouseDown={event => event.stopPropagation()}><header><div><p className="eyebrow">SPECIAL CALCULATION</p><h2>特殊計算の管理</h2></div><button type="button" className="calculator-modal-close" aria-label="閉じる" onClick={() => setManaging(false)}>×</button></header><p>新規登録するか、登録済みの特殊計算を選択して編集します。</p><div className="special-calculation-manager-list"><button type="button" className="primary" onClick={() => setEditing({ id: crypto.randomUUID(), name: '', amount_mode: 'special', definition: { fields: [], usageKey: 'usage', amountKey: 'amount', amountMode: 'special' } })}>＋ 新しい特殊計算を登録</button>{items.map(item => <button type="button" key={item.id} onClick={() => setEditing(structuredClone(item))}>{item.name}を編集</button>)}</div></section></div>}
    {(editing || running) && <div className="calculator-modal-backdrop" role="presentation" onMouseDown={() => { setEditing(null); setRunning(null); }}><section className="calculator-modal special-calculation-modal" role="dialog" aria-modal="true" aria-label="特殊計算" onMouseDown={event => event.stopPropagation()}>
      <header><div><p className="eyebrow">SPECIAL CALCULATION</p><h2>{editing ? '特殊計算の登録' : `${running!.name}の特殊計算`}</h2></div><button type="button" className="calculator-modal-close" aria-label="閉じる" onClick={() => { setEditing(null); setRunning(null); }}>×</button></header>
      {message && <p role="status">{message}</p>}
      {editing ? <>
        <div className="special-calculation-heading-fields"><label>特殊計算名（検針画面のボタン名）<input value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} /></label><label>金額の計算方法<select value={editing.definition.amountMode ?? editing.amount_mode ?? 'special'} onChange={e => { const amountMode = e.target.value as 'fixed_unit_price' | 'special'; setEditing({ ...editing, amount_mode: amountMode, definition: { ...editing.definition, amountMode } }); }}><option value="fixed_unit_price">固定単価で計算</option><option value="special">特殊計算</option></select></label></div>
        <p>上から順に計算します。計算式には四則演算・括弧・上の行のキーを使えます。メーター参照は同じビルの全小分類から選べます。</p>
        <div className="table-wrap"><SpecialDefinitionTable><thead><tr><ResizableHeading group="key">キー</ResizableHeading><ResizableHeading group="label">項目名</ResizableHeading><ResizableHeading group="source">入力方法</ResizableHeading><ResizableHeading group="expression">計算内容・メーター</ResizableHeading><ResizableHeading group="multiplier">乗率</ResizableHeading><ResizableHeading group="rounding">小数点処理</ResizableHeading><ResizableHeading group="digits">小数桁</ResizableHeading><ResizableHeading group="action">操作</ResizableHeading></tr></thead><tbody>{editing.definition.fields.map((field, i) => <tr key={i}>
          <td><input aria-label={`キー${i + 1}`} value={field.key} onChange={e => changeField(i, { key: e.target.value })} /></td>
          <td><input aria-label={`項目名${i + 1}`} value={field.label} onChange={e => changeField(i, { label: e.target.value })} /></td>
          <td><select value={field.source} onChange={e => { const source = e.target.value as CalculationField['source']; changeField(i, { source, expression: '', ...(source === 'reading' ? { multiplier: field.multiplier ?? 1 } : {}) }); }}><option value="input">毎月入力（使用量・金額）</option><option value="reading">毎月入力（読取値）</option><option value="constant">定数</option><option value="meter">メーター使用量</option><option value="formula">計算式</option></select></td>
          <td>{field.source === 'meter' ? <select value={field.expression} onChange={e => changeField(i, { expression: e.target.value })}><option value="">メーターを選択</option>{meters.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select> : field.source !== 'input' && <input aria-label={`計算内容${i + 1}`} value={field.expression} onChange={e => changeField(i, { expression: e.target.value })} />}</td>
          <td>{field.source === 'reading' ? <input type="number" min="1" step="1" value={field.multiplier ?? 1} onChange={e => changeField(i, { multiplier: Number(e.target.value) })} /> : '—'}</td>
          <td><select value={field.rounding} onChange={e => changeField(i, { rounding: e.target.value as CalculationField['rounding'] })}><option value="none">—</option><option value="round">四捨五入</option><option value="floor">切り捨て</option><option value="ceil">切り上げ</option></select></td>
          <td><input type="number" min="0" max="6" value={field.digits} onChange={e => changeField(i, { digits: Number(e.target.value) })} /></td>
          <td><button type="button" onClick={() => setEditing({ ...editing, definition: { ...editing.definition, fields: editing.definition.fields.filter((_, index) => index !== i) } })}>削除</button></td>
        </tr>)}</tbody></SpecialDefinitionTable></div>
        <button type="button" onClick={() => setEditing({ ...editing, definition: { ...editing.definition, fields: [...editing.definition.fields, { key: `v${editing.definition.fields.length + 1}`, label: '', source: 'input', expression: '', rounding: 'none', digits: 0 }] } })}>計算項目を追加</button>
        <label>使用量の出力キー<input value={editing.definition.usageKey} onChange={e => setEditing({ ...editing, definition: { ...editing.definition, usageKey: e.target.value } })} /></label>
        {(editing.definition.amountMode ?? editing.amount_mode ?? 'special') === 'special' && <label>税別金額の出力キー<input value={editing.definition.amountKey} onChange={e => setEditing({ ...editing, definition: { ...editing.definition, amountKey: e.target.value } })} /></label>}
        <footer><button type="button" className="primary" disabled={busy} onClick={() => void saveDefinition()}>{busy ? '保存中…' : '登録する'}</button></footer>
      </> : <>
        <div className="calculator-tax-mode">対象請求月：<strong>{month}</strong>　参照メーターは保存済み使用量を使用します。</div>
        <div className="special-monthly-fields">{running!.definition.fields.filter(f => f.source === 'input' || f.source === 'reading').map((field) => field.source === 'reading' ? <fieldset key={field.key}><legend>{field.label}</legend><div className="special-reading-inputs"><div className="calculator-result-field"><span>前月指針</span><strong>{inputs[`${field.key}_previous`]?.trim() ? Number(inputs[`${field.key}_previous`]).toLocaleString('ja-JP', { maximumFractionDigits: 6 }) : '—'}</strong></div><label><span>当月指針</span><input type="text" inputMode="decimal" disabled={confirmed} value={formatNumberInput(inputs[`${field.key}_current`])} onChange={e => setInputs({ ...inputs, [`${field.key}_current`]: normalizeNumberInput(e.target.value) })} /></label><label><span>乗率</span><input type="number" min="1" step="1" disabled={confirmed} value={field.multiplier ?? 1} onChange={e => setRunning(current => current && ({ ...current, definition: { ...current.definition, fields: current.definition.fields.map((candidate) => candidate.key === field.key ? { ...candidate, multiplier: Number(e.target.value) } : candidate) } }))} /></label><div className="calculator-result-field"><span>使用量</span><strong>{inputs[`${field.key}_current`]?.trim() && inputs[`${field.key}_previous`]?.trim() ? ((Number(inputs[`${field.key}_current`]) - Number(inputs[`${field.key}_previous`])) * (field.multiplier ?? 1)).toLocaleString('ja-JP', { maximumFractionDigits: 6 }) : '—'}</strong></div></div></fieldset> : <label className="special-direct-input" key={field.key}><span>{field.label}</span><input type="text" inputMode="decimal" disabled={confirmed} value={formatNumberInput(inputs[field.key])} onChange={e => setInputs({ ...inputs, [field.key]: normalizeNumberInput(e.target.value) })} /></label>)}</div>
        {calculationError && <p role="alert">{calculationError}</p>}
        {result && <><details className="special-calculation-details"><summary>計算明細を確認</summary><table><tbody>{running!.definition.fields.map(field => <tr key={field.key}><th>{field.label}</th><td>{result!.values[field.key].toLocaleString('ja-JP', { maximumFractionDigits: 6 })}</td></tr>)}</tbody></table></details><div className="calculator-unit-price-result"><div className="calculator-price-output"><span>計算使用量</span><strong>{result.usage.toLocaleString()}</strong></div><div className="calculator-price-output"><span>税別金額</span><strong>{result.amount == null ? '固定単価から計算' : `${result.amount.toLocaleString()}円`}</strong></div></div></>}
        <p>保存すると、メーター設定で指定した通常行の使用量・金額へ反映します。</p>
        <footer><button type="button" className="primary" disabled={confirmed || busy || !result} onClick={() => void saveResult()}>{busy ? '保存中…' : '計算結果を保存'}</button></footer>
      </>}
    </section></div>}
  </div>;
}

const specialColumns = ['key', 'label', 'source', 'expression', 'multiplier', 'rounding', 'digits', 'action'] as const;
function SpecialDefinitionTable({ children }: { children: ReactNode }) {
  return <table className="special-definition-table"><colgroup>{specialColumns.map(group => <col key={group} data-special-column={group} />)}</colgroup>{children}</table>;
}
function ResizableHeading({ group, children }: { group: typeof specialColumns[number]; children: ReactNode }) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const resize = (event: PointerEvent<HTMLSpanElement>) => {
    const table = event.currentTarget.closest('table');
    const column = table?.querySelector<HTMLTableColElement>(`col[data-special-column="${group}"]`);
    if (!column) return;
    start.current = { x: event.clientX, width: column.getBoundingClientRect().width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent<HTMLSpanElement>) => {
    if (!start.current) return;
    const table = event.currentTarget.closest('table');
    const column = table?.querySelector<HTMLTableColElement>(`col[data-special-column="${group}"]`);
    if (column) column.style.width = `${Math.max(72, start.current.width + event.clientX - start.current.x)}px`;
  };
  return <th data-column-group={group}>{children}<span className="column-resizer" onPointerDown={resize} onPointerMove={move} onPointerUp={() => { start.current = null; }} /></th>;
}
