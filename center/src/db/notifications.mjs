// 站内通知存储（E 枝）：通知只是提醒，不改变任何业务状态。
// 同一事实用 dedupe_key 去重；已读只改 read_at，不删除历史。

import { decodeJson, newId, nowIso, pick, required } from './json.mjs';

/** 支持的类通知类型，与 schema 的 CHECK 保持一致。 */
export const NOTIFICATION_KINDS = [
  'task_available',
  'review_requested',
  'decision_required',
  'impact_to_check',
  'lease_expiring',
  'system',
];

function parseNotification(row) {
  return row ?? null;
}

/**
 * 写入一条通知；dedupe_key 冲突时跳过（幂等）。
 * @returns {object|null} 新建的通知；重复时为 null
 */
export function createNotification(db, input = {}) {
  const actorId = required(input, 'actor_id', 'actorId');
  const kind = required(input, 'kind');
  if (!NOTIFICATION_KINDS.includes(kind)) throw new Error(`非法的通知类型：${kind}`);
  const title = required(input, 'title');
  const dedupeKey = required(input, 'dedupe_key', 'dedupeKey');
  const notificationId = pick(input, 'notification_id', 'notificationId') ?? newId('ntf');
  const now = pick(input, 'created_at', 'createdAt') ?? nowIso();

  const result = db.prepare(`INSERT OR IGNORE INTO notifications (
    notification_id, actor_id, project_id, kind, title, body,
    ref_type, ref_id, dedupe_key, created_at, read_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`).run(
    notificationId,
    actorId,
    pick(input, 'project_id', 'projectId'),
    kind,
    title,
    pick(input, 'body'),
    pick(input, 'ref_type', 'refType'),
    pick(input, 'ref_id', 'refId'),
    dedupeKey,
    now,
  );
  if (result.changes === 0) return null;
  return getNotification(db, notificationId);
}

export function getNotification(db, notificationId) {
  return parseNotification(
    db.prepare('SELECT * FROM notifications WHERE notification_id = ?').get(notificationId),
  );
}

/** 列出某主体的通知，默认只返回最近 100 条。 */
export function listNotifications(db, query = {}) {
  const clauses = [];
  const params = [];
  const actorId = pick(query, 'actor_id', 'actorId');
  if (actorId) {
    clauses.push('actor_id = ?');
    params.push(actorId);
  }
  const unread = pick(query, 'unread');
  if (unread === true || unread === '1' || unread === 'true') {
    clauses.push('read_at IS NULL');
  }
  const kind = pick(query, 'kind');
  if (kind) {
    clauses.push('kind = ?');
    params.push(kind);
  }
  const limit = Math.min(Math.max(Number(pick(query, 'limit')) || 100, 1), 500);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM notifications ${where}
    ORDER BY created_at DESC, notification_id DESC LIMIT ?`).all(...params, limit)
    .map(parseNotification);
}

/** 未读数；可按 actor 过滤。 */
export function unreadCount(db, actorId) {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM notifications
    WHERE read_at IS NULL AND (? IS NULL OR actor_id = ?)`).get(actorId ?? null, actorId ?? null).n);
}

/** 标记单条已读；不存在返回 null，已读保持幂等。 */
export function markRead(db, notificationId, actorId) {
  const existing = getNotification(db, notificationId);
  if (!existing) return null;
  if (actorId && existing.actor_id !== actorId) {
    throw Object.assign(new Error('通知不属于该主体'), { code: 'NOTIFICATION_NOT_OWNED', status: 403 });
  }
  if (!existing.read_at) {
    db.prepare('UPDATE notifications SET read_at = ? WHERE notification_id = ?')
      .run(nowIso(), notificationId);
  }
  return getNotification(db, notificationId);
}

/** 全部标记已读；返回受影响条数。 */
export function markAllRead(db, actorId) {
  return db.prepare(`UPDATE notifications SET read_at = ?
    WHERE actor_id = ? AND read_at IS NULL`).run(nowIso(), actorId).changes;
}

/** 读取通知偏好；缺省视为全部开启。 */
export function listPrefs(db, actorId) {
  const rows = db.prepare('SELECT kind, enabled FROM notification_prefs WHERE actor_id = ?').all(actorId);
  const map = new Map(rows.map((row) => [row.kind, Number(row.enabled) === 1]));
  return NOTIFICATION_KINDS.map((kind) => ({ kind, enabled: map.get(kind) ?? true }));
}

/** 偏好是否允许发送；未设置按允许处理。 */
export function isEnabled(db, actorId, kind) {
  const row = db.prepare('SELECT enabled FROM notification_prefs WHERE actor_id = ? AND kind = ?')
    .get(actorId, kind);
  return row === undefined ? true : Number(row.enabled) === 1;
}

/** 批量更新偏好；只接受已知类型。 */
export function savePrefs(db, actorId, prefs = []) {
  const now = nowIso();
  for (const pref of prefs) {
    const kind = pick(pref, 'kind');
    if (!NOTIFICATION_KINDS.includes(kind)) throw new Error(`非法的通知类型：${kind}`);
    db.prepare(`INSERT INTO notification_prefs (actor_id, kind, enabled)
      VALUES (?, ?, ?)
      ON CONFLICT (actor_id, kind) DO UPDATE SET enabled = excluded.enabled`)
      .run(actorId, kind, pick(pref, 'enabled') ? 1 : 0);
  }
  return listPrefs(db, actorId);
}

export { decodeJson };
