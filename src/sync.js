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
import { limitCode, photoQuota } from './limits.js';
import { track } from './track.js';

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
  photos: r.photos.filter(p => p.up).map(p => ({ id: p.id })), // 还没传上去的照片等传完再告诉服务端
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
// apply(r, isNew): 合并后的记录交回界面；onStatus({ pending, state, at, until })；
// onPhotoLimit(until): 照片额度用完时提醒一次，until 是额度恢复的时间
export function createSync({ uid, records, save, apply, onStatus, onPhotoLimit }) {
  const cursorKey = `mymap:${uid}:cursor`;
  let running = false, again = false, timer = null;
  let errorReported = false; // 这次打开页面已经上报过同步失败
  let limited = false; // 这一轮有记录因超出用量限制没能上传
  let photosBlockedUntil = 0; // 照片额度用完，到这个时间之前不再尝试上传照片
  const pushed = new Map(); // id -> 上次推送时的版本，额度用完期间避免每分钟重复推送同一条
  let state = 'idle', lastAt = Number(localStorage.getItem(`mymap:${uid}:syncedAt`)) || 0;

  const status = () => onStatus({
    pending: records().filter(r => r.dirty).length, state: navigator.onLine ? state : 'offline', at: lastAt,
    until: photosBlockedUntil > Date.now() ? photosBlockedUntil : 0,
  });

  // 额度用完：问清楚什么时候恢复，到点自动续传
  async function blockPhotos() {
    const { nextAt } = await photoQuota().catch(() => ({}));
    photosBlockedUntil = Math.max(nextAt || 0, Date.now() + 60_000);
    onPhotoLimit?.(photosBlockedUntil);
    setTimeout(() => request(0), photosBlockedUntil - Date.now() + 1000);
  }

  async function upload(r) {
    for (const p of r.photos) {
      if (p.up || !p.blob) continue;
      if (Date.now() < photosBlockedUntil) return; // 已传的照片照常推送，剩下的等额度恢复
      // 先领上传凭证：服务端在这里统计照片额度，没有凭证 Storage 不接受上传
      const ticket = await supabase.rpc('claim_photo', { photo: p.id });
      if (limitCode(ticket.error) === 'photos_per_day') return blockPhotos();
      if (ticket.error) throw ticket.error;
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
      const version = r.updatedAt;
      let row;
      try {
        await upload(r);
        const sig = `${version}|${r.photos.filter(p => p.up).map(p => p.id)}`;
        if (pushed.get(r.id) === sig) continue; // 和上次推送的一样，只是还有照片在等额度
        const res = await supabase.rpc('push_checkin', { r: toRow(r) });
        if (res.error) throw res.error;
        row = res.data;
        pushed.set(r.id, sig);
      } catch (err) {
        // 超限的记录留在本地、保持待上传，不挡住其他记录；额度恢复后自动续传
        if (!limitCode(err)) throw err;
        console.warn('超出用量限制，稍后再传', r.id, err.message);
        limited = true;
        continue;
      }
      if (r.updatedAt !== version) continue; // 上传期间又被修改，下一轮再推
      await purge(row);
      r.dirty = false;
      mergeRow(r, row);
      await fetchMissing(r);
      await save(r);
      apply(r, false);
      status();
    }
  }

  // 删掉的照片（以及整条删除的打卡的全部照片）从 Storage 里一并删除，不留在云端
  async function purge(row) {
    const ids = [...row.deleted_photos, ...(row.deleted ? row.photos.map(p => p.id) : [])];
    if (!ids.length) return;
    const { error } = await supabase.storage.from(BUCKET).remove(ids.flatMap(id => [`${uid}/${id}.jpg`, `${uid}/${id}_t.jpg`]));
    if (error) throw error;
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
    limited = false;
    status();
    try {
      await push();
      await pull();
      await push(); // 拉取时合并出来的本地独有内容
      const waiting = photosBlockedUntil > Date.now() && records().some(r => r.photos.some(p => !p.up && p.blob));
      state = limited || waiting ? 'limited' : 'idle';
      lastAt = Date.now();
      localStorage.setItem(`mymap:${uid}:syncedAt`, lastAt);
    } catch (err) {
      console.warn('同步失败', err);
      state = 'error';
      // 使用统计：联网时的同步失败，每次打开页面只报一次（断网重试不算）
      if (navigator.onLine && !errorReported) {
        errorReported = true;
        track('client_error', { where: 'sync', code: String(err?.code || err?.name || 'unknown') });
      }
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
