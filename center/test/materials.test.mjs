// 材料与提取测试（C 枝）：注入假模型，验证草稿落库、出处校验、采纳与拒绝规则。
// 运行：node --test center/test/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openStore,
  createProject,
  createMaterial,
  listMaterials,
  listExtractions,
  acceptExtraction,
  rejectExtraction,
  getRequirement,
  listRequirements,
  listConventionPacks,
} from '../src/store.mjs';
import { extractFromMaterial } from '../src/ai/materials.mjs';

const dbPath = path.join(os.tmpdir(), `sap-materials-test-${process.pid}-${Date.now()}.db`);
const ENV_KEYS = ['SAP_LLM_BASE_URL', 'SAP_LLM_API_KEY', 'SAP_LLM_MODEL', 'SAP_LLM_TIMEOUT_MS'];
const originalEnv = {};
const originalFetch = globalThis.fetch;
const ISOLATED_CONFIG = path.join(os.tmpdir(), `sap-materials-config-${process.pid}.json`);

let db;
let project;

test.before(() => {
  db = openStore(dbPath);
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
  originalEnv.SAP_CONFIG_PATH = process.env.SAP_CONFIG_PATH;
  process.env.SAP_CONFIG_PATH = ISOLATED_CONFIG;
  fs.rmSync(ISOLATED_CONFIG, { force: true });
  project = createProject(db, { name: `材料项目-${Date.now()}` });
});

test.after(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  if (originalEnv.SAP_CONFIG_PATH === undefined) delete process.env.SAP_CONFIG_PATH;
  else process.env.SAP_CONFIG_PATH = originalEnv.SAP_CONFIG_PATH;
  fs.rmSync(ISOLATED_CONFIG, { force: true });
  globalThis.fetch = originalFetch;
  db.close();
  fs.rmSync(dbPath, { force: true });
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

function configureModel() {
  process.env.SAP_LLM_BASE_URL = 'https://llm.example';
  process.env.SAP_LLM_API_KEY = 'test-key';
  process.env.SAP_LLM_MODEL = 'test-model';
  process.env.SAP_LLM_TIMEOUT_MS = '5000';
}

function unconfigureModel() {
  delete process.env.SAP_LLM_BASE_URL;
  delete process.env.SAP_LLM_API_KEY;
}

function fakeModel(payload) {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(payload) } }],
    }),
  });
}

function seedMaterial() {
  return createMaterial(db, {
    project_id: project.project_id,
    title: '需求评审会纪要',
    kind: 'meeting',
    content: '会上确定：导出功能要先冻结接口；另外要统一响应格式。',
    created_by: '张三',
  });
}

const GOOD = {
  requirements: [
    {
      raw_text: '导出功能先冻结接口再实现',
      claimed_level: 'L1',
      claimed_reason: '涉及对外接口',
      source_quote: '会上确定：导出功能要先冻结接口',
    },
  ],
  conventions: [
    {
      name: '统一响应格式',
      description: '所有接口返回统一包络',
      rules: [
        {
          key: 'api.response',
          title: '统一响应包络',
          severity: 'must',
          value: { fields: ['status', 'message', 'data'] },
          rationale: '会上确认',
        },
      ],
      source_quote: '另外要统一响应格式',
    },
  ],
  decisions: [
    {
      question: '先做导出还是先做导入',
      options: ['导出', '导入'],
      chosen: '导出',
      rationale: '导出需求更急',
      source_quote: '会上确定：导出功能要先冻结接口',
    },
  ],
  uncertainties: ['导入的时间点未定'],
};

test('材料：原文保留，可按项目列出', () => {
  const material = seedMaterial();
  assert.equal(material.kind, 'meeting');
  assert.match(material.content, /冻结接口/);
  const rows = listMaterials(db, { project_id: project.project_id });
  assert.ok(rows.some((row) => row.material_id === material.material_id));
});

test('提取：三类草稿落库，且不创建正式需求/约定', async () => {
  configureModel();
  fakeModel(GOOD);
  const material = seedMaterial();
  const before = listRequirements(db, { project_id: project.project_id }).length;

  const result = await extractFromMaterial(db, material, { created_by: '张三' });
  assert.equal(result.extractions.length, 3);
  assert.ok(result.extractions.every((row) => row.status === 'draft'));
  assert.deepEqual(result.uncertainties, ['导入的时间点未定']);

  const kinds = result.extractions.map((row) => row.kind).sort();
  assert.deepEqual(kinds, ['convention', 'decision', 'requirement']);

  // 未创建正式对象
  assert.equal(listRequirements(db, { project_id: project.project_id }).length, before);
  assert.equal(listConventionPacks(db, { project_id: project.project_id }).length, 0);
});

