// Center 数据库连接与迁移（T7 归置）。
// schema.sql 是唯一建表来源；本文件只负责打开连接、执行迁移与重置。

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.dirname(path.dirname(HERE));
const SCHEMA_PATH = path.join(HERE, 'schema.sql');

/** 默认数据库文件：center/data/center.db */
export const DEFAULT_DB_PATH = path.join(PACKAGE_ROOT, 'data', 'center.db');

// reset() 按依赖倒序删表；表名硬编码以避免解析 SQL 文本。
const TABLES = [
  'project_members',
  'delegations',
  'actor_credentials',
  'actors',
  'artifacts',
  'definition_events',
  'workflow_templates',
  'convention_packs',
  'ai_suggestions',
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

function ensureContractOrchestrationSuggestionKind(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ai_suggestions'").get();
  if (!row?.sql || row.sql.includes('contract_orchestration')) return;
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`CREATE TABLE ai_suggestions_t14 (
      suggestion_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
      requirement_id TEXT, change_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('assessment','task_plan','impact','contract_orchestration')),
      payload TEXT NOT NULL, raw_response TEXT, model TEXT, created_at TEXT NOT NULL
    )`);
    db.exec(`INSERT INTO ai_suggestions_t14
      SELECT suggestion_id, project_id, requirement_id, change_id, kind, payload, raw_response, model, created_at
      FROM ai_suggestions`);
    db.exec('DROP TABLE ai_suggestions');
    db.exec('ALTER TABLE ai_suggestions_t14 RENAME TO ai_suggestions');
    db.exec('CREATE INDEX idx_ai_suggestions_project ON ai_suggestions (project_id)');
    db.exec('CREATE INDEX idx_ai_suggestions_requirement ON ai_suggestions (requirement_id)');
    db.exec('CREATE INDEX idx_ai_suggestions_change ON ai_suggestions (change_id)');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/**
 * 旧库的 definition_events 只允许约定包与编排模板；P1 起需要记录身份事件。
 * 通过重建表扩展 CHECK 约束，历史数据原样保留。
 */
function ensureDefinitionEventTypes(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'definition_events'").get();
  if (!row?.sql || row.sql.includes("'actor'")) return;
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`CREATE TABLE definition_events_p1 (
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
    )`);
    db.exec(`INSERT INTO definition_events_p1
      SELECT event_id, project_id, object_type, object_id, event_type, actor, reason,
             refs, occurred_at, created_at FROM definition_events`);
    db.exec('DROP TABLE definition_events');
    db.exec('ALTER TABLE definition_events_p1 RENAME TO definition_events');
    db.exec(`CREATE INDEX idx_definition_events_object
      ON definition_events (object_type, object_id, occurred_at)`);
    db.exec(`CREATE INDEX idx_definition_events_project
      ON definition_events (project_id, occurred_at)`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/** P1：签署行记录操作者类型快照，历史数据不迁移。 */
const ACTOR_TYPE_COLUMNS = [
  ['decisions', 'confirmed_actor_type'],
  ['reviews', 'reviewer_actor_type'],
  ['trunk_items', 'confirmed_actor_type'],
  ['convention_packs', 'activated_actor_type'],
  ['artifacts', 'published_actor_type'],
  ['trunk_changes', 'confirmed_actor_type'],
];

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
  ensureColumn(db, 'requirements', 'final_level', 'TEXT');
  ensureColumn(db, 'trunk_changes', 'policy_ref', 'TEXT');
  for (const [table, column] of ACTOR_TYPE_COLUMNS) {
    ensureColumn(db, table, column, 'TEXT');
  }
  ensureContractOrchestrationSuggestionKind(db);
  ensureDefinitionEventTypes(db);
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
