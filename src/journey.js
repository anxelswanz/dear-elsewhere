// 旅程：按打卡日期把去过的城市串成一段段旅程
//   · 同一个城市里连续的几次打卡算一站；换城市就是一段，跨年的一段算到达的那一年
//   · 跨国默认飞机（可改轮船），国内默认火车（可改汽车、飞机）；改过的记在「到达」那次打卡的 transport 上
//   · 平时只画一个年份的航线，交通工具停在每段中点，点它切换
//   · 回放：镜头不动，一段接一段跑，到站盖邮戳，跑完停 2.5 秒循环
//   · 新打卡换了城市、且是最新日期时，关上明信片后从上一站飞过来一次
import { t, lang } from './i18n.js';

const INTL = ['plane', 'ship'];
const DOMESTIC = ['train', 'car', 'plane'];
const STYLE = {
  plane: { color: '#1f4b8f', weight: 2, dash: '10 8', bend: .3 },
  ship: { color: '#2b7a8c', weight: 2, dash: '7 5', bend: .12, wave: true },
  train: { color: '#2a2723', weight: 1.5, dash: null, bend: .05, ties: true },
  car: { color: '#9a6b3f', weight: 2.2, dash: '1 6', bend: .02 },
};
const VEHICLE = {
  plane: '<path fill="currentColor" stroke="none" d="M21.5 12c0-.8-.7-1.3-1.5-1.3h-5.2L10 3.5H8.1l2.3 7.2H5.6L4 8.6H2.6l1 3.4-1 3.4H4l1.6-2.1h4.8L8.1 20.5H10l4.8-7.2H20c.8 0 1.5-.5 1.5-1.3z"/>',
  ship: '<path d="M2.5 15h19l-3 4.5h-13z"/><path d="M6 15v-4.5h8.5L18 15"/><path d="M9 10.5V6.5h3.5v4"/><path d="M2.5 21.5c1.5-.8 3-.8 4.5 0s3 .8 4.5 0 3-.8 4.5 0 3 .8 4.5 0"/>',
  train: '<rect x="6" y="3" width="12" height="13.5" rx="3"/><path d="M6 10h12M9.5 13.5h.01M14.5 13.5h.01M9 20.5l-2 2M15 20.5l2 2"/>',
  car: '<path d="M3 15.5v-3.2L5.2 8h11l3 4.3h1.8v3.2z"/><circle cx="7.3" cy="16.3" r="1.9"/><circle cx="16.7" cy="16.3" r="1.9"/>',
};
const ROUTE_ICON = '<path d="M5 18.5c3-6 9 0 14-7"/><circle cx="5" cy="18.5" r="2"/><path d="M19 4.5l.01 0M16.5 7c0-1.4 1.1-2.5 2.5-2.5S21.5 5.6 21.5 7c0 1.9-2.5 4.5-2.5 4.5S16.5 8.9 16.5 7z"/>';
const svg = (body, cls = 'ic') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = d => (d || '').replaceAll('-', '.');
const ease = x => (x < .5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2);

