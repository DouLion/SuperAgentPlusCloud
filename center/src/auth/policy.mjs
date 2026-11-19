// 授权策略（P1）：集中判定「谁能做什么」，避免权限判断散落在各路由。
// 兼容期：无 token 时按 legacy 放行（SAP_AUTH_MODE=optional），required 时写操作必须带 token。

import { authMode, roleEnforcement } from '../config.mjs';
import { activeDelegationFor, findActorByToken, getActor } from '../db/actors.mjs';
import { decodeJson, codedError } from '../db/json.mjs';

/** 只能由人类执行的动作：Agent 与服务账号一律拒绝。 */
export const HUMAN_ONLY = new Set([
  'decision.confirm',
  'review.record',
  'trunk_item.confirm',
  'trunk_item.retire',
  'convention_pack.activate',
  'artifact.publish',
  'trunk_change.confirm',
  'trunk_change.activate',
  'impact_item.resolve',
]);

/** 从请求头取 Bearer token。 */
export function bearerToken(req) {
  const header = req?.headers?.authorization || req?.headers?.Authorization;
  if (!header || typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/**
 * 解析请求主体。
 * @returns {{actor: object, credential: object} | null} 无 token 或无效 token 返回 null
 */
export function resolveRequestActor(db, req) {
  const token = bearerToken(req);
  if (!token) return null;
  return findActorByToken(db, token);
}

/** 项目角色可执行的动作。owner 覆盖全部。 */
export const PROJECT_ROLE_ACTIONS = {
  owner: [
    'decision.confirm', 'review.record',
    'trunk_item.confirm', 'trunk_item.retire',
    'trunk_change.confirm', 'trunk_change.activate',
    'artifact.publish', 'impact_item.resolve',
  ],
  direction: [
    'decision.confirm', 'trunk_item.confirm', 'trunk_item.retire',
    'trunk_change.confirm', 'trunk_change.activate',
  ],
  reviewer: ['review.record'],
  publisher: ['artifact.publish'],
};

/** 某主体（人类，或 Agent 的人类责任人）在项目中的角色列表。 */
export function projectRoles(db, actorId, projectId) {
  if (!actorId || !projectId) return [];
  const row = db.prepare('SELECT roles FROM project_members WHERE project_id = ? AND actor_id = ?')
    .get(projectId, actorId);
  return row ? decodeJson(row.roles, []) : [];
}

/** 该角色集合是否覆盖某动作。 */
export function rolesAllow(roles, action) {
  return roles.some((role) => (PROJECT_ROLE_ACTIONS[role] || []).includes(action));
}

/**
 * 计算动作对应的责任人：人类本人；Agent 取其委派的人类责任人。
 */
function accountableActorId(db, auth, target) {
  if (!auth.actor) return null;
  if (auth.actor.type === 'human') return auth.actor.actor_id;
  if (auth.actor.type === 'agent') {
    const delegation = auth.delegation
      ?? activeDelegationFor(db, auth.actor.actor_id, target.project_id ?? null);
    return delegation?.on_behalf_of ?? null;
  }
  return null;
}

/**
 * 断言当前请求可以执行某个动作。
 * @param {object} db
 * @param {object} req HTTP 请求（读取 Authorization）
 * @param {string} action 例如 decision.confirm
 * @param {object} [target] 目标对象，至少可含 project_id
 * @returns {{actor: object|null, actor_type: string, actor_id: string|null, delegation?: object,
 *   role_check: 'skipped'|'passed'}}
 * @throws 401 AUTH_REQUIRED / 401 AUTH_INVALID / 403 HUMAN_ACTION_REQUIRED /
 *   403 DELEGATION_REQUIRED / 403 PROJECT_ROLE_REQUIRED
 */
export function assertCan(db, req, action, target = {}) {
  const token = bearerToken(req);
  const resolved = token ? resolveRequestActor(db, req) : null;

  if (token && !resolved) {
    // 带了 token 却解析失败：已撤销、已过期或主体停用，必须拒绝，不能降级成 legacy。
    throw codedError('AUTH_INVALID', '凭据无效、已撤销或已过期', 401);
  }

  if (!resolved) {
    if (authMode() === 'required') {
      throw codedError('AUTH_REQUIRED', '此操作需要 Authorization: Bearer <token>', 401);
    }
    return { actor: null, actor_type: 'legacy', actor_id: null, role_check: 'skipped' };
  }

  const { actor } = resolved;
  const base = { actor, actor_type: actor.type, actor_id: actor.actor_id };

  if (HUMAN_ONLY.has(action)) {
    if (actor.type !== 'human') {
      throw codedError('HUMAN_ACTION_REQUIRED', `动作 ${action} 只能由人类执行，当前主体是 ${actor.type}`, 403);
    }
    return { ...base, role_check: 'skipped' };
  }

  if (actor.type === 'agent') {
    const delegation = activeDelegationFor(db, actor.actor_id, target.project_id ?? null);
    if (!delegation) {
      throw codedError('DELEGATION_REQUIRED', `Agent ${actor.actor_id} 在项目 ${target.project_id ?? '(全局)'} 上没有有效委派`, 403);
    }
    const allowed = delegation.allowed_actions || [];
    if (allowed.length > 0 && !allowed.includes(action)) {
      throw codedError('DELEGATION_REQUIRED', `委派未授予动作 ${action}`, 403);
    }
    return { ...base, delegation, role_check: 'skipped' };
  }

  return { ...base, role_check: 'skipped' };
}

/**
 * 在 assertCan 之后，按开关校验项目角色。
 * @returns {{role_check:'skipped'|'passed', roles:string[]}}
 */
export function assertProjectRole(db, auth, action, target = {}) {
  if (roleEnforcement() !== 'on') return { role_check: 'skipped', roles: [] };
  const projectId = target.project_id ?? null;
  if (!projectId) return { role_check: 'skipped', roles: [] };
  const actorId = accountableActorId(db, auth, target);
  if (!actorId) {
    throw codedError('PROJECT_ROLE_REQUIRED', `动作 ${action} 需要项目角色，但无法确定责任人`, 403);
  }
  const roles = projectRoles(db, actorId, projectId);
  if (!rolesAllow(roles, action)) {
    const needed = Object.entries(PROJECT_ROLE_ACTIONS)
      .filter(([, actions]) => actions.includes(action))
      .map(([role]) => role);
    throw codedError(
      'PROJECT_ROLE_REQUIRED',
      `动作 ${action} 需要项目 ${projectId} 的 ${needed.join(' / ')} 角色，当前主体没有`,
      403,
    );
  }
  return { role_check: 'passed', roles };
}

/** 签署快照列：表 → 列。白名单，避免动态拼接任意表名。 */
const STAMP_COLUMNS = new Map([
  ['decisions', 'confirmed_actor_type'],
  ['reviews', 'reviewer_actor_type'],
  ['trunk_items', 'confirmed_actor_type'],
  ['convention_packs', 'activated_actor_type'],
  ['artifacts', 'published_actor_type'],
  ['trunk_changes', 'confirmed_actor_type'],
]);

/**
 * 把本次操作的 actor_type 快照写入对应行。
 * @param {object} db
 * @param {string} table 白名单内表名
 * @param {string} idColumn 主键列名
 * @param {string} id 主键值
 * @param {string} actorType human / agent / service / legacy
 */
export function stampActorType(db, table, idColumn, id, actorType) {
  const column = STAMP_COLUMNS.get(table);
  if (!column || !id) return;
  db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${idColumn} = ?`).run(actorType, id);
}
