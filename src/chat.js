// 好友私聊与群聊
//   · 从好友列表点「聊天」打开对话窗：桌面是右下角的信笺，手机铺满全屏
//   · 群聊：只能拉自己的好友，最多 20 人；群主可以改名、移出成员；自己的消息下显示几人已读
//   · 可以发文字和 emoji，也可以转发自己的一次打卡（发送时存快照，照片读发送者的私有目录）
//   · 好友点开转发的打卡能看全部照片、地址和留言，还能飞到地图上
//   · 未读数显示在好友列表和「好友」红点上；对话窗开着时新消息直接标记已读
// 数据权限见 supabase/migrations/0004_chat.sql、0010_groups.sql
import { supabase } from './supabase.js';
import { avatarUrl } from './auth.js';
import { t, lang } from './i18n.js';
import { limitText, LIMITS } from './limits.js';
import { ago } from './social.js';
import { track } from './track.js';

const PAGE = 50;
const $ = sel => document.querySelector(sel);
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const EMOJI = [
  '😀', '😄', '😁', '😆', '😂', '🤣', '😊', '😇', '🙂', '😉', '😍', '🥰', '😘', '😋', '😜', '🤪',
  '😎', '🤩', '🥳', '😏', '😌', '😴', '🤔', '🤨', '😮', '😲', '🥺', '😢', '😭', '😤', '😡', '🤯',
  '😱', '🤗', '🤭', '🙄', '😬', '🫠', '😅', '🙃', '👍', '👎', '👏', '🙌', '🙏', '🤝', '✌️', '👌',
  '🤞', '💪', '👋', '🫶', '❤️', '🧡', '💛', '💚', '💙', '💜', '💔', '✨', '🔥', '🎉', '🎈', '🌟',
  '☀️', '🌙', '🌈', '☔', '❄️', '🌊', '🏔️', '🏖️', '🏝️', '🏕️', '🌋', '🗻', '🌸', '🌻', '🍁', '🌲',
  '✈️', '🚄', '🚗', '🚲', '⛵', '🚀', '🗺️', '🧭', '📍', '📷', '🎒', '🧳', '🏨', '🗼', '🏯', '🎡',
  '☕', '🍵', '🍺', '🍷', '🍜', '🍣', '🍕', '🍔', '🍦', '🍰', '🍓', '🍉', '🥟', '🌮', '🥐', '🍲',
];

const ICON = {
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  smile: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 14c.8 1.4 2 2.1 3.5 2.1s2.7-.7 3.5-2.1"/><path d="M9.2 9.8h.01M14.8 9.8h.01"/>',
  postcard: '<rect x="3.5" y="5.5" width="17" height="13" rx="1.5"/><path d="M13 9h4.5M13 12h4.5M13 15h3"/><path d="M6 15.5l2.2-2.8 1.6 1.8 1.2-1.3"/>',
  send: '<path d="M4 12l16-7-6 16-3-7z"/><path d="M11 14l9-9"/>',
  pin: '<path d="M12 21s-6.5-6.1-6.5-11a6.5 6.5 0 0 1 13 0c0 4.9-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  camera: '<path d="M4 8.5h3l1.5-2h7l1.5 2h3v10H4z"/><circle cx="12" cy="13" r="3.2"/>',
  sent: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  read: '<path d="M2.5 12.5l4.5 4.5L16.5 7.5"/><path d="M11.5 16.5l.5.5 9.5-9.5"/>',
  users: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19.5c.6-3.3 2.8-5 5.5-5s4.9 1.7 5.5 5"/><path d="M15.5 5.6a3.2 3.2 0 0 1 0 5.8M17.5 14.8c1.6.6 2.7 2.2 3 4.7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  chat: '<path d="M4.5 6.5h15v9.5h-9l-4.5 3.5v-3.5h-1.5z"/>',
};
const icon = name => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;

