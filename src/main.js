// Dear Elsewhere（致远方）—— 旅行足迹地图，打卡数据（含照片）保存在浏览器 IndexedDB 中
import * as L from 'leaflet';
import { t, lang, applyStatic, localName } from './i18n.js';
import { initAuth, askLetter, avatarUrl } from './auth.js';
import { initSocial } from './social.js';
import { initChat } from './chat.js';
import { initSnapshot } from './snapshot.js';

applyStatic();
import { createSync, touch } from './sync.js';
//
// 层级：世界 -> 国家 -> 省/州 -> 城市 -> 具体地点
// 每条打卡记录（record）的 level 为 country / region / city / place，
// 并记录所属的 country / region / city id，用于点亮上级区域。

// ---------- 坐标转换：WGS84 <-> GCJ-02（高德瓦片使用 GCJ-02） ----------
const PI = Math.PI, AXIS = 6378245.0, EE = 0.00669342162296594323;

function outOfChina(lat, lng) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}
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
function wgs2gcj(lat, lng) {
  if (outOfChina(lat, lng)) return [lat, lng];
  let dLat = transformLat(lng - 105, lat - 35);
  let dLng = transformLng(lng - 105, lat - 35);
  const rad = lat / 180 * PI;
  let magic = Math.sin(rad);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180) / ((AXIS * (1 - EE)) / (magic * sqrtMagic) * PI);
  dLng = (dLng * 180) / (AXIS / sqrtMagic * Math.cos(rad) * PI);
  return [lat + dLat, lng + dLng];
}
function gcj2wgs(lat, lng) {
  const [gLat, gLng] = wgs2gcj(lat, lng);
  return [lat * 2 - gLat, lng * 2 - gLng];
}

// ---------- 几何工具（坐标均为 GeoJSON 的 [lng, lat]） ----------
const polygonsOf = geom =>
  geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];

function inRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function ringBBox(ring) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of ring) {
    if (x < b[0]) b[0] = x;
    if (y < b[1]) b[1] = y;
    if (x > b[2]) b[2] = x;
    if (y > b[3]) b[3] = y;
  }
  return b;
}

function featureAt(features, lng, lat) {
  return features.find(f => {
    const b = f._bbox ||= polygonsOf(f.geometry).map(p => ringBBox(p[0]))
      .reduce((a, c) => [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.max(a[2], c[2]), Math.max(a[3], c[3])]);
    if (lng < b[0] || lng > b[2] || lat < b[1] || lat > b[3]) return false;
    return polygonsOf(f.geometry).some(([outer, ...holes]) => inRing([lng, lat], outer) && !holes.some(h => inRing([lng, lat], h)));
  });
}

// 视野范围：以面积最大的多边形为主体，只并入离它不远的部分，
// 避免法属圭亚那、阿留申群岛这类飞地把视野拉得过大
function smartBounds(geom) {
  const parts = polygonsOf(geom).map(p => {
    const b = ringBBox(p[0]);
    return { b, area: (b[2] - b[0]) * (b[3] - b[1]) };
  });
  if (!parts.length) return null;
  const main = parts.reduce((a, c) => (c.area > a.area ? c : a));
  const cx = (main.b[0] + main.b[2]) / 2, cy = (main.b[1] + main.b[3]) / 2;
  const limit = Math.max(Math.hypot(main.b[2] - main.b[0], main.b[3] - main.b[1]), 3);
  const bounds = L.latLngBounds([]);
  for (const { b } of parts) {
    if (Math.hypot((b[0] + b[2]) / 2 - cx, (b[1] + b[3]) / 2 - cy) > limit) continue;
    bounds.extend(toMap(b[1], b[0])).extend(toMap(b[3], b[2]));
  }
  return bounds;
}

function distKm(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * r / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lng2 - lng1) * r / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

// ---------- 行政区数据（由 scripts/build-data.mjs 生成） ----------
const geo = {
  world: null,
  countryById: new Map(),   // A3 -> 国家 feature
  regionById: new Map(),    // regionId -> { id, name, en, country }
  cityById: new Map(),      // cityId -> { id, name, en, country, region, lat, lng, rank }
  cities: [],
  regions: new Map(),       // A3 -> 省/州 FeatureCollection
  regionCities: new Map(),  // regionId -> 城市边界 FeatureCollection（仅中国）
};

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function withLoading(promise) {
  const timer = setTimeout(() => { $('#loading').hidden = false; }, 200);
  try { return await promise; } finally { clearTimeout(timer); $('#loading').hidden = true; }
}

// 按界面语言改写要素的 name，原来的中文名留在 zh
function localize(props, en) {
  props.zh = props.name;
  props.name = localName(props.name, en);
}

async function loadBase() {
  const [world, index] = await Promise.all([fetchJson('data/world.json'), fetchJson('data/index.json')]);
  geo.world = world;
  world.features.forEach(f => {
    localize(f.properties, f.properties.en);
    geo.countryById.set(f.properties.id, f);
  });
  index.regions.forEach(([id, name, en, country]) => geo.regionById.set(id, { id, name: localName(name, en), zh: name, en, country }));
  index.cities.forEach(([id, name, en, country, region, lat, lng, rank]) => {
    const c = { id, name: localName(name, en), zh: name, en, country, region, lat, lng, rank };
    geo.cities.push(c);
    geo.cityById.set(id, c);
  });
}

async function loadRegions(country) {
  if (!geo.regions.has(country)) {
    let fc = { type: 'FeatureCollection', features: [] };
    try { fc = await withLoading(fetchJson(`data/country/${country}.json`)); } catch { /* 无下级行政区 */ }
    fc.features.forEach(f => localize(f.properties, f.properties.en));
    geo.regions.set(country, fc);
  }
  return geo.regions.get(country);
}

// 只有中国的省份带城市边界文件，其余国家的城市是点
const hasCityShapes = regionId => regionId.startsWith('CN');

async function loadRegionCities(regionId) {
  if (!hasCityShapes(regionId)) return null;
  if (!geo.regionCities.has(regionId)) {
    const fc = await withLoading(fetchJson(`data/region/${regionId}.json`));
    fc.features.forEach(f => localize(f.properties, geo.cityById.get(f.properties.id)?.en));
    geo.regionCities.set(regionId, fc);
  }
  return geo.regionCities.get(regionId);
}

const countryName = id => geo.countryById.get(id)?.properties.name || '';
const regionName = id => geo.regionById.get(id)?.name || '';
const cityName = id => geo.cityById.get(id)?.name || '';
const countryZh = id => geo.countryById.get(id)?.properties.zh || '';
const regionZh = id => geo.regionById.get(id)?.zh || '';
const cityZh = id => geo.cityById.get(id)?.zh || '';
const countryEn = id => geo.countryById.get(id)?.properties.en || '';
const regionEn = id => geo.regionById.get(id)?.en || '';
const cityEn = id => geo.cityById.get(id)?.en || '';

// 标准层级：国家 / 一级行政区 / 城市，如 United Kingdom / England / Cambridge
// name 是界面语言下的名字；zh / en 分别是中文、英文名
function pathOf(r) {
  return [
    r.country && { level: 'country', id: r.country, name: countryName(r.country), zh: countryZh(r.country), en: countryEn(r.country) },
    r.region && { level: 'region', id: r.region, name: regionName(r.region), zh: regionZh(r.region), en: regionEn(r.region) },
    r.city && { level: 'city', id: r.city, name: cityName(r.city), zh: cityZh(r.city), en: cityEn(r.city) },
  ].filter(p => p && p.name);
}
// 副标题：中文界面配英文名，英文界面配中文名
const altName = (level, id) => (lang === 'zh'
  ? (level === 'country' ? countryEn : level === 'region' ? regionEn : cityEn)(id)
  : (level === 'country' ? countryZh : level === 'region' ? regionZh : cityZh)(id));
const regionFeature = id => geo.regions.get(geo.regionById.get(id)?.country)?.features.find(f => f.properties.id === id);
const cityFeature = id => geo.regionCities.get(geo.cityById.get(id)?.region)?.features.find(f => f.properties.id === id);

// ---------- IndexedDB ----------
// 每个账号一个库（mymap-{用户 id}）；登录前的旧库 mymap 只在第一次登录时迁移
const makeDb = () => ({
  _db: null,
  open(name) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 2);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (d.objectStoreNames.contains('checkins')) return;
        const store = d.createObjectStore('checkins', { keyPath: 'id' });
        // 迁移第一版的 places
        if (d.objectStoreNames.contains('places')) {
          req.transaction.objectStore('places').getAll().onsuccess = e => e.target.result.forEach(p => store.put(fromV1(p)));
        }
      };
      req.onsuccess = () => { this._db = req.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  },
  _tx(mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction('checkins', mode);
      const req = fn(tx.objectStore('checkins'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    });
  },
  all() { return this._tx('readonly', s => s.getAll()); },
  put(r) { return this._tx('readwrite', s => s.put(r)); },
  del(id) { return this._tx('readwrite', s => s.delete(id)); },
  clear() { return this._tx('readwrite', s => s.clear()); },
});
const db = makeDb();

// ---------- 状态 ----------
let records = [];          // 界面上显示的记录
let tombstones = [];       // 已删除、等待同步给其他设备的记录
let sync = null;
let social = null;          // 好友与动态，登录后创建
let chat = null;            // 好友私聊，登录后创建
let me = null;              // 当前用户 id
let visited = { country: new Set(), region: new Set(), city: new Set() };
let view = { level: 'world' };
let currentId = null;
const photoUrls = new Map(); // photoId -> objectURL

