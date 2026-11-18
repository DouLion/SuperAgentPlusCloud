// Client 提交与评审命令测试（T4）：用 node:http 假 Center 验证
// deliver / review / show --task 的请求体与错误透出。
// 运行：node --test client/test/

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { api } from '../src/api.mjs';
import { run as runDeliver } from '../src/commands/deliver.mjs';
import { run as runReview } from '../src/commands/review.mjs';
import { run as runShow } from '../src/commands/show.mjs';

/**
 * 启动假 Center：维护任务、认领、提交、评审状态并记录请求。
 * 校验规则与真实 Center 保持一致（提交人须为活跃认领者、confirm 需条件结果、reject 需理由）。
 */
function startFakeCenter() {
  const state = {
    requests: [],
    seq: { submission: 2, review: 1 },
    tasks: [
      {
        task_id: 'task_a',
        project_id: 'prj_x',
        requirement_id: 'req_x',
        status: 'claimed',
        purpose: '实现导出',
        scope: null,
        non_scope: null,
        done_when: ['接口返回提交列表', '评审后任务状态正确'],
        serves_item_ids: [],
        acceptance_evidence: ['HTTP 响应样例'],
        blocked_by: [],
        created_by: 'alice',
      },
    ],
    claims: [
      {
        claim_id: 'clm_1',
        task_id: 'task_a',
        worker_id: 'worker_a',
        status: 'active',
        claimed_at: '2026-11-18T00:00:00.000Z',
        released_at: null,
      },
    ],
    submissions: [
      {
        submission_id: 'sub_1',
        task_id: 'task_a',
        claim_id: 'clm_1',
        commit_refs: [{ repo: 'sap-center', hash: 'abc123' }],
        summary: '首次提交',
        self_test: 'node --test 通过',
        known_gaps: [],
        artifacts: [],
        submitted_by: 'worker_a',
        submitted_at: '2026-11-18T01:00:00.000Z',
      },
    ],
    reviews: [],
    requirements: new Map(),
  };

  state.requirements.set('req_x', {
    requirement_id: 'req_x',
    project_id: 'prj_x',
    status: 'submitted',
    author: 'alice',
    raw_text: '希望支持导出',
    claimed_level: null,
    final_level: null,
    claimed_reason: null,
    source_ref: null,
    related_item_ids: [],
    attachments: [],
    created_at: '2026-11-18T00:00:00.000Z',
  });

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = {};
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = {};
        }
      }
      state.requests.push({ method: req.method, path: req.url, body });

      const send = (status, payload) => {
        const data = JSON.stringify(payload);
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(data);
      };

      let matched = url.pathname.match(/^\/tasks\/([^/]+)$/);
      if (req.method === 'GET' && matched) {
        const task = state.tasks.find((item) => item.task_id === matched[1]);
        if (!task) return send(404, { ok: false, error: `任务不存在：${matched[1]}` });
        return send(200, task);
      }

      matched = url.pathname.match(/^\/tasks\/([^/]+)\/submissions$/);
      if (req.method === 'GET' && matched) {
        return send(200, state.submissions.filter((item) => item.task_id === matched[1]));
      }
      if (req.method === 'POST' && matched) {
        const task = state.tasks.find((item) => item.task_id === matched[1]);
        if (!task) return send(404, { ok: false, error: `任务不存在：${matched[1]}` });
        if (!Array.isArray(body.commit_refs) || body.commit_refs.length === 0) {
          return send(400, { ok: false, error: '缺少必填字段：commit_refs（必须是非空数组）' });
        }
        if (!body.summary) {
          return send(400, { ok: false, error: '缺少必填字段：summary' });
        }
        const claim = state.claims.find(
          (item) => item.task_id === task.task_id && item.status === 'active',
        );
        if (!claim || claim.worker_id !== body.submitted_by) {
          return send(409, {
            ok: false,
            error: '只有当前活跃认领的认领者本人才能提交成果',
            code: 'SUBMISSION_NOT_ALLOWED',
          });
        }
        const submission = {
          submission_id: `sub_${state.seq.submission++}`,
          task_id: task.task_id,
          claim_id: claim.claim_id,
          commit_refs: body.commit_refs,
          summary: body.summary,
          self_test: body.self_test ?? null,
          known_gaps: body.known_gaps ?? [],
          artifacts: body.artifacts ?? [],
          submitted_by: body.submitted_by,
          submitted_at: '2026-11-18T02:00:00.000Z',
        };
        state.submissions.push(submission);
        task.status = 'submitted';
        return send(201, submission);
      }

      matched = url.pathname.match(/^\/submissions\/([^/]+)\/review$/);
      if (req.method === 'POST' && matched) {
        const submission = state.submissions.find(
          (item) => item.submission_id === matched[1],
        );
        if (!submission) {
          return send(404, { ok: false, error: `提交不存在：${matched[1]}` });
        }
        if (!['confirm', 'reject', 'needs_info'].includes(body.conclusion)) {
          return send(400, { ok: false, error: `非法的评审结论：${body.conclusion}` });
        }
        if (body.conclusion === 'confirm') {
          if (!Array.isArray(body.criterion_results) || body.criterion_results.length === 0) {
            return send(400, {
              ok: false,
              error: '结论为 confirm 时必须提供非空的 criterion_results',
            });
          }
        }
        if (body.conclusion === 'reject' && !body.reason) {
          return send(400, { ok: false, error: '结论为 reject 时必须提供 reason' });
        }
        const task = state.tasks.find((item) => item.task_id === submission.task_id);
        const review = {
          review_id: `rev_${state.seq.review++}`,
          submission_id: submission.submission_id,
          reviewer_id: body.reviewer_id,
          conclusion: body.conclusion,
          criterion_results: body.criterion_results ?? [],
          reason: body.reason ?? null,
          self_review: body.reviewer_id === submission.submitted_by ? 1 : 0,
          reviewed_at: '2026-11-18T03:00:00.000Z',
        };
        state.reviews.push(review);

        if (body.conclusion === 'confirm') {
          task.status = 'accepted';
        } else if (body.conclusion === 'reject') {
          task.status = 'rework';
          const claim = state.claims.find(
            (item) => item.task_id === task.task_id && item.status === 'active',
          );
          if (claim) {
            claim.status = 'released';
            claim.released_at = '2026-11-18T03:00:00.000Z';
          }
        }
        return send(201, review);
      }

      matched = url.pathname.match(/^\/submissions\/([^/]+)\/reviews$/);
      if (req.method === 'GET' && matched) {
        return send(200, state.reviews.filter((item) => item.submission_id === matched[1]));
      }

      matched = url.pathname.match(/^\/submissions\/([^/]+)$/);
      if (req.method === 'GET' && matched) {
        const submission = state.submissions.find(
          (item) => item.submission_id === matched[1],
        );
        if (!submission) {
          return send(404, { ok: false, error: `提交不存在：${matched[1]}` });
        }
        return send(200, submission);
      }

      matched = url.pathname.match(/^\/tasks\/([^/]+)\/claims$/);
      if (req.method === 'GET' && matched) {
        return send(200, state.claims.filter((item) => item.task_id === matched[1]));
      }

      matched = url.pathname.match(/^\/requirements\/([^/]+)\/timeline$/);
      if (req.method === 'GET' && matched) return send(200, []);
      matched = url.pathname.match(/^\/requirements\/([^/]+)\/assessments$/);
      if (req.method === 'GET' && matched) return send(200, []);
      matched = url.pathname.match(/^\/requirements\/([^/]+)\/decisions$/);
      if (req.method === 'GET' && matched) return send(200, []);
      matched = url.pathname.match(/^\/requirements\/([^/]+)$/);
      if (req.method === 'GET' && matched) {
        const requirement = state.requirements.get(matched[1]);
        if (!requirement) {
          return send(404, { ok: false, error: `需求不存在：${matched[1]}` });
        }
        return send(200, requirement);
      }

      return send(404, { ok: false, error: 'not_found' });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        url: `http://127.0.0.1:${server.address().port}`,
        state,
        async close() {
          await new Promise((done) => server.close(done));
        },
      });
    });
  });
}

