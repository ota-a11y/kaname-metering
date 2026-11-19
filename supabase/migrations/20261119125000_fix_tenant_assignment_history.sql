create or replace function public.assign_kanameter_meter_tenant_from(
  p_asset_meter_id uuid,
  p_tenant_id uuid,
  p_effective_from date
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_asset_id uuid;
  v_next_from date;
begin
  if not public.current_account_is_active() then raise exception 'KANAMETERを利用する権限がありません'; end if;
  select asset_id into v_asset_id from public.asset_meter where asset_meter_id = p_asset_meter_id;
  if v_asset_id is null then raise exception 'メーターが見つかりません'; end if;
  if not exists (
    select 1
    from public.lease_contract contract
    join public.lease_contract_unit contract_unit on contract_unit.lease_contract_id = contract.lease_contract_id
    join public.unit_master unit on unit.unit_id = contract_unit.unit_id
    where contract.tenant_id = p_tenant_id and unit.property_id = v_asset_id
  ) then raise exception '対象物件のテナントではありません'; end if;

  select min(effective_from) into v_next_from
  from public.asset_meter_unit_assignment
  where asset_meter_id = p_asset_meter_id and effective_from > p_effective_from;

  update public.asset_meter_unit_assignment
  set effective_to = p_effective_from - 1, updated_at = now()
  where asset_meter_id = p_asset_meter_id
    and effective_from < p_effective_from
    and (effective_to is null or effective_to >= p_effective_from);

  delete from public.asset_meter_unit_assignment
  where asset_meter_id = p_asset_meter_id and effective_from = p_effective_from;

  insert into public.asset_meter_unit_assignment (
    asset_meter_id, unit_id, lease_contract_billing_unit_id, tenant_id,
    effective_from, effective_to, allocation_method, allocation_weight
  ) values (
    p_asset_meter_id, null, null, p_tenant_id,
    p_effective_from, case when v_next_from is null then null else v_next_from - 1 end,
    'single', 1
  );
end $$;

revoke all on function public.assign_kanameter_meter_tenant_from(uuid, uuid, date) from public, anon;
grant execute on function public.assign_kanameter_meter_tenant_from(uuid, uuid, date) to authenticated;

with ordered as (
  select asset_meter_unit_assignment_id,
         lead(effective_from) over (partition by asset_meter_id order by effective_from) as next_from
  from public.asset_meter_unit_assignment
  where tenant_id is not null
)
update public.asset_meter_unit_assignment assignment
set effective_to = ordered.next_from - 1,
    updated_at = now()
from ordered
where assignment.asset_meter_unit_assignment_id = ordered.asset_meter_unit_assignment_id
  and ordered.next_from is not null
  and (assignment.effective_to is null or assignment.effective_to >= ordered.next_from);

notify pgrst, 'reload schema';
