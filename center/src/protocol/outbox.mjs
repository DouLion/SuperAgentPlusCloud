// 事件投递（P3）：至少一次投递 + 消费端按 event_id 去重。
// 本轮没有外部订阅者，dispatch 的默认投递器是空操作（标记已投递）。

import { createHmac } from 'node:crypto';
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
 * - 无订阅时保持原行为：直接标记已投递（便于本地无消费者时推进队列）。
 * - 有订阅时按 topic 匹配，逐个 POST；任一订阅失败即视为该事件失败并退避。
 * @param {object} db
 * @param {{limit?: number, deliverer?: (item: object) => any, fetchImpl?: Function, timeoutMs?: number}} [options]
 * @returns {Promise<{delivered: number, failed: number, items: object[], subscriptions: number}>}
 */
export async function dispatchOutbox(db, options = {}) {
  const items = listPending(db, options.limit ?? 50);
  const subs = listSubscriptions(db).filter((row) => !row.disabled_at);
  const deliverer = options.deliverer
    ?? (subs.length
      ? (item) => deliverToSubscriptions(db, item, subs, options)
      : () => true);

  let delivered = 0;
  let failed = 0;
  for (const item of items) {
    try {
      await deliverer(item);
      markDelivered(db, item.event_id);
      delivered += 1;
    } catch (error) {
      markFailed(db, item.event_id, error instanceof Error ? error.message : String(error));
      failed += 1;
    }
  }
  return { delivered, failed, items, subscriptions: subs.length };
}

// ---------------------------------------------------------------- 订阅

function parseSubscription(row) {
  if (!row) return null;
  return { ...row, topics: decodeJson(row.topics, []) };
}

/** 新建订阅；topics 为空表示订阅全部。 */
export function createSubscription(db, input = {}) {
  const url = input.url;
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
    throw Object.assign(new Error('url 必须是 http(s) 地址'), { code: 'SUBSCRIPTION_URL_INVALID', status: 400 });
  }
  const topics = Array.isArray(input.topics) ? input.topics.filter((t) => typeof t === 'string' && t.trim()) : [];
  const subscriptionId = input.subscription_id ?? input.subscriptionId ?? newId('sub');
  db.prepare(`INSERT INTO outbox_subscriptions (subscription_id, url, topics, secret, created_at, disabled_at)
    VALUES (?, ?, ?, ?, ?, NULL)`).run(
    subscriptionId, url, encodeJson(topics), input.secret ?? null, nowIso(),
  );
  return getSubscription(db, subscriptionId);
}

export function getSubscription(db, id) {
  return parseSubscription(db.prepare('SELECT * FROM outbox_subscriptions WHERE subscription_id = ?').get(id));
}

export function listSubscriptions(db, query = {}) {
  const includeDisabled = query.include_disabled === true || query.includeDisabled === true;
  const where = includeDisabled ? '' : 'WHERE disabled_at IS NULL';
  return db.prepare(`SELECT * FROM outbox_subscriptions ${where}
    ORDER BY created_at ASC, subscription_id ASC`).all().map(parseSubscription);
}

/** 停用订阅（软删除，保留历史）。 */
export function disableSubscription(db, id) {
  const existing = getSubscription(db, id);
  if (!existing) {
    throw Object.assign(new Error(`订阅不存在：${id}`), { status: 404, code: 'SUBSCRIPTION_NOT_FOUND' });
  }
  if (!existing.disabled_at) {
    db.prepare('UPDATE outbox_subscriptions SET disabled_at = ? WHERE subscription_id = ?')
      .run(nowIso(), id);
  }
  return getSubscription(db, id);
}

/** topic 是否被订阅匹配；空 topics 视为订阅全部。 */
export function subscriptionMatches(subscription, topic) {
  if (!subscription || subscription.disabled_at) return false;
  const topics = subscription.topics || [];
  return topics.length === 0 || topics.includes(topic);
}

/** HMAC-SHA256 签名头；没有 secret 时不签名。 */
export function signatureOf(body, secret) {
  if (!secret) return null;
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/**
 * 把一条事件投递给所有匹配订阅。任一订阅非 2xx 即抛错，交给调度器退避重试。
 */
export async function deliverToSubscriptions(db, item, subscriptions, options = {}) {
  const targets = (subscriptions ?? listSubscriptions(db)).filter((sub) => subscriptionMatches(sub, item.topic));
  if (!targets.length) return { delivered: 0, skipped: true };

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || 5000, 100), 30000);
  const body = JSON.stringify({ topic: item.topic, event_id: item.event_id, payload: item.payload });

  let delivered = 0;
  for (const sub of targets) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { 'content-type': 'application/json', 'x-sap-event': item.topic };
      const signature = signatureOf(body, sub.secret);
      if (signature) headers['x-sap-signature'] = signature;
      const response = await fetchImpl(sub.url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`订阅 ${sub.subscription_id} 返回 ${response.status}`);
      }
      delivered += 1;
    } catch (error) {
      throw new Error(`投递到 ${sub.url} 失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return { delivered };
}
