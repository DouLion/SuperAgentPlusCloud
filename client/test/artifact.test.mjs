// Client T13：Artifact 命令请求与输出。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { run as runArtifact } from '../src/commands/artifact.mjs';

function fakeCenter() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      requests.push({ method: req.method, path: url.pathname, body });
      const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (url.pathname === '/sap-cloud/api/artifacts' && req.method === 'POST') return json(201, { artifact_id: 'art_1', type: body.type, name: body.name, version: 1, status: 'draft', digest: 'a'.repeat(64) });
      if (url.pathname === '/sap-cloud/api/artifacts/art_1/validate') return json(200, { valid: true, counts: { must: 0, should: 0, preference: 0 }, violations: [] });
      if (url.pathname === '/sap-cloud/api/artifacts/art_1/publish') return json(200, { artifact: { artifact_id: 'art_1', type: 'api_contract', name: '订单 API', version: 1, status: 'published', digest: 'a'.repeat(64) }, validation: { valid: true, counts: { must: 0, should: 0, preference: 0 }, violations: [] } });
      return json(404, { error: 'not_found' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` })));
}

function io() {
  const out = []; const err = [];
  return { out, err, value: { stdout: (x) => out.push(x), stderr: (x) => err.push(x) } };
}

test('artifact create/validate/publish 使用新 API 前缀并输出校验', async () => {
  const fake = await fakeCenter(); process.env.CENTER_URL = fake.url;
  const file = path.join(os.tmpdir(), `sap-artifact-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ openapi: '3.1.0', info: { title: '订单 API', version: '1.0.0' }, paths: {} }));
  try {
    let capture = io();
    assert.equal(await runArtifact(['create', '--project', 'prj_x', '--type', 'api_contract', '--name', '订单 API', '--file', file, '--by', 'owner'], capture.value), 0);
    assert.equal(fake.requests.at(-1).path, '/sap-cloud/api/artifacts');
    assert.equal(fake.requests.at(-1).body.content.openapi, '3.1.0');
    capture = io();
    assert.equal(await runArtifact(['validate', '--artifact', 'art_1'], capture.value), 0);
    assert.ok(capture.out.some((line) => line.includes('校验：通过')));
    capture = io();
    assert.equal(await runArtifact(['publish', '--artifact', 'art_1', '--by', 'owner', '--reason', '确认契约'], capture.value), 0);
    assert.equal(fake.requests.at(-1).body.reason, '确认契约');
    capture = io();
    assert.equal(await runArtifact(['doc', '--artifact', 'art_1'], capture.value), 0);
    assert.equal(capture.out[0], `${fake.url}/sap-cloud/api/artifacts/art_1/document`);
  } finally {
    delete process.env.CENTER_URL; fs.rmSync(file, { force: true });
    await new Promise((resolve) => fake.server.close(resolve));
  }
});
