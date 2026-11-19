alter table public.asset_meter_special_calculation
  add column output_asset_meter_id uuid references public.asset_meter(asset_meter_id),
  add column amount_mode text not null default 'special'
    check (amount_mode in ('fixed_unit_price', 'special'));

create unique index asset_meter_special_calculation_output_meter_key
  on public.asset_meter_special_calculation(output_asset_meter_id)
  where output_asset_meter_id is not null;

comment on column public.asset_meter_special_calculation.output_asset_meter_id is
  '通常のメーター設定・検針画面に表示する出力行。使用量は月次計算結果からmeter_reading_entryへ同期する。';
comment on column public.asset_meter_special_calculation.amount_mode is
  'fixed_unit_price: 出力使用量×契約固定単価、special: 定義内の金額出力キーを使用';

notify pgrst, 'reload schema';
