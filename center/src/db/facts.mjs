// 外部工具只读事实（G 枝）：Git/CI 等系统上报的事实，仅作证据，不改业务状态。

import { appendEvent } from './events.mjs';
import { assertProjectExists } from './projects.mjs';
import { resolveRepository } from './repositories.mjs';
import { getTask } from './tasks.mjs';
import {
  codedError,
  decodeJson,
  encodeJson,
  newId,
  nowIso,
  pick,
  required,
} from './json.mjs';

export const FACT_SOURCES = ['git', 'ci', 'issue', 'chat', 'other'];
export const FACT_KINDS = ['commit', 'build', 'test_run', 'issue', 'message'];

/** 事实只作证据，不推进任务；响应里统一带这句话。 */
export const FACT_NOTE = '外部事实仅为证据，不代表任务完成';

function parseFact(row) {
  if (!row) return null;
  return { ...row, payload: decodeJson(row.payload, {}) };
}

/**
 * 按 source/kind 做最小结构校验，避免把明显不相干的载荷当成证据。
 * 只校验「有没有关键字段」，不判断内容真假。
 */
function validatePayload(source, kind, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw codedError('FACT_PAYLOAD_INVALID', 'payload 必须是 JSON 对象', 400);
  }
  const has = (key) => payload[key] !== undefined && payload[key] !== null && payload[key] !== '';
  if (source === 'git' && kind === 'commit') {
    if (!has('commit_sha')) throw codedError('FACT_PAYLOAD_INVALID', 'git/commit 事实必须包含 commit_sha', 400);
    if (!has('ref') && !has('branch')) {
      throw codedError('FACT_PAYLOAD_INVALID', 'git/commit 事实必须包含 ref 或 branch', 400);
    }
  }
  if (source === 'ci' && kind === 'build') {
    if (!has('status')) throw codedError('FACT_PAYLOAD_INVALID', 'ci/build 事实必须包含 status', 400);
  }
}

/** 幂等键：同一仓库、来源、类型、外部 ID 视为同一事实。 */
export function factDedupeKey(source, kind, externalId, repositoryId = null) {
  return repositoryId
    ? `${source}:${kind}:${repositoryId}:${externalId}`
    : `${source}:${kind}:${externalId}`;
}

/**
 * 摄入一条外部事实。重复（同 dedupe_key）时返回首次记录并标记 deduplicated。
 * 不修改任何 task/submission/artifact 状态。
 */
export function createFact(db, input = {}) {
  const projectId = required(input, 'project_id', 'projectId');
  const source = required(input, 'source');
  const kind = required(input, 'kind');
  const externalId = required(input, 'external_id', 'externalId');
  if (!FACT_SOURCES.includes(source)) throw codedError('FACT_SOURCE_INVALID', `非法的事实来源：${source}`, 400);
  if (!FACT_KINDS.includes(kind)) throw codedError('FACT_KIND_INVALID', `非法的事实类型：${kind}`, 400);
  assertProjectExists(db, projectId);

  const payload = pick(input, 'payload') ?? {};
  validatePayload(source, kind, payload);

  // git 事实应落在具体仓库上；项目已登记仓库时必须指明，避免多仓来源混淆。
  const repository = resolveRepository(db, projectId, input);
  if (source === 'git' && !repository) {
    const registered = db.prepare(
      'SELECT COUNT(*) AS n FROM project_repositories WHERE project_id = ?',
    ).get(projectId).n;
    if (Number(registered) > 0) {
      throw codedError('REPOSITORY_REQUIRED', '项目已登记仓库，git 事实需指明 repository_id 或 repository_url', 400);
    }
  }
  const repositoryId = repository?.repository_id ?? null;

  const dedupeKey = factDedupeKey(source, kind, externalId, repositoryId);
  const existing = db.prepare('SELECT * FROM external_facts WHERE dedupe_key = ?').get(dedupeKey);
  if (existing) return { fact: parseFact(existing), deduplicated: true };

  const factId = pick(input, 'fact_id', 'factId') ?? newId('fact');
  const now = nowIso();
  const actorId = pick(input, 'actor_id', 'actorId') ?? null;
  db.prepare(`INSERT INTO external_facts (
    fact_id, project_id, repository_id, source, kind, external_id, payload, received_at, actor_id, dedupe_key, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    factId, projectId, repositoryId, source, kind, externalId, encodeJson(payload), now, actorId, dedupeKey, now,
  );

  appendEvent(db, {
    project_id: projectId,
    object_type: 'external_fact',
    object_id: factId,
    event_type: 'fact.received',
    actor: actorId ?? source,
    occurred_at: now,
    reason: `${source}/${kind}:${externalId}`,
    refs: [externalId, ...(repositoryId ? [repositoryId] : [])],
  });

  return { fact: getFact(db, factId), deduplicated: false };
}

export function getFact(db, factId) {
  return parseFact(db.prepare('SELECT * FROM external_facts WHERE fact_id = ?').get(factId));
}

export function listFacts(db, query = {}) {
  const clauses = [];
  const params = [];
  for (const [key, column] of [
    ['project_id', 'project_id'],
    ['repository_id', 'repository_id'],
    ['source', 'source'],
    ['kind', 'kind'],
  ]) {
    const value = pick(query, key, key === 'project_id' ? 'projectId' : key);
    if (value !== undefined) {
      clauses.push(`${column} = ?`);
      params.push(value);
    }
  }
  const externalId = pick(query, 'external_id', 'externalId');
  if (externalId !== undefined) {
    clauses.push('external_id = ?');
    params.push(externalId);
  }
  const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 500);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM external_facts ${where}
    ORDER BY received_at DESC, fact_id DESC LIMIT ?`).all(...params, limit).map(parseFact);
}

