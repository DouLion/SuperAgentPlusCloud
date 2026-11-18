// Center 存储层（T1）：基于 node:sqlite 的 SQLite 访问封装。
// 零外部依赖；JSON 字段以 TEXT 存储，读取时解析为 JS 值。

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.dirname(HERE);
const SCHEMA_PATH = path.join(HERE, 'schema.sql');

/** 默认数据库文件：center/data/center.db */
export const DEFAULT_DB_PATH = path.join(PACKAGE_ROOT, 'data', 'center.db');

export const TRUNK_ITEM_KINDS = [
  'goal',
  'scope',
  'capability',
  'business_rule',
  'interface',
  'data_contract',
  'architecture_decision',
  'other',
];

export const TRUNK_ITEM_STATUSES = ['proposed', 'active', 'superseded', 'retired'];

export const PROJECT_STATUSES = ['active', 'paused', 'archived'];

export const REQUIREMENT_STATUSES = [
  'submitted',
  'needs_info',
  'assessed',
  'accepted',
  'rejected',
  'cancelled',
];

/** 影响等级；undecided 表示评估未完成定级。 */
export const LEVELS = ['L0', 'L1', 'L2', 'L3', 'L4'];
export const ASSESSMENT_LEVELS = [...LEVELS, 'undecided'];

export const PROPOSED_ACTIONS = ['accept', 'relevel', 'ask', 'reject', 'investigate'];

export const ASSESSOR_TYPES = ['AI', 'human', 'rule'];

export const DECISION_CONCLUSIONS = [
  'accepted',
  'relevelled',
  'needs_info',
  'rejected',
  'deferred',
];

/** 任务状态机：draft → open → claimed → submitted → accepted → closed；rework 为打回分支。 */
export const TASK_STATUSES = [
  'draft',
  'open',
  'claimed',
  'submitted',
  'rework',
  'accepted',
  'closed',
  'cancelled',
];

/** 认领状态：active 为当前持有；released/completed/expired 保留历史。 */
export const CLAIM_STATUSES = ['active', 'released', 'completed', 'expired'];

/** 评审结论：confirm 通过、reject 打回、needs_info 待补充信息。 */
export const REVIEW_CONCLUSIONS = ['confirm', 'reject', 'needs_info'];

/** 决定结论 → 需求状态。 */
export const DECISION_STATUS_MAP = {
  accepted: 'accepted',
  relevelled: 'accepted',
  needs_info: 'needs_info',
  rejected: 'rejected',
  deferred: 'needs_info',
};

// reset() 按依赖倒序删表；表名硬编码以避免解析 SQL 文本。
const TABLES = [
  'impact_items',
  'trunk_changes',
  'reviews',
  'submissions',
  'claims',
  'tasks',
  'decisions',
  'assessments',
  'requirements',
  'trunk_items',
  'events',
  'projects',
];

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

function camel(snake) {
  return snake.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());
}

