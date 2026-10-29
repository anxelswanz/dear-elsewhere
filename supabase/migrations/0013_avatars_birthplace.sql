-- 第 15 步：ID 每周只能改一次；头像改为抽取（四个稀有度）；出生地
-- 在 Supabase 控制台 → SQL Editor 中整段执行一次即可（需先执行 0001–0012）。
--
--   ID      7 天内只能改一次（原来是 30 天）
--   头像    不能再自己挑，只能抽。注册时只能用「普通」头像（前端无限次随机）；
--           之后每天（按账号时区）最多抽 3 次，抽到后由用户决定换不换。
--           稀有度与概率：普通 70%、高级 20%、稀有 8%、传说 2%（头像文件见 scripts/build-avatars.mjs）
--           头像只能通过 accept_avatar() 换成自己抽到的那一个，直接改 profiles.avatar 会被拒绝
--   出生地  城市 ID（与地图数据 index.json 一致），存在 profile_private，只有本人可见

-- ---------- 头像目录 ----------
create table public.avatar_catalog (
  id   text primary key,
  tier smallint not null check (tier between 0 and 3) -- 0 普通 1 高级 2 稀有 3 传说
);
insert into public.avatar_catalog (id, tier)
  select 'a' || lpad(n::text, greatest(2, length(n::text)), '0'), 0 from generate_series(1, 130) n
  union all select 'p' || lpad(n::text, greatest(2, length(n::text)), '0'), 1 from generate_series(1, 50) n
  union all select 'r' || lpad(n::text, greatest(2, length(n::text)), '0'), 2 from generate_series(1, 40) n
  union all select 'l' || lpad(n::text, greatest(2, length(n::text)), '0'), 3 from generate_series(1, 16) n;

alter table public.avatar_catalog enable row level security;
create policy "登录用户可以查看头像目录" on public.avatar_catalog for select to authenticated using (true);
revoke all on public.avatar_catalog from anon;
revoke insert, update, delete on public.avatar_catalog from authenticated;

-- 原来的格式检查只认 a01–a60，换成引用头像目录
alter table public.profiles drop constraint profiles_avatar_check;
alter table public.profiles add constraint profiles_avatar_fkey foreign key (avatar) references public.avatar_catalog (id);

-- ---------- 抽头像记录 ----------
create table public.avatar_draws (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users on delete cascade,
  avatar      text not null references public.avatar_catalog (id),
  created_at  timestamptz not null default now(),
  accepted_at timestamptz,  -- 换上了
  declined_at timestamptz   -- 选择保留原来的
);
create index avatar_draws_user_created on public.avatar_draws (user_id, created_at);

alter table public.avatar_draws enable row level security;
create policy "只能查看自己抽到的头像" on public.avatar_draws
  for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.avatar_draws from anon;
revoke insert, update, delete on public.avatar_draws from authenticated; -- 只能通过下面的函数

-- ---------- 资料守卫：ID 每 7 天一次；头像只能用抽到的 ----------
create or replace function public.profiles_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.handle_changed_at := null;
    -- 注册时只能用普通头像
    if not exists (select 1 from public.avatar_catalog c where c.id = new.avatar and c.tier = 0) then
      raise exception 'AVATAR_NOT_ALLOWED' using errcode = 'P0001';
    end if;
  else
    new.created_at := old.created_at;
    if new.handle is distinct from old.handle then
      if old.handle_changed_at > now() - interval '7 days' then
        raise exception 'HANDLE_COOLDOWN' using errcode = 'P0001',
          detail = to_char(old.handle_changed_at + interval '7 days', 'YYYY-MM-DD');
      end if;
      new.handle_changed_at := now();
    else
      new.handle_changed_at := old.handle_changed_at;
    end if;
    -- 换头像只能经由 accept_avatar()，它会在本事务里标记允许换成哪一个
    if new.avatar is distinct from old.avatar
       and coalesce(current_setting('app.accept_avatar', true), '') is distinct from new.avatar then
      raise exception 'AVATAR_NOT_ALLOWED' using errcode = 'P0001';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
