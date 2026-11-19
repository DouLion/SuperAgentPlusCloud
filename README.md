<p align="center">
  <img src="logo.svg" alt="SuperAgentPlusCloud" width="180" />
</p>

<h1 align="center">SuperAgentPlusCloud</h1>

<p align="center">
  把项目当成一棵树来维护：严格控制主干，放手让枝叶生长。
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D26-brightgreen.svg" alt="Node" />
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen.svg" alt="Dependencies" />
  <img src="https://img.shields.io/badge/tests-242%20passing-brightgreen.svg" alt="Tests" />
</p>

---

这套设计要解决的不是「任务没人做」，而是：**项目持续推进时，当前有效的决定、依据和影响范围能否被唯一、可追溯地保留下来。**

需求会变、约定会作废、人会换、会话会丢。真正让人崩溃的不是变化本身，而是变化之后没人说得清「当初为什么这样定、现在还算不算数」。

## 核心流程

```text
提出需求 → 评估影响 → 被授权者确认 → 拆解任务 → 认领执行
        → 提交 Git 与证据 → 评审 →（若主干变更）记录并处置影响
```

## 现在能做什么

| 能力 | 说明 |
|---|---|
| **主干与决策** | 主干条目、需求、评估、决定、任务、提交、评审、变更与影响处置、事件时间线 |
| **契约优先协作** | 团队约定包 → 项目快照；OpenAPI 契约校验、发布、同源文档与 Mock；`contract-first-api` 编排 |
| **AI 辅助** | 评估建议、任务草稿、契约编排、材料提取；**一律草稿，人确认才生效** |
| **多 Agent** | 主体与凭据、委派、人类专属动作、项目角色、租约 + 心跳 + fencing、幂等命令、上下文快照 |
| **材料接入** | 会议纪要/文档导入 → 提取需求、约定、决定草稿（强制出处）→ 人采纳 |
| **运行保障** | 通知与偏好、备份与校验、健康检查、卡住任务识别、outbox 订阅与签名投递 |
| **外部工具** | Git/CI 只读事实摄入，作为提交证据与任务关联，不改任务状态 |
| **数据可迁移** | 数据库方言层（当前 SQLite）、整库导出/导入、DDL 草案 |

## 面板

Center 托管 Vue 3 + Element Plus 工作台：

```powershell
npm --prefix web install
npm --prefix web run build
npm run center
```

打开 <http://127.0.0.1:8787/sap-cloud/>。页面包括：项目驾驶舱、主干地图、需求工作台、任务工作台、变更影响台、契约与制品、材料与提取、主体与在线状态、事件时间线、设置。

## 快速开始

```powershell
npm test          # 单元测试（Center + Client）
npm run e2e       # 端到端：需求→任务→提交→评审→变更→影响
npm run center    # 启动 Center（默认 8787）
npm run client -- --help
```

首次启动无需配置：默认 SQLite、端口 8787。打开 `/sap-cloud/setup` 可完成初始化；模型可在设置页填入，未配置时 AI 功能返回 503，核心链不受影响。

## 仓库结构

```text
docs/      设计文档（00 背景 … 12 工具适配草案）
center/    中心服务（HTTP + SQLite，零第三方依赖）
client/    命令行客户端（只与 Center 交互）
web/       面板（Vue 3 + Element Plus，构建产物由 Center 托管）
logo.svg / logo.png / logo.ico / logo-preview.png   标识资源
```

## 设计文档

- [00 项目背景与问题定义](docs/00_项目背景.md)：为什么需要做，不解决什么
- [01 解决思路](docs/01_解决思路.md)：主干比喻、两种工作、约定变化、成立条件
- [02 核心概念与原则](docs/02_核心概念与原则.md)：术语、影响等级、AI 输出地位
- [03 总体架构](docs/03_总体架构.md)：组成、责任边界、核心流程、一期范围
- [04 详细方案](docs/04_详细方案.md)：对象、字段、状态、变更与影响记录
- [05 实施计划](docs/05_实施计划.md)：分层生长进度（T0–T15、P1–P5、A–G 已完成）
- [06 中心增强设计](docs/06_中心增强设计.md)：代码归置、模型接入、前端面板
- [07 数据库适配与部署](docs/07_数据库适配与部署.md)：启动门槛、配置分层、迁移路径
- [08 面板产品设计与 URL 契约](docs/08_面板产品设计与URL契约.md)：信息架构、示例项目、强制路径前缀
- [09 项目契约、编排与接口制品](docs/09_项目契约编排与接口制品.md)：约定包、编排模板、OpenAPI/文档/Mock
- [10 实施方案](docs/10_实施方案.md)：A–G 枝条的问题、交付与验收口径
- [11 多 Agent 接入设计](docs/11_多Agent接入设计.md)：身份、授权、租约与 fencing、协议、协作与观测
- [12 外部工具适配草案](docs/12_外部工具适配草案.md)：Git/CI 只读接入与 DSH/OpenCode 适配形态
- [原始材料](docs/多人协作AI辅助开发的想法.md)：未修改的原始想法

## 两条不变的原则

1. **AI 只出草稿。** 激活约定、发布契约、创建正式任务、评审通过，都必须由人或明确规则确认。
2. **主干只有一个来源。** 文档与 Mock 从同一份契约生成，不维护第二份事实。

## License

Apache License 2.0，见 [LICENSE](LICENSE)。
