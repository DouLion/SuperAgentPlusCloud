// sap verify 命令测试：核对结果输出与错误透出。

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { run } from '../src/commands/verify.mjs';

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      url: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

function collect() {
  const lines = [];
  const errors = [];
  return {
    lines,
    errors,
    io: { stdout: (line) => lines.push(String(line)), stderr: (line) => errors.push(String(line)) },
  };
}

test('verify：打印已核对与未找到', async () => {
  let seen;
  const { server, url } = await startServer((req, res) => {
    seen = { method: req.method, url: req.url };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      verified: [{ hash: 'abc123456789', repository_id: 'repo_1' }],
      unverified: [{ hash: 'deadbeef', reason: 'NOT_FOUND' }],
      checked_at: '2026-11-19T00:00:00.000Z',
    }));
  });
  const sink = collect();
  try {
    const code = await run(['--submission', 'sub_1'], { ...sink.io, url });
    assert.equal(code, 0);
    assert.equal(seen.method, 'POST');
    assert.equal(seen.url, '/sap-cloud/api/submissions/sub_1/verify-commits');
    const text = sink.lines.join('\n');
    assert.match(text, /已核对\s+abc123456789/);
    assert.match(text, /未找到\s+deadbeef/);
  } finally {
    server.close();
  }
});

test('verify：缺少 --submission 时非零退出', async () => {
  const sink = collect();
  const code = await run([], sink.io);
  assert.equal(code, 1);
  assert.match(sink.errors.join('\n'), /submission/);
});
