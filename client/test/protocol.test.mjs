// 客户端协议层测试（P3）：写请求带 command_id 与协议版本头，冲突错误可透出。

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { api, apiRequest } from '../src/api.mjs';

/** 启动假 Center，记录请求头。 */
function startFakeCenter() {
  const state = { requests: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : {};
      const path = new URL(req.url, 'http://127.0.0.1').pathname.replace(/^\/sap-cloud\/api/, '');
      state.requests.push({ method: req.method, path, headers: req.headers, body });

      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
      };

      if (req.method === 'POST' && path === '/projects') {
        if (req.headers['x-sap-command-id'] === 'dup') {
          return send(409, { ok: false, code: 'IDEMPOTENCY_CONFLICT', error: '命令已用不同载荷执行过' });
        }
        return send(201, { project_id: 'prj_fake', name: body.name });
      }
      if (req.method === 'GET' && path === '/projects') {
        return send(200, []);
      }
      if (req.method === 'GET' && path === '/command-results/cmd_1') {
        return send(200, { command_id: 'cmd_1', status_code: 201, response: { project_id: 'prj_fake' } });
      }
      if (req.method === 'GET' && path === '/outbox') {
        return send(200, [{ event_id: 'obx_1', topic: 'decision.confirmed' }]);
      }
      if (req.method === 'POST' && path === '/outbox/dispatch') {
        return send(200, { delivered: 1, failed: 0, note: '空操作' });
      }
      return send(404, { ok: false, error: 'not_found' });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ state, server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

test('写请求自动带 command_id 与协议版本头', async () => {
  const fake = await startFakeCenter();
  try {
    await api.createProject({ name: '协议测试' }, { url: fake.url });
    const request = fake.state.requests.at(-1);
    assert.equal(request.method, 'POST');
    assert.equal(request.headers['x-sap-protocol-version'], '1');
    assert.match(request.headers['x-sap-command-id'], /^[0-9a-f-]{36}$/);
  } finally {
    fake.server.close();
  }
});

test('显式 command_id 优先，重试可复用同一个键', async () => {
  const fake = await startFakeCenter();
  try {
    await apiRequest('POST', '/projects', { name: 'x' }, { url: fake.url, commandId: 'fixed-key-1' });
    await apiRequest('POST', '/projects', { name: 'x' }, { url: fake.url, commandId: 'fixed-key-1' });
    const keys = fake.state.requests.map((row) => row.headers['x-sap-command-id']);
    assert.deepEqual(keys, ['fixed-key-1', 'fixed-key-1']);
  } finally {
    fake.server.close();
  }
});

test('读请求不带 command_id', async () => {
  const fake = await startFakeCenter();
  try {
    await api.listProjects({}, { url: fake.url });
    const request = fake.state.requests.at(-1);
    assert.equal(request.headers['x-sap-command-id'], undefined);
    assert.equal(request.headers['x-sap-protocol-version'], '1');
  } finally {
    fake.server.close();
  }
});

test('IDEMPOTENCY_CONFLICT 以中文消息透出', async () => {
  const fake = await startFakeCenter();
  try {
    await assert.rejects(
      () => api.createProject({ name: 'x' }, { url: fake.url, commandId: 'dup' }),
      (error) => {
        assert.equal(error.code, 'IDEMPOTENCY_CONFLICT');
        assert.match(error.message, /命令已用不同载荷执行过/);
        return true;
      },
    );
  } finally {
    fake.server.close();
  }
});

test('命令结果查询与 outbox 接口可用', async () => {
  const fake = await startFakeCenter();
  try {
    const result = await api.getCommandResult('cmd_1', { url: fake.url });
    assert.equal(result.status_code, 201);
    assert.equal(result.response.project_id, 'prj_fake');

    const pending = await api.listOutbox({ status: 'pending' }, { url: fake.url });
    assert.equal(pending[0].topic, 'decision.confirmed');

    const dispatched = await api.dispatchOutbox({}, { url: fake.url });
    assert.equal(dispatched.delivered, 1);
  } finally {
    fake.server.close();
  }
});
