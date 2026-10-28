// 欢迎动画：登录后盖一枚「欢迎回来」邮戳，注册后盖「护照已签发」印章；
// 一架纸飞机沿虚线航线飞过，最后像相机光圈一样收拢到邮戳上，露出地图。
// 点一下、按 Esc / 回车 都可以跳过；系统开启「减少动态效果」时只淡入淡出。

import { t } from './i18n.js';

const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const COPY = {
  login: {
    ring: () => t('wl.loginRing'),
    title: name => t('wl.loginTitle', { name }),
    sub: p => t('wl.loginSub', { handle: p.handle }),
  },
  signup: {
    ring: () => t('wl.signupRing'),
    title: name => t('wl.signupTitle', { name }),
    sub: (p, no) => t('wl.signupSub', { no }),
  },
};

const PLANE = '<path d="M2.5 12.5L21 4.5l-6 16-3.5-6.5z"/><path d="M11.5 14L21 4.5"/>';
// 从左下沿画面底部绕过文字，再从右侧爬升出去
const ROUTE = 'M-40 610 C 220 650, 480 600, 690 500 S 900 210, 1050 100';

export function playWelcome(kind, { profile, avatar, passportNo = '' }) {
  const copy = COPY[kind];
  const today = new Date();
  const date = `${String(today.getDate()).padStart(2, '0')} · ${today.toLocaleString('en', { month: 'short' }).toUpperCase()} · ${today.getFullYear()}`;
  const el = document.createElement('div');
  el.id = 'welcome';
  el.className = `wl-${kind}`;
  el.setAttribute('role', 'status');
  el.innerHTML = `
    <svg class="wl-route" viewBox="0 0 1000 640" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <!-- 虚线航线跟着飞机一段段画出来：用一条实线做遮罩 -->
      <mask id="wl-route-mask"><path class="wl-route-reveal" d="${ROUTE}" pathLength="1" /></mask>
      <path class="wl-route-line" d="${ROUTE}" mask="url(#wl-route-mask)" />
      <g class="wl-plane"><svg x="-18" y="-18" width="36" height="36" viewBox="0 0 24 24">${PLANE}</svg></g>
    </svg>
    <div class="wl-center">
      <div class="wl-stamp" aria-hidden="true">
        <svg viewBox="0 0 200 200">
          <defs><path id="wl-arc" d="M100,100 m-76,0 a76,76 0 1,1 152,0 a76,76 0 1,1 -152,0" /></defs>
          <circle class="wl-ring-outer" cx="100" cy="100" r="94" />
          <circle class="wl-ring-inner" cx="100" cy="100" r="60" />
          <text class="wl-ring-text"><textPath href="#wl-arc" textLength="468" lengthAdjust="spacing">${copy.ring()}</textPath></text>
        </svg>
        <span class="wl-avatar"><img src="${avatar}" alt="" /></span>
        <span class="wl-date">${date}</span>
        <i class="wl-ink"></i><i class="wl-ink wl-ink-2"></i>
      </div>
      <h2 class="wl-title">${escapeHtml(copy.title(profile.name))}</h2>
      <p class="wl-sub">${escapeHtml(copy.sub(profile, passportNo))}</p>
      <p class="wl-skip">${t('wl.skip')}</p>
    </div>`;
  document.body.append(el);

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  return new Promise(resolve => {
    let done = false, raf = 0;
    const timers = [];

    // 纸飞机沿着航线飞：取路径上的点和切线方向
    const path = el.querySelector('.wl-route-line');
    const plane = el.querySelector('.wl-plane');
    const len = path.getTotalLength();
    const start = performance.now() + 250, dur = 1700;
    const ease = t => 1 - (1 - t) ** 3;
    const fly = now => {
      const t = Math.min(1, Math.max(0, (now - start) / dur));
      const d = ease(t) * len;
      const p = path.getPointAtLength(d), q = path.getPointAtLength(Math.min(len, d + 1));
      const angle = Math.atan2(q.y - p.y, q.x - p.x) * 180 / Math.PI + 45; // 图标本身朝右上 45°
      plane.setAttribute('transform', `translate(${p.x} ${p.y}) rotate(${angle})`);
      plane.style.opacity = t <= 0 || t >= 1 ? 0 : 1;
      if (t < 1) raf = requestAnimationFrame(fly);
    };
    if (!reduced) raf = requestAnimationFrame(fly);

    const finish = () => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      cancelAnimationFrame(raf);
      removeEventListener('keydown', onKey, true);
      // 光圈收拢到邮戳中心
      const r = el.querySelector('.wl-stamp').getBoundingClientRect();
      el.style.setProperty('--cx', `${r.left + r.width / 2}px`);
      el.style.setProperty('--cy', `${r.top + r.height / 2}px`);
      el.classList.add('wl-out');
      setTimeout(() => { el.remove(); resolve(); }, reduced ? 300 : 750);
    };
    const onKey = e => {
      if (['Escape', 'Enter', ' '].includes(e.key)) { e.preventDefault(); e.stopImmediatePropagation(); finish(); }
    };
    el.addEventListener('click', finish);
    addEventListener('keydown', onKey, true);
    timers.push(setTimeout(finish, reduced ? 1400 : 3000));
  });
}
