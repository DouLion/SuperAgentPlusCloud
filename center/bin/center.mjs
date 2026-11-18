#!/usr/bin/env node
// Center 启动入口：只负责配置读取、启动与优雅退出。
// 路由见 src/http/server.mjs，存储见 src/db/*，配置见 src/config.mjs。

import { openStore } from '../src/store.mjs';
import { createServer } from '../src/http/server.mjs';
import { resolveConfig } from '../src/config.mjs';

// 未初始化时也正常启动（开箱即用），设置向导在 /setup。
const resolved = resolveConfig();
const { port, host, db } = resolved;

const dbHandle = openStore(db.path);
const server = createServer(dbHandle);

server.on('error', (err) => {
  console.error(`Center 启动失败：${err.message}`);
  dbHandle.close();
  process.exit(1);
});

server.listen(port, host, () => {
  console.log(`Center 已启动：http://${host}:${port}`);
  console.log(`数据库：${db.path}`);
  if (!resolved.initialized) {
    console.log('首次使用：打开 /setup 完成初始化（面板会自动跳转）');
  }
});

function shutdown() {
  server.close(() => {
    dbHandle.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
