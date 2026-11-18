// Center AI 建议测试（T8）：注入假 fetch（monkeypatch globalThis.fetch），
// 验证未配置降级、JSON 容错解析、落库留档、校验失败与“不改变需求状态”。
// 运行：node --test center/test/
// 测试数据库使用系统临时目录，结束后删除。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openStore,
  createProject,
  createRequirement,
  createTrunkItem,
  createTrunkChange,
  getRequirement,
  listAiSuggestions,
  listImpactItems,
} from '../src/store.mjs';
import {
  proposeTasks,
  suggestAssessment,
  suggestImpacts,
} from '../src/ai/advisor.mjs';
import { createServer } from '../src/server.mjs';

const dbPath = path.join(
  os.tmpdir(),
  `sap-center-ai-test-${process.pid}-${Date.now()}.db`,
);

const ENV_KEYS = ['SAP_LLM_BASE_URL', 'SAP_LLM_API_KEY', 'SAP_LLM_MODEL', 'SAP_LLM_TIMEOUT_MS'];
const originalEnv = {};
const originalFetch = globalThis.fetch;

let db;

test.before(() => {
  db = openStore(dbPath);
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
});

test.after(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  globalThis.fetch = originalFetch;
  db.close();
  fs.rmSync(dbPath, { force: true });
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** 配置一个可用的假模型。 */
function configureModel() {
  process.env.SAP_LLM_BASE_URL = 'https://llm.example';
  process.env.SAP_LLM_API_KEY = 'test-key';
  process.env.SAP_LLM_MODEL = 'test-model';
}

/** 清空模型配置。 */
function unconfigureModel() {
  delete process.env.SAP_LLM_BASE_URL;
  delete process.env.SAP_LLM_API_KEY;
  delete process.env.SAP_LLM_MODEL;
  delete process.env.SAP_LLM_TIMEOUT_MS;
}

/** 注入假 fetch；handler 返回 { status, body }。 */
function mockFetch(handler) {
  globalThis.fetch = async (url, init) => {
    const request = {
      url: String(url),
      method: init && init.method,
      headers: init && init.headers,
      body: init && init.body ? JSON.parse(init.body) : null,
    };
    const result = handler(request);
    return new Response(JSON.stringify(result.body ?? {}), {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

/** 生成一段 OpenAI 兼容的假响应。 */
function contentResponse(content) {
  return { body: { choices: [{ message: { content } }] } };
}

/** 建项目与需求。 */
function seed() {
  const project = createProject(db, { name: 'T8 AI 项目' });
  const requirement = createRequirement(db, {
    project_id: project.project_id,
    raw_text: '希望支持按项目导出需求清单',
    author: 'alice',
    claimed_level: 'L2',
  });
  return { project, requirement };
}

/** 建一个 active 主干条目。 */
function activeItem(projectId, statement = '当前有效范围：仅内部使用') {
  return createTrunkItem(db, {
    project_id: projectId,
    kind: 'scope',
    statement,
    status: 'active',
    confirmed_by: 'owner',
    confirmed_at: '2026-11-18T00:00:00.000Z',
  });
}

test('AI：未配置模型时抛 AI_NOT_CONFIGURED（503）且不落库', async () => {
  unconfigureModel();
  const { project, requirement } = seed();

  await assert.rejects(
    () => suggestAssessment(db, requirement.requirement_id),
    (error) => {
      assert.equal(error.code, 'AI_NOT_CONFIGURED');
      assert.equal(error.status, 503);
      assert.match(error.message, /未配置模型/);
      return true;
    },
  );
  assert.equal(listAiSuggestions(db, { project_id: project.project_id }).length, 0);
});

test('AI：正常返回解析出 draft 并写入 ai_suggestions 留档', async () => {
  configureModel();
  const { project, requirement } = seed();
  const item = activeItem(project.project_id);

  mockFetch(() => contentResponse(JSON.stringify({
    assessed_level: 'L2',
    related_item_ids: [item.item_id, 'item_unknown'],
    impact_summary: '影响导出模块',
    uncertainties: ['数据量未知'],
    proposed_action: 'relevel',
  })));

  const { suggestion, draft } = await suggestAssessment(db, requirement.requirement_id);

  assert.equal(draft.assessed_level, 'L2');
  assert.equal(draft.proposed_action, 'relevel');
  // 未给出的条目 id 被过滤，只保留给出的 active 条目。
  assert.deepEqual(draft.related_item_ids, [item.item_id]);
  assert.deepEqual(draft.uncertainties, ['数据量未知']);

  assert.match(suggestion.suggestion_id, /^sug_/);
  assert.equal(suggestion.kind, 'assessment');
  assert.equal(suggestion.project_id, project.project_id);
  assert.equal(suggestion.requirement_id, requirement.requirement_id);
  assert.equal(suggestion.model, 'test-model');
  assert.ok(suggestion.raw_response.includes('assessed_level'));

  const rows = listAiSuggestions(db, {
    project_id: project.project_id,
    requirement_id: requirement.requirement_id,
    kind: 'assessment',
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].suggestion_id, suggestion.suggestion_id);
  assert.deepEqual(rows[0].payload, draft);

  // AI 建议不得改变需求状态。
  assert.equal(getRequirement(db, requirement.requirement_id).status, 'submitted');
});

test('AI：代码块包裹的 JSON 也能解析', async () => {
  configureModel();
  const { project, requirement } = seed();
  const item = activeItem(project.project_id, '导出范围条目');

  const payload = JSON.stringify({
    assessed_level: 'L3',
    related_item_ids: [item.item_id],
    impact_summary: '局部导出行为',
    uncertainties: [],
    proposed_action: 'accept',
  });
  mockFetch(() => contentResponse(`好的，评估如下：\n\`\`\`json\n${payload}\n\`\`\`\n以上。`));

  const { draft } = await suggestAssessment(db, requirement.requirement_id);
  assert.equal(draft.assessed_level, 'L3');
  assert.deepEqual(draft.related_item_ids, [item.item_id]);
});

test('AI：非法 JSON 抛 AI_BAD_RESPONSE（502）并留档原始响应', async () => {
  configureModel();
  const { project, requirement } = seed();

  mockFetch(() => contentResponse('这不是 JSON，也没有代码块'));
  await assert.rejects(
    () => suggestAssessment(db, requirement.requirement_id),
    (error) => {
      assert.equal(error.code, 'AI_BAD_RESPONSE');
      assert.equal(error.status, 502);
      return true;
    },
  );

  // 解析失败也要能看到原文（docs/06 §3.4）。
  const archived = listAiSuggestions(db, {
    project_id: project.project_id,
    kind: 'assessment',
  });
  assert.equal(archived.length, 1);
  assert.equal(archived[0].raw_response, '这不是 JSON，也没有代码块');
  assert.match(archived[0].payload.error, /无法从模型响应中提取 JSON/);
});

test('AI：网络错误抛 AI_REQUEST_FAILED（502）且消息带原因', async () => {
  configureModel();
  const { requirement } = seed();

  globalThis.fetch = async () => {
    throw new Error('socket hangup');
  };
  await assert.rejects(
    () => suggestAssessment(db, requirement.requirement_id),
    (error) => {
      assert.equal(error.code, 'AI_REQUEST_FAILED');
      assert.equal(error.status, 502);
      assert.match(error.message, /socket hangup/);
      return true;
    },
  );
});

test('AI：proposeTasks 缺少 done_when 时抛 AI_BAD_RESPONSE', async () => {
  configureModel();
  const { project, requirement } = seed();
  const item = activeItem(project.project_id);

  mockFetch(() => contentResponse(JSON.stringify([
    { purpose: '实现导出', serves_item_ids: [item.item_id] },
  ])));
  await assert.rejects(
    () => proposeTasks(db, requirement.requirement_id),
    (error) => {
      assert.equal(error.code, 'AI_BAD_RESPONSE');
      assert.equal(error.status, 502);
      assert.match(error.message, /done_when/);
      return true;
    },
  );

  // 缺少关联且未标注探索的任务同样不合法。
  mockFetch(() => contentResponse(JSON.stringify([
    { purpose: '无关联任务', done_when: ['可检验'] },
  ])));
  await assert.rejects(
    () => proposeTasks(db, requirement.requirement_id),
    (error) => {
      assert.equal(error.code, 'AI_BAD_RESPONSE');
      assert.match(error.message, /探索任务/);
      return true;
    },
  );
});

test('AI：proposeTasks 正常草稿落库，需求状态保持 submitted', async () => {
  configureModel();
  const { project, requirement } = seed();
  const item = activeItem(project.project_id);

  mockFetch(() => contentResponse(JSON.stringify([
    {
      purpose: '实现按项目导出',
      done_when: ['接口返回需求列表', '空项目返回空数组'],
      scope: '仅导出接口',
      non_scope: '不做导出调度',
      serves_item_ids: [item.item_id, 'item_unknown'],
    },
    {
      purpose: '确认导出权限边界',
      done_when: ['给出结论或提出追问'],
      related_question: '导出是否包含归档项目',
    },
  ])));

  const { suggestion, draft } = await proposeTasks(db, requirement.requirement_id);
  assert.equal(draft.length, 2);
  assert.deepEqual(draft[0].serves_item_ids, [item.item_id]);
  assert.equal(draft[0].done_when.length, 2);
  assert.equal(draft[1].related_question, '导出是否包含归档项目');
  assert.equal(suggestion.kind, 'task_plan');
  assert.equal(listAiSuggestions(db, { project_id: project.project_id, kind: 'task_plan' }).length, 1);
  assert.equal(getRequirement(db, requirement.requirement_id).status, 'submitted');
});

test('AI：suggestImpacts 只给候选，不写 impact_items', async () => {
  configureModel();
  const { project, requirement } = seed();
  const oldItem = activeItem(project.project_id, '旧范围：仅内部使用');
  const change = createTrunkChange(db, {
    project_id: project.project_id,
    trigger_requirement_id: requirement.requirement_id,
    reason: '范围需要对外开放',
    old_item_ids: [oldItem.item_id],
  });

  let captured;
  mockFetch((request) => {
    captured = request.body;
    return contentResponse(JSON.stringify([
      { target_type: 'task', target_id: 'task_a', reason: '该任务依赖旧范围' },
      { target_type: 'document', target_id: 'doc_a', reason: '文档引用旧表述' },
      { target_type: 'task', target_id: 'task_a', reason: '重复项应去重' },
    ]));
  });

  const { suggestion, draft } = await suggestImpacts(db, change.change_id);
  assert.equal(draft.length, 2);
  assert.equal(draft[0].target_type, 'task');
  assert.equal(draft[0].target_id, 'task_a');
  assert.equal(suggestion.kind, 'impact');
  assert.equal(suggestion.change_id, change.change_id);

  // 提示词带上了旧条目，便于模型给出有依据的候选。
  const promptText = JSON.stringify(captured.messages);
  assert.ok(promptText.includes(oldItem.statement));

  // 只给候选，不登记影响项。
  assert.equal(listImpactItems(db, change.change_id).length, 0);
});

test('AI：HTTP 未配置时 health 为 false，advice 返回 503 且核心链可用', async () => {
  unconfigureModel();
  const { requirement } = seed();

  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const health = await fetch(`${base}/ai/health`).then((res) => res.json());
    assert.equal(health.configured, false);
    assert.equal(health.model, 'deepseek-chat');

    const advice = await fetch(`${base}/requirements/${requirement.requirement_id}/advice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(advice.status, 503);
    const adviceBody = await advice.json();
    assert.equal(adviceBody.code, 'AI_NOT_CONFIGURED');

    // 核心链不受影响：仍能提交需求、查询健康。
    const created = await fetch(`${base}/requirements`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: requirement.project_id,
        raw_text: '未配置模型时核心链仍可用',
      }),
    });
    assert.equal(created.status, 201);
    const healthz = await fetch(`${base}/healthz`).then((res) => res.json());
    assert.deepEqual(healthz, { ok: true });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('AI：HTTP 已配置时 advice 落库并返回 suggestion 与 draft', async () => {
  configureModel();
  const { project, requirement } = seed();
  const item = activeItem(project.project_id);

  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  // 发往 Center 的请求走真实 fetch；发往模型的请求走假响应。
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith(base)) return originalFetch(url, init);
    return new Response(
      JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              assessed_level: 'L2',
              related_item_ids: [item.item_id],
              impact_summary: '影响导出',
              uncertainties: [],
              proposed_action: 'relevel',
            }),
          },
        }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  try {
    const health = await fetch(`${base}/ai/health`).then((res) => res.json());
    assert.equal(health.configured, true);
    assert.equal(health.model, 'test-model');
    assert.equal(health.base_url, 'https://llm.example');

    const response = await fetch(`${base}/requirements/${requirement.requirement_id}/advice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.draft.assessed_level, 'L2');
    assert.equal(body.suggestion.kind, 'assessment');

    const list = await fetch(
      `${base}/ai/suggestions?project_id=${project.project_id}&kind=assessment`,
    ).then((res) => res.json());
    assert.equal(list.length, 1);

    const missing = await fetch(`${base}/requirements/req_missing/advice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(missing.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