revoke execute on function public.profiles_guard() from public, anon, authenticated;

-- ---------- 抽头像 ----------
-- 今天已经抽了几次（按账号时区的自然日）
create function public.avatar_draws_today(uid uuid) returns int
language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.avatar_draws d
  where d.user_id = uid and d.created_at >= public.user_day_start(uid);
$$;
revoke execute on function public.avatar_draws_today(uuid) from public, anon, authenticated;

-- 抽一次：先按概率定稀有度，再在这一级里随机挑一个（不会抽到正在用的）
create function public.draw_avatar() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  current_avatar text;
  r float8 := random();
  want smallint;
  got record;
  draw_id bigint;
begin
  select p.avatar into current_avatar from public.profiles p where p.id = uid;
  if current_avatar is null then raise exception 'NO_PROFILE' using errcode = 'P0001'; end if;
  -- 同一个人并发抽也不会超额
  perform pg_advisory_xact_lock(hashtext('draw_avatar:' || uid::text));
  if public.avatar_draws_today(uid) >= 3 then perform public.limit_exceeded('avatar_draws'); end if;
  want := case when r < .70 then 0 when r < .90 then 1 when r < .98 then 2 else 3 end;
  select c.id, c.tier into got from public.avatar_catalog c
    where c.tier = want and c.id <> current_avatar order by random() limit 1;
  insert into public.avatar_draws (user_id, avatar) values (uid, got.id) returning id into draw_id;
  return jsonb_build_object('id', draw_id, 'avatar', got.id, 'tier', got.tier, 'left', 3 - public.avatar_draws_today(uid));
end $$;
revoke execute on function public.draw_avatar() from public, anon;
grant execute on function public.draw_avatar() to authenticated;

-- 换上刚抽到的头像：只认自己最近的一次抽取，且还没换过
create function public.accept_avatar(draw bigint) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  d record;
begin
  select * into d from public.avatar_draws a where a.user_id = uid order by a.created_at desc, a.id desc limit 1 for update;
  if d.id is distinct from draw or d.accepted_at is not null or d.declined_at is not null then
    raise exception 'DRAW_EXPIRED' using errcode = 'P0001';
  end if;
  perform set_config('app.accept_avatar', d.avatar, true);
  update public.profiles set avatar = d.avatar where id = uid;
  perform set_config('app.accept_avatar', '', true);
  update public.avatar_draws set accepted_at = now() where id = d.id;
  return d.avatar;
end $$;
revoke execute on function public.accept_avatar(bigint) from public, anon;
grant execute on function public.accept_avatar(bigint) to authenticated;

-- 不换：保留原来的头像，这次抽到的作废
create function public.decline_avatar(draw bigint) returns void
language sql volatile security definer set search_path = '' as $$
  update public.avatar_draws set declined_at = now()
  where id = draw and user_id = auth.uid() and accepted_at is null and declined_at is null;
$$;
revoke execute on function public.decline_avatar(bigint) from public, anon;
grant execute on function public.decline_avatar(bigint) to authenticated;

-- 今天还能抽几次，以及还没决定换不换的那一次（没有则为 null）
create function public.avatar_draw_state() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'left', greatest(0, 3 - public.avatar_draws_today(auth.uid())),
    'pending', (
      select jsonb_build_object('id', d.id, 'avatar', d.avatar, 'tier', c.tier)
      from public.avatar_draws d join public.avatar_catalog c on c.id = d.avatar
      where d.id = (select a.id from public.avatar_draws a where a.user_id = auth.uid()
                    order by a.created_at desc, a.id desc limit 1)
        and d.accepted_at is null and d.declined_at is null
        and d.created_at >= public.user_day_start(auth.uid())
        and d.avatar <> (select p.avatar from public.profiles p where p.id = auth.uid())));
$$;
revoke execute on function public.avatar_draw_state() from public, anon;
grant execute on function public.avatar_draw_state() to authenticated;

-- ---------- 出生地（仅本人可见） ----------
alter table public.profile_private
  add column birthplace text check (birthplace ~ '^[A-Za-z0-9_-]{1,40}$');
