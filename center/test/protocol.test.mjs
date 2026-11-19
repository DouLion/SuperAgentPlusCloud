// 协议层测试（P3）：命令账本幂等、协议版本、未知结果查询与 outbox。
// 运行：node --test center/test/

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/store.mjs';
import { createServer } from '../src/server.mjs';
import { enqueue, listPending, markFailed } from '../src/protocol/outbox.mjs';
import { createProject } from '../src/db/projects.mjs';

const dbPath = path.join(os.tmpdir(), `sap-protocol-${process.pid}-${Date.now()}.db`);

let db;
let server;
let base;

function post(p, body, headers = {}) {
  return fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test.before(() => {
  db = openStore(dbPath);
  server = createServer(db);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}/sap-cloud/api`;
      resolve();
    });
  });
});

test.after(() => {
  server.close();
  db.close();
});

test('同 command_id 同载荷：第二次回放首次结果，只产生一次副作用', async () => {
  const payload = { name: `幂等项目-${Date.now()}` };
  const first = await post('/projects', payload, { 'x-sap-command-id': 'cmd-replay-1' });
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  assert.equal(first.headers.get('x-sap-idempotent-replay'), null);

  const second = await post('/projects', payload, { 'x-sap-command-id': 'cmd-replay-1' });
  assert.equal(second.status, 201);
  assert.equal(second.headers.get('x-sap-idempotent-replay'), '1');
  assert.deepEqual(await second.json(), firstBody);

  const rows = await fetch(`${base}/projects`).then((r) => r.json());
  assert.equal(rows.filter((row) => row.name === payload.name).length, 1);
});

test('同 command_id 不同载荷：409 IDEMPOTENCY_CONFLICT', async () => {
  await post('/projects', { name: '第一次载荷' }, { 'x-sap-command-id': 'cmd-conflict-1' });
  const res = await post('/projects', { name: '第二次载荷' }, { 'x-sap-command-id': 'cmd-conflict-1' });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, 'IDEMPOTENCY_CONFLICT');
});

test('无 command_id 时保持旧行为：两次都执行', async () => {
  const name = `无键项目-${Date.now()}`;
  await post('/projects', { name });
  await post('/projects', { name });
  const rows = await fetch(`${base}/projects`).then((r) => r.json());
  assert.equal(rows.filter((row) => row.name === name).length, 2);
});

test('GET 不记账，也不回放', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM command_ledger').get().n;
  await fetch(`${base}/projects`, { headers: { 'x-sap-command-id': 'cmd-get' } });
  const after = db.prepare('SELECT COUNT(*) AS n FROM command_ledger').get().n;
  assert.equal(before, after);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM command_ledger WHERE command_id = 'cmd-get'").get().n,
    0,
  );
});

test('协议版本：缺省 1 通过并回显；版本 2 返回 400', async () => {
  const ok = await fetch(`${base}/healthz`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('x-sap-protocol-version'), '1');

  const explicit = await fetch(`${base}/healthz`, {
    headers: { 'x-sap-protocol-version': '1' },
  });
  assert.equal(explicit.status, 200);

  const bad = await fetch(`${base}/healthz`, {
    headers: { 'x-sap-protocol-version': '2' },
  });
  assert.equal(bad.status, 400);
  const body = await bad.json();
  assert.equal(body.code, 'UNSUPPORTED_PROTOCOL_VERSION');
});

test('未知结果查询：命中返回首次结果，未知返回 404', async () => {
  const payload = { name: `查询项目-${Date.now()}` };
  const created = await post('/projects', payload, { 'x-sap-command-id': 'cmd-lookup-1' })
    .then((r) => r.json());

  const hit = await fetch(`${base}/command-results/cmd-lookup-1`).then((r) => r.json());
  assert.equal(hit.command_id, 'cmd-lookup-1');
  assert.equal(hit.method, 'POST');
  assert.equal(hit.path, '/projects');
  assert.equal(hit.status_code, 201);
  assert.equal(hit.response.project_id, created.project_id);

  const missing = await fetch(`${base}/command-results/cmd-not-exist`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, 'COMMAND_NOT_FOUND');
});

test('失败的命令不占用幂等键：可同键重试', async () => {
  const headers = { 'x-sap-command-id': 'cmd-retry-1' };
  const bad = await post('/projects', { name: '' }, headers);
  assert.equal(bad.status, 400);

  const ok = await post('/projects', { name: `重试项目-${Date.now()}` }, headers);
  assert.equal(ok.status, 201);
  assert.equal(ok.headers.get('x-sap-idempotent-replay'), null);
});

test('outbox：关键事件入队，派发后标记已投递', async () => {
  const project = createProject(db, { name: `outbox项目-${Date.now()}` });
  const requirement = await post('/requirements', {
    project_id: project.project_id,
    raw_text: '验证 outbox 入队',
    author: '协议测试',
  }).then((r) => r.json());

  await post(`/requirements/${requirement.requirement_id}/decision`, {
    conclusion: 'rejected',
    reason: '测试用拒绝',
    confirmed_by: '协议测试',
  });

  const pending = await fetch(`${base}/outbox?status=pending`).then((r) => r.json());
  assert.ok(pending.some((row) => row.topic === 'decision.confirmed'));

  const dispatched = await post('/outbox/dispatch', {}).then((r) => r.json());
  assert.ok(dispatched.delivered >= 1);
  assert.ok(dispatched.note.includes('空操作'));

  const stillPending = await fetch(`${base}/outbox?status=pending`).then((r) => r.json());
  assert.equal(stillPending.filter((row) => row.topic === 'decision.confirmed').length, 0);

  const delivered = await fetch(`${base}/outbox?status=delivered`).then((r) => r.json());
  assert.ok(delivered.some((row) => row.topic === 'decision.confirmed' && row.delivered_at));
});

test('outbox：失败重试递增 attempts 并推迟可投递时间', () => {
  const eventId = enqueue(db, { topic: 'test.failure', payload: { a: 1 } });
  assert.equal(listPending(db, 10).some((row) => row.event_id === eventId), true);

  const failed = markFailed(db, eventId, '故意失败', 60);
  assert.equal(failed.attempts, 1);
  assert.equal(failed.last_error, '故意失败');
  assert.ok(failed.available_at > new Date().toISOString());
  assert.equal(listPending(db, 50).some((row) => row.event_id === eventId), false);
});
