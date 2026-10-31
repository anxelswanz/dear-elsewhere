// 给没有英文名的中国省份、城市补上英文名（拼音），供英文界面使用。
// 在 build-data 之后运行：直接改写 public/data/index.json。
// 用法：npm run build:data（已包含）或 node scripts/add-english-names.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinyin } from 'pinyin-pro';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data', 'index.json');

// 约定俗成的英文名，或拼音容易出错的
const OVERRIDES = {
  内蒙古自治区: 'Inner Mongolia', 西藏自治区: 'Tibet', 香港特别行政区: 'Hong Kong', 澳门特别行政区: 'Macau', 台湾省: 'Taiwan',
  花地玛堂区: 'Our Lady of Fátima', 花王堂区: 'St. Anthony', 望德堂区: 'St. Lazarus', 大堂区: 'Sé (Cathedral)',
  风顺堂区: 'St. Lawrence', 嘉模堂区: 'Taipa', 路凼填海区: 'Cotai', 圣方济各堂区: 'Coloane',
  陕西省: 'Shaanxi', 山西省: 'Shanxi',
  呼和浩特市: 'Hohhot', 乌鲁木齐市: 'Ürümqi', 拉萨市: 'Lhasa', 哈尔滨市: 'Harbin', 喀什地区: 'Kashgar',
  西双版纳傣族自治州: 'Xishuangbanna', 日喀则市: 'Shigatse', 包头市: 'Baotou', 重庆市: 'Chongqing',
};
const ETHNIC = ['朝鲜族', '土家族', '苗族', '藏族', '羌族', '彝族', '布依族', '侗族', '哈尼族', '壮族', '傣族', '白族', '景颇族', '傈僳族',
  '回族', '蒙古族', '蒙古', '柯尔克孜', '哈萨克', '维吾尔', '畲族'];
const SUFFIX = /(特别行政区|自治区|自治州|自治县|地区|林区|新区|省|市|区|县|盟|旗)$/;

function englishName(zh) {
  if (OVERRIDES[zh]) return OVERRIDES[zh];
  let core = zh;
  if (core.length > 2) core = core.replace(SUFFIX, '');
  // 去掉「××族自治州」里的民族名，如 凉山彝族自治州 → 凉山
  for (let changed = true; changed;) {
    changed = false;
    for (const e of ETHNIC) {
      if (core.endsWith(e) && core.length - e.length >= 2) { core = core.slice(0, -e.length); changed = true; }
    }
  }
  const syllables = pinyin(core, { toneType: 'none', type: 'array', v: false });
  // 韵母开头的音节前加隔音符号，如 Xi'an、Lu'an
  const word = syllables.map((s, i) => (i && /^[aeo]/.test(s) ? `'${s}` : s)).join('');
  return word.charAt(0).toUpperCase() + word.slice(1);
}

const index = JSON.parse(fs.readFileSync(FILE, 'utf8'));
let n = 0;
for (const list of [index.regions, index.cities]) {
  for (const row of list) {
    if (row[0].startsWith('CN') && !row[2]) { row[2] = englishName(row[1]); n++; }
  }
}
fs.writeFileSync(FILE, JSON.stringify(index));
console.log(`已补充 ${n} 个英文名`);
