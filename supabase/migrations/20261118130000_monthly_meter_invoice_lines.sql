alter table public.asset_meter_sub_item
  add column if not exists invoice_display_unit text not null default 'period_total',
  add column if not exists monthly_period_start_offset smallint not null default -1;

alter table public.asset_meter_sub_item
  drop constraint if exists asset_meter_sub_item_invoice_display_unit_check,
  add constraint asset_meter_sub_item_invoice_display_unit_check
    check (invoice_display_unit in ('period_total', 'monthly_lines')),
  drop constraint if exists asset_meter_sub_item_monthly_period_start_offset_check,
  add constraint asset_meter_sub_item_monthly_period_start_offset_check
    check (monthly_period_start_offset between -3 and 0);

create table if not exists public.meter_reading_period_entry (
  asset_id uuid not null references public.asset_master(asset_id) on delete cascade,
  billing_month date not null,
  service_month date not null,
  asset_meter_id uuid not null references public.asset_meter(asset_meter_id) on delete cascade,
  usage_amount numeric(14, 3),
  previous_reading numeric(14, 3),
  current_reading numeric(14, 3),
  updated_at timestamptz not null default now(),
  primary key (asset_id, billing_month, service_month, asset_meter_id)
);

alter table public.meter_reading_period_entry enable row level security;
drop policy if exists "active users manage period meter readings" on public.meter_reading_period_entry;
create policy "active users manage period meter readings" on public.meter_reading_period_entry
  for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());
grant select, insert, update, delete on public.meter_reading_period_entry to authenticated;

alter table public.meter_reading_confirmed_amount
  add column if not exists service_month date,
  add column if not exists source_meter_id uuid references public.asset_meter(asset_meter_id) on delete set null,
  add column if not exists line_sequence smallint not null default 1;

alter table public.meter_reading_confirmed_amount
  drop constraint if exists uq_meter_reading_confirmed_amount;
drop index if exists public.uq_meter_reading_confirmed_amount_period;

comment on column public.asset_meter_sub_item.invoice_display_unit is
  '請求書表示単位。period_totalは期間合算、monthly_linesは1カ月ごとの2行';
comment on column public.asset_meter_sub_item.monthly_period_start_offset is
  '1カ月ごと表示の開始月。請求月に対する月オフセット（-3～0）';
comment on table public.meter_reading_period_entry is
  '隔月請求を1カ月ごとに表示する場合のメーター月別検針値';

create or replace function public.confirm_kanameter_month_with_amounts(
  p_asset_id uuid,
  p_billing_month date,
  p_amounts jsonb
) returns timestamptz
language plpgsql
as $$
declare
  v_month date := date_trunc('month', p_billing_month)::date;
  v_confirmed_at timestamptz := now();
begin
  if auth.uid() is null or not public.current_account_is_active() then
    raise exception 'KANAMETERを利用する権限がありません';
  end if;
  if jsonb_typeof(coalesce(p_amounts, '[]'::jsonb)) <> 'array' then
    raise exception '確定明細の形式が正しくありません';
  end if;
  if not exists (select 1 from public.meter_reading_entry where asset_id = p_asset_id and billing_month = v_month) then
    raise exception '確定できる検針データがありません';
  end if;

  delete from public.meter_reading_confirmed_amount where asset_id = p_asset_id and billing_month = v_month;

  insert into public.meter_reading_confirmed_amount (
    asset_id, billing_month, meter_reading_contract_id, tenant_id, tenant_name,
    row_no, invoice_number, category, source_kind, source_id, source_name,
    asset_billing_line_item_id, line_item_name, usage_amount, usage_unit,
    unit_price, show_unit_price_on_invoice, show_usage_on_invoice,
    amount, amount_rounding_mode, usage_rounding_digits,
    usage_rounding_mode, tax_mode, tax_rate, service_month, source_meter_id, line_sequence
  )
  select
    p_asset_id, v_month, amount.meter_reading_contract_id, amount.tenant_id,
    amount.tenant_name, amount.row_no, amount.invoice_number, amount.category,
    amount.source_kind, amount.source_id, amount.source_name,
    amount.asset_billing_line_item_id, amount.line_item_name, amount.usage_amount,
    amount.usage_unit, amount.unit_price,
    coalesce(amount.show_unit_price_on_invoice, true),
    coalesce(amount.show_usage_on_invoice, true),
    amount.amount, amount.amount_rounding_mode, amount.usage_rounding_digits,
    amount.usage_rounding_mode, amount.tax_mode, amount.tax_rate,
    amount.service_month, amount.source_meter_id, coalesce(amount.line_sequence, 1)
  from jsonb_to_recordset(coalesce(p_amounts, '[]'::jsonb)) as amount(
    meter_reading_contract_id uuid, tenant_id uuid, tenant_name varchar(200),
    row_no smallint, invoice_number smallint, category varchar(10),
    source_kind varchar(10), source_id uuid, source_name varchar(100),
    asset_billing_line_item_id uuid, line_item_name varchar(200),
    usage_amount numeric(14, 3), usage_unit varchar(10), unit_price numeric(12, 4),
    show_unit_price_on_invoice boolean, show_usage_on_invoice boolean,
    amount numeric(12, 0), amount_rounding_mode varchar(10),
    usage_rounding_digits smallint, usage_rounding_mode varchar(10),
    tax_mode varchar(10), tax_rate numeric(5, 4), service_month date,
    source_meter_id uuid, line_sequence smallint
  );

  update public.meter_reading_month
  set status = 'confirmed', confirmed_at = v_confirmed_at, updated_at = v_confirmed_at
  where asset_id = p_asset_id and billing_month = v_month;
  return v_confirmed_at;
end;
$$;