test('提取：缺 source_quote 视为无出处推断，拒绝入库', async () => {
  configureModel();
  fakeModel({
    requirements: [{ raw_text: '没有出处的需求' }],
    conventions: [],
    decisions: [],
  });
  const material = seedMaterial();
  await assert.rejects(
    () => extractFromMaterial(db, material, { created_by: '张三' }),
    (err) => err.code === 'AI_BAD_RESPONSE' && /source_quote/.test(err.message),
  );
});

test('提取：未配置模型返回 AI_NOT_CONFIGURED', async () => {
  unconfigureModel();
  const material = seedMaterial();
  await assert.rejects(
    () => extractFromMaterial(db, material, { created_by: '张三' }),
    (err) => err.code === 'AI_NOT_CONFIGURED' && err.status === 503,
  );
});

test('采纳需求：生成带 material 来源的需求，重复采纳被拒', async () => {
  configureModel();
  fakeModel(GOOD);
  const material = seedMaterial();
  const { extractions } = await extractFromMaterial(db, material, { created_by: '张三' });
  const target = extractions.find((row) => row.kind === 'requirement');

  const result = acceptExtraction(db, target.extraction_id, { actor: '李四' });
  assert.equal(result.kind, 'requirement');
  const requirement = getRequirement(db, result.created.requirement_id);
  assert.equal(requirement.source_ref, `material:${material.material_id}`);
  assert.equal(requirement.raw_text, '导出功能先冻结接口再实现');
  assert.equal(result.extraction.status, 'accepted');
  assert.equal(result.extraction.accepted_ref, requirement.requirement_id);

  assert.throws(
    () => acceptExtraction(db, target.extraction_id, { actor: '李四' }),
    (err) => err.code === 'EXTRACTION_ALREADY_ACCEPTED',
  );
});

test('采纳约定：生成项目约定包草稿，不自动激活', async () => {
  configureModel();
  fakeModel(GOOD);
  const material = seedMaterial();
  const { extractions } = await extractFromMaterial(db, material, { created_by: '张三' });
  const target = extractions.find((row) => row.kind === 'convention');

  const result = acceptExtraction(db, target.extraction_id, { actor: '李四' });
  assert.equal(result.kind, 'convention');
  const pack = listConventionPacks(db, { project_id: project.project_id })
    .find((row) => row.pack_id === result.created.pack_id);
  assert.equal(pack.scope, 'project');
  assert.equal(pack.status, 'draft');
  assert.equal(pack.rules.length, 1);
});

test('采纳决定：生成承载需求并标记 pending_decision', async () => {
  configureModel();
  fakeModel(GOOD);
  const material = seedMaterial();
  const { extractions } = await extractFromMaterial(db, material, { created_by: '张三' });
  const target = extractions.find((row) => row.kind === 'decision');

  const result = acceptExtraction(db, target.extraction_id, { actor: '李四' });
  assert.equal(result.kind, 'decision');
  const requirement = getRequirement(db, result.created.requirement_id);
  assert.equal(requirement.raw_text, '先做导出还是先做导入');
  assert.equal(result.extraction.payload.pending_decision.chosen, '导出');
});

test('拒绝：理由必填，拒绝后不能采纳', async () => {
  configureModel();
  fakeModel(GOOD);
  const material = seedMaterial();
  const { extractions } = await extractFromMaterial(db, material, { created_by: '张三' });
  const target = extractions[0];

  assert.throws(() => rejectExtraction(db, target.extraction_id, { actor: '李四' }), /reason/);

  const rejected = rejectExtraction(db, target.extraction_id, { actor: '李四', reason: '只是讨论' });
  assert.equal(rejected.status, 'rejected');
  assert.throws(
    () => acceptExtraction(db, target.extraction_id, { actor: '李四' }),
    (err) => err.code === 'EXTRACTION_REJECTED',
  );
});

test('提取：可按 kinds 只取需求', async () => {
  configureModel();
  fakeModel(GOOD);
  const material = seedMaterial();
  const result = await extractFromMaterial(db, material, { created_by: '张三', kinds: ['requirement'] });
  assert.equal(result.extractions.length, 1);
  assert.equal(result.extractions[0].kind, 'requirement');
  const all = listExtractions(db, { material_id: material.material_id });
  assert.ok(all.length >= 1);
});
