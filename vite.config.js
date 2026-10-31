// 环境开关：.env 里的 APP_ENV（test / prod）决定连哪一套 Supabase；命令行或部署平台的 APP_ENV 优先
// 只把选中那一套的地址和 key 注入前端，另一套不会出现在打包产物里
import { defineConfig, loadEnv } from 'vite';

const ENVS = ['test', 'prod'];

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  const target = (env.APP_ENV || 'test').trim().toLowerCase();
  if (!ENVS.includes(target)) throw new Error(`APP_ENV 只能是 ${ENVS.join(' 或 ')}，现在是「${env.APP_ENV}」`);
  const suffix = target.toUpperCase();
  const url = env[`SUPABASE_URL_${suffix}`] || '';
  const key = env[`SUPABASE_KEY_${suffix}`] || '';
  // 线上经本站 /sb/ 转发到 Supabase（worker/index.js），国内直连 supabase.co 不稳定；测试环境默认直连
  const proxy = env[`SUPABASE_PROXY_${suffix}`] ?? (target === 'prod' ? '/sb/' : '');
  if (!url || !key) console.warn(`\n⚠ 没有配置 SUPABASE_URL_${suffix} / SUPABASE_KEY_${suffix}（见 .env.example）\n`);
  else console.log(`\n▶ Dear Elsewhere · ${target === 'prod' ? '生产环境 PROD' : '测试环境 TEST'} · ${url}\n`);

  return {
    // 三个页面：官网（/，介绍、教程、规则）、软件本身（/app/）、管理员控制台（/dashboard/）
    build: {
      rollupOptions: {
        input: { site: 'index.html', app: 'app/index.html', dashboard: 'dashboard/index.html' },
      },
    },
    define: {
      'import.meta.env.VITE_APP_ENV': JSON.stringify(target),
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(url),
      'import.meta.env.VITE_SUPABASE_KEY': JSON.stringify(key),
      'import.meta.env.VITE_SUPABASE_PROXY': JSON.stringify(proxy),
    },
  };
});
