// Center 提交与评审测试（T4）。
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
  openTask,
  claimTask,
  releaseTask,
  listClaims,
  createSubmission,
  getSubmission,
  listSubmissions,
  createReview,
  listReviews,
  listEvents,
} from '../src/store.mjs';
import { createServer } from '../src/server.mjs';

const dbPath = path.join(
  os.tmpdir(),
  `sap-center-submission-test-${process.pid}-${Date.now()}.db`,
);

let db;

test.before(() => {
  db = openStore(dbPath);
});

test.after(() => {
  db.close();
  fs.rmSync(dbPath, { force: true });
});

/** 建项目与需求，返回 { project, requirement }。 */
function seed() {
  const project = createProject(db, { name: 'T4 提交评审项目' });
  const requirement = createRequirement(db, {
    project_id: project.project_id,
    raw_text: '希望登记提交并按完成条件评审',
    author: 'alice',
  });
  return { project, requirement };
}

/** 建任务并开放，返回任务行。 */
function seedOpenTask() {
  const { project, requirement } = seed();
  const task = openTask(db, createTask(db, {
    project_id: project.project_id,
    requirement_id: requirement.requirement_id,
    purpose: '实现提交与评审',
    done_when: ['接口返回提交列表', '评审后任务状态正确'],
    created_by: 'alice',
  }).task_id);
  return task;
}

/** 建任务、开放并由 worker 认领，返回 { task, claim, project }。 */
function seedClaimedTask(workerId = 'worker_a') {
  const { project } = seed();
  const task = openTask(db, createTask(db, {
    project_id: project.project_id,
    purpose: '实现提交与评审',
    done_when: ['接口返回提交列表', '评审后任务状态正确'],
    created_by: 'alice',
  }).task_id);
  const claimed = claimTask(db, task.task_id, workerId);
  return { project, task: claimed.task, claim: claimed.claim };
}

/** 以提交者身份登记一次提交。 */
function submit(taskId, submittedBy = 'worker_a', extra = {}) {
  return createSubmission(db, {
    task_id: taskId,
    commit_refs: ['sap@abc123'],
    summary: '完成提交',
    submitted_by: submittedBy,
    ...extra,
  });
}

test('提交：必填字段与 commit_refs 校验', () => {
  const { task } = seedClaimedTask('worker_a');

  assert.throws(
    () => createSubmission(db, {
      commit_refs: ['sap@abc123'],
      summary: '完成',
      submitted_by: 'worker_a',
    }),
    /缺少必填字段：task_id/,
  );
  assert.throws(
    () => createSubmission(db, {
      task_id: task.task_id,
      summary: '完成',
      submitted_by: 'worker_a',
    }),
    /缺少必填字段：commit_refs/,
  );
  assert.throws(
    () => createSubmission(db, {
      task_id: task.task_id,
      commit_refs: [],
      summary: '完成',
      submitted_by: 'worker_a',
    }),
    /commit_refs（必须是非空数组）/,
  );
  assert.throws(
    () => createSubmission(db, {
      task_id: task.task_id,
      commit_refs: [''],
      summary: '完成',
      submitted_by: 'worker_a',
    }),
    /commit_refs 第 1 项/,
  );
  assert.throws(
    () => createSubmission(db, {
      task_id: task.task_id,
      commit_refs: [{ note: '缺少仓库与哈希' }],
      summary: '完成',
      submitted_by: 'worker_a',
    }),
    /commit_refs 第 1 项必须包含 repo\/branch\/hash/,
  );
  assert.throws(
    () => createSubmission(db, {
      task_id: task.task_id,
      commit_refs: ['sap@abc123'],
      submitted_by: 'worker_a',
    }),
    /缺少必填字段：summary/,
  );
  assert.throws(
    () => createSubmission(db, {
      task_id: task.task_id,
      commit_refs: ['sap@abc123'],
      summary: '完成',
    }),
    /缺少必填字段：submitted_by/,
  );
  assert.throws(
    () => createSubmission(db, {
      task_id: 'task_missing',
      commit_refs: ['sap@abc123'],
      summary: '完成',
      submitted_by: 'worker_a',
    }),
    /任务不存在：task_missing/,
  );

  // 校验失败不改变任务状态，也不产生提交记录。
  assert.equal(getTask(db, task.task_id).status, 'claimed');
  assert.equal(listSubmissions(db, { task_id: task.task_id }).length, 0);
});

