// T14：contract_orchestration 单一建议与 adopt。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  activateConventionPack, createConventionPack, createDecision, createProject,
  createRequirement, createTrunkItem, listArtifacts, listTasks, openStore,
  seedBuiltInTemplates,
} from '../src/store.mjs';
import { suggestContractOrchestration, adoptContractOrchestration } from '../src/ai/contract-orchestration.mjs';
import { createServer } from '../src/server.mjs';

const dbPath = path.join(os.tmpdir(), `sap-t14-${process.pid}-${Date.now()}.db`);
const originalFetch = globalThis.fetch;
let db;

const GOOD = {
  openapi: '3.1.0', info: { title: '订单 API', version: '1.0.0' },
  paths: { '/orders/query': { post: { operationId: 'queryOrders', responses: { '200': { content: { 'application/json': { schema: { type: 'object', required: ['status', 'message', 'data'], properties: { status: { type: 'integer', const: 1 }, message: { type: 'string' }, data: { type: 'array', items: { type: 'object' } } } } } } } } } } },
};

test.before(() => {
  process.env.SAP_LLM_BASE_URL = 'https://llm.example'; process.env.SAP_LLM_API_KEY = 'key';
  db = openStore(dbPath);
});
test.after(() => { globalThis.fetch = originalFetch; db.close(); fs.rmSync(dbPath, { force: true }); delete process.env.SAP_LLM_BASE_URL; delete process.env.SAP_LLM_API_KEY; });
test.afterEach(() => { globalThis.fetch = originalFetch; });

function seed() {
  const project = createProject(db, { name: `T14-${Math.random()}` });
  const item = createTrunkItem(db, { project_id: project.project_id, kind: 'interface', statement: '订单接口', status: 'active', confirmed_by: 'owner', confirmed_at: new Date().toISOString() });
  const pack = createConventionPack(db, { name: 'API 约定', scope: 'project', project_id: project.project_id, created_by: 'owner', rules: [
    { key: 'api.methods.forbidden', title: '禁止 PUT/DELETE', severity: 'must', value: { methods: ['put', 'delete'] } },
    { key: 'api.response', title: '统一响应包络', severity: 'must', value: { fields: ['status', 'message', 'data'] } },
  ] });
  activateConventionPack(db, pack.pack_id, { activated_by: 'owner', reason: '启用' });
  const template = seedBuiltInTemplates(db, project.project_id, { created_by: 'system' });
  const req = createRequirement(db, { project_id: project.project_id, raw_text: '新增订单查询 API', author: 'owner' });
  createDecision(db, { requirement_id: req.requirement_id, conclusion: 'accepted', final_level: 'L2', confirmed_by: 'owner', reason: '明确' });
  return { project, item, template, requirement: req };
}

function answer({ item, template, uncertainties = [], failedMust = false, contract = GOOD }) {
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    workflow_template_id: template.template_id,
    convention_checks: [{ rule_key: 'api.response', severity: 'must', result: failedMust ? 'failed' : 'passed', reason: '确定性约定' }],
    api_contract_draft: contract,
    tasks: template.nodes.map((node) => ({
      node_key: node.key, purpose: node.purpose_template, scope: '订单 API', non_scope: '',
      done_when: node.done_when_template, serves_item_ids: [item.item_id],
      depends_on_node_keys: node.depends_on, expected_outputs: node.outputs,
    })),
    uncertainties,
  }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('suggest 只写 contract_orchestration，不创建任务/制品', async () => {
  const data = seed(); answer(data);
  const { suggestion, draft } = await suggestContractOrchestration(db, data.requirement.requirement_id, { workflow_template_id: data.template.template_id });
  assert.equal(suggestion.kind, 'contract_orchestration'); assert.equal(draft.adoptable, true);
  assert.equal(listTasks(db, { project_id: data.project.project_id }).length, 0);
  assert.equal(listArtifacts(db, { project_id: data.project.project_id }).length, 0);
});

test('adopt 创建 draft 契约与 4 个 open 任务，DAG 依赖映射 task id；重复采纳拒绝', async () => {
  const data = seed(); answer(data);
  const { suggestion } = await suggestContractOrchestration(db, data.requirement.requirement_id);
  const result = adoptContractOrchestration(db, suggestion.suggestion_id, { created_by: 'owner', contract_name: '订单 API' });
  assert.equal(result.artifact.status, 'draft'); assert.equal(result.tasks.length, 4);
  assert.ok(result.tasks.every((task) => task.status === 'open'));
  const frontend = result.tasks.find((task) => task.node_key === 'frontend');
  const contract = result.tasks.find((task) => task.node_key === 'contract');
  const integration = result.tasks.find((task) => task.node_key === 'integration');
  assert.deepEqual(frontend.blocked_by, [contract.task_id]); assert.equal(integration.blocked_by.length, 2);
  assert.throws(() => adoptContractOrchestration(db, suggestion.suggestion_id, { created_by: 'owner', contract_name: 'x' }), (e) => e.code === 'ORCHESTRATION_ALREADY_ADOPTED');
});

test('uncertainties 与 must 违规分别阻断采纳', async () => {
  let data = seed(); answer({ ...data, uncertainties: ['错误码未定'] });
  let { suggestion } = await suggestContractOrchestration(db, data.requirement.requirement_id);
  assert.throws(() => adoptContractOrchestration(db, suggestion.suggestion_id, { created_by: 'owner', contract_name: 'x' }), (e) => e.code === 'ORCHESTRATION_UNCERTAIN');
  data = seed(); answer({ ...data, failedMust: true });
  ({ suggestion } = await suggestContractOrchestration(db, data.requirement.requirement_id));
  assert.throws(() => adoptContractOrchestration(db, suggestion.suggestion_id, { created_by: 'owner', contract_name: 'x' }), (e) => e.code === 'CONTRACT_VALIDATION_FAILED');
});

test('unknown 节点与模板依赖不一致被拒', async () => {
  const data = seed();
  answer(data);
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    workflow_template_id: data.template.template_id, convention_checks: [], api_contract_draft: GOOD,
    tasks: [{ node_key: 'unknown', purpose: 'x', done_when: ['x'], serves_item_ids: [data.item.item_id], depends_on_node_keys: [], expected_outputs: [] }], uncertainties: [],
  }) } }] }), { status: 200 });
  await assert.rejects(() => suggestContractOrchestration(db, data.requirement.requirement_id), (e) => e.code === 'AI_BAD_RESPONSE');
});

test('HTTP：orchestrate 与 adopt-orchestration', async () => {
  const data = seed(); answer(data);
  const server = createServer(db); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/sap-cloud/api`;
  try {
    const suggested = await originalFetch(`${base}/requirements/${data.requirement.requirement_id}/orchestrate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(suggested.status, 201); const { suggestion } = await suggested.json();
    const adopted = await originalFetch(`${base}/ai/suggestions/${suggestion.suggestion_id}/adopt-orchestration`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ created_by: 'owner', contract_name: '订单 API' }) });
    assert.equal(adopted.status, 201); assert.equal((await adopted.json()).tasks.length, 4);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
