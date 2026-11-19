alter table public.asset_meter
  add column fixed_value_mode text check (fixed_value_mode in ('usage', 'usage_amount')),
  add column fixed_usage_amount numeric check (fixed_usage_amount >= 0),
  add column fixed_billed_amount numeric check (fixed_billed_amount >= 0),
  add constraint asset_meter_fixed_value_complete check (
    fixed_value_mode is null
    or (fixed_usage_amount is not null and (fixed_value_mode = 'usage' or fixed_billed_amount is not null))
  );

comment on column public.asset_meter.fixed_value_mode is 'usage: 使用量のみ固定、usage_amount: 使用量と税別金額を固定';
notify pgrst, 'reload schema';
