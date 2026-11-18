// Center 任务与认领测试（T3）。
// 运行：node --test center/test/
// 测试数据库使用系统临时目录，结束后删除。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openStore,
  createProject,
  createRequirement,
  createTask,
  getTask,
  listTasks,
  openTask,
  claimTask,
  releaseTask,
  listClaims,
  listEvents,
} from '../src/store.mjs';
import { createServer } from '../src/server.mjs';

const dbPath = path.join(
  os.tmpdir(),
  `sap-center-task-test-${process.pid}-${Date.now()}.db`,
);

let db;

test.before(() => {
  db = openStore(dbPath);
});

test.after(() => {
  db.close();
  fs.rmSync(dbPath, { force: true });
});

/** 建一个项目与需求，返回 { project, requirement }。 */
function seed() {
  const project = createProject(db, { name: 'T3 任务项目' });
  const requirement = createRequirement(db, {
    project_id: project.project_id,
    raw_text: '希望支持按项目导出任务清单',
    author: 'alice',
  });
  return { project, requirement };
}

test('任务：必填校验（缺 purpose / done_when / 空数组 / 不存在项目）', () => {
  const { project } = seed();

  assert.throws(
    () => createTask(db, { project_id: project.project_id, done_when: ['可检验'] }),
    /缺少必填字段：purpose/,
  );
  assert.throws(
    () => createTask(db, { project_id: project.project_id, purpose: '导出任务' }),
    /缺少必填字段：done_when/,
  );
  assert.throws(
    () => createTask(db, { project_id: project.project_id, purpose: '导出任务', done_when: [] }),
    /缺少必填字段：done_when/,
  );
  assert.throws(
    () => createTask(db, {
      project_id: project.project_id,
      purpose: '导出任务',
      done_when: ['条件', ''],
    }),
    /done_when 的每一项/,
  );
  assert.throws(
    () => createTask(db, { purpose: '导出任务', done_when: ['可检验'] }),
    /缺少必填字段：project_id/,
  );
  assert.throws(
    () => createTask(db, {
      project_id: 'prj_missing',
      purpose: '导出任务',
      done_when: ['可检验'],
    }),
    /项目不存在/,
  );
});

test('任务：创建后默认 draft，JSON 字段往返一致，可按条件过滤', () => {
  const { project, requirement } = seed();
  const task = createTask(db, {
    project_id: project.project_id,
    requirement_id: requirement.requirement_id,
    purpose: '实现任务导出',
    scope: '仅导出接口',
    non_scope: '不做导出调度',
    done_when: ['接口返回任务列表', '空项目返回空数组'],
    serves_item_ids: ['item_a'],
    acceptance_evidence: ['接口响应样例'],
    blocked_by: ['task_other'],
    created_by: 'alice',
  });

  assert.match(task.task_id, /^task_/);
  assert.equal(task.status, 'draft');
  assert.equal(task.project_id, project.project_id);
  assert.equal(task.requirement_id, requirement.requirement_id);
  assert.deepEqual(task.done_when, ['接口返回任务列表', '空项目返回空数组']);
  assert.deepEqual(task.serves_item_ids, ['item_a']);
  assert.deepEqual(task.acceptance_evidence, ['接口响应样例']);
  assert.deepEqual(task.blocked_by, ['task_other']);
  assert.equal(task.created_by, 'alice');

  const fetched = getTask(db, task.task_id);
  assert.deepEqual(fetched.done_when, task.done_when);
  assert.equal(getTask(db, 'task_missing'), null);

  assert.equal(listTasks(db, { projectId: project.project_id }).length, 1);
  assert.equal(listTasks(db, { status: 'draft' }).length, 1);
  assert.equal(listTasks(db, { status: 'open' }).length, 0);
  assert.equal(listTasks(db, { requirement_id: requirement.requirement_id }).length, 1);
  assert.equal(listTasks(db, { requirement_id: 'req_missing' }).length, 0);
  assert.throws(() => listTasks(db, { status: 'bogus' }), /非法的任务状态/);
});

test('任务：draft → open，非 draft 不能重复开放', () => {
  const { project } = seed();
  const task = createTask(db, {
    project_id: project.project_id,
    purpose: '开放演示',
    done_when: ['可被查询'],
  });

  const opened = openTask(db, task.task_id);
  assert.equal(opened.status, 'open');
  assert.equal(getTask(db, task.task_id).status, 'open');
  assert.throws(() => openTask(db, task.task_id), /不可开放/);
  assert.throws(() => openTask(db, 'task_missing'), /任务不存在/);
});

