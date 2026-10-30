// 好友、动态与评论
//   · 好友：输入 ID 发申请，对方接受后互为好友；可以撤回、忽略、删除
//   · 动态：带照片、点过「收进足迹」的打卡（自己和好友的），可以评论；
//           同一个人 72 小时内的动态合成一组，可以展开；可以不看某位好友的动态（feed_mutes，见 0015）
//   · 地图：可叠加好友的足迹；有评论的标记上方滚动显示最新评论
//   · 红点：新的好友申请、好友新动态、别人对我的打卡的新评论
// 数据权限见 supabase/migrations/0003_social.sql
import { supabase } from './supabase.js';
import { avatarUrl } from './auth.js';
import { t } from './i18n.js';
import { limitText } from './limits.js';
import { track } from './track.js';

const BUCKET = 'photos';
const URL_TTL = 3600;           // 签名链接有效期（秒）
const FEED_DAYS = 30;           // 动态流读取最近多少天
const GROUP_HOURS = 72;         // 同一个人从第一条起多少小时内的动态合成一组
const RECENT_DAYS = 7;          // 地图上默认显示好友最近多少天去过的地方
const $ = sel => document.querySelector(sel);
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const keyOf = (owner, id) => `${owner}/${id}`;
const fmtDate = d => (d || '').replaceAll('-', '.');

export function ago(at) {
  const s = (Date.now() - Date.parse(at)) / 1000;
  if (s < 60) return t('ago.now');
  if (s < 3600) return t('ago.min', { n: Math.floor(s / 60) });
  if (s < 86400) return t('ago.hour', { n: Math.floor(s / 3600) });
  if (s < 86400 * 7) return t('ago.day', { n: Math.floor(s / 86400) });
  return new Date(at).toISOString().slice(0, 10).replaceAll('-', '.');
}

const ICON = {
  users: '<circle cx="9" cy="8.5" r="3.2" /><path d="M3.5 19.5c.6-3.3 2.8-5 5.5-5s4.9 1.7 5.5 5" /><path d="M15.5 5.6a3.2 3.2 0 0 1 0 5.8M17.5 14.8c1.6.6 2.7 2.2 3 4.7" />',
  pin: '<path d="M12 21s-6.5-6.1-6.5-11a6.5 6.5 0 0 1 13 0c0 4.9-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  send: '<path d="M4 12l16-7-6 16-3-7z"/><path d="M11 14l9-9"/>',
  feed: '<rect x="4" y="5" width="16" height="14" rx="1.5" /><path d="M4 9.5h16M8 13h5M8 16h8" />',
  bubble: '<path d="M5 6.5h14v9H10l-4 3.5v-3.5H5z"/>',
  mute: '<path d="M6 9.5h2.5L13 5.5v13l-4.5-4H6z"/><path d="M16.5 9.5l4 5M20.5 9.5l-4 5"/>',
  chat: '<path d="M4.5 6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H11l-4.5 3.5v-3.5h0a2 2 0 0 1-2-2z"/><path d="M8.5 10.5h.01M12 10.5h.01M15.5 10.5h.01"/>',
};
const icon = name => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;

