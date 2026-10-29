-- 第 16 步：堵住限额的几个绕过方式
-- 在 Supabase 控制台 → SQL Editor 中整段执行一次即可（需先执行 0001–0013）。
--
--   1. 每天 10 个地点：原来只在新建 place 记录时计数。客户端可以直接 UPDATE checkins，
--      把 city 改成 place、改坐标把旧记录当新地点用、把删除的记录复活，都不会被数到。
--      现在 level 和坐标建好后不能再改（坐标只允许从空补上），删除后不能复活。
--      前端本来就不会做这些修改，正常同步不受影响。
--   2. 照片总量：原来只限每天 50 张，没有总量上限，一个人几天就能写满存储。
--      现在每人最多 1000 张照片（原图 + 缩略图共 2000 个文件），领凭证和上传时都检查。
--      注销账号时如果照片还没删干净就拒绝执行，避免绕过前端直接调用后在存储里留下照片。
--   3. 时间字段：published_at 由客户端填写，填成 2099 年就会一直置顶在好友动态里；
--      发布过后还能改回空再重新发布，反复把自己顶上去。
--      现在 published_at 不能晚于服务器时间，发布过就不能再改；updated_at 不能超过服务器时间 1 分钟。
--   4. 删后重发：评论、好友申请、每天建群原来数的是表里还存在的行，删掉（撤回、退群解散）就不算了，
--      可以反复发送再删除，绕过限额并不停给对方推送。现在改为记一份只增不删的操作日志来计数，
--      同时加锁，避免并发请求同时通过检查。

-- ---------- 1 + 3. 打卡 ----------
create or replace function public.checkins_limits() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  n int := jsonb_array_length(new.photos);
begin
  -- 只拦「变多」：限制上线前已有超过 5 张的记录仍可正常修改、删照片
  if n > 5 and (tg_op = 'INSERT' or n > jsonb_array_length(old.photos)) then
    perform public.limit_exceeded('photos_per_place');
  end if;

  -- 客户端的时钟可以有一点偏差，但不能写未来的时间
  -- （不用 least()：它会忽略 null，least(null, now()) 会把没发布的记录变成已发布）
  if new.updated_at > now() + interval '1 minute' then new.updated_at := now() + interval '1 minute'; end if;
  if new.published_at > now() then new.published_at := now(); end if;

  if tg_op = 'UPDATE' then
    -- 打卡时间以服务器为准；层级、坐标建好后不能改；删除后不能复活；发布时间只记第一次
    new.created_at := old.created_at;
    new.level := old.level;
    if old.lat is not null or old.lng is not null then
      new.lat := old.lat;
      new.lng := old.lng;
    end if;
    new.deleted := old.deleted or new.deleted;
    if old.published_at is not null then new.published_at := old.published_at; end if;
    return new;
  end if;
  new.created_at := now();

  if (select count(*) from public.checkins c
      where c.user_id = new.user_id and c.created_at >= now() - interval '1 day') >= 300 then
    perform public.limit_exceeded('records_per_day');
  end if;

  if new.level = 'place' and (select count(*) from public.checkins c
      where c.user_id = new.user_id and c.level = 'place'
        and c.created_at >= public.user_day_start(new.user_id)) >= 10 then
    perform public.limit_exceeded('places_per_day');
  end if;
  return new;
end $$;
revoke execute on function public.checkins_limits() from public, anon, authenticated;

-- ---------- 2. 照片总量 ----------
-- 某人存储目录里的文件数（原图和缩略图各算一个），except_path 用于覆盖上传时不把自己算进去
create function public.photo_files(uid uuid, except_path text default null) returns int
language sql stable security definer set search_path = '' as $$
  select count(*)::int from storage.objects o
  where o.bucket_id = 'photos' and o.name like uid::text || '/%'
    and o.name is distinct from except_path;
$$;
revoke execute on function public.photo_files(uuid, text) from public, anon, authenticated;

create or replace function public.claim_photo(photo text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if photo !~ '^[a-z0-9]{6,40}$' then
    raise exception 'BAD_PHOTO_ID' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.photo_tickets t where t.user_id = auth.uid() and t.photo_id = photo) then
    return;
  end if;
  -- 同一用户的并发领取排队执行，避免同时领取时多算出额度
  perform pg_advisory_xact_lock(hashtext('photo_tickets:' || auth.uid()::text));
  if public.photo_files(auth.uid()) >= 2000 then
    perform public.limit_exceeded('photos_total');
  end if;
  if (select count(*) from public.photo_tickets t
      where t.user_id = auth.uid() and t.created_at >= now() - interval '1 day') >= 50 then
    perform public.limit_exceeded('photos_per_day');
  end if;
  insert into public.photo_tickets (user_id, photo_id) values (auth.uid(), photo)
    on conflict do nothing;
end $$;

