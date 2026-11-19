alter table public.asset_meter
  add column if not exists surcharge_exclusion_mode text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.asset_meter'::regclass
      and conname = 'asset_meter_surcharge_exclusion_mode_check'
  ) then
    alter table public.asset_meter
      add constraint asset_meter_surcharge_exclusion_mode_check
      check (surcharge_exclusion_mode is null or surcharge_exclusion_mode in ('exclude_all', 'exclude_billing'));
  end if;
end
$$;

comment on column public.asset_meter.surcharge_exclusion_mode is
  '増額分: null=通常、exclude_all=単価計算と請求から除外、exclude_billing=単価計算に含め請求から除外。共有メーターは全按分先に適用。';
