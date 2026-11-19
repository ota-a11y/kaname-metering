import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
const quote = value => `'${value.replaceAll("'", "''")}'`;
function query(sql, write = false) {
  const command = `npx.cmd supabase db query --remote ${write ? '--yes' : '--read-only'} -o json ${quote(sql)}`;
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8' });
  return JSON.parse(raw.slice(raw.indexOf('{'))).rows;
}
const a = ts.transpile(fs.readFileSync('src/lib/monthAllocation.ts','utf8'), { module: ts.ModuleKind.ES2022 });
const source = ts.transpile(fs.readFileSync('src/lib/specialCalculation.ts','utf8'), { module: ts.ModuleKind.ES2022 }).replace("'./monthAllocation'", JSON.stringify(`data:text/javascript;base64,${Buffer.from(a).toString('base64')}`));
const { taiseiTemplate } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const definition = taiseiTemplate();
const rows = query(`select m.asset_id,m.asset_meter_id,m.meter_code,s.asset_meter_sub_item_id,s.sub_item_name from asset_meter m join asset_master a using(asset_id) join asset_meter_sub_item s using(asset_meter_sub_item_id) where a.asset_name='三共神戸ツインビル' and m.is_active`);
const target = rows.find(r => r.sub_item_name === '電気代');
if (!target) throw Error('神戸の電気代が見つかりません');
const meter = (code, item) => { const found = rows.filter(r => r.meter_code === code && r.sub_item_name === item); if(found.length !== 1) throw Error(`メーター照合エラー: ${code}`); return found[0].asset_meter_id; };
const refs = { sevenLeft: meter('ホテル棟　左','電気代'), sevenRight: meter('ホテル棟　右','電気代'), kudoLight: meter('104 358','電灯'), kudoAir: meter('226 601 675','動力') };
const index = definition.fields.findIndex(f => f.key === 'seven');
definition.fields.splice(index, 0, ...['sevenLeft','sevenRight'].map(key => ({key,label:key === 'sevenLeft' ? 'セブン左 使用量' : 'セブン右 使用量',source:'meter',expression:refs[key],rounding:'none',digits:0})));
definition.fields.find(f=>f.key==='seven').source='formula';
definition.fields.find(f=>f.key==='seven').expression='sevenLeft+sevenRight';
for(const f of definition.fields){
  if(/^y\d+$/.test(f.key)) f.source='reading';
  if(f.key==='kudoLight'||f.key==='kudoAir') f.expression=refs[f.key];
  if(f.key==='total') f.invoiceField='usage';
  if(f.key==='gross') f.invoiceField='gross';
  if(f.key==='tax') f.invoiceField='tax';
}
const existing = query(`select id from asset_meter_special_calculation where asset_id=${quote(target.asset_id)} and asset_meter_sub_item_id=${quote(target.asset_meter_sub_item_id)} and name='大成観光開発'`);
if(existing.length > 1) throw Error('計算定義が重複しています');
const jsonSql = `convert_from(decode('${Buffer.from(JSON.stringify(definition)).toString('base64')}','base64'),'UTF8')::jsonb`;
query(existing.length ? `update asset_meter_special_calculation set definition=${jsonSql} where id=${quote(existing[0].id)}` : `insert into asset_meter_special_calculation(asset_id,asset_meter_sub_item_id,name,definition) values (${quote(target.asset_id)},${quote(target.asset_meter_sub_item_id)},'大成観光開発',${jsonSql})`,true);
console.log('神戸・電気代に大成観光開発を登録しました。');
