// URL 契约迁移测试：/sap-cloud/api 与 /sap-cloud 前缀、旧路径迁移。
// 运行：node --test center/test/

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/store.mjs';
import { createServer } from '../src/server.mjs';

const dbPath = path.join(
  os.tmpdir(),
  `sap-center-url-prefix-test-${process.pid}-${Date.now()}.db`,
);

let db;
let server;
let base;

test.before(() => {
  db = openStore(dbPath);
  server = createServer(db);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(() => {
  server.close();
  db.close();
});

test('新前缀 healthz 返回 200 JSON', async () => {
  const res = await fetch(`${base}/sap-cloud/api/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('旧根 API GET 308 到 /sap-cloud/api', async () => {
  const res = await fetch(`${base}/healthz`, { redirect: 'manual' });
  assert.equal(res.status, 308);
  assert.equal(res.headers.get('location'), '/sap-cloud/api/healthz');
});

test('旧根 API 写操作返回 410 + API_PREFIX_REQUIRED', async () => {
  const res = await fetch(`${base}/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'x' }),
  });
  assert.equal(res.status, 410);
  const body = await res.json();
  assert.equal(body.code, 'API_PREFIX_REQUIRED');
});

test('站点根 308 到 /sap-cloud/', async () => {
  const res = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(res.status, 308);
  assert.equal(res.headers.get('location'), '/sap-cloud/');
});

test('/sap-cloud/ 返回面板 HTML', async () => {
  const res = await fetch(`${base}/sap-cloud/`, { headers: { accept: 'text/html' } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
});

test('面板深链回落 index.html', async () => {
  const res = await fetch(`${base}/sap-cloud/project/prj_x/overview`, {
    headers: { accept: 'text/html' },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
});

test('旧页面路径按 Accept 分流：浏览器去面板，接口去 API', async () => {
  const browser = await fetch(`${base}/requirements`, {
    headers: { accept: 'text/html' },
    redirect: 'manual',
  });
  assert.equal(browser.status, 308);
  assert.equal(browser.headers.get('location'), '/sap-cloud/requirements');

  const api = await fetch(`${base}/requirements`, { redirect: 'manual' });
  assert.equal(api.status, 308);
  assert.equal(api.headers.get('location'), '/sap-cloud/api/requirements');
});

test('未知 API 路径返回 404 JSON', async () => {
  const res = await fetch(`${base}/sap-cloud/api/nope`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, 'not_found');
  assert.equal(body.path, '/nope');
});
