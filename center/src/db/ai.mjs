// Center AI 建议存储（T8）。
// 只保存模型产出的建议/草稿与原始响应；不写评估、任务、影响项等业务状态。

import { AI_SUGGESTION_KINDS } from './enums.mjs';
import {
  camel,
  decodeJson,
  encodeJson,
  newId,
  nowIso,
  pick,
  required,
} from './json.mjs';

const INSERT_SUGGESTION = `INSERT INTO ai_suggestions (
  suggestion_id, project_id, requirement_id, change_id, kind,
  payload, raw_response, model, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function parseSuggestion(row) {
  if (!row) return null;
  return { ...row, payload: decodeJson(row.payload, null) };
}

/**
 * 保存一条 AI 建议。必填 project_id、kind（assessment/task_plan/impact）、payload；
 * requirement_id / change_id / raw_response / model 可空。
 * @returns {object} 已解析 payload 的完整建议行
 */
export function createAiSuggestion(db, input = {}) {
  const suggestionId = pick(input, 'suggestion_id', 'suggestionId') ?? newId('sug');
  const projectId = required(input, 'project_id', 'projectId');
  const kind = required(input, 'kind');
  const payload = pick(input, 'payload');

  if (!AI_SUGGESTION_KINDS.includes(kind)) {
    throw new Error(`非法的 AI 建议类型：${kind}`);
  }
  if (payload === undefined || payload === null) {
    throw new Error('缺少必填字段：payload');
  }

  db.prepare(INSERT_SUGGESTION).run(
    suggestionId,
    projectId,
    pick(input, 'requirement_id', 'requirementId') ?? null,
    pick(input, 'change_id', 'changeId') ?? null,
    kind,
    encodeJson(payload),
    pick(input, 'raw_response', 'rawResponse') ?? null,
    pick(input, 'model') ?? null,
    pick(input, 'created_at', 'createdAt') ?? nowIso(),
  );

  return getAiSuggestion(db, suggestionId);
}

/** 按 ID 查询 AI 建议；不存在返回 null。 */
export function getAiSuggestion(db, suggestionId) {
  return parseSuggestion(
    db.prepare('SELECT * FROM ai_suggestions WHERE suggestion_id = ?').get(suggestionId),
  );
}

/**
 * 列出 AI 建议，可按 project_id / requirement_id / change_id / kind 过滤，
 * 按创建时间升序。
 */
export function listAiSuggestions(db, query = {}) {
  const clauses = [];
  const params = [];

  for (const key of ['project_id', 'requirement_id', 'change_id']) {
    const value = pick(query, key, camel(key));
    if (value) {
      clauses.push(`${key} = ?`);
      params.push(value);
    }
  }

  const kind = pick(query, 'kind');
  if (kind) {
    if (!AI_SUGGESTION_KINDS.includes(kind)) {
      throw new Error(`非法的 AI 建议类型：${kind}`);
    }
    clauses.push('kind = ?');
    params.push(kind);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT * FROM ai_suggestions ${where}
       ORDER BY created_at ASC, suggestion_id ASC`,
    )
    .all(...params);
  return rows.map(parseSuggestion);
}
