alter table public.meter_reading_confirmed_amount
  add column if not exists show_unit_price_on_invoice boolean not null default true,
  add column if not exists show_usage_on_invoice boolean not null default true;

-- 既に確定済みの月も、現在保存されている契約区画別設定から表示可否を補完する。
-- 複数区画を1つの請求明細へ集約している場合は、1区画でもオフなら非表示とする。
with contract_term_flags as (
  select
    contract.tenant_id,
    unit.property_id as asset_id,
    confirmed.billing_month,
    term.asset_meter_sub_item_id,
    bool_and(term.show_unit_price_on_invoice) as show_unit_price_on_invoice,
    bool_and(term.show_usage_on_invoice) as show_usage_on_invoice
  from public.meter_reading_confirmed_amount confirmed
  join public.lease_contract contract on contract.tenant_id = confirmed.tenant_id
  join public.lease_contract_unit contract_unit on contract_unit.lease_contract_id = contract.lease_contract_id
  join public.unit_master unit on unit.unit_id = contract_unit.unit_id and unit.property_id = confirmed.asset_id
  join public.lease_contract_unit_meter_term term
    on term.lease_contract_unit_id = contract_unit.lease_contract_unit_id
   and term.asset_meter_sub_item_id = confirmed.source_id
  where confirmed.source_kind = 'subItem'
    and contract_unit.lease_start_date <= (confirmed.billing_month + interval '1 month - 1 day')::date
    and (contract_unit.lease_end_date is null or contract_unit.lease_end_date >= confirmed.billing_month)
  group by contract.tenant_id, unit.property_id, confirmed.billing_month, term.asset_meter_sub_item_id
)
update public.meter_reading_confirmed_amount confirmed
set show_unit_price_on_invoice = flags.show_unit_price_on_invoice,
    show_usage_on_invoice = flags.show_usage_on_invoice
from contract_term_flags flags
where confirmed.tenant_id = flags.tenant_id
  and confirmed.asset_id = flags.asset_id
  and confirmed.billing_month = flags.billing_month
  and confirmed.source_id = flags.asset_meter_sub_item_id;

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
  if not exists (
    select 1 from public.meter_reading_entry
    where asset_id = p_asset_id and billing_month = v_month
  ) then
    raise exception '確定できる検針データがありません';
  end if;
  if not exists (
    select 1 from public.meter_reading_month
    where asset_id = p_asset_id and billing_month = v_month
  ) then
    raise exception '対象月の検針データがありません';
  end if;

  delete from public.meter_reading_confirmed_amount
  where asset_id = p_asset_id and billing_month = v_month;

  insert into public.meter_reading_confirmed_amount (
    asset_id, billing_month, meter_reading_contract_id, tenant_id, tenant_name,
    row_no, invoice_number, category, source_kind, source_id, source_name,
    asset_billing_line_item_id, line_item_name, usage_amount, usage_unit,
    unit_price, show_unit_price_on_invoice, show_usage_on_invoice,
    amount, amount_rounding_mode, usage_rounding_digits,
    usage_rounding_mode, tax_mode, tax_rate
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
    amount.usage_rounding_mode, amount.tax_mode, amount.tax_rate
  from jsonb_to_recordset(coalesce(p_amounts, '[]'::jsonb)) as amount(
    meter_reading_contract_id uuid,
    tenant_id uuid,
    tenant_name varchar(200),
    row_no smallint,
    invoice_number smallint,
    category varchar(10),
    source_kind varchar(10),
    source_id uuid,
    source_name varchar(100),
    asset_billing_line_item_id uuid,
    line_item_name varchar(200),
    usage_amount numeric(14, 3),
    usage_unit varchar(10),
    unit_price numeric(12, 4),
    show_unit_price_on_invoice boolean,
    show_usage_on_invoice boolean,
    amount numeric(12, 0),
    amount_rounding_mode varchar(10),
    usage_rounding_digits smallint,
    usage_rounding_mode varchar(10),
    tax_mode varchar(10),
    tax_rate numeric(5, 4)
  );

  update public.meter_reading_month
  set status = 'confirmed', confirmed_at = v_confirmed_at, updated_at = v_confirmed_at
  where asset_id = p_asset_id and billing_month = v_month;

  return v_confirmed_at;
end;
$$;
