alter table public.asset_meter
  add column if not exists billing_adjustment_rounding_digits smallint,
  add column if not exists billing_adjustment_rounding_mode text;

alter table public.asset_meter
  drop constraint if exists asset_meter_billing_adjustment_rounding_digits_check;
alter table public.asset_meter
  add constraint asset_meter_billing_adjustment_rounding_digits_check
  check (billing_adjustment_rounding_digits is null or billing_adjustment_rounding_digits between 0 and 4);

alter table public.asset_meter
  drop constraint if exists asset_meter_billing_adjustment_rounding_mode_check;
alter table public.asset_meter
  add constraint asset_meter_billing_adjustment_rounding_mode_check
  check (billing_adjustment_rounding_mode is null or billing_adjustment_rounding_mode in ('floor', 'round', 'ceil'));

comment on column public.asset_meter.billing_adjustment_rounding_digits is
  '使用量補正の計算結果を丸める小数桁数。nullは補正時には丸めない';
comment on column public.asset_meter.billing_adjustment_rounding_mode is
  '使用量補正の端数処理。floor、round、ceil。nullは補正時には丸めない';
