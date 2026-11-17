create table if not exists public.asset_meter_child_meter (
  parent_asset_meter_id uuid not null references public.asset_meter(asset_meter_id) on delete cascade,
  child_asset_meter_id uuid not null references public.asset_meter(asset_meter_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (parent_asset_meter_id, child_asset_meter_id),
  constraint asset_meter_child_meter_not_self check (parent_asset_meter_id <> child_asset_meter_id)
);

comment on table public.asset_meter_child_meter is '親メーターの使用量から差し引く子メーター。1つの親に複数の子を設定できる';

-- 旧列は「設定したメーター自身－選択メーター」で計算していたため、
-- 実際の意味に合わせて自身を親、選択先を子として移行する。
insert into public.asset_meter_child_meter (parent_asset_meter_id, child_asset_meter_id)
select asset_meter_id, parent_asset_meter_id
from public.asset_meter
where parent_asset_meter_id is not null
on conflict do nothing;

update public.asset_meter set parent_asset_meter_id = null where parent_asset_meter_id is not null;

alter table public.asset_meter_child_meter enable row level security;
drop policy if exists asset_meter_child_meter_select_active on public.asset_meter_child_meter;
create policy asset_meter_child_meter_select_active on public.asset_meter_child_meter
for select to authenticated using (public.current_account_is_active());
grant select on public.asset_meter_child_meter to authenticated;

create or replace function public.set_kanameter_meter_children(
  p_parent_asset_meter_id uuid,
  p_child_asset_meter_ids uuid[]
)
returns void language plpgsql security definer set search_path = public
as $$
declare
  v_asset_id uuid;
  v_child_id uuid;
begin
  if not public.current_account_is_active() then raise exception 'KANAMETERを利用する権限がありません'; end if;

  select asset_id into v_asset_id from public.asset_meter
  where asset_meter_id = p_parent_asset_meter_id and is_active = true;
  if v_asset_id is null then raise exception '親メーターが見つかりません'; end if;

  if p_parent_asset_meter_id = any(coalesce(p_child_asset_meter_ids, array[]::uuid[])) then
    raise exception '同じメーターを子メーターには設定できません';
  end if;

  foreach v_child_id in array coalesce(p_child_asset_meter_ids, array[]::uuid[])
  loop
    if not exists (
      select 1 from public.asset_meter
      where asset_meter_id = v_child_id and asset_id = v_asset_id and is_active = true
    ) then raise exception '同じビルの有効なメーターだけを子メーターに設定できます'; end if;

    if exists (
      with recursive descendants(id) as (
        select child_asset_meter_id from public.asset_meter_child_meter where parent_asset_meter_id = v_child_id
        union
        select relation.child_asset_meter_id
        from public.asset_meter_child_meter relation join descendants on relation.parent_asset_meter_id = descendants.id
      )
      select 1 from descendants where id = p_parent_asset_meter_id
    ) then raise exception '親子メーターが循環する設定は保存できません'; end if;
  end loop;

  delete from public.asset_meter_child_meter where parent_asset_meter_id = p_parent_asset_meter_id;
  insert into public.asset_meter_child_meter (parent_asset_meter_id, child_asset_meter_id)
  select p_parent_asset_meter_id, child_id
  from unnest(coalesce(p_child_asset_meter_ids, array[]::uuid[])) child_id
  on conflict do nothing;
end;
$$;

revoke all on function public.set_kanameter_meter_children(uuid, uuid[]) from public, anon;
grant execute on function public.set_kanameter_meter_children(uuid, uuid[]) to authenticated;
