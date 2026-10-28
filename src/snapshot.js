// 一键截图（「暗房」）：按当前地图的中心和缩放，隐藏所有界面，
// 用手账风格的矢量底图重新画一张图，保留全部打卡标记；可选 4:5 / 1:1 / 9:16，2 倍清晰度导出 PNG。
// 底图不用地图瓦片：瓦片跨域会污染画布，也和手账风格不搭。

import { t } from './i18n.js';

const RATIOS = { '4:5': 4 / 5, '1:1': 1, '9:16': 9 / 16 };
const SCALE = 2;
const C = {
  sea: '#dde5e3', rule: 'rgba(31, 75, 143, .07)', land: '#f6efdf', ink: '#2a2723', inkSoft: '#7a7064',
  accent: '#e8590c', red: '#c4302b', white: '#fff',
};
const SANS = '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
const SERIF_EN = '"Fraunces", "Iowan Old Style", Georgia, serif';
const SERIF_ZH = '"Noto Serif SC", "Songti SC", serif';

const $ = sel => document.querySelector(sel);

// scene() 由地图提供当前画面的全部内容，见 main.js 的 snapshotScene
export function initSnapshot({ map, toMap, scene, iconSvg }) {
  let ratio = '4:5';
  let blob = null;
  let rendering = 0;

  // ---------- 坐标：投影一次，再按「一个世界宽」平移出左右的副本 ----------
  const project = (lat, lng) => {
    const p = map.latLngToContainerPoint(toMap(lat, lng));
    return [p.x, p.y];
  };
  const worldPx = () => 256 * 2 ** map.getZoom();

  function ringPath(ctx, ring, shift) {
    ring.forEach(([lng, lat], i) => {
      const [x, y] = project(lat, lng);
      i ? ctx.lineTo(x + shift, y) : ctx.moveTo(x + shift, y);
    });
    ctx.closePath();
  }
  const polygonsOf = g => (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []);

  // 画一个要素：在可见范围内的每个世界副本上各画一次
  function drawFeature(ctx, feature, crop, style) {
    const polys = polygonsOf(feature.geometry);
    if (!polys.length) return;
    // 先用外环算出投影后的包围盒，做裁剪
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const poly of polys) for (const [lng, lat] of poly[0]) {
      const [x, y] = project(lat, lng);
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    if (maxY < crop.y || minY > crop.y + crop.h) return;
    const W = worldPx();
    for (const k of [-1, 0, 1]) {
      const shift = k * W;
      if (maxX + shift < crop.x || minX + shift > crop.x + crop.w) continue;
      ctx.beginPath();
      for (const poly of polys) for (const ring of poly) ringPath(ctx, ring, shift);
      style(ctx);
    }
  }

  // ---------- 底图 ----------
  function paperNoise() {
    const c = document.createElement('canvas');
    c.width = c.height = 160;
    const g = c.getContext('2d');
    const img = g.createImageData(160, 160);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 110 + Math.random() * 80;
      img.data[i] = v; img.data[i + 1] = v * .92; img.data[i + 2] = v * .78; img.data[i + 3] = Math.random() * 22;
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  function drawBase(ctx, crop, s) {
    // 海：淡灰蓝的纸，带一行行横格线
    ctx.fillStyle = C.sea;
    ctx.fillRect(crop.x, crop.y, crop.w, crop.h);
    ctx.strokeStyle = C.rule;
    ctx.lineWidth = 1;
    for (let y = crop.y + 18; y < crop.y + crop.h; y += 22) {
      ctx.beginPath(); ctx.moveTo(crop.x, y); ctx.lineTo(crop.x + crop.w, y); ctx.stroke();
    }

    const pencil = (width, color, dash = []) => c => {
      c.setLineDash(dash);
      c.lineJoin = 'round';
      c.strokeStyle = color;
      c.lineWidth = width;
      c.stroke();
      // 铅笔描两遍：第二遍错开半个像素，线条更像手画
      c.save(); c.translate(.6, .4); c.globalAlpha = .35; c.stroke(); c.restore();
      c.setLineDash([]);
    };

    // 陆地
    for (const f of s.countries) {
      const visited = s.visited.country.has(f.properties.id);
      drawFeature(ctx, f, crop, c => {
        c.fillStyle = C.land; c.fill('evenodd');
        if (visited) { c.fillStyle = 'rgba(232, 89, 12, .07)'; c.fill('evenodd'); }
        pencil(1, 'rgba(42, 39, 35, .5)')(c);
      });
    }
    // 省 / 州
    for (const f of s.regions) {
      const id = f.properties.id;
      const current = s.current?.level === 'region' && s.current.id === id;
      drawFeature(ctx, f, crop, c => {
        if (s.visited.region.has(id) && map.getZoom() < 9) { c.fillStyle = 'rgba(232, 89, 12, .06)'; c.fill('evenodd'); }
        pencil(current ? 1.8 : .8, current ? C.red : 'rgba(42, 39, 35, .35)', current ? [7, 4] : [4, 3])(c);
      });
    }
    // 陆地上的手账点阵
    dotGrid(ctx, crop, s);

    // 城市轮廓（目前只有中国的城市有边界）
    for (const f of s.cities) {
      const id = f.properties.id;
      const current = s.current?.level === 'city' && s.current.id === id;
      drawFeature(ctx, f, crop, c => {
        if (s.visited.city.has(id)) { c.fillStyle = 'rgba(232, 89, 12, .12)'; c.fill('evenodd'); }
        pencil(current ? 2.2 : .7, current ? C.red : 'rgba(42, 39, 35, .28)', current ? [8, 5] : [2, 3])(c);
      });
    }
  }

  function dotGrid(ctx, crop, s) {
    ctx.save();
    // 用所有陆地拼成一条裁剪路径
    const W = worldPx();
    ctx.beginPath();
    for (const f of s.countries) {
      for (const poly of polygonsOf(f.geometry)) {
        const pts = poly[0].map(([lng, lat]) => project(lat, lng));
        const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
        if (Math.max(...ys) < crop.y || Math.min(...ys) > crop.y + crop.h) continue;
        for (const k of [-1, 0, 1]) {
          const sh = k * W;
          if (Math.max(...xs) + sh < crop.x || Math.min(...xs) + sh > crop.x + crop.w) continue;
          pts.forEach(([x, y], i) => (i ? ctx.lineTo(x + sh, y) : ctx.moveTo(x + sh, y)));
          ctx.closePath();
        }
      }
    }
    ctx.clip('evenodd');
    ctx.fillStyle = 'rgba(42, 39, 35, .13)';
    for (let y = crop.y + 11; y < crop.y + crop.h; y += 18) {
      for (let x = crop.x + 11; x < crop.x + crop.w; x += 18) ctx.fillRect(x - .6, y - .6, 1.2, 1.2);
    }
    ctx.restore();
  }

  // 没有边界数据的城市：用一圈手绘虚线圈出大致范围（约 8 公里）
  function cityRing(ctx, s) {
    const c = s.currentCity;
    if (!c || s.cities.some(f => f.properties.id === c.id)) return;
    const [x, y] = project(c.lat, c.lng);
    const [, y2] = project(c.lat + 8 / 111, c.lng);
    const r = Math.abs(y - y2);
    if (r < 20) return;
    ctx.save();
    ctx.strokeStyle = C.red; ctx.lineWidth = 2; ctx.setLineDash([9, 6]); ctx.lineCap = 'round';
    ctx.beginPath();
    // 不是正圆：半径随角度轻轻起伏，更像手画
    for (let a = 0; a <= Math.PI * 2 + .01; a += Math.PI / 48) {
      const rr = r * (1 + .025 * Math.sin(a * 3) + .015 * Math.cos(a * 5));
      const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr * .96;
      a ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.stroke();
    ctx.fillStyle = 'rgba(232, 89, 12, .05)'; ctx.fill();
    ctx.restore();
  }

  // 地名：按重要程度从高到低放，互相不重叠
  function drawLabels(ctx, crop, s) {
    const z = map.getZoom();
    const maxRank = z < 4 ? 1 : z < 6 ? 3 : z < 8 ? 6 : 10;
    const taken = [];
    const fits = r => !taken.some(t => r.x < t.x + t.w && r.x + r.w > t.x && r.y < t.y + t.h && r.y + r.h > t.y);
    ctx.textBaseline = 'middle';
    const W = worldPx();
    const candidates = s.labels.filter(c => c.rank <= maxRank).sort((a, b) => a.rank - b.rank);
    let n = 0;
    for (const c of candidates) {
      if (n >= 40) break;
      let [x, y] = project(c.lat, c.lng);
      x += Math.round((crop.x + crop.w / 2 - x) / W) * W;
      if (x < crop.x || x > crop.x + crop.w || y < crop.y + 10 || y > crop.y + crop.h - 10) continue;
      const big = c.rank <= 2;
      ctx.font = `${big ? 700 : 500} ${big ? 13 : 11.5}px ${SERIF_ZH}`;
      const w = ctx.measureText(c.name).width;
      const box = { x: x - 4, y: y - 9, w: w + 14, h: 18 };
      if (!fits(box)) continue;
      taken.push(box);
      n++;
      ctx.fillStyle = C.ink;
      ctx.beginPath(); ctx.arc(x, y, big ? 2.6 : 2, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(246, 239, 223, .9)'; ctx.lineJoin = 'round';
      ctx.strokeText(c.name, x + 6, y);
      ctx.fillStyle = big ? C.ink : C.inkSoft;
      ctx.fillText(c.name, x + 6, y);
    }
  }

  // ---------- 标记（与地图上的样式一致） ----------
  const icons = new Map();
  function iconImage(name, color) {
    const key = `${name}|${color}`;
    if (!icons.has(key)) {
      icons.set(key, new Promise(resolve => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${iconSvg(name)}</svg>`)}`;
      }));
    }
    return icons.get(key);
  }
  async function loadImage(src) {
    if (!src) return null;
    return new Promise(resolve => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }
  async function photoImage(p) {
    try {
      if (p.blob) return await createImageBitmap(p.blob);
      if (p.url) return await createImageBitmap(await (await fetch(p.url, { mode: 'cors' })).blob());
    } catch { /* 照片读不到就跳过 */ }
    return null;
  }

  const rr = (ctx, x, y, w, h, r) => { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); };
  function fitText(ctx, text, max) {
    if (ctx.measureText(text).width <= max) return text;
    while (text && ctx.measureText(`${text}…`).width > max) text = text.slice(0, -1);
    return `${text}…`;
  }
  const shadow = (ctx, blur, y, color = 'rgba(0, 0, 0, .3)') => { ctx.shadowColor = color; ctx.shadowBlur = blur; ctx.shadowOffsetY = y; };
  const noShadow = ctx => { ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0; };

  // 名字 + 日期两行，返回宽度；draw=false 时只量尺寸
  function textBlock(ctx, m, x, y, { color = C.white, dateColor = color, align = 'center', upper = false, nameFont, draw = true } = {}) {
    ctx.font = nameFont || `700 13px ${SANS}`;
    const name = fitText(ctx, upper ? m.text.toUpperCase() : m.text, 170);
    const nw = ctx.measureText(name).width;
    ctx.font = `600 10.5px ${SERIF_EN}`;
    const dw = ctx.measureText(m.date).width;
    const w = Math.max(nw, dw);
    if (draw) {
      ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
      ctx.font = nameFont || `700 13px ${SANS}`;
      ctx.fillStyle = color; ctx.fillText(name, x, y + 13);
      ctx.font = `600 10.5px ${SERIF_EN}`;
      ctx.fillStyle = dateColor; ctx.fillText(m.date, x, y + 13 + 13);
    }
    return w;
  }

  // 每种样式都以坐标点 (0, 0) 为底部中心向上画
  const DRAW = {
    async sign(ctx, m) {
      const ico = await iconImage(m.icon, C.white);
      const w = textBlock(ctx, m, 0, 0, { draw: false }) + 28 + 22;
      const h = 44, top = -27 - h;
      ctx.fillStyle = 'rgba(0, 0, 0, .25)'; ctx.beginPath(); ctx.ellipse(0, -2.5, 9, 2.5, 0, 0, Math.PI * 2); ctx.fill();
      const pole = ctx.createLinearGradient(-2.5, 0, 2.5, 0);
      pole.addColorStop(0, '#7b828a'); pole.addColorStop(.45, '#dfe3e7'); pole.addColorStop(1, '#7b828a');
      ctx.fillStyle = pole; ctx.fillRect(-2.5, -27, 5, 24);
      shadow(ctx, 12, 5); ctx.fillStyle = '#1e6b46'; rr(ctx, -w / 2, top, w, h, 6); ctx.fill(); noShadow(ctx);
      ctx.strokeStyle = C.white; ctx.lineWidth = 1.5; rr(ctx, -w / 2 + 2.75, top + 2.75, w - 5.5, h - 5.5, 4); ctx.stroke();
      if (ico) ctx.drawImage(ico, -w / 2 + 14, top + h / 2 - 8, 16, 16);
      textBlock(ctx, m, 11, top + 7);
      return { w, h: 71, badgeAt: [-w / 2 + 14, top + h / 2] };
    },
    async flag(ctx, m) {
      const ico = await iconImage(m.icon, C.white);
      const tw = textBlock(ctx, m, 0, 0, { draw: false });
      const w = tw + 10 + 24 + 20, h = 40;
      ctx.fillStyle = 'rgba(0, 0, 0, .25)'; ctx.beginPath(); ctx.ellipse(-0.5, -2, 7, 2, 0, 0, Math.PI * 2); ctx.fill();
      const pole = ctx.createLinearGradient(0, 0, 3, 0);
      pole.addColorStop(0, C.ink); pole.addColorStop(.5, '#6b665e'); pole.addColorStop(1, C.ink);
      ctx.fillStyle = pole; ctx.fillRect(0, -62, 3, 60);
      ctx.fillStyle = '#d4a72c'; ctx.beginPath(); ctx.arc(1.5, -62, 3.5, 0, Math.PI * 2); ctx.fill();
      const x = 3, y = -60;
      const cloth = ctx.createLinearGradient(x, y, x + w, y + h);
      cloth.addColorStop(0, C.accent); cloth.addColorStop(1, C.red);
      shadow(ctx, 6, 3, 'rgba(0, 0, 0, .25)');
      ctx.fillStyle = cloth;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w * .88, y + h / 2); ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); ctx.closePath(); ctx.fill();
      noShadow(ctx);
      if (ico) ctx.drawImage(ico, x + 10, y + h / 2 - 8, 16, 16);
      textBlock(ctx, m, x + 10 + 20, y + 6, { align: 'left' });
      return { w: w * 2, h: 64 };
    },
    async neon(ctx, m) {
      const ico = await iconImage(m.icon, '#ffe6f3');
      const w = textBlock(ctx, m, 0, 0, { draw: false }) + 28 + 22, h = 44, top = -8 - 18 - h;
      ctx.fillStyle = '#ff4fa3'; shadow(ctx, 10, 0, '#ff4fa3');
      ctx.beginPath(); ctx.arc(0, -4, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillRect(-1, -26, 2, 18);
      ctx.fillStyle = '#16131f'; shadow(ctx, 18, 0, 'rgba(255, 79, 163, .6)'); rr(ctx, -w / 2, top, w, h, 10); ctx.fill();
      noShadow(ctx); ctx.strokeStyle = '#ff4fa3'; ctx.lineWidth = 1.5; ctx.stroke();
      if (ico) ctx.drawImage(ico, -w / 2 + 14, top + h / 2 - 8, 16, 16);
      shadow(ctx, 10, 0, '#ff4fa3');
      textBlock(ctx, m, 11, top + 7, { color: '#ffe6f3', dateColor: '#8ff5ff' });
      noShadow(ctx);
      return { w, h: 70 };
    },
    async stamp(ctx, m) {
      const ico = await iconImage(m.icon, C.red);
      const nameFont = `800 13px ${SERIF_EN}, ${SERIF_ZH}`;
      const tw = textBlock(ctx, m, 0, 0, { draw: false, upper: true, nameFont });
      const w = tw + 24 + 22, h = 52, cy = -18 - h / 2;
      // 底下的定位点
      ctx.fillStyle = C.red; shadow(ctx, 3, 1, 'rgba(0, 0, 0, .45)');
      ctx.beginPath(); ctx.arc(0, -6.5, 4.5, 0, Math.PI * 2); ctx.fill(); noShadow(ctx);
      ctx.strokeStyle = C.white; ctx.lineWidth = 2; ctx.stroke();
      ctx.save(); ctx.translate(0, cy); ctx.rotate(-6 * Math.PI / 180);
      shadow(ctx, 10, 4, 'rgba(0, 0, 0, .2)'); ctx.fillStyle = 'rgba(255, 250, 240, .95)'; rr(ctx, -w / 2, -h / 2, w, h, 4); ctx.fill(); noShadow(ctx);
      ctx.strokeStyle = C.red; ctx.lineWidth = 2.5; ctx.stroke();
      ctx.lineWidth = 1; rr(ctx, -w / 2 - 3.5, -h / 2 - 3.5, w + 7, h + 7, 6); ctx.stroke();
      if (ico) ctx.drawImage(ico, -w / 2 + 12, -8, 16, 16);
      ctx.font = `800 9px ${SERIF_EN}`; ctx.fillStyle = C.red; ctx.textAlign = 'center';
      if ('letterSpacing' in ctx) ctx.letterSpacing = '3px';
      ctx.fillText('VISITED', 11, -h / 2 + 13);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
      textBlock(ctx, m, 11, -h / 2 + 15, { color: C.red, upper: true, nameFont });
      ctx.restore();
      return { w, h: 80 };
    },
    async pin(ctx, m) {
      const plain = (m.icon || 'pin') === 'pin';
      const w = textBlock(ctx, m, 0, 0, { draw: false }) + 22, h = 38;
      // 地面波纹
      ctx.strokeStyle = 'rgba(232, 89, 12, .5)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(0, 0, 13, 5, 0, 0, Math.PI * 2); ctx.stroke();
      let top;
      if (plain) {
        ctx.save(); ctx.translate(0, -16); ctx.rotate(-Math.PI / 4);
        shadow(ctx, 5, 2, 'rgba(0, 0, 0, .3)');
        // 与 .pin-head 相同：左下角不圆，转 -45° 后尖角朝下
        ctx.fillStyle = C.accent; rr(ctx, -11, -11, 22, 22, [11, 11, 11, 0]); ctx.fill();
        noShadow(ctx); ctx.strokeStyle = C.white; ctx.lineWidth = 3; ctx.stroke();
        ctx.restore();
        top = -32 - 7 - h;
      } else {
        const ico = await iconImage(m.icon, C.white);
        ctx.fillStyle = '#9a9187'; ctx.fillRect(-1, -14, 2, 14);
        shadow(ctx, 5, 2, 'rgba(0, 0, 0, .3)');
        ctx.fillStyle = C.accent; ctx.beginPath(); ctx.arc(0, -27, 13, 0, Math.PI * 2); ctx.fill(); noShadow(ctx);
        ctx.strokeStyle = C.white; ctx.lineWidth = 2.5; ctx.stroke();
        if (ico) ctx.drawImage(ico, -8, -35, 16, 16);
        top = -40 - 7 - h;
      }
      shadow(ctx, 12, 4, 'rgba(0, 0, 0, .22)'); ctx.fillStyle = C.white; rr(ctx, -w / 2, top, w, h, 10); ctx.fill(); noShadow(ctx);
      textBlock(ctx, m, 0, top + 5, { color: '#1f2328', dateColor: C.accent });
      return { w, h: -top };
    },
    async photos(ctx, m) {
      const imgs = await Promise.all(m.photos.slice(0, 3).map(photoImage));
      ctx.font = `700 13px ${SANS}`;
      const name = fitText(ctx, m.text, 170);
      const nw = ctx.measureText(name).width;
      ctx.font = `600 10.5px ${SERIF_EN}`;
      const dw = ctx.measureText(m.date).width;
      const badge = m.badgeImg ? 21 : 0;
      const cw = badge + nw + 7 + dw + 22, chH = 25;
      // 定位点
      ctx.fillStyle = C.accent; shadow(ctx, 3, 1, 'rgba(0, 0, 0, .45)');
      ctx.beginPath(); ctx.arc(0, -6.5, 4.5, 0, Math.PI * 2); ctx.fill(); noShadow(ctx);
      ctx.strokeStyle = C.white; ctx.lineWidth = 2; ctx.stroke();
      // 名字胶囊
      const capTop = -14 - chH;
      shadow(ctx, 10, 3, 'rgba(0, 0, 0, .22)'); ctx.fillStyle = C.white; rr(ctx, -cw / 2, capTop, cw, chH, chH / 2); ctx.fill(); noShadow(ctx);
      let x = -cw / 2 + 11;
      if (m.badgeImg) { drawAvatar(ctx, m.badgeImg, x + 9, capTop + chH / 2, 9.5); x += badge; }
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.font = `700 13px ${SANS}`; ctx.fillStyle = '#1f2328'; ctx.fillText(name, x, capTop + chH / 2 + .5);
      ctx.font = `600 10.5px ${SERIF_EN}`; ctx.fillStyle = C.accent; ctx.fillText(m.date, x + nw + 7, capTop + chH / 2 + 1);
      // 照片叠放：第三张在最下，封面在最上
      const stackBottom = capTop - 4, left = -39 + 6;
      // 与 .mk-stack 的 p1 / p2 / p3 相同：封面、第二张、第三张依次错开
      const place = [[0, 0, -4], [9, -5, 5], [17, -10, 12]];
      for (let i = imgs.length - 1; i >= 0; i--) {
        const img = imgs[i], [px, py, pr] = place[i];
        {
          ctx.save();
          ctx.translate(left + px + 28, stackBottom + py - 28);
          ctx.rotate(pr * Math.PI / 180);
          shadow(ctx, 8, 3, 'rgba(0, 0, 0, .32)');
          ctx.fillStyle = C.white; rr(ctx, -28, -28, 56, 56, 4); ctx.fill(); noShadow(ctx);
          if (img) {
            ctx.save(); rr(ctx, -25, -25, 50, 50, 2); ctx.clip();
            const s = Math.max(50 / img.width, 50 / img.height);
            ctx.drawImage(img, -img.width * s / 2, -img.height * s / 2, img.width * s, img.height * s);
            ctx.restore();
          } else {
            ctx.fillStyle = '#e9e2d3'; ctx.fillRect(-25, -25, 50, 50);
          }
          ctx.restore();
        }
      }
      return { w: Math.max(cw, 78), h: -stackBottom + 72 };
    },
  };

  function drawAvatar(ctx, img, x, y, r) {
    ctx.save();
    ctx.beginPath(); ctx.arc(x, y, r + 1.5, 0, Math.PI * 2); ctx.fillStyle = C.white; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.clip();
    ctx.drawImage(img, x - r, y - r, r * 2, r * 2);
    ctx.restore();
  }

  async function drawMarkers(ctx, crop, s) {
    const W = worldPx();
    // 从北往南画，靠南的盖在上面，和地图上一致
    const items = s.markers.map(m => {
      let [x, y] = project(m.lat, m.lng);
      x += Math.round((crop.x + crop.w / 2 - x) / W) * W;
      return { ...m, x, y };
    }).filter(m => m.x > crop.x - 120 && m.x < crop.x + crop.w + 120 && m.y > crop.y - 20 && m.y < crop.y + crop.h + 160)
      .sort((a, b) => a.y - b.y || (a.friend ? -1 : 1));
    for (const m of items) {
      m.badgeImg = m.badge ? await loadImage(m.badge) : null;
      ctx.save();
      ctx.translate(m.x, m.y);
      if (s.far) ctx.scale(.78, .78);
      const style = m.photos.length ? 'photos' : DRAW[m.style] ? m.style : 'sign';
      const box = await DRAW[style](ctx, m);
      // 好友的路牌类标记：在左上角贴一枚头像
      if (m.badgeImg && style !== 'photos') drawAvatar(ctx, m.badgeImg, style === 'flag' ? 0 : -box.w / 2, -box.h + 4, 10);
      ctx.restore();
    }
  }

  // ---------- 合成 ----------
  function cropRect() {
    const size = map.getSize();
    const r = RATIOS[ratio];
    let w = size.x, h = w / r;
    if (h > size.y) { h = size.y; w = h * r; }
    return { x: (size.x - w) / 2, y: (size.y - h) / 2, w, h };
  }

  async function render() {
    const s = scene();
    const crop = cropRect();
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(crop.w * SCALE);
    canvas.height = Math.round(crop.h * SCALE);
    const ctx = canvas.getContext('2d');
    ctx.scale(SCALE, SCALE);
    ctx.translate(-crop.x, -crop.y);
    await Promise.all([`700 13px ${SANS}`, `600 10.5px ${SERIF_EN}`, `800 13px ${SERIF_EN}`, `700 13px ${SERIF_ZH}`, `500 11.5px ${SERIF_ZH}`]
      .map(f => document.fonts.load(f).catch(() => null)));

    drawBase(ctx, crop, s);
    cityRing(ctx, s);
    drawLabels(ctx, crop, s);
    // 纸张颗粒
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = ctx.createPattern(paperNoise(), 'repeat');
    ctx.fillRect(crop.x, crop.y, crop.w, crop.h);
    ctx.restore();
    if (s.showMarkers) await drawMarkers(ctx, crop, s);
    // 四角轻微压暗
    const v = ctx.createRadialGradient(crop.x + crop.w / 2, crop.y + crop.h / 2, Math.min(crop.w, crop.h) * .45, crop.x + crop.w / 2, crop.y + crop.h / 2, Math.hypot(crop.w, crop.h) * .6);
    v.addColorStop(0, 'rgba(60, 40, 20, 0)'); v.addColorStop(1, 'rgba(60, 40, 20, .14)');
    ctx.fillStyle = v; ctx.fillRect(crop.x, crop.y, crop.w, crop.h);
    return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  }

  // ---------- 暗房界面 ----------
  async function develop() {
    const job = ++rendering;
    const box = $('#shot');
    box.dataset.state = 'developing';
    $('#shotSave').disabled = true;
    const out = await render();
    if (job !== rendering) return; // 期间换了比例
    blob = out;
    const img = $('#shotImg');
    URL.revokeObjectURL(img.src);
    img.src = URL.createObjectURL(blob);
    await img.decode().catch(() => {});
    box.style.setProperty('--ratio', RATIOS[ratio]);
    box.dataset.state = 'ready';
    $('#shotSave').disabled = false;
  }

  function open() {
    const s = scene();
    $('#shotTitle').textContent = s.title;
    $('#shot').hidden = false;
    for (const b of document.querySelectorAll('[data-ratio]')) b.setAttribute('aria-checked', b.dataset.ratio === ratio);
    develop();
  }

  function close() {
    $('#shot').hidden = true;
    rendering++;
  }

  async function save() {
    if (!blob) return;
    const name = `${t('backupName')}-${scene().title}-${new Date().toISOString().slice(0, 10)}.png`;
    const file = new File([blob], name, { type: 'image/png' });
    // 手机上优先用系统分享（可以直接存到相册）
    if (innerWidth <= 700 && navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return; } catch { /* 用户取消 */ }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  $('#shotClose').onclick = close;
  $('#shot .shot-backdrop').onclick = close;
  $('#shotSave').onclick = save;
  $('#shot').addEventListener('click', e => {
    const b = e.target.closest('[data-ratio]');
    if (!b || b.dataset.ratio === ratio) return;
    ratio = b.dataset.ratio;
    for (const x of document.querySelectorAll('[data-ratio]')) x.setAttribute('aria-checked', x === b);
    develop();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('#shot').hidden) { e.stopImmediatePropagation(); close(); }
  }, true);

  return { open, render, setRatio: r => { ratio = r; } };
}
