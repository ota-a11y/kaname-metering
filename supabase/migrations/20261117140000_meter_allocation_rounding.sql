alter table public.asset_meter
  add column if not exists allocation_rounding_digits smallint,
  add column if not exists allocation_rounding_mode text;

alter table public.asset_meter
  drop constraint if exists asset_meter_allocation_rounding_digits_check;
alter table public.asset_meter
  add constraint asset_meter_allocation_rounding_digits_check
  check (allocation_rounding_digits is null or allocation_rounding_digits between 0 and 4);

alter table public.asset_meter
  drop constraint if exists asset_meter_allocation_rounding_mode_check;
alter table public.asset_meter
  add constraint asset_meter_allocation_rounding_mode_check
  check (allocation_rounding_mode is null or allocation_rounding_mode in ('floor', 'round', 'ceil'));

comment on column public.asset_meter.allocation_rounding_digits is
  '按分結果を丸める小数桁数。nullは小分類の使用量集計桁数を使用';
comment on column public.asset_meter.allocation_rounding_mode is
  '按分結果の端数処理。floor、round、ceil。nullは小分類の使用量小数点処理を使用';