test('api：提交与评审的请求路径、请求体与返回', async () => {
  const fake = await startFakeCenter();
  try {
    const options = { url: fake.url };

    const created = await api.createSubmission('task_a', {
      commit_refs: ['sap-center@abc123'],
      summary: 'API 提交',
      submitted_by: 'worker_a',
    }, options);
    assert.match(created.submission_id, /^sub_/);
    assert.equal(created.task_id, 'task_a');

    const list = await api.listSubmissions('task_a', options);
    assert.equal(list.length, 2);

    const fetched = await api.getSubmission(created.submission_id, options);
    assert.equal(fetched.summary, 'API 提交');

    const review = await api.createReview(created.submission_id, {
      reviewer_id: 'reviewer_a',
      conclusion: 'confirm',
      criterion_results: [
        { criterion: '接口返回提交列表', result: '通过', evidence: 'HTTP 201' },
      ],
    }, options);
    assert.equal(review.conclusion, 'confirm');
    assert.equal(review.self_review, 0);

    const reviews = await api.listReviews(created.submission_id, options);
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].review_id, review.review_id);

    assert.deepEqual(
      fake.state.requests.map((item) => `${item.method} ${item.path}`),
      [
        'POST /tasks/task_a/submissions',
        'GET /tasks/task_a/submissions',
        'GET /submissions/sub_2',
        'POST /submissions/sub_2/review',
        'GET /submissions/sub_2/reviews',
      ],
    );
    assert.equal(fake.state.requests[0].body.submitted_by, 'worker_a');
  } finally {
    await fake.close();
  }
});

