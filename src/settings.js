// 设置：语言、主题色（跟着账号存在 profile_private），以及「数据」——
// 按年份 + 国家 / 地区 / 城市 / 景点 勾选照片，打包成 zip 下载
import { zip } from 'fflate';
import { supabase } from './supabase.js';
import { t, lang, langSwitch, beforeLangChange } from './i18n.js';
import { initTimezone } from './limits.js';

const THEME_KEY = 'mymap:theme';
export const THEMES = ['airmail', 'coast', 'forest', 'darkroom', 'night'];
const BUCKET = 'photos';

const $ = sel => document.querySelector(sel);
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- 主题 ----------
// 页面最早由 index.html 里的内联脚本按本机缓存设好 data-theme，这里负责之后的切换
export const currentTheme = () => (THEMES.includes(document.documentElement.dataset.theme) ? document.documentElement.dataset.theme : 'airmail');

function applyTheme(id) {
  document.documentElement.dataset.theme = id;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim();
  try { localStorage.setItem(THEME_KEY, id); } catch { /* 隐私模式 */ }
}

// ---------- 跟着账号走 ----------
let uid = null;

async function saveToAccount(fields) {
  if (!uid) return;
  const { error } = await supabase.from('profile_private').upsert({ id: uid, ...fields });
  if (error) console.warn('保存设置失败', error);
}
beforeLangChange.push(next => saveToAccount({ lang: next }));

// 登录后用账号里的设置覆盖本机；语言不同时要整页刷新，返回 true 表示即将刷新
export function applyAccountSettings(userId, priv) {
  uid = userId;
  initTimezone(userId, priv);
  if (priv?.theme && priv.theme !== currentTheme()) applyTheme(priv.theme);
  if (priv?.lang && priv.lang !== lang) {
    try { localStorage.setItem('mymap:lang', priv.lang); } catch { return false; }
    location.reload();
    return true;
  }
  return false;
}

// ---------- 设置面板 ----------
let data = null; // 地图就绪后由 initSettings 提供：{ records, pathOf }
let tab = 'main';

const sheet = () => $('#settings');

export function openSettings(view = 'main') {
  tab = view;
  sheet().hidden = false;
  render();
}

function closeSettings() {
  sheet().hidden = true;
}

function render() {
  const body = $('#settingsBody');
  $('#settings').dataset.view = tab;
  $('#settingsTitle').textContent = t(tab === 'photos' ? 'st.photosTitle' : 'st.title');
  $('#settingsBack').hidden = tab === 'main';
  $('#settingsLegal').href = `${import.meta.env.BASE_URL}legal.html?lang=${lang}`;
  // 导出 / 导入备份的按钮写在 index.html 里（main.js 按 id 绑定事件）：重绘前先挪出来，免得被 innerHTML 一起销毁
  const backup = $('#settingsBackup');
  sheet().querySelector('.st-paper').append(backup);
  backup.hidden = tab !== 'main';
  if (tab === 'photos') return renderPhotos(body);
  body.innerHTML = `
    <section class="st-group">
      <h3>${t('st.language')}</h3>
      ${langSwitch('st-lang')}
    </section>
    <section class="st-group">
      <h3>${t('st.theme')}</h3>
      <div class="st-themes" role="radiogroup" aria-label="${t('st.theme')}">
        ${THEMES.map(id => `<button type="button" role="radio" class="st-theme" data-theme="${id}" data-set-theme="${id}" aria-checked="${id === currentTheme()}">
          <span class="st-swatch" aria-hidden="true"><i></i></span>
          <b>${t(`theme.${id}`)}</b><small>${t(`theme.${id}.sub`)}</small>
        </button>`).join('')}
      </div>
    </section>
    <section class="st-group">
      <h3>${t('st.data')}</h3>
      <button type="button" class="st-row" data-st-photos ${data ? '' : 'disabled'}>
        <span><b>${t('st.photos')}</b><small>${t('st.photosSub')}</small></span><i aria-hidden="true">›</i>
      </button>
    </section>`;
  // 备份按钮放在「数据」一组的末尾
  body.querySelector('.st-group:last-child').append(backup);
}

// ---------- 下载照片 ----------
let year = null;          // 选中的年份：'2026' | 'all' | 'none'
let selected = new Set(); // 选中的打卡 id
let busy = false;

const yearOf = r => (r.date ? r.date.slice(0, 4) : 'none');
const withPhotos = () => data.records().filter(r => !r.deleted && r.photos?.length);
const inYear = r => year === 'all' || yearOf(r) === year;

