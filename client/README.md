# SuperAgentPlus Client

命令行客户端，供参与者（提出者 / 执行者 / 评审者）与 Center 交互。
**只调用 Center HTTP 接口，不接入任何编码 CLI。**

- 运行时：Node.js v26+，全部 ESM。
- 依赖：零第三方依赖，仅 Node 内置模块。
- 当前进度：**T0 骨架**，`sap --help` 可用，命令实现从 T2 起逐层补齐。

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
| `CENTER_URL` | `http://127.0.0.1:8787` | Center 服务根地址 |

先启动 Center：`node center/bin/center.mjs`（默认端口 `CENTER_PORT=8787`）。

```powershell
$env:CENTER_URL = "http://127.0.0.1:9000"
node bin/sap.mjs --help
```

## 命令规划

| 命令 | 用途 | 实现层 |
|---|---|---|
| `submit` | 提交需求/问题，保留原文与材料引用 | T2 |
| `decide` | 确认决定：接受 / 改级 / 追问 / 拒绝 / 延后 | T2 |
| `tasks` | 查看任务、范围与完成条件 | T3 |
| `claim` | 原子认领任务、释放 | T3 |
| `deliver` | 提交成果（commit 引用、自测证据） | T4 |
| `review` | 按完成条件逐项评审（确认 / 打回 / 需补充） | T4 |
| `trunk` | 查看与提出主干条目 | T5 |
| `change` | 主干变更、影响清单逐项处置 | T5 |

命令实现后，参数解析统一放在 `client/src/commands/`，HTTP 调用集中在 `client/src/api.mjs`。

## 测试

```powershell
cd client
npm test                  # = node --test test/
```
