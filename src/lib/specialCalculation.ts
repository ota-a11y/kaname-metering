import { evaluateAllocationAmountExpression } from './monthAllocation';

export type CalculationField = { key: string; label: string; source: 'input' | 'reading' | 'constant' | 'meter' | 'formula'; expression: string; rounding: 'none' | 'round' | 'floor' | 'ceil'; digits: number; multiplier?: number; invoiceField?: 'usage' | 'gross' | 'tax' };
export type CalculationDefinition = {
  fields: CalculationField[];
  usageKey: string;
  amountKey: string;
  amountMode?: 'fixed_unit_price' | 'special';
};

export function calculateSpecial(definition: CalculationDefinition, inputs: Record<string, string>, meters: Record<string, number | null>) {
  const values: Record<string, number> = {};
  for (const field of definition.fields) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(field.key) || Object.prototype.hasOwnProperty.call(values, field.key)) throw new Error('項目キーは重複しない半角英数字で指定してください。');
    let value: number | null;
    if (field.source === 'reading') {
      const previous = inputs[`${field.key}_previous`];
      const current = inputs[`${field.key}_current`];
      const multiplier = field.multiplier ?? 1;
      if (!Number.isInteger(multiplier) || multiplier < 1) throw new Error(`${field.label}の乗率は1以上の自然数で指定してください。`);
      value = previous?.trim() && current?.trim() ? (Number(current) - Number(previous)) * multiplier : null;
    } else if (field.source === 'meter') value = meters[field.expression] ?? null;
    else {
      const raw = field.source === 'input' ? inputs[field.key] ?? '' : field.expression;
      const expression = field.source === 'formula' ? raw.replace(/[A-Za-z][A-Za-z0-9_]*/g, key => {
        if (!Object.prototype.hasOwnProperty.call(values, key)) throw new Error(`${field.label}: ${key} は未定義です。上の行のキーだけ参照できます。`);
        return `(${values[key]})`;
      }) : raw;
      value = evaluateAllocationAmountExpression(expression);
    }
    if (value == null || !Number.isFinite(value) || value < 0) throw new Error(`${field.label}の入力・参照メーター・計算式を確認してください。`);
    if (!Number.isInteger(field.digits) || field.digits < 0 || field.digits > 6) throw new Error('小数点処理の桁数は0～6で指定してください。');
    const factor = 10 ** field.digits;
    values[field.key] = field.rounding === 'none' ? value : Math[field.rounding](value * factor) / factor;
  }
  if (!Object.prototype.hasOwnProperty.call(values, definition.usageKey)) throw new Error('使用量の出力キーを確認してください。');
  if ((definition.amountMode ?? 'special') === 'special' && !Object.prototype.hasOwnProperty.call(values, definition.amountKey)) throw new Error('税別金額の出力キーを確認してください。');
  return { values, usage: values[definition.usageKey], amount: (definition.amountMode ?? 'special') === 'special' ? values[definition.amountKey] : null };
}

export function taiseiTemplate(): CalculationDefinition {
  const fields: CalculationField[] = [];
  const add = (key: string, label: string, source: CalculationField['source'], expression = '', rounding: CalculationField['rounding'] = 'none') => fields.push({ key, label, source, expression, rounding, digits: 0, ...(source === 'reading' ? { multiplier: 1 } : {}) });
  add('total', 'ビル全体使用量（kWh）', 'input');
  add('gross', 'ビル全体税込金額（円）', 'input');
  add('tax', '消費税（円）', 'input');
  ['イ','ロ','ハ','ニ','ホ','ヘ','ト','チ','リ','ヌ','ル','ヲ','ワ','カ'].forEach((name, i) => add(`y${i + 10}`, `${name} 使用量（乗率適用後）`, 'input'));
  add('officeShare', '事務所共用持分', 'constant', '0.4148');
  add('floors', '配賦階数', 'constant', '14');
  add('seven', 'セブン使用量（控除メーター指定）', 'meter');
  add('kudoLight', 'クドウ電灯（控除メーター指定）', 'meter');
  add('kudoAir', 'クドウ空調（控除メーター指定）', 'meter');
  add('office', '事務所専用使用量', 'formula', 'y10+y11+y14+y17+y21+y22+y23');
  add('common', '全体共用使用量', 'formula', 'y12+y13+y15+y16+y18+y19+y20');
  add('officeCommon', '事務所共用持分使用量', 'formula', 'common*officeShare', 'floor');
  add('hotel', 'ホテル使用量', 'formula', 'total-office-officeCommon');
  add('residual', '配賦対象使用量', 'formula', 'hotel-seven-kudoLight-kudoAir');
  add('floorUsage', '1階当たり使用量', 'formula', 'residual/floors');
  add('net', 'ビル全体税別金額', 'formula', 'gross-tax');
  add('hotelNet', '配賦対象税別金額', 'formula', 'residual*(net/total)', 'round');
  add('floorNet', '1階当たり税別金額', 'formula', 'floorUsage*(hotelNet/residual)', 'round');
  add('area2', '2階配賦母面積', 'constant', '1339.43'); add('target2', '2階対象面積', 'constant', '340.84');
  add('area3', '3階配賦母面積', 'constant', '1351.22'); add('target3', '3階対象面積', 'constant', '789.49');
  add('usage2', '2階使用量', 'formula', 'target2/area2*floorUsage', 'round');
  add('usage3', '3階使用量', 'formula', 'target3/area3*floorUsage', 'round');
  add('amount2', '2階税別金額', 'formula', 'target2/area2*floorNet', 'round');
  add('amount3', '3階税別金額', 'formula', 'target3/area3*floorNet', 'round');
  add('usage', '請求使用量', 'formula', 'usage2+usage3'); add('amount', '請求税別金額', 'formula', 'amount2+amount3');
  return { fields, usageKey: 'usage', amountKey: 'amount', amountMode: 'special' };
}
