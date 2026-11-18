alter table public.asset_meter_date_setting
  drop constraint if exists asset_meter_date_setting_date_number_check;

alter table public.asset_meter_date_setting
  add constraint asset_meter_date_setting_date_number_check
  check (date_number >= 1);

comment on table public.asset_meter_date_setting is
  'ビルごとの検針日名称。1番は標準検針日、2番以降は追加検針日';

comment on column public.asset_meter_date_setting.date_number is
  '画面表示用の通し番号。1は標準検針日、2以降は追加検針日';
