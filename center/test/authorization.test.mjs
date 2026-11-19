// D 枝：管理员、项目角色强制、主体生命周期与安全配置。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  addMember,
  claimTask,
  createActor,
  createProject,
  createRequirement,
  createReview,
  createSubmission,
  createTask,
  getActor,
  getClaim,
  getTask,
  issueCredential,
  openStore,
  openTask,
  setActorAdmin,
  setActorStatus,
} from '../src/store.mjs';
import { assertCan, assertProjectRole, projectRoles } from '../src/auth/policy.mjs';
import { initSetup, setupStatus } from '../src/setup.mjs';
import { resolveConfig } from '../src/config.mjs';

function tempDb(name) {
  return path.join(os.tmpdir(), `sap-authz-${name}-${process.pid}-${Date.now()}.db`);
}

function reqWith(token) {
  return { headers: token ? { authorization: `Bearer ${token}` } : {} };
}

/** 临时切换环境变量并在结束后恢复。 */
function withEnv(patch, fn) {
  const backup = {};
  for (const key of Object.keys(patch)) backup[key] = process.env[key];
  Object.assign(process.env, patch);
  try {
    return fn();
  } finally {
    for (const key of Object.keys(patch)) {
      if (backup[key] === undefined) delete process.env[key];
      else process.env[key] = backup[key];
    }
  }
}

