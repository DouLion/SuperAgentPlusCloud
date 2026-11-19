// T13：项目制品、OpenAPI 契约校验、文档与 Mock。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  activateConventionPack,
  artifactReferences,
  claimTask,
  createAiSuggestion,
  createArtifact,
  createConventionPack,
  createProject,
  createRequirement,
  createSubmission,
  createTask,
  createTrunkItem,
  getArtifact,
  listArtifacts,
  openStore,
  openTask,
  publishArtifact,
  retireArtifact,
} from '../src/store.mjs';
import { createServer } from '../src/server.mjs';
import { activeConventionRules, mockFromContract, renderOpenApiHtml, validateOpenApi } from '../src/contracts/openapi.mjs';

const dbPath = path.join(os.tmpdir(), `sap-t13-${process.pid}-${Date.now()}.db`);
let db;
test.before(() => { db = openStore(dbPath); });
test.after(() => { db.close(); fs.rmSync(dbPath, { force: true }); });

const GOOD = {
  openapi: '3.1.0',
  info: { title: '订单 API', version: '1.0.0' },
  paths: {
    '/orders/query': {
      post: {
        operationId: 'queryOrders', summary: '查询订单',
        responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/OrderListEnvelope' } } } } },
      },
    },
  },
  components: {
    schemas: {
      OrderListEnvelope: {
        type: 'object', required: ['status', 'message', 'data'],
        properties: {
          status: { type: 'integer', const: 1 },
          message: { type: 'string', example: 'ok' },
          data: { type: 'array', items: { $ref: '#/components/schemas/Order' } },
        },
      },
      Order: { type: 'object', properties: { orderId: { type: 'string', example: 'O-1' } } },
    },
  },
};

function seedProject() {
  return createProject(db, { name: `契约项目-${Date.now()}-${Math.random()}` });
}

function seedRules(projectId) {
  const pack = createConventionPack(db, {
    name: `API 约定-${projectId}`, scope: 'project', project_id: projectId, created_by: 'owner',
    rules: [
      { key: 'api.methods.forbidden', title: '禁止 PUT/DELETE', severity: 'must', value: { methods: ['put', 'delete'] } },
      { key: 'api.response', title: '响应包络', severity: 'must', value: { fields: ['status', 'message', 'data'] } },
      { key: 'api.path.case', title: '路径 kebab-case', severity: 'must', value: { style: 'kebab-case' } },
      { key: 'api.field.case', title: '字段 camelCase', severity: 'should', value: { style: 'camelCase' } },
    ],
  });
  return activateConventionPack(db, pack.pack_id, { activated_by: 'owner', reason: '测试启用 API 约定' });
}

test('Artifact：版本、稳定摘要、发布替代与退役保留历史', () => {
  const project = seedProject();
  const first = createArtifact(db, { project_id: project.project_id, type: 'api_contract', name: '订单 API', content: GOOD, created_by: 'owner' });
  assert.equal(first.version, 1); assert.match(first.digest, /^[0-9a-f]{64}$/);
  const published = publishArtifact(db, first.artifact_id, { published_by: 'owner', reason: '首版确认' });
  assert.equal(published.status, 'published');
  const second = createArtifact(db, { project_id: project.project_id, type: 'api_contract', name: '订单 API', content: { ...GOOD, info: { ...GOOD.info, version: '1.1.0' } }, created_by: 'owner' });
  assert.equal(second.version, 2);
  publishArtifact(db, second.artifact_id, { published_by: 'owner', reason: '升级契约' });
  assert.equal(getArtifact(db, first.artifact_id).status, 'superseded');
  assert.equal(getArtifact(db, second.artifact_id).supersedes, first.artifact_id);
  assert.equal(retireArtifact(db, second.artifact_id, { retired_by: 'owner', reason: '接口下线' }).status, 'retired');
  assert.equal(listArtifacts(db, { project_id: project.project_id }).length, 2);
});

test('OpenAPI：active 项目约定决定校验，引用与响应包络可解引用', () => {
  const project = seedProject(); seedRules(project.project_id);
  const rules = activeConventionRules(db, project.project_id);
  const ok = validateOpenApi(GOOD, rules);
  assert.equal(ok.valid, true); assert.equal(ok.operations.length, 1);

  const bad = structuredClone(GOOD);
  bad.paths['/orders/{orderId}'] = { put: { operationId: 'queryOrders', responses: { '200': { content: { 'application/json': { schema: { type: 'object', required: ['data'], properties: { data: { type: 'object' } } } } } } } } };
  bad.components.schemas.Order.properties.order_id = { type: 'string' };
  bad.components.schemas.Broken = { $ref: '#/components/schemas/Missing' };
  const result = validateOpenApi(bad, rules);
  assert.equal(result.valid, false);
  assert.ok(result.violations.some((v) => /禁止 PUT/.test(v.message)));
  assert.ok(result.violations.some((v) => /operationId 重复/.test(v.message)));
  assert.ok(result.violations.some((v) => /status/.test(v.message)));
  assert.ok(result.violations.some((v) => /引用不存在/.test(v.message)));
  assert.ok(result.violations.some((v) => /camelCase/.test(v.message)));
});

