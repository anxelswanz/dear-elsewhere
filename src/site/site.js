// 官网（/about/）：字体、样式，以及语言切换和邮戳日期
// 语言与主站共用 localStorage 的 mymap:lang，在官网切换后进入主站也是同一种语言
import '@fontsource-variable/fraunces/opsz.css';
import '@fontsource-variable/fraunces/opsz-italic.css';
import '@fontsource/noto-serif-sc/500.css';
import '@fontsource/noto-serif-sc/700.css';
import '../styles/themes.css';
import './site.css';
import { track } from '../track.js';

// 邮件链接（验证邮箱、重置密码）回跳到官网时，带着登录信息转到应用里处理
if (/(^|[#&])(access_token|error_code)=/.test(location.hash)) location.replace(`${import.meta.env.BASE_URL}app/${location.hash}`);

const root = document.documentElement;
const buttons = document.querySelectorAll('[data-set]');

function show(next) {
  root.dataset.show = next;
  root.lang = next === 'en' ? 'en' : 'zh-CN';
  buttons.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.set === next)));
}

show(root.dataset.show || 'zh');
buttons.forEach(b => b.addEventListener('click', () => {
  show(b.dataset.set);
  try { localStorage.setItem('mymap:lang', b.dataset.set); } catch { /* 隐私模式 */ }
}));

// 邮戳上盖今天的日期
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const now = new Date();
document.querySelectorAll('[data-today]').forEach(el => {
  el.textContent = `${String(now.getDate()).padStart(2, '0')} · ${MONTHS[now.getMonth()]} · ${now.getFullYear()}`;
});

// ---------- 旅伴们：从全部旅伴里随机摆出一批，点一下放大；不分档、不提概率 ----------
// 编号范围与 scripts/build-avatars.mjs、0013 迁移里的头像目录一致
const ids = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1).padStart(2, '0')}`);
const COMPANIONS = [...ids('a', 130), ...ids('p', 50), ...ids('r', 40), ...ids('l', 16)];
const SHOWN = 12;
const avatarUrl = id => `/avatars/${id}.svg`;

function shuffleCompanions() {
  const grid = document.getElementById('dexGrid');
  const hero = document.getElementById('dexHero');
  if (!grid || !hero) return;
  const picked = [...COMPANIONS].sort(() => Math.random() - .5).slice(0, SHOWN);
  const show = id => { hero.src = avatarUrl(id); hero.style.animation = 'none'; void hero.offsetWidth; hero.style.animation = ''; };
  show(picked[0]);
  grid.replaceChildren(...picked.map(id => {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `<img src="${avatarUrl(id)}" alt="" loading="lazy" />`;
    b.addEventListener('click', () => show(id));
    return b;
  }));
}
shuffleCompanions();
document.getElementById('dexShuffle')?.addEventListener('click', shuffleCompanions);

// ---------- 使用统计：官网的浏览和「进入」（匿名，不带任何标识） ----------
track('site_view', { lang: root.dataset.show || 'zh' });
document.addEventListener('click', e => {
  const a = e.target.closest('a[href="/app/"]');
  if (a) track('site_cta', { from: a.closest('.nav') ? 'nav' : a.closest('.hero') ? 'hero' : a.closest('.closing') ? 'closing' : 'footer' });
}, true);

// ---------- 进入软件：寄出一封航空信 ----------
// 信纸从点击处铺满屏幕，邮票盖在中央，然后跳转；软件页开头是同样的画面，接着把信纸收走（public/boot/arrive.js）
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
document.addEventListener('click', e => {
  const a = e.target.closest('a[href="/app/"]');
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  if (reduced.matches) return;
  e.preventDefault();
  const warp = document.createElement('div');
  warp.className = 'warp';
  warp.style.setProperty('--cx', `${e.clientX || innerWidth / 2}px`);
  warp.style.setProperty('--cy', `${e.clientY || innerHeight / 2}px`);
  warp.innerHTML = '<i class="warp-ink"></i><img src="/brand/stamp@2x.png" alt="" />';
  document.body.append(warp);
  try { sessionStorage.setItem('de:arrive', String(Date.now())); } catch { /* 隐私模式 */ }
  setTimeout(() => { location.href = a.href; }, 820);
});
// 提前取好软件页，点进入后跳转更快（写在 HTML 里会被 Vite 当成要打包的资源）
const prefetch = document.createElement('link');
prefetch.rel = 'prefetch';
prefetch.href = '/app/';
document.head.append(prefetch);
// 从软件按返回键回来时，页面可能是从缓存里恢复的，把盖住页面的信纸拿掉
addEventListener('pageshow', e => { if (e.persisted) document.querySelectorAll('.warp').forEach(w => w.remove()); });

// ---------- 首屏航线：宽屏按比例裁切，飞机才不会被拉扁；窄屏首屏很高，改回拉伸，只留虚线 ----------
const route = document.querySelector('.hero-route');
const narrow = matchMedia('(max-width: 720px)');
function fitRoute() {
  root.classList.toggle('narrow', narrow.matches);
  route?.setAttribute('preserveAspectRatio', narrow.matches ? 'none' : 'xMidYMid slice');
}
fitRoute();
narrow.addEventListener('change', fitRoute);

// ---------- 滚动浮现：每组元素依次浮上来，浮完去掉 .rv，不影响各自的悬停效果 ----------
const GROUPS = ['.features article', '.sec-head', '.steps > li', '.themes', '.timeline > li', '.dex', '.ticket', '.ledger', '.rule-card', '.legal-link', '.parcel', '.faq details', '.closing-card'];
if (!reduced.matches && 'IntersectionObserver' in window) {
  const io = new IntersectionObserver(entries => entries.forEach(({ isIntersecting, target }) => {
    if (!isIntersecting) return;
    io.unobserve(target);
    target.classList.add('in');
    setTimeout(() => target.classList.remove('rv', 'in'), 900 + Number(target.style.getPropertyValue('--d') || 0) * 80);
  }), { rootMargin: '0px 0px -8% 0px' });
  GROUPS.forEach(sel => document.querySelectorAll(sel).forEach((el, i, all) => {
    // 同一行里的元素错开出场；超过 6 个的不再加长等待
    el.style.setProperty('--d', String(Math.min(i % (all.length > 4 ? 4 : all.length), 6)));
    el.classList.add('rv');
    io.observe(el);
  }));
}