/** JSON 编码为 TEXT；null / undefined 存 NULL。 */
export function encodeJson(value) {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

/** JSON 解码；空值或非法文本回退到 fallback。 */
export function decodeJson(text, fallback = null) {
  if (text === undefined || text === null || text === '') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** 依次尝试多个键名，返回第一个非空值（兼容 snake_case / camelCase）。 */
function pick(source, ...keys) {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function required(source, ...keys) {
  const value = pick(source, ...keys);
  if (value === undefined) throw new Error(`缺少必填字段：${keys[0]}`);
  return value;
}

/** 取 JSON 字段并编码；未给出时用 fallback。 */
function jsonField(source, key, fallback = []) {
  const value = pick(source, key, camel(key));
  return encodeJson(value === undefined ? fallback : value);
}

function parseTrunkItem(row) {
  if (!row) return null;
  return {
    ...row,
    relations: decodeJson(row.relations, []),
    source_refs: decodeJson(row.source_refs, []),
  };
}

/**
 * 打开（并按需创建目录）数据库，执行迁移。
 * @param {string} [dbPath] 绝对或相对路径，默认 center/data/center.db
 * @returns {import('node:sqlite').DatabaseSync}
 */
export function openStore(dbPath = DEFAULT_DB_PATH) {
  const resolved = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new DatabaseSync(resolved);
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

/**
 * 补齐旧库缺失的列（T1 → T2 增量）。仅新增可空列，不改动已有数据。
 * schema.sql 仍是唯一建表来源，这里只处理已存在的安全阀。
 */
function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (!columns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/**
 * 执行建表迁移；可重复执行（IF NOT EXISTS）。
 * @param {import('node:sqlite').DatabaseSync} [db] 缺省时打开默认库
 */
export function migrate(db = openStore()) {
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(sql);
  ensureColumn(db, 'requirements', 'final_level', 'TEXT');
  ensureColumn(db, 'trunk_changes', 'policy_ref', 'TEXT');
  return db;
}

/**
 * 删除全部业务表并重新迁移，用于测试与本地重置。
 * @param {import('node:sqlite').DatabaseSync} [db] 缺省时操作默认库
 */
export function reset(db = openStore()) {
  db.exec('PRAGMA foreign_keys = OFF');
  for (const table of TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
  db.exec('PRAGMA foreign_keys = ON');
  return migrate(db);
}

// ---------------------------------------------------------------- 主干条目

const INSERT_TRUNK_ITEM = `INSERT INTO trunk_items (
  item_id, project_id, kind, statement, rationale, status, valid_from, valid_until,
  relations, source_refs, created_at, created_by, confirmed_at, confirmed_by,
  superseded_by
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * 新建主干条目。item_id 缺省自动生成 `item_` 前缀 ID。
 * @returns {object} 已解析 JSON 字段的完整行
 */
export function createTrunkItem(db, input = {}) {
  const itemId = pick(input, 'item_id', 'itemId') ?? newId('item');
  const projectId = required(input, 'project_id', 'projectId');
  const kind = required(input, 'kind');
  const statement = required(input, 'statement');
  const status = pick(input, 'status') ?? 'proposed';

  if (!TRUNK_ITEM_KINDS.includes(kind)) {
    throw new Error(`非法的主干条目类型：${kind}`);
  }
  if (!TRUNK_ITEM_STATUSES.includes(status)) {
    throw new Error(`非法的主干条目状态：${status}`);
  }

  db.prepare(INSERT_TRUNK_ITEM).run(
    itemId,
    projectId,
    kind,
    statement,
    pick(input, 'rationale'),
    status,
    pick(input, 'valid_from', 'validFrom'),
    pick(input, 'valid_until', 'validUntil'),
    jsonField(input, 'relations'),
    jsonField(input, 'source_refs'),
    pick(input, 'created_at', 'createdAt') ?? nowIso(),
    pick(input, 'created_by', 'createdBy'),
    pick(input, 'confirmed_at', 'confirmedAt'),
    pick(input, 'confirmed_by', 'confirmedBy'),
    pick(input, 'superseded_by', 'supersededBy'),
  );
  return getTrunkItem(db, itemId);
}

/** 按 ID 查询主干条目；不存在返回 null。 */
export function getTrunkItem(db, itemId) {
  const row = db
    .prepare('SELECT * FROM trunk_items WHERE item_id = ?')
    .get(itemId);
  return parseTrunkItem(row);
}

/**
 * 列出主干条目，可按 project_id / status / kind 过滤。
 * @param {object} [query]
 */
export function listTrunkItems(db, query = {}) {
  const clauses = [];
  const params = [];

  const projectId = pick(query, 'project_id', 'projectId');
  if (projectId) {
    clauses.push('project_id = ?');
    params.push(projectId);
  }
  const status = pick(query, 'status');
  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  const kind = pick(query, 'kind');
  if (kind) {
    clauses.push('kind = ?');
    params.push(kind);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT * FROM trunk_items ${where} ORDER BY created_at ASC, item_id ASC`,
    )
    .all(...params);
  return rows.map(parseTrunkItem);
}

const TRUNK_SCALAR_PATCH = {
  statement: 'statement',
  rationale: 'rationale',
  valid_from: 'valid_from',
  valid_until: 'valid_until',
  confirmed_at: 'confirmed_at',
  confirmed_by: 'confirmed_by',
  superseded_by: 'superseded_by',
};

const TRUNK_JSON_PATCH = {
  relations: 'relations',
  source_refs: 'source_refs',
};

/**
 * 更新主干条目状态，可附带更新确认信息、生效时间或被替代条目。
 * @param {object} [patch] 允许的附加字段
 * @returns {object|null} 更新后的完整行
 */
export function updateTrunkItemStatus(db, itemId, status, patch = {}) {
  if (!TRUNK_ITEM_STATUSES.includes(status)) {
    throw new Error(`非法的主干条目状态：${status}`);
  }
  const existing = getTrunkItem(db, itemId);
  if (!existing) throw new Error(`主干条目不存在：${itemId}`);

  const assignments = ['status = ?'];
  const params = [status];

  for (const [key, column] of Object.entries(TRUNK_SCALAR_PATCH)) {
    if (patch[key] !== undefined || patch[camel(key)] !== undefined) {
      assignments.push(`${column} = ?`);
      params.push(pick(patch, key, camel(key)));
    }
  }
  for (const [key, column] of Object.entries(TRUNK_JSON_PATCH)) {
    if (patch[key] !== undefined || patch[camel(key)] !== undefined) {
      assignments.push(`${column} = ?`);
      params.push(encodeJson(pick(patch, key, camel(key))));
    }
  }

  params.push(itemId);
  db.prepare(
    `UPDATE trunk_items SET ${assignments.join(', ')} WHERE item_id = ?`,
  ).run(...params);
  return getTrunkItem(db, itemId);
}

// -------------------------------------------------------------------- 事件

/**
 * 追加一条事件记录。event_id 缺省自动生成 `evt_` 前缀 ID。
 * @returns {object} 已解析 refs 的完整行
 */
export function appendEvent(db, input = {}) {
  const eventId = pick(input, 'event_id', 'eventId') ?? newId('evt');
  const now = nowIso();

  db.prepare(
    `INSERT INTO events (
       event_id, project_id, object_type, object_id, event_type, actor,
       occurred_at, recorded_at, reason, refs, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    eventId,
    required(input, 'project_id', 'projectId'),
    pick(input, 'object_type', 'objectType'),
    pick(input, 'object_id', 'objectId'),
    required(input, 'event_type', 'eventType'),
    pick(input, 'actor'),
    pick(input, 'occurred_at', 'occurredAt') ?? now,
    pick(input, 'recorded_at', 'recordedAt') ?? now,
    pick(input, 'reason'),
    jsonField(input, 'refs'),
    now,
  );

  const row = db
    .prepare('SELECT * FROM events WHERE event_id = ?')
    .get(eventId);
  return { ...row, refs: decodeJson(row.refs, []) };
}

/**
 * 列出事件，可按 project_id / object_type / object_id / event_type 过滤。
 * 默认按发生时间倒序，最多 200 条。
 * @param {object} [query]
 */
export function listEvents(db, query = {}) {
  const clauses = [];
  const params = [];

  const filters = {
    project_id: 'project_id',
    object_type: 'object_type',
    object_id: 'object_id',
    event_type: 'event_type',
  };
  for (const [key, column] of Object.entries(filters)) {
    const value = pick(query, key, camel(key));
    if (value) {
      clauses.push(`${column} = ?`);
      params.push(value);
    }
  }

  let limit = Number(pick(query, 'limit') ?? 200);
  if (!Number.isFinite(limit)) limit = 200;
  limit = Math.min(Math.max(Math.trunc(limit), 1), 1000);

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT * FROM events ${where}
       ORDER BY occurred_at DESC, event_id DESC LIMIT ?`,
    )
    .all(...params, limit);
  return rows.map((row) => ({ ...row, refs: decodeJson(row.refs, []) }));
}

// -------------------------------------------------------------------- 项目

const INSERT_PROJECT = `INSERT INTO projects (
  project_id, name, purpose, scope_summary, status, policy_ref, created_at, created_by
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * 新建项目。project_id 缺省自动生成 `prj_` 前缀 ID。
 * @returns {object} 完整行
 */
export function createProject(db, input = {}) {
  const projectId = pick(input, 'project_id', 'projectId') ?? newId('prj');
  const name = required(input, 'name');
  const status = pick(input, 'status') ?? 'active';

  if (!PROJECT_STATUSES.includes(status)) {
    throw new Error(`非法的项目状态：${status}`);
  }

  const now = pick(input, 'created_at', 'createdAt') ?? nowIso();
  const createdBy = pick(input, 'created_by', 'createdBy');

  db.prepare(INSERT_PROJECT).run(
    projectId,
    name,
    pick(input, 'purpose'),
    pick(input, 'scope_summary', 'scopeSummary'),
    status,
    pick(input, 'policy_ref', 'policyRef'),
    now,
    createdBy,
  );

  appendEvent(db, {
    project_id: projectId,
    object_type: 'project',
    object_id: projectId,
    event_type: 'project.created',
    actor: createdBy,
    occurred_at: now,
    reason: pick(input, 'purpose'),
  });

  return getProject(db, projectId);
}

/** 按 ID 查询项目；不存在返回 null。 */
export function getProject(db, projectId) {
  return db.prepare('SELECT * FROM projects WHERE project_id = ?').get(projectId) ?? null;
}

/** 列出项目，可按 status 过滤，按创建时间升序。 */
export function listProjects(db, query = {}) {
  const status = pick(query, 'status');
  const where = status ? 'WHERE status = ?' : '';
  const params = status ? [status] : [];
  return db
    .prepare(`SELECT * FROM projects ${where} ORDER BY created_at ASC, project_id ASC`)
    .all(...params);
}

// -------------------------------------------------------------------- 需求

const INSERT_REQUIREMENT = `INSERT INTO requirements (
  requirement_id, project_id, author, source_ref, raw_text, attachments,
  claimed_level, claimed_reason, related_item_ids, status, final_level, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function parseRequirement(row) {
  if (!row) return null;
  return {
    ...row,
    attachments: decodeJson(row.attachments, []),
    related_item_ids: decodeJson(row.related_item_ids, []),
  };
}

/** 校验项目存在；不存在抛错。 */
function assertProjectExists(db, projectId) {
  if (!getProject(db, projectId)) throw new Error(`项目不存在：${projectId}`);
}

/**
 * 提交需求。必填 project_id、raw_text；claimed_level 可空；默认 status=submitted。
 * @returns {object} 已解析 JSON 字段的完整行
 */
export function createRequirement(db, input = {}) {
  const requirementId = pick(input, 'requirement_id', 'requirementId') ?? newId('req');
  const projectId = required(input, 'project_id', 'projectId');
  const rawText = required(input, 'raw_text', 'rawText');
  const status = pick(input, 'status') ?? 'submitted';

  if (!REQUIREMENT_STATUSES.includes(status)) {
    throw new Error(`非法的需求状态：${status}`);
  }
  assertProjectExists(db, projectId);

  const now = pick(input, 'created_at', 'createdAt') ?? nowIso();
  const relatedItemIds = pick(input, 'related_item_ids', 'relatedItemIds');

  db.prepare(INSERT_REQUIREMENT).run(
    requirementId,
    projectId,
    pick(input, 'author'),
    pick(input, 'source_ref', 'sourceRef'),
    rawText,
    jsonField(input, 'attachments'),
    pick(input, 'claimed_level', 'claimedLevel'),
    pick(input, 'claimed_reason', 'claimedReason'),
    encodeJson(relatedItemIds === undefined ? [] : relatedItemIds),
    status,
    pick(input, 'final_level', 'finalLevel'),
    now,
  );

  appendEvent(db, {
    project_id: projectId,
    object_type: 'requirement',
    object_id: requirementId,
    event_type: 'requirement.submitted',
    actor: pick(input, 'author'),
    occurred_at: now,
    reason: pick(input, 'claimed_reason', 'claimedReason'),
    refs: relatedItemIds === undefined ? [] : [...relatedItemIds],
  });

  return getRequirement(db, requirementId);
}

/** 按 ID 查询需求；不存在返回 null。 */
export function getRequirement(db, requirementId) {
  return parseRequirement(
    db.prepare('SELECT * FROM requirements WHERE requirement_id = ?').get(requirementId),
  );
}

/** 列出需求，可按 project_id / status 过滤，按创建时间升序。 */
export function listRequirements(db, query = {}) {
  const clauses = [];
  const params = [];

  const projectId = pick(query, 'project_id', 'projectId');
  if (projectId) {
    clauses.push('project_id = ?');
    params.push(projectId);
  }
  const status = pick(query, 'status');
  if (status) {
    if (!REQUIREMENT_STATUSES.includes(status)) {
      throw new Error(`非法的需求状态：${status}`);
    }
    clauses.push('status = ?');
    params.push(status);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT * FROM requirements ${where}
       ORDER BY created_at ASC, requirement_id ASC`,
    )
    .all(...params);
  return rows.map(parseRequirement);
}

const REQUIREMENT_SCALAR_PATCH = {
  claimed_level: 'claimed_level',
  claimed_reason: 'claimed_reason',
  source_ref: 'source_ref',
  author: 'author',
  final_level: 'final_level',
};

const REQUIREMENT_JSON_PATCH = {
  attachments: 'attachments',
  related_item_ids: 'related_item_ids',
};

/**
 * 更新需求状态，可附带更新自报等级、来源、关联条目、最终等级等。
 * @param {object} [patch] 允许的附加字段；actor / reason 用于事件
 * @returns {object|null} 更新后的完整行
 */
export function updateRequirementStatus(db, requirementId, status, patch = {}) {
  if (!REQUIREMENT_STATUSES.includes(status)) {
    throw new Error(`非法的需求状态：${status}`);
  }
  const existing = getRequirement(db, requirementId);
  if (!existing) throw new Error(`需求不存在：${requirementId}`);

  const assignments = ['status = ?'];
  const params = [status];

  for (const [key, column] of Object.entries(REQUIREMENT_SCALAR_PATCH)) {
    if (patch[key] !== undefined || patch[camel(key)] !== undefined) {
      assignments.push(`${column} = ?`);
      params.push(pick(patch, key, camel(key)));
    }
  }
  for (const [key, column] of Object.entries(REQUIREMENT_JSON_PATCH)) {
    if (patch[key] !== undefined || patch[camel(key)] !== undefined) {
      assignments.push(`${column} = ?`);
      params.push(encodeJson(pick(patch, key, camel(key))));
    }
  }

  params.push(requirementId);
  db.prepare(
    `UPDATE requirements SET ${assignments.join(', ')} WHERE requirement_id = ?`,
  ).run(...params);

  appendEvent(db, {
    project_id: existing.project_id,
    object_type: 'requirement',
    object_id: requirementId,
    event_type: 'requirement.updated',
    actor: pick(patch, 'actor', 'updated_by', 'updatedBy'),
    reason: pick(patch, 'reason'),
    refs: [requirementId],
  });

  return getRequirement(db, requirementId);
}

// -------------------------------------------------------------------- 评估

const INSERT_ASSESSMENT = `INSERT INTO assessments (
  assessment_id, requirement_id, assessed_level, related_item_ids, impact_summary,
  uncertainties, proposed_action, assessor_type, assessor_id, created_at, source_refs
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function parseAssessment(row) {
  if (!row) return null;
  return {
    ...row,
    related_item_ids: decodeJson(row.related_item_ids, []),
    uncertainties: decodeJson(row.uncertainties, []),
    source_refs: decodeJson(row.source_refs, []),
  };
}

/**
 * 新建评估。必填 requirement_id；assessed_level 允许 L0..L4 或 undecided（缺省 undecided）；
 * proposed_action 允许 accept/relevel/ask/reject/investigate；assessor_type 缺省 AI。
 * 若需求当前为 submitted，自动置为 assessed。
 * @returns {object} 已解析 JSON 字段的完整评估行
 */
export function createAssessment(db, input = {}) {
  const assessmentId = pick(input, 'assessment_id', 'assessmentId') ?? newId('asm');
  const requirementId = required(input, 'requirement_id', 'requirementId');

  const requirement = getRequirement(db, requirementId);
  if (!requirement) throw new Error(`需求不存在：${requirementId}`);

  const assessedLevel = pick(input, 'assessed_level', 'assessedLevel') ?? 'undecided';
  if (!ASSESSMENT_LEVELS.includes(assessedLevel)) {
    throw new Error(`非法的评估等级：${assessedLevel}`);
  }

  const proposedAction = pick(input, 'proposed_action', 'proposedAction');
  if (proposedAction !== undefined && !PROPOSED_ACTIONS.includes(proposedAction)) {
    throw new Error(`非法的建议动作：${proposedAction}`);
  }

  const assessorType = pick(input, 'assessor_type', 'assessorType') ?? 'AI';
  if (!ASSESSOR_TYPES.includes(assessorType)) {
    throw new Error(`非法的评估者类型：${assessorType}`);
  }

  const assessorId = pick(input, 'assessor_id', 'assessorId');
  const now = pick(input, 'created_at', 'createdAt') ?? nowIso();

  db.prepare(INSERT_ASSESSMENT).run(
    assessmentId,
    requirementId,
    assessedLevel,
    jsonField(input, 'related_item_ids'),
    pick(input, 'impact_summary', 'impactSummary'),
    jsonField(input, 'uncertainties'),
    proposedAction,
    assessorType,
    assessorId,
    now,
    jsonField(input, 'source_refs'),
  );

  // 评估完成后，submitted → assessed（仅在尚未进入后续状态时）。
  if (requirement.status === 'submitted') {
    updateRequirementStatus(db, requirementId, 'assessed', {
      actor: assessorId ?? assessorType,
      reason: `评估完成：${proposedAction ?? 'undecided'}`,
    });
  }

  appendEvent(db, {
    project_id: requirement.project_id,
    object_type: 'assessment',
    object_id: assessmentId,
    event_type: 'assessment.created',
    actor: assessorId ?? assessorType,
    occurred_at: now,
    reason: pick(input, 'impact_summary', 'impactSummary'),
    refs: [requirementId],
  });

  return getAssessment(db, assessmentId);
}

/** 按 ID 查询评估；不存在返回 null。 */
export function getAssessment(db, assessmentId) {
  return parseAssessment(
    db.prepare('SELECT * FROM assessments WHERE assessment_id = ?').get(assessmentId),
  );
}

/** 列出某需求的全部评估（旧评估保留，按创建时间升序）。 */
export function listAssessments(db, requirementId) {
  const rows = db
    .prepare(
      `SELECT * FROM assessments WHERE requirement_id = ?
       ORDER BY created_at ASC, assessment_id ASC`,
    )
    .all(requirementId);
  return rows.map(parseAssessment);
}

// -------------------------------------------------------------------- 决定

const INSERT_DECISION = `INSERT INTO decisions (
  decision_id, requirement_id, conclusion, final_level, reason, confirmed_by,
  confirmed_at, policy_ref, assessment_ref, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * 记录人类确认的决定，并按结论同步需求状态。
 * 规则：accepted/relevelled 必须有 final_level（L0..L4）；relevelled 必须有 reason。
 * @returns {object} 完整决定行
 */
export function createDecision(db, input = {}) {
  const decisionId = pick(input, 'decision_id', 'decisionId') ?? newId('dec');
  const requirementId = required(input, 'requirement_id', 'requirementId');
  const conclusion = required(input, 'conclusion');
  const confirmedBy = required(input, 'confirmed_by', 'confirmedBy');

  if (!DECISION_CONCLUSIONS.includes(conclusion)) {
    throw new Error(`非法的决定结论：${conclusion}`);
  }

  const finalLevel = pick(input, 'final_level', 'finalLevel');
  if (conclusion === 'accepted' || conclusion === 'relevelled') {
    if (!finalLevel) {
      throw new Error(`结论为 ${conclusion} 时必须提供 final_level（L0..L4）`);
    }
    if (!LEVELS.includes(finalLevel)) {
      throw new Error(`非法的等级：${finalLevel}`);
    }
  }
  if (conclusion === 'relevelled' && !pick(input, 'reason')) {
    throw new Error('结论为 relevelled 时必须提供 reason');
  }

  const requirement = getRequirement(db, requirementId);
  if (!requirement) throw new Error(`需求不存在：${requirementId}`);

  const now = pick(input, 'confirmed_at', 'confirmedAt') ?? nowIso();

  db.prepare(INSERT_DECISION).run(
    decisionId,
    requirementId,
    conclusion,
    finalLevel,
    pick(input, 'reason'),
    confirmedBy,
    now,
    pick(input, 'policy_ref', 'policyRef'),
    pick(input, 'assessment_ref', 'assessmentRef'),
    now,
  );

  // 决定写入后同步需求状态；状态确实变化或最终等级更新时才写 requirement.updated。
  const nextStatus = DECISION_STATUS_MAP[conclusion];
  if (requirement.status !== nextStatus || (finalLevel && requirement.final_level !== finalLevel)) {
    updateRequirementStatus(db, requirementId, nextStatus, {
      final_level: finalLevel,
      actor: confirmedBy,
      reason: pick(input, 'reason'),
    });
  }

  appendEvent(db, {
    project_id: requirement.project_id,
    object_type: 'decision',
    object_id: decisionId,
    event_type: 'decision.confirmed',
    actor: confirmedBy,
    occurred_at: now,
    reason: pick(input, 'reason'),
    refs: [requirementId],
  });

  return db.prepare('SELECT * FROM decisions WHERE decision_id = ?').get(decisionId);
}

/** 列出某需求的全部决定（历史保留，按确认时间升序）。 */
export function listDecisions(db, requirementId) {
  return db
    .prepare(
      `SELECT * FROM decisions WHERE requirement_id = ?
       ORDER BY confirmed_at ASC, decision_id ASC`,
    )
    .all(requirementId);
}

/**
 * 需求时间线：本需求自身的事件，以及评估/决定等引用了本需求的事件，按发生时间升序。
 * @returns {object[]} 事件列表
 */
export function listRequirementTimeline(db, requirementId) {
  const requirement = getRequirement(db, requirementId);
  if (!requirement) throw new Error(`需求不存在：${requirementId}`);

  const events = listEvents(db, { projectId: requirement.project_id, limit: 1000 });
  return events
    .filter(
      (event) =>
        event.object_id === requirementId ||
        (Array.isArray(event.refs) && event.refs.includes(requirementId)),
    )
    .sort((a, b) => {
      if (a.occurred_at !== b.occurred_at) {
        return a.occurred_at < b.occurred_at ? -1 : 1;
      }
      return a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0;
    });
}

// -------------------------------------------------------------------- 任务

const INSERT_TASK = `INSERT INTO tasks (
  task_id, project_id, requirement_id, serves_item_ids, related_question_id,
  purpose, scope, non_scope, done_when, acceptance_evidence, blocked_by,
  status, created_by, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function parseTask(row) {
  if (!row) return null;
  return {
    ...row,
    serves_item_ids: decodeJson(row.serves_item_ids, []),
    done_when: decodeJson(row.done_when, []),
    acceptance_evidence: decodeJson(row.acceptance_evidence, []),
    blocked_by: decodeJson(row.blocked_by, []),
  };
}

/**
 * 新建任务。必填 project_id、purpose、done_when（非空数组）；
 * requirement_id / serves_item_ids / related_question_id / scope / non_scope /
 * acceptance_evidence / blocked_by / created_by 均可空。默认 status=draft。
 * @returns {object} 已解析 JSON 字段的完整任务行
 */
export function createTask(db, input = {}) {
  const taskId = pick(input, 'task_id', 'taskId') ?? newId('task');
  const projectId = required(input, 'project_id', 'projectId');
  const purpose = required(input, 'purpose');
  const doneWhen = pick(input, 'done_when', 'doneWhen');

  if (!Array.isArray(doneWhen) || doneWhen.length === 0) {
    throw new Error('缺少必填字段：done_when（必须是非空数组）');
  }
  if (doneWhen.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new Error('done_when 的每一项都必须是非空字符串');
  }

  const status = pick(input, 'status') ?? 'draft';
  if (!TASK_STATUSES.includes(status)) {
    throw new Error(`非法的任务状态：${status}`);
  }

  assertProjectExists(db, projectId);

  const requirementId = pick(input, 'requirement_id', 'requirementId');
  if (requirementId !== undefined && requirementId !== null && !getRequirement(db, requirementId)) {
    throw new Error(`需求不存在：${requirementId}`);
  }

  const now = pick(input, 'created_at', 'createdAt') ?? nowIso();
  const createdBy = pick(input, 'created_by', 'createdBy');

  db.prepare(INSERT_TASK).run(
    taskId,
    projectId,
    requirementId,
    jsonField(input, 'serves_item_ids'),
    pick(input, 'related_question_id', 'relatedQuestionId'),
    purpose,
    pick(input, 'scope'),
    pick(input, 'non_scope', 'nonScope'),
    encodeJson(doneWhen),
    jsonField(input, 'acceptance_evidence'),
    jsonField(input, 'blocked_by'),
    status,
    createdBy,
    now,
  );

  appendEvent(db, {
    project_id: projectId,
    object_type: 'task',
    object_id: taskId,
    event_type: 'task.created',
    actor: createdBy,
    occurred_at: now,
    reason: purpose,
    refs: requirementId ? [requirementId] : [],
  });

  return getTask(db, taskId);
}

/** 按 ID 查询任务；不存在返回 null。 */
export function getTask(db, taskId) {
  return parseTask(db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId));
}

/** 列出任务，可按 project_id / status / requirement_id 过滤，按创建时间升序。 */
export function listTasks(db, query = {}) {
  const clauses = [];
  const params = [];

  const projectId = pick(query, 'project_id', 'projectId');
  if (projectId) {
    clauses.push('project_id = ?');
    params.push(projectId);
  }
  const status = pick(query, 'status');
  if (status) {
    if (!TASK_STATUSES.includes(status)) {
      throw new Error(`非法的任务状态：${status}`);
    }
    clauses.push('status = ?');
    params.push(status);
  }
  const requirementId = pick(query, 'requirement_id', 'requirementId');
  if (requirementId) {
    clauses.push('requirement_id = ?');
    params.push(requirementId);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT * FROM tasks ${where} ORDER BY created_at ASC, task_id ASC`,
    )
    .all(...params);
  return rows.map(parseTask);
}

/**
 * 开放任务：draft → open，使其可被认领。
 * @param {object} [patch] 可附带 actor / reason 用于事件
 * @returns {object|null} 更新后的完整任务行
 */
export function openTask(db, taskId, patch = {}) {
  const existing = getTask(db, taskId);
  if (!existing) throw new Error(`任务不存在：${taskId}`);
  if (existing.status !== 'draft') {
    throw new Error(`任务当前状态不可开放：${existing.status}`);
  }

  const now = nowIso();
  db.prepare(`UPDATE tasks SET status = 'open' WHERE task_id = ?`).run(taskId);

  appendEvent(db, {
    project_id: existing.project_id,
    object_type: 'task',
    object_id: taskId,
    event_type: 'task.updated',
    actor: pick(patch, 'actor', 'created_by', 'createdBy'),
    occurred_at: now,
    reason: pick(patch, 'reason') ?? '任务进入可认领状态',
    refs: [taskId],
  });

  return getTask(db, taskId);
}

// -------------------------------------------------------------------- 认领

const INSERT_CLAIM = `INSERT INTO claims (
  claim_id, task_id, worker_id, claimed_at, released_at, status, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?)`;

/** 按 ID 查询认领；不存在返回 null。 */
export function getClaim(db, claimId) {
  return db.prepare('SELECT * FROM claims WHERE claim_id = ?').get(claimId) ?? null;
}

/**
 * 原子认领任务：任务当前为 open 或 rework 时成功（打回后可直接重新认领）。
 * 采用条件 UPDATE 判断影响行数，再插入 claim，全程单事务；
 * 已被认领或状态不符时抛 code=TASK_NOT_CLAIMABLE 的冲突错误。
 * @returns {{ task: object, claim: object }}
 */
export function claimTask(db, taskId, workerId) {
  if (workerId === undefined || workerId === null || workerId === '') {
    throw new Error('缺少必填字段：worker_id');
  }

  const task = getTask(db, taskId);
  if (!task) throw new Error(`任务不存在：${taskId}`);

  let claimId;
  db.exec('BEGIN');
  try {
    const result = db
      .prepare(
        `UPDATE tasks SET status = 'claimed'
         WHERE task_id = ? AND status IN ('open', 'rework')`,
      )
      .run(taskId);

    if (result.changes === 0) {
      throw Object.assign(new Error('任务已被认领或不可认领'), {
        code: 'TASK_NOT_CLAIMABLE',
        status: 409,
      });
    }

    const now = nowIso();
    claimId = newId('clm');
    db.prepare(INSERT_CLAIM).run(claimId, taskId, workerId, now, null, 'active', now);

    appendEvent(db, {
      project_id: task.project_id,
      object_type: 'task',
      object_id: taskId,
      event_type: 'task.claimed',
      actor: workerId,
      occurred_at: now,
      reason: '工作者认领任务',
      refs: [taskId],
    });

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { task: getTask(db, taskId), claim: getClaim(db, claimId) };
}

/**
 * 释放任务：仅 active 认领的 worker 本人可释放。
 * claim 置 released、任务回 open，写事件 task.released。
 * @returns {{ task: object, claim: object }}
 */
export function releaseTask(db, taskId, workerId) {
  if (workerId === undefined || workerId === null || workerId === '') {
    throw new Error('缺少必填字段：worker_id');
  }

  const task = getTask(db, taskId);
  if (!task) throw new Error(`任务不存在：${taskId}`);

  let claimId;
  db.exec('BEGIN');
  try {
    const claim = db
      .prepare(
        `SELECT * FROM claims WHERE task_id = ? AND status = 'active'
         ORDER BY claimed_at ASC, claim_id ASC LIMIT 1`,
      )
      .get(taskId);

    if (!claim) {
      throw Object.assign(new Error('任务当前没有可释放的活跃认领'), {
        code: 'CLAIM_NOT_RELEASABLE',
        status: 409,
      });
    }
    if (claim.worker_id !== workerId) {
      throw Object.assign(new Error('只有认领者本人可以释放该任务'), {
        code: 'CLAIM_NOT_RELEASABLE',
        status: 409,
      });
    }

    const now = nowIso();
    db.prepare(
      `UPDATE claims SET status = 'released', released_at = ? WHERE claim_id = ?`,
    ).run(now, claim.claim_id);
    db.prepare(`UPDATE tasks SET status = 'open' WHERE task_id = ?`).run(taskId);

    appendEvent(db, {
      project_id: task.project_id,
      object_type: 'task',
      object_id: taskId,
      event_type: 'task.released',
      actor: workerId,
      occurred_at: now,
      reason: '认领者释放任务',
      refs: [taskId],
    });

    claimId = claim.claim_id;
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { task: getTask(db, taskId), claim: getClaim(db, claimId) };
}

/** 列出某任务的全部认领（历史保留，按认领时间升序）。 */
export function listClaims(db, taskId) {
  if (!getTask(db, taskId)) throw new Error(`任务不存在：${taskId}`);
  return db
    .prepare(
      `SELECT * FROM claims WHERE task_id = ?
       ORDER BY claimed_at ASC, claim_id ASC`,
    )
    .all(taskId);
}

/** 取任务当前的 active 认领；没有返回 null。 */
function getActiveClaim(db, taskId) {
  return (
    db
      .prepare(
        `SELECT * FROM claims WHERE task_id = ? AND status = 'active'
         ORDER BY claimed_at ASC, claim_id ASC LIMIT 1`,
      )
      .get(taskId) ?? null
  );
}

// -------------------------------------------------------------------- 提交

const INSERT_SUBMISSION = `INSERT INTO submissions (
  submission_id, task_id, claim_id, commit_refs, summary, self_test,
  known_gaps, artifacts, submitted_by, submitted_at, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function parseSubmission(row) {
  if (!row) return null;
  return {
    ...row,
    commit_refs: decodeJson(row.commit_refs, []),
    known_gaps: decodeJson(row.known_gaps, []),
    artifacts: decodeJson(row.artifacts, []),
  };
}

/**
 * 校验 commit_refs：必须是非空数组；每项是非空字符串，
 * 或含 repo/branch/hash 至少一项的对象。
 */
function normalizeCommitRefs(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('缺少必填字段：commit_refs（必须是非空数组）');
  }
  value.forEach((item, index) => {
    const position = `第 ${index + 1} 项`;
    if (typeof item === 'string') {
      if (item.trim() === '') {
        throw new Error(`commit_refs ${position} 不能为空字符串`);
      }
      return;
    }
    if (item && typeof item === 'object') {
      if (!pick(item, 'repo') && !pick(item, 'branch') && !pick(item, 'hash')) {
        throw new Error(`commit_refs ${position}必须包含 repo/branch/hash`);
      }
      return;
    }
    throw new Error(`commit_refs ${position} 必须是非空字符串或对象`);
  });
  return value;
}

/**
 * 登记任务成果提交。必填 task_id、commit_refs（非空）、summary、submitted_by；
 * 仅当前 active 认领的认领者本人可提交，否则抛 code=SUBMISSION_NOT_ALLOWED。
 * 写入后任务置为 submitted 并写事件 submission.created；每次提交都是新行。
 * @returns {object} 已解析 JSON 字段的完整提交行
 */
export function createSubmission(db, input = {}) {
  const submissionId = pick(input, 'submission_id', 'submissionId') ?? newId('sub');
  const taskId = required(input, 'task_id', 'taskId');
  const summary = required(input, 'summary');
  const submittedBy = required(input, 'submitted_by', 'submittedBy');
  const commitRefs = normalizeCommitRefs(pick(input, 'commit_refs', 'commitRefs'));

  const task = getTask(db, taskId);
  if (!task) throw new Error(`任务不存在：${taskId}`);

  db.exec('BEGIN');
  try {
    const claim = getActiveClaim(db, taskId);
    if (!claim || claim.worker_id !== submittedBy) {
      throw Object.assign(new Error('只有当前活跃认领的认领者本人才能提交成果'), {
        code: 'SUBMISSION_NOT_ALLOWED',
        status: 409,
      });
    }

    const now = pick(input, 'submitted_at', 'submittedAt') ?? nowIso();
    db.prepare(INSERT_SUBMISSION).run(
      submissionId,
      taskId,
      claim.claim_id,
      encodeJson(commitRefs),
      summary,
      pick(input, 'self_test', 'selfTest'),
      jsonField(input, 'known_gaps'),
      jsonField(input, 'artifacts'),
      submittedBy,
      now,
      pick(input, 'created_at', 'createdAt') ?? now,
    );

    db.prepare(`UPDATE tasks SET status = 'submitted' WHERE task_id = ?`).run(taskId);

    appendEvent(db, {
      project_id: task.project_id,
      object_type: 'submission',
      object_id: submissionId,
      event_type: 'submission.created',
      actor: submittedBy,
      occurred_at: now,
      reason: summary,
      refs: [taskId],
    });

    const submission = getSubmission(db, submissionId);
    db.exec('COMMIT');
    return submission;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** 按 ID 查询提交；不存在返回 null。 */
export function getSubmission(db, submissionId) {
  return parseSubmission(
    db.prepare('SELECT * FROM submissions WHERE submission_id = ?').get(submissionId),
  );
}

/** 列出提交，可按 task_id 过滤，按提交时间升序。 */
export function listSubmissions(db, query = {}) {
  const taskId = pick(query, 'task_id', 'taskId');
  const where = taskId ? 'WHERE task_id = ?' : '';
  const params = taskId ? [taskId] : [];
  const rows = db
    .prepare(
      `SELECT * FROM submissions ${where}
       ORDER BY submitted_at ASC, submission_id ASC`,
    )
    .all(...params);
  return rows.map(parseSubmission);
}

// -------------------------------------------------------------------- 评审

const INSERT_REVIEW = `INSERT INTO reviews (
  review_id, submission_id, reviewer_id, conclusion, criterion_results,
  reason, self_review, reviewed_at, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function parseReview(row) {
  if (!row) return null;
  return { ...row, criterion_results: decodeJson(row.criterion_results, []) };
}

/** 校验逐项条件结果：每项至少含 criterion 与 result，evidence 可空。 */
function normalizeCriterionResults(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('criterion_results 必须是数组');
  return value.map((item, index) => {
    const position = `第 ${index + 1} 项`;
    if (!item || typeof item !== 'object') {
      throw new Error(`criterion_results ${position} 必须是对象`);
    }
    const criterion = pick(item, 'criterion');
    const result = pick(item, 'result');
    if (!criterion) throw new Error(`criterion_results ${position} 缺少 criterion`);
    if (!result) throw new Error(`criterion_results ${position} 缺少 result`);
    return { criterion, result, evidence: pick(item, 'evidence') ?? '' };
  });
}

/**
 * 记录对某次提交的评审，并在同一事务内推进任务状态：
 * - confirm：任务 accepted，写 review.confirmed；
 * - reject：任务 rework，当前 active 认领置 released（写 task.released、review.rejected）；
 * - needs_info：任务保持 submitted，写 review.needs_info。
 * self_review 由 reviewer_id 与提交人是否相同自动判定。
 * @returns {object} 已解析 JSON 字段的完整评审行
 */
export function createReview(db, input = {}) {
  const reviewId = pick(input, 'review_id', 'reviewId') ?? newId('rev');
  const submissionId = required(input, 'submission_id', 'submissionId');
  const reviewerId = required(input, 'reviewer_id', 'reviewerId');
  const conclusion = required(input, 'conclusion');

  if (!REVIEW_CONCLUSIONS.includes(conclusion)) {
    throw new Error(`非法的评审结论：${conclusion}`);
  }

  const submission = getSubmission(db, submissionId);
  if (!submission) throw new Error(`提交不存在：${submissionId}`);

  const criterionResults = normalizeCriterionResults(
    pick(input, 'criterion_results', 'criterionResults'),
  );
  if (conclusion === 'confirm' && criterionResults.length === 0) {
    throw new Error('结论为 confirm 时必须提供非空的 criterion_results');
  }

  const reason = pick(input, 'reason');
  if (conclusion === 'reject' && !reason) {
    throw new Error('结论为 reject 时必须提供 reason，说明未满足的条件或缺少的证据');
  }

  const task = getTask(db, submission.task_id);
  if (!task) throw new Error(`任务不存在：${submission.task_id}`);

  // 自审自动判定：评审者即提交者时为真，不依赖调用方传入。
  const selfReview = reviewerId === submission.submitted_by ? 1 : 0;

  db.exec('BEGIN');
  try {
    const now = pick(input, 'reviewed_at', 'reviewedAt') ?? nowIso();
    db.prepare(INSERT_REVIEW).run(
      reviewId,
      submissionId,
      reviewerId,
      conclusion,
      encodeJson(criterionResults),
      reason ?? null,
      selfReview,
      now,
      pick(input, 'created_at', 'createdAt') ?? now,
    );

    const reviewEvent = {
      project_id: task.project_id,
      object_type: 'review',
      object_id: reviewId,
      actor: reviewerId,
      occurred_at: now,
      refs: [submissionId, task.task_id],
    };

    if (conclusion === 'confirm') {
      db.prepare(`UPDATE tasks SET status = 'accepted' WHERE task_id = ?`).run(task.task_id);
      appendEvent(db, { ...reviewEvent, event_type: 'review.confirmed', reason: reason ?? null });
    } else if (conclusion === 'reject') {
      db.prepare(`UPDATE tasks SET status = 'rework' WHERE task_id = ?`).run(task.task_id);

      const claim = getActiveClaim(db, task.task_id);
      if (claim) {
        db.prepare(
          `UPDATE claims SET status = 'released', released_at = ? WHERE claim_id = ?`,
        ).run(now, claim.claim_id);
        appendEvent(db, {
          project_id: task.project_id,
          object_type: 'task',
          object_id: task.task_id,
          event_type: 'task.released',
          actor: reviewerId,
          occurred_at: now,
          reason: reason ?? '评审打回，释放认领',
          refs: [task.task_id],
        });
      }

      appendEvent(db, { ...reviewEvent, event_type: 'review.rejected', reason: reason ?? null });
    } else {
      // needs_info：任务保持 submitted，等待补充信息后重新评审。
      appendEvent(db, {
        ...reviewEvent,
        event_type: 'review.needs_info',
        reason: reason ?? null,
      });
    }

    const review = getReview(db, reviewId);
    db.exec('COMMIT');
    return review;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** 按 ID 查询评审；不存在返回 null。 */
export function getReview(db, reviewId) {
  return parseReview(
    db.prepare('SELECT * FROM reviews WHERE review_id = ?').get(reviewId),
  );
}

/** 列出某次提交的全部评审（历史保留，按评审时间升序）。 */
export function listReviews(db, submissionId) {
  if (!getSubmission(db, submissionId)) throw new Error(`提交不存在：${submissionId}`);
  const rows = db
    .prepare(
      `SELECT * FROM reviews WHERE submission_id = ?
       ORDER BY reviewed_at ASC, review_id ASC`,
    )
    .all(submissionId);
  return rows.map(parseReview);
}

// ------------------------------------------------------- 主干变更与影响处置

/** 主干变更状态机：proposed → confirmed → in_effect → closed。 */
export const TRUNK_CHANGE_STATUSES = ['proposed', 'confirmed', 'in_effect', 'closed'];

/** 影响对象类型。 */
export const IMPACT_TARGET_TYPES = ['task', 'submission', 'document', 'test', 'other'];

/** 影响评估状态；to_check（待检查）与 not_affected（确认无影响）必须区分。 */
export const IMPACT_ASSESSMENT_STATUSES = ['to_check', 'affected', 'not_affected'];

/** 影响处置方式；pending 表示尚未处置。 */
export const IMPACT_RESOLUTIONS = ['continue', 'adjust', 'revalidate', 'obsolete', 'pending'];

/** 构造带 code / status 的可识别错误，便于 HTTP 层映射。 */
function codedError(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

function notFound(message) {
  return Object.assign(new Error(message), { status: 404 });
}

function parseTrunkChange(row) {
  if (!row) return null;
  return {
    ...row,
    old_item_ids: decodeJson(row.old_item_ids, []),
    proposed_item_ids: decodeJson(row.proposed_item_ids, []),
  };
}

function parseImpactItem(row) {
  if (!row) return null;
  return { ...row };
}

const INSERT_TRUNK_CHANGE = `INSERT INTO trunk_changes (
  change_id, project_id, trigger_requirement_id, old_item_ids, proposed_item_ids,
  reason, impact_assessment, confirmed_by, confirmed_at, effective_at, policy_ref,
  status, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * 提出主干变更。必填 project_id、reason；trigger_requirement_id 可空；
 * old_item_ids[]、impact_assessment 可空；proposed_items[] 可空，
 * 每项复用 createTrunkItem 校验并建成 status=proposed 的条目。
 * 默认 status=proposed，写事件 change.proposed。
 * @returns {object} 已解析 JSON 字段的完整变更行
 */
export function createTrunkChange(db, input = {}) {
  const changeId = pick(input, 'change_id', 'changeId') ?? newId('chg');
  const projectId = required(input, 'project_id', 'projectId');
  const reason = required(input, 'reason');
  const status = pick(input, 'status') ?? 'proposed';

  if (!TRUNK_CHANGE_STATUSES.includes(status)) {
    throw new Error(`非法的主干变更状态：${status}`);
  }
  assertProjectExists(db, projectId);

  const triggerRequirementId = pick(input, 'trigger_requirement_id', 'triggerRequirementId');
  if (
    triggerRequirementId !== undefined
    && triggerRequirementId !== null
    && !getRequirement(db, triggerRequirementId)
  ) {
    throw new Error(`需求不存在：${triggerRequirementId}`);
  }

  const oldItemIds = pick(input, 'old_item_ids', 'oldItemIds') ?? [];
  if (!Array.isArray(oldItemIds)) throw new Error('old_item_ids 必须是数组');
  const proposedItems = pick(input, 'proposed_items', 'proposedItems') ?? [];
  if (!Array.isArray(proposedItems)) throw new Error('proposed_items 必须是数组');

  const impactAssessment = pick(input, 'impact_assessment', 'impactAssessment');
  const now = pick(input, 'created_at', 'createdAt') ?? nowIso();

  db.exec('BEGIN');
  try {
    // 提议中的新条目先建成 proposed，变更确认/生效后再推进状态。
    const proposedItemIds = proposedItems.map((item) => {
      const created = createTrunkItem(db, {
        ...(item && typeof item === 'object' ? item : {}),
        project_id: projectId,
        status: 'proposed',
      });
      return created.item_id;
    });

    db.prepare(INSERT_TRUNK_CHANGE).run(
      changeId,
      projectId,
      triggerRequirementId ?? null,
      encodeJson(oldItemIds),
      encodeJson(proposedItemIds),
      reason,
      impactAssessment ?? null,
      null,
      null,
      null,
      null,
      status,
      now,
    );

    appendEvent(db, {
      project_id: projectId,
      object_type: 'trunk_change',
      object_id: changeId,
      event_type: 'change.proposed',
      actor: pick(input, 'created_by', 'createdBy'),
      occurred_at: now,
      reason,
      refs: [...oldItemIds, ...proposedItemIds],
    });

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return getTrunkChange(db, changeId);
}

/** 按 ID 查询主干变更；不存在返回 null。 */
export function getTrunkChange(db, changeId) {
  return parseTrunkChange(
    db.prepare('SELECT * FROM trunk_changes WHERE change_id = ?').get(changeId),
  );
}

/** 列出主干变更，可按 project_id / status 过滤，按创建时间升序。 */
export function listTrunkChanges(db, query = {}) {
  const clauses = [];
  const params = [];

  const projectId = pick(query, 'project_id', 'projectId');
  if (projectId) {
    clauses.push('project_id = ?');
    params.push(projectId);
  }
  const status = pick(query, 'status');
  if (status) {
    if (!TRUNK_CHANGE_STATUSES.includes(status)) {
      throw new Error(`非法的主干变更状态：${status}`);
    }
    clauses.push('status = ?');
    params.push(status);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT * FROM trunk_changes ${where}
       ORDER BY created_at ASC, change_id ASC`,
    )
    .all(...params);
  return rows.map(parseTrunkChange);
}

/**
 * 确认主干变更：仅 proposed 可确认 → confirmed。
 * confirmed_by 必填；effective_at / policy_ref 可空。写事件 change.confirmed。
 * @returns {object} 更新后的完整变更行
 */
export function confirmTrunkChange(db, changeId, patch = {}) {
  const change = getTrunkChange(db, changeId);
  if (!change) throw notFound(`主干变更不存在：${changeId}`);
  if (change.status !== 'proposed') {
    throw codedError('INVALID_TRANSITION', `主干变更当前状态不可确认：${change.status}`);
  }

  const confirmedBy = required(patch, 'confirmed_by', 'confirmedBy');
  const now = pick(patch, 'confirmed_at', 'confirmedAt') ?? nowIso();
  const effectiveAt = pick(patch, 'effective_at', 'effectiveAt') ?? null;

  db.exec('BEGIN');
  try {
    db.prepare(
      `UPDATE trunk_changes
       SET status = 'confirmed', confirmed_by = ?, confirmed_at = ?,
           effective_at = ?, policy_ref = ?
       WHERE change_id = ?`,
    ).run(
      confirmedBy,
      now,
      effectiveAt,
      pick(patch, 'policy_ref', 'policyRef') ?? null,
      changeId,
    );

    appendEvent(db, {
      project_id: change.project_id,
      object_type: 'trunk_change',
      object_id: changeId,
      event_type: 'change.confirmed',
      actor: confirmedBy,
      occurred_at: now,
      reason: `变更已确认，生效时间：${effectiveAt ?? '未指定'}`,
      refs: [changeId, ...change.old_item_ids, ...change.proposed_item_ids],
    });

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return getTrunkChange(db, changeId);
}

/**
 * 计算旧条目对应的新条目：按位置配对；新条目多于旧条目时，
 * 多出的新条目视为最后一个旧条目的额外替代项，此时取第一个。
 */
function proposedCandidatesForOld(change, oldIndex) {
  const proposed = change.proposed_item_ids;
  if (oldIndex >= proposed.length) return [];
  if (oldIndex === change.old_item_ids.length - 1) return proposed.slice(oldIndex);
  return [proposed[oldIndex]];
}

/**
 * 使主干变更生效：仅 confirmed 可生效 → in_effect。同一事务内：
 * - proposed_item_ids 对应条目置 active（写 confirmed_at/confirmed_by），写 trunk_item.confirmed；
 * - old_item_ids 中仍为 active 的条目置 superseded 并写 superseded_by，写 trunk_item.superseded；
 * - 写事件 change.confirmed。
 * @returns {object} 更新后的完整变更行
 */
export function activateTrunkChange(db, changeId, patch = {}) {
  const change = getTrunkChange(db, changeId);
  if (!change) throw notFound(`主干变更不存在：${changeId}`);
  if (change.status !== 'confirmed') {
    throw codedError('INVALID_TRANSITION', `主干变更当前状态不可生效：${change.status}`);
  }

  const confirmedBy = required(patch, 'confirmed_by', 'confirmedBy');
  const now = nowIso();
  const effectiveAt = change.effective_at ?? now;

  db.exec('BEGIN');
  try {
    for (const itemId of change.proposed_item_ids) {
      const item = getTrunkItem(db, itemId);
      if (!item) throw new Error(`主干条目不存在：${itemId}`);
      updateTrunkItemStatus(db, itemId, 'active', {
        confirmed_at: effectiveAt,
        confirmed_by: confirmedBy,
      });
      appendEvent(db, {
        project_id: change.project_id,
        object_type: 'trunk_item',
        object_id: itemId,
        event_type: 'trunk_item.confirmed',
        actor: confirmedBy,
        occurred_at: effectiveAt,
        reason: `变更 ${changeId} 生效，新条目开始生效`,
        refs: [itemId, changeId],
      });
    }

    change.old_item_ids.forEach((oldId, index) => {
      const item = getTrunkItem(db, oldId);
      if (!item) throw new Error(`主干条目不存在：${oldId}`);
      if (item.status !== 'active') return;

      const candidates = proposedCandidatesForOld(change, index);
      const replacement = candidates[0] ?? null;
      const reason = replacement
        ? (candidates.length > 1
          ? `被 ${candidates.length} 个新条目替代，此处记录第一个：${replacement}`
          : `被新条目替代：${replacement}`)
        : '本次变更未提出替代条目，旧条目停止生效';

      updateTrunkItemStatus(db, oldId, 'superseded', { superseded_by: replacement });
      appendEvent(db, {
        project_id: change.project_id,
        object_type: 'trunk_item',
        object_id: oldId,
        event_type: 'trunk_item.superseded',
        actor: confirmedBy,
        occurred_at: effectiveAt,
        reason,
        refs: [oldId, replacement, changeId].filter(Boolean),
      });
    });

    db.prepare(
      `UPDATE trunk_changes SET status = 'in_effect', effective_at = ?
       WHERE change_id = ?`,
    ).run(effectiveAt, changeId);

    appendEvent(db, {
      project_id: change.project_id,
      object_type: 'trunk_change',
      object_id: changeId,
      event_type: 'change.confirmed',
      actor: confirmedBy,
      occurred_at: effectiveAt,
      reason: '变更已生效：新条目 active，旧条目 superseded',
      refs: [changeId, ...change.old_item_ids, ...change.proposed_item_ids],
    });

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return getTrunkChange(db, changeId);
}

/**
 * 关闭主干变更：仅 in_effect 可关闭 → closed。
 * 关闭前必须满足：所有影响项 assessment_status 都不是 to_check；
 * 若没有任何影响项，则 impact_assessment 必须是非空字符串（已明确声明并检查过）。
 * 不满足抛 code=CHANGE_IMPACT_UNRESOLVED。写事件 change.closed。
 * @returns {object} 更新后的完整变更行
 */
export function closeTrunkChange(db, changeId) {
  const change = getTrunkChange(db, changeId);
  if (!change) throw notFound(`主干变更不存在：${changeId}`);
  if (change.status !== 'in_effect') {
    throw codedError('INVALID_TRANSITION', `主干变更当前状态不可关闭：${change.status}`);
  }

  const impacts = listImpactItems(db, changeId);
  const pending = impacts.filter((item) => item.assessment_status === 'to_check');
  if (pending.length > 0) {
    throw codedError(
      'CHANGE_IMPACT_UNRESOLVED',
      `仍有 ${pending.length} 个影响项处于待检查（to_check），不能关闭变更`,
    );
  }
  if (impacts.length === 0) {
    const assessment = typeof change.impact_assessment === 'string'
      ? change.impact_assessment.trim()
      : '';
    if (!assessment) {
      throw codedError(
        'CHANGE_IMPACT_UNRESOLVED',
        '未登记任何影响项，且未提供影响声明（impact_assessment），不能关闭变更',
      );
    }
  }

  const now = nowIso();
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE trunk_changes SET status = 'closed' WHERE change_id = ?`).run(changeId);
    appendEvent(db, {
      project_id: change.project_id,
      object_type: 'trunk_change',
      object_id: changeId,
      event_type: 'change.closed',
      actor: change.confirmed_by,
      occurred_at: now,
      reason: '影响处置完成，变更关闭',
      refs: [changeId, ...impacts.map((item) => item.impact_item_id)],
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return getTrunkChange(db, changeId);
}

const INSERT_IMPACT_ITEM = `INSERT INTO impact_items (
  impact_item_id, change_id, target_type, target_id, assessment_status,
  resolution, reason, owner_id, updated_at, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * 登记影响项。target_type 允许 task/submission/document/test/other；
 * 默认 assessment_status=to_check、resolution=pending。写事件 impact_item.created。
 * @returns {object} 完整影响项行
 */
export function addImpactItem(db, input = {}) {
  const impactItemId = pick(input, 'impact_item_id', 'impactItemId') ?? newId('imp');
  const changeId = required(input, 'change_id', 'changeId');
  const targetType = required(input, 'target_type', 'targetType');
  const targetId = required(input, 'target_id', 'targetId');
  const ownerId = pick(input, 'owner_id', 'ownerId');

  if (!IMPACT_TARGET_TYPES.includes(targetType)) {
    throw new Error(`非法的影响对象类型：${targetType}`);
  }

  const change = getTrunkChange(db, changeId);
  if (!change) throw notFound(`主干变更不存在：${changeId}`);

  const now = pick(input, 'created_at', 'createdAt') ?? nowIso();
  db.prepare(INSERT_IMPACT_ITEM).run(
    impactItemId,
    changeId,
    targetType,
    targetId,
    'to_check',
    'pending',
    null,
    ownerId ?? null,
    now,
    now,
  );

  appendEvent(db, {
    project_id: change.project_id,
    object_type: 'impact_item',
    object_id: impactItemId,
    event_type: 'impact_item.created',
    actor: ownerId,
    occurred_at: now,
    reason: `登记影响对象 ${targetType}:${targetId}，待检查`,
    refs: [changeId, targetId],
  });

  return getImpactItem(db, impactItemId);
}

/**
 * 更新影响项处置。assessment_status 允许 to_check/affected/not_affected；
 * resolution 允许 continue/adjust/revalidate/obsolete/pending；
 * not_affected 时 reason 必填。写事件 impact_item.updated。
 * @returns {object} 更新后的完整影响项行
 */
export function updateImpactItem(db, impactItemId, patch = {}) {
  const existing = getImpactItem(db, impactItemId);
  if (!existing) throw notFound(`影响项不存在：${impactItemId}`);

  const assessmentStatus = pick(patch, 'assessment_status', 'assessmentStatus')
    ?? existing.assessment_status;
  if (!IMPACT_ASSESSMENT_STATUSES.includes(assessmentStatus)) {
    throw new Error(`非法的影响评估状态：${assessmentStatus}`);
  }

  const resolution = pick(patch, 'resolution') ?? existing.resolution;
  if (!IMPACT_RESOLUTIONS.includes(resolution)) {
    throw new Error(`非法的影响处置方式：${resolution}`);
  }

  const reason = pick(patch, 'reason');
  if (
    assessmentStatus === 'not_affected'
    && (reason === undefined || String(reason).trim() === '')
  ) {
    throw new Error('影响评估为 not_affected 时必须提供 reason，说明确认无影响的依据');
  }

  const ownerId = pick(patch, 'owner_id', 'ownerId') ?? existing.owner_id;
  const now = nowIso();

  db.prepare(
    `UPDATE impact_items
     SET assessment_status = ?, resolution = ?, reason = ?, owner_id = ?, updated_at = ?
     WHERE impact_item_id = ?`,
  ).run(
    assessmentStatus,
    resolution,
    reason ?? existing.reason ?? null,
    ownerId,
    now,
    impactItemId,
  );

  appendEvent(db, {
    project_id: getTrunkChange(db, existing.change_id).project_id,
    object_type: 'impact_item',
    object_id: impactItemId,
    event_type: 'impact_item.updated',
    actor: ownerId,
    occurred_at: now,
    reason: reason ?? existing.reason ?? `影响评估更新为 ${assessmentStatus}`,
    refs: [existing.change_id, existing.target_id, impactItemId].filter(Boolean),
  });

  return getImpactItem(db, impactItemId);
}

/** 按 ID 查询影响项；不存在返回 null。 */
export function getImpactItem(db, impactItemId) {
  return parseImpactItem(
    db.prepare('SELECT * FROM impact_items WHERE impact_item_id = ?').get(impactItemId),
  );
}

/** 列出某变更的全部影响项，按创建时间升序。 */
export function listImpactItems(db, changeId) {
  const rows = db
    .prepare(
      `SELECT * FROM impact_items WHERE change_id = ?
       ORDER BY created_at ASC, impact_item_id ASC`,
    )
    .all(changeId);
  return rows.map(parseImpactItem);
}
