// Client 任务与认领测试（T3）：用 node:http 假 Center 验证
// tasks / claim / release 的请求路径、参数与错误透出。
// 运行：node --test client/test/

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { api } from '../src/api.mjs';
import { run as runTasks } from '../src/commands/tasks.mjs';
import { run as runClaim } from '../src/commands/claim.mjs';
import { run as runRelease } from '../src/commands/release.mjs';

/** 启动假 Center：记录请求，任务认领状态在内存中维护。 */
function startFakeCenter() {
  const state = {
    requests: [],
    claimSeq: 1,
    tasks: [
      {
        task_id: 'task_a',
        project_id: 'prj_x',
        status: 'open',
        purpose: '实现导出',
        done_when: ['接口返回任务列表'],
        serves_item_ids: [],
        acceptance_evidence: [],
        blocked_by: [],
        scope: null,
        non_scope: null,
        requirement_id: null,
      },
      {
        task_id: 'task_b',
        project_id: 'prj_x',
        status: 'claimed',
        purpose: '编写测试',
        done_when: ['测试通过'],
        serves_item_ids: [],
        acceptance_evidence: [],
        blocked_by: [],
        scope: null,
        non_scope: null,
        requirement_id: null,
      },
    ],
    claims: [
      {
        claim_id: 'clm_0',
        task_id: 'task_b',
        worker_id: 'worker_a',
        status: 'active',
        claimed_at: '2026-11-18T00:00:00.000Z',
        released_at: null,
      },
    ],
  };

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

      let matched = url.pathname.match(/^\/tasks$/);
      if (req.method === 'GET' && matched) {
        let tasks = state.tasks;
        if (url.searchParams.get('project_id')) {
          tasks = tasks.filter((t) => t.project_id === url.searchParams.get('project_id'));
        }
        if (url.searchParams.get('status')) {
          tasks = tasks.filter((t) => t.status === url.searchParams.get('status'));
        }
        if (url.searchParams.get('requirement_id')) {
          tasks = tasks.filter(
            (t) => t.requirement_id === url.searchParams.get('requirement_id'),
          );
        }
        return send(200, tasks);
      }

      matched = url.pathname.match(/^\/tasks\/([^/]+)\/claim$/);
      if (req.method === 'POST' && matched) {
        const task = state.tasks.find((t) => t.task_id === matched[1]);
        if (!task) return send(404, { ok: false, error: `任务不存在：${matched[1]}` });
        if (task.status !== 'open') {
          return send(409, {
            ok: false,
            error: '任务已被认领或不可认领',
            code: 'TASK_NOT_CLAIMABLE',
          });
        }
        task.status = 'claimed';
        const claim = {
          claim_id: `clm_${state.claimSeq++}`,
          task_id: task.task_id,
          worker_id: body.worker_id,
          status: 'active',
          claimed_at: '2026-11-18T00:00:00.000Z',
          released_at: null,
        };
        state.claims.push(claim);
        return send(201, { task, claim });
      }

      matched = url.pathname.match(/^\/tasks\/([^/]+)\/release$/);
      if (req.method === 'POST' && matched) {
        const claim = state.claims.find(
          (c) => c.task_id === matched[1] && c.status === 'active',
        );
        if (!claim) {
          return send(409, {
            ok: false,
            error: '任务当前没有可释放的活跃认领',
            code: 'CLAIM_NOT_RELEASABLE',
          });
        }
        if (claim.worker_id !== body.worker_id) {
          return send(409, {
            ok: false,
            error: '只有认领者本人可以释放该任务',
            code: 'CLAIM_NOT_RELEASABLE',
          });
        }
        claim.status = 'released';
        claim.released_at = '2026-11-18T01:00:00.000Z';
        const task = state.tasks.find((t) => t.task_id === matched[1]);
        task.status = 'open';
        return send(201, { task, claim });
      }

      matched = url.pathname.match(/^\/tasks\/([^/]+)\/claims$/);
      if (req.method === 'GET' && matched) {
        return send(200, state.claims.filter((c) => c.task_id === matched[1]));
      }

      matched = url.pathname.match(/^\/tasks\/([^/]+)$/);
      if (req.method === 'GET' && matched) {
        const task = state.tasks.find((t) => t.task_id === matched[1]);
        if (!task) return send(404, { ok: false, error: `任务不存在：${matched[1]}` });
        return send(200, task);
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

test('api：tasks / claim / release 的请求路径、查询参数与请求体', async () => {
  const fake = await startFakeCenter();
  try {
    const options = { url: fake.url };

    const tasks = await api.listTasks({ project_id: 'prj_x', status: 'open' }, options);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].task_id, 'task_a');

    const all = await api.listTasks({ project_id: 'prj_x' }, options);
    assert.equal(all.length, 2);

    const claimed = await api.claimTask('task_a', { worker_id: 'worker_a' }, options);
    assert.equal(claimed.claim.claim_id, 'clm_1');
    assert.equal(claimed.task.status, 'claimed');

    const released = await api.releaseTask('task_a', { worker_id: 'worker_a' }, options);
    assert.equal(released.task.status, 'open');
    assert.equal(released.claim.status, 'released');

    const claims = await api.listClaims('task_a', options);
    assert.equal(claims.length, 1);

    assert.deepEqual(
      fake.state.requests.map((r) => `${r.method} ${r.path}`),
      [
        'GET /tasks?project_id=prj_x&status=open',
        'GET /tasks?project_id=prj_x',
        'POST /tasks/task_a/claim',
        'POST /tasks/task_a/release',
        'GET /tasks/task_a/claims',
      ],
    );
    assert.equal(fake.state.requests[2].body.worker_id, 'worker_a');
  } finally {
    await fake.close();
  }
});

