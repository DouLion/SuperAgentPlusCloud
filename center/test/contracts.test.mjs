// T12：约定包与编排模板存储/HTTP 测试。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  activateConventionPack, activateWorkflowTemplate, createConventionPack,
  createProject, createWorkflowTemplate, getConventionPack, importConventionPack,
  listConventionPacks, listDefinitionEvents, openStore, retireConventionPack, retireWorkflowTemplate,
  seedBuiltInTemplates,
} from '../src/store.mjs';
import { createServer } from '../src/server.mjs';

const dbPath = path.join(os.tmpdir(), `sap-t12-${process.pid}-${Date.now()}.db`);
let db;
test.before(() => { db = openStore(dbPath); });
test.after(() => { db.close(); fs.rmSync(dbPath, { force: true }); });

const RULES = [{ key: 'api.response', category: 'api', title: '响应统一包络', severity: 'must', value: { fields: ['status', 'message', 'data'] } }];

test('约定包：团队模板激活、导入项目快照、退役且规则独立', () => {
  const project = createProject(db, { name: '约定项目' });
  const team = createConventionPack(db, {
    name: '团队 API 约定', scope: 'team', rules: RULES, created_by: 'owner',
  });
  const active = activateConventionPack(db, team.pack_id, { activated_by: 'owner', reason: '启用团队 API 约定' });
  assert.equal(active.status, 'active');
  const snapshot = importConventionPack(db, team.pack_id, { project_id: project.project_id, created_by: 'owner' });
  assert.equal(snapshot.scope, 'project');
  assert.equal(snapshot.imported_from, team.pack_id);
  assert.deepEqual(snapshot.rules, RULES.map((r) => ({ ...r, rationale: '', examples: [] })));
  snapshot.rules[0].title = '本地修改';
  assert.equal(getConventionPack(db, team.pack_id).rules[0].title, '响应统一包络');
  activateConventionPack(db, snapshot.pack_id, { activated_by: 'owner', reason: '启用项目快照' });
  assert.equal(retireConventionPack(db, snapshot.pack_id, {
    retired_by: 'owner', reason: '项目约定已替代',
  }).status, 'retired');
  assert.equal(listConventionPacks(db, { project_id: project.project_id }).length, 1);
  const events = listDefinitionEvents(db, 'convention_pack', snapshot.pack_id);
  assert.deepEqual(events.map((event) => event.event_type), [
    'convention_pack.created', 'convention_pack.activated', 'convention_pack.retired',
  ]);
  assert.ok(events.every((event) => event.actor && event.reason));
});

test('约定包：重复 key、非法 severity、导入非 active 模板被拒', () => {
  assert.throws(() => createConventionPack(db, {
    name: 'x', scope: 'team', rules: [RULES[0], RULES[0]], created_by: 'owner',
  }), /重复/);
  assert.throws(() => createConventionPack(db, {
    name: 'x', scope: 'team', rules: [{ ...RULES[0], severity: 'block' }], created_by: 'owner',
  }), /严重程度/);
  const draft = createConventionPack(db, {
    name: '未激活', scope: 'team', rules: RULES, created_by: 'owner',
  });
  assert.throws(() => importConventionPack(db, draft.pack_id, { project_id: 'x' }), (e) => e.code === 'PACK_NOT_IMPORTABLE');
});

test('编排模板：DAG 校验、内置 contract-first-api 幂等 seed', () => {
  assert.throws(() => createWorkflowTemplate(db, {
    name: 'cycle', kind: 'test', created_by: 'owner', nodes: [
      { key: 'a', title: 'A', done_when_template: ['a'], depends_on: ['b'] },
      { key: 'b', title: 'B', done_when_template: ['b'], depends_on: ['a'] },
    ],
  }), (e) => e.code === 'WORKFLOW_CYCLE');
  assert.throws(() => createWorkflowTemplate(db, {
    name: 'missing', kind: 'test', created_by: 'owner', nodes: [{ key: 'a', title: 'A', done_when_template: ['a'], depends_on: ['x'] }],
  }), /不存在的依赖/);
  const project = createProject(db, { name: '编排项目' });
  const first = seedBuiltInTemplates(db, project.project_id, { created_by: 'system' });
  const second = seedBuiltInTemplates(db, project.project_id, { created_by: 'system' });
  assert.equal(first.template_id, second.template_id);
  assert.ok(first.template_id.startsWith('wft_'));
  assert.equal(first.project_id, project.project_id);
  assert.equal(first.status, 'active');
  assert.deepEqual(first.nodes.map((n) => n.key), ['contract', 'frontend', 'backend', 'integration']);
  assert.deepEqual(first.nodes[0].outputs, ['api_contract', 'api_document', 'mock_definition']);
  assert.deepEqual(first.nodes.at(-1).depends_on, ['frontend', 'backend']);
  assert.equal(retireWorkflowTemplate(db, first.template_id, {
    retired_by: 'owner', reason: '测试退役内置模板',
  }).status, 'retired');
});

test('HTTP：约定包与模板新接口挂在 sap-cloud/api', async () => {
  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/sap-cloud/api`;
  try {
    const packRes = await fetch(`${base}/convention-packs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'HTTP pack', scope: 'team', rules: RULES, created_by: 'owner' }),
    });
    assert.equal(packRes.status, 201);
    const pack = await packRes.json();
    assert.ok(pack.pack_id.startsWith('pack_'));
    const seeded = await fetch(`${base}/workflow-templates/seed`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ created_by: 'system', reason: '启用内置模板' }),
    }).then((r) => r.json());
    assert.equal(seeded.name, 'contract-first-api');
    assert.equal((await fetch(`${base}/workflow-templates`).then((r) => r.json())).some((r) => r.template_id === seeded.template_id), true);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
