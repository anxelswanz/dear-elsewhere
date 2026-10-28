-- 第 7 步：旅程动画里每一段的交通工具
-- 在 Supabase 控制台 → SQL Editor 中整段执行一次即可（需先执行 0001–0004）。
--
-- 交通工具记在「到达」的那次打卡上：这一段旅程是怎么来的。
-- 为空表示用默认值（跨国坐飞机、国内坐火车）。和其他字段一样按「最后修改胜出」合并。

alter table public.checkins add column transport text
  check (transport in ('plane', 'ship', 'train', 'car'));

-- ---------- 同步函数：合并时带上 transport ----------
create or replace function public.push_checkin(r jsonb) returns public.checkins
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
    published_at = least(cur.published_at, incoming.published_at), -- least 会忽略 null
    transport = winner.transport,
    created_at = least(cur.created_at, incoming.created_at),
    updated_at = greatest(cur.updated_at, incoming.updated_at),
    synced_at = now()
  where c.user_id = cur.user_id and c.id = cur.id
  returning * into winner;
  return winner;
end $$;
