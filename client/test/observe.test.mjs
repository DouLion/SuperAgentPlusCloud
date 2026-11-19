// Client observe 命令测试（P5）：请求路径、输出与错误透出。

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { run } from '../src/commands/observe.mjs';

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      url: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

function collect() {
  const lines = [];
  const errors = [];
  return {
    lines,
    errors,
    io: { stdout: (line) => lines.push(String(line)), stderr: (line) => errors.push(String(line)) },
  };
}

test('observe actors：打印主体与在线状态', async () => {
  const { server, url } = await startServer((req, res) => {
    assert.equal(req.url, '/sap-cloud/api/observability/actors');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      generated_at: '2026-01-01T00:00:00.000Z',
      actors: [{
        actor_id: 'act_1', type: 'agent', status: 'active', display_name: 'A',
        presence: 'online', active_claims: 2, capabilities: { backend: 'expert' },
      }],
    }));
  });
  const sink = collect();
  try {
    const code = await run(['actors'], { ...sink.io, url });
    assert.equal(code, 0);
    const text = sink.lines.join('\n');
    assert.match(text, /act_1/);
    assert.match(text, /在线/);
    assert.match(text, /认领 2/);
  } finally {
    server.close();
  }
});

test('observe stuck：透出 project 过滤并打印类别', async () => {
  const { server, url } = await startServer((req, res) => {
    assert.equal(req.url, '/sap-cloud/api/observability/stuck?project_id=prj_1');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      generated_at: 'now',
      count: 1,
      items: [{ kind: 'review_overdue', task_id: 'task_1', detail: '提交后已 25 小时未评审' }],
    }));
  });
  const sink = collect();
  try {
    const code = await run(['stuck', '--project', 'prj_1'], { ...sink.io, url });
    assert.equal(code, 0);
    assert.match(sink.lines.join('\n'), /review_overdue/);
  } finally {
    server.close();
  }
});

test('observe stats：输出过期率与回放次数', async () => {
  const { server, url } = await startServer((req, res) => {
    assert.equal(req.url, '/sap-cloud/api/observability/stats');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      project_id: null,
      generated_at: 'now',
      tasks_by_status: { open: 1, claimed: 2 },
      tasks_total: 3,
      avg_claim_latency_ms: 60000,
      lease_expiry_rate: 0.25,
      avg_review_latency_ms: 120000,
      idempotency_replays: 4,
      outbox_pending: 1,
    }));
  });
  const sink = collect();
  try {
    const code = await run(['stats'], { ...sink.io, url });
    assert.equal(code, 0);
    const text = sink.lines.join('\n');
    assert.match(text, /25\.00%/);
    assert.match(text, /幂等回放：4/);
  } finally {
    server.close();
  }
});

test('observe：未知子命令给出用法并非零退出', async () => {
  const sink = collect();
  const code = await run(['nope'], { ...sink.io, url: 'http://127.0.0.1:1' });
  assert.equal(code, 1);
  assert.match(sink.errors.join('\n'), /用法/);
});
