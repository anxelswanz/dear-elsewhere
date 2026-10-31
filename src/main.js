// Dear Elsewhere（致远方）—— 旅行足迹地图，打卡数据（含照片）保存在浏览器 IndexedDB 中
import * as L from 'leaflet';
// 字体随站点一起发布，不从 Google Fonts 加载（避免把访客 IP 交给第三方）
import '@fontsource-variable/fraunces/opsz.css';
import '@fontsource-variable/fraunces/opsz-italic.css';
import '@fontsource/noto-serif-sc/500.css';
import '@fontsource/noto-serif-sc/700.css';
import { t, lang, applyStatic, localName } from './i18n.js';
import { initAuth, avatarUrl, myBirthplace } from './auth.js';
import { initSocial, ago } from './social.js';
import { initChat } from './chat.js';
import { track } from './track.js';
import { initSnapshot } from './snapshot.js';
import { initJourney } from './journey.js';
import { initSettings } from './settings.js';

applyStatic();
import { createSync, touch } from './sync.js';
import { LIMITS, accountDay, photoQuota, hhmm, limitText } from './limits.js';
import { viaSite } from './supabase.js';
import { routed } from './net.js';
//
// 层级：世界 -> 国家 -> 省/州 -> 城市 -> 具体地点
// 每条打卡记录（record）的 level 为 country / region / city / place，
// 并记录所属的 country / region / city id，用于点亮上级区域。

// ---------- 坐标转换：WGS84 <-> GCJ-02（底图带 gcj: true 时使用；目前的天地图和 Esri 都是 WGS84） ----------
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

// 应用在 /app/ 下，数据文件在站点根目录的 data/，不能用相对路径
const DATA = `${import.meta.env.BASE_URL}data/`;

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
  const [world, index] = await Promise.all([fetchJson(`${DATA}world.json`), fetchJson(`${DATA}index.json`)]);
  geo.world = world;
  world.features.forEach(f => {
    localize(f.properties, f.properties.en);
    geo.countryById.set(f.properties.id, f);
  });
  index.regions.forEach(([id, name, en, country]) => geo.regionById.set(id, { id, name: localName(name, en), zh: name, en, country }));
  geo.legacyCity = index.legacy || {};
  index.cities.forEach(([id, name, en, country, region, lat, lng, rank]) => {
    const c = { id, name: localName(name, en), zh: name, en, country, region, lat, lng, rank };
    geo.cities.push(c);
    geo.cityById.set(id, c);
  });
}

async function loadRegions(country) {
  if (!geo.regions.has(country)) {
    let fc = { type: 'FeatureCollection', features: [] };
    try { fc = await withLoading(fetchJson(`${DATA}country/${country}.json`)); } catch { /* 无下级行政区 */ }
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
    const fc = await withLoading(fetchJson(`${DATA}region/${regionId}.json`));
    fc.features.forEach(f => localize(f.properties, geo.cityById.get(f.properties.id)?.en));
    geo.regionCities.set(regionId, fc);
  }
  return geo.regionCities.get(regionId);
}

// 台湾、香港、澳门是中国的省级行政区（scripts/build-data.mjs）。旧数据里它们是单独的「国家」TWN / HKG / MAC：
// 护照上的旧代码仍然显示名称；打卡用 chinaPartPatch() 改到新结构
const CN_PART = {
  TWN: { region: 'CN710000', zh: '中国台湾', en: 'Taiwan, China' },
  HKG: { region: 'CN810000', zh: '中国香港', en: 'Hong Kong, China' },
  MAC: { region: 'CN820000', zh: '中国澳门', en: 'Macau, China' },
};
const legacyCountry = id => CN_PART[id] && { id, name: localName(CN_PART[id].zh, CN_PART[id].en), zh: CN_PART[id].zh, en: CN_PART[id].en };

// 旧打卡 → 新结构（返回要改的字段，不需要改时返回 null）：
//   国家 台湾/香港/澳门 → 中国的省级行政区；原来的一级行政区（台湾县市、香港各区）→ 城市（id 不变）；
//   原来的城市点（台湾、香港的乡镇）→ 地点，名字和坐标都保留；澳门按坐标找最近的堂区
function chinaPartPatch(r) {
  const part = CN_PART[r.country];
  if (!part) return null;
  const region = part.region;
  let city = r.region && geo.cityById.get(r.region)?.region === region ? r.region
    : geo.legacyCity[r.city] || '';
  if (!city && r.lat != null && r.lng != null) {
    let best = null, bestKm = 25;
    for (const c of geo.cities) {
      if (c.region !== region) continue;
      const km = distKm(r.lat, r.lng, c.lat, c.lng);
      if (km < bestKm) { bestKm = km; best = c; }
    }
    city = best?.id || '';
  }
  const patch = { country: 'CHN', region, city };
  if (r.level === 'country' || (r.level === 'region' && !city)) Object.assign(patch, { level: 'region', ref: region, city: '', name: regionName(region) });
  else if (r.level === 'region') Object.assign(patch, { level: 'city', ref: city, name: cityName(city) });
  else if (r.level === 'city') Object.assign(patch, r.lat != null && r.lng != null ? { level: 'place', ref: '' } : { level: 'region' });
  if (patch.level === 'region' && r.level === 'city') Object.assign(patch, { ref: region, city: '', name: regionName(region) });
  return patch;
}

async function migrateChinaParts() {
  for (const r of [...records, ...tombstones]) {
    const patch = chinaPartPatch(r);
    if (!patch) continue;
    Object.assign(r, patch);
    touch(r);
    await db.put(r);
  }
}

