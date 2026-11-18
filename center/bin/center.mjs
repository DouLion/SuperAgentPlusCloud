#!/usr/bin/env node
// Center 启动入口（T0 骨架）：HTTP 服务 + 最小路由。
// T2 起在此扩展路由，或按 docs/05_实施计划.md 抽出 src/server.mjs。

import http from 'node:http';
import path from 'node:path';
import { openStore, DEFAULT_DB_PATH } from '../src/store.mjs';

const PORT = Number(process.env.CENTER_PORT || 8787);
const HOST = process.env.CENTER_HOST || '127.0.0.1';
const dbPath = path.resolve(process.env.CENTER_DB || DEFAULT_DB_PATH);

const db = openStore(dbPath);

/**
 * 路由表：键为 "METHOD /path"。未命中的请求统一返回 404 JSON。
 * 后续层在此登记需求、任务、提交、评审、主干变更等接口。
 */
const routes = new Map([
  ['GET /healthz', () => ({ status: 200, body: { ok: true } })],
]);

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

/** 读取并解析 JSON body；无 body 返回空对象，非法 JSON 抛错。 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname = url.pathname;
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.replace(/\/+$/, '');
    }

    const handler = routes.get(`${req.method} ${pathname}`);
    if (!handler) {
      sendJson(res, 404, {
        ok: false,
        error: 'not_found',
        method: req.method,
        path: pathname,
      });
      return;
    }

    const body = await readJsonBody(req);
    const result = await handler({ req, url, body });
    sendJson(res, result.status ?? 200, result.body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('JSON') ? 400 : 500;
    sendJson(res, status, { ok: false, error: message });
  }
});

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
