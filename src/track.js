// 使用统计：只记功能事件名和少量属性，设计见本地 ANALYTICS.md，服务端见 0018_analytics.sql
// 不写本机存储；会话 id 只在内存里，每次打开页面换一个。失败一律静默，不影响使用
import { supabase } from './supabase.js';

const sid = (crypto.randomUUID?.() || String(Math.random()).slice(2)).slice(0, 36);
let enabled = true; // 账号里关掉了统计时为 false（服务端也会丢弃，这里只是省一次请求）

export function setTracking(on) {
  enabled = on !== false;
}

// 返回 Promise：页面马上要刷新时（例如换语言）可以等它发完
export function track(event, props = {}) {
  if (!enabled || !supabase) return Promise.resolve();
  return supabase.rpc('track', { event, props, sid }).then(({ error }) => {
    if (error && import.meta.env.DEV) console.debug('track', event, error.message); // 还没执行 0018 时
  }, () => {});
}

export const device = () => (matchMedia('(max-width: 700px)').matches ? 'phone' : 'desktop');
