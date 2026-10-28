// 账号：登录 / 注册 / 找回密码（一封航空信），首次登录填写「旅行护照」资料，
// 以及顶栏头像和「个人资料」面板。必须登录才能使用地图。
import { supabase, supabaseReady } from './supabase.js';
import { playWelcome } from './welcome.js';
import { t, lang, localName, langSwitch } from './i18n.js';

const AVATAR_COUNT = 60;
const AVATARS = Array.from({ length: AVATAR_COUNT }, (_, i) => `a${String(i + 1).padStart(2, '0')}`);
export const avatarUrl = id => `${import.meta.env.BASE_URL}avatars/${id}.svg`;
const HANDLE_MIN = 3, HANDLE_MAX = 20;
const HANDLE_RE = new RegExp(`^[a-z0-9_]{${HANDLE_MIN},${HANDLE_MAX}}$`);
const HANDLE_COOLDOWN_DAYS = 30;

const $ = sel => document.querySelector(sel);
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => new Date().toISOString().slice(0, 10);

let session = null;
let profile = null;      // public.profiles 中自己的一行
let birthday = '';       // public.profile_private，仅自己可见
let countries = [];      // [{ id, name, en }]，按中文名排序
let view = 'checking';
let email = '';          // 在登录 / 注册 / 找回密码之间切换时保留
let resolveReady;        // 第一次拿到完整资料时，把账号交给地图
let readyUser = null;
let welcome = null;      // 'login' | 'signup'：只在主动登录、刚签发护照时播放欢迎动画，刷新页面不播

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

  supabase.auth.onAuthStateChange((event, s) => {
    if (event === 'PASSWORD_RECOVERY') { session = s; return showGate('reset'); }
    if (!['INITIAL_SESSION', 'SIGNED_IN', 'SIGNED_OUT'].includes(event)) return;
    if (event === 'SIGNED_IN' && s?.user.id === session?.user.id && profile) return; // 切回标签页时也会触发
    if (view === 'reset') return;
    // 回调里不能直接 await supabase 的其他请求，放到下一轮执行
    setTimeout(() => handleSession(s), 0);
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
  renderMe();
  if (!s) return showGate('login');
  showGate('checking');
  const uid = s.user.id;
  const [pub, priv] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', uid).maybeSingle(),
    supabase.from('profile_private').select('birthday').eq('id', uid).maybeSingle(),
  ]);
  if (pub.error) return showGate('login', t('au.loadFailed', { msg: pub.error.message }));
  profile = pub.data;
  birthday = priv.data?.birthday || '';
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
  signup: { lead: t('au.signupLead'), submit: t('au.signup'), fields: ['email', 'password', 'password2'] },
  forgot: { lead: t('au.forgotLead'), submit: t('au.sendReset'), fields: ['email'] },
  reset: { lead: t('au.resetLead'), submit: t('au.saveNew'), fields: ['password', 'password2'] },
};

const FIELD = {
  email: () => `<label class="au-field"><span>${t('au.email')}</span>
    <input name="email" type="email" autocomplete="email" required value="${escapeHtml(email)}" placeholder="you@example.com" /></label>`,
  password: v => `<label class="au-field"><span>${t(v === 'reset' ? 'au.newPassword' : 'au.password')}</span>
    <input name="password" type="password" minlength="6" required autocomplete="${v === 'login' ? 'current-password' : 'new-password'}" placeholder="${v === 'login' ? '' : t('au.min6')}" /></label>`,
  password2: () => `<label class="au-field"><span>${t('au.confirm')}</span>
    <input name="password2" type="password" minlength="6" required autocomplete="new-password" /></label>`,
};

