-- 第 12 步：群聊
-- 在 Supabase 控制台 → SQL Editor 中整段执行一次即可（需先执行 0001–0009）。
--
--   拉人    只能拉自己的好友；群里的人彼此不一定是好友。任何成员都能拉自己的好友进来，被拉进来直接成为成员
--   人数    每个群最多 20 人（含群主）；每人每天最多建 10 个群
--   群主    可以改群名、移出成员；群主退群后由最早入群的成员接任，最后一个人退出后群自动解散
--   消息    只能看到自己入群之后的消息。三种：text、checkin（转发自己的章，快照同私信）、
--           system（建群、拉人、退群、移出、改名，由下面的函数写入，客户端不能伪造）
--   已读    每人只记一个「读到哪」的时间 read_at；某条消息的已读人数 = read_at 不早于它的其他成员
--   照片    转发到群里的章，群成员可以查看那几张照片；退群后就看不到了
--   限频    群消息和私信合计：每分钟 30 条，每天 2000 条（替换 0009 里只数私信的版本）
--
-- 建群、拉人、退群、改名都走下面的函数；表本身对客户端只读（群消息可以插入）。

-- ---------- 表 ----------
create table public.chat_groups (
  id              uuid primary key default gen_random_uuid(),
  name            text not null check (char_length(btrim(name)) between 1 and 30),
  owner           uuid references public.profiles (id) on delete set null,
  created_by      uuid references public.profiles (id) on delete set null, -- 只用来数「每天建了几个群」
  created_at      timestamptz not null default now(),
  last_message_at timestamptz not null default now()                       -- 群列表按最近消息排序
);
create index chat_groups_created_by on public.chat_groups (created_by, created_at);

