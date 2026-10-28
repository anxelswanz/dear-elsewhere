// 生成前端使用的地图数据：node scripts/build-data.mjs
//
// 数据来源：
//   - Natural Earth（世界国家、全球一级行政区、全球城市点），坐标 WGS84
//   - 阿里 DataV GeoAtlas（中国省 -> 地级市边界），坐标 GCJ-02，这里统一转为 WGS84
//
// 输出（public/data/，由 Vite 原样作为静态资源提供）：
//   world.json            国家边界
//   country/{A3}.json     某国的一级行政区（省/州）边界
//   region/{id}.json      某省下的城市边界（目前只有中国）
//   index.json            全部行政区与城市的索引（搜索、归属判断用）

import fs from 'node:fs';
import path from 'node:path';
import mapshaper from 'mapshaper';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const RAW = path.join(ROOT, 'raw');
const OUT = path.join(ROOT, 'public', 'data');

const NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson';
const DATAV = 'https://geo.datav.aliyun.com/areas_v3/bound';
// 台湾、香港、澳门在 Natural Earth 中已作为独立区域存在，避免重复
const CN_SKIP = new Set([710000, 810000, 820000]);

// 常用中文简称
const NAME_OVERRIDES = {
  CHN: '中国', TWN: '台湾', KOR: '韩国', PRK: '朝鲜', CYN: '北塞浦路斯',
  IOA: '澳属印度洋领地', ARE: '阿联酋', BIH: '波黑', COD: '刚果（金）', COG: '刚果（布）',
};

// Natural Earth 对这些国家的一级行政区划分过细（郡、省、市镇），
// 按标准的一级行政区合并：英国 -> 英格兰/苏格兰/威尔士/北爱尔兰，法国 -> 大区，意大利 -> 大区，西班牙 -> 自治区…
const GROUP_BY = {
  GBR: 'geonunit', FRA: 'region', ITA: 'region', ESP: 'region',
  PHL: 'region', SVN: 'region', LVA: 'region', MKD: 'region', MLT: 'region', UGA: 'region',
};
const GROUP_ZH = {
  England: '英格兰', Scotland: '苏格兰', Wales: '威尔士', 'Northern Ireland': '北爱尔兰',
  'Hauts-de-France': '上法兰西', 'Grand Est': '大东部', "Provence-Alpes-Côte-d'Azur": '普罗旺斯-阿尔卑斯-蓝色海岸',
  'Auvergne-Rhône-Alpes': '奥弗涅-罗讷-阿尔卑斯', 'Nouvelle-Aquitaine': '新阿基坦', Occitanie: '奥克西塔尼',
  'Bourgogne-Franche-Comté': '勃艮第-弗朗什-孔泰', 'Pays de la Loire': '卢瓦尔河地区', Bretagne: '布列塔尼',
  Normandie: '诺曼底', Corse: '科西嘉', 'Centre-Val de Loire': '中央-卢瓦尔河谷', 'Île-de-France': '法兰西岛',
  'Guyane française': '法属圭亚那', Martinique: '马提尼克', Guadeloupe: '瓜德罗普', 'Réunion': '留尼汪', Mayotte: '马约特',
  "Valle d'Aosta": '瓦莱达奥斯塔', Piemonte: '皮埃蒙特', Lombardia: '伦巴第', 'Trentino-Alto Adige': '特伦蒂诺-上阿迪杰',
  Liguria: '利古里亚', 'Emilia-Romagna': '艾米利亚-罗马涅', Marche: '马尔凯', Veneto: '威尼托',
  'Friuli-Venezia Giulia': '弗留利-威尼斯朱利亚', Abruzzo: '阿布鲁佐', Molise: '莫利塞', Apulia: '普利亚',
  Basilicata: '巴西利卡塔', Calabria: '卡拉布里亚', Campania: '坎帕尼亚', Lazio: '拉齐奥', Toscana: '托斯卡纳',
  Sicily: '西西里', Sardegna: '撒丁', Umbria: '翁布里亚',
  Ceuta: '休达', Melilla: '梅利利亚', 'Foral de Navarra': '纳瓦拉', 'País Vasco': '巴斯克', 'Aragón': '阿拉贡',
  'Cataluña': '加泰罗尼亚', Extremadura: '埃斯特雷马杜拉', 'Andalucía': '安达卢西亚', Galicia: '加利西亚',
  'Castilla y León': '卡斯蒂利亚-莱昂', Valenciana: '巴伦西亚', Murcia: '穆尔西亚', Asturias: '阿斯图里亚斯',
  Cantabria: '坎塔布里亚', 'Canary Is.': '加那利群岛', 'Islas Baleares': '巴利阿里群岛', 'La Rioja': '拉里奥哈',
  'Castilla-La Mancha': '卡斯蒂利亚-拉曼恰', Madrid: '马德里',
};

