-- 第 3 步：账号资料
-- 在 Supabase 控制台 → SQL Editor 中整段执行一次即可。
--
-- profiles         公开资料（ID、名字、国家、头像），登录用户都能查看，用于按 ID 加好友
-- profile_private  只有本人可见的资料（生日）

-- ---------- 公开资料 ----------
create table public.profiles (
  id                uuid primary key references auth.users on delete cascade,
  handle            text not null unique check (handle ~ '^[a-z0-9_]{3,20}$'),
  name              text not null check (char_length(btrim(name)) between 1 and 30),
  country           text not null check (country ~ '^[A-Z]{3}$'),
  avatar            text not null check (avatar ~ '^a(0[1-9]|[1-5][0-9]|60)$'),
  map_public        boolean not null default false,
  handle_changed_at timestamptz,           -- 上次修改 ID 的时间；注册时为空，第一次修改不受限制
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "登录用户可以查看资料" on public.profiles
  for select to authenticated using (true);
create policy "只能创建自己的资料" on public.profiles
  for insert to authenticated with check (id = (select auth.uid()));
create policy "只能修改自己的资料" on public.profiles
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

revoke all on public.profiles from anon;

-- 时间字段由数据库维护；ID 每 30 天只能改一次
create function public.profiles_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.handle_changed_at := null;
  else
    new.created_at := old.created_at;
    if new.handle is distinct from old.handle then
      if old.handle_changed_at > now() - interval '30 days' then
        raise exception 'HANDLE_COOLDOWN' using errcode = 'P0001',
          detail = to_char(old.handle_changed_at + interval '30 days', 'YYYY-MM-DD');
      end if;
      new.handle_changed_at := now();
    else
      new.handle_changed_at := old.handle_changed_at;
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger profiles_guard before insert or update on public.profiles
  for each row execute function public.profiles_guard();

-- ---------- 仅本人可见 ----------
create table public.profile_private (
  id       uuid primary key references auth.users on delete cascade,
  birthday date check (birthday >= date '1900-01-01')
);

alter table public.profile_private enable row level security;

create policy "只能查看自己的私密资料" on public.profile_private
  for select to authenticated using (id = (select auth.uid()));
create policy "只能创建自己的私密资料" on public.profile_private
  for insert to authenticated with check (id = (select auth.uid()));
create policy "只能修改自己的私密资料" on public.profile_private
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

revoke all on public.profile_private from anon;
