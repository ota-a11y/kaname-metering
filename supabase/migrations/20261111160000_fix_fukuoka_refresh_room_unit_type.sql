-- 福岡3Fのリフレッシュルーム（喫煙室）は貸室ではなく、公共料金の請求対象外とする。
do $$
declare
  target_count integer;
begin
  select count(*)
    into target_count
  from public.unit_master unit
  join public.asset_master asset on asset.asset_id = unit.property_id
  join public.lease_contract_unit contract_unit on contract_unit.unit_id = unit.unit_id
  join public.lease_contract contract on contract.lease_contract_id = contract_unit.lease_contract_id
  join public.tenant_master tenant on tenant.tenant_id = contract.tenant_id
  where asset.asset_name = '三共福岡ビル'
    and replace(replace(unit.floor_label, 'F', ''), '階', '') = '3'
    and unit.unit_code = 'H'
    and contract.contract_status = 'active'
    and tenant.tenant_name = 'リフレッシュルーム(喫煙室)';

  if target_count <> 1 then
    raise exception '福岡3Fのリフレッシュルーム（喫煙室）が一意ではありません（該当件数: %）', target_count;
  end if;

  update public.unit_master unit
  set unit_type = 'other'
  from public.asset_master asset
  where asset.asset_id = unit.property_id
    and asset.asset_name = '三共福岡ビル'
    and replace(replace(unit.floor_label, 'F', ''), '階', '') = '3'
    and unit.unit_code = 'H';
end
$$;
