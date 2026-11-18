// Client AI 命令测试（T8）：用 node:http 假 Center 验证
// advise / plan / impacts 的请求路径、输出标注与 503 未配置透出。
// 运行：node --test client/test/

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { run as runAdvise } from '../src/commands/advise.mjs';
import { run as runPlan } from '../src/commands/plan.mjs';
import { run as runImpacts } from '../src/commands/impacts.mjs';

/** 启动假 Center，记录请求并按需返回 AI 结果。 */
function startFakeCenter() {
  const state = { requests: [] };

  const suggestion = {
    suggestion_id: 'sug_fake',
    project_id: 'prj_x',
    model: 'deepseek-chat',
    created_at: '2026-11-18T00:00:00.000Z',
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      // 假 Center 按剥掉 /sap-cloud/api 前缀后的路径匹配。
      const path = url.pathname.replace(/^\/sap-cloud\/api/, '');
      const raw = Buffer.concat(chunks).toString('utf8');
      state.requests.push({ method: req.method, path: req.url, body: raw ? JSON.parse(raw) : {} });

      const send = (status, payload) => {
        const data = JSON.stringify(payload);
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(data);
      };

      if (req.method === 'GET' && path === '/ai/health') {
        return send(200, { configured: false, model: 'deepseek-chat', base_url: '' });
      }

      let matched = path.match(/^\/requirements\/([^/]+)\/advice$/);
      if (req.method === 'POST' && matched) {
        if (matched[1] === 'req_unconfigured') {
          return send(503, {
            ok: false,
            error: 'Center 未配置模型：请设置 SAP_LLM_BASE_URL 与 SAP_LLM_API_KEY',
            code: 'AI_NOT_CONFIGURED',
          });
        }
        return send(201, {
          suggestion,
          draft: {
            assessed_level: 'L2',
            related_item_ids: ['item_a'],
            impact_summary: '影响导出模块',
            uncertainties: ['数据量未知'],
            proposed_action: 'relevel',
          },
        });
      }

      matched = path.match(/^\/requirements\/([^/]+)\/plan$/);
      if (req.method === 'POST' && matched) {
        return send(201, {
          suggestion,
          draft: [{
            purpose: '实现按项目导出',
            done_when: ['接口返回需求列表', '空项目返回空数组'],
            scope: '仅导出接口',
            non_scope: '不做导出调度',
            serves_item_ids: ['item_a'],
          }],
        });
      }

      matched = path.match(/^\/trunk-changes\/([^/]+)\/advice$/);
      if (req.method === 'POST' && matched) {
        return send(201, {
          suggestion,
          draft: [
            { target_type: 'task', target_id: 'task_a', reason: '该任务依赖旧范围' },
          ],
        });
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

/** 捕获命令输出。 */
function capture() {
  const lines = [];
  const errors = [];
  return {
    lines,
    errors,
    io: { stdout: (line) => lines.push(line), stderr: (line) => errors.push(line) },
  };
}

test('命令：advise 未配置模型时中文透出 503 并非零退出', async () => {
  const fake = await startFakeCenter();
  process.env.CENTER_URL = fake.url;
  const io = capture();

  try {
    const code = await runAdvise(['--requirement', 'req_unconfigured'], io.io);
    assert.equal(code, 1);
    assert.ok(io.errors.some((line) => line.includes('Center 未配置模型')));
    assert.ok(io.errors.some((line) => line.includes('SAP_LLM_BASE_URL')
      && line.includes('SAP_LLM_API_KEY')));

    const request = fake.state.requests[fake.state.requests.length - 1];
    assert.equal(request.method, 'POST');
    assert.equal(request.path, '/sap-cloud/api/requirements/req_unconfigured/advice');
  } finally {
    delete process.env.CENTER_URL;
    await fake.close();
  }
});

test('命令：advise 正常打印评估建议并标注「建议，未生效」', async () => {
  const fake = await startFakeCenter();
  process.env.CENTER_URL = fake.url;
  const io = capture();

  try {
    const code = await runAdvise(['--requirement', 'req_ok'], io.io);
    assert.equal(code, 0);
    assert.ok(io.lines.some((line) => line.includes('评估建议（建议，未生效）')));
    assert.ok(io.lines.some((line) => line.includes('等级：L2')));
    assert.ok(io.lines.some((line) => line.includes('关联条目：item_a')));
    assert.ok(io.lines.some((line) => line.includes('影响摘要：影响导出模块')));
    assert.ok(io.lines.some((line) => line.includes('不确定项：数据量未知')));
    assert.ok(io.lines.some((line) => line.includes('建议动作：relevel')));

    const request = fake.state.requests[fake.state.requests.length - 1];
    assert.equal(request.path, '/sap-cloud/api/requirements/req_ok/advice');
  } finally {
    delete process.env.CENTER_URL;
    await fake.close();
  }
});

test('命令：plan / impacts 请求路径与未生效标注', async () => {
  const fake = await startFakeCenter();
  process.env.CENTER_URL = fake.url;

  try {
    const planIo = capture();
    assert.equal(await runPlan(['--requirement', 'req_ok'], planIo.io), 0);
    assert.ok(planIo.lines.some((line) => line.includes('任务草稿（建议，未生效）')));
    assert.ok(planIo.lines.some((line) => line.includes('接口返回需求列表')));
    assert.ok(planIo.lines.some((line) => line.includes('服务条目：item_a')));
    let request = fake.state.requests[fake.state.requests.length - 1];
    assert.equal(request.path, '/sap-cloud/api/requirements/req_ok/plan');

    const impactsIo = capture();
    assert.equal(await runImpacts(['--change', 'chg_ok'], impactsIo.io), 0);
    assert.ok(impactsIo.lines.some((line) => line.includes('影响候选（建议，未生效）')));
    assert.ok(impactsIo.lines.some((line) => line.includes('task:task_a')));
    assert.ok(impactsIo.lines.some((line) => line.includes('该任务依赖旧范围')));
    request = fake.state.requests[fake.state.requests.length - 1];
    assert.equal(request.path, '/sap-cloud/api/trunk-changes/chg_ok/advice');
  } finally {
    delete process.env.CENTER_URL;
    await fake.close();
  }
});

test('命令：advise 缺少 --requirement 时返回 1 并非零退出', async () => {
  const fake = await startFakeCenter();
  process.env.CENTER_URL = fake.url;
  const io = capture();

  try {
    assert.equal(await runAdvise([], io.io), 1);
    assert.ok(io.errors.some((line) => line.includes('--requirement')));
  } finally {
    delete process.env.CENTER_URL;
    await fake.close();
  }
});
