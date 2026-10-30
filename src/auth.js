// 账号：登录 / 注册 / 找回密码（一封航空信），首次登录填写「旅行护照」资料，
// 以及顶栏头像和「个人资料」面板。必须登录才能使用地图。
import { supabase, supabaseReady, urlAuth } from './supabase.js';
import { playWelcome } from './welcome.js';
import { t, lang, localName, langSwitch } from './i18n.js';
import { applyAccountSettings } from './settings.js';
import { limitText } from './limits.js';

// 头像分四个稀有度，用文件名前缀区分（见 scripts/build-avatars.mjs 与 0013_avatars_birthplace.sql）。
// 不能自己挑：注册时在普通头像里随机，之后每天抽 3 次
const avatarIds = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1).padStart(2, '0')}`);
const COMMON = avatarIds('a', 130);
const ALL_AVATARS = [...COMMON, ...avatarIds('p', 50), ...avatarIds('r', 40), ...avatarIds('l', 16)];
const randomOf = list => list[Math.floor(Math.random() * list.length)];
const BRAND = `${import.meta.env.BASE_URL}brand/`; // Logo：航空邮票（无文字）
// 出生地（城市 ID），仅自己可见；修改时派发 birthplace:change
export const myBirthplace = () => birthplace;
export const avatarUrl = id => `${import.meta.env.BASE_URL}avatars/${id}.svg`;
const HANDLE_MIN = 3, HANDLE_MAX = 20;
const HANDLE_RE = new RegExp(`^[a-z0-9_]{${HANDLE_MIN},${HANDLE_MAX}}$`);
const HANDLE_COOLDOWN_DAYS = 7;
// 条款版本：改动 public/legal.html 的实质内容时更新，注册时记进 user_metadata 作为同意凭证
const TERMS_VERSION = '2026-10-29';
const legalUrl = hash => `${import.meta.env.BASE_URL}legal.html?lang=${lang}${hash ? `#${lang}-${hash}` : ''}`;

const $ = sel => document.querySelector(sel);
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => new Date().toISOString().slice(0, 10);

let session = null;
let profile = null;      // public.profiles 中自己的一行
let birthday = '';       // public.profile_private，仅自己可见
let birthplace = '';     // 同上：出生的城市（地图数据里的城市 ID）
let cities = null;       // 出生地候选，第一次打开护照时加载：[{ id, name, zh, en, country }]
let countries = [];      // [{ id, name, en }]，按中文名排序
let view = 'checking';
let email = '';          // 在登录 / 注册 / 找回密码之间切换时保留
let invite = '';         // 注册用的邀请码，同上
let resolveReady;        // 第一次拿到完整资料时，把账号交给地图
let readyUser = null;
let welcome = null;      // 'login' | 'signup'：只在主动登录、刚签发护照时播放欢迎动画，刷新页面不播
let recovering = urlAuth.recovery; // 从重置密码邮件回来：设好新密码之前，拿到会话也不进地图
let linkNotice = urlAuth.error ? t('au.linkExpired') : ''; // 邮件链接用过或过期，在登录页提示一次

// ---------- 入口 ----------
// 返回的 Promise 在登录且资料齐全后 resolve 为 { user, profile }；之后换账号或退出时整页刷新
export function initAuth({ countries: countriesReady }) {
  const ready = new Promise(resolve => { resolveReady = resolve; });
  // 登录 / 注册页右上角的语言切换
  $('#auth').insertAdjacentHTML('beforeend', langSwitch('au-lang'));
  countriesReady.then(list => {
    // name 已是界面语言下的名字；搜索时中英文都能匹配
    countries = list.map(({ id, name, en, zh }) => ({ id, name: localName(zh || name, en), zh: zh || name, en }))
      .sort((a, b) => a.name.localeCompare(b.name, lang === 'zh' ? 'zh-CN' : 'en'));
    if (view === 'passport') renderPassport(); // 国家列表晚于护照页到达时补上
  });
  showGate('checking');
  if (!supabaseReady) { showGate('config'); return ready; }

  if (urlAuth.error) history.replaceState(null, '', location.pathname + location.search);

  supabase.auth.onAuthStateChange((event, s) => {
    // 重置密码：INITIAL_SESSION 可能比 PASSWORD_RECOVERY 先到，两种都直接进「设置新密码」
    if (event === 'PASSWORD_RECOVERY' || (recovering && s && ['INITIAL_SESSION', 'SIGNED_IN'].includes(event))) {
      recovering = true;
      session = s;
      if (view !== 'reset') showGate('reset');
      return;
    }
    if (!['INITIAL_SESSION', 'SIGNED_IN', 'SIGNED_OUT'].includes(event)) return;
    if (event === 'SIGNED_IN' && s?.user.id === session?.user.id && profile) return; // 切回标签页时也会触发
    if (view === 'reset') return;
    // 回调里不能直接 await supabase 的其他请求，放到下一轮执行；到时候已经进了重置页就不再处理
    setTimeout(() => { if (view !== 'reset') handleSession(s); }, 0);
  });
  return ready;
}

// 资料齐全：第一次交给地图；已经交出去的账号变了（退出或换号）就整页刷新，避免串数据
function accountReady() {
  if (welcome) {
    const kind = welcome;
    welcome = null;
    // 动画先盖在最上层，登录框在它下面收起
    playWelcome(kind, { profile, avatar: avatarUrl(profile.avatar), passportNo: session.user.id.slice(0, 8).toUpperCase() });
  }
  hideGate();
  if (!readyUser) {
    readyUser = session.user;
    resolveReady({ user: session.user, profile });
  }
}

async function handleSession(s) {
  if (readyUser && s?.user.id !== readyUser.id) return location.reload();
  session = s;
  profile = null;
  birthday = '';
  birthplace = '';
  renderMe();
  if (!s) {
    const notice = linkNotice;
    linkNotice = '';
    return showGate('login', notice);
  }
  showGate('checking');
  const uid = s.user.id;
  const [pub, priv] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', uid).maybeSingle(),
    supabase.from('profile_private').select('*').eq('id', uid).maybeSingle(), // 还没执行 0008 时没有 theme / lang 列
  ]);
  if (pub.error) return showGate('login', t('au.loadFailed', { msg: pub.error.message }));
  profile = pub.data;
  birthday = priv.data?.birthday || '';
  birthplace = priv.data?.birthplace || '';
  if (applyAccountSettings(uid, priv.data)) return; // 账号的语言和本机不同，页面即将刷新
  renderMe();
  if (profile) accountReady();
  else openPassport('create');
}

// ---------- 遮罩层 ----------
function showGate(next, message = '') {
  view = next;
  const gate = $('#auth');
  gate.hidden = false;
  gate.dataset.view = next;
  if (next === 'checking') { $('#authStage').innerHTML = ''; return; }
  renderLetter(message);
}

function hideGate() {
  view = 'closed';
  $('#auth').hidden = true;
  $('#authStage').innerHTML = '';
}

// ---------- 航空信：登录 / 注册 / 找回密码 ----------
const LETTER = {
  login: { lead: t('au.loginLead'), submit: t('au.login'), fields: ['email', 'password'] },
  signup: { lead: t('au.signupLead'), submit: t('au.signup'), fields: ['invite', 'email', 'password', 'password2', 'consent'] },
  forgot: { lead: t('au.forgotLead'), submit: t('au.sendReset'), fields: ['email'] },
  reset: { lead: t('au.resetLead'), submit: t('au.saveNew'), fields: ['password', 'password2'] },
};

const FIELD = {
  invite: () => `<label class="au-field"><span>${t('au.invite')}</span>
    <input name="invite" type="text" required autocomplete="off" autocapitalize="characters" spellcheck="false" value="${escapeHtml(invite)}" placeholder="${t('au.invitePh')}" /></label>`,
  email: () => `<label class="au-field"><span>${t('au.email')}</span>
    <input name="email" type="email" autocomplete="email" required value="${escapeHtml(email)}" placeholder="you@example.com" /></label>`,
  password: v => `<label class="au-field"><span>${t(v === 'reset' ? 'au.newPassword' : 'au.password')}</span>
    <input name="password" type="password" ${v === 'login' ? '' : `minlength="${PASSWORD_MIN}"`} required autocomplete="${v === 'login' ? 'current-password' : 'new-password'}" placeholder="${v === 'login' ? '' : t('au.min6', { n: PASSWORD_MIN })}" /></label>`,
  password2: () => `<label class="au-field"><span>${t('au.confirm')}</span>
    <input name="password2" type="password" minlength="${PASSWORD_MIN}" required autocomplete="new-password" /></label>`,
  consent: () => `<label class="au-consent"><input name="consent" type="checkbox" required />
    <span>${t('au.consent', { terms: `<a href="${legalUrl('terms')}" target="_blank" rel="noopener">${t('au.terms')}</a>`, privacy: `<a href="${legalUrl('privacy')}" target="_blank" rel="noopener">${t('au.privacy')}</a>` })}</span></label>`,
};

// 登录 / 注册页底部：条款要点，全文在 legal.html
const termsHtml = () => `<details class="au-terms" open>
  <summary>${t(view === 'signup' ? 'au.termsTitleSignup' : 'au.termsTitleLogin')}</summary>
  <ul>${t('au.termsPoints').map(p => `<li>${p}</li>`).join('')}</ul>
  <p><a href="${legalUrl('terms')}" target="_blank" rel="noopener">${t('au.terms')}</a> · <a href="${legalUrl('privacy')}" target="_blank" rel="noopener">${t('au.privacy')}</a> · ${t('au.termsVersion', { v: TERMS_VERSION })}</p>
