// 运行可靠性（E 枝）：备份、备份校验与运行健康检查。
// 备份是运维动作，不改变业务状态；校验以只读方式打开副本。

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { codedError } from '../db/json.mjs';

/** 健康检查关注的核心表；顺序即输出顺序。 */
const HEALTH_TABLES = [
  'projects',
  'trunk_items',
  'requirements',
  'tasks',
  'claims',
  'submissions',
  'reviews',
  'artifacts',
  'actors',
  'notifications',
  'events',
  'outbox',
];

/** SQLite 标识符/字符串转义：单引号翻倍。 */
function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/**
 * 生成数据库快照。
 * @param {object} db
 * @param {{target: string}} input 目标文件路径
 * @returns {{target: string, bytes: number}}
 */
export function createBackup(db, input = {}) {
  const target = input.target;
  if (!target || typeof target !== 'string') {
    throw codedError('BACKUP_TARGET_REQUIRED', '需要提供备份目标路径 target', 400);
  }
  const resolved = path.resolve(target);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  if (fs.existsSync(resolved)) {
    throw codedError('BACKUP_TARGET_EXISTS', `备份目标已存在：${resolved}`, 409);
  }
  try {
    db.exec(`VACUUM INTO ${quote(resolved)}`);
  } catch (error) {
    throw codedError(
      'BACKUP_FAILED',
      `备份失败：${error instanceof Error ? error.message : String(error)}`,
      500,
    );
  }
  const stat = fs.statSync(resolved);
  return { target: resolved, bytes: stat.size };
}

/**
 * 校验备份文件：完整性检查 + 关键表行数统计。
 * @returns {{ok: boolean, integrity: string[], tables: Record<string, number>, bytes: number}}
 */
export function verifyBackup(filePath) {
  if (!filePath) throw codedError('BACKUP_PATH_REQUIRED', '需要提供备份文件路径 path', 400);
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw codedError('BACKUP_NOT_FOUND', `备份文件不存在：${resolved}`, 404);
  }
  let db;
  try {
    db = new DatabaseSync(resolved, { readOnly: true });
  } catch (error) {
    throw codedError(
      'BACKUP_UNREADABLE',
      `备份文件无法以只读方式打开：${error instanceof Error ? error.message : String(error)}`,
      400,
    );
  }
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all().map((row) => row.integrity_check);
    const tables = {};
    for (const table of HEALTH_TABLES) {
      try {
        tables[table] = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
      } catch {
        tables[table] = -1; // 表不存在：备份早于该表引入
      }
    }
    return {
      ok: integrity.length === 1 && integrity[0] === 'ok',
      integrity,
      tables,
      bytes: fs.statSync(resolved).size,
    };
  } finally {
    db.close();
  }
}

/**
 * 运行健康：完整性、关键表行数、outbox 积压、过期未回收租约。
 * 「过期未回收」不等于数据损坏，但意味着读路径还没触发回收。
 */
export function healthReport(db, now = new Date().toISOString()) {
  const integrity = db.prepare('PRAGMA integrity_check').all().map((row) => row.integrity_check);
  const tables = {};
  for (const table of HEALTH_TABLES) {
    try {
      tables[table] = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
    } catch {
      tables[table] = -1;
    }
  }

  const outbox = db.prepare(`SELECT COUNT(*) AS pending,
      MIN(available_at) AS oldest FROM outbox WHERE delivered_at IS NULL`).get();
  const expiredLeases = db.prepare(`SELECT COUNT(*) AS n FROM claims
    WHERE status = 'active' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`).get(now);

  return {
    ok: integrity.length === 1 && integrity[0] === 'ok',
    generated_at: now,
    integrity,
    tables,
    outbox: { pending: Number(outbox?.pending ?? 0), oldest_pending_at: outbox?.oldest ?? null },
    expired_leases: Number(expiredLeases?.n ?? 0),
    errors_24h: 0, // 暂无错误采集，先显式返回 0 而不是编造数字
  };
}
