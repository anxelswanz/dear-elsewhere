// 传说旅伴：烫金版画肖像（由 scripts/build-avatars.mjs 调用）
// 和品牌的「反白 · 深蓝底烫金」Logo、注册时的护照封皮同一套语言：
//   深色底 + 细密的防伪雕刻纹 → 金色邮戳环 → 圆形肖像窗（notionists 人物，黑线改成金箔，白底改成浅一档的底色）
//   → 下方月桂枝 + 一枚旅行徽记，顶上三颗星。头像在界面里会被裁成圆形，重要内容都在圆内
// 肖像窗是羊皮纸色、人物线条用这一枚的深底色（像浮雕宝石），缩到很小时也认得出是一张脸
import { createAvatar } from '@dicebear/core';
import { notionists } from '@dicebear/collection';

// 四种底色轮换：护照蓝、勃艮第、墨绿、夜紫；每种给出 外圈 / 中心（外圈色也用作人物线条）
const GROUNDS = [
  { edge: '#0f1f36', mid: '#22416b' },
  { edge: '#2a0d12', mid: '#5c1f28' },
  { edge: '#0c201a', mid: '#1f4636' },
  { edge: '#1a1230', mid: '#3a2a62' },
];

// 旅行徽记：24×24 的线条图标，画在金色小圆章上
const EMBLEMS = [
  '<path d="M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z"/>',                                // 指南针星
  '<path d="M3 11.5l18-7-5 16-4.5-6.5z M11.5 14l9.5-9.5"/>',                                               // 纸飞机
  '<rect x="3.5" y="6" width="17" height="12" rx="1.5"/><path d="M4 7l8 6 8-6"/>',                          // 信封
  '<path d="M2.5 19l6-10 4 6 2.5-3.5 6.5 7.5z"/>',                                                          // 山
  '<path d="M15.5 4a8 8 0 1 0 4.5 13.5A6.5 6.5 0 0 1 15.5 4z"/>',                                           // 新月
  '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>', // 太阳
  '<circle cx="12" cy="5" r="2"/><path d="M12 7v13M7 10h10M4.5 14a7.5 7.5 0 0 0 15 0"/>',                   // 锚
  '<path d="M9 21h6M10 21l.8-12h2.4L14 21M9.5 9h5l-1-3h-3z M12 3.5v2.5M5 7l3 1M19 7l-3 1"/>',             // 灯塔
  '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c-3 3-3 14 0 17M12 3.5c3 3 3 14 0 17"/>',     // 地球
  '<path d="M4 17l2-9 4 4 2-6 2 6 4-4 2 9z M4 20h16"/>',                                                    // 王冠
  '<circle cx="8" cy="12" r="3.5"/><path d="M11.5 12H21M17 12v3M20 12v2"/>',                                // 钥匙
  '<path d="M19 4C11 5 6 11 5 20M19 4c-1 7-5 11-11 12M9 15l-3-3"/>',                                        // 羽毛
  '<path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10z"/>',                        // 心
  '<path d="M12 3a6 6 0 0 1 6 6c0 3-2.5 5-4 6h-4c-1.5-1-4-3-4-6a6 6 0 0 1 6-6z M10 15l.5 3h3l.5-3 M10.5 18h3v2.5h-3z"/>', // 热气球
  '<path d="M2.5 14c2-2 4-2 6 0s4 2 6 0 4-2 6 0 M2.5 18.5c2-2 4-2 6 0s4 2 6 0 4-2 6 0 M12 4v7M9 7.5l3-3.5 3 3.5"/>', // 远洋
  '<path d="M12 3l7 9-7 9-7-9z M5 12h14"/>',                                                                // 宝石
];

// 种子：古往今来的旅行者（只用来生成随机样貌，不代表任何人的长相）
const SEEDS = [
  'Xuanzang', 'Ibn Battuta', 'Marco Polo', 'Xu Xiake', 'Isabella Bird', 'Matsuo Basho', 'Zheng He', 'Freya Stark',
  'Nellie Bly', 'Humboldt', 'Gertrude Bell', 'Tenzing', 'Amelia', 'Magellan', 'Ella Maillart', 'Faxian',
];

const round = n => Math.round(n * 100) / 100;

// 防伪雕刻纹：一圈旋转的椭圆叠成玫瑰花饰，外加几道细同心圆
function guilloche() {
  let s = '';
  for (let i = 0; i < 36; i++) s += `<ellipse cx="100" cy="100" rx="96" ry="38" transform="rotate(${i * 5} 100 100)"/>`;
  for (const r of [99, 93, 50]) s += `<circle cx="100" cy="100" r="${r}"/>`;
  return `<g fill="none" stroke="url(#gold)" stroke-width=".35" opacity=".22">${s}</g>`;
}

