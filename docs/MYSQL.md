# 本机 MySQL 与 Redis 开发验证

线上 Sites 站点当前仍使用 D1，本轮不切换线上数据库。已通过线上 API 确认 37 名候选人、43 次投递、revision 3；API 返回权限投影，会过滤核对邀请和部分评价，不能作为完整迁移备份。下面先用独立的合成样本验证本机 MySQL，不表示已将线上 37/43 数据完整迁入。

## 启动与初始化

需要 Docker Desktop / Docker Engine 与 Compose，以及 Node.js 22.13 或以上版本。项目根目录的 Compose 项目名为 `talentflow-mysql`，服务为 `mysql`、`redis`、`storage`；本机端口分别为 `13306`、`16379`、`8788`。

```sh
npm ci
npm --prefix services/storage ci
node scripts/setup-local-mysql.mjs
docker compose --env-file .env.mysql up -d --build
docker compose --env-file .env.mysql ps
```

配置脚本在本地生成 `.env.mysql` 与 `.dev.vars`，使用随机密码和令牌；不覆盖已有文件。MySQL 首次建库时运行 `services/storage/schema.sql`，建立 `recruitment_state` 与 `sessions`。状态表保留 `id = 'main'`、`revision BIGINT` 与 `payload LONGTEXT`，通过 `JSON_VALID` 约束保证 JSON 有效，同时保留原文键顺序，兼容现有筛选报告校验。会话表保存 token 哈希、用户 ID 与过期时间。当前没有把候选人、投递、面试等业务对象正式拆表。

本轮早期若已用 JSON 列初始化本地卷，应先执行 `services/storage/migrations/001_preserve_payload.sql`，再清空该开发环境的 Redis 缓存。该升级只防止后续字段重排，不能恢复旧 JSON 列已经改变的键顺序；历史报告需按原始备份迁入或在界面重新生成。新建库已使用正确的文本列，无需执行此升级。

本机 macOS 若使用已建立的 Colima `talentflow` profile，执行 Compose 时改用下列前缀，后面的 `up`、`run`、`restart` 等参数一致。此方式不修改用户默认 Docker context：

```sh
DOCKER_HOST="unix://$HOME/.colima/talentflow/docker.sock" docker-compose --env-file .env.mysql up -d --build
```

可先在空库导入完整的合成初始状态，避免网页首次访问自动初始化与导入竞争：

```sh
mkdir -p .sites-runtime
node --experimental-strip-types --input-type=module -e 'import { createSeed } from "./lib/seed.ts"; const state = createSeed(new Date("2026-10-20T02:00:00.000Z")); process.stdout.write(JSON.stringify(state));' > .sites-runtime/mysql-seed.json
docker compose --env-file .env.mysql run --rm -T --no-deps storage node scripts/import-state.mjs < .sites-runtime/mysql-seed.json
```

初始合成样本为 36 名候选人、42 次投递、revision 1。输出只有各集合数量、revision 与 canonical JSON 的 SHA-256；不能将它与线上 37/43 数据混淆。验证幂等性时重复读取同一个文件；重新生成样本可能包含新 ID，会被视为不同内容并拒绝覆盖。

## 完整备份导入

只接受 D1 `recruitment_state.payload` 的完整原始 JSON 对象。导出时需让表内 revision 与 payload.revision 一致，并确保 `users`、`jobs`、`candidates`、`applications`、`interviews`、`scorecards`、`events`、`imports` 和存在时的 `reviews` 完整保留。不要使用截图、截断的 SQL 输出、`/api/recruitment` 权限投影、手工补齐的对象或仅包含候选人的列表。

取得完整备份后，仅对本机空状态库执行：

```sh
docker compose --env-file .env.mysql run --rm -T --no-deps storage node scripts/import-state.mjs < /安全位置/raw-state.json
```