const $ = sel => document.querySelector(sel);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const today = () => new Date().toISOString().slice(0, 10);
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// 线性图标（代替 emoji），颜色跟随文字
const ICONS = {
  camera: '<path d="M4 8.5h3.2l1.8-2.5h6l1.8 2.5H20V19H4z"/><circle cx="12" cy="13.3" r="3.3"/>',
  pin: '<path d="M12 21s-6.5-6.1-6.5-11a6.5 6.5 0 0 1 13 0c0 4.9-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
  home: '<path d="M4 11l8-6.5 8 6.5"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-5h4v5"/>',
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
  coffee: '<path d="M5 9h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5z"/><path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16"/><path d="M8.5 3.5c0 1.5 1 1.5 1 3M12.5 3.5c0 1.5 1 1.5 1 3"/>',
  food: '<path d="M7 3v8a2 2 0 0 0 2 2v8M5 3v5M9 3v5"/><path d="M17 21V3c-2 1.5-3 4-3 7v3h3"/>',
  museum: '<path d="M3 9.5L12 4l9 5.5z"/><path d="M5.5 10v8M9.8 10v8M14.2 10v8M18.5 10v8M3 20h18"/>',
  church: '<path d="M12 2v5M10 4h4"/><path d="M6 21v-9l6-4 6 4v9z"/><path d="M10 21v-4a2 2 0 0 1 4 0v4"/>',
  castle: '<path d="M4 21V8h3v3h2V8h6v3h2V8h3v13z"/><path d="M10 21v-4a2 2 0 0 1 4 0v4"/>',
  mountain: '<path d="M2 20L9 7l4 7 2-3 7 9z"/><path d="M7.4 10l1.6 1.5L10.7 10"/>',
  beach: '<path d="M4 11a8 8 0 0 1 16 0z"/><path d="M12 11v8"/><path d="M3 21c2-1.3 4-1.3 6 0s4 1.3 6 0 4-1.3 6 0"/>',
  tree: '<path d="M12 3l-6 8h3l-4 6h14l-4-6h3z"/><path d="M12 17v4"/>',
  shop: '<path d="M5 8h14l-1 13H6z"/><path d="M9 10V6a3 3 0 0 1 6 0v4"/>',
  bed: '<path d="M3 19V6M3 15h18v4M21 15v-3a3 3 0 0 0-3-3h-7v6"/><circle cx="7" cy="11" r="2"/>',
  plane: '<path d="M2.5 12.5L21 4.5l-6 16-3.5-6.5z"/><path d="M11.5 14L21 4.5"/>',
  train: '<rect x="6" y="3" width="12" height="13" rx="3"/><path d="M6 10h12M9 20l-2 2M15 20l2 2M9.5 13h.01M14.5 13h.01"/>',
  users: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19.5c.6-3.3 2.8-5 5.5-5s4.9 1.7 5.5 5"/><path d="M15.5 5.6a3.2 3.2 0 0 1 0 5.8M17.5 14.8c1.6.6 2.7 2.2 3 4.7"/>',
};
// 打卡标记上可以插的图标
const MARKER_ICONS = [
  'pin', 'heart', 'star', 'camera', 'coffee', 'food', 'museum', 'church',
  'castle', 'mountain', 'beach', 'tree', 'shop', 'bed', 'plane', 'train',
].map(id => [id, t(`icon.${id}`)]);
const icon = name => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
const photoCount = n => (n ? `<span class="pc-count">${icon('camera')}${n}</span>` : '');

const LEVEL_LABEL = Object.fromEntries(['world', 'country', 'region', 'city', 'place'].map(l => [l, t(`level.${l}`)]));

function newRecord(level, fields) {
  return {
    id: uid(), level, ref: '', name: '', country: '', region: '', city: '',
    lat: null, lng: null, date: today(), note: '', photos: [], marker: 'sign', icon: 'pin', label: '', createdAt: Date.now(),
    updatedAt: Date.now(), dirty: true, deletedPhotos: [], ...fields,
  };
}

// 第一版只有地点，所属国家/城市是文字，载入后重新计算
const fromV1 = p => newRecord('place', { ...p, level: 'place', country: '', region: '', city: '' });

function newMark(level, id) {
  if (level === 'country') return newRecord(level, { ref: id, country: id, name: countryName(id) });
  if (level === 'region') {
    const r = geo.regionById.get(id);
    return newRecord(level, { ref: id, country: r.country, region: id, name: r.name });
  }
  const c = geo.cityById.get(id);
  return newRecord(level, { ref: id, country: c.country, region: c.region, city: id, name: c.name, lat: c.lat, lng: c.lng });
}

const findMark = (level, id) => records.find(r => r.level === level && r.ref === id);
const recordsIn = (level, id) => (level === 'world' ? records : records.filter(r => r[level] === id));
const places = () => records.filter(r => r.level === 'place');

function photoUrl(photo) {
  if (photo.url) return photo.url; // 好友的照片：私有存储的签名链接
  if (!photoUrls.has(photo.id)) photoUrls.set(photo.id, URL.createObjectURL(photo.blob));
  return photoUrls.get(photo.id);
}

function revokePhoto(photo) {
  const url = photoUrls.get(photo.id);
  if (url) { URL.revokeObjectURL(url); photoUrls.delete(photo.id); }
}

async function saveRecord(r) {
  touch(r);
  await db.put(r);
  if (!records.includes(r)) records.push(r);
  refresh();
  sync?.request();
}

// 删除只打墓碑标记，照片文件不再保留在本地
async function removeRecord(r) {
  r.photos.forEach(revokePhoto);
  r.photos = r.photos.map(({ id, up }) => ({ id, up, blob: null }));
  r.deleted = true;
  touch(r);
  await db.put(r);
  records = records.filter(x => x !== r);
  tombstones.push(r);
  if (currentId === r.id) closeEditor();
  refresh();
  sync?.request();
}

// 同步拉取或推送后，把合并好的记录放回界面
let refreshQueued = false;
function applySynced(r) {
  const shown = records.includes(r);
  if (r.deleted && shown) {
    records = records.filter(x => x !== r);
    if (currentId === r.id) closeEditor();
  }
  if (r.deleted && !tombstones.includes(r)) tombstones.push(r);
  if (!r.deleted && !shown) {
    tombstones = tombstones.filter(x => x !== r);
    records.push(r);
  }
  if (refreshQueued) return;
  refreshQueued = true;
  requestAnimationFrame(() => { refreshQueued = false; refresh(); });
}

function refresh() {
  visited = { country: new Set(), region: new Set(), city: new Set() };
  for (const r of records) {
    if (r.country) visited.country.add(r.country);
    if (r.region) visited.region.add(r.region);
    if (r.city) visited.city.add(r.city);
  }
  worldLayer?.setStyle(countryStyle);
  drawLevelLayers();
  renderPlaces();
  renderSidebar();
  const cur = records.find(r => r.id === currentId);
  if (cur) fillEditor(cur);
}

// ---------- 地图 ----------
const baseLayers = {
  [t('base.gaode')]: L.tileLayer(`https://webrd0{s}.is.autonavi.com/appmaptile?lang=${lang === 'en' ? 'en' : 'zh_cn'}&size=1&scale=1&style=8&x={x}&y={y}&z={z}`, {
    subdomains: '1234', maxZoom: 18, attribution: '© AMap 高德地图', gcj: true,
  }),
  [t('base.gaodeSat')]: L.tileLayer('https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}', {
    subdomains: '1234', maxZoom: 18, attribution: '© AMap 高德地图', gcj: true,
  }),
  [t('base.intl')]: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, attribution: 'Tiles © Esri',
  }),
  'OpenStreetMap': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap',
  }),
};
// 高德在国外没有详细数据，浏览国外时自动换成国际底图；手动选择底图后不再自动切换
const GAODE_COVERED = new Set(['CHN', 'HKG', 'MAC', 'TWN']);
let autoBase = true;
let switchingBase = false;

const WORLD_VIEW = [[30, 90], 2];
// 无边界：左右无限循环（worldCopyJump + 每个图层画三份），上下锁在墨卡托有效范围内不露空白
const map = L.map('map', {
  minZoom: 2, worldCopyJump: true, preferCanvas: true,
  maxBounds: [[-85.0511, -540], [85.0511, 540]], maxBoundsViscosity: 1,
}).setView(...WORLD_VIEW);
// 世界高度（256 × 2^z 像素）至少要铺满窗口高度
const fitMinZoom = () => map.setMinZoom(Math.max(1, Math.ceil(Math.log2(map.getSize().y / 256))));
fitMinZoom();
map.on('resize', fitMinZoom);
let activeLayer = baseLayers[t('base.gaode')].addTo(map);
L.control.layers(baseLayers, null, { position: 'topright' }).addTo(map);
L.control.scale({ imperial: false }).addTo(map);

const useGcj = () => !!activeLayer.options.gcj;
// 数据统一存 WGS84，显示时按当前底图转换
const toMap = (lat, lng) => (useGcj() ? wgs2gcj(lat, lng) : [lat, lng]);
const fromMap = (lat, lng) => (useGcj() ? gcj2wgs(lat, lng) : [lat, lng]);
// 每份世界在经度上偏移 360°，拖到哪里都有边界和标记
const WORLD_COPIES = [-360, 0, 360];
const toMapAt = (lat, lng, offset) => {
  const [a, b] = toMap(lat, lng);
  return [a, b + offset];
};
// 点击到相邻那份世界时，经度折回 [-180, 180]
const wrapLng = lng => L.Util.wrapNum(lng, [-180, 180], true);

