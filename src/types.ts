export type AccountStatus = "pending" | "active" | "suspended";
export type UserProfile = {
  user_id: string;
  email: string;
  role: string;
  account_status: AccountStatus;
  employee?: {
    employee_name: string;
    department?: { department_name: string } | null;
  } | null;
};
export type Asset = {
  asset_id: string;
  asset_code: number;
  asset_name: string;
  short_name: string | null;
};
export type UtilityCategory = "electric" | "water" | "gas";
export type MeterInputMode = "usage" | "reading" | "mixed";
export type TaxMode = "exclusive" | "inclusive";
export type AssetUtilitySetting = {
  category: UtilityCategory;
  price_scope: "line_item" | "category";
  default_unit_price: number | null;
  default_tax_mode: TaxMode;
  show_in_rent_roll: boolean;
  billing_frequency: "monthly" | "odd" | "even";
};
export type AssetMeterBuildingSetting = { meter_date_mode: "shared" | "category" };
export type MeterTag = {
  asset_meter_tag_id: string;
  asset_id: string;
  tag_name: string;
  color: string;
  created_at?: string;
};
export type ContractUnit = {
  lease_contract_unit_id: string;
  lease_contract_billing_unit_id?: string;
  member_unit_ids?: string[];
  utility_amount_rounding_mode: "floor" | "round" | "ceil";
  unit: {
    unit_id: string;
    unit_code: string;
    unit_name: string | null;
    floor_label: string | null;
    unit_type: string;
  } | null;
  contract: {
    lease_contract_id: string;
    tenant_id: string;
    contract_status: string;
    contract_start_date: string | null;
    contract_end_date: string | null;
    tenant: { tenant_name: string } | null;
  } | null;
  prices: Array<{
    asset_billing_line_item_id: string;
    unit_price: number;
    tax_mode: TaxMode;
    billing_month_prices: Array<{ start_month: number; end_month: number; unit_price: number }>;
    item: {
      line_item_name: string;
    } | null;
  }>;
  categoryPrices: Array<{
    category: UtilityCategory;
    unit_price: number;
    tax_mode: TaxMode;
    billing_month_prices: Array<{ start_month: number; end_month: number; unit_price: number }>;
  }>;
  basics: Array<{
    category: UtilityCategory;
    amount: number;
    tax_mode: TaxMode;
  }>;
  meterBilling: Array<{
    meter_reading_contract_id: string;
    row_no: number;
    invoice_number: number;
    split_label: string | null;
    electric_billable: boolean;
    water_billable: boolean;
    gas_billable: boolean;
    electric_sum_mode: "aggregate" | "perMeter";
    water_sum_mode: "aggregate" | "perMeter";
    gas_sum_mode: "aggregate" | "perMeter";
    amount_rounding_mode: "floor" | "round" | "ceil";
    units: Array<{ unit_id: string }>;
    items: Array<{
      asset_meter_sub_item_id: string;
      is_billable: boolean;
      fixed_amount: number | null;
    }>;
  }>;
};

export type MeterReadingRow = {
  asset_meter_id: string;
  use_reading_input: boolean;
  parent_meter_id: string | null;
  is_rate_source: boolean;
  is_allocation_source: boolean;
  sort_order: number;
  meter_code: string;
  meter_label: string | null;
  billing_adjustment_enabled: boolean;
  billing_adjustment_method: "ratio" | "percent" | null;
  billing_adjustment_percent: number | null;
  billing_adjustment_numerator: number | null;
  billing_adjustment_denominator: number | null;
  billing_adjustment_note: string | null;
  tag: MeterTag | null;
  subItem: {
    asset_meter_sub_item_id: string;
    category: UtilityCategory;
    sub_item_name: string;
    input_mode: MeterInputMode;
    input_decimal_digits: number;
    aggregation_decimal_digits: number;
    usage_rounding_mode: "floor" | "round" | "ceil";
  };
  assignments: Array<{
    asset_meter_unit_assignment_id: string;
    unit_id: string;
    effective_from: string;
    effective_to: string | null;
    allocation_method: "single" | "area" | "ratio" | "meter_usage";
    allocation_weight: number;
    area_sqm_snapshot: number | null;
    allocation_source_meter_id: string | null;
    unit: {
      unit_id: string;
      unit_code: string;
      unit_name: string | null;
      floor_label: string | null;
      rentable_area_sqm: number | null;
    } | null;
  }>;
  allocation_common_source_meter_ids: string[];
  entry: {
    usage_amount: number | null;
    previous_reading: number | null;
    current_reading: number | null;
  } | null;
};

