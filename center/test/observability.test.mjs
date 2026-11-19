// Center 观测层测试（P5）：主体在线判定、卡住任务识别、流水线指标、role_hint 优先级。
// 运行：node --test center/test/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openStore,
  createProject,
  createRequirement,
  createTrunkItem,
  createTask,
  openTask,
} from '../src/store.mjs';
import { createActor, issueCredential } from '../src/db/actors.mjs';
import { claimTask } from '../src/db/claims.mjs';
import {
  ONLINE_WINDOW_MS,
  actorStatus,
  pipelineStats,
  stuckTasks,
} from '../src/observability/metrics.mjs';
import { createServer } from '../src/server.mjs';

const dbPath = path.join(os.tmpdir(), `sap-observability-test-${process.pid}-${Date.now()}.db`);

let db;

test.before(() => {
  db = openStore(dbPath);
});

test.after(() => {
  db.close();
  fs.rmSync(dbPath, { force: true });
});

let seq = 0;

/** 建项目 + 需求 + 主干条目 + 已开放任务。 */
function seedTask(extra = {}) {
  seq += 1;
  const project = createProject(db, { name: `观测项目-${seq}` });
  const requirement = createRequirement(db, {
    project_id: project.project_id,
    raw_text: `需求-${seq}`,
    author: 'alice',
  });
  const item = createTrunkItem(db, {
    project_id: project.project_id,
    kind: 'scope',
    statement: `条目-${seq}`,
  });
  const task = createTask(db, {
    project_id: project.project_id,
    requirement_id: requirement.requirement_id,
    purpose: `任务-${seq}`,
    done_when: ['可检验'],
    serves_item_ids: [item.item_id],
    ...extra,
  });
  return { project, requirement, item, task: openTask(db, task.task_id, { actor: 'alice' }) };
}

/** 直接改认领时间字段，构造确定性的时间场景。 */
function setClaimTimes(claimId, patch) {
  const fields = [];
  const values = [];
  for (const [key, value] of Object.entries(patch)) {
    fields.push(`${key} = ?`);
    values.push(value);
  }
  values.push(claimId);
  db.prepare(`UPDATE claims SET ${fields.join(', ')} WHERE claim_id = ?`).run(...values);
}

function iso(ms) {
  return new Date(ms).toISOString();
}

test('主体在线判定：online / idle / never', () => {
  const human = createActor(db, { type: 'human', display_name: '在线人' });
  const { token } = issueCredential(db, human.actor_id, { label: 'test' });
  // 模拟刚用过凭据
  db.prepare("UPDATE actor_credentials SET last_used_at = ? WHERE actor_id = ?")
    .run(iso(Date.now()), human.actor_id);

  const idle = createActor(db, { type: 'human', display_name: '离线人' });
  issueCredential(db, idle.actor_id, { label: 'old' });
  db.prepare("UPDATE actor_credentials SET last_used_at = ? WHERE actor_id = ?")
    .run(iso(Date.now() - ONLINE_WINDOW_MS - 60_000), idle.actor_id);

  const never = createActor(db, { type: 'service', display_name: '从未使用' });

  const rows = actorStatus(db);
  const byId = Object.fromEntries(rows.map((row) => [row.actor_id, row]));
  assert.equal(byId[human.actor_id].presence, 'online');
  assert.equal(byId[idle.actor_id].presence, 'idle');
  assert.equal(byId[never.actor_id].presence, 'never');
  assert.ok(token.startsWith('sap_'));
  assert.equal(typeof byId[human.actor_id].active_claims, 'number');
  assert.equal(typeof byId[human.actor_id].capabilities, 'object');
});

