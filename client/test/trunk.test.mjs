// Client 主干条目命令测试（T6）：用 node:http 假 Center 验证
// trunk list/show/propose/confirm/retire 的请求体、参数校验与错误透出。
// 运行：node --test client/test/

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { run as runTrunk } from '../src/commands/trunk.mjs';

const KINDS = ['goal', 'scope', 'capability', 'business_rule', 'interface', 'data_contract', 'architecture_decision', 'other'];
const STATUSES = ['proposed', 'active', 'superseded', 'retired'];

/** 启动假 Center，维护主干条目并记录请求。 */
function startFakeCenter() {
  const state = {
    requests: [],
    seq: 1,
    items: new Map(),
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

      let matched = path.match(/^\/trunk-items$/);
      if (req.method === 'GET' && matched) {
        const items = [...state.items.values()].filter((item) => {
          if (url.searchParams.get('project_id')
            && item.project_id !== url.searchParams.get('project_id')) return false;
          if (url.searchParams.get('status') && item.status !== url.searchParams.get('status')) return false;
          if (url.searchParams.get('kind') && item.kind !== url.searchParams.get('kind')) return false;
          return true;
        });
        return send(200, items);
      }
      if (req.method === 'POST' && matched) {
        if (!body.project_id) return send(400, { ok: false, error: '缺少必填字段：project_id' });
        if (!body.kind || !KINDS.includes(body.kind)) {
          return send(400, { ok: false, error: `非法的主干条目类型：${body.kind}` });
        }
        if (!body.statement) return send(400, { ok: false, error: '缺少必填字段：statement' });
        const itemId = `item_${state.seq++}`;
        const item = {
          item_id: itemId,
          project_id: body.project_id,
          kind: body.kind,
          statement: body.statement,
          rationale: body.rationale ?? null,
          status: body.status ?? 'proposed',
          valid_from: body.valid_from ?? null,
          valid_until: body.valid_until ?? null,
          relations: body.relations ?? [],
          source_refs: body.source_refs ?? [],
          created_at: '2026-11-18T00:00:00.000Z',
          created_by: body.created_by ?? null,
          confirmed_at: null,
          confirmed_by: null,
          superseded_by: null,
        };
        state.items.set(itemId, item);
        return send(201, item);
      }

      matched = path.match(/^\/trunk-items\/([^/]+)$/);
      if (req.method === 'GET' && matched) {
        const item = state.items.get(matched[1]);
        if (!item) return send(404, { ok: false, error: `主干条目不存在：${matched[1]}` });
        return send(200, item);
      }

      matched = path.match(/^\/trunk-items\/([^/]+)\/confirm$/);
      if (req.method === 'POST' && matched) {
        const item = state.items.get(matched[1]);
        if (!item) return send(404, { ok: false, error: `主干条目不存在：${matched[1]}` });
        if (!body.confirmed_by) return send(400, { ok: false, error: '缺少必填字段：confirmed_by' });
        if (item.status !== 'proposed') {
          return send(409, {
            ok: false,
            error: `主干条目当前状态不可确认：${item.status}`,
            code: 'INVALID_TRANSITION',
          });
        }
        item.status = 'active';
        item.confirmed_by = body.confirmed_by;
        item.confirmed_at = '2026-11-18T01:00:00.000Z';
        if (body.valid_from !== undefined) item.valid_from = body.valid_from;
        return send(200, item);
      }

      matched = path.match(/^\/trunk-items\/([^/]+)\/retire$/);
      if (req.method === 'POST' && matched) {
        const item = state.items.get(matched[1]);
        if (!item) return send(404, { ok: false, error: `主干条目不存在：${matched[1]}` });
        if (!body.confirmed_by) return send(400, { ok: false, error: '缺少必填字段：confirmed_by' });
        if (item.status !== 'active') {
          return send(409, {
            ok: false,
            error: `主干条目当前状态不可退役：${item.status}`,
            code: 'INVALID_TRANSITION',
          });
        }
        item.status = 'retired';
        item.confirmed_by = body.confirmed_by;
        item.confirmed_at = '2026-11-18T02:00:00.000Z';
        return send(200, item);
      }

      matched = path.match(/^\/trunk-changes$/);
      if (req.method === 'GET' && matched) return send(200, []);

      return send(404, { ok: false, error: 'not_found' });
    });
  });

  const addItem = (item) => {
    state.items.set(item.item_id, item);
    return item;
  };

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        url: `http://127.0.0.1:${server.address().port}`,
        state,
        addItem,
        async close() {
          await new Promise((done) => server.close(done));
        },
      });
    });
  });
}

