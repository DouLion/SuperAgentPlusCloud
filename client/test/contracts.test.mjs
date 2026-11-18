// Client T12 命令测试：约定包与编排模板请求路径、请求体和输出。

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run as runConvention } from '../src/commands/convention.mjs';
import { run as runWorkflow } from '../src/commands/workflow.mjs';

function fakeCenter() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      requests.push({ method: req.method, path: url.pathname, body });
      const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (url.pathname === '/sap-cloud/api/convention-packs' && req.method === 'POST') return json(201, { pack_id: 'pack_1', name: body.name, scope: body.scope, version: 1, status: 'draft', rules: body.rules });
      if (url.pathname === '/sap-cloud/api/convention-packs/pack_team/import') return json(201, { pack_id: 'pack_2', name: '团队约定', scope: 'project', version: 1, status: 'draft', rules: [], imported_from: 'pack_team' });
      if (url.pathname === '/sap-cloud/api/workflow-templates/seed') return json(200, { template_id: 'wft_1', name: 'contract-first-api', kind: 'api-development', project_id: body.project_id ?? null, version: 1, status: 'active', built_in: true, nodes: [{ key: 'contract', title: '接口契约设计', depends_on: [] }] });
      return json(404, { error: 'not_found' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` })));
}

function io() {
  const out = []; const err = [];
  return { out, err, value: { stdout: (x) => out.push(x), stderr: (x) => err.push(x) } };
}

test('convention create 从 JSON 文件创建约定包；import 生成项目快照', async () => {
  const fake = await fakeCenter();
  process.env.CENTER_URL = fake.url;
  const file = path.join(os.tmpdir(), `sap-pack-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ name: 'API 约定', scope: 'team', rules: [{ key: 'api.response', title: '响应包络', severity: 'must' }] }));
  try {
    let capture = io();
    assert.equal(await runConvention(['create', '--file', file, '--by', 'owner'], capture.value), 0);
    assert.equal(fake.requests.at(-1).path, '/sap-cloud/api/convention-packs');
    assert.equal(fake.requests.at(-1).body.created_by, 'owner');
    capture = io();
    assert.equal(await runConvention(['import', '--pack', 'pack_team', '--project', 'prj_x'], capture.value), 0);
    assert.equal(fake.requests.at(-1).path, '/sap-cloud/api/convention-packs/pack_team/import');
    assert.equal(fake.requests.at(-1).body.project_id, 'prj_x');
  } finally {
    delete process.env.CENTER_URL; fs.rmSync(file, { force: true }); await new Promise((r) => fake.server.close(r));
  }
});

test('workflow seed 调用内置 contract-first-api 接口并打印节点', async () => {
  const fake = await fakeCenter(); process.env.CENTER_URL = fake.url; const capture = io();
  try {
    assert.equal(await runWorkflow([
      'seed', '--project', 'prj_x', '--by', 'system', '--reason', '启用内置模板',
    ], capture.value), 0);
    assert.equal(fake.requests.at(-1).path, '/sap-cloud/api/workflow-templates/seed');
    assert.deepEqual(fake.requests.at(-1).body, {
      project_id: 'prj_x', created_by: 'system', reason: '启用内置模板',
    });
    assert.ok(capture.out.some((line) => line.includes('contract-first-api')));
  } finally { delete process.env.CENTER_URL; await new Promise((r) => fake.server.close(r)); }
});
