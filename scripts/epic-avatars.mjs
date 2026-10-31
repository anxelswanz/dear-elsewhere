// 史诗旅伴：「Pixel Voyagers」像素旅人系列，40 位（由 scripts/build-avatars.mjs 调用）
// 灵感来自 NFT 头像：32×32 像素、每一位由几组「特征」组合而成（背景、肤色、帽子发型、眼睛、嘴、配饰），
// 胸前印着自己的编号。画风是原创的：正面的旅人 + 全息镭射底 + 像素星光，不模仿任何现有系列。
// 每个特征按编号错开取值，40 位的组合各不相同；头像在界面里会被裁成圆形，重要内容都在圆内

const W = 32;
const OUTLINE = '#1d1b2f';

// 全息底：三段渐变，按编号轮换
const HOLO = [
  ['#ff9de2', '#a0c4ff', '#9bf6ff'], ['#fdffb6', '#ffd6a5', '#ffadad'], ['#caffbf', '#9bf6ff', '#bdb2ff'],
  ['#2b1055', '#7597de', '#c2e9fb'], ['#f9f871', '#ff9671', '#d65db1'], ['#00c9a7', '#4d8076', '#c4fcef'],
  ['#845ec2', '#d65db1', '#ff6f91'], ['#0b132b', '#3a506b', '#5bc0be'],
];
const SKINS = ['#f6d3b3', '#e9b48a', '#c98b5e', '#8d5a3b', '#f1c9a5', '#ffe0bd'];
// 少数几位是特殊肤色：金像、月光
const SPECIAL_SKIN = { 7: '#e8c25a', 23: '#cfe3f7', 36: '#e8c25a' };
const HAIRS = ['#2a1d17', '#6b3e26', '#d9a441', '#c4302b', '#3d5a99', '#f2f2f2', '#7a4fb5'];
const SHIRTS = ['#1f4b8f', '#c4302b', '#3f6b52', '#e0a33a', '#6b4f8a', '#2f5d62', '#ef6f6c', '#22223b'];
const GOLD = '#f4c542', GOLD_DARK = '#b8860b';

// ---------- 画布 ----------
function canvas() {
  const px = new Map();
  const set = (x, y, c) => { if (x >= 0 && x < W && y >= 0 && y < W && c) px.set(`${x},${y}`, c); };
  const rect = (x0, y0, x1, y1, c) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, c); };
  const del = (x, y) => px.delete(`${x},${y}`);
  const has = (x, y) => px.has(`${x},${y}`);
  return { px, set, rect, del, has };
}

// 人物外面自动描一圈深色轮廓（只描上下左右相邻的空格）
function outline(fig) {
  const add = [];
  for (const key of fig.px.keys()) {
    const [x, y] = key.split(',').map(Number);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (!fig.has(x + dx, y + dy)) add.push([x + dx, y + dy]);
  }
  for (const [x, y] of add) fig.set(x, y, OUTLINE);
}

// 同一行相邻同色的像素合成一个 rect，文件小一些
function toRects(px) {
  const rows = new Map();
  for (const [key, c] of px) {
    const [x, y] = key.split(',').map(Number);
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push([x, c]);
  }
  let out = '';
  for (const [y, list] of rows) {
    list.sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < list.length;) {
      let j = i;
      while (j + 1 < list.length && list[j + 1][0] === list[j][0] + 1 && list[j + 1][1] === list[i][1]) j++;
      out += `<rect x="${list[i][0]}" y="${y}" width="${j - i + 1}" height="1" fill="${list[i][1]}"/>`;
      i = j + 1;
    }
  }
  return out;
}