test('命令：deliver 组装 commit 引用、自测与缺口并输出提交结果', async () => {
  const fake = await startFakeCenter();
  process.env.CENTER_URL = fake.url;

  const lines = [];
  const errors = [];
  const io = { stdout: (line) => lines.push(line), stderr: (line) => errors.push(line) };

  try {
    const code = await runDeliver([
      '--task', 'task_a',
      '--worker', 'worker_a',
      '--commit', 'sap-center@abc123',
      '--commit=sap-client@def456',
      '--summary', '完成导出功能',
      '--self-test', 'node --test 通过',
      '--gap', 'Windows 路径未覆盖',
    ], io);

    assert.equal(code, 0);
    assert.ok(lines.some((line) => line.includes('提交已登记')));
    assert.ok(lines.some((line) => line.includes('sap-center@abc123')));
    assert.ok(lines.some((line) => line.includes('完成导出功能')));

    const request = fake.state.requests[fake.state.requests.length - 1];
    assert.equal(request.method, 'POST');
    assert.equal(request.path, '/tasks/task_a/submissions');
    assert.deepEqual(request.body.commit_refs, [
      { repo: 'sap-center', hash: 'abc123' },
      { repo: 'sap-client', hash: 'def456' },
    ]);
    assert.equal(request.body.submitted_by, 'worker_a');
    assert.equal(request.body.summary, '完成导出功能');
    assert.equal(request.body.self_test, 'node --test 通过');
    assert.deepEqual(request.body.known_gaps, ['Windows 路径未覆盖']);
    assert.equal(errors.length, 0);
  } finally {
    delete process.env.CENTER_URL;
    await fake.close();
  }
});

test('命令：deliver 缺少 --commit 或格式错误时返回 1 并给出中文提示', async () => {
  const fake = await startFakeCenter();
  process.env.CENTER_URL = fake.url;
  const errors = [];
  const io = { stdout: () => {}, stderr: (line) => errors.push(line) };

  try {
    assert.equal(await runDeliver(['--task', 'task_a', '--worker', 'worker_a'], io), 1);
    assert.ok(errors.some((line) => line.includes('--commit')));
    assert.ok(errors.some((line) => line.includes('repo@hash')));

    errors.length = 0;
    assert.equal(await runDeliver([
      '--task', 'task_a',
      '--worker', 'worker_a',
      '--commit', '缺少分隔符',
    ], io), 1);
    assert.ok(errors.some((line) => line.includes('repo@hash')));
  } finally {
    delete process.env.CENTER_URL;
    await fake.close();
  }
});

test('命令：deliver 服务端 SUBMISSION_NOT_ALLOWED 原样透出', async () => {
  const fake = await startFakeCenter();
  process.env.CENTER_URL = fake.url;
  const errors = [];
  const io = { stdout: () => {}, stderr: (line) => errors.push(line) };

  try {
    const code = await runDeliver([
      '--task', 'task_a',
      '--worker', 'worker_b',
      '--commit', 'sap-center@abc123',
    ], io);

    assert.equal(code, 1);
    assert.ok(errors.some((line) => line.includes('只有当前活跃认领的认领者本人才能提交成果')));
    assert.ok(errors.some((line) => line.includes('409')));
  } finally {
    delete process.env.CENTER_URL;
    await fake.close();
  }
});

test('命令：review 解析 "条件=结果" 并提交逐项结果', async () => {
  const fake = await startFakeCenter();
  process.env.CENTER_URL = fake.url;

  const lines = [];
  const errors = [];
  const io = { stdout: (line) => lines.push(line), stderr: (line) => errors.push(line) };

  try {
    const code = await runReview([
      '--submission', 'sub_1',
      '--reviewer', 'reviewer_a',
      '--conclusion', 'confirm',
      '--criterion', '接口返回提交列表=通过',
      '--criterion=评审后任务状态正确=通过',
    ], io);

    assert.equal(code, 0);
    assert.ok(lines.some((line) => line.includes('评审已记录')));
    assert.ok(lines.some((line) => line.includes('confirm')));
    assert.ok(lines.some((line) => line.includes('自审：否')));

    const request = fake.state.requests[fake.state.requests.length - 1];
    assert.equal(request.method, 'POST');
    assert.equal(request.path, '/submissions/sub_1/review');
    assert.deepEqual(request.body.criterion_results, [
      {
        criterion: '接口返回提交列表',
        result: '通过',
        evidence: 'CLI 未提供独立证据',
      },
      {
        criterion: '评审后任务状态正确',
        result: '通过',
        evidence: 'CLI 未提供独立证据',
      },
    ]);
    assert.equal(request.body.reviewer_id, 'reviewer_a');
    assert.equal(errors.length, 0);
  } finally {
    delete process.env.CENTER_URL;
    await fake.close();
  }
});