</details>`;

const brandHtml = `
  <header class="au-head">
    <img class="brand-mark" src="${BRAND}stamp.png" srcset="${BRAND}stamp.png 1x, ${BRAND}stamp@2x.png 2x" alt="" />
    <div><h2 class="wordmark"><i>Dear</i> Elsewhere</h2><p>${t('brandSub')}</p></div>
    <svg class="au-postmark" viewBox="0 0 100 100" aria-hidden="true">
      <defs><path id="au-arc" d="M50,50 m-36,0 a36,36 0 1,1 72,0 a36,36 0 1,1 -72,0" /></defs>
      <circle cx="50" cy="50" r="46" /><circle cx="50" cy="50" r="27" />
      <text class="au-pm-ring"><textPath href="#au-arc">${lang === 'zh' ? 'PAR AVION ✦ 航空 ✦ PAR AVION ✦ 航空 ✦' : 'PAR AVION ✦ BY AIR MAIL ✦ PAR AVION ✦'}</textPath></text>
      <text class="au-pm-mid" x="50" y="55" text-anchor="middle">${today().slice(2).replaceAll('-', '.')}</text>
    </svg>
  </header>`;

function renderLetter(message = '') {
  const stage = $('#authStage');
  if (view === 'config') {
    stage.innerHTML = `<article class="au-letter"><div class="au-paper">${brandHtml}
      <div class="au-notice">
        <b>${t('au.noConfig')}</b>
        <p>${t('au.noConfigBody', { env: import.meta.env.VITE_APP_ENV || 'test', ENV: (import.meta.env.VITE_APP_ENV || 'test').toUpperCase() })}</p>
      </div></div></article>`;
    return;
  }
  if (view === 'check-email') {
    stage.innerHTML = `<article class="au-letter"><div class="au-paper">${brandHtml}
      <div class="au-notice">
        <b>${t('au.checkEmail')}</b>
        <p>${t('au.checkEmailBody', { email: escapeHtml(email) })}</p>
        <p class="au-msg" role="alert">${escapeHtml(message)}</p>
        <div class="au-row">
          <button type="button" class="au-link" data-resend>${t('au.resend')}</button>
          <button type="button" class="au-link" data-go="login">${t('au.backToLogin')}</button>
        </div>
      </div></div></article>`;
    return;
  }
  const v = LETTER[view];
  const tabs = view === 'login' || view === 'signup';
  stage.innerHTML = `<article class="au-letter"><div class="au-paper">${brandHtml}
    ${tabs ? `<nav class="au-tabs" role="tablist">
      <button type="button" role="tab" aria-selected="${view === 'login'}" data-go="login">${t('au.login')}</button>
      <button type="button" role="tab" aria-selected="${view === 'signup'}" data-go="signup">${t('au.signup')}</button>
    </nav>` : `<p class="au-title">${t(view === 'forgot' ? 'au.forgotTitle' : 'au.resetTitle')}</p>`}
    <form class="au-form" novalidate>
      <p class="au-lead">${v.lead}</p>
      ${v.fields.map(f => FIELD[f](view)).join('')}
      <p class="au-msg" role="alert">${escapeHtml(message)}</p>
      <button class="au-submit" type="submit"><span>${v.submit}</span><b aria-hidden="true">→</b></button>
      <div class="au-row">
        ${view === 'login' ? `<button type="button" class="au-link" data-go="forgot">${t('au.forgot')}</button>` : ''}
        ${view === 'forgot' ? `<button type="button" class="au-link" data-go="login">${t('au.backToLogin')}</button>` : ''}
      </div>
      ${view === 'login' ? `<p class="au-agree">${t('au.loginAgree', { terms: `<a href="${legalUrl('terms')}" target="_blank" rel="noopener">${t('au.terms')}</a>`, privacy: `<a href="${legalUrl('privacy')}" target="_blank" rel="noopener">${t('au.privacy')}</a>` })}</p>` : ''}
      ${tabs ? termsHtml() : ''}
    </form></div></article>`;
  const first = stage.querySelector(view === 'signup' && !invite ? 'input[name="invite"]'
    : email && view !== 'reset' ? 'input[name="password"]' : 'input');
  first?.focus();
}

function authError(err) {
  const m = err?.message || '';
  if (err?.code === 'invalid_credentials' || /invalid login/i.test(m)) return t('err.credentials');
  if (err?.code === 'email_not_confirmed' || /not confirmed/i.test(m)) return t('err.notConfirmed');
  if (err?.code === 'user_already_exists' || /already registered/i.test(m)) return t('err.exists');
  if (err?.code === 'weak_password' || /password should/i.test(m)) return t('err.weak');
  if (err?.code === 'same_password') return t('err.same');
  // 邀请码在数据库里校验，未通过时 Supabase 只会返回笼统的「Database error saving new user」
  if (/database error saving new user/i.test(m)) return t('err.invite');
  // 429 分三种：同一邮箱 60 秒内只能发一次邮件；整个项目每小时的发信上限（控制台 Auth → Rate Limits）；其他限频
  const wait = m.match(/after (\d+) seconds?/i);
  if (wait) return t('err.wait', { n: wait[1] });
  if (err?.code === 'over_email_send_rate_limit' || /email rate limit/i.test(m)) return t('err.mailLimit');
  if (err?.status === 429 || /rate limit|LIMIT:too_fast/i.test(m)) return t('err.rate'); // LIMIT：邀请码查询太频繁（0011）
  if (/error sending .*email/i.test(m)) return t('err.mail'); // Supabase 的 SMTP（Resend）发信失败
  if (/fetch|network/i.test(m)) return t('err.network');
  return m || t('err.unknown');
}

const PASSWORD_MIN = 8; // 与 Supabase 控制台 Auth → Password 的最短长度保持一致
const redirectTo = () => location.origin + location.pathname;

async function submitLetter(form) {
  const data = Object.fromEntries(new FormData(form));
  const say = msg => { form.querySelector('.au-msg').textContent = msg; };
  if ('email' in data) {
    email = data.email.trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) return say(t('err.emailFormat'));
  }
  if ('invite' in data) {
    invite = data.invite.trim().toUpperCase();
    if (!invite) return say(t('err.invite'));
  }
  // 新密码至少 8 位；登录时不检查长度，老账号的 6 位密码照样能登录
  if ('password' in data && view !== 'login' && data.password.length < PASSWORD_MIN) return say(t('err.pw6', { n: PASSWORD_MIN }));
  if ('password2' in data && data.password !== data.password2) return say(t('err.pwMatch'));
  if (view === 'signup' && !data.consent) return say(t('err.consent'));

  const button = form.querySelector('.au-submit');
  button.disabled = true;
  try {
    if (view === 'login') {
      const { error } = await supabase.auth.signInWithPassword({ email, password: data.password });
      if (error) return say(authError(error));
      welcome = 'login';
      // 成功后由 onAuthStateChange 接手
    } else if (view === 'signup') {
      const { data: ok, error: inviteError } = await supabase.rpc('check_invite', { code: invite });
      if (inviteError) return say(authError(inviteError));
      if (!ok) return say(t('err.invite'));
      const { data: res, error } = await supabase.auth.signUp({
        email, password: data.password,
        options: { emailRedirectTo: redirectTo(), data: { invite_code: invite, terms_version: TERMS_VERSION, terms_accepted_at: new Date().toISOString(), lang } }, // lang：验证邮件用中文还是英文
      });
      if (error) return say(authError(error));
      // 开启邮箱验证时，已注册的邮箱会返回一个没有 identities 的假用户
      if (res.user && !res.user.identities?.length) return say(t('err.exists'));
      if (!res.session) showGate('check-email');
    } else if (view === 'forgot') {
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: redirectTo() });
      if (error) return say(authError(error));
      say('');
      form.querySelector('.au-lead').textContent = t('au.resetSent', { email });
    } else if (view === 'reset') {
      const { error } = await supabase.auth.updateUser({ password: data.password });
      if (error) return say(authError(error));
      recovering = false;
      view = 'checking';
      handleSession(session);
    }
  } finally {
    button.disabled = false;
  }
}

// 用航空信样式问一个是 / 否问题（例如迁移本机旧数据），返回 Promise<boolean>
export function askLetter({ title, body, ok, cancel }) {
  return new Promise(resolve => {
    view = 'ask';
    const gate = $('#auth');
    gate.hidden = false;
    gate.dataset.view = 'ask';
    $('#authStage').innerHTML = `<article class="au-letter"><div class="au-paper">${brandHtml}
      <div class="au-notice">
        <b>${escapeHtml(title)}</b>
        <p>${body}</p>
        <button class="au-submit" type="button" data-ask="1"><span>${escapeHtml(ok)}</span><b aria-hidden="true">→</b></button>
        <div class="au-row"><button type="button" class="au-link" data-ask="0">${escapeHtml(cancel)}</button></div>
      </div></div></article>`;
    $('#authStage').addEventListener('click', function answer(e) {
      const b = e.target.closest('[data-ask]');
      if (!b) return;
      $('#authStage').removeEventListener('click', answer);
      hideGate();
      resolve(b.dataset.ask === '1');
    });
  });
}

// ---------- 旅行护照：首次填写 / 编辑资料 ----------
let pp = null; // 正在编辑的护照 { mode, avatar, handle, name, country, birthday, birthplace, handleState, draw }

function openPassport(mode) {
  pp = mode === 'create'
    ? { mode, avatar: randomOf(COMMON), handle: '', name: '', country: '', birthday: '', birthplace: '' }
    : { mode, avatar: profile.avatar, handle: profile.handle, name: profile.name, country: profile.country, birthday, birthplace };
  pp.handleState = mode === 'create' ? '' : 'mine';
  view = 'passport';
  const gate = $('#auth');
  gate.hidden = false;
  gate.dataset.view = 'passport';
  renderPassport();
  $(mode === 'create' ? '#ppHandle' : '#ppName')?.focus();
  loadCities();
  if (mode === 'edit') loadDrawState();
}

// 7 天内改过 ID 时，返回下次可以修改的日期
function handleLockedUntil() {
  if (pp.mode !== 'edit' || !profile.handle_changed_at) return '';
  const until = new Date(new Date(profile.handle_changed_at).getTime() + HANDLE_COOLDOWN_DAYS * 864e5);
  return until > new Date() ? until.toISOString().slice(0, 10) : '';
}

// 护照底部的机读码，跟着输入实时变化
function mrz() {
  const clean = s => s.toUpperCase().replace(/[^A-Z0-9]/g, '<');
  const pad = s => (s + '<'.repeat(44)).slice(0, 44);
  const name = clean(countries.find(c => c.id === pp.country)?.en || '');
  return [
    pad(`P<${pp.country || '<<<'}${clean(pp.handle || '')}<<${name}`),
    pad(`${clean(pp.handle || '').padEnd(9, '<').slice(0, 9)}0${pp.country || '<<<'}${(pp.birthday || '').replaceAll('-', '').slice(2) || '<<<<<<'}<DEARELSEWHERE`),
  ];
}

// ---------- 国家：输入后自动提示 ----------
const countryLabel = id => {
  const c = countries.find(x => x.id === id);
  return c ? (lang === 'zh' ? `${c.name}　${c.en}` : c.name) : '';
};

// 中文名、英文名、三位代码都能搜；完全匹配 > 开头匹配 > 包含
function matchCountries(q) {
  q = q.trim().toLowerCase();
  if (!q) return countries.slice(0, 8);
  const score = c => {
    const zh = c.zh.toLowerCase(), en = c.en.toLowerCase(), id = c.id.toLowerCase();
    if (zh === q || en === q || id === q) return 0;
    if (zh.startsWith(q) || en.startsWith(q)) return 1;
    if (en.split(/[\s-]+/).some(w => w.startsWith(q))) return 2;
    if (zh.includes(q) || en.includes(q)) return 3;
    return -1;
  };
  return countries.map(c => [score(c), c]).filter(([s]) => s >= 0)
    .sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name, 'zh-CN')).slice(0, 8).map(([, c]) => c);
}

let countryActive = 0;
function showCountryOptions() {
  const input = $('#ppCountry'), list = $('#ppCountryList');
  const items = matchCountries(input.value === countryLabel(pp.country) ? '' : input.value);
  countryActive = Math.min(countryActive, Math.max(0, items.length - 1));
  list.innerHTML = items.length
    ? items.map((c, i) => `<li role="option" id="ppc-${c.id}" data-country="${c.id}" aria-selected="${i === countryActive}">
        <span>${escapeHtml(c.name)}</span><em>${escapeHtml(lang === 'zh' ? c.en : c.zh)}</em></li>`).join('')
    : `<li class="pp-none">${t('pp.noCountry')}</li>`;
  list.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-activedescendant', items[countryActive] ? `ppc-${items[countryActive].id}` : '');
  list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
}

function hideCountryOptions() {
  const list = $('#ppCountryList');
  if (!list) return;
  list.hidden = true;
  $('#ppCountry').setAttribute('aria-expanded', 'false');
}

function pickCountry(id) {
  pp.country = id;
  $('#ppCountry').value = countryLabel(id);
  hideCountryOptions();
  refreshPassportBits();
}

// ---------- 出生地：城市，输入后自动提示（只有自己能看到） ----------
async function loadCities() {
  if (cities) return;
  try {
    const index = await (await fetch(`${import.meta.env.BASE_URL}data/index.json`)).json();
    cities = index.cities.map(([id, zh, en, country, , , , rank]) => ({ id, zh, en: en || '', name: localName(zh, en), country, rank }));
  } catch {
    return;
  }
  // 编辑时城市名晚于护照页到达：补上已存的出生地
  const input = $('#ppBirthplace');
  if (input && pp && document.activeElement !== input) input.value = cityLabel(pp.birthplace);
}

const cityLabel = id => {
  const c = id && cities?.find(x => x.id === id);
  if (!c) return '';
  const country = countries.find(x => x.id === c.country);
  return country ? `${c.name} · ${country.name}` : c.name;
};

// 中文名、英文名都能搜；完全匹配 > 开头匹配 > 包含，同分时大城市在前
function matchCities(q) {
  q = q.trim().toLowerCase();
  if (!q || !cities) return [];
  const score = c => {
    const zh = c.zh.toLowerCase(), en = c.en.toLowerCase();
    if (zh === q || en === q || zh.replace(/[市县区]$/, '') === q) return 0;
    if (zh.startsWith(q) || en.startsWith(q)) return 1;
    if (en.split(/[\s-]+/).some(w => w.startsWith(q))) return 2;
    if (zh.includes(q) || en.includes(q)) return 3;
    return -1;
  };
  return cities.map(c => [score(c), c]).filter(([n]) => n >= 0)
    .sort((a, b) => a[0] - b[0] || a[1].rank - b[1].rank).slice(0, 8).map(([, c]) => c);
}

let cityActive = 0;
function showCityOptions() {
  const input = $('#ppBirthplace'), list = $('#ppBirthplaceList');
  const q = input.value === cityLabel(pp.birthplace) ? '' : input.value;
  if (!q.trim()) return hideCityOptions();
  const items = matchCities(q);
  cityActive = Math.min(cityActive, Math.max(0, items.length - 1));
  list.innerHTML = items.length
    ? items.map((c, i) => `<li role="option" id="ppb-${c.id}" data-city="${c.id}" aria-selected="${i === cityActive}">
        <span>${escapeHtml(c.name)}</span><em>${escapeHtml(countries.find(x => x.id === c.country)?.name || c.country)}</em></li>`).join('')
    : `<li class="pp-none">${cities ? t('pp.noCity') : t('loading')}</li>`;
  list.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-activedescendant', items[cityActive] ? `ppb-${items[cityActive].id}` : '');
  list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
}

function hideCityOptions() {
  const list = $('#ppBirthplaceList');
  if (!list) return;
  list.hidden = true;
  $('#ppBirthplace').setAttribute('aria-expanded', 'false');
}

function pickCity(id) {
  pp.birthplace = id;
  $('#ppBirthplace').value = cityLabel(id);
  hideCityOptions();
}

// ---------- 头像：注册时随机普通头像；之后每天抽 3 次（界面上不显示稀有度，低调一点） ----------

async function loadDrawState() {
  pp.draw = { loading: true };
  renderDraw();
  const { data, error } = await supabase.rpc('avatar_draw_state');
  if (pp?.mode !== 'edit') return;
  pp.draw = error ? { left: 0, error: t('pp.drawFailed', { msg: error.message }) } : { left: data.left, pending: data.pending };
  renderDraw();
}

function renderDraw() {
  const box = $('#ppDraw');
  const d = pp?.draw;
  if (!box || !d) return;
  if (d.loading) { box.innerHTML = `<p class="pp-draw-note">${t('loading')}</p>`; return; }
  const p = d.pending;
  const card = p
    ? `<figure class="pp-draw-card${d.reveal ? ' reveal' : ''}" id="ppDrawCard"><img src="${avatarUrl(p.avatar)}" alt="" /></figure>`
    : `<figure class="pp-draw-card ${d.busy ? 'spinning' : 'back'}" id="ppDrawCard">${d.busy ? `<img src="${avatarUrl(randomOf(ALL_AVATARS))}" alt="" />` : `<img src="${BRAND}stamp.png" alt="" />`}</figure>`;
  const body = p
    ? `<p class="pp-draw-title">${t('pp.drawGot')}</p>
       <div class="pp-draw-actions">
         <button type="button" class="pp-draw-btn ghost" data-draw-keep>${t('pp.drawKeep')}</button>
         <button type="button" class="pp-draw-btn" data-draw-use>${t('pp.drawUse')}</button>
       </div>`
    : `<p class="pp-draw-title">${d.left > 0 ? t('pp.drawLeft', { n: d.left }) : t('pp.drawNone')}</p>
       <div class="pp-draw-actions">
         <button type="button" class="pp-draw-btn" data-draw ${d.left > 0 && !d.busy ? '' : 'disabled'}>${t('pp.draw')}</button>
       </div>`;
  const note = d.error || d.note || '';
  box.innerHTML = `${card}<div class="pp-draw-body">${body}${note ? `<small class="pp-draw-msg${d.error ? ' bad' : ''}">${escapeHtml(note)}</small>` : ''}</div>`;
}

async function drawAvatar() {
  const d = pp.draw;
  if (d.busy || d.left <= 0) return;
  Object.assign(d, { busy: true, error: '', note: '', reveal: false });
  renderDraw();
  // 洗牌：至少转一秒再揭晓
  const spin = setInterval(() => { const img = $('#ppDrawCard img'); if (img) img.src = avatarUrl(randomOf(ALL_AVATARS)); }, 90);
  const [res] = await Promise.all([supabase.rpc('draw_avatar'), new Promise(r => setTimeout(r, 1100))]);
  clearInterval(spin);
  if (pp?.draw !== d) return;
  d.busy = false;
  if (res.error) {
    d.error = limitText(res.error) || t('pp.drawFailed', { msg: res.error.message });
    if (limitText(res.error)) d.left = 0;
  } else {
    d.left = res.data.left;
    d.pending = { id: res.data.id, avatar: res.data.avatar };
    d.reveal = true;
  }
  renderDraw();
}

async function useDraw() {
  const d = pp.draw;
  const { data, error } = await supabase.rpc('accept_avatar', { draw: d.pending.id });
  if (pp?.draw !== d) return;
  d.pending = null;
  d.reveal = false;
  if (error) {
    d.error = error.message?.includes('DRAW_EXPIRED') ? t('pp.drawExpired') : t('pp.drawFailed', { msg: error.message });
    return renderDraw();
  }
  profile = { ...profile, avatar: data };
  pp.avatar = data;
  d.note = t('pp.drawUsed');
  renderMe();
  refreshPassportBits();
  renderDraw();
  document.dispatchEvent(new CustomEvent('avatar:change', { detail: data }));
}

async function keepMine() {
  const d = pp.draw;
  const id = d.pending.id;
  Object.assign(d, { pending: null, reveal: false, note: t('pp.drawKept') });
  renderDraw();
  await supabase.rpc('decline_avatar', { draw: id });
}

const HANDLE_HINT = {
  '': ['', t('pp.hint', { min: HANDLE_MIN, max: HANDLE_MAX })],
  short: ['bad', t('pp.short', { min: HANDLE_MIN })],
  invalid: ['bad', t('pp.invalid')],
  checking: ['', t('pp.checking')],
  taken: ['bad', t('pp.taken')],
  free: ['ok', t('pp.free')],
  mine: ['', t('pp.mine')],
};

// 字段标题：中文界面「名字 · Name」，英文界面只显示英文
const fieldLabel = (zh, en) => (lang === 'zh' ? `${t(zh)} · <i>${t(en)}</i>` : t(zh));

function renderPassport() {
  if (view !== 'passport' || !pp) return;
  const locked = handleLockedUntil();
  const [hintClass, hintText] = locked ? ['', t('pp.locked', { date: locked })] : HANDLE_HINT[pp.handleState];
  const create = pp.mode === 'create';
  $('#authStage').innerHTML = `
    <article class="passport" aria-labelledby="ppTitle">
      ${create ? '' : `<button type="button" class="pc-close" data-pp-close title="${t('close')}">×</button>`}
      <header class="pp-cover">
        <img class="pp-emblem" src="${BRAND}stamp-gold.png" srcset="${BRAND}stamp-gold.png 1x, ${BRAND}stamp-gold@2x.png 2x" alt="" />
        <div><p>${t('pp.kicker')}</p><h2 id="ppTitle">${t(create ? 'pp.create' : 'pp.edit')}</h2></div>
        <span class="pp-no">No. ${escapeHtml((session?.user.id || '').slice(0, 8).toUpperCase())}</span>
      </header>

      <form class="pp-page" novalidate>
        <div class="pp-main">
          <div class="pp-photo">
            <span class="pp-photo-frame"><img id="ppPhoto" src="${avatarUrl(pp.avatar)}" alt="${t('pp.photoAlt')}" /></span>
            ${create ? `<button type="button" class="au-link" data-pp-random>${t('pp.random')}</button>` : ''}
          </div>

          <div class="pp-fields">
            <label class="pp-field pp-field-wide">
              <span>${fieldLabel('pp.handle', 'pp.handleEn')}</span>
              <span class="pp-handle"><b>@</b><input id="ppHandle" name="handle" minlength="${HANDLE_MIN}" maxlength="${HANDLE_MAX}" autocomplete="username" spellcheck="false"
                value="${escapeHtml(pp.handle)}" placeholder="${t('pp.handlePh')}" ${locked ? 'disabled' : ''} />
                <output class="pp-count" id="ppHandleCount" for="ppHandle">${handleCount()}</output></span>
              <small class="pp-hint ${hintClass}" id="ppHandleHint">${hintText}</small>
            </label>
            <label class="pp-field">
              <span>${fieldLabel('pp.name', 'pp.nameEn')}</span>
              <input id="ppName" name="name" maxlength="30" autocomplete="nickname" value="${escapeHtml(pp.name)}" placeholder="${t('pp.namePh')}" />
            </label>
            <div class="pp-field pp-country">
              <label for="ppCountry">${fieldLabel('pp.country', 'pp.countryEn')}</label>
              <input id="ppCountry" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="ppCountryList"
                autocomplete="off" spellcheck="false" value="${escapeHtml(countryLabel(pp.country))}"
                placeholder="${countries.length ? t('pp.countryPh') : t('loading')}" />
              <ul class="pp-options" id="ppCountryList" role="listbox" hidden></ul>
            </div>
            <label class="pp-field">
              <span>${fieldLabel('pp.birthday', 'pp.birthdayEn')}<em>${t('pp.birthdayNote')}</em></span>
              <input id="ppBirthday" name="birthday" type="date" min="1900-01-01" max="${today()}" value="${escapeHtml(pp.birthday)}" />
            </label>
            <div class="pp-field pp-country pp-birthplace">
              <label for="ppBirthplace">${fieldLabel('pp.birthplace', 'pp.birthplaceEn')}<em>${t('pp.birthdayNote')}</em></label>
              <input id="ppBirthplace" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="ppBirthplaceList"
                autocomplete="off" spellcheck="false" value="${escapeHtml(cityLabel(pp.birthplace))}" placeholder="${t('pp.birthplacePh')}" />
              <ul class="pp-options" id="ppBirthplaceList" role="listbox" hidden></ul>
            </div>
          </div>
        </div>

        <section class="pp-avatars">
          <p class="pp-section"><span>${t('pp.avatars')}</span><i>${ALL_AVATARS.length} companions</i></p>
          ${create ? `<p class="pp-draw-note">${t('pp.avatarsNew')}</p>` : '<div class="pp-draw" id="ppDraw"></div>'}
        </section>

        <div class="pp-mrz" aria-hidden="true">${mrz().map(l => `<span>${escapeHtml(l)}</span>`).join('')}</div>

        <footer class="pp-foot">
          <p class="au-msg" role="alert"></p>
          ${create ? `<button type="button" class="au-link" data-signout>${t('pp.switch')}</button>` : `<button type="button" class="au-link" data-pp-close>${t('pp.cancel')}</button>`}
          <button class="au-submit" type="submit"><span>${t(create ? 'pp.issue' : 'pp.save')}</span><b aria-hidden="true">→</b></button>
        </footer>
      </form>
    </article>`;
  renderDraw();
}

// ID 长度计数：不足 3 位时标红
const handleCount = () => `${pp.handle.length}/${HANDLE_MAX}`;

// 局部更新，避免整页重绘打断输入
function refreshPassportBits() {
  const count = $('#ppHandleCount');
  count.value = handleCount();
  count.className = `pp-count${pp.handle && pp.handle.length < HANDLE_MIN ? ' short' : ''}${pp.handle.length >= HANDLE_MAX ? ' full' : ''}`;
  $('#ppPhoto').src = avatarUrl(pp.avatar);
  const [hintClass, hintText] = handleLockedUntil() ? ['', $('#ppHandleHint').textContent] : HANDLE_HINT[pp.handleState];
  $('#ppHandleHint').className = `pp-hint ${hintClass}`;
  $('#ppHandleHint').textContent = hintText;
  document.querySelector('.pp-mrz').innerHTML = mrz().map(l => `<span>${escapeHtml(l)}</span>`).join('');
}

let handleTimer, handleSeq = 0;
function checkHandle() {
  clearTimeout(handleTimer);
  const h = pp.handle;
  if (pp.mode === 'edit' && h === profile.handle) pp.handleState = 'mine';
  else if (!h) pp.handleState = '';
  else if (h.length < HANDLE_MIN) pp.handleState = 'short';
  else if (!HANDLE_RE.test(h)) pp.handleState = 'invalid';
  else {
    pp.handleState = 'checking';
    const seq = ++handleSeq;
    handleTimer = setTimeout(async () => {
      const { data, error } = await supabase.from('profiles').select('id').eq('handle', h).maybeSingle();
      if (seq !== handleSeq || view !== 'passport') return; // 已有更新的输入
      pp.handleState = error ? '' : data ? 'taken' : 'free';
      refreshPassportBits();
    }, 300);
  }
  refreshPassportBits();
}

async function submitPassport(form) {
  const say = msg => { form.querySelector('.au-msg').textContent = msg; };
  const name = pp.name.trim();
  if (!handleLockedUntil()) {
    if (pp.handle.length < HANDLE_MIN || pp.handle.length > HANDLE_MAX) return say(t('pp.length', { min: HANDLE_MIN, max: HANDLE_MAX })), $('#ppHandle').focus();
    if (!HANDLE_RE.test(pp.handle)) return say(t('pp.needHandle')), $('#ppHandle').focus();
    if (pp.handleState === 'taken') return say(t('pp.taken')), $('#ppHandle').focus();
  }
  if (!name) return say(t('pp.needName')), $('#ppName').focus();
  if (!pp.country) return say(t('pp.needCountry')), $('#ppCountry').focus();
  if (pp.birthday && (pp.birthday < '1900-01-01' || pp.birthday > today())) return say(t('pp.badBirthday')), $('#ppBirthday').focus();
  // 出生地：输入框清空 = 不填；输入了但没从候选里选 = 提示
  const bp = $('#ppBirthplace').value.trim();
  if (!bp) pp.birthplace = '';
  else if (bp !== cityLabel(pp.birthplace)) return say(t('pp.needCity')), $('#ppBirthplace').focus();

  const button = form.querySelector('.au-submit');
  button.disabled = true;
  const uid = session.user.id;
  // 头像只在注册时随资料提交；之后只能经由抽取（accept_avatar）更换
  const fields = { name, country: pp.country, ...(pp.mode === 'create' ? { avatar: pp.avatar } : {}) };
  if (!handleLockedUntil()) fields.handle = pp.handle;
  try {
    const pub = pp.mode === 'create'
      ? await supabase.from('profiles').insert({ id: uid, ...fields }).select().single()
      : await supabase.from('profiles').update(fields).eq('id', uid).select().single();
    if (pub.error) {
      if (pub.error.code === '23505') { pp.handleState = 'taken'; refreshPassportBits(); return say(t('pp.justTaken')); }
      if (pub.error.message?.includes('HANDLE_COOLDOWN')) return say(t('pp.locked', { date: pub.error.details }));
      return say(t('saveFailed', { msg: pub.error.message }));
    }
    if (pp.birthday || birthday || pp.birthplace || birthplace) {
      const row = { id: uid, birthday: pp.birthday || null };
      if (pp.birthplace || birthplace) row.birthplace = pp.birthplace || null; // 还没执行 0013 时没有这一列
      const priv = await supabase.from('profile_private').upsert(row);
      if (priv.error) return say(t('pp.birthdayFailed', { msg: priv.error.message }));
    }
    profile = pub.data;
    birthday = pp.birthday;
    if (birthplace !== pp.birthplace) {
      birthplace = pp.birthplace;
      document.dispatchEvent(new CustomEvent('birthplace:change', { detail: birthplace }));
    }
    if (pp.mode === 'create') welcome = 'signup';
    pp = null;
    renderMe();
    accountReady();
  } finally {
    button.disabled = false;
  }
}

function closePassport() {
  if (pp?.mode !== 'edit') return;
  pp = null;
  hideGate();
}

// ---------- 顶栏头像 + 个人资料面板 ----------
const GUEST_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="9.5" r="3.6" /><path d="M5.5 19.5c1-3.3 3.4-5 6.5-5s5.5 1.7 6.5 5" /></svg>';

// 头像面板里的「语言」：放在二级面板里，主界面保持简洁
const langRow = () => `<div class="me-lang"><span>${t('language')}${lang === 'zh' ? ' · Language' : ''}</span>${langSwitch()}</div>`;

function renderMe() {
  $('#meAvatar').innerHTML = profile ? `<img src="${avatarUrl(profile.avatar)}" alt="" />` : GUEST_SVG;
  const panel = $('#drop-me');
  if (!profile) {
    panel.innerHTML = `<div class="me-card"><span class="avatar avatar-lg">${GUEST_SVG}</span><b>${t('me.guest')}</b><span>${t('me.signedOut')}</span></div>${langRow()}`;
    return;
  }
  const country = countries.find(c => c.id === profile.country);
  panel.innerHTML = `
    <div class="me-card">
      <span class="avatar avatar-lg"><img src="${avatarUrl(profile.avatar)}" alt="" /></span>
      <b>${escapeHtml(profile.name)}</b>
      <span class="me-handle">@${escapeHtml(profile.handle)}${country ? ` · ${escapeHtml(country.name)}` : ''}</span>
    </div>
    <button type="button" class="me-settings" data-open-settings data-close-drop>
      <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>
      <span><b>${t('st.title')}</b><small>${t('st.entrySub')}</small></span><i aria-hidden="true">›</i>
    </button>
    <div id="meInbox"></div>
    <div class="me-actions">
      <button type="button" data-pp-edit data-close-drop>${t('me.edit')}</button>
      <button type="button" data-signout data-close-drop>${t('me.signout')}</button>
    </div>
    <p class="me-email">${escapeHtml(session?.user.email || '')}</p>`;
  document.dispatchEvent(new Event('me:render')); // 让「收到的评论」重新填进来
}

// ---------- 数据导出与注销（GDPR 第 15、17、20 条） ----------
// 打卡和照片用「足迹」里的导出备份；这里导出账号、好友、评论、私信
async function exportAccount(button) {
  button.disabled = true;
  try {
    const uid = session.user.id;
    const all = async query => {
      const rows = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await query().range(from, from + 999);
        if (error) throw error;
        rows.push(...data);
        if (data.length < 1000) return rows;
      }
    };
    const [friendships, messages, comments, checkins, groups, groupMessages, feedMutes] = await Promise.all([
      all(() => supabase.from('friendships').select('*').order('created_at')),
      all(() => supabase.from('messages').select('*').order('created_at')),
      all(() => supabase.from('comments').select('*').eq('author', uid).order('created_at')),
      all(() => supabase.from('checkins').select('*').eq('user_id', uid).eq('deleted', false).order('created_at')),
      // 群聊：所在的群和成员，以及自己在群里发的消息（还没执行 0010 时为空）
      all(() => supabase.from('chat_groups').select('*, group_members(*)').order('created_at')).catch(() => []),
      all(() => supabase.from('group_messages').select('*').eq('sender', uid).order('created_at')).catch(() => []),
      // 不看动态的好友（还没执行 0015 时为空）
      all(() => supabase.from('feed_mutes').select('muted, created_at').order('created_at')).catch(() => []),
    ]);
    const { user } = session;
    const data = {
      exported_at: new Date().toISOString(),
      account: { id: user.id, email: user.email, created_at: user.created_at, email_confirmed_at: user.email_confirmed_at,
        terms_version: user.user_metadata?.terms_version ?? null, terms_accepted_at: user.user_metadata?.terms_accepted_at ?? null },
      profile, private: { birthday: birthday || null, birthplace: birthplace || null },
      checkins, friendships, comments, messages, groups, group_messages: groupMessages, feed_mutes: feedMutes,
      note: 'Photos are included in the backup exported from the Map panel. 照片请用「足迹」里的「导出备份」。',
    };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = `dear-elsewhere-${profile.handle}-${today()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) {
    alert(t('me.exportFailed', { msg: err.message || err }));
  } finally {
    button.disabled = false;
  }
}

