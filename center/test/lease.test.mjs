// P2 认领层测试：角色化认领、租约心跳、fencing 与过期回收。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openStore,
  createProject,
  createTrunkItem,
  createTask,
  openTask,
  getTask,
  claimTask,
  heartbeatClaim,
  releaseClaim,
  releaseTask,
  expireLeases,
  assertClaimValid,
  listClaims,
  createSubmission,
  listEvents,
} from '../src/store.mjs';

const dbPath = path.join(os.tmpdir(), `sap-lease-test-${process.pid}-${Date.now()}.db`);
let db;
let project;

test.before(() => {
  db = openStore(dbPath);
  project = createProject(db, { name: '租约项目' });
});

test.after(() => {
  db.close();
  fs.rmSync(dbPath, { force: true });
});

function seedOpenTask(label = '租约任务') {
  const item = createTrunkItem(db, {
    project_id: project.project_id, kind: 'capability', statement: `${label}-能力`,
  });
  const task = createTask(db, {
    project_id: project.project_id,
    purpose: label,
    done_when: ['可检验'],
    serves_item_ids: [item.item_id],
  });
  return openTask(db, task.task_id, { actor: 'tester' });
}

test('只有一个人能成为 owner，协作者可在 owner 之后加入且可并存', () => {
  const task = seedOpenTask('owner-唯一');
  const first = claimTask(db, task.task_id, 'worker_a');
  assert.equal(first.claim.role, 'owner');
  assert.equal(getTask(db, task.task_id).status, 'claimed');

  assert.throws(() => claimTask(db, task.task_id, 'worker_b'), /不可认领|TASK_NOT_CLAIMABLE/);

  const join1 = claimTask(db, task.task_id, 'worker_b', { role: 'collaborator' });
  const join2 = claimTask(db, task.task_id, 'worker_c', { role: 'collaborator' });
  assert.equal(join1.claim.role, 'collaborator');
  assert.equal(join2.claim.role, 'collaborator');
  assert.equal(getTask(db, task.task_id).status, 'claimed');
});

test('没有 owner 时不能以协作者身份加入', () => {
  const task = seedOpenTask('无owner');
  assert.throws(
    () => claimTask(db, task.task_id, 'worker_x', { role: 'collaborator' }),
    /CLAIM_OWNER_REQUIRED|owner/,
  );
});

test('fencing token 单调递增', () => {
  const task = seedOpenTask('token');
  const a = claimTask(db, task.task_id, 'worker_a');
  releaseClaim(db, a.claim.claim_id, 'worker_a');
  const b = claimTask(db, task.task_id, 'worker_b');
  assert.ok(b.claim.fencing_token > a.claim.fencing_token);
});

test('心跳续租延长到期时间；非本人不能续租', () => {
  const task = seedOpenTask('心跳');
  const claimed = claimTask(db, task.task_id, 'worker_a', { ttl_seconds: 60 });
  const before = claimed.claim.lease_expires_at;
  const renewed = heartbeatClaim(db, claimed.claim.claim_id, 'worker_a', { ttl_seconds: 600 });
  assert.ok(new Date(renewed.lease_expires_at) > new Date(before));
  assert.throws(
    () => heartbeatClaim(db, claimed.claim.claim_id, 'worker_b'),
    /本人|CLAIM_NOT_HEARTBEATABLE/,
  );
});

test('过期回收：任务回 open、旧 token 失效、可重新认领', () => {
  const task = seedOpenTask('过期');
  const claimed = claimTask(db, task.task_id, 'worker_a', { ttl_seconds: 1 });
  // 直接把租约置为过去，避免测试等待。
  db.prepare('UPDATE claims SET lease_expires_at = ? WHERE claim_id = ?')
    .run('2000-01-01T00:00:00.000Z', claimed.claim.claim_id);

  const expired = expireLeases(db);
  assert.ok(expired >= 1);
  assert.equal(getTask(db, task.task_id).status, 'open');
  const claim = listClaims(db, task.task_id)[0];
  assert.equal(claim.status, 'expired');

  assert.throws(
    () => assertClaimValid(db, claimed.claim.claim_id, { actor_id: 'worker_a' }),
    /LEASE_EXPIRED|已过期/,
  );

  const again = claimTask(db, task.task_id, 'worker_b');
  assert.ok(again.claim.fencing_token > claimed.claim.fencing_token);
});

