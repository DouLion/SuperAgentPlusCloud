// Client P4：Agent 接入命令（inbox / claim / deliver）与错误透出。

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { run as runAgent } from '../src/commands/agent.mjs';
import { run as runCaps } from '../src/commands/caps.mjs';
import { run as runCandidates } from '../src/commands/candidates.mjs';

function fakeCenter() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      requests.push({ method: req.method, path: url.pathname, body });
      const json = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };

      if (url.pathname === '/sap-cloud/api/agent/inbox') {
        return json(200, {
          actor_id: 'act_agent',
          count: 1,
          items: [{
            task_id: 'task_1',
            purpose: '实现接口',
            done_when: ['接口可用'],
            serves_item_ids: ['item_1'],
            blocked_by: [],
            lease_seconds: 1800,
          }],
        });
      }
      if (url.pathname === '/sap-cloud/api/agent/claim') {
        return json(201, {
          task: { task_id: body.task_id, status: 'claimed' },
          claim: { claim_id: 'clm_1', role: 'owner', fencing_token: 3, lease_expires_at: '2026-01-01T00:00:00.000Z' },
          context_digest: 'b'.repeat(64),
        });
      }
      if (url.pathname === '/sap-cloud/api/agent/deliver') {
        return json(409, {
          ok: false,
          code: 'CONTEXT_STALE',
          error: '上下文已变化，请重新获取上下文再交付',
          current_context_digest: 'c'.repeat(64),
        });
      }
      if (url.pathname === '/sap-cloud/api/actors/act_agent/capabilities' && req.method === 'POST') {
        return json(201, { actor_id: 'act_agent', key: body.key, level: body.level, updated_at: '2026-01-01T00:00:00.000Z' });
      }
      if (url.pathname === '/sap-cloud/api/tasks/task_1/candidates') {
        return json(200, {
          task_id: 'task_1',
          node_key: 'backend',
          role_hint: 'backend',
          candidates: [{ actor_id: 'act_agent', display_name: '助手', score: 3 }],
          note: '候选只用于推荐',
        });
      }
      return json(404, { error: 'not_found' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` });
  }));
}

function io() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    value: { stdout: (line) => out.push(line), stderr: (line) => err.push(line) },
  };
}

test('agent inbox/claim 使用 agent 接口并输出上下文摘要', async () => {
  const fake = await fakeCenter();
  process.env.CENTER_URL = fake.url;
  process.env.SAP_TOKEN = 'sap_token_agent';
  try {
    let capture = io();
    assert.equal(await runAgent(['inbox', '--project', 'prj_1'], capture.value), 0);
    assert.equal(fake.requests.at(-1).path, '/sap-cloud/api/agent/inbox');
    assert.ok(capture.out.some((line) => line.includes('可认领任务：1')));

    capture = io();
    assert.equal(await runAgent(['claim', '--task', 'task_1'], capture.value), 0);
    assert.equal(fake.requests.at(-1).body.task_id, 'task_1');
    assert.ok(capture.out.some((line) => line.includes('fencing_token：3')));
    assert.ok(capture.out.some((line) => line.includes('b'.repeat(64))));
  } finally {
    delete process.env.CENTER_URL;
    delete process.env.SAP_TOKEN;
    await new Promise((resolve) => fake.server.close(resolve));
  }
});

test('agent deliver 把 CONTEXT_STALE 透出为非零退出', async () => {
  const fake = await fakeCenter();
  process.env.CENTER_URL = fake.url;
  process.env.SAP_TOKEN = 'sap_token_agent';
  try {
    const capture = io();
    const code = await runAgent([
      'deliver', '--claim', 'clm_1', '--commit', 'demo@abc', '--summary', '交付',
    ], capture.value);
    assert.equal(code, 1);
    assert.ok(capture.err.some((line) => line.includes('409')));
    assert.ok(capture.err.some((line) => line.includes('上下文')));
  } finally {
    delete process.env.CENTER_URL;
    delete process.env.SAP_TOKEN;
    await new Promise((resolve) => fake.server.close(resolve));
  }
});

test('caps set 与 candidates 输出', async () => {
  const fake = await fakeCenter();
  process.env.CENTER_URL = fake.url;
  process.env.SAP_TOKEN = 'sap_token_agent';
  try {
    let capture = io();
    assert.equal(await runCaps(['set', '--actor', 'act_agent', '--key', 'backend', '--level', 'expert'], capture.value), 0);
    assert.equal(fake.requests.at(-1).body.level, 'expert');

    capture = io();
    assert.equal(await runCandidates(['--task', 'task_1'], capture.value), 0);
    assert.ok(capture.out.some((line) => line.includes('act_agent')));
    assert.ok(capture.out.some((line) => line.includes('评分 3')));
  } finally {
    delete process.env.CENTER_URL;
    delete process.env.SAP_TOKEN;
    await new Promise((resolve) => fake.server.close(resolve));
  }
});
