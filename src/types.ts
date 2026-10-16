export type AccountStatus = 'pending' | 'active' | 'suspended';
export type UserProfile = { user_id: string; email: string; role: string; account_status: AccountStatus; employee?: { employee_name: string; department?: { department_name: string } | null } | null };
export type Asset = { asset_id: string; asset_code: number; asset_name: string; short_name: string | null };
export type UtilityCategory = 'electric' | 'water' | 'gas';
export type TaxMode = 'exclusive' | 'inclusive';
export type AssetUtilitySetting = { category: UtilityCategory; price_scope: 'line_item' | 'category'; default_unit_price: number | null; default_tax_mode: TaxMode };
export type ContractUnit = {
  lease_contract_unit_id: string;
  utility_amount_rounding_mode: 'floor' | 'round' | 'ceil';
  unit: { unit_code: string; unit_name: string | null } | null;
  contract: { lease_contract_id: string; tenant: { tenant_name: string } | null } | null;
  prices: Array<{ asset_billing_line_item_id: string; unit_price: number; tax_mode: TaxMode; item: { line_item_name: string; utility_kind: UtilityCategory | null } | null }>;
  categoryPrices: Array<{ category: UtilityCategory; unit_price: number; tax_mode: TaxMode }>;
  basics: Array<{ category: UtilityCategory; amount: number; tax_mode: TaxMode }>;
};
