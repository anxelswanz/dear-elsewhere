-- 第 17 步：不看某位好友的动态
-- 在 Supabase 控制台 → SQL Editor 中整段执行一次即可（需先执行 0001–0014）。
--
-- 只影响自己的动态流和红点：私信、对方给我的评论、地图上的好友打卡都照常。
-- 只有本人能读写，对方不知道自己被静音。删好友不会自动取消（重新加回来仍保持静音）。

create table public.feed_mutes (
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  muted      uuid not null references auth.users on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, muted),
  check (user_id <> muted)
);

alter table public.feed_mutes enable row level security;
create policy "只能查看自己的静音列表" on public.feed_mutes
  for select to authenticated using (user_id = (select auth.uid()));
create policy "只能静音给自己看" on public.feed_mutes
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "只能取消自己的静音" on public.feed_mutes
  for delete to authenticated using (user_id = (select auth.uid()));

revoke all on public.feed_mutes from anon;
revoke update on public.feed_mutes from authenticated;