test('提交：非认领人或无 active 认领一律 SUBMISSION_NOT_ALLOWED', () => {
  // 场景一：他人认领中。
  const claimed = seedClaimedTask('worker_a');
  assert.throws(
    () => submit(claimed.task.task_id, 'worker_b'),
    (error) => {
      assert.equal(error.code, 'SUBMISSION_NOT_ALLOWED');
      assert.equal(error.status, 409);
      assert.match(error.message, /认领者本人/);
      return true;
    },
  );
  assert.equal(getTask(db, claimed.task.task_id).status, 'claimed');

  // 场景二：任务已开放但无人认领。
  const open = seedOpenTask();
  assert.throws(
    () => submit(open.task_id, 'worker_a'),
    (error) => {
      assert.equal(error.code, 'SUBMISSION_NOT_ALLOWED');
      return true;
    },
  );
  assert.equal(getTask(db, open.task_id).status, 'open');

  // 场景三：认领已释放，活跃认领不存在。
  const released = seedClaimedTask('worker_a');
  releaseTask(db, released.task.task_id, 'worker_a');
  assert.throws(
    () => submit(released.task.task_id, 'worker_a'),
    (error) => {
      assert.equal(error.code, 'SUBMISSION_NOT_ALLOWED');
      return true;
    },
  );
});

test('提交：任务置 submitted，重复提交生成两条记录且 JSON 字段往返', () => {
  const { task, claim } = seedClaimedTask('worker_a');

  const first = createSubmission(db, {
    task_id: task.task_id,
    commit_refs: [
      { repo: 'sap-center', branch: 'main', hash: 'abc123' },
      'sap-client@def456',
    ],
    summary: '首次提交',
    self_test: 'node --test center/test/ 通过',
    known_gaps: ['未覆盖 Windows 路径'],
    artifacts: ['test-report.txt'],
    submitted_by: 'worker_a',
  });
  assert.match(first.submission_id, /^sub_/);
  assert.equal(first.claim_id, claim.claim_id);
  assert.deepEqual(first.commit_refs, [
    { repo: 'sap-center', branch: 'main', hash: 'abc123' },
    'sap-client@def456',
  ]);
  assert.deepEqual(first.known_gaps, ['未覆盖 Windows 路径']);
  assert.deepEqual(first.artifacts, ['test-report.txt']);
  assert.equal(getTask(db, task.task_id).status, 'submitted');
  assert.equal(getSubmission(db, first.submission_id).summary, '首次提交');

  const second = submit(task.task_id, 'worker_a', { summary: '补充提交' });
  assert.notEqual(second.submission_id, first.submission_id);

  const list = listSubmissions(db, { task_id: task.task_id });
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((item) => item.summary), ['首次提交', '补充提交']);
  assert.equal(listSubmissions(db, { task_id: 'task_missing' }).length, 0);
});

test('评审：confirm 缺 criterion_results 抛错；带条件结果任务 accepted', () => {
  const { task } = seedClaimedTask('worker_a');
  const submission = submit(task.task_id);

  assert.throws(
    () => createReview(db, {
      submission_id: submission.submission_id,
      reviewer_id: 'reviewer_a',
      conclusion: 'confirm',
    }),
    /confirm 时必须提供非空的 criterion_results/,
  );
  assert.throws(
    () => createReview(db, {
      submission_id: submission.submission_id,
      reviewer_id: 'reviewer_a',
      conclusion: 'confirm',
      criterion_results: [],
    }),
    /confirm 时必须提供非空的 criterion_results/,
  );
  assert.throws(
    () => createReview(db, {
      submission_id: submission.submission_id,
      reviewer_id: 'reviewer_a',
      conclusion: 'confirm',
      criterion_results: [{ criterion: '接口返回提交列表' }],
    }),
    /缺少 result/,
  );
  // 校验失败不改变任务状态。
  assert.equal(getTask(db, task.task_id).status, 'submitted');

  const review = createReview(db, {
    submission_id: submission.submission_id,
    reviewer_id: 'reviewer_a',
    conclusion: 'confirm',
    criterion_results: [
      { criterion: '接口返回提交列表', result: '通过', evidence: 'HTTP 200' },
      { criterion: '评审后任务状态正确', result: '通过', evidence: '状态为 accepted' },
    ],
  });
  assert.match(review.review_id, /^rev_/);
  assert.equal(review.conclusion, 'confirm');
  assert.equal(review.self_review, 0);
  assert.equal(review.criterion_results.length, 2);
  assert.equal(getTask(db, task.task_id).status, 'accepted');
  assert.equal(listReviews(db, submission.submission_id).length, 1);
});

