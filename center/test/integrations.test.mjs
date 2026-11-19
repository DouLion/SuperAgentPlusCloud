// G 枝外部工具只读适配测试：事实摄入幂等、证据引用、任务关联、订阅投递。

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
  createActor,
  createProject,
  issueCredential,
  openStore,
} from '../src/store.mjs';
import { createRequirement } from '../src/db/requirements.mjs';
import { createTask, openTask } from '../src/db/tasks.mjs';
import { claimTask } from '../src/db/claims.mjs';
import { createSubmission, getSubmission } from '../src/db/submissions.mjs';
import { createFact, linkTaskFacts, listFacts } from '../src/db/facts.mjs';
import { enqueue } from '../src/protocol/outbox.mjs';
import { createServer } from '../src/server.mjs';

const dbPath = path.join(os.tmpdir(), `sap-integrations-${process.pid}-${Date.now()}.db`);
let db;
let server;
let base;
let project;
let serviceToken;
let humanToken;
let agentToken;
let taskId;

function authHeaders(token) {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function post(urlPath, body, token) {
  return fetch(`${base}/sap-cloud/api${urlPath}`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(body ?? {}),
  });
}

async function getJson(urlPath, token) {
  const response = await fetch(`${base}/sap-cloud/api${urlPath}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: response.status, body: await response.json() };
}

test.before(async () => {
  db = openStore(dbPath);
  project = createProject(db, { name: 'G 枝项目' });

  const human = createActor(db, { type: 'human', display_name: '负责人', created_by: 'bootstrap' });
  humanToken = issueCredential(db, human.actor_id, { label: 'human' }).token;

  const service = createActor(db, { type: 'service', display_name: 'git-webhook', created_by: human.actor_id });
  serviceToken = issueCredential(db, service.actor_id, { label: 'service' }).token;

  const agent = createActor(db, {
    type: 'agent',
    display_name: 'CI Agent',
    on_behalf_of: human.actor_id,
    project_id: project.project_id,
    allowed_actions: ['submit'],
    created_by: human.actor_id,
  });
  agentToken = issueCredential(db, agent.actor_id, { label: 'agent' }).token;

  const requirement = createRequirement(db, {
    project_id: project.project_id, author: '负责人', raw_text: '关联外部事实', claimed_level: 'L3',
  });
  const task = createTask(db, {
    project_id: project.project_id,
    requirement_id: requirement.requirement_id,
    purpose: '接入外部事实',
    done_when: ['提交可引用事实'],
    serves_item_ids: [],
    related_question_id: 'q-1',
    created_by: '负责人',
  });
  taskId = openTask(db, task.task_id).task_id;

  server = createServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  db.close();
});

test('service 凭据可摄入 commit 事实；重复 external_id 幂等', async () => {
  const payload = { commit_sha: 'abc123', ref: 'refs/heads/main', message: 'fix: 修复导出' };
  const first = await post(`/integrations/git/facts`, {
    project_id: project.project_id, kind: 'commit', external_id: 'abc123', payload,
  }, serviceToken);
  assert.equal(first.status, 201);
  const created = await first.json();
  assert.equal(created.deduplicated, false);
  assert.match(created.note, /不代表任务完成/);

  const second = await post(`/integrations/git/facts`, {
    project_id: project.project_id, kind: 'commit', external_id: 'abc123', payload,
  }, serviceToken);
  assert.equal(second.status, 200);
  const again = await second.json();
  assert.equal(again.deduplicated, true);
  assert.equal(again.fact.fact_id, created.fact.fact_id);
});

test('人类凭据不能走 integrations 接口', async () => {
  const response = await post('/integrations/git/facts', {
    project_id: project.project_id, kind: 'commit', external_id: 'human-1', payload: { commit_sha: 'h1', ref: 'main' },
  }, humanToken);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'INTEGRATION_ENDPOINT_HUMAN');
});

test('git/commit 缺 commit_sha 被拒绝', async () => {
  const response = await post('/integrations/git/facts', {
    project_id: project.project_id, kind: 'commit', external_id: 'bad-1', payload: { ref: 'main' },
  }, serviceToken);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'FACT_PAYLOAD_INVALID');
});

test('提交可引用同项目事实；跨项目事实被拒绝', async () => {
  const fact = createFact(db, {
    project_id: project.project_id,
    source: 'ci',
    kind: 'build',
    external_id: 'build-9',
    payload: { status: 'success', url: 'https://ci/build/9' },
    actor_id: 'git-webhook',
  }).fact;

  const claim = claimTask(db, taskId, '负责人', { role: 'owner' });
  const submission = createSubmission(db, {
    task_id: taskId,
    claim_id: claim.claim.claim_id,
    commit_refs: ['abc123'],
    summary: '接入事实引用',
    submitted_by: '负责人',
    external_fact_ids: [fact.fact_id],
  });
  assert.deepEqual(submission.external_fact_ids, [fact.fact_id]);

  const detail = getSubmission(db, submission.submission_id);
  assert.equal(detail.external_facts.length, 1);
  assert.equal(detail.external_facts[0].external_id, 'build-9');

  const otherProject = createProject(db, { name: '另一个项目' });
  const foreign = createFact(db, {
    project_id: otherProject.project_id,
    source: 'ci',
    kind: 'build',
    external_id: 'build-foreign',
    payload: { status: 'success' },
  }).fact;

  assert.throws(
    () => createSubmission(db, {
      task_id: taskId,
      commit_refs: ['abc123'],
      summary: '跨项目引用',
      submitted_by: '负责人',
      external_fact_ids: [foreign.fact_id],
    }),
    (error) => error.code === 'FACT_PROJECT_MISMATCH',
  );
});

test('事实关联到任务不改变任务状态，响应带说明', async () => {
  const before = db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(taskId).status;
  const fact = listFacts(db, { project_id: project.project_id })[0];
  const result = linkTaskFacts(db, taskId, [fact.fact_id], '负责人');
  assert.match(result.note, /不代表任务完成/);
  const after = db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(taskId).status;
  assert.equal(after, before);

  const view = await getJson(`/tasks/${taskId}/facts`);
  assert.equal(view.status, 200);
  assert.ok(view.body.facts.some((row) => row.fact_id === fact.fact_id));
});

test('outbox 订阅：按 topic 投递并带事件头与签名', async () => {
  const received = [];
  const hook = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        url: req.url,
        event: req.headers['x-sap-event'],
        signature: req.headers['x-sap-signature'],
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => hook.listen(0, '127.0.0.1', resolve));
  const hookUrl = `http://127.0.0.1:${hook.address().port}/hook`;

  try {
    const created = await post('/outbox/subscriptions', {
      url: hookUrl, topics: ['fact.received'], secret: 'shh',
    }, serviceToken);
    assert.equal(created.status, 201);
    const subscription = await created.json();

    enqueue(db, { topic: 'fact.received', payload: { fact_id: 'fact_x' } });
    enqueue(db, { topic: 'task.created', payload: { task_id: 'task_x' } });

    const dispatch = await post('/outbox/dispatch', {}, serviceToken);
    assert.equal(dispatch.status, 200);
    const dispatched = await dispatch.json();
    assert.equal(dispatched.subscriptions, 1);
    assert.ok(dispatched.delivered >= 2, '没有订阅的事件也应在无匹配时视为已处理');

    const matched = received.filter((item) => item.event === 'fact.received');
    assert.equal(matched.length, 1);
    assert.match(matched[0].signature, /^sha256=[0-9a-f]{64}$/);
    assert.match(matched[0].body, /fact_x/);

    const removed = await fetch(`${base}/sap-cloud/api/outbox/subscriptions/${subscription.subscription_id}`, {
      method: 'DELETE',
      headers: authHeaders(serviceToken),
    });
    assert.equal(removed.status, 200);
    assert.ok((await removed.json()).disabled_at);
  } finally {
    hook.close();
  }
});

test('投递失败时 attempts 递增并安排重试', async () => {
  const failing = http.createServer((req, res) => {
    res.writeHead(500);
    res.end('boom');
  });
  await new Promise((resolve) => failing.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${failing.address().port}/hook`;

  try {
    await post('/outbox/subscriptions', { url, topics: [] }, serviceToken);
    const eventId = enqueue(db, { topic: 'review.confirmed', payload: { submission_id: 'sub_x' } });

    const dispatch = await post('/outbox/dispatch', {}, serviceToken);
    const result = await dispatch.json();
    assert.equal(result.failed >= 1, true);

    const row = db.prepare('SELECT attempts, last_error, delivered_at FROM outbox WHERE event_id = ?').get(eventId);
    assert.ok(row.attempts >= 1);
    assert.ok(row.last_error);
    assert.equal(row.delivered_at, null);
  } finally {
    failing.close();
  }
});
