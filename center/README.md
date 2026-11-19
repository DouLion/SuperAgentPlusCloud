# SuperAgentPlus Center

中心服务：保存项目权威主干记录、需求、评估、决定、任务、提交、评审与事件历史。
当前进度：**T0–T13**（核心链、主干变更、模型建议、面板/初始化、约定包、编排模板、项目制品、OpenAPI 校验、同源接口文档与 Mock 可用）。

- 运行时：Node.js v26+（本机 v26.12.1），全部 ESM。
- 依赖：零第三方依赖，仅 Node 内置模块（`node:http`、`node:sqlite`、`node:test`、`node:fs`、`node:path`、`node:url`、`node:crypto`）。

## 目录

```text
center/
  package.json
  bin/center.mjs     启动入口（环境变量、监听、优雅退出）
  src/
    config.mjs       环境变量集中读取
    store.mjs        存储门面（转发到 db/*，兼容旧引用）
    server.mjs       HTTP 门面（转发到 http/server.mjs）
    init-db.mjs      建库脚本
    db/
      schema.sql     建表语句（唯一来源）
      store.mjs      连接、迁移、重置
      json.mjs       编解码与错误工具
      enums.mjs      状态与类型枚举
      events.mjs      appendEvent / listEvents
      projects.mjs  trunk.mjs  requirements.mjs
      tasks.mjs     submissions.mjs  changes.mjs
      conventions.mjs  workflows.mjs  artifacts.mjs  definition-events.mjs
    contracts/
      openapi.mjs     OpenAPI 约定校验、HTML 文档与 Mock 生成
    http/
      server.mjs     createServer、路由匹配、JSON 收发、错误映射
      routes/        projects / trunk / requirements / tasks / submissions / changes
    public/         （T9）托管 web/dist 构建产物
    ai/             （T8）模型接入
  test/*.test.mjs    按层测试（store/requirement/task/submission/change/trunk）
  data/center.db     运行期生成（已忽略，不入库）
```

## 主要接口

