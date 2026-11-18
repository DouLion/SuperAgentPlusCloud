// Client 主干变更与影响处置命令测试（T5）：用 node:http 假 Center 验证
// change / impact 的请求体、参数校验与 409 错误透出。
// 运行：node --test client/test/

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { run as runChange } from '../src/commands/change.mjs';
import { run as runImpact } from '../src/commands/impact.mjs';

const TARGET_TYPES = ['task', 'submission', 'document', 'test', 'other'];
const ASSESSMENTS = ['to_check', 'affected', 'not_affected'];
const RESOLUTIONS = ['continue', 'adjust', 'revalidate', 'obsolete', 'pending'];

/**
 * 启动假 Center：维护变更与影响项状态并记录请求。
 * 校验规则与真实 Center 保持一致（关闭门槛、not_affected 需 reason）。
 */
function startFakeCenter() {
  const state = {
    requests: [],
    seq: { change: 1, impact: 1, item: 1 },
    changes: new Map(),
    impacts: new Map(),
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      // 假 Center 按剥掉 /sap-cloud/api 前缀后的路径匹配。
      const path = url.pathname.replace(/^\/sap-cloud\/api/, '');
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

      let matched = path.match(/^\/trunk-changes$/);
      if (req.method === 'GET' && matched) {
        return send(200, [...state.changes.values()]);
      }
      if (req.method === 'POST' && matched) {
        if (!body.project_id) return send(400, { ok: false, error: '缺少必填字段：project_id' });
        if (!body.reason) return send(400, { ok: false, error: '缺少必填字段：reason' });
        const changeId = `chg_${state.seq.change++}`;
        const proposedItemIds = (body.proposed_items ?? []).map(() => `item_p${state.seq.item++}`);
        const change = {
          change_id: changeId,
          project_id: body.project_id,
          trigger_requirement_id: body.trigger_requirement_id ?? null,
          old_item_ids: body.old_item_ids ?? [],
          proposed_item_ids: proposedItemIds,
          reason: body.reason,
          impact_assessment: body.impact_assessment ?? null,
          confirmed_by: null,
          confirmed_at: null,
          effective_at: null,
          status: 'proposed',
          created_at: '2026-11-18T00:00:00.000Z',
        };
        state.changes.set(changeId, change);
        return send(201, change);
      }

      matched = path.match(/^\/trunk-changes\/([^/]+)$/);
      if (req.method === 'GET' && matched) {
        const change = state.changes.get(matched[1]);
        if (!change) return send(404, { ok: false, error: `主干变更不存在：${matched[1]}` });
        return send(200, change);
      }

      matched = path.match(/^\/trunk-changes\/([^/]+)\/confirm$/);
      if (req.method === 'POST' && matched) {
        const change = state.changes.get(matched[1]);
        if (!change) return send(404, { ok: false, error: `主干变更不存在：${matched[1]}` });
        if (!body.confirmed_by) return send(400, { ok: false, error: '缺少必填字段：confirmed_by' });
        if (change.status !== 'proposed') {
          return send(409, {
            ok: false,
            error: `主干变更当前状态不可确认：${change.status}`,
            code: 'INVALID_TRANSITION',
          });
        }
        change.status = 'confirmed';
        change.confirmed_by = body.confirmed_by;
        change.confirmed_at = '2026-11-18T01:00:00.000Z';
        change.effective_at = body.effective_at ?? null;
        return send(200, change);
      }

      matched = path.match(/^\/trunk-changes\/([^/]+)\/activate$/);
      if (req.method === 'POST' && matched) {
        const change = state.changes.get(matched[1]);
        if (!change) return send(404, { ok: false, error: `主干变更不存在：${matched[1]}` });
        if (!body.confirmed_by) return send(400, { ok: false, error: '缺少必填字段：confirmed_by' });
        if (change.status !== 'confirmed') {
          return send(409, {
            ok: false,
            error: `主干变更当前状态不可生效：${change.status}`,
            code: 'INVALID_TRANSITION',
          });
        }
        change.status = 'in_effect';
        change.effective_at = change.effective_at ?? '2026-11-18T02:00:00.000Z';
        return send(200, change);
      }

      matched = path.match(/^\/trunk-changes\/([^/]+)\/close$/);
      if (req.method === 'POST' && matched) {
        const change = state.changes.get(matched[1]);
        if (!change) return send(404, { ok: false, error: `主干变更不存在：${matched[1]}` });
        if (change.status !== 'in_effect') {
          return send(409, {
            ok: false,
            error: `主干变更当前状态不可关闭：${change.status}`,
            code: 'INVALID_TRANSITION',
          });
        }
        const impacts = [...state.impacts.values()]
          .filter((item) => item.change_id === change.change_id);
        const pending = impacts.filter((item) => item.assessment_status === 'to_check');
        if (pending.length > 0) {
          return send(409, {
            ok: false,
            error: `仍有 ${pending.length} 个影响项处于待检查（to_check），不能关闭变更`,
            code: 'CHANGE_IMPACT_UNRESOLVED',
          });
        }
        if (impacts.length === 0 && !change.impact_assessment) {
          return send(409, {
            ok: false,
            error: '未登记任何影响项，且未提供影响声明（impact_assessment），不能关闭变更',
            code: 'CHANGE_IMPACT_UNRESOLVED',
          });
        }
        change.status = 'closed';
        return send(200, change);
      }

      matched = path.match(/^\/trunk-changes\/([^/]+)\/impacts$/);
      if (req.method === 'GET' && matched) {
        return send(200, [...state.impacts.values()]
          .filter((item) => item.change_id === matched[1]));
      }
      if (req.method === 'POST' && matched) {
        const change = state.changes.get(matched[1]);
        if (!change) return send(404, { ok: false, error: `主干变更不存在：${matched[1]}` });
        if (!TARGET_TYPES.includes(body.target_type)) {
          return send(400, { ok: false, error: `非法的影响对象类型：${body.target_type}` });
        }
        if (!body.target_id) return send(400, { ok: false, error: '缺少必填字段：target_id' });
        const impact = {
          impact_item_id: `imp_${state.seq.impact++}`,
          change_id: change.change_id,
          target_type: body.target_type,
          target_id: body.target_id,
          assessment_status: 'to_check',
          resolution: 'pending',
          reason: null,
          owner_id: body.owner_id ?? null,
          updated_at: '2026-11-18T03:00:00.000Z',
          created_at: '2026-11-18T03:00:00.000Z',
        };
        state.impacts.set(impact.impact_item_id, impact);
        return send(201, impact);
      }

      matched = path.match(/^\/impact-items\/([^/]+)$/);
      if (req.method === 'PATCH' && matched) {
        const impact = state.impacts.get(matched[1]);
        if (!impact) return send(404, { ok: false, error: `影响项不存在：${matched[1]}` });
        const status = body.assessment_status ?? impact.assessment_status;
        if (!ASSESSMENTS.includes(status)) {
          return send(400, { ok: false, error: `非法的影响评估状态：${status}` });
        }
        const resolution = body.resolution ?? impact.resolution;
        if (!RESOLUTIONS.includes(resolution)) {
          return send(400, { ok: false, error: `非法的影响处置方式：${resolution}` });
        }
        if (status === 'not_affected' && !body.reason) {
          return send(400, {
            ok: false,
            error: '影响评估为 not_affected 时必须提供 reason，说明确认无影响的依据',
          });
        }
        impact.assessment_status = status;
        impact.resolution = resolution;
        impact.reason = body.reason ?? impact.reason;
        impact.updated_at = '2026-11-18T04:00:00.000Z';
        return send(200, impact);
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

/** 准备一个已生效（in_effect）的变更。 */
async function seedEffective(fake) {
  const change = await fetch(`${fake.url}/trunk-changes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: 'prj_x', reason: '范围调整' }),
  }).then((res) => res.json());
  await fetch(`${fake.url}/trunk-changes/${change.change_id}/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmed_by: 'owner_a' }),
  });
  await fetch(`${fake.url}/trunk-changes/${change.change_id}/activate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmed_by: 'owner_a' }),
  });
  return change;
}

test('命令：change propose 组装请求体并输出变更与新条目', async () => {
  const fake = await startFakeCenter();
  process.env.CENTER_URL = fake.url;
  const lines = [];
  const errors = [];
  const io = { stdout: (line) => lines.push(line), stderr: (line) => errors.push(line) };

  try {
    const code = await runChange([
      'propose',
      '--project', 'prj_x',
      '--reason', '旧范围已不适用',
      '--old', 'item_a',
      '--old=item_b',
      '--requirement', 'req_x',
      '--proposal', 'scope:新范围：对外开放',
      '--proposal=goal:新目标',
    ], io);

    assert.equal(code, 0);
    assert.ok(lines.some((line) => line.includes('变更已提出')));
    assert.ok(lines.some((line) => line.includes('新条目（proposed）')));
    assert.equal(errors.length, 0);

    const request = fake.state.requests[fake.state.requests.length - 1];
    assert.equal(request.method, 'POST');
    assert.equal(request.path, '/sap-cloud/api/trunk-changes');
    assert.equal(request.body.project_id, 'prj_x');
    assert.equal(request.body.reason, '旧范围已不适用');
    assert.equal(request.body.trigger_requirement_id, 'req_x');
    assert.deepEqual(request.body.old_item_ids, ['item_a', 'item_b']);
    assert.deepEqual(request.body.proposed_items, [
      { kind: 'scope', statement: '新范围：对外开放' },
      { kind: 'goal', statement: '新目标' },
    ]);
  } finally {
    delete process.env.CENTER_URL;
    await fake.close();
  }
});

test('命令：change propose 缺少 --reason 或 proposal 格式错误时返回 1', async () => {
  const fake = await startFakeCenter();
  process.env.CENTER_URL = fake.url;
  const errors = [];
  const io = { stdout: () => {}, stderr: (line) => errors.push(line) };

  try {
    assert.equal(await runChange(['propose', '--project', 'prj_x'], io), 1);
    assert.ok(errors.some((line) => line.includes('--reason')));

    errors.length = 0;
    assert.equal(await runChange([
      'propose', '--project', 'prj_x', '--reason', '理由', '--proposal', '缺少冒号',
    ], io), 1);
    assert.ok(errors.some((line) => line.includes('<kind>:<statement>')));

    errors.length = 0;
    assert.equal(await runChange([
      'propose', '--project', 'prj_x', '--reason', '理由', '--proposal', 'bogus:陈述',
    ], io), 1);
    assert.ok(errors.some((line) => line.includes('类型非法')));
  } finally {
    delete process.env.CENTER_URL;
    await fake.close();
  }
});

test('命令：change confirm / activate 请求体与输出', async () => {
  const fake = await startFakeCenter();
  process.env.CENTER_URL = fake.url;
  const lines = [];
  const io = { stdout: (line) => lines.push(line), stderr: () => {} };

  try {
    const created = await fetch(`${fake.url}/trunk-changes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: 'prj_x', reason: '确认演示' }),
    }).then((res) => res.json());

    assert.equal(await runChange([
      'confirm', '--change', created.change_id, '--by', '张三',
      '--effective-at', '2026-11-19T00:00:00.000Z',
    ], io), 0);
    assert.ok(lines.some((line) => line.includes('变更已确认')));
    let request = fake.state.requests[fake.state.requests.length - 1];
    assert.equal(request.path, `/sap-cloud/api/trunk-changes/${created.change_id}/confirm`);
    assert.equal(request.body.confirmed_by, '张三');
    assert.equal(request.body.effective_at, '2026-11-19T00:00:00.000Z');

    assert.equal(await runChange([
      'activate', '--change', created.change_id, '--by', '张三',
    ], io), 0);
    assert.ok(lines.some((line) => line.includes('变更已生效')));
    request = fake.state.requests[fake.state.requests.length - 1];
    assert.equal(request.path, `/sap-cloud/api/trunk-changes/${created.change_id}/activate`);
    assert.deepEqual(request.body, { confirmed_by: '张三' });
  } finally {
    delete process.env.CENTER_URL;
    await fake.close();
  }
});

