-- 第 22 步：旅伴扩充到 410 位，新增「史诗」等级
-- 在 Supabase 控制台 → SQL Editor 中整段执行一次即可（需先执行 0013）。
--
--   普通 a01–a200（原 130）  高级 p01–p100（原 50）  稀有 r01–r50（原 40）
--   史诗 e01–e40（新增，像素旅人）  传说 l01–l20（原 16）
--   等级编号：0 普通 1 高级 2 稀有 3 史诗 4 传说（传说从 3 改为 4）
--   抽取概率：普通 60%、高级 23%、稀有 10%、史诗 5%、传说 2%（原来 70 / 20 / 8 / — / 2）
-- 头像文件由 scripts/build-avatars.mjs 生成；已有的头像不变。

-- ---------- 等级：传说挪到 4，给史诗腾出 3 ----------
alter table public.avatar_catalog drop constraint if exists avatar_catalog_tier_check;
update public.avatar_catalog set tier = 4 where tier = 3 and id like 'l%';
alter table public.avatar_catalog add constraint avatar_catalog_tier_check check (tier between 0 and 4);
comment on column public.avatar_catalog.tier is '0 普通 1 高级 2 稀有 3 史诗 4 传说';

-- ---------- 新头像 ----------
insert into public.avatar_catalog (id, tier)
  select 'a' || lpad(n::text, greatest(2, length(n::text)), '0'), 0 from generate_series(131, 200) n
  union all select 'p' || lpad(n::text, greatest(2, length(n::text)), '0'), 1 from generate_series(51, 100) n
  union all select 'r' || lpad(n::text, greatest(2, length(n::text)), '0'), 2 from generate_series(41, 50) n
  union all select 'e' || lpad(n::text, 2, '0'), 3 from generate_series(1, 40) n
  union all select 'l' || lpad(n::text, 2, '0'), 4 from generate_series(17, 20) n
on conflict (id) do nothing;

-- ---------- 抽一次：新的概率 ----------
create or replace function public.draw_avatar() returns jsonb
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
  want := case when r < .60 then 0 when r < .83 then 1 when r < .93 then 2 when r < .98 then 3 else 4 end;
  select c.id, c.tier into got from public.avatar_catalog c
    where c.tier = want and c.id <> current_avatar order by random() limit 1;
  insert into public.avatar_draws (user_id, avatar) values (uid, got.id) returning id into draw_id;
  return jsonb_build_object('id', draw_id, 'avatar', got.id, 'tier', got.tier, 'left', 3 - public.avatar_draws_today(uid));
end $$;
revoke execute on function public.draw_avatar() from public, anon;
grant execute on function public.draw_avatar() to authenticated;
