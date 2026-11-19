create table public.asset_meter_special_calculation (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.asset_master(asset_id),
  asset_meter_sub_item_id uuid not null references public.asset_meter_sub_item(asset_meter_sub_item_id),
  name text not null check (length(trim(name)) > 0),
  definition jsonb not null,
  unique (id, asset_id)
);
create table public.meter_reading_month_special_calculation (
  calculation_id uuid not null,
  asset_id uuid not null,
  billing_month date not null check (extract(day from billing_month) = 1),
  inputs jsonb not null,
  definition_snapshot jsonb not null,
  result_snapshot jsonb not null,
  usage_amount numeric not null check (usage_amount >= 0),
  billed_amount numeric not null check (billed_amount >= 0),
  primary key (calculation_id, billing_month),
  foreign key (calculation_id, asset_id) references public.asset_meter_special_calculation(id, asset_id)
);
create function public.validate_special_calculation() returns trigger language plpgsql set search_path = public as $$
begin
  if tg_table_name = 'asset_meter_special_calculation' then
    if not exists (select 1 from asset_meter_sub_item where asset_meter_sub_item_id = new.asset_meter_sub_item_id and asset_id = new.asset_id) then
      raise exception '小分類が対象物件に属していません';
    end if;
  else
    if exists (select 1 from meter_reading_month where asset_id = new.asset_id and billing_month = new.billing_month and status = 'confirmed') then
      raise exception '確定済みの計算結果は変更できません';
    end if;
  end if;
  return new;
end $$;
create trigger validate_special_definition before insert or update on public.asset_meter_special_calculation for each row execute function public.validate_special_calculation();
create trigger validate_special_result before insert or update on public.meter_reading_month_special_calculation for each row execute function public.validate_special_calculation();
alter table public.asset_meter_special_calculation enable row level security;
alter table public.meter_reading_month_special_calculation enable row level security;
create policy active_users_special_definitions on public.asset_meter_special_calculation for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());
create policy active_users_special_results on public.meter_reading_month_special_calculation for all to authenticated using (public.current_account_is_active()) with check (public.current_account_is_active());
grant select, insert, update on public.asset_meter_special_calculation to authenticated;
grant select, insert, update on public.meter_reading_month_special_calculation to authenticated;
