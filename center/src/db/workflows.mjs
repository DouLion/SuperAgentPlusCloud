// 任务编排模板（T12）：版本化 DAG 定义与内置 contract-first-api 模板。

import { appendEvent } from './events.mjs';
import { appendDefinitionEvent } from './definition-events.mjs';
import { assertProjectExists } from './projects.mjs';
import { VERSIONED_DEFINITION_STATUSES } from './enums.mjs';
import {
  codedError,
  decodeJson,
  encodeJson,
  newId,
  nowIso,
  pick,
  required,
} from './json.mjs';

const INSERT_TEMPLATE = `INSERT INTO workflow_templates (
  template_id, name, description, status, version, project_id, kind, nodes,
  created_by, created_at, activated_at, supersedes, built_in
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export const CONTRACT_FIRST_API = {
  name: 'contract-first-api',
  description: '先确认接口契约，再由前端和后端并行实现，最后联调测试。',
  kind: 'api-development',
  nodes: [
    {
      key: 'contract', title: '接口契约设计',
      purpose_template: '定义接口路径、方法、请求/响应与错误约定。',
      done_when_template: ['接口契约经确认并形成可引用版本'],
      role_hint: 'api-designer', depends_on: [], outputs: ['api_contract', 'api_document', 'mock_definition'],
    },
    {
      key: 'frontend', title: '前端按契约实现',
      purpose_template: '前端严格按已确认接口契约实现交互与数据映射。',
      done_when_template: ['前端功能完成且 mock 场景通过'],
      role_hint: 'frontend', depends_on: ['contract'], outputs: ['frontend_change'],
    },
    {
      key: 'backend', title: '后端按契约实现',
      purpose_template: '后端严格按已确认接口契约实现接口与校验。',
      done_when_template: ['后端接口完成且契约测试通过'],
      role_hint: 'backend', depends_on: ['contract'], outputs: ['backend_change'],
    },
    {
      key: 'integration', title: '前后端联调测试',
      purpose_template: '在真实前后端组合上验证契约、异常与边界场景。',
      done_when_template: ['前后端联调通过，契约偏差已处置'],
      role_hint: 'tester', depends_on: ['frontend', 'backend'], outputs: ['integration_report'],
    },
  ],
};

function parseTemplate(row) {
  if (!row) return null;
  return { ...row, nodes: decodeJson(row.nodes, []), built_in: Boolean(row.built_in) };
}

function normalizeNodes(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error('nodes 必须是非空数组');
  const keys = new Set();
  const nodes = value.map((node, index) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      throw new Error(`第 ${index + 1} 个模板节点必须是对象`);
    }
    const key = required(node, 'key').trim();
    const title = required(node, 'title').trim();
    if (!key || !title) throw new Error(`第 ${index + 1} 个模板节点的 key/title 不能为空`);
    if (keys.has(key)) throw new Error(`模板节点 key 重复：${key}`);
    keys.add(key);
    const doneWhen = pick(node, 'done_when_template', 'doneWhenTemplate');
    if (!Array.isArray(doneWhen) || doneWhen.length === 0
      || doneWhen.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
      throw new Error(`模板节点 ${key} 的 done_when_template 必须是非空字符串数组`);
    }
    const depends = pick(node, 'depends_on', 'dependsOn') ?? [];
    if (!Array.isArray(depends) || depends.some((entry) => typeof entry !== 'string')) {
      throw new Error(`模板节点 ${key} 的 depends_on 必须是字符串数组`);
    }
    const outputs = pick(node, 'outputs') ?? [];
    if (!Array.isArray(outputs)) throw new Error(`模板节点 ${key} 的 outputs 必须是数组`);
    return {
      key,
      title,
      purpose_template: pick(node, 'purpose_template', 'purposeTemplate') ?? '',
      done_when_template: doneWhen.map((entry) => entry.trim()),
      role_hint: pick(node, 'role_hint', 'roleHint') ?? '',
      depends_on: [...depends],
      outputs: [...outputs],
    };
  });

  for (const node of nodes) {
    for (const dep of node.depends_on) {
      if (!keys.has(dep)) throw new Error(`模板节点 ${node.key} 引用了不存在的依赖：${dep}`);
      if (dep === node.key) throw new Error(`模板节点 ${node.key} 不能依赖自身`);
    }
  }
  // Kahn 算法检查无环。
  const indegree = new Map(nodes.map((node) => [node.key, node.depends_on.length]));
  const outgoing = new Map(nodes.map((node) => [node.key, []]));
  for (const node of nodes) for (const dep of node.depends_on) outgoing.get(dep).push(node.key);
  const queue = [...indegree].filter(([, degree]) => degree === 0).map(([key]) => key);
  let visited = 0;
  while (queue.length) {
    const key = queue.shift();
    visited += 1;
    for (const next of outgoing.get(key)) {
      const degree = indegree.get(next) - 1;
      indegree.set(next, degree);
      if (degree === 0) queue.push(next);
    }
  }
  if (visited !== nodes.length) throw codedError('WORKFLOW_CYCLE', '编排模板 depends_on 存在循环依赖', 400);
  return nodes;
}

export function createWorkflowTemplate(db, input = {}) {
  const templateId = pick(input, 'template_id', 'templateId') ?? newId('wft');
  const name = required(input, 'name');
  const kind = required(input, 'kind');
  const status = pick(input, 'status') ?? 'draft';
  if (!VERSIONED_DEFINITION_STATUSES.includes(status)) throw new Error(`非法的编排模板状态：${status}`);
  if (status !== 'draft') throw new Error('新建编排模板只能是 draft 状态');
  const projectId = pick(input, 'project_id', 'projectId');
  if (projectId) assertProjectExists(db, projectId);
  const version = Number(pick(input, 'version') ?? 1);
  if (!Number.isInteger(version) || version < 1) throw new Error('version 必须是正整数');
  const nodes = normalizeNodes(required(input, 'nodes'));
  const createdBy = required(input, 'created_by', 'createdBy');
  const now = pick(input, 'created_at', 'createdAt') ?? nowIso();
  db.prepare(INSERT_TEMPLATE).run(
    templateId, name, pick(input, 'description'), status, version, projectId, kind,
    encodeJson(nodes), createdBy, now, null, pick(input, 'supersedes'),
    pick(input, 'built_in', 'builtIn') ? 1 : 0,
  );
  appendDefinitionEvent(db, {
    project_id: projectId,
    object_type: 'workflow_template', object_id: templateId,
    event_type: 'workflow_template.created', actor: createdBy,
    occurred_at: now, reason: `创建编排模板：${name}`,
  });
  if (projectId) {
    appendEvent(db, {
      project_id: projectId, object_type: 'workflow_template', object_id: templateId,
      event_type: 'workflow_template.created', actor: createdBy,
      occurred_at: now, reason: name,
    });
  }
  return getWorkflowTemplate(db, templateId);
}

export function getWorkflowTemplate(db, templateId) {
  return parseTemplate(db.prepare('SELECT * FROM workflow_templates WHERE template_id = ?').get(templateId));
}

export function listWorkflowTemplates(db, query = {}) {
  const clauses = [];
  const params = [];
  for (const [key, column] of [
    ['project_id', 'project_id'], ['status', 'status'], ['kind', 'kind'], ['name', 'name'],
  ]) {
    const value = pick(query, key, key === 'project_id' ? 'projectId' : key);
    if (value !== undefined) {
      clauses.push(`${column} = ?`);
      params.push(value);
    }
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM workflow_templates ${where} ORDER BY built_in DESC, created_at DESC`)
    .all(...params).map(parseTemplate);
}

