// Client G 枝命令测试：事实、任务关联、订阅。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { run as runFact } from '../src/commands/fact.mjs';
import { run as runTask } from '../src/commands/task.mjs';
import { run as runSubscribe } from '../src/commands/subscribe.mjs';

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

test('fact add：读取 payload 文件并打印幂等结果', async () => {
  const payloadPath = path.join(os.tmpdir(), `sap-payload-${Date.now()}.json`);
  fs.writeFileSync(payloadPath, JSON.stringify({ commit_sha: 'abc', ref: 'main' }));

  const { server, url } = await startServer((req, res) => {
    assert.equal(req.url, '/sap-cloud/api/integrations/git/facts');
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      fact: { fact_id: 'fact_1', source: 'git', kind: 'commit', external_id: 'abc' },
      deduplicated: false,
      note: '外部事实仅为证据，不代表任务完成',
    }));
  });
  const sink = collect();
  try {
    const code = await runFact([
      'add', '--project', 'prj_1', '--source', 'git', '--kind', 'commit',
      '--external-id', 'abc', '--file', payloadPath,
    ], { ...sink.io, url });
    assert.equal(code, 0);
    assert.match(sink.lines.join('\n'), /fact_1/);
    assert.match(sink.lines.join('\n'), /不代表任务完成/);
  } finally {
    server.close();
    fs.unlinkSync(payloadPath);
  }
});

test('fact list 空态与 task facts 空态', async () => {
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.startsWith('/sap-cloud/api/integrations/facts')) res.end('[]');
    else res.end(JSON.stringify({ task_id: 'task_1', facts: [], note: '外部事实仅为证据，不代表任务完成' }));
  });
  try {
    const factSink = collect();
    assert.equal(await runFact(['list'], { ...factSink.io, url }), 0);
    assert.match(factSink.lines.join('\n'), /还没有外部事实/);

    const taskSink = collect();
    assert.equal(await runTask(['facts', '--task', 'task_1'], { ...taskSink.io, url }), 0);
    assert.match(taskSink.lines.join('\n'), /还没有关联的外部事实/);
  } finally {
    server.close();
  }
});

test('task link-facts：缺少 --fact 时非零退出', async () => {
  const sink = collect();
  const code = await runTask(['link-facts', '--task', 'task_1'], { ...sink.io, url: 'http://127.0.0.1:1' });
  assert.equal(code, 1);
  assert.match(sink.errors.join('\n'), /缺少 --fact/);
});

test('subscribe list：打印订阅与 topic', async () => {
  const { server, url } = await startServer((req, res) => {
    assert.equal(req.url, '/sap-cloud/api/outbox/subscriptions');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([{
      subscription_id: 'sub_1', url: 'http://hook', topics: ['fact.received'], disabled_at: null,
    }]));
  });
  const sink = collect();
  try {
    const code = await runSubscribe(['list'], { ...sink.io, url });
    assert.equal(code, 0);
    assert.match(sink.lines.join('\n'), /sub_1/);
    assert.match(sink.lines.join('\n'), /fact\.received/);
  } finally {
    server.close();
  }
});
