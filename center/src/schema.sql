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
  claimed_at  TEXT NOT NULL,
  released_at TEXT,
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
  change_id         TEXT NOT NULL REFERENCES trunk_changes (change_id),
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