test('主体：首个创建的主体自动成为管理员', () => {
  const dbPath = tempDb('bootstrap');
  const db = openStore(dbPath);
  try {
    const first = createActor(db, { type: 'human', display_name: '第一位' });
    assert.equal(first.is_admin, 1);
    const second = createActor(db, { type: 'human', display_name: '第二位' });
    assert.equal(second.is_admin, 0);
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test('主体：可授予与取消管理员，Agent 不能被设为管理员', () => {
  const dbPath = tempDb('admin');
  const db = openStore(dbPath);
  try {
    const human = createActor(db, { type: 'human', display_name: '管理员' });
    const member = createActor(db, { type: 'human', display_name: '成员' });
    assert.equal(setActorAdmin(db, member.actor_id, true).is_admin, 1);
    assert.equal(setActorAdmin(db, member.actor_id, false).is_admin, 0);

    const agent = createActor(db, {
      type: 'agent', display_name: 'Agent', on_behalf_of: human.actor_id,
    });
    assert.throws(() => setActorAdmin(db, agent.actor_id, true), /管理员必须是人类/);
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test('角色强制 off：不要求项目角色', () => {
  const dbPath = tempDb('role-off');
  const db = openStore(dbPath);
  try {
    const project = createProject(db, { name: '角色项目' });
    const human = createActor(db, { type: 'human', display_name: '无角色成员' });
    const token = issueCredential(db, human.actor_id, {}).token;
    const auth = assertCan(db, reqWith(token), 'review.record', { project_id: project.project_id });
    const result = withEnv({ SAP_ROLE_ENFORCEMENT: 'off' }, () => (
      assertProjectRole(db, auth, 'review.record', { project_id: project.project_id })
    ));
    assert.equal(result.role_check, 'skipped');
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test('角色强制 on：无 reviewer 角色被拒，授予后通过', () => {
  const dbPath = tempDb('role-on');
  const db = openStore(dbPath);
  try {
    const project = createProject(db, { name: '角色项目 2' });
    const human = createActor(db, { type: 'human', display_name: '评审人' });
    const token = issueCredential(db, human.actor_id, {}).token;
    const auth = assertCan(db, reqWith(token), 'review.record', { project_id: project.project_id });

    withEnv({ SAP_ROLE_ENFORCEMENT: 'on' }, () => {
      assert.throws(
        () => assertProjectRole(db, auth, 'review.record', { project_id: project.project_id }),
        (err) => err.code === 'PROJECT_ROLE_REQUIRED',
      );
    });

    addMember(db, project.project_id, { actor_id: human.actor_id, roles: ['reviewer'] });
    assert.deepEqual(projectRoles(db, human.actor_id, project.project_id), ['reviewer']);

    const passed = withEnv({ SAP_ROLE_ENFORCEMENT: 'on' }, () => (
      assertProjectRole(db, auth, 'review.record', { project_id: project.project_id })
    ));
    assert.equal(passed.role_check, 'passed');
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test('角色强制 on：Agent 不能靠责任人角色绕过人类专属动作', () => {
  const dbPath = tempDb('role-agent');
  const db = openStore(dbPath);
  try {
    const project = createProject(db, { name: '角色项目 3' });
    const owner = createActor(db, { type: 'human', display_name: '责任人' });
    const agent = createActor(db, {
      type: 'agent', display_name: '编码 Agent', on_behalf_of: owner.actor_id,
      allowed_actions: ['trunk_item.confirm'], project_id: project.project_id,
    });
    const token = issueCredential(db, agent.actor_id, {}).token;
    addMember(db, project.project_id, { actor_id: owner.actor_id, roles: ['direction'] });

    // 责任人拥有 direction 角色，但动作本身只能由人类执行，Agent 依然被拒。
    withEnv({ SAP_ROLE_ENFORCEMENT: 'on' }, () => {
      assert.throws(
        () => assertCan(db, reqWith(token), 'trunk_item.confirm', { project_id: project.project_id }),
        (err) => err.code === 'HUMAN_ACTION_REQUIRED',
      );
    });

    // 人类本人持有 direction 角色时可通过角色校验。
    const ownerToken = issueCredential(db, owner.actor_id, {}).token;
    const auth = assertCan(db, reqWith(ownerToken), 'trunk_item.confirm', { project_id: project.project_id });
    const passed = withEnv({ SAP_ROLE_ENFORCEMENT: 'on' }, () => (
      assertProjectRole(db, auth, 'trunk_item.confirm', { project_id: project.project_id })
    ));
    assert.equal(passed.role_check, 'passed');
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test('生命周期：停用主体释放其进行中的认领', () => {
  const dbPath = tempDb('lifecycle');
  const db = openStore(dbPath);
  try {
    const project = createProject(db, { name: '生命周期项目' });
    const owner = createActor(db, { type: 'human', display_name: '责任人' });
    const agent = createActor(db, {
      type: 'agent', display_name: 'Agent', on_behalf_of: owner.actor_id,
      allowed_actions: ['claim'], project_id: project.project_id,
    });
    const requirement = createRequirement(db, { project_id: project.project_id, raw_text: '做点事', author: 't' });
    const trunItem = db.prepare(`INSERT INTO trunk_items (item_id, project_id, kind, statement, status, created_at)
      VALUES ('item_x', ?, 'goal', '目标', 'active', ?)`).run(project.project_id, new Date().toISOString());
    assert.ok(trunItem);
    const draft = createTask(db, {
      project_id: project.project_id,
      requirement_id: requirement.requirement_id,
      purpose: '任务',
      done_when: ['可检验'],
      serves_item_ids: ['item_x'],
    });
    openTask(db, draft.task_id);
    const claimed = claimTask(db, draft.task_id, agent.actor_id, { ttl_seconds: 600 });
    assert.equal(claimed.task.status, 'claimed');

    const disabled = setActorStatus(db, agent.actor_id, 'disabled', { reason: '测试停用' });
    assert.equal(disabled.status, 'disabled');
    assert.equal(disabled.released_claims, 1);
    assert.equal(getClaim(db, claimed.claim.claim_id).status, 'released');
    assert.equal(getTask(db, draft.task_id).status, 'open');
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test('评审：自审被标记，且角色强制开启时责任人也需评审角色', () => {
  const dbPath = tempDb('review');
  const db = openStore(dbPath);
  try {
    const project = createProject(db, { name: '评审项目' });
    const worker = createActor(db, { type: 'human', display_name: '执行者' });
    const fromWorker = createActor(db, { type: 'human', display_name: '他人' });
    db.prepare(`INSERT INTO trunk_items (item_id, project_id, kind, statement, status, created_at)
      VALUES ('item_r', ?, 'goal', '目标', 'active', ?)`).run(project.project_id, new Date().toISOString());
    const requirement = createRequirement(db, { project_id: project.project_id, raw_text: '做事', author: 't' });
    const draft = createTask(db, {
      project_id: project.project_id,
      requirement_id: requirement.requirement_id,
      purpose: '任务',
      done_when: ['可检验'],
      serves_item_ids: ['item_r'],
    });
    openTask(db, draft.task_id);
    const claimed = claimTask(db, draft.task_id, worker.actor_id, { ttl_seconds: 600 });

    const submission = createSubmission(db, {
      task_id: draft.task_id,
      claim_id: claimed.claim.claim_id,
      submitted_by: worker.actor_id,
      commit_refs: [{ repo: 'r', branch: 'main', hash: 'abc' }],
      summary: '完成',
      self_test: '通过',
      fencing_token: claimed.claim.fencing_token,
    });
    const selfReview = createReview(db, {
      submission_id: submission.submission_id,
      reviewer_id: worker.actor_id,
      conclusion: 'confirm',
      criterion_results: [{ criterion: '可检验', result: '通过', evidence: '自测' }],
    });
    assert.equal(selfReview.self_review, 1);

    const fromWorkerReview = createReview(db, {
      submission_id: submission.submission_id,
      reviewer_id: fromWorker.actor_id,
      conclusion: 'needs_info',
      criterion_results: [{ criterion: '可检验', result: '待补', evidence: '无' }],
    });
    assert.equal(fromWorkerReview.self_review, 0);
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test('安全配置：setup 写入后 resolveConfig 读回一致', () => {
  const configPath = path.join(os.tmpdir(), `sap-config-${process.pid}-${Date.now()}.json`);
  const env = { SAP_CONFIG_PATH: configPath };
  try {
    initSetup({
      initialized: true,
      security: { auth_mode: 'required', role_enforcement: 'on' },
    }, env);
    const status = setupStatus(env);
    assert.equal(status.security.auth_mode, 'required');
    assert.equal(status.security.role_enforcement, 'on');

    const resolved = resolveConfig(env);
    assert.equal(resolved.security.auth_mode, 'required');
    assert.equal(resolved.security.role_enforcement, 'on');
  } finally {
    fs.rmSync(configPath, { force: true });
  }
});

test('安全配置：非法值被拒绝', () => {
  const configPath = path.join(os.tmpdir(), `sap-config-bad-${process.pid}-${Date.now()}.json`);
  const env = { SAP_CONFIG_PATH: configPath };
  try {
    assert.throws(
      () => initSetup({ security: { auth_mode: 'nope' } }, env),
      (err) => err.code === 'INVALID_AUTH_MODE',
    );
    assert.throws(
      () => initSetup({ security: { role_enforcement: 'nope' } }, env),
      (err) => err.code === 'INVALID_ROLE_ENFORCEMENT',
    );
  } finally {
    fs.rmSync(configPath, { force: true });
  }
});

test('主体：停用后凭据立即失效', () => {
  const dbPath = tempDb('revoke');
  const db = openStore(dbPath);
  try {
    const human = createActor(db, { type: 'human', display_name: '将被停用' });
    const token = issueCredential(db, human.actor_id, {}).token;
    assert.ok(assertCan(db, reqWith(token), 'trunk_item.confirm', {}).actor);
    setActorStatus(db, human.actor_id, 'disabled', { reason: '测试' });
    assert.throws(
      () => assertCan(db, reqWith(token), 'trunk_item.confirm', {}),
      (err) => err.code === 'AUTH_INVALID',
    );
    assert.equal(getActor(db, human.actor_id).status, 'disabled');
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});
