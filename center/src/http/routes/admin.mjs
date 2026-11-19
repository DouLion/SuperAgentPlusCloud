// 运维路由（E 枝）：备份、备份校验与运行健康。仅管理员人类可执行备份与校验。

import { assertCan } from '../../auth/policy.mjs';
import { createBackup, healthReport, verifyBackup } from '../../reliability/backup.mjs';

/** 管理员守卫：必须是人类管理员；健康检查允许只读匿名（便于探活）。 */
function requireAdmin(db, req, action = 'admin.operate') {
  const auth = assertCan(db, req, action, {});
  if (auth.actor_type !== 'human') {
    return {
      error: {
        status: 403,
        body: { ok: false, code: 'HUMAN_ACTION_REQUIRED', error: `${action} 只能由人类执行` },
      },
    };
  }
  if (!auth.actor?.is_admin) {
    return {
      error: {
        status: 403,
        body: { ok: false, code: 'ADMIN_REQUIRED', error: `${action} 需要管理员主体` },
      },
    };
  }
  return { auth };
}

export const ROUTES = [
  {
    method: 'POST',
    pattern: '/admin/backup',
    handler: ({ db, body, req }) => {
      const guard = requireAdmin(db, req, 'admin.backup');
      if (guard.error) return guard.error;
      return { status: 201, body: createBackup(db, { target: body?.target ?? body?.path }) };
    },
  },
  {
    method: 'GET',
    pattern: '/admin/backup/verify',
    handler: ({ db, url, req }) => {
      const guard = requireAdmin(db, req, 'admin.backup');
      if (guard.error) return guard.error;
      return verifyBackup(url.searchParams.get('path'));
    },
  },
  {
    method: 'GET',
    pattern: '/admin/health',
    handler: ({ db }) => healthReport(db),
  },
];
