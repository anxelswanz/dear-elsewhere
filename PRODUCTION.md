# 上线清单

代码里能做的加固已经做完（见文末「已完成」）。下面这些必须在各个控制台里手动完成，按顺序来。

> **生产项目已经用 `scripts/setup-prod.mjs` 建好**：`dear-elsewhere-prod`（ref 存在 `secrets/prod_project_ref`，区域 eu-central-1，免费版）。
> 第 1 节和第 2 节里的 migrations、邀请码、邮箱验证、密码长度、Resend SMTP、邮件模板都已经完成。
> 正式域名 `dear-elsewhere.com` 已配好（Site URL 和回调地址）。剩下：在 Resend 验证发件域名、备份、部署。
>
> **环境开关**：`.env` 里的 `APP_ENV=test`（测试库 map）或 `prod`（生产库），两套地址和 key 在 `.env.local`。也可以临时覆盖：`APP_ENV=prod npm run dev`。测试环境的标签页标题前会显示 `[TEST]`。
> 以后新增 migration：`node scripts/setup-prod.mjs migrate` 只会执行还没执行过的文件。

## 1. 数据库（Supabase → SQL Editor）

- [ ] 按编号顺序执行 `supabase/migrations/0001` … `0019`，已经执行过的跳过（或 `node scripts/setup-prod.mjs migrate`）。
- [ ] 把自己设为控制台管理员：`insert into public.admins (user_id) select id from auth.users where email = '你的邮箱';`，然后打开 `/dashboard/`。
- [ ] 执行完打开 **Advisors → Security Advisor**，确认没有 “RLS disabled” 或 “Function search path mutable” 之类的警告。
- [ ] 邀请码：旧的 `ANSEL-FRIEND` 太短，而且写在过代码里。换成随机码，再停用旧的：
  ```sql
  insert into public.invite_codes (code, note) values (upper(encode(gen_random_bytes(6), 'hex')), '朋友 2026');
  select code from public.invite_codes where active;   -- 记下新码发给朋友
  update public.invite_codes set active = false where code = 'ANSEL-FRIEND';
  ```

## 2. 登录与邮件（Supabase → Authentication）

- [x] **URL Configuration**：Site URL 为 `https://dear-elsewhere.com`，回调地址只允许 `dear-elsewhere.com` 和 `www.dear-elsewhere.com`。
- [ ] **Sign In / Providers → Email**：打开 Confirm email 和 Secure email change。
- [ ] **Password**：最短长度改为 **8**，和前端一致（`src/auth.js` 的 `PASSWORD_MIN`）。Pro 套餐可以再打开 Leaked password protection。
- [ ] **SMTP**：配成 Resend（smtp.resend.com）。在 Resend 里验证发件域名，在域名 DNS 里加上 SPF、DKIM、DMARC 记录。不配的话，Supabase 自带邮件每小时只能发几封。
- [ ] **Email Templates**：把 `supabase/templates/` 里的 4 个模板贴进去（先执行 `npm run build:emails`）。
- [ ] **Rate Limits**：检查注册、登录、发邮件的频率，默认值一般够用。

## 3. 存储与备份

- [ ] **Storage → photos**：确认是 Private，单个文件上限 3 MB，只允许 `image/jpeg`（0009 已经设置，确认一下）。
- [ ] **备份**：免费套餐没有自动备份。正式运营建议升级 Pro（每日备份，可以加时间点恢复）；或者至少每周用 `pg_dump` 手动导出一次，照片另外备份。

## 4. 网站托管（Cloudflare Pages）

- [ ] 构建命令 `npm run build`，输出目录 `dist`，Node 20 及以上。
- [ ] 环境变量：`APP_ENV=prod`、`SUPABASE_URL_PROD`、`SUPABASE_KEY_PROD`（publishable key，值见本地 `.env.local`），`VITE_TIANDITU_KEY`（可选）。**不要**放 service_role 或 secret key。构建日志里应该出现「▶ 生产环境 PROD」。
- [ ] `public/_headers` 会自动生效：包括 CSP、HSTS、禁止被嵌入 iframe、缓存策略。部署后打开浏览器控制台，确认没有 `Content-Security-Policy` 报错：登录、地图、搜索、照片、聊天、截图都要点一遍。
- [ ] 以后新增任何外部服务（例如 Sentry），记得把它的域名加进 `_headers` 里的 CSP。
- [ ] 绑定自定义域名，打开 Always Use HTTPS。

## 5. 第三方服务

- [ ] 天地图（如果用）：在控制台把 key 的白名单设成正式域名。
- [ ] Esri 免 key 接口只能非商业使用。将来商用，换成 ArcGIS Location Platform 的 API key。
- [ ] OpenFreeMap（截图街道）：截图上已经带署名，不需要额外操作。

## 6. 法律文本

- [ ] `public/legal.html` 第 1 节「数据控制者与联系方式」填上真实的联系人和邮箱。
- [ ] 这次隐私政策改了地图服务商和群聊部分。如果希望老用户重新同意，把 `src/auth.js` 里的 `TERMS_VERSION` 改成上线日期。
- [ ] `legal.html` 里仍然写的是「打卡」，站内已经统一成「盖章」，可以顺手统一。

## 7. 代码仓库

- [ ] 提交所有改动，包括 migrations 0006–0011、`public/legal.html`、`public/_headers`、`public/boot/`、`src/limits.js`、`src/settings.js`、`src/streets.js`。
- [ ] 确认 `secrets/` 和 `.env.local` 没有被提交（已在 `.gitignore`；目前 git 历史里也没有发现密钥）。
- [ ] 如果 GitHub 仓库是公开的，再检查一遍 `rule.md` 和 Logo 源文件要不要公开。

## 8. 上线前冒烟测试

用两三个测试账号，在桌面 Chrome、iOS Safari、Android Chrome 上各走一遍：

注册（邀请码）→ 验证邮件 → 填资料 → 加好友 → 长按盖章 → 侧栏「盖个章」→ 传照片（第 6 张应被拦下）→ 动态与评论 → 私信与已读 → 建群、群消息、几人已读、转发章、拉人、移出、退群 → 城市截图 → 导出备份 → 下载我的数据 → 注销账号

## 9. 上线后

- [ ] 观察 Supabase **Logs**（API、Auth、Postgres）和 Cloudflare Analytics。
- [ ] 目前没有前端报错监控。需要的话接入 Sentry（免费额度够用），并把它的域名加进 CSP。

---

## 已完成（代码里）

| 项目 | 说明 |
| --- | --- |
| 行级权限 | 所有表都开了 RLS；客户端只能写允许的列；限额由数据库触发器强制执行 |
| 实时推送泄露 | 好友关系、群成员改用随机主键，删除事件不再广播「谁和谁」（0011） |
| 打卡字段校验 | 标记样式、图标、地区 id、照片列表加上格式和大小限制，防止往好友页面注入内容（0011） |
| 邀请码爆破 | 注册前的邀请码查询改为每个 IP 每小时最多 20 次（0011）；仓库里不再写死邀请码 |
| 好友关系 | 客户端只能改 status 一列（0011） |
| 密码 | 新密码至少 8 位；老账号的 6 位密码仍然能登录 |
| 前端 XSS | 用户填写的内容全部经过转义；提示条用 textContent |
| CSP | 内联脚本移到 `public/boot/`，CSP 不允许内联脚本 |
| 地图服务 | 去掉非官方的高德接口，换成天地图和 Esri |
| 依赖 | `npm audit --omit=dev`：0 个漏洞 |
| 群聊 | 照片只对群成员可见；新成员看不到入群前的消息；消息频率与私信合计 |