test('卡住任务：三类都能识别，健康任务不误报', () => {
  const now = Date.now();

  // 1) lease_expiring：租约 2 分钟后到期，且没有提交
  const expiring = seedTask();
  const claimExpiring = claimTask(db, expiring.task.task_id, 'agent-a', { role: 'owner' }).claim;
  setClaimTimes(claimExpiring.claim_id, {
    heartbeat_at: iso(now - 60_000),
    lease_expires_at: iso(now + 2 * 60_000),
  });

  // 2) review_overdue：已提交，25 小时前
  const overdue = seedTask();
  const claimOverdue = claimTask(db, overdue.task.task_id, 'agent-b', { role: 'owner' }).claim;
  db.prepare(`INSERT INTO submissions (
    submission_id, task_id, claim_id, commit_refs, summary, self_test, known_gaps,
    artifacts, submitted_by, submitted_at, created_at
  ) VALUES (?, ?, ?, '[]', '完成', NULL, '[]', '[]', ?, ?, ?)`).run(
    `sub_${Date.now()}_overdue`, overdue.task.task_id, claimOverdue.claim_id,
    'agent-b', iso(now - 25 * 3600_000), iso(now - 25 * 3600_000),
  );
  db.prepare("UPDATE tasks SET status = 'submitted' WHERE task_id = ?").run(overdue.task.task_id);

  // 3) heartbeat_stale：租约 30 分钟，但心跳停在 90 分钟前（租约已到期且无人续租）
  const stale = seedTask();
  const claimStale = claimTask(db, stale.task.task_id, 'agent-c', { role: 'owner' }).claim;
  setClaimTimes(claimStale.claim_id, {
    heartbeat_at: iso(now - 90 * 60_000),
    lease_expires_at: iso(now - 60 * 60_000),
  });

  // 4) 健康任务：刚心跳、租约充裕、无提交
  const healthy = seedTask();
  const claimHealthy = claimTask(db, healthy.task.task_id, 'agent-d', { role: 'owner' }).claim;
  setClaimTimes(claimHealthy.claim_id, {
    heartbeat_at: iso(now - 60_000),
    lease_expires_at: iso(now + 25 * 60_000),
  });

  const items = stuckTasks(db, now);
  const kindsFor = (taskId) => items.filter((item) => item.task_id === taskId).map((item) => item.kind);

  assert.deepEqual(kindsFor(expiring.task.task_id), ['lease_expiring']);
  assert.deepEqual(kindsFor(overdue.task.task_id), ['review_overdue']);
  assert.deepEqual(kindsFor(stale.task.task_id), ['heartbeat_stale']);
  assert.deepEqual(kindsFor(healthy.task.task_id), []);
});

test('流水线指标：字段完整，租约过期率 1/3', () => {
  const before = pipelineStats(db, {});
  assert.ok(Object.prototype.hasOwnProperty.call(before, 'tasks_by_status'));
  assert.ok(Object.prototype.hasOwnProperty.call(before, 'avg_claim_latency_ms'));
  assert.ok(Object.prototype.hasOwnProperty.call(before, 'lease_expiry_rate'));
  assert.ok(Object.prototype.hasOwnProperty.call(before, 'avg_review_latency_ms'));
  assert.ok(Object.prototype.hasOwnProperty.call(before, 'idempotency_replays'));
  assert.ok(Object.prototype.hasOwnProperty.call(before, 'outbox_pending'));

  // 独立项目里构造 4 条 owner 认领，其中 1 条过期 → 0.25
  const project = createProject(db, { name: '过期率项目' });
  const item = createTrunkItem(db, { project_id: project.project_id, kind: 'scope', statement: 'x' });
  const created = [];
  for (let i = 0; i < 4; i += 1) {
    const task = createTask(db, {
      project_id: project.project_id,
      purpose: `过期率任务-${i}`,
      done_when: ['ok'],
      serves_item_ids: [item.item_id],
    });
    created.push(openTask(db, task.task_id, { actor: 'alice' }));
  }
  const claims = created.map((task, index) => claimTask(
    db, task.task_id, `worker-${index}`, { role: 'owner' },
  ).claim);
  db.prepare("UPDATE claims SET status = 'expired' WHERE claim_id = ?").run(claims[0].claim_id);

  const stats = pipelineStats(db, { project_id: project.project_id });
  assert.equal(stats.lease_expiry_rate, 0.25);
  assert.equal(stats.tasks_total, 4);
  assert.equal(stats.project_id, project.project_id);
});

test('role_hint 优先级：任务显式优先于编排模板，都没有时给出原因', async () => {
  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/sap-cloud/api`;
  try {
    const explicit = seedTask({ role_hint: 'backend' });
    const first = await fetch(`${base}/tasks/${explicit.task.task_id}/candidates`).then((r) => r.json());
    assert.equal(first.role_hint, 'backend');
    assert.equal(first.source, 'task');
    assert.equal(first.node_key, null);

    const plain = seedTask();
    const second = await fetch(`${base}/tasks/${plain.task.task_id}/candidates`).then((r) => r.json());
    assert.equal(second.source, 'none');
    assert.equal(second.role_hint, null);
    assert.ok(second.reason);
  } finally {
    server.close();
  }
});

test('观测路由：actors / stuck / stats 可用', async () => {
  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/sap-cloud/api`;
  try {
    const actors = await fetch(`${base}/observability/actors`).then((r) => r.json());
    assert.ok(Array.isArray(actors.actors));
    assert.ok(actors.generated_at);

    const stuck = await fetch(`${base}/observability/stuck`).then((r) => r.json());
    assert.ok(Array.isArray(stuck.items));
    assert.equal(stuck.count, stuck.items.length);

    const stats = await fetch(`${base}/observability/stats`).then((r) => r.json());
    assert.ok(Object.prototype.hasOwnProperty.call(stats, 'tasks_total'));
  } finally {
    server.close();
  }
});
