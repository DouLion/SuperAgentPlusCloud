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
