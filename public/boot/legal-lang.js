// 隐私政策页：按 ?lang=、上次选择或浏览器语言显示中文或英文（在 <head> 里同步执行，避免闪烁）
(function () {
  var q = new URLSearchParams(location.search).get('lang'), saved = null;
  try { saved = localStorage.getItem('mymap:lang'); } catch (e) { /* 隐私模式 */ }
  var l = q || saved || (/^zh/i.test(navigator.language || '') ? 'zh' : 'en');
  document.documentElement.dataset.show = l === 'en' ? 'en' : 'zh';
  document.documentElement.lang = l === 'en' ? 'en' : 'zh-CN';
})();
