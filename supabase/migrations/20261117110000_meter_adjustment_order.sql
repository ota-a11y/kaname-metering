alter table public.asset_meter
  add column if not exists billing_adjustment_order text not null default 'after_children';

alter table public.asset_meter
  drop constraint if exists asset_meter_billing_adjustment_order_check;
alter table public.asset_meter
  add constraint asset_meter_billing_adjustment_order_check
  check (billing_adjustment_order in ('before_children', 'after_children'));

comment on column public.asset_meter.billing_adjustment_order is
  '補正と子メーター差引の適用順。before_childrenは補正後に子を差引、after_childrenは子を差引後に補正';
