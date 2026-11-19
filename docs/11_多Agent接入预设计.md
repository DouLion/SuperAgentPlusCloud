# 11｜多 Agent 接入预设计

> 状态：评估与预埋清单。**本文不授权实现**，只回答「以后接多个 Agent 方不方便、现在要先埋什么」。
> 基线：T0–T14 已推送（`d555b2b`）。

## 1. 结论

**能接，而且大部分不用改。** 现有领域模型已经把「工作单元 → 认领 → 提交 → 评审」拆开了，`blocked_by` 也能表达并行依赖，DAG 天然容纳多个执行者。

但有 **4 处现在不埋、以后很贵** 的东西，建议在下一枝之前顺手补掉，代价很小：

1. 身份只有字符串，没有「人 / Agent / 服务」的类型区分；
2. 认领只有 `claimed_at`，没有租约与心跳，Agent 挂掉后任务会永久卡住；
3. 人类签署端点没有强制「操作者是人」；
4. 没有统一的「任务上下文包」端点，Agent 接入要自己拼 5 个接口。

## 2. 现状盘点

### 已经就绪

| 能力 | 现状 |
|---|---|
| 工作单元 | `tasks` 有 purpose/scope/non_scope/done_when/serves_item_ids |
| 并发认领 | `claimTask` 单事务条件更新，只有一人成功 |
| 依赖与并行 | `tasks.blocked_by` + `contract-first-api` 模板给出并行前端/后端、汇合联调 |
| 结果锚定 | `submissions.commit_refs` + `artifact_id` |
| 评审 | `reviews.criterion_results` 逐条对应 done_when |
| 约定与契约 | 约定包、OpenAPI 契约、校验、文档、Mock |
| AI 建议 | `ai_suggestions`，一律草稿，人采纳才落对象 |

### 缺口

| 缺口 | 影响的 Agent 场景 |
|---|---|
| 无 `actors` 表，`worker_id` / `confirmed_by` 都是自由文本 | 无法区分 Agent 与人，无法阻止 Agent 冒充签署 |
| 认领无租约/心跳/过期 | Agent 崩溃后任务永久 `claimed`，只能人工 SQL 修 |
| 无能力声明 | 派活只能靠人指定，无法按「谁擅长什么」匹配 |
| 无上下文包端点 | Agent 要自行聚合需求、主干、约定、契约、完成条件 |
| 无协议版本与幂等键 | 多版本 Agent 共存、网络重试时容易重复提交 |
| 无运行状态可见性 | 不知道哪个 Agent 在线、卡住、超时 |

## 3. 现在就该预埋（低成本，防返工）

### 3.1 身份分层（最重要）

```text
actors
  actor_id      # 唯一主体 ID
  type          # human | agent | service
  display_name
  project_id    # 可选；agent 通常绑定项目
  status        # active / disabled
  created_at
  owner_actor_id  # agent 的人类责任人，必填（agent 才有）
```

【判断】现在改，是因为**历史记录里的字符串身份事后无法回溯分类**。加表后，`worker_id`、`confirmed_by`、`submitted_by`、`reviewer_id` 保留为字符串以兼容，但可以逐步映射到 `actor_id`，并新增 `actor_type` 快照字段（写入时冗余存），这样老数据不迁移也能区分。

### 3.2 人类签署强制

下列动作现在只校验字符串非空，接入 Agent 后必须校验「操作者是人类」：

- `decision.confirmed_by`（需求决定）
- `review.reviewer_id`（评审，且不得等于提交者）
- `convention_pack.activated_by`
- `artifact.published_by`
- `trunk_item.confirmed_by`

【判断】Agent 可以提交、可以认领、可以产出候选，但不能代表人类确认方向、验收或发布。这条如果不提前写进校验，等接了 Agent 再补，历史数据里可能已经混入 Agent 签名。

### 3.3 认领升级为租约

```text
claims 增加
  lease_expires_at   # 到期时间
  heartbeat_at       # 最近心跳
  attempt_no         # 第几次尝试
  released_reason    # released / expired / cancelled / completed
```

- 认领时给默认租约（如 30 分钟），Agent 需定期 `heartbeat` 续租；
- 过期后任务回到 `open`，写 `claim.expired` 事件，不删除历史；
- 不做 fencing token 也可以先跑，但要在文档里标明「到期不保证远端停止执行」，后续加 token 时不用改语义。

### 3.4 上下文包端点

```text
GET /sap-cloud/api/tasks/:id/context
→ {
    task, requirement, active_trunk, active_conventions,
    relevant_contracts, done_when, blocked_by, upstream_submissions
  }
```

一次取全，人和 Agent 都能用。面板详情页也能复用，不算额外成本。

### 3.5 协议版本与幂等

- 请求头 `X-SAP-Protocol-Version: 1`（缺省按 1 处理）；
- 关键写操作（claim / deliver / review）接受 `command_id`，重复提交返回首次结果。

## 4. 之后的接入路径（不在本轮）

| 阶段 | 内容 | 依赖 |
|---|---|---|
| P1 | `actors` + 人类签署校验 + 租约心跳 + 上下文包 | 本文 §3 |
| P2 | Agent 接入协议：`poll → claim → context → heartbeat → deliver`，含取消与未知结果查询 | P1 |
| P3 | 能力声明与匹配派活（role_hint 已存在于模板节点） | P2 |
| P4 | 多 Agent 协作：同一任务多人协作、子任务拆分、跨 Agent 交接 | P3 |
| P5 | 外部工具适配（Git/CI/DSH/OpenCode） | P2 |

【判断】不要把「多 Agent」做成一个中心编排器去指挥所有 Agent。现有模型是「任务池 + 自行认领 + 结构化交付」，这比中心派单更耐故障，也更容易审计。

## 5. 不建议现在做

- 通用 Agent 编排框架、A2A/MCP 全自动接入；
- 跨机高可用、分布式锁、消息队列（等出现真实并发瓶颈）；
- Agent 之间的自由对话总线（会产生无法追溯的决策来源）。

## 6. 确认点

1. [ ] 是否现在补 §3 的 5 项预埋（建议：补 3.1–3.4，3.5 可随 P2 一起）。
2. [ ] Agent 必须绑定人类责任人（`owner_actor_id`）是否作为硬约束。
3. [ ] 人类签署端点是否立即强制 `type=human`（会使现有自由字符串调用受限，需要同时给出 `actors` 创建入口）。
4. [ ] 租约默认时长与心跳间隔（建议 30 分钟 / 5 分钟）。
5. [ ] 是否把 P1 与「A 契约与制品工作区」合并成下一次的两步，还是先做 P1。

[10｜实施方案]: <./10_实施方案.md>
[09｜项目契约、编排模板与接口制品]: <./09_项目契约编排与接口制品.md>
