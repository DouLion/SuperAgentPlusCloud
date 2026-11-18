// Client API 测试（T2）：用 node:http 起一个内存假 Center，
// 验证请求路径、方法、请求体、JSON 解析与错误处理。

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { api, apiRequest, resolveCenterUrl } from '../src/api.mjs';
import { DEFAULT_CENTER_URL } from '../src/help.mjs';

/** 启动假 Center，返回地址与内存数据。 */
function startFakeCenter() {
  const state = {
    projects: new Map(),
    requirements: new Map(),
    decisions: [],
    requests: [],
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
      state.requests.push({ method: req.method, path: url.pathname, body });

      const send = (status, payload) => {
        const data = JSON.stringify(payload);
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(data);
      };

      if (req.method === 'GET' && url.pathname === '/healthz') {
        return send(200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/projects') {
        if (!body.name) return send(400, { error: '缺少必填字段：name' });
        const project = {
          project_id: 'prj_fake',
          name: body.name,
          status: 'active',
        };
        state.projects.set(project.project_id, project);
        return send(201, project);
      }
      if (req.method === 'POST' && url.pathname === '/requirements') {
        if (!body.project_id) return send(400, { error: '缺少必填字段：project_id' });
        if (!body.raw_text) return send(400, { error: '缺少必填字段：raw_text' });
        const requirement = {
          requirement_id: 'req_fake',
          project_id: body.project_id,
          raw_text: body.raw_text,
          claimed_level: body.claimed_level ?? null,
          status: 'submitted',
        };
        state.requirements.set(requirement.requirement_id, requirement);
        return send(201, requirement);
      }

      let matched = url.pathname.match(/^\/requirements\/([^/]+)\/decision$/);
      if (req.method === 'POST' && matched) {
        if (!body.confirmed_by) return send(400, { error: '缺少必填字段：confirmed_by' });
        if (!body.conclusion) return send(400, { error: '缺少必填字段：conclusion' });
        if (
          (body.conclusion === 'accepted' || body.conclusion === 'relevelled')
          && !body.final_level
        ) {
          return send(400, { error: `结论为 ${body.conclusion} 时必须提供 final_level（L0..L4）` });
        }
        const decision = {
          decision_id: 'dec_fake',
          requirement_id: matched[1],
          conclusion: body.conclusion,
          final_level: body.final_level ?? null,
          confirmed_by: body.confirmed_by,
        };
        state.decisions.push(decision);
        return send(201, decision);
      }

      matched = url.pathname.match(/^\/requirements\/([^/]+)\/timeline$/);
      if (req.method === 'GET' && matched) {
        return send(200, [
          {
            event_id: 'evt_1',
            object_id: matched[1],
            event_type: 'requirement.submitted',
            occurred_at: '2026-11-18T00:00:00.000Z',
            refs: [matched[1]],
          },
        ]);
      }

      matched = url.pathname.match(/^\/requirements\/([^/]+)\/assessments$/);
      if (req.method === 'GET' && matched) return send(200, []);

      matched = url.pathname.match(/^\/requirements\/([^/]+)\/decisions$/);
      if (req.method === 'GET' && matched) {
        return send(200, state.decisions.filter((d) => d.requirement_id === matched[1]));
      }

      matched = url.pathname.match(/^\/requirements\/([^/]+)$/);
      if (req.method === 'GET' && matched) {
        const requirement = state.requirements.get(matched[1]);
        if (!requirement) return send(404, { error: `需求不存在：${matched[1]}` });
        return send(200, requirement);
      }

      return send(404, { error: 'not_found' });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        url: `http://127.0.0.1:${server.address().port}`,
        state,
      });
    });
  });
}

test('resolveCenterUrl：默认地址与 CENTER_URL 覆盖', () => {
  assert.equal(resolveCenterUrl({}), DEFAULT_CENTER_URL);
  assert.equal(resolveCenterUrl({ CENTER_URL: 'http://127.0.0.1:9999' }), 'http://127.0.0.1:9999');
  assert.equal(resolveCenterUrl({ CENTER_URL: 'http://127.0.0.1:9999/' }), 'http://127.0.0.1:9999');
});

test('api：请求路径、方法、请求体与 JSON 解析', async () => {
  const fake = await startFakeCenter();
  try {
    const options = { url: fake.url };

    assert.deepEqual(await api.healthz(options), { ok: true });

    const project = await api.createProject({ name: '假项目' }, options);
    assert.equal(project.project_id, 'prj_fake');

    const requirement = await api.createRequirement({
      project_id: 'prj_fake',
      raw_text: '希望支持导出',
      claimed_level: 'L2',
    }, options);
    assert.equal(requirement.requirement_id, 'req_fake');
    assert.equal(requirement.claimed_level, 'L2');

    const decision = await api.createDecision('req_fake', {
      conclusion: 'relevelled',
      final_level: 'L1',
      reason: '影响有限',
      confirmed_by: 'alice',
    }, options);
    assert.equal(decision.conclusion, 'relevelled');
    assert.equal(decision.final_level, 'L1');

    const timeline = await api.getTimeline('req_fake', options);
    assert.equal(timeline.length, 1);
    assert.equal(timeline[0].event_type, 'requirement.submitted');

    assert.deepEqual(
      fake.state.requests.map((r) => `${r.method} ${r.path}`),
      [
        'GET /healthz',
        'POST /projects',
        'POST /requirements',
        'POST /requirements/req_fake/decision',
        'GET /requirements/req_fake/timeline',
      ],
    );
    assert.equal(fake.state.requests[2].body.raw_text, '希望支持导出');
    assert.equal(fake.state.requests[3].body.confirmed_by, 'alice');
  } finally {
    await new Promise((resolve) => fake.server.close(resolve));
  }
});

test('api：非 2xx 抛错并携带服务端 error 文本', async () => {
  const fake = await startFakeCenter();
  try {
    const options = { url: fake.url };

    await assert.rejects(
      () => api.createRequirement({ project_id: 'prj_fake' }, options),
      /缺少必填字段：raw_text/,
    );
    await assert.rejects(
      () => api.createDecision('req_fake', {
        conclusion: 'accepted',
        final_level: 'L1',
      }, options),
      /缺少必填字段：confirmed_by/,
    );
    await assert.rejects(
      () => api.getRequirement('req_missing', options),
      /需求不存在：req_missing/,
    );
    await assert.rejects(
      () => apiRequest('GET', '/not-found', undefined, options),
      /not_found/,
    );
  } finally {
    await new Promise((resolve) => fake.server.close(resolve));
  }
});

test('api：无法连接 Center 时给出可读错误', async () => {
  await assert.rejects(
    () => api.healthz({ url: 'http://127.0.0.1:1' }),
    /无法连接 Center/,
  );
});
