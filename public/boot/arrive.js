// 软件页（/app/）：从官网点「进入」过来时，接着播放「寄出航空信」动画的后半段（样式见 src/styles/welcome.css 末尾）
// 官网在跳转前写下时间戳；只认 5 秒内的，免得跳转失败后留下的标记在下次打开时误触发
// 单独成文件、在 <head> 里同步执行：CSP 不允许内联脚本，且必须在第一次绘制前加上 class
(function () {
  try {
    var at = Number(sessionStorage.getItem('de:arrive'));
    sessionStorage.removeItem('de:arrive');
    if (!at || Date.now() - at > 5000) return;
    var root = document.documentElement;
    root.classList.add('de-arrive');
    setTimeout(function () { root.classList.remove('de-arrive'); }, 2000);
  } catch (e) { /* 隐私模式 */ }
})();
