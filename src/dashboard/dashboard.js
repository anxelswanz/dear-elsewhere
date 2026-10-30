// 管理员控制台（/dashboard/）：数据来自 0018 的 admin_dashboard / admin_users，只有 admins 表里的账号能读
// 指标的含义和「怎么看」见本地 ANALYTICS.md
import '@fontsource-variable/fraunces/opsz.css';
import '@fontsource/noto-serif-sc/700.css';
import '../styles/themes.css';
import './dashboard.css';
import { createClient } from '@supabase/supabase-js';

// 控制台自己登录：唯一账号，用户名 admin 换成下面的邮箱（账号由 scripts/setup-prod.mjs admin 创建）
// 会话单独存一份，不会把同一浏览器里 App 的登录顶掉
const DASHBOARD_USER = 'admin';
const DASHBOARD_EMAIL = 'admin@dear-elsewhere.com';
const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_KEY;
const supabase = url && key ? createClient(url, key, { auth: { storageKey: 'de-dashboard-auth' } }) : null;
if (import.meta.env.VITE_APP_ENV === 'test') document.title = `[TEST] ${document.title}`;

const $ = sel => document.querySelector(sel);
const root = $('#db');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = n => Number(n || 0).toLocaleString('zh-CN');
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const day = s => String(s).slice(5, 10).replace('-', '.');

let days = 30;
let sort = 'last_active';
let page = 0;

// ---------- 名称 ----------
const EVENT = {
  app_open: '打开 App', site_view: '官网浏览', site_cta: '官网点「进入」', signup_view: '打开注册页', signup_submit: '提交注册', signup_error: '注册失败',
  friends_overlay: '切换好友地图', friend_dot_click: '点好友头像圆针', only_friend: '只看 TA', feed_open: '打开动态', chat_open: '打开对话',
  snapshot_open: '暗房：取景', snapshot_shoot: '暗房：快门', snapshot_ready: '暗房：出图', snapshot_save: '暗房：保存', snapshot_cancel: '暗房：放弃',
  settings_open: '打开设置', theme_change: '换主题', lang_change: '换语言', photos_zip: '下载照片 zip', account_export: '下载我的数据', account_delete: '注销账号',
  limit_hit: '碰到限额', client_error: '同步失败',
};
const LABEL = {
  // 属性值
  phone: '手机', desktop: '电脑', zh: '中文', en: 'English', dm: '私信', group: '群聊', portrait: '竖版', square: '方形', story: '故事',
  download: '直接下载', share: '系统分享', share_cancel: '分享后取消（改下载）', frame: '取景时', preview: '看到预览后',
  nav: '顶栏', hero: '首屏', closing: '结尾', footer: '页脚', city: '城市', region: '省/州', country: '国家', world: '世界',
  true: '是', false: '否', invite: '邀请码不对', mail: '验证邮件发不出', rate: '太频繁', wait: '冷却中', exists: '邮箱已注册', weak: '密码太弱', network: '网络', other: '其他',
  airmail: '航空信', coast: '海岸明信片', forest: '森林邮局', darkroom: '暗房胶片', night: '夜航',
  sign: '路牌', flag: '旗帜', neon: '霓虹', stamp: '印章', pin: '图钉', plane: '飞机', train: '火车', ship: '轮船', car: '汽车', none: '没选',
  comment: '评论', friend_request: '好友申请', group_create: '建群',
  // 限额代码（limits.js / 各迁移里的 limit_exceeded）
  too_fast: '太快', places_per_day: '每天盖章', records_per_day: '每天记录', photos_per_place: '每章照片', photos_per_day: '每天照片', photos_total: '照片总量',
  comments_per_day: '每天评论', comments_per_post: '单张明信片评论', messages_per_day: '每天消息', requests_per_day: '每天好友申请', requests_pending: '待处理申请',
  group_full: '群满员', groups_per_day: '每天建群', avatar_draws: '抽旅伴',
};
const label = k => LABEL[k] || k;