test('命令：trunk propose 组装请求体并输出 proposed 提示', async () => {
  const fake = await startFakeCenter();
  process.env.CENTER_URL = fake.url;
  const lines = [];
  const errors = [];
  const io = { stdout: (line) => lines.push(line), stderr: (line) => errors.push(line) };

  try {
    const code = await runTrunk([
      'propose',
      '--project', 'prj_x',
      '--kind', 'scope',
      '--statement', '只覆盖单项目',
      '--rationale', '一期范围',
      '--rationale', '先跑通链路',
      '--source', 'docs/04_详细方案.md',
      '--by', '张三',
    ], io);

    assert.equal(code, 0);
    assert.ok(lines.some((line) => line.includes('主干条目已提出')));
    assert.ok(lines.some((line) => line.includes('状态：proposed')));
    assert.ok(lines.some((line) => line.includes('需 confirm 后才作为已确认前提')));
    assert.equal(errors.length, 0);

    const request = fake.state.requests[fake.state.requests.length - 1];
    assert.equal(request.method, 'POST');
    assert.equal(request.path, '/sap-cloud/api/trunk-items');
    assert.equal(request.body.project_id, 'prj_x');
    assert.equal(request.body.kind, 'scope');
    assert.equal(request.body.statement, '只覆盖单项目');
    assert.equal(request.body.rationale, '一期范围；先跑通链路');
    assert.deepEqual(request.body.source_refs, ['docs/04_详细方案.md']);
    assert.equal(request.body.created_by, '张三');
  } finally {
    delete process.env.CENTER_URL;
    await fake.close();
  }
});

test('命令：trunk propose 参数校验（缺参、非法 kind）', async () => {
  const fake = await startFakeCenter();
  process.env.CENTER_URL = fake.url;
  const errors = [];
  const io = { stdout: () => {}, stderr: (line) => errors.push(line) };

  try {
    assert.equal(await runTrunk(['propose', '--project', 'prj_x'], io), 1);
    assert.ok(errors.some((line) => line.includes('--kind')));

    errors.length = 0;
    assert.equal(await runTrunk([
      'propose', '--project', 'prj_x', '--kind', 'bogus', '--statement', 'x',
    ], io), 1);
    assert.ok(errors.some((line) => line.includes('--kind 只能是')));
  } finally {
    delete process.env.CENTER_URL;
    await fake.close();
  }
});

test('命令：trunk confirm / retire 请求体与输出', async () => {
  const fake = await startFakeCenter();
  process.env.CENTER_URL = fake.url;
  const lines = [];
  const io = { stdout: (line) => lines.push(line), stderr: () => {} };

  try {
    const created = await fetch(`${fake.url}/trunk-items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: 'prj_x', kind: 'goal', statement: '目标一' }),
    }).then((res) => res.json());

    assert.equal(await runTrunk([
      'confirm', '--item', created.item_id, '--by', '李四',
      '--valid-from', '2026-11-19T00:00:00.000Z',
    ], io), 0);
    assert.ok(lines.some((line) => line.includes('主干条目已确认')));
    let request = fake.state.requests[fake.state.requests.length - 1];
    assert.equal(request.path, `/sap-cloud/api/trunk-items/${created.item_id}/confirm`);
    assert.deepEqual(request.body, {
      confirmed_by: '李四',
      valid_from: '2026-11-19T00:00:00.000Z',
    });

    assert.equal(await runTrunk([
      'retire', '--item', created.item_id, '--by', '李四',
    ], io), 0);
    assert.ok(lines.some((line) => line.includes('主干条目已退役')));
    request = fake.state.requests[fake.state.requests.length - 1];
    assert.equal(request.path, `/sap-cloud/api/trunk-items/${created.item_id}/retire`);
    assert.deepEqual(request.body, { confirmed_by: '李四' });
  } finally {
    delete process.env.CENTER_URL;
    await fake.close();
  }
});

test('命令：trunk confirm 遇非法流转时透出错误并非零退出', async () => {
  const fake = await startFakeCenter();
  process.env.CENTER_URL = fake.url;
  const errors = [];
  const io = { stdout: () => {}, stderr: (line) => errors.push(line) };

  try {
    const created = await fetch(`${fake.url}/trunk-items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: 'prj_x', kind: 'goal', statement: '目标一' }),
    }).then((res) => res.json());

    const code = await runTrunk(['confirm', '--item', created.item_id, '--by', '李四'], io);
    assert.equal(code, 0);

    errors.length = 0;
    assert.equal(await runTrunk([
      'confirm', '--item', created.item_id, '--by', '李四',
    ], io), 1);
    assert.ok(errors.some((line) => line.includes('INVALID_TRANSITION')
      || line.includes('不可确认')));

    errors.length = 0;
    assert.equal(await runTrunk([
      'confirm', '--item', 'item_missing', '--by', '李四',
    ], io), 1);
    assert.ok(errors.some((line) => line.includes('主干条目不存在')));
  } finally {
    delete process.env.CENTER_URL;
    await fake.close();
  }
});

