import type { SupabaseClient } from '@supabase/supabase-js';
import type { Asset, AssetUtilitySetting, ContractUnit, MeterReadingRow, UtilityCategory } from '../types';

function fail(context: string, error: { message: string } | null) { if (error) throw new Error(`${context}: ${error.message}`); }

export async function loadBillingAssets(client: SupabaseClient): Promise<Asset[]> {
  const { data, error } = await client.from('asset_master').select('asset_id, asset_code, asset_name, short_name').eq('is_tenant_billing_enabled', true).order('asset_code');
  fail('請求対象ビルを読み込めませんでした', error);
  return (data ?? []) as Asset[];
}

export async function loadAssetUtilitySettings(client: SupabaseClient, assetId: string): Promise<AssetUtilitySetting[]> {
  const { data, error } = await client.from('asset_utility_price_setting').select('category, price_scope, default_unit_price, default_tax_mode').eq('asset_id', assetId).order('category');
  fail('ビルの公共料金設定を読み込めませんでした', error);
  return (data ?? []) as AssetUtilitySetting[];
}

export async function loadContractUnits(client: SupabaseClient, assetId: string): Promise<ContractUnit[]> {
  const { data, error } = await client.from('lease_contract_unit').select(`lease_contract_unit_id, utility_amount_rounding_mode, unit:unit_master!inner(unit_code, unit_name, property_id), contract:lease_contract!inner(lease_contract_id, tenant:tenant_master(tenant_name)), prices:lease_contract_unit_utility_price(asset_billing_line_item_id, unit_price, tax_mode, item:asset_billing_line_item(line_item_name, utility_kind)), categoryPrices:lease_contract_unit_category_price(category, unit_price, tax_mode), basics:lease_contract_unit_basic_charge(category, amount, tax_mode)`).eq('unit.property_id', assetId).order('lease_contract_unit_id');
  fail('契約ごとの公共料金設定を読み込めませんでした', error);
  return (data ?? []) as unknown as ContractUnit[];
}

export async function loadMeterReadings(client: SupabaseClient, assetId: string, billingMonth: string, category: UtilityCategory): Promise<{ rows: MeterReadingRow[]; status: 'draft' | 'confirmed' | null }> {
  const month = `${billingMonth}-01`;
  const [metersResult, entriesResult, monthResult] = await Promise.all([
    client.from('asset_meter').select(`asset_meter_id, meter_code, meter_label, subItem:asset_meter_sub_item!inner(category, sub_item_name, input_mode), assignments:asset_meter_unit_assignment(unit:unit_master(unit_code, unit_name))`).eq('asset_id', assetId).eq('is_active', true).eq('subItem.category', category).order('sort_order'),
    client.from('meter_reading_entry').select('asset_meter_id, usage_amount, previous_reading, current_reading').eq('asset_id', assetId).eq('billing_month', month),
    client.from('meter_reading_month').select('status').eq('asset_id', assetId).eq('billing_month', month).maybeSingle(),
  ]);
  fail('メーターを読み込めませんでした', metersResult.error);
  fail('保存済みの検針値を読み込めませんでした', entriesResult.error);
  fail('対象月の状態を読み込めませんでした', monthResult.error);
  const entries = new Map((entriesResult.data ?? []).map((entry) => [entry.asset_meter_id, entry]));
  return {
    rows: (metersResult.data ?? []).map((meter) => ({ ...meter, entry: entries.get(meter.asset_meter_id) ?? null })) as unknown as MeterReadingRow[],
    status: (monthResult.data?.status as 'draft' | 'confirmed' | undefined) ?? null,
  };
}

export async function saveMeterReading(client: SupabaseClient, assetId: string, billingMonth: string, meterId: string, value: number) {
  const { data, error } = await client.rpc('save_kanameter_reading', { p_asset_id: assetId, p_billing_month: `${billingMonth}-01`, p_asset_meter_id: meterId, p_value: value });
  fail('検針値を保存できませんでした', error);
  return data?.[0] as { usage_amount: number; previous_reading: number | null; current_reading: number | null; month_status: 'draft'; saved_at: string };
}

export async function confirmMeterReadingMonth(client: SupabaseClient, assetId: string, billingMonth: string) {
  const { data, error } = await client.rpc('confirm_kanameter_month', { p_asset_id: assetId, p_billing_month: `${billingMonth}-01` });
  fail('検針データを確定できませんでした', error);
  return data as string;
}
