-- 第 19 步：使用统计（第一方、轻量）与管理员控制台
-- 在 Supabase 控制台 → SQL Editor 中整段执行一次即可（需先执行 0001–0017）。
-- 设计说明见本地的 ANALYTICS.md。
--
--   · events：功能事件。不存 IP、不存内容；用户在设置里关掉后直接丢弃；400 天后删除；注销账号时一起删除
--   · admins：能打开 /dashboard/ 的账号。执行完把自己加进去：
--       insert into public.admins (user_id) select id from auth.users where email = '你的邮箱';
--   · admin_dashboard(days) / admin_users(...)：只返回汇总和计数，不返回任何文字内容、邮箱、照片

-- ---------- 表 ----------
create table public.admins (
  user_id    uuid primary key references auth.users on delete cascade,
  created_at timestamptz not null default now()
);

create table public.events (
  id      bigint generated always as identity primary key,
  user_id uuid references auth.users on delete cascade,
  session text,
  name    text not null,
  props   jsonb not null default '{}',
  at      timestamptz not null default now()
);
create index events_name_at on public.events (name, at);
create index events_user_at on public.events (user_id, at);

-- 限频用：登录用户按 id，匿名按 IP 哈希；只保留 1 分钟
create table public.event_throttle (
  key text not null,
  at  timestamptz not null default now()
);
create index event_throttle_key on public.event_throttle (key, at);

alter table public.admins enable row level security;
alter table public.events enable row level security;
alter table public.event_throttle enable row level security;
-- 不建 policy：只有下面的 security definer 函数能读写
revoke all on public.admins, public.events, public.event_throttle from anon, authenticated;

-- 设置 → 数据 →「帮助改进 Dear Elsewhere」
alter table public.profile_private add column analytics boolean not null default true;

-- ---------- 上报 ----------
-- 不认识的事件、未登录时的非官网/注册事件、关闭了统计的用户、超频的请求：都静默丢弃，不报错
create function public.track(event text, props jsonb default '{}', sid text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid     uuid := auth.uid();
  headers json := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json;
  ip      text := coalesce(headers->>'cf-connecting-ip', btrim(split_part(headers->>'x-forwarded-for', ',', 1)), 'unknown');
  bucket  text;
  clean   jsonb := '{}';
  k       text;
begin
  if event is null or not (event = any (array[
      'app_open', 'site_view', 'site_cta', 'signup_view', 'signup_submit', 'signup_error',
      'friends_overlay', 'friend_dot_click', 'only_friend', 'feed_open', 'chat_open',
      'snapshot_open', 'snapshot_shoot', 'snapshot_ready', 'snapshot_save', 'snapshot_cancel',
      'settings_open', 'theme_change', 'lang_change', 'photos_zip', 'account_export', 'account_delete',
      'limit_hit', 'client_error'])) then
    return;
  end if;
  if uid is null and not (event = any (array['site_view', 'site_cta', 'signup_view', 'signup_submit', 'signup_error'])) then
    return;
  end if;
  if uid is not null and exists (select 1 from public.profile_private p where p.id = uid and not p.analytics) then
    return;
  end if;

  bucket := coalesce(uid::text, md5('track:' || ip));
  delete from public.event_throttle t where t.at < now() - interval '1 minute';
  if (select count(*) from public.event_throttle t where t.key = bucket) >= (case when uid is null then 60 else 120 end) then
    return;
  end if;
  insert into public.event_throttle (key) values (bucket);

  -- 属性只留白名单里的标量，字符串截到 40 个字符
  if jsonb_typeof(props) = 'object' then
    for k in select jsonb_object_keys(props) loop
      if k = any (array['device', 'lang', 'theme', 'from', 'code', 'on', 'n', 'type', 'level', 'marks',
                        'ratio', 'moved', 'ms', 'ok', 'via', 'stage', 'photos', 'where'])
         and jsonb_typeof(props->k) in ('string', 'number', 'boolean') then
        clean := clean || jsonb_build_object(k,
          case when jsonb_typeof(props->k) = 'string' then to_jsonb(left(props->>k, 40)) else props->k end);
      end if;
    end loop;
  end if;

  -- 注销账号的事件不挂在账号上：账号删除时事件会级联删除，挂上就统计不到流失了
  insert into public.events (user_id, session, name, props)
  values (case when event = 'account_delete' then null else uid end, left(sid, 36), event, clean);
  -- 偶尔顺手清掉 400 天前的事件，不需要定时任务
  if random() < 0.01 then
    delete from public.events e where e.at < now() - interval '400 days';
  end if;
end $$;
revoke execute on function public.track(text, jsonb, text) from public;
grant execute on function public.track(text, jsonb, text) to anon, authenticated;

-- ---------- 管理员 ----------
create function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid());
$$;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- 「活跃」：打开过 App，或写过打卡 / 评论 / 私信 / 群消息
create function public.activity() returns table (user_id uuid, at timestamptz)
language sql stable security definer set search_path = '' as $$
  select e.user_id, e.at from public.events e where e.name = 'app_open' and e.user_id is not null
  union all select c.user_id, c.created_at from public.checkins c
  union all select c.author, c.created_at from public.comments c
  union all select m.sender, m.created_at from public.messages m
  union all select g.sender, g.created_at from public.group_messages g where g.kind <> 'system';