// ---------- 工具 ----------
async function download(url, file) {
  if (fs.existsSync(file)) return;
  console.log('下载', url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function writeJson(rel, obj) {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj));
}

async function shaper(geojson, commands) {
  const out = await mapshaper.applyCommands(`-i in.json ${commands} -o out.json precision=0.001`, { 'in.json': geojson });
  return JSON.parse(out['out.json']);
}

// GCJ-02 -> WGS84（与 app.js 中算法一致）
const PI = Math.PI, AXIS = 6378245.0, EE = 0.00669342162296594323;
function transformLat(x, y) {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3;
  r += (20 * Math.sin(y * PI) + 40 * Math.sin(y / 3 * PI)) * 2 / 3;
  r += (160 * Math.sin(y / 12 * PI) + 320 * Math.sin(y * PI / 30)) * 2 / 3;
  return r;
}
function transformLng(x, y) {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3;
  r += (20 * Math.sin(x * PI) + 40 * Math.sin(x / 3 * PI)) * 2 / 3;
  r += (150 * Math.sin(x / 12 * PI) + 300 * Math.sin(x / 30 * PI)) * 2 / 3;
  return r;
}
function gcj2wgs([lng, lat]) {
  let dLat = transformLat(lng - 105, lat - 35);
  let dLng = transformLng(lng - 105, lat - 35);
  const rad = lat / 180 * PI;
  let magic = Math.sin(rad);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180) / ((AXIS * (1 - EE)) / (magic * sqrtMagic) * PI);
  dLng = (dLng * 180) / (AXIS / sqrtMagic * Math.cos(rad) * PI);
  return [lng - dLng, lat - dLat];
}
const mapCoords = (c, fn) => (typeof c[0] === 'number' ? fn(c) : c.map(x => mapCoords(x, fn)));

// 点是否在 Polygon / MultiPolygon 内（射线法）
function inRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inGeometry(pt, geom) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  return polys.some(([outer, ...holes]) => inRing(pt, outer) && !holes.some(h => inRing(pt, h)));
}

function nearestRegion([x, y], regions) {
  let best = null, bestD = Infinity;
  for (const r of regions) {
    mapCoords(r.geometry.coordinates, ([px, py]) => {
      const d = (px - x) ** 2 + (py - y) ** 2;
      if (d < bestD) { bestD = d; best = r; }
    });
  }
  return best;
}

const round = n => Math.round(n * 1e4) / 1e4;

// ---------- 主流程 ----------
const files = ['ne_50m_admin_0_countries', 'ne_10m_admin_1_states_provinces', 'ne_10m_populated_places'];
for (const f of files) await download(`${NE}/${f}.geojson`, path.join(RAW, `${f}.geojson`));
await download(`${DATAV}/100000_full.json`, path.join(RAW, 'cn/100000_full.json'));
const cnProvinces = readJson(path.join(RAW, 'cn/100000_full.json')).features
  .filter(f => typeof f.properties.adcode === 'number' && f.properties.name && !CN_SKIP.has(f.properties.adcode));
for (const p of cnProvinces) {
  await download(`${DATAV}/${p.properties.adcode}_full.json`, path.join(RAW, `cn/${p.properties.adcode}_full.json`));
}

fs.rmSync(OUT, { recursive: true, force: true });

// 1. 世界国家
console.log('处理 国家…');
const world = await shaper(readJson(path.join(RAW, 'ne_50m_admin_0_countries.geojson')),
  '-filter-fields ADM0_A3,NAME,NAME_ZH -simplify 40% keep-shapes');
for (const f of world.features) {
  const p = f.properties;
  f.properties = { id: p.ADM0_A3, name: NAME_OVERRIDES[p.ADM0_A3] || p.NAME_ZH || p.NAME, en: p.NAME };
}
writeJson('world.json', world);
const countryIds = new Set(world.features.map(f => f.properties.id));

