# 11｜多 Agent 接入设计

> 状态：设计，待确认后实现。**本文按「最优」而非「最小」设计**：现在省下的结构，后面要用返工偿还。
> 基线：T0–T14 已推送（`d555b2b`）。零第三方依赖与「AI 只出草稿」两条不变。

## 1. 立场

【判断】多 Agent 不是「多几个 worker_id」，而是三件事同时成立：

1. **谁在行动** —— 可验证的主体，不是自由字符串；
2. **被允许做什么** —— 授权在服务端集中判定，不靠调用方自觉；
3. **行动是否仍有效** —— 认领是有期限的权利，不是一次性的状态位。

这三件事分别对应身份层、授权层、认领层。协议层与协作层建立在其上。任何一层做成「先凑合」，后面都会被历史数据锁死。

## 2. 身份层

### 2.1 主体

```text
actors
  actor_id        # act_
  type            # human | agent | service
  display_name
  status          # active | disabled
  created_at
  created_by      # 人类操作者
```

- `human`：真实成员，可做方向确认、评审、发布。
- `agent`：执行主体，**必须**通过 `delegations` 绑定人类责任人。
- `service`：集成账号（Git webhook、CI 回调），权限受限且不可签署。

### 2.2 凭据

```text
actor_credentials
  credential_id   # cred_
  actor_id
  token_hash      # 只存哈希，明文仅创建时返回一次
  label
  expires_at
  revoked_at
  last_used_at
  created_at
```

请求头 `Authorization: Bearer <token>`。撤销即时生效：每次请求校验 `revoked_at` 与 `expires_at`，不做长会话缓存。

### 2.3 委派（谁代表谁）

```text
delegations
  delegation_id   # dlg_
  agent_actor_id
  on_behalf_of    # human actor_id，必填
  project_id      # 可空＝全部项目
  allowed_actions # JSON：[claim, submit, report, propose, ...]
  valid_from / valid_until
  revoked_at
  created_by
```

【判断】用委派边而不是在 actor 上放一个 `owner` 字段：委派可撤销、可限项目、可限动作，还能表达「A 的 Agent 在项目 X 代表 B」。单字段做不到，且会迫使以后改表。

### 2.4 项目成员与角色

```text
project_members
  project_id / actor_id / roles(JSON) / added_at
  roles ⊆ [owner, contributor, reviewer, direction, publisher, observer]
```

角色只决定「能否被指派到对应动作」，具体动作是否允许仍由授权层判定。

## 3. 授权层

【判断】把权限判断从各路由散落的 `required(body,'confirmed_by')` 收敛到一个策略模块：

```text
can(actor, action, target) → allow | deny(code, reason)
```

### 3.1 人类专属动作（不可委托）

| 动作 | 说明 |
|---|---|
| `decision.confirm` | 需求接受/改级/拒绝 |
| `review.record` | 验收结论，且不得与提交者为同一 actor |
| `trunk_item.confirm` / `retire` | 主干生效与退役 |
| `convention_pack.activate` | 约定启用 |
| `artifact.publish` | 契约发布 |
| `trunk_change.confirm` / `activate` | 变更生效 |
| `impact_item.resolve` | 影响项判定为「无影响」 |

Agent 可以：认领、提交、报告、提出建议、创建草稿、登记候选影响（默认 `to_check`）。

### 3.2 职责分离

- 评审人 ≠ 提交人 ≠ 该任务当前 owner；
- 同一 actor 兼任多角色时，每个动作各记一次签署，不合并；
- 自审必须显式 `self_review=true` 且被策略允许（默认禁止于 `must` 级约定场景）。

### 3.3 兼容

现有记录的字符串身份保留，新增 `actor_type` 快照列（写入时冗余），并提供 `legacy:<name>` 映射，逐步转成 `actor_id`。**不要求一次性迁移历史数据。**

## 4. 认领层（租约 + fencing）

### 4.1 角色化认领

```text
claims
  claim_id / task_id / actor_id / role(owner|collaborator|observer)
  claimed_at / heartbeat_at / lease_expires_at
  fencing_token    # 单调递增，按 task 全局
  attempt_no
  status           # active | released | expired | completed | cancelled
  released_reason
```

- 同一任务**最多一个 `owner`**（部分唯一索引：`status='active' AND role='owner'`）；
- `collaborator` 可多个，用于同一任务的前后端分工；
- 只有 `owner` 能让任务进入 `submitted`；`collaborator` 的提交作为贡献记录，供 owner 汇总。

### 4.2 租约语义

- 认领时签发租约（默认 30 分钟）与 `fencing_token`；
- 心跳续租，续租必须校验：租约未过期、未撤销、actor 未禁用、委派仍有效；
- 过期 → `expired`，任务回 `open`，写事件；**过期租约不可复活**，只能重新认领拿新 token；
- 所有正式写操作（提交、状态推进）必须携带 token，且 `token >= 当前最大 token`；否则拒绝。

### 4.3 不承诺远端停止

【判断】租约只能保证「服务端不再接受旧权利的写入」，不能保证断网 Agent 停止执行。因此：

- 外部副作用必须登记 `operation_id`，事后可查询；
- 未知结果先查询再决定重试，禁止盲目重放；
- 文档与界面统一表述为「权利已失效」，不写「进程已停止」。

## 5. 协议层

### 5.1 命令信封

所有写操作统一携带：

```text
protocol_version   # 请求头 X-SAP-Protocol-Version，缺省 1
command_id         # 幂等键，客户端生成
expected_revision  # 目标对象当前 revision，冲突即拒绝
fencing_token      # 涉及任务的写操作必填
actor              # 由凭据解析，不接受客户端自填
causation_id       # 可选，串起一次协作链
```

