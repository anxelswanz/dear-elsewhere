// Supabase 客户端；未配置时为 null，登录页会给出配置提示
// 地址和 key 由 vite.config.js 按 .env 里的 APP_ENV（test / prod）选好后注入
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_KEY;

// 从邮件链接回来时网址里带的信息：要在客户端读取并清掉网址之前记下来
//   recovery：重置密码链接（事件顺序不固定，不能只靠 PASSWORD_RECOVERY 事件判断）
//   error：链接用过或过期（otp_expired 等）
const hash = new URLSearchParams(location.hash.slice(1));
export const urlAuth = {
  recovery: hash.get('type') === 'recovery',
  error: hash.get('error_code') || new URLSearchParams(location.search).get('error_code') || '',
};

export const supabaseReady = Boolean(url && key && !url.includes('你的项目'));
export const supabase = supabaseReady ? createClient(url, key) : null;

// 测试环境在标签页标题前加 [TEST]，免得和正式站混淆
export const appEnv = import.meta.env.VITE_APP_ENV;
if (appEnv === 'test') document.title = `[TEST] ${document.title}`;
