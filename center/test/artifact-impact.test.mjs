// 契约变更影响分析（B 枝）：发布新版本时生成待检查影响项。
// 覆盖：发布不生成；升版生成提交与编排任务各一条；重复发布不重复；处置校验。

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import {
  openStore,
  createProject,
  createTrunkItem,
  createTask,
  openTask,
  claimTask,
  createSubmission,
  createArtifact,
  publishArtifact,
  createAiSuggestion,
  addImpactItem,
  createTrunkChange,
  listImpacts,
  updateImpact,
} from '../src/store.mjs';

const dbPath = path.join(os.tmpdir(), `sap-artifact-impact-${process.pid}-${Date.now()}.db`);
let db;

test.before(() => { db = openStore(dbPath); });
test.after(() => { db.close(); });

const CONTRACT = (version) => ({
  openapi: '3.1.0',
  info: { title: '订单 API', version },
  paths: {
    '/orders/query': {
      post: {
        operationId: 'queryOrders',
        responses: {
          200: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['status', 'message', 'data'],
                  properties: {
                    status: { type: 'integer', const: 1 },
                    message: { type: 'string', example: 'ok' },
                    data: { type: 'array', items: { type: 'object' } },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
});

function seedProject(name) {
  return createProject(db, { name: `${name}-${Date.now()}-${Math.random()}` });
}

function publish(projectId, name, version) {
  const artifact = createArtifact(db, {
    project_id: projectId, type: 'api_contract', name, content: CONTRACT(version), created_by: 'owner',
  });
  publishArtifact(db, artifact.artifact_id, { published_by: 'owner', reason: `发布 ${version}` });
  return artifact;
}

test('发布首个版本不生成影响项', () => {
  const project = seedProject('首个版本');
  const v1 = publish(project.project_id, '订单 API', '1.0.0');
  assert.deepEqual(listImpacts(db, { source_type: 'artifact', source_id: v1.artifact_id }), []);
});

test('升版对引用旧版本的提交与编排任务各生成一条待检查影响', () => {
  const project = seedProject('升版');
  const item = createTrunkItem(db, {
    project_id: project.project_id, kind: 'interface', statement: '订单查询接口', created_by: 'owner',
  });
  const task = openTask(db, createTask(db, {
    project_id: project.project_id,
    purpose: '按契约实现订单查询',
    done_when: ['返回包络符合契约'],
    serves_item_ids: [item.item_id],
    created_by: 'owner',
  }).task_id, { actor: 'owner' });
  const claim = claimTask(db, task.task_id, 'worker-a');
  createSubmission(db, {
    task_id: task.task_id,
    claim_id: claim.claim.claim_id,
    submitted_by: 'worker-a',
    commit_refs: ['repo@aaa'],
    summary: '完成初版',
    artifacts: [],
  });

  const v1 = publish(project.project_id, '订单 API', '1.0.0');
  // 提交引用 v1 制品
  db.prepare('UPDATE submissions SET artifacts = ? WHERE task_id = ?')
    .run(JSON.stringify([v1.artifact_id]), task.task_id);
  // 已采纳编排建议指向 v1
  createAiSuggestion(db, {
    project_id: project.project_id,
    kind: 'contract_orchestration',
    payload: { artifact_id: v1.artifact_id, task_ids: [task.task_id] },
  });

  const v2 = publish(project.project_id, '订单 API', '1.1.0');
  const impacts = listImpacts(db, { source_type: 'artifact', source_id: v2.artifact_id });
  assert.equal(impacts.length, 2);
  assert.equal(impacts.filter((row) => row.target_type === 'submission').length, 1);
  assert.equal(impacts.filter((row) => row.target_type === 'task').length, 1);
  assert.ok(impacts.every((row) => row.assessment_status === 'to_check'));
  assert.ok(impacts.every((row) => row.resolution === 'pending'));
  assert.ok(impacts.every((row) => /升级到 v\d+/.test(String(row.reason))));
});

test('同一目标被多次引用时只登记一条影响项', () => {
  const project = seedProject('幂等');
  const item = createTrunkItem(db, {
    project_id: project.project_id, kind: 'interface', statement: '接口', created_by: 'owner',
  });
  const task = openTask(db, createTask(db, {
    project_id: project.project_id,
    purpose: '实现',
    done_when: ['通过'],
    serves_item_ids: [item.item_id],
    created_by: 'owner',
  }).task_id, { actor: 'owner' });
  const v1 = publish(project.project_id, '幂等 API', '1.0.0');
  // 两份建议都指向同一任务，生成时应去重
  for (let i = 0; i < 2; i += 1) {
    createAiSuggestion(db, {
      project_id: project.project_id,
      kind: 'contract_orchestration',
      payload: { artifact_id: v1.artifact_id, task_ids: [task.task_id] },
    });
  }
  const v2 = publish(project.project_id, '幂等 API', '1.1.0');
  const first = listImpacts(db, { source_type: 'artifact', source_id: v2.artifact_id });
  assert.equal(first.length, 1);

  const v3 = publish(project.project_id, '幂等 API', '1.2.0');
  const second = listImpacts(db, { source_type: 'artifact', source_id: v3.artifact_id });
  assert.equal(second.length, 1);
  // v2 的历史影响仍保留，不被覆盖
  assert.equal(listImpacts(db, { source_type: 'artifact', source_id: v2.artifact_id }).length, 1);
});

test('处置校验：not_affected 必须给理由，处置后状态可查', () => {
  const project = seedProject('处置');
  const v1 = publish(project.project_id, '处置 API', '1.0.0');
  const v2 = publish(project.project_id, '处置 API', '1.1.0');
  const created = db.prepare(`INSERT INTO impact_items (
    impact_item_id, change_id, source_type, source_id, target_type, target_id,
    assessment_status, resolution, reason, owner_id, updated_at, created_at
  ) VALUES ('imp_manual', NULL, 'artifact', ?, 'document', 'doc-1', 'to_check', 'pending', NULL, NULL, ?, ?)`)
    .run(v2.artifact_id, new Date().toISOString(), new Date().toISOString());
  assert.ok(created);

  assert.throws(() => updateImpact(db, 'imp_manual', { assessment_status: 'not_affected' }), /reason/);
  const updated = updateImpact(db, 'imp_manual', {
    assessment_status: 'not_affected', resolution: 'continue', reason: '文档未引用该接口',
  });
  assert.equal(updated.assessment_status, 'not_affected');
  assert.equal(updated.resolution, 'continue');
  assert.equal(listImpacts(db, { source_type: 'artifact', source_id: v2.artifact_id, assessment_status: 'not_affected' }).length, 1);
});

test('主干变更影响项保持原有行为', () => {
  const project = seedProject('变更回归');
  const change = createTrunkChange(db, {
    project_id: project.project_id, reason: '调整接口约定', created_by: 'owner',
  });
  const item = addImpactItem(db, {
    change_id: change.change_id, target_type: 'task', target_id: 'task_x',
  });
  assert.equal(item.source_type, 'trunk_change');
  assert.equal(item.source_id, change.change_id);
  const listed = listImpacts(db, { source_type: 'trunk_change', source_id: change.change_id });
  assert.equal(listed.length, 1);
});
