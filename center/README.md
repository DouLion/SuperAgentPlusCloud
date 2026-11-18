# SuperAgentPlus Center

中心服务：保存项目权威主干记录、需求、评估、决定、任务、提交、评审与事件历史。
当前进度：**T0 骨架 + T1 存储**（HTTP 服务可启动、SQLite 建库与主干条目/事件读写可用）。

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
  test/store.test.mjs
  data/center.db     运行期生成（已忽略，不入库）
```

## 启动

```powershell
cd center
npm start                 # = node bin/center.mjs
```

启动后访问 `GET http://127.0.0.1:8787/healthz`，应返回 `{"ok":true}`。
其余路径为 T2+ 预留，当前统一返回 404 JSON。

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
