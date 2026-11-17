alter table public.asset_meter
  add column if not exists reading_decimal_digits smallint,
  add column if not exists usage_input_decimal_digits smallint;

alter table public.asset_meter
  drop constraint if exists asset_meter_reading_decimal_digits_check;
alter table public.asset_meter
  add constraint asset_meter_reading_decimal_digits_check
  check (reading_decimal_digits is null or reading_decimal_digits between 0 and 3);

alter table public.asset_meter
  drop constraint if exists asset_meter_usage_input_decimal_digits_check;
alter table public.asset_meter
  add constraint asset_meter_usage_input_decimal_digits_check
  check (usage_input_decimal_digits is null or usage_input_decimal_digits between 0 and 3);

comment on column public.asset_meter.reading_decimal_digits is 'メーター固有の検針値入力桁数。nullは小分類設定を継承';
comment on column public.asset_meter.usage_input_decimal_digits is 'メーター固有の使用量入力桁数。nullは小分類設定を継承';
