// 用量限制：前端先拦一道并给出提示，真正的防线在 supabase/migrations/0009_limits.sql
import { supabase } from './supabase.js';
import { t } from './i18n.js';

export const LIMITS = {
  placesPerDay: 10,  // 每天最多打卡的景点（按账号时区的自然日）
  photosPerPlace: 5, // 每个景点最多的照片
  photosPerDay: 50,  // 任意 24 小时内最多上传的照片（删了重传也算）
  photosTotal: 1000, // 每人最多保存的照片（与 0014 迁移一致）
  groupSize: 20,     // 每个群最多的人数（含群主）
};

// ---------- 时区：「每天」跟着账号走 ----------
// 浏览器自动上报；服务端 24 小时内只接受一次修改，所以以服务端返回的为准
const browserTz = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
};
let accountTz = browserTz();

export async function initTimezone(uid, priv) {
  accountTz = priv?.timezone || accountTz;
  if (priv?.timezone === browserTz()) return;
  const { data, error } = await supabase.from('profile_private')
    .upsert({ id: uid, timezone: browserTz() }).select('timezone').single();
  if (error) return console.warn('上报时区失败', error); // 还没执行 0009 时没有这一列
  accountTz = data.timezone || accountTz;
}

// 账号时区下的日期，如 2026-10-29
export function accountDay(ts = Date.now()) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: accountTz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ts);
  } catch {
    return new Date(ts).toISOString().slice(0, 10);
  }
}

// ---------- 照片额度 ----------
// { left, nextAt, totalLeft }：今天还剩几张、下一张额度恢复的时间（毫秒，可能为 null）、总量还能存几张
export async function photoQuota() {
  const { data, error } = await supabase.rpc('photo_quota');
  if (error) throw error;
  // totalLeft：总量还能存几张；0014 之前的数据库没有这一项，按不限处理
  return { left: data.left, nextAt: data.next_at ? Date.parse(data.next_at) : null, totalLeft: data.total_left ?? Infinity };
}

export const hhmm = ts => new Date(ts).toTimeString().slice(0, 5);

// 服务端抛出的 'LIMIT:<代码>' → 提示文字；不是超限错误时返回 null
export function limitCode(err) {
  return /LIMIT:(\w+)/.exec(err?.message || '')?.[1] || null;
}
export function limitText(err) {
  const code = limitCode(err);
  return code ? t(`limit.${code}`, LIMITS) : null;
}
