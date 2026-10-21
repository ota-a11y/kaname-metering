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
export type TaxMode = "exclusive" | "inclusive";
export type AssetUtilitySetting = {
  category: UtilityCategory;
  price_scope: "line_item" | "category";
  default_unit_price: number | null;
  default_tax_mode: TaxMode;
  show_in_rent_roll: boolean;
};
export type ContractUnit = {
  lease_contract_unit_id: string;
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
    tenant: { tenant_name: string } | null;
  } | null;
  prices: Array<{
    asset_billing_line_item_id: string;
    unit_price: number;
    tax_mode: TaxMode;
    item: {
      line_item_name: string;
    } | null;
  }>;
  categoryPrices: Array<{
    category: UtilityCategory;
    unit_price: number;
    tax_mode: TaxMode;
  }>;
  basics: Array<{
    category: UtilityCategory;
    amount: number;
    tax_mode: TaxMode;
  }>;
  meterBilling: Array<{
    meter_reading_contract_id: string;
    row_no: number;
    split_label: string | null;
    electric_billable: boolean;
    water_billable: boolean;
    gas_billable: boolean;
    electric_sum_mode: "aggregate" | "perMeter";
    water_sum_mode: "aggregate" | "perMeter";
    gas_sum_mode: "aggregate" | "perMeter";
    amount_rounding_mode: "floor" | "round" | "ceil";
    units: Array<{ unit_id: string }>;
  }>;
};

export type MeterReadingRow = {
  asset_meter_id: string;
  parent_meter_id: string | null;
  sort_order: number;
  meter_code: string;
  meter_label: string | null;
  subItem: {
    asset_meter_sub_item_id: string;
    category: UtilityCategory;
    sub_item_name: string;
    input_mode: "usage" | "reading";
    input_decimal_digits: number;
    aggregation_decimal_digits: number;
    usage_rounding_mode: "floor" | "round" | "ceil";
  };
  assignments: Array<{
    asset_meter_unit_assignment_id: string;
    unit_id: string;
    effective_from: string;
    effective_to: string | null;
    unit: {
      unit_id: string;
      unit_code: string;
      unit_name: string | null;
      floor_label: string | null;
    } | null;
  }>;
  entry: {
    usage_amount: number;
    previous_reading: number | null;
    current_reading: number | null;
  } | null;
};

export type MeterUnitOption = {
  unit_id: string;
  unit_code: string;
  unit_name: string | null;
  floor_label: string | null;
};

export type MeterCategorySetting = {
  category: UtilityCategory;
  usage_unit: string;
  is_billable: boolean;
  is_basic_billable: boolean;
};

export type MeterSubItem = {
  asset_meter_sub_item_id: string;
  category: UtilityCategory;
  sub_item_name: string;
  sub_item_kind: "basic" | "custom";
  asset_billing_line_item_id: string | null;
  sort_order: number;
  input_mode: "usage" | "reading";
  input_decimal_digits: number;
  aggregation_decimal_digits: number;
  usage_rounding_mode: "floor" | "round" | "ceil";
  billing_period_pattern_id: string | null;
  price_mode: "fixed" | "variable";
  default_unit_price: number | null;
  tax_mode: TaxMode;
  tax_rounding_mode: "floor" | "round" | "ceil";
  show_unit_price_on_invoice: boolean;
};

export type MeterSurcharge = {
  asset_meter_surcharge_id: string;
  category: UtilityCategory;
  surcharge_name: string;
  is_billable: boolean;
  billing_period_pattern_id: string | null;
  asset_billing_line_item_id: string | null;
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
};
