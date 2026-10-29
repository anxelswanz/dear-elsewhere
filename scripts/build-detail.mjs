// 截图（暗房）用的细节图层：河流、湖泊、海岸线、陆地、国界、城市建成区。
// 用法：node scripts/build-detail.mjs（npm run build:data 已包含，需在 build-data 之后运行）
//
// 数据来源：Natural Earth 10m（公有领域，无需署名），坐标 WGS84
// 输出：public/data/detail/{列}_{行}.json，按 10°×10° 切块，截图时只加载画面覆盖到的块；
//       public/data/detail/index.json 列出有内容的块，避免请求空块。
// 每块的格式（坐标保留 3 位小数，约 100 米）：
//   { land: [多边形], coast: [线], borders: [线], lakes: [[等级, 多边形]], urban: [[等级, 多边形]], rivers: [[等级, 线]] }
//   多边形 = [外环, 内环…]，线 = [[lng, lat]…]；等级越小越重要，缩得越远只画越重要的

import fs from 'node:fs';
import path from 'node:path';
import mapshaper from 'mapshaper';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const RAW = path.join(ROOT, 'raw');
const OUT = path.join(ROOT, 'public', 'data', 'detail');
const NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson';
const CELL = 10;

// 图层 -> 来源文件；附加的欧洲、北美数据补充了更多小河小湖
const LAYERS = {
  land: ['ne_10m_land'],
  coast: ['ne_10m_coastline'],
  borders: ['ne_10m_admin_0_boundary_lines_land'],
  lakes: ['ne_10m_lakes', 'ne_10m_lakes_europe', 'ne_10m_lakes_north_america'],
  urban: ['ne_10m_urban_areas'],
  rivers: ['ne_10m_rivers_lake_centerlines', 'ne_10m_rivers_europe', 'ne_10m_rivers_north_america'],
};
const RANKED = new Set(['lakes', 'urban', 'rivers']);

async function download(name) {
  const file = path.join(RAW, `${name}.geojson`);
  if (fs.existsSync(file)) return file;
  console.log('下载', name);
  const res = await fetch(`${NE}/${name}.geojson`);
  if (!res.ok) throw new Error(`${res.status} ${name}`);
  fs.mkdirSync(RAW, { recursive: true });
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

const round = n => Math.round(n * 1e3) / 1e3;
const roundCoords = c => (typeof c[0] === 'number' ? [round(c[0]), round(c[1])] : c.map(roundCoords));
// 去掉取整后重复的相邻点
const dedupe = line => line.filter((p, i) => !i || p[0] !== line[i - 1][0] || p[1] !== line[i - 1][1]);

// 把几何拆成「多边形」或「线」的列表
function parts(geom) {
  if (!geom) return [];
  switch (geom.type) {
    case 'Polygon': return [geom.coordinates];
    case 'MultiPolygon': return geom.coordinates;
    case 'LineString': return [geom.coordinates];
    case 'MultiLineString': return geom.coordinates;
    default: return [];
  }
}

const cells = new Map(); // "列_行" -> 块
const cellOf = key => {
  if (!cells.has(key)) cells.set(key, Object.fromEntries(Object.keys(LAYERS).map(k => [k, []])));
  return cells.get(key);
};

for (const [layer, names] of Object.entries(LAYERS)) {
  console.log('处理', layer);
  const features = [];
  for (const name of names) {
    const fc = JSON.parse(fs.readFileSync(await download(name), 'utf8'));
    for (const f of fc.features) {
      if (!f.geometry) continue;
      const rank = f.properties.scalerank ?? f.properties.SCALERANK ?? 0;
      if (layer === 'coast' && rank > 6) continue; // 100 = 南极冰架边缘之类
      features.push({ type: 'Feature', properties: { r: rank }, geometry: f.geometry });
    }
  }
  // 一次读入，逐块裁剪；每块多留 0.02° 的边，相邻块的陆地填色互相盖住，不会露出接缝
  const pad = layer === 'land' ? .02 : 0;
  const cmds = ['-i in.json name=src'];
  const keys = [];
  for (let x = 0; x < 360 / CELL; x++) {
    for (let y = 0; y < 180 / CELL; y++) {
      const w = -180 + x * CELL, s = -90 + y * CELL;
      keys.push(`${x}_${y}`);
      cmds.push(`-clip bbox=${w - pad},${s - pad},${w + CELL + pad},${s + CELL + pad} target=src + name=c${x}_${y}`);
    }
  }
  cmds.push('-o target=* format=geojson precision=0.001');
  const out = await mapshaper.applyCommands(cmds.join(' '), { 'in.json': { type: 'FeatureCollection', features } });
  for (const key of keys) {
    const file = out[`c${key}.json`];
    if (!file) continue;
    for (const f of JSON.parse(file).features || []) { // 空块输出的是 GeometryCollection
      for (const p of parts(f.geometry)) {
        const isLine = typeof p[0][0] === 'number';
        const g = isLine ? dedupe(roundCoords(p)) : roundCoords(p).map(dedupe).filter(r => r.length >= 4);
        if (isLine ? g.length < 2 : !g.length) continue;
        cellOf(key)[layer].push(RANKED.has(layer) ? [f.properties.r, g] : g);
      }
    }
  }
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
let bytes = 0;
const index = [];
for (const [key, cell] of cells) {
  for (const k of Object.keys(cell)) if (!cell[k].length) delete cell[k];
  if (!Object.keys(cell).length) continue;
  const json = JSON.stringify(cell);
  fs.writeFileSync(path.join(OUT, `${key}.json`), json);
  bytes += json.length;
  index.push(key);
}
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({ cell: CELL, cells: index.sort() }));
console.log(`完成：${index.length} 块，共 ${(bytes / 1e6).toFixed(1)} MB`);
