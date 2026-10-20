# Gmail 真实核对邮件接入

本功能通过网站自己的 Google OAuth 客户端调用 Gmail API，不能复用聊天里连接的 Gmail 凭据。未配置、未授权或身份不匹配时失败封闭，不能把邮件预览或打开 Gmail 草稿计为真实发送。

## 当前交付与状态

- 代码包括官方授权入口 `/mail-connect`、单次 OAuth 回调、Gmail 服务端发送、加密保存 refresh token、独立 D1 发送记录和核对回执。
- 创建档案与邀请分开保存；上传后建档成功但发信失败，不需要重复创建候选人。
- 页面显式提交 `sendEmail: true` 才真实发送。只有 Gmail 返回消息 ID 后才显示“Gmail 已接受发送”；这不代表送达或已读。
- `sending`、`unknown` 不自动重发。先核对 Gmail 已发送邮件；若要重新邀请，明确撤销旧链接后再发新邀请，旧链接失效。
- 站点托管受众已为 public。live 模式下管理首页与全部招聘 API 限允许的真实 ChatGPT 账号；候选人凭七天链接仅访问本次投递白名单字段，不需要 HR 演示账号。
- Google Cloud 已创建 `TalentFlow Recruitment` 项目和 `TalentFlow Recruitment Web` 客户端；Gmail API 已启用，声明范围已保存为 `gmail.send`、`openid` 与 `userinfo.email`，发件人已加入测试用户。首次服务条款与 API 数据政策由用户亲自完成。六项网站配置已写入 Sites 服务端并随当前环境修订 2 生效，密钥均标 secret，临时传递文件已删除。
- v8 修复 Workers 不支持 `redirect: "error"` 的兼容问题：四条 Google 请求使用 `manual` 且不跟随跳转；send 3xx 保持 unknown、不自动重发。新增实际 Miniflare 回归后，全量 220/220、类型与正式构建通过。
- 正式 `/mail-connect` 已通过真实所有者登录及 Google OAuth，发件身份核对成功。已按用户授权向本人发送一封合成核对邮件，在本人 Gmail 的 INBOX/SENT 实际查收，并完成匿名资料更正、链接锁定与 HR 回写。结果见 [VERIFICATION.md](../VERIFICATION.md) 与 [脱敏机器证据](./evidence/gmail-live-acceptance.json)。该单次真实验收不代表所有收件服务、额度或送达情况均已验证。
- OAuth 应用处于 External / Testing 且包含 Gmail 权限时，Google 签发的 refresh token 有效期为 7 天，届时需要重新连接；仅基本身份范围的例外不适用于本应用的 `gmail.send`。见 [Google 官方有效期说明](https://developers.google.com/identity/protocols/oauth2/#expiration)。

## 服务端配置

以下值使用 Sites 原生环境变量配置，密钥标记 secret；不写入源码、聊天、浏览器 bundle 或 `.openai/hosting.json`。

| 名称 | 用途 |
| --- | --- |
| `GMAIL_CLIENT_ID` | Google Web OAuth 客户端 ID |
| `GMAIL_CLIENT_SECRET` | 对应客户端 secret |
| `GMAIL_TOKEN_KEY` | 32 字节随机值的 Base64，用于 AES-GCM 加密 D1 refresh token |
| `MAIL_OPERATOR_EMAIL` | 允许管理招聘资料、连接邮箱和发信的 Sites 登录邮箱 |
| `MAIL_BASE_URL` | 固定公开站点 HTTPS 地址，不从客户端 Host 构造邮件链接 |
| `MAIL_MODE` | `live` 启用真实管理身份门禁；未启用时保留合成 Demo |

Google 授权重定向 URI 必须精确登记为：

`https://talentflow-recruiting-demo.swoonytune34.chatgpt.site/api/gmail/callback`

只请求 `gmail.send` 及确认发件账号所需的 `openid email`。发送方通过 Google 返回的 verified email 确认，不允许浏览器伪造 From。仅连接指定发件人的测试模式足以体验真实邮件；Google OAuth 项目处于 Testing 时，包含 Gmail scope 的 refresh token 一般七天到期，需要重新授权，不应宣称长期生产可用。

## 可靠性与权限验收

1. 未登录、非允许账号、演示 HR cookie、未配置及未连接的真实发信请求均被拒绝。
2. OAuth state、PKCE 和 HttpOnly cookie 绑定单次十分钟授权；重放、账号更换和断开期间迟到回调不可恢复连接。
3. 原始 token、client secret、Google access/refresh token 不进入响应、审计或客户端；D1 refresh token 使用独立密钥加密。
4. mail job 在外部调用前原子 claim；同一 ID 重复调用最多发送一次。发送之后网络超时、5xx 或写库失败为 unknown，禁止自动重试。
5. 接受回执不改变招聘阶段、候选人事实、测评或招聘决定。旧邀请迟到回执不覆盖新邀请的状态。
6. 匿名候选人链接只含对应字段；过期、撤销、已提交和资料已更正的旧链接仍受原服务端约束。
7. 真正验收需要向明确授权的测试收件人发送合成核对邀请，并验证其可打开、提交和 HR 回写；不能只用 mock 或构建结果代替。

官方依据：[Gmail 发信](https://developers.google.com/workspace/gmail/api/guides/sending)、[服务端 OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)。
