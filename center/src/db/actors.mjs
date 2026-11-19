// 身份与授权存储（P1）：主体、凭据、委派、项目成员。
// 只存 token 哈希；明文仅在签发时返回一次。所有变更写事件。

import crypto from 'node:crypto';
import { appendDefinitionEvent } from './definition-events.mjs';
import { appendEvent } from './events.mjs';
import { assertProjectExists } from './projects.mjs';
import {
  codedError,
  decodeJson,
  encodeJson,
  newId,
  nowIso,
  pick,
  required,
} from './json.mjs';

export const ACTOR_TYPES = ['human', 'agent', 'service'];
export const ACTOR_STATUSES = ['active', 'disabled'];

/** 项目成员角色；只决定可被指派到哪些动作，不直接等于权限。 */
export const PROJECT_ROLES = ['owner', 'contributor', 'reviewer', 'direction', 'publisher', 'observer'];

/** Agent 委派的默认有效期（天）。 */
export const DEFAULT_DELEGATION_DAYS = 90;

function parseActor(row) {
  return row ?? null;
}

function parseDelegation(row) {
  if (!row) return null;
  return { ...row, allowed_actions: decodeJson(row.allowed_actions, []) };
}

function parseMember(row) {
  if (!row) return null;
  return { ...row, roles: decodeJson(row.roles, []) };
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function addDays(days) {
  const date = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return date.toISOString();
}

/** 取主体；不存在返回 null。 */
export function getActor(db, actorId) {
  return parseActor(db.prepare('SELECT * FROM actors WHERE actor_id = ?').get(actorId));
}

/** 列出主体，可按 type / status 过滤。 */
export function listActors(db, query = {}) {
  const clauses = [];
  const params = [];
  for (const [key, column] of [['type', 'type'], ['status', 'status']]) {
    const value = pick(query, key);
    if (value !== undefined) {
      clauses.push(`${column} = ?`);
      params.push(value);
    }
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM actors ${where} ORDER BY created_at ASC, actor_id ASC`)
    .all(...params);
}

/**
 * 新建主体。
 * - human / service：直接创建。
 * - agent：必须同时给出 on_behalf_of（人类责任人），事务内一并建立委派；缺失则 AGENT_OWNER_REQUIRED。
 */
export function createActor(db, input = {}) {
  const type = required(input, 'type');
  if (!ACTOR_TYPES.includes(type)) throw new Error(`非法的主体类型：${type}`);
  const displayName = required(input, 'display_name', 'displayName');
  const actorId = pick(input, 'actor_id', 'actorId') ?? newId('act');
  const createdBy = pick(input, 'created_by', 'createdBy');
  const now = nowIso();

  if (type === 'agent') {
    const ownerId = pick(input, 'on_behalf_of', 'onBehalfOf');
    if (!ownerId) {
      throw codedError('AGENT_OWNER_REQUIRED', 'Agent 必须绑定人类责任人：请提供 on_behalf_of', 400);
    }
    const owner = getActor(db, ownerId);
    if (!owner) throw codedError('AGENT_OWNER_REQUIRED', `人类责任人不存在：${ownerId}`, 400);
    if (owner.type !== 'human') {
      throw codedError('AGENT_OWNER_REQUIRED', `责任人必须是 human：${ownerId}`, 400);
    }

    db.exec('BEGIN');
    try {
      db.prepare(`INSERT INTO actors (actor_id, type, display_name, status, created_at, created_by)
        VALUES (?, ?, ?, 'active', ?, ?)`).run(actorId, type, displayName, now, createdBy ?? ownerId);
      appendDefinitionEvent(db, {
        object_type: 'actor', object_id: actorId, event_type: 'actor.created',
        actor: createdBy ?? ownerId, reason: `创建 Agent：${displayName}`,
        refs: [ownerId], occurred_at: now,
      });
      createDelegationCore(db, {
        agent_actor_id: actorId,
        on_behalf_of: ownerId,
        project_id: pick(input, 'project_id', 'projectId'),
        allowed_actions: pick(input, 'allowed_actions', 'allowedActions') ?? [],
        valid_until: pick(input, 'valid_until', 'validUntil'),
        created_by: createdBy ?? ownerId,
      });
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return getActor(db, actorId);
  }

  db.prepare(`INSERT INTO actors (actor_id, type, display_name, status, created_at, created_by)
    VALUES (?, ?, ?, 'active', ?, ?)`).run(actorId, type, displayName, now, createdBy);
  appendDefinitionEvent(db, {
    object_type: 'actor', object_id: actorId, event_type: 'actor.created',
    actor: createdBy ?? actorId, reason: `创建主体：${displayName}`, occurred_at: now,
  });
  return getActor(db, actorId);
}

/** 启用/停用主体；停用后其凭据立即失效。 */
export function setActorStatus(db, actorId, status, patch = {}) {
  if (!ACTOR_STATUSES.includes(status)) throw new Error(`非法的主体状态：${status}`);
  const actor = getActor(db, actorId);
  if (!actor) throw Object.assign(new Error(`主体不存在：${actorId}`), { status: 404 });
  const actorName = pick(patch, 'actor') ?? 'system';
  const now = nowIso();
  db.prepare('UPDATE actors SET status = ? WHERE actor_id = ?').run(status, actorId);
  appendDefinitionEvent(db, {
    object_type: 'actor', object_id: actorId,
    event_type: status === 'disabled' ? 'actor.disabled' : 'actor.enabled',
    actor: actorName, reason: pick(patch, 'reason') ?? `主体状态改为 ${status}`, occurred_at: now,
  });
  return getActor(db, actorId);
}

// ------------------------------------------------------------------ 凭据

/** 签发凭据；返回 { credential, token }，token 明文只出现这一次。 */
export function issueCredential(db, actorId, input = {}) {
  const actor = getActor(db, actorId);
  if (!actor) throw Object.assign(new Error(`主体不存在：${actorId}`), { status: 404 });
  if (actor.status !== 'active') throw codedError('ACTOR_DISABLED', '主体已停用，不能签发凭据', 409);

  const credentialId = newId('cred');
  const token = `sap_${crypto.randomBytes(24).toString('hex')}`;
  const now = nowIso();
  db.prepare(`INSERT INTO actor_credentials (
    credential_id, actor_id, token_hash, label, expires_at, revoked_at, last_used_at, created_at
  ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`).run(
    credentialId, actorId, hashToken(token), pick(input, 'label'),
    pick(input, 'expires_at', 'expiresAt'), now,
  );
  appendDefinitionEvent(db, {
    object_type: 'credential', object_id: credentialId, event_type: 'credential.issued',
    actor: actorId, reason: `为 ${actor.display_name} 签发凭据`, refs: [actorId], occurred_at: now,
  });
  const credential = db.prepare('SELECT * FROM actor_credentials WHERE credential_id = ?').get(credentialId);
  return { credential: { ...credential, token_hash: undefined }, token };
}

/** 撤销凭据；已撤销的再次撤销保持幂等。 */
export function revokeCredential(db, credentialId, patch = {}) {
  const credential = db.prepare('SELECT * FROM actor_credentials WHERE credential_id = ?').get(credentialId);
  if (!credential) throw Object.assign(new Error(`凭据不存在：${credentialId}`), { status: 404 });
  if (credential.revoked_at) return { ...credential, token_hash: undefined };
  const now = nowIso();
  db.prepare('UPDATE actor_credentials SET revoked_at = ? WHERE credential_id = ?').run(now, credentialId);
  appendDefinitionEvent(db, {
    object_type: 'credential', object_id: credentialId, event_type: 'credential.revoked',
    actor: pick(patch, 'actor') ?? credential.actor_id,
    reason: pick(patch, 'reason') ?? '撤销凭据', refs: [credential.actor_id], occurred_at: now,
  });
  return { ...db.prepare('SELECT * FROM actor_credentials WHERE credential_id = ?').get(credentialId), token_hash: undefined };
}

/**
 * 用 token 解析主体；校验撤销、过期、主体停用。
 * 成功时更新 last_used_at，并返回 { actor, credential }；失败返回 null。
 */
export function findActorByToken(db, token) {
  if (!token || typeof token !== 'string') return null;
  const credential = db.prepare('SELECT * FROM actor_credentials WHERE token_hash = ?').get(hashToken(token));
  if (!credential) return null;
  if (credential.revoked_at) return null;
  if (credential.expires_at && credential.expires_at <= nowIso()) return null;
  const actor = getActor(db, credential.actor_id);
  if (!actor || actor.status !== 'active') return null;
  db.prepare('UPDATE actor_credentials SET last_used_at = ? WHERE credential_id = ?')
    .run(nowIso(), credential.credential_id);
  return { actor, credential: { ...credential, token_hash: undefined } };
}

// ------------------------------------------------------------------ 委派

function createDelegationCore(db, input = {}) {
  const agentId = required(input, 'agent_actor_id', 'agentActorId');
  const ownerId = required(input, 'on_behalf_of', 'onBehalfOf');
  const agent = getActor(db, agentId);
  if (!agent) throw new Error(`Agent 不存在：${agentId}`);
  if (agent.type !== 'agent') throw new Error(`委派主体必须是 agent：${agentId}`);
  const owner = getActor(db, ownerId);
  if (!owner) throw new Error(`责任人不存在：${ownerId}`);
  if (owner.type !== 'human') throw new Error(`责任人必须是 human：${ownerId}`);

  const projectId = pick(input, 'project_id', 'projectId');
  if (projectId) assertProjectExists(db, projectId);
  const actions = pick(input, 'allowed_actions', 'allowedActions');
  const allowed = Array.isArray(actions)
    ? actions.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
    : [];
  const now = nowIso();
  const delegationId = newId('dlg');
  db.prepare(`INSERT INTO delegations (
    delegation_id, agent_actor_id, on_behalf_of, project_id, allowed_actions,
    valid_from, valid_until, revoked_at, created_by, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`).run(
    delegationId, agentId, ownerId, projectId ?? null, encodeJson(allowed),
    pick(input, 'valid_from', 'validFrom') ?? now,
    pick(input, 'valid_until', 'validUntil') ?? addDays(DEFAULT_DELEGATION_DAYS),
    pick(input, 'created_by', 'createdBy') ?? ownerId, now,
  );
  appendDefinitionEvent(db, {
    object_type: 'delegation', object_id: delegationId, event_type: 'delegation.created',
    actor: pick(input, 'created_by', 'createdBy') ?? ownerId,
    reason: `委派 ${agentId} 代表 ${ownerId}`,
    refs: [agentId, ownerId, projectId].filter(Boolean), occurred_at: now,
  });
  return getDelegation(db, delegationId);
}

/** 新建委派（Agent 代表人类）。 */
export function createDelegation(db, input = {}) {
  return createDelegationCore(db, input);
}

export function getDelegation(db, delegationId) {
  return parseDelegation(db.prepare('SELECT * FROM delegations WHERE delegation_id = ?').get(delegationId));
}

/** 撤销委派；已撤销保持幂等。 */
export function revokeDelegation(db, delegationId, patch = {}) {
  const delegation = getDelegation(db, delegationId);
  if (!delegation) throw Object.assign(new Error(`委派不存在：${delegationId}`), { status: 404 });
  if (delegation.revoked_at) return delegation;
  const now = nowIso();
  db.prepare('UPDATE delegations SET revoked_at = ? WHERE delegation_id = ?').run(now, delegationId);
  appendDefinitionEvent(db, {
    object_type: 'delegation', object_id: delegationId, event_type: 'delegation.revoked',
    actor: pick(patch, 'actor') ?? delegation.on_behalf_of,
    reason: pick(patch, 'reason') ?? '撤销委派',
    refs: [delegation.agent_actor_id, delegation.on_behalf_of].filter(Boolean), occurred_at: now,
  });
  return getDelegation(db, delegationId);
}

/** 列出委派，可按 agent_actor_id / project_id 过滤。 */
export function listDelegations(db, query = {}) {
  const clauses = [];
  const params = [];
  for (const [key, column] of [['agent_actor_id', 'agent_actor_id'], ['project_id', 'project_id']]) {
    const value = pick(query, key, key === 'agent_actor_id' ? 'agentActorId' : key);
    if (value !== undefined) {
      clauses.push(`${column} = ?`);
      params.push(value);
    }
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM delegations ${where} ORDER BY created_at ASC, delegation_id ASC`)
    .all(...params).map(parseDelegation);
}

/**
 * 取该 Agent 在指定项目上当前有效的委派：
 * 未撤销、在有效期内，且 project_id 为空（全项目）或等于目标项目。
 * 项目级委派优先于全项目委派。
 */
export function activeDelegationFor(db, agentId, projectId) {
  const now = nowIso();
  const rows = db.prepare(`SELECT * FROM delegations
    WHERE agent_actor_id = ? AND revoked_at IS NULL
      AND valid_from <= ? AND valid_until >= ?
      AND (project_id IS NULL OR project_id = ?)
    ORDER BY (project_id IS NULL) ASC, valid_until DESC`)
    .all(agentId, now, now, projectId ?? null);
  return rows.length ? parseDelegation(rows[0]) : null;
}

// -------------------------------------------------------------- 项目成员

/** 添加或更新项目成员角色。 */
export function addMember(db, projectId, input = {}) {
  assertProjectExists(db, projectId);
  const actorId = required(input, 'actor_id', 'actorId');
  const actor = getActor(db, actorId);
  if (!actor) throw Object.assign(new Error(`主体不存在：${actorId}`), { status: 404 });
  const roles = pick(input, 'roles');
  const list = Array.isArray(roles) ? roles : [];
  if (list.length === 0) throw new Error('roles 必须是非空数组');
  for (const role of list) {
    if (!PROJECT_ROLES.includes(role)) throw new Error(`非法的项目角色：${role}`);
  }
  const now = nowIso();
  db.prepare(`INSERT INTO project_members (project_id, actor_id, roles, added_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (project_id, actor_id) DO UPDATE SET roles = excluded.roles`)
    .run(projectId, actorId, encodeJson(list), now);
  appendEvent(db, {
    project_id: projectId, object_type: 'project_member', object_id: actorId,
    event_type: 'member.added', actor: pick(input, 'created_by', 'createdBy') ?? actorId,
    occurred_at: now, reason: `角色：${list.join(', ')}`, refs: [actorId],
  });
  return getMember(db, projectId, actorId);
}

export function getMember(db, projectId, actorId) {
  return parseMember(db.prepare('SELECT * FROM project_members WHERE project_id = ? AND actor_id = ?')
    .get(projectId, actorId));
}

export function listMembers(db, projectId) {
  return db.prepare('SELECT * FROM project_members WHERE project_id = ? ORDER BY added_at ASC, actor_id ASC')
    .all(projectId).map(parseMember);
}