下表均为相对路径，正式接口统一加前缀 **`/sap-cloud/api`**。例如健康检查是 `/sap-cloud/api/healthz`，项目列表是 `/sap-cloud/api/projects`。旧根路径只用于迁移提示，不应继续调用。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/healthz` | 健康检查 |
| `GET/POST` | `/projects` | 项目列表 / 新建 |
| `GET/POST` | `/trunk-items` | 主干条目列表 / 新建（默认 proposed） |
| `GET` | `/trunk-items/:id` | 查询单个条目 |
| `POST` | `/trunk-items/:id/confirm` | proposed → active，body `{confirmed_by, valid_from}` |
| `POST` | `/trunk-items/:id/retire` | active → retired，body `{confirmed_by}` |
| `GET/POST` | `/requirements` | 需求列表 / 提交需求 |
| `GET` | `/requirements/:id` | 需求详情（含原文与自报等级） |
| `POST` | `/requirements/:id/assessments` | 评估（影响等级、关联条目、建议动作） |
| `GET` | `/requirements/:id/assessments` | 评估列表 |
| `POST` | `/requirements/:id/decision` | 决定（accepted/relevelled/needs_info/rejected/deferred） |
| `GET` | `/requirements/:id/decisions` | 决定列表 |
| `GET` | `/requirements/:id/timeline` | 需求相关事件时间线 |
| `POST` | `/requirements/:id/tasks` | 批量拆解任务并开放 |
| `GET/POST` | `/tasks` | 任务列表 / 新建（创建后自动开放） |
| `GET` | `/tasks/:id` | 任务详情 |
| `POST` | `/tasks/:id/claim` | 原子认领，body `{worker_id}` |
| `POST` | `/tasks/:id/release` | 认领者本人释放 |
| `GET` | `/tasks/:id/claims` | 认领历史 |
| `GET/POST` | `/tasks/:id/submissions` | 提交列表 / 提交成果 |
| `GET` | `/submissions/:id` | 提交详情 |
| `POST` | `/submissions/:id/review` | 评审（confirm/reject/needs_info） |
| `GET` | `/submissions/:id/reviews` | 评审列表 |
| `GET/POST` | `/trunk-changes` | 主干变更列表 / 发起变更 |
| `GET` | `/trunk-changes/:id` | 变更详情 |
| `POST` | `/trunk-changes/:id/confirm` | proposed → confirmed |
| `POST` | `/trunk-changes/:id/activate` | confirmed → in_effect（替代旧条目） |
| `POST` | `/trunk-changes/:id/close` | in_effect → closed（须完成影响处置） |
| `GET/POST` | `/trunk-changes/:id/impacts` | 影响项列表 / 登记 |
| `PATCH` | `/impact-items/:id` | 更新影响项评估与处置 |
| `GET/POST` | `/convention-packs` | 约定包列表 / 创建团队模板或项目快照 |
| `POST` | `/convention-packs/:id/activate` | 激活约定包（actor + reason 必填） |
| `POST` | `/convention-packs/:id/import` | 把 active 团队模板导入项目为独立快照 |
| `GET/POST` | `/workflow-templates` | 编排模板列表 / 创建 DAG 模板 |
| `POST` | `/workflow-templates/seed` | 创建内置 contract-first-api 模板 |
| `GET/POST` | `/artifacts` | 项目制品列表 / 创建草稿 |
| `GET` | `/artifacts/:id/validate` | 按项目 active 约定校验 API 契约 |
| `POST` | `/artifacts/:id/publish` | 校验通过后发布；must 违规返回 422 |
| `GET` | `/artifacts/:id/document` | 从 API 契约即时渲染 HTML 文档 |
| `*` | `/mock/:projectId/*` | 从已发布 API 契约生成只读 Mock 响应 |

错误约定：业务校验失败 400；状态冲突 409（响应带 `code`，如 `TASK_NOT_CLAIMABLE`、`TASK_NOT_LINKED`、`CHANGE_IMPACT_UNRESOLVED`、`INVALID_TRANSITION`）；路径存在但方法不符 405（带 `Allow`）；其余 500。

## 启动

```powershell
cd center
npm start                 # = node bin/center.mjs
```

启动后访问 `GET http://127.0.0.1:8787/sap-cloud/api/healthz`，应返回 `{"ok":true}`。完整接口清单见上节「主要接口」。

## 初始化数据库

```powershell
cd center
npm run init-db           # = node src/init-db.mjs
```

脚本执行迁移并打印数据库路径。`schema.sql` 全部使用 `IF NOT EXISTS`，
重复执行安全；表结构见 `src/schema.sql`，字段与状态枚举依据 `docs/04_详细方案.md`。

## 跑测试

```powershell
cd center
npm test                  # = node --test test/
# 或在仓库根目录：
node --test center/test/
```

测试数据库写在系统临时目录，测试结束自动删除，不会留下文件。

## 端到端

在仓库根目录执行：

```powershell
npm run e2e    # = node client/bin/e2e.mjs
```

脚本用临时 SQLite 库在进程内启动 Center（端口由系统分配，避免冲突），
通过 HTTP 与 Client 命令跑通：建项目 → 建并确认主干条目 → 提交需求 → 评估 →
改级决定 → 拆任务 → 认领 → 提交 → 评审打回 → 重新认领 → 再提交 → 评审确认 →
主干变更 → 影响项处置 → 变更关闭。结束后关闭服务并删除临时库。

## 根目录脚本

| 命令 | 作用 |
|---|---|
| `npm test` | 运行 `node --test center/test/ client/test/` |
| `npm run e2e` | 运行端到端脚本 |
| `npm run center` | 启动 Center（等价于 `node center/bin/center.mjs`） |
| `npm run client` | 运行 Client（等价于 `node client/bin/sap.mjs`） |
| `npm run export-data` | 导出当前库为 JSON |
| `npm run import-data` | 把导出的 JSON 写入新库 |
| `npm run sqlite-to-sql` | 生成通用 SQL DDL 草案 |

## 数据库与迁移

### 方言层

`src/db/dialect.mjs` 定义数据库方言契约，`src/db/dialects/sqlite.mjs` 是当前唯一实现。
`db/*.mjs` 只调用 `prepare / exec / transaction / close`，不直接依赖 `node:sqlite`。

- `openStore(path, { type })` 返回方言外观对象，原有调用方式不变；
- `transaction(fn)` 支持嵌套（内层用保存点），回滚内层不影响外层；
- `insertReturning(table, columns, values)` 供将来需要 `RETURNING` 的方言使用。

### 当前只支持 SQLite

`db.type` 可以是 `sqlite` / `postgres` / `mysql`，但**运行期只放行 `sqlite`**。
选择 `postgres` 或 `mysql` 时启动会抛 `UNSUPPORTED_DB_TYPE`（HTTP 501 语义），并提示需要：

1. 安装对应驱动（`pg` 或 `mysql2`）；
2. 新增 `src/db/dialects/postgres.mjs` 或 `mysql.mjs`，实现同一契约；
3. 用 `sqlite-to-sql` 的草案人工复核索引、CHECK 与外键后再迁移。

> 引入驱动会打破 Center「零第三方依赖」，因此这一步只在确有并发或运维需求时进行。

### 导出与导入

```powershell
# 导出全部表（也可 --table tasks 只导一张）
node center/bin/export-data.mjs --out dump.json

# 查看将写入多少行，不落库
node center/bin/import-data.mjs --in dump.json --target new.db --dry-run

# 实际导入（目标库必须不存在，避免误覆盖）
node center/bin/import-data.mjs --in dump.json --target new.db
```

导出文件包含 `schema_version`、`exported_at`、`dialect` 与按表分组的行数据。
导入按内置外键顺序写入，整个导入在单事务内完成，失败自动回滚。

### DDL 草案

```powershell
node center/bin/sqlite-to-sql.mjs --out schema-draft.sql
```

只做 `TEXT / INTEGER` 的基本映射，索引、CHECK 约束、部分唯一索引与级联行为**需人工复核**。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CENTER_PORT` | `8787` | HTTP 监听端口 |
| `CENTER_HOST` | `127.0.0.1` | HTTP 监听地址 |
| `CENTER_DB` | `center/data/center.db`（相对包目录） | SQLite 文件路径 |
| `SAP_CONFIG_PATH` | `center/config.json`（相对包目录） | 配置文件路径；设置页写入的文件 |
| `SAP_LLM_BASE_URL` | 空 | OpenAI 兼容根地址，如 `https://api.deepseek.com`；为空则 AI 功能不可用 |
| `SAP_LLM_API_KEY` | 空 | 模型 API Key；与 `SAP_LLM_BASE_URL` 同时非空才启用 AI 功能 |
| `SAP_LLM_MODEL` | `deepseek-chat` | 模型名 |
| `SAP_LLM_TIMEOUT_MS` | `30000` | 模型请求超时（毫秒） |

示例：

```powershell
$env:CENTER_PORT = "9000"; $env:CENTER_DB = "D:\tmp\center-dev.db"; npm start
```

配置优先级：**默认值 < `SAP_CONFIG_PATH` 指向的文件 < 环境变量**。首次启动无需任何配置；
打开 `/sap-cloud/setup` 可在 Web 界面完成初始化。模型配置保存后立即生效，端口/数据库修改后需重启。

## 重置数据库

代码层可用 `reset(db)`（`center/src/store.mjs`）删表重建，主要用于测试与本地环境。
它会删除全部业务数据，请勿在生产库上调用。
