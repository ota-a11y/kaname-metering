alter table public.asset_meter_special_calculation add column asset_meter_tag_id uuid references public.asset_meter_tag(asset_meter_tag_id);
alter table public.meter_reading_month_special_calculation add column input_provenance jsonb not null default '{}'::jsonb;
comment on column public.meter_reading_month_special_calculation.input_provenance is '入力キー別の出典。source(manual/invoice)、document_id、field、imported_at、original_valueを保持する。definitionのinvoiceFieldがusage/gross/taxの連携先を表す。';
notify pgrst, 'reload schema';
