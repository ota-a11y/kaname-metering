alter table public.asset_meter_sub_item
  add column if not exists variable_price_for_unpriced_only boolean not null default false;

comment on column public.asset_meter_sub_item.variable_price_for_unpriced_only is
  '変動単価を契約単価未設定の区画だけに適用する場合はtrue';