const renderer = L.canvas({ padding: 0.5 });
const overlay = L.layerGroup().addTo(map);     // 省/州、城市
const placeLayer = L.layerGroup().addTo(map);  // 具体地点
let worldLayer = null;

map.on('baselayerchange', e => {
  if (!switchingBase) autoBase = false;
  const c = map.getCenter();
  const [wLat, wLng] = fromMap(c.lat, c.lng);
  activeLayer = e.layer;
  map.setView(toMap(wLat, wLng), map.getZoom(), { animate: false });
  drawWorld();
  refresh();
});

function autoPickBase() {
  if (!autoBase) return;
  const want = baseLayers[t(!view.country || GAODE_COVERED.has(view.country) ? 'base.gaode' : 'base.intl')];
  if (want === activeLayer) return;
  switchingBase = true;
  map.removeLayer(activeLayer);
  map.addLayer(want); // 触发 baselayerchange，统一处理坐标与重绘
  switchingBase = false;
}

// ---------- 样式 ----------
const COLOR = { accent: '#e8590c', line: '#8b95a5', dim: '#1f2937' };
const VISITED = { color: COLOR.accent, weight: 1, fillColor: COLOR.accent, fillOpacity: 0.4 };
const OPEN = { color: '#5b6577', weight: 1.2, fillColor: COLOR.line, fillOpacity: 0.06 };
const CURRENT = { color: COLOR.accent, weight: 2.5, fillColor: COLOR.accent, fillOpacity: 0 };
const DIMMED = v => ({ color: COLOR.line, weight: 0.5, fillColor: v ? COLOR.accent : COLOR.dim, fillOpacity: v ? 0.15 : 0.12 });

// 每一级：正在查看的区域透明高亮，同级其他区域变暗，下一级按是否去过上色
function countryStyle(f) {
  const id = f.properties.id;
  if (view.level === 'world') return visited.country.has(id) ? VISITED : OPEN;
  return id === view.country ? CURRENT : DIMMED(visited.country.has(id));
}

function regionStyle(f) {
  const id = f.properties.id;
  if (view.level === 'country') return visited.region.has(id) ? VISITED : OPEN;
  return id === view.region ? CURRENT : DIMMED(visited.region.has(id));
}

function cityStyle(f) {
  const id = f.properties.id;
  if (view.level === 'region') return visited.city.has(id) ? VISITED : OPEN;
  return id === view.city ? { ...CURRENT, weight: 3 } : DIMMED(visited.city.has(id));
}

function geoLayer(fc, styleFn, level) {
  return L.featureGroup(WORLD_COPIES.map(offset => L.geoJSON(fc, {
    renderer, style: styleFn, bubblingMouseEvents: false,
    coordsToLatLng: c => L.latLng(toMapAt(c[1], c[0], offset)),
    onEachFeature: (f, layer) => {
      layer.bindTooltip(f.properties.name, { sticky: true, direction: 'top', className: 'geo-tip' });
      layer.on('click', e => {
        // 进入城市或放得足够大时，点击用于添加具体地点
        if (view.level === 'city' || map.getZoom() >= 13) showAddPopup(e.latlng);
        else goTo(level, f.properties.id);
      });
      layer.on('mouseover', () => {
        if (view.level === 'city') return;
        const s = styleFn(f);
        layer.setStyle({ weight: s.weight + 1.5, fillOpacity: Math.min(0.7, s.fillOpacity + 0.15) });
      });
      layer.on('mouseout', () => layer.setStyle(styleFn(f)));
    },
  })));
}

function drawWorld() {
  if (worldLayer) map.removeLayer(worldLayer);
  worldLayer = geoLayer(geo.world, countryStyle, 'country').addTo(map);
  worldLayer.bringToBack();
}

function cityDot(c, label) {
  const v = visited.city.has(c.id);
  return L.featureGroup(WORLD_COPIES.map(offset => L.circleMarker(toMapAt(c.lat, c.lng, offset), {
    renderer, bubblingMouseEvents: false,
    radius: c.rank <= 2 ? 6 : c.rank <= 5 ? 5 : 4,
    color: v ? '#fff' : COLOR.accent, weight: 2,
    fillColor: v ? COLOR.accent : '#fff', fillOpacity: 1,
  })
    .bindTooltip(c.name, label
      ? { permanent: true, direction: 'right', className: 'city-label' }
      : { direction: 'top', className: 'geo-tip' })
    .on('click', () => goTo('city', c.id))));
}

function drawLevelLayers() {
  overlay.clearLayers();
  if (view.level === 'world') {
    geo.cities.filter(c => visited.city.has(c.id)).forEach(c => overlay.addLayer(cityDot(c, false)));
    return;
  }

  overlay.addLayer(geoLayer(geo.regions.get(view.country), regionStyle, 'region'));

  let drawn = new Set();
  if (view.level === 'region' || view.level === 'city') {
    const shapes = geo.regionCities.get(view.region);
    if (shapes) {
      overlay.addLayer(geoLayer(shapes, cityStyle, 'city'));
      shapes.features.forEach(f => drawn.add(f.properties.id));
    } else if (view.level === 'region') {
      const list = geo.cities.filter(c => c.region === view.region);
      const labelAll = list.length <= 25;
      list.forEach(c => overlay.addLayer(cityDot(c, labelAll || c.rank <= 5 || visited.city.has(c.id))));
      drawn = new Set(list.map(c => c.id));
    }
  }
  // 其他地方去过的城市也显示出来
  geo.cities
    .filter(c => visited.city.has(c.id) && !drawn.has(c.id) && c.id !== view.city)
    .forEach(c => overlay.addLayer(cityDot(c, view.level !== 'city')));
}

// ---------- 具体地点 ----------
// 打卡标记：没有照片时用用户选的带名字的动画样式，有照片时显示前三张叠放；都带到达日期
const MARKER_STYLES = ['sign', 'flag', 'neon', 'stamp', 'pin'].map(id => ({ id, name: t(`style.${id}`) }));
const fmtDate = d => (d || '').replaceAll('-', '.');
const seenMarkers = new Set(); // 已经播过入场动画的标记

// 牌子上的文字：用户自己写的优先，否则用地名
const markerText = r => (r.label || '').trim() || r.name || t('unnamed');