const countryName = id => geo.countryById.get(id)?.properties.name || legacyCountry(id)?.name || '';
const regionName = id => geo.regionById.get(id)?.name || '';
const cityName = id => geo.cityById.get(id)?.name || '';
const countryZh = id => geo.countryById.get(id)?.properties.zh || CN_PART[id]?.zh || '';
const regionZh = id => geo.regionById.get(id)?.zh || '';
const cityZh = id => geo.cityById.get(id)?.zh || '';
const countryEn = id => geo.countryById.get(id)?.properties.en || CN_PART[id]?.en || '';
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
// 每个账号一个库（mymap-{用户 id}）。新记录必须联网打卡，以云端为准，这里只做缓存
const makeDb = () => ({
  _db: null,
  open(name) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 2);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('checkins')) d.createObjectStore('checkins', { keyPath: 'id' });
      };
      req.onsuccess = () => {
        this._db = req.result;
        this._db.onversionchange = () => this._db.close(); // 注销账号时要删除这个库
        resolve();
      };
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
let journey = null;         // 旅程航线与回放，登录后创建
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
  // 别的设备还是旧版本时，同步回来的可能仍是旧结构
  const patch = chinaPartPatch(r);
  if (patch) { Object.assign(r, patch); touch(r); db.put(r); }
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

// ---------- 出生地：一枚小小的「出生」邮戳，只出现在自己的地图上 ----------
let birthLayer = null; // 地图在后面才创建，第一次用到时再加
function renderBirthplace() {
  birthLayer ||= L.layerGroup().addTo(map);
  birthLayer.clearLayers();
  const c = geo.cityById.get(geo.legacyCity[myBirthplace()] || myBirthplace());
  if (!c) return;
  const label = t('birth.marker');
  const html = `<div class="birth-mark" title="${label} · ${escapeHtml(c.name)}">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 11 12 4l8.5 7" /><path d="M5.5 9.5V20h13V9.5" /><path d="M12 17.2s-3.2-1.9-3.2-3.9a1.7 1.7 0 0 1 3.2-.8 1.7 1.7 0 0 1 3.2.8c0 2-3.2 3.9-3.2 3.9z" /></svg>
    <span>${label}</span></div>`;
  for (const off of WORLD_COPIES) {
    L.marker(toMapAt(c.lat, c.lng, off), {
      icon: L.divIcon({ className: 'birth-anchor', iconSize: [0, 0], iconAnchor: [0, 0], html }),
      interactive: false, keyboard: false, zIndexOffset: -500,
    }).addTo(birthLayer);
  }
}
document.addEventListener('birthplace:change', () => renderBirthplace());

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
  journey?.refresh();
  renderBirthplace();
  const cur = records.find(r => r.id === currentId);
  if (cur) fillEditor(cur);
}

// ---------- 地图 ----------
// 天地图管中国（坐标就是 WGS84，不用再做偏移），key 写在 .env.local；
// Esri 管国外，用的是免 key 的公开接口（非商业用途；商用需改成带 API key 的 ArcGIS Location Platform）
const TDT_KEY = import.meta.env.VITE_TIANDITU_KEY;
// 线上经本站 /geo/ 转发（worker/index.js）：国内直连 arcgis.com 很慢，搜索要等十几秒甚至没结果
const ESRI_GEOCODE = viaSite ? `${location.origin}/geo` : 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer';
// 慢网络下缩放更顺：缩放动画过程中不请求中间层级的瓦片，停下再加载；周围多留一圈瓦片，拖动时不露白
const TILE_OPTS = { updateWhenZooming: false, keepBuffer: 3 };
const tdt = (layer, opts) => L.tileLayer(`https://t{s}.tianditu.gov.cn/${layer}_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=${TDT_KEY}`, {
  subdomains: '01234567', maxZoom: 18, ...TILE_OPTS, ...opts,
});
// 天地图的底图和注记是两层：vec/img + cva/eva、cia/eia（c 中文，e 英文）
const tdtBase = (layer, notes) => L.layerGroup([
  tdt(layer, { attribution: '© <a href="https://www.tianditu.gov.cn" target="_blank">天地图</a>' }),
  tdt(`${lang === 'en' ? 'e' : 'c'}${notes}`),
]);
const baseLayers = {};
if (TDT_KEY) {
  baseLayers[t('base.tdt')] = tdtBase('vec', 'va');
  baseLayers[t('base.tdtSat')] = tdtBase('img', 'ia');
}
// 国内用户的 Esri 瓦片经本站转发、Cloudflare 缓存（src/net.js）
baseLayers[t('base.intl')] = L.tileLayer(routed('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}'), {
  ...TILE_OPTS,
  maxZoom: 19,
  // Esri 要求的署名：Powered by Esri + 底图的数据来源（取自 World Street Map 图层的 Credits）
  attribution: 'Powered by <a href="https://www.esri.com" target="_blank">Esri</a> | Sources: Esri, HERE, Garmin, USGS, Intermap, INCREMENT P, NRCan, Esri Japan, METI, Esri China (Hong Kong), Esri Korea, Esri (Thailand), NGCC, © <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors, and the GIS User Community',
});
// 卫星图 + 地名注记两层，免 key（没配天地图 key 时，全球默认用上面的街道图）
const esri = (path, opts) => L.tileLayer(routed(`https://server.arcgisonline.com/ArcGIS/rest/services/${path}/MapServer/tile/{z}/{y}/{x}`), { ...TILE_OPTS, maxZoom: 19, ...opts });
baseLayers[t('base.sat')] = L.layerGroup([
  esri('World_Imagery', { attribution: 'Powered by <a href="https://www.esri.com" target="_blank">Esri</a> | Sources: Esri, Maxar, Earthstar Geographics, and the GIS User Community' }),
  esri('Reference/World_Boundaries_and_Places'),
]);
// 天地图在国外没有详细数据，浏览国外时自动换成国际底图；手动选择底图后不再自动切换
const CN_COVERED = new Set(['CHN', 'HKG', 'MAC', 'TWN']);
const inChina = country => CN_COVERED.has(country);
const chinaBase = () => baseLayers[t('base.tdt')] || Object.values(baseLayers)[0];
const intlBase = () => baseLayers[t('base.intl')];
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
let activeLayer = chinaBase().addTo(map);
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
  const want = !view.country || inChina(view.country) ? chinaBase() : intlBase();
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
// current：正在查看的区域，悬停时不再加填充，免得鼠标一划过整片变红、挡住底图
const CURRENT = { color: COLOR.accent, weight: 2.5, fillColor: COLOR.accent, fillOpacity: 0, current: true };
const CURRENT_VISITED = { ...CURRENT, fillOpacity: 0.12 }; // 正在查看、且盖过章：淡淡填一层，不挡底图
const DIMMED = v => ({ color: COLOR.line, weight: 0.5, fillColor: v ? COLOR.accent : COLOR.dim, fillOpacity: v ? 0.15 : 0.12 });