// ---------- 小部件 ----------
// 单一系列的趋势小图：2px 线 + 淡面积，悬停每个点显示数值
function spark(series, key, title) {
  const W = 320, H = 90, P = 6;
  const vals = series.map(d => Number(d[key] || 0));
  const max = Math.max(1, ...vals);
  const x = i => P + (i * (W - 2 * P)) / Math.max(1, vals.length - 1);
  const y = v => H - P - (v / max) * (H - 2 * P);
  const line = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const total = vals.reduce((a, b) => a + b, 0);
  return `<figure class="db-spark">
    <figcaption><span>${title}</span><b>${num(total)}</b></figcaption>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(title)}，合计 ${total}">
      <line class="grid" x1="0" x2="${W}" y1="${H - P}" y2="${H - P}" />
      <path class="area" d="${line} L${x(vals.length - 1)} ${H - P} L${x(0)} ${H - P} Z" />
      <path class="line" d="${line}" />
      ${vals.map((v, i) => `<g class="pt"><rect x="${x(i) - (W / vals.length) / 2}" y="0" width="${W / vals.length}" height="${H}" /><circle cx="${x(i)}" cy="${y(v)}" r="3.5" /><title>${day(series[i].day)}：${v}</title></g>`).join('')}
    </svg>
    <p class="db-axis"><span>${day(series[0]?.day)}</span><span>峰值 ${num(max)}</span><span>${day(series.at(-1)?.day)}</span></p>
  </figure>`;
}

// 横条：[[名称, 数值], …]，按数值从大到小
function bars(entries, { of = null, unit = '' } = {}) {
  const list = entries.filter(([, v]) => v != null).sort((a, b) => b[1] - a[1]);
  if (!list.length) return '<p class="db-empty">还没有数据</p>';
  const max = of ?? Math.max(...list.map(([, v]) => v), 1);
  const sum = list.reduce((a, [, v]) => a + v, 0);
  return `<ul class="db-bars">${list.map(([k, v]) => `<li title="${esc(label(k))}：${num(v)}${unit}（${pct(v, sum)}）">
    <span>${esc(label(k))}</span><i style="--w:${Math.max(1.5, (v / max) * 100)}%"></i><b>${num(v)}${unit}</b><small>${pct(v, sum)}</small></li>`).join('')}</ul>`;
}
const obj = o => Object.entries(o || {});

function card(title, body, hint = '', cls = '') {
  return `<section class="db-card ${cls}"><h2>${title}</h2>${hint ? `<p class="db-hint">${hint}</p>` : ''}${body}</section>`;
}
const stat = (k, v, sub = '') => `<div class="db-stat"><small>${k}</small><b>${v}</b>${sub ? `<span>${sub}</span>` : ''}</div>`;

// ---------- 区块 ----------
function kpi(d) {
  const k = d.kpi;
  return `<div class="db-kpis">
    ${stat('用户', num(k.users), `近 ${d.days} 天新增 ${num(k.new)}`)}
    ${stat('日活 DAU', num(k.dau), `周活 ${num(k.wau)} · 月活 ${num(k.mau)}`)}
    ${stat('黏性 DAU÷MAU', pct(k.dau, k.mau), '旅行类低于 10% 属正常')}
    ${stat('章', num(k.stamps), `照片 ${num(k.photos)} 张`)}
  </div>`;
}

function trends(d) {
  const s = d.series || [];
  return card('趋势', `<div class="db-sparks">
    ${spark(s, 'signups', '注册')}${spark(s, 'active', '活跃人数')}${spark(s, 'stamps', '盖章')}
    ${spark(s, 'comments', '评论')}${spark(s, 'messages', '消息')}
  </div>`, '发版前后各取 14 天对比，只看事先写在 ANALYTICS.md 里的那个指标。');
}

function funnel(d) {
  const f = d.funnel || {};
  const steps = [['注册', f.signed], ['建护照', f.passport], ['第一个章', f.stamp], ['第一张照片', f.photo], ['第一个好友', f.friend], ['发布或转发', f.share], ['7 天后回来', f.returned]];
  const first = steps[0][1] || 0;
  const body = first ? `<ol class="db-funnel">${steps.map(([k, v], i) => {
    const prev = i ? steps[i - 1][1] : v;
    return `<li title="${k}：${v} 人，占注册 ${pct(v, first)}">
      <span>${k}</span><i style="--w:${Math.max(1.5, (v / first) * 100)}%"></i><b>${num(v)}</b>
      <small>${pct(v, first)}${i ? ` · 本步 ${pct(v, prev)}` : ''}</small></li>`;
  }).join('')}</ol>` : `<p class="db-empty">近 ${d.days} 天没有新注册</p>`;
  return card(`激活漏斗 · 近 ${d.days} 天注册的人`, body, '「本步」最低的那一步先修：护照太长 → 精简；不会盖章 → 新手示范；没好友 → 第一章后引导邀请。');
}

