// Center 事件存储（T7 归置）。
// 每个状态变更都要写 events；本文件只负责事件的追加与查询。

import { camel, decodeJson, jsonField, newId, nowIso, pick, required } from './json.mjs';

/**
 * 追加一条事件记录。event_id 缺省自动生成 `evt_` 前缀 ID。
 * @returns {object} 已解析 refs 的完整行
 */
export function appendEvent(db, input = {}) {
  const eventId = pick(input, 'event_id', 'eventId') ?? newId('evt');
  const now = nowIso();

  db.prepare(
    `INSERT INTO events (
       event_id, project_id, object_type, object_id, event_type, actor,
       occurred_at, recorded_at, reason, refs, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    eventId,
    required(input, 'project_id', 'projectId'),
    pick(input, 'object_type', 'objectType'),
    pick(input, 'object_id', 'objectId'),
    required(input, 'event_type', 'eventType'),
    pick(input, 'actor'),
    pick(input, 'occurred_at', 'occurredAt') ?? now,
    pick(input, 'recorded_at', 'recordedAt') ?? now,
    pick(input, 'reason'),
    jsonField(input, 'refs'),
    now,
  );

  const row = db
    .prepare('SELECT * FROM events WHERE event_id = ?')
    .get(eventId);
  return { ...row, refs: decodeJson(row.refs, []) };
}

/**
 * 列出事件，可按 project_id / object_type / object_id / event_type 过滤。
 * 默认按发生时间倒序，最多 200 条。
 * @param {object} [query]
 */
export function listEvents(db, query = {}) {
  const clauses = [];
  const params = [];

  const filters = {
    project_id: 'project_id',
    object_type: 'object_type',
    object_id: 'object_id',
    event_type: 'event_type',
  };
  for (const [key, column] of Object.entries(filters)) {
    const value = pick(query, key, camel(key));
    if (value) {
      clauses.push(`${column} = ?`);
      params.push(value);
    }
  }

  let limit = Number(pick(query, 'limit') ?? 200);
  if (!Number.isFinite(limit)) limit = 200;
  limit = Math.min(Math.max(Math.trunc(limit), 1), 1000);

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT * FROM events ${where}
       ORDER BY occurred_at DESC, event_id DESC LIMIT ?`,
    )
    .all(...params, limit);
  return rows.map((row) => ({ ...row, refs: decodeJson(row.refs, []) }));
}
