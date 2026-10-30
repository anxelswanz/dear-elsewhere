-- 第 22 步：照片额度调整
-- 在 Supabase 控制台 → SQL Editor 中整段执行一次即可（需先执行 0001–0019）。
--
--   1. 每人每年最多上传 365 张照片：按账号时区的自然年计算，1 月 1 日重新开始。
--      计数用上传凭证（photo_tickets，只增不删）：和每天 50 张一样，删了重传也算。
--      今年已经领过的凭证直接计入，执行后无缝衔接。
--   2. 每个地点的照片从最多 5 张改为最多 3 张。已有 4、5 张的地点不受影响，只是不能再加。

-- ---------- 1. 每年 365 张 ----------

-- 账号时区下今年的开始时间
create function public.user_year_start(uid uuid) returns timestamptz
language sql stable security definer set search_path = '' as $$
  select date_trunc('year', now(), coalesce(
    (select p.timezone from public.profile_private p where p.id = uid), 'UTC'));
$$;
revoke execute on function public.user_year_start(uuid) from public, anon, authenticated;

create or replace function public.claim_photo(photo text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if photo !~ '^[a-z0-9]{6,40}$' then
    raise exception 'BAD_PHOTO_ID' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.photo_tickets t where t.user_id = auth.uid() and t.photo_id = photo) then
    return;
  end if;
  -- 同一用户的并发领取排队执行，避免同时领取时多算出额度
  perform pg_advisory_xact_lock(hashtext('photo_tickets:' || auth.uid()::text));
  if public.photo_files(auth.uid()) >= 2000 then
    perform public.limit_exceeded('photos_total');
  end if;
  if (select count(*) from public.photo_tickets t
      where t.user_id = auth.uid() and t.created_at >= public.user_year_start(auth.uid())) >= 365 then
    perform public.limit_exceeded('photos_per_year');
  end if;
  if (select count(*) from public.photo_tickets t
      where t.user_id = auth.uid() and t.created_at >= now() - interval '1 day') >= 50 then
    perform public.limit_exceeded('photos_per_day');
  end if;
  insert into public.photo_tickets (user_id, photo_id) values (auth.uid(), photo)
    on conflict do nothing;
end $$;

-- 剩余额度再多返回 year_used / year_limit：今年已经上传几张、每年上限
create or replace function public.photo_quota() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'left', greatest(0, 50 - count(*) filter (where t.created_at >= now() - interval '1 day')),
    'next_at', min(t.created_at) filter (where t.created_at >= now() - interval '1 day') + interval '1 day',
    'total_left', greatest(0, 1000 - (
      select count(*) from storage.objects o
      where o.bucket_id = 'photos' and o.name like auth.uid()::text || '/%' and o.name not like '%\_t.jpg')),
    'year_used', count(*) filter (where t.created_at >= public.user_year_start(auth.uid())),
    'year_limit', 365)
  from public.photo_tickets t
  where t.user_id = auth.uid()
    and t.created_at >= least(public.user_year_start(auth.uid()), now() - interval '1 day');
$$;

-- ---------- 2. 每个地点最多 3 张 ----------
create or replace function public.checkins_limits() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  n int := jsonb_array_length(new.photos);
begin
  -- 只拦「变多」：改成 3 张之前已有 4、5 张的记录仍可正常修改、删照片
  if n > 3 and (tg_op = 'INSERT' or n > jsonb_array_length(old.photos)) then
    perform public.limit_exceeded('photos_per_place');
  end if;

  -- 客户端的时钟可以有一点偏差，但不能写未来的时间
  -- （不用 least()：它会忽略 null，least(null, now()) 会把没发布的记录变成已发布）
  if new.updated_at > now() + interval '1 minute' then new.updated_at := now() + interval '1 minute'; end if;
  if new.published_at > now() then new.published_at := now(); end if;

  if tg_op = 'UPDATE' then
    -- 打卡时间以服务器为准；层级、坐标建好后不能改；删除后不能复活；发布时间只记第一次
    new.created_at := old.created_at;
    new.level := old.level;
    if old.lat is not null or old.lng is not null then
      new.lat := old.lat;
      new.lng := old.lng;
    end if;
    new.deleted := old.deleted or new.deleted;
    if old.published_at is not null then new.published_at := old.published_at; end if;
    return new;
  end if;
  new.created_at := now();

  if (select count(*) from public.checkins c
      where c.user_id = new.user_id and c.created_at >= now() - interval '1 day') >= 300 then
    perform public.limit_exceeded('records_per_day');
  end if;

  if new.level = 'place' and (select count(*) from public.checkins c
      where c.user_id = new.user_id and c.level = 'place'
        and c.created_at >= public.user_day_start(new.user_id)) >= 10 then
    perform public.limit_exceeded('places_per_day');
  end if;
  return new;
end $$;
revoke execute on function public.checkins_limits() from public, anon, authenticated;