function retention(d) {
  const rows = d.retention || [];
  const cell = (n, size) => (n == null ? '<td class="na">—</td>'
    : `<td style="--a:${size ? (n / size) * 0.85 + 0.05 : 0}" title="${n} / ${size}">${pct(n, size)}</td>`);
  const f = d.friend_effect || {};
  const body = rows.length ? `<div class="db-scroll"><table class="db-heat">
      <thead><tr><th>注册周</th><th>人数</th><th>第 1 周</th><th>第 2 周</th><th>第 4 周</th><th>第 8 周</th></tr></thead>
      <tbody>${rows.map(r => `<tr><th>${day(r.week)}</th><td class="n">${r.size}</td>${cell(r.w1, r.size)}${cell(r.w2, r.size)}${cell(r.w4, r.size)}${cell(r.w8, r.size)}</tr>`).join('')}</tbody>
    </table></div>` : '<p class="db-empty">还没有数据</p>';
  const effect = `<div class="db-kpis small">
    ${stat('有好友的人 · 近 30 天仍活跃', pct(f.with_active, f.with_total), `${num(f.with_active)} / ${num(f.with_total)}`)}
    ${stat('没好友的人 · 近 30 天仍活跃', pct(f.without_active, f.without_total), `${num(f.without_active)} / ${num(f.without_total)}`)}
  </div>`;
  return card('留存', body + effect, '有好友的人明显更留得住 → 资源投社交；差不多 → 投个人记录体验。假期回升说明是「旅行时才用」的产品。');
}

function content(d) {
  const c = d.content || {};
  return card('内容：用户怎么记', `<div class="db-cols">
      <div><h3>标记样式</h3>${bars(obj(c.markers))}</div>
      <div><h3>交通方式</h3>${bars(obj(c.transport))}</div>
      <div><h3>每个章的照片数</h3>${bars(obj(c.photos_per_stamp).map(([k, v]) => [`${k} 张`, v]))}</div>
      <div><h3>热门国家（章数）</h3>${bars((c.countries || []).map(x => [x.country, x.stamps]))}</div>
    </div>
    <p class="db-foot">已发布到动态的章：${num(c.published)} / ${num(d.kpi.stamps)}（${pct(c.published, d.kpi.stamps)}）</p>`,
  '冷门样式砍掉或重做；常塞满 5 张 → 放宽或做付费；发布率低 → 用户把它当私密日记。');
}

function social(d) {
  const s = d.social || {};
  return card(`社交 · 近 ${d.days} 天`, `<div class="db-kpis small">
      ${stat('好友申请接受率', pct(s.accepted, s.requests), `${num(s.accepted)} / ${num(s.requests)}`)}
      ${stat('人均好友', s.friends_avg)}
      ${stat('评论', num(s.comments), `其中聊天里 ${num(s.chat_comments)}`)}
      ${stat('私信 / 群消息', `${num(s.dms)} / ${num(s.group_msgs)}`)}
      ${stat('转发明信片', num(s.shares))}
      ${stat('新建群', num(s.groups), `平均 ${s.group_size} 人`)}
      ${stat('抽旅伴', num(s.draws))}
    </div>`, '接受率低 → 好友申请加附言；聊天里评论多 → 加强群聊；转发多 → 做外部分享卡片拉新。');
}

function darkroom(d) {
  const e = d.events || {}, b = d.breakdown || {};
  const steps = [['取景', e.snapshot_open?.n], ['快门', e.snapshot_shoot?.n], ['出图', e.snapshot_ready?.n], ['保存', e.snapshot_save?.n]].map(([k, v]) => [k, v || 0]);
  const first = steps[0][1];
  const ms = d.snapshot_ms || {};
  return card('暗房（截图）', `${first ? `<ol class="db-funnel">${steps.map(([k, v], i) => `<li><span>${k}</span><i style="--w:${Math.max(1.5, (v / first) * 100)}%"></i><b>${num(v)}</b><small>${pct(v, first)}${i ? ` · 本步 ${pct(v, steps[i - 1][1])}` : ''}</small></li>`).join('')}</ol>` : '<p class="db-empty">还没人用过暗房</p>'}
    <div class="db-cols">
      <div><h3>比例</h3>${bars(obj(b['snapshot_save.ratio']))}</div>
      <div><h3>保存方式</h3>${bars(obj(b['snapshot_save.via']))}</div>
      <div><h3>在哪一步放弃</h3>${bars(obj(b['snapshot_cancel.stage']))}</div>
      <div><h3>取景层级</h3>${bars(obj(b['snapshot_open.level']))}</div>
    </div>
    <p class="db-foot">出图耗时：平均 ${ms.avg ? `${num(ms.avg)} ms` : '—'} · 90% 在 ${ms.p90 ? `${num(Math.round(ms.p90))} ms` : '—'} 以内 · 失败 ${num(b['snapshot_ready.ok']?.false)} 次</p>`,
  '取景多快门少 → 加取景引导；预览后放弃多 → 改出图；故事比例多 → 做分享到 Story + 水印；耗时长 → 优化渲染。');
}