// chat：有评论时在标记上方留一个滚动评论的位置；badge：好友的头像角标
function markerHtml(r, opts = {}) {
  const html = markerBody(r, opts);
  if (!opts.chat && !opts.badge) return html;
  const chat = opts.chat ? `<div class="mk-chat" data-chat="${escapeHtml(opts.chat)}" hidden></div>` : '';
  const badge = opts.badge ? `<img class="mk-badge" src="${opts.badge}" alt="" />` : '';
  // 每种样式都是一个 <div class="mk …"> 根元素，且只有一处地名 <span class="mk-txt">：气泡放最前，头像放在地名前
  return html.replace(/^(<div class="mk[^"]*)(">)/, `$1${opts.badge ? ' mk-friend' : ''}$2${chat}`)
    .replace('<span class="mk-txt">', `${badge}<span class="mk-txt">`);
}

function markerBody(r, { style = r.marker || 'sign', usePhotos = true, enter = false } = {}) {
  const text = `<span class="mk-txt"><b>${escapeHtml(markerText(r))}</b><time>${fmtDate(r.date)}</time></span>`;
  const ico = icon(ICONS[r.icon] ? r.icon : 'pin');
  const cls = `mk${enter ? ' enter' : ''}`;
  if (usePhotos && r.photos.length) {
    // 倒序输出，封面在最上层
    const imgs = r.photos.slice(0, 3).map((p, i) => `<img class="p${i + 1}" src="${photoUrl(p)}" alt="" />`).reverse().join('');
    return `<div class="${cls} mk-photos"><div class="mk-stack">${imgs}</div><div class="mk-cap">${text}</div><i class="mk-dot"></i></div>`;
  }
  switch (style) {
    case 'flag':
      return `<div class="${cls} mk-flag"><div class="flag-cloth">${ico}${text}</div><i class="flag-pole"></i></div>`;
    case 'neon':
      return `<div class="${cls} mk-neon"><div class="neon-plate">${ico}${text}</div><i class="neon-stem"></i></div>`;
    case 'stamp':
      return `<div class="${cls} mk-stamp"><div class="stamp-ink">${ico}<span class="mk-txt"><small>VISITED</small><b>${escapeHtml(markerText(r))}</b><time>${fmtDate(r.date)}</time></span></div><i class="mk-dot"></i></div>`;
    case 'pin':
      // 选了定位以外的图标：插一枚圆形图标徽章代替水滴针
      return `<div class="${cls} mk-pin"><div class="pin-label">${text}</div>${(r.icon || 'pin') === 'pin'
        ? '<i class="pin-head"></i>'
        : `<i class="pin-badge">${ico}</i><i class="pin-stake"></i>`}<i class="pin-pulse"></i></div>`;
    default:
      return `<div class="${cls} mk-sign"><div class="sign-board">${ico}${text}</div><i class="sign-pole"></i></div>`;
  }
}

// 图标本身 0×0 落在坐标点上，内容向上展开，宽度随名字自适应
const markerIcon = (r, opts) =>
  L.divIcon({ className: 'mk-anchor', iconSize: [0, 0], iconAnchor: [0, 0], html: markerHtml(r, opts) });

let highlight = null; // 从动态飞过来时，高亮这条打卡

function renderPlaces() {
  placeLayer.clearLayers();
  const z = map.getZoom();
  $('#map').classList.toggle('mk-far', z < 12);
  if (view.level !== 'city' && z < 8) return;
  const chatOf = key => (z >= 12 && social?.comments(key).length ? key : null);
  const own = places().map(r => ({ r, key: `${me}/${r.id}`, click: () => openEditor(r.id) }));
  const friends = (social?.pins() || []).map(p => ({
    r: p, key: p.key, badge: avatarUrl(p.owner?.avatar || 'a01'),
    click: () => p.published && social.openPost(p.key),
  }));
  for (const { r, key, badge, click } of [...friends, ...own]) {
    const seen = [key, r.marker, r.icon, r.photos.slice(0, 3).map(p => p.id)].join('|');
    const enter = !seenMarkers.has(seen);
    seenMarkers.add(seen);
    const opts = { enter, chat: chatOf(key), badge };
    for (const offset of WORLD_COPIES) {
      const m = L.marker(toMapAt(r.lat, r.lng, offset), { icon: markerIcon(r, opts), riseOnHover: true, zIndexOffset: badge ? 0 : 500 })
        .on('click', click)
        .addTo(placeLayer);
      if (highlight === key) m.getElement()?.querySelector('.mk')?.classList.add('mk-hi');
    }
  }
  updateChats(false);
}

// ---------- 标记上的评论走马灯：每 3 秒换一条，视野里最多 8 个 ----------
let chatTick = 0;
function updateChats(advance = true) {
  if (advance) chatTick++;
  if (!social) return;
  const box = map.getContainer().getBoundingClientRect();
  const els = [...document.querySelectorAll('#map .mk-chat')];
  const inView = el => {
    const r = el.parentElement.getBoundingClientRect();
    return r.right > box.left && r.left < box.right && r.bottom > box.top + 70 && r.top < box.bottom;
  };
  const latest = el => Date.parse(social.comments(el.dataset.chat).at(-1)?.created_at || 0);
  const shown = new Set(els.filter(inView).sort((a, b) => latest(b) - latest(a)).slice(0, 8));
  els.forEach((el, i) => {
    const recent = social.comments(el.dataset.chat).slice(-5); // 最近 5 条轮播
    if (!shown.has(el) || !recent.length) { el.hidden = true; return; }
    el.hidden = false;
    const c = recent[(chatTick + i) % recent.length];
    if (el.dataset.cid === c.id) return;
    el.dataset.cid = c.id;
    const a = social.author(c.author);
    el.innerHTML = `<span class="chat-line"><img src="${avatarUrl(a?.avatar || 'a01')}" alt="" /><b>${escapeHtml(a?.name || '')}</b><span>${escapeHtml(c.body)}</span></span>`;
  });
}
setInterval(() => document.visibilityState === 'visible' && updateChats(), 3000);
map.on('moveend', () => updateChats(false));

function showAddPopup(latlng, name = '') {
  const box = document.createElement('div');
  box.className = 'checkin-popup';
  box.innerHTML = name
    ? `<b>${escapeHtml(name)}</b><small>${t('checkInHere')}</small>`
    : `<small>${t('addPlaceHere')}</small>`;
  const btn = document.createElement('button');
  btn.innerHTML = `${icon('pin')}${t('checkIn')}`;
  box.append(btn);
  const popup = L.popup().setLatLng(latlng).setContent(box).openOn(map);
  btn.onclick = () => {
    map.closePopup(popup);
    addPlace(...fromMap(latlng.lat, wrapLng(latlng.lng)), name);
  };
}

map.on('click', e => {
  if (view.level === 'city' || map.getZoom() >= 13) showAddPopup(e.latlng);
});

// 判断一个坐标属于哪个国家 / 省 / 城市
async function locate(lat, lng) {
  const loc = { country: '', region: '', city: '' };
  loc.country = featureAt(geo.world.features, lng, lat)?.properties.id || view.country || '';
  if (!loc.country) return loc;

  const regions = await loadRegions(loc.country);
  loc.region = featureAt(regions.features, lng, lat)?.properties.id
    || (view.country === loc.country ? view.region || '' : '');
  if (!loc.region) return loc;

  const shapes = await loadRegionCities(loc.region);
  if (shapes) {
    loc.city = featureAt(shapes.features, lng, lat)?.properties.id || '';
  } else {
    // 城市只有中心点：当前查看的城市优先，否则取 50km 内最近的城市
    const cur = geo.cityById.get(view.city);
    if (view.level === 'city' && cur && distKm(lat, lng, cur.lat, cur.lng) < 60) {
      loc.city = cur.id;
    } else {
      let best = null, bestD = 50;
      for (const c of geo.cities) {
        if (c.country !== loc.country) continue;
        const d = distKm(lat, lng, c.lat, c.lng);
        if (d < bestD) { bestD = d; best = c; }
      }
      loc.city = best?.id || '';
    }
  }
  if (loc.city) loc.region = geo.cityById.get(loc.city).region;
  return loc;
}

async function reverseName(lat, lng) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&accept-language=zh-CN`;
    const data = await (await fetch(url, { signal: ctrl.signal })).json();
    const a = data.address || {};
    return data.name || a.attraction || a.tourism || a.road || a.suburb || '';
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

async function addPlace(lat, lng, knownName = '') {
  const r = newRecord('place', { lat, lng, name: knownName, ...(await locate(lat, lng)) });
  await saveRecord(r);
  openEditor(r.id);
  if (knownName) return;
  const name = await reverseName(lat, lng);
  if (name && !r.name) {
    r.name = name;
    await saveRecord(r);
  }
}

// ---------- 层级导航 ----------
async function go(next, { fly = true } = {}) {
  if (next.country) await loadRegions(next.country);
  if (next.region) await loadRegionCities(next.region);
  view = next;
  autoPickBase();
  $('#map').dataset.level = view.level;
  worldLayer.eachLayer(copy => copy.eachLayer(l => l.closeTooltip()));
  worldLayer.setStyle(countryStyle);
  drawLevelLayers();
  renderPlaces();
  renderSidebar();
  $('#panel').scrollTop = 0;
  renderCrumbs();
  if (fly) flyToView();
}

function goTo(level, id) {
  if (level === 'world') return go({ level });
  if (level === 'country') return go({ level, country: id });
  if (level === 'region') {
    const r = geo.regionById.get(id);
    return go({ level, country: r.country, region: id });
  }
  const c = geo.cityById.get(id);
  return go({ level: 'city', country: c.country, region: c.region, city: id });
}

function boundsOf(v) {
  if (v.level === 'country') return smartBounds(geo.countryById.get(v.country).geometry);
  if (v.level === 'region') {
    const f = regionFeature(v.region);
    return f ? smartBounds(f.geometry) : boundsOf({ level: 'country', country: v.country });
  }
  if (v.level === 'city') {
    const f = cityFeature(v.city);
    if (f) return smartBounds(f.geometry);
    const c = geo.cityById.get(v.city);
    const [lat, lng] = toMap(c.lat, c.lng);
    return L.latLng(lat, lng).toBounds(16000); // 无边界的城市：中心点周围约 16km
  }
  return null;
}

const FIT = { padding: [40, 40] };
const fitZoom = b => map.getBoundsZoom(b, false, L.point(80, 80));

function flyToView() {
  const b = boundsOf(view);
  if (b) map.flyToBounds(b, { ...FIT, duration: 0.9 });
  else map.flyTo(...WORLD_VIEW, { duration: 0.9 });
}

// 手动缩小到超出当前区域时，自动回到上一级
const parentOf = v =>
  v.level === 'city' ? { level: 'region', country: v.country, region: v.region }
  : v.level === 'region' ? { level: 'country', country: v.country }
  : v.level === 'country' ? { level: 'world' } : null;

map.on('zoomend', () => {
  renderPlaces();
  const z = map.getZoom();
  let next = view;
  while (next.level !== 'world') {
    const parent = parentOf(next);
    const target = parent.level === 'world' ? next : parent;
    const threshold = fitZoom(boundsOf(target)) - (parent.level === 'world' ? 1 : 0);
    if (z >= threshold) break;
    next = parent;
  }
  if (next !== view) go(next, { fly: false });
});

function renderCrumbs() {
  const items = [['world', '', t('world')]];
  if (view.country) items.push(['country', view.country, countryName(view.country)]);
  if (view.region) items.push(['region', view.region, regionName(view.region)]);
  if (view.city) items.push(['city', view.city, cityName(view.city)]);
  $('#crumbs').innerHTML = items.map(([level, id, name], i) => (i === items.length - 1
    ? `<b title="${escapeHtml(name)}">${escapeHtml(name)}</b>`
    : `<a data-level="${level}" data-id="${id}" title="${escapeHtml(name)}">${escapeHtml(name)}</a><span class="sep">›</span>`)).join('');
}

$('#crumbs').addEventListener('click', e => {
  const a = e.target.closest('a[data-level]');
  if (a) goTo(a.dataset.level, a.dataset.id);
});

// ---------- 我的足迹面板 ----------
const sortVisitedFirst = (list, isVisited, tiebreak) =>
  list.sort((a, b) => (isVisited(b) - isVisited(a)) || tiebreak(a, b));
const byName = (a, b) => a.name.localeCompare(b.name, lang === 'zh' ? 'zh-CN' : 'en');

function row({ level, id, name, visited: v, meta = '' }) {
  return `<div class="row${v ? ' visited' : ''}" data-level="${level}" data-id="${escapeHtml(id)}">
    <span class="label"><i class="dot"></i><span>${escapeHtml(name)}</span></span><small>${meta}</small></div>`;
}

function summary(list) {
  const cities = new Set(list.map(r => r.city).filter(Boolean)).size;
  const n = list.filter(r => r.level === 'place').length;
  return [cities && t('sumCities', { n: cities }), n && t('sumPlaces', { n })].filter(Boolean).join(' · ');
}

function thumbs(list) {
  const photos = list.flatMap(r => r.photos);
  if (!photos.length) return '';
  const more = photos.length - 5;
  return `<div class="thumbs">${photos.slice(0, 5).map(p => `<img src="${photoUrl(p)}" data-photo alt="" />`).join('')}${
    more > 0 ? `<span class="thumbs-more">+${more}</span>` : ''}</div>`;
}

function entityCard(level, id, name, sub) {
  const mark = findMark(level, id);
  const inside = recordsIn(level, id);
  const alt = altName(level, id);
  return `<section class="card">
    <p class="kicker">${LEVEL_EN[level]}${lang === 'zh' ? ` · ${LEVEL_LABEL[level]}` : ''}</p>
    <h2>${escapeHtml(name)}</h2>
    ${alt && alt !== name ? `<p class="card-en">${escapeHtml(alt)}</p>` : ''}
    <p class="card-sub">${sub}</p>
    <div class="card-actions">
      <button data-act="mark" class="${mark ? 'on' : ''}">${mark ? `${icon('check')}${t('visited')}` : `${icon('plus')}${t('markVisited')}`}</button>
      <button data-act="edit">${icon('camera')}${t('photosNotes')}${mark && mark.photos.length ? `<i>${mark.photos.length}</i>` : ''}</button>
    </div>
    ${thumbs(inside)}
  </section>`;
}

// 足迹按标准层级归档：国家 -> 一级行政区 -> 城市 -> 地点
function footprintTree() {
  const tree = new Map();
  const node = (m, id) => {
    if (!m.has(id)) m.set(id, { id, children: new Map(), places: [], records: [] });
    return m.get(id);
  };
  for (const r of records) {
    if (!r.country) continue;
    let n = node(tree, r.country);
    n.records.push(r);
    for (const key of ['region', 'city']) {
      if (!r[key]) break;
      n = node(n.children, r[key]);
      n.records.push(r);
    }
    if (r.level === 'place') n.places.push(r);
  }
  return tree;
}

function renderTree() {
  const tree = footprintTree();
  if (!tree.size) {
    return `<div class="empty-card">${icon('pin')}<b>${t('emptyTitle')}</b><span>${t('emptySub')}</span></div>`;
  }
  const sorted = m => [...m.values()].sort((a, b) => b.records.length - a.records.length);
  const head = (level, id, name, alt, meta) => `<summary>
      <span class="fp-name" data-nav="${level}" data-id="${escapeHtml(id)}">${escapeHtml(name)}</span>
      ${alt && alt !== name ? `<em>${escapeHtml(alt)}</em>` : ''}<small>${meta}</small></summary>`;
  const placesHtml = list => list.map(p => `<div class="fp-place" data-nav="place" data-id="${p.id}">
      <span>${escapeHtml(p.name || t('unnamed'))}</span><small>${photoCount(p.photos.length)}</small></div>`).join('');
  const branch = (n, level) => {
    const name = level === 'country' ? countryName(n.id) : level === 'region' ? regionName(n.id) : cityName(n.id);
    const child = level === 'country' ? 'region' : 'city';
    const meta = level === 'city' ? (n.places.length ? t('sumPlaces', { n: n.places.length }) : '') : summary(n.records);
    return `<details class="fp fp-${level}" open>${head(level, n.id, name, altName(level, n.id), meta)}
      ${level === 'city' ? '' : sorted(n.children).map(c => branch(c, child)).join('')}${placesHtml(n.places)}</details>`;
  };
  return sorted(tree).map(n => branch(n, 'country')).join('');
}

async function focusRecord(p) {
  const c = geo.cityById.get(p.city);
  if (c) await go({ level: 'city', country: c.country, region: c.region, city: c.id }, { fly: false });
  if (p.lat != null) map.flyTo(toMap(p.lat, p.lng), Math.max(map.getZoom(), 16), { duration: 1 });
  openEditor(p.id);
}

// 进入国家/地区/城市后，顶部的返回栏：回到「我的足迹」首页，或回到上一级
function backBar() {
  const trail = [];
  if (view.level !== 'country') trail.push(['country', view.country, countryName(view.country)]);
  if (view.level === 'city') trail.push(['region', view.region, regionName(view.region)]);
  return `<nav class="trail" aria-label="${t('trailLabel')}">
    <button class="trail-up" data-up title="${t('backUp')}">${icon('back')}</button>
    <ol>
      <li><button class="trail-home" data-home title="${t('backHome')}">${icon('home')}${t('trailHome')}</button></li>
      ${trail.map(([level, id, name]) => `<li><button data-nav="${level}" data-id="${escapeHtml(id)}">${escapeHtml(name)}</button></li>`).join('')}
    </ol>
  </nav>`;
}

function renderSidebar() {
  const panel = $('#panel');
  const { level } = view;

  if (level === 'world') {
    panel.innerHTML = `
      <section class="stats">
        <div><b>${visited.country.size}</b><span>${t('statCountries')}</span></div>
        <div><b>${visited.city.size}</b><span>${t('statCities')}</span></div>
        <div><b>${places().length}</b><span>${t('statPlaces')}</span></div>
        <div><b>${records.reduce((n, r) => n + r.photos.length, 0)}</b><span>${t('statPhotos')}</span></div>
      </section>
      <p class="hint">${icon('pin')}<span>${t('hintWorld')}</span></p>
      <div class="section-title"><span>${t('archive')}</span><span>${t('archivePath')}</span></div>
      <div class="tree">${renderTree()}</div>`;
    return;
  }

  if (level === 'country') {
    const regions = geo.regions.get(view.country).features.map(f => ({ id: f.properties.id, name: f.properties.name }));
    sortVisitedFirst(regions, r => visited.region.has(r.id), byName);
    const n = regions.filter(r => visited.region.has(r.id)).length;
    panel.innerHTML = backBar() + entityCard('country', view.country, countryName(view.country),
      [t('regionsSub', { n: regions.length, v: n }), summary(recordsIn('country', view.country))].filter(Boolean).join(' · ')) + `
      <div class="section-title"><span>${t('sectionRegions')}</span><span>${regions.length}</span></div>
      <div class="rows">${regions.map(r => row({ level: 'region', id: r.id, name: r.name, visited: visited.region.has(r.id), meta: summary(recordsIn('region', r.id)) })).join('')}</div>`;
    return;
  }

  if (level === 'region') {
    const cities = geo.cities.filter(c => c.region === view.region);
    sortVisitedFirst(cities, c => visited.city.has(c.id), (a, b) => a.rank - b.rank || byName(a, b));
    const n = cities.filter(c => visited.city.has(c.id)).length;
    panel.innerHTML = backBar() + entityCard('region', view.region, regionName(view.region), [t('citiesSub', { n: cities.length, v: n }), summary(recordsIn('region', view.region))].filter(Boolean).join(' · ')) + `
      <div class="section-title"><span>${t('sectionCities')}</span><span>${cities.length}</span></div>
      <div class="rows">${cities.map(c => row({ level: 'city', id: c.id, name: c.name, visited: visited.city.has(c.id), meta: summary(recordsIn('city', c.id)) })).join('')
        || `<p class="empty">${t('noCities')}</p>`}</div>`;
    return;
  }

  const list = places().filter(r => r.city === view.city).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  panel.innerHTML = backBar() + entityCard('city', view.city, cityName(view.city), list.length ? t('placesSub', { n: list.length }) : t('noPlacesYet')) + `
    <p class="hint">${icon('pin')}<span>${t('hintCity')}</span></p>
    <div class="section-title"><span>${t('sectionPlaces')}</span><span>${list.length}</span></div>
    <div class="rows">${list.map(r => row({ level: 'place', id: r.id, name: r.name || t('unnamed'), visited: true,
      meta: `${photoCount(r.photos.length)}${escapeHtml(r.date || '')}` })).join('')
      || `<p class="empty">${t('noPlaces')}</p>`}</div>`;
}

$('#panel').addEventListener('click', async e => {
  if (e.target.closest('[data-home]')) return go({ level: 'world' });
  if (e.target.closest('[data-up]')) return go(parentOf(view));
  const img = e.target.closest('[data-photo]');
  if (img) return showLightbox(img.src);

  const act = e.target.closest('[data-act]')?.dataset.act;
  const level = view.level, id = view[level];
  if (act === 'mark') {
    const m = findMark(level, id);
    if (!m) return saveRecord(newMark(level, id));
    if ((m.photos.length || m.note) && !confirm(t('confirmUnmark'))) return;
    return removeRecord(m);
  }
  if (act === 'edit') {
    let m = findMark(level, id);
    if (!m) await saveRecord(m = newMark(level, id));
    return openEditor(m.id);
  }

  const nav = e.target.closest('[data-nav]');
  const r = e.target.closest('.row');
  if (!nav && !r) return;
  e.preventDefault(); // 点名称时不折叠树
  const target = nav ? nav.dataset.nav : r.dataset.level;
  const targetId = (nav || r).dataset.id;
  if (target === 'place') focusRecord(records.find(x => x.id === targetId));
  else goTo(target, targetId);
  if (isPhone()) closeDrop();
});

// ---------- 顶栏下拉面板 ----------
// 同一时间只开一张；点外面（含地图）、按 Esc 收起。手机上改为从底部弹出的抽屉
const isPhone = () => innerWidth <= 700;
let openDrop = null;

function setDrop(name) {
  openDrop = name === openDrop ? null : name;
  for (const d of document.querySelectorAll('.drop')) {
    d.hidden = d.id !== `drop-${openDrop}`;
    if (d.hidden) continue;
    // 桌面上对齐到触发它的顶栏按钮下方
    const trigger = $(`#topbar [data-drop="${openDrop}"]`).getBoundingClientRect();
    const phone = isPhone();
    d.style.left = !phone && d.classList.contains('drop-left') ? `${Math.max(12, trigger.left - 6)}px` : '';
    d.style.right = !phone && d.classList.contains('drop-right') ? `${Math.max(12, innerWidth - trigger.right - 6)}px` : '';
  }
  for (const b of document.querySelectorAll('[data-drop]')) b.setAttribute('aria-expanded', b.dataset.drop === openDrop);
  $('#scrim').hidden = !(openDrop && isPhone());
  document.dispatchEvent(new CustomEvent('drop:change', { detail: openDrop }));
}
const closeDrop = () => openDrop && setDrop(openDrop);

