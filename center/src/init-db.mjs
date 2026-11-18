// 初始化 Center 数据库：执行迁移并打印数据库路径。
// 用法：node src/init-db.mjs（可用环境变量 CENTER_DB 指定路径）

import path from 'node:path';
import { openStore, DEFAULT_DB_PATH } from './store.mjs';

const dbPath = path.resolve(process.env.CENTER_DB || DEFAULT_DB_PATH);
const db = openStore(dbPath);

const { n: tableCount } = db
  .prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  )
  .get();

console.log(`Center 数据库已就绪：${dbPath}`);
console.log(`已创建/确认 ${tableCount} 张表。`);

db.close();
