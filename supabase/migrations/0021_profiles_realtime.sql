-- 第 21 步：资料实时推送
-- 在 Supabase 控制台 → SQL Editor 中整段执行一次即可。
--
-- 好友换头像、改名字后，对方页面立刻更新，不必刷新页面。
-- profiles 本来就对所有登录用户可读（见 0001），推送的内容不超出原有可见范围；
-- 前端只订阅好友（最多 100 人）的变化。

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'profiles') then
    alter publication supabase_realtime add table public.profiles;
  end if;
end $$;
