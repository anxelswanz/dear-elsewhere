-- 第 5 步：好友、动态与评论
-- 在 Supabase 控制台 → SQL Editor 中整段执行一次即可（需先执行 0001、0002）。
--
-- 好友能看到什么：
--   · 带照片、点过「收进足迹」的打卡（动态），以及动态下的评论
--   · 对方在资料里打开「足迹地图对好友公开」后，能看到对方的全部打卡
-- 陌生人什么都看不到。

-- ---------- 动态：在打卡上记录发布时间 ----------
alter table public.checkins add column published_at timestamptz;
create index checkins_feed on public.checkins (published_at desc) where published_at is not null and not deleted;

-- ---------- 好友关系 ----------
-- 一行表示一次申请；对方接受后 status 变为 accepted。拒绝、撤回、删除好友都是删除这一行
create table public.friendships (
  requester   uuid not null references public.profiles (id) on delete cascade,
  addressee   uuid not null references public.profiles (id) on delete cascade,
  status      text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at  timestamptz not null default now(),
  accepted_at timestamptz,
  primary key (requester, addressee),
  check (requester <> addressee)
);
-- 同一对人只能有一行，不论谁先发起
create unique index friendships_pair on public.friendships (least(requester, addressee), greatest(requester, addressee));
create index friendships_addressee on public.friendships (addressee);

alter table public.friendships enable row level security;

create policy "查看与自己有关的好友关系" on public.friendships
  for select to authenticated using ((select auth.uid()) in (requester, addressee));
create policy "以自己的名义发送申请" on public.friendships
  for insert to authenticated with check (requester = (select auth.uid()) and status = 'pending');
create policy "只有被申请的一方可以接受" on public.friendships
  for update to authenticated using (addressee = (select auth.uid())) with check (addressee = (select auth.uid()));
create policy "任何一方都可以解除" on public.friendships
  for delete to authenticated using ((select auth.uid()) in (requester, addressee));

revoke all on public.friendships from anon;

-- 只允许把 pending 改成 accepted，其他字段不能动
create function public.friendships_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.accepted_at := null;
    new.status := 'pending';
    return new;
  end if;
  if new.requester <> old.requester or new.addressee <> old.addressee
     or old.status <> 'pending' or new.status <> 'accepted' then
    raise exception 'FRIENDSHIP_IMMUTABLE' using errcode = 'P0001';
  end if;
  new.created_at := old.created_at;
  new.accepted_at := now();
  return new;
end $$;

create trigger friendships_guard before insert or update on public.friendships
  for each row execute function public.friendships_guard();

-- 当前用户与 other 是否互为好友（other 用文本，方便在 Storage 路径里直接用）
create function public.is_friend(other text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and ((f.requester = auth.uid() and f.addressee::text = other)
        or (f.addressee = auth.uid() and f.requester::text = other)));
$$;
revoke execute on function public.is_friend(text) from public, anon;
grant execute on function public.is_friend(text) to authenticated;

-- ---------- 好友能看到的打卡 ----------
create policy "好友可以查看动态与公开的足迹" on public.checkins
  for select to authenticated using (
    not deleted
    and public.is_friend(user_id::text)
    and (
      (published_at is not null and photos <> '[]'::jsonb)
      or exists (select 1 from public.profiles p where p.id = checkins.user_id and p.map_public)
    )
  );

create policy "好友可以查看照片" on storage.objects
  for select to authenticated
  using (bucket_id = 'photos' and public.is_friend((storage.foldername(name))[1]));

-- ---------- 评论 ----------
create table public.comments (
  id            uuid primary key default gen_random_uuid(),
  checkin_owner uuid not null,
  checkin_id    text not null,
  author        uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  body          text not null check (char_length(btrim(body)) between 1 and 140),
  created_at    timestamptz not null default now(),
  foreign key (checkin_owner, checkin_id) references public.checkins (user_id, id) on delete cascade
);
create index comments_checkin on public.comments (checkin_owner, checkin_id, created_at desc);
create index comments_owner_recent on public.comments (checkin_owner, created_at desc);

alter table public.comments enable row level security;

-- 能看到这条打卡，就能看到它的评论（子查询同样受 checkins 的 RLS 约束）
create policy "能看到打卡就能看评论" on public.comments
  for select to authenticated using (
    exists (select 1 from public.checkins c where c.user_id = checkin_owner and c.id = checkin_id));
-- 只能评论自己能看到的动态
create policy "评论自己能看到的动态" on public.comments
  for insert to authenticated with check (
    author = (select auth.uid())
    and exists (select 1 from public.checkins c
      where c.user_id = checkin_owner and c.id = checkin_id
        and c.published_at is not null and not c.deleted));
create policy "作者或打卡主人可以删除评论" on public.comments
  for delete to authenticated using ((select auth.uid()) in (author, checkin_owner));

-- 作者和时间由数据库填写，客户端只能写这三列
revoke all on public.comments from anon, authenticated;
grant select, delete on public.comments to authenticated;
grant insert (checkin_owner, checkin_id, body) on public.comments to authenticated;

-- ---------- 推送：发布时间并入同步函数（取最早的一次发布） ----------
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
    created_at = least(cur.created_at, incoming.created_at),
    updated_at = greatest(cur.updated_at, incoming.updated_at),
    synced_at = now()
  where c.user_id = cur.user_id and c.id = cur.id
  returning * into winner;
  return winner;
end $$;

-- ---------- 实时推送 ----------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.friendships, public.comments, public.checkins;
  end if;
end $$;