$$;
revoke execute on function public.activity() from public, anon, authenticated;

-- 整个控制台一次取回；days：趋势、漏斗、功能使用的时间范围
create function public.admin_dashboard(days int default 30) returns json
language plpgsql stable security definer set search_path = '' as $$
declare
  d     int := greatest(1, least(coalesce(days, 30), 365));
  since timestamptz := now() - make_interval(days => d);
  out   json;
begin
  if not public.is_admin() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;

  with act as (select * from public.activity()),
  users as (select u.id, u.created_at from auth.users u),
  cohort as (select * from users where created_at >= since)
  select json_build_object(
    'days', d,
    'generated_at', now(),

    'kpi', json_build_object(
      'users',    (select count(*) from users),
      'new',      (select count(*) from cohort),
      'new_7d',   (select count(*) from users where created_at >= now() - interval '7 days'),
      'dau',      (select count(distinct user_id) from act where at >= now() - interval '1 day'),
      'wau',      (select count(distinct user_id) from act where at >= now() - interval '7 days'),
      'mau',      (select count(distinct user_id) from act where at >= now() - interval '30 days'),
      'stamps',   (select count(*) from public.checkins c where not c.deleted),
      'photos',   (select coalesce(sum(jsonb_array_length(c.photos)), 0) from public.checkins c where not c.deleted)),

    -- 按天：注册、活跃人数、盖章、评论、消息
    'series', (select json_agg(json_build_object(
        'day', day,
        'signups',  (select count(*) from users u where u.created_at >= day and u.created_at < day + interval '1 day'),
        'active',   (select count(distinct a.user_id) from act a where a.at >= day and a.at < day + interval '1 day'),
        'stamps',   (select count(*) from public.checkins c where c.created_at >= day and c.created_at < day + interval '1 day'),
        'comments', (select count(*) from public.comments c where c.created_at >= day and c.created_at < day + interval '1 day'),
        'messages', (select count(*) from public.messages m where m.created_at >= day and m.created_at < day + interval '1 day')
                  + (select count(*) from public.group_messages g where g.kind <> 'system' and g.created_at >= day and g.created_at < day + interval '1 day'))
        order by day)
      from generate_series(date_trunc('day', now()) - make_interval(days => d - 1), date_trunc('day', now()), interval '1 day') day),

    -- 激活漏斗：这段时间里注册的人，各走到了哪一步
    'funnel', (select json_build_object(
        'signed',   count(*),
        'passport', count(*) filter (where exists (select 1 from public.profiles p where p.id = c.id)),
        'stamp',    count(*) filter (where exists (select 1 from public.checkins k where k.user_id = c.id and not k.deleted)),
        'photo',    count(*) filter (where exists (select 1 from public.checkins k where k.user_id = c.id and not k.deleted and k.photos <> '[]'::jsonb)),
        'friend',   count(*) filter (where exists (select 1 from public.friendships f where f.status = 'accepted' and c.id in (f.requester, f.addressee))),
        'share',    count(*) filter (where exists (select 1 from public.checkins k where k.user_id = c.id and k.published_at is not null)
                                        or exists (select 1 from public.messages m where m.sender = c.id and m.kind = 'checkin')
                                        or exists (select 1 from public.group_messages g where g.sender = c.id and g.kind = 'checkin')),
        'returned', count(*) filter (where exists (select 1 from act a where a.user_id = c.id and a.at >= c.created_at + interval '7 days')))
      from cohort c),

    -- 留存：最近 12 个注册周，之后第 1 / 2 / 4 / 8 周是否活跃（还没到的周为空）
    'retention', (select json_agg(r order by r.week) from (
        select w.week,
          count(*) as size,
          case when w.week + interval '14 days' <= now() then count(*) filter (where exists (select 1 from act a where a.user_id = u.id and a.at >= w.week + interval '7 days' and a.at < w.week + interval '14 days')) end as w1,
          case when w.week + interval '21 days' <= now() then count(*) filter (where exists (select 1 from act a where a.user_id = u.id and a.at >= w.week + interval '14 days' and a.at < w.week + interval '21 days')) end as w2,
          case when w.week + interval '35 days' <= now() then count(*) filter (where exists (select 1 from act a where a.user_id = u.id and a.at >= w.week + interval '28 days' and a.at < w.week + interval '35 days')) end as w4,
          case when w.week + interval '63 days' <= now() then count(*) filter (where exists (select 1 from act a where a.user_id = u.id and a.at >= w.week + interval '56 days' and a.at < w.week + interval '63 days')) end as w8
        from (select distinct date_trunc('week', u.created_at) as week from users u where u.created_at >= date_trunc('week', now()) - interval '11 weeks') w
        join users u on date_trunc('week', u.created_at) = w.week
        group by w.week) r),

    -- 有好友 vs 没好友：注册满 30 天的人，最近 30 天还活跃的比例
    'friend_effect', (select json_build_object(
        'with_total',    count(*) filter (where has_friend),
        'with_active',   count(*) filter (where has_friend and active),
        'without_total', count(*) filter (where not has_friend),
        'without_active', count(*) filter (where not has_friend and active))
      from (select exists (select 1 from public.friendships f where f.status = 'accepted' and u.id in (f.requester, f.addressee)) as has_friend,
                   exists (select 1 from act a where a.user_id = u.id and a.at >= now() - interval '30 days') as active
            from users u where u.created_at < now() - interval '30 days') x),

    'content', json_build_object(
      'markers',   (select json_object_agg(coalesce(marker, '?'), n) from (select c.marker, count(*) n from public.checkins c where not c.deleted group by 1) x),
      'transport', (select json_object_agg(coalesce(transport, 'none'), n) from (select c.transport, count(*) n from public.checkins c where not c.deleted group by 1) x),
      'photos_per_stamp', (select json_object_agg(k, n) from (select least(jsonb_array_length(c.photos), 5)::text k, count(*) n from public.checkins c where not c.deleted group by 1) x),
      'published', (select count(*) from public.checkins c where not c.deleted and c.published_at is not null),
      'countries', (select json_agg(json_build_object('country', country, 'stamps', n, 'users', u) order by n desc) from (
          select c.country, count(*) n, count(distinct c.user_id) u from public.checkins c
          where not c.deleted and c.country <> '' group by 1 order by 2 desc limit 10) x)),

    'social', json_build_object(
      'requests',      (select count(*) from public.friendships f where f.created_at >= since),
      'accepted',      (select count(*) from public.friendships f where f.created_at >= since and f.status = 'accepted'),
      'friends_avg',   (select round(coalesce(avg(n), 0), 1) from (select u.id, (select count(*) from public.friendships f where f.status = 'accepted' and u.id in (f.requester, f.addressee)) n from users u) x),
      'comments',      (select count(*) from public.comments c where c.created_at >= since),
      'chat_comments', (select count(*) from public.messages m where m.kind = 'comment' and m.created_at >= since)
                     + (select count(*) from public.group_messages g where g.kind = 'comment' and g.created_at >= since),
      'dms',           (select count(*) from public.messages m where m.created_at >= since and m.kind <> 'comment'),
      'group_msgs',    (select count(*) from public.group_messages g where g.created_at >= since and g.kind not in ('system', 'comment')),
      'shares',        (select count(*) from public.messages m where m.kind = 'checkin' and m.created_at >= since)
                     + (select count(*) from public.group_messages g where g.kind = 'checkin' and g.created_at >= since),
      'groups',        (select count(*) from public.chat_groups g where g.created_at >= since),
      'group_size',    (select round(coalesce(avg(n), 0), 1) from (select count(*) n from public.group_members m group by m.group_id) x),
      'draws',         (select count(*) from public.avatar_draws a where a.created_at >= since)),

    -- 功能事件：次数和人数；以及几个值得拆开看的属性
    'events', (select json_object_agg(name, json_build_object('n', n, 'users', u, 'sessions', s)) from (
        select e.name, count(*) n, count(distinct e.user_id) u, count(distinct e.session) s
        from public.events e where e.at >= since group by 1) x),
    -- 形如 { "snapshot_save.via": { "share": 3, "download": 5 }, ... }
    'breakdown', (select json_object_agg(k, v) from (
        select p.name || '.' || p.key as k, json_object_agg(p.value, p.n) as v
        from (select e.name, kv.key, kv.value #>> '{}' as value, count(*) n
              from public.events e cross join lateral jsonb_each(e.props) kv
              where e.at >= since and kv.key in ('device', 'lang', 'theme', 'from', 'code', 'type', 'level', 'marks', 'ratio', 'moved', 'ok', 'via', 'stage', 'where', 'on')
              group by 1, 2, 3) p
        group by p.name, p.key) x),
    'snapshot_ms', (select json_build_object('avg', round(avg((e.props->>'ms')::numeric)), 'p90', percentile_cont(0.9) within group (order by (e.props->>'ms')::numeric))
      from public.events e where e.name = 'snapshot_ready' and e.at >= since and e.props->>'ms' ~ '^[0-9.]+$'),

    'limits', (select json_object_agg(kind, n) from (select a.kind, count(*) n from public.action_log a where a.at >= now() - interval '1 day' group by 1) x),
    'invites', (select json_agg(json_build_object('code', left(i.code, 3) || '…', 'note', i.note, 'uses', i.uses, 'active', i.active) order by i.uses desc) from public.invite_codes i)
  ) into out;
  return out;
