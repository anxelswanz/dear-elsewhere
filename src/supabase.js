// Supabase 客户端；未配置时为 null，登录页会给出配置提示
// 地址和 key 由 vite.config.js 按 .env 里的 APP_ENV（test / prod）选好后注入
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_KEY;

export const supabaseReady = Boolean(url && key && !url.includes('你的项目'));
export const supabase = supabaseReady ? createClient(url, key) : null;

// 测试环境在标签页标题前加 [TEST]，免得和正式站混淆
export const appEnv = import.meta.env.VITE_APP_ENV;
if (appEnv === 'test') document.title = `[TEST] ${document.title}`;
