// 生成 Supabase Auth 的邮件模板（航空信样式），输出到 supabase/templates/*.html
// 用法：node scripts/build-emails.mjs，然后把每个文件的内容粘到
// Supabase 控制台 → Authentication → Emails → Templates 里对应的模板，主题见下方 subject。
//
// 邮件客户端不支持外部 CSS、渐变和网页字体，所以全部用表格 + 行内样式：
// 航空信的红蓝斜纹边用一排色块拼出来，邮票图片从线上站点加载（{{ .SiteURL }}）。
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = new URL('../supabase/templates/', import.meta.url);

const C = {
  red: '#c4302b', blue: '#1f4b8f', paper: '#f8f2e4', card: '#fffdf8',
  ink: '#2a2723', soft: '#7a7064', rule: '#e3d8c2', accent: '#e8590c', bg: '#ebdfc6',
};
const SERIF_ZH = "'Noto Serif SC','Songti SC','STSong',serif";
const SERIF_EN = "'Iowan Old Style',Georgia,'Times New Roman',serif";

const MAILS = {
  confirmation: {
    subject: '欢迎来到 Dear Elsewhere · 请确认你的邮箱',
    kicker: 'PAR AVION · 一封来自远方的信',
    title: '确认你的邮箱',
    body: '你好，旅行者：<br>谢谢你用邀请码登上 Dear Elsewhere。点下面的按钮确认这个邮箱，你的旅行护照就可以签发了。',
    button: '确认邮箱',
    en: 'Thanks for joining Dear Elsewhere. Confirm your email to get your travel passport issued.',
    enButton: 'Confirm email',
  },
  recovery: {
    subject: 'Dear Elsewhere · 重置你的密码',
    kicker: 'PAR AVION · 找回密码',
    title: '重置密码',
    body: '我们收到了为 <b>{{ .Email }}</b> 重置密码的请求。点下面的按钮设置一个新密码。<br>如果这不是你本人的操作，忽略这封信即可，原密码不会改变。',
    button: '设置新密码',
    en: 'Someone asked to reset the password for this account. If it wasn\'t you, just ignore this letter.',
    enButton: 'Reset password',
  },
  email_change: {
    subject: 'Dear Elsewhere · 确认新的邮箱地址',
    kicker: 'PAR AVION · 更换邮箱',
    title: '确认新邮箱',
    body: '你正在把账号邮箱从 <b>{{ .Email }}</b> 改为 <b>{{ .NewEmail }}</b>。点下面的按钮确认这次更换。',
    button: '确认更换',
    en: 'Confirm the change of your account email to {{ .NewEmail }}.',
    enButton: 'Confirm change',
  },
  invite: {
    subject: '你收到了一封 Dear Elsewhere 的邀请',
    kicker: 'PAR AVION · 邀请函',
    title: '有人邀请你一起记录旅行',
    body: '你被邀请加入 Dear Elsewhere：一张只属于你的旅行足迹地图。点下面的按钮接受邀请，设置你的账号。',
    button: '接受邀请',
    en: 'You\'ve been invited to Dear Elsewhere, a map of everywhere you\'ve been.',
    enButton: 'Accept invite',
  },
};

// 航空信的斜纹边：红、纸、蓝、纸 循环
const stripes = () => {
  const cells = Array.from({ length: 30 }, (_, i) => [C.red, C.paper, C.blue, C.paper][i % 4])
    .map(c => `<td width="20" height="7" style="background:${c};font-size:0;line-height:0;">&nbsp;</td>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed;"><tr>${cells}</tr></table>`;
};

const render = m => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<title>${m.subject}</title>
</head>
<body style="margin:0;padding:0;background:${C.bg};">
<div style="display:none;max-height:0;overflow:hidden;">${m.en}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.bg};">
<tr><td align="center" style="padding:32px 12px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:${C.paper};border-radius:6px;overflow:hidden;">
    <tr><td>${stripes()}</td></tr>
    <tr><td style="padding:30px 34px 8px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td width="64" valign="middle"><img src="{{ .SiteURL }}/brand/stamp@2x.png" width="52" alt="" style="display:block;border:0;"></td>
        <td valign="middle" style="padding-left:12px;">
          <div style="font:700 26px/1.1 ${SERIF_EN};color:${C.ink};letter-spacing:.04em;"><i>Dear</i> Elsewhere</div>
          <div style="margin-top:6px;font:italic 13px/1 ${SERIF_EN};color:${C.soft};">${m.kicker}</div>
        </td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:18px 34px 0;">
      <div style="border-top:1px solid ${C.rule};padding-top:20px;font:700 19px/1.4 ${SERIF_ZH};letter-spacing:.08em;color:${C.ink};">${m.title}</div>
      <p style="margin:12px 0 0;font:15px/1.85 ${SERIF_ZH};color:${C.ink};">${m.body}</p>
    </td></tr>
    <tr><td style="padding:26px 34px 6px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="background:${C.red};border-radius:4px;">
          <a href="{{ .ConfirmationURL }}" style="display:inline-block;padding:12px 26px;font:700 15px/1 ${SERIF_ZH};letter-spacing:.12em;color:#fff;text-decoration:none;">${m.button} · ${m.enButton} &rarr;</a>
        </td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:18px 34px 0;">
      <p style="margin:0;font:italic 13px/1.7 ${SERIF_EN};color:${C.soft};">${m.en}</p>
      <p style="margin:14px 0 0;font:12px/1.7 ${SERIF_ZH};color:${C.soft};word-break:break-all;">按钮打不开？复制这个链接到浏览器：<br><a href="{{ .ConfirmationURL }}" style="color:${C.blue};">{{ .ConfirmationURL }}</a></p>
    </td></tr>
    <tr><td style="padding:26px 34px 28px;">
      <div style="border-top:1px dashed ${C.rule};padding-top:14px;font:11px/1.7 ${SERIF_EN};letter-spacing:.14em;color:${C.soft};">
        BY AIR MAIL &nbsp;✦&nbsp; DEAR ELSEWHERE<br>
        <span style="letter-spacing:0;font-family:${SERIF_ZH};">这是一封系统邮件，请不要直接回复。</span>
      </div>
    </td></tr>
    <tr><td>${stripes()}</td></tr>
  </table>
</td></tr>
</table>
</body>
</html>
`;

mkdirSync(OUT, { recursive: true });
for (const [name, m] of Object.entries(MAILS)) {
  writeFileSync(new URL(`${name}.html`, OUT), render(m));
  console.log(`${name}.html  主题：${m.subject}`);
}
