-- 非請求の組み込み基本料を残したまま、同名の任意小分類を設定できるようにする。
alter table public.asset_meter_sub_item
  drop constraint if exists uq_asset_meter_sub_item_name;

create unique index if not exists uq_asset_meter_sub_item_name_kind
  on public.asset_meter_sub_item (asset_id, category, sub_item_name, sub_item_kind);
