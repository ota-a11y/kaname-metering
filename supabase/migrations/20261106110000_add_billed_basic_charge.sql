alter table public.meter_reading_month_sub_item
  add column if not exists billed_basic_charge numeric;

alter table public.meter_reading_month_sub_item
  add constraint meter_reading_month_sub_item_basic_charge_nonnegative
  check (billed_basic_charge is null or billed_basic_charge >= 0);

comment on column public.meter_reading_month_sub_item.billed_basic_charge is
  '税込の変動単価計算で、請求金額（税込）から差し引く税込基本料';