// 月桂枝：一根沿圆弧的枝干，叶子在枝干内外交替长出，左右对称
function laurel() {
  const R = 79, leaves = [], stems = [];
  const at = (deg, r = R) => [round(100 + r * Math.cos(deg * Math.PI / 180)), round(100 + r * Math.sin(deg * Math.PI / 180))];
  for (const side of [-1, 1]) {
    const [x0, y0] = at(90 + side * 30), [x1, y1] = at(90 + side * 96);
    stems.push(`<path d="M${x0} ${y0}A${R} ${R} 0 0 ${side > 0 ? 1 : 0} ${x1} ${y1}"/>`);
    for (let i = 0; i < 7; i++) {
      const deg = 90 + side * (36 + i * 9);           // 从正下方两侧往上长
      const out = i % 2 ? 1 : -1;                      // 内外交替
      const [x, y] = at(deg, R + out * 3.4);
      const tilt = round(deg + side * (out > 0 ? 40 : 70));
      leaves.push(`<ellipse cx="${x}" cy="${y}" rx="5.4" ry="2.1" transform="rotate(${tilt} ${x} ${y})"/>`);
    }
  }
  return `<g fill="none" stroke="url(#gold)" stroke-width="1.1" stroke-linecap="round">${stems.join('')}</g><g fill="url(#gold)">${leaves.join('')}</g>`;
}

const star = (x, y, r) => {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * .45 : r;
    pts.push(`${round(x + rr * Math.cos(a))},${round(y + rr * Math.sin(a))}`);
  }
  return `<polygon points="${pts.join(' ')}"/>`;
};

// notionists 的内容取出来，黑线换成深底色、白色的脸和衣服换成羊皮纸色；id 加前缀，避免同一页面多个头像的 mask 互相冲突
function portrait(seed, ink, prefix) {
  const svg = createAvatar(notionists, { seed, scale: 122, translateY: 9, bodyIconProbability: 0, gestureProbability: 0 }).toString();
  const inner = svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<metadata>[\s\S]*?<\/metadata>/, '');
  return inner
    .replaceAll('fill="#000"', `fill="${ink}"`).replaceAll('stroke="#000"', `stroke="${ink}"`)
    .replaceAll('fill="#fff"', 'fill="#fbf4e1"')
    .replace(/id="([^"]+)"/g, `id="${prefix}$1"`).replace(/url\(#(?!gold)([^)]+)\)/g, `url(#${prefix}$1)`);
}

export function legendAvatar(i) {
  const g = GROUNDS[i % GROUNDS.length];
  const p = `l${i}-`;
  const gold = `<linearGradient id="gold" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#fbeab0"/><stop offset=".35" stop-color="#e2bd62"/><stop offset=".6" stop-color="#b98a33"/><stop offset="1" stop-color="#f3d98f"/></linearGradient>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
<defs>${gold}
  <radialGradient id="${p}bg" cx=".5" cy=".42" r=".7"><stop offset="0" stop-color="${g.mid}"/><stop offset="1" stop-color="${g.edge}"/></radialGradient>
  <radialGradient id="${p}win" cx=".5" cy=".32" r=".8"><stop offset="0" stop-color="#f8eccd"/><stop offset=".7" stop-color="#ead6a6"/><stop offset="1" stop-color="#cfb173"/></radialGradient>
  <clipPath id="${p}clip"><circle cx="100" cy="94" r="60"/></clipPath>
</defs>
<rect width="200" height="200" fill="url(#${p}bg)"/>
${guilloche()}
<circle cx="100" cy="100" r="88" fill="none" stroke="url(#gold)" stroke-width="2.4"/>
<circle cx="100" cy="100" r="84" fill="none" stroke="url(#gold)" stroke-width=".8" stroke-dasharray="1.6 2.4"/>
${laurel()}
<g fill="url(#gold)">${star(100, 22, 4.6)}${star(85, 25.5, 2.8)}${star(115, 25.5, 2.8)}</g>
<circle cx="100" cy="94" r="60" fill="url(#${p}win)"/>
<g clip-path="url(#${p}clip)"><svg x="40" y="34" width="120" height="120" viewBox="0 0 1744 1744">${portrait(SEEDS[i], g.edge, p)}</svg></g>
<circle cx="100" cy="94" r="60" fill="none" stroke="url(#gold)" stroke-width="2"/>
<circle cx="100" cy="94" r="63.5" fill="none" stroke="url(#gold)" stroke-width=".6"/>
<circle cx="100" cy="160" r="14" fill="url(#gold)" stroke="${g.edge}" stroke-width="1.5"/>
<g transform="translate(90 150) scale(.84)" fill="none" stroke="${g.edge}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${EMBLEMS[i % EMBLEMS.length]}</g>
</svg>`;
}