也可安装 `services/storage` 的依赖后，从宿主机运行脚本：用环境变量 `MYSQL_HOST=127.0.0.1`、`MYSQL_PORT=13306`、`MYSQL_USER`、`MYSQL_PASSWORD`、`MYSQL_DATABASE` 配置连接。密码仅保存在本地环境或 `.env.mysql`，不要放到命令参数、仓库或日志。

脚本先检查基本状态形状、安全整数 revision、唯一 ID、候选人/投递/职位等引用及快照关联；保留全部 JSON 字段和集合。标准输入及序列化后的完整状态均不超过 1,900,000 字节，与 Worker 的状态容量限制一致。事务内由主键原子插入和加锁回读协调并发，不存在覆盖操作。已有同 revision 且内容相同的状态可重复导入成功；任何内容或 revision 不同都会拒绝并回滚。回读比较稳定 SHA-256，不受 MySQL JSON 对象键顺序变化影响。输出与错误信息不包含候选人信息、邀请 token 或数据库密码。会话不迁移，需重新登录。

## 让本地 Worker 连接 MySQL 服务

配置脚本默认已在项目根目录 `.dev.vars` 设置本地值，token 与 `.env.mysql` 的 `STORAGE_API_TOKEN` 相同；已有 `.dev.vars` 时需手工合并以下两项：

```dotenv
MYSQL_STORAGE_URL=http://127.0.0.1:8788
MYSQL_STORAGE_TOKEN=替换为本地至少32字符的随机token
```

构建并启动本地 Worker 后，状态与会话调用经带令牌的 HTTP 接口到存储服务，再访问 MySQL。此源码已切为 MySQL 存储，未配置时返回 503，不回退到 D1。尚未重新部署的线上站点仍运行原 D1 版本。远程服务地址必须为 HTTPS。本机 Docker 的 `127.0.0.1` 地址只适用于本地 Worker，已部署的 Sites Worker 无法访问开发电脑的回环地址。

```sh
npm run build
npm start
```

MySQL 是状态和并发判断的唯一权威。写入使用 `WHERE revision = expectedRevision` 的比较后提交；相同旧 revision 的竞争操作只能有一个成功，其余收到冲突并刷新重试。Redis 仅缓存按 revision 区分的状态，TTL 60 秒；读操作先核实数据库当前 revision，写提交后不会使用旧版本缓存。Redis 断开时直接读数据库。会话始终查 MySQL，不从 Redis 读取。

## 持久化与验收

MySQL 使用 Compose 命名卷，Redis 仅存内存缓存，上限 64 MB，使用 allkeys-lru 淘汰。`docker compose --env-file .env.mysql restart`、`down` 后再 `up -d` 保留 MySQL 数据；`down -v` 会删除本地数据库，不用于常规重启。缓存可随时丢弃，招聘状态不可依赖缓存恢复。

```sh
npm test
npm --prefix services/storage test
npm run typecheck
docker compose --env-file .env.mysql restart
docker compose --env-file .env.mysql ps
```

验收需包含：同一状态重复导入的哈希相同、不同状态导入被拒绝、重启后候选人/投递数量与 revision 保留、两个同 revision 写入仅一条成功、Redis 停止时读写仍可用且恢复后不读旧状态、登出后会话立即无效。单元测试验证导入边界和回滚逻辑；Docker/MySQL 实际运行结果需单独记录，不能用模拟连接测试代替实库验收。

## 线上切换条件

当前交付只用于本地开发验证。正式切换前需取得未经权限投影和截断的 D1 完整备份，在停写窗口导入并校验数量、revision 和全量哈希；部署可由 Sites Worker 访问的私有存储 API，配置 HTTPS 与独立令牌，完成真实 MySQL/Redis 并发、故障、重启和恢复验证；明确备份恢复、访问控制与回滚方案后再设置线上 `MYSQL_STORAGE_URL` / `MYSQL_STORAGE_TOKEN`。大规模数据还需将业务集合拆表与分页，单个 JSON 状态加 Redis 不能消除全局 revision 竞争或替代数据库容量规划。
