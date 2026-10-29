-- 第 8 步：凭邀请码注册
-- 在 Supabase 控制台 → SQL Editor 中整段执行一次即可（需先执行 0001–0005）。
--
-- 注册时前端把邀请码放在 user_metadata.invite_code 里；数据库在创建账号前校验，
-- 所以绕过前端直接调用注册接口也没用。邀请码只存在数据库里，前端看不到列表。
-- 新增邀请码：insert into public.invite_codes (code, note) values ('XXX', '给谁的');
-- 停用邀请码：update public.invite_codes set active = false where code = 'XXX';

create table public.invite_codes (
  code       text primary key check (code = upper(btrim(code)) and code <> ''),
  note       text,
  active     boolean not null default true,
  uses       integer not null default 0,     -- 已经用它注册了几个账号
  created_at timestamptz not null default now()
);

-- 不建任何 policy：只有 SQL Editor 和下面的 security definer 函数能读写
alter table public.invite_codes enable row level security;
revoke all on public.invite_codes from anon, authenticated;

-- 邀请码不要写进代码仓库：执行完本文件后，在 SQL Editor 里单独插入，并用足够长的随机码，例如
--   insert into public.invite_codes (code, note) values (upper(encode(gen_random_bytes(6), 'hex')), '给谁的');

-- 注册页在提交前先问一下邀请码是否有效，好给出明确的提示（只返回是 / 否）
create function public.check_invite(code text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.invite_codes i
    where i.code = upper(btrim(check_invite.code)) and i.active
  );
$$;

revoke all on function public.check_invite(text) from public;
grant execute on function public.check_invite(text) to anon, authenticated;

-- 真正的关卡：没有有效邀请码就不能创建账号。
-- 在控制台用「Invite user」邀请的人不需要邀请码。
create function public.require_invite() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  given text := upper(btrim(coalesce(new.raw_user_meta_data ->> 'invite_code', '')));
begin
  if new.invited_at is not null then return new; end if;
  update public.invite_codes set uses = uses + 1 where code = given and active;
  if not found then
    raise exception 'invalid invite code' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function public.require_invite() from public;

create trigger require_invite before insert on auth.users
  for each row execute function public.require_invite();
