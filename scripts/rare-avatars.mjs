// 稀有旅伴：小动物（由 scripts/build-avatars.mjs 调用）
// 画法和普通、高级的 notionists 一致：深墨色粗描边 + 平涂色块；10 种动物 × 5 种旅行配饰 = 50 位
// 底是柔和的邮票色，加一圈放射光和虚线邮票环。头像在界面里会被裁成圆形，重要内容都在圆内
const INK = '#2a2723';
// 描边：默认 4，细一点的部位传入粗细（同一个元素上不能写两个 stroke-width）
const line = (w = 4) => `stroke="${INK}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"`;
const LINE = line();
const CREAM = '#fbf4e4';
const PINK = '#f2a7a0';

// 底色：鼠尾草、杏、天蓝、玫瑰、麦秆、薰衣草
const GROUNDS = ['#cfe0cf', '#f4d6b4', '#c9daee', '#efcfca', '#ece0bd', '#dcd2ec'];
// 衣服颜色
const SHIRTS = ['#1f4b8f', '#c4302b', '#3f6b52', '#e0a33a', '#6b4f8a', '#2f5d62'];

// 每种动物：head() 画头；eyes 是两只眼睛的中心（给眼镜用）；flower 是插花的位置
const ANIMALS = {
  fox: {
    eyes: [[82, 92], [118, 92]], flower: [140, 52],
    head: () => `
      <path d="M62 72 L54 26 L92 52 Z" fill="#e8894a" ${LINE}/><path d="M138 72 L146 26 L108 52 Z" fill="#e8894a" ${LINE}/>
      <path d="M64 62 L60 38 L80 52 Z" fill="${INK}"/><path d="M136 62 L140 38 L120 52 Z" fill="${INK}"/>
      <path d="M48 88 C48 58 74 44 100 44 C126 44 152 58 152 88 C152 114 128 134 100 142 C72 134 48 114 48 88 Z" fill="#e8894a" ${LINE}/>
      <path d="M58 104 C74 98 90 106 100 114 C110 106 126 98 142 104 C134 124 116 136 100 142 C84 136 66 124 58 104 Z" fill="${CREAM}" ${LINE}/>
      ${dotEyes(82, 92, 118, 92)}
      <ellipse cx="100" cy="116" rx="7" ry="5" fill="${INK}"/>
      <path d="M93 126 Q100 131 107 126" fill="none" ${LINE}/>`,
  },
  cat: {
    eyes: [[82, 96], [118, 96]], flower: [142, 58],
    head: () => `
      <path d="M58 76 L58 32 L94 56 Z" fill="#c9bfae" ${LINE}/><path d="M142 76 L142 32 L106 56 Z" fill="#c9bfae" ${LINE}/>
      <path d="M64 64 L64 44 L82 56 Z" fill="${PINK}"/><path d="M136 64 L136 44 L118 56 Z" fill="${PINK}"/>
      <ellipse cx="100" cy="98" rx="52" ry="44" fill="#c9bfae" ${LINE}/>
      <path d="M92 60 L92 70 M100 58 L100 70 M108 60 L108 70" ${LINE}/>
      ${dotEyes(82, 96, 118, 96)}
      <path d="M95 110 L105 110 L100 116 Z" fill="${PINK}" ${line(2.5)}/>
      <path d="M90 121 Q95 126 100 120 Q105 126 110 121" fill="none" ${LINE}/>
      <path d="M58 108 L76 112 M58 120 L76 118 M142 108 L124 112 M142 120 L124 118" ${line(2.5)}/>`,
  },
  rabbit: {
    eyes: [[83, 100], [117, 100]], flower: [138, 66],
    head: () => `
      <ellipse cx="81" cy="52" rx="13" ry="31" transform="rotate(-10 81 52)" fill="${CREAM}" ${LINE}/>
      <ellipse cx="119" cy="52" rx="13" ry="31" transform="rotate(10 119 52)" fill="${CREAM}" ${LINE}/>
      <ellipse cx="81" cy="54" rx="6" ry="21" transform="rotate(-10 81 54)" fill="${PINK}"/>
      <ellipse cx="119" cy="54" rx="6" ry="21" transform="rotate(10 119 54)" fill="${PINK}"/>
      <ellipse cx="100" cy="104" rx="48" ry="42" fill="${CREAM}" ${LINE}/>
      ${dotEyes(83, 100, 117, 100)}
      <circle cx="72" cy="116" r="7" fill="${PINK}" opacity=".7"/><circle cx="128" cy="116" r="7" fill="${PINK}" opacity=".7"/>
      <path d="M95 111 L105 111 L100 116 Z" fill="${PINK}" ${line(2.5)}/>
      <path d="M100 117 L100 122 M100 122 Q94 128 89 124 M100 122 Q106 128 111 124" fill="none" ${line(3)}/>
      <rect x="96" y="124" width="8" height="7" rx="1.5" fill="#fff" ${line(2.5)}/>`,
  },
  bear: {
    eyes: [[82, 94], [118, 94]], flower: [144, 62],
    head: () => `
      <circle cx="62" cy="60" r="17" fill="#a87a55" ${LINE}/><circle cx="138" cy="60" r="17" fill="#a87a55" ${LINE}/>
      <circle cx="62" cy="60" r="8" fill="#e9cfa6"/><circle cx="138" cy="60" r="8" fill="#e9cfa6"/>
      <circle cx="100" cy="98" r="49" fill="#a87a55" ${LINE}/>
      <ellipse cx="100" cy="116" rx="22" ry="17" fill="#e9cfa6" ${LINE}/>
      ${dotEyes(82, 94, 118, 94)}
      <ellipse cx="100" cy="108" rx="8" ry="5.5" fill="${INK}"/>
      <path d="M100 113 L100 119 M93 122 Q100 127 107 122" fill="none" ${line(3)}/>`,
  },
  panda: {
    eyes: [[81, 96], [119, 96]], flower: [144, 60],
    head: () => `
      <circle cx="62" cy="60" r="17" fill="${INK}"/><circle cx="138" cy="60" r="17" fill="${INK}"/>
      <ellipse cx="100" cy="100" rx="51" ry="46" fill="#fff" ${LINE}/>
      <ellipse cx="80" cy="97" rx="12" ry="16" transform="rotate(35 80 97)" fill="${INK}"/>
      <ellipse cx="120" cy="97" rx="12" ry="16" transform="rotate(-35 120 97)" fill="${INK}"/>
      <circle cx="82" cy="95" r="4.5" fill="#fff"/><circle cx="118" cy="95" r="4.5" fill="#fff"/>
      <circle cx="83" cy="96" r="2.2" fill="${INK}"/><circle cx="117" cy="96" r="2.2" fill="${INK}"/>
      <ellipse cx="100" cy="114" rx="7" ry="5" fill="${INK}"/>
      <path d="M93 123 Q100 128 107 123" fill="none" ${line(3)}/>
      <circle cx="68" cy="118" r="6" fill="${PINK}" opacity=".6"/><circle cx="132" cy="118" r="6" fill="${PINK}" opacity=".6"/>`,
  },
  owl: {
    eyes: [[80, 92], [120, 92]], flower: [142, 58], noGlasses: true,
    head: () => `
      <path d="M54 78 L56 34 L84 56 Z" fill="#9c7a5a" ${LINE}/><path d="M146 78 L144 34 L116 56 Z" fill="#9c7a5a" ${LINE}/>
      <path d="M50 84 C50 58 72 48 100 52 C128 48 150 58 150 84 C150 118 128 142 100 142 C72 142 50 118 50 84 Z" fill="#9c7a5a" ${LINE}/>
      <circle cx="80" cy="92" r="21" fill="#efdfc0" ${LINE}/><circle cx="120" cy="92" r="21" fill="#efdfc0" ${LINE}/>
      <circle cx="80" cy="92" r="11" fill="#fff" ${line(3)}/><circle cx="120" cy="92" r="11" fill="#fff" ${line(3)}/>
      <circle cx="82" cy="93" r="6" fill="${INK}"/><circle cx="118" cy="93" r="6" fill="${INK}"/>
      <circle cx="84" cy="91" r="1.8" fill="#fff"/><circle cx="120" cy="91" r="1.8" fill="#fff"/>
      <path d="M93 108 L107 108 L100 120 Z" fill="#e8a23a" ${line(3)}/>
      <path d="M84 128 l5 4 5 -4 M106 128 l5 4 5 -4" fill="none" ${line(2.5)}/>`,
  },
  penguin: {
    eyes: [[85, 98], [115, 98]], flower: [140, 60],
    head: () => `
      <ellipse cx="100" cy="98" rx="50" ry="47" fill="#2f3a4a" ${LINE}/>
      <path d="M62 100 C62 74 84 70 100 86 C116 70 138 74 138 100 C138 122 120 138 100 138 C80 138 62 122 62 100 Z" fill="#fff" ${LINE}/>
      ${dotEyes(85, 98, 115, 98)}
      <ellipse cx="100" cy="112" rx="10" ry="5.5" fill="#e8a23a" ${line(3)}/>
      <circle cx="73" cy="114" r="6" fill="${PINK}" opacity=".7"/><circle cx="127" cy="114" r="6" fill="${PINK}" opacity=".7"/>`,
  },
  raccoon: {
    eyes: [[80, 94], [120, 94]], flower: [142, 56],
    head: () => `
      <path d="M60 72 L58 34 L90 54 Z" fill="#a3a09a" ${LINE}/><path d="M140 72 L142 34 L110 54 Z" fill="#a3a09a" ${LINE}/>
      <path d="M64 62 L63 44 L80 54 Z" fill="${INK}"/><path d="M136 62 L137 44 L120 54 Z" fill="${INK}"/>
      <path d="M48 90 C48 60 74 46 100 46 C126 46 152 60 152 90 C152 116 128 138 100 140 C72 138 48 116 48 90 Z" fill="#a3a09a" ${LINE}/>
      <path d="M54 92 C66 78 88 82 100 92 C112 82 134 78 146 92 C138 106 116 108 100 100 C84 108 62 106 54 92 Z" fill="${INK}"/>
      <circle cx="80" cy="93" r="5.5" fill="#fff"/><circle cx="120" cy="93" r="5.5" fill="#fff"/>
      <circle cx="81" cy="94" r="2.6" fill="${INK}"/><circle cx="119" cy="94" r="2.6" fill="${INK}"/>
      <path d="M78 112 C88 106 112 106 122 112 C118 128 108 136 100 138 C92 136 82 128 78 112 Z" fill="${CREAM}" ${LINE}/>
      <ellipse cx="100" cy="114" rx="7" ry="5" fill="${INK}"/>
      <path d="M94 124 Q100 129 106 124" fill="none" ${line(3)}/>`,
  },
  frog: {
    eyes: [[74, 72], [126, 72]], flower: [148, 86],
    head: () => `
      <circle cx="74" cy="72" r="19" fill="#93c27d" ${LINE}/><circle cx="126" cy="72" r="19" fill="#93c27d" ${LINE}/>
      <ellipse cx="100" cy="108" rx="56" ry="38" fill="#93c27d" ${LINE}/>
      <path d="M58 84 C70 90 130 90 142 84" fill="#93c27d"/>
      <circle cx="74" cy="72" r="11" fill="#fff" ${line(3)}/><circle cx="126" cy="72" r="11" fill="#fff" ${line(3)}/>
      <circle cx="76" cy="74" r="5.5" fill="${INK}"/><circle cx="124" cy="74" r="5.5" fill="${INK}"/>
      <path d="M66 112 Q100 140 134 112" fill="none" ${LINE}/>
      <circle cx="94" cy="100" r="2" fill="${INK}"/><circle cx="106" cy="100" r="2" fill="${INK}"/>
      <circle cx="64" cy="118" r="7" fill="${PINK}" opacity=".7"/><circle cx="136" cy="118" r="7" fill="${PINK}" opacity=".7"/>`,
  },
  shiba: {
    eyes: [[82, 94], [118, 94]], flower: [142, 54],
    head: () => `
      <path d="M58 74 L60 32 L94 54 Z" fill="#dc9a5c" ${LINE}/><path d="M142 74 L140 32 L106 54 Z" fill="#dc9a5c" ${LINE}/>
      <path d="M64 64 L65 44 L82 55 Z" fill="${CREAM}"/><path d="M136 64 L135 44 L118 55 Z" fill="${CREAM}"/>
      <path d="M48 90 C48 60 74 46 100 46 C126 46 152 60 152 90 C152 118 128 140 100 140 C72 140 48 118 48 90 Z" fill="#dc9a5c" ${LINE}/>
      <path d="M60 106 C72 100 88 104 100 110 C112 104 128 100 140 106 C134 128 116 140 100 140 C84 140 66 128 60 106 Z" fill="${CREAM}" ${LINE}/>
      <ellipse cx="80" cy="82" rx="5" ry="3" fill="${CREAM}"/><ellipse cx="120" cy="82" rx="5" ry="3" fill="${CREAM}"/>
      ${dotEyes(82, 94, 118, 94)}
      <ellipse cx="100" cy="114" rx="7.5" ry="5" fill="${INK}"/>
      <path d="M100 119 L100 123 M92 125 Q100 131 108 125" fill="none" ${line(3)}/>`,
  },
};

