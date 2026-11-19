-- SuperAgentPlus Center 数据库结构
-- 依据 docs/04_详细方案.md；所有 CREATE 均带 IF NOT EXISTS，可重复执行。
-- JSON 字段统一以 TEXT 存储（内容为 JSON 数组/对象文本）。

PRAGMA foreign_keys = ON;

-- 项目 --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS projects (
  project_id    TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  purpose       TEXT,
  scope_summary TEXT,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'paused', 'archived')),
  policy_ref    TEXT,
  created_at    TEXT NOT NULL,
  created_by    TEXT
);

CREATE INDEX IF NOT EXISTS idx_projects_status ON projects (status);

-- 主干条目 ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trunk_items (
  item_id       TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects (project_id),
  kind          TEXT NOT NULL
                CHECK (kind IN ('goal', 'scope', 'capability', 'business_rule',
                                'interface', 'data_contract',
                                'architecture_decision', 'other')),
  statement     TEXT NOT NULL,
  rationale     TEXT,
  status        TEXT NOT NULL DEFAULT 'proposed'
                CHECK (status IN ('proposed', 'active', 'superseded', 'retired')),
  valid_from    TEXT,
  valid_until   TEXT,
  relations     TEXT NOT NULL DEFAULT '[]',
  source_refs   TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL,
  created_by    TEXT,
  confirmed_at  TEXT,
  confirmed_by  TEXT,
  superseded_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_trunk_items_project ON trunk_items (project_id);
CREATE INDEX IF NOT EXISTS idx_trunk_items_status ON trunk_items (status);
CREATE INDEX IF NOT EXISTS idx_trunk_items_project_status
  ON trunk_items (project_id, status);

-- 需求 --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS requirements (
  requirement_id   TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects (project_id),
  author           TEXT,
  source_ref       TEXT,
  raw_text         TEXT NOT NULL,
  attachments      TEXT NOT NULL DEFAULT '[]',
  claimed_level    TEXT,
  claimed_reason   TEXT,
  related_item_ids TEXT NOT NULL DEFAULT '[]',
  status           TEXT NOT NULL DEFAULT 'submitted'
                   CHECK (status IN ('submitted', 'needs_info', 'assessed',
                                     'accepted', 'rejected', 'cancelled')),
  -- 已确认的最终等级（仅决定为 accepted/relevelled 时写入）；
  -- 与提交者自报的 claimed_level 分开保存，不覆盖原文与自报信息。
  final_level      TEXT,
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_requirements_project ON requirements (project_id);
CREATE INDEX IF NOT EXISTS idx_requirements_status ON requirements (status);

-- 评估 --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assessments (
  assessment_id   TEXT PRIMARY KEY,
  requirement_id  TEXT NOT NULL REFERENCES requirements (requirement_id),
  assessed_level  TEXT,
  related_item_ids TEXT NOT NULL DEFAULT '[]',
  impact_summary  TEXT,
  uncertainties    TEXT NOT NULL DEFAULT '[]',
  proposed_action TEXT
                   CHECK (proposed_action IN
                     ('accept', 'relevel', 'ask', 'reject', 'investigate')),
  assessor_type   TEXT
                   CHECK (assessor_type IN ('AI', 'human', 'rule')),
  assessor_id     TEXT,
  created_at      TEXT NOT NULL,
  source_refs     TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_assessments_requirement
  ON assessments (requirement_id);

-- 决定 --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS decisions (
  decision_id    TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL REFERENCES requirements (requirement_id),
  conclusion     TEXT NOT NULL
                 CHECK (conclusion IN ('accepted', 'relevelled', 'needs_info',
                                       'rejected', 'deferred')),
  final_level    TEXT,
  reason         TEXT,
  confirmed_by   TEXT,
  confirmed_at   TEXT,
  policy_ref     TEXT,
  assessment_ref TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_decisions_requirement
  ON decisions (requirement_id);

-- 任务 --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
  task_id              TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES projects (project_id),
  requirement_id       TEXT REFERENCES requirements (requirement_id),
  serves_item_ids      TEXT NOT NULL DEFAULT '[]',
  related_question_id  TEXT,
  purpose              TEXT,
  scope                TEXT,
  non_scope            TEXT,
  done_when            TEXT NOT NULL DEFAULT '[]',
  acceptance_evidence  TEXT NOT NULL DEFAULT '[]',
  blocked_by           TEXT NOT NULL DEFAULT '[]',
  status               TEXT NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft', 'open', 'claimed', 'submitted',
                                         'rework', 'accepted', 'closed',
                                         'cancelled')),
  revision             INTEGER NOT NULL DEFAULT 1,
  role_hint            TEXT,
  created_by           TEXT,
  created_at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks (project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);
CREATE INDEX IF NOT EXISTS idx_tasks_requirement ON tasks (requirement_id);

-- 认领 --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS claims (
  claim_id    TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks (task_id),
  worker_id   TEXT,
  actor_id    TEXT,
  role        TEXT NOT NULL DEFAULT 'owner'
              CHECK (role IN ('owner', 'collaborator')),
  claimed_at  TEXT NOT NULL,
  heartbeat_at TEXT,
  lease_expires_at TEXT,
  fencing_token INTEGER NOT NULL DEFAULT 0,
  attempt_no  INTEGER NOT NULL DEFAULT 1,
  released_at TEXT,
  released_reason TEXT,
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'released', 'completed', 'expired')),
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_claims_task ON claims (task_id);
CREATE INDEX IF NOT EXISTS idx_claims_status ON claims (status);

-- 提交 --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS submissions (
  submission_id  TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks (task_id),
  claim_id       TEXT REFERENCES claims (claim_id),
  commit_refs    TEXT NOT NULL DEFAULT '[]',
  summary        TEXT,
  self_test      TEXT,
  known_gaps     TEXT NOT NULL DEFAULT '[]',
  artifacts      TEXT NOT NULL DEFAULT '[]',
  external_fact_ids TEXT NOT NULL DEFAULT '[]',
  submitted_by   TEXT,
  submitted_at   TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_submissions_task ON submissions (task_id);
CREATE INDEX IF NOT EXISTS idx_submissions_claim ON submissions (claim_id);

-- 评审 --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reviews (
  review_id         TEXT PRIMARY KEY,
  submission_id     TEXT NOT NULL REFERENCES submissions (submission_id),
  reviewer_id       TEXT,
  conclusion        TEXT NOT NULL
                    CHECK (conclusion IN ('confirm', 'reject', 'needs_info')),
  criterion_results TEXT NOT NULL DEFAULT '[]',
  reason            TEXT,
  self_review       INTEGER NOT NULL DEFAULT 0,
  reviewed_at       TEXT NOT NULL,
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reviews_submission ON reviews (submission_id);

-- 主干变更 ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trunk_changes (
  change_id              TEXT PRIMARY KEY,
  project_id             TEXT NOT NULL REFERENCES projects (project_id),
  trigger_requirement_id TEXT REFERENCES requirements (requirement_id),
  old_item_ids           TEXT NOT NULL DEFAULT '[]',
  proposed_item_ids      TEXT NOT NULL DEFAULT '[]',
  reason                 TEXT,
  impact_assessment      TEXT,
  confirmed_by           TEXT,
  confirmed_at           TEXT,
  effective_at           TEXT,
  -- 确认所依据的政策/规范引用；与 decisions.policy_ref 保持一致。
  policy_ref             TEXT,
  status                 TEXT NOT NULL DEFAULT 'proposed'
                         CHECK (status IN ('proposed', 'confirmed', 'in_effect',
                                           'closed')),
  created_at             TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trunk_changes_project
  ON trunk_changes (project_id);
CREATE INDEX IF NOT EXISTS idx_trunk_changes_status
  ON trunk_changes (status);

-- 影响对象 ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS impact_items (
  impact_item_id    TEXT PRIMARY KEY,
  change_id         TEXT REFERENCES trunk_changes (change_id),
  source_type       TEXT NOT NULL DEFAULT 'trunk_change'
                    CHECK (source_type IN ('trunk_change', 'artifact')),
  source_id         TEXT,
  target_type       TEXT NOT NULL
                    CHECK (target_type IN
                      ('task', 'submission', 'document', 'test', 'other')),
  target_id         TEXT,
  assessment_status TEXT NOT NULL DEFAULT 'to_check'
                    CHECK (assessment_status IN
                      ('to_check', 'affected', 'not_affected')),
  resolution        TEXT NOT NULL DEFAULT 'pending'
                    CHECK (resolution IN
                      ('continue', 'adjust', 'revalidate', 'obsolete', 'pending')),
  reason            TEXT,
  owner_id          TEXT,
  updated_at        TEXT NOT NULL,
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_impact_items_change
  ON impact_items (change_id);
CREATE INDEX IF NOT EXISTS idx_impact_items_assessment
  ON impact_items (assessment_status);
CREATE INDEX IF NOT EXISTS idx_impact_items_source
  ON impact_items (source_type, source_id);

-- 事件与审计 --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  event_id     TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects (project_id),
  object_type  TEXT,
  object_id    TEXT,
  event_type   TEXT NOT NULL,
  actor        TEXT,
  occurred_at  TEXT NOT NULL,
  recorded_at  TEXT NOT NULL,
  reason       TEXT,
  refs         TEXT NOT NULL DEFAULT '[]',
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_project ON events (project_id);
CREATE INDEX IF NOT EXISTS idx_events_object
  ON events (object_type, object_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events (event_type);

-- AI 建议（T8）-------------------------------------------------------------
-- 只保存模型产出的建议/草稿与原始响应，不改变任何业务状态。
CREATE TABLE IF NOT EXISTS ai_suggestions (
  suggestion_id  TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  requirement_id TEXT,
  change_id      TEXT,
  kind           TEXT NOT NULL CHECK (kind IN ('assessment', 'task_plan', 'impact', 'contract_orchestration')),
  payload        TEXT NOT NULL,
  raw_response   TEXT,
  model          TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_suggestions_project
  ON ai_suggestions (project_id);
CREATE INDEX IF NOT EXISTS idx_ai_suggestions_requirement
  ON ai_suggestions (requirement_id);
CREATE INDEX IF NOT EXISTS idx_ai_suggestions_change
  ON ai_suggestions (change_id);

-- 团队/项目约定包（T12）-----------------------------------------------------
-- 团队模板可被多个项目导入；导入后形成独立项目快照，不随模板自动覆盖。
CREATE TABLE IF NOT EXISTS convention_packs (
  pack_id       TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'active', 'superseded', 'retired')),
  version       INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  scope         TEXT NOT NULL CHECK (scope IN ('team', 'project')),
  project_id    TEXT REFERENCES projects (project_id),
  rules         TEXT NOT NULL DEFAULT '[]',
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  activated_at  TEXT,
  supersedes    TEXT REFERENCES convention_packs (pack_id),
  imported_from TEXT REFERENCES convention_packs (pack_id)
);

CREATE INDEX IF NOT EXISTS idx_convention_packs_scope_status
  ON convention_packs (scope, status);
CREATE INDEX IF NOT EXISTS idx_convention_packs_project_status
  ON convention_packs (project_id, status);

-- 编排模板（T12）-------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workflow_templates (
  template_id  TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  status       TEXT NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft', 'active', 'superseded', 'retired')),
  version      INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  project_id   TEXT REFERENCES projects (project_id),
  kind         TEXT NOT NULL,
  nodes        TEXT NOT NULL DEFAULT '[]',
  created_by   TEXT,
  created_at   TEXT NOT NULL,
  activated_at TEXT,
  supersedes   TEXT REFERENCES workflow_templates (template_id),
  built_in     INTEGER NOT NULL DEFAULT 0 CHECK (built_in IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_workflow_templates_project_status
  ON workflow_templates (project_id, status);
CREATE INDEX IF NOT EXISTS idx_workflow_templates_kind_status
  ON workflow_templates (kind, status);

-- 全局定义事件（T12）---------------------------------------------------------
-- 团队模板/内置模板可能没有 project_id，不能写入 project_id 必填的 events。
CREATE TABLE IF NOT EXISTS definition_events (
  event_id    TEXT PRIMARY KEY,
  project_id  TEXT REFERENCES projects (project_id),
  object_type TEXT NOT NULL CHECK (object_type IN (
                'convention_pack', 'workflow_template',
                'actor', 'credential', 'delegation', 'project_member'
              )),
  object_id   TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  actor       TEXT NOT NULL,
  reason      TEXT NOT NULL,
  refs        TEXT NOT NULL DEFAULT '[]',
  occurred_at TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_definition_events_object
  ON definition_events (object_type, object_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_definition_events_project
  ON definition_events (project_id, occurred_at);

-- 项目制品（T13）-------------------------------------------------------------
-- API 文档与 Mock 均从 api_contract content 生成，不维护第二份事实。
CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id          TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES projects (project_id),
  type                 TEXT NOT NULL CHECK (type IN (
                         'api_contract', 'api_document', 'mock_definition',
                         'document', 'schema', 'test_report'
                       )),
  name                 TEXT NOT NULL,
  version              INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  status               TEXT NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft', 'published', 'superseded', 'retired')),
  content              TEXT NOT NULL,
  digest               TEXT NOT NULL,
  source_task_id       TEXT REFERENCES tasks (task_id),
  source_submission_id TEXT REFERENCES submissions (submission_id),
  created_by           TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  published_by         TEXT,
  published_at         TEXT,
  supersedes           TEXT REFERENCES artifacts (artifact_id)
);

CREATE INDEX IF NOT EXISTS idx_artifacts_project_type_status
  ON artifacts (project_id, type, status);
CREATE INDEX IF NOT EXISTS idx_artifacts_project_name_version
  ON artifacts (project_id, name, version);

-- 身份与授权（P1）------------------------------------------------------------
-- 主体：人类 / Agent / 服务账号。Agent 必须通过 delegations 绑定人类责任人。
CREATE TABLE IF NOT EXISTS actors (
  actor_id     TEXT PRIMARY KEY,
  type         TEXT NOT NULL CHECK (type IN ('human', 'agent', 'service')),
  display_name TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  is_admin     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  created_by   TEXT
);

CREATE INDEX IF NOT EXISTS idx_actors_type_status ON actors (type, status);

-- 凭据：只存 token 哈希，明文仅在签发时返回一次。
CREATE TABLE IF NOT EXISTS actor_credentials (
  credential_id TEXT PRIMARY KEY,
  actor_id      TEXT NOT NULL REFERENCES actors (actor_id),
  token_hash    TEXT NOT NULL UNIQUE,
  label         TEXT,
  expires_at    TEXT,
  revoked_at    TEXT,
  last_used_at  TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_credentials_actor ON actor_credentials (actor_id);

-- 委派：Agent 代表某个人类行动，可限项目、限动作、可撤销。
CREATE TABLE IF NOT EXISTS delegations (
  delegation_id   TEXT PRIMARY KEY,
  agent_actor_id  TEXT NOT NULL REFERENCES actors (actor_id),
  on_behalf_of    TEXT NOT NULL REFERENCES actors (actor_id),
  project_id      TEXT REFERENCES projects (project_id),
  allowed_actions TEXT NOT NULL DEFAULT '[]',
  valid_from      TEXT NOT NULL,
  valid_until     TEXT NOT NULL,
  revoked_at      TEXT,
  created_by      TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_delegations_agent ON delegations (agent_actor_id);
CREATE INDEX IF NOT EXISTS idx_delegations_project ON delegations (project_id);

-- 项目成员：角色只决定可被指派到哪些动作，具体仍由策略判断。
CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL REFERENCES projects (project_id),
  actor_id   TEXT NOT NULL REFERENCES actors (actor_id),
  roles      TEXT NOT NULL DEFAULT '[]',
  added_at   TEXT NOT NULL,
  PRIMARY KEY (project_id, actor_id)
);

CREATE INDEX IF NOT EXISTS idx_members_project ON project_members (project_id);

-- 协议层（P3）----------------------------------------------------------------
-- 命令账本：同 command_id + 同摘要返回首次结果，同键异摘要视为冲突。
CREATE TABLE IF NOT EXISTS command_ledger (
  command_id      TEXT PRIMARY KEY,
  actor_id        TEXT NOT NULL DEFAULT 'legacy',
  method          TEXT NOT NULL,
  path            TEXT NOT NULL,
  payload_digest  TEXT NOT NULL,
  status_code     INTEGER NOT NULL,
  response_body   TEXT NOT NULL,
  content_type    TEXT NOT NULL DEFAULT 'application/json; charset=utf-8',
  response_headers TEXT NOT NULL DEFAULT '{}',
  replay_count    INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_command_ledger_created ON command_ledger (created_at);

-- 事件投递：至少一次投递 + 消费端按 event_id 去重。
CREATE TABLE IF NOT EXISTS outbox (
  event_id     TEXT PRIMARY KEY,
  topic        TEXT NOT NULL,
  payload      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  available_at TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  delivered_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbox_available ON outbox (available_at);
CREATE INDEX IF NOT EXISTS idx_outbox_delivered ON outbox (delivered_at);

-- Agent 能力（P4）------------------------------------------------------------
-- 能力只用于推荐匹配，不构成授权；授权仍由 delegations 与 policy 判定。
CREATE TABLE IF NOT EXISTS actor_capabilities (
  actor_id   TEXT NOT NULL REFERENCES actors (actor_id),
  key        TEXT NOT NULL,
  level      TEXT NOT NULL CHECK (level IN ('basic', 'standard', 'expert')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (actor_id, key)
);

CREATE INDEX IF NOT EXISTS idx_capabilities_key ON actor_capabilities (key);


-- 材料与提取（C 枝）----------------------------------------------------------
-- 材料保留原文；提取只产出 draft，人采纳后才变成正式需求或约定。
CREATE TABLE IF NOT EXISTS materials (
  material_id TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects (project_id),
  title       TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('meeting', 'design', 'chat', 'doc', 'other')),
  content     TEXT NOT NULL,
  source_ref  TEXT,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_materials_project ON materials (project_id);
CREATE INDEX IF NOT EXISTS idx_materials_kind ON materials (kind);

CREATE TABLE IF NOT EXISTS material_extractions (
  extraction_id TEXT PRIMARY KEY,
  material_id   TEXT NOT NULL REFERENCES materials (material_id),
  kind          TEXT NOT NULL CHECK (kind IN ('requirement', 'convention', 'decision')),
  payload       TEXT NOT NULL,
  raw_response  TEXT,
  model         TEXT,
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'accepted', 'rejected')),
  accepted_ref  TEXT,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  accepted_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_extractions_material ON material_extractions (material_id);
CREATE INDEX IF NOT EXISTS idx_extractions_kind_status ON material_extractions (kind, status);


-- 站内通知（E 枝）-------------------------------------------------------------
-- 通知是「提醒」，不是「权利」：读或不读都不改变业务状态；dedupe_key 保证同一事实不重复推送。
CREATE TABLE IF NOT EXISTS notifications (
  notification_id TEXT PRIMARY KEY,
  actor_id        TEXT NOT NULL REFERENCES actors (actor_id),
  project_id      TEXT REFERENCES projects (project_id),
  kind            TEXT NOT NULL CHECK (kind IN (
                    'task_available', 'review_requested', 'decision_required',
                    'impact_to_check', 'lease_expiring', 'system'
                  )),
  title           TEXT NOT NULL,
  body            TEXT,
  ref_type        TEXT,
  ref_id          TEXT,
  dedupe_key      TEXT NOT NULL UNIQUE,
  created_at      TEXT NOT NULL,
  read_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_notifications_actor_read ON notifications (actor_id, read_at);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications (created_at);

CREATE TABLE IF NOT EXISTS notification_prefs (
  actor_id TEXT NOT NULL REFERENCES actors (actor_id),
  kind     TEXT NOT NULL,
  enabled  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (actor_id, kind)
);


-- 外部工具只读事实（G 枝）------------------------------------------------------
-- 外部事实只是证据：可以引用、可以关联到任务，但不改变任何业务状态。
CREATE TABLE IF NOT EXISTS external_facts (
  fact_id     TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects (project_id),
  source      TEXT NOT NULL CHECK (source IN ('git', 'ci', 'issue', 'chat', 'other')),
  kind        TEXT NOT NULL CHECK (kind IN ('commit', 'build', 'test_run', 'issue', 'message')),
  external_id TEXT NOT NULL,
  payload     TEXT NOT NULL,
  received_at TEXT NOT NULL,
  actor_id    TEXT,
  dedupe_key  TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_external_facts_project ON external_facts (project_id, source);
CREATE INDEX IF NOT EXISTS idx_external_facts_kind ON external_facts (kind);

CREATE TABLE IF NOT EXISTS task_fact_links (
  task_id   TEXT NOT NULL REFERENCES tasks (task_id),
  fact_id   TEXT NOT NULL REFERENCES external_facts (fact_id),
  linked_by TEXT,
  linked_at TEXT NOT NULL,
  PRIMARY KEY (task_id, fact_id)
);

CREATE INDEX IF NOT EXISTS idx_task_fact_links_fact ON task_fact_links (fact_id);

CREATE TABLE IF NOT EXISTS outbox_subscriptions (
  subscription_id TEXT PRIMARY KEY,
  url             TEXT NOT NULL,
  topics          TEXT NOT NULL DEFAULT '[]',
  secret          TEXT,
  created_at      TEXT NOT NULL,
  disabled_at     TEXT
);



