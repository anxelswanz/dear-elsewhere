-- 第 11 步：用量限制，防止刷数据和恶意攻击
-- 在 Supabase 控制台 → SQL Editor 中整段执行一次即可（需先执行 0001–0008）。
--
-- 前端（src/limits.js）会先拦一道并给出友好提示；这里是真正的防线，绕过前端也过不去。
-- 超限统一抛出 'LIMIT:<代码>'（errcode P0001），前端按代码翻译成提示文字。
--
--   打卡    必须联网：新记录的打卡时间由服务器写入，客户端填的不算数，也就没法伪造日期。
--           每天最多 10 个景点，「每天」按账号时区的自然日；每天最多新建 300 条记录（兜底）
--   时区    浏览器自动上报，存在 profile_private；24 小时内最多改一次，防止改时区多拿一天
--   照片    每个景点最多 5 张；任意 24 小时内最多上传 50 张。上传前必须先领一张「上传凭证」，
--           Storage 只接受有凭证的文件名；凭证不随照片删除，删了重传也算额度
--   评论    每分钟 10 条，每天 300 条
--   私信    每分钟 30 条，每天 2000 条
--   好友申请 每天 30 次，同时待处理的申请最多 50 个

-- ---------- 通用：超限报错 ----------
create function public.limit_exceeded(code text) returns void
language plpgsql set search_path = '' as $$
begin
  raise exception 'LIMIT:%', code using errcode = 'P0001';
end $$;
-- 只会抛错，没有副作用，保留默认的执行权限（触发器以当前用户身份调用它）

-- 计数用的触发器和函数都是 security definer：只数自己的行，不受 RLS 可见范围影响
-- （例如被删好友后看不到的评论也要算进去）

-- ---------- 时区 ----------
alter table public.profile_private
  add column timezone text,
  add column timezone_changed_at timestamptz;

-- 时区只能是合法的 IANA 名称；24 小时内第二次修改直接忽略，继续用旧时区
create function public.profile_private_timezone() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.timezone is not null and (tg_op = 'INSERT' or new.timezone is distinct from old.timezone)
     and not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = new.timezone) then
    new.timezone := case when tg_op = 'UPDATE' then old.timezone end;
  end if;
  if tg_op = 'INSERT' then
    new.timezone_changed_at := case when new.timezone is not null then now() end;
    return new;
  end if;
  new.timezone_changed_at := old.timezone_changed_at;
  if new.timezone is distinct from old.timezone then
    if old.timezone is not null and old.timezone_changed_at > now() - interval '1 day' then
      new.timezone := old.timezone;
    else
      new.timezone_changed_at := now();
    end if;
  end if;
  return new;
end $$;
create trigger profile_private_timezone before insert or update on public.profile_private
  for each row execute function public.profile_private_timezone();

-- 某个用户「今天」从什么时候开始（没上报过时区按 UTC）
create function public.user_day_start(uid uuid) returns timestamptz
language sql stable security definer set search_path = '' as $$
  select date_trunc('day', now(), coalesce(
    (select p.timezone from public.profile_private p where p.id = uid), 'UTC'));
$$;
revoke execute on function public.user_day_start(uuid) from public, anon, authenticated;

-- ---------- 打卡 ----------
create index checkins_user_created on public.checkins (user_id, created_at);

create function public.checkins_limits() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  n int := jsonb_array_length(new.photos);
begin
  -- 只拦「变多」：限制上线前已有超过 5 张的记录仍可正常修改、删照片
  if n > 5 and (tg_op = 'INSERT' or n > jsonb_array_length(old.photos)) then
    perform public.limit_exceeded('photos_per_place');
  end if;

  -- 打卡时间以服务器为准：新建时写入当前时间，之后不能再改
  if tg_op = 'UPDATE' then
    new.created_at := old.created_at;
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

create trigger checkins_limits before insert or update on public.checkins
  for each row execute function public.checkins_limits();

-- ---------- 照片上传凭证 ----------
create table public.photo_tickets (
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  photo_id   text not null check (photo_id ~ '^[a-z0-9]{6,40}$'),
  created_at timestamptz not null default now(),
  primary key (user_id, photo_id)
);
create index photo_tickets_recent on public.photo_tickets (user_id, created_at);
alter table public.photo_tickets enable row level security;
revoke all on public.photo_tickets from anon, authenticated; -- 只能通过下面的函数读写