async function deleteAccount() {
  const yes = await askLetter({
    title: t('me.deleteTitle'), body: t('me.deleteBody', { handle: escapeHtml(profile.handle) }),
    ok: t('me.deleteOk'), cancel: t('pp.cancel'),
  });
  if (!yes) return;
  const uid = session.user.id;
  showGate('checking');
  try {
    // 先删 Storage 里的照片（SQL 删不了），再删账号，数据库里的其余数据随外键级联删除
    // 服务端发现还有照片会拒绝（PHOTOS_REMAIN）：多半是后台同步刚好又传上来一张，再清一轮
    for (let attempt = 0; ; attempt++) {
      for (;;) {
        const { data, error } = await supabase.storage.from('photos').list(uid, { limit: 1000 });
        if (error) throw error;
        if (!data.length) break;
        const { error: rmError } = await supabase.storage.from('photos').remove(data.map(f => `${uid}/${f.name}`));
        if (rmError) throw rmError;
      }
      const { error } = await supabase.rpc('delete_my_account');
      if (!error) break;
      if (attempt < 2 && error.message?.includes('PHOTOS_REMAIN')) continue;
      throw error;
    }
  } catch (err) {
    return showGate('login', t('me.deleteFailed', { msg: err.message || err }));
  }
  // 本机缓存也一起清掉
  indexedDB.deleteDatabase(`mymap-${uid}`);
  try {
    Object.keys(localStorage).filter(k => k.startsWith(`mymap:${uid}:`)).forEach(k => localStorage.removeItem(k));
  } catch { /* 隐私模式 */ }
  await supabase.auth.signOut({ scope: 'local' });
  alert(t('me.deleted'));
  location.reload();
}