test('认领：原子互斥——连续两次只有一次成功，另一次 TASK_NOT_CLAIMABLE', () => {
  const { project } = seed();
  const task = openTask(db, createTask(db, {
    project_id: project.project_id,
    purpose: '并发认领',
    done_when: ['只有一人持有'],
  }).task_id);

  const first = claimTask(db, task.task_id, 'worker_a');
  assert.match(first.claim.claim_id, /^clm_/);
  assert.equal(first.claim.status, 'active');
  assert.equal(first.claim.worker_id, 'worker_a');
  assert.equal(first.task.status, 'claimed');
  assert.equal(getTask(db, task.task_id).status, 'claimed');

  assert.throws(
    () => claimTask(db, task.task_id, 'worker_b'),
    (error) => {
      assert.equal(error.code, 'TASK_NOT_CLAIMABLE');
      assert.equal(error.status, 409);
      assert.match(error.message, /任务已被认领或不可认领/);
      return true;
    },
  );

  // 冲突后状态不被破坏，仍归 worker_a。
  assert.equal(getTask(db, task.task_id).status, 'claimed');
  const claims = listClaims(db, task.task_id);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].worker_id, 'worker_a');
  assert.throws(() => claimTask(db, task.task_id), /缺少必填字段：worker_id/);
  assert.throws(() => claimTask(db, 'task_missing', 'worker_a'), /任务不存在/);
});

test('认领：非 open 任务（claimed）不能再认领', () => {
  const { project } = seed();
  const created = createTask(db, {
    project_id: project.project_id,
    purpose: '不可认领',
    done_when: ['状态校验'],
  });

  // draft 状态不可认领。
  assert.throws(() => claimTask(db, created.task_id, 'worker_a'), /TASK_NOT_CLAIMABLE|不可认领/);

  const opened = openTask(db, created.task_id);
  claimTask(db, opened.task_id, 'worker_a');
  assert.throws(() => claimTask(db, opened.task_id, 'worker_b'), /不可认领/);
});

test('释放：任务回 open 可再次被认领；非本人或非 active 抛错', () => {
  const { project } = seed();
  const task = openTask(db, createTask(db, {
    project_id: project.project_id,
    purpose: '释放演示',
    done_when: ['释放后可再认领'],
  }).task_id);

  claimTask(db, task.task_id, 'worker_a');

  // 非本人释放抛错，状态不变。
  assert.throws(() => releaseTask(db, task.task_id, 'worker_b'), /本人/);
  assert.equal(getTask(db, task.task_id).status, 'claimed');

  const released = releaseTask(db, task.task_id, 'worker_a');
  assert.equal(released.task.status, 'open');
  assert.equal(released.claim.status, 'released');
  assert.ok(released.claim.released_at);

  // 已无活跃认领，再释放抛错。
  assert.throws(() => releaseTask(db, task.task_id, 'worker_a'), /活跃认领/);

  // 释放后其他 worker 可认领。
  const second = claimTask(db, task.task_id, 'worker_b');
  assert.equal(second.claim.worker_id, 'worker_b');
  assert.equal(getTask(db, task.task_id).status, 'claimed');

  const claims = listClaims(db, task.task_id);
  assert.equal(claims.length, 2);
  assert.deepEqual(claims.map((c) => c.status), ['released', 'active']);

  assert.throws(() => releaseTask(db, 'task_missing', 'worker_a'), /任务不存在/);
  assert.throws(() => listClaims(db, 'task_missing'), /任务不存在/);
});

test('HTTP：批量拆解自动开放，claim 冲突返回 409 且带 code', async () => {
  const { project, requirement } = seed();
  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const created = await fetch(
      `${base}/requirements/${requirement.requirement_id}/tasks`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          created_by: 'alice',
          tasks: [
            { purpose: '任务一', done_when: ['可检验一'] },
            { purpose: '任务二', done_when: ['可检验二'] },
          ],
        }),
      },
    ).then((res) => res.json());

    assert.equal(created.length, 2);
    assert.ok(created.every((task) => task.status === 'open'));
    assert.ok(created.every((task) => task.project_id === project.project_id));

    const listed = await fetch(
      `${base}/tasks?project_id=${project.project_id}&status=open`,
    ).then((res) => res.json());
    assert.equal(listed.length, 2);

    const taskId = created[0].task_id;
    const first = await fetch(`${base}/tasks/${taskId}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ worker_id: 'worker_a' }),
    });
    assert.equal(first.status, 201);

    const conflict = await fetch(`${base}/tasks/${taskId}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ worker_id: 'worker_b' }),
    });
    assert.equal(conflict.status, 409);
    const payload = await conflict.json();
    assert.equal(payload.code, 'TASK_NOT_CLAIMABLE');
    assert.match(payload.error, /任务已被认领或不可认领/);

    const missing = await fetch(`${base}/tasks/task_missing`);
    assert.equal(missing.status, 404);

    const badRequest = await fetch(`${base}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ purpose: '缺少 done_when' }),
    });
    assert.equal(badRequest.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('事件：创建、开放、认领、释放都产生事件', () => {
  const { project, requirement } = seed();
  const task = openTask(db, createTask(db, {
    project_id: project.project_id,
    requirement_id: requirement.requirement_id,
    purpose: '事件演示',
    done_when: ['有完整事件链'],
    created_by: 'alice',
  }).task_id);

  claimTask(db, task.task_id, 'worker_a');
  releaseTask(db, task.task_id, 'worker_a');

  const types = listEvents(db, { projectId: project.project_id }).map((e) => e.event_type);
  for (const expected of ['task.created', 'task.updated', 'task.claimed', 'task.released']) {
    assert.ok(types.includes(expected), `缺少事件：${expected}`);
  }

  const claimed = listEvents(db, {
    projectId: project.project_id,
    object_id: task.task_id,
    event_type: 'task.claimed',
  });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].actor, 'worker_a');
});