// 每一级：正在查看的区域透明高亮，同级其他区域变暗，下一级按是否去过上色
function countryStyle(f) {
  const id = f.properties.id;
  if (view.level === 'world') return visited.country.has(id) ? VISITED : OPEN;
  return id === view.country ? (visited.country.has(id) ? CURRENT_VISITED : CURRENT) : DIMMED(visited.country.has(id));
}

function regionStyle(f) {
  const id = f.properties.id;
  if (view.level === 'country') return visited.region.has(id) ? VISITED : OPEN;
  return id === view.region ? (visited.region.has(id) ? CURRENT_VISITED : CURRENT) : DIMMED(visited.region.has(id));
}

function cityStyle(f) {
  const id = f.properties.id;
  if (view.level === 'region') return visited.city.has(id) ? VISITED : OPEN;
  return id === view.city ? { ...(visited.city.has(id) ? CURRENT_VISITED : CURRENT), weight: 3 } : DIMMED(visited.city.has(id));
}

let mapDragging = false;

function geoLayer(fc, styleFn, level) {
  return L.featureGroup(WORLD_COPIES.map(offset => L.geoJSON(fc, {
    renderer, style: styleFn, bubblingMouseEvents: false,
    coordsToLatLng: c => L.latLng(toMapAt(c[1], c[0], offset)),
    onEachFeature: (f, layer) => {
      layer.bindTooltip(f.properties.name, { sticky: true, direction: 'top', className: 'geo-tip' });
      layer.on('click', e => {
        // 进入城市或放得足够大时，点击用于添加具体地点
        if (view.level === 'city' || map.getZoom() >= 13) showStampHint(e.latlng);
        else goTo(level, f.properties.id);
      });
      layer.on('mouseover', () => {
        if (view.level === 'city') return;
        // 拖地图找地方时鼠标会扫过很多区域，不要一路闪；触屏点一下也会触发 mouseover，同样跳过
        if (mapDragging || !matchMedia('(hover: hover)').matches) return;
        const s = styleFn(f);
        if (s.current) return;
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
  // 其他地方去过的城市也显示出来；没有边界的当前城市（国外城市只有中心点）也要画，否则盖了章看不出来
  geo.cities
    .filter(c => visited.city.has(c.id) && !drawn.has(c.id))
    .forEach(c => overlay.addLayer(cityDot(c, view.level !== 'city' || c.id === view.city)));
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

// onZoom：缩放触发时，标记由 Leaflet 自己跟着地图移动，只有跨过显示方式的分界（远 / 近、评论气泡）才重画；
// 缩得很小时的好友圆点按屏幕距离合并，每一级都要重算
let placesBucket = null;
function renderPlaces({ onZoom = false } = {}) {
  const z = map.getZoom();
  const near = view.level === 'city' || z >= 8;
  const bucket = near ? `near|${z >= 12}` : 'dots';
  if (onZoom && near && bucket === placesBucket) return;
  placesBucket = bucket;
  placeLayer.clearLayers();
  $('#map').classList.toggle('mk-far', z < 12);
  if (view.level !== 'city' && z < 8) return renderFriendDots();
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

// ---------- 缩小时的好友：头像小圆针，屏幕上挨得太近的合成一枚，标上人数 ----------
const DOT_GAP = 40; // 两枚圆针中心小于这个像素距离就合并
function renderFriendDots() {
  const pins = social?.pins() || [];
  const clusters = [];
  for (const p of pins) {
    const pt = map.project(toMap(p.lat, p.lng), map.getZoom());
    const near = clusters.find(c => c.pt.distanceTo(pt) < DOT_GAP);
    if (near) near.pins.push(p);
    else clusters.push({ pt, pins: [p] });
  }
  for (const { pins: list } of clusters) {
    const people = [...new Map(list.map(p => [p.owner?.id, p.owner])).values()];
    const faces = people.slice(0, 3).map(o => `<img src="${avatarUrl(o?.avatar || 'a01')}" alt="" />`).join('');
    const count = list.length > 1 ? `<i class="fd-n">${list.length}</i>` : '';
    const head = list[0];
    const tip = list.length > 1
      ? people.map(o => escapeHtml(o?.name || '')).join(lang === 'zh' ? '、' : ', ')
      : `${escapeHtml(head.owner?.name || '')} · ${escapeHtml(markerText(head))}`;
    const icon = L.divIcon({ className: 'mk-anchor', iconSize: [0, 0], iconAnchor: [0, 0],
      html: `<div class="fd n${Math.min(people.length, 3)}"><span class="fd-faces">${faces}</span>${count}</div>` });
    // 一个地点：飞过去；一簇：放大到刚好装下它们
    const click = () => {
      track('friend_dot_click', { n: list.length });
      if (list.length === 1 || list.every(p => p.lat === head.lat && p.lng === head.lng)) flyToRow({ ...head, user_id: head.owner?.id });
      else map.flyToBounds(L.latLngBounds(list.map(p => toMap(p.lat, p.lng))).pad(0.5), { maxZoom: 13, duration: 1 });
    };
    // 坐标取这一簇的平均位置
    const lat = list.reduce((a, p) => a + p.lat, 0) / list.length;
    const lng = list.reduce((a, p) => a + p.lng, 0) / list.length;
    for (const offset of WORLD_COPIES) {
      L.marker(toMapAt(lat, lng, offset), { icon, riseOnHover: true })
        .bindTooltip(tip, { direction: 'top', offset: [0, -40], className: 'geo-tip' })
        .on('click', click)
        .addTo(placeLayer);
    }
  }
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

// ---------- 盖邮戳打卡：按住地图约 0.6 秒落章，章印停 1 秒后收成普通标记并打开编辑器 ----------
const PRESS_MS = 600, LAND_MS = 1000, MOVE_TOLERANCE = 8, HINT_TEXT_TIMES = 3;
const canStamp = () => view.level === 'city' || map.getZoom() >= 13;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const vibrate = pattern => { try { navigator.vibrate?.(pattern); } catch { /* 不支持振动 */ } };
const mapEl = map.getContainer();

// 章面：城市名（不在城市里就退到省、国家）+ 当天日期
function stampFace(loc) {
  const [level, id] = loc?.city ? ['city', loc.city] : loc?.region ? ['region', loc.region] : loc?.country ? ['country', loc.country] : [];
  if (!level) return { zh: '远方', en: 'ELSEWHERE' };
  const name = { city: cityName, region: regionName, country: countryName }[level](id);
  const zh = { city: cityZh, region: regionZh, country: countryZh }[level](id) || name;
  const en = { city: cityEn, region: regionEn, country: countryEn }[level](id) || name;
  return { zh, en: en.toUpperCase() };
}

function setFace(st, loc) {
  const { zh, en } = stampFace(loc);
  const face = st.getElement()?.querySelector('.stp-face');
  if (!face) return;
  face.querySelector('small').textContent = en;
  face.querySelector('b').textContent = zh.toUpperCase() === en ? '' : zh;
}

// 落章时飞溅的墨点，每次方向随机
const splatter = () => Array.from({ length: 7 }, (_, i) => {
  const a = (i / 7) * 2 * PI + Math.random() * 0.6, d = 50 + Math.random() * 18;
  return `<i style="--dx:${(Math.cos(a) * d).toFixed(1)}px;--dy:${(Math.sin(a) * d).toFixed(1)}px;--s:${(0.5 + Math.random() * 0.8).toFixed(2)}"></i>`;
}).join('');

function stampMarker(latlng, state, tip = '') {
  const tilt = (Math.random() * 16 - 8).toFixed(1);
  const html = `<div class="stp ${state}" style="--tilt:${tilt}deg">
    <i class="stp-blot"></i>
    <svg class="stp-ring" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="46" /></svg>
    <div class="stp-face"><small></small><i class="stp-rule">✦</i><time>${fmtDate(today())}</time><b></b></div>
    <span class="stp-ink">${splatter()}</span>
    ${tip ? `<span class="stp-tip">${escapeHtml(tip)}</span>` : ''}
  </div>`;
  return L.marker(latlng, {
    icon: L.divIcon({ className: 'stp-anchor', iconSize: [0, 0], iconAnchor: [0, 0], html }),
    interactive: false, keyboard: false, zIndexOffset: 3000,
  }).addTo(map);
}

const stampEl = st => st.getElement()?.querySelector('.stp');
function dropStamp(st, cls, after) {
  stampEl(st)?.classList.add(cls);
  setTimeout(() => st.remove(), after);
}

let press = null;     // 正在按住的那一次
let stampedAt = 0;    // 落章后松手时浏览器还会补发 click，用它忽略掉
let landedId = null;  // 已经落章、还没松开的那根手指

function cancelPress() {
  if (!press) return;
  clearTimeout(press.timer);
  dropStamp(press.st, 'lift', 220);
  press = null;
}

// 章落下：没网或今天打满就是没墨的空章，弹开；否则留下章印，1 秒后变成标记
// p.onLand / p.onDone：侧栏「标记去过」用，落章时保存、仪式结束后打开编辑器，不受打卡上限限制
async function land(p) {
  if (press === p) press = null;
  stampedAt = Date.now();
  landedId = p.id;
  const el = stampEl(p.st);
  el?.classList.remove('pressing');
  const blocked = p.onDone ? ''
    : !navigator.onLine ? t('needOnline')
    : placesToday() >= LIMITS.placesPerDay ? t('limit.places_per_day', LIMITS) : '';
  if (blocked) {
    vibrate([12, 60, 12]);
    dropStamp(p.st, 'dry', 750);
    return toast(blocked);
  }
  el?.classList.add('landed');
  vibrate(35);
  if (!reducedMotion.matches) {
    mapEl.classList.remove('thud');
    void mapEl.offsetWidth; // 重新触发动画
    mapEl.classList.add('thud');
  }
  p.onLand?.();
  const [loc] = await Promise.all([p.loc, new Promise(r => setTimeout(r, LAND_MS))]);
  dropStamp(p.st, 'fold', 260);
  if (p.onDone) p.onDone();
  else addPlace(p.lat, p.lng, p.name, loc);
}

function startStamp(latlng, { name = '', state = 'pressing', loc } = {}) {
  const [lat, lng] = fromMap(latlng.lat, wrapLng(latlng.lng));
  const st = stampMarker(latlng, state);
  loc ||= locate(lat, lng).catch(() => ({ country: '', region: '', city: '' }));
  loc.then(l => setFace(st, l));
  return { st, lat, lng, name, loc };
}

mapEl.addEventListener('pointerdown', e => {
  if (press && !e.isPrimary) return cancelPress(); // 第二根手指：在缩放
  if (press || !e.isPrimary || e.button !== 0 || !canStamp()) return;
  if (e.target.closest('.leaflet-marker-icon, .leaflet-control, .leaflet-popup')) return;
  const p = { ...startStamp(map.mouseEventToLatLng(e)), id: e.pointerId, x: e.clientX, y: e.clientY };
  p.timer = setTimeout(() => land(p), PRESS_MS);
  press = p;
  vibrate(8);
});
window.addEventListener('pointermove', e => {
  if (press?.id === e.pointerId && Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_TOLERANCE) cancelPress();
});
for (const type of ['pointerup', 'pointercancel']) {
  window.addEventListener(type, e => {
    if (press?.id === e.pointerId) cancelPress();
    if (landedId === e.pointerId) { stampedAt = Date.now(); landedId = null; }
  });
}
map.on('movestart zoomstart', cancelPress);
map.on('dragstart', () => { mapDragging = true; });
map.on('dragend', () => { mapDragging = false; });
// 长按别弹出系统菜单
mapEl.addEventListener('contextmenu', e => { if (canStamp()) e.preventDefault(); });

// 单击：在点击处浮出一个邮戳虚影，教用户按住；前几次带文字
let hint = null;
function showStampHint(latlng) {
  if (Date.now() - stampedAt < 500) return;
  let shown = 0;
  try { shown = Number(localStorage.getItem('de.stampHints')) || 0; localStorage.setItem('de.stampHints', shown + 1); } catch { /* 无痕模式 */ }
  hint?.remove();
  const st = stampMarker(latlng, 'ghost', shown < HINT_TEXT_TIMES ? t('holdToStamp') : '');
  hint = st;
  setTimeout(() => { st.remove(); if (hint === st) hint = null; }, 1500);
}

// 从搜索选中的地点：飞到后直接落章
function stampAt(latlng, name) {
  land(startStamp(latlng, { name, state: 'auto' }));
}

// 侧栏「标记去过」：城市落在中心点，省和国家落在视野中心；落章时区域点亮，仪式后打开明信片
let markStamping = false;
function stampMark(m) {
  if (markStamping) return;
  markStamping = true;
  const latlng = m.lat != null ? L.latLng(toMap(m.lat, m.lng)) : map.getCenter();
  const p = startStamp(latlng, { state: 'auto', loc: Promise.resolve(m) });
  p.onLand = () => { markStamping = false; saveRecord(m); };
  p.onDone = () => openEditor(m.id);
  land(p);
}

map.on('click', e => {
  if (canStamp()) showStampHint(e.latlng);
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

// 地名接口最多等 8 秒：一家卡住时不能让整个搜索一直转圈
const GEO_TIMEOUT = 8000;
function withTimeout(signal) {
  const t = AbortSignal.timeout(GEO_TIMEOUT);
  return !signal ? t : AbortSignal.any ? AbortSignal.any([signal, t]) : signal; // 老浏览器没有 any：只靠调用方取消
}

async function getJson(url, signal) {
  const res = await fetch(url, { signal: withTimeout(signal) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// 点在地图上时查一个地名：国内用天地图，国外用 Esri；先找附近的景点，找不到再用街道地址
async function reverseName(lat, lng, country) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    if (inChina(country) && TDT_KEY) {
      const post = encodeURIComponent(JSON.stringify({ lon: lng, lat, ver: 1 }));
      const { result = {} } = await getJson(`https://api.tianditu.gov.cn/geocoder?postStr=${post}&type=geocode&tk=${TDT_KEY}`, ctrl.signal);
      const a = result.addressComponent || {};
      return a.poi || a.road || result.formatted_address || '';
    }
    const base = `${ESRI_GEOCODE}/reverseGeocode?f=json&location=${lng},${lat}&langCode=${lang === 'en' ? 'ENG' : 'CHI'}`; // 反查要用三字母语言代码，ZH 不生效
    const poi = await getJson(`${base}&featureTypes=POI`, ctrl.signal);
    const a = (poi.address ? poi : await getJson(base, ctrl.signal)).address || {};
    return a.PlaceName || a.ShortLabel || a.Address || '';
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

// 今天新建的景点，删掉的也算，避免删了重打卡绕过限制
const placesToday = () => [...records, ...tombstones]
  .filter(r => r.level === 'place' && accountDay(r.createdAt) === accountDay()).length;

async function addPlace(lat, lng, knownName = '', loc = null) {
  if (!navigator.onLine) return toast(t('needOnline'));
  if (placesToday() >= LIMITS.placesPerDay) return toast(t('limit.places_per_day', LIMITS));
  const r = newRecord('place', { lat, lng, name: knownName, ...(loc || await locate(lat, lng)) });
  await saveRecord(r);
  openEditor(r.id);
  if (knownName) return;
  const name = await reverseName(lat, lng, r.country);
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
  renderPlaces({ onZoom: true });
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
    if (!m) return stampMark(newMark(level, id));
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
  hoverOpened = false;
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

// 头像面板：有鼠标的设备上悬停即展开，移开后稍等再收起；悬停展开时点一下头像会把它固定住
let hoverOpened = false, enterTimer = 0, leaveTimer = 0;
const canHover = matchMedia('(hover: hover) and (pointer: fine)');
for (const el of [$('#topbar [data-drop="me"]'), $('#drop-me')]) {
  el.addEventListener('mouseenter', () => {
    if (!canHover.matches || isPhone()) return;
    clearTimeout(leaveTimer);
    if (openDrop !== 'me') enterTimer = setTimeout(() => { setDrop('me'); hoverOpened = true; }, 150);
  });
  el.addEventListener('mouseleave', () => {
    clearTimeout(enterTimer);
    if (hoverOpened) leaveTimer = setTimeout(() => hoverOpened && openDrop === 'me' && setDrop('me'), 320);
  });
}

document.addEventListener('click', e => {
  const trigger = e.target.closest('[data-drop]');
  if (trigger?.dataset.drop === 'me' && hoverOpened && openDrop === 'me') {
    hoverOpened = false; // 固定住，不再随鼠标移开收起
    clearTimeout(leaveTimer);
    return;
  }
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

// ---------- 搜索具体地点（国内天地图，国外 Esri；在世界视图两家都搜） ----------
// 进入某个国家/城市后，额外在当前视野内搜一次，让附近的同名地点排在前面
let poiCtrl;
const clampLng = x => Math.max(-180, Math.min(180, x));
function viewBounds() {
  const b = map.getBounds();
  const [s, w] = fromMap(b.getSouth(), b.getWest());
  const [n, e] = fromMap(b.getNorth(), b.getEast());
  return [clampLng(w), s, clampLng(e), n];
}

function searchTianditu(q, signal, local) {
  const query = (mapBound, level) => {
    const post = encodeURIComponent(JSON.stringify({ keyWord: q, mapBound, level, queryType: 1, start: 0, count: 6 }));
    return getJson(`https://api.tianditu.gov.cn/v2/search?postStr=${post}&type=query&tk=${TDT_KEY}`, signal)
      .then(j => (j.pois || []).map(p => {
        const [lng, lat] = String(p.lonlat).split(',').map(Number);
        return { name: p.name, sub: [p.city || p.county || p.province, countryName('CHN')].filter(Boolean).join(' · '), lat, lng };
      }));
  };
  const jobs = [query('73,3,136,54', 5)];
  if (local) jobs.unshift(query(viewBounds().join(','), Math.min(18, Math.max(1, Math.round(map.getZoom())))));
  return Promise.all(jobs.map(j => j.catch(() => []))).then(lists => lists.flat());
}

async function searchEsri(q, signal) {
  let url = `${ESRI_GEOCODE}/findAddressCandidates?f=json&maxLocations=6&outFields=PlaceName,City,Region,CntryName`
    + `&langCode=${lang === 'en' ? 'EN' : 'ZH'}&SingleLine=${encodeURIComponent(q)}`;
  if (view.level !== 'world') {
    const c = map.getCenter();
    const [lat, lng] = fromMap(c.lat, wrapLng(c.lng));
    url += `&location=${lng},${lat}`;
  }
  const j = await getJson(url, signal);
  return (j.candidates || []).map(c => {
    const a = c.attributes || {};
    return { name: a.PlaceName || c.address, sub: [a.City || a.Region, a.CntryName].filter(Boolean).join(' · '), lat: c.location.y, lng: c.location.x };
  });
}

// 天地图和 Esri 谁先回来先显示谁（onUpdate），不用等慢的那一家
async function searchPlaces(q, onUpdate) {
  poiCtrl?.abort();
  poiCtrl = new AbortController();
  const { signal } = poiCtrl;
  const china = view.level === 'world' ? null : inChina(view.country);
  const jobs = [];
  if (TDT_KEY && china !== false) jobs.push(searchTianditu(q, signal, china === true));
  if (china !== true || !TDT_KEY) jobs.push(searchEsri(q, signal));
  // 世界视图下输入中文时天地图的结果排前面，否则 Esri 排前面
  if (china === null && !/[一-鿿]/.test(q)) jobs.reverse();
  const lists = jobs.map(() => []);
  const merged = () => {
    const seen = new Set();
    const out = [];
    for (const p of lists.flat()) {
      const key = `${p.name}|${p.lat?.toFixed(3)}|${p.lng?.toFixed(3)}`;
      if (!p.name || !Number.isFinite(p.lat) || !Number.isFinite(p.lng) || seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
    return out.slice(0, 8);
  };
  let left = jobs.length;
  await Promise.all(jobs.map((job, i) => job.catch(() => []).then(list => {
    lists[i] = list;
    left--;
    if (!signal.aborted && (list.length || !left)) onUpdate?.(merged(), left > 0);
  })));
  return merged();
}

async function focusPlace(p) {
  const loc = await locate(p.lat, p.lng);
  const target = loc.city ? { level: 'city', ...loc }
    : loc.region ? { level: 'region', country: loc.country, region: loc.region }
    : loc.country ? { level: 'country', country: loc.country }
    : { level: 'world' };
  await go(target, { fly: false });
  const ll = L.latLng(toMap(p.lat, p.lng));
  map.once('moveend', () => stampAt(ll, p.name));
  map.flyTo(ll, 17, { duration: 1.2 });
}

let searchTimer, poiTimer, poiResults = [];
function renderSearch(local, pois, pending) {
  const localHtml = local.map(r => `<li data-level="${r.level}" data-id="${escapeHtml(r.id)}"><span><em>${escapeHtml(r.name)}</em></span><small>${escapeHtml(r.sub)}</small></li>`).join('');
  const poiHtml = pois.map((p, i) => `<li data-poi="${i}"><span>${icon('pin')}<em>${escapeHtml(p.name)}</em></span><small>${escapeHtml(p.sub)}</small></li>`).join('');
  $('#searchResults').innerHTML = localHtml
    + (pending || pois.length ? `<li class="group">${t('searchPlaces')}</li>` : '')
    + poiHtml + (pending ? `<li class="group">${t('searching')}</li>` : '')
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
    poiTimer = setTimeout(() => searchPlaces(q, (pois, pending) => {
      if ($('#searchInput').value.trim() !== q) return; // 已有更新的输入
      poiResults = pois;
      renderSearch(local, pois, pending);
    }), 350);
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

// ---------- 明信片里的好友评论 ----------
const CARD_COMMENTS = 3;
let cardCommentsOpen = false;
function renderCardComments(r) {
  const box = $('#cardComments');
  const list = r && social && me ? [...social.comments(`${me}/${r.id}`)].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)) : [];
  box.hidden = !list.length;
  if (!list.length) { box.innerHTML = ''; return; }
  const shown = cardCommentsOpen ? list : list.slice(0, CARD_COMMENTS);
  const rest = list.length - CARD_COMMENTS;
  box.innerHTML = `<p class="pc-marker-title"><span>${t('card.comments')}</span><small>${t('card.commentsN', { n: list.length })}</small></p>
    <ul class="post-comments">${shown.map(c => {
      const a = social.author(c.author);
      const name = c.author === me ? t('feed.me') : a?.name || t('feed.friend');
      return `<li><img src="${avatarUrl(a?.avatar || 'a01')}" alt="" />
        <p><b>${escapeHtml(name)}</b>${escapeHtml(c.body)}<time>${ago(c.created_at)}</time></p></li>`;
    }).join('')}</ul>
    ${rest > 0 ? `<button type="button" class="pc-comments-more" data-card-more aria-expanded="${cardCommentsOpen}">${cardCommentsOpen ? t('card.less') : t('card.more', { n: rest })}</button>` : ''}`;
}
$('#cardComments').addEventListener('click', e => {
  if (!e.target.closest('[data-card-more]')) return;
  cardCommentsOpen = !cardCommentsOpen;
  renderCardComments(current());
});

function openEditor(id) {
  currentId = id;
  cardCommentsOpen = false;
  shownPhotos = new Set();
  $('#photoGrid').dataset.sig = '';
  const ed = $('#editor');
  ed.classList.remove('closing');
  fillEditor(current());
  ed.hidden = false;
  loadYearQuota();
}

function closeEditor() {
  const ed = $('#editor');
  if (ed.hidden) return;
  const closed = currentId;
  currentId = null;
  setTimeout(() => journey?.afterEdit(closed), 260); // 等明信片收起再飞
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
  renderCardComments(r);
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

// 今年的照片额度：打开明信片时问一次服务端，之后加减照片时用本地待上传的张数修正
// uploaded：问服务端时已经传上去的照片；之后才传上去的（包括之后才加的），服务端的 used 里还没有，本地补上
let yearQuota = null; // { used, limit, uploaded }
const queuedPhotos = () => records.reduce((n, x) => n + x.photos.filter(p => !p.up && p.blob).length, 0);
const setYearQuota = q => {
  const uploaded = new Set(records.flatMap(x => x.photos.filter(p => p.up).map(p => p.id)));
  yearQuota = { used: q.yearUsed, limit: q.yearLimit, uploaded };
};
function renderYearQuota() {
  const box = $('#photoYear');
  box.hidden = !yearQuota || !Number.isFinite(yearQuota.limit);
  if (box.hidden) return;
  const { used, limit, uploaded } = yearQuota;
  const sent = records.reduce((n, x) => n + x.photos.filter(p => p.up && !uploaded.has(p.id)).length, 0);
  const left = Math.max(0, limit - used - sent - queuedPhotos());
  box.querySelector('b').style.width = `${(left / limit) * 100}%`;
  box.querySelector('small').textContent = t('photosYear', { left, total: limit });
  box.classList.toggle('low', left <= limit * 0.1);
}
async function loadYearQuota() {
  try {
    setYearQuota(await photoQuota());
  } catch { /* 离线：不显示 */ }
  renderYearQuota();
}

function renderPhotos(r) {
  renderYearQuota();
  const grid = $('#photoGrid');
  const sig = r.id + ':' + r.photos.map(p => p.id).join();
  if (grid.dataset.sig === sig) return; // 只改了文字时不重绘照片
  grid.dataset.sig = sig;
  grid.innerHTML = '';
  $('#photoDrop').classList.toggle('empty', !r.photos.length);
  const room = LIMITS.photosPerPlace - r.photos.length;
  $('#photoDrop').classList.toggle('full', room <= 0);
  $('#photoInput').disabled = room <= 0;
  $('#photoRoom').textContent = room <= 0 ? t('photosFull', { n: LIMITS.photosPerPlace })
    : r.photos.length ? t('photosLeft', { n: room }) : t('dropPhotos');
  r.photos.forEach((photo, i) => {
    const fig = document.createElement('figure');
    fig.className = 'polaroid' + (shownPhotos.has(photo.id) ? '' : ' fresh');
    fig.style.setProperty('--i', i);
    fig.style.setProperty('--tilt', `${TILTS[i % TILTS.length]}deg`);
    shownPhotos.add(photo.id);
    fig.dataset.id = photo.id;
    fig.innerHTML = `<img src="${photoUrl(photo)}" alt="" draggable="false" />
      <figcaption>${i === 0 ? t('cover') : String(i + 1).padStart(2, '0')}</figcaption>
      <div class="pol-tools">${i ? `<button data-cover title="${t('setCover')}">★</button>` : ''}<button data-del title="${t('deletePhoto')}">×</button></div>`;
    fig.querySelector('img').onclick = () => { if (!grid.dataset.dragged) showLightbox(photoUrl(photo)); };
    if (r.photos.length > 1) {
      fig.title = t('dragToReorder');
      fig.addEventListener('pointerdown', e => dragPhoto(e, fig, r));
    }
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

// 拖动照片调换顺序：鼠标按下移动即可拖，触屏需要长按一下（不影响正常滑动页面）
function dragPhoto(e, fig, r) {
  if (e.button !== 0 || e.target.closest('button')) return;
  const grid = fig.parentElement;
  const touch = e.pointerType === 'touch';
  let startX = e.clientX, startY = e.clientY, dragging = false, dx = 0;
  let hold = touch ? setTimeout(() => begin(), 260) : 0;

  const begin = () => {
    hold = 0;
    dragging = true;
    grid.dataset.dragged = '1';
    fig.classList.add('lifted');
    grid.classList.add('sorting');
    try { fig.setPointerCapture(e.pointerId); } catch { /* 指针已经离开 */ }
    navigator.vibrate?.(10);
  };
  const move = ev => {
    if (ev.pointerId !== e.pointerId) return;
    if (!dragging) {
      const far = Math.hypot(ev.clientX - startX, ev.clientY - startY) > 6;
      if (touch) { if (far) end(); return; } // 长按前就滑动了：当作滚动页面
      if (!far) return;
      begin();
    }
    dx = ev.clientX - startX;
    fig.style.translate = `${dx}px 0`;
    // 拖过相邻照片的中线就和它换位
    const others = [...grid.children].filter(el => el !== fig && el.classList.contains('polaroid'));
    const before = others.find(el => { const b = el.getBoundingClientRect(); return ev.clientX < b.left + b.width / 2; });
    if ((before || null) !== nextPolaroid(fig)) {
      const was = fig.getBoundingClientRect().left - dx;
      grid.insertBefore(fig, before || others.at(-1)?.nextSibling || null);
      startX += fig.getBoundingClientRect().left - dx - was; // 换位后保持照片仍在手指下
      dx = ev.clientX - startX;
      fig.style.translate = `${dx}px 0`;
    }
  };
  const blockScroll = ev => { if (dragging) ev.preventDefault(); };
  const end = async () => {
    clearTimeout(hold);
    fig.removeEventListener('pointermove', move);
    fig.removeEventListener('pointerup', end);
    fig.removeEventListener('pointercancel', end);
    fig.removeEventListener('touchmove', blockScroll);
    if (!dragging) return;
    dragging = false;
    fig.classList.remove('lifted');
    grid.classList.remove('sorting');
    fig.style.translate = '';
    setTimeout(() => delete grid.dataset.dragged); // 拖完松手不要顺带打开大图
    const order = [...grid.querySelectorAll('.polaroid')].map(el => el.dataset.id);
    if (order.join() === r.photos.map(p => p.id).join()) return;
    const byId = new Map(r.photos.map(p => [p.id, p]));
    r.photos = order.map(id => byId.get(id)).filter(Boolean);
    await saveRecord(r);
  };
  fig.addEventListener('pointermove', move);
  fig.addEventListener('pointerup', end);
  fig.addEventListener('pointercancel', end);
  fig.addEventListener('touchmove', blockScroll, { passive: false });
}
const nextPolaroid = el => {
  let n = el.nextElementSibling;
  while (n && !n.classList.contains('polaroid')) n = n.nextElementSibling;
  return n;
};

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
  const room = LIMITS.photosPerPlace - r.photos.length;
  if (room <= 0) return toast(t('photosPickFull', { n: LIMITS.photosPerPlace }));
  if (!navigator.onLine) return toast(t('needOnline'));
  let quota;
  try {
    quota = await photoQuota();
  } catch (err) {
    return toast(limitText(err) || t('opFailed', { msg: err.message }));
  }
  setYearQuota(quota);
  renderYearQuota();
  // 本地还没传上去的照片也会占额度
  const queued = queuedPhotos();
  if (quota.totalLeft - queued <= 0) return toast(t('limit.photos_total', LIMITS));
  const yearLeft = Math.max(0, quota.yearLimit - quota.yearUsed - queued);
  if (!yearLeft) return toast(t('limit.photos_per_year', LIMITS));
  const left = Math.max(0, Math.min(quota.left, quota.totalLeft) - queued);
  if (!left) return toast(quota.nextAt ? t('photosQuotaUntil', { t: hhmm(quota.nextAt) }) : t('limit.photos_per_day', LIMITS));
  const fit = Math.min(room, left, yearLeft);
  if (files.length > fit) {
    toast(fit === room ? t('photosPick', { n: LIMITS.photosPerPlace })
      : fit === yearLeft ? t('photosYearLeft', { n: yearLeft }) : t('photosTodayLeft', { n: left }));
    files = files.slice(0, fit);
  }

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

// 装满时文件选择框不再弹出，点一下给个提示
$('.pc-add').addEventListener('click', () => {
  if ($('#photoInput').disabled) toast(t('photosPickFull', { n: LIMITS.photosPerPlace }));
});
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
function renderSyncStatus({ pending, state, at, until }) {
  const el = $('#syncStatus');
  const text = state === 'offline' ? (pending ? t('syncOffline', { n: pending }) : t('syncOfflineIdle'))
    : state === 'syncing' ? t('syncing')
    : state === 'limited' ? (until ? t('syncLimitedUntil', { t: hhmm(until) }) : t('syncLimited'))
    : state === 'error' ? `${t('syncError')}${pending ? ` · ${t('syncPending', { n: pending })}` : ''}`
    : pending ? t('syncPending', { n: pending })
    : at ? t('syncedAt', { t: hhmm(at) }) : t('synced');
  el.hidden = false;
  el.dataset.state = pending && state === 'idle' ? 'pending' : state;
  el.innerHTML = `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 18.5h10.5a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.6 9.6 4.5 4.5 0 0 0 7 18.5z" /></svg><span>${text}</span>`;
}

// ---------- 导出备份（照片转为 base64 一并保存） ----------
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

// ---------- 启动 ----------
(async () => {
  const baseReady = withLoading(loadBase());
  const account = initAuth({ countries: baseReady.then(() => [...geo.world.features.map(f => f.properties), ...Object.keys(CN_PART).map(legacyCountry)]) });
  await baseReady;
  drawWorld();
  renderCrumbs();

  // 登录后才打开这个账号自己的本地库
  const { user, profile } = await account;
  await db.open(`mymap-${user.id}`);
  const all = await db.all();
  records = all.filter(r => !r.deleted);
  tombstones = all.filter(r => r.deleted);
  await migrateChinaParts();
  await assignMissing();
  refresh();
  initSettings({ records: () => records, pathOf });

  me = user.id;
  journey = initJourney({
    map, L, toMapAt, uid: user.id, distKm, toast,
    records: () => records,
    save: saveRecord,
    // 这次打卡落在哪一站：有城市就按城市，否则按坐标附近（约 10 公里）
    stationOf: r => {
      const c = r.city && geo.cityById.get(r.city);
      if (c) return { key: c.id, name: c.name, country: c.country, lat: c.lat, lng: c.lng };
      if (r.lat == null || r.lng == null) return null;
      return { key: `${r.country}|${r.lat.toFixed(1)},${r.lng.toFixed(1)}`, name: r.name || regionName(r.region) || countryName(r.country), country: r.country, lat: r.lat, lng: r.lng };
    },
  });
  social = initSocial({
    me: { id: user.id, profile },
    helpers: {
      placeText: row => pathOf(row).map(p => p.name).join(' / '),
      fixPlace: chinaPartPatch,
      countryName,
      closeDrop: () => closeDrop(),
      myRecords: () => records,
      showPhoto: showLightbox,
      openDrop: name => openDrop !== name && setDrop(name),
      flyTo: flyToRow,
      fitPins: list => list.length && map.flyToBounds(L.latLngBounds(list.map(p => toMap(p.lat, p.lng))).pad(0.4), { maxZoom: 15, duration: 1 }),
      onChange: () => { renderPlaces(); friendsControl.sync(); chat?.friendsChanged(); if (currentId) renderCardComments(current()); },
      chatUnread: id => chat?.unread(id) || 0,
      groupsHtml: () => chat?.groupsHtml() || '',
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
      fixPlace: chinaPartPatch,
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
    onPhotoLimit: until => toast(t('photosQuotaUntil', { t: hhmm(until) })),
  });
})();

// 端到端测试入口：开发环境或带 ?e2e 时暴露少量内部函数
if (import.meta.env.DEV || new URLSearchParams(location.search).has('e2e')) {
  window.__mymap = { saveRecord, removeRecord, newRecord, goTo, records: () => records, sync: () => sync, social: () => social, map: () => map, journey: () => journey, closeEditor, openEditor };
}