function features(d) {
  const e = d.events || {};
  const rows = Object.keys(EVENT).filter(k => !k.startsWith('snapshot_')).map(k => [k, e[k]]);
  const b = d.breakdown || {};
  return card(`功能使用 · 近 ${d.days} 天`, `<div class="db-scroll"><table class="db-table">
      <thead><tr><th>事件</th><th>次数</th><th>人数</th></tr></thead>
      <tbody>${rows.map(([k, v]) => `<tr><td>${EVENT[k]}</td><td class="n">${num(v?.n)}</td><td class="n">${k.startsWith('site_') || k.startsWith('signup_') || k === 'account_delete' ? '匿名' : num(v?.users)}</td></tr>`).join('')}</tbody>
    </table></div>
    <div class="db-cols">
      <div><h3>设备</h3>${bars(obj(b['app_open.device']))}</div>
      <div><h3>主题</h3>${bars(obj(b['app_open.theme']))}</div>
      <div><h3>语言</h3>${bars(obj(b['app_open.lang']))}</div>
      <div><h3>对话类型</h3>${bars(obj(b['chat_open.type']))}</div>
    </div>`, '新功能上线两周没人用 → 停止投入。');
}

function health(d) {
  const b = d.breakdown || {}, e = d.events || {};
  const site = [['官网浏览', e.site_view?.sessions], ['点「进入」', e.site_cta?.sessions], ['打开注册页', e.signup_view?.sessions], ['提交注册', e.signup_submit?.sessions], ['注册成功', d.kpi.new]].map(([k, v]) => [k, v || 0]);
  const first = site[0][1];
  return card('官网、限额与出错', `<div class="db-cols">
      <div><h3>官网 → 注册（按会话）</h3>${first ? `<ol class="db-funnel">${site.map(([k, v]) => `<li><span>${k}</span><i style="--w:${Math.max(1.5, (v / first) * 100)}%"></i><b>${num(v)}</b><small>${pct(v, first)}</small></li>`).join('')}</ol>` : '<p class="db-empty">还没有数据</p>'}</div>
      <div><h3>注册失败原因</h3>${bars(obj(b['signup_error.code']))}</div>
      <div><h3>碰到的限额</h3>${bars(obj(b['limit_hit.code']))}</div>
      <div><h3>同步失败</h3>${bars(obj(b['client_error.code']))}</div>
      <div><h3>最近 24 小时的操作量</h3>${bars(obj(d.limits))}</div>
      <div><h3>邀请码使用</h3>${bars((d.invites || []).map(i => [`${i.code}${i.note ? ` ${i.note}` : ''}${i.active ? '' : '（停用）'}`, i.uses]))}</div>
    </div>`, '「验证邮件发不出」突增 = 发信故障，当天就要查；常被碰到的限额考虑放宽。');
}

// ---------- 用户列表 ----------
const COLS = [['handle', 'ID', false], ['created_at', '注册', true], ['last_active', '最近活跃', true], ['stamps', '章', true], ['photos', '照片', true], ['friends', '好友', true], ['comments', '评论', true], ['messages', '消息', true]];
const ago = at => {
  if (!at) return '从未';
  const h = (Date.now() - Date.parse(at)) / 36e5;
  return h < 1 ? '刚刚' : h < 24 ? `${Math.floor(h)} 小时前` : `${Math.floor(h / 24)} 天前`;
};

