// 初始化 Center 数据库：执行迁移并打印数据库路径。
// 用法：node src/init-db.mjs（可用环境变量 CENTER_DB 指定路径）

import { openStore } from './store.mjs';
import { DB_PATH } from './config.mjs';

const db = openStore(DB_PATH);

const { n: tableCount } = db
  .prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  )
  .get();

console.log(`Center 数据库已就绪：${DB_PATH}`);
console.log(`已创建/确认 ${tableCount} 张表。`);

db.close();