create table public.group_members (
  group_id  uuid not null references public.chat_groups (id) on delete cascade,
  user_id   uuid not null references public.profiles (id) on delete cascade,
  added_by  uuid references public.profiles (id) on delete set null,
  joined_at timestamptz not null default now(),
  read_at   timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index group_members_user on public.group_members (user_id);

create table public.group_messages (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid not null references public.chat_groups (id) on delete cascade,
  sender     uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  kind       text not null default 'text' check (kind in ('text', 'checkin', 'system')),
  body       text not null default '' check (char_length(body) <= 1000),
  checkin    jsonb,
  meta       jsonb, -- system：{ event: create|add|leave|remove|rename, users: [id], name }
  created_at timestamptz not null default now(),
  check (kind <> 'text' or char_length(btrim(body)) >= 1),
  check (kind <> 'checkin' or (
    jsonb_typeof(checkin) = 'object'
    and checkin->>'id' ~ '^[a-z0-9]{6,40}$'
    and jsonb_typeof(checkin->'photos') = 'array'
    and jsonb_array_length(checkin->'photos') between 1 and 9
    and pg_column_size(checkin) <= 8192)),
  check (kind = 'checkin' or checkin is null),
  check ((kind = 'system') = (meta is not null))
);
create index group_messages_group on public.group_messages (group_id, created_at desc);
create index group_messages_sender_recent on public.group_messages (sender, created_at desc);
create index group_messages_checkins on public.group_messages (sender) where kind = 'checkin';

-- ---------- 成员判断（security definer：避免策略之间互相递归） ----------
-- 自己在这个群里的入群时间；不是成员时为 null
create function public.group_joined_at(gid uuid) returns timestamptz
language sql stable security definer set search_path = '' as $$
  select m.joined_at from public.group_members m where m.group_id = gid and m.user_id = auth.uid();
$$;
revoke execute on function public.group_joined_at(uuid) from public, anon;
grant execute on function public.group_joined_at(uuid) to authenticated;

-- ---------- 权限 ----------
alter table public.chat_groups enable row level security;
alter table public.group_members enable row level security;
alter table public.group_messages enable row level security;

create policy "成员可以查看群" on public.chat_groups
  for select to authenticated using (public.group_joined_at(id) is not null);
create policy "成员可以查看群成员" on public.group_members
  for select to authenticated using (public.group_joined_at(group_id) is not null);
create policy "成员可以查看入群之后的消息" on public.group_messages
  for select to authenticated using (created_at >= public.group_joined_at(group_id));
create policy "成员可以以自己的名义发群消息" on public.group_messages
  for insert to authenticated
  with check (sender = (select auth.uid()) and kind in ('text', 'checkin') and public.group_joined_at(group_id) is not null);

revoke all on public.chat_groups, public.group_members, public.group_messages from anon, authenticated;
grant select on public.chat_groups, public.group_members, public.group_messages to authenticated;
grant insert (group_id, kind, body, checkin) on public.group_messages to authenticated;

-- 发送时间由数据库填写；快照里的照片 id 只能是安全的文件名
create function public.group_messages_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.created_at := now();
  if new.kind = 'checkin' and exists (
    select 1 from jsonb_array_elements(new.checkin->'photos') p
    where jsonb_typeof(p) <> 'string' or p #>> '{}' !~ '^[a-z0-9]{6,40}$') then
    raise exception 'BAD_PHOTO_ID' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger group_messages_guard before insert on public.group_messages
  for each row execute function public.group_messages_guard();

-- 有新消息时更新群的最近消息时间
create function public.group_messages_touch() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.chat_groups set last_message_at = new.created_at where id = new.group_id;
  return null;
end $$;
create trigger group_messages_touch after insert on public.group_messages
  for each row execute function public.group_messages_touch();

-- ---------- 限频：私信 + 群消息合计 ----------
create function public.chat_sent_since(uid uuid, since timestamptz) returns int
language sql stable security definer set search_path = '' as $$
  select ((select count(*) from public.messages m where m.sender = uid and m.created_at >= since)
        + (select count(*) from public.group_messages g where g.sender = uid and g.created_at >= since and g.kind <> 'system'))::int;
$$;
revoke execute on function public.chat_sent_since(uuid, timestamptz) from public, anon, authenticated;

-- 替换 0009 的版本；两张表共用（系统消息不计数）
create or replace function public.messages_limits() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'system' then return new; end if;
  if public.chat_sent_since(new.sender, now() - interval '1 minute') >= 30 then
    perform public.limit_exceeded('too_fast');
  end if;
  if public.chat_sent_since(new.sender, now() - interval '1 day') >= 2000 then
    perform public.limit_exceeded('messages_per_day');
  end if;
  return new;
end $$;
create trigger group_messages_limits before insert on public.group_messages
  for each row execute function public.messages_limits();

-- ---------- 有人离开：群主交接、最后一人离开时解散 ----------
-- 退群、被移出、注销账号（级联删除）都会走到这里
create function public.group_members_left() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  heir uuid;
begin
  select m.user_id into heir from public.group_members m
  where m.group_id = old.group_id order by m.joined_at, m.user_id limit 1;
  if heir is null then
    delete from public.chat_groups where id = old.group_id;
  else
    update public.chat_groups set owner = heir
    where id = old.group_id and (owner is null or owner = old.user_id);
  end if;
  return null;
end $$;
create trigger group_members_left after delete on public.group_members
  for each row execute function public.group_members_left();

-- ---------- 操作 ----------
create function public.group_system(gid uuid, event text, users uuid[] default '{}', new_name text default null) returns void
language sql security definer set search_path = '' as $$
  insert into public.group_messages (group_id, sender, kind, meta)
  values (gid, auth.uid(), 'system', jsonb_strip_nulls(jsonb_build_object('event', event, 'users', to_jsonb(users), 'name', new_name)));
$$;
revoke execute on function public.group_system(uuid, text, uuid[], text) from public, anon, authenticated;

-- 去重、去掉自己，并确认每个人都是我的好友
create function public.group_friends_only(ids uuid[]) returns uuid[]
language plpgsql stable security definer set search_path = '' as $$
declare
  picked uuid[] := array(select distinct u from unnest(ids) u where u is not null and u <> auth.uid());
begin
  if exists (select 1 from unnest(picked) u where not public.is_friend(u::text)) then
    raise exception 'NOT_FRIEND' using errcode = 'P0001';
  end if;
  return picked;
end $$;
revoke execute on function public.group_friends_only(uuid[]) from public, anon, authenticated;

create function public.create_group(group_name text, members uuid[]) returns uuid
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
  if (select count(*) from public.chat_groups g
      where g.created_by = me and g.created_at >= now() - interval '1 day') >= 10 then
    perform public.limit_exceeded('groups_per_day');
  end if;
  insert into public.chat_groups (name, owner, created_by) values (btrim(group_name), me, me) returning id into gid;
  insert into public.group_members (group_id, user_id, added_by)
  select gid, u, me from unnest(array_prepend(me, others)) u;
  perform public.group_system(gid, 'create', others);
  return gid;
end $$;

create function public.add_group_members(gid uuid, members uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  fresh uuid[];
begin
  if public.group_joined_at(gid) is null then
    raise exception 'NOT_MEMBER' using errcode = '42501';
  end if;
  perform 1 from public.chat_groups where id = gid for update; -- 并发拉人时也不会超过上限
  fresh := array(select u from unnest(public.group_friends_only(members)) u
                 where not exists (select 1 from public.group_members m where m.group_id = gid and m.user_id = u));
  if cardinality(fresh) = 0 then return; end if;
  if (select count(*) from public.group_members m where m.group_id = gid) + cardinality(fresh) > 20 then
    perform public.limit_exceeded('group_full');
  end if;
  insert into public.group_members (group_id, user_id, added_by) select gid, u, me from unnest(fresh) u;
  perform public.group_system(gid, 'add', fresh);
end $$;

create function public.remove_group_member(gid uuid, member uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.chat_groups g where g.id = gid and g.owner = auth.uid()) then
    raise exception 'NOT_OWNER' using errcode = '42501';
  end if;
  if member = auth.uid() then
    raise exception 'USE_LEAVE' using errcode = 'P0001';
  end if;
  delete from public.group_members where group_id = gid and user_id = member;
  if found then perform public.group_system(gid, 'remove', array[member]); end if;
end $$;

create function public.leave_group(gid uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if public.group_joined_at(gid) is null then return; end if;
  perform public.group_system(gid, 'leave');
  delete from public.group_members where group_id = gid and user_id = auth.uid();
end $$;

create function public.rename_group(gid uuid, new_name text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.chat_groups g where g.id = gid and g.owner = auth.uid()) then
    raise exception 'NOT_OWNER' using errcode = '42501';
  end if;
  update public.chat_groups set name = btrim(new_name) where id = gid and name <> btrim(new_name);
  if found then perform public.group_system(gid, 'rename', '{}', btrim(new_name)); end if;
end $$;

-- 读到最新
create function public.mark_group_read(gid uuid) returns void
language sql security definer set search_path = '' as $$
  update public.group_members set read_at = now() where group_id = gid and user_id = auth.uid();
$$;

-- 每个群里别人发的、我还没读的消息数（系统消息不算）
create function public.group_unread() returns table (group_id uuid, n int)
language sql stable security definer set search_path = '' as $$
  select m.group_id, count(g.id)::int
  from public.group_members m
  join public.group_messages g on g.group_id = m.group_id and g.created_at > m.read_at
   and g.sender <> m.user_id and g.kind <> 'system'
  where m.user_id = auth.uid()
  group by m.group_id;
$$;

do $$
declare
  f text;
begin
  foreach f in array array['create_group(text, uuid[])', 'add_group_members(uuid, uuid[])', 'remove_group_member(uuid, uuid)',
                           'leave_group(uuid)', 'rename_group(uuid, text)', 'mark_group_read(uuid)', 'group_unread()'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- ---------- 照片：群成员可以查看转发到群里的那几张 ----------
create function public.group_shared_photo(owner text, file text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.group_messages g
    join public.group_members m on m.group_id = g.group_id and m.user_id = auth.uid()
    where g.kind = 'checkin' and g.sender::text = owner and g.created_at >= m.joined_at
      and g.checkin->'photos' ? regexp_replace(file, '(_t)?\.jpg$', ''));
$$;
revoke execute on function public.group_shared_photo(text, text) from public, anon;
grant execute on function public.group_shared_photo(text, text) to authenticated;

create policy "群成员可以查看群里转发的照片" on storage.objects
  for select to authenticated
  using (bucket_id = 'photos' and public.group_shared_photo((storage.foldername(name))[1], storage.filename(name)));

-- ---------- 实时推送 ----------
-- 退群、被移出不靠 DELETE 事件（实时推送的删除事件不经过行级权限），而是看系统消息
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.group_messages, public.group_members;
  end if;
end $$;