test('expireLeases 幂等', () => {
  const task = seedOpenTask('幂等');
  const claimed = claimTask(db, task.task_id, 'worker_a', { ttl_seconds: 1 });
  db.prepare('UPDATE claims SET lease_expires_at = ? WHERE claim_id = ?')
    .run('2000-01-01T00:00:00.000Z', claimed.claim.claim_id);
  expireLeases(db);
  assert.equal(expireLeases(db), 0);
});

test('旧 token 提交被拒，新 token 可提交', () => {
  const task = seedOpenTask('fencing');
  const old = claimTask(db, task.task_id, 'worker_a', { ttl_seconds: 1 });
  db.prepare('UPDATE claims SET lease_expires_at = ? WHERE claim_id = ?')
    .run('2000-01-01T00:00:00.000Z', old.claim.claim_id);
  expireLeases(db);

  const fresh = claimTask(db, task.task_id, 'worker_b');
  assert.throws(() => createSubmission(db, {
    task_id: task.task_id,
    claim_id: old.claim.claim_id,
    fencing_token: old.claim.fencing_token,
    commit_refs: ['repo@old'],
    summary: '旧权利提交',
    submitted_by: 'worker_a',
  }), /LEASE_EXPIRED|已过期/);

  const submission = createSubmission(db, {
    task_id: task.task_id,
    claim_id: fresh.claim.claim_id,
    fencing_token: fresh.claim.fencing_token,
    commit_refs: ['repo@new'],
    summary: '新权利提交',
    submitted_by: 'worker_b',
  });
  assert.equal(submission.contribution, false);
  assert.equal(getTask(db, task.task_id).status, 'submitted');
});

test('协作者提交只记贡献，不推进任务状态；owner 提交才进入 submitted', () => {
  const task = seedOpenTask('协作提交');
  const owner = claimTask(db, task.task_id, 'worker_a');
  const collab = claimTask(db, task.task_id, 'worker_b', { role: 'collaborator' });

  const contribution = createSubmission(db, {
    task_id: task.task_id,
    claim_id: collab.claim.claim_id,
    fencing_token: collab.claim.fencing_token,
    commit_refs: ['repo@fe'],
    summary: '前端部分',
    submitted_by: 'worker_b',
  });
  assert.equal(contribution.contribution, true);
  assert.equal(getTask(db, task.task_id).status, 'claimed');

  const final = createSubmission(db, {
    task_id: task.task_id,
    claim_id: owner.claim.claim_id,
    fencing_token: owner.claim.fencing_token,
    commit_refs: ['repo@all'],
    summary: '汇总提交',
    submitted_by: 'worker_a',
  });
  assert.equal(final.contribution, false);
  assert.equal(getTask(db, task.task_id).status, 'submitted');

  const types = listEvents(db, { project_id: project.project_id }).map((event) => event.event_type);
  assert.ok(types.includes('submission.contributed'));
  assert.ok(types.includes('submission.created'));
});

test('旧接口 releaseTask 仍按任务释放 owner 认领', () => {
  const task = seedOpenTask('旧释放');
  claimTask(db, task.task_id, 'worker_a');
  const released = releaseTask(db, task.task_id, 'worker_a');
  assert.equal(released.claim.status, 'released');
  assert.equal(getTask(db, task.task_id).status, 'open');
  assert.throws(() => releaseTask(db, 'task_missing', 'worker_a'), /任务不存在/);
});