test('评审：reject 缺 reason 抛错；带理由任务 rework、原认领释放且可重新认领', () => {
  const { task, claim } = seedClaimedTask('worker_a');
  const submission = submit(task.task_id);

  assert.throws(
    () => createReview(db, {
      submission_id: submission.submission_id,
      reviewer_id: 'reviewer_a',
      conclusion: 'reject',
    }),
    /reject 时必须提供 reason/,
  );
  assert.equal(getTask(db, task.task_id).status, 'submitted');

  const review = createReview(db, {
    submission_id: submission.submission_id,
    reviewer_id: 'reviewer_a',
    conclusion: 'reject',
    reason: '缺少自测证据与完成条件对照',
    criterion_results: [
      { criterion: '接口返回提交列表', result: '未验证', evidence: '无' },
    ],
  });
  assert.equal(review.conclusion, 'reject');
  assert.equal(review.reason, '缺少自测证据与完成条件对照');
  assert.equal(getTask(db, task.task_id).status, 'rework');

  const claims = listClaims(db, task.task_id);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].claim_id, claim.claim_id);
  assert.equal(claims[0].status, 'released');
  assert.ok(claims[0].released_at);

  // 打回后任务可被其他工作者重新认领。
  const reclaimed = claimTask(db, task.task_id, 'worker_b');
  assert.equal(reclaimed.claim.worker_id, 'worker_b');
  assert.equal(reclaimed.claim.status, 'active');
  assert.equal(getTask(db, task.task_id).status, 'claimed');
  assert.deepEqual(
    listClaims(db, task.task_id).map((item) => item.status),
    ['released', 'active'],
  );
});

test('评审：needs_info 任务保持 submitted', () => {
  const { task } = seedClaimedTask('worker_a');
  const submission = submit(task.task_id);

  const review = createReview(db, {
    submission_id: submission.submission_id,
    reviewer_id: 'reviewer_a',
    conclusion: 'needs_info',
    reason: '请补充测试报告',
  });
  assert.equal(review.conclusion, 'needs_info');
  assert.equal(getTask(db, task.task_id).status, 'submitted');
  assert.equal(listClaims(db, task.task_id)[0].status, 'active');
});

test('评审：自审自动标记 self_review=1（缺省与显式 false 都按自动判定）', () => {
  const { task } = seedClaimedTask('worker_a');
  const submission = submit(task.task_id);

  const selfReview = createReview(db, {
    submission_id: submission.submission_id,
    reviewer_id: 'worker_a',
    conclusion: 'needs_info',
  });
  assert.equal(selfReview.self_review, 1);

  const forced = createReview(db, {
    submission_id: submission.submission_id,
    reviewer_id: 'worker_a',
    conclusion: 'needs_info',
    self_review: false,
  });
  assert.equal(forced.self_review, 1);

  const other = createReview(db, {
    submission_id: submission.submission_id,
    reviewer_id: 'reviewer_b',
    conclusion: 'needs_info',
  });
  assert.equal(other.self_review, 0);
});

