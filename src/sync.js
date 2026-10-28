// 本地 IndexedDB 与 Supabase 双写同步
//
// 本地记录多出这些字段：
//   updatedAt    最后修改时间（毫秒），用于「最后修改胜出」
//   dirty        有未上传的修改
//   deleted      墓碑标记：删除也要同步给其他设备
//   deletedPhotos 删除过的照片 id，任何一端删过都不再复活
//   photos[].up  照片已上传到 Storage
// 合并规则与 supabase/migrations/0002_checkins_sync.sql 中的 push_checkin 一致。
import { supabase } from './supabase.js';

const BUCKET = 'photos';
const PULL_OVERLAP = 60_000;  // 拉取时往回多看 1 分钟，弥补并发事务的提交时间差
const PULL_EVERY = 60_000;
const PAGE = 500;

// 在本地修改一条记录后调用
export function touch(r) {
  r.updatedAt = Date.now();
  r.dirty = true;
}

const toRow = r => ({
  id: r.id, level: r.level, ref: r.ref || '', name: r.name || '',
  country: r.country || '', region: r.region || '', city: r.city || '',
  lat: r.lat ?? null, lng: r.lng ?? null, date: r.date || null, note: r.note || '',
  marker: r.marker || 'sign', icon: r.icon || 'pin', label: r.label || '',
  photos: r.photos.map(p => ({ id: p.id })),
  deleted_photos: r.deletedPhotos || [],
  deleted: !!r.deleted,
  published_at: r.publishedAt ? new Date(r.publishedAt).toISOString() : null,
  transport: r.transport || null,
  created_at: new Date(r.createdAt || Date.now()).toISOString(),
  updated_at: new Date(r.updatedAt || Date.now()).toISOString(),
});

// 把服务器上的一行合并进本地记录（local 可为空），返回合并后的记录；照片 blob 由调用方补齐
export function mergeRow(local, row) {
  const remoteAt = Date.parse(row.updated_at);
  const dead = new Set([...(local?.deletedPhotos || []), ...row.deleted_photos]);
  const remoteWins = !local || !local.dirty || remoteAt >= local.updatedAt;
  const r = local || { id: row.id, photos: [] };
  if (remoteWins) {
    Object.assign(r, {
      level: row.level, ref: row.ref, name: row.name, country: row.country, region: row.region, city: row.city,
      lat: row.lat, lng: row.lng, date: row.date || '', note: row.note,
      marker: row.marker, icon: row.icon, label: row.label, deleted: row.deleted,
      // 还没执行 0005 时云端没有这一列：保留本地的选择
      transport: row.transport === undefined ? local?.transport || '' : row.transport || '',
      createdAt: Date.parse(row.created_at), updatedAt: Math.max(remoteAt, local?.updatedAt || 0),
    });
  }
  // 照片：胜出方的顺序在前，另一方独有的接在后面，删除过的剔除
  const localPhotos = new Map(r.photos.map(p => [p.id, p]));
  const remotePhotos = row.photos.map(p => localPhotos.get(p.id) || { id: p.id, blob: null, up: true });
  const first = remoteWins ? remotePhotos : r.photos;
  const second = remoteWins ? r.photos : remotePhotos;
  const seen = new Set(first.map(p => p.id));
  r.photos = [...first, ...second.filter(p => !seen.has(p.id))].filter(p => !dead.has(p.id));
  for (const p of r.photos) if (remotePhotos.some(x => x.id === p.id)) p.up = true;
  r.deletedPhotos = [...dead];
  // 发布时间取两边最早的一次
  const published = [local?.publishedAt, row.published_at && Date.parse(row.published_at)].filter(Boolean);
  r.publishedAt = published.length ? Math.min(...published) : null;
  r.dirty = !remoteWins || r.photos.some(p => !p.up);
  return r;
}

// 生成 400px 缩略图，供地图标记和好友动态使用
async function thumbnail(blob) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, 400 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8));
}