end $$;
revoke execute on function public.admin_dashboard(int) from public, anon;
grant execute on function public.admin_dashboard(int) to authenticated;

-- 用户列表：只有计数，不含内容和邮箱；sort 只认下面几列
create function public.admin_users(sort text default 'last_active', page int default 0) returns json
language plpgsql stable security definer set search_path = '' as $$
declare out json;
begin
  if not public.is_admin() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  with act as (select a.user_id, max(a.at) as last from public.activity() a group by 1),
  rows as (
    select p.handle, p.name, p.avatar, u.created_at, act.last as last_active,
      (select count(*) from public.checkins c where c.user_id = u.id and not c.deleted) as stamps,
      (select coalesce(sum(jsonb_array_length(c.photos)), 0) from public.checkins c where c.user_id = u.id and not c.deleted) as photos,
      (select count(*) from public.friendships f where f.status = 'accepted' and u.id in (f.requester, f.addressee)) as friends,
      (select count(*) from public.comments c where c.author = u.id) as comments,
      (select count(*) from public.messages m where m.sender = u.id) + (select count(*) from public.group_messages g where g.sender = u.id and g.kind <> 'system') as messages
    from auth.users u
    left join public.profiles p on p.id = u.id
    left join act on act.user_id = u.id)
  select json_build_object(
    'total', (select count(*) from rows),
    'rows', (select json_agg(r) from (
      select * from rows
      order by
        case when sort = 'created_at' then extract(epoch from created_at) end desc nulls last,
        case when sort = 'stamps' then stamps end desc,
        case when sort = 'photos' then photos end desc,
        case when sort = 'friends' then friends end desc,
        case when sort = 'comments' then comments end desc,
        case when sort = 'messages' then messages end desc,
        extract(epoch from last_active) desc nulls last
      limit 50 offset greatest(coalesce(page, 0), 0) * 50) r)
  ) into out;
  return out;
end $$;
revoke execute on function public.admin_users(text, int) from public, anon;
grant execute on function public.admin_users(text, int) to authenticated;