### 5.2 命令账本（幂等）

```text
command_ledger
  command_id (PK) / actor_id / method / path
  payload_digest / status_code / response_digest
  created_at
```

同 `command_id` + 同摘要 → 返回首次结果；同 `command_id` + 不同摘要 → 409 `IDEMPOTENCY_CONFLICT`。

### 5.3 未知结果查询

```text
GET /command-results/:command_id
```

超时后客户端先查这里，而不是直接重试。

### 5.4 事件投递

```text
outbox
  event_id / topic / payload / created_at
  available_at / attempts / last_error / delivered_at
```

至少一次投递 + 消费端按 `event_id` 去重。Agent 可通过长轮询或 webhook 订阅 `task.available`、`task.reassigned`、`review.changed`。

## 6. 上下文层

```text
GET /sap-cloud/api/tasks/:id/context
→ {
    task, requirement, active_trunk, active_conventions,
    relevant_contracts, prior_submissions, review_history,
    policy: { allowed_actions, lease, fencing_token },
    digests: { ... },
    generated_at
  }
```

- 只投影该 actor 有权读的内容；
- 每块带 `digest`，Agent 回报时引用 digest，证明它看到的是哪一版；
- 上下文变化（契约升版、约定变更）应使未提交的尝试可感知：`staleness` 字段标注。

【判断】上下文包不是「把库里的东西全塞给模型」，而是**有版本、有权限、可追溯的一份快照**。这决定了后面能不能判断「Agent 是基于旧契约做错的」。

## 7. 调度层

- **拉取为主**：Agent 轮询/长轮询领取，中心不主动推任务，避免单点调度器成为故障源。
- **可选指派**：中心可 `assign`，但被指派方仍需显式 `claim`，保留拒绝权。
- **能力声明**：`actor_capabilities(actor_id, key, level)`，与模板节点的 `role_hint`、契约的 `outputs` 匹配。
- **匹配只做推荐**：推荐不构成授权，也不因历史分数永久封锁某个 Agent。

## 8. 协作层

| 场景 | 机制 |
|---|---|
| 同任务分工 | `owner` + 多个 `collaborator`，各自提交贡献记录 |
| 子任务拆分 | 由需求拆解产生新任务，`blocked_by` 表达依赖 |
| 交接 | 释放 + 新认领；历史认领保留，不覆盖 |
| 契约冲突 | 制品按 (project,type,name,version) 唯一；发布走事务替换，旧版 superseded |
| 多人评审 | 按策略多人，缺席不计通过 |

## 9. 观测层

- `GET /actors?status=active` 与心跳时间，识别离线；
- 卡住检测：租约临近过期且无进展、重复相同提交、长时间 `submitted` 未评审；
- 指标：领取延迟、租约过期率、提交-评审往返、幂等命中、未知结果数。

## 10. 数据模型变更清单

| 表 | 变更 |
|---|---|
| `actors` | 新增 |
| `actor_credentials` | 新增 |
| `delegations` | 新增 |
| `project_members` | 新增 |
| `actor_capabilities` | 新增 |
| `claims` | 加 `actor_id`、`role`、`heartbeat_at`、`lease_expires_at`、`fencing_token`、`attempt_no`、`released_reason`；owner 唯一部分索引 |
| `tasks` | 加 `revision`、`owner_actor_id`（冗余便于查询） |
| 各签署表 | 加 `actor_type` 快照；保留原字符串 |
| `command_ledger` | 新增 |
| `outbox` | 新增 |

## 11. 分期

| 阶段 | 内容 | 验收 |
|---|---|---|
| P1 身份与授权 | actors / credentials / delegations / project_members / policy；人类专属动作强制；legacy 映射 | Agent 凭据无法调用任何人类签署动作；人工流程不被破坏 |
| P2 认领与租约 | 角色化认领、租约心跳、fencing、过期与重新认领 | 过期后旧 token 写入被拒；owner 唯一；collab 可并行提交贡献 |
| P3 协议可靠性 | 命令账本、协议版本、未知结果查询、outbox | 重试不重复生效；超时后先查结果 |
| P4 Agent 接入 | context 包、pull/claim/heartbeat/deliver、能力匹配 | 一个真实 Agent 从领取到交付全程无需人拼接口 |
| P5 观测与调度 | 在线状态、卡住检测、指标、可选指派 | 能回答「谁在线、谁卡住、为什么」 |

P1/P2 必须先做：它们改的是数据模型与写入校验，越晚越贵。P3 可与 P4 合并交付。

## 12. 明确不做

- 中心化「总调度器」替所有 Agent 决策；
- Agent 之间自由对话总线（会产生无法追溯的决策来源）；
- 跨机分布式锁与共识（SQLite 单写者够用前不做）；
- 自动让 Agent 通过评审或发布契约。

## 13. 确认点

1. [ ] 接受 §2–§5 的身份/授权/租约/协议四层设计，按其实现而非简化。
2. [ ] Agent 必须绑定人类责任人（`delegations` 必填）作为硬约束。
3. [ ] 人类专属动作清单（§3.1）是否照此执行，是否需要增删。
4. [ ] 同一任务允许多 `collaborator`，但只有 owner 能提交任务级结果——是否同意。
5. [ ] 租约 30 分钟 / 心跳 5 分钟 / fencing 从 P2 就上——是否同意。
6. [ ] P1 是否立即开始；P1 是否会推迟「A 契约与制品工作区」（建议 P1 优先）。

[10｜实施方案]: <./10_实施方案.md>
[07｜数据库适配与部署]: <./07_数据库适配与部署.md>
