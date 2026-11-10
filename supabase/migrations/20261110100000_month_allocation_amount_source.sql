alter table public.meter_reading_month_allocation
  add column if not exists amount_source text not null default 'manual'
  check (amount_source in ('manual', 'import'));

alter table public.meter_reading_month_allocation
  add column if not exists source_reference text;

comment on column public.meter_reading_month_allocation.amount_source is
  '請求額の入力元。取込処理もbilled_amountを更新し、区画別配賦率はそのまま保持する';
comment on column public.meter_reading_month_allocation.source_reference is
  '取込元データの識別子。手入力時はnull';
