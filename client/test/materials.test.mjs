// Client material 命令测试（C 枝）：请求路径、输出与错误透出。

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { run } from '../src/commands/material.mjs';

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

test('material add：提交原文并打印材料 ID', async () => {
  const { server, url } = await startServer((req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/sap-cloud/api/materials');
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      assert.equal(body.project_id, 'prj_1');
      assert.equal(body.kind, 'meeting');
      assert.match(body.content, /冻结接口/);
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        material_id: 'mat_1', project_id: 'prj_1', title: body.title,
        kind: body.kind, created_at: '2026-01-01T00:00:00.000Z',
      }));
    });
  });
  const sink = collect();
  try {
    const code = await run(
      ['add', '--project', 'prj_1', '--title', '纪要', '--kind', 'meeting', '--text', '会上确定：导出功能要先冻结接口', '--by', '张三'],
      { ...sink.io, url },
    );
    assert.equal(code, 0);
    assert.match(sink.lines.join('\n'), /mat_1/);
  } finally {
    server.close();
  }
});

test('material extract：打印三类草稿与出处', async () => {
  const { server, url } = await startServer((req, res) => {
    assert.equal(req.url, '/sap-cloud/api/materials/mat_1/extract');
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      uncertainties: ['导入时间未定'],
      extractions: [
        {
          extraction_id: 'ext_1', kind: 'requirement', status: 'draft',
          payload: { raw_text: '先冻结接口', claimed_level: 'L1', source_quote: '会上确定：先冻结接口' },
        },
        {
          extraction_id: 'ext_2', kind: 'convention', status: 'draft',
          payload: {
            name: '统一响应',
            rules: [{ key: 'api.response', title: '统一包络', severity: 'must' }],
            source_quote: '统一响应格式',
          },
        },
      ],
    }));
  });
  const sink = collect();
  try {
    const code = await run(['extract', '--material', 'mat_1', '--by', '张三'], { ...sink.io, url });
    assert.equal(code, 0);
    const text = sink.lines.join('\n');
    assert.match(text, /2 条草稿/);
    assert.match(text, /先冻结接口/);
    assert.match(text, /api\.response/);
    assert.match(text, /出处：统一响应格式/);
    assert.match(text, /导入时间未定/);
  } finally {
    server.close();
  }
});

test('material accept：打印生成的正式对象', async () => {
  const { server, url } = await startServer((req, res) => {
    assert.equal(req.url, '/sap-cloud/api/material-extractions/ext_1/accept');
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      kind: 'requirement',
      extraction: { extraction_id: 'ext_1', status: 'accepted' },
      created: { requirement_id: 'req_9' },
    }));
  });
  const sink = collect();
  try {
    const code = await run(['accept', '--extraction', 'ext_1', '--by', '李四'], { ...sink.io, url });
    assert.equal(code, 0);
    assert.match(sink.lines.join('\n'), /req_9/);
  } finally {
    server.close();
  }
});

test('material：未配置模型时透出 503 提示', async () => {
  const { server, url } = await startServer((req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, code: 'AI_NOT_CONFIGURED', error: 'Center 未配置模型' }));
  });
  const sink = collect();
  try {
    const code = await run(['extract', '--material', 'mat_1', '--by', '张三'], { ...sink.io, url });
    assert.equal(code, 1);
    assert.match(sink.errors.join('\n'), /未配置模型/);
  } finally {
    server.close();
  }
});

test('material：缺少必填参数时给出用法并非零退出', async () => {
  const sink = collect();
  const code = await run(['add'], { ...sink.io, url: 'http://127.0.0.1:1' });
  assert.equal(code, 1);
  assert.match(sink.errors.join('\n'), /缺少 --/);
});
