// 界面语言：简体中文 / English
// 每条文字写成 [中文, English]；English 可以是函数，用来处理单复数。
// 切换语言会整页刷新：地图上的地名、已渲染的面板都按新语言重画，最省心也最不容易漏。
const KEY = 'mymap:lang';
export const LANGS = [['zh', '中文'], ['en', 'English']];

export const lang = (() => {
  try {
    const saved = localStorage.getItem(KEY);
    if (LANGS.some(([id]) => id === saved)) return saved;
  } catch { /* 隐私模式 */ }
  return /^zh/i.test(navigator.language || '') ? 'zh' : 'en';
})();
document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';

export function setLang(next) {
  if (next === lang) return;
  try { localStorage.setItem(KEY, next); } catch { /* 隐私模式 */ }
  location.reload();
}

const s = n => (n === 1 ? '' : 's');

const DICT = {
  // ---------- 通用 ----------
  appTitle: ['Dear Elsewhere · 致远方', 'Dear Elsewhere'],
  brand: ['Dear Elsewhere', 'Dear Elsewhere'],
  brandSub: ['致远方 · 旅行手账', 'A travel journal'],
  postmarkRing: ['DEAR ELSEWHERE ✦ 致远方 ✦ DEAR ELSEWHERE ✦', 'DEAR ELSEWHERE ✦ PAR AVION ✦ DEAR ELSEWHERE ✦'],
  loading: ['加载中…', 'Loading…'],
  close: ['关闭（Esc）', 'Close (Esc)'],
  friends: ['好友', 'Friends'],
  feed: ['动态', 'Feed'],
  footprints: ['足迹', 'Map'],
  profile: ['个人资料', 'Profile'],
  here: ['当前位置', 'Location'],
  mainNav: ['主导航', 'Main'],
  world: ['世界', 'World'],
  unnamed: ['未命名地点', 'Untitled place'],
  unknownArea: ['未知地区', 'Unknown area'],
  language: ['语言', 'Language'],
  opFailed: ['操作失败：{msg}', 'Something went wrong: {msg}'],
  saveFailed: ['保存失败：{msg}', 'Could not save: {msg}'],

  // ---------- 层级 ----------
  'level.world': ['世界', 'World'],
  'level.country': ['国家', 'Country'],
  'level.region': ['省 / 州', 'Region'],
  'level.city': ['城市', 'City'],
  'level.place': ['地点', 'Place'],

  // ---------- 我的足迹面板 ----------
  searchPlaceholder: ['搜索国家、城市或地点', 'Search countries, cities or places'],
  searchTitle: ['可以搜具体地点，如 King\'s College Chapel', 'You can search specific places, e.g. King\'s College Chapel'],
  searchPlaces: ['具体地点', 'Places'],
  searching: ['搜索中…', 'Searching…'],
  notFound: ['没有找到', 'No results'],
  exportBackup: ['导出备份', 'Export'],
  importBackup: ['导入备份', 'Import'],
  backUp: ['返回上一级', 'Back'],
  backHome: ['回到我的足迹首页', 'Back to home'],
  trailHome: ['我的足迹', 'Home'],
  trailLabel: ['返回', 'Back'],
  statCountries: ['国家', 'Countries'],
  statCities: ['城市', 'Cities'],
  statPlaces: ['地点', 'Places'],
  statPhotos: ['照片', 'Photos'],
  hintWorld: ['点地图上的国家逐级进入省份、城市；在城市里点击地图任意位置即可打卡。', 'Click a country to drill into regions and cities; inside a city, click anywhere on the map to check in.'],
  hintCity: ['在地图上点击任意位置，即可添加景点、餐厅等具体地点。', 'Click anywhere on the map to add a sight, a restaurant or any other place.'],
  archive: ['足迹档案', 'Archive'],
  archivePath: ['国家 › 地区 › 城市 › 地点', 'Country › Region › City › Place'],
  sumCities: ['{n} 城', n => `${n} cit${n === 1 ? 'y' : 'ies'}`],
  sumPlaces: ['{n} 地点', n => `${n} place${s(n)}`],
  regionsSub: ['{n} 个省/州，去过 {v} 个', (n, v) => `${n} region${s(n)}, ${v} visited`],
  citiesSub: ['{n} 个城市，去过 {v} 个', (n, v) => `${n} cit${n === 1 ? 'y' : 'ies'}, ${v} visited`],
  placesSub: ['{n} 个打卡地点', n => `${n} place${s(n)} checked in`],
  noPlacesYet: ['还没有打卡地点', 'No places yet'],
  noCities: ['这里没有收录城市，放大地图后可直接点击打卡', 'No cities listed here — zoom in and click the map to check in'],
  noPlaces: ['还没有具体地点', 'No places yet'],
  sectionRegions: ['省 / 州', 'Regions'],
  sectionCities: ['城市', 'Cities'],
  sectionPlaces: ['打卡地点', 'Places'],
  visited: ['已去过', 'Visited'],
  markVisited: ['标记去过', 'Mark visited'],
  photosNotes: ['照片和备注', 'Photos & notes'],
  emptyTitle: ['还没有寄出的明信片', 'No postcards sent yet'],
  emptySub: ['点击地图上的国家，开始收集你的足迹', 'Click a country on the map to start collecting footprints'],
  confirmUnmark: ['取消标记会同时删除这条打卡的照片和备注，确定吗？', 'Unmarking also deletes the photos and notes of this check-in. Continue?'],

  // ---------- 地图 ----------
  'base.gaode': ['高德地图', 'AMap'],
  'base.gaodeSat': ['高德卫星', 'AMap Satellite'],
  'base.intl': ['国际地图', 'World Street Map'],
  checkInHere: ['打卡这个地点', 'Check in here'],
  addPlaceHere: ['在这里添加一个具体地点', 'Add a place here'],
  checkIn: ['打卡', 'Check in'],
  shotButton: ['截图', 'Snapshot'],
  shotTitle: ['把当前画面冲印成一张图', 'Print this view as an image'],
  friendsShow: ['在地图上显示好友的足迹', 'Show friends on the map'],
  friendsHide: ['隐藏好友的足迹', 'Hide friends on the map'],

  // ---------- 明信片编辑器 ----------
  addPhotos: ['添加照片', 'Add photos'],
  dropPhotos: ['或直接拖到明信片上', 'or drop them on the postcard'],
  namePlaceholder: ['给这里起个名字', 'Name this place'],
  notePlaceholder: ['写给这里的一句话…', 'A line for this place…'],
  changeDate: ['修改日期', 'Change date'],
  dateLabel: ['打卡日期', 'Visit date'],
  markerTitle: ['ON THE MAP · 地图上的样子', 'ON THE MAP'],
  markerLabel: ['牌子上的文字', 'Text on the sign'],
  useName: ['改回地名', 'Use place name'],
  markerIcon: ['插在地图上的图标', 'Icon on the map'],
  iconGroup: ['图标', 'Icon'],
  delete: ['删除', 'Delete'],
  autosaved: ['✓ 已自动保存', '✓ Saved'],
  done: ['收进足迹 →', 'Keep it →'],
  doneSend: ['收进足迹 · 寄给好友 →', 'Keep & send to friends →'],
  deletePostcard: ['删除这张明信片', 'Delete this postcard'],
  unmark: ['取消标记', 'Unmark'],
  labelDefault: ['默认显示地名：{name}', 'Defaults to the place name: {name}'],
  markerHintPhotos: ['有照片时，地图上显示照片叠放；下面的样式在没有照片时使用', 'With photos, the map shows a photo stack; these styles are used when there are none'],
  markerHint: ['选一个喜欢的样式，地图上会显示名字和到达日期', 'Pick a style — the map shows the name and the date you arrived'],
  photoStackCurrent: ['照片叠放 · 当前', 'Photo stack · current'],
  cover: ['封面', 'Cover'],
  setCover: ['设为封面', 'Set as cover'],
  deletePhoto: ['删除照片', 'Delete photo'],
  confirmDeletePhoto: ['删除这张照片？', 'Delete this photo?'],
  confirmDeleteRecord: ['确定删除「{name}」及其所有照片吗？', 'Delete “{name}” and all its photos?'],
  developing: ['冲洗中…', 'Developing…'],
  cannotRead: ['无法读取图片：{name}', 'Could not read image: {name}'],
  sentToFriends: ['明信片已寄给 {n} 位好友', n => `Postcard sent to ${n} friend${s(n)}`],
  keptNoFriends: ['已收进足迹 · 加了好友后，他们就能看到这张明信片', 'Kept · once you add friends, they will see this postcard'],
  'style.sign': ['路牌', 'Sign'],
  'style.flag': ['旗帜', 'Flag'],
  'style.neon': ['霓虹', 'Neon'],
  'style.stamp': ['印章', 'Stamp'],
  'style.pin': ['图钉', 'Pin'],
  'icon.pin': ['定位', 'Pin'], 'icon.heart': ['喜欢', 'Love'], 'icon.star': ['推荐', 'Star'], 'icon.camera': ['拍照', 'Photo'],
  'icon.coffee': ['咖啡', 'Coffee'], 'icon.food': ['美食', 'Food'], 'icon.museum': ['博物馆', 'Museum'], 'icon.church': ['教堂', 'Church'],
  'icon.castle': ['城堡', 'Castle'], 'icon.mountain': ['山', 'Mountain'], 'icon.beach': ['海边', 'Beach'], 'icon.tree': ['公园', 'Park'],
  'icon.shop': ['购物', 'Shopping'], 'icon.bed': ['住宿', 'Stay'], 'icon.plane': ['机场', 'Airport'], 'icon.train': ['车站', 'Station'],

  // ---------- 同步 / 备份 ----------
  syncOffline: ['离线 · {n} 条待上传', n => `Offline · ${n} to upload`],
  syncOfflineIdle: ['离线 · 联网后自动同步', 'Offline · will sync when online'],
  syncing: ['正在同步…', 'Syncing…'],
  syncError: ['同步失败，稍后自动重试', 'Sync failed, retrying soon'],
  syncPending: ['{n} 条待上传', n => `${n} to upload`],
  syncedAt: ['已同步到云端 · {t}', 'Synced · {t}'],
  synced: ['已同步到云端', 'Synced'],
  backupName: ['dear-elsewhere', 'dear-elsewhere'],
  confirmImport: ['导入 {n} 条打卡。\n确定 = 覆盖现有数据；取消 = 合并到现有数据', n => `Import ${n} check-in${s(n)}.\nOK = replace existing data; Cancel = merge`],
  importFailed: ['导入失败：文件格式不正确', 'Import failed: invalid file'],
  legacyTitle: ['这台设备上有你之前的足迹', 'Found earlier footprints on this device'],
  legacyBody: ['共 {n} 条打卡、{p} 张照片。存进 <em>@{handle}</em> 的账号后，会同步到云端，换设备也能看到。',
    (n, p, handle) => `${n} check-in${s(n)} and ${p} photo${s(p)}. Save them to <em>@${handle}</em> to sync them to the cloud and see them on any device.`],
  legacyOk: ['存进我的账号', 'Save to my account'],
  legacyCancel: ['先不用，以后可以用「导入备份」', 'Not now — you can use “Import” later'],

  // ---------- 截图 ----------
  darkroom: ['DARKROOM · 冲印这一页足迹', 'DARKROOM · PRINT THIS PAGE'],
  shotPreview: ['地图截图预览', 'Snapshot preview'],
  ratio: ['比例', 'Ratio'],
  portrait: ['竖版', 'Portrait'],
  square: ['方形', 'Square'],
  story: ['故事', 'Story'],
  saveImage: ['保存图片', 'Save image'],

  // ---------- 登录 / 注册 ----------
  'au.loginLead': ['欢迎回来。登录后继续点亮你的地图。', 'Welcome back. Sign in to keep lighting up your map.'],
  'au.signupLead': ['注册一个账号，开始收集你去过的地方。', 'Create an account and start collecting the places you\'ve been.'],
  'au.forgotLead': ['输入注册时的邮箱，我们会寄一封重置密码的信。', 'Enter your email and we\'ll send you a link to reset your password.'],
  'au.resetLead': ['设置一个新密码。', 'Choose a new password.'],
  'au.login': ['登录', 'Sign in'],
  'au.signup': ['注册', 'Sign up'],
  'au.sendReset': ['发送重置链接', 'Send reset link'],
  'au.saveNew': ['保存新密码', 'Save password'],
  'au.email': ['邮箱 · Email', 'Email'],
  'au.password': ['密码 · Password', 'Password'],
  'au.newPassword': ['新密码 · Password', 'New password'],
  'au.confirm': ['再输一次 · Confirm', 'Confirm password'],
  'au.min6': ['至少 6 位', 'At least 6 characters'],
  'au.noConfig': ['还没有连接 Supabase', 'Supabase is not connected'],
  'au.noConfigBody': ['把项目根目录的 <code>.env.example</code> 复制为 <code>.env.local</code>，填上 Project URL 和 key，然后重启 <code>npm run dev</code>。',
    'Copy <code>.env.example</code> to <code>.env.local</code>, fill in the Project URL and key, then restart <code>npm run dev</code>.'],
  'au.checkEmail': ['请查收验证邮件', 'Check your inbox'],
  'au.checkEmailBody': ['我们给 <em>{email}</em> 寄了一封信，点开其中的链接即可完成注册。', 'We sent a letter to <em>{email}</em>. Open the link inside to finish signing up.'],
  'au.resend': ['没收到？重新发送', 'Didn\'t get it? Resend'],
  'au.resent': ['已重新发送，请查收', 'Sent again — check your inbox'],
  'au.backToLogin': ['返回登录', 'Back to sign in'],
  'au.forgot': ['忘记密码？', 'Forgot password?'],
  'au.forgotTitle': ['找回密码', 'Reset password'],
  'au.resetTitle': ['重置密码', 'New password'],
  'au.resetSent': ['重置链接已寄到 {email}，请查收邮件。', 'A reset link is on its way to {email}.'],
  'au.loadFailed': ['读取资料失败：{msg}', 'Could not load your profile: {msg}'],
  'err.credentials': ['邮箱或密码不对', 'Wrong email or password'],
  'err.notConfirmed': ['邮箱还没有验证，请先点开验证邮件里的链接', 'Please confirm your email first — open the link in the verification email'],
  'err.exists': ['这个邮箱已经注册过了，请直接登录', 'This email is already registered — please sign in'],
  'err.weak': ['密码太简单了，请换一个更长的', 'That password is too weak — try a longer one'],
  'err.same': ['新密码不能和原来的一样', 'The new password must be different'],
  'err.rate': ['操作太频繁了，请稍后再试', 'Too many attempts — please try again later'],
  'err.network': ['连不上服务器，请检查网络', 'Cannot reach the server — check your connection'],
  'err.unknown': ['出错了，请稍后再试', 'Something went wrong — please try again'],
  'err.emailFormat': ['邮箱格式不对', 'That doesn\'t look like an email'],
  'err.pw6': ['密码至少 6 位', 'Password needs at least 6 characters'],
  'err.pwMatch': ['两次输入的密码不一样', 'Passwords don\'t match'],

  // ---------- 护照 ----------
  'pp.kicker': ['旅行护照 · TRAVEL PASSPORT', 'TRAVEL PASSPORT'],
  'pp.create': ['签发你的旅行护照', 'Issue your travel passport'],
  'pp.edit': ['编辑护照资料', 'Edit your passport'],
  'pp.photoAlt': ['已选头像', 'Selected avatar'],
  'pp.random': ['随机换一个', 'Shuffle'],
  'pp.handle': ['ID', 'ID'],
  'pp.handleEn': ['Passport No.', 'Passport No.'],
  'pp.handlePh': ['例如 ronghui_z', 'e.g. ronghui_z'],
  'pp.name': ['名字', 'Name'],
  'pp.nameEn': ['Name', ''],
  'pp.namePh': ['好友看到的名字', 'The name friends will see'],
  'pp.country': ['国家', 'Nationality'],
  'pp.countryEn': ['Nationality', ''],
  'pp.countryPh': ['输入搜索，如 中国、Japan', 'Type to search, e.g. Japan'],
  'pp.noCountry': ['没有找到这个国家', 'No matching country'],
  'pp.birthday': ['生日', 'Date of birth'],
  'pp.birthdayEn': ['Date of birth', ''],
  'pp.birthdayNote': ['选填，仅自己可见', 'Optional · only you can see it'],
  'pp.avatars': ['选一位旅伴当头像', 'Pick a travel companion'],
  'pp.avatarGroup': ['头像', 'Avatar'],
  'pp.switch': ['换个账号', 'Use another account'],
  'pp.cancel': ['取消', 'Cancel'],
  'pp.issue': ['签发护照', 'Issue passport'],
  'pp.save': ['保存修改', 'Save changes'],
  'pp.hint': ['{min}–{max} 位小写字母、数字或下划线，好友靠它找到你', '{min}–{max} lowercase letters, digits or _ — friends find you by it'],
  'pp.short': ['太短了，至少 {min} 位', 'Too short — at least {min} characters'],
  'pp.invalid': ['只能用小写字母、数字和下划线', 'Only lowercase letters, digits and _'],
  'pp.checking': ['正在查询…', 'Checking…'],
  'pp.taken': ['这个 ID 已经有人用了', 'This ID is taken'],
  'pp.free': ['可以使用', 'Available'],
  'pp.mine': ['好友靠这个 ID 找到你', 'Friends find you by this ID'],
  'pp.locked': ['30 天内只能修改一次，{date} 后可再改', 'Can be changed once every 30 days — next change after {date}'],
  'pp.length': ['ID 需要 {min}–{max} 位', 'ID must be {min}–{max} characters'],
  'pp.needHandle': ['请先填一个可用的 ID', 'Please choose an available ID'],
  'pp.needName': ['请填写名字', 'Please enter a name'],
  'pp.needCountry': ['请从候选里选择国家', 'Please pick a country from the list'],
  'pp.badBirthday': ['生日不太对', 'That birthday doesn\'t look right'],
  'pp.justTaken': ['这个 ID 刚刚被别人用了，换一个吧', 'Someone just took this ID — try another'],
  'pp.birthdayFailed': ['生日保存失败：{msg}', 'Could not save birthday: {msg}'],

  // ---------- 头像面板 ----------
  'me.guest': ['旅行者', 'Traveller'],
  'me.signedOut': ['尚未登录', 'Not signed in'],
  'me.public': ['足迹地图对好友公开', 'Share my full map with friends'],
  'me.publicOn': ['好友可以查看你的完整足迹地图', 'Friends can see your whole map'],
  'me.publicOff': ['好友只能看到你带照片的动态', 'Friends only see postcards with photos'],
  'me.edit': ['编辑资料', 'Edit profile'],
  'me.signout': ['退出登录', 'Sign out'],
  'me.inbox': ['收到的评论', 'Comments for you'],
  'me.commented': ['评论了「{title}」', 'commented on “{title}”'],
  'me.myPostcard': ['我的明信片', 'my postcard'],

  // ---------- 好友 / 动态 ----------
  'ago.now': ['刚刚', 'just now'],
  'ago.min': ['{n} 分钟前', n => `${n} min ago`],
  'ago.hour': ['{n} 小时前', n => `${n} h ago`],
  'ago.day': ['{n} 天前', n => `${n} day${s(n)} ago`],
  'fr.self': ['这是你自己', 'That\'s you'],
  'fr.already': ['已经是好友', 'Already friends'],
  'fr.pending': ['已发送申请，等待对方确认', 'Request sent — waiting for them'],
  'fr.acceptTheirs': ['接受 TA 的申请', 'Accept their request'],
  'fr.request': ['发送好友申请', 'Send friend request'],
  'fr.handlePh': ['输入好友的 ID', 'Friend\'s ID'],
  'fr.find': ['查找', 'Find'],
  'fr.overlay': ['在地图上显示好友的足迹', 'Show friends on my map'],
  'fr.overlaySub': ['好友的明信片会叠加在你的地图上', 'Friends\' postcards appear on your map'],
  'fr.onlyOne': ['只看 {name}', 'Only {name}'],
  'fr.showAll': ['看全部好友', 'show all'],
  'fr.requests': ['好友申请', 'Requests'],
  'fr.accept': ['接受', 'Accept'],
  'fr.ignore': ['忽略', 'Ignore'],
  'fr.waiting': ['等待对方确认', 'Pending'],
  'fr.withdraw': ['撤回', 'Withdraw'],
  'fr.mine': ['我的好友', 'My friends'],
  'fr.onlyTitle': ['在地图上只看 TA 的足迹', 'Show only their map'],
  'fr.remove': ['删除', 'Remove'],
  'fr.removeTitle': ['删除好友', 'Remove friend'],
  'fr.publicMap': ['地图公开', 'Public map'],
  'fr.none': ['还没有好友', 'No friends yet'],
  'fr.noneSub': ['输入对方的 ID 发送申请，通过后就能互相看到明信片', 'Send a request by ID — once accepted, you\'ll see each other\'s postcards'],
  'fr.badHandle': ['ID 是 3–20 位小写字母、数字或下划线', 'IDs are 3–20 lowercase letters, digits or _'],
  'fr.lookupFailed': ['查找失败：{msg}', 'Search failed: {msg}'],
  'fr.notFound': ['没有找到 @{h}', 'No one called @{h}'],
  'fr.confirmRemove': ['删除好友 {name}（@{handle}）？删除后你们将互相看不到对方的明信片。', 'Remove {name} (@{handle})? You will no longer see each other\'s postcards.'],
  'feed.subtitle': ['Postcards from friends', 'Postcards from friends'],
  'feed.me': ['我', 'Me'],
  'feed.fly': ['在地图上查看', 'Show on map'],
  'feed.photo': ['查看大图', 'View photo'],
  'feed.more': ['查看全部 {n} 条评论', n => `View all ${n} comments`],
  'feed.friend': ['好友', 'Friend'],
  'feed.deleteComment': ['删除评论', 'Delete comment'],
  'feed.reply': ['写一句评论…', 'Add a comment…'],
  'feed.send': ['发送', 'Send'],
  'feed.empty': ['信箱还是空的', 'Your mailbox is empty'],
  'feed.emptySub': ['你和好友带照片打卡、点「收进足迹」后，明信片会寄到这里', 'Postcards with photos from you and your friends land here'],
  'feed.emptyGuest': ['好友带照片打卡后，明信片会寄到这里', 'Friends\' postcards with photos land here'],
  'feed.commentFailed': ['评论失败：{msg}', 'Could not post comment: {msg}'],
  'feed.confirmDelete': ['删除这条评论？', 'Delete this comment?'],
  'fr.noneGuest': ['登录后输入对方的 ID，就能互相看到足迹', 'Sign in and add friends by their ID'],

  // ---------- 私聊 ----------
  'chat.open': ['聊天', 'Chat'],
  'chat.kicker': ['PAR AVION · 航空信', 'PAR AVION · AIRMAIL'],
  'chat.posted': ['寄出', 'POSTED'],
  'chat.placeholder': ['写点什么…', 'Write something…'],
  'chat.send': ['发送（回车）', 'Send (Enter)'],
  'chat.emoji': ['表情', 'Emoji'],
  'chat.share': ['转发我的打卡', 'Share a check-in'],
  'chat.pickTitle': ['选一张带照片的打卡转发给 TA', 'Pick a check-in with photos to share'],
  'chat.pickEmpty': ['还没有带照片的打卡，先去打一张卡吧', 'No check-ins with photos yet'],
  'chat.uploading': ['照片还在上传，稍等一下再转发', 'Photos are still uploading — try again in a moment'],
  'chat.sharedCheckin': ['[打卡] 转发了一张明信片', '[Check-in] shared a postcard'],
  'chat.viewCheckin': ['查看这次打卡', 'View this check-in'],
  'chat.sharedBy': ['{name} 转发的打卡', 'Shared by {name}'],
  'chat.sharedByMe': ['我转发的打卡', 'Shared by me'],
  'chat.earlier': ['查看更早的消息', 'Load earlier messages'],
  'chat.empty': ['和 {name} 打个招呼吧', 'Say hi to {name}'],
  'chat.emptySub': ['可以发 emoji，也可以把你的打卡转发给 TA', 'Send emoji, or share one of your check-ins'],
  'chat.today': ['今天', 'Today'],
  'chat.yesterday': ['昨天', 'Yesterday'],
  'chat.sending': ['发送中…', 'Sending…'],
  'chat.read': ['已读', 'Read'],
  'chat.unread': ['未读', 'Unread'],
  'chat.readAt': ['{time} 已读', 'Read at {time}'],
  'chat.unreadTitle': ['对方还没有看', 'Not read yet'],
  'chat.failed': ['发送失败：{msg}', 'Could not send: {msg}'],
  'chat.failedShort': ['发送失败', 'Not sent'],
  'chat.loadFailed': ['读取消息失败：{msg}', 'Could not load messages: {msg}'],
  'chat.notFriend': ['你们已经不是好友，不能再发送消息', 'You\'re no longer friends and can\'t send messages'],
  'chat.newFrom': ['{name}：{text}', '{name}: {text}'],

  // ---------- 旅程 ----------
  'jr.button': ['旅程', 'Journeys'],
  'jr.title': ['旅程', 'Journeys'],
  'jr.stats': ['{s} 站 · {l} 段 · {km} 公里', (s, l, km) => `${s} stops · ${l} leg${l === 1 ? '' : 's'} · ${km} km`],
  'jr.showLines': ['在地图上显示航线', 'Show routes on the map'],
  'jr.tip': ['点航线中间的交通工具可以切换', 'Tap a vehicle on a route to switch it'],
  'jr.play': ['回放 {y} 年的旅程', 'Replay {y}'],
  'jr.empty': ['在两个不同的城市打卡后，这里会出现你的旅程', 'Check in to two different cities to start a journey'],
  'jr.emptyYear': ['这一年还没有跨城市的旅程', 'No trips between cities this year'],
  'jr.hud': ['{y} · 第 {i}/{n} 段', '{y} · leg {i} of {n}'],
  'jr.pause': ['暂停', 'Pause'],
  'jr.resume': ['继续', 'Resume'],
  'jr.stop': ['停止回放', 'Stop'],
  'jr.switch': ['{mode} · 点击切换交通工具', '{mode} · click to switch'],
  'jr.changed': ['{from} → {to} 改为{mode}', '{from} → {to} by {mode}'],
  'jr.mode.plane': ['飞机', 'plane'],
  'jr.mode.ship': ['轮船', 'ship'],
  'jr.mode.train': ['火车', 'train'],
  'jr.mode.car': ['汽车', 'car'],

  // ---------- 欢迎动画 ----------
  'wl.loginRing': ['WELCOME BACK ✦ 欢迎回来 ✦ WELCOME BACK ✦ 欢迎回来 ✦', 'WELCOME BACK ✦ BON RETOUR ✦ WELCOME BACK ✦ BON RETOUR ✦'],
  'wl.loginTitle': ['欢迎回来，{name}', 'Welcome back, {name}'],
  'wl.loginSub': ['@{handle} · 继续点亮你的地图', '@{handle} · keep lighting up your map'],
  'wl.signupRing': ['PASSPORT ISSUED ✦ 护照已签发 ✦ PASSPORT ISSUED ✦ 护照已签发 ✦', 'PASSPORT ISSUED ✦ BON VOYAGE ✦ PASSPORT ISSUED ✦ BON VOYAGE ✦'],
  'wl.signupTitle': ['欢迎加入，{name}', 'Welcome aboard, {name}'],
  'wl.signupSub': ['旅行护照 No. {no} 已签发 · 去打下第一张卡吧', 'Passport No. {no} issued · go check in your first place'],
  'wl.skip': ['点击任意处继续', 'Click anywhere to continue'],
};

