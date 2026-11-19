// P1 身份与授权测试：主体、凭据、委派、人类专属动作与 legacy 兼容。

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import {
  addMember,
  createActor,
  createDelegation,
  findActorByToken,
  issueCredential,
  listMembers,
  revokeCredential,
  revokeDelegation,
  setActorStatus,
} from '../src/store.mjs';
import { createProject, openStore } from '../src/store.mjs';
import { createRequirement } from '../src/db/requirements.mjs';
import { createServer } from '../src/server.mjs';
import { assertCan } from '../src/auth/policy.mjs';

const dbPath = path.join(os.tmpdir(), `sap-actors-${process.pid}-${Date.now()}.db`);
let db;
let server;
let base;
let project;

function authHeaders(token) {
  return token ? { authorization: `Bearer ${token}`, 'content-type': 'application/json' } : { 'content-type': 'application/json' };
}

async function post(urlPath, body, token) {
  return fetch(`${base}/sap-cloud/api${urlPath}`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(body ?? {}),
  });
}

test.before(async () => {
  db = openStore(dbPath);
  project = createProject(db, { name: 'P1 项目' });
  server = createServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  db.close();
});

test('主体：先建人类；Agent 缺人类责任人被拒绝', () => {
  const human = createActor(db, { type: 'human', display_name: '张三', created_by: 'bootstrap' });
  assert.equal(human.type, 'human');

  assert.throws(
    () => createActor(db, { type: 'agent', display_name: '编码助手' }),
    (error) => error.code === 'AGENT_OWNER_REQUIRED',
  );

  const agent = createActor(db, {
    type: 'agent', display_name: '编码助手', on_behalf_of: human.actor_id, project_id: project.project_id,
  });
  assert.equal(agent.type, 'agent');
});

test('凭据：签发可用，撤销/过期/停用后失效', () => {
  const human = createActor(db, { type: 'human', display_name: `李四-${Date.now()}` });
  const { credential, token } = issueCredential(db, human.actor_id, { label: 'cli' });
  assert.match(token, /^sap_[0-9a-f]+$/);
  assert.equal(credential.token_hash, undefined, '返回对象不应包含哈希');

  const resolved = findActorByToken(db, token);
  assert.equal(resolved.actor.actor_id, human.actor_id);

  revokeCredential(db, credential.credential_id);
  assert.equal(findActorByToken(db, token), null);

  const again = issueCredential(db, human.actor_id, {});
  assert.ok(findActorByToken(db, again.token));

  const expired = issueCredential(db, human.actor_id, { expires_at: '2000-01-01T00:00:00.000Z' });
  assert.equal(findActorByToken(db, expired.token), null);

  const third = issueCredential(db, human.actor_id, {});
  setActorStatus(db, human.actor_id, 'disabled', { reason: '测试停用' });
  assert.equal(findActorByToken(db, third.token), null);
});

test('策略：Agent 无委派拒绝，有委派放行，撤销后再次拒绝', () => {
  const owner = createActor(db, { type: 'human', display_name: `王五-${Date.now()}` });
  const agent = createActor(db, {
    type: 'agent', display_name: `助手-${Date.now()}`, on_behalf_of: owner.actor_id, project_id: project.project_id,
  });
  const { token } = issueCredential(db, agent.actor_id, {});
  const req = { headers: { authorization: `Bearer ${token}` } };

  // createActor 已自动建立委派，先撤销以验证拒绝。
  const delegations = db.prepare('SELECT * FROM delegations WHERE agent_actor_id = ?').all(agent.actor_id);
  assert.equal(delegations.length, 1, '创建 Agent 时应自动建立委派');
  revokeDelegation(db, delegations[0].delegation_id, { reason: '测试撤销' });

  assert.throws(
    () => assertCan(db, req, 'task.claim', { project_id: project.project_id }),
    (error) => error.code === 'DELEGATION_REQUIRED',
  );

  createDelegation(db, {
    agent_actor_id: agent.actor_id, on_behalf_of: owner.actor_id, project_id: project.project_id, allowed_actions: ['task.claim'],
  });
  const allowed = assertCan(db, req, 'task.claim', { project_id: project.project_id });
  assert.equal(allowed.actor_type, 'agent');

  assert.throws(
    () => assertCan(db, req, 'submission.create', { project_id: project.project_id }),
    (error) => error.code === 'DELEGATION_REQUIRED',
    '委派未授予的动作应拒绝',
  );
});

