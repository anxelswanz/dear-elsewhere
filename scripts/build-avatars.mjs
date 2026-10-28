// 生成 60 个卡通头像到 public/avatars/a01.svg … a60.svg
// 风格：DiceBear notionists（Zoish，CC0 1.0，可自由商用），手绘线稿配手账底色
// 用法：npm run build:avatars
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAvatar } from '@dicebear/core';
import { notionists } from '@dicebear/collection';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'avatars');
const AVATAR_COUNT = 60;

// 与界面一致的纸面色：杏、航空蓝、牛皮纸、邮戳红、鼠尾草、芥末黄
const BACKGROUNDS = ['f6d9c4', 'd6e2f0', 'ebe3cf', 'f2cdc7', 'd8e6d2', 'f3e3b3'];
// 种子取自世界各地的地名，保证每次生成结果一致
const SEEDS = [
  'Cambridge', 'Kyoto', 'Lisbon', 'Chengdu', 'Reykjavik', 'Marrakesh', 'Hanoi', 'Cusco', 'Tallinn', 'Hobart',
  'Valparaiso', 'Lhasa', 'Porto', 'Kotor', 'Oaxaca', 'Bergen', 'Luang Prabang', 'Siena', 'Zanzibar', 'Quebec',
  'Dali', 'Granada', 'Bruges', 'Hoi An', 'Cappadocia', 'Queenstown', 'Sintra', 'Hallstatt', 'Matera', 'Jaipur',
  'Bagan', 'Ushuaia', 'Edinburgh', 'Kanazawa', 'Tromso', 'Petra', 'Galway', 'Colmar', 'Lijiang', 'Salzburg',
  'Havana', 'Busan', 'Seville', 'Mendoza', 'Krakow', 'Fes', 'Bled', 'Nara', 'Kashgar', 'Dubrovnik',
  'Cartagena', 'Hue', 'Ljubljana', 'Pokhara', 'Tbilisi', 'Yazd', 'Arles', 'Taipei', 'Lucerne', 'Penang',
];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
SEEDS.slice(0, AVATAR_COUNT).forEach((seed, i) => {
  const svg = createAvatar(notionists, {
    seed,
    backgroundColor: [BACKGROUNDS[i % BACKGROUNDS.length]],
    scale: 92,
    translateY: 4,
  }).toString();
  fs.writeFileSync(path.join(OUT, `a${String(i + 1).padStart(2, '0')}.svg`), svg);
});
console.log(`已生成 ${AVATAR_COUNT} 个头像 → public/avatars/`);