// ---------- 事件 ----------
document.addEventListener('click', async e => {
  const go = e.target.closest('#auth [data-go]');
  if (go) return showGate(go.dataset.go);
  if (e.target.closest('[data-resend]')) {
    const { error } = await supabase.auth.resend({ type: 'signup', email, options: { emailRedirectTo: redirectTo() } });
    return showGate('check-email', error ? authError(error) : t('au.resent'));
  }
  if (e.target.closest('[data-signout]')) {
    pp = null;
    await supabase.auth.signOut();
    return;
  }
  if (e.target.closest('[data-export-account]')) return exportAccount(e.target.closest('[data-export-account]'));
  if (e.target.closest('[data-delete-account]')) return deleteAccount();
  if (e.target.closest('[data-pp-edit]')) return openPassport('edit');
  if (e.target.closest('[data-pp-close]')) return closePassport();
  if (e.target.closest('[data-pp-random]') && pp?.mode === 'create') {
    pp.avatar = randomOf(COMMON.filter(id => id !== pp.avatar));
    return refreshPassportBits();
  }
  if (e.target.closest('[data-draw]')) return drawAvatar();
  if (e.target.closest('[data-draw-use]')) return useDraw();
  if (e.target.closest('[data-draw-keep]')) return keepMine();
  const city = e.target.closest('[data-city]');
  if (city) return pickCity(city.dataset.city);
});