test('评审：非法结论、不存在提交抛错', () => {
  const { task } = seedClaimedTask('worker_a');
  const submission = submit(task.task_id);

  assert.throws(
    () => createReview(db, {
      submission_id: submission.submission_id,
      reviewer_id: 'reviewer_a',
      conclusion: 'approved',
    }),
    /非法的评审结论：approved/,
  );
  assert.throws(
    () => createReview(db, {
      submission_id: 'sub_missing',
      reviewer_id: 'reviewer_a',
      conclusion: 'confirm',
      criterion_results: [{ criterion: '条件', result: '通过', evidence: '无' }],
    }),
    /提交不存在：sub_missing/,
  );
  assert.throws(() => listReviews(db, 'sub_missing'), /提交不存在：sub_missing/);
  assert.throws(
    () => createReview(db, {
      submission_id: submission.submission_id,
      conclusion: 'needs_info',
    }),
    /缺少必填字段：reviewer_id/,
  );
});

test('事件：提交与各评审结论都写入事件', () => {
  const { project } = seed();
  const makeTask = () => openTask(db, createTask(db, {
    project_id: project.project_id,
    purpose: '事件演示',
    done_when: ['有完整事件链'],
    created_by: 'alice',
  }).task_id);

  const confirmed = claimTask(db, makeTask().task_id, 'worker_a');
  const confirmedSub = submit(confirmed.task.task_id);
  createReview(db, {
    submission_id: confirmedSub.submission_id,
    reviewer_id: 'reviewer_a',
    conclusion: 'confirm',
    criterion_results: [{ criterion: '条件一', result: '通过', evidence: '无' }],
  });

  const rejected = claimTask(db, makeTask().task_id, 'worker_a');
  const rejectedSub = submit(rejected.task.task_id);
  createReview(db, {
    submission_id: rejectedSub.submission_id,
    reviewer_id: 'reviewer_a',
    conclusion: 'reject',
    reason: '证据不足',
  });

  const waiting = claimTask(db, makeTask().task_id, 'worker_a');
  const waitingSub = submit(waiting.task.task_id);
  createReview(db, {
    submission_id: waitingSub.submission_id,
    reviewer_id: 'reviewer_a',
    conclusion: 'needs_info',
    reason: '待补充',
  });

  const types = listEvents(db, { project_id: project.project_id }).map(
    (event) => event.event_type,
  );
  for (const expected of [
    'submission.created',
    'review.confirmed',
    'review.rejected',
    'review.needs_info',
    'task.released',
  ]) {
    assert.ok(types.includes(expected), `缺少事件：${expected}`);
  }

  const submissionEvent = listEvents(db, {
    project_id: project.project_id,
    object_type: 'submission',
    object_id: confirmedSub.submission_id,
  })[0];
  assert.equal(submissionEvent.event_type, 'submission.created');
  assert.equal(submissionEvent.actor, 'worker_a');
  assert.deepEqual(submissionEvent.refs, [confirmed.task.task_id]);

  const reviewEvent = listEvents(db, {
    project_id: project.project_id,
    object_type: 'review',
    event_type: 'review.confirmed',
  })[0];
  assert.deepEqual(reviewEvent.refs, [confirmedSub.submission_id, confirmed.task.task_id]);

  const releasedEvent = listEvents(db, {
    project_id: project.project_id,
    event_type: 'task.released',
  })[0];
  assert.equal(releasedEvent.actor, 'reviewer_a');
  assert.match(releasedEvent.reason, /证据不足/);
});

