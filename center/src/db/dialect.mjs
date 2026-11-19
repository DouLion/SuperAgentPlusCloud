// 数据库方言层（F 枝）：让 db/*.mjs 不直接依赖 node:sqlite 的具体行为。
// 当前只实现 SQLite；PostgreSQL / MySQL 仅保留接入点，未安装驱动时明确报错。

import { codedError } from './json.mjs';
import * as sqlite from './dialects/sqlite.mjs';

/** 已实现的方言。 */
export const SUPPORTED_DB_TYPES = ['sqlite'];
/** 已声明、尚未实现的方言。 */
export const PLANNED_DB_TYPES = ['postgres', 'postgresql', 'mysql'];

/**
 * 方言契约（所有实现必须满足）：
 *   type                 方言名
 *   placeholder(n)       第 n 个占位符（从 1 开始）
 *   exec(sql)            执行无返回语句（含 BEGIN/COMMIT/ROLLBACK、PRAGMA）
 *   prepare(sql)         预编译语句，返回 { get, all, run }
 *   transaction(fn)      事务；支持嵌套（内层用保存点）
 *   insertReturning(table, columns, values)  插入并返回落库行
 *   jsonType()           JSON 列类型
 *   nowExpression()      数据库侧当前时间表达式（本项目实际用应用层 ISO 时间）
 *   supportsReturning    是否原生支持 RETURNING
 *   close()              关闭连接
 */

/**
 * 按类型创建方言实例（同步）。
 * 未来的 PostgreSQL / MySQL 若需要异步加载驱动，可另加 createDialectAsync，
 * 但不得改变本函数签名，否则会破坏 openStore 的同步语义。
 * @param {{type?: string, database: string, readOnly?: boolean}} options
 * @returns {object} 方言实例
 */
export function createDialect(options = {}) {
  const type = String(options.type || 'sqlite').toLowerCase();
  if (type === 'sqlite') return sqlite.create(options);
  if (PLANNED_DB_TYPES.includes(type)) {
    throw codedError(
      'UNSUPPORTED_DB_TYPE',
      `尚未实现 ${type} 方言：请安装对应驱动并新增 db/dialects/${type}.mjs。当前只支持 sqlite。`,
      501,
    );
  }
  throw codedError('UNSUPPORTED_DB_TYPE', `未知的数据库类型：${type}`, 400);
}

/** 该类型是否可以直接运行（而非仅有规划）。 */
export function isRunnableDbType(type) {
  return SUPPORTED_DB_TYPES.includes(String(type || 'sqlite').toLowerCase());
}
