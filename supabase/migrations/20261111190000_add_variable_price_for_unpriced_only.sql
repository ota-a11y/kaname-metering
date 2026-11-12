-- 20261030100000 はKANAME側の別Migrationと番号が衝突してリモートでは別内容が記録済みのため、
-- 未適用のカラム追加を新しい履歴番号で再実行する。
alter table public.asset_meter_sub_item
  add column if not exists variable_price_for_unpriced_only boolean not null default false;

comment on column public.asset_meter_sub_item.variable_price_for_unpriced_only is
  '変動単価を契約単価未設定の区画だけに適用する場合はtrue';
