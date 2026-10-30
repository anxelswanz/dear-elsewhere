// 用 Supabase Management API 建生产环境：建项目 → 等它就绪 → 按顺序执行 migrations → 配置登录与发信 → 写出前端环境变量
// 用法：node scripts/setup-prod.mjs <步骤>
//   create   建项目（数据库密码随机生成，存到 secrets/prod_db_password）
//   migrate  执行 supabase/migrations 里还没执行过的文件（记录在 secrets/prod_migrated.json）
//   auth     登录设置、Resend SMTP、邮件模板
//   env      把项目地址和 publishable key 写进 .env.local 的 SUPABASE_URL_PROD / SUPABASE_KEY_PROD
//   invite   生成一个随机邀请码：node scripts/setup-prod.mjs invite "给谁的"（记录在 secrets/prod_invite_codes.txt）
//   admin    建 / 更新控制台账号（用户名 admin），并设为唯一的管理员：DASHBOARD_PASSWORD=… node scripts/setup-prod.mjs admin（需先执行 0019）
// 需要的密钥都在 secrets/（已被 git 忽略）：supabase_pat、resend_api_key.md；本脚本不会打印任何密钥。
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const root = new URL('../', import.meta.url);
const secret = name => new URL(`secrets/${name}`, root);
const read = name => readFileSync(secret(name), 'utf8').trim();

const CONFIG = {
  name: 'dear-elsewhere-prod',
  region: 'eu-central-1',
  siteUrl: 'https://dear-elsewhere.com',
  // 登录、重置密码、换邮箱邮件里的链接只能跳回这些地址
  redirects: ['https://dear-elsewhere.com/**', 'https://www.dear-elsewhere.com/**'],
  sender: { email: 'noreply@dear-elsewhere.com', name: 'Dear Elsewhere' },
};

const TOKEN = read('supabase_pat');
const api = async (method, path, body) => {
  const res = await fetch(`https://api.supabase.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ref = () => read('prod_project_ref');

async function create() {
  if (existsSync(secret('prod_project_ref'))) return console.log('已经建过：', ref());
  // 有的令牌列不出组织，就用已有项目所在的组织
  let orgIds = (await api('GET', '/v1/organizations')).map(o => o.id);
  if (!orgIds.length) orgIds = [...new Set((await api('GET', '/v1/projects')).map(p => p.organization_id))];
  if (orgIds.length !== 1) throw new Error(`找到 ${orgIds.length} 个组织，请在 CONFIG 里指定：${orgIds.join(', ')}`);
  const pass = randomBytes(24).toString('base64url');
  writeFileSync(secret('prod_db_password'), pass + '\n', { mode: 0o600 });
  const p = await api('POST', '/v1/projects', {
    name: CONFIG.name, organization_id: orgIds[0], region: CONFIG.region, db_pass: pass,
  });
  writeFileSync(secret('prod_project_ref'), p.id + '\n');
  console.log(`已创建 ${p.name}（${p.id}，${p.region}），等待就绪…`);
  for (let i = 0; i < 60; i++) {
    const s = await api('GET', `/v1/projects/${p.id}`);
    if (s.status === 'ACTIVE_HEALTHY') return console.log('项目已就绪');
    await sleep(10_000);
  }
  throw new Error('等了 10 分钟还没就绪，稍后再运行 migrate');
}

const query = sql => api('POST', `/v1/projects/${ref()}/database/query`, { query: sql });

async function migrate() {
  const doneFile = secret('prod_migrated.json');
  const done = existsSync(doneFile) ? JSON.parse(readFileSync(doneFile, 'utf8')) : [];
  const dir = new URL('supabase/migrations/', root);
  for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    if (done.includes(f)) continue;
    process.stdout.write(`执行 ${f} … `);
    await query(readFileSync(new URL(f, dir), 'utf8'));
    done.push(f);
    writeFileSync(doneFile, JSON.stringify(done, null, 2));
    console.log('完成');
  }
  console.log('全部 migrations 已执行');
}

async function auth() {
  const tpl = name => readFileSync(new URL(`supabase/templates/${name}.html`, root), 'utf8');
  // 模板和主题由 scripts/build-emails.mjs 生成，按用户资料里的 lang 发中文或英文
  const subjects = JSON.parse(readFileSync(new URL('supabase/templates/subjects.json', root), 'utf8'));
  const resend = readFileSync(secret('resend_api_key.md'), 'utf8').match(/re_[A-Za-z0-9_]+/)?.[0];
  if (!resend) throw new Error('secrets/resend_api_key.md 里没有找到 Resend key');
  await api('PATCH', `/v1/projects/${ref()}/config/auth`, {
    site_url: CONFIG.siteUrl,
    uri_allow_list: CONFIG.redirects.join(','),
    mailer_autoconfirm: false,                // 注册要验证邮箱
    mailer_secure_email_change_enabled: true, // 换邮箱时新旧两边都要确认
    password_min_length: 8,
    smtp_host: 'smtp.resend.com', smtp_port: '465', smtp_user: 'resend', smtp_pass: resend,
    smtp_admin_email: CONFIG.sender.email, smtp_sender_name: CONFIG.sender.name,
    mailer_subjects_confirmation: subjects.confirmation,
    mailer_subjects_recovery: subjects.recovery,
    mailer_subjects_email_change: subjects.email_change,
    mailer_subjects_invite: subjects.invite,
    mailer_templates_confirmation_content: tpl('confirmation'),
    mailer_templates_recovery_content: tpl('recovery'),
    mailer_templates_email_change_content: tpl('email_change'),
    mailer_templates_invite_content: tpl('invite'),
  });
  console.log(`登录设置已更新：Site URL ${CONFIG.siteUrl}，邮箱验证开启，密码至少 8 位，发信走 Resend（${CONFIG.sender.email}）`);
}

async function env() {
  const keys = await api('GET', `/v1/projects/${ref()}/api-keys`);
  const key = keys.find(k => k.type === 'publishable')?.api_key || keys.find(k => k.name === 'anon')?.api_key;
  if (!key) throw new Error('没有拿到 publishable / anon key');
  // 写进 .env.local 的 SUPABASE_URL_PROD / SUPABASE_KEY_PROD，其他内容保持不变（开关见 .env 的 APP_ENV）
  const file = new URL('.env.local', root);
  let text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  for (const [name, value] of [['SUPABASE_URL_PROD', `https://${ref()}.supabase.co`], ['SUPABASE_KEY_PROD', key]]) {
    const line = `${name}=${value}`;
    text = new RegExp(`^${name}=.*$`, 'm').test(text) ? text.replace(new RegExp(`^${name}=.*$`, 'm'), line) : `${text.trimEnd()}\n${line}\n`;
  }
  writeFileSync(file, text, { mode: 0o600 });
  console.log('已更新 .env.local 里的生产环境地址和 key');
}