// 只有 1–3 个 emoji 的消息放大显示
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter() : null;
function bigEmoji(text) {
  const s = text.trim();
  // 数字和 # * 也属于 Emoji_Component，要排除掉
  if (!s || /[0-9#*]/.test(s) || !/^(\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u.test(s)) return false;
  const n = segmenter ? [...segmenter.segment(s.replace(/\s/g, ''))].length : [...s].length;
  return n <= 3;
}

const dayKey = at => new Date(at).toDateString();
function dayLabel(at) {
  const d = new Date(at);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400_000);
  if (d.toDateString() === today.toDateString()) return t('chat.today');
  if (d.toDateString() === yesterday.toDateString()) return t('chat.yesterday');
  return d.toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en', { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}
const after = (a, b) => Date.parse(a) >= Date.parse(b); // 时间 a 不早于 b
const clock = at => new Date(at).toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en', { hour: '2-digit', minute: '2-digit' });

// me: { id }；social：好友资料与照片签名；helpers 由地图提供：
//   myRecords() 自己的本地记录；localPhotoUrl(photo) 本地照片；placeText(row) 行政区路径；
//   showPhoto(url) 大图；flyTo(row) 飞到地图上；toast(text)；requestSync() 立即同步（让照片尽快上传）
export function initChat({ me, social, helpers }) {
  const state = {
    conv: null,          // 正在看的对话：{ type: 'dm' | 'group', id }
    messages: [],        // 当前对话，时间正序
    more: false,         // 还有更早的消息
    unread: new Map(),   // 好友 id -> 未读数
    groups: new Map(),   // 群 id -> { id, name, owner, last_message_at, members: [{ user_id, joined_at, read_at }] }
    groupUnread: new Map(), // 群 id -> 未读数
    tray: null,          // 'emoji' | 'checkin' | null
    viewing: null,       // 正在查看的转发打卡消息
    viewComments: [],    // 它的评论（和动态里那条打卡的评论是同一批），时间正序
    sheet: null,         // 盖在对话上的面板：'create' 建群 | 'info' 群聊信息 | null
    picked: new Set(),   // 建群、拉人时勾选的好友
    readersOf: null,     // 展开了已读名单的消息 id
  };
  const peerOf = () => (state.conv?.type === 'dm' ? state.conv.id : null);
  const groupOf = () => (state.conv?.type === 'group' ? state.groups.get(state.conv.id) : null);
  const isOpenGroup = gid => !box.hidden && state.conv?.type === 'group' && state.conv.id === gid;
  const thumbs = new Map(); // 存储路径 -> 签名链接
  const justRead = new Set(); // 刚变成已读的消息，播一次盖章动画

  document.body.insertAdjacentHTML('beforeend', `
    <section id="chat" hidden role="dialog" aria-labelledby="chatName">
      <header class="ch-head">
        <span class="ch-stamp" id="chatAvatar"></span>
        <span class="person-text"><em class="ch-kicker" id="chatKicker">${t('chat.kicker')}</em><b id="chatName"></b><small id="chatHandle"></small></span>
        <button class="ch-x" id="chatInfo" data-sheet="info" title="${t('grp.info')}" hidden>${icon('users')}</button>
        <button class="ch-x" data-chat-close title="${t('close')}">${icon('close')}</button>
      </header>
      <div class="ch-sheet" id="chatSheet" hidden></div>
      <div class="ch-list" id="chatList" aria-live="polite"></div>
      <div class="ch-tray" id="chatTray" hidden></div>
      <p class="ch-gone" id="chatGone" hidden></p>
      <form class="ch-compose" id="chatForm" autocomplete="off">
        <button type="button" class="ch-tool" data-tray="emoji" title="${t('chat.emoji')}" aria-expanded="false">${icon('smile')}</button>
        <button type="button" class="ch-tool" data-tray="checkin" title="${t('chat.share')}" aria-expanded="false">${icon('postcard')}</button>
        <textarea id="chatInput" rows="1" maxlength="1000" placeholder="${t('chat.placeholder')}"></textarea>
        <button type="submit" class="ch-send" title="${t('chat.send')}">${icon('send')}</button>
      </form>
    </section>
    <div id="chatView" hidden>
      <div class="cv-backdrop" data-view-close></div>
      <article class="cv-card" role="dialog" aria-modal="true" aria-labelledby="cvTitle"></article>
    </div>`);
  const box = $('#chat');
  const list = $('#chatList');
  const input = $('#chatInput');

  // ---------- 未读 ----------
  async function loadUnread() {
    const { data, error } = await supabase.from('messages').select('sender')
      .eq('recipient', me.id).is('read_at', null).limit(1000);
    if (error) return console.warn('读取未读消息失败', error);
    state.unread = new Map();
    for (const m of data) if (m.sender !== peerOf() || box.hidden) state.unread.set(m.sender, (state.unread.get(m.sender) || 0) + 1);
    social.refresh();
  }

  async function markRead(peer) {
    if (!state.unread.has(peer) && !state.messages.some(m => m.sender === peer && !m.read_at)) return;
    state.unread.delete(peer);
    social.refresh();
    const { error } = await supabase.rpc('mark_read', { peer });
    if (error) console.warn('标记已读失败', error);
  }

  // 群聊只记「读到哪」：有别人的新消息时才更新，免得每次打开都推送给全群
  async function markGroupRead(gid) {
    const g = state.groups.get(gid);
    const mine = g?.members.find(x => x.user_id === me.id);
    if (!mine) return;
    const latest = isOpenGroup(gid) ? state.messages.findLast(m => m.sender !== me.id && m.kind !== 'system' && !m.pending) : null;
    if (!state.groupUnread.has(gid) && !(latest && !after(mine.read_at, latest.created_at))) return;
    state.groupUnread.delete(gid);
    mine.read_at = new Date().toISOString();
    social.refresh();
    const { error } = await supabase.rpc('mark_group_read', { gid });
    if (error) console.warn('标记已读失败', error);
  }

  // ---------- 群列表 ----------
  let groupsSeq = 0;
  async function loadGroups() {
    const seq = ++groupsSeq;
    const [res, unread] = await Promise.all([
      supabase.from('chat_groups').select('id, name, owner, last_message_at, group_members(user_id, joined_at, read_at)'),
      supabase.rpc('group_unread'),
    ]);
    if (res.error) return console.warn('读取群聊失败', res.error); // 还没执行 0010 时
    await social.ensureProfiles(res.data.flatMap(g => g.group_members.map(m => m.user_id)));
    if (seq !== groupsSeq) return;
    state.groups = new Map(res.data.map(({ group_members, ...g }) => [g.id, { ...g, members: group_members }]));
    state.groupUnread = new Map((unread.data || []).filter(r => r.n && !isOpenGroup(r.group_id)).map(r => [r.group_id, r.n]));
    social.refresh();
    if (state.conv?.type === 'group' && !box.hidden) {
      renderHead();
      renderCompose();
      renderList();
    }
    if (state.sheet === 'info') renderSheet();
  }

  const nameOf = id => (id === me.id ? t('grp.you') : social.author(id)?.name || t('grp.someone'));
  // 群头像：最多四位成员的头像拼成一枚邮票，自己排在最后
  function groupAvatar(g, cls) {
    const ids = g.members.map(m => m.user_id).sort((a, b) => (a === me.id) - (b === me.id)).slice(0, 4);
    return `<span class="${cls} grp-avatar n${ids.length}">${ids.map(id => `<img src="${avatarUrl(social.author(id)?.avatar || 'a01')}" alt="" />`).join('')}</span>`;
  }

  // 好友面板里的「群聊」一节（由 social.js 嵌进好友列表）
  function groupsHtml() {
    const list = [...state.groups.values()].sort((a, b) => Date.parse(b.last_message_at) - Date.parse(a.last_message_at));
    const canCreate = social.friends().length > 0;
    if (!list.length && !canCreate) return '';
    const badge = id => {
      const n = state.groupUnread.get(id) || 0;
      return n ? `<i class="fr-unread">${n > 99 ? '99+' : n}</i>` : '';
    };
    return `<p class="fr-title"><span>${t('grp.title')}</span><i>${list.length}</i>
        ${canCreate ? `<button class="fr-btn fr-new-group" data-new-group>${icon('plus')}${t('grp.new')}</button>` : ''}</p>
      ${list.length ? `<ul class="people">${list.map(g => `<li class="person grp-row" data-group="${g.id}">
          ${groupAvatar(g, 'avatar')}
          <span class="person-text"><b>${escapeHtml(g.name)}</b><small>${t('grp.count', { n: g.members.length })}</small></span>
          <span class="person-acts"><button class="fr-btn fr-icon fr-chat" title="${t('grp.open')}">${icon('chat')}${badge(g.id)}</button></span>
        </li>`).join('')}</ul>`
        : `<p class="grp-none">${t('grp.none')}</p>`}`;
  }

  // ---------- 读取对话 ----------
  const pairFilter = peer => `and(sender.eq.${me.id},recipient.eq.${peer}),and(sender.eq.${peer},recipient.eq.${me.id})`;

  async function fetchPage(conv, before) {
    let q = conv.type === 'group'
      ? supabase.from('group_messages').select('*').eq('group_id', conv.id)
      : supabase.from('messages').select('*').or(pairFilter(conv.id));
    q = q.order('created_at', { ascending: false }).limit(PAGE);
    if (before) q = q.lt('created_at', before);
    const { data, error } = await q;
    if (error) throw error;
    await Promise.all([signThumbs(data), people(data)]);
    return data.reverse();
  }

  // 群里可能有不是好友的人，系统消息里还会提到已经退群的人
  const people = msgs => social.ensureProfiles(msgs.flatMap(m => [m.sender, ...(m.meta?.users || [])]));

  // 转发打卡的缩略图：发送者目录里的 {照片 id}_t.jpg
  async function signThumbs(msgs) {
    const paths = msgs.filter(m => m.kind === 'checkin').flatMap(m => m.checkin.photos.slice(0, 3).map(pid => `${m.sender}/${pid}_t.jpg`))
      .filter(p => !thumbs.has(p));
    if (!paths.length) return;
    const urls = await social.photoUrls(paths);
    paths.forEach((p, i) => urls[i] && thumbs.set(p, urls[i]));
  }

  function renderHead() {
    const avatar = $('#chatAvatar');
    const g = groupOf();
    $('#chatInfo').hidden = !g;
    if (g) {
      avatar.className = 'ch-stamp group';
      avatar.innerHTML = groupAvatar(g, 'ch-collage');
      $('#chatKicker').textContent = t('grp.kicker');
      $('#chatName').textContent = g.name;
      $('#chatHandle').textContent = t('grp.count', { n: g.members.length });
      return;
    }
    const p = social.author(peerOf());
    avatar.className = 'ch-stamp';
    avatar.innerHTML = `<img src="${avatarUrl(p?.avatar || 'a01')}" alt="" />`;
    $('#chatKicker').textContent = t('chat.kicker');
    $('#chatName').textContent = p?.name || '';
    $('#chatHandle').textContent = p ? `@${p.handle}` : '';
  }

  async function show(type, id) {
    if (type === 'dm' ? !social.author(id) : !state.groups.has(id)) return;
    const switching = state.conv?.type !== type || state.conv.id !== id;
    if (switching) {
      track('chat_open', { type });
      state.conv = { type, id };
      state.messages = []; state.more = false; state.readersOf = null;
      setTray(null); input.value = '';
    }
    const conv = state.conv;
    setSheet(null);
    box.hidden = false;
    renderHead();
    renderCompose();
    if (switching) list.innerHTML = `<p class="ch-note">${t('loading')}</p>`;
    if (!matchMedia('(max-width: 700px)').matches) input.focus();
    try {
      const msgs = await fetchPage(conv);
      if (state.conv !== conv) return;
      state.messages = msgs;
      state.more = msgs.length === PAGE;
      renderList({ toBottom: true, enter: true });
      if (type === 'dm') markRead(id);
      else markGroupRead(id);
    } catch (err) {
      list.innerHTML = `<p class="ch-note">${escapeHtml(t('chat.loadFailed', { msg: err.message }))}</p>`;
    }
  }
  const open = peer => show('dm', peer);
  const openGroup = gid => show('group', gid);

  function close() {
    box.hidden = true;
    state.conv = null;
    setTray(null);
    setSheet(null);
  }

  async function loadEarlier() {
    const conv = state.conv;
    const oldest = state.messages[0]?.created_at;
    try {
      const msgs = await fetchPage(conv, oldest);
      if (state.conv !== conv) return;
      const before = list.scrollHeight - list.scrollTop;
      state.messages = [...msgs, ...state.messages];
      state.more = msgs.length === PAGE;
      renderList();
      list.scrollTop = list.scrollHeight - before; // 保持当前看到的位置
    } catch (err) {
      helpers.toast(t('chat.loadFailed', { msg: err.message }));
    }
  }

  // ---------- 渲染 ----------
  function checkinCard(m) {
    const c = m.checkin;
    const shots = c.photos.slice(0, 3).map((pid, i) => `<img class="p${i + 1}" src="${thumbs.get(`${m.sender}/${pid}_t.jpg`) || ''}" alt="" loading="lazy" />`).reverse().join('');
    return `<button class="ch-checkin" data-view="${m.id}" title="${t('chat.viewCheckin')}">
      <span class="post-stack n${Math.min(3, c.photos.length)}">${shots}</span>
      <span class="ch-ci-text">
        <b>${escapeHtml(c.name || t('unnamed'))}</b>
        <small>${escapeHtml(c.place || '')}</small>
        <span class="ch-ci-meta">${c.date ? `<time>${escapeHtml(c.date.replaceAll('-', '.'))}</time>` : ''}<span>${
          commentCount(m) ? `<i>${icon('chat')}${commentCount(m)}</i>` : ''}<i>${icon('camera')}${c.photos.length}</i></span></span>
      </span>
    </button>`;
  }

  const commentCount = m => social.comments(`${m.sender}/${m.checkin.id}`).length;

  // 评论消息：上面一行引用被评论的明信片，点它打开那张明信片
  function commentHtml(m) {
    return `<button class="ch-quote" data-view-ref="${escapeHtml(m.reply.to)}" title="${t('chat.viewCheckin')}">${icon('postcard')}<span>${
      escapeHtml(t('chat.commentedOn', { name: m.reply.name || t('unnamed') }))}</span></button>
      <p class="ch-bubble">${escapeHtml(m.body)}</p>`;
  }

  // 自己发出的消息：未读 / 已读（同一组消息只在最后一条下面显示）
  function receipt(m) {
    if (m.pending || m.failed) return '';
    const read = !!m.read_at;
    const pop = read && justRead.has(m.id) ? ' pop' : '';
    return `<span class="ch-receipt ${read ? 'read' : 'unread'}${pop}" title="${read ? t('chat.readAt', { time: clock(m.read_at) }) : t('chat.unreadTitle')}">${
      icon(read ? 'read' : 'sent')}${t(read ? 'chat.read' : 'chat.unread')}</span>`;
  }

  // 群里：发出时已经在群里的其他人，按读到哪分成已读和未读
  function readers(m) {
    const others = (groupOf()?.members || []).filter(x => x.user_id !== m.sender && after(m.created_at, x.joined_at));
    const read = others.filter(x => after(x.read_at, m.created_at));
    return { others, read };
  }

  function groupReceipt(m) {
    if (m.pending || m.failed) return '';
    const { others, read } = readers(m);
    if (!others.length) return '';
    const all = read.length === others.length;
    const pop = read.length && justRead.has(m.id) ? ' pop' : '';
    const label = all ? t('grp.allRead') : read.length ? t('grp.nRead', { n: read.length }) : t('chat.unread');
    return `<button type="button" class="ch-receipt ${read.length ? 'read' : 'unread'}${pop}" data-readers="${m.id}" title="${t('grp.whoRead')}" aria-expanded="${state.readersOf === m.id}">${
      icon(all ? 'read' : 'sent')}${label}</button>`;
  }

  function readersList(m) {
    const { others, read } = readers(m);
    const readIds = new Set(read.map(x => x.user_id));
    const names = list => list.map(x => escapeHtml(nameOf(x.user_id))).join(t('grp.sep')) || '—';
    return `<div class="ch-readers">
      <p><b>${t('grp.readBy')} ${read.length}</b>${names(read)}</p>
      <p><b>${t('grp.unreadBy')} ${others.length - read.length}</b>${names(others.filter(x => !readIds.has(x.user_id)))}</p>
    </div>`;
  }

  function systemText(m) {
    const names = (m.meta.users || []).map(nameOf).join(t('grp.sep'));
    return t(`grp.sys.${m.meta.event}`, { actor: nameOf(m.sender), names, name: m.meta.name || '' });
  }

  // enter：刚打开对话，最近几条依次落下；fresh：这条刚到，单独做一次到达动画
  function renderList({ toBottom = false, enter = false, fresh = null } = {}) {
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    const group = groupOf();
    let html = state.more ? `<button class="ch-earlier" data-earlier>${t('chat.earlier')}</button>` : '';
    if (!state.messages.some(m => m.kind !== 'system')) {
      html += group
        ? `<div class="ch-empty"><span>🎒</span><b>${t('grp.empty')}</b><small>${t('grp.emptySub')}</small></div>`
        : `<div class="ch-empty"><span>👋</span><b>${escapeHtml(t('chat.empty', { name: social.author(peerOf())?.name || '' }))}</b><small>${t('chat.emptySub')}</small></div>`;
    }
    let lastDay = null;
    state.messages.forEach((m, i) => {
      if (dayKey(m.created_at) !== lastDay) {
        lastDay = dayKey(m.created_at);
        html += `<p class="ch-day"><span class="ch-postmark"><small>${t('chat.posted')}</small>${dayLabel(m.created_at)}</span></p>`;
      }
      if (m.kind === 'system') {
        html += `<p class="ch-sys${m.id === fresh ? ' arrive' : ''}">${escapeHtml(systemText(m))}</p>`;
        return;
      }
      const mine = m.sender === me.id;
      const prev = state.messages[i - 1];
      const next = state.messages[i + 1];
      const sameRun = o => o && o.kind !== 'system' && o.sender === m.sender && dayKey(o.created_at) === lastDay;
      const tail = !sameRun(next);
      // 群里别人的一组消息，开头写上是谁
      const from = group && !mine && !sameRun(prev)
        ? `<p class="ch-from"><img src="${avatarUrl(social.author(m.sender)?.avatar || 'a01')}" alt="" />${escapeHtml(nameOf(m.sender))}</p>` : '';
      const content = m.kind === 'checkin' ? checkinCard(m) + (m.body ? `<p class="ch-bubble">${escapeHtml(m.body)}</p>` : '')
        : m.kind === 'comment' ? commentHtml(m)
        : bigEmoji(m.body) ? `<p class="ch-emoji">${escapeHtml(m.body.trim())}</p>`
        : `<p class="ch-bubble">${escapeHtml(m.body)}</p>`;
      const back = state.messages.length - 1 - i;
      const motion = enter && back < 10 ? ` enter" style="--i: ${9 - back}` : m.id === fresh ? ' arrive' : '';
      html += `<div class="ch-msg ${mine ? 'mine' : 'theirs'}${tail ? ' tail' : ''}${m.pending ? ' pending' : ''}${m.failed ? ' failed' : ''}${motion}" data-msg="${m.id}">
        ${from}${content}
        ${tail ? `<p class="ch-meta"><time>${m.failed ? t('chat.failedShort') : m.pending ? t('chat.sending') : clock(m.created_at)}</time>${
          mine ? (group ? groupReceipt(m) : receipt(m)) : ''}</p>` : ''}
        ${tail && mine && group && state.readersOf === m.id ? readersList(m) : ''}
      </div>`;
    });
    list.innerHTML = html;
    justRead.clear();
    if (toBottom || nearBottom) list.scrollTop = list.scrollHeight;
  }

  function renderCompose() {
    const gone = state.conv?.type === 'dm' ? !social.isFriend(state.conv.id)
      : state.conv?.type === 'group' ? !state.groups.has(state.conv.id) : false;
    $('#chatGone').textContent = state.conv?.type === 'group' ? t('grp.gone') : t('chat.notFriend');
    $('#chatGone').hidden = !gone;
    $('#chatForm').hidden = gone;
    $('#chatInfo').hidden = !groupOf();
    if (gone) setTray(null);
  }

  // ---------- 输入托盘：emoji 与选择打卡 ----------
  function setTray(name) {
    state.tray = state.tray === name ? null : name;
    const tray = $('#chatTray');
    tray.hidden = !state.tray;
    for (const b of box.querySelectorAll('[data-tray]')) b.setAttribute('aria-expanded', b.dataset.tray === state.tray);
    if (state.tray === 'emoji') {
      tray.className = 'ch-tray ch-emojis';
      tray.innerHTML = EMOJI.map(e => `<button type="button" data-emoji="${e}">${e}</button>`).join('');
    } else if (state.tray === 'checkin') {
      tray.className = 'ch-tray ch-picks';
      tray.innerHTML = pickerHtml();
    }
  }

  const titleOf = r => (r.label || '').trim() || r.name || t('unnamed');

  function pickerHtml() {
    const rows = helpers.myRecords().filter(r => !r.deleted && r.photos.length)
      .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.updatedAt || 0) - (a.updatedAt || 0));
    if (!rows.length) return `<p class="ch-note">${t('chat.pickEmpty')}</p>`;
    return `<p class="ch-tray-title">${t(groupOf() ? 'grp.pickTitle' : 'chat.pickTitle')}</p><ul>${rows.map(r => {
      const ready = r.photos.some(p => p.up);
      const cover = r.photos.find(p => p.blob) || r.photos[0];
      return `<li><button type="button" data-pick="${r.id}" ${ready ? '' : 'disabled'}>
        <img src="${cover?.blob ? helpers.localPhotoUrl(cover) : ''}" alt="" />
        <span><b>${escapeHtml(titleOf(r))}</b><small>${ready ? escapeHtml(helpers.placeText(r)) : t('chat.uploading')}</small></span>
        <time>${escapeHtml((r.date || '').replaceAll('-', '.'))}</time>
      </button></li>`;
    }).join('')}</ul>`;
  }

  function insertEmoji(e) {
    const { selectionStart: a, selectionEnd: b, value } = input;
    input.value = value.slice(0, a) + e + value.slice(b);
    input.selectionStart = input.selectionEnd = a + e.length;
    input.focus();
    autosize();
  }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  }

  // ---------- 群聊面板：建群 / 群聊信息 ----------
  function setSheet(name) {
    state.sheet = name;
    state.picked = new Set();
    const sheet = $('#chatSheet');
    sheet.hidden = !name;
    if (name) renderSheet();
  }

  function friendPicker(exclude = new Set(), room = Infinity) {
    const friends = social.friends().filter(p => !exclude.has(p.id));
    if (!friends.length) return `<p class="ch-note">${t('grp.allIn')}</p>`;
    return `<ul class="sh-people">${friends.map(p => {
      const on = state.picked.has(p.id);
      return `<li><label class="sh-person">
        <input type="checkbox" data-pick-friend value="${p.id}" ${on ? 'checked' : ''} ${!on && state.picked.size >= room ? 'disabled' : ''} />
        <span class="avatar"><img src="${avatarUrl(p.avatar || 'a01')}" alt="" /></span>
        <span class="person-text"><b>${escapeHtml(p.name)}</b><small>@${escapeHtml(p.handle)}</small></span>
        <i class="sh-check" aria-hidden="true">${icon('sent')}</i>
      </label></li>`;
    }).join('')}</ul>`;
  }

  // 最多还能拉几个人
  const roomLeft = () => LIMITS.groupSize - (state.sheet === 'info' ? groupOf()?.members.length || 0 : 1);

  function renderSheet() {
    const sheet = $('#chatSheet');
    const head = (title, back) => `<header class="sh-head">
      <button type="button" class="ch-x" data-sheet-close title="${t(back ? 'back' : 'close')}">${icon(back ? 'back' : 'close')}</button>
      <b>${title}</b></header>`;
    if (state.sheet === 'create') {
      sheet.innerHTML = `${head(t('grp.createTitle'), !box.hidden && state.conv)}
        <div class="sh-body">
          <label class="sh-name"><span>${t('grp.name')}</span><input id="groupName" maxlength="30" placeholder="${t('grp.namePh')}" /></label>
          <p class="fr-title"><span>${t('grp.pickFriends')}</span><i data-pick-count></i></p>
          ${friendPicker(new Set(), roomLeft())}
        </div>
        <footer class="sh-foot"><button type="button" class="fr-btn fr-primary" data-create-group></button></footer>`;
      return updatePicks();
    }
    const g = groupOf();
    if (!g) return setSheet(null);
    const owner = g.owner === me.id;
    const ids = new Set(g.members.map(m => m.user_id));
    const members = [...g.members].sort((a, b) => (b.user_id === g.owner) - (a.user_id === g.owner) || Date.parse(a.joined_at) - Date.parse(b.joined_at));
    sheet.innerHTML = `${head(t('grp.info'), true)}
      <div class="sh-body">
        ${owner
          ? `<form class="sh-name" id="groupRename" autocomplete="off"><span>${t('grp.name')}</span><input maxlength="30" value="${escapeHtml(g.name)}" required /><button class="fr-btn">${t('grp.save')}</button></form>`
          : `<p class="sh-name"><span>${t('grp.name')}</span><b>${escapeHtml(g.name)}</b></p>`}
        <p class="fr-title"><span>${t('grp.members')}</span><i>${g.members.length} / ${LIMITS.groupSize}</i></p>
        <ul class="sh-people">${members.map(m => {
          const p = social.author(m.user_id);
          return `<li class="sh-person">
            <span class="avatar"><img src="${avatarUrl(p?.avatar || 'a01')}" alt="" /></span>
            <span class="person-text"><b>${escapeHtml(p?.name || t('grp.someone'))}${m.user_id === me.id ? ` <em>(${t('grp.you')})</em>` : ''}</b><small>${p ? `@${escapeHtml(p.handle)}` : ''}</small></span>
            ${m.user_id === g.owner ? `<em class="sh-owner">${t('grp.owner')}</em>` : ''}
            ${owner && m.user_id !== me.id ? `<button type="button" class="fr-btn fr-more" data-kick="${m.user_id}">${t('grp.kick')}</button>` : ''}
          </li>`;
        }).join('')}</ul>
        ${roomLeft() > 0 ? `<p class="fr-title"><span>${t('grp.addTitle')}</span><i data-pick-count></i></p>${friendPicker(ids, roomLeft())}`
          : `<p class="ch-note">${t('limit.group_full', LIMITS)}</p>`}
      </div>
      <footer class="sh-foot">
        <button type="button" class="fr-btn sh-leave" data-leave-group>${t('grp.leave')}</button>
        <button type="button" class="fr-btn fr-primary" data-add-members></button>
      </footer>`;
    updatePicks();
  }

  // 勾选变化时只更新按钮和计数，不重画列表（保留输入框内容）
  function updatePicks() {
    const n = state.picked.size;
    const room = roomLeft();
    const count = $('#chatSheet [data-pick-count]');
    if (count) count.textContent = `${n} / ${room}`;
    for (const cb of document.querySelectorAll('#chatSheet [data-pick-friend]')) cb.disabled = !cb.checked && n >= room;
    const create = $('#chatSheet [data-create-group]');
    if (create) { create.textContent = t('grp.create', { n }); create.disabled = !n; }
    const add = $('#chatSheet [data-add-members]');
    if (add) { add.textContent = t('grp.add', { n }); add.hidden = !n; }
  }

  async function rpc(name, args) {
    const { data, error } = await supabase.rpc(name, args);
    if (error) { helpers.toast(limitText(error) || t('opFailed', { msg: error.message })); throw error; }
    return data;
  }

  async function createGroup(btn) {
    const ids = [...state.picked];
    const typed = $('#groupName').value.trim();
    // 没填群名时用前几个人的名字
    const auto = [me.id, ...ids].slice(0, 3).map(id => social.author(id)?.name || '').filter(Boolean).join(t('grp.sep'));
    const name = (typed || auto + (ids.length > 2 ? '…' : '')).slice(0, 30) || t('grp.title');
    btn.disabled = true;
    try {
      const gid = await rpc('create_group', { group_name: name, members: ids });
      await loadGroups();
      openGroup(gid);
    } catch {
      btn.disabled = false;
    }
  }

  async function addMembers(btn) {
    const g = groupOf();
    btn.disabled = true;
    try {
      await rpc('add_group_members', { gid: g.id, members: [...state.picked] });
      state.picked = new Set();
      await loadGroups();
    } catch {
      btn.disabled = false;
    }
  }

  async function kick(uid) {
    const g = groupOf();
    if (!confirm(t('grp.kickConfirm', { name: nameOf(uid) }))) return;
    try { await rpc('remove_group_member', { gid: g.id, member: uid }); await loadGroups(); } catch {}
  }

  async function leave() {
    const g = groupOf();
    const sole = g.members.length === 1;
    if (!confirm(t(sole ? 'grp.leaveLast' : g.owner === me.id ? 'grp.leaveOwner' : 'grp.leaveConfirm', { name: g.name }))) return;
    try {
      await rpc('leave_group', { gid: g.id });
      close();
      state.groups.delete(g.id);
      state.groupUnread.delete(g.id);
      social.refresh();
    } catch {}
  }

  async function rename(form) {
    const g = groupOf();
    const name = form.querySelector('input').value.trim();
    if (!name || name === g.name) return;
    try { await rpc('rename_group', { gid: g.id, new_name: name }); await loadGroups(); } catch {}
  }

  function startCreate() {
    if (box.hidden) {
      state.conv = null;
      state.messages = [];
      list.innerHTML = '';
      $('#chatAvatar').className = 'ch-stamp';
      $('#chatAvatar').innerHTML = '';
      box.hidden = false;
    }
    setSheet('create');
    if (!matchMedia('(max-width: 700px)').matches) $('#groupName').focus();
  }

  // ---------- 发送 ----------
  async function send(fields) {
    const conv = state.conv;
    const group = conv.type === 'group';
    const temp = { id: `tmp-${Date.now()}`, sender: me.id, body: '', checkin: null, kind: 'text', ...fields, created_at: new Date().toISOString(), pending: true };
    state.messages.push(temp);
    await signThumbs([temp]);
    renderList({ toBottom: true, fresh: temp.id });
    const { data, error } = group
      ? await supabase.from('group_messages').insert({ group_id: conv.id, ...fields }).select().single()
      : await supabase.from('messages').insert({ recipient: conv.id, ...fields }).select().single();
    if (state.conv !== conv) return;
    let i = state.messages.indexOf(temp);
    if (i < 0) i = state.messages.push(temp) - 1; // 等待期间对话被重新读取过
    if (error) {
      temp.pending = false;
      temp.failed = true;
      renderList();
      if (group && error.code === '42501') loadGroups(); // 已经不在群里了
      return helpers.toast(limitText(error) || t('chat.failed', { msg: error.message }));
    }
    // 实时推送可能先到，避免重复
    if (state.messages.some(m => m.id === data.id)) state.messages.splice(i, 1);
    else state.messages[i] = data;
    renderList();
  }

  function sendText() {
    const body = input.value.trim();
    if (!body || !state.conv) return;
    input.value = '';
    autosize();
    if (state.tray === 'emoji') setTray(null);
    send({ kind: 'text', body });
  }

  function shareCheckin(id) {
    const r = helpers.myRecords().find(x => x.id === id);
    const photos = r?.photos.filter(p => p.up).slice(0, 9).map(p => p.id) || [];
    if (!photos.length) { helpers.requestSync(); return helpers.toast(t('chat.uploading')); }
    setTray(null);
    send({
      kind: 'checkin',
      body: input.value.trim().slice(0, 1000),
      checkin: {
        id: r.id, level: r.level, name: titleOf(r), place: helpers.placeText(r), date: r.date || '',
        note: (r.note || '').slice(0, 300), photos,
        country: r.country || '', region: r.region || '', city: r.city || '', lat: r.lat ?? null, lng: r.lng ?? null,
      },
    });
    input.value = '';
    autosize();
  }

  // ---------- 查看转发的打卡 ----------
  async function view(id) {
    const m = state.messages.find(x => x.id === id) || await fetchMessage(id);
    if (!m) return helpers.toast(t('chat.checkinGone'));
    state.viewing = m;
    state.viewComments = [];
    const c = m.checkin;
    const from = social.author(m.sender);
    const paths = c.photos.map(pid => `${m.sender}/${pid}_t.jpg`);
    const urls = await social.photoUrls(paths);
    const card = $('#chatView .cv-card');
    card.innerHTML = `
      <button class="pc-close" data-view-close title="${t('close')}">×</button>
      ${c.date ? `<span class="cv-postmark" aria-hidden="true"><small>DEAR ELSEWHERE</small>${escapeHtml(c.date.replaceAll('-', '.'))}</span>` : ''}
      <div class="cv-photos n${Math.min(c.photos.length, 4)}">${c.photos.map((pid, i) =>
        `<button data-full="${pid}" title="${t('feed.photo')}"><img src="${urls[i] || ''}" alt="" /></button>`).join('')}</div>
      <div class="cv-text">
        <p class="cv-from">${t(m.sender === me.id ? 'chat.sharedByMe' : 'chat.sharedBy', { name: escapeHtml(from?.name || '') })}</p>
        <h3 id="cvTitle">${escapeHtml(c.name || t('unnamed'))}</h3>
        ${c.place ? `<small>${escapeHtml(c.place)}</small>` : ''}
        ${c.note ? `<p>${escapeHtml(c.note)}</p>` : ''}
        <footer>
          ${c.date ? `<time>${escapeHtml(c.date.replaceAll('-', '.'))}</time>` : '<span></span>'}
          ${c.country || c.lat != null ? `<button class="fr-btn" data-view-fly>${icon('pin')}${t('feed.fly')}</button>` : ''}
        </footer>
        <section class="cv-comments" id="cvComments"></section>
      </div>`;
    $('#chatView').hidden = false;
    renderViewComments();
    loadViewComments();
  }

  // 被评论的那条转发消息不在当前这一页里时，单独读一次
  async function fetchMessage(id) {
    const conv = state.conv;
    if (!conv) return null;
    const { data } = await (conv.type === 'group' ? supabase.from('group_messages') : supabase.from('messages'))
      .select('*').eq('id', id).eq('kind', 'checkin').maybeSingle();
    if (data) await Promise.all([signThumbs([data]), people([data])]);
    return data;
  }

  // ---------- 明信片上的评论：和原打卡的评论打通 ----------
  async function loadViewComments() {
    const m = state.viewing;
    if (!m) return;
    const { data, error } = await supabase.from('comments').select('*')
      .eq('checkin_owner', m.sender).eq('checkin_id', m.checkin.id).order('created_at', { ascending: true }).limit(200);
    if (error) return console.warn('读取评论失败', error);
    await social.ensureProfiles(data.map(c => c.author));
    if (state.viewing !== m) return;
    state.viewComments = data;
    renderViewComments();
  }

  // 本人和发帖人的好友可以评论；群里不是好友的人只能看
  const canComment = m => m.sender === me.id || social.isFriend(m.sender);

  function renderViewComments() {
    const m = state.viewing;
    const box = $('#cvComments');
    if (!m || !box) return;
    const input = box.querySelector('input');
    const draft = input?.value || '';
    const hadFocus = input && document.activeElement === input;
    const list = state.viewComments;
    box.innerHTML = `<p class="cv-c-title">${t('chat.comments')}${list.length ? ` <i>${list.length}</i>` : ''}</p>
      ${list.length ? `<ul class="post-comments">${list.map(c => {
        const a = social.author(c.author);
        return `<li><img src="${avatarUrl(a?.avatar || 'a01')}" alt="" />
          <p><b>${escapeHtml(c.author === me.id ? t('grp.you') : a?.name || t('grp.someone'))}</b>${escapeHtml(c.body)}<time>${ago(c.created_at)}</time></p></li>`;
      }).join('')}</ul>` : `<p class="cv-c-none">${t('chat.noComments')}</p>`}
      ${canComment(m)
        ? `<form class="post-reply" id="cvReply" autocomplete="off"><input maxlength="140" placeholder="${t('feed.reply')}" />
            <button type="submit" title="${t('feed.send')}">${icon('send')}</button></form>`
        : `<p class="cv-c-none">${escapeHtml(t('chat.commentFriendsOnly', { name: social.author(m.sender)?.name || '' }))}</p>`}`;
    const next = box.querySelector('input');
    if (next) { next.value = draft; if (hadFocus) next.focus(); }
    const ul = box.querySelector('.post-comments');
    if (ul) ul.scrollTop = ul.scrollHeight;
  }

  async function submitComment(form) {
    const m = state.viewing;
    const field = form.querySelector('input');
    const body = field.value.trim();
    if (!m || !body || !state.conv) return;
    const btn = form.querySelector('button');
    btn.disabled = true;
    const { error } = await supabase.rpc('comment_shared', { conv: state.conv.type, msg: m.id, body });
    btn.disabled = false;
    if (error) return helpers.toast(limitText(error) || t('opFailed', { msg: error.message }));
    field.value = '';
    // 对话里的评论消息由实时推送送到；评论列表和动态里的评论这里先刷新
    loadViewComments();
    social.load();
  }

  function closeView() {
    $('#chatView').hidden = true;
    state.viewing = null;
    state.viewComments = [];
  }

  // ---------- 实时 ----------
  // 打开的对话里来了一条消息：替换自己发送中的那条，或者追加
  function arrive(m) {
    if (m.kind === 'comment' && state.viewing?.id === m.reply?.to) loadViewComments();
    if (state.messages.some(x => x.id === m.id)) return;
    // 自己在别的设备上发的、或刚发出去还在等回执的
    const temp = state.messages.find(x => x.pending && x.sender === m.sender && x.kind === m.kind && x.body === m.body);
    if (temp) state.messages[state.messages.indexOf(temp)] = m;
    else state.messages.push(m);
    Promise.all([signThumbs([m]), people([m])]).then(() => renderList({ fresh: temp ? null : m.id }));
  }

  const previewText = m => (m.kind === 'checkin' ? t('chat.sharedCheckin')
    : m.kind === 'comment' ? `${t('chat.commentedOn', { name: m.reply?.name || t('unnamed') })}：${m.body.slice(0, 30)}`
    : m.body.slice(0, 40));

  function onInsert(m) {
    const peer = peerOf();
    const inOpenChat = !box.hidden && peer && (m.sender === peer || m.recipient === peer);
    if (inOpenChat) {
      arrive(m);
      if (m.recipient === me.id && document.visibilityState === 'visible') markRead(m.sender);
      else if (m.recipient === me.id) { state.unread.set(m.sender, (state.unread.get(m.sender) || 0) + 1); social.refresh(); }
      return;
    }
    if (m.recipient !== me.id) return;
    state.unread.set(m.sender, (state.unread.get(m.sender) || 0) + 1);
    social.refresh();
    const p = social.author(m.sender);
    helpers.toast(t('chat.newFrom', { name: p?.name || t('feed.friend'), text: previewText(m) }));
  }

  async function onGroupInsert(m) {
    const g = state.groups.get(m.group_id);
    if (g) g.last_message_at = m.created_at;
    // 新群、成员或群名有变化：重新读取群列表
    if (!g || m.kind === 'system') await loadGroups();
    if (isOpenGroup(m.group_id)) {
      arrive(m);
      if (m.sender !== me.id && m.kind !== 'system') {
        if (document.visibilityState === 'visible') markGroupRead(m.group_id);
        else { state.groupUnread.set(m.group_id, (state.groupUnread.get(m.group_id) || 0) + 1); social.refresh(); }
      }
      return;
    }
    if (m.sender === me.id) return social.refresh();
    const group = state.groups.get(m.group_id);
    if (m.kind === 'system') {
      if (['create', 'add'].includes(m.meta.event) && m.meta.users?.includes(me.id)) {
        helpers.toast(t('grp.addedYou', { name: nameOf(m.sender), group: group?.name || '' }));
      }
      return social.refresh();
    }
    state.groupUnread.set(m.group_id, (state.groupUnread.get(m.group_id) || 0) + 1);
    social.refresh();
    await social.ensureProfiles([m.sender]);
    helpers.toast(t('grp.newFrom', { group: group?.name || '', name: nameOf(m.sender), text: previewText(m) }));
  }

  function onUpdate(m) {
    const cur = state.messages.find(x => x.id === m.id);
    if (cur && cur.read_at !== m.read_at) {
      if (!cur.read_at && m.read_at) justRead.add(cur.id);
      cur.read_at = m.read_at;
      renderList();
    }
  }

  // 群成员读到了新的位置：自己在这之间发的消息播一次已读动画
  function onMemberUpdate(row) {
    const member = state.groups.get(row.group_id)?.members.find(x => x.user_id === row.user_id);
    if (!member || member.read_at === row.read_at) return;
    const before = member.read_at;
    member.read_at = row.read_at;
    if (!isOpenGroup(row.group_id) || row.user_id === me.id) return;
    for (const m of state.messages) {
      if (m.sender === me.id && !after(before, m.created_at) && after(row.read_at, m.created_at)) justRead.add(m.id);
    }
    renderList();
  }

  supabase.channel('chat')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, e => onInsert(e.new))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, e => onUpdate(e.new))
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'group_messages' }, e => onGroupInsert(e.new))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'group_members' }, e => onMemberUpdate(e.new))
    .subscribe();
  // 回到页面时补上断线期间的消息
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    loadUnread();
    loadGroups();
    if (state.conv && !box.hidden && !state.sheet) show(state.conv.type, state.conv.id);
  });

  // ---------- 事件 ----------
  document.addEventListener('click', e => {
    const el = e.target;
    const chatBtn = el.closest('#drop-friends [data-chat]');
    const groupRow = el.closest('#drop-friends [data-group]');
    const newGroup = el.closest('#drop-friends [data-new-group]');
    if (chatBtn || groupRow || newGroup) {
      if (chatBtn) open(chatBtn.closest('[data-person]').dataset.person);
      else if (groupRow) openGroup(groupRow.dataset.group);
      else startCreate();
      if (matchMedia('(max-width: 700px)').matches) helpers.closeDrop();
      return;
    }
    if (!el.closest('#chat, #chatView')) return;
    if (el.closest('[data-chat-close]')) return close();
    if (el.closest('[data-sheet-close]')) return state.conv ? setSheet(null) : close();
    if (el.closest('[data-sheet]')) return setSheet(state.sheet ? null : 'info');
    if (el.closest('[data-create-group]')) return createGroup(el.closest('button'));
    if (el.closest('[data-add-members]')) return addMembers(el.closest('button'));
    if (el.closest('[data-leave-group]')) return leave();
    const kickBtn = el.closest('[data-kick]');
    if (kickBtn) return kick(kickBtn.dataset.kick);
    const who = el.closest('[data-readers]');
    if (who) { state.readersOf = state.readersOf === who.dataset.readers ? null : who.dataset.readers; return renderList(); }
    if (el.closest('[data-earlier]')) return loadEarlier();
    const tray = el.closest('[data-tray]');
    if (tray) return setTray(tray.dataset.tray);
    const emoji = el.closest('[data-emoji]');
    if (emoji) return insertEmoji(emoji.dataset.emoji);
    const pick = el.closest('[data-pick]');
    if (pick) return shareCheckin(pick.dataset.pick);
    const v = el.closest('[data-view]');
    if (v) return view(v.dataset.view);
    const ref = el.closest('[data-view-ref]');
    if (ref) return view(ref.dataset.viewRef);
    if (el.closest('[data-view-close]')) return closeView();
    const full = el.closest('[data-full]');
    if (full && state.viewing) {
      const path = `${state.viewing.sender}/${full.dataset.full}.jpg`;
      return social.photoUrls([path]).then(([url]) => url && helpers.showPhoto(url));
    }
    if (el.closest('[data-view-fly]') && state.viewing) {
      const { sender, checkin: c } = state.viewing;
      closeView();
      if (matchMedia('(max-width: 700px)').matches) close();
      return helpers.flyTo({ ...c, user_id: sender });
    }
  });

  $('#chatSheet').addEventListener('change', e => {
    if (!e.target.matches('[data-pick-friend]')) return;
    if (e.target.checked) state.picked.add(e.target.value);
    else state.picked.delete(e.target.value);
    updatePicks();
  });
  $('#chatSheet').addEventListener('submit', e => {
    if (e.target.id !== 'groupRename') return;
    e.preventDefault();
    rename(e.target);
  });
  $('#chatForm').addEventListener('submit', e => { e.preventDefault(); sendText(); });
  $('#chatView').addEventListener('submit', e => {
    if (e.target.id !== 'cvReply') return;
    e.preventDefault();
    submitComment(e.target);
  });
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', e => {
    // 回车发送，Shift+回车换行；输入法选字时的回车不算
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); sendText(); }
  });
  // 捕获阶段处理，免得地图的 Esc（收起面板、返回上一级）同时生效
  addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !$('#lightbox').hidden) return;
    if (!$('#chatView').hidden) closeView();
    else if (!box.hidden && box.contains(document.activeElement)) state.sheet ? (state.conv ? setSheet(null) : close()) : state.tray ? setTray(null) : close();
    else return;
    e.stopPropagation();
  }, true);

  loadUnread();
  loadGroups();

  return {
    open,
    openGroup,
    groupsHtml,
    // 不传 id 时为全部未读（私聊 + 群聊）
    unread: id => (id ? state.unread.get(id) || 0
      : [...state.unread.values(), ...state.groupUnread.values()].reduce((a, b) => a + b, 0)),
    // 好友列表变化后（例如被删除好友）刷新输入框状态
    // 好友动态重新读取后（好友、评论有变化）：刷新输入框状态、明信片上的评论数和正在看的评论
    friendsChanged: () => {
      if (!box.hidden) { renderCompose(); if (state.conv) renderList(); }
      if (state.viewing) loadViewComments();
      if (state.sheet) renderSheet();
    },
  };
}