document.addEventListener('click', e => {
  const trigger = e.target.closest('[data-drop]');
  if (trigger) return setDrop(trigger.dataset.drop);
  if (e.target.closest('[data-close-drop]')) return closeDrop();
  // 用事件路径判断：点击后面板内容可能已被重新渲染，target 会脱离文档
  const inside = e.composedPath().some(n => n.matches?.('.drop, #map, #editor, #lightbox, #chat, #chatView'));
  if (!inside) closeDrop();
});
map.on('click', closeDrop); // 地图用 Leaflet 的 click，拖动地图不会误关
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('#editor').hidden && $('#lightbox').hidden) closeDrop();
});
addEventListener('resize', () => {
  if (!openDrop) return;
  const name = openDrop;
  openDrop = null; // 重新定位，不切换
  setDrop(name);
});

// ---------- 搜索（本地索引） ----------
function search(q) {
  q = q.toLowerCase();
  const hit = (name, en, zh) => [name, en, zh].some(x => x && x.toLowerCase().includes(q));
  const score = (name, en, zh) => {
    const names = [name, en, zh].filter(Boolean).map(x => x.toLowerCase());
    return names.includes(q) ? 0 : names.some(x => x.startsWith(q)) ? 1 : 2;
  };
  const out = [];
  for (const f of geo.world.features) {
    const { id, name, en, zh } = f.properties;
    if (hit(name, en, zh)) out.push({ level: 'country', id, name, sub: t('level.country'), s: score(name, en, zh) });
  }
  for (const r of geo.regionById.values()) {
    if (hit(r.name, r.en, r.zh)) out.push({ level: 'region', id: r.id, name: r.name, sub: countryName(r.country), s: score(r.name, r.en, r.zh) + 0.1 });
  }
  for (const c of geo.cities) {
    if (hit(c.name, c.en, c.zh)) {
      out.push({ level: 'city', id: c.id, name: c.name, sub: [regionName(c.region), countryName(c.country)].filter(Boolean).join(' · '), s: score(c.name, c.en, c.zh) + 0.2 + c.rank / 100 });
    }
  }
  return out.sort((a, b) => a.s - b.s).slice(0, 12);
}