// 登录页：重新输入时清掉上一次的错误提示
document.addEventListener('input', e => {
  const form = e.target.closest('.au-form');
  if (form) form.querySelector('.au-msg').textContent = '';
});

document.addEventListener('submit', e => {
  if (e.target.matches('.au-form')) { e.preventDefault(); submitLetter(e.target); }
  if (e.target.matches('.pp-page')) { e.preventDefault(); submitPassport(e.target); }
});

document.addEventListener('input', e => {
  if (!pp || !e.target.closest('.pp-page')) return;
  const { name, value } = e.target;
  e.target.closest('.pp-page').querySelector('.au-msg').textContent = '';
  if (name === 'handle') {
    pp.handle = value.toLowerCase().replace(/\s/g, '').slice(0, HANDLE_MAX); // 粘贴超长时截断
    if (value !== pp.handle) e.target.value = pp.handle;
    return checkHandle();
  }
  if (e.target.id === 'ppCountry') {
    countryActive = 0; // 输入只是搜索，没选中候选前保留原来的国家
    return showCountryOptions();
  }
  if (e.target.id === 'ppBirthplace') {
    cityActive = 0;
    return showCityOptions();
  }
  if (name in pp) { pp[name] = value; refreshPassportBits(); }
});

// 国家候选：方向键选择、回车确认、Esc 收起；失焦时只认列表里的国家
document.addEventListener('keydown', e => {
  if (e.target.id !== 'ppCountry') return;
  const list = $('#ppCountryList');
  const options = [...list.querySelectorAll('[data-country]')];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (list.hidden) return showCountryOptions();
    countryActive = (countryActive + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % Math.max(1, options.length);
    showCountryOptions();
  } else if (e.key === 'Enter' && !list.hidden && options[countryActive]) {
    e.preventDefault();
    pickCountry(options[countryActive].dataset.country);
  } else if (e.key === 'Escape' && !list.hidden) {
    e.stopPropagation();
    hideCountryOptions();
  }
}, true);
// 聚焦或再次点击时全选，直接输入就是重新搜索
const reopenCountry = e => {
  if (e.target.id !== 'ppCountry') return;
  e.target.select();
  showCountryOptions();
};
document.addEventListener('focusin', reopenCountry);
document.addEventListener('click', e => $('#ppCountryList')?.hidden && reopenCountry(e));
document.addEventListener('focusout', e => {
  if (e.target.id !== 'ppCountry' || !pp) return;
  const typed = e.target.value.trim().toLowerCase();
  const exact = countries.find(c => [c.name, c.zh, c.en, c.id].some(v => v.toLowerCase() === typed));
  if (exact) pp.country = exact.id;
  e.target.value = countryLabel(pp.country);
  hideCountryOptions();
  refreshPassportBits();
});
// 用 mousedown 选择，抢在输入框失焦之前
document.addEventListener('mousedown', e => {
  const li = e.target.closest('#ppCountryList [data-country]');
  if (!li) return;
  e.preventDefault();
  pickCountry(li.dataset.country);
});

// 出生地候选：同上；清空输入框 = 不填
document.addEventListener('keydown', e => {
  if (e.target.id !== 'ppBirthplace') return;
  const list = $('#ppBirthplaceList');
  const options = [...list.querySelectorAll('[data-city]')];
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && options.length) {
    e.preventDefault();
    cityActive = (cityActive + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    showCityOptions();
  } else if (e.key === 'Enter' && !list.hidden && options[cityActive]) {
    e.preventDefault();
    pickCity(options[cityActive].dataset.city);
  } else if (e.key === 'Escape' && !list.hidden) {
    e.stopPropagation();
    hideCityOptions();
  }
}, true);
document.addEventListener('focusout', e => {
  if (e.target.id !== 'ppBirthplace' || !pp) return;
  if (!e.target.value.trim()) pp.birthplace = '';
  e.target.value = cityLabel(pp.birthplace);
  hideCityOptions();
});
document.addEventListener('mousedown', e => {
  const li = e.target.closest('#ppBirthplaceList [data-city]');
  if (!li) return;
  e.preventDefault();
  pickCity(li.dataset.city);
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && view === 'passport') closePassport();
});
