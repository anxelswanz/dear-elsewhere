// 官网（/about/）：字体、样式，以及语言切换和邮戳日期
// 语言与主站共用 localStorage 的 mymap:lang，在官网切换后进入主站也是同一种语言
import '@fontsource-variable/fraunces/opsz.css';
import '@fontsource-variable/fraunces/opsz-italic.css';
import '@fontsource/noto-serif-sc/500.css';
import '@fontsource/noto-serif-sc/700.css';
import '../styles/themes.css';
import './site.css';

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
