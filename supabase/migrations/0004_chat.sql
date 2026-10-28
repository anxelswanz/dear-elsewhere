-- 第 6 步：好友私聊
-- 在 Supabase 控制台 → SQL Editor 中整段执行一次即可（需先执行 0001–0003）。
--
-- 每条消息只有收发双方能看到；只能发给当前的好友（删除好友后还能看历史，但不能再发）。
-- 消息有两种：
--   text     文字和 emoji
--   checkin  转发自己的一次打卡：发送时把标题、地址、照片 id 等存成快照，
--            照片本身仍在发送者的私有目录里，好友靠 0003 里「好友可以查看照片」的策略读取

create table public.messages (
  id         uuid primary key default gen_random_uuid(),
  sender     uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  recipient  uuid not null references public.profiles (id) on delete cascade,
  kind       text not null default 'text' check (kind in ('text', 'checkin')),
  body       text not null default '' check (char_length(body) <= 1000),
  checkin    jsonb,
  created_at timestamptz not null default now(),
  read_at    timestamptz,
  check (sender <> recipient),
  check (kind <> 'text' or char_length(btrim(body)) >= 1),
  check (kind <> 'checkin' or (
    jsonb_typeof(checkin) = 'object'
    and checkin->>'id' ~ '^[a-z0-9]{6,40}$'
    and jsonb_typeof(checkin->'photos') = 'array'
    and jsonb_array_length(checkin->'photos') between 1 and 9
    and pg_column_size(checkin) <= 8192)),
  check (kind = 'checkin' or checkin is null)
);
-- 一段对话按时间读取；未读按收件人查
create index messages_pair on public.messages (least(sender, recipient), greatest(sender, recipient), created_at desc);
create index messages_unread on public.messages (recipient, sender) where read_at is null;

alter table public.messages enable row level security;

create policy "只能看自己收发的消息" on public.messages
  for select to authenticated using ((select auth.uid()) in (sender, recipient));
create policy "只能以自己的名义发给好友" on public.messages
  for insert to authenticated with check (sender = (select auth.uid()) and public.is_friend(recipient::text));
create policy "收件人可以标记已读" on public.messages
  for update to authenticated using (recipient = (select auth.uid())) with check (recipient = (select auth.uid()));

-- 发送者、时间由数据库填写；客户端只能写这几列，已读只能改 read_at
revoke all on public.messages from anon, authenticated;
grant select on public.messages to authenticated;
grant insert (recipient, kind, body, checkin) on public.messages to authenticated;
grant update (read_at) on public.messages to authenticated;

-- 快照里的照片 id 只能是安全的文件名，避免拼出别的存储路径
create function public.messages_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.read_at := null;
    if new.kind = 'checkin' and exists (
      select 1 from jsonb_array_elements(new.checkin->'photos') p
      where jsonb_typeof(p) <> 'string' or p #>> '{}' !~ '^[a-z0-9]{6,40}$') then
      raise exception 'BAD_PHOTO_ID' using errcode = 'P0001';
    end if;
  elsif new.read_at is not null and old.read_at is not null then
    new.read_at := old.read_at; -- 已读时间只记第一次
  end if;
  return new;
end $$;

create trigger messages_guard before insert or update on public.messages
  for each row execute function public.messages_guard();

-- 把某位好友发给我的消息全部标为已读
create function public.mark_read(peer uuid) returns void
language sql security invoker set search_path = '' as $$
  update public.messages set read_at = now()
  where recipient = auth.uid() and sender = peer and read_at is null;
$$;
revoke execute on function public.mark_read(uuid) from public, anon;
grant execute on function public.mark_read(uuid) to authenticated;

-- ---------- 实时推送 ----------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;
