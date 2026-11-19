// 事件投递（P3）：至少一次投递 + 消费端按 event_id 去重。
// 本轮没有外部订阅者，dispatch 的默认投递器是空操作（标记已投递）。

import { decodeJson, encodeJson, newId, nowIso } from '../db/json.mjs';

/** 入队一条待投递事件。 */
export function enqueue(db, input = {}) {
  const eventId = input.event_id ?? input.eventId ?? newId('obx');
  const now = nowIso();
  db.prepare(`INSERT INTO outbox (
    event_id, topic, payload, created_at, available_at, attempts, last_error, delivered_at
  ) VALUES (?, ?, ?, ?, ?, 0, NULL, NULL)`).run(
    eventId,
    input.topic,
    encodeJson(input.payload ?? {}),
    now,
    input.available_at ?? input.availableAt ?? now,
  );
  return eventId;
}

/**
 * 由事件行入队。topic 缺省取 event_type，payload 保留足够消费方路由的字段。
 */
export function enqueueFromEvent(db, event, extra = {}) {
  if (!event?.event_type) return null;
  return enqueue(db, {
    topic: extra.topic ?? event.event_type,
    payload: {
      event_id: event.event_id,
      project_id: event.project_id,
      object_type: event.object_type,
      object_id: event.object_id,
      event_type: event.event_type,
      actor: event.actor,
      occurred_at: event.occurred_at,
      reason: event.reason ?? null,
      refs: event.refs ?? [],
      ...extra.payload,
    },
    available_at: extra.available_at,
  });
}

function parseOutbox(row) {
  if (!row) return null;
  return { ...row, payload: decodeJson(row.payload, {}) };
}

/** 待投递事件：未投递且到达可投递时间。 */
export function listPending(db, limit = 50) {
  const bound = Math.min(Math.max(Number(limit) || 50, 1), 500);
  return db.prepare(`SELECT * FROM outbox
    WHERE delivered_at IS NULL AND available_at <= ?
    ORDER BY available_at ASC, event_id ASC LIMIT ?`)
    .all(nowIso(), bound).map(parseOutbox);
}

/** 管理查询：pending / delivered。 */
export function listOutbox(db, query = {}) {
  const status = query.status ?? 'pending';
  const bound = Math.min(Math.max(Number(query.limit) || 100, 1), 500);
  if (status === 'delivered') {
    return db.prepare(`SELECT * FROM outbox WHERE delivered_at IS NOT NULL
      ORDER BY delivered_at DESC, event_id DESC LIMIT ?`).all(bound).map(parseOutbox);
  }
  return db.prepare(`SELECT * FROM outbox WHERE delivered_at IS NULL
    ORDER BY available_at ASC, event_id ASC LIMIT ?`).all(bound).map(parseOutbox);
}

/** 标记已投递。 */
export function markDelivered(db, eventId) {
  const now = nowIso();
  db.prepare('UPDATE outbox SET delivered_at = ?, last_error = NULL WHERE event_id = ?')
    .run(now, eventId);
  return parseOutbox(db.prepare('SELECT * FROM outbox WHERE event_id = ?').get(eventId));
}

/** 标记失败并安排下次尝试。 */
export function markFailed(db, eventId, error, retryDelaySeconds = 30) {
  const now = Date.now();
  const next = new Date(now + Math.max(Number(retryDelaySeconds) || 30, 1) * 1000).toISOString();
  db.prepare(`UPDATE outbox SET attempts = attempts + 1, last_error = ?, available_at = ?
    WHERE event_id = ?`).run(String(error ?? 'delivery failed'), next, eventId);
  return parseOutbox(db.prepare('SELECT * FROM outbox WHERE event_id = ?').get(eventId));
}

/**
 * 派发一批待投递事件。
 * @param {object} db
 * @param {{limit?: number, deliverer?: (item: object) => any}} [options]
 * @returns {{delivered: number, failed: number, items: object[]}}
 */
export function dispatchOutbox(db, options = {}) {
  const items = listPending(db, options.limit ?? 50);
  const deliverer = options.deliverer ?? (() => true);
  let delivered = 0;
  let failed = 0;
  for (const item of items) {
    try {
      deliverer(item);
      markDelivered(db, item.event_id);
      delivered += 1;
    } catch (error) {
      markFailed(db, item.event_id, error instanceof Error ? error.message : String(error));
      failed += 1;
    }
  }
  return { delivered, failed, items };
}
