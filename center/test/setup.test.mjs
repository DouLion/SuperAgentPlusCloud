// Center 配置与设置服务测试（T10）。
// 覆盖三层合并、原子写、初始化/更新、校验、密钥不回显与 HTTP 路由。
// 运行：node --test center/test/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/store.mjs';
import { createServer } from '../src/server.mjs';
import {
  readConfigFile,
  writeConfigFile,
  resolveConfig,
  llmConfig,
  aiConfigured,
  config,
} from '../src/config.mjs';
import { setupStatus, initSetup, updateSetup } from '../src/setup.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sap-setup-test-'));
const configPath = path.join(dir, 'config.json');
const env = { SAP_CONFIG_PATH: configPath, SAP_WEB_DIST: path.join(dir, 'web') };

const originalConfigPath = process.env.SAP_CONFIG_PATH;

test.after(() => {
  if (originalConfigPath === undefined) delete process.env.SAP_CONFIG_PATH;
  else process.env.SAP_CONFIG_PATH = originalConfigPath;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readConfigFile：不存在返回 exists:false', () => {
  const result = readConfigFile(env);
  assert.equal(result.exists, false);
  assert.deepEqual(result.values, {});
});

test('writeConfigFile：原子写并合并默认值', () => {
  const written = writeConfigFile({ port: 9000, llm: { model: 'm1' } }, env);
  assert.equal(written, configPath);
  assert.ok(fs.existsSync(configPath));
  const stored = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(stored.version, 1);
  assert.equal(stored.port, 9000);
  assert.equal(stored.llm.model, 'm1');
  assert.equal(stored.llm.base_url, '');
  assert.equal(stored.host, '127.0.0.1');
  assert.equal(stored.db.type, 'sqlite');
});

test('resolveConfig：配置文件 < 环境变量，db.path 相对 center 解析', () => {
  const fromFile = resolveConfig(env);
  assert.equal(fromFile.port, 9000);
  assert.equal(fromFile.llm.model, 'm1');
  assert.equal(fromFile.initialized, false);
  assert.ok(path.isAbsolute(fromFile.db.path));

  const overridden = resolveConfig({ ...env, CENTER_PORT: '9100', CENTER_DB: path.join(dir, 'x.db') });
  assert.equal(overridden.port, 9100);
  assert.equal(overridden.db.path, path.join(dir, 'x.db'));
});

test('resolveConfig：db.path 兼容 center/data/center.db 写法', () => {
  writeConfigFile({ db: { path: 'data/other.db' } }, env);
  const plain = resolveConfig(env).db.path;

  writeConfigFile({ db: { path: 'center/data/other.db' } }, env);
  const prefixed = resolveConfig(env).db.path;

  assert.equal(prefixed, plain);
  assert.ok(prefixed.endsWith(path.join('center', 'data', 'other.db')));
  assert.equal(prefixed.includes(`${path.sep}center${path.sep}center${path.sep}`), false);
});

test('llmConfig / aiConfigured 跟随配置文件与环境变量', () => {
  writeConfigFile({ llm: { base_url: 'https://llm.example', api_key: 'secret', model: 'm2' } }, env);
  assert.equal(llmConfig(env).api_key, 'secret');
  assert.equal(aiConfigured(env), true);
  assert.equal(llmConfig({ ...env, SAP_LLM_API_KEY: 'other' }).api_key, 'other');
  assert.equal(llmConfig({ ...env, SAP_LLM_MODEL: 'override' }).model, 'override');

  writeConfigFile({ llm: { base_url: '', api_key: '', model: 'm2' } }, env);
  assert.equal(aiConfigured(env), false);
  assert.equal(
    aiConfigured({ ...env, SAP_LLM_BASE_URL: 'https://x', SAP_LLM_API_KEY: 'k' }),
    true,
  );
});

test('setupStatus：字段完整且不回显 api_key', () => {
  const secret = 'sk-do-not-leak';
  writeConfigFile({ llm: { base_url: 'https://llm.example', api_key: secret, model: 'm3' } }, env);
  const status = setupStatus(env);
  assert.equal(status.initialized, false);
  assert.equal(status.config_exists, true);
  assert.equal(status.config_path, configPath);
  assert.equal(status.llm.configured, true);
  assert.equal(status.llm.model, 'm3');
  assert.deepEqual(status.needs_restart, []);
  assert.equal(JSON.stringify(status).includes(secret), false);
});

