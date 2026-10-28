// 好友私聊
//   · 从好友列表点「聊天」打开对话窗：桌面是右下角的信笺，手机铺满全屏
//   · 可以发文字和 emoji，也可以转发自己的一次打卡（发送时存快照，照片读发送者的私有目录）
//   · 好友点开转发的打卡能看全部照片、地址和留言，还能飞到地图上
//   · 未读数显示在好友列表和「好友」红点上；对话窗开着时新消息直接标记已读
// 数据权限见 supabase/migrations/0004_chat.sql
import { supabase } from './supabase.js';
import { avatarUrl } from './auth.js';
import { t, lang } from './i18n.js';

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
const clock = at => new Date(at).toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en', { hour: '2-digit', minute: '2-digit' });

// me: { id }；social：好友资料与照片签名；helpers 由地图提供：
//   myRecords() 自己的本地记录；localPhotoUrl(photo) 本地照片；placeText(row) 行政区路径；
//   showPhoto(url) 大图；flyTo(row) 飞到地图上；toast(text)；requestSync() 立即同步（让照片尽快上传）
export function initChat({ me, social, helpers }) {
  const state = {
    peer: null,          // 正在聊天的好友 id
    messages: [],        // 当前对话，时间正序
    more: false,         // 还有更早的消息
    unread: new Map(),   // 好友 id -> 未读数
    tray: null,          // 'emoji' | 'checkin' | null
    viewing: null,       // 正在查看的转发打卡消息
  };
  const thumbs = new Map(); // 存储路径 -> 签名链接
  const justRead = new Set(); // 刚变成已读的消息，播一次盖章动画

  document.body.insertAdjacentHTML('beforeend', `
    <section id="chat" hidden role="dialog" aria-labelledby="chatName">
      <header class="ch-head">
        <span class="ch-stamp" id="chatAvatar"></span>
        <span class="person-text"><em class="ch-kicker">${t('chat.kicker')}</em><b id="chatName"></b><small id="chatHandle"></small></span>
        <button class="ch-x" data-chat-close title="${t('close')}">${icon('close')}</button>
      </header>
      <div class="ch-list" id="chatList" aria-live="polite"></div>
      <div class="ch-tray" id="chatTray" hidden></div>
      <p class="ch-gone" id="chatGone" hidden>${t('chat.notFriend')}</p>
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
    for (const m of data) if (m.sender !== state.peer || box.hidden) state.unread.set(m.sender, (state.unread.get(m.sender) || 0) + 1);
    social.refresh();
  }

  async function markRead(peer) {
    if (!state.unread.has(peer) && !state.messages.some(m => m.sender === peer && !m.read_at)) return;
    state.unread.delete(peer);
    social.refresh();
    const { error } = await supabase.rpc('mark_read', { peer });
    if (error) console.warn('标记已读失败', error);
  }

  // ---------- 读取对话 ----------
  const pairFilter = peer => `and(sender.eq.${me.id},recipient.eq.${peer}),and(sender.eq.${peer},recipient.eq.${me.id})`;

  async function fetchPage(peer, before) {
    let q = supabase.from('messages').select('*').or(pairFilter(peer)).order('created_at', { ascending: false }).limit(PAGE);
    if (before) q = q.lt('created_at', before);
    const { data, error } = await q;
    if (error) throw error;
    await signThumbs(data);
    return data.reverse();
  }

  // 转发打卡的缩略图：发送者目录里的 {照片 id}_t.jpg
  async function signThumbs(msgs) {
    const paths = msgs.filter(m => m.kind === 'checkin').flatMap(m => m.checkin.photos.slice(0, 3).map(pid => `${m.sender}/${pid}_t.jpg`))
      .filter(p => !thumbs.has(p));
    if (!paths.length) return;
    const urls = await social.photoUrls(paths);
    paths.forEach((p, i) => urls[i] && thumbs.set(p, urls[i]));
  }

  async function open(peer) {
    const p = social.author(peer);
    if (!p) return;
    const switching = state.peer !== peer;
    state.peer = peer;
    if (switching) { state.messages = []; state.more = false; setTray(null); input.value = ''; }
    $('#chatAvatar').innerHTML = `<img src="${avatarUrl(p.avatar || 'a01')}" alt="" />`;
    $('#chatName').textContent = p.name;
    $('#chatHandle').textContent = `@${p.handle}`;
    box.hidden = false;
    renderCompose();
    if (switching) list.innerHTML = `<p class="ch-note">${t('loading')}</p>`;
    if (!matchMedia('(max-width: 700px)').matches) input.focus();
    try {
      const msgs = await fetchPage(peer);
      if (state.peer !== peer) return;
      state.messages = msgs;
      state.more = msgs.length === PAGE;
      renderList({ toBottom: true, enter: true });
      markRead(peer);
    } catch (err) {
      list.innerHTML = `<p class="ch-note">${escapeHtml(t('chat.loadFailed', { msg: err.message }))}</p>`;
    }
  }

  function close() {
    box.hidden = true;
    state.peer = null;
    setTray(null);
  }

  async function loadEarlier() {
    const peer = state.peer;
    const oldest = state.messages[0]?.created_at;
    try {
      const msgs = await fetchPage(peer, oldest);
      if (state.peer !== peer) return;
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
        <span class="ch-ci-meta">${c.date ? `<time>${escapeHtml(c.date.replaceAll('-', '.'))}</time>` : ''}<i>${icon('camera')}${c.photos.length}</i></span>
      </span>
    </button>`;
  }

  // 自己发出的消息：未读 / 已读（同一组消息只在最后一条下面显示）
  function receipt(m) {
    if (m.pending || m.failed) return '';
    const read = !!m.read_at;
    const pop = read && justRead.has(m.id) ? ' pop' : '';
    return `<span class="ch-receipt ${read ? 'read' : 'unread'}${pop}" title="${read ? t('chat.readAt', { time: clock(m.read_at) }) : t('chat.unreadTitle')}">${
      icon(read ? 'read' : 'sent')}${t(read ? 'chat.read' : 'chat.unread')}</span>`;
  }

  // enter：刚打开对话，最近几条依次落下；fresh：这条刚到，单独做一次到达动画
  function renderList({ toBottom = false, enter = false, fresh = null } = {}) {
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    let html = state.more ? `<button class="ch-earlier" data-earlier>${t('chat.earlier')}</button>` : '';
    if (!state.messages.length) {
      const p = social.author(state.peer);
      html += `<div class="ch-empty"><span>👋</span><b>${escapeHtml(t('chat.empty', { name: p?.name || '' }))}</b><small>${t('chat.emptySub')}</small></div>`;
    }
    let lastDay = null;
    state.messages.forEach((m, i) => {
      if (dayKey(m.created_at) !== lastDay) {
        lastDay = dayKey(m.created_at);
        html += `<p class="ch-day"><span class="ch-postmark"><small>${t('chat.posted')}</small>${dayLabel(m.created_at)}</span></p>`;
      }
      const mine = m.sender === me.id;
      const next = state.messages[i + 1];
      const tail = !next || next.sender !== m.sender || dayKey(next.created_at) !== lastDay;
      const content = m.kind === 'checkin' ? checkinCard(m) + (m.body ? `<p class="ch-bubble">${escapeHtml(m.body)}</p>` : '')
        : bigEmoji(m.body) ? `<p class="ch-emoji">${escapeHtml(m.body.trim())}</p>`
        : `<p class="ch-bubble">${escapeHtml(m.body)}</p>`;
      const back = state.messages.length - 1 - i;
      const motion = enter && back < 10 ? ` enter" style="--i: ${9 - back}` : m.id === fresh ? ' arrive' : '';
      html += `<div class="ch-msg ${mine ? 'mine' : 'theirs'}${tail ? ' tail' : ''}${m.pending ? ' pending' : ''}${m.failed ? ' failed' : ''}${motion}" data-msg="${m.id}">
        ${content}
        ${tail ? `<p class="ch-meta"><time>${m.failed ? t('chat.failedShort') : m.pending ? t('chat.sending') : clock(m.created_at)}</time>${mine ? receipt(m) : ''}</p>` : ''}
      </div>`;
    });
    list.innerHTML = html;
    justRead.clear();
    if (toBottom || nearBottom) list.scrollTop = list.scrollHeight;
  }

  function renderCompose() {
    const gone = state.peer && !social.isFriend(state.peer);
    $('#chatGone').hidden = !gone;
    $('#chatForm').hidden = gone;
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
    return `<p class="ch-tray-title">${t('chat.pickTitle')}</p><ul>${rows.map(r => {
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

  // ---------- 发送 ----------
  async function send(fields) {
    const peer = state.peer;
    const temp = { id: `tmp-${Date.now()}`, sender: me.id, recipient: peer, body: '', checkin: null, kind: 'text', ...fields, created_at: new Date().toISOString(), pending: true };
    state.messages.push(temp);
    await signThumbs([temp]);
    renderList({ toBottom: true, fresh: temp.id });
    const { data, error } = await supabase.from('messages').insert({ recipient: peer, ...fields }).select().single();
    if (state.peer !== peer) return;
    let i = state.messages.indexOf(temp);
    if (i < 0) i = state.messages.push(temp) - 1; // 等待期间对话被重新读取过
    if (error) {
      temp.pending = false;
      temp.failed = true;
      renderList();
      return helpers.toast(t('chat.failed', { msg: error.message }));
    }
    // 实时推送可能先到，避免重复
    if (state.messages.some(m => m.id === data.id)) state.messages.splice(i, 1);
    else state.messages[i] = data;
    renderList();
  }

  function sendText() {
    const body = input.value.trim();
    if (!body || !state.peer) return;
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
    const m = state.messages.find(x => x.id === id);
    if (!m) return;
    state.viewing = m;
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
      </div>`;
    $('#chatView').hidden = false;
  }

  function closeView() {
    $('#chatView').hidden = true;
    state.viewing = null;
  }

  // ---------- 实时 ----------
  function onInsert(m) {
    const inOpenChat = !box.hidden && state.peer && (m.sender === state.peer || m.recipient === state.peer);
    if (inOpenChat) {
      if (state.messages.some(x => x.id === m.id)) return;
      // 自己在别的设备上发的、或刚发出去还在等回执的
      const temp = state.messages.find(x => x.pending && x.sender === m.sender && x.kind === m.kind && x.body === m.body);
      if (temp) state.messages[state.messages.indexOf(temp)] = m;
      else state.messages.push(m);
      signThumbs([m]).then(() => renderList({ fresh: temp ? null : m.id }));
      if (m.recipient === me.id && document.visibilityState === 'visible') markRead(m.sender);
      else if (m.recipient === me.id) { state.unread.set(m.sender, (state.unread.get(m.sender) || 0) + 1); social.refresh(); }
      return;
    }
    if (m.recipient !== me.id) return;
    state.unread.set(m.sender, (state.unread.get(m.sender) || 0) + 1);
    social.refresh();
    const p = social.author(m.sender);
    helpers.toast(t('chat.newFrom', { name: p?.name || t('feed.friend'), text: m.kind === 'checkin' ? t('chat.sharedCheckin') : m.body.slice(0, 40) }));
  }

  function onUpdate(m) {
    const cur = state.messages.find(x => x.id === m.id);
    if (cur && cur.read_at !== m.read_at) {
      if (!cur.read_at && m.read_at) justRead.add(cur.id);
      cur.read_at = m.read_at;
      renderList();
    }
  }

  supabase.channel('chat')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, e => onInsert(e.new))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, e => onUpdate(e.new))
    .subscribe();
  // 回到页面时补上断线期间的消息
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    loadUnread();
    if (state.peer && !box.hidden) open(state.peer);
  });

  // ---------- 事件 ----------
  document.addEventListener('click', e => {
    const el = e.target;
    const chatBtn = el.closest('#drop-friends [data-chat]');
    if (chatBtn) {
      open(chatBtn.closest('[data-person]').dataset.person);
      if (matchMedia('(max-width: 700px)').matches) helpers.closeDrop();
      return;
    }
    if (!el.closest('#chat, #chatView')) return;
    if (el.closest('[data-chat-close]')) return close();
    if (el.closest('[data-earlier]')) return loadEarlier();
    const tray = el.closest('[data-tray]');
    if (tray) return setTray(tray.dataset.tray);
    const emoji = el.closest('[data-emoji]');
    if (emoji) return insertEmoji(emoji.dataset.emoji);
    const pick = el.closest('[data-pick]');
    if (pick) return shareCheckin(pick.dataset.pick);
    const v = el.closest('[data-view]');
    if (v) return view(v.dataset.view);
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

  $('#chatForm').addEventListener('submit', e => { e.preventDefault(); sendText(); });
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', e => {
    // 回车发送，Shift+回车换行；输入法选字时的回车不算
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); sendText(); }
  });
  // 捕获阶段处理，免得地图的 Esc（收起面板、返回上一级）同时生效
  addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !$('#lightbox').hidden) return;
    if (!$('#chatView').hidden) closeView();
    else if (!box.hidden && box.contains(document.activeElement)) state.tray ? setTray(null) : close();
    else return;
    e.stopPropagation();
  }, true);

  loadUnread();

  return {
    open,
    // 不传 id 时为全部未读
    unread: id => (id ? state.unread.get(id) || 0 : [...state.unread.values()].reduce((a, b) => a + b, 0)),
    // 好友列表变化后（例如被删除好友）刷新输入框状态
    friendsChanged: () => !box.hidden && renderCompose(),
  };
}
