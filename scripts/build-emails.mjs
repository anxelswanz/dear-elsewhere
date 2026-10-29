// 生成 Supabase Auth 的邮件模板（航空信样式），输出到 supabase/templates/*.html
// 用法：node scripts/build-emails.mjs，再用 node scripts/setup-prod.mjs auth 上传到生产环境
// （或手动粘到 Supabase 控制台 → Authentication → Emails → Templates，主题见 subjects.json）。
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

// 每封信都有中文和英文两版，Supabase 按用户资料里的 lang（注册、登录、切换语言时由前端写入）选一版发出；
// 没有 lang 的老账号收到中文版
const MAILS = {
  confirmation: {
    zh: {
      subject: '欢迎来到 Dear Elsewhere · 请确认你的邮箱',
      kicker: 'PAR AVION · 一封来自远方的信',
      title: '确认你的邮箱',
      body: '你好，旅行者：<br>谢谢你用邀请码登上 Dear Elsewhere。点下面的按钮确认这个邮箱，你的旅行护照就可以签发了。',
      button: '确认邮箱',
    },
    en: {
      subject: 'Welcome to Dear Elsewhere · Please confirm your email',
      kicker: 'PAR AVION · A letter from elsewhere',
      title: 'Confirm your email',
      body: 'Hello, traveller —<br>thanks for joining Dear Elsewhere with an invite. Confirm this email below and your travel passport will be issued.',
      button: 'Confirm email',
    },
  },
  recovery: {
    zh: {
      subject: 'Dear Elsewhere · 重置你的密码',
      kicker: 'PAR AVION · 找回密码',
      title: '重置密码',
      body: '我们收到了为 <b>{{ .Email }}</b> 重置密码的请求。点下面的按钮设置一个新密码。<br>如果这不是你本人的操作，忽略这封信即可，原密码不会改变。',
      button: '设置新密码',
    },
    en: {
      subject: 'Dear Elsewhere · Reset your password',
      kicker: 'PAR AVION · Password reset',
      title: 'Reset your password',
      body: 'We received a request to reset the password for <b>{{ .Email }}</b>. Use the button below to choose a new one.<br>If this wasn’t you, just ignore this letter — your password won’t change.',
      button: 'Choose a new password',
    },
  },
  email_change: {
    zh: {
      subject: 'Dear Elsewhere · 确认新的邮箱地址',
      kicker: 'PAR AVION · 更换邮箱',
      title: '确认新邮箱',
      body: '你正在把账号邮箱从 <b>{{ .Email }}</b> 改为 <b>{{ .NewEmail }}</b>。点下面的按钮确认这次更换。',
      button: '确认更换',
    },
    en: {
      subject: 'Dear Elsewhere · Confirm your new email address',
      kicker: 'PAR AVION · Change of address',
      title: 'Confirm your new email',
      body: 'You’re changing your account email from <b>{{ .Email }}</b> to <b>{{ .NewEmail }}</b>. Confirm the change below.',
      button: 'Confirm change',
    },
  },
  invite: {
    zh: {
      subject: '你收到了一封 Dear Elsewhere 的邀请',
      kicker: 'PAR AVION · 邀请函',
      title: '有人邀请你一起记录旅行',
      body: '你被邀请加入 Dear Elsewhere：一张只属于你的旅行足迹地图。点下面的按钮接受邀请，设置你的账号。',
      button: '接受邀请',
    },
    en: {
      subject: 'You’re invited to Dear Elsewhere',
      kicker: 'PAR AVION · An invitation',
      title: 'Someone invited you to map your travels',
      body: 'You’ve been invited to Dear Elsewhere — a map of everywhere you’ve been, just for you. Accept below to set up your account.',
      button: 'Accept invite',
    },
  },
};

// 两种语言共用的固定文字
const COMMON = {
  zh: { htmlLang: 'zh-CN', font: SERIF_ZH, fallback: '按钮打不开？复制这个链接到浏览器：', noreply: '这是一封系统邮件，请不要直接回复。' },
  en: { htmlLang: 'en', font: SERIF_EN, fallback: 'Button not working? Copy this link into your browser:', noreply: 'This is an automated letter — please don’t reply.' },
};

// Go 模板：user_metadata.lang 为 en 时用英文。用 printf 转成字符串再比较，没有 lang 时不会报错
const byLang = (en, zh) => `{{ if eq (printf "%v" .Data.lang) "en" }}${en}{{ else }}${zh}{{ end }}`;

// 航空信的斜纹边：红、纸、蓝、纸 循环
const stripes = () => {
  const cells = Array.from({ length: 30 }, (_, i) => [C.red, C.paper, C.blue, C.paper][i % 4])
    .map(c => `<td width="20" height="7" style="background:${c};font-size:0;line-height:0;">&nbsp;</td>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed;"><tr>${cells}</tr></table>`;
};

const render = (m, c) => `<!doctype html>
<html lang="${c.htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<title>${m.subject}</title>
</head>
<body style="margin:0;padding:0;background:${C.bg};">
<div style="display:none;max-height:0;overflow:hidden;">${m.title}</div>
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
      <div style="border-top:1px solid ${C.rule};padding-top:20px;font:700 19px/1.4 ${c.font};letter-spacing:.08em;color:${C.ink};">${m.title}</div>
      <p style="margin:12px 0 0;font:15px/1.85 ${c.font};color:${C.ink};">${m.body}</p>
    </td></tr>
    <tr><td style="padding:26px 34px 6px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="background:${C.red};border-radius:4px;">
          <a href="{{ .ConfirmationURL }}" style="display:inline-block;padding:12px 26px;font:700 15px/1 ${c.font};letter-spacing:.12em;color:#fff;text-decoration:none;">${m.button} &rarr;</a>
        </td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:18px 34px 0;">
      <p style="margin:0;font:12px/1.7 ${c.font};color:${C.soft};word-break:break-all;">${c.fallback}<br><a href="{{ .ConfirmationURL }}" style="color:${C.blue};">{{ .ConfirmationURL }}</a></p>
    </td></tr>
    <tr><td style="padding:26px 34px 28px;">
      <div style="border-top:1px dashed ${C.rule};padding-top:14px;font:11px/1.7 ${SERIF_EN};letter-spacing:.14em;color:${C.soft};">
        BY AIR MAIL &nbsp;✦&nbsp; DEAR ELSEWHERE<br>
        <span style="letter-spacing:0;font-family:${c.font};">${c.noreply}</span>
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
const subjects = {};
for (const [name, m] of Object.entries(MAILS)) {
  writeFileSync(new URL(`${name}.html`, OUT), byLang(render(m.en, COMMON.en), render(m.zh, COMMON.zh)));
  subjects[name] = byLang(m.en.subject, m.zh.subject);
  console.log(`${name}.html  主题：${m.zh.subject} / ${m.en.subject}`);
}
// 主题也按语言切换；scripts/setup-prod.mjs auth 读这个文件上传
writeFileSync(new URL('subjects.json', OUT), JSON.stringify(subjects, null, 2) + '\n');
