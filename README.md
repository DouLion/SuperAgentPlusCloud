# SuperAgentPlusCloud

把项目当成一棵树来维护：严格控制主干，放手让枝叶生长。

这套设计要解决的不是"任务没人做"，而是：**项目持续推进时，当前有效的决定、依据和影响范围能否被唯一、可追溯地保留下来。**

## 核心流程

```text
提出需求 → 评估影响 → 被授权者确认 → 拆解任务 → Client 认领执行
        → 提交 Git 与证据 → 评审 → （若主干变更）记录并处置影响
```

## 文档

- [00 项目背景与问题定义](docs/00_项目背景.md)：为什么需要做，不解决什么
- [01 解决思路](docs/01_解决思路.md)：主干比喻、两种工作、约定变化、成立条件
- [02 核心概念与原则](docs/02_核心概念与原则.md)：术语、影响等级、AI 输出地位
- [03 总体架构](docs/03_总体架构.md)：组成、责任边界、核心流程、一期范围
- [04 详细方案](docs/04_详细方案.md)：对象、字段、状态、变更与影响记录
- [05 实施计划](docs/05_实施计划.md)：分层生长计划与当前进度（T0–T14 已完成）
- [06 中心增强设计](docs/06_中心增强设计.md)：代码归置、模型接入、前端面板
- [07 数据库适配与部署](docs/07_数据库适配与部署.md)：启动门槛、配置分层、SQLite→PG/MySQL 路径
- [08 面板产品设计与 URL 契约](docs/08_面板产品设计与URL契约.md)：工作台信息架构、示例项目、页面与 API 强制前缀
- [09 项目契约、编排与接口制品](docs/09_项目契约编排与接口制品.md)：团队约定包、工作流模板、OpenAPI/文档/Mock
- [10 实施方案](docs/10_实施方案.md)：后续枝叶候选、推荐顺序与待确认点（未确认不实现）
- [11 多 Agent 接入预设计](docs/11_多Agent接入预设计.md)：现状缺口、需要提前预埋的最小改动、接入路径
- [原始材料](docs/多人协作AI辅助开发的想法.md)：未修改的原始想法

## 仓库结构

```text
docs/    设计文档
center/  中心服务实现（HTTP + SQLite）
client/  客户端实现（命令行，只与 Center 交互）
web/     面板（Vue 3 + Element Plus，构建产物由 Center 托管）
```

Center 与 Client 均已可运行：Center 提供 HTTP 服务与 SQLite 存储，Client 提供命令行；
核心链、主干变更、约定包、编排模板、Artifact、OpenAPI 校验、同源接口文档与 Mock 已实现，端到端脚本可跑通完整链路。

## 运行与测试

```powershell
npm run center    # 启动 Center（默认 http://127.0.0.1:8787）
npm run client -- --help
npm test          # = node --test center/test/ client/test/
npm run e2e       # = node client/bin/e2e.mjs
```

## 面板

Center 托管 Vue 3 + Element Plus 面板（`web/` 工程）：

```powershell
npm --prefix web install
npm --prefix web run build      # 产物 web/dist，由 Center 在 8787 托管
npm run web                     # 开发模式（Vite，需另开 Center）
```

构建后打开 `http://127.0.0.1:8787/sap-cloud/` 即可使用；未构建时 Center 会给出提示页，不影响 `/sap-cloud/api/*`。

## 模型接入

Center 的评估建议、任务拆解、影响候选由模型生成，**只作为建议，不自动生效**：

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `SAP_LLM_BASE_URL` | 空 | OpenAI 兼容根地址 |
| `SAP_LLM_API_KEY` | 空 | 缺失则 AI 功能返回 503 |
| `SAP_LLM_MODEL` | `deepseek-chat` | 模型名 |
| `SAP_LLM_TIMEOUT_MS` | `30000` | 超时 |

未配置模型时核心链不受影响。

详见 [center/README.md](center/README.md) 与 [client/README.md](client/README.md)。

## License

Apache License 2.0，见 [LICENSE](LICENSE)。
