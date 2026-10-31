// 新消息提示音：Web Audio 现场合成，不需要音频文件（也不用改 CSP）
//   私信  上行两声铃音（像信件投进邮筒）
//   群聊  三声更轻快的琶音
//   正在看这个会话  一声很轻的「嗒」
// 浏览器要求用户先和页面交互过才能出声，所以在第一次点击/按键时才创建 AudioContext。
// 开关在 设置 → 通知，存在本机 localStorage（mymap:sound）。

const KEY = 'mymap:sound';
let ctx = null;
let lastAt = 0;

export const soundOn = () => {
  try { return localStorage.getItem(KEY) !== '0'; } catch { return true; }
};
export function setSound(on) {
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* 隐私模式 */ }
  if (on) play('dm', { force: true }); // 打开时试听一下
}

function unlock() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx ||= new AC();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
}
for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, unlock, { capture: true, passive: true });

// 一声铃音：正弦基音 + 两个泛音，快速起音、指数衰减，再带一点向上滑的音高
function bell(at, freq, { vol = 0.18, len = 0.55 } = {}) {
  const out = ctx.createGain();
  out.gain.setValueAtTime(0.0001, at);
  out.gain.exponentialRampToValueAtTime(vol, at + 0.012);
  out.gain.exponentialRampToValueAtTime(0.0001, at + len);
  out.connect(ctx.destination);
  for (const [mul, gain] of [[1, 1], [2.01, 0.28], [3.98, 0.08]]) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq * mul * 0.985, at);
    osc.frequency.exponentialRampToValueAtTime(freq * mul, at + 0.05);
    g.gain.value = gain;
    osc.connect(g).connect(out);
    osc.start(at);
    osc.stop(at + len + 0.05);
  }
}

const PATTERNS = {
  dm: [[0, 880], [0.11, 1318.5]],                      // A5 → E6
  group: [[0, 784], [0.08, 987.8], [0.16, 1318.5]],    // G5 → B5 → E6
  soft: [[0, 1174.7, { vol: 0.07, len: 0.25 }]],       // D6，很轻
};

export function play(kind = 'dm', { force = false } = {}) {
  if (!force && !soundOn()) return;
  if (!ctx || ctx.state !== 'running') return; // 还没交互过：浏览器不让出声
  const now = performance.now();
  if (!force && now - lastAt < 1200) return; // 一下子来很多条只响一次
  lastAt = now;
  const t0 = ctx.currentTime + 0.01;
  // 每次音高随机偏一点点，连续几条听起来不机械
  const shift = 2 ** ((Math.random() - 0.5) * 0.08);
  for (const [dt, f, opt] of PATTERNS[kind] || PATTERNS.dm) bell(t0 + dt, f * shift, opt);
}
