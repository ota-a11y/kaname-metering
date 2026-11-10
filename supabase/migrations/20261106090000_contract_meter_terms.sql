-- Contract-specific meter pricing and invoice display settings. Existing contracts
-- receive a snapshot of their current sub-item defaults.
alter table public.asset_meter_sub_item
  add column if not exists show_usage_on_invoice boolean not null default true;

create table public.lease_contract_unit_meter_term (
  lease_contract_unit_id uuid not null references public.lease_contract_unit on delete cascade,
  asset_meter_sub_item_id uuid not null references public.asset_meter_sub_item on delete cascade,
  price_mode text not null check (price_mode in ('fixed', 'amount', 'master_meter')),
  tax_mode text not null check (tax_mode in ('exclusive', 'inclusive')),
  show_unit_price_on_invoice boolean not null,
  show_usage_on_invoice boolean not null,
  primary key (lease_contract_unit_id, asset_meter_sub_item_id)
);

create table public.lease_contract_billing_unit_meter_term (
  lease_contract_billing_unit_id uuid not null references public.lease_contract_billing_unit on delete cascade,
  asset_meter_sub_item_id uuid not null references public.asset_meter_sub_item on delete cascade,
  price_mode text not null check (price_mode in ('fixed', 'amount', 'master_meter')),
  tax_mode text not null check (tax_mode in ('exclusive', 'inclusive')),
  show_unit_price_on_invoice boolean not null,
  show_usage_on_invoice boolean not null,
  primary key (lease_contract_billing_unit_id, asset_meter_sub_item_id)
);

insert into public.lease_contract_unit_meter_term
select contract_unit.lease_contract_unit_id, item.asset_meter_sub_item_id,
       item.price_mode, item.tax_mode, item.show_unit_price_on_invoice, item.show_usage_on_invoice
from public.lease_contract_unit contract_unit
join public.unit_master unit on unit.unit_id = contract_unit.unit_id
join public.asset_meter_sub_item item on item.asset_id = unit.property_id
where item.sub_item_kind = 'custom' and not item.is_monthly_fixed;

insert into public.lease_contract_billing_unit_meter_term
select billing_unit.lease_contract_billing_unit_id, item.asset_meter_sub_item_id,
       item.price_mode, item.tax_mode, item.show_unit_price_on_invoice, item.show_usage_on_invoice
from public.lease_contract_billing_unit billing_unit
join public.lease_contract_billing_unit_member member on member.lease_contract_billing_unit_id = billing_unit.lease_contract_billing_unit_id
join public.lease_contract_unit contract_unit on contract_unit.lease_contract_unit_id = member.lease_contract_unit_id
join public.unit_master unit on unit.unit_id = contract_unit.unit_id
join public.asset_meter_sub_item item on item.asset_id = unit.property_id
where item.sub_item_kind = 'custom' and not item.is_monthly_fixed
on conflict do nothing;

alter table public.lease_contract_unit_meter_term enable row level security;
alter table public.lease_contract_billing_unit_meter_term enable row level security;
create policy "active users manage contract unit meter terms" on public.lease_contract_unit_meter_term
  for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());
create policy "active users manage contract billing unit meter terms" on public.lease_contract_billing_unit_meter_term
  for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());
grant select, insert, update, delete on public.lease_contract_unit_meter_term to authenticated;
grant select, insert, update, delete on public.lease_contract_billing_unit_meter_term to authenticated;

create function public.initialize_contract_unit_meter_terms() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.lease_contract_unit_meter_term
  select new.lease_contract_unit_id, item.asset_meter_sub_item_id, item.price_mode,
         item.tax_mode, item.show_unit_price_on_invoice, item.show_usage_on_invoice
  from public.unit_master unit
  join public.asset_meter_sub_item item on item.asset_id = unit.property_id
  where unit.unit_id = new.unit_id and item.sub_item_kind = 'custom' and not item.is_monthly_fixed
  on conflict do nothing;
  return new;
end;
$$;
create trigger initialize_contract_unit_meter_terms_after_insert
after insert on public.lease_contract_unit for each row
execute function public.initialize_contract_unit_meter_terms();

create function public.initialize_contract_billing_unit_meter_terms() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.lease_contract_billing_unit_meter_term
  select new.lease_contract_billing_unit_id, item.asset_meter_sub_item_id, item.price_mode,
         item.tax_mode, item.show_unit_price_on_invoice, item.show_usage_on_invoice
  from public.lease_contract_unit contract_unit
  join public.unit_master unit on unit.unit_id = contract_unit.unit_id
  join public.asset_meter_sub_item item on item.asset_id = unit.property_id
  where contract_unit.lease_contract_unit_id = new.lease_contract_unit_id
    and item.sub_item_kind = 'custom' and not item.is_monthly_fixed
  on conflict do nothing;
  return new;
end;
$$;
create trigger initialize_contract_billing_unit_meter_terms_after_insert
after insert on public.lease_contract_billing_unit_member for each row
execute function public.initialize_contract_billing_unit_meter_terms();
