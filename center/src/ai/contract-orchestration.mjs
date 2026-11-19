// T14：API 契约优先任务编排。只生成 contract_orchestration 建议；人工采纳后才创建 draft Artifact + open Tasks。

import { validateOpenApi, activeConventionRules } from '../contracts/openapi.mjs';
import { createAiSuggestion, getAiSuggestion } from '../db/ai.mjs';
import { createArtifact, listArtifacts } from '../db/artifacts.mjs';
import { codedError, required } from '../db/json.mjs';
import { getRequirement } from '../db/requirements.mjs';
import { createTask, openTask } from '../db/tasks.mjs';
import { listTrunkItems } from '../db/trunk.mjs';
import { getWorkflowTemplate, listWorkflowTemplates, normalizeNodes } from '../db/workflows.mjs';
import { listConventionPacks } from '../db/conventions.mjs';
import { llmConfig } from '../config.mjs';
import { chatWithRaw } from './provider.mjs';

function bad(message) { return codedError('AI_BAD_RESPONSE', message, 502); }
function strings(value) { return Array.isArray(value) ? value.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []; }
function object(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad(`${label} 必须是对象`); return value; }

function prompt(requirement, trunk, packs, template, contracts) {
  const rules = packs.flatMap((pack) => (pack.rules || []).map((rule) => ({ ...rule, pack_id: pack.pack_id })));
  return {
    system: [
      '你是 SuperAgentPlus 的 API 契约优先任务编排助手，只生成未生效草稿。',
      '只输出 JSON：workflow_template_id, convention_checks[], api_contract_draft, tasks[], uncertainties[]。',
      'convention_checks 项：rule_key,severity,result(passed|failed|unknown),reason。',
      'tasks 项：node_key,purpose,scope,non_scope,done_when[],serves_item_ids[],depends_on_node_keys[],expected_outputs[]。',
      '节点 key 与 depends_on_node_keys 必须严格对应给出的模板；done_when 非空；serves_item_ids 只能引用给出的 active 主干 id。',
      'contract 节点 expected_outputs 必须含 api_contract；不得绕过 must 规则；信息不足写 uncertainties。',
      'api_contract_draft 必须是 OpenAPI 3.1 对象，遵守 active 约定（方法、响应包络、命名）。',
      '不得创建任务、不得发布制品，只输出 JSON。',
    ].join('\n'),
    user: JSON.stringify({
      requirement,
      active_trunk: trunk.map(({ item_id, kind, statement, rationale }) => ({ item_id, kind, statement, rationale })),
      active_conventions: rules,
      workflow_template: template,
      published_api_contracts: contracts.map(({ artifact_id, name, version, digest }) => ({ artifact_id, name, version, digest })),
    }, null, 2),
  };
}

function normalize(data, template, activeItemIds, rules, requirement) {
  object(data, '编排响应');
  if (data.workflow_template_id !== template.template_id) throw bad('workflow_template_id 与选定模板不一致');
  const checks = Array.isArray(data.convention_checks) ? data.convention_checks.map((check) => ({
    rule_key: String(check?.rule_key ?? ''), severity: String(check?.severity ?? ''),
    result: String(check?.result ?? ''), reason: String(check?.reason ?? ''),
  })) : [];
  for (const check of checks) {
    if (!['must', 'should', 'preference'].includes(check.severity) || !['passed', 'failed', 'unknown'].includes(check.result)) {
      throw bad('convention_checks 的 severity/result 非法');
    }
  }
  const tasks = data.tasks;
  if (!Array.isArray(tasks) || tasks.length !== template.nodes.length) throw bad('tasks 数量必须与模板节点一致');
  const normalized = tasks.map((task) => {
    object(task, '任务节点');
    const key = String(task.node_key ?? '').trim();
    const definition = template.nodes.find((node) => node.key === key);
    if (!definition) throw bad(`任务 node_key 不在模板中：${key}`);
    const depends = strings(task.depends_on_node_keys);
    if (JSON.stringify(depends) !== JSON.stringify(definition.depends_on)) throw bad(`任务 ${key} 的依赖必须与模板完全一致`);
    const doneWhen = strings(task.done_when);
    const serves = strings(task.serves_item_ids);
    if (!String(task.purpose ?? '').trim() || !doneWhen.length) throw bad(`任务 ${key} 缺少 purpose/done_when`);
    if (!serves.length || serves.some((id) => !activeItemIds.has(id))) throw bad(`任务 ${key} 只能引用 active 主干条目`);
    const outputs = strings(task.expected_outputs);
    if (JSON.stringify(outputs) !== JSON.stringify(definition.outputs)) throw bad(`任务 ${key} 的 expected_outputs 必须与模板完全一致`);
    return {
      node_key: key, purpose: String(task.purpose).trim(), scope: String(task.scope ?? ''), non_scope: String(task.non_scope ?? ''),
      done_when: doneWhen, serves_item_ids: serves, depends_on_node_keys: depends, expected_outputs: outputs,
    };
  });
  normalizeNodes(normalized.map((task) => {
    const definition = template.nodes.find((node) => node.key === task.node_key);
    return { ...definition, depends_on: task.depends_on_node_keys, done_when_template: task.done_when, outputs: task.expected_outputs };
  }));
  const contractTask = normalized.find((task) => task.node_key === 'contract');
  if (!contractTask?.expected_outputs.includes('api_contract')) throw bad('contract 节点 expected_outputs 必须包含 api_contract');
  const contract = object(data.api_contract_draft, 'api_contract_draft');
  const validation = validateOpenApi(contract, rules);
  const mustFailed = checks.some((check) => check.severity === 'must' && check.result !== 'passed');
  return {
    workflow_template_id: template.template_id,
    convention_checks: checks,
    api_contract_draft: contract,
    validation,
    tasks: normalized,
    uncertainties: strings(data.uncertainties),
    adoptable: validation.valid && !mustFailed && strings(data.uncertainties).length === 0,
    requirement_snapshot: { requirement_id: requirement.requirement_id, raw_text: requirement.raw_text },
  };
}

