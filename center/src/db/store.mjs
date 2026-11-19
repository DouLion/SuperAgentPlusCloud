// Center 数据库连接与迁移（T7 归置）。
// schema.sql 是唯一建表来源；本文件只负责打开连接、执行迁移与重置。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDialect } from './dialect.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.dirname(path.dirname(HERE));
const SCHEMA_PATH = path.join(HERE, 'schema.sql');

/** 默认数据库文件：center/data/center.db */
export const DEFAULT_DB_PATH = path.join(PACKAGE_ROOT, 'data', 'center.db');

// reset() 按依赖倒序删表；表名硬编码以避免解析 SQL 文本。
const TABLES = [
  'notification_prefs',
  'notifications',
  'outbox_subscriptions',
  'outbox',
  'command_ledger',
  'task_fact_links',
  'external_facts',
  'material_extractions',
  'materials',
  'actor_capabilities',
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
 * 返回方言外观对象：向上暴露 prepare / exec / close / type / dialect / raw / transaction，
 * 因此现有 db/*.mjs 的调用方式不需要改动。
 * @param {string} [dbPath] 绝对或相对路径，默认 center/data/center.db
 * @param {{type?: string, readOnly?: boolean}} [options] 数据库类型，默认 sqlite
 * @returns {object} 方言外观对象
 */
export function openStore(dbPath = DEFAULT_DB_PATH, options = {}) {
  const dialect = createDialect({
    type: options.type || 'sqlite',
    database: dbPath,
    readOnly: options.readOnly,
  });
  // 自引用，便于调用方取到方言元信息（type / placeholder / transaction）。
  dialect.dialect = dialect;
  if (!options.readOnly && options.migrate !== false) migrate(dialect);
  return dialect;
}

/**
 * 旧库的 claims 没有角色/租约字段。补列后可能存在同一任务多条 active 认领，
 * 直接建唯一索引会失败，因此先把多余的 active 认领标记为 expired。
 */
function ensureClaimLeaseColumns(db) {
  const columns = db.prepare('PRAGMA table_info(claims)').all().map((row) => row.name);
  const additions = [
    ['actor_id', 'TEXT'],
    ['role', "TEXT NOT NULL DEFAULT 'owner'"],
    ['heartbeat_at', 'TEXT'],
    ['lease_expires_at', 'TEXT'],
    ['fencing_token', 'INTEGER NOT NULL DEFAULT 0'],
    ['attempt_no', 'INTEGER NOT NULL DEFAULT 1'],
    ['released_reason', 'TEXT'],
  ];
  for (const [column, definition] of additions) {
    if (!columns.includes(column)) db.exec(`ALTER TABLE claims ADD COLUMN ${column} ${definition}`);
  }

  // 历史数据：worker_id 同步到 actor_id；同一任务只保留最早一条 active owner。
  db.prepare(`UPDATE claims SET actor_id = worker_id WHERE actor_id IS NULL AND worker_id IS NOT NULL`).run();
  db.prepare(`UPDATE claims SET fencing_token = 1 WHERE fencing_token = 0`).run();
  const duplicates = db.prepare(`SELECT task_id FROM claims WHERE status = 'active' AND role = 'owner'
    GROUP BY task_id HAVING COUNT(*) > 1`).all();
  for (const row of duplicates) {
    const keep = db.prepare(`SELECT claim_id FROM claims WHERE task_id = ? AND status = 'active'
      AND role = 'owner' ORDER BY claimed_at ASC, claim_id ASC LIMIT 1`).get(row.task_id);
    db.prepare(`UPDATE claims SET status = 'expired', released_at = ?, released_reason = 'migration_dedupe'
      WHERE task_id = ? AND status = 'active' AND role = 'owner' AND claim_id != ?`)
      .run(new Date().toISOString(), row.task_id, keep.claim_id);
  }

  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_claims_active_owner
    ON claims (task_id) WHERE status = 'active' AND role = 'owner'`);
}

/**
 * 旧库的 impact_items 只允许关联主干变更，且 change_id 非空。
 * B 枝并入契约来源后，需要 change_id 可空并新增 source_type/source_id；
 * SQLite 无法直接放宽 NOT NULL，因此重建表并原样保留历史数据。
 * 注意：重建必须保留 target_id——漏掉它会让登记影响项直接报错，且历史数据不可恢复。
 */
function ensureImpactSourceColumns(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'impact_items'").get();
  if (!row?.sql) return;

  const columns = db.prepare('PRAGMA table_info(impact_items)').all().map((c) => c.name);
  const hasSource = columns.includes('source_type') && columns.includes('source_id');
  const hasTarget = columns.includes('target_id');

  // 已经重建过但漏了 target_id 的库：补列（历史值已丢失，只能置空）。
  if (hasSource && !hasTarget) {
    db.exec('ALTER TABLE impact_items ADD COLUMN target_id TEXT');
    return;
  }
  if (hasSource && hasTarget) return;

  const sourceExpr = hasSource ? 'source_type' : "'trunk_change'";
  const sourceIdExpr = hasSource ? 'source_id' : 'change_id';
  const targetExpr = hasTarget ? 'target_id' : 'NULL';

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`CREATE TABLE impact_items_b (
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
    )`);
    db.exec(`INSERT INTO impact_items_b (
      impact_item_id, change_id, source_type, source_id, target_type, target_id,
      assessment_status, resolution, reason, owner_id, updated_at, created_at
    ) SELECT impact_item_id, change_id, ${sourceExpr}, ${sourceIdExpr}, target_type, ${targetExpr},
             assessment_status, resolution, reason, owner_id, updated_at, created_at
      FROM impact_items`);
    db.exec('DROP TABLE impact_items');
    db.exec('ALTER TABLE impact_items_b RENAME TO impact_items');
    db.exec('CREATE INDEX IF NOT EXISTS idx_impact_items_change ON impact_items (change_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_impact_items_assessment ON impact_items (assessment_status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_impact_items_source ON impact_items (source_type, source_id)');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
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
  ensureColumn(db, 'tasks', 'revision', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'tasks', 'role_hint', 'TEXT');
  for (const [table, column] of ACTOR_TYPE_COLUMNS) {
    ensureColumn(db, table, column, 'TEXT');
  }
  ensureContractOrchestrationSuggestionKind(db);
  ensureDefinitionEventTypes(db);
  ensureClaimLeaseColumns(db);
  ensureImpactSourceColumns(db);
  // 依赖 source_type/source_id 的索引必须在补列之后创建，否则旧库会因缺列启动失败。
  db.exec('CREATE INDEX IF NOT EXISTS idx_impact_items_source ON impact_items (source_type, source_id)');
  ensureColumn(db, 'command_ledger', 'replay_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'actors', 'is_admin', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'submissions', 'external_fact_ids', "TEXT NOT NULL DEFAULT '[]'");
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
