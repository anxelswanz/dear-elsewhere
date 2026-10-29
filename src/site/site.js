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

// ---------- 旅伴图鉴：编号范围与 scripts/build-avatars.mjs、0013 迁移里的头像目录一致 ----------
const TIERS = {
  0: { prefix: 'a', count: 130, odds: '70%', zh: '普通', en: 'Common' },
  1: { prefix: 'p', count: 50, odds: '20%', zh: '高级', en: 'Premium' },
  2: { prefix: 'r', count: 40, odds: '8%', zh: '稀有', en: 'Rare' },
  3: { prefix: 'l', count: 16, odds: '2%', zh: '传说', en: 'Legendary' },
};
const SHOWN = 12; // 每档展示的数量
const dex = document.querySelector('.dex');
const avatarUrl = (prefix, n) => `/avatars/${prefix}${String(n).padStart(2, '0')}.svg`;

function showTier(tier) {
  const t = TIERS[tier];
  dex.dataset.tier = tier;
  dex.querySelectorAll('[data-tier]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tier === String(tier))));
  // 在这一档里均匀取 SHOWN 个，第一个放大展示
  const step = t.count / SHOWN;
  const ids = Array.from({ length: Math.min(SHOWN, t.count) }, (_, i) => Math.floor(i * step) + 1);
  const hero = document.getElementById('dexHero');
  hero.src = avatarUrl(t.prefix, ids[0]);
  document.getElementById('dexOdds').textContent = `${root.dataset.show === 'en' ? t.en : t.zh} · ${t.odds}`;
  document.getElementById('dexCount').textContent = root.dataset.show === 'en' ? `${t.count} companions` : `共 ${t.count} 位`;
  const grid = document.getElementById('dexGrid');
  grid.replaceChildren(...ids.map(n => {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `<img src="${avatarUrl(t.prefix, n)}" alt="" loading="lazy" />`;
    b.addEventListener('click', () => { hero.src = avatarUrl(t.prefix, n); });
    return b;
  }));
}

if (dex) {
  dex.querySelectorAll('[data-tier]').forEach(b => b.addEventListener('click', () => showTier(b.dataset.tier)));
  buttons.forEach(b => b.addEventListener('click', () => showTier(dex.dataset.tier)));
  showTier(2);
}

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