-- 上传时再检查一次总量：凭证不会过期，不能先攒一大堆凭证再一次传完
create or replace function public.has_photo_ticket(path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select storage.filename(path) ~ '^[a-z0-9]{6,40}(_t)?\.jpg$'
    and exists (select 1 from public.photo_tickets t
      where t.user_id = auth.uid()
        and t.photo_id = regexp_replace(storage.filename(path), '(_t)?\.jpg$', ''))
    and public.photo_files(auth.uid(), path) < 2000;
$$;

-- 剩余额度多返回一项 total_left：总量还能存几张（按原图数，缩略图不算）
create or replace function public.photo_quota() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'left', greatest(0, 50 - count(*)),
    'next_at', min(t.created_at) + interval '1 day',
    'total_left', greatest(0, 1000 - (
      select count(*) from storage.objects o
      where o.bucket_id = 'photos' and o.name like auth.uid()::text || '/%' and o.name not like '%\_t.jpg')))
  from public.photo_tickets t
  where t.user_id = auth.uid() and t.created_at >= now() - interval '1 day';
$$;

-- 注销：照片要先由前端通过 Storage API 删完（SQL 删不了存储里的文件）
create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if public.photo_files(me) > 0 then
    raise exception 'PHOTOS_REMAIN' using errcode = 'P0001';
  end if;
  delete from auth.users where id = me;
end;
$$;

-- ---------- 4. 操作日志：只增不删，用来计数 ----------
create table public.action_log (
  user_id uuid not null references auth.users on delete cascade,
  kind    text not null check (kind in ('comment', 'friend_request', 'group_create')),
  at      timestamptz not null default now()
);
create index action_log_user_kind_at on public.action_log (user_id, kind, at);
alter table public.action_log enable row level security; -- 不建 policy：只有下面的函数能读写
revoke all on public.action_log from anon, authenticated;

-- 检查并记一次：per_minute / per_day 为空表示不限（「每天」是滚动 24 小时，和原来一致）
create function public.log_action(uid uuid, what text, per_minute int, minute_code text, per_day int, day_code text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtext('action_log:' || uid::text || ':' || what));
  if per_minute is not null and (select count(*) from public.action_log a
      where a.user_id = uid and a.kind = what and a.at >= now() - interval '1 minute') >= per_minute then
    perform public.limit_exceeded(minute_code);
  end if;
  if per_day is not null and (select count(*) from public.action_log a
      where a.user_id = uid and a.kind = what and a.at >= now() - interval '1 day') >= per_day then
    perform public.limit_exceeded(day_code);
  end if;
  -- 顺手清掉这个人两天前的旧日志，表不会无限变大
  delete from public.action_log a where a.user_id = uid and a.kind = what and a.at < now() - interval '2 days';
  insert into public.action_log (user_id, kind) values (uid, what);
end $$;
revoke execute on function public.log_action(uuid, text, int, text, int, text) from public, anon, authenticated;

-- 把最近一天还存在的记录补进日志，执行后限额无缝衔接
insert into public.action_log (user_id, kind, at)
  select c.author, 'comment', c.created_at from public.comments c where c.created_at >= now() - interval '1 day'
  union all
  select f.requester, 'friend_request', f.created_at from public.friendships f where f.created_at >= now() - interval '1 day'
  union all
  select g.created_by, 'group_create', g.created_at from public.chat_groups g
    where g.created_by is not null and g.created_at >= now() - interval '1 day';

create or replace function public.comments_limits() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.log_action(new.author, 'comment', 10, 'too_fast', 300, 'comments_per_day');
  return new;
end $$;

create or replace function public.friendships_limits() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- 同时待处理的申请数看的是当前状态，撤回后确实不再占名额，仍然数表
  if (select count(*) from public.friendships f
      where f.requester = new.requester and f.status = 'pending') >= 50 then
    perform public.limit_exceeded('requests_pending');
  end if;
  perform public.log_action(new.requester, 'friend_request', null, null, 30, 'requests_per_day');
  return new;
end $$;

create or replace function public.create_group(group_name text, members uuid[]) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  others uuid[];
  gid uuid;
begin
  if me is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  others := public.group_friends_only(members);
  if cardinality(others) < 1 then
    raise exception 'GROUP_EMPTY' using errcode = 'P0001';
  end if;
  if cardinality(others) + 1 > 20 then
    perform public.limit_exceeded('group_full');
  end if;
  perform public.log_action(me, 'group_create', null, null, 10, 'groups_per_day');
  insert into public.chat_groups (name, owner, created_by) values (btrim(group_name), me, me) returning id into gid;
  insert into public.group_members (group_id, user_id, added_by)
  select gid, u, me from unnest(array_prepend(me, others)) u;
  perform public.group_system(gid, 'create', others);
  return gid;
end $$;

-- create or replace 会保留原来的授权，这里再收一遍，和 0010、0012 保持一致
revoke execute on function public.comments_limits() from public, anon, authenticated;
revoke execute on function public.friendships_limits() from public, anon, authenticated;
revoke execute on function public.create_group(text, uuid[]) from public, anon;
grant execute on function public.create_group(text, uuid[]) to authenticated;