// ---------- 搜索具体地点（Photon，基于 OpenStreetMap） ----------
// 进入某个国家/城市后，额外在当前视野内搜一次，让附近的同名地点排在前面
let poiCtrl;
async function searchPlaces(q) {
  poiCtrl?.abort();
  poiCtrl = new AbortController();
  const base = `https://photon.komoot.io/api/?limit=6&q=${encodeURIComponent(q)}`;
  const urls = [base];
  if (view.level !== 'world') {
    const b = map.getBounds();
    const clampLng = x => Math.max(-180, Math.min(180, x));
    const [s, w] = fromMap(b.getSouth(), b.getWest());
    const [n, e] = fromMap(b.getNorth(), b.getEast());
    urls.unshift(`${base}&bbox=${clampLng(w)},${s},${clampLng(e)},${n}`);
  }
  const lists = await Promise.all(urls.map(u => fetch(u, { signal: poiCtrl.signal })
    .then(res => res.json()).then(j => j.features).catch(() => [])));
  const seen = new Set();
  const out = [];
  for (const f of lists.flat()) {
    const p = f.properties;
    const key = `${p.osm_type}${p.osm_id}`;
    if (!p.name || seen.has(key)) continue;
    seen.add(key);
    const [lng, lat] = f.geometry.coordinates;
    out.push({ name: p.name, sub: [p.city || p.county || p.state, p.country].filter(Boolean).join(' · '), lat, lng });
  }
  return out.slice(0, 8);
}

async function focusPlace(p) {
  const loc = await locate(p.lat, p.lng);
  const target = loc.city ? { level: 'city', ...loc }
    : loc.region ? { level: 'region', country: loc.country, region: loc.region }
    : loc.country ? { level: 'country', country: loc.country }
    : { level: 'world' };
  await go(target, { fly: false });
  const ll = L.latLng(toMap(p.lat, p.lng));
  map.once('moveend', () => showAddPopup(ll, p.name));
  map.flyTo(ll, 17, { duration: 1.2 });
}

let searchTimer, poiTimer, poiResults = [];
function renderSearch(local, pois, pending) {
  const localHtml = local.map(r => `<li data-level="${r.level}" data-id="${escapeHtml(r.id)}"><span><em>${escapeHtml(r.name)}</em></span><small>${escapeHtml(r.sub)}</small></li>`).join('');
  const poiHtml = pois.map((p, i) => `<li data-poi="${i}"><span>${icon('pin')}<em>${escapeHtml(p.name)}</em></span><small>${escapeHtml(p.sub)}</small></li>`).join('');
  $('#searchResults').innerHTML = localHtml
    + (pending || pois.length ? `<li class="group">${t('searchPlaces')}</li>` : '')
    + (pending ? `<li class="group">${t('searching')}</li>` : poiHtml)
    + (!pending && !local.length && !pois.length ? `<li class="group">${t('notFound')}</li>` : '');
}

$('#searchInput').addEventListener('input', e => {
  clearTimeout(searchTimer);
  clearTimeout(poiTimer);
  poiCtrl?.abort();
  searchTimer = setTimeout(() => {
    const q = e.target.value.trim();
    if (!q) { $('#searchResults').innerHTML = ''; return; }
    const local = search(q);
    if (q.length < 2) return renderSearch(local, [], false);
    renderSearch(local, [], true);
    poiTimer = setTimeout(async () => {
      const pois = await searchPlaces(q);
      if ($('#searchInput').value.trim() !== q) return; // 已有更新的输入
      poiResults = pois;
      renderSearch(local, pois, false);
    }, 350);
  }, 120);
});

$('#searchResults').addEventListener('click', e => {
  const li = e.target.closest('li[data-level], li[data-poi]');
  if (!li) return;
  $('#searchResults').innerHTML = '';
  $('#searchInput').value = '';
  if (li.dataset.poi) focusPlace(poiResults[li.dataset.poi]);
  else goTo(li.dataset.level, li.dataset.id);
  if (isPhone()) closeDrop();
});

$('#searchInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('#searchResults li[data-level], #searchResults li[data-poi]')?.click();
});

// ---------- 打卡明信片（居中弹窗） ----------
const current = () => records.find(r => r.id === currentId);
const LEVEL_EN = { country: 'COUNTRY', region: 'REGION', city: 'CITY', place: 'PLACE' };
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const TILTS = [-3, 2.2, -1.4, 3.2, -2.4, 1.2];
let shownPhotos = new Set(); // 已经入场过的照片，不再重复播放动画

function openEditor(id) {
  currentId = id;
  shownPhotos = new Set();
  $('#photoGrid').dataset.sig = '';
  const ed = $('#editor');
  ed.classList.remove('closing');
  fillEditor(current());
  ed.hidden = false;
}

function closeEditor() {
  const ed = $('#editor');
  if (ed.hidden) return;
  currentId = null;
  ed.classList.add('closing');
  setTimeout(() => {
    if (!currentId) ed.hidden = true;
    ed.classList.remove('closing');
  }, 220);
}

function fillEditor(r) {
  // 正在输入的字段不覆盖，避免打断用户
  const setIfIdle = (el, v) => { if (document.activeElement !== el) el.value = v; };
  setIfIdle($('#editName'), r.name);
  setIfIdle($('#editNote'), r.note);
  $('#editDate').value = r.date || '';

  $('.postcard').dataset.level = r.level;
  $('#editKicker').textContent = lang === 'zh' ? `${LEVEL_EN[r.level]} · ${LEVEL_LABEL[r.level]}` : LEVEL_EN[r.level];
  const [y, m, d] = (r.date || today()).split('-');
  $('#stampLevel').textContent = LEVEL_EN[r.level];
  $('#stampDay').textContent = d;
  $('#stampMonth').textContent = `${MONTHS[+m - 1]} ${y}`;

  const path = pathOf(r);
  $('#editAddress').innerHTML = path.map((p, i) => {
    const alt = lang === 'zh' ? p.en : p.zh;
    return `<li style="--i:${i}" data-level="${p.level}" data-id="${escapeHtml(p.id)}">
      <span>${escapeHtml(p.name)}</span>${alt && alt !== p.name ? `<em>${escapeHtml(alt)}</em>` : ''}</li>`;
  }).join('') || `<li class="unknown"><span>${t('unknownArea')}</span></li>`;
  const last = path[path.length - 1];
  $('#postmarkText').textContent = (last?.en || last?.zh || 'EARTH').toUpperCase().slice(0, 11);

  $('#deleteRecord').textContent = t(r.level === 'place' ? 'deletePostcard' : 'unmark');
  $('#doneEditor').textContent = t(r.photos.length && !r.publishedAt ? 'doneSend' : 'done');
  renderPhotos(r);
  renderMarkerPicker(r);
}