const brandHtml = `
  <header class="au-head">
    <svg class="brand-mark" viewBox="0 0 40 40" aria-hidden="true">
      <rect class="bm-perf" x="3" y="3" width="34" height="34" rx="2" />
      <rect class="bm-face" x="7" y="7" width="26" height="26" rx="1" />
      <path class="bm-pin" d="M20 29s-6-5.6-6-10a6 6 0 0 1 12 0c0 4.4-6 10-6 10z" />
      <circle class="bm-dot" cx="20" cy="19" r="2" />
    </svg>
    <div><h2>${t('brand')}</h2><p>${t('brandSub')}</p></div>
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
        <p>${t('au.noConfigBody')}</p>
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
    </form></div></article>`;
  const first = stage.querySelector(email && view !== 'reset' ? 'input[name="password"]' : 'input');
  first?.focus();
}

function authError(err) {
  const m = err?.message || '';
  if (err?.code === 'invalid_credentials' || /invalid login/i.test(m)) return t('err.credentials');
  if (err?.code === 'email_not_confirmed' || /not confirmed/i.test(m)) return t('err.notConfirmed');
  if (err?.code === 'user_already_exists' || /already registered/i.test(m)) return t('err.exists');
  if (err?.code === 'weak_password' || /password should/i.test(m)) return t('err.weak');
  if (err?.code === 'same_password') return t('err.same');
  if (err?.status === 429 || /rate limit/i.test(m)) return t('err.rate');
  if (/fetch|network/i.test(m)) return t('err.network');
  return m || t('err.unknown');
}

const redirectTo = () => location.origin + location.pathname;