test('人类专属动作：Agent token 403，人类 token 通过并写入快照', async () => {
  const human = createActor(db, { type: 'human', display_name: `赵六-${Date.now()}` });
  const humanToken = issueCredential(db, human.actor_id, {}).token;
  const agent = createActor(db, {
    type: 'agent', display_name: `助手2-${Date.now()}`, on_behalf_of: human.actor_id, project_id: project.project_id,
  });
  const agentToken = issueCredential(db, agent.actor_id, {}).token;

  const requirement = createRequirement(db, {
    project_id: project.project_id, raw_text: '需要一次决定', author: human.display_name,
  });

  const agentRes = await post(`/requirements/${requirement.requirement_id}/decision`, {
    conclusion: 'accepted', final_level: 'L2', reason: '测试',
  }, agentToken);
  assert.equal(agentRes.status, 403);
  assert.equal((await agentRes.json()).code, 'HUMAN_ACTION_REQUIRED');

  const humanRes = await post(`/requirements/${requirement.requirement_id}/decision`, {
    conclusion: 'accepted', final_level: 'L2', reason: '人类决定',
  }, humanToken);
  assert.equal(humanRes.status, 201);
  const decision = await humanRes.json();
  assert.equal(decision.confirmed_actor_type, 'human');
  const row = db.prepare('SELECT * FROM decisions WHERE decision_id = ?').get(decision.decision_id);
  assert.equal(row.confirmed_actor_type, 'human');
});

test('legacy 兼容：无 token 时按 legacy 记录', async () => {
  const requirement = createRequirement(db, {
    project_id: project.project_id, raw_text: '无 token 的决定', author: 'legacy',
  });
  const res = await post(`/requirements/${requirement.requirement_id}/decision`, {
    conclusion: 'accepted', final_level: 'L3', reason: 'legacy', confirmed_by: '老流程',
  });
  assert.equal(res.status, 201);
  const decision = await res.json();
  assert.equal(decision.confirmed_actor_type, 'legacy');
});

test('已撤销的 token 返回 401，不降级为 legacy', async () => {
  const human = createActor(db, { type: 'human', display_name: `撤销用例-${Date.now()}` });
  const issued = issueCredential(db, human.actor_id, {});
  revokeCredential(db, issued.credential.credential_id);

  const requirement = createRequirement(db, {
    project_id: project.project_id, raw_text: '撤销后决定', author: 'x',
  });
  const res = await post(`/requirements/${requirement.requirement_id}/decision`, {
    conclusion: 'rejected', reason: '撤销后尝试',
  }, issued.token);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, 'AUTH_INVALID');
});

test('SAP_AUTH_MODE=required：写操作无 token 401，读操作仍可匿名', async () => {
  const previous = process.env.SAP_AUTH_MODE;
  process.env.SAP_AUTH_MODE = 'required';
  try {
    const requirement = createRequirement(db, {
      project_id: project.project_id, raw_text: 'required 模式', author: 'system',
    });
    const denied = await post(`/requirements/${requirement.requirement_id}/decision`, {
      conclusion: 'accepted', final_level: 'L4', reason: '无 token', confirmed_by: '匿名',
    });
    assert.equal(denied.status, 401);
    assert.equal((await denied.json()).code, 'AUTH_REQUIRED');

    const read = await fetch(`${base}/sap-cloud/api/requirements/${requirement.requirement_id}`);
    assert.equal(read.status, 200, '读操作不应被强制鉴权');
  } finally {
    if (previous === undefined) delete process.env.SAP_AUTH_MODE;
    else process.env.SAP_AUTH_MODE = previous;
  }
});

test('项目成员：角色白名单与幂等更新', () => {
  const human = createActor(db, { type: 'human', display_name: `成员-${Date.now()}` });
  const member = addMember(db, project.project_id, { actor_id: human.actor_id, roles: ['reviewer'] });
  assert.deepEqual(member.roles, ['reviewer']);

  const updated = addMember(db, project.project_id, { actor_id: human.actor_id, roles: ['owner', 'publisher'] });
  assert.deepEqual(updated.roles, ['owner', 'publisher']);
  assert.equal(listMembers(db, project.project_id).length, 1, '同一主体不应重复插入');

  assert.throws(() => addMember(db, project.project_id, { actor_id: human.actor_id, roles: ['admin'] }), /非法的项目角色/);
});

test('HTTP：引导期可创建首位主体，之后需要人类 token', async () => {
  // 已存在主体，无 token 创建应被拒绝。
  const denied = await post('/actors', { type: 'human', display_name: '未授权' });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, 'HUMAN_ACTION_REQUIRED');

  const human = createActor(db, { type: 'human', display_name: `管理员-${Date.now()}` });
  const token = issueCredential(db, human.actor_id, {}).token;
  const created = await post('/actors', { type: 'service', display_name: 'CI 回调' }, token);
  assert.equal(created.status, 201);
  assert.equal((await created.json()).type, 'service');
});
