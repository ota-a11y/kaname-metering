import type { SupabaseClient } from '@supabase/supabase-js';
import type { Asset, AssetUtilitySetting, ContractUnit } from '../types';

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