// map / L：地图；toMapAt(lat, lng, offset)：WGS84 → 当前底图坐标；records()：自己的记录；
// stationOf(r)：这次打卡落在哪一站 { key, name, country, lat, lng }；distKm；save(r)：保存并同步；toast(text)
export function initJourney({ map, L, toMapAt, uid, records, stationOf, distKm, save, toast }) {
  const store = {
    get: (k, d) => { try { return localStorage.getItem(`mymap:${uid}:jr-${k}`) ?? d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(`mymap:${uid}:jr-${k}`, v); } catch { /* 隐私模式 */ } },
  };
  let show = store.get('show', '1') === '1';
  let year = Number(store.get('year', 0)) || 0;
  let legs = [];
  let play = null;

  map.createPane('journey').style.zIndex = 450;
  const renderer = L.svg({ pane: 'journey', padding: .5 });
  const staticLayer = L.layerGroup().addTo(map);
  const playLayer = L.layerGroup().addTo(map);

  // ---------- 站点与旅程 ----------
  function compute() {
    const dated = records().filter(r => !r.deleted && r.date)
      .map(r => ({ r, s: stationOf(r) })).filter(x => x.s)
      .sort((a, b) => a.r.date.localeCompare(b.r.date) || (a.r.createdAt || 0) - (b.r.createdAt || 0));
    const stations = [];
    for (const { r, s } of dated) {
      const last = stations.at(-1);
      if (last && last.key === s.key) { last.last = r.date; continue; }
      stations.push({ ...s, first: r.date, last: r.date, arrival: r });
    }
    legs = stations.slice(1).map((to, i) => {
      const from = stations[i];
      const intl = from.country !== to.country;
      const options = intl ? INTL : DOMESTIC;
      const mode = options.includes(to.arrival.transport) ? to.arrival.transport : options[0];
      return { from, to, intl, options, mode, year: Number(to.first.slice(0, 4)), km: distKm(from.lat, from.lng, to.lat, to.lng) };
    });
    const years = [...new Set(legs.map(l => l.year))].sort();
    if (!years.includes(year)) {
      const now = new Date().getFullYear();
      year = years.includes(now) ? now : years.at(-1) || now;
    }
    return years;
  }
  const legsOf = y => legs.filter(l => l.year === y);

  // ---------- 几何：在当前缩放的像素坐标里画弧线，再换回经纬度 ----------
  function geometry(leg) {
    const z = map.getZoom();
    const st = STYLE[leg.mode];
    const a = toMapAt(leg.from.lat, leg.from.lng, 0);
    const b = toMapAt(leg.to.lat, leg.to.lng, 0);
    // 走近的一边：终点经度与起点相差不超过 180°（横跨太平洋时不绕地球一圈）
    let blng = b[1];
    while (blng - a[1] > 180) blng -= 360;
    while (blng - a[1] < -180) blng += 360;
    const p0 = map.project(L.latLng(a[0], a[1]), z);
    const p1 = map.project(L.latLng(b[0], blng), z);
    const d = p1.subtract(p0);
    const len = Math.hypot(d.x, d.y) || 1;
    let n = L.point(-d.y / len, d.x / len);
    if (n.y > 0) n = n.multiplyBy(-1); // 弧线向北拱起
    const ctrl = p0.add(p1).divideBy(2).add(n.multiplyBy(len * st.bend));
    const steps = Math.max(24, Math.min(180, Math.round(len / 5)));
    const pts = [];
    let walked = 0, prev = null;
    for (let i = 0; i <= steps; i++) {
      const s = i / steps;
      let p = p0.multiplyBy((1 - s) ** 2).add(ctrl.multiplyBy(2 * (1 - s) * s)).add(p1.multiplyBy(s * s));
      if (prev) walked += p.distanceTo(prev);
      prev = p;
      // 轮船：沿航线起伏的波浪，两端收住
      if (st.wave && len > 40) p = p.add(n.multiplyBy(Math.sin(walked / 9) * 2.6 * Math.sin(Math.PI * s)));
      pts.push(p);
    }
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
    return { pts, cum, z, latlngs: pts.map(p => map.unproject(p, z)) };
  }

  // 沿折线走到 f（0–1）处：位置和方向
  function at(g, f) {
    const target = g.cum.at(-1) * f;
    let i = 1;
    while (i < g.cum.length - 1 && g.cum[i] < target) i++;
    const seg = g.cum[i] - g.cum[i - 1] || 1;
    const k = (target - g.cum[i - 1]) / seg;
    const p = g.pts[i - 1].add(g.pts[i].subtract(g.pts[i - 1]).multiplyBy(k));
    const dir = g.pts[i].subtract(g.pts[i - 1]);
    return { latlng: map.unproject(p, g.z), angle: Math.atan2(dir.y, dir.x) * 180 / Math.PI, i };
  }

  const shift = (lls, k) => lls.map(ll => L.latLng(ll.lat, ll.lng + k * 360));
  // 选一个离当前视野中心最近的世界副本
  const nearestCopy = lls => Math.round((map.getCenter().lng - lls[Math.floor(lls.length / 2)].lng) / 360);

  function routeLines(g, mode, k, extra = {}) {
    const st = STYLE[mode];
    const lls = shift(g.latlngs, k);
    const base = { renderer, interactive: false, color: st.color, lineCap: 'round', lineJoin: 'round', ...extra };
    const lines = [];
    if (st.ties) {
      // 火车：一条细轨道 + 一道道枕木
      lines.push(L.polyline(lls, { ...base, weight: 7, dashArray: '1.4 7', opacity: (extra.opacity ?? .8) * .55, lineCap: 'butt' }));
      lines.push(L.polyline(lls, { ...base, weight: st.weight, opacity: extra.opacity ?? .8 }));
    } else {
      lines.push(L.polyline(lls, { ...base, weight: st.weight, dashArray: st.dash, opacity: extra.opacity ?? .8 }));
    }
    return lines;
  }

  function vehicleHtml(mode, angle, cls = '') {
    // 飞机朝航线方向转；其他交通工具是侧面图，往左走时左右翻转
    const flip = mode !== 'plane' && mode !== 'train' && Math.abs(angle) > 90;
    const style = mode === 'plane' ? `--rot: ${angle}deg` : `--flip: ${flip ? -1 : 1}`;
    return `<span class="jr-vehicle jr-${mode} ${cls}" style="${style}">${svg(VEHICLE[mode], 'jr-ic')}</span>`;
  }

  // ---------- 平时：画选中年份的航线，交通工具停在中点 ----------
  function draw() {
    staticLayer.clearLayers();
    if (!show) return;
    const z = map.getZoom();
    for (const leg of legsOf(year)) {
      const g = geometry(leg);
      const mid = at(g, .5);
      for (const k of [-1, 0, 1]) {
        routeLines(g, leg.mode, k).forEach(l => l.addTo(staticLayer));
        if (z < 4 && !leg.intl) continue; // 缩得很小时只留跨国的
        L.marker(L.latLng(mid.latlng.lat, mid.latlng.lng + k * 360), {
          icon: L.divIcon({ className: 'jr-anchor', iconSize: [30, 30], iconAnchor: [15, 15], html: vehicleHtml(leg.mode, mid.angle, 'parked') }),
          title: t('jr.switch', { mode: t(`jr.mode.${leg.mode}`) }),
          zIndexOffset: 300, keyboard: true,
        }).on('click', () => cycle(leg)).addTo(staticLayer);
      }
    }
  }

  async function cycle(leg) {
    const next = leg.options[(leg.options.indexOf(leg.mode) + 1) % leg.options.length];
    leg.to.arrival.transport = next;
    toast(t('jr.changed', { from: leg.from.name, to: leg.to.name, mode: t(`jr.mode.${next}`) }));
    await save(leg.to.arrival); // 保存后 refresh 会重画
  }

  // ---------- 回放 ----------
  const hud = document.createElement('div');
  hud.id = 'journeyHud';
  hud.hidden = true;
  document.body.append(hud);

  function renderHud() {
    if (!play) { hud.hidden = true; return; }
    const leg = play.legs[play.i];
    hud.hidden = false;
    hud.innerHTML = `
      <span class="jr-hud-ic">${svg(VEHICLE[leg.mode], 'jr-ic')}</span>
      <span class="jr-hud-text"><b>${play.single ? escapeHtml(String(leg.year)) : t('jr.hud', { y: play.year, i: play.i + 1, n: play.legs.length })}</b>
        <small>${escapeHtml(leg.from.name)} → ${escapeHtml(leg.to.name)}</small></span>
      ${play.single ? '' : `<button type="button" data-jr="pause" title="${t(play.paused ? 'jr.resume' : 'jr.pause')}">${play.paused
        ? svg('<path fill="currentColor" stroke="none" d="M8 5.5v13l10.5-6.5z"/>')
        : svg('<path d="M9 6v12M15 6v12"/>')}</button>`}
      <button type="button" data-jr="stop" title="${t('jr.stop')}">${svg('<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none"/>')}</button>`;
  }

  // 到站邮戳：放在离视野中心最近的那个世界副本上，和交通工具对齐
  function stamp(station, leg) {
    const [lat, lng] = toMapAt(station.lat, station.lng, 0);
    const k = Math.round((map.getCenter().lng - lng) / 360);
    L.marker(L.latLng(lat, lng + k * 360), {
      interactive: false, zIndexOffset: 900,
      icon: L.divIcon({ className: 'jr-anchor', iconSize: [0, 0], iconAnchor: [0, 0],
        html: `<span class="jr-stamp jr-stamp-${leg.mode}"><b>${escapeHtml(station.name)}</b><time>${fmtDate(station.first)}</time></span>` }),
    }).addTo(playLayer);
  }

  function runLeg() {
    const leg = play.legs[play.i];
    const g = geometry(leg);
    const k = nearestCopy(g.latlngs);
    const lls = shift(g.latlngs, k);
    const trail = routeLines({ latlngs: [] }, leg.mode, 0, { opacity: 1, weight: STYLE[leg.mode].weight + 1 });
    trail.forEach(l => l.addTo(playLayer));
    const vehicle = L.marker(lls[0], {
      interactive: false, zIndexOffset: 1000,
      icon: L.divIcon({ className: 'jr-anchor', iconSize: [40, 40], iconAnchor: [20, 20], html: vehicleHtml(leg.mode, 0, 'moving') }),
    }).addTo(playLayer);
    const el = () => vehicle.getElement()?.querySelector('.jr-vehicle');
    // 每段 2.6–5.5 秒，越远越久
    const dur = Math.max(2600, Math.min(5500, 2300 + leg.km * .2));
    Object.assign(play, { elapsed: 0, last: performance.now(), leg, g, k, trail, vehicle, dur });
    renderHud();

    const frame = now => {
      if (!play || play.leg !== leg) return;
      if (!play.paused) play.elapsed += now - play.last;
      play.last = now;
      const f = Math.min(1, play.elapsed / dur);
      const pos = at(g, ease(f));
      const ll = L.latLng(pos.latlng.lat, pos.latlng.lng + k * 360);
      vehicle.setLatLng(ll);
      const v = el();
      if (v) {
        if (leg.mode === 'plane') v.style.setProperty('--rot', `${pos.angle}deg`);
        else if (leg.mode !== 'train') v.style.setProperty('--flip', Math.abs(pos.angle) > 90 ? -1 : 1);
      }
      const done = lls.slice(0, pos.i).concat([ll]);
      trail.forEach(l => l.setLatLngs(done));
      if (f < 1) { play.raf = requestAnimationFrame(frame); return; }
      playLayer.removeLayer(vehicle);
      stamp(leg.to, leg);
      play.timer = setTimeout(nextLeg, 1300); // 到站后停一下，让邮戳看清楚
    };
    play.raf = requestAnimationFrame(frame);
  }

  function nextLeg() {
    if (!play) return;
    play.i++;
    if (play.i < play.legs.length) return runLeg();
    if (play.single) { play.timer = setTimeout(stop, 2200); return; }
    // 一年跑完：停 2 秒，从头再来
    play.timer = setTimeout(() => {
      if (!play) return;
      playLayer.clearLayers();
      play.i = 0;
      runLeg();
    }, 2500);
  }

  function start(list, opts = {}) {
    stop();
    if (!list.length) return;
    play = { legs: list, i: 0, year: opts.year, single: !!opts.single, paused: false };
    document.body.classList.add('jr-playing');
    if (!opts.single) stamp(list[0].from, list[0]);
    runLeg();
  }

  function stop() {
    if (!play) return;
    cancelAnimationFrame(play.raf);
    clearTimeout(play.timer);
    play = null;
    playLayer.clearLayers();
    document.body.classList.remove('jr-playing');
    renderHud();
    renderPanel();
  }

  function togglePause() {
    if (!play) return;
    play.paused = !play.paused;
    play.last = performance.now();
    renderHud();
  }

  hud.addEventListener('click', e => {
    const b = e.target.closest('[data-jr]');
    if (!b) return;
    if (b.dataset.jr === 'pause') togglePause();
    else stop();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && play && !e.defaultPrevented && document.querySelector('#editor')?.hidden !== false) stop();
  });

  // ---------- 地图右上角：旅程按钮 + 年份小面板 ----------
  let panelOpen = false;
  const control = new (L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const box = L.DomUtil.create('div', 'jr-control');
      box.innerHTML = `<button type="button" class="leaflet-bar map-btn jr-button" aria-expanded="false">${svg(ROUTE_ICON)}<span>${t('jr.button')}</span></button>
        <div class="jr-panel" hidden></div>`;
      L.DomEvent.disableClickPropagation(box);
      L.DomEvent.disableScrollPropagation(box);
      box.addEventListener('click', onPanelClick);
      box.addEventListener('change', e => {
        if (e.target.id !== 'jrShow') return;
        show = e.target.checked;
        store.set('show', show ? '1' : '0');
        draw();
      });
      return box;
    },
  }))().addTo(map);
  const panel = () => control.getContainer().querySelector('.jr-panel');

  function renderPanel() {
    const box = panel();
    if (!box) return;
    control.getContainer().querySelector('.jr-button').setAttribute('aria-expanded', panelOpen);
    box.hidden = !panelOpen;
    if (!panelOpen) return;
    const years = [...new Set(legs.map(l => l.year))].sort();
    if (!legs.length) {
      box.innerHTML = `<p class="jr-head"><b>${t('jr.title')}</b>${lang === 'zh' ? '<span>Journeys</span>' : ''}</p><p class="jr-empty">${t('jr.empty')}</p>`;
      return;
    }
    const list = legsOf(year);
    const stops = new Set(list.flatMap(l => [l.from.key, l.to.key])).size;
    const km = Math.round(list.reduce((n, l) => n + l.km, 0)).toLocaleString();
    box.innerHTML = `
      <p class="jr-head"><b>${t('jr.title')}</b>${lang === 'zh' ? '<span>Journeys</span>' : ''}</p>
      <div class="jr-years" role="radiogroup">${years.map(y => `<button type="button" role="radio" data-year="${y}" aria-checked="${y === year}">${y}</button>`).join('')}</div>
      ${list.length ? `<p class="jr-stats">${t('jr.stats', { s: stops, l: list.length, km })}</p>
        <ol class="jr-legs">${list.map(l => `<li>${svg(VEHICLE[l.mode], 'jr-ic')}<span>${escapeHtml(l.from.name)} → ${escapeHtml(l.to.name)}</span><time>${fmtDate(l.to.first).slice(5)}</time></li>`).join('')}</ol>`
      : `<p class="jr-empty">${t('jr.emptyYear')}</p>`}
      <label class="me-switch jr-toggle"><span><b>${t('jr.showLines')}</b><small>${t('jr.tip')}</small></span>
        <input type="checkbox" id="jrShow" ${show ? 'checked' : ''} /><i aria-hidden="true"></i></label>
      <button type="button" class="jr-play" data-jr-play ${list.length ? '' : 'disabled'}>${play && !play.single
        ? `${svg('<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none"/>')}${t('jr.stop')}`
        : `${svg('<path fill="currentColor" stroke="none" d="M8 5.5v13l10.5-6.5z"/>')}${t('jr.play', { y: year })}`}</button>`;
  }

  function onPanelClick(e) {
    if (e.target.closest('.jr-button')) { panelOpen = !panelOpen; return renderPanel(); }
    const y = e.target.closest('[data-year]');
    if (y) {
      year = Number(y.dataset.year);
      store.set('year', year);
      if (play && !play.single) stop();
      draw();
      return renderPanel();
    }
    if (e.target.closest('[data-jr-play]')) {
      if (play && !play.single) return stop();
      if (!show) { show = true; store.set('show', '1'); draw(); }
      start(legsOf(year), { year });
      renderPanel();
    }
  }
  document.addEventListener('click', e => {
    if (panelOpen && !e.target.closest('.jr-control')) { panelOpen = false; renderPanel(); }
  });

  map.on('zoomend', draw);

  // ---------- 对外 ----------
  function refresh() {
    compute();
    draw();
    renderPanel();
  }

  // 关上明信片后：这次打卡开启了新的一站、且是最新日期 → 从上一站飞过来一次
  function afterEdit(id) {
    const last = legs.at(-1);
    if (!last || last.to.arrival.id !== id || play) return;
    const r = last.to.arrival;
    if (Date.now() - (r.createdAt || 0) > 6 * 3600_000) return; // 只给新打卡播
    const played = new Set(store.get('played', '').split(',').filter(Boolean));
    if (played.has(id)) return;
    played.add(id);
    store.set('played', [...played].slice(-50).join(','));
    start([last], { single: true });
  }

  refresh();
  return { refresh, afterEdit, stop };
}