async function submitLetter(form) {
  const data = Object.fromEntries(new FormData(form));
  const say = msg => { form.querySelector('.au-msg').textContent = msg; };
  if ('email' in data) {
    email = data.email.trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) return say(t('err.emailFormat'));
  }
  if ('password' in data && data.password.length < 6) return say(t('err.pw6'));
  if ('password2' in data && data.password !== data.password2) return say(t('err.pwMatch'));

  const button = form.querySelector('.au-submit');
  button.disabled = true;
  try {
    if (view === 'login') {
      const { error } = await supabase.auth.signInWithPassword({ email, password: data.password });
      if (error) return say(authError(error));
      welcome = 'login';
      // 成功后由 onAuthStateChange 接手
    } else if (view === 'signup') {
      const { data: res, error } = await supabase.auth.signUp({ email, password: data.password, options: { emailRedirectTo: redirectTo() } });
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
let pp = null; // 正在编辑的护照 { mode, avatar, handle, name, country, birthday, handleState }

function openPassport(mode) {
  pp = mode === 'create'
    ? { mode, avatar: AVATARS[Math.floor(Math.random() * AVATAR_COUNT)], handle: '', name: '', country: '', birthday: '' }
    : { mode, avatar: profile.avatar, handle: profile.handle, name: profile.name, country: profile.country, birthday };
  pp.handleState = mode === 'create' ? '' : 'mine';
  view = 'passport';
  const gate = $('#auth');
  gate.hidden = false;
  gate.dataset.view = 'passport';
  renderPassport();
  $(mode === 'create' ? '#ppHandle' : '#ppName')?.focus();
}

// 30 天内改过 ID 时，返回下次可以修改的日期
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
        <span class="pp-emblem" aria-hidden="true">
          <svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="15" /><path d="M5 20h30M20 5c-5 4-5 26 0 30M20 5c5 4 5 26 0 30M8 12.5h24M8 27.5h24" /></svg>
        </span>
        <div><p>${t('pp.kicker')}</p><h2 id="ppTitle">${t(create ? 'pp.create' : 'pp.edit')}</h2></div>
        <span class="pp-no">No. ${escapeHtml((session?.user.id || '').slice(0, 8).toUpperCase())}</span>
      </header>

      <form class="pp-page" novalidate>
        <div class="pp-main">
          <div class="pp-photo">
            <span class="pp-photo-frame"><img id="ppPhoto" src="${avatarUrl(pp.avatar)}" alt="${t('pp.photoAlt')}" /></span>
            <button type="button" class="au-link" data-pp-random>${t('pp.random')}</button>
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
          </div>
        </div>

        <section class="pp-avatars">
          <p class="pp-section"><span>${t('pp.avatars')}</span><i>${AVATAR_COUNT} companions</i></p>
          <div class="pp-grid" role="radiogroup" aria-label="${t('pp.avatarGroup')}">
            ${AVATARS.map(id => `<button type="button" role="radio" aria-checked="${id === pp.avatar}" data-avatar="${id}" title="${id}">
              <img src="${avatarUrl(id)}" alt="" loading="lazy" /></button>`).join('')}
          </div>
        </section>

        <div class="pp-mrz" aria-hidden="true">${mrz().map(l => `<span>${escapeHtml(l)}</span>`).join('')}</div>

        <footer class="pp-foot">
          <p class="au-msg" role="alert"></p>
          ${create ? `<button type="button" class="au-link" data-signout>${t('pp.switch')}</button>` : `<button type="button" class="au-link" data-pp-close>${t('pp.cancel')}</button>`}
          <button class="au-submit" type="submit"><span>${t(create ? 'pp.issue' : 'pp.save')}</span><b aria-hidden="true">→</b></button>
        </footer>
      </form>
    </article>`;
}

// ID 长度计数：不足 3 位时标红
const handleCount = () => `${pp.handle.length}/${HANDLE_MAX}`;

// 局部更新，避免整页重绘打断输入
function refreshPassportBits() {
  const count = $('#ppHandleCount');
  count.value = handleCount();
  count.className = `pp-count${pp.handle && pp.handle.length < HANDLE_MIN ? ' short' : ''}${pp.handle.length >= HANDLE_MAX ? ' full' : ''}`;
  $('#ppPhoto').src = avatarUrl(pp.avatar);
  for (const b of document.querySelectorAll('[data-avatar]')) b.setAttribute('aria-checked', b.dataset.avatar === pp.avatar);
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

  const button = form.querySelector('.au-submit');
  button.disabled = true;
  const uid = session.user.id;
  const fields = { name, country: pp.country, avatar: pp.avatar };
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
    if (pp.birthday || birthday) {
      const priv = await supabase.from('profile_private').upsert({ id: uid, birthday: pp.birthday || null });
      if (priv.error) return say(t('pp.birthdayFailed', { msg: priv.error.message }));
    }
    profile = pub.data;
    birthday = pp.birthday;
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
    <label class="me-switch">
      <span><b>${t('me.public')}</b><small>${t(profile.map_public ? 'me.publicOn' : 'me.publicOff')}</small></span>
      <input type="checkbox" id="mapPublic" ${profile.map_public ? 'checked' : ''} /><i aria-hidden="true"></i>
    </label>
    ${langRow()}
    <div id="meInbox"></div>
    <div class="me-actions">
      <button type="button" data-pp-edit data-close-drop>${t('me.edit')}</button>
      <button type="button" data-signout data-close-drop>${t('me.signout')}</button>
    </div>
    <p class="me-email">${escapeHtml(session?.user.email || '')}</p>`;
  document.dispatchEvent(new Event('me:render')); // 让「收到的评论」重新填进来
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
  if (e.target.closest('[data-pp-edit]')) return openPassport('edit');
  if (e.target.closest('[data-pp-close]')) return closePassport();
  if (e.target.closest('[data-pp-random]')) {
    pp.avatar = AVATARS.filter(id => id !== pp.avatar)[Math.floor(Math.random() * (AVATAR_COUNT - 1))];
    return refreshPassportBits();
  }
  const avatar = e.target.closest('[data-avatar]');
  if (avatar) { pp.avatar = avatar.dataset.avatar; refreshPassportBits(); }
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

document.addEventListener('change', async e => {
  if (e.target.id !== 'mapPublic') return;
  const on = e.target.checked;
  const { data, error } = await supabase.from('profiles').update({ map_public: on }).eq('id', session.user.id).select().single();
  if (error) { e.target.checked = !on; return alert(t('saveFailed', { msg: error.message })); }
  profile = data;
  renderMe();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && view === 'passport') closePassport();
});