// 2. 各国一级行政区（中国除外）
console.log('处理 一级行政区…');
const rawAdmin1 = readJson(path.join(RAW, 'ne_10m_admin_1_states_provinces.geojson'));
const skip = JSON.stringify(['CHN', ...Object.keys(GROUP_BY)]);
const admin1 = await shaper(rawAdmin1,
  `-filter "!${skip.replace(/"/g, "'")}.includes(adm0_a3)" -filter-fields adm1_code,adm0_a3,name,name_zh -simplify interval=800 keep-shapes`);
const regionsByCountry = new Map();
for (const f of admin1.features) {
  const p = f.properties;
  if (!regionsByCountry.has(p.adm0_a3)) regionsByCountry.set(p.adm0_a3, []);
  f.properties = { id: p.adm1_code, name: p.name_zh || p.name || p.adm1_code, en: p.name || '' };
  regionsByCountry.get(p.adm0_a3).push(f);
}
for (const [a3, field] of Object.entries(GROUP_BY)) {
  const own = { type: 'FeatureCollection', features: rawAdmin1.features.filter(f => f.properties.adm0_a3 === a3) };
  const merged = await shaper(own, `-dissolve ${field} -simplify interval=800 keep-shapes`);
  regionsByCountry.set(a3, merged.features.filter(f => f.properties[field]).map(f => {
    const en = f.properties[field];
    return { ...f, properties: { id: `${a3}-${en.normalize('NFD').replace(/[^A-Za-z]+/g, '')}`, name: GROUP_ZH[en] || en, en } };
  }));
}

// 3. 中国：省 + 地级市（DataV，GCJ-02 -> WGS84）
console.log('处理 中国省市…');
const toWgs = f => ({ ...f, geometry: { ...f.geometry, coordinates: mapCoords(f.geometry.coordinates, gcj2wgs) } });
const cnRegions = cnProvinces.map(f => ({
  ...toWgs(f),
  properties: { id: 'CN' + f.properties.adcode, name: f.properties.name, en: '', cities: 1 },
}));
regionsByCountry.set('CHN', (await shaper({ type: 'FeatureCollection', features: cnRegions }, '-simplify 30% keep-shapes')).features);

const cities = [];
for (const prov of cnProvinces) {
  const regionId = 'CN' + prov.properties.adcode;
  const raw = readJson(path.join(RAW, `cn/${prov.properties.adcode}_full.json`)).features.filter(f => f.properties.name);
  const feats = raw.map(f => ({ ...toWgs(f), properties: { id: 'CN' + f.properties.adcode, name: f.properties.name } }));
  writeJson(`region/${regionId}.json`, await shaper({ type: 'FeatureCollection', features: feats }, ''));
  for (const f of raw) {
    const [lng, lat] = gcj2wgs(f.properties.center || f.properties.centroid);
    cities.push(['CN' + f.properties.adcode, f.properties.name, '', 'CHN', regionId, round(lat), round(lng), 3]);
  }
}

for (const [a3, feats] of regionsByCountry) writeJson(`country/${a3}.json`, { type: 'FeatureCollection', features: feats });

// 4. 全球城市点（中国用上面的地级市代替）
console.log('处理 城市…');
for (const f of readJson(path.join(RAW, 'ne_10m_populated_places.geojson')).features) {
  const p = f.properties;
  if (p.ADM0_A3 === 'CHN' || !countryIds.has(p.ADM0_A3)) continue;
  const pt = [p.LONGITUDE, p.LATITUDE];
  const candidates = regionsByCountry.get(p.ADM0_A3) || [];
  // 沿海城市可能因边界简化落在多边形外，退而取最近的行政区
  const region = candidates.find(r => inGeometry(pt, r.geometry)) || nearestRegion(pt, candidates);
  cities.push(['P' + p.NE_ID, p.NAME_ZH || p.NAME, p.NAME, p.ADM0_A3, region ? region.properties.id : '',
    round(p.LATITUDE), round(p.LONGITUDE), p.SCALERANK]);
}

// 5. 索引
const regions = [];
for (const [a3, feats] of regionsByCountry) for (const f of feats) regions.push([f.properties.id, f.properties.name, f.properties.en, a3]);
writeJson('index.json', { regions, cities });

const size = dir => fs.readdirSync(dir, { recursive: true })
  .map(f => path.join(dir, f)).filter(f => fs.statSync(f).isFile()).reduce((n, f) => n + fs.statSync(f).size, 0);
console.log(`完成：${world.features.length} 个国家，${regions.length} 个一级行政区，${cities.length} 个城市，共 ${(size(OUT) / 1e6).toFixed(1)} MB`);
