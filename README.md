# 拾才 TalentFlow 招聘协作 Demo

覆盖社招和校招的内部招聘工作台。使用合成数据，可执行职位确认、独立投递、CSV 预检导入、筛选、约面和评价、经理决策、Offer 答复、校招协议登记、实际入职及漏斗分析。

- [产品 Spec 主计划](https://chatgpt.com/space/page_f49ca2bb805c8191949bac02aab9e291)
- [分层甄选与 AI 评估补充](https://chatgpt.com/space/page_e223fdade85c819197499dc0eca1d81e)
- [演示账号与体验步骤](./DEMO.md)

## 本地运行

Node.js 22.13 或更新版本，npm。依赖版本由 package-lock.json 锁定。

```sh
npm ci
npm run build
```

首次建立本地演示数据库时执行下面的迁移一次；不要在已有数据库上重复执行同一建表迁移。

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_flaky_fenris.sql
npm run dev
```

打开终端显示的 Local 地址，通常是 http://127.0.0.1:5173 。开发服务器与本地迁移共享 `.wrangler/state`。数据库为空时通过首次业务访问写入合成样本；本地与线上数据相互独立。

## 验证

```sh
npm test
npm run typecheck
```

运行中的本地服务可执行集成验证。脚本会新增合成验收记录；只有显式提供 `--reset` 才会重置样本。

```sh
npm run test:api
```

代码交付不宣称原 Spec 全部 31 个验收场景或生产性能目标都已经通过；实际检查结果记录在 `VERIFICATION.md`。

## 技术与实现边界

- 使用 Vinext 的 Next.js 风格全栈路由、React、TypeScript 与 Cloudflare D1；SQL 建表迁移随代码交付。
- 为降低 Demo 工程规模，业务对象集合保存在 D1 的 JSON 状态中，使用全局 revision 比较后提交；会话使用独立表、随机 HttpOnly Cookie 和过期时间。具备服务端权限与并发保护，但不是 Spec 规划的完整规范化业务表。
- 初始有 8 个职位、36 名合成人员、42 次独立投递，均为演示资料。请勿录入真实招聘资料。
- 所有角色均为公开的演示账号，统一演示密码见 DEMO.md。账号切换实际建立服务端会话，用于体验权限边界，不是生产身份管理。
- CSV 文件界面限制 1 MB、1000 行；整个 Demo 状态另有约 1.9 MB 的序列化容量保护。超限拒绝写入并保留原数据，大批量招聘需要分表和异步导入。与原计划的 5 MiB 导入目标相比，此 Demo 范围更小。
- 规则核对当前支持技能与毕业届别。学历条件配置、性格测评、笔试平台、AI 简历复筛、AI 面试、AI 评分和录音转写尚未接入。人工面试评分由面试官实际填写，不伪造模型分数。
- 面试安排及人工通知确认都在系统内登记；邮件、短信、外部日历、招聘渠道、电子签约、背调和 HRIS 尚未接入。
- 资料清理仅用于合成样本演示，不代表已完成生产环境的资料期限、备份再清理、资料权利请求等完整治理。

## 代码位置

`components/recruitment/` 为工作台、详情和表单；`lib/engine.ts` 为业务规则和权限投影；`lib/server.ts` 为 D1 与会话；`lib/metrics.ts` 为指标口径；`tests/` 和 `scripts/api-smoke.mjs` 为验证。
