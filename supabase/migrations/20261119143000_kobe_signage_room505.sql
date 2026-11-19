do $$
declare
  v_asset_id uuid;
  v_sign_unit_id uuid;
  v_303_contract_id uuid;
  v_505_contract_id uuid;
  v_505_contract_unit_id uuid;
  v_tenant_id uuid;
begin
  select asset_id into strict v_asset_id
  from public.asset_master where asset_name = '三共神戸ツインビル';

  select unit_id into strict v_sign_unit_id
  from public.unit_master
  where property_id = v_asset_id and unit_code = 'Sign_1-4'
    and unit_type in ('other', 'signage') and is_active;

  select c.lease_contract_id, c.tenant_id
    into strict v_303_contract_id, v_tenant_id
  from public.unit_master u
  join public.lease_contract_unit cu on cu.unit_id = u.unit_id
  join public.lease_contract c on c.lease_contract_id = cu.lease_contract_id
  join public.tenant_master t on t.tenant_id = c.tenant_id
  where u.property_id = v_asset_id and u.unit_code = '303'
    and c.contract_status = 'active' and t.external_tenant_code = '2710';

  select c.lease_contract_id, cu.lease_contract_unit_id
    into strict v_505_contract_id, v_505_contract_unit_id
  from public.unit_master u
  join public.lease_contract_unit cu on cu.unit_id = u.unit_id
  join public.lease_contract c on c.lease_contract_id = cu.lease_contract_id
  where u.property_id = v_asset_id and u.unit_code = '505'
    and c.tenant_id = v_tenant_id and c.contract_status = 'active'
    and cu.leased_area_sqm = 52.69 and cu.monthly_rent_amount = 159300
    and cu.deposit_amount = 1593000;

  if v_303_contract_id = v_505_contract_id then
    raise exception '神戸505は303と別契約である必要があります';
  end if;

  if exists (select 1 from public.lease_contract_unit_term where lease_contract_unit_id = v_505_contract_unit_id) then
    raise exception '神戸505に賃料履歴があります。契約変更を確認してください';
  end if;

  update public.unit_master set unit_type = 'signage', updated_at = now()
  where unit_id = v_sign_unit_id and unit_type = 'other';

  update public.lease_contract
  set contract_start_date = date '2023-03-01',
      contract_end_date = date '2027-02-28',
      renewal_terms = '2年間', payment_terms = '翌月分当月末', updated_at = now()
  where lease_contract_id = v_505_contract_id
    and contract_start_date = date '2009-11-01'
    and contract_end_date = date '2014-10-31';

  update public.lease_contract_unit
  set monthly_common_charge_amount = 0, updated_at = now()
  where lease_contract_unit_id = v_505_contract_unit_id
    and monthly_common_charge_amount is null;

  if not exists (
    select 1 from public.lease_contract_unit_category_price
    where lease_contract_unit_id = v_505_contract_unit_id and category = 'electric'
  ) then
    insert into public.lease_contract_unit_category_price
      (lease_contract_unit_id, category, unit_price, tax_mode)
    values (v_505_contract_unit_id, 'electric', 34, 'exclusive');
  end if;
end
$$;