test('文档与 Mock：同一契约生成 HTML 与示例响应', () => {
  const validation = validateOpenApi(GOOD, []);
  const html = renderOpenApiHtml(GOOD, validation);
  assert.match(html, /订单 API/); assert.match(html, /queryOrders/);
  const mock = mockFromContract(GOOD, 'POST', '/orders/query');
  assert.equal(mock.status, 200);
  assert.deepEqual(mock.body, { status: 1, message: 'ok', data: [{ orderId: 'O-1' }] });
  assert.equal(mock.operation_id, 'queryOrders');
});

test('引用关系：无引用返回空数组，有任务与提交时正确列出', async () => {
  const project = seedProject();
  const artifact = createArtifact(db, {
    project_id: project.project_id, type: 'api_contract', name: `引用契约-${Date.now()}`,
    content: GOOD, created_by: 'owner',
  });

  // 无引用：任务与提交都是空数组，路径仍然可用。
  const empty = artifactReferences(db, artifact.artifact_id);
  assert.deepEqual(empty.tasks, []);
  assert.deepEqual(empty.submissions, []);
  assert.equal(empty.document_path, `/sap-cloud/api/artifacts/${artifact.artifact_id}/document`);
  assert.equal(empty.mock_path, `/sap-cloud/api/mock/${project.project_id}/orders/query`);

  // 造一个引用该契约的任务与提交。
  const item = createTrunkItem(db, {
    project_id: project.project_id, kind: 'capability', statement: '引用测试能力', created_by: 'owner',
  });
  const requirement = createRequirement(db, {
    project_id: project.project_id, author: 'owner', raw_text: '引用测试需求',
  });
  const task = createTask(db, {
    project_id: project.project_id,
    requirement_id: requirement.requirement_id,
    serves_item_ids: [item.item_id],
    purpose: '按契约实现',
    done_when: ['按契约完成'],
    created_by: 'owner',
  });
  openTask(db, task.task_id);
  const claim = claimTask(db, task.task_id, 'worker-1');
  createSubmission(db, {
    task_id: task.task_id,
    claim_id: claim.claim.claim_id,
    commit_refs: [{ repo: 'demo', hash: 'abc123' }],
    summary: '按契约实现',
    submitted_by: 'worker-1',
    artifacts: [artifact.artifact_id],
  });
  db.prepare(`SELECT 1`).get();

  const filled = artifactReferences(db, artifact.artifact_id);
  assert.equal(filled.submissions.length, 1);
  assert.equal(filled.submissions[0].task_id, task.task_id);
  assert.deepEqual(filled.tasks, []);

  // 已采纳的编排建议会把任务挂到制品上。
  createAiSuggestion(db, {
    project_id: project.project_id,
    requirement_id: requirement.requirement_id,
    kind: 'contract_orchestration',
    payload: { artifact_id: artifact.artifact_id, task_ids: [task.task_id] },
  });
  const withTask = artifactReferences(db, artifact.artifact_id);
  assert.equal(withTask.tasks.length, 1);
  assert.equal(withTask.tasks[0].task_id, task.task_id);
  assert.equal(withTask.tasks[0].purpose, '按契约实现');
});

test('HTTP：引用关系接口返回 200，未知制品 404', async () => {
  const project = seedProject();
  const artifact = createArtifact(db, {
    project_id: project.project_id, type: 'api_contract', name: `HTTP引用-${Date.now()}`,
    content: GOOD, created_by: 'owner',
  });
  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/sap-cloud/api`;
  try {
    const ok = await fetch(`${base}/artifacts/${artifact.artifact_id}/references`);
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.artifact_id, artifact.artifact_id);
    assert.ok(Array.isArray(body.tasks));
    assert.ok(Array.isArray(body.submissions));
    assert.match(body.mock_path, /\/sap-cloud\/api\/mock\//);

    const missing = await fetch(`${base}/artifacts/art_missing/references`);
    assert.equal(missing.status, 404);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('HTTP：must 违规阻断发布；发布后文档与 Mock 可用', async () => {
  const project = seedProject(); seedRules(project.project_id);
  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/sap-cloud/api`;
  try {
    const create = async (content, name) => fetch(`${base}/artifacts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: project.project_id, type: 'api_contract', name, content, created_by: 'owner' }),
    }).then((r) => r.json());
    const bad = structuredClone(GOOD);
    bad.paths['/orders/remove'] = { delete: { operationId: 'removeOrder', responses: { '200': { content: { 'application/json': { schema: { type: 'object' } } } } } } };
    const badArtifact = await create(bad, '坏契约');
    const blocked = await fetch(`${base}/artifacts/${badArtifact.artifact_id}/publish`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ published_by: 'owner', reason: '尝试发布' }),
    });
    assert.equal(blocked.status, 422);
    assert.equal((await blocked.json()).code, 'CONTRACT_VALIDATION_FAILED');

    const artifact = await create(GOOD, '订单 API');
    const published = await fetch(`${base}/artifacts/${artifact.artifact_id}/publish`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ published_by: 'owner', reason: '确认契约' }),
    });
    assert.equal(published.status, 200);
    const doc = await fetch(`${base}/artifacts/${artifact.artifact_id}/document`);
    assert.match(doc.headers.get('content-type'), /text\/html/); assert.match(await doc.text(), /queryOrders/);
    const mocked = await fetch(`${base}/mock/${project.project_id}/orders/query`, { method: 'POST' });
    assert.equal(mocked.status, 200);
    assert.deepEqual(await mocked.json(), { status: 1, message: 'ok', data: [{ orderId: 'O-1' }] });
    assert.equal(mocked.headers.get('x-sap-operation-id'), 'queryOrders');
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
