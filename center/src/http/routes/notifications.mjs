// 站内通知路由（E 枝）：列表、已读、偏好与主动扫描。

import {
  listNotifications,
  listPrefs,
  markAllRead,
  markRead,
  savePrefs,
  unreadCount,
} from '../../db/notifications.mjs';
import { scanNotifications } from '../../notify/scan.mjs';

function requireActorId(value) {
  if (!value) {
    return { error: { status: 400, body: { ok: false, code: 'ACTOR_REQUIRED', error: '需要 actor_id' } } };
  }
  return { actorId: value };
}

export const ROUTES = [
  {
    method: 'GET',
    pattern: '/notifications',
    handler: ({ db, url }) => {
      const query = Object.fromEntries(url.searchParams);
      return { generated_at: new Date().toISOString(), items: listNotifications(db, query) };
    },
  },
  {
    method: 'GET',
    pattern: '/notifications/unread-count',
    handler: ({ db, url }) => ({
      actor_id: url.searchParams.get('actor_id'),
      unread: unreadCount(db, url.searchParams.get('actor_id')),
    }),
  },
  {
    method: 'POST',
    pattern: '/notifications/read-all',
    handler: ({ db, body }) => {
      const guard = requireActorId(body?.actor_id ?? body?.actorId);
      if (guard.error) return guard.error;
      return { actor_id: guard.actorId, updated: markAllRead(db, guard.actorId) };
    },
  },
  {
    method: 'POST',
    pattern: '/notifications/scan',
    handler: ({ db }) => scanNotifications(db),
  },
  {
    method: 'POST',
    pattern: '/notifications/:id/read',
    handler: ({ db, params, body }) => {
      const updated = markRead(db, params.id, body?.actor_id ?? body?.actorId);
      if (!updated) return { status: 404, body: { ok: false, error: `通知不存在：${params.id}` } };
      return updated;
    },
  },
  {
    method: 'GET',
    pattern: '/notification-prefs',
    handler: ({ db, url }) => {
      const guard = requireActorId(url.searchParams.get('actor_id'));
      if (guard.error) return guard.error;
      return { actor_id: guard.actorId, prefs: listPrefs(db, guard.actorId) };
    },
  },
  {
    method: 'PUT',
    pattern: '/notification-prefs',
    handler: ({ db, body }) => {
      const guard = requireActorId(body?.actor_id ?? body?.actorId);
      if (guard.error) return guard.error;
      return { actor_id: guard.actorId, prefs: savePrefs(db, guard.actorId, body.prefs ?? []) };
    },
  },
];
