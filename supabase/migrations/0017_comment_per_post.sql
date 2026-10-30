-- 第 18 步：评论防刷屏，同一张明信片每人滚动 24 小时最多 20 条
-- 在 Supabase 控制台 → SQL Editor 中整段执行一次即可（需先执行 0001–0016）。
--
-- 原有的每人每分钟 10 条、每天 300 条保留；新增的单卡额度同样记在 action_log 里，删了再发也计数。
-- 执行前已有的日志没有记明信片，上线后的头 24 小时里，之前发过的评论不计入单卡额度。

alter table public.action_log add column target text;

-- 多一个可选参数 target：这次操作落在哪个对象上（评论：'{打卡主人}/{打卡 id}'）
-- 只加带默认值的参数会和旧签名重载冲突，所以先删再建；原来 6 个参数的调用照常可用
drop function public.log_action(uuid, text, int, text, int, text);
create function public.log_action(uid uuid, what text, per_minute int, minute_code text, per_day int, day_code text, target text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtext('action_log:' || uid::text || ':' || what));
  if per_minute is not null and (select count(*) from public.action_log a
      where a.user_id = uid and a.kind = what and a.at >= now() - interval '1 minute') >= per_minute then
    perform public.limit_exceeded(minute_code);
  end if;
  if per_day is not null and (select count(*) from public.action_log a
      where a.user_id = uid and a.kind = what and a.at >= now() - interval '1 day') >= per_day then
    perform public.limit_exceeded(day_code);
  end if;
  -- 顺手清掉这个人两天前的旧日志，表不会无限变大
  delete from public.action_log a where a.user_id = uid and a.kind = what and a.at < now() - interval '2 days';
  insert into public.action_log (user_id, kind, target) values (uid, what, log_action.target);
end $$;
revoke execute on function public.log_action(uuid, text, int, text, int, text, text) from public, anon, authenticated;

create or replace function public.comments_limits() returns trigger
language plpgsql security definer set search_path = '' as $$
declare post text := new.checkin_owner::text || '/' || new.checkin_id;
begin
  -- 和 log_action 同一把锁（可重入），并发时也不会多插
  perform pg_advisory_xact_lock(hashtext('action_log:' || new.author::text || ':comment'));
  if (select count(*) from public.action_log a
      where a.user_id = new.author and a.kind = 'comment' and a.target = post
        and a.at >= now() - interval '1 day') >= 20 then
    perform public.limit_exceeded('comments_per_post');
  end if;
  perform public.log_action(new.author, 'comment', 10, 'too_fast', 300, 'comments_per_day', post);
  return new;
end $$;
revoke execute on function public.comments_limits() from public, anon, authenticated;