-- 上传一张照片前调用；同一张照片重复领取（重试、原图 + 缩略图）不重复计数
create function public.claim_photo(photo text) returns void
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
  if (select count(*) from public.photo_tickets t
      where t.user_id = auth.uid() and t.created_at >= now() - interval '1 day') >= 50 then
    perform public.limit_exceeded('photos_per_day');
  end if;
  insert into public.photo_tickets (user_id, photo_id) values (auth.uid(), photo)
    on conflict do nothing;
end $$;
revoke execute on function public.claim_photo(text) from public, anon;
grant execute on function public.claim_photo(text) to authenticated;

-- 剩余额度：left 还能传几张；next_at 下一张额度恢复的时间（最早那张凭证满 24 小时），没有占用时为 null
create function public.photo_quota() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'left', greatest(0, 50 - count(*)),
    'next_at', min(t.created_at) + interval '1 day')
  from public.photo_tickets t
  where t.user_id = auth.uid() and t.created_at >= now() - interval '1 day';
$$;
revoke execute on function public.photo_quota() from public, anon;
grant execute on function public.photo_quota() to authenticated;

-- Storage 路径 {用户 id}/{照片 id}.jpg 或 {照片 id}_t.jpg：文件名必须合规且领过凭证
create function public.has_photo_ticket(path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select storage.filename(path) ~ '^[a-z0-9]{6,40}(_t)?\.jpg$'
    and exists (select 1 from public.photo_tickets t
      where t.user_id = auth.uid()
        and t.photo_id = regexp_replace(storage.filename(path), '(_t)?\.jpg$', ''));
$$;
revoke execute on function public.has_photo_ticket(text) from public, anon;
grant execute on function public.has_photo_ticket(text) to authenticated;

-- 限制上线前已经上传过的照片补发凭证（不占今天的额度）
insert into public.photo_tickets (user_id, photo_id, created_at)
select distinct (storage.foldername(o.name))[1]::uuid, regexp_replace(storage.filename(o.name), '(_t)?\.jpg$', ''), o.created_at
from storage.objects o
where o.bucket_id = 'photos'
  and storage.filename(o.name) ~ '^[a-z0-9]{6,40}(_t)?\.jpg$'
  and (storage.foldername(o.name))[1] ~ '^[0-9a-f-]{36}$'
  and exists (select 1 from auth.users u where u.id::text = (storage.foldername(o.name))[1])
on conflict do nothing;

drop policy "上传到自己的照片目录" on storage.objects;
create policy "上传到自己的照片目录" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text
    and public.has_photo_ticket(name));
drop policy "覆盖自己的照片" on storage.objects;
create policy "覆盖自己的照片" on storage.objects
  for update to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text
    and public.has_photo_ticket(name));

-- 前端压缩后的原图（长边 1600px）通常不到 1MB，单个文件上限从 5MB 收紧到 3MB，只收 JPEG
update storage.buckets set file_size_limit = 3145728, allowed_mime_types = array['image/jpeg']
where id = 'photos';

-- ---------- 评论 ----------
create index comments_author_recent on public.comments (author, created_at desc);

create function public.comments_limits() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.comments c
      where c.author = new.author and c.created_at >= now() - interval '1 minute') >= 10 then
    perform public.limit_exceeded('too_fast');
  end if;
  if (select count(*) from public.comments c
      where c.author = new.author and c.created_at >= now() - interval '1 day') >= 300 then
    perform public.limit_exceeded('comments_per_day');
  end if;
  return new;
end $$;
create trigger comments_limits before insert on public.comments
  for each row execute function public.comments_limits();

-- ---------- 私信 ----------
create index messages_sender_recent on public.messages (sender, created_at desc);

create function public.messages_limits() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.messages m
      where m.sender = new.sender and m.created_at >= now() - interval '1 minute') >= 30 then
    perform public.limit_exceeded('too_fast');
  end if;
  if (select count(*) from public.messages m
      where m.sender = new.sender and m.created_at >= now() - interval '1 day') >= 2000 then
    perform public.limit_exceeded('messages_per_day');
  end if;
  return new;
end $$;
create trigger messages_limits before insert on public.messages
  for each row execute function public.messages_limits();

-- ---------- 好友申请 ----------
create index friendships_requester_recent on public.friendships (requester, created_at desc);

create function public.friendships_limits() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.friendships f
      where f.requester = new.requester and f.created_at >= now() - interval '1 day') >= 30 then
    perform public.limit_exceeded('requests_per_day');
  end if;
  if (select count(*) from public.friendships f
      where f.requester = new.requester and f.status = 'pending') >= 50 then
    perform public.limit_exceeded('requests_pending');
  end if;
  return new;
end $$;
create trigger friendships_limits before insert on public.friendships
  for each row execute function public.friendships_limits();