/** 按 ID 批量取事实；不存在的 ID 会被忽略，由调用方判断缺口。 */
export function factsByIds(db, factIds = []) {
  const ids = [...new Set((Array.isArray(factIds) ? factIds : []).filter((id) => typeof id === 'string' && id.trim()))];
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(', ');
  return db.prepare(`SELECT * FROM external_facts WHERE fact_id IN (${placeholders})`)
    .all(...ids).map(parseFact);
}

/**
 * 把事实关联到任务。只记录关联，不改任务状态。
 * 每个 fact 必须存在且属于同一项目。
 */
export function linkTaskFacts(db, taskId, factIds, linkedBy = null) {
  const task = getTask(db, taskId);
  if (!task) throw codedError('TASK_NOT_FOUND', `任务不存在：${taskId}`, 404);

  const ids = [...new Set((Array.isArray(factIds) ? factIds : []).filter((id) => typeof id === 'string' && id.trim()))];
  if (!ids.length) throw codedError('FACT_IDS_REQUIRED', 'fact_ids 必须是非空数组', 400);

  const facts = factsByIds(db, ids);
  const found = new Set(facts.map((fact) => fact.fact_id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) {
    throw codedError('FACT_NOT_FOUND', `事实不存在：${missing.join(', ')}`, 400);
  }
  const foreign = facts.filter((fact) => fact.project_id !== task.project_id);
  if (foreign.length) {
    throw codedError(
      'FACT_PROJECT_MISMATCH',
      `事实不属于任务所在项目：${foreign.map((fact) => fact.fact_id).join(', ')}`,
      400,
    );
  }

  const now = nowIso();
  for (const factId of ids) {
    db.prepare(`INSERT INTO task_fact_links (task_id, fact_id, linked_by, linked_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (task_id, fact_id) DO NOTHING`).run(taskId, factId, linkedBy, now);
  }
  return { task_id: taskId, facts: listTaskFacts(db, taskId), note: FACT_NOTE };
}

export function listTaskFacts(db, taskId) {
  return db.prepare(`SELECT f.* FROM task_fact_links l
    JOIN external_facts f ON f.fact_id = l.fact_id
    WHERE l.task_id = ? ORDER BY l.linked_at ASC, f.fact_id ASC`).all(taskId).map(parseFact);
}

/** 事实摘要：给提交详情用，避免把整段载荷塞进列表。 */
export function summarizeFact(fact) {
  if (!fact) return null;
  const payload = fact.payload || {};
  const summary = payload.summary
    ?? payload.message
    ?? payload.commit_message
    ?? payload.status
    ?? payload.title
    ?? '';
  return {
    fact_id: fact.fact_id,
    source: fact.source,
    kind: fact.kind,
    external_id: fact.external_id,
    repository_id: fact.repository_id ?? null,
    summary: String(summary).slice(0, 200),
    received_at: fact.received_at,
  };
}