// 用法：node scripts/setup-prod.mjs invite "给谁的"
// 码是 12 位随机十六进制（约 2^48 种），没法猜；生成的码追加记录到 secrets/prod_invite_codes.txt
async function invite() {
  const note = (process.argv[3] || '').trim().slice(0, 100);
  const code = randomBytes(6).toString('hex').toUpperCase();
  await query(`insert into public.invite_codes (code, note) values ('${code}', ${note ? `'${note.replaceAll("'", "''")}'` : 'null'})`);
  const line = `${code}\t${new Date().toISOString().slice(0, 10)}\t${note}\n`;
  writeFileSync(secret('prod_invite_codes.txt'), line, { flag: 'a', mode: 0o600 });
  console.log(`新邀请码：${code}${note ? `（${note}）` : ''}`);
}

// 控制台账号：用户名 admin 在前端换成这个邮箱登录（src/dashboard/dashboard.js 的 DASHBOARD_EMAIL）
// 密码从环境变量读，不写进任何文件；app_metadata.dashboard 让它不需要邀请码（见 0019）
const DASHBOARD_EMAIL = 'admin@dear-elsewhere.com';
async function admin() {
  const password = process.env.DASHBOARD_PASSWORD || '';
  if (password.length < 8) throw new Error('用法：DASHBOARD_PASSWORD=至少 8 位 node scripts/setup-prod.mjs admin');
  const keys = await api('GET', `/v1/projects/${ref()}/api-keys?reveal=true`);
  const service = keys.find(k => k.name === 'service_role')?.api_key || keys.find(k => k.type === 'secret')?.api_key;
  if (!service) throw new Error('没有拿到 service role key');
  const authApi = (method, path, body) => fetch(`https://${ref()}.supabase.co/auth/v1/admin${path}`, {
    method, headers: { apikey: service, Authorization: `Bearer ${service}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(async res => { const j = await res.json(); if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${j.msg || j.message || ''}`); return j; });

  const [found] = await query(`select id from auth.users where email = '${DASHBOARD_EMAIL}'`);
  const fields = { password, email_confirm: true, app_metadata: { dashboard: true } };
  let id = found?.id;
  if (id) await authApi('PUT', `/users/${id}`, fields);
  else id = (await authApi('POST', '/users', { email: DASHBOARD_EMAIL, ...fields })).id;
  await query(`delete from public.admins where user_id <> '${id}'; insert into public.admins (user_id) values ('${id}') on conflict do nothing;`);
  console.log(`控制台账号已${found ? '更新密码' : '创建'}：用户名 admin（${DASHBOARD_EMAIL}），已设为唯一的管理员`);
}

const steps = { create, migrate, auth, env, invite, admin };
const step = steps[process.argv[2]];
if (!step) { console.log(`用法：node scripts/setup-prod.mjs ${Object.keys(steps).join('|')}`); process.exit(1); }
step().catch(err => { console.error(err.message); process.exit(1); });
