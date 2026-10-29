// 官网（/）：邮件里的登录链接（邀请、改邮箱等没有指定回调地址的）会落到 Site URL，也就是官网首页。
// 带着登录凭证或错误信息来的，原样转交给软件（/app/）处理；普通访问不受影响。
// 单独成文件、在 <head> 里同步执行：CSP 不允许内联脚本，也避免先闪一下官网
(function () {
  var hash = location.hash, query = location.search;
  if (/(^|[#&])(access_token|refresh_token|error_description|error_code)=/.test(hash) || /[?&](code|token_hash|error_description)=/.test(query)) {
    location.replace('/app/' + query + hash);
  }
})();
