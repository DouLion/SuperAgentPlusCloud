# SuperAgentPlus Center

中心服务：保存项目权威主干记录、需求、评估、决定、任务、提交、评审与事件历史。
当前进度：**T0–T6**（存储与 HTTP 路由可用；主干条目支持 proposed/active/superseded/retired 与确认、退役；端到端脚本可跑通完整链路）。

- 运行时：Node.js v26+（本机 v26.12.1），全部 ESM。
- 依赖：零第三方依赖，仅 Node 内置模块（`node:http`、`node:sqlite`、`node:test`、`node:fs`、`node:path`、`node:url`、`node:crypto`）。

## 目录

```text
center/
  package.json
  bin/center.mjs     启动入口（HTTP 服务与路由骨架）
  src/schema.sql     建表语句
  src/store.mjs      SQLite 访问层
  src/init-db.mjs    建库脚本
  test/*.test.mjs    按层测试（store/requirement/task/submission/change/trunk）
  data/center.db     运行期生成（已忽略，不入库）
```

## 启动

```powershell
cd center
npm start                 # = node bin/center.mjs
```

启动后访问 `GET http://127.0.0.1:8787/healthz`，应返回 `{"ok":true}`。

主干条目相关接口（T6 补全）：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/trunk-items?project_id=&status=&kind=` | 列出主干条目 |
| `POST` | `/trunk-items` | 新建条目（默认 proposed） |
| `GET` | `/trunk-items/:id` | 查询单个条目 |
| `POST` | `/trunk-items/:id/confirm` | proposed → active，body `{confirmed_by, valid_from}` |
| `POST` | `/trunk-items/:id/retire` | active → retired，body `{confirmed_by}` |

非法流转（如对 active 再 confirm）返回 409，并带 `code=INVALID_TRANSITION`。

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

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CENTER_PORT` | `8787` | HTTP 监听端口 |
| `CENTER_HOST` | `127.0.0.1` | HTTP 监听地址 |
| `CENTER_DB` | `center/data/center.db`（相对包目录） | SQLite 文件路径 |

示例：

```powershell
$env:CENTER_PORT = "9000"; $env:CENTER_DB = "D:\tmp\center-dev.db"; npm start
```

## 重置数据库

代码层可用 `reset(db)`（`center/src/store.mjs`）删表重建，主要用于测试与本地环境。
它会删除全部业务数据，请勿在生产库上调用。
