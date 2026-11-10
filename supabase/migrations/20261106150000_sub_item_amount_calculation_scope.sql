alter table public.asset_meter_sub_item
  add column if not exists amount_calculation_scope text not null default 'tenant'
  check (amount_calculation_scope in ('meter', 'unit', 'tenant'));

-- Preserve a property's existing per-meter behavior when every billing row
-- for the category used it. Mixed legacy choices need one shared default.
update public.asset_meter_sub_item sub_item
set amount_calculation_scope = 'meter'
where sub_item.sub_item_kind = 'custom'
  and exists (
    select 1 from public.meter_reading_contract contract_row
    where contract_row.asset_id = sub_item.asset_id
      and case sub_item.category
        when 'electric' then contract_row.electric_sum_mode
        when 'water' then contract_row.water_sum_mode
        else contract_row.gas_sum_mode
      end = 'perMeter'
  )
  and not exists (
    select 1 from public.meter_reading_contract contract_row
    where contract_row.asset_id = sub_item.asset_id
      and case sub_item.category
        when 'electric' then contract_row.electric_sum_mode
        when 'water' then contract_row.water_sum_mode
        else contract_row.gas_sum_mode
      end <> 'perMeter'
  );