test('api：认领冲突与不存在的任务透出服务端错误', async () => {
  const fake = await startFakeCenter();
  try {
    const options = { url: fake.url };

    await assert.rejects(
      () => api.claimTask('task_b', { worker_id: 'worker_b' }, options),
      /任务已被认领或不可认领/,
    );
    await assert.rejects(
      () => api.releaseTask('task_b', { worker_id: 'worker_b' }, options),
      /只有认领者本人可以释放该任务/,
    );
    await assert.rejects(
      () => api.getTask('task_missing', options),
      /任务不存在：task_missing/,
    );
    await assert.rejects(
      () => api.claimTask('task_missing', { worker_id: 'worker_b' }, options),
      /任务不存在：task_missing/,
    );
  } finally {
    await fake.close();
  }
});

test('命令：tasks 输出中文列表；claim 冲突把服务端错误写到 stderr', async () => {
  const fake = await startFakeCenter();
  const previous = process.env.CENTER_URL;
  process.env.CENTER_URL = fake.url;

  const lines = [];
  const errors = [];
  const io = { stdout: (line) => lines.push(line), stderr: (line) => errors.push(line) };

  try {
    const code = await runTasks(['--project', 'prj_x', '--status', 'open'], io);
    assert.equal(code, 0);
    assert.ok(lines.some((line) => line.includes('task_a')));
    assert.ok(lines.some((line) => line.includes('实现导出')));
    assert.ok(lines.some((line) => line.includes('接口返回任务列表')));

    // task_b 已是 claimed，另一个 worker 认领应失败并透出冲突。
    const claimCode = await runClaim(['--task', 'task_b', '--worker', 'worker_b'], io);
    assert.equal(claimCode, 1);
    assert.ok(errors.some((line) => line.includes('任务已被认领或不可认领')));

    errors.length = 0;
    const okCode = await runClaim(['--task', 'task_a', '--worker', 'worker_a'], io);
    assert.equal(okCode, 0);
    assert.ok(lines.some((line) => line.includes('认领成功')));
    assert.ok(lines.some((line) => line.includes('clm_1')));

    const releaseCode = await runRelease(['--task', 'task_a', '--worker', 'worker_b'], io);
    assert.equal(releaseCode, 1);
    assert.ok(errors.some((line) => line.includes('只有认领者本人可以释放该任务')));

    errors.length = 0;
    const releaseOk = await runRelease(['--task', 'task_a', '--worker', 'worker_a'], io);
    assert.equal(releaseOk, 0);
    assert.ok(lines.some((line) => line.includes('释放成功')));
  } finally {
    if (previous === undefined) delete process.env.CENTER_URL;
    else process.env.CENTER_URL = previous;
    await fake.close();
  }
});

test('命令：缺少必填参数时返回 1 并给出用法', async () => {
  const errors = [];
  const io = { stdout: () => {}, stderr: (line) => errors.push(line) };

  assert.equal(await runTasks([], io), 1);
  assert.ok(errors.some((line) => line.includes('--project')));
  assert.equal(await runClaim(['--task', 'task_a'], io), 1);
  assert.ok(errors.some((line) => line.includes('--worker')));
  assert.equal(await runRelease(['--worker', 'worker_a'], io), 1);
  assert.ok(errors.some((line) => line.includes('--task')));
});
