-- 三共仙台ビルの空調使用料は8Fのみ。誤って保存された5F A1の定額を削除する。
do $$
declare
  target_count integer;
begin
  select count(*)
    into target_count
  from public.meter_reading_month_fixed_charge fixed
  join public.asset_master asset on asset.asset_id = fixed.asset_id
  join public.asset_meter_sub_item item on item.asset_meter_sub_item_id = fixed.asset_meter_sub_item_id
  join public.lease_contract_unit contract_unit on contract_unit.lease_contract_unit_id = fixed.lease_contract_unit_id
  join public.unit_master unit on unit.unit_id = contract_unit.unit_id
  where asset.asset_name = '三共仙台ビル'
    and item.sub_item_name = '空調使用料'
    and fixed.billing_month = date '2026-10-01'
    and unit.floor_label = '5F'
    and unit.unit_code = 'A1'
    and fixed.amount = 4211;

  if target_count > 1 then
    raise exception '削除対象の仙台5F A1空調使用料が複数あります（該当件数: %）', target_count;
  end if;

  delete from public.meter_reading_month_fixed_charge fixed
  using public.asset_master asset,
        public.asset_meter_sub_item item,
        public.lease_contract_unit contract_unit,
        public.unit_master unit
  where asset.asset_id = fixed.asset_id
    and item.asset_meter_sub_item_id = fixed.asset_meter_sub_item_id
    and contract_unit.lease_contract_unit_id = fixed.lease_contract_unit_id
    and unit.unit_id = contract_unit.unit_id
    and asset.asset_name = '三共仙台ビル'
    and item.sub_item_name = '空調使用料'
    and fixed.billing_month = date '2026-10-01'
    and unit.floor_label = '5F'
    and unit.unit_code = 'A1'
    and fixed.amount = 4211;
end
$$;
