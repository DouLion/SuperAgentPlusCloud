// P4 Agent 接入测试：inbox、依赖阻断、凭据要求、上下文过期与交付。

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import {
  createActor,
  createArtifact,
  createProject,
  createTask,
  createTrunkItem,
  issueCredential,
  openStore,
  openTask,
  publishArtifact,
  setCapability,
} from '../src/store.mjs';
import { createServer } from '../src/server.mjs';
import { matchActors } from '../src/db/capabilities.mjs';

const dbPath = path.join(os.tmpdir(), `sap-agent-${process.pid}-${Date.now()}.db`);
let db;
let server;
let base;
let project;
let human;
let humanToken;
let agent;
let agentToken;
let readyTask;
let blockedTask;
let item;
let contract;

const CONTRACT = {
  openapi: '3.1.0',
  info: { title: 'Agent 测试 API', version: '1.0.0' },
  paths: {
    '/demo/query': {
      post: {
        operationId: 'queryDemo',
        responses: {
          200: {
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Envelope' } },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Envelope: {
        type: 'object',
        required: ['status', 'message', 'data'],
        properties: {
          status: { type: 'integer', const: 1 },
          message: { type: 'string', example: 'ok' },
          data: { type: 'object' },
        },
      },
    },
  },
};

function headers(token) {
  const result = { 'content-type': 'application/json' };
  if (token) result.authorization = `Bearer ${token}`;
  return result;
}

async function req(method, urlPath, body, token) {
  const response = await fetch(`${base}/sap-cloud/api${urlPath}`, {
    method,
    headers: headers(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, body: data };
}

test.before(async () => {
  db = openStore(dbPath);
  project = createProject(db, { name: 'P4 Agent 项目' });
  human = createActor(db, { type: 'human', display_name: '负责人', created_by: 'bootstrap' });
  humanToken = issueCredential(db, human.actor_id, { label: 'human' }).token;
  agent = createActor(db, {
    type: 'agent',
    display_name: '编码助手',
    on_behalf_of: human.actor_id,
    project_id: project.project_id,
  });
  agentToken = issueCredential(db, agent.actor_id, { label: 'agent' }).token;

  item = createTrunkItem(db, {
    project_id: project.project_id,
    kind: 'capability',
    statement: 'Agent 可以领取任务',
    rationale: '验证接入',
    status: 'active',
    confirmed_by: '负责人',
  });

  contract = createArtifact(db, {
    project_id: project.project_id,
    type: 'api_contract',
    name: 'Agent 契约',
    content: CONTRACT,
    created_by: '负责人',
  });
  publishArtifact(db, contract.artifact_id, { published_by: '负责人', reason: '首版' });

  const first = openTask(db, createTask(db, {
    project_id: project.project_id,
    purpose: '可认领任务',
    done_when: ['完成条件一'],
    serves_item_ids: [item.item_id],
    created_by: '负责人',
  }).task_id, { actor: '负责人' });
  readyTask = first;

  const second = openTask(db, createTask(db, {
    project_id: project.project_id,
    purpose: '被阻塞任务',
    done_when: ['完成条件二'],
    serves_item_ids: [item.item_id],
    blocked_by: [first.task_id],
    created_by: '负责人',
  }).task_id, { actor: '负责人' });
  blockedTask = second;

  server = createServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  db.close();
});

test('agent/*：无 token 401，human token 400', async () => {
  const anonymous = await req('GET', '/agent/inbox');
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.code, 'AUTH_REQUIRED');

  const asHuman = await req('GET', '/agent/inbox', undefined, humanToken);
  assert.equal(asHuman.status, 400);
  assert.equal(asHuman.body.code, 'AGENT_ENDPOINT_HUMAN');
});

test('inbox：只返回依赖已满足且未被认领的任务', async () => {
  const result = await req('GET', `/agent/inbox?project_id=${project.project_id}`, undefined, agentToken);
  assert.equal(result.status, 200);
  const ids = result.body.items.map((row) => row.task_id);
  assert.ok(ids.includes(readyTask.task_id));
  assert.ok(!ids.includes(blockedTask.task_id), '被阻塞任务不应出现在 inbox');
});

test('claim：依赖未满足返回 TASK_BLOCKED', async () => {
  const result = await req('POST', '/agent/claim', { task_id: blockedTask.task_id }, agentToken);
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'TASK_BLOCKED');
  assert.ok(Array.isArray(result.body.pending));
});

test('deliver：上下文过期被拒，重新取上下文后成功', async () => {
  const claim = await req('POST', '/agent/claim', { task_id: readyTask.task_id }, agentToken);
  assert.equal(claim.status, 201);
  const claimId = claim.body.claim.claim_id;
  const fence = claim.body.claim.fencing_token;
  const oldDigest = claim.body.context_digest;

  // 契约升版，使旧上下文过期。
  const next = createArtifact(db, {
    project_id: project.project_id,
    type: 'api_contract',
    name: 'Agent 契约',
    content: { ...CONTRACT, info: { ...CONTRACT.info, version: '1.1.0' } },
    created_by: '负责人',
  });
  publishArtifact(db, next.artifact_id, { published_by: '负责人', reason: '升版' });

  const stale = await req('POST', '/agent/deliver', {
    claim_id: claimId,
    fencing_token: fence,
    commit_refs: ['demo@abc123'],
    summary: '按旧上下文交付',
    context_digest: oldDigest,
  }, agentToken);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'CONTEXT_STALE');
  assert.match(stale.body.current_context_digest, /^[0-9a-f]{64}$/);

  const ok = await req('POST', '/agent/deliver', {
    claim_id: claimId,
    fencing_token: fence,
    commit_refs: ['demo@abc123'],
    summary: '按新上下文交付',
    context_digest: stale.body.current_context_digest,
  }, agentToken);
  assert.equal(ok.status, 201);
  assert.equal(ok.body.submission.task_id, readyTask.task_id);
});

test('能力：按等级排序，缺少角色能力的不入选', () => {
  const helper = createActor(db, {
    type: 'agent', display_name: '助手B', on_behalf_of: human.actor_id, project_id: project.project_id,
  });
  setCapability(db, agent.actor_id, { key: 'backend', level: 'expert' });
  setCapability(db, helper.actor_id, { key: 'backend', level: 'basic' });

  const ranked = matchActors(db, { project_id: project.project_id, role_hint: 'backend' });
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].actor_id, agent.actor_id, 'expert 应排在 basic 前');

  const none = matchActors(db, { project_id: project.project_id, role_hint: 'frontend' });
  assert.deepEqual(none, []);
});

test('候选：无法推断编排来源时返回原因', async () => {
  const result = await req('GET', `/tasks/${readyTask.task_id}/candidates`);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.candidates, []);
  assert.match(result.body.reason, /无法推断/);
});
