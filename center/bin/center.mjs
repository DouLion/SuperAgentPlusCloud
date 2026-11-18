#!/usr/bin/env node
// Center 启动入口：只负责环境变量、启动与优雅退出。
// 路由见 src/server.mjs，存储见 src/store.mjs。

import path from 'node:path';
import { openStore, DEFAULT_DB_PATH } from '../src/store.mjs';
import { createServer } from '../src/server.mjs';

const PORT = Number(process.env.CENTER_PORT || 8787);
const HOST = process.env.CENTER_HOST || '127.0.0.1';
const dbPath = path.resolve(process.env.CENTER_DB || DEFAULT_DB_PATH);

const db = openStore(dbPath);
const server = createServer(db);

server.on('error', (err) => {
  console.error(`Center 启动失败：${err.message}`);
  db.close();
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`Center 已启动：http://${HOST}:${PORT}`);
  console.log(`数据库：${dbPath}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
