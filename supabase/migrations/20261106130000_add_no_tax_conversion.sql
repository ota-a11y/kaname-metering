alter table public.asset_meter_sub_item
  drop constraint if exists asset_meter_sub_item_tax_rounding_mode_check;

alter table public.asset_meter_sub_item
  add constraint asset_meter_sub_item_tax_rounding_mode_check
  check (tax_rounding_mode in ('none', 'floor', 'round', 'ceil'));

alter table public.asset_meter_sub_item
  alter column tax_rounding_mode set default 'none';

-- The old floor value was the default, so existing custom items without an
-- intentional choice start from the new "ー" setting.
update public.asset_meter_sub_item
set tax_rounding_mode = 'none'
where sub_item_kind = 'custom' and not is_monthly_fixed and tax_rounding_mode = 'floor';
