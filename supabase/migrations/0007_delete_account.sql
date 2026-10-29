-- 第 9 步：注销账号（GDPR 第 17 条「被遗忘权」）
-- 在 Supabase 控制台 → SQL Editor 中整段执行一次即可（需先执行 0001–0006）。
--
-- 删除 auth.users 中的这一行后，外键 on delete cascade 会带走：
--   profiles、profile_private、checkins（连同别人在上面的评论）、friendships、
--   自己发出和收到的 messages、自己写的 comments
-- Storage 里的照片不能用 SQL 删除（Supabase 禁止直接删 storage.objects），
-- 由前端在调用本函数之前通过 Storage API 删除 photos/{用户 id}/ 下的全部文件。

create function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  delete from auth.users where id = me;
end;
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
