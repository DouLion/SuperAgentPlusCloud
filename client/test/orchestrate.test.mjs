// Client T14：sap orchestrate 与 orchestrate adopt。

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { run } from '../src/commands/orchestrate.mjs';

function fakeCenter() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x'); const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
      requests.push({ path: url.pathname, body });
      const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (url.pathname === '/sap-cloud/api/requirements/req_1/orchestrate') return json(201, { suggestion: { suggestion_id: 'sug_1' }, draft: { workflow_template_id: 'wft_1', api_contract_draft: { info: { title: 'API' } }, adoptable: true, uncertainties: [], tasks: [{ node_key: 'contract', purpose: '契约', depends_on_node_keys: [] }] } });
      if (url.pathname === '/sap-cloud/api/ai/suggestions/sug_1/adopt-orchestration') return json(201, { artifact: { artifact_id: 'art_1' }, tasks: [{ node_key: 'contract', task_id: 'task_1', status: 'open' }] });
      return json(404, { error: 'not_found' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` })));
}
function io() { const out = []; const err = []; return { out, err, value: { stdout: (x) => out.push(x), stderr: (x) => err.push(x) } }; }

test('orchestrate 生成未生效建议；adopt 具名采纳', async () => {
  const fake = await fakeCenter(); process.env.CENTER_URL = fake.url;
  try {
    let capture = io();
    assert.equal(await run(['--requirement', 'req_1', '--workflow', 'wft_1'], capture.value), 0);
    assert.equal(fake.requests.at(-1).path, '/sap-cloud/api/requirements/req_1/orchestrate');
    assert.equal(fake.requests.at(-1).body.workflow_template_id, 'wft_1');
    assert.ok(capture.out.some((line) => line.includes('未生效')));
    capture = io();
    assert.equal(await run(['adopt', '--suggestion', 'sug_1', '--by', 'owner', '--contract-name', '订单 API'], capture.value), 0);
    assert.equal(fake.requests.at(-1).body.created_by, 'owner');
    assert.ok(capture.out.some((line) => line.includes('draft 契约')));
  } finally { delete process.env.CENTER_URL; await new Promise((resolve) => fake.server.close(resolve)); }
});

test('orchestrate/adopt 缺参返回非零', async () => {
  let capture = io(); assert.equal(await run([], capture.value), 1);
  capture = io(); assert.equal(await run(['adopt', '--suggestion', 'sug_1'], capture.value), 1);
});