async function renderUsers() {
  const box = $('#dbUsers');
  const { data, error } = await supabase.rpc('admin_users', { sort, page });
  if (error) { box.innerHTML = `<p class="db-empty">读取失败：${esc(error.message)}</p>`; return; }
  const pages = Math.max(1, Math.ceil(data.total / 50));
  box.innerHTML = `<div class="db-scroll"><table class="db-table db-users">
      <thead><tr>${COLS.map(([k, t, sortable]) => `<th>${sortable ? `<button type="button" data-sort="${k}" aria-pressed="${sort === k}">${t}${sort === k ? ' ↓' : ''}</button>` : t}</th>`).join('')}</tr></thead>
      <tbody>${(data.rows || []).map(r => `<tr>
        <td><span class="db-who"><img src="/avatars/${esc(r.avatar || 'a01')}.svg" alt="" /><span><b>${esc(r.name || '（没建护照）')}</b><small>${r.handle ? `@${esc(r.handle)}` : ''}</small></span></span></td>
        <td>${esc(String(r.created_at).slice(0, 10))}</td><td>${ago(r.last_active)}</td>
        <td class="n">${num(r.stamps)}</td><td class="n">${num(r.photos)}</td><td class="n">${num(r.friends)}</td><td class="n">${num(r.comments)}</td><td class="n">${num(r.messages)}</td>
      </tr>`).join('')}</tbody>
    </table></div>
    <p class="db-pager"><button type="button" data-page="-1" ${page ? '' : 'disabled'}>‹ 上一页</button><span>${page + 1} / ${pages} · 共 ${num(data.total)} 人</span><button type="button" data-page="1" ${page + 1 < pages ? '' : 'disabled'}>下一页 ›</button></p>`;
}

// ---------- 读取 ----------
async function load() {
  for (const b of document.querySelectorAll('[data-days]')) b.setAttribute('aria-checked', Number(b.dataset.days) === days);
  root.classList.add('loading');
  const { data, error } = await supabase.rpc('admin_dashboard', { days });
  root.classList.remove('loading');
  if (error) { root.innerHTML = `<p class="db-note">读取失败：${esc(error.message)}</p>`; return; }
  root.innerHTML = `${kpi(data)}${trends(data)}
    <div class="db-grid">${funnel(data)}${retention(data)}</div>
    ${content(data)}${social(data)}${darkroom(data)}${features(data)}${health(data)}
    ${card('用户', '<div id="dbUsers"><p class="db-empty">读取中…</p></div>', '只有计数，没有任何内容。重度用户约访谈；注册后没盖章或 30 天没回来的，了解流失原因；单日消息异常多的，排查刷屏。')}
    <p class="db-generated">生成于 ${new Date(data.generated_at).toLocaleString('zh-CN')}</p>`;
  renderUsers();
}

// ---------- 登录 ----------
function showLogin(message = '') {
  $('.db-range').hidden = true;
  $('[data-refresh]').hidden = true;
  $('[data-signout]').hidden = true;
  root.innerHTML = `<form class="db-login" id="dbLogin" autocomplete="on">
      <img src="/brand/stamp@2x.png" alt="" />
      <h1>控制台登录</h1>
      <label><span>用户名</span><input name="user" autocomplete="username" required autofocus /></label>
      <label><span>密码</span><input name="password" type="password" autocomplete="current-password" required /></label>
      <p class="db-login-msg" role="alert">${esc(message)}</p>
      <button type="submit">登录</button>
    </form>`;
}

async function login(form) {
  const user = form.user.value.trim().toLowerCase();
  const password = form.password.value;
  const say = msg => { form.querySelector('.db-login-msg').textContent = msg; };
  if (user !== DASHBOARD_USER) return say('用户名或密码不对');
  const button = form.querySelector('button');
  button.disabled = true;
  const { error } = await supabase.auth.signInWithPassword({ email: DASHBOARD_EMAIL, password });
  button.disabled = false;
  if (error) return say(error.status === 429 ? '尝试太多次了，请稍后再试' : '用户名或密码不对');
  start();
}

async function start() {
  if (!supabase) { root.innerHTML = '<p class="db-note">没有配置 Supabase。</p>'; return; }
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return showLogin();
  const { data: admin, error } = await supabase.rpc('is_admin');
  if (error) { root.innerHTML = `<p class="db-note">读取失败：${esc(error.message)}（是否已执行 0018、0019 迁移？）</p>`; return; }
  if (!admin) { await supabase.auth.signOut(); return showLogin('这个账号没有控制台权限'); }
  $('.db-range').hidden = false;
  $('[data-refresh]').hidden = false;
  $('[data-signout]').hidden = false;
  load();
}

document.addEventListener('click', e => {
  const d = e.target.closest('[data-days]');
  if (d) { days = Number(d.dataset.days); return load(); }
  if (e.target.closest('[data-refresh]')) return load();
  if (e.target.closest('[data-signout]')) return supabase.auth.signOut().then(() => showLogin());
  const s = e.target.closest('[data-sort]');
  if (s) { sort = s.dataset.sort; page = 0; return renderUsers(); }
  const p = e.target.closest('[data-page]');
  if (p) { page += Number(p.dataset.page); return renderUsers(); }
});

document.addEventListener('submit', e => {
  if (e.target.id !== 'dbLogin') return;
  e.preventDefault();
  login(e.target);
});

start();
