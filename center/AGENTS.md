# AGENTS｜Center

给后续 Agent 的 Center 开发约定。设计依据：`docs/03_总体架构.md`、`docs/04_详细方案.md`、`docs/05_实施计划.md`。

## 目录约定

- `bin/center.mjs`：进程入口，只负责启动、环境变量、优雅退出。
- `src/config.mjs`：环境变量集中读取（`CENTER_PORT` / `CENTER_HOST` / `CENTER_DB`，T8 起加入 LLM 配置）。
- `src/http/server.mjs`：HTTP 服务、路由匹配、JSON 收发、错误映射。
- `src/http/routes/*.mjs`：按领域拆分路由（projects / trunk / requirements / tasks / submissions / changes）。
- `src/db/store.mjs`：连接、迁移、重置；`src/db/schema.sql` 是唯一建表来源。
- `src/db/json.mjs`、`enums.mjs`、`events.mjs`：工具、枚举、事件。
- `src/db/{projects,trunk,requirements,tasks,submissions,changes}.mjs`：核心链数据访问。
- `src/db/{conventions,workflows,definition-events}.mjs`：T12 约定包、编排模板与全局定义事件。
- `src/db/artifacts.mjs`、`src/contracts/openapi.mjs`：T13 项目制品、OpenAPI 校验、同源文档与 Mock。
- `src/ai/`：模型接入（T8），只产出建议，不产生已生效状态。T14 未授权前不得让 AI 自动创建任务。
- `src/public/`：托管前端构建产物（T9）。
- `src/store.mjs`、`src/server.mjs`：兼容旧引用的**门面**，新代码请直接引用 `db/*` 与 `http/*`。
- `test/*.test.mjs`：按层新增测试文件，如 `test/requirement.test.mjs`。

## 命名约定

- 文件用小写中划线或单义词：`store.mjs`、`init-db.mjs`。
- 函数用动词短语：`createTrunkItem`、`listEvents`、`updateTrunkItemStatus`。
- 数据库字段一律 `snake_case`；JS 对象兼容 `camelCase` 入参（`pick()` 处理）。
- 表名、状态枚举、字段名必须与 `docs/04_详细方案.md` 一致；如需调整先改文档再改代码。

## ID 前缀约定

`item_` 主干条目、`req_` 需求、`asm_` 评估、`dec_` 决定、`task_` 任务、
`clm_` 认领、`sub_` 提交、`rev_` 评审、`chg_` 主干变更、`imp_` 影响项、
`evt_` 事件、`prj_` 项目。前缀后用 `crypto.randomUUID()` 去横线，保证全局唯一且可读。

## 存储约定

- JSON 数组/对象字段（`relations`、`source_refs`、`done_when` 等）存 TEXT，
  写入用 `encodeJson()`，读出用 `decodeJson()`，禁止在 SQL 里手工拼接 JSON。
- 时间统一 ISO 8601 字符串（`new Date().toISOString()`），不存时间戳数字。
- 布尔值存 `INTEGER` 0/1（如 `reviews.self_review`）。
- 每个状态变更都要写 `events`，操作者、时间、理由不得缺失。
- 状态机以 `schema.sql` 的 CHECK 约束为准，代码层同样校验。

## 测试方式

```powershell
npm test
# 或根目录：node --test center/test/
```

- 用 `node:test` + `node:assert/strict`。
- 测试库必须落在 `os.tmpdir()`，`after()` 里关闭连接并删除文件。
- 每层新增功能配一个同名测试文件；不要依赖真实 `data/center.db`。

## 禁止事项

- 禁止引入任何第三方依赖，禁止 `npm install`。
- 禁止修改 `docs/` 下文档。
- 禁止执行 `git add` / `git commit` / `git push`（由负责人统一提交）。
- 禁止静默覆盖历史：旧记录保留状态与事件，新结论写新行。
- 禁止把 AI 建议直接写成已确认状态；建议与确认必须分字段/分记录。