export async function suggestContractOrchestration(db, requirementId, options = {}) {
  const requirement = getRequirement(db, requirementId);
  if (!requirement) throw Object.assign(new Error(`需求不存在：${requirementId}`), { status: 404 });
  const trunk = listTrunkItems(db, { project_id: requirement.project_id, status: 'active' });
  const packs = listConventionPacks(db, { project_id: requirement.project_id, status: 'active' });
  const requested = options.workflow_template_id ?? options.workflowTemplateId;
  const projectTemplates = listWorkflowTemplates(db, { project_id: requirement.project_id, status: 'active', kind: 'api-development' });
  const globalTemplates = db.prepare("SELECT template_id FROM workflow_templates WHERE project_id IS NULL AND status = 'active' AND kind = 'api-development' AND built_in = 1").all()
    .map((row) => getWorkflowTemplate(db, row.template_id));
  const template = requested ? getWorkflowTemplate(db, requested) : (projectTemplates.find((row) => row.name === 'contract-first-api') ?? globalTemplates.find((row) => row.name === 'contract-first-api'));
  if (!template || template.status !== 'active' || template.kind !== 'api-development'
    || (template.project_id && template.project_id !== requirement.project_id)
    || (!template.project_id && !template.built_in)) {
    throw codedError('WORKFLOW_TEMPLATE_INVALID', '需要指定当前项目 active 模板，或全局 built_in active 的 contract-first-api 模板', 409);
  }
  const contracts = listArtifacts(db, { project_id: requirement.project_id, type: 'api_contract', status: 'published' });
  const { data, raw } = await chatWithRaw(prompt(requirement, trunk, packs, template, contracts));
  const draft = normalize(data, template, new Set(trunk.map((item) => item.item_id)), activeConventionRules(db, requirement.project_id), requirement);
  const suggestion = createAiSuggestion(db, {
    project_id: requirement.project_id, requirement_id: requirementId, kind: 'contract_orchestration',
    payload: draft, raw_response: raw, model: llmConfig().model,
  });
  return { suggestion, draft };
}

export function adoptContractOrchestration(db, suggestionId, input = {}) {
  const suggestion = getAiSuggestion(db, suggestionId);
  if (!suggestion) throw Object.assign(new Error(`AI 建议不存在：${suggestionId}`), { status: 404 });
  if (suggestion.kind !== 'contract_orchestration') throw codedError('SUGGESTION_KIND_MISMATCH', '建议不是 contract_orchestration', 409);
  const payload = suggestion.payload;
  if (payload.adopted_at) throw codedError('ORCHESTRATION_ALREADY_ADOPTED', '编排建议已被采纳', 409);
  if (payload.uncertainties?.length) throw codedError('ORCHESTRATION_UNCERTAIN', '编排建议仍有未决项，不能采纳', 409);
  const validation = validateOpenApi(payload.api_contract_draft, activeConventionRules(db, suggestion.project_id));
  const mustFailed = payload.convention_checks?.some((check) => check.severity === 'must' && check.result !== 'passed');
  if (!validation.valid || mustFailed) throw codedError('CONTRACT_VALIDATION_FAILED', 'API 契约或 must 约定校验未通过', 422);
  const actor = required(input, 'created_by', 'createdBy');
  const name = required(input, 'contract_name', 'contractName');
  const requirementId = suggestion.requirement_id;
  db.exec('BEGIN');
  try {
    const artifact = createArtifact(db, {
      project_id: suggestion.project_id, type: 'api_contract', name,
      content: payload.api_contract_draft, created_by: actor,
    });
    const taskByNode = new Map();
    for (const draft of payload.tasks) {
      const task = createTask(db, {
        project_id: suggestion.project_id, requirement_id: requirementId,
        serves_item_ids: draft.serves_item_ids, purpose: draft.purpose,
        scope: `${draft.scope}${draft.expected_outputs.length ? `；预期产物：${draft.expected_outputs.join('、')}` : ''}`,
        non_scope: draft.non_scope, done_when: draft.done_when,
        blocked_by: [],
        acceptance_evidence: draft.expected_outputs,
        created_by: actor, status: 'draft',
      });
      taskByNode.set(draft.node_key, task);
    }
    for (const draft of payload.tasks) {
      const task = taskByNode.get(draft.node_key);
      const blockedBy = draft.depends_on_node_keys.map((key) => taskByNode.get(key).task_id);
      db.prepare('UPDATE tasks SET blocked_by = ? WHERE task_id = ?').run(JSON.stringify(blockedBy), task.task_id);
      const opened = openTask(db, task.task_id, { actor, reason: `采纳编排建议 ${suggestionId}` });
      taskByNode.set(draft.node_key, opened);
    }
    const adoptedAt = new Date().toISOString();
    const nextPayload = { ...payload, adopted_at: adoptedAt, adopted_by: actor, artifact_id: artifact.artifact_id, task_ids: [...taskByNode.values()].map((task) => task.task_id) };
    db.prepare('UPDATE ai_suggestions SET payload = ? WHERE suggestion_id = ?').run(JSON.stringify(nextPayload), suggestionId);
    db.exec('COMMIT');
    return {
      artifact,
      tasks: payload.tasks.map((draft) => ({
        node_key: draft.node_key,
        ...taskByNode.get(draft.node_key),
        blocked_by: draft.depends_on_node_keys.map((key) => taskByNode.get(key).task_id),
      })),
      suggestion: getAiSuggestion(db, suggestionId),
    };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
