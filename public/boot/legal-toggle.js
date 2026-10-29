// 隐私政策页：中英文切换按钮
document.querySelectorAll('[data-set]').forEach(function (b) {
  var sync = function () { b.setAttribute('aria-pressed', String(document.documentElement.dataset.show === b.dataset.set)); };
  sync();
  b.addEventListener('click', function () {
    document.documentElement.dataset.show = b.dataset.set;
    document.documentElement.lang = b.dataset.set === 'en' ? 'en' : 'zh-CN';
    document.querySelectorAll('[data-set]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
  });
});
