create table public.meter_special_calculation_reading (
  calculation_id uuid not null,
  asset_id uuid not null,
  billing_month date not null check (extract(day from billing_month) = 1),
  field_key text not null check (field_key ~ '^[A-Za-z][A-Za-z0-9_]*$'),
  current_reading numeric not null check (current_reading >= 0),
  updated_at timestamptz not null default now(),
  primary key (calculation_id, billing_month, field_key),
  foreign key (calculation_id, asset_id)
    references public.asset_meter_special_calculation(id, asset_id)
    on delete cascade
);

alter table public.meter_special_calculation_reading enable row level security;
create policy active_users_special_readings
  on public.meter_special_calculation_reading for all to authenticated
  using (public.current_account_is_active())
  with check (public.current_account_is_active());
grant select, insert, update on public.meter_special_calculation_reading to authenticated;

comment on table public.meter_special_calculation_reading is
  '特殊計算の読取値入力を月別・項目別に保持し、翌月の前月指針へ引き継ぐ。計算結果未保存の月も保持できる。';
notify pgrst, 'reload schema';
