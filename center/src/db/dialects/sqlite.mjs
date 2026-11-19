// SQLite 方言实现（F 枝）：封装 node:sqlite，向上暴露与厂商无关的接口。
// 现有的 db/*.mjs 只用到 prepare/exec/close，因此外观保持这三者即可。

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { codedError } from '../json.mjs';

/** 事务嵌套深度计数：用于决定用 BEGIN 还是 SAVEPOINT。 */
const DEPTH = Symbol('depth');

function statementOf(raw) {
  return {
    get: (...params) => raw.get(...params),
    all: (...params) => raw.all(...params),
    run: (...params) => raw.run(...params),
  };
}

/**
 * 创建 SQLite 方言实例。
 * @param {{database: string, readOnly?: boolean}} options
 */
export function create(options = {}) {
  const database = options.database;
  if (!database) throw codedError('DB_PATH_REQUIRED', 'SQLite 需要提供 database 路径', 400);

  const resolved = path.resolve(database);
  if (!options.readOnly) {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
  }
  const raw = options.readOnly
    ? new DatabaseSync(resolved, { readOnly: true })
    : new DatabaseSync(resolved);
  if (!options.readOnly) raw.exec('PRAGMA foreign_keys = ON');

  const state = { [DEPTH]: 0 };

  const facade = {
    type: 'sqlite',
    path: resolved,
    raw,
    isReadOnly: Boolean(options.readOnly),

    placeholder: () => '?',
    jsonType: () => 'TEXT',
    nowExpression: () => 'CURRENT_TIMESTAMP',
    supportsReturning: false,
    state,

    exec(sql) {
      return raw.exec(sql);
    },

    prepare(sql) {
      return statementOf(raw.prepare(sql));
    },

    /**
     * 事务；嵌套时内层使用 SAVEPOINT，内层回滚不影响外层。
     * fn 的返回值即本函数的返回值。
     */
    transaction(fn) {
      const depth = state[DEPTH];
      const savepoint = `sp_${depth}`;
      if (depth === 0) raw.exec('BEGIN');
      else raw.exec(`SAVEPOINT ${savepoint}`);
      state[DEPTH] = depth + 1;
      try {
        const result = fn();
        if (result && typeof result.then === 'function') {
          throw codedError('TRANSACTION_ASYNC_UNSUPPORTED', '事务回调必须是同步函数', 500);
        }
        if (depth === 0) raw.exec('COMMIT');
        else raw.exec(`RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        if (depth === 0) raw.exec('ROLLBACK');
        else raw.exec(`ROLLBACK TO ${savepoint}`);
        throw error;
      } finally {
        state[DEPTH] = depth;
      }
    },

    /**
     * 插入并返回落库行。SQLite 没有 RETURNING 依赖，先插入再按主键查询。
     * @param {string} table
     * @param {string[]} columns
     * @param {Array<any>} values
     * @param {string} [idColumn] 主键列名，默认 columns[0]
     */
    insertReturning(table, columns, values, idColumn = columns[0]) {
      const placeholders = columns.map(() => '?').join(', ');
      raw.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`)
        .run(...values);
      const index = columns.indexOf(idColumn);
      const id = index >= 0 ? values[index] : undefined;
      return id === undefined ? null : raw.prepare(`SELECT * FROM ${table} WHERE ${idColumn} = ?`).get(id);
    },

    /** 列出所有表名（导出与迁移用）。 */
    listTables() {
      return raw.prepare(`SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
        .all().map((row) => row.name);
    },

    close() {
      raw.close();
    },
  };

  return facade;
}