function years() {
  const set = new Set(withPhotos().map(yearOf));
  const list = [...set].filter(y => y !== 'none').sort((a, b) => b.localeCompare(a));
  return [...list, ...(set.has('none') ? ['none'] : []), 'all'];
}

// 国家 / 地区 / 城市 / 景点 的树；打卡挂在它自己那一级的节点上（例如城市级打卡挂在城市节点）
function buildTree() {
  const root = { key: '', children: new Map(), records: [] };
  for (const r of withPhotos().filter(inYear)) {
    const segs = [...data.pathOf(r)];
    if (r.level === 'place') segs.push({ level: 'place', id: r.id, name: r.name || t('unnamed') });
    let node = root;
    for (const s of segs) {
      const key = `${node.key}/${s.level}:${s.id}`;
      if (!node.children.has(key)) node.children.set(key, { key, name: s.name, level: s.level, children: new Map(), records: [] });
      node = node.children.get(key);
    }
    node.records.push(r);
  }
  return root;
}

const allRecords = node => [...node.records, ...[...node.children.values()].flatMap(allRecords)];
const photoCount = list => list.reduce((n, r) => n + r.photos.length, 0);
const sortNodes = node => [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name, lang === 'zh' ? 'zh-CN' : 'en'));

function nodeHtml(node, depth) {
  const recs = allRecords(node);
  const n = recs.filter(r => selected.has(r.id)).length;
  const state = n === 0 ? 'none' : n === recs.length ? 'all' : 'some';
  const kids = sortNodes(node);
  const label = `<label class="st-node" data-level="${node.level}">
      <input type="checkbox" data-node="${escapeHtml(node.key)}" ${state === 'all' ? 'checked' : ''} ${state === 'some' ? 'data-some' : ''} />
      <span>${escapeHtml(node.name)}</span><em>${t('st.nPhotos', { n: photoCount(recs) })}</em>
    </label>`;
  if (!kids.length) return `<li>${label}</li>`;
  return `<li><details ${depth === 0 && state === 'some' ? 'open' : ''}><summary>${label}</summary>
    <ul>${kids.map(k => nodeHtml(k, depth + 1)).join('')}</ul></details></li>`;
}

function findNode(node, key) {
  if (node.key === key) return node;
  for (const c of node.children.values()) {
    const hit = key.startsWith(c.key) && findNode(c, key);
    if (hit) return hit;
  }
  return null;
}

function renderPhotos(body) {
  const ys = years();
  if (!ys.includes(year)) year = ys.includes(String(new Date().getFullYear())) ? String(new Date().getFullYear()) : ys[0];
  const tree = buildTree();
  const recs = allRecords(tree);
  const picked = recs.filter(r => selected.has(r.id));
  const open = new Set([...body.querySelectorAll('details[open]')].map(d => d.querySelector('[data-node]')?.dataset.node));
  body.innerHTML = `
    <p class="st-note">${t('st.photosNote')}</p>
    <nav class="st-years" role="tablist">
      ${ys.map(y => `<button type="button" role="tab" data-year="${y}" aria-selected="${y === year}">${y === 'all' ? t('st.allYears') : y === 'none' ? t('st.noDate') : y}</button>`).join('')}
    </nav>
    ${recs.length ? `
      <label class="st-node st-all">
        <input type="checkbox" data-node="" ${picked.length === recs.length ? 'checked' : ''} ${picked.length && picked.length < recs.length ? 'data-some' : ''} />
        <span>${t('st.selectAll')}</span><em>${t('st.nPhotos', { n: photoCount(recs) })}</em>
      </label>
      <ul class="st-tree">${sortNodes(tree).map(n => nodeHtml(n, 0)).join('')}</ul>`
    : `<p class="st-empty">${t('st.noPhotos')}</p>`}
    <footer class="st-foot">
      <span class="st-progress" role="status">${t('st.picked', { n: photoCount(picked), m: picked.length })}</span>
      <button type="button" class="st-download" data-st-download ${picked.length && !busy ? '' : 'disabled'}>${t('st.download')}</button>
    </footer>`;
  for (const d of body.querySelectorAll('details')) if (open.has(d.querySelector('[data-node]')?.dataset.node)) d.open = true;
  for (const c of body.querySelectorAll('[data-some]')) c.indeterminate = true;
}

// 文件夹和文件名里不能出现的字符
const safe = s => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || '_';

async function photoBlob(p) {
  if (p.blob) return p.blob;
  const { data: blob, error } = await supabase.storage.from(BUCKET).download(`${uid}/${p.id}.jpg`);
  if (error) throw error;
  return blob;
}

