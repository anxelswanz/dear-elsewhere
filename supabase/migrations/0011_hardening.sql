-- 第 13 步：上线前的安全加固
-- 在 Supabase 控制台 → SQL Editor 中整段执行一次即可（需先执行 0001–0010）。
--
--   1. 实时推送的删除事件不经过行级权限，会把被删行的主键推给所有订阅者。
--      好友关系、群成员原来用（两个用户 id）做主键，等于把「谁和谁解除了好友 / 谁退了哪个群」广播出去。
--      改成随机 id 做主键，原来的组合改为唯一约束；删除事件里就只剩一个无意义的随机 id。
--   2. 打卡记录的字段补上格式校验：好友的客户端会把这些字段渲染到页面上，数据库这一层也要兜底。
--      用 not valid：只约束今后的写入，不检查已有数据，执行时不会因为历史数据失败。
--   3. 注册前的邀请码查询（check_invite）对未登录用户开放，原来可以无限次尝试；
--      改为每个 IP 每小时最多 20 次（IP 只存哈希，1 小时后删除）。
--   4. 好友关系只允许改 status 一列。

-- ---------- 1. 随机主键 ----------
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'friendships' and column_name = 'id') then
    alter table public.friendships add column id uuid not null default gen_random_uuid();
    alter table public.friendships drop constraint friendships_pkey;
    alter table public.friendships add primary key (id);
    alter table public.friendships add constraint friendships_requester_addressee unique (requester, addressee);
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'group_members' and column_name = 'id') then
    alter table public.group_members add column id uuid not null default gen_random_uuid();
    alter table public.group_members drop constraint group_members_pkey;
    alter table public.group_members add primary key (id);
    alter table public.group_members add constraint group_members_group_user unique (group_id, user_id);
  end if;
end $$;

-- ---------- 2. 打卡字段校验 ----------
-- 照片列表里只能是 { id: 安全的文件名 } 这样的对象
create function public.checkin_photos_ok(p jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(bool_and(jsonb_typeof(e) = 'object' and coalesce(e->>'id', '') ~ '^[a-z0-9]{6,40}$'), true)
  from jsonb_array_elements(p) e;
$$;

alter table public.checkins
  add constraint checkins_marker_ok check (marker in ('sign', 'flag', 'neon', 'stamp', 'pin')) not valid,
  add constraint checkins_icon_ok check (icon ~ '^[a-z]{1,20}$') not valid,
  add constraint checkins_place_ok check (
    ref ~ '^[A-Za-z0-9_-]{0,32}$' and country ~ '^([A-Z]{3})?$'
    and region ~ '^[A-Za-z0-9_-]{0,32}$' and city ~ '^[A-Za-z0-9_-]{0,32}$') not valid,
  add constraint checkins_photos_ok check (pg_column_size(photos) <= 4096 and public.checkin_photos_ok(photos)) not valid,
  add constraint checkins_deleted_photos_ok check (cardinality(deleted_photos) <= 1000) not valid;

-- ---------- 3. 邀请码查询限频 ----------
create table public.invite_checks (
  ip_hash text not null,
  at      timestamptz not null default now()
);
create index invite_checks_ip on public.invite_checks (ip_hash, at);
alter table public.invite_checks enable row level security; -- 不建 policy：只有下面的函数能读写
revoke all on public.invite_checks from anon, authenticated;

create or replace function public.check_invite(code text) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  headers json := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json;
  ip text := coalesce(headers->>'cf-connecting-ip', btrim(split_part(headers->>'x-forwarded-for', ',', 1)), 'unknown');
  h text := md5('invite:' || ip);
begin
  delete from public.invite_checks where at < now() - interval '1 hour';
  if (select count(*) from public.invite_checks c where c.ip_hash = h) >= 20 then
    perform public.limit_exceeded('too_fast');
  end if;
  insert into public.invite_checks (ip_hash) values (h);
  return exists (
    select 1 from public.invite_codes i
    where i.code = upper(btrim(check_invite.code)) and i.active
  );
end $$;
revoke all on function public.check_invite(text) from public;
grant execute on function public.check_invite(text) to anon, authenticated;

-- ---------- 4. 好友关系只能改 status ----------
revoke insert, update on public.friendships from authenticated;
grant insert (requester, addressee) on public.friendships to authenticated;
grant update (status) on public.friendships to authenticated;