export type MeterUnitOption = {
  unit_id: string;
  unit_code: string;
  unit_name: string | null;
  floor_label: string | null;
  rentable_area_sqm: number | null;
  unit_type: "office" | "warehouse" | "storage" | "equipment" | "other";
  billing_unit_id?: string;
  tenant_name?: string | null;
  source_sort_order?: number;
};

export type MeterCategorySetting = {
  category: UtilityCategory;
  usage_unit: string;
  is_billable: boolean;
  is_basic_billable: boolean;
  basic_charge_method: "fixed" | "sqm" | "tsubo";
  basic_charge_fixed_amount: number | null;
  basic_charge_area_unit_price: number | null;
};

export type MeterSubItem = {
  asset_meter_sub_item_id: string;
  category: UtilityCategory;
  sub_item_name: string;
  sub_item_kind: "basic" | "custom";
  asset_billing_line_item_id: string | null;
  sort_order: number;
  input_mode: MeterInputMode;
  input_decimal_digits: number;
  aggregation_decimal_digits: number;
  usage_rounding_mode: "floor" | "round" | "ceil";
  billing_period_pattern_id: string | null;
  price_mode: "fixed" | "amount" | "master_meter";
  default_unit_price: number | null;
  tax_mode: TaxMode;
  tax_rounding_mode: "floor" | "round" | "ceil";
  show_unit_price_on_invoice: boolean;
  is_monthly_fixed: boolean;
};

export type MeterUnitPriceCalculation = {
  asset_meter_sub_item_id: string;
  unit_price: number | null;
  billed_inclusive: number | null;
  billed_tax: number | null;
  billed_exclusive: number | null;
  billed_usage: number | null;
  rate_source_meter_id: string | null;
  tariff_code: string | null;
  water_inclusive: number | null;
  sewer_inclusive: number | null;
  unit_price_rounding_digits: number;
  unit_price_rounding_mode: "floor" | "round" | "ceil";
  unit_price_adjustment_enabled: boolean;
  unit_price_adjustment_factor: number;
};

export type UtilityTariffTier = {
  component: "water" | "sewer";
  min_usage: number;
  max_usage: number | null;
  rate: number;
  deduction: number;
  sort_order: number;
};

export type UtilityTariffVersion = {
  utility_tariff_version_id: string;
  tariff_name: string;
  effective_from: string;
  effective_to: string | null;
  tax_rate: number;
  tiers: UtilityTariffTier[];
};

export type MeterSurcharge = {
  asset_meter_surcharge_id: string;
  category: UtilityCategory;
  surcharge_name: string;
  is_billable: boolean;
  billing_period_pattern_id: string | null;
  asset_billing_line_item_id: string | null;
  calculation_scope: "tenant" | "unit";
  recovery_inclusive_mode?: "from_exclusive" | "use_calculated_inclusive";
};

export type BillingPeriodPattern = {
  billing_period_pattern_id: string;
  start_month_offset: number;
  start_day_type: string;
  start_meter_day_offset: number;
  end_month_offset: number;
  end_day_type: string;
  end_meter_day_offset: number;
  pattern_name?: string;
};

export type BillingLineItem = {
  asset_billing_line_item_id: string;
  line_item_name: string;
  display_name: string | null;
  utility_category: UtilityCategory | null;
  charge_type_name: string;
  is_surcharge: boolean;
};

export type ConfirmedMeterAmount = {
  meter_reading_contract_id: string | null;
  tenant_id: string;
  tenant_name: string;
  row_no: number;
  invoice_number: number;
  category: UtilityCategory;
  source_kind: "subItem" | "surcharge";
  source_id: string;
  source_name: string;
  asset_billing_line_item_id: string | null;
  line_item_name: string | null;
  usage_amount: number;
  usage_unit: string;
  unit_price: number | null;
  amount: number;
  amount_rounding_mode: "floor" | "round" | "ceil";
  usage_rounding_digits: number | null;
  usage_rounding_mode: "floor" | "round" | "ceil" | null;
  tax_mode: TaxMode | null;
  tax_rate: number | null;
};