async function download() {
  const tree = buildTree();
  const recs = allRecords(tree).filter(r => selected.has(r.id));
  if (!recs.length || busy) return;
  busy = true;
  const status = $('#settingsBody .st-progress');
  const button = $('#settingsBody [data-st-download]');
  button.disabled = true;
  const total = photoCount(recs);
  const yearDir = year === 'all' ? null : year === 'none' ? safe(t('st.noDate')) : year;
  const files = {};
  const notes = new Map(); // 文件夹 → 记录.txt 的内容
  const used = new Map();  // 文件夹 → 已用的文件名，避免同名覆盖
  let done = 0;
  try {
    const jobs = recs.flatMap(r => r.photos.map((p, i) => ({ r, p, i })));
    const folderOf = r => {
      const segs = data.pathOf(r).map(s => safe(s.name));
      if (r.level === 'place') segs.push(safe(r.name || t('unnamed')));
      return [yearDir ?? (r.date ? r.date.slice(0, 4) : safe(t('st.noDate'))), ...segs].join('/');
    };
    for (const r of recs) {
      const dir = folderOf(r);
      const text = [
        `${r.name || data.pathOf(r).map(s => s.name).join(' / ')}`,
        `${t('st.txtPlace')}: ${data.pathOf(r).map(s => s.name).join(' / ')}`,
        `${t('st.txtDate')}: ${r.date || '-'}`,
        r.note ? `\n${r.note}` : '',
      ].join('\n').trim();
      notes.set(dir, notes.has(dir) ? `${notes.get(dir)}\n\n----\n\n${text}` : text);
    }
    // 同时最多下载 4 张
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const { r, p, i } = jobs[next++];
        const dir = folderOf(r);
        const names = used.get(dir) || new Set();
        used.set(dir, names);
        let name = `${r.date || t('st.noDate')}_${String(i + 1).padStart(2, '0')}.jpg`;
        for (let k = 2; names.has(name); k++) name = `${r.date || t('st.noDate')}_${String(i + 1).padStart(2, '0')}-${k}.jpg`;
        names.add(name);
        files[`${dir}/${safe(name)}`] = [new Uint8Array(await (await photoBlob(p)).arrayBuffer()), { level: 0 }];
        status.textContent = t('st.fetching', { n: ++done, m: total });
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker));
    const enc = new TextEncoder();
    for (const [dir, text] of notes) files[`${dir}/${t('st.txtName')}`] = enc.encode(`${text}\n`);
    status.textContent = t('st.zipping');
    const out = await new Promise((resolve, reject) => zip(files, { level: 0 }, (err, res) => (err ? reject(err) : resolve(res))));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([out], { type: 'application/zip' }));
    a.download = `Dear-Elsewhere-${year === 'all' ? t('st.allYears') : yearDir}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    status.textContent = t('st.done', { n: total });
  } catch (err) {
    console.warn('下载照片失败', err);
    status.textContent = t('st.failed', { msg: err.message || err });
  } finally {
    busy = false;
    button.disabled = false;
  }
}

// ---------- 事件 ----------
document.addEventListener('click', e => {
  if (e.target.closest('[data-open-settings]')) return openSettings();
  if (sheet()?.hidden !== false) return;
  if (e.target.closest('[data-st-close]') || e.target === sheet()) return closeSettings();
  if (e.target.closest('#settingsBack')) { tab = 'main'; return render(); }
  const th = e.target.closest('[data-set-theme]');
  if (th) {
    applyTheme(th.dataset.setTheme);
    saveToAccount({ theme: th.dataset.setTheme });
    for (const b of document.querySelectorAll('[data-set-theme]')) b.setAttribute('aria-checked', b === th);
    return;
  }
  if (e.target.closest('[data-st-photos]')) { tab = 'photos'; return render(); }
  const y = e.target.closest('[data-year]');
  if (y) { year = y.dataset.year; return render(); }
  if (e.target.closest('[data-st-download]')) return download();
});

document.addEventListener('change', e => {
  const box = e.target.closest('#settings [data-node]');
  if (!box) return;
  const tree = buildTree();
  const node = box.dataset.node ? findNode(tree, box.dataset.node) : tree;
  for (const r of allRecords(node)) {
    if (box.checked) selected.add(r.id);
    else selected.delete(r.id);
  }
  render();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && sheet()?.hidden === false) closeSettings();
});

// 地图数据就绪后调用：records() 返回当前全部打卡，pathOf(r) 返回国家 / 地区 / 城市
export function initSettings(helpers) {
  data = helpers;
  if (sheet()?.hidden === false) render();
}
