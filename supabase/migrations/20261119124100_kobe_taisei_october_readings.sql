insert into public.meter_special_calculation_reading (
  calculation_id, asset_id, billing_month, field_key, current_reading
)
select calculation.id, calculation.asset_id, date '2026-10-01', reading.field_key, reading.current_reading
from public.asset_meter_special_calculation calculation
cross join (values
  ('y10', 51959::numeric),
  ('y11', 9201::numeric),
  ('y12', 69422::numeric),
  ('y13', 7265::numeric),
  ('y14', 11536::numeric),
  ('y15', 4469::numeric),
  ('y16', 12930::numeric),
  ('y17', 5298::numeric),
  ('y18', 26257::numeric),
  ('y19', 3700::numeric),
  ('y20', 6761::numeric),
  ('y21', 7222::numeric),
  ('y22', 12938::numeric),
  ('y23', 3646::numeric)
) as reading(field_key, current_reading)
where calculation.id = 'fadf95d3-7290-4984-b377-b68b134fb90b'
on conflict (calculation_id, billing_month, field_key) do update
set current_reading = excluded.current_reading,
    updated_at = now();
