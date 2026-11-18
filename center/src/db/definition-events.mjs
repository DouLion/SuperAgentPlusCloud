// 团队/项目定义事件（T12）：状态变更一律保留 actor / reason。

import { encodeJson, newId, nowIso } from './json.mjs';

export function appendDefinitionEvent(db, input) {
  const now = input.occurred_at ?? nowIso();
  const eventId = input.event_id ?? newId('evt');
  if (!input.actor) throw new Error('定义状态变更必须提供 actor');
  if (!input.reason) throw new Error('定义状态变更必须提供 reason');
  db.prepare(`INSERT INTO definition_events (
    event_id, project_id, object_type, object_id, event_type, actor, reason, refs, occurred_at, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    eventId, input.project_id ?? null, input.object_type, input.object_id,
    input.event_type, input.actor, input.reason, encodeJson(input.refs ?? []), now, now,
  );
  return eventId;
}

export function listDefinitionEvents(db, objectType, objectId) {
  return db.prepare(`SELECT * FROM definition_events
    WHERE object_type = ? AND object_id = ? ORDER BY occurred_at ASC, event_id ASC`)
    .all(objectType, objectId);
}