// me: { id, profile }；helpers 由地图提供：
//   placeText(row) 行政区路径；flyTo(row) 飞到这条打卡；openDrop(name) 打开顶栏面板；
//   showPhoto(url) 大图；onChange() 好友标记或评论变化后重绘地图；myRecords() 自己的本地记录；
//   chatUnread(id?) 未读私信数（不传 id 为总数）
export function initSocial({ me, helpers }) {
  const seenKey = name => `mymap:${me.id}:${name}`;
  const state = {
    profiles: new Map([[me.id, me.profile]]),
    friends: [],       // 已接受：[{ profile, since }]
    incoming: [],      // 别人发给我的申请
    outgoing: [],      // 我发出、对方还没处理的申请
    posts: [],         // 动态（自己 + 好友），按发布时间倒序
    pins: [],          // 好友在地图上的打卡
    comments: new Map(), // key -> [评论]，按时间正序
    overlay: localStorage.getItem(seenKey('overlay')) !== '0',
    only: null,        // 只看某一位好友
    feedSeen: Number(localStorage.getItem(seenKey('feedSeen'))) || Date.now(),
    commentsSeen: Number(localStorage.getItem(seenKey('commentsSeen'))) || Date.now(),
    lookup: null,      // 按 ID 查到的人
    expanded: new Set(), // 展开全部评论的动态
    openGroups: new Set(), // 展开的动态组
    muted: new Set(),  // 不看动态的好友（feed_mutes）
  };
  localStorage.setItem(seenKey('feedSeen'), state.feedSeen);
  localStorage.setItem(seenKey('commentsSeen'), state.commentsSeen);

  // ---------- 照片签名链接（私有存储） ----------
  const signed = new Map(); // path -> { url, until }
  async function sign(paths) {
    const now = Date.now();
    const need = [...new Set(paths)].filter(p => !(signed.get(p)?.until > now + 60_000));
    if (!need.length) return;
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(need, URL_TTL);
    if (error) return console.warn('照片链接获取失败', error);
    for (const d of data) if (d.signedUrl) signed.set(d.path, { url: d.signedUrl, until: now + URL_TTL * 1000 });
  }
  const thumbUrl = (owner, pid) => signed.get(`${owner}/${pid}_t.jpg`)?.url || '';
  async function fullUrl(owner, pid) {
    const path = `${owner}/${pid}.jpg`;
    await sign([path]);
    return signed.get(path)?.url;
  }

  // ---------- 读取 ----------
  async function profilesFor(ids) {
    const missing = [...new Set(ids)].filter(id => !state.profiles.has(id));
    if (!missing.length) return;
    const { data } = await supabase.from('profiles').select('id, handle, name, country, avatar').in('id', missing);
    for (const p of data || []) state.profiles.set(p.id, p);
  }

  let loading = null, reloadAgain = false;
  async function load() {
    if (loading) { reloadAgain = true; return loading; }
    loading = (async () => {
      const cols = 'user_id, id, level, name, label, marker, icon, date, note, lat, lng, country, region, city, photos, published_at';
      const [fr, posts, pins, comments] = await Promise.all([
        supabase.from('friendships').select('*'),
        // 最近 30 天的动态，前端再按 72 小时分组；高产的好友也挤不掉别人
        supabase.from('checkins').select(cols).not('published_at', 'is', null).eq('deleted', false)
          .gte('published_at', new Date(Date.now() - FEED_DAYS * 864e5).toISOString())
          .order('published_at', { ascending: false }).limit(300),
        supabase.from('checkins').select(cols).neq('user_id', me.id).eq('deleted', false).not('lat', 'is', null).limit(2000),
        supabase.from('comments').select('*').order('created_at', { ascending: false }).limit(500),
      ]);
      for (const r of [fr, posts, pins, comments]) if (r.error) throw r.error;
      // 静音列表：还没执行 0015 时没有这张表，当作没静音任何人
      const mutes = await supabase.from('feed_mutes').select('muted');
      state.muted = new Set(mutes.error ? [] : mutes.data.map(m => m.muted));

      const rows = fr.data;
      const other = f => (f.requester === me.id ? f.addressee : f.requester);
      await profilesFor([...rows.map(other), ...comments.data.map(c => c.author), ...posts.data.map(p => p.user_id)]);
      state.friends = rows.filter(f => f.status === 'accepted').map(f => ({ profile: state.profiles.get(other(f)), since: f.accepted_at }))
        .filter(f => f.profile).sort((a, b) => a.profile.name.localeCompare(b.profile.name));
      state.incoming = rows.filter(f => f.status === 'pending' && f.addressee === me.id).map(f => ({ profile: state.profiles.get(f.requester), at: f.created_at })).filter(f => f.profile);
      state.outgoing = rows.filter(f => f.status === 'pending' && f.requester === me.id).map(f => ({ profile: state.profiles.get(f.addressee), at: f.created_at })).filter(f => f.profile);

      state.posts = posts.data.filter(p => p.photos.length && !state.muted.has(p.user_id));
      state.pins = pins.data;
      state.comments = new Map();
      for (const c of [...comments.data].reverse()) {
        const k = keyOf(c.checkin_owner, c.checkin_id);
        if (!state.comments.has(k)) state.comments.set(k, []);
        state.comments.get(k).push(c);
      }
      // 只给动态签发照片链接；好友公开地图里未发布的打卡不显示照片
      await sign([...state.posts, ...state.pins.filter(p => p.published_at)].flatMap(p => p.photos.slice(0, 3).map(ph => `${p.user_id}/${ph.id}_t.jpg`)));
      if (state.only && !state.friends.some(f => f.profile.id === state.only)) state.only = null;
      render();
      helpers.onChange();
    })().catch(err => console.warn('读取好友动态失败', err)).finally(() => {
      loading = null;
      if (reloadAgain) { reloadAgain = false; load(); }
    });
    return loading;
  }

  // 实时：好友关系、评论、打卡有变化就重新读取（短时间内多次变化合并成一次）
  let reloadTimer;
  const soon = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(load, 600); };
  supabase.channel('social')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' }, soon)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'comments' }, soon)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'checkins' }, e => {
      if (e.new?.user_id === me.id && !e.new?.published_at) return; // 自己未发布的修改与动态无关
      soon();
    })
    .subscribe();
  // 实时连接断开时的兜底
  setInterval(() => document.visibilityState === 'visible' && load(), 90_000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && soon());

  // ---------- 渲染 ----------
  const avatarImg = (p, cls = 'avatar') => `<span class="${cls}"><img src="${avatarUrl(p?.avatar || 'a01')}" alt="" /></span>`;
  const countryText = id => helpers.countryName(id) || '';

  function render() {
    renderFriends();
    renderFeed();
    renderInbox();
    renderDots();
  }

  function personRow(p, actions, sub = '') {
    return `<li class="person" data-person="${p.id}">
      ${avatarImg(p)}
      <span class="person-text"><b>${escapeHtml(p.name)}</b><small>@${escapeHtml(p.handle)}${sub}</small></span>
      <span class="person-acts">${actions}</span>
    </li>`;
  }

  function lookupCard() {
    const l = state.lookup;
    if (!l) return '';
    if (l.error) return `<p class="fr-msg">${escapeHtml(l.error)}</p>`;
    const p = l.profile;
    const rel = p.id === me.id ? ['', t('fr.self')]
      : state.friends.some(f => f.profile.id === p.id) ? ['', t('fr.already')]
      : state.outgoing.some(f => f.profile.id === p.id) ? ['', t('fr.pending')]
      : state.incoming.some(f => f.profile.id === p.id) ? [`<button class="fr-btn fr-primary" data-accept>${t('fr.acceptTheirs')}</button>`, '']
      : [`<button class="fr-btn fr-primary" data-request>${t('fr.request')}</button>`, ''];
    return `<div class="fr-found" data-person="${p.id}">
      ${avatarImg(p, 'avatar avatar-md')}
      <span class="person-text"><b>${escapeHtml(p.name)}</b><small>@${escapeHtml(p.handle)}${p.country ? ` · ${escapeHtml(countryText(p.country))}` : ''}</small>
        ${rel[1] ? `<em>${rel[1]}</em>` : ''}</span>
      ${rel[0]}
    </div>`;
  }

  const chatBadge = id => {
    const n = helpers.chatUnread?.(id) || 0;
    return n ? `<i class="fr-unread">${n > 99 ? '99+' : n}</i>` : '';
  };

  function renderFriends() {
    const box = $('#drop-friends');
    const keepInput = box.querySelector('#friendHandle')?.value || '';
    const focused = document.activeElement?.id === 'friendHandle';
    const pinsOf = id => state.pins.filter(p => p.user_id === id).length;
    box.innerHTML = `
      <p class="drop-head"><b>${t('friends')}</b><span>Friends</span></p>
      <div class="drop-scroll">
        <form class="fr-add" autocomplete="off">
          <label class="fr-input"><b>@</b><input id="friendHandle" maxlength="20" spellcheck="false" placeholder="${t('fr.handlePh')}" value="${escapeHtml(keepInput)}" /></label>
          <button class="fr-btn" type="submit">${t('fr.find')}</button>
        </form>
        ${lookupCard()}

        <label class="me-switch fr-overlay">
          <span><b>${t('fr.overlay')}</b><small>${state.only ? `${t('fr.onlyOne', { name: escapeHtml(state.profiles.get(state.only)?.name) })} · <a href="#" data-only-all>${t('fr.showAll')}</a>` : t('fr.overlaySub')}</small></span>
          <input type="checkbox" id="overlayToggle" ${state.overlay ? 'checked' : ''} /><i aria-hidden="true"></i>
        </label>

        ${state.incoming.length ? `<p class="fr-title"><span>${t('fr.requests')}</span><i class="fr-count">${state.incoming.length}</i></p>
          <ul class="people">${state.incoming.map(f => personRow(f.profile,
            `<button class="fr-btn fr-primary" data-accept>${t('fr.accept')}</button><button class="fr-btn" data-decline>${t('fr.ignore')}</button>`, ` · ${ago(f.at)}`)).join('')}</ul>` : ''}

        ${state.outgoing.length ? `<p class="fr-title"><span>${t('fr.waiting')}</span><i>${state.outgoing.length}</i></p>
          <ul class="people">${state.outgoing.map(f => personRow(f.profile, `<button class="fr-btn" data-withdraw>${t('fr.withdraw')}</button>`)).join('')}</ul>` : ''}

        ${helpers.groupsHtml?.() || ''}

        <p class="fr-title"><span>${t('fr.mine')}</span><i>${state.friends.length}</i></p>
        ${state.friends.length ? `<ul class="people">${state.friends.map(f => personRow(f.profile,
          `<button class="fr-btn fr-icon fr-chat" data-chat title="${t('chat.open')}">${icon('chat')}${chatBadge(f.profile.id)}</button>
           ${pinsOf(f.profile.id) ? `<button class="fr-btn fr-icon" data-only title="${t('fr.onlyTitle')}">${icon('pin')}</button>` : ''}
           <button class="fr-btn fr-icon${state.muted.has(f.profile.id) ? ' fr-muted' : ''}" data-toggle-mute aria-pressed="${state.muted.has(f.profile.id)}"
             title="${t(state.muted.has(f.profile.id) ? 'fr.unmuteTitle' : 'fr.muteTitle')}">${icon('mute')}</button>
           <button class="fr-btn fr-more" data-unfriend title="${t('fr.removeTitle')}">${t('fr.remove')}</button>`,
          state.muted.has(f.profile.id) ? ` · ${t('fr.muted')}` : '')).join('')}</ul>`
        : `<div class="empty-card">${icon('users')}<b>${t('fr.none')}</b><span>${t('fr.noneSub')}</span></div>`}
      </div>`;
    if (focused) { const i = box.querySelector('#friendHandle'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
  }

  function photoStack(p) {
    return p.photos.slice(0, 3).map((ph, i) => `<img class="p${i + 1}" src="${thumbUrl(p.user_id, ph.id)}" data-full="${p.user_id}|${ph.id}" alt="" loading="lazy" />`).reverse().join('');
  }

  function commentList(k, owner) {
    const list = state.comments.get(k) || [];
    const all = state.expanded.has(k);
    const shown = all ? list : list.slice(-3);
    return `${list.length > 3 && !all ? `<button class="post-more" data-expand>${t('feed.more', { n: list.length })}</button>` : ''}
      <ul class="post-comments">${shown.map(c => {
        const a = state.profiles.get(c.author);
        const canDel = c.author === me.id || owner === me.id;
        return `<li data-comment="${c.id}"><img src="${avatarUrl(a?.avatar || 'a01')}" alt="" />
          <p><b>${escapeHtml(a?.name || t('feed.friend'))}</b>${escapeHtml(c.body)}<time>${ago(c.created_at)}</time></p>
          ${canDel ? `<button class="post-del" data-del-comment title="${t('feed.deleteComment')}">×</button>` : ''}</li>`;
      }).join('')}</ul>`;
  }

  // ---------- 动态分组：同一个人从第一条起 72 小时内的动态合成一组 ----------
  // 组按最新一条的时间排序；组内按时间正序，读起来像一段行程
  function feedGroups() {
    const byUser = new Map();
    for (const p of [...state.posts].sort((a, b) => Date.parse(a.published_at) - Date.parse(b.published_at))) {
      if (!byUser.has(p.user_id)) byUser.set(p.user_id, []);
      const list = byUser.get(p.user_id);
      const last = list[list.length - 1];
      if (last && Date.parse(p.published_at) - Date.parse(last[0].published_at) < GROUP_HOURS * 3600e3) last.push(p);
      else list.push([p]);
    }
    return [...byUser.values()].flat()
      .map(posts => ({ key: keyOf(posts[0].user_id, posts[0].id), user: posts[0].user_id, posts, latest: posts[posts.length - 1] }))
      .sort((a, b) => Date.parse(b.latest.published_at) - Date.parse(a.latest.published_at));
  }
  const isFresh = p => p.user_id !== me.id && Date.parse(p.published_at) > state.feedSeen;
  const titleOf = p => (p.label || '').trim() || p.name || t('unnamed');

  function postHead(p, fresh, extra = '') {
    const a = state.profiles.get(p.user_id);
    const mine = p.user_id === me.id;
    return `<header>${avatarImg(a)}<span class="person-text"><b>${escapeHtml(mine ? t('feed.me') : a?.name)}</b><small>@${escapeHtml(a?.handle)} · ${ago(p.published_at)}</small></span>
      ${extra}${mine ? '' : `<button class="post-fly post-mute" data-mute title="${t('feed.mute')}">${icon('mute')}</button>`}</header>`;
  }

  function postCard(p) {
    return `<div class="post-card">
      <button class="post-photos" data-photo title="${t('feed.photo')}"><span class="post-stack n${Math.min(3, p.photos.length)}">${photoStack(p)}</span></button>
      <div class="post-text">
        <b>${escapeHtml(titleOf(p))}</b>
        <small>${escapeHtml(helpers.placeText(p))}</small>
        ${p.note ? `<p>${escapeHtml(p.note)}</p>` : ''}
        <time>${fmtDate(p.date)}</time>
      </div>
      <button class="post-fly post-fly-in" data-fly title="${t('feed.fly')}">${icon('pin')}</button>
    </div>`;
  }

  // 一条完整的动态（单独一条，或展开的组里的一站）
  function postBody(p, drafts) {
    const k = keyOf(p.user_id, p.id);
    return `${postCard(p)}
      ${commentList(k, p.user_id)}
      <form class="post-reply"><input maxlength="140" placeholder="${t('feed.reply')}" value="${escapeHtml(drafts.get(k) || '')}" />
        <button type="submit" title="${t('feed.send')}">${icon('send')}</button></form>`;
  }

  function groupHtml(g, drafts) {
    const p0 = g.posts[0];
    if (g.posts.length === 1) {
      return `<article class="post${isFresh(p0) ? ' fresh' : ''}" data-post="${keyOf(p0.user_id, p0.id)}" data-user="${p0.user_id}">
        ${postHead(p0, isFresh(p0))}${postBody(p0, drafts)}</article>`;
    }
    const fresh = g.posts.filter(isFresh).length;
    const open = state.openGroups.has(g.key);
    const span = Date.parse(g.latest.published_at) - Date.parse(p0.published_at);
    const days = Math.max(1, Math.ceil(span / 864e5));
    const places = [...new Set(g.posts.map(titleOf))];
    const title = t('feed.groupTitle', { d: days, n: g.posts.length, places: escapeHtml(places.slice(0, 3).join(t('listSep')) + (places.length > 3 ? '…' : '')) });
    const badge = fresh ? `<i class="pg-new">${t('feed.newN', { n: fresh })}</i>` : '';
    const head = postHead(g.latest, fresh, badge);
    const toggle = `<button class="pg-toggle" data-group-toggle aria-expanded="${open}">${open ? t('feed.collapseGroup') : t('feed.expandGroup', { n: g.posts.length })}</button>`;
    if (open) {
      return `<article class="post post-group open${fresh ? ' fresh' : ''}" data-group="${g.key}" data-user="${g.user}">
        ${head}<p class="pg-title">${title}</p>
        <ol class="pg-stops">${g.posts.map(p => `<li class="pg-stop${isFresh(p) ? ' fresh' : ''}" data-post="${keyOf(p.user_id, p.id)}">
          <span class="pg-when">${ago(p.published_at)}</span>${postBody(p, drafts)}</li>`).join('')}</ol>
        ${toggle}</article>`;
    }
    // 收起：最新一条做封面，下面一排其余地点的缩略图
    const others = g.posts.slice(0, -1).reverse();
    const strip = others.slice(0, 6).map(p => `<button class="pg-thumb" data-group-toggle title="${escapeHtml(titleOf(p))}"><img src="${thumbUrl(p.user_id, p.photos[0].id)}" alt="" loading="lazy" /></button>`).join('')
      + (others.length > 6 ? `<span class="pg-thumb pg-more">+${others.length - 6}</span>` : '');
    const comments = g.posts.flatMap(p => state.comments.get(keyOf(p.user_id, p.id)) || []).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    const lastC = comments[comments.length - 1];
    const lastA = lastC && state.profiles.get(lastC.author);
    return `<article class="post post-group${fresh ? ' fresh' : ''}" data-group="${g.key}" data-user="${g.user}">
      ${head}<p class="pg-title">${title}</p>
      <div data-post="${keyOf(g.latest.user_id, g.latest.id)}">${postCard(g.latest)}</div>
      <div class="pg-strip">${strip}</div>
      ${comments.length ? `<p class="pg-comments"><span>${t('feed.groupComments', { n: comments.length })}</span>
        <img src="${avatarUrl(lastA?.avatar || 'a01')}" alt="" /><b>${escapeHtml(lastA?.name || t('feed.friend'))}</b>${escapeHtml(lastC.body)}</p>` : ''}
      ${toggle}</article>`;
  }

  function renderFeed() {
    const box = $('#drop-feed');
    const scroll = box.querySelector('.drop-scroll')?.scrollTop || 0;
    // 正在输入的评论草稿不能因为重绘丢掉
    const drafts = new Map([...box.querySelectorAll('.post-reply input')].map(i => [i.closest('[data-post]').dataset.post, i.value]));
    const active = document.activeElement?.closest?.('#drop-feed [data-post]')?.dataset.post;
    box.innerHTML = `
      <p class="drop-head"><b>${t('feed')}</b><span>${t('feed.subtitle')}</span></p>
      <div class="drop-scroll">${state.posts.length ? feedGroups().map(g => groupHtml(g, drafts)).join('')
        : `<div class="empty-card">${icon('feed')}<b>${t('feed.empty')}</b><span>${t('feed.emptySub')}</span></div>`}
        ${state.muted.size ? `<p class="feed-muted">${t('feed.mutedNote', { n: state.muted.size })}</p>` : ''}</div>`;
    box.querySelector('.drop-scroll').scrollTop = scroll;
    if (active) box.querySelector(`[data-post="${CSS.escape(active)}"] .post-reply input`)?.focus();
  }

  // 头像面板里「收到的评论」
  function inboxItems() {
    const out = [];
    for (const [k, list] of state.comments) {
      if (!k.startsWith(`${me.id}/`)) continue;
      for (const c of list) if (c.author !== me.id) out.push(c);
    }
    return out.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  }

  function renderInbox() {
    const box = $('#meInbox');
    if (!box) return;
    const items = inboxItems().slice(0, 6);
    const title = id => {
      const r = helpers.myRecords().find(x => x.id === id);
      return r ? (r.label || '').trim() || r.name || t('unnamed') : t('me.myPostcard');
    };
    box.innerHTML = items.length ? `<p class="fr-title"><span>${t('me.inbox')}</span></p>
      <ul class="inbox">${items.map(c => {
        const a = state.profiles.get(c.author);
        const fresh = Date.parse(c.created_at) > state.commentsSeen;
        return `<li class="${fresh ? 'fresh' : ''}" data-open-post="${keyOf(c.checkin_owner, c.checkin_id)}">
          <img src="${avatarUrl(a?.avatar || 'a01')}" alt="" />
          <p><b>${escapeHtml(a?.name)}</b> ${t('me.commented', { title: escapeHtml(title(c.checkin_id)) })}<span>${escapeHtml(c.body)}</span></p>
          <time>${ago(c.created_at)}</time></li>`;
      }).join('')}</ul>` : '';
  }

  function renderDots() {
    const unreadFeed = state.posts.some(p => p.user_id !== me.id && Date.parse(p.published_at) > state.feedSeen);
    const unreadComments = inboxItems().some(c => Date.parse(c.created_at) > state.commentsSeen);
    const requests = state.incoming.length > 0 || (helpers.chatUnread?.() || 0) > 0;
    for (const [sel, on] of [['[data-drop="feed"] .tb-dot', unreadFeed], ['[data-drop="friends"] .tb-dot', requests], ['[data-drop="me"] .tb-dot', unreadComments]]) {
      for (const dot of document.querySelectorAll(sel)) dot.hidden = !on;
    }
  }

  function markSeen(name) {
    if (name === 'feed') { state.feedSeen = Date.now(); localStorage.setItem(seenKey('feedSeen'), state.feedSeen); }
    if (name === 'me') { state.commentsSeen = Date.now(); localStorage.setItem(seenKey('commentsSeen'), state.commentsSeen); }
    renderDots();
  }
  // 面板关上时才清掉「新」的高亮，打开期间还能看到哪些是新的
  let lastDrop = null;
  document.addEventListener('drop:change', e => {
    if (lastDrop && lastDrop !== e.detail) markSeen(lastDrop);
    if (e.detail === 'feed' && lastDrop !== 'feed') track('feed_open');
    lastDrop = e.detail;
    if (e.detail === 'feed' || e.detail === 'me') renderDots();
  });
  document.addEventListener('me:render', renderInbox);

  // ---------- 操作 ----------
  async function act(promise) {
    const { error } = await promise;
    if (error) { alert(limitText(error) || t('opFailed', { msg: error.message })); return false; }
    await load();
    return true;
  }
  const between = (a, b) => `and(requester.eq.${a},addressee.eq.${b}),and(requester.eq.${b},addressee.eq.${a})`;

  async function findHandle(raw) {
    const h = raw.trim().replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(h)) { state.lookup = { error: t('fr.badHandle') }; return renderFriends(); }
    const { data, error } = await supabase.from('profiles').select('id, handle, name, country, avatar').eq('handle', h).maybeSingle();
    state.lookup = error ? { error: t('fr.lookupFailed', { msg: error.message }) } : data ? { profile: data } : { error: t('fr.notFound', { h }) };
    if (data) state.profiles.set(data.id, data);
    renderFriends();
  }

  document.addEventListener('submit', async e => {
    if (e.target.matches('#drop-friends .fr-add')) {
      e.preventDefault();
      return findHandle(e.target.querySelector('input').value);
    }
    if (e.target.matches('#drop-feed .post-reply')) {
      e.preventDefault();
      const input = e.target.querySelector('input');
      const body = input.value.trim();
      if (!body) return;
      const [owner, id] = e.target.closest('[data-post]').dataset.post.split('/');
      input.disabled = true;
      const { error } = await supabase.from('comments').insert({ checkin_owner: owner, checkin_id: id, body });
      input.disabled = false;
      if (error) return alert(limitText(error) || t('feed.commentFailed', { msg: error.message }));
      input.value = '';
      load();
    }
  });

  document.addEventListener('click', async e => {
    const el = e.target;
    const person = el.closest('[data-person]')?.dataset.person;
    if (el.closest('[data-request]')) {
      const ok = await act(supabase.from('friendships').insert({ requester: me.id, addressee: person }));
      if (ok) state.lookup = null, renderFriends();
      return;
    }
    if (el.closest('[data-accept]')) return act(supabase.from('friendships').update({ status: 'accepted' }).eq('requester', person).eq('addressee', me.id));
    if (el.closest('[data-decline], [data-withdraw]')) return act(supabase.from('friendships').delete().or(between(me.id, person)));
    if (el.closest('[data-unfriend]')) {
      const p = state.profiles.get(person);
      if (!confirm(t('fr.confirmRemove', { name: p?.name, handle: p?.handle }))) return;
      return act(supabase.from('friendships').delete().or(between(me.id, person)));
    }
    if (el.closest('[data-only]')) {
      track('only_friend');
      state.only = person;
      setOverlay(true);
      helpers.fitPins(state.pins.filter(p => p.user_id === person));
      return renderFriends();
    }
    if (el.closest('[data-only-all]')) { e.preventDefault(); state.only = null; renderFriends(); return helpers.onChange(); }

    // 静音 / 取消静音
    const muteFrom = el.closest('[data-mute]') ? el.closest('[data-user]')?.dataset.user
      : el.closest('[data-toggle-mute]') ? person : null;
    if (muteFrom) {
      const p = state.profiles.get(muteFrom);
      if (state.muted.has(muteFrom)) return act(supabase.from('feed_mutes').delete().eq('muted', muteFrom));
      if (!confirm(t('feed.muteConfirm', { name: p?.name || '' }))) return;
      return act(supabase.from('feed_mutes').insert({ user_id: me.id, muted: muteFrom }));
    }
    const group = el.closest('[data-group]')?.dataset.group;
    if (group && el.closest('[data-group-toggle]')) {
      if (state.openGroups.has(group)) state.openGroups.delete(group); else state.openGroups.add(group);
      renderFeed();
      return document.querySelector(`#drop-feed [data-group="${CSS.escape(group)}"]`)?.scrollIntoView({ block: 'nearest' });
    }
    const post = el.closest('[data-post]')?.dataset.post;
    if (post && el.closest('[data-expand]')) { state.expanded.add(post); return renderFeed(); }
    if (post && el.closest('[data-del-comment]')) {
      if (!confirm(t('feed.confirmDelete'))) return;
      return act(supabase.from('comments').delete().eq('id', el.closest('[data-comment]').dataset.comment));
    }
    if (post && el.closest('[data-photo]')) {
      const [owner, pid] = el.closest('[data-photo]').querySelector('.p1').dataset.full.split('|');
      const url = await fullUrl(owner, pid);
      if (url) helpers.showPhoto(url);
      return;
    }
    if (post && el.closest('[data-fly]')) return flyToPost(post);
    const open = el.closest('[data-open-post]')?.dataset.openPost;
    if (open) return openPost(open);
  });

  document.addEventListener('change', e => {
    if (e.target.id === 'overlayToggle') setOverlay(e.target.checked);
  });

  // 到达日期；没填日期的用发布时间，都没有的排在最后
  const dayOf = p => p.date || p.published_at?.slice(0, 10) || '';
  function recentPins() {
    const friendIds = new Set(state.friends.map(f => f.profile.id));
    if (state.only) return state.pins.filter(p => p.user_id === state.only && friendIds.has(p.user_id));
    const since = new Date(Date.now() - RECENT_DAYS * 864e5).toISOString().slice(0, 10);
    const byUser = new Map();
    for (const p of state.pins) {
      if (!friendIds.has(p.user_id)) continue;
      if (!byUser.has(p.user_id)) byUser.set(p.user_id, []);
      byUser.get(p.user_id).push(p);
    }
    return [...byUser.values()].flatMap(list => {
      const recent = list.filter(p => dayOf(p) >= since);
      return recent.length ? recent : [list.reduce((a, b) => (dayOf(b) > dayOf(a) ? b : a))];
    });
  }

  function setOverlay(on) {
    if (on !== state.overlay) track('friends_overlay', { on });
    state.overlay = on;
    if (!on) state.only = null;
    localStorage.setItem(seenKey('overlay'), on ? '1' : '0');
    const toggle = $('#overlayToggle');
    if (toggle) toggle.checked = on;
    helpers.onChange();
  }

  function flyToPost(k) {
    const [owner, id] = k.split('/');
    const row = state.posts.find(p => keyOf(p.user_id, p.id) === k) || state.pins.find(p => keyOf(p.user_id, p.id) === k);
    if (!row) return;
    if (owner !== me.id && !state.overlay) setOverlay(true);
    helpers.flyTo(row, owner === me.id ? id : null);
  }

  // 打开动态面板并滚到这条明信片
  function openPost(k) {
    // 在收起的组里：先展开
    const g = feedGroups().find(x => x.posts.length > 1 && x.posts.some(p => keyOf(p.user_id, p.id) === k));
    if (g && !state.openGroups.has(g.key)) { state.openGroups.add(g.key); renderFeed(); }
    helpers.openDrop('feed');
    requestAnimationFrame(() => {
      const el = document.querySelector(`#drop-feed [data-post="${CSS.escape(k)}"]`);
      // 展开的组里滚到那一站
      if (!el) return;
      el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
    });
  }

  render();
  load();

  return {
    load,
    get overlay() { return state.overlay; },
    setOverlay,
    friendCount: () => state.friends.length,
    friends: () => state.friends.map(f => f.profile),
    isFriend: id => state.friends.some(f => f.profile.id === id),
    // 私有存储里的照片签名链接（自己和好友的目录），path 形如 {用户 id}/{照片 id}_t.jpg
    photoUrls: async paths => { await sign(paths); return paths.map(p => signed.get(p)?.url || ''); },
    refresh: () => { renderFriends(); renderDots(); },
    // 地图上要画的好友打卡（照片用缩略图）
    // 默认每位好友只画最近 7 天去过的地方，这周没出门的只画最近一次；「只看 TA」时画这个人的全部足迹
    pins: () => !state.overlay ? [] : recentPins()
      .map(p => ({
        key: keyOf(p.user_id, p.id), owner: state.profiles.get(p.user_id),
        id: p.id, level: p.level, name: p.name, label: p.label, marker: p.marker, icon: p.icon, date: p.date || '',
        lat: p.lat, lng: p.lng, published: !!p.published_at, country: p.country, region: p.region, city: p.city,
        photos: p.published_at ? p.photos.slice(0, 3).map(ph => ({ id: ph.id, url: thumbUrl(p.user_id, ph.id) })) : [],
      })),
    // 某条打卡的评论（时间正序），用于标记上的滚动评论
    comments: key => state.comments.get(key) || [],
    author: id => state.profiles.get(id),
    // 读取不在好友列表里的人（群成员）的资料，之后 author() 就能拿到
    ensureProfiles: profilesFor,
    openPost,
  };
}
