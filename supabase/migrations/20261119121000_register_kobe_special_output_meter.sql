do $$
declare
  calculation_id constant uuid := 'fadf95d3-7290-4984-b377-b68b134fb90b';
  output_meter_id uuid;
begin
  select output_asset_meter_id into output_meter_id
  from public.asset_meter_special_calculation
  where id = calculation_id;

  if output_meter_id is null then
    insert into public.asset_meter (
      asset_id,
      asset_meter_sub_item_id,
      meter_code,
      sort_order,
      use_reading_input
    )
    select asset_id, asset_meter_sub_item_id, name, 2, false
    from public.asset_meter_special_calculation
    where id = calculation_id
    returning asset_meter_id into output_meter_id;

    update public.asset_meter_special_calculation
    set output_asset_meter_id = output_meter_id,
        amount_mode = 'special',
        definition = jsonb_set(definition, '{amountMode}', '"special"'::jsonb, true)
    where id = calculation_id;
  end if;
end $$;

notify pgrst, 'reload schema';
