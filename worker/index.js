// Cloudflare Worker：/sb/* 转发到 Supabase，/geo/* 转发到 Esri 地名搜索，
// /tiles/esri/* 和 /ofm/* 转发地图瓦片（只有国内用户会用到，见 src/net.js），其余请求交给静态文件（dist/）
// 为什么要转发：国内直连 *.supabase.co（法兰克福）很不稳定，点登录会一直没反应；
// 走自己的域名后，浏览器只需要连得上 Cloudflare，Cloudflare 到 Supabase 是境外线路，很稳定。
// 邮件里的链接（验证邮箱、重置密码）也改走这里，见 scripts/setup-prod.mjs 的 auth 步骤。

const PREFIX = '/sb/';
// 只转发 Supabase 的这几类接口
const ALLOWED = /^(auth|rest|storage|realtime|functions)\/v1(\/|$)/;

// Esri 地名搜索、坐标反查（免 key 接口）：国内直连 arcgis.com 同样很慢
const GEO_PREFIX = '/geo/';
const GEO_UPSTREAM = 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/';
const GEO_ALLOWED = /^(findAddressCandidates|reverseGeocode|suggest)$/;

function geocode(request, url) {
  const op = url.pathname.slice(GEO_PREFIX.length);
  if (request.method !== 'GET' || !GEO_ALLOWED.test(op)) return new Response('Not found', { status: 404 });
  // 只带必要的头：不把本站的 cookie、来源页面等信息交给第三方
  return fetch(GEO_UPSTREAM + op + url.search, { headers: { accept: 'application/json' } });
}

// 地图瓦片：只放行用到的几个图层，在 Cloudflare 边缘缓存，同一块瓦片只需从境外取一次
const DAY = 86400;
const TILE_ROUTES = [
  {
    prefix: '/tiles/esri/', upstream: 'https://server.arcgisonline.com/ArcGIS/rest/services/',
    allowed: /^(World_Street_Map|World_Imagery|Reference\/World_Boundaries_and_Places)\/MapServer\/tile\/\d{1,2}\/\d{1,7}\/\d{1,7}$/,
    ttl: () => 30 * DAY,
  },
  {
    // 截图的街道数据：planet 是 TileJSON（会更新，缓存 1 小时），带版本号的 .pbf 瓦片内容不变
    prefix: '/ofm/', upstream: 'https://tiles.openfreemap.org/',
    allowed: /^planet(\/[\w.-]+\/\d{1,2}\/\d{1,7}\/\d{1,7}\.pbf)?$/,
    ttl: path => (path.endsWith('.pbf') ? 30 * DAY : 3600),
  },
];

async function tile(request, url, route) {
  const path = url.pathname.slice(route.prefix.length);
  if (request.method !== 'GET' || !route.allowed.test(path) || url.search) return new Response('Not found', { status: 404 });
  const ttl = route.ttl(path);
  const res = await fetch(route.upstream + path, { cf: { cacheEverything: true, cacheTtl: ttl, cacheTtlByStatus: { '200-299': ttl, '404': 3600, '500-599': 0 } } });
  const out = new Response(res.body, res);
  out.headers.set('cache-control', `public, max-age=${Math.min(ttl, 7 * DAY)}`); // 浏览器也缓存，最多 7 天
  out.headers.delete('set-cookie');
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith(GEO_PREFIX)) return geocode(request, url);
    const tileRoute = TILE_ROUTES.find(r => url.pathname.startsWith(r.prefix));
    if (tileRoute) return tile(request, url, tileRoute);
    if (!url.pathname.startsWith(PREFIX)) return env.ASSETS.fetch(request);

    const rest = url.pathname.slice(PREFIX.length);
    if (!ALLOWED.test(rest)) return new Response('Not found', { status: 404 });
    const target = new URL(rest + url.search, env.SUPABASE_UPSTREAM.replace(/\/?$/, '/'));

    const headers = new Headers(request.headers);
    // Supabase 按 IP 限频（登录、注册、邀请码查询）：把真实访客 IP 带过去，不然所有人共用 Worker 的 IP
    const ip = request.headers.get('cf-connecting-ip');
    if (ip) headers.set('x-forwarded-for', ip);
    headers.delete('cookie'); // Supabase 不用 cookie，不把本站的 cookie 带过去

    // 实时推送是 websocket：原样转发，Workers 会把升级后的连接接起来
    // redirect: manual —— 邮件链接验证后的 303 跳转要交给浏览器，不能在这里跟随
    return fetch(new Request(target, { method: request.method, headers, body: request.body, redirect: 'manual' }));
  },
};