// 颜色变深 / 变浅
function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const f = v => Math.max(0, Math.min(255, Math.round(k < 0 ? v * (1 + k) : v + (255 - v) * k)));
  return `#${[n >> 16, (n >> 8) & 255, n & 255].map(f).map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

// ---------- 身体 ----------
function body(f, skin, shirt) {
  f.rect(9, 25, 22, 25, shirt);
  f.rect(7, 26, 24, 26, shirt);
  f.rect(6, 27, 25, 31, shirt);
  f.rect(14, 22, 17, 25, skin);                       // 脖子
  for (const [x, y] of [[13, 25], [18, 25], [14, 26], [17, 26]]) f.set(x, y, shade(shirt, -0.35)); // 领口
  f.rect(9, 8, 22, 21, skin);                         // 头
  for (const [x, y] of [[9, 8], [22, 8], [9, 21], [22, 21]]) f.del(x, y);
  f.rect(8, 14, 8, 16, skin); f.rect(23, 14, 23, 16, skin); // 耳朵
  f.set(15, 17, shade(skin, -0.18)); f.set(16, 17, shade(skin, -0.18)); // 鼻子
  f.set(11, 18, shade(skin, -0.08)); f.set(20, 18, shade(skin, -0.08)); // 脸颊
}

// ---------- 帽子 / 发型 ----------
const hairCap = (f, c) => { f.rect(9, 7, 22, 10, c); f.rect(10, 6, 21, 6, c); f.set(9, 11, c); f.set(22, 11, c); };
const HATS = {
  beanie: (f, c) => {
    f.rect(9, 5, 22, 10, c); f.rect(10, 4, 21, 4, c); f.rect(8, 9, 23, 10, shade(c, -0.3));
    f.rect(15, 2, 16, 3, '#ffffff');
    for (let x = 10; x <= 21; x += 2) f.set(x, 6, shade(c, 0.25));
  },
  straw: f => {
    const straw = '#e8c77b', band = '#c4302b';
    f.rect(10, 4, 21, 8, straw); f.rect(11, 3, 20, 3, straw); f.rect(10, 7, 21, 7, band);
    f.rect(4, 9, 27, 10, straw); f.rect(6, 8, 25, 8, straw);
    for (let x = 5; x <= 26; x += 3) f.set(x, 10, shade(straw, -0.2));
  },
  captain: (f) => {
    f.rect(9, 5, 22, 8, '#f4f4f4'); f.rect(10, 4, 21, 4, '#f4f4f4'); f.rect(9, 9, 22, 9, '#1f2a44');
    f.rect(8, 10, 19, 10, '#11182b'); f.set(15, 6, GOLD); f.set(16, 6, GOLD); f.set(15, 7, GOLD_DARK); f.set(16, 7, GOLD_DARK);
  },
  headphones: (f, c, hair) => {
    hairCap(f, hair);
    f.rect(9, 4, 22, 4, c); f.set(8, 5, c); f.set(23, 5, c); f.rect(7, 6, 7, 11, c); f.rect(24, 6, 24, 11, c);
    f.rect(5, 12, 8, 17, c); f.rect(23, 12, 26, 17, c); f.rect(6, 13, 7, 16, shade(c, 0.35)); f.rect(24, 13, 25, 16, shade(c, 0.35));
  },
  bun: (f, c, hair) => { hairCap(f, hair); f.rect(13, 2, 18, 5, hair); f.del(13, 2); f.del(18, 2); f.rect(13, 6, 18, 6, c); },
  spiky: (f, c, hair) => {
    hairCap(f, hair);
    for (const x of [9, 12, 15, 18, 21]) { f.rect(x, 4, x + 1, 5, hair); f.set(x + (x % 2 ? 0 : 1), 3, hair); }
  },
  pilot: (f) => {
    const leather = '#7b4a2a';
    f.rect(9, 5, 22, 10, leather); f.rect(10, 4, 21, 4, leather); f.rect(8, 11, 9, 16, leather); f.rect(22, 11, 23, 16, leather);
    f.rect(9, 9, 22, 9, '#3b2a20');
    for (const x0 of [10, 17]) { f.rect(x0, 8, x0 + 4, 10, '#c0c8d2'); f.rect(x0 + 1, 9, x0 + 3, 9, '#6fb7ff'); }
  },
  beret: (f, c) => {
    f.rect(8, 6, 21, 9, c); f.rect(10, 5, 20, 5, c); f.rect(7, 8, 8, 9, c); f.set(16, 4, shade(c, -0.3)); f.set(16, 3, shade(c, -0.3));
  },
  flowers: (f, c, hair) => {
    hairCap(f, hair);
    [[10, 6], [13, 5], [16, 5], [19, 5], [21, 6]].forEach(([x, y], k) => {
      const petal = ['#ff7eb6', '#ffd166', '#7bdff2', '#ff9f68', '#c49bff'][k];
      f.set(x, y, petal); f.set(x + 1, y, petal); f.set(x, y - 1, petal); f.set(x + 1, y - 1, '#ffffff');
    });
  },
  astronaut: () => {}, // 头盔画在轮廓之后，见 helmet()
};
const HAT_ORDER = ['beanie', 'straw', 'captain', 'headphones', 'bun', 'spiky', 'pilot', 'beret', 'flowers', 'astronaut'];

// ---------- 眼睛 ----------
const EYES = {
  dots: f => { for (const x of [11, 19]) { f.rect(x, 14, x + 1, 15, OUTLINE); f.set(x, 14, '#ffffff'); } f.rect(11, 12, 12, 12, OUTLINE); f.rect(19, 12, 20, 12, OUTLINE); },
  sleepy: f => { f.rect(11, 15, 12, 15, OUTLINE); f.rect(19, 15, 20, 15, OUTLINE); },
  wink: f => { f.rect(11, 14, 12, 15, OUTLINE); f.set(11, 14, '#ffffff'); f.rect(19, 15, 20, 15, OUTLINE); f.set(18, 14, OUTLINE); },
  shades: f => { f.rect(10, 13, 21, 13, OUTLINE); f.rect(10, 14, 14, 15, OUTLINE); f.rect(17, 14, 21, 15, OUTLINE); f.set(11, 14, '#7a7a9a'); f.set(18, 14, '#7a7a9a'); },
  visor: f => {
    const neon = ['#ff4fd8', '#a855ff', '#4fd1ff', '#4fffb0'];
    for (let x = 9; x <= 22; x++) f.rect(x, 13, x, 15, neon[Math.floor((x - 9) / 3.5)]);
    f.rect(10, 13, 13, 13, '#ffffff');
  },
  round: f => {
    for (const x0 of [10, 17]) {
      f.rect(x0, 13, x0 + 3, 13, GOLD_DARK); f.rect(x0, 16, x0 + 3, 16, GOLD_DARK); f.rect(x0 - 1, 14, x0 - 1, 15, GOLD_DARK); f.rect(x0 + 4, 14, x0 + 4, 15, GOLD_DARK);
      f.rect(x0 + 1, 14, x0 + 2, 15, OUTLINE); f.set(x0 + 1, 14, '#ffffff');
    }
    f.rect(14, 14, 16, 14, GOLD_DARK);
  },
  stars: f => {
    for (const x of [11, 19]) { f.set(x, 13, GOLD); f.rect(x - 1, 14, x + 1, 14, GOLD); f.set(x, 15, GOLD); f.set(x + 1, 15, OUTLINE); }
  },
  monocle: f => {
    f.rect(11, 14, 12, 15, OUTLINE); f.set(11, 14, '#ffffff');
    f.rect(18, 13, 21, 13, GOLD); f.rect(18, 16, 21, 16, GOLD); f.rect(17, 14, 17, 15, GOLD); f.rect(22, 14, 22, 15, GOLD);
    f.rect(19, 14, 20, 15, OUTLINE); f.set(19, 14, '#bfe6ff'); f.rect(22, 17, 22, 21, GOLD_DARK);
  },
};
const EYE_ORDER = ['dots', 'shades', 'sleepy', 'visor', 'round', 'wink', 'stars', 'monocle'];

// ---------- 嘴 ----------
const MOUTHS = {
  smile: f => { f.rect(14, 19, 17, 19, OUTLINE); f.set(13, 18, OUTLINE); f.set(18, 18, OUTLINE); },
  grin: f => { f.rect(13, 19, 18, 20, OUTLINE); f.rect(14, 19, 17, 19, '#ffffff'); },
  o: f => { f.rect(15, 19, 16, 20, OUTLINE); },
  flat: f => { f.rect(14, 19, 17, 19, OUTLINE); },
  pipe: f => {
    f.rect(14, 19, 16, 19, OUTLINE);
    f.rect(17, 19, 20, 19, '#6b3e26'); f.rect(20, 18, 22, 21, '#6b3e26'); f.rect(21, 18, 21, 18, '#ff8c42');
  },
  gum: f => { f.rect(14, 19, 15, 19, OUTLINE); f.rect(16, 18, 19, 21, '#ff8fc7'); f.set(17, 18, '#ffd1ea'); },
};
const MOUTH_ORDER = ['smile', 'grin', 'pipe', 'o', 'gum', 'flat'];

// ---------- 配饰 ----------
const ACCESSORIES = {
  none: () => {},
  chain: f => { for (let x = 11; x <= 20; x++) f.set(x, x < 14 || x > 17 ? 26 : 27, GOLD); f.rect(15, 28, 16, 29, GOLD); f.set(15, 28, '#fff3b0'); },
  earring: f => { f.set(8, 17, GOLD); f.set(8, 18, GOLD_DARK); },
  scarf: (f, c) => { f.rect(10, 23, 21, 25, c); f.rect(18, 26, 20, 30, c); for (let x = 11; x <= 20; x += 3) f.set(x, 24, shade(c, 0.4)); },
  straps: f => { f.rect(9, 26, 10, 31, '#3b2a20'); f.rect(21, 26, 22, 31, '#3b2a20'); f.set(9, 29, GOLD); f.set(22, 29, GOLD); },
  camera: f => { f.rect(11, 25, 11, 27, OUTLINE); f.rect(20, 25, 20, 27, OUTLINE); f.rect(11, 27, 20, 31, '#3a3a3a'); f.rect(14, 28, 17, 30, '#cfd8e2'); f.rect(15, 29, 16, 29, OUTLINE); f.set(19, 28, '#ff5d5d'); },
};
const ACC_ORDER = ['chain', 'none', 'earring', 'scarf', 'straps', 'camera', 'chain', 'earring'];

// 太空头盔：圆环 + 一层透明的面罩反光（画在轮廓之后，不再被描边）
function helmet(top) {
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const d = Math.hypot(x + 0.5 - 15.5, y + 0.5 - 15);
    if (y <= 24 && d > 10.6 && d < 12.2) top.set(x, y, d > 11.4 ? '#9aa6b8' : '#eef4ff');
  }
  for (const [x, y] of [[9, 7], [10, 6], [11, 5], [8, 9]]) top.set(x, y, 'rgba(255,255,255,.75)');
}

// 3×5 像素数字，印在胸前
const DIGITS = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001',
  '111100111001111', '111100111101111', '111001001010010', '111101111101111', '111101111001111'];
function number(top, n, color) {
  const s = String(n).padStart(2, '0');
  [...s].forEach((d, k) => {
    const bits = DIGITS[+d];
    for (let i = 0; i < 15; i++) if (bits[i] === '1') top.set(13 + k * 4 + (i % 3), 27 + Math.floor(i / 3), color);
  });
}

// 星光：四角各一颗十字星
function sparkles(bg, i) {
  const spots = [[3, 4], [27, 3], [4, 22], [28, 20], [25, 9], [5, 12]];
  spots.forEach(([x, y], k) => {
    if ((i + k) % 3 === 0) return;
    const c = 'rgba(255,255,255,.9)';
    bg.set(x, y, c); bg.set(x - 1, y, 'rgba(255,255,255,.5)'); bg.set(x + 1, y, 'rgba(255,255,255,.5)');
    bg.set(x, y - 1, 'rgba(255,255,255,.5)'); bg.set(x, y + 1, 'rgba(255,255,255,.5)');
  });
}

export function epicAvatar(i) {
  const holo = HOLO[(i * 3 + Math.floor(i / 8)) % HOLO.length];
  const skin = SPECIAL_SKIN[i] || SKINS[(i * 5) % SKINS.length];
  const hair = HAIRS[(i * 3 + 1) % HAIRS.length];
  const shirt = SHIRTS[(i * 7 + 3) % SHIRTS.length];
  const hatColor = SHIRTS[(i * 5 + 1) % SHIRTS.length];
  const hat = HAT_ORDER[i % HAT_ORDER.length];
  const eyes = EYE_ORDER[(i * 3 + Math.floor(i / 10)) % EYE_ORDER.length];
  const mouth = MOUTH_ORDER[(i * 5 + Math.floor(i / 10)) % MOUTH_ORDER.length];
  const acc = ACC_ORDER[(i * 7 + 2 * Math.floor(i / 10)) % ACC_ORDER.length];

  const bg = canvas();
  sparkles(bg, i);

  const fig = canvas();
  body(fig, skin, shirt);
  if (hat !== 'astronaut') HATS[hat](fig, hatColor, hair); else hairCap(fig, hair);
  EYES[eyes](fig);
  MOUTHS[mouth](fig);
  ACCESSORIES[acc](fig, hatColor);
  outline(fig);

  const top = canvas();
  if (hat === 'astronaut') helmet(top);
  // 有相机或围巾挡着胸口时，编号印在右肩
  number(top, i + 1, shade(shirt, shirt === '#22223b' ? 0.55 : 0.45));
  if (acc === 'camera' || acc === 'scarf' || acc === 'chain') for (const k of [...top.px.keys()]) {
    const [x, y] = k.split(',').map(Number);
    if (y >= 27 && x >= 13 && x <= 19) top.px.delete(k);
  }

  const id = `e${i}-`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${W}" shape-rendering="crispEdges">
<defs>
  <linearGradient id="${id}holo" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${holo[0]}"/><stop offset=".55" stop-color="${holo[1]}"/><stop offset="1" stop-color="${holo[2]}"/></linearGradient>
  <linearGradient id="${id}sheen" x1="0" y1="1" x2="1" y2="0">
    <stop offset=".25" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".28"/><stop offset=".75" stop-color="#fff" stop-opacity="0"/></linearGradient>
  <pattern id="${id}grid" width="2" height="2" patternUnits="userSpaceOnUse"><rect width="1" height="1" fill="#fff" opacity=".07"/></pattern>
</defs>
<rect width="${W}" height="${W}" fill="url(#${id}holo)"/>
<rect width="${W}" height="${W}" fill="url(#${id}grid)"/>
<rect width="${W}" height="${W}" fill="url(#${id}sheen)"/>
${toRects(bg.px)}
${toRects(fig.px)}
${toRects(top.px)}
</svg>`;
}
