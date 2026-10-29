-- 第 10 步：设置（主题色、语言跟着账号走），好友固定可以看到全部足迹
-- 在 Supabase 控制台 → SQL Editor 中整段执行一次即可（需先执行 0001–0007）。

-- ---------- 设置：只有本人可见，放在 profile_private ----------
alter table public.profile_private
  add column theme text check (theme in ('airmail', 'coast', 'forest', 'darkroom', 'night')),
  add column lang  text check (lang in ('zh', 'en'));

-- ---------- 去掉「足迹地图对好友公开」：好友能看到全部未删除的打卡 ----------
drop policy "好友可以查看动态与公开的足迹" on public.checkins;
create policy "好友可以查看全部足迹" on public.checkins
  for select to authenticated using (not deleted and public.is_friend(user_id::text));

alter table public.profiles drop column map_public;
