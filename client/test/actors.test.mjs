// Client P1：主体、凭据与委派命令的请求与错误透出。

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { run as runActor } from '../src/commands/actor.mjs';
import { run as runDelegate } from '../src/commands/delegate.mjs';
import { run as runMember } from '../src/commands/member.mjs';

function fakeCenter() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      requests.push({ method: req.method, path: url.pathname, body, authorization: req.headers.authorization });
      const json = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };

      if (url.pathname === '/sap-cloud/api/actors' && req.method === 'POST') {
        if (!body.on_behalf_of && body.type === 'agent') {
          return json(400, { error: 'Agent 必须绑定人类责任人', code: 'AGENT_OWNER_REQUIRED' });
        }
        return json(201, { actor_id: 'act_1', type: body.type, display_name: body.display_name, status: 'active' });
      }
      if (url.pathname === '/sap-cloud/api/actors/act_1/credentials') {
        return json(201, { credential: { credential_id: 'cred_1', actor_id: 'act_1' }, token: 'sap_deadbeef' });
      }
      if (url.pathname === '/sap-cloud/api/delegations') {
        return json(201, {
          delegation_id: 'dlg_1', agent_actor_id: body.agent_actor_id, on_behalf_of: body.on_behalf_of,
          project_id: body.project_id, allowed_actions: body.allowed_actions || [],
          valid_from: '2026-01-01T00:00:00.000Z', valid_until: '2026-04-01T00:00:00.000Z',
        });
      }
      if (url.pathname === '/sap-cloud/api/projects/prj_1/members') {
        return json(201, { project_id: 'prj_1', actor_id: body.actor_id, roles: body.roles });
      }
      return json(404, { error: 'not_found' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server, requests, url: `http://127.0.0.1:${server.address().port}`,
  })));
}

function io() {
  const out = [];
  const err = [];
  return { out, err, value: { stdout: (line) => out.push(line), stderr: (line) => err.push(line) } };
}

test('actor create 传 on_behalf_of；token 只打印一次', async () => {
  const fake = await fakeCenter();
  process.env.CENTER_URL = fake.url;
  try {
    let capture = io();
    const code = await runActor(['create', '--type', 'agent', '--name', '编码助手', '--owner', 'act_owner'], capture.value);
    assert.equal(code, 0);
    assert.equal(fake.requests.at(-1).body.on_behalf_of, 'act_owner');

    capture = io();
    assert.equal(await runActor(['token', '--actor', 'act_1', '--label', 'cli'], capture.value), 0);
    assert.ok(capture.out.some((line) => line.includes('sap_deadbeef')));
  } finally {
    delete process.env.CENTER_URL;
    await new Promise((resolve) => fake.server.close(resolve));
  }
});

test('actor create 缺少 owner 时给出本地提示', async () => {
  const fake = await fakeCenter();
  process.env.CENTER_URL = fake.url;
  try {
    const capture = io();
    const code = await runActor(['create', '--type', 'agent', '--name', '孤儿助手'], capture.value);
    assert.equal(code, 1);
    assert.ok(capture.err.some((line) => line.includes('缺少 --owner')));
    assert.equal(fake.requests.length, 0, '本地校验失败时不应发出请求');
  } finally {
    delete process.env.CENTER_URL;
    await new Promise((resolve) => fake.server.close(resolve));
  }
});

test('delegate add 带上动作清单；member add 校验角色输入', async () => {
  const fake = await fakeCenter();
  process.env.CENTER_URL = fake.url;
  try {
    let capture = io();
    assert.equal(
      await runDelegate(['add', '--agent', 'act_2', '--owner', 'act_1', '--project', 'prj_1', '--actions', 'task.claim,task.submit'], capture.value),
      0,
    );
    assert.deepEqual(fake.requests.at(-1).body.allowed_actions, ['task.claim', 'task.submit']);

    capture = io();
    assert.equal(
      await runMember(['add', '--project', 'prj_1', '--actor', 'act_1', '--roles', 'owner,reviewer'], capture.value),
      0,
    );
    assert.deepEqual(fake.requests.at(-1).body.roles, ['owner', 'reviewer']);
  } finally {
    delete process.env.CENTER_URL;
    await new Promise((resolve) => fake.server.close(resolve));
  }
});