test('initSetup：写入 initialized:true 与默认配置', () => {
  // 模拟首次运行：先删除已有配置文件。
  fs.rmSync(configPath, { force: true });
  const status = initSetup({ initialized: true }, env);
  assert.equal(status.initialized, true);
  const stored = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(stored.initialized, true);
  assert.equal(stored.port, 8787);
  assert.equal(stored.db.type, 'sqlite');
});

test('updateSetup：模型立即可用，端口变更需重启', () => {
  const modelUpdate = updateSetup(
    { llm: { base_url: 'https://llm.example', api_key: 'k', model: 'instant' } },
    env,
  );
  assert.deepEqual(modelUpdate.needs_restart, []);
  assert.equal(modelUpdate.status.llm.configured, true);
  assert.equal(llmConfig(env).model, 'instant');

  const portUpdate = updateSetup({ port: 9300 }, env);
  assert.deepEqual(portUpdate.needs_restart, ['port']);
  assert.equal(portUpdate.status.port, 9300);
});

test('校验：非法值抛 400 + code', () => {
  const cases = [
    [{ port: 0 }, 'INVALID_PORT'],
    [{ port: 70000 }, 'INVALID_PORT'],
    [{ db: { type: 'oracle' } }, 'UNSUPPORTED_DB_TYPE'],
    [{ db: { path: '' } }, 'INVALID_DB_PATH'],
    [{ llm: { timeout_ms: 0 } }, 'INVALID_TIMEOUT'],
  ];
  for (const [values, code] of cases) {
    assert.throws(() => initSetup(values, env), (err) => {
      assert.equal(err.status, 400);
      assert.equal(err.code, code);
      return true;
    });
  }
});

test('校验：postgres / mysql 可保存，但运行期仍只支持 sqlite', async () => {
  // 允许提前规划，因此保存不报错。
  const status = initSetup({ db: { type: 'postgres', path: 'pg-placeholder' } }, env);
  assert.equal(status.db_type, 'postgres');

  const { openStore } = await import('../src/db/store.mjs');
  assert.throws(
    () => openStore(path.join(os.tmpdir(), `sap-pg-${process.pid}.db`), { type: 'postgres' }),
    (err) => err.code === 'UNSUPPORTED_DB_TYPE',
  );
});

test('HTTP：/setup/status 不泄漏密钥，/setup/init 与 /setup 可用', async () => {
  process.env.SAP_CONFIG_PATH = configPath;
  const dbPath = path.join(dir, 'center.db');
  const db = openStore(dbPath);
  const server = createServer(db);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}/sap-cloud/api`;
  const secret = 'sk-http-secret';

  try {
    writeConfigFile(
      { initialized: false, llm: { base_url: 'https://llm.example', api_key: secret, model: 'm4' } },
      env,
    );

    const statusResponse = await fetch(`${base}/setup/status`);
    assert.equal(statusResponse.status, 200);
    const statusBody = await statusResponse.json();
    assert.equal(statusBody.initialized, false);
    assert.equal(statusBody.llm.configured, true);
    assert.equal(JSON.stringify(statusBody).includes(secret), false);

    const initResponse = await fetch(`${base}/setup/init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initialized: true }),
    });
    assert.equal(initResponse.status, 200);
    const initBody = await initResponse.json();
    assert.equal(initBody.initialized, true);
    assert.equal(JSON.stringify(initBody).includes(secret), false);

    const updateResponse = await fetch(`${base}/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ llm: { base_url: 'https://new.example', model: 'm5' }, port: 9400 }),
    });
    assert.equal(updateResponse.status, 200);
    const updateBody = await updateResponse.json();
    assert.equal(updateBody.status.llm.model, 'm5');
    assert.ok(updateBody.needs_restart.includes('port'));
    assert.equal(llmConfig(env).base_url, 'https://new.example');

    const badResponse = await fetch(`${base}/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ db: { type: 'oracle' } }),
    });
    assert.equal(badResponse.status, 400);
    const badBody = await badResponse.json();
    assert.equal(badBody.code, 'UNSUPPORTED_DB_TYPE');
  } finally {
    server.closeIdleConnections?.();
    await new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test('config 快照保留既有字段名', () => {
  assert.equal(typeof config.port, 'number');
  assert.equal(typeof config.host, 'string');
  assert.equal(typeof config.db_path, 'string');
  assert.equal(typeof config.web_dist, 'string');
  assert.equal(typeof config.llm.model, 'string');
});