function dotEyes(x1, y1, x2, y2) {
  return `<ellipse cx="${x1}" cy="${y1}" rx="5" ry="6.5" fill="${INK}"/><ellipse cx="${x2}" cy="${y2}" rx="5" ry="6.5" fill="${INK}"/>
    <circle cx="${x1 + 1.6}" cy="${y1 - 2.2}" r="1.7" fill="#fff"/><circle cx="${x2 + 1.6}" cy="${y2 - 2.2}" r="1.7" fill="#fff"/>`;
}

// 肩膀和衣服
const body = shirt => `<path d="M26 206 C30 168 60 146 100 146 C140 146 170 168 174 206 Z" fill="${shirt}" ${LINE}/>
  <path d="M84 147 Q100 162 116 147" fill="none" ${line(3)}/>`;

// 配饰：画在头的前面
const ACCESSORIES = {
  // 条纹围巾：绕脖子一圈，一端垂下来
  scarf: (a, color) => `
    <path d="M60 140 C80 152 120 152 140 140 L143 157 C120 170 80 170 57 157 Z" fill="${color}" ${LINE}/>
    <path d="M118 158 L130 196 L113 198 L106 162 Z" fill="${color}" ${LINE}/>
    <path d="M72 148 L70 162 M88 152 L87 166 M104 153 L104 167 M120 150 L122 163 M112 172 L124 170 M115 184 L127 182" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".85"/>`,
  // 圆框眼镜
  glasses: a => {
    const [[x1, y1], [x2, y2]] = a.eyes;
    return `<g fill="#fff" fill-opacity=".28" ${line(3.5)}>
      <circle cx="${x1}" cy="${y1}" r="13"/><circle cx="${x2}" cy="${y2}" r="13"/>
      <path d="M${x1 + 13} ${y1} Q100 ${y1 - 6} ${x2 - 13} ${y2}" fill="none"/></g>`;
  },
  // 胸前挂一台相机
  camera: () => `
    <path d="M66 150 L88 176 M134 150 L112 176" ${line(3)}/>
    <rect x="80" y="168" width="40" height="27" rx="5" fill="#3a3a3a" ${line(3)}/>
    <rect x="86" y="164" width="11" height="6" rx="1.5" fill="#3a3a3a" ${line(2.5)}/>
    <circle cx="100" cy="181" r="9" fill="#cfd8e2" ${line(3)}/><circle cx="100" cy="181" r="3.5" fill="${INK}"/>
    <circle cx="113" cy="173" r="2" fill="#f4d06b"/>`,
  // 胸前挂着一本护照（第五种配饰，r41–r50）
  passport: (a, color) => `
    <path d="M70 150 L90 170 M130 150 L110 170" ${line(3)}/>
    <rect x="84" y="166" width="32" height="30" rx="3" fill="${color}" ${line(3)}/>
    <circle cx="100" cy="179" r="6.5" fill="none" stroke="#f4d06b" stroke-width="2"/>
    <path d="M93.5 179 H106.5 M100 172.5 V185.5" stroke="#f4d06b" stroke-width="1.5"/>
    <path d="M90 191 H110" stroke="#f4d06b" stroke-width="2" stroke-linecap="round"/>`,
  // 领结（猫头鹰戴不了眼镜时用）
  bowtie: (a, color) => `
    <path d="M100 150 L78 140 L78 162 Z M100 150 L122 140 L122 162 Z" fill="${color}" ${line(3)}/>
    <circle cx="100" cy="150" r="5" fill="${color}" ${line(3)}/>`,
  // 耳边一朵小花
  flower: (a, color) => {
    const [x, y] = a.flower;
    const petals = [0, 72, 144, 216, 288].map(d => {
      const r = d * Math.PI / 180;
      return `<circle cx="${(x + 8 * Math.cos(r)).toFixed(1)}" cy="${(y + 8 * Math.sin(r)).toFixed(1)}" r="7" fill="${color}" ${line(2.5)}/>`;
    }).join('');
    return `${petals}<circle cx="${x}" cy="${y}" r="5" fill="#f4d06b" ${line(2.5)}/>`;
  },
};
const ACCESSORY_COLORS = ['#c4302b', '#1f4b8f', '#e0a33a', '#3f6b52', '#d0657a'];