// 「地图上的样子」：每个选项都是真实标记的缩小预览
function renderMarkerPicker(r) {
  const box = $('#markerPicker');
  box.hidden = r.level !== 'place';
  if (box.hidden) return;
  const label = $('#markerLabel');
  if (document.activeElement !== label) label.value = r.label || '';
  label.placeholder = t('labelDefault', { name: r.name || t('unnamed') });
  $('#useName').hidden = !(r.label || '').trim();

  const sig = [r.id, r.marker, r.icon, r.name, r.label, r.date, r.photos.slice(0, 3).map(p => p.id)].join('|');
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  const hasPhotos = r.photos.length > 0;
  $('#markerHint').textContent = t(hasPhotos ? 'markerHintPhotos' : 'markerHint');
  $('#markerOptions').innerHTML =
    (hasPhotos ? `<div class="mk-opt current"><div class="mk-preview">${markerHtml(r)}</div><span>${t('photoStackCurrent')}</span></div>` : '')
    + MARKER_STYLES.map(s => `<button type="button" class="mk-opt${(r.marker || 'sign') === s.id ? ' selected' : ''}" data-style="${s.id}">
        <div class="mk-preview">${markerHtml(r, { style: s.id, usePhotos: false })}</div><span>${s.name}</span></button>`).join('');
  const chosen = ICONS[r.icon] ? r.icon : 'pin';
  $('#markerIcons').innerHTML = MARKER_ICONS.map(([id, name]) =>
    `<button type="button" class="mk-ic${id === chosen ? ' selected' : ''}" data-icon="${id}" title="${name}" aria-label="${name}">${icon(id)}</button>`).join('');
}

$('#markerIcons').addEventListener('click', async e => {
  const btn = e.target.closest('[data-icon]');
  const r = current();
  if (!btn || !r) return;
  r.icon = btn.dataset.icon;
  await saveRecord(r);
  flashSaved();
});

$('#useName').onclick = async () => {
  const r = current();
  if (!r) return;
  r.label = '';
  $('#markerLabel').value = '';
  await saveRecord(r);
  flashSaved();
};

$('#markerOptions').addEventListener('click', async e => {
  const btn = e.target.closest('[data-style]');
  const r = current();
  if (!btn || !r) return;
  r.marker = btn.dataset.style;
  await saveRecord(r);
  flashSaved();
});

function renderPhotos(r) {
  const grid = $('#photoGrid');
  const sig = r.id + ':' + r.photos.map(p => p.id).join();
  if (grid.dataset.sig === sig) return; // 只改了文字时不重绘照片
  grid.dataset.sig = sig;
  grid.innerHTML = '';
  $('#photoDrop').classList.toggle('empty', !r.photos.length);
  r.photos.forEach((photo, i) => {
    const fig = document.createElement('figure');
    fig.className = 'polaroid' + (shownPhotos.has(photo.id) ? '' : ' fresh');
    fig.style.setProperty('--i', i);
    fig.style.setProperty('--tilt', `${TILTS[i % TILTS.length]}deg`);
    shownPhotos.add(photo.id);
    fig.innerHTML = `<img src="${photoUrl(photo)}" alt="" />
      <figcaption>${i === 0 ? t('cover') : String(i + 1).padStart(2, '0')}</figcaption>
      <div class="pol-tools">${i ? `<button data-cover title="${t('setCover')}">★</button>` : ''}<button data-del title="${t('deletePhoto')}">×</button></div>`;
    fig.querySelector('img').onclick = () => showLightbox(photoUrl(photo));
    fig.querySelector('[data-cover]')?.addEventListener('click', async () => {
      r.photos.splice(i, 1);
      r.photos.unshift(photo);
      await saveRecord(r);
    });
    fig.querySelector('[data-del]').onclick = async () => {
      if (!confirm(t('confirmDeletePhoto'))) return;
      r.photos.splice(i, 1);
      (r.deletedPhotos ||= []).push(photo.id);
      revokePhoto(photo);
      await saveRecord(r);
    };
    grid.append(fig);
  });
}

function flashSaved() {
  const el = $('#savedHint');
  el.classList.remove('show');
  void el.offsetWidth; // 重新触发动画
  el.classList.add('show');
}

let saveTimer;
function bindField(sel, key, delay) {
  $(sel).addEventListener('input', e => {
    const r = current();
    if (!r) return;
    r[key] = e.target.value;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => { await saveRecord(r); flashSaved(); }, delay);
  });
}
bindField('#editName', 'name', 400);
bindField('#editNote', 'note', 400);
bindField('#markerLabel', 'label', 400);
bindField('#editDate', 'date', 0);

$('#stamp').onclick = () => {
  const input = $('#editDate');
  try { input.showPicker(); } catch { input.focus(); }
};

$('#editAddress').addEventListener('click', e => {
  const li = e.target.closest('li[data-level]');
  if (!li) return;
  closeEditor();
  goTo(li.dataset.level, li.dataset.id);
});

$('#closeEditor').onclick = closeEditor;
// 「收进足迹」：带照片且还没发布过的打卡，这时才作为动态寄给好友（之后补照片只更新原动态）
$('#doneEditor').onclick = async () => {
  const r = current();
  if (r && r.photos.length && !r.publishedAt) {
    r.publishedAt = Date.now();
    await saveRecord(r);
    const n = social?.friendCount() || 0;
    toast(n ? t('sentToFriends', { n }) : t('keptNoFriends'));
  }
  closeEditor();
};

let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  el.classList.remove('out');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.add('out'); setTimeout(() => { el.hidden = true; }, 300); }, 2600);
}
$('#editor .pc-backdrop').onclick = closeEditor;
$('#deleteRecord').onclick = () => {
  const r = current();
  if (r && confirm(t('confirmDeleteRecord', { name: r.name || LEVEL_LABEL[r.level] }))) removeRecord(r);
};

// 压缩图片：长边不超过 1600px，转为 JPEG，避免占满浏览器存储
async function compressImage(file, maxSide = 1600, quality = 0.85) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
}

async function addPhotos(files) {
  const r = current();
  files = files.filter(f => f.type.startsWith('image/'));
  if (!r || !files.length) return;

  $('#photoDrop').classList.remove('empty');
  const grid = $('#photoGrid');
  const placeholders = files.map(() => {
    const d = document.createElement('figure');
    d.className = 'polaroid developing';
    d.innerHTML = `<div class="dev"></div><figcaption>${t('developing')}</figcaption>`;
    grid.append(d);
    return d;
  });

  for (const file of files) {
    try {
      r.photos.push({ id: uid(), blob: await compressImage(file) });
    } catch {
      alert(t('cannotRead', { name: file.name }));
    }
  }
  placeholders.forEach(d => d.remove());
  grid.dataset.sig = '';
  await saveRecord(r);
  flashSaved();
}

$('#photoInput').addEventListener('change', e => {
  const files = [...e.target.files];
  e.target.value = '';
  addPhotos(files);
});

// 照片可以直接拖到明信片上
const postcard = $('.postcard');
postcard.addEventListener('dragover', e => {
  e.preventDefault();
  $('#photoDrop').classList.add('dragging');
});
postcard.addEventListener('dragleave', e => {
  if (!postcard.contains(e.relatedTarget)) $('#photoDrop').classList.remove('dragging');
});
postcard.addEventListener('drop', e => {
  e.preventDefault();
  $('#photoDrop').classList.remove('dragging');
  addPhotos([...e.dataTransfer.files]);
});

function showLightbox(src) {
  const lb = $('#lightbox');
  lb.querySelector('img').src = src;
  lb.hidden = false;
}
$('#lightbox').onclick = () => { $('#lightbox').hidden = true; };
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!$('#lightbox').hidden) $('#lightbox').hidden = true;
  else if (!$('#editor').hidden) closeEditor();
  else if (view.level !== 'world') go(parentOf(view));
});

// ---------- 从动态飞到地图上 ----------
async function flyToRow(row) {
  const target = geo.cityById.has(row.city) ? { level: 'city', country: row.country, region: row.region, city: row.city }
    : geo.regionById.has(row.region) ? { level: 'region', country: row.country, region: row.region }
    : geo.countryById.has(row.country) ? { level: 'country', country: row.country } : { level: 'world' };
  highlight = `${row.user_id}/${row.id}`;
  await go(target, { fly: false });
  if (row.lat != null) map.flyTo(toMap(row.lat, row.lng), Math.max(map.getZoom(), 16), { duration: 1 });
  else flyToView();
  if (isPhone()) closeDrop();
  setTimeout(() => { highlight = null; document.querySelectorAll('.mk-hi').forEach(el => el.classList.remove('mk-hi')); }, 4000);
}

