#!/usr/bin/env node
// Center 启动入口：只负责环境变量、启动与优雅退出。
// 路由见 src/http/server.mjs，存储见 src/db/*。

import { openStore } from '../src/store.mjs';
import { createServer } from '../src/http/server.mjs';
import { PORT, HOST, DB_PATH } from '../src/config.mjs';

const db = openStore(DB_PATH);
const server = createServer(db);

server.on('error', (err) => {
  console.error(`Center 启动失败：${err.message}`);
  db.close();
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`Center 已启动：http://${HOST}:${PORT}`);
  console.log(`数据库：${DB_PATH}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
