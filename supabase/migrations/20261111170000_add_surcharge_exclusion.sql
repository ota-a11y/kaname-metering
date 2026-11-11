alter table public.meter_reading_contract
  add column if not exists surcharge_excluded boolean not null default false;
