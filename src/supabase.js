// Supabase 客户端；未配置 .env.local 时为 null，登录页会给出配置提示
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_KEY;

export const supabaseReady = Boolean(url && key && !url.includes('你的项目'));
export const supabase = supabaseReady ? createClient(url, key) : null;