test('命令：trunk list 过滤条件与 show 打印条目、关系、来源、替代信息', async () => {
  const fake = await startFakeCenter();
  process.env.CENTER_URL = fake.url;

  const active = fake.addItem({
    item_id: 'item_active',
    project_id: 'prj_x',
    kind: 'scope',
    statement: '当前有效范围',
    status: 'active',
    relations: [{ type: 'depends_on', item_id: 'item_other' }, 'item_plain'],
    source_refs: ['docs/03_总体架构.md', 'meeting/2026-11-18'],
    confirmed_by: 'owner',
    created_by: 'owner',
    created_at: '2026-11-18T00:00:00.000Z',
    confirmed_at: '2026-11-18T01:00:00.000Z',
    valid_from: null,
    valid_until: null,
    rationale: null,
    superseded_by: 'item_new',
  });
  fake.addItem({
    item_id: 'item_new',
    project_id: 'prj_x',
    kind: 'scope',
    statement: '新范围',
    status: 'active',
    relations: [],
    source_refs: [],
    confirmed_by: 'owner',
    created_by: 'owner',
    created_at: '2026-11-19T00:00:00.000Z',
    confirmed_at: '2026-11-19T00:00:00.000Z',
    valid_from: null,
    valid_until: null,
    rationale: null,
    superseded_by: null,
  });

  const lines = [];
  const io = { stdout: (line) => lines.push(line), stderr: () => {} };

  try {
    assert.equal(await runTrunk([
      'list', '--project', 'prj_x', '--status', 'active', '--kind', 'scope',
    ], io), 0);
    assert.ok(lines.some((line) => line.includes('item_active')));
    assert.ok(lines.some((line) => line.includes('item_new')));
    const listRequest = fake.state.requests[fake.state.requests.length - 1];
    assert.equal(listRequest.path, '/sap-cloud/api/trunk-items?project_id=prj_x&status=active&kind=scope');

    lines.length = 0;
    assert.equal(await runTrunk(['show', '--item', active.item_id], io), 0);
    assert.ok(lines.some((line) => line.includes('主干条目 item_active')));
    assert.ok(lines.some((line) => line.includes('depends_on item_other')));
    assert.ok(lines.some((line) => line.includes('item_plain')));
    assert.ok(lines.some((line) => line.includes('docs/03_总体架构.md')));
    assert.ok(lines.some((line) => line.includes('被替代为')));
    assert.ok(lines.some((line) => line.includes('item_new')));
    assert.ok(lines.some((line) => line.includes('相关主干变更（0）')));
  } finally {
    delete process.env.CENTER_URL;
    await fake.close();
  }
});

test('命令：trunk list 非法 status、show 缺参时返回 1', async () => {
  const fake = await startFakeCenter();
  process.env.CENTER_URL = fake.url;
  const errors = [];
  const io = { stdout: () => {}, stderr: (line) => errors.push(line) };

  try {
    assert.equal(await runTrunk(['list', '--project', 'prj_x', '--status', 'bogus'], io), 1);
    assert.ok(errors.some((line) => line.includes('--status 只能是')));

    errors.length = 0;
    assert.equal(await runTrunk(['show'], io), 1);
    assert.ok(errors.some((line) => line.includes('--item')));

    errors.length = 0;
    assert.equal(await runTrunk([], io), 1);
    assert.ok(errors.some((line) => line.includes('用法')));
  } finally {
    delete process.env.CENTER_URL;
    await fake.close();
  }
});