// 放射光 + 虚线邮票环
function ground(color) {
  const rays = [];
  for (let i = 0; i < 16; i++) {
    const a0 = (i * 22.5) * Math.PI / 180, a1 = (i * 22.5 + 11.25) * Math.PI / 180;
    rays.push(`M100 100 L${(100 + 150 * Math.cos(a0)).toFixed(1)} ${(100 + 150 * Math.sin(a0)).toFixed(1)} L${(100 + 150 * Math.cos(a1)).toFixed(1)} ${(100 + 150 * Math.sin(a1)).toFixed(1)} Z`);
  }
  return `<rect width="200" height="200" fill="${color}"/>
    <path d="${rays.join(' ')}" fill="#fff" opacity=".22"/>
    <circle cx="100" cy="100" r="90" fill="none" stroke="#fff" stroke-width="2" stroke-dasharray="2 5" stroke-linecap="round" opacity=".8"/>`;
}

const ORDER = ['fox', 'cat', 'rabbit', 'bear', 'panda', 'owl', 'penguin', 'raccoon', 'frog', 'shiba'];
const KINDS = ['scarf', 'glasses', 'camera', 'flower', 'passport'];

export function rareAvatar(i) {
  const a = ANIMALS[ORDER[i % ORDER.length]];
  let kind = KINDS[Math.floor(i / ORDER.length) % KINDS.length];
  if (kind === 'glasses' && a.noGlasses) kind = 'bowtie'; // 猫头鹰的大眼睛戴不了眼镜，换成领结
  const color = ACCESSORY_COLORS[(i * 3) % ACCESSORY_COLORS.length];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
${ground(GROUNDS[(i * 5) % GROUNDS.length])}
${body(SHIRTS[(i * 7 + 2) % SHIRTS.length])}
${a.head()}
${ACCESSORIES[kind](a, color)}
</svg>`;
}
