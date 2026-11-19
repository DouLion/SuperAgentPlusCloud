# SuperAgentPlus Client

命令行客户端，供参与者（提出者 / 执行者 / 评审者）与 Center 交互。
**只调用 Center HTTP 接口，不接入任何编码 CLI。**

- 运行时：Node.js v26+，全部 ESM。
- 依赖：零第三方依赖，仅 Node 内置模块。
- 当前进度：**T0–T13**，核心链、AI 建议、约定包、编排模板、Artifact/OpenAPI 校验与文档/Mock 命令可用。

## 安装与运行

无需 `npm install`。直接调用脚本即可：

```powershell
node bin/sap.mjs --help
# 或（package.json 已声明 bin）
npx sap --help
```

## 配置 Center 地址

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `CENTER_URL` | `http://127.0.0.1:8787` | Center 服务 origin；客户端自动追加 `/sap-cloud/api` |

先启动 Center：`node center/bin/center.mjs`（默认端口 `CENTER_PORT=8787`）。

```powershell
$env:CENTER_URL = "http://127.0.0.1:9000"
node bin/sap.mjs --help
```

## 命令

| 命令 | 用途 | 实现层 |
|---|---|---|
| `submit` | 提交需求/问题，保留原文与材料引用 | T2 |
| `decide` | 确认决定：接受 / 改级 / 追问 / 拒绝 / 延后 | T2 |
| `show` | 查看需求或任务的完整链条（评估、决定、认领、提交、评审） | T2 / T4 |
| `tasks` | 查看任务、范围与完成条件 | T3 |
| `claim` | 原子认领任务 | T3 |
| `release` | 认领者本人释放任务 | T3 |
| `deliver` | 提交成果（commit 引用、自测证据） | T4 |
| `review` | 按完成条件逐项评审（确认 / 打回 / 需补充） | T4 |
| `trunk` | 主干条目：查看、提出、确认生效、退役 | T6 |
| `change` | 主干变更：发起、确认、生效、关闭 | T5 |
| `impact` | 影响项登记与逐项处置 | T5 |
| `advise` / `plan` / `impacts` | 模型评估、任务草稿、影响候选（均未生效） | T8 |
| `convention` | 团队/项目约定包、模板导入、版本状态 | T12 |
| `workflow` | 编排模板 DAG 与内置 contract-first-api | T12 |
| `artifact` | 项目制品、OpenAPI 校验、发布、文档 URL | T13 |
| `orchestrate` | API 契约优先编排；建议未生效，`adopt` 具名采纳 | T14 |

### trunk 命令

```powershell
node bin/sap.mjs trunk list --project <id> [--status proposed|active|superseded|retired] [--kind <类型>]
node bin/sap.mjs trunk show --item <item_id>
node bin/sap.mjs trunk propose --project <id> --kind <类型> --statement <表述> [--rationale ...] [--source ...] [--by <名字>]
node bin/sap.mjs trunk confirm --item <item_id> --by <名字> [--valid-from <ISO>]
node bin/sap.mjs trunk retire --item <item_id> --by <名字>
```

`propose` 只生成 `proposed` 建议；`confirm` 才进入 `active`；`retire` 将 `active`
条位置为 `retired` 并保留历史。非法流转（如对 `active` 再 confirm）透出服务端
409 `INVALID_TRANSITION` 并非零退出。

参数解析统一放在 `client/src/commands/`，HTTP 调用集中在 `client/src/api.mjs`。
新增命令时两处都要同步登记。

## 测试

```powershell
cd client
npm test                  # = node --test test/
# 或在仓库根目录：
npm test                  # = node --test center/test/ client/test/
```

## 端到端

在仓库根目录执行：

```powershell
npm run e2e    # = node client/bin/e2e.mjs
# 或在 client 目录：
npm run e2e    # = node bin/e2e.mjs
```

脚本在进程内启动 Center（临时库 + 系统分配端口），通过真实 HTTP 与 `trunk`
命令跑通完整链路，结束时清理临时库，不留下后台进程或端口占用。

## 根目录脚本

| 命令 | 作用 |
|---|---|
| `npm test` | 运行 Center 与 Client 的全部测试 |
| `npm run e2e` | 运行端到端脚本 |
| `npm run center` | 启动 Center |
| `npm run client` | 运行 Client |
