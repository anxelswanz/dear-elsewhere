// 先按本机缓存设好主题，避免打开时闪一下默认配色；登录后再以账号里的设置为准（src/settings.js）
// 单独成文件而不是内联：生产环境的 CSP 不允许内联脚本（见 public/_headers）
try {
  var theme = localStorage.getItem('mymap:theme');
  if (/^(airmail|coast|forest|darkroom|night)$/.test(theme)) document.documentElement.dataset.theme = theme;
} catch (e) { /* 隐私模式 */ }