test('命令：change close 遇 CHANGE_IMPACT_UNRESOLVED 时中文提示并非零退出', async () => {
  const fake = await startFakeCenter();
  process.env.CENTER_URL = fake.url;
  const errors = [];
  const io = { stdout: () => {}, stderr: (line) => errors.push(line) };

  try {
    const change = await seedEffective(fake);
    await fetch(`${fake.url}/trunk-changes/${change.change_id}/impacts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target_type: 'task', target_id: 'task_a' }),
    });

    const code = await runChange(['close', '--change', change.change_id], io);
    assert.equal(code, 1);
    assert.ok(errors.some((line) => line.includes('影响处置未完成')));
    assert.ok(errors.some((line) => line.includes('待检查')));
    assert.ok(errors.some((line) => line.includes('sap impact')));
  } finally {
    delete process.env.CENTER_URL;
    await fake.close();
  }
});

test('命令：change show 打印变更、影响项与处置状态', async () => {
  const fake = await startFakeCenter();
  process.env.CENTER_URL = fake.url;
  const lines = [];
  const io = { stdout: (line) => lines.push(line), stderr: () => {} };

  try {
    const change = await seedEffective(fake);
    await fetch(`${fake.url}/trunk-changes/${change.change_id}/impacts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target_type: 'document', target_id: 'doc_a', owner_id: '李四' }),
    }).then((res) => res.json());

    const impact = [...fake.state.impacts.values()][0];
    await fetch(`${fake.url}/impact-items/${impact.impact_item_id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        assessment_status: 'not_affected',
        resolution: 'obsolete',
        reason: '该文档不引用旧范围',
      }),
    });

    const code = await runChange(['show', '--change', change.change_id], io);
    assert.equal(code, 0);
    assert.ok(lines.some((line) => line.includes(`主干变更 ${change.change_id}`)));
    assert.ok(lines.some((line) => line.includes('状态：in_effect')));
    assert.ok(lines.some((line) => line.includes('影响项（1，待检查 0）')));
    assert.ok(lines.some((line) => line.includes('document:doc_a')));
    assert.ok(lines.some((line) => line.includes('评估：not_affected')));
    assert.ok(lines.some((line) => line.includes('处置：obsolete')));
    assert.ok(lines.some((line) => line.includes('该文档不引用旧范围')));
  } finally {
    delete process.env.CENTER_URL;
    await fake.close();
  }
});

test('命令：impact add / update 请求体与参数校验', async () => {
  const fake = await startFakeCenter();
  process.env.CENTER_URL = fake.url;
  const lines = [];
  const errors = [];
  const io = { stdout: (line) => lines.push(line), stderr: (line) => errors.push(line) };

  try {
    const change = await seedEffective(fake);

    assert.equal(await runImpact([
      'add', '--change', change.change_id,
      '--type', 'task', '--target', 'task_a', '--owner', 'worker_a',
    ], io), 0);
    assert.ok(lines.some((line) => line.includes('影响项已登记')));
    assert.ok(lines.some((line) => line.includes('评估：to_check')));
    assert.ok(lines.some((line) => line.includes('处置：pending')));

    let request = fake.state.requests[fake.state.requests.length - 1];
    assert.equal(request.path, `/sap-cloud/api/trunk-changes/${change.change_id}/impacts`);
    assert.deepEqual(request.body, {
      target_type: 'task',
      target_id: 'task_a',
      owner_id: 'worker_a',
    });

    const impact = [...fake.state.impacts.values()][0];

    errors.length = 0;
    assert.equal(await runImpact([
      'update', '--impact', impact.impact_item_id, '--status', 'not_affected',
    ], io), 1);
    assert.ok(errors.some((line) => line.includes('not_affected 时必须提供 --reason')));

    errors.length = 0;
    assert.equal(await runImpact([
      'update', '--impact', impact.impact_item_id, '--status', 'bogus',
    ], io), 1);
    assert.ok(errors.some((line) => line.includes('--status 只能是')));

    assert.equal(await runImpact([
      'update', '--impact', impact.impact_item_id,
      '--status', 'not_affected',
      '--resolution', 'continue',
      '--reason', '该任务不依赖旧范围',
    ], io), 0);
    assert.ok(lines.some((line) => line.includes('评估：not_affected')));
    assert.ok(lines.some((line) => line.includes('处置：continue')));

    request = fake.state.requests[fake.state.requests.length - 1];
    assert.equal(request.method, 'PATCH');
    assert.equal(request.path, `/sap-cloud/api/impact-items/${impact.impact_item_id}`);
    assert.equal(request.body.assessment_status, 'not_affected');
    assert.equal(request.body.resolution, 'continue');
    assert.equal(request.body.reason, '该任务不依赖旧范围');
  } finally {
    delete process.env.CENTER_URL;
    await fake.close();
  }
});

test('命令：change / impact 缺少必填参数时返回 1 并非零退出', async () => {
  const fake = await startFakeCenter();
  process.env.CENTER_URL = fake.url;
  const errors = [];
  const io = { stdout: () => {}, stderr: (line) => errors.push(line) };

  try {
    assert.equal(await runChange([], io), 1);
    assert.ok(errors.some((line) => line.includes('用法')));

    errors.length = 0;
    assert.equal(await runChange(['close'], io), 1);
    assert.ok(errors.some((line) => line.includes('--change')));

    errors.length = 0;
    assert.equal(await runImpact(['add', '--change', 'chg_1'], io), 1);
    assert.ok(errors.some((line) => line.includes('--type')));

    errors.length = 0;
    assert.equal(await runImpact(['update', '--impact', 'imp_1'], io), 1);
    assert.ok(errors.some((line) => line.includes('--status')));
  } finally {
    delete process.env.CENTER_URL;
    await fake.close();
  }
});
