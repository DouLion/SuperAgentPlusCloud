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
 * 执行建表迁移；可重复执行（IF NOT EXISTS）。
 * @param {import('node:sqlite').DatabaseSync} [db] 缺省时打开默认库
 */
export function migrate(db = openStore()) {
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(sql);
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