export function activateWorkflowTemplate(db, templateId, patch = {}) {
  const template = getWorkflowTemplate(db, templateId);
  if (!template) throw Object.assign(new Error(`编排模板不存在：${templateId}`), { status: 404 });
  if (template.status !== 'draft') {
    throw codedError('INVALID_TRANSITION', `编排模板当前状态不可激活：${template.status}`, 409);
  }
  const actor = required(patch, 'activated_by', 'activatedBy');
  const reason = required(patch, 'reason');
  const now = nowIso();
  db.prepare("UPDATE workflow_templates SET status = 'active', activated_at = ? WHERE template_id = ?")
    .run(now, templateId);
  appendDefinitionEvent(db, {
    project_id: template.project_id,
    object_type: 'workflow_template', object_id: templateId,
    event_type: 'workflow_template.activated', actor, occurred_at: now, reason,
  });
  if (template.project_id) {
    appendEvent(db, {
      project_id: template.project_id, object_type: 'workflow_template', object_id: templateId,
      event_type: 'workflow_template.activated', actor, occurred_at: now,
      reason,
    });
  }
  return getWorkflowTemplate(db, templateId);
}

export function retireWorkflowTemplate(db, templateId, patch = {}) {
  const template = getWorkflowTemplate(db, templateId);
  if (!template) throw Object.assign(new Error(`编排模板不存在：${templateId}`), { status: 404 });
  if (template.status !== 'active') {
    throw codedError('INVALID_TRANSITION', `编排模板当前状态不可退役：${template.status}`, 409);
  }
  const actor = required(patch, 'retired_by', 'retiredBy');
  const reason = required(patch, 'reason');
  const now = nowIso();
  db.prepare("UPDATE workflow_templates SET status = 'retired' WHERE template_id = ?").run(templateId);
  appendDefinitionEvent(db, {
    project_id: template.project_id,
    object_type: 'workflow_template', object_id: templateId,
    event_type: 'workflow_template.retired', actor, occurred_at: now, reason,
  });
  if (template.project_id) {
    appendEvent(db, {
      project_id: template.project_id, object_type: 'workflow_template', object_id: templateId,
      event_type: 'workflow_template.retired', actor, occurred_at: now,
      reason,
    });
  }
  return getWorkflowTemplate(db, templateId);
}

export function seedBuiltInTemplates(db, projectId, input = {}) {
  if (projectId) assertProjectExists(db, projectId);
  const existing = db.prepare(`SELECT * FROM workflow_templates
    WHERE name = ? AND built_in = 1 AND project_id IS ?`)
    .get(CONTRACT_FIRST_API.name, projectId ?? null);
  if (existing) return parseTemplate(existing);
  const actor = pick(input, 'created_by', 'createdBy') ?? 'system';
  const created = createWorkflowTemplate(db, {
    ...CONTRACT_FIRST_API,
    project_id: projectId ?? null,
    built_in: true,
    created_by: actor,
  });
  return activateWorkflowTemplate(db, created.template_id, {
    activated_by: actor,
    reason: '启用内置 contract-first-api 编排模板',
  });
}

// 兼容早期内部名称；新代码使用 seedBuiltInTemplates。
export function seedBuiltInWorkflows(db, input = {}) {
  return seedBuiltInTemplates(db, pick(input, 'project_id', 'projectId'), input);
}

export { normalizeNodes };
