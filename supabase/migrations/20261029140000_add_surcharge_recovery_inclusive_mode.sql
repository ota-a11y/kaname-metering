alter table public.asset_meter_surcharge
  add column if not exists recovery_inclusive_mode text not null default 'from_exclusive';

alter table public.asset_meter_surcharge
  drop constraint if exists asset_meter_surcharge_recovery_inclusive_mode_check;

alter table public.asset_meter_surcharge
  add constraint asset_meter_surcharge_recovery_inclusive_mode_check
  check (recovery_inclusive_mode in ('from_exclusive', 'use_calculated_inclusive'));

comment on column public.asset_meter_surcharge.recovery_inclusive_mode is
  '増額分計算で使う回収税込金額（from_exclusive：税抜合計から算出、use_calculated_inclusive：税込計算額をそのまま使用）';
