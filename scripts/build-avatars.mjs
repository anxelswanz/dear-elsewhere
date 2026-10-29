// 生成头像到 public/avatars/，分四个稀有度（抽到的概率见 supabase/migrations/0013_avatars_birthplace.sql）：
//   普通 a01–a130  人物      DiceBear notionists（Zoish，CC0 1.0）；a01–a60 是最早的 60 个，保持原样
//   高级 p01–p50   人物      notionists，带手势和胸前徽章，配色更鲜明
//   稀有 r01–r40   小动物    原创绘制，10 种动物 × 4 种旅行配饰（scripts/rare-avatars.mjs）
//   传说 l01–l16   烫金肖像  notionists 人物 + 勋章边框（scripts/legend-avatars.mjs）
// 用法：npm run build:avatars
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAvatar } from '@dicebear/core';
import { notionists } from '@dicebear/collection';
import { legendAvatar } from './legend-avatars.mjs';
import { rareAvatar } from './rare-avatars.mjs';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'avatars');

// 与界面一致的纸面色：杏、航空蓝、牛皮纸、邮戳红、鼠尾草、芥末黄
const BACKGROUNDS = ['f6d9c4', 'd6e2f0', 'ebe3cf', 'f2cdc7', 'd8e6d2', 'f3e3b3'];
// 高级：更饱和的邮票色
const PREMIUM_BG = ['f4b183', '9fc0e8', 'e7a6a0', 'a9cf9c', 'f2cf6b', 'c5b3e6'];

// 种子取自世界各地的地名，保证每次生成结果一致
const SEEDS = [
  'Cambridge', 'Kyoto', 'Lisbon', 'Chengdu', 'Reykjavik', 'Marrakesh', 'Hanoi', 'Cusco', 'Tallinn', 'Hobart',
  'Valparaiso', 'Lhasa', 'Porto', 'Kotor', 'Oaxaca', 'Bergen', 'Luang Prabang', 'Siena', 'Zanzibar', 'Quebec',
  'Dali', 'Granada', 'Bruges', 'Hoi An', 'Cappadocia', 'Queenstown', 'Sintra', 'Hallstatt', 'Matera', 'Jaipur',
  'Bagan', 'Ushuaia', 'Edinburgh', 'Kanazawa', 'Tromso', 'Petra', 'Galway', 'Colmar', 'Lijiang', 'Salzburg',
  'Havana', 'Busan', 'Seville', 'Mendoza', 'Krakow', 'Fes', 'Bled', 'Nara', 'Kashgar', 'Dubrovnik',
  'Cartagena', 'Hue', 'Ljubljana', 'Pokhara', 'Tbilisi', 'Yazd', 'Arles', 'Taipei', 'Lucerne', 'Penang',
];
// 新增头像的种子：再走一圈世界
const MORE = [
  'Alesund', 'Antigua', 'Aswan', 'Avignon', 'Ayutthaya', 'Bamberg', 'Bariloche', 'Bath', 'Beirut', 'Bilbao',
  'Bukhara', 'Cadiz', 'Cairns', 'Chefchaouen', 'Cinque Terre', 'Cork', 'Cuenca', 'Da Lat', 'Darjeeling', 'Delft',
  'Dunhuang', 'Essaouira', 'Evora', 'Fenghuang', 'Florence', 'Gdansk', 'Ghent', 'Girona', 'Goreme', 'Guilin',
  'Hakodate', 'Hampi', 'Heidelberg', 'Hiroshima', 'Huangshan', 'Inverness', 'Isfahan', 'Jodhpur', 'Kampot', 'Kandy',
  'Kilkenny', 'Kobe', 'Kunming', 'Lagos', 'Leh', 'Leiden', 'Lofoten', 'Luxor', 'Macau', 'Malacca',
  'Mostar', 'Nafplio', 'Naxos', 'Nice', 'Nuremberg', 'Ohrid', 'Olomouc', 'Pingyao', 'Plovdiv', 'Positano',
  'Puno', 'Quito', 'Riga', 'Ronda', 'Rothenburg', 'Samarkand', 'San Cristobal', 'Santorini', 'Sapporo', 'Segovia',
  'Shiraz', 'Sibiu', 'Split', 'Stellenbosch', 'St Andrews', 'Sucre', 'Suzhou', 'Takayama', 'Tangier', 'Taormina',
  'Toledo', 'Trinidad', 'Trogir', 'Tuscany', 'Udaipur', 'Uyuni', 'Valletta', 'Varanasi', 'Verona', 'Vigan',
  'Vilnius', 'Wanaka', 'Wuzhen', 'Xian', 'Yangshuo', 'York', 'Zermatt', 'Zhangjiajie', 'Zurich', 'Aarhus',
  'Abu Simbel', 'Agra', 'Akureyri', 'Amalfi', 'Annecy', 'Arequipa', 'Assisi', 'Bonaire', 'Banff', 'Belgrade',
  'Bodrum', 'Bonifacio', 'Brasov', 'Cesky Krumlov', 'Chiang Mai', 'Coimbra', 'Cordoba', 'Dingle', 'Erfurt', 'Faro',
  'Fethiye', 'Galle', 'Gimmelwald', 'Gozo', 'Hydra', 'Inle', 'Jeju', 'Kampala', 'Kas', 'Kazan',
  'Kinsale', 'Lake Como', 'Lamu', 'Lecce', 'Luang Namtha', 'Madeira', 'Manarola', 'Mdina', 'Merida', 'Monopoli',
  'Mykonos', 'Nikko', 'Oban', 'Ollantaytambo', 'Paro', 'Perast', 'Piran', 'Portree', 'Procida', 'Ravello',
  'Rovinj', 'Salento', 'Shirakawa', 'Sigiriya', 'Skagen', 'Sorrento', 'Stari Grad', 'Tartu', 'Tarifa', 'Tofino',
  'Ubud', 'Ulm', 'Vernazza', 'Wengen', 'Xitang', 'Yixian', 'Zadar', 'Zakopane', 'Zhouzhuang', 'Zlatibor',
  'Akaroa', 'Alberobello', 'Albi', 'Bayeux', 'Berat', 'Biarritz', 'Blois', 'Cefalu', 'Cochem', 'Dinan',
];
let used = 0;
const nextSeed = () => MORE[used++];

