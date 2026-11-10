alter table public.asset_meter_sub_item
  add column if not exists calculation_mode text not null default 'meter'
  check (calculation_mode in ('meter', 'fixed', 'allocated_amount'));

update public.asset_meter_sub_item
set calculation_mode = 'fixed'
where is_monthly_fixed;

create table public.meter_reading_month_allocation (
  asset_id uuid not null references public.asset_master(asset_id) on delete cascade,
  billing_month date not null,
  asset_meter_sub_item_id uuid not null references public.asset_meter_sub_item(asset_meter_sub_item_id) on delete cascade,
  billed_amount numeric not null check (billed_amount >= 0),
  allocation_ratios jsonb not null default '{}'::jsonb,
  primary key (asset_id, billing_month, asset_meter_sub_item_id)
);

alter table public.meter_reading_month_allocation enable row level security;
create policy "active users manage billed amount allocations" on public.meter_reading_month_allocation
  for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());
grant select, insert, update, delete on public.meter_reading_month_allocation to authenticated;
