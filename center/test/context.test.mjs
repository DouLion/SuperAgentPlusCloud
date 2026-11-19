// P4 上下文包测试：租约、摘要、过期判断与降级。

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import {
  activeDelegationFor,
  createActor,
  createArtifact,
  createConventionPack,
  createProject,
  createRequirement,
  createTask,
  createTrunkItem,
  issueCredential,
  openStore,
  openTask,
  publishArtifact,
  claimTask,
} from '../src/store.mjs';
import { buildTaskContext, contextDigestOf } from '../src/context/bundle.mjs';
import { activateConventionPack } from '../src/db/conventions.mjs';

const dbPath = path.join(os.tmpdir(), `sap-context-${process.pid}-${Date.now()}.db`);
let db;
let project;
let human;
let agent;
let delegation;
let task;
let contract;

const CONTRACT = {
  openapi: '3.1.0',
  info: { title: '上下文测试 API', version: '1.0.0' },
  paths: {
    '/demo/query': {
      post: {
        operationId: 'queryDemo',
        responses: {
          200: {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Envelope' },
              },
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

test.before(() => {
  db = openStore(dbPath);
  project = createProject(db, { name: 'P4 上下文项目' });
  human = createActor(db, { type: 'human', display_name: '负责人', created_by: 'bootstrap' });
  agent = createActor(db, {
    type: 'agent',
    display_name: '编码助手',
    on_behalf_of: human.actor_id,
    project_id: project.project_id,
  });
  delegation = activeDelegationFor(db, agent.actor_id, project.project_id);

  const item = createTrunkItem(db, {
    project_id: project.project_id,
    kind: 'capability',
    statement: '系统能给出任务上下文',
    rationale: 'Agent 需要一次取全背景',
    status: 'active',
    confirmed_by: '负责人',
  });
  const pack = createConventionPack(db, {
    name: 'P4 约定',
    scope: 'project',
    project_id: project.project_id,
    created_by: '负责人',
    rules: [{ key: 'api.response', title: '响应包络', severity: 'must', value: { fields: ['status', 'message', 'data'] } }],
  });
  activateConventionPack(db, pack.pack_id, { activated_by: '负责人', reason: '启用' });

  contract = createArtifact(db, {
    project_id: project.project_id,
    type: 'api_contract',
    name: '上下文契约',
    content: CONTRACT,
    created_by: '负责人',
  });
  publishArtifact(db, contract.artifact_id, { published_by: '负责人', reason: '首版' });

  const requirement = createRequirement(db, {
    project_id: project.project_id,
    author: '负责人',
    raw_text: '让 Agent 能一次拿到任务上下文',
    status: 'accepted',
  });
  const created = createTask(db, {
    project_id: project.project_id,
    requirement_id: requirement.requirement_id,
    purpose: '实现上下文包',
    done_when: ['上下文包含租约与摘要'],
    serves_item_ids: [item.item_id],
    created_by: '负责人',
  });
  task = openTask(db, created.task_id, { actor: '负责人' });
});

test.after(() => {
  db.close();
});

test('上下文包：包含任务、主干、约定、契约、租约与摘要', () => {
  const claim = claimTask(db, task.task_id, agent.actor_id, { role: 'owner' });
  const context = buildTaskContext(db, task.task_id, { actor: agent, delegation });

  assert.equal(context.task.task_id, task.task_id);
  assert.ok(context.active_trunk.length >= 1);
  assert.ok(context.active_conventions.length >= 1);
  assert.equal(context.relevant_contracts[0].artifact_id, contract.artifact_id);
  assert.equal(context.lease.claim_id, claim.claim.claim_id);
  assert.equal(context.lease.fencing_token, claim.claim.fencing_token);
  assert.equal(context.degraded, false);
  for (const key of ['task', 'trunk', 'conventions', 'contracts']) {
    assert.match(context.digests[key], /^[0-9a-f]{64}$/);
  }
  assert.equal(context.staleness.contracts_changed_since_claim, false);

  // 同一内容两次构造，摘要应当一致（generated_at 不参与）。
  const again = buildTaskContext(db, task.task_id, { actor: agent, delegation });
  assert.equal(contextDigestOf(context), contextDigestOf(again));
});

test('上下文包：契约发布新版本后 staleness 变真', () => {
  const next = createArtifact(db, {
    project_id: project.project_id,
    type: 'api_contract',
    name: '上下文契约',
    content: { ...CONTRACT, info: { ...CONTRACT.info, version: '1.1.0' } },
    created_by: '负责人',
  });
  publishArtifact(db, next.artifact_id, { published_by: '负责人', reason: '升版' });

  const context = buildTaskContext(db, task.task_id, { actor: agent, delegation });
  assert.equal(context.staleness.contracts_changed_since_claim, true);
});

test('上下文包：无凭据时降级，只给任务级字段', () => {
  const context = buildTaskContext(db, task.task_id, {});
  assert.equal(context.degraded, true);
  assert.deepEqual(context.active_trunk, []);
  assert.deepEqual(context.relevant_contracts, []);
  assert.equal(context.requirement.requirement_id !== undefined, true);
  assert.equal(context.digests.trunk, null);
});
