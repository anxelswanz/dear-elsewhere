-- 第 4 步：打卡记录与照片的双写同步
-- 在 Supabase 控制台 → SQL Editor 中整段执行一次即可（需先执行 0001）。
--
-- 合并规则（与前端 src/sync.js 一致）：
--   · 整条记录「最后修改胜出」：比较客户端写入的 updated_at
--   · 照片按 id 取并集，删除过的照片 id 记在 deleted_photos 里，任何一端删过都不会复活
--   · 删除整条打卡只打墓碑标记 deleted = true，方便其他设备同步到这次删除

-- ---------- 打卡记录 ----------
create table public.checkins (
  user_id        uuid not null default auth.uid() references auth.users on delete cascade,
  id             text not null check (id ~ '^[a-z0-9]{6,40}$'),
  level          text not null check (level in ('country', 'region', 'city', 'place')),
  ref            text not null default '',
  name           text not null default '' check (char_length(name) <= 200),
  country        text not null default '',
  region         text not null default '',
  city           text not null default '',
  lat            double precision check (lat between -90 and 90),
  lng            double precision check (lng between -540 and 540),
  date           date,
  note           text not null default '' check (char_length(note) <= 5000),
  marker         text not null default 'sign',
  icon           text not null default 'pin',
  label          text not null default '' check (char_length(label) <= 60),
  photos         jsonb not null default '[]' check (jsonb_typeof(photos) = 'array'),
  deleted_photos text[] not null default '{}',
  deleted        boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null,               -- 客户端最后修改时间，用于「最后修改胜出」
  synced_at      timestamptz not null default now(), -- 服务器写入时间，用于增量拉取
  primary key (user_id, id)
);

create index checkins_user_synced on public.checkins (user_id, synced_at);

alter table public.checkins enable row level security;

create policy "只能查看自己的打卡" on public.checkins
  for select to authenticated using (user_id = (select auth.uid()));
create policy "只能新增自己的打卡" on public.checkins
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "只能修改自己的打卡" on public.checkins
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
-- 不开放 delete：删除通过墓碑标记同步

revoke all on public.checkins from anon;

-- ---------- 写入并合并（客户端只调用这个函数） ----------
create function public.push_checkin(r jsonb) returns public.checkins
language plpgsql security invoker set search_path = '' as $$
declare
  incoming public.checkins;
  cur      public.checkins;
  winner   public.checkins;
  loser    public.checkins;
  dead     text[];
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  -- 缺省字段先补上默认值（jsonb_populate_record 不会用列默认值）
  incoming := jsonb_populate_record(null::public.checkins, jsonb_build_object(
    'ref', '', 'name', '', 'country', '', 'region', '', 'city', '', 'note', '',
    'marker', 'sign', 'icon', 'pin', 'label', '', 'photos', '[]'::jsonb, 'deleted_photos', '{}'::text[],
    'deleted', false, 'created_at', now(), 'updated_at', now()) || jsonb_strip_nulls(r));
  incoming.user_id := auth.uid();
  incoming.synced_at := now();

  select * into cur from public.checkins c
    where c.user_id = incoming.user_id and c.id = incoming.id
    for update;

  if not found then
    incoming.photos := (
      select coalesce(jsonb_agg(p order by o), '[]') from jsonb_array_elements(incoming.photos) with ordinality t(p, o)
      where not (p->>'id' = any(incoming.deleted_photos)));
    insert into public.checkins select (incoming).* returning * into winner;
    return winner;
  end if;

  if incoming.updated_at > cur.updated_at then
    winner := incoming; loser := cur;
  else
    winner := cur; loser := incoming;
  end if;

  dead := array(select distinct x from unnest(cur.deleted_photos || incoming.deleted_photos) x order by x);

  -- 胜出方的照片顺序在前，另一方独有的照片接在后面，删除过的剔除
  winner.photos := (
    select coalesce(jsonb_agg(p order by o), '[]') from (
      select p, o from jsonb_array_elements(winner.photos) with ordinality t(p, o)
      union all
      select p, 1000000 + o from jsonb_array_elements(loser.photos) with ordinality t(p, o)
        where not exists (select 1 from jsonb_array_elements(winner.photos) w where w->>'id' = p->>'id')
    ) s
    where not (p->>'id' = any(dead)));

  update public.checkins c set
    level = winner.level, ref = winner.ref, name = winner.name,
    country = winner.country, region = winner.region, city = winner.city,
    lat = winner.lat, lng = winner.lng, date = winner.date, note = winner.note,
    marker = winner.marker, icon = winner.icon, label = winner.label,
    photos = winner.photos, deleted_photos = dead, deleted = winner.deleted,
    created_at = least(cur.created_at, incoming.created_at),
    updated_at = greatest(cur.updated_at, incoming.updated_at),
    synced_at = now()
  where c.user_id = cur.user_id and c.id = cur.id
  returning * into winner;
  return winner;
end $$;

revoke execute on function public.push_checkin(jsonb) from public, anon;
grant execute on function public.push_checkin(jsonb) to authenticated;

-- ---------- 照片存储 ----------
-- 路径：photos/{用户 id}/{照片 id}.jpg（长边 1600px）与 {照片 id}_t.jpg（400px 缩略图）
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 5242880, array['image/jpeg', 'image/webp'])
on conflict (id) do nothing;

create policy "上传到自己的照片目录" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "查看自己的照片" on storage.objects
  for select to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "覆盖自己的照片" on storage.objects
  for update to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "删除自己的照片" on storage.objects
  for delete to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
