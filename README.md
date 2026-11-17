# SuperAgentPlusCloud

云端版“分布式人机协作与治理系统”设计仓库：中心服务器承载权威状态与协作协议，人类终端承载 G1 操作者初审、G2 独立验收、G3 总工方向/结构裁决。

这是**设计提案**，不是可运行系统。仓库只包含文档、两张可交互图示和文档级检查脚本；不包含服务端实现、CLI、数据库或部署配置。

## 先看什么

| 文档 | 内容 |
|---|---|
| [阅读导航](SuperAgentPlus/README.md) | 七/八节结构、角色与三条阅读线 |
| [01 定位与总体构想](SuperAgentPlus/01_定位与总体构想.md) | 为什么需要治理、中心/终端承载边界、G1/G2/G3 |
| [02 协作治理与生命周期](SuperAgentPlus/02_协作治理与生命周期.md) | 任务状态、验收对象、方向对象、恢复语义 |
| [03 系统架构与协作协议](SuperAgentPlus/03_系统架构与协作协议.md) | 组件、命令、事件、权限与并发 |
| [04 场景推演与协作体验](SuperAgentPlus/04_场景推演与协作体验.md) | 典型场景与工作台要求 |
| [05 MVP 与设计验证路线](SuperAgentPlus/05_MVP与设计验证路线.md) | 最小验证、测试门槛、待确认项 |
| [06 工作契约与决策模板](SuperAgentPlus/06_工作契约与决策模板.md) | G1/G2/G3 模板与示例 |
| [07 总工信息隔离](SuperAgentPlus/07_总工信息隔离.md) | 方向层/操作层、信息闸门、按需细节包 |
| [08 云端与单机职责边界](SuperAgentPlus/08_云端与单机职责边界.md) | 云端治理 vs 单机方向连续性 |
| [设计检查说明](SuperAgentPlus/设计检查说明.md) | 检查范围、图示验证与未证明事项 |

## 图示

- [系统架构图](SuperAgentPlus/diagrams/architecture/architecture.html)：承载边界与 G1/G2/G3。
- [协作闭环图](SuperAgentPlus/diagrams/workflow/workflow.html)：G1 初审与 G2 验收的交付闭环，G3 另走方向简报。

两张图是设计表达，不是应用界面原型。

## 检查

```bash
python SuperAgentPlus/diagrams/check-docs.py
```

脚本只做文档级检查：链接目标、UTF-8、表格列数、代码围栏、图示文件存在性与摘要。它不证明语义正确或系统已实现。结果写入 `SuperAgentPlus/diagrams/document-check.json`。

## 相关仓库

- 单机版插件与设计：[SuperAgentPlusLocal](https://github.com/DouLion/SuperAgentPlusLocal)

## 边界

- **没有实现**：本文档不声称任一 CLI、服务端、数据库、权限系统或 G3 联合裁决已经可运行。
- **没有审批简化**：云端有 G1/G2/G3；单机版没有审批，不要把云端 G1/G2/G3 搬进 `.sap.local`。
- **没有绩效定论**：贡献记录是可选扩展，不等于自动价值排名。

## License

Apache License 2.0，见 [LICENSE](LICENSE)。
