// 身份与授权 HTTP 路由（P1 基础 + D 枝：管理员、生命周期、凭据列表）。
// 管理动作：引导期放行；此后仅管理员人类可执行。

import {
  addMember,
  createActor,
  createDelegation,
  getActor,
  issueCredential,
  listActors,
  listCredentials,
  listDelegations,
  listMembers,
  revokeCredential,
  revokeDelegation,
  setActorAdmin,
  setActorStatus,
} from '../../db/actors.mjs';
import { assertCan } from '../../auth/policy.mjs';

function requireActor(db, id) {
  const actor = getActor(db, id);
  if (!actor) return { status: 404, body: { ok: false, error: `主体不存在：${id}` } };
  return actor;
}

/** 系统里还没有任何主体时，允许完成首次引导创建。 */
function isBootstrap(db) {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM actors').get().n) === 0;
}

/** 是否已存在任何凭据；用于允许首位主体领取首个 token。 */
function hasAnyCredential(db) {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM actor_credentials').get().n) > 0;
}

/**
 * 引导期：系统还没有任何主体，或还没有签发过任何凭据。
 * 期间允许匿名完成初始身份配置（负责人 + Agent + 能力），一旦签发凭据即关闭。
 */
function isBootstrapOpen(db) {
  return !hasAnyCredential(db);
}

/**
 * 身份管理动作：当前主体必须是管理员人类。
 * @returns {{error: object}|{auth: object}}
 */
function requireAdmin(db, req, action = 'actor.manage') {
  if (isBootstrapOpen(db)) return { auth: { actor: null, actor_type: 'legacy' } };
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
    pattern: '/actors',
    handler: ({ db, body, req }) => {
      if (!isBootstrapOpen(db)) {
        const guard = requireAdmin(db, req);
        if (guard.error) return guard.error;
      }
      return { status: 201, body: createActor(db, body) };
    },
  },
  {
    method: 'GET',
    pattern: '/actors',
    handler: ({ db, url }) => listActors(db, Object.fromEntries(url.searchParams)),
  },
  {
    method: 'GET',
    pattern: '/actors/:id',
    handler: ({ db, params }) => requireActor(db, params.id),
  },
  {
    method: 'POST',
    pattern: '/actors/:id/disable',
    handler: ({ db, params, body, req }) => {
      const guard = requireAdmin(db, req);
      if (guard.error) return guard.error;
      if (!getActor(db, params.id)) {
        return { status: 404, body: { ok: false, error: `主体不存在：${params.id}` } };
      }
      return { status: 200, body: setActorStatus(db, params.id, 'disabled', body) };
    },
  },
  {
    method: 'POST',
    pattern: '/actors/:id/enable',
    handler: ({ db, params, body, req }) => {
      const guard = requireAdmin(db, req);
      if (guard.error) return guard.error;
      if (!getActor(db, params.id)) {
        return { status: 404, body: { ok: false, error: `主体不存在：${params.id}` } };
      }
      return { status: 200, body: setActorStatus(db, params.id, 'active', body) };
    },
  },
  {
    method: 'POST',
    pattern: '/actors/:id/promote',
    handler: ({ db, params, body, req }) => {
      const guard = requireAdmin(db, req);
      if (guard.error) return guard.error;
      return { status: 200, body: setActorAdmin(db, params.id, true, body) };
    },
  },
  {
    method: 'POST',
    pattern: '/actors/:id/demote',
    handler: ({ db, params, body, req }) => {
      const guard = requireAdmin(db, req);
      if (guard.error) return guard.error;
      return { status: 200, body: setActorAdmin(db, params.id, false, body) };
    },
  },
  {
    method: 'GET',
    pattern: '/actors/:id/credentials',
    handler: ({ db, params }) => listCredentials(db, params.id),
  },
  {
    method: 'POST',
    pattern: '/actors/:id/credentials',
    handler: ({ db, params, body, req }) => {
      const actor = getActor(db, params.id);
      if (!actor) return { status: 404, body: { ok: false, error: `主体不存在：${params.id}` } };
      // 引导期：系统还没有任何凭据时，允许为首个主体领取首个 token。
      if (hasAnyCredential(db)) {
        const guard = requireAdmin(db, req);
        if (guard.error) return guard.error;
      }
      return { status: 201, body: issueCredential(db, params.id, body) };
    },
  },
  {
    method: 'DELETE',
    pattern: '/credentials/:id',
    handler: ({ db, params, body, req }) => {
      const guard = requireAdmin(db, req);
      if (guard.error) return guard.error;
      return { status: 200, body: revokeCredential(db, params.id, body) };
    },
  },
  {
    method: 'POST',
    pattern: '/delegations',
    handler: ({ db, body, req }) => {
      const guard = requireAdmin(db, req);
      if (guard.error) return guard.error;
      return { status: 201, body: createDelegation(db, body) };
    },
  },
  {
    method: 'GET',
    pattern: '/delegations',
    handler: ({ db, url }) => listDelegations(db, Object.fromEntries(url.searchParams)),
  },
  {
    method: 'POST',
    pattern: '/delegations/:id/revoke',
    handler: ({ db, params, body, req }) => {
      const guard = requireAdmin(db, req);
      if (guard.error) return guard.error;
      return { status: 200, body: revokeDelegation(db, params.id, body) };
    },
  },
  {
    method: 'GET',
    pattern: '/projects/:id/members',
    handler: ({ db, params }) => listMembers(db, params.id),
  },
  {
    method: 'POST',
    pattern: '/projects/:id/members',
    handler: ({ db, params, body, req }) => {
      const guard = requireAdmin(db, req);
      if (guard.error) return guard.error;
      return { status: 201, body: addMember(db, params.id, body) };
    },
  },
];