// t('key', { n: 3 })：中文用 {n} 占位；英文若是函数，按占位符出现的顺序传参
export function t(key, vars = {}) {
  const entry = DICT[key];
  if (!entry) return key;
  const text = entry[lang === 'zh' ? 0 : 1];
  if (typeof text === 'function') return text(...Object.values(vars));
  return text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

// 静态 HTML：data-i18n="key" 替换文字，data-i18n-attr="placeholder:key title:key" 替换属性
export function applyStatic(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of el.dataset.i18nAttr.split(/\s+/)) {
      const [attr, key] = pair.split(':');
      el.setAttribute(attr, t(key));
    }
  }
  document.title = t('appTitle');
}

// 地名：英文界面用英文名，没有英文名的（如中国的区县）保留中文
export const localName = (zh, en) => (lang === 'en' && en ? en : zh);

// 语言切换按钮（登录页和头像面板共用）
export const langSwitch = cls => `<div class="lang-switch ${cls || ''}" role="radiogroup" aria-label="${t('language')} · Language">
  ${LANGS.map(([id, label]) => `<button type="button" role="radio" data-lang="${id}" aria-checked="${id === lang}">${label}</button>`).join('')}
</div>`;

document.addEventListener('click', e => {
  const b = e.target.closest('[data-lang]');
  if (b) setLang(b.dataset.lang);
});
