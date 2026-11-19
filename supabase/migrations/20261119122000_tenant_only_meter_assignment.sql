alter table public.asset_meter_unit_assignment
  add column tenant_id uuid references public.tenant_master(tenant_id) on delete restrict;

alter table public.asset_meter_unit_assignment
  drop constraint if exists asset_meter_unit_assignment_exactly_one_target;
alter table public.asset_meter_unit_assignment
  drop constraint if exists asset_meter_unit_assignment_unit_or_billing_unit_check;
alter table public.asset_meter_unit_assignment
  drop constraint if exists asset_meter_assignment_exactly_one_target;
alter table public.asset_meter_unit_assignment
  add constraint asset_meter_unit_assignment_exactly_one_target
  check (
    (unit_id is not null)::integer
    + (lease_contract_billing_unit_id is not null)::integer
    + (tenant_id is not null)::integer = 1
  ) not valid;

create unique index asset_meter_unit_assignment_tenant_key
  on public.asset_meter_unit_assignment(asset_meter_id, tenant_id, effective_from)
  where tenant_id is not null;

create or replace function public.create_kanameter_meter_for_tenant(
  p_asset_id uuid,
  p_asset_meter_sub_item_id uuid,
  p_meter_code text,
  p_tenant_id uuid
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_meter_id uuid;
begin
  if not public.current_account_is_active() then raise exception 'KANAMETERを利用する権限がありません'; end if;
  if nullif(trim(p_meter_code), '') is null then raise exception 'メーター番号を入力してください'; end if;
  if not exists (select 1 from public.asset_meter_sub_item where asset_meter_sub_item_id = p_asset_meter_sub_item_id and asset_id = p_asset_id) then raise exception '小分類が対象ビルのものではありません'; end if;
  if not exists (
    select 1 from public.lease_contract contract
    join public.lease_contract_unit contract_unit on contract_unit.lease_contract_id = contract.lease_contract_id
    join public.unit_master unit on unit.unit_id = contract_unit.unit_id
    where contract.tenant_id = p_tenant_id and unit.property_id = p_asset_id
  ) then raise exception '対象物件のテナントではありません'; end if;
  insert into public.asset_meter (asset_id, asset_meter_sub_item_id, meter_code, is_active)
  values (p_asset_id, p_asset_meter_sub_item_id, trim(p_meter_code), true)
  returning asset_meter_id into v_meter_id;
  insert into public.asset_meter_unit_assignment (asset_meter_id, unit_id, lease_contract_billing_unit_id, tenant_id, effective_from)
  values (v_meter_id, null, null, p_tenant_id, date '1900-01-01');
  return v_meter_id;
end $$;

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
begin
  select asset_id into v_asset_id from public.asset_meter where asset_meter_id = p_asset_meter_id;
  if v_asset_id is null then raise exception 'メーターが見つかりません'; end if;
  if not exists (
    select 1
    from public.lease_contract contract
    join public.lease_contract_unit contract_unit on contract_unit.lease_contract_id = contract.lease_contract_id
    join public.unit_master unit on unit.unit_id = contract_unit.unit_id
    where contract.tenant_id = p_tenant_id and unit.property_id = v_asset_id
  ) then raise exception '対象物件のテナントではありません'; end if;

  update public.asset_meter_unit_assignment
  set effective_to = p_effective_from - 1, updated_at = now()
  where asset_meter_id = p_asset_meter_id and effective_to is null and effective_from < p_effective_from;

  delete from public.asset_meter_unit_assignment
  where asset_meter_id = p_asset_meter_id and effective_from = p_effective_from;

  insert into public.asset_meter_unit_assignment (
    asset_meter_id, unit_id, lease_contract_billing_unit_id, tenant_id,
    effective_from, effective_to, allocation_method, allocation_weight
  ) values (
    p_asset_meter_id, null, null, p_tenant_id,
    p_effective_from, null, 'single', 1
  );
end $$;

revoke all on function public.assign_kanameter_meter_tenant_from(uuid, uuid, date) from public, anon;
revoke all on function public.create_kanameter_meter_for_tenant(uuid, uuid, text, uuid) from public, anon;
grant execute on function public.assign_kanameter_meter_tenant_from(uuid, uuid, date) to authenticated;
grant execute on function public.create_kanameter_meter_for_tenant(uuid, uuid, text, uuid) to authenticated;
comment on column public.asset_meter_unit_assignment.tenant_id is
  '区画を指定せず、テナント全体に直接紐づける場合の割当先';

notify pgrst, 'reload schema';
