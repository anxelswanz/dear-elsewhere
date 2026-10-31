// 国内网络适配：第三方地图服务（Esri 底图瓦片、OpenFreeMap 街道数据）在国内直连很慢，
// 线上（有 Worker，见 worker/index.js）且用户在中国大陆时，改走本站转发，Cloudflare 边缘缓存瓦片。
// 只给国内用户转发：Worker 免费额度按请求数算，海外用户直连更快也更省。
// Supabase 和地名搜索不在这里：它们对所有线上用户都走本站（见 supabase.js、main.js 的 ESRI_GEOCODE）。
import { viaSite } from './supabase.js';

// 中国大陆的时区（港澳台不受影响，直连就很快）
const CN_TIMEZONES = ['Asia/Shanghai', 'Asia/Urumqi', 'Asia/Chongqing', 'Asia/Harbin', 'Asia/Kashgar'];

function detectCn() {
  // 手动覆盖，方便测试或开了代理的用户：localStorage 'de:cn' 设为 '1' / '0'
  try {
    const forced = localStorage.getItem('de:cn');
    if (forced === '1' || forced === '0') return forced === '1';
  } catch { /* 无痕模式 */ }
  try {
    return CN_TIMEZONES.includes(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return false;
  }
}

export const cnNet = viaSite && detectCn();

// 外部地址 → 本站转发路径（和 worker/index.js 的路由一一对应）
const ROUTES = [
  ['https://server.arcgisonline.com/ArcGIS/rest/services/', '/tiles/esri/'],
  ['https://tiles.openfreemap.org/', '/ofm/'],
];

export function routed(url) {
  if (!cnNet) return url;
  for (const [from, to] of ROUTES) {
    if (url.startsWith(from)) return location.origin + to + url.slice(from.length);
  }
  return url;
}
