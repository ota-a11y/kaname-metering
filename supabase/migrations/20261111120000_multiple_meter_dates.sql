create table if not exists public.asset_meter_date_setting (
  asset_meter_date_setting_id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.asset_master(asset_id) on delete cascade,
  date_number integer not null check (date_number >= 2),
  setting_name text not null check (btrim(setting_name) <> ''),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (asset_id, date_number)
);

alter table public.asset_meter_sub_item
  add column if not exists asset_meter_date_setting_id uuid references public.asset_meter_date_setting(asset_meter_date_setting_id) on delete set null;

alter table public.asset_meter_surcharge
  add column if not exists asset_meter_date_setting_id uuid references public.asset_meter_date_setting(asset_meter_date_setting_id) on delete set null;

create table if not exists public.meter_reading_month_date (
  asset_id uuid not null references public.asset_master(asset_id) on delete cascade,
  billing_month date not null,
  asset_meter_date_setting_id uuid not null references public.asset_meter_date_setting(asset_meter_date_setting_id) on delete cascade,
  meter_date date,
  primary key (asset_id, billing_month, asset_meter_date_setting_id)
);

alter table public.asset_meter_date_setting enable row level security;
alter table public.meter_reading_month_date enable row level security;

drop policy if exists "active users can manage meter date settings" on public.asset_meter_date_setting;
create policy "active users can manage meter date settings" on public.asset_meter_date_setting
  for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());
drop policy if exists "active users can manage monthly meter dates" on public.meter_reading_month_date;
create policy "active users can manage monthly meter dates" on public.meter_reading_month_date
  for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());

grant select, insert, update, delete on public.asset_meter_date_setting to authenticated;
grant select, insert, update, delete on public.meter_reading_month_date to authenticated;

comment on table public.asset_meter_date_setting is 'ビルごとの追加検針日。標準検針日は既存のmeter_reading_month.meter_dateを使用する';
comment on column public.asset_meter_date_setting.date_number is '画面表示用の通し番号。1は標準検針日のため2以降';