test('HTTP：提交与评审路由、状态码与错误映射', async () => {
  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const { project } = seed();
    const created = await fetch(`${base}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: project.project_id,
        purpose: 'HTTP 提交评审',
        done_when: ['接口返回提交', '评审后状态正确'],
        created_by: 'alice',
      }),
    }).then((res) => res.json());
    const taskId = created.task_id;

    // 不存在的资源 → 404。
    const missing = await fetch(`${base}/submissions/sub_missing`);
    assert.equal(missing.status, 404);
    assert.match((await missing.json()).error, /提交不存在/);

    const missingTask = await fetch(`${base}/tasks/task_missing/submissions`);
    assert.equal(missingTask.status, 404);

    // 缺字段 → 400。
    const badRequest = await fetch(`${base}/tasks/${taskId}/submissions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ summary: '缺少 commit_refs', submitted_by: 'worker_a' }),
    });
    assert.equal(badRequest.status, 400);

    // 无认领 → 409 SUBMISSION_NOT_ALLOWED。
    const forbidden = await fetch(`${base}/tasks/${taskId}/submissions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commit_refs: ['sap@abc123'],
        summary: '完成',
        submitted_by: 'worker_a',
      }),
    });
    assert.equal(forbidden.status, 409);
    const forbiddenBody = await forbidden.json();
    assert.equal(forbiddenBody.code, 'SUBMISSION_NOT_ALLOWED');

    // 认领 → 提交 → 查询。
    await fetch(`${base}/tasks/${taskId}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ worker_id: 'worker_a' }),
    });

    const delivered = await fetch(`${base}/tasks/${taskId}/submissions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commit_refs: [{ repo: 'sap-center', hash: 'abc123' }],
        summary: 'HTTP 提交',
        self_test: 'node --test',
        known_gaps: ['暂无'],
        submitted_by: 'worker_a',
      }),
    });
    assert.equal(delivered.status, 201);
    const submission = await delivered.json();
    assert.equal(submission.task_id, taskId);

    const task = await fetch(`${base}/tasks/${taskId}`).then((res) => res.json());
    assert.equal(task.status, 'submitted');

    const list = await fetch(`${base}/tasks/${taskId}/submissions`).then((res) => res.json());
    assert.equal(list.length, 1);
    assert.deepEqual(list[0].commit_refs, [{ repo: 'sap-center', hash: 'abc123' }]);

    const fetched = await fetch(`${base}/submissions/${submission.submission_id}`);
    assert.equal(fetched.status, 200);

    // confirm 缺 criterion_results → 400。
    const badReview = await fetch(`${base}/submissions/${submission.submission_id}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reviewer_id: 'reviewer_a', conclusion: 'confirm' }),
    });
    assert.equal(badReview.status, 400);

    const reviewed = await fetch(`${base}/submissions/${submission.submission_id}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reviewer_id: 'reviewer_a',
        conclusion: 'confirm',
        criterion_results: [
          { criterion: '接口返回提交', result: '通过', evidence: 'HTTP 201' },
          { criterion: '评审后状态正确', result: '通过', evidence: '状态为 accepted' },
        ],
      }),
    });
    assert.equal(reviewed.status, 201);
    const review = await reviewed.json();
    assert.equal(review.conclusion, 'confirm');
    assert.equal(review.self_review, 0);

    const accepted = await fetch(`${base}/tasks/${taskId}`).then((res) => res.json());
    assert.equal(accepted.status, 'accepted');

    const reviews = await fetch(
      `${base}/submissions/${submission.submission_id}/reviews`,
    ).then((res) => res.json());
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].review_id, review.review_id);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('HTTP：rework 后可通过 HTTP 重新认领并再次提交', async () => {
  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const { project } = seed();
    const task = await fetch(`${base}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: project.project_id,
        purpose: '打回后重新认领',
        done_when: ['可再次提交'],
      }),
    }).then((res) => res.json());

    const post = (path, body) => fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    await post(`/tasks/${task.task_id}/claim`, { worker_id: 'worker_a' });
    const submitted = await post(`/tasks/${task.task_id}/submissions`, {
      commit_refs: ['sap@aaa'],
      summary: '第一次',
      submitted_by: 'worker_a',
    }).then((res) => res.json());

    const rejected = await post(`/submissions/${submitted.submission_id}/review`, {
      reviewer_id: 'reviewer_a',
      conclusion: 'reject',
      reason: '证据不足',
    });
    assert.equal(rejected.status, 201);
    assert.equal((await fetch(`${base}/tasks/${task.task_id}`).then((res) => res.json())).status, 'rework');

    const reclaimed = await post(`/tasks/${task.task_id}/claim`, { worker_id: 'worker_b' });
    assert.equal(reclaimed.status, 201);

    const resubmitted = await post(`/tasks/${task.task_id}/submissions`, {
      commit_refs: ['sap@bbb'],
      summary: '第二次',
      submitted_by: 'worker_b',
    });
    assert.equal(resubmitted.status, 201);

    const list = await fetch(`${base}/tasks/${task.task_id}/submissions`).then((res) => res.json());
    assert.equal(list.length, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
