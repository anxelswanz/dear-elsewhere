-- 第 14 步：收回触发器函数的执行权限
-- 在 Supabase 控制台 → SQL Editor 中整段执行一次即可（需先执行 0001–0011）。
--
-- Supabase 默认把新函数的执行权限授给 anon 和 authenticated，触发器函数因此也出现在 /rest/v1/rpc/ 下。
-- 触发器函数本来就不能被直接调用，这里收回权限只是让 Security Advisor 不再报警；
-- 触发器触发时不检查调用者的执行权限，收回后照常工作。
do $$
declare
  f text;
begin
  foreach f in array array[
    'checkins_limits()', 'comments_limits()', 'friendships_limits()', 'messages_limits()',
    'group_members_left()', 'group_messages_touch()', 'group_messages_guard()', 'require_invite()',
    'profiles_guard()', 'friendships_guard()', 'messages_guard()', 'profile_private_timezone()'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;