test('命令：review 缺 criterion / reason 或结论非法时返回 1 并非零退出', async () => {
  const fake = await startFakeCenter();
  process.env.CENTER_URL = fake.url;
  const errors = [];
  const io = { stdout: () => {}, stderr: (line) => errors.push(line) };

  try {
    errors.length = 0;
    assert.equal(await runReview([
      '--submission', 'sub_1',
      '--reviewer', 'reviewer_a',
      '--conclusion', 'confirm',
    ], io), 1);
    assert.ok(errors.some((line) => line.includes('confirm 时必须提供至少一个 --criterion')));

    errors.length = 0;
    assert.equal(await runReview([
      '--submission', 'sub_1',
      '--reviewer', 'reviewer_a',
      '--conclusion', 'reject',
    ], io), 1);
    assert.ok(errors.some((line) => line.includes('reject 时必须提供 --reason')));

    errors.length = 0;
    assert.equal(await runReview([
      '--submission', 'sub_1',
      '--reviewer', 'reviewer_a',
      '--conclusion', 'approved',
    ], io), 1);
    assert.ok(errors.some((line) => line.includes('--conclusion 只能是')));

    errors.length = 0;
    assert.equal(await runReview([
      '--submission', 'sub_1',
      '--reviewer', 'reviewer_a',
      '--conclusion', 'needs_info',
      '--criterion', '缺少等号',
    ], io), 1);
    assert.ok(errors.some((line) => line.includes('条件=结果')));
  } finally {
    delete process.env.CENTER_URL;
    await fake.close();
  }
});

test('命令：review 服务端错误（提交不存在）原样透出', async () => {
  const fake = await startFakeCenter();
  process.env.CENTER_URL = fake.url;
  const errors = [];
  const io = { stdout: () => {}, stderr: (line) => errors.push(line) };

  try {
    const code = await runReview([
      '--submission', 'sub_missing',
      '--reviewer', 'reviewer_a',
      '--conclusion', 'needs_info',
    ], io);
    assert.equal(code, 1);
    assert.ok(errors.some((line) => line.includes('提交不存在：sub_missing')));
  } finally {
    delete process.env.CENTER_URL;
    await fake.close();
  }
});

test('命令：show --task 打印任务、认领、提交与评审全链', async () => {
  const fake = await startFakeCenter();
  process.env.CENTER_URL = fake.url;

  const lines = [];
  const errors = [];
  const io = { stdout: (line) => lines.push(line), stderr: (line) => errors.push(line) };

  try {
    const code = await runShow(['--task', 'task_a'], io);
    assert.equal(code, 0);
    assert.ok(lines.some((line) => line.includes('任务 task_a')));
    assert.ok(lines.some((line) => line.includes('实现导出')));
    assert.ok(lines.some((line) => line.includes('认领（1）')));
    assert.ok(lines.some((line) => line.includes('clm_1')));
    assert.ok(lines.some((line) => line.includes('提交（1）')));
    assert.ok(lines.some((line) => line.includes('sub_1')));
    assert.ok(lines.some((line) => line.includes('sap-center@abc123')));
    assert.ok(lines.some((line) => line.includes('评审（0）')));
    assert.equal(errors.length, 0);

    // 参数校验：二者缺一不可，且不能同时给出。
    errors.length = 0;
    assert.equal(await runShow([], io), 1);
    assert.ok(errors.some((line) => line.includes('--requirement')));

    errors.length = 0;
    assert.equal(await runShow(['--task', 'task_a', '--requirement', 'req_x'], io), 1);
    assert.ok(errors.some((line) => line.includes('不能同时使用')));
  } finally {
    delete process.env.CENTER_URL;
    await fake.close();
  }
});

test('命令：show --requirement 保持原有行为', async () => {
  const fake = await startFakeCenter();
  process.env.CENTER_URL = fake.url;

  const lines = [];
  const io = { stdout: (line) => lines.push(line), stderr: () => {} };

  try {
    const code = await runShow(['--requirement', 'req_x'], io);
    assert.equal(code, 0);
    assert.ok(lines.some((line) => line.includes('需求 req_x')));
    assert.ok(lines.some((line) => line.includes('希望支持导出')));
  } finally {
    delete process.env.CENTER_URL;
    await fake.close();
  }
});