// ---------- 一键截图 ----------
// 截图要画的全部内容：国家 / 省州 / 城市轮廓、地名、去过的地方、当前看到的打卡标记
function snapshotScene() {
  const z = map.getZoom();
  const mark = (r, extra = {}) => ({
    lat: r.lat, lng: r.lng, style: r.marker || 'sign', icon: ICONS[r.icon] ? r.icon : 'pin',
    text: markerText(r), date: fmtDate(r.date), photos: r.photos.slice(0, 3), ...extra,
  });
  return {
    title: view.level === 'world' ? t('world')
      : view.level === 'country' ? countryName(view.country)
      : view.level === 'region' ? regionName(view.region) : cityName(view.city),
    countries: geo.world.features,
    regions: view.country ? geo.regions.get(view.country)?.features || [] : [],
    cities: view.region ? geo.regionCities.get(view.region)?.features || [] : [],
    visited,
    current: view.level === 'world' ? null : { level: view.level, id: view[view.level] },
    currentCity: view.level === 'city' ? geo.cityById.get(view.city) : null,
    labels: geo.cities,
    far: z < 12,
    showMarkers: view.level === 'city' || z >= 8,
    markers: [
      ...(social?.pins() || []).map(p => mark(p, { friend: true, badge: avatarUrl(p.owner?.avatar || 'a01') })),
      ...places().filter(r => r.lat != null).map(r => mark(r)),
    ],
  };
}

const snapshot = initSnapshot({ map, toMap, scene: snapshotScene, iconSvg: name => ICONS[name] || ICONS.pin });

// 地图右上角：截图
new (L.Control.extend({
  options: { position: 'topright' },
  onAdd() {
    const b = L.DomUtil.create('button', 'leaflet-bar map-btn map-shot');
    b.type = 'button';
    b.title = t('shotTitle');
    b.innerHTML = `${icon('camera')}<span>${t('shotButton')}</span>`;
    L.DomEvent.disableClickPropagation(b);
    b.onclick = () => { closeDrop(); snapshot.open(); };
    return b;
  },
}))().addTo(map);

// 地图右上角：叠加 / 隐藏好友的足迹
const friendsControl = new (L.Control.extend({
  options: { position: 'topright' },
  onAdd() {
    const b = L.DomUtil.create('button', 'leaflet-bar map-btn map-friends');
    b.type = 'button';
    b.innerHTML = `${icon('users')}<span>${t('friends')}</span>`;
    L.DomEvent.disableClickPropagation(b);
    b.onclick = () => social?.setOverlay(!social.overlay);
    this._button = b;
    this.sync();
    return b;
  },
  sync() {
    if (!this._button || !social) return;
    this._button.setAttribute('aria-pressed', social.overlay);
    this._button.title = t(social.overlay ? 'friendsHide' : 'friendsShow');
  },
}))();

// ---------- 同步状态（「我的足迹」面板底部） ----------
const hhmm = t => new Date(t).toTimeString().slice(0, 5);
function renderSyncStatus({ pending, state, at }) {
  const el = $('#syncStatus');
  const text = state === 'offline' ? (pending ? t('syncOffline', { n: pending }) : t('syncOfflineIdle'))
    : state === 'syncing' ? t('syncing')
    : state === 'error' ? `${t('syncError')}${pending ? ` · ${t('syncPending', { n: pending })}` : ''}`
    : pending ? t('syncPending', { n: pending })
    : at ? t('syncedAt', { t: hhmm(at) }) : t('synced');
  el.hidden = false;
  el.dataset.state = pending && state === 'idle' ? 'pending' : state;
  el.innerHTML = `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 18.5h10.5a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.6 9.6 4.5 4.5 0 0 0 7 18.5z" /></svg><span>${text}</span>`;
}

// ---------- 导出 / 导入备份（照片转为 base64 一并保存） ----------
const blobToDataUrl = blob => new Promise(resolve => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.readAsDataURL(blob);
});

$('#exportBtn').onclick = async () => {
  const data = await Promise.all(records.map(async r => ({
    ...r,
    // 便于阅读的标准层级路径，如 United Kingdom / England / Cambridge / King's College Chapel
    path: [...pathOf(r).map(p => p.en || p.zh || p.name), ...(r.level === 'place' ? [r.name] : [])].join(' / '),
    path_zh: [...pathOf(r).map(p => p.zh || p.name), ...(r.level === 'place' ? [r.name] : [])].join(' / '),
    photos: await Promise.all(r.photos.map(async ph => ({ id: ph.id, data: await blobToDataUrl(ph.blob) }))),
  })));
  const blob = new Blob([JSON.stringify({ version: 2, records: data })], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${t('backupName')}-${today()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};

$('#importInput').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const json = JSON.parse(await file.text());
    const raw = json.version === 2 ? json.records : json.places.map(fromV1);
    const imported = await Promise.all(raw.map(async r => ({
      ...r,
      deleted: false,
      deletedPhotos: r.deletedPhotos || [],
      photos: await Promise.all(r.photos.map(async ph => ({ id: ph.id, blob: await (await fetch(ph.data)).blob() }))),
    })));
    if (records.length && confirm(t('confirmImport', { n: imported.length }))) {
      const keep = new Set(imported.map(r => r.id));
      for (const r of [...records]) if (!keep.has(r.id)) await removeRecord(r);
    }
    for (const r of imported) {
      const old = records.find(x => x.id === r.id) || tombstones.find(x => x.id === r.id);
      old?.photos.forEach(revokePhoto);
      records = records.filter(x => x.id !== r.id);
      tombstones = tombstones.filter(x => x.id !== r.id);
      touch(r);
      records.push(r);
      await db.put(r);
    }
    await assignMissing();
    refresh();
    sync?.request();
  } catch (err) {
    alert(t('importFailed'));
    console.error(err);
  }
});

// 旧数据没有行政区归属，或行政区划分已更新（如英国改为英格兰/苏格兰…），重新归档
async function assignMissing() {
  for (const r of records) {
    const stale = r.region && !geo.regionById.has(r.region);
    if (r.level === 'place' && (!r.country || stale)) {
      Object.assign(r, await locate(r.lat, r.lng));
    } else if (r.level === 'city' && geo.cityById.has(r.city) && geo.cityById.get(r.city).region !== r.region) {
      r.region = geo.cityById.get(r.city).region;
    } else {
      continue;
    }
    touch(r);
    await db.put(r);
  }
}

// 第一次登录：把登录前存在这台设备上的足迹（旧库 mymap）存进账号
async function claimLegacy(profile) {
  const flag = 'mymap:legacy-claimed';
  if (localStorage.getItem(flag)) return;
  const names = (await indexedDB.databases?.())?.map(d => d.name);
  if (names && !names.includes('mymap')) return localStorage.setItem(flag, 'none');
  const legacy = makeDb();
  await legacy.open('mymap');
  const old = await legacy.all();
  legacy._db.close();
  if (!old.length) return localStorage.setItem(flag, 'none');
  const photos = old.reduce((n, r) => n + r.photos.length, 0);
  const yes = await askLetter({
    title: t('legacyTitle'),
    body: t('legacyBody', { n: old.length, p: photos, handle: escapeHtml(profile.handle) }),
    ok: t('legacyOk'),
    cancel: t('legacyCancel'),
  });
  localStorage.setItem(flag, yes ? profile.handle : 'declined');
  if (!yes) return;
  for (const r of old) {
    if (records.some(x => x.id === r.id)) continue;
    Object.assign(r, { deleted: false, deletedPhotos: r.deletedPhotos || [] });
    r.photos.forEach(p => { p.up = false; });
    touch(r);
    records.push(r);
    await db.put(r);
  }
}

// ---------- 启动 ----------
(async () => {
  const baseReady = withLoading(loadBase());
  const account = initAuth({ countries: baseReady.then(() => geo.world.features.map(f => f.properties)) });
  await baseReady;
  drawWorld();
  renderCrumbs();

  // 登录后才打开这个账号自己的本地库
  const { user, profile } = await account;
  await db.open(`mymap-${user.id}`);
  const all = await db.all();
  records = all.filter(r => !r.deleted);
  tombstones = all.filter(r => r.deleted);
  await claimLegacy(profile);
  await assignMissing();
  refresh();

  me = user.id;
  social = initSocial({
    me: { id: user.id, profile },
    helpers: {
      placeText: row => pathOf(row).map(p => p.name).join(' / '),
      countryName,
      myRecords: () => records,
      showPhoto: showLightbox,
      openDrop: name => openDrop !== name && setDrop(name),
      flyTo: flyToRow,
      fitPins: list => list.length && map.flyToBounds(L.latLngBounds(list.map(p => toMap(p.lat, p.lng))).pad(0.4), { maxZoom: 15, duration: 1 }),
      onChange: () => { renderPlaces(); friendsControl.sync(); chat?.friendsChanged(); },
      chatUnread: id => chat?.unread(id) || 0,
    },
  });
  friendsControl.addTo(map);

  chat = initChat({
    me: { id: user.id },
    social,
    helpers: {
      myRecords: () => records,
      localPhotoUrl: photoUrl,
      placeText: row => pathOf(row).map(p => p.name).join(' / '),
      showPhoto: showLightbox,
      flyTo: flyToRow,
      toast,
      requestSync: () => sync?.request(0),
      closeDrop,
    },
  });

  sync = createSync({
    uid: user.id,
    records: () => [...records, ...tombstones],
    save: r => db.put(r),
    apply: applySynced,
    onStatus: renderSyncStatus,
  });
})();

// 端到端测试入口：开发环境或带 ?e2e 时暴露少量内部函数
if (import.meta.env.DEV || new URLSearchParams(location.search).has('e2e')) {
  window.__mymap = { saveRecord, removeRecord, newRecord, goTo, records: () => records, sync: () => sync, social: () => social, map: () => map };
}
