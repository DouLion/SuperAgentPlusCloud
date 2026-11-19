// sap repo 命令测试：路径、输出与错误透出。

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { run } from '../src/commands/repo.mjs';

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

test('repo add：发送名称、地址与默认分支', async () => {
  let received;
  const { server, url } = await startServer((req, res) => {
    received = { method: req.method, url: req.url };
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      repository_id: 'repo_1', name: '前端', url: 'https://github.com/acme/web', provider: 'github',
      default_branch: 'main', status: 'active',
    }));
  });
  const sink = collect();
  try {
    const code = await run(
      ['add', '--project', 'prj_1', '--name', '前端', '--url', 'https://github.com/acme/web', '--branch', 'main'],
      { ...sink.io, url },
    );
    assert.equal(code, 0);
    assert.equal(received.method, 'POST');
    assert.equal(received.url, '/sap-cloud/api/projects/prj_1/repositories');
    assert.match(sink.lines.join('\n'), /repo_1/);
    assert.match(sink.lines.join('\n'), /前端/);
  } finally {
    server.close();
  }
});

test('repo list：带 summary 查询并打印提交数', async () => {
  let query;
  const { server, url } = await startServer((req, res) => {
    query = req.url;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([{
      repository_id: 'repo_1', name: '前端', url: 'https://github.com/acme/web', provider: 'github',
      status: 'active', commit_count: 3, last_commit_at: '2026-11-19T00:00:00.000Z', refs: ['refs/heads/main'],
    }]));
  });
  const sink = collect();
  try {
    const code = await run(['list', '--project', 'prj_1'], { ...sink.io, url });
    assert.equal(code, 0);
    assert.match(query, /summary=1/);
    const text = sink.lines.join('\n');
    assert.match(text, /提交事实：3/);
    assert.match(text, /refs\/heads\/main/);
  } finally {
    server.close();
  }
});

test('repo commits：打印提交号与分支', async () => {
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      repository_id: 'repo_1',
      facts: [{
        fact_id: 'fact_1', source: 'git', kind: 'commit', external_id: 'abc123456789',
        payload: { commit_sha: 'abc123456789', ref: 'refs/heads/main', message: 'feat: 登录' },
        received_at: '2026-11-19T00:00:00.000Z',
      }],
    }));
  });
  const sink = collect();
  try {
    const code = await run(['commits', '--repo', 'repo_1'], { ...sink.io, url });
    assert.equal(code, 0);
    const text = sink.lines.join('\n');
    assert.match(text, /abc123456789/);
    assert.match(text, /refs\/heads\/main/);
    assert.match(text, /feat: 登录/);
  } finally {
    server.close();
  }
});

test('repo：未知子命令给出用法并非零退出', async () => {
  const sink = collect();
  const code = await run(['nope'], sink.io);
  assert.equal(code, 1);
  assert.match(sink.errors.join('\n'), /用法/);
});