// uid: 当前用户；records(): 内存中的全部记录（含墓碑）；save(r): 写入 IndexedDB；
// apply(r, isNew): 合并后的记录交回界面；onStatus({ pending, state, at })
export function createSync({ uid, records, save, apply, onStatus }) {
  const cursorKey = `mymap:${uid}:cursor`;
  let running = false, again = false, timer = null;
  let state = 'idle', lastAt = Number(localStorage.getItem(`mymap:${uid}:syncedAt`)) || 0;

  const status = () => onStatus({ pending: records().filter(r => r.dirty).length, state: navigator.onLine ? state : 'offline', at: lastAt });

  async function upload(r) {
    for (const p of r.photos) {
      if (p.up || !p.blob) continue;
      const base = `${uid}/${p.id}`;
      const opts = { contentType: 'image/jpeg', upsert: true };
      const full = await supabase.storage.from(BUCKET).upload(`${base}.jpg`, p.blob, opts);
      if (full.error) throw full.error;
      const thumb = await supabase.storage.from(BUCKET).upload(`${base}_t.jpg`, await thumbnail(p.blob), opts);
      if (thumb.error) throw thumb.error;
      p.up = true;
      await save(r);
    }
  }

  async function push() {
    for (const r of records().filter(x => x.dirty)) {
      await upload(r);
      const version = r.updatedAt;
      const { data: row, error } = await supabase.rpc('push_checkin', { r: toRow(r) });
      if (error) throw error;
      if (r.updatedAt !== version) continue; // 上传期间又被修改，下一轮再推
      r.dirty = false;
      mergeRow(r, row);
      await fetchMissing(r);
      await save(r);
      apply(r, false);
      status();
    }
  }

  async function fetchMissing(r) {
    if (r.deleted) return; // 已删除的记录不需要照片
    for (const p of r.photos) {
      if (p.blob) continue;
      const { data, error } = await supabase.storage.from(BUCKET).download(`${uid}/${p.id}.jpg`);
      if (error) throw error;
      p.blob = data;
    }
  }

  async function pull() {
    let cursor = Number(localStorage.getItem(cursorKey)) || 0;
    for (;;) {
      const since = new Date(Math.max(0, cursor - PULL_OVERLAP)).toISOString();
      const { data: rows, error } = await supabase.from('checkins').select('*')
        .eq('user_id', uid).gt('synced_at', since).order('synced_at').limit(PAGE);
      if (error) throw error;
      for (const row of rows) {
        const local = records().find(r => r.id === row.id);
        const same = local && !local.dirty && local.updatedAt === Date.parse(row.updated_at)
          && local.photos.map(p => p.id).join() === row.photos.map(p => p.id).join() && !!local.deleted === row.deleted;
        if (same) continue;
        const merged = mergeRow(local ? { ...local, photos: local.photos.map(p => ({ ...p })) } : null, row);
        await fetchMissing(merged);
        if (local) Object.assign(local, merged);
        await save(local || merged);
        apply(local || merged, !local);
      }
      const newest = rows.length ? Date.parse(rows.at(-1).synced_at) : cursor;
      const advanced = newest > cursor;
      cursor = Math.max(cursor, newest);
      localStorage.setItem(cursorKey, cursor);
      if (rows.length < PAGE || !advanced) break;
    }
  }

  async function run() {
    if (running) { again = true; return; }
    if (!navigator.onLine) return status();
    running = true;
    state = 'syncing';
    status();
    try {
      await push();
      await pull();
      await push(); // 拉取时合并出来的本地独有内容
      state = 'idle';
      lastAt = Date.now();
      localStorage.setItem(`mymap:${uid}:syncedAt`, lastAt);
    } catch (err) {
      console.warn('同步失败', err);
      state = 'error';
    } finally {
      running = false;
      status();
      if (again) { again = false; request(0); }
    }
  }

  function request(delay = 1200) {
    clearTimeout(timer);
    status();
    timer = setTimeout(run, delay);
  }

  addEventListener('online', () => request(0));
  addEventListener('offline', status);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && request(0));
  setInterval(() => document.visibilityState === 'visible' && request(0), PULL_EVERY);
  request(0);
  return { request, status };
}
