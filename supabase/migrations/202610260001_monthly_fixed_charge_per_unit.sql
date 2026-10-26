alter table public.meter_reading_month_fixed_charge
  add column if not exists lease_contract_unit_id uuid
  references public.lease_contract_unit (lease_contract_unit_id);

-- Existing tenant-level amounts become the amount of the first unit so that
-- migration does not multiply the invoiced total across every tenant unit.
with candidates as (
  select
    fixed.ctid as fixed_row,
    contract_unit.lease_contract_unit_id,
    row_number() over (
      partition by fixed.ctid
      order by contract_unit.lease_contract_unit_id
    ) as unit_rank
  from public.meter_reading_month_fixed_charge fixed
  join public.meter_reading_contract reading_contract
    on reading_contract.meter_reading_contract_id = fixed.meter_reading_contract_id
  join public.lease_contract contract
    on contract.tenant_id = reading_contract.tenant_id
  join public.lease_contract_unit contract_unit
    on contract_unit.lease_contract_id = contract.lease_contract_id
  join public.unit_master unit
    on unit.unit_id = contract_unit.unit_id
   and unit.property_id = fixed.asset_id
  where fixed.lease_contract_unit_id is null
)
update public.meter_reading_month_fixed_charge fixed
set lease_contract_unit_id = candidates.lease_contract_unit_id
from candidates
where fixed.ctid = candidates.fixed_row
  and candidates.unit_rank = 1;

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select constraint_row.conname
    from pg_constraint constraint_row
    where constraint_row.conrelid = 'public.meter_reading_month_fixed_charge'::regclass
      and constraint_row.contype in ('p', 'u')
      and (
        select array_agg(attribute.attname order by key_column.ordinality)::text[]
        from unnest(constraint_row.conkey) with ordinality as key_column(attnum, ordinality)
        join pg_attribute attribute
          on attribute.attrelid = constraint_row.conrelid
         and attribute.attnum = key_column.attnum
      ) = array[
        'asset_id',
        'billing_month',
        'meter_reading_contract_id',
        'asset_meter_sub_item_id'
      ]::text[]
  loop
    execute format(
      'alter table public.meter_reading_month_fixed_charge drop constraint %I',
      constraint_name
    );
  end loop;
end
$$;

create unique index if not exists meter_reading_month_fixed_charge_per_unit_key
  on public.meter_reading_month_fixed_charge (
    asset_id,
    billing_month,
    lease_contract_unit_id,
    asset_meter_sub_item_id
  );

