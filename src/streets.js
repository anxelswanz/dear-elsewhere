// 截图（暗房）的街道层：OpenStreetMap 数据，经 OpenFreeMap 的矢量瓦片（OpenMapTiles 格式）取得。
// 拿到的是数据（线和面），由 snapshot.js 按手账风格自己画，不是截别人的底图图片。
//
// 合规：
//   - OSM 数据为 ODbL，OpenMapTiles 格式为 CC-BY，OpenFreeMap 要求署名 ——
//     凡是画了街道的截图，都在图上写明 STREETS_CREDIT（见 snapshot.js 的 drawCredit）
//   - OpenFreeMap 条款：同时最多 4 个请求；每张截图只取画面覆盖到的那几块瓦片

import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { routed } from './net.js';

export const STREETS_CREDIT = '© OpenStreetMap contributors · © OpenMapTiles · OpenFreeMap';
const TILEJSON = 'https://tiles.openfreemap.org/planet';
const MAX_TILE_ZOOM = 14;
const MAX_TILES = 24;
const PARALLEL = 4;
// 用到的图层；其余（POI、门牌号…）不取
const LAYERS = ['water', 'waterway', 'landcover', 'park', 'building', 'transportation', 'transportation_name'];

let template = null;
const tiles = new Map(); // "z/x/y" -> Promise<要素[]>

// 瓦片地址里带数据版本号，从 TileJSON 取
function tileUrl() {
  // 国内用户经本站 /ofm/ 转发（src/net.js），TileJSON 和瓦片都要换地址
  template ||= fetch(routed(TILEJSON)).then(r => r.json()).then(j => routed(j.tiles[0])).catch(e => { template = null; throw e; });
  return template;
}

// 解析一块瓦片：几何统一成「多边形 = [环…]」或「线 = [[lng, lat]…]」
function decode(buf, x, y, z) {
  const vt = new VectorTile(new PbfReader(buf));
  const out = [];
  for (const name of LAYERS) {
    const layer = vt.layers[name];
    if (!layer) continue;
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      const g = f.toGeoJSON(x, y, z).geometry;
      const p = f.properties;
      const base = { layer: name, cls: p.class || '', sub: p.subclass || '', brunnel: p.brunnel || '', props: p };
      if (g.type === 'Polygon') out.push({ ...base, polys: [g.coordinates] });
      else if (g.type === 'MultiPolygon') out.push({ ...base, polys: g.coordinates });
      else if (g.type === 'LineString') out.push({ ...base, lines: [g.coordinates] });
      else if (g.type === 'MultiLineString') out.push({ ...base, lines: g.coordinates });
    }
  }
  return out;
}

// 最多 PARALLEL 个请求同时进行
async function pool(jobs) {
  const results = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(PARALLEL, jobs.length) }, async () => {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await jobs[i]();
    }
  }));
  return results;
}

const lng2x = (lng, z) => ((lng + 180) / 360) * 2 ** z;
const lat2y = (lat, z) => {
  const r = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

// 取画面（west/south/east/north，经度可以超出 ±180）覆盖到的瓦片。
// 任何一块失败都返回 null：宁可不画街道，也不画出缺块的地图
export async function loadStreets({ west, south, east, north }, mapZoom) {
  // 一块瓦片在画面上大约占 512px，取的块数少、线条也足够细
  const z = Math.max(0, Math.min(MAX_TILE_ZOOM, Math.round(mapZoom) - 1));
  const n = 2 ** z;
  const x0 = Math.floor(lng2x(west, z)), x1 = Math.floor(lng2x(east, z));
  const y0 = Math.max(0, Math.floor(lat2y(north, z))), y1 = Math.min(n - 1, Math.floor(lat2y(south, z)));
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_TILES) return null;
  try {
    const url = await tileUrl();
    const jobs = [];
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const tx = ((x % n) + n) % n;
        const key = `${z}/${tx}/${y}`;
        jobs.push(() => {
          if (!tiles.has(key)) {
            tiles.set(key, fetch(url.replace('{z}', z).replace('{x}', tx).replace('{y}', y))
              .then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
              .then(buf => decode(buf, tx, y, z))
              .catch(e => { tiles.delete(key); throw e; }));
          }
          return tiles.get(key);
        });
      }
    }
    return { zoom: z, features: (await pool(jobs)).flat() };
  } catch {
    return null;
  }
}
