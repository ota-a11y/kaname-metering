do $$
declare
  target record;
  migrated_count integer;
begin
  for target in
    select c.meter_reading_contract_id, c.asset_id, c.tenant_id
    from public.meter_reading_contract c
    join public.asset_master a on a.asset_id = c.asset_id
    join public.tenant_master t on t.tenant_id = c.tenant_id
    where c.surcharge_excluded
      and (
        (a.asset_name = '三共小石川THビル' and t.tenant_name = 'SKハウジング(株)')
        or (a.asset_name = '三共福岡ビル' and t.tenant_name = '株式会社LIXIL')
      )
  loop
    if exists (
      select 1
      from public.asset_meter m
      join public.asset_meter_sub_item s on s.asset_meter_sub_item_id = m.asset_meter_sub_item_id
      join public.asset_meter_unit_assignment ma on ma.asset_meter_id = m.asset_meter_id
      where m.asset_id = target.asset_id and m.is_active and s.category = 'electric'
        and m.surcharge_exclusion_mode is not null
        and ma.effective_from <= current_date
        and (ma.effective_to is null or ma.effective_to >= current_date)
        and (
          ma.tenant_id = target.tenant_id
          or exists (
            select 1 from public.lease_contract_unit cu
            join public.lease_contract c on c.lease_contract_id = cu.lease_contract_id
            where cu.unit_id = ma.unit_id and c.tenant_id = target.tenant_id
              and c.contract_status = 'active'
          )
        )
    ) then
      raise exception '既存のメーター単位増額分設定と旧除外設定が重複しています';
    end if;

    update public.asset_meter m
    set surcharge_exclusion_mode = 'exclude_all', updated_at = now()
    where m.asset_id = target.asset_id and m.is_active
      and m.asset_meter_sub_item_id in (
        select s.asset_meter_sub_item_id from public.asset_meter_sub_item s
        where s.category = 'electric'
      )
      and exists (
        select 1 from public.asset_meter_unit_assignment ma
        where ma.asset_meter_id = m.asset_meter_id
          and ma.effective_from <= current_date
          and (ma.effective_to is null or ma.effective_to >= current_date)
          and (
            ma.tenant_id = target.tenant_id
            or exists (
              select 1 from public.lease_contract_unit cu
              join public.lease_contract c on c.lease_contract_id = cu.lease_contract_id
              where cu.unit_id = ma.unit_id and c.tenant_id = target.tenant_id
                and c.contract_status = 'active'
            )
          )
      );
    get diagnostics migrated_count = row_count;
    if migrated_count = 0 then
      raise exception '旧除外設定に対応する電気メーターが見つかりません';
    end if;

    update public.meter_reading_contract
    set surcharge_excluded = false
    where meter_reading_contract_id = target.meter_reading_contract_id;
  end loop;
end
$$;
