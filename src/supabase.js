// Supabase 客户端；未配置时为 null，登录页会给出配置提示
// 地址和 key 由 vite.config.js 按 .env 里的 APP_ENV（test / prod）选好后注入
import { createClient } from '@supabase/supabase-js';

const direct = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_KEY;
const proxy = import.meta.env.VITE_SUPABASE_PROXY; // 生产环境为 /sb/：经自己域名上的 Worker 转发（worker/index.js）

// 国内直连 *.supabase.co 不稳定，线上走本站的 /sb/；本地开发（vite）没有 Worker，仍然直连
const local = ['localhost', '127.0.0.1'].includes(location.hostname);
// 线上有 Worker：Supabase 和 Esri 地名搜索都经本站转发（worker/index.js）
export const viaSite = Boolean(proxy && !local);
const url = viaSite && direct ? new URL(proxy, location.origin).href : direct;

// 登录状态按原来的直连地址命名保存，换成转发地址后已登录的用户不会被登出
export const clientOptions = direct ? { auth: { storageKey: `sb-${new URL(direct).hostname.split('.')[0]}-auth-token` } } : {};

// 网络卡住时不能一直没反应：登录、数据接口 20 秒没回应就报错（上传、下载照片不限时）
const TIMEOUT = 20_000;
function fetchWithTimeout(input, init = {}) {
  const target = String(input?.url ?? input);
  if (init.signal || !/\/(auth|rest)\/v1\//.test(target)) return fetch(input, init);
  return fetch(input, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
}

// 从邮件链接回来时网址里带的信息：要在客户端读取并清掉网址之前记下来
//   recovery：重置密码链接（事件顺序不固定，不能只靠 PASSWORD_RECOVERY 事件判断）
//   error：链接用过或过期（otp_expired 等）
const hash = new URLSearchParams(location.hash.slice(1));
export const urlAuth = {
  recovery: hash.get('type') === 'recovery',
  error: hash.get('error_code') || new URLSearchParams(location.search).get('error_code') || '',
};

export const supabaseReady = Boolean(direct && key && !direct.includes('你的项目'));
export const supabase = supabaseReady
  ? createClient(url, key, { ...clientOptions, global: { fetch: fetchWithTimeout } })
  : null;

// 测试环境在标签页标题前加 [TEST]，免得和正式站混淆
export const appEnv = import.meta.env.VITE_APP_ENV;
if (appEnv === 'test') document.title = `[TEST] ${document.title}`;
