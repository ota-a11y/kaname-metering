create or replace function public.assign_kanameter_meter_units_with_sources_from(
  p_asset_meter_id uuid,
  p_method text,
  p_allocations jsonb,
  p_effective_from date
)
returns void language plpgsql security definer set search_path = public
as $$
declare
  v_asset_id uuid;
  v_sub_item_id uuid;
  v_item jsonb;
  v_resolved jsonb := '[]'::jsonb;
  v_source_meter_id uuid;
  v_source_meter_name text;
  v_source_meter_label text;
  v_source_meter_tag_id uuid;
  v_unit_id uuid;
  v_billing_unit_id uuid;
  v_common_area boolean;
  v_common_source_ids uuid[] := array[]::uuid[];
begin
  if not public.current_account_is_active() then raise exception 'KANAMETERを利用する権限がありません'; end if;
  if p_method <> 'meter_usage' then
    delete from public.asset_meter_allocation_common_source where asset_meter_id = p_asset_meter_id;
    perform public.assign_kanameter_meter_units_from(p_asset_meter_id, p_method, p_allocations, p_effective_from);
    return;
  end if;
  if jsonb_typeof(p_allocations) <> 'array' then raise exception '区画設定が不正です'; end if;

  select asset_id, asset_meter_sub_item_id into v_asset_id, v_sub_item_id
  from public.asset_meter where asset_meter_id = p_asset_meter_id;
  if v_asset_id is null then raise exception 'メーターが見つかりません'; end if;

  for v_item in select value from jsonb_array_elements(p_allocations)
  loop
    v_source_meter_id := nullif(v_item ->> 'source_meter_id', '')::uuid;
    v_source_meter_name := nullif(trim(v_item ->> 'source_meter_name'), '');
    v_source_meter_label := nullif(trim(v_item ->> 'source_meter_label'), '');
    v_source_meter_tag_id := nullif(v_item ->> 'source_meter_tag_id', '')::uuid;
    v_unit_id := nullif(v_item ->> 'unit_id', '')::uuid;
    v_billing_unit_id := nullif(v_item ->> 'billing_unit_id', '')::uuid;
    v_common_area := coalesce((v_item ->> 'common_area')::boolean, false);
    if v_source_meter_name is null then raise exception '按分用メーター名を入力してください'; end if;
    if v_source_meter_label is null then raise exception '按分名を入力してください'; end if;

    if v_source_meter_id is null then
      insert into public.asset_meter (
        asset_id, asset_meter_sub_item_id, meter_code, meter_label, asset_meter_tag_id, is_active, is_rate_source
      ) values (
        v_asset_id, v_sub_item_id, v_source_meter_name, v_source_meter_label, v_source_meter_tag_id, true, false
      ) returning asset_meter_id into v_source_meter_id;

      if not v_common_area then
        insert into public.asset_meter_unit_assignment (
          asset_meter_id, unit_id, lease_contract_billing_unit_id, effective_from,
          allocation_method, allocation_weight, area_sqm_snapshot, allocation_source_meter_id
        ) values (
          v_source_meter_id, v_unit_id, v_billing_unit_id, p_effective_from,
          'single', 1, null, null
        );
      end if;
    else
      update public.asset_meter
      set meter_code = v_source_meter_name,
          meter_label = v_source_meter_label,
          asset_meter_tag_id = v_source_meter_tag_id,
          updated_at = now()
      where asset_meter_id = v_source_meter_id
        and asset_id = v_asset_id
        and asset_meter_sub_item_id = v_sub_item_id
        and is_active = true;
      if not found then raise exception '按分用メーターが見つかりません'; end if;
    end if;

    if v_common_area then
      v_common_source_ids := array_append(v_common_source_ids, v_source_meter_id);
    else
      v_resolved := v_resolved || jsonb_build_array(
        v_item || jsonb_build_object('source_meter_id', v_source_meter_id)
      );
    end if;
  end loop;

  perform public.assign_kanameter_meter_units_from(
    p_asset_meter_id, p_method, v_resolved, p_effective_from
  );
  delete from public.asset_meter_allocation_common_source where asset_meter_id = p_asset_meter_id;
  insert into public.asset_meter_allocation_common_source (asset_meter_id, source_asset_meter_id)
  select p_asset_meter_id, source_id from unnest(v_common_source_ids) source_id;
end;
$$;

revoke all on function public.assign_kanameter_meter_units_with_sources_from(uuid, text, jsonb, date) from public, anon;
grant execute on function public.assign_kanameter_meter_units_with_sources_from(uuid, text, jsonb, date) to authenticated;
comment on function public.assign_kanameter_meter_units_with_sources_from(uuid, text, jsonb, date) is
  '使用量按分用メーターの按分名・タグ・表示メーター名を含めて保存する';