const id = (prefix, n) => `${prefix}${String(n).padStart(2, '0')}`;
const write = (name, svg) => fs.writeFileSync(path.join(OUT, `${name}.svg`), svg);
const pick = (list, i) => list[i % list.length];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// 普通：最早的 60 个参数与第一版完全一致（已有用户的头像不变），再加 70 个不带手势和徽章的
SEEDS.forEach((seed, i) => write(id('a', i + 1), createAvatar(notionists, {
  seed, backgroundColor: [pick(BACKGROUNDS, i)], scale: 92, translateY: 4,
}).toString()));
for (let i = 60; i < 130; i++) {
  write(id('a', i + 1), createAvatar(notionists, {
    seed: nextSeed(), backgroundColor: [pick(BACKGROUNDS, i)], scale: 92, translateY: 4,
    bodyIconProbability: 0, gestureProbability: 0,
  }).toString());
}
// 高级：一定带手势和胸前徽章
for (let i = 0; i < 50; i++) {
  write(id('p', i + 1), createAvatar(notionists, {
    seed: nextSeed(), backgroundColor: [pick(PREMIUM_BG, i)], scale: 92, translateY: 4,
    bodyIconProbability: 100, gestureProbability: 100,
  }).toString());
}
// 稀有：小动物
for (let i = 0; i < 40; i++) write(id('r', i + 1), rareAvatar(i));
// 传说：烫金版画肖像
for (let i = 0; i < 16; i++) write(id('l', i + 1), legendAvatar(i));
console.log(`已生成 130 + 50 + 40 + 16 = 236 个头像 → public/avatars/（新种子用了 ${used} 个）`);
