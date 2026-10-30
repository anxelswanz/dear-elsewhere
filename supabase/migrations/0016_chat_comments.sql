-- 第 17 步：聊天里转发的明信片可以评论
-- 在 Supabase 控制台 → SQL Editor 中整段执行一次即可（需先执行 0001–0015）。
--
-- 评论和原打卡的评论是同一批（comments 表）：动态、地图上的评论走马灯、聊天里的明信片都能看到。
--   · 谁能评论：和以前一样，只有能看到这条打卡的人（本人和好友）；另外，转发到聊天里的打卡即使没发布到动态也能评论
--   · 谁能看评论：除了能看到打卡的人，转发到的私信双方、群成员（入群之后转发的）也能看；群里不是好友的人只能看不能评
-- 在聊天里评论时，对话里同时出现一条 comment 消息（「A 评论了『京都』：…」），算未读、有提醒，点它打开那张明信片。

-- ---------- 消息多一种：comment ----------
-- reply：{ to: 被评论的转发消息 id, name: 明信片标题, comment: 评论 id }
alter table public.messages add column reply jsonb;
alter table public.group_messages add column reply jsonb;

alter table public.messages drop constraint messages_kind_check;
alter table public.messages add constraint messages_kind_check check (kind in ('text', 'checkin', 'comment'));
alter table public.messages add constraint messages_reply_check check (
  (kind = 'comment') = (reply is not null)
  and (kind <> 'comment' or (
    char_length(btrim(body)) between 1 and 140
    and jsonb_typeof(reply) = 'object' and reply->>'to' ~ '^[0-9a-f-]{36}$' and pg_column_size(reply) <= 1024)));

alter table public.group_messages drop constraint group_messages_kind_check;
alter table public.group_messages add constraint group_messages_kind_check check (kind in ('text', 'checkin', 'system', 'comment'));
alter table public.group_messages add constraint group_messages_reply_check check (
  (kind = 'comment') = (reply is not null)
  and (kind <> 'comment' or (
    char_length(btrim(body)) between 1 and 140
    and jsonb_typeof(reply) = 'object' and reply->>'to' ~ '^[0-9a-f-]{36}$' and pg_column_size(reply) <= 1024)));

drop policy "成员可以以自己的名义发群消息" on public.group_messages;
create policy "成员可以以自己的名义发群消息" on public.group_messages
  for insert to authenticated
  with check (sender = (select auth.uid()) and kind in ('text', 'checkin', 'comment') and public.group_joined_at(group_id) is not null);

-- comment 消息只能由下面的 comment_shared() 写入，客户端不直接写 reply 列
create index messages_checkins on public.messages (sender) where kind = 'checkin';

-- ---------- 评论的读取：转发到的对话里的人也能看 ----------
create policy "转发到聊天里的打卡，对话里的人可以看评论" on public.comments
  for select to authenticated using (
    exists (select 1 from public.messages m
      where m.kind = 'checkin' and m.sender = checkin_owner and m.checkin->>'id' = checkin_id
        and (select auth.uid()) in (m.sender, m.recipient))
    or exists (select 1 from public.group_messages g
      where g.kind = 'checkin' and g.sender = checkin_owner and g.checkin->>'id' = checkin_id
        and g.created_at >= public.group_joined_at(g.group_id)));

-- ---------- 评论的写入：转发到聊天里的打卡，没发布到动态也能评 ----------
drop policy "评论自己能看到的动态" on public.comments;
create policy "评论自己能看到的动态" on public.comments
  for insert to authenticated with check (
    author = (select auth.uid())
    and exists (select 1 from public.checkins c
      where c.user_id = checkin_owner and c.id = checkin_id and not c.deleted
        and (c.published_at is not null
          or exists (select 1 from public.messages m
            where m.kind = 'checkin' and m.sender = checkin_owner and m.checkin->>'id' = checkin_id
              and (select auth.uid()) in (m.sender, m.recipient))
          or exists (select 1 from public.group_messages g
            where g.kind = 'checkin' and g.sender = checkin_owner and g.checkin->>'id' = checkin_id
              and g.created_at >= public.group_joined_at(g.group_id)))));

-- ---------- 在聊天里评论：写评论 + 在同一个对话里发一条 comment 消息 ----------
-- security invoker：两次写入都照常受上面的 RLS 和限频约束（不是好友时评论会被拒绝，整个调用回滚）
create function public.comment_shared(conv text, msg uuid, body text) returns public.comments
language plpgsql security invoker set search_path = '' as $$
declare
  dm  public.messages;
  grp public.group_messages;
  c   public.comments;
  txt text := btrim(body);
begin
  if conv = 'dm' then
    select * into dm from public.messages m where m.id = msg and m.kind = 'checkin';
    if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
    insert into public.comments (checkin_owner, checkin_id, body) values (dm.sender, dm.checkin->>'id', txt) returning * into c;
    insert into public.messages (recipient, kind, body, reply)
    values (case when dm.sender = auth.uid() then dm.recipient else dm.sender end, 'comment', txt,
            jsonb_build_object('to', dm.id, 'name', left(dm.checkin->>'name', 80), 'comment', c.id));
  elsif conv = 'group' then
    select * into grp from public.group_messages g where g.id = msg and g.kind = 'checkin';
    if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
    insert into public.comments (checkin_owner, checkin_id, body) values (grp.sender, grp.checkin->>'id', txt) returning * into c;
    insert into public.group_messages (group_id, kind, body, reply)
    values (grp.group_id, 'comment', txt,
            jsonb_build_object('to', grp.id, 'name', left(grp.checkin->>'name', 80), 'comment', c.id));
  else
    raise exception 'BAD_CONV' using errcode = '22023';
  end if;
  return c;
end $$;
revoke execute on function public.comment_shared(text, uuid, text) from public, anon;
grant execute on function public.comment_shared(text, uuid, text) to authenticated;

-- reply 列只给上面的函数用：它是 security invoker，所以要给 authenticated 这一列的写权限，
-- 再由触发器保证 reply 指向同一个对话里真实的转发消息
grant insert (reply) on public.messages to authenticated;
grant insert (reply) on public.group_messages to authenticated;

create function public.reply_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare to_id uuid;
begin
  if new.kind <> 'comment' then return new; end if;
  to_id := (new.reply->>'to')::uuid;
  if tg_table_name = 'messages' then
    if not exists (select 1 from public.messages m where m.id = to_id and m.kind = 'checkin'
        and least(m.sender, m.recipient) = least(new.sender, new.recipient)
        and greatest(m.sender, m.recipient) = greatest(new.sender, new.recipient)) then
      raise exception 'BAD_REPLY' using errcode = 'P0001';
    end if;
  elsif not exists (select 1 from public.group_messages g where g.id = to_id and g.kind = 'checkin' and g.group_id = new.group_id) then
    raise exception 'BAD_REPLY' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke execute on function public.reply_guard() from public, anon, authenticated;
create trigger messages_reply_guard before insert on public.messages
  for each row execute function public.reply_guard();
create trigger group_messages_reply_guard before insert on public.group_messages
  for each row execute function public.reply_guard();
