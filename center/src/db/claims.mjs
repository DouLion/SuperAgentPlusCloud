// 认领与租约（P2）：角色化认领、心跳续租、fencing 与过期回收。
// 认领是有期限的权利：过期或撤销后旧 token 不可再写入。

import { appendEvent } from './events.mjs';
import { enqueueFromEvent } from '../protocol/outbox.mjs';
import { getTask } from './tasks.mjs';
import {
  codedError,
  newId,
  nowIso,
  pick,
} from './json.mjs';

export const CLAIM_ROLES = ['owner', 'collaborator'];
export const DEFAULT_LEASE_SECONDS = 1800;

const ACTIVE = "status = 'active'";

function toIso(ms) {
  return new Date(ms).toISOString();
}

function leaseSeconds(input) {
  const raw = pick(input, 'ttl_seconds', 'ttlSeconds', 'ttl');
  const value = raw === undefined ? DEFAULT_LEASE_SECONDS : Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error('ttl_seconds 必须是正数');
  return Math.trunc(value);
}

function parseClaim(row) {
  return row ?? null;
}

/** 按 ID 查询认领；不存在返回 null。 */
export function getClaim(db, claimId) {
  return parseClaim(db.prepare('SELECT * FROM claims WHERE claim_id = ?').get(claimId));
}

/** 列出某任务的全部认领（历史保留，按认领时间升序）。 */
export function listClaims(db, taskId) {
  if (!getTask(db, taskId)) throw new Error(`任务不存在：${taskId}`);
  return db
    .prepare(`SELECT * FROM claims WHERE task_id = ?
      ORDER BY claimed_at ASC, claim_id ASC`)
    .all(taskId);
}

/** 取任务当前 active 的 owner 认领；没有返回 null。 */
export function activeOwnerClaim(db, taskId) {
  return parseClaim(
    db.prepare(`SELECT * FROM claims WHERE task_id = ? AND ${ACTIVE} AND role = 'owner'
      ORDER BY claimed_at ASC, claim_id ASC LIMIT 1`).get(taskId),
  );
}

/** 取任务当前所有 active 认领。 */
export function activeClaims(db, taskId) {
  return db.prepare(`SELECT * FROM claims WHERE task_id = ? AND ${ACTIVE}
    ORDER BY claimed_at ASC, claim_id ASC`).all(taskId);
}

/** 任务是否可被 owner 认领。 */
function claimableStatus(status) {
  return status === 'open' || status === 'rework';
}

/**
 * 认领任务。
 * - role=owner：任务须为 open/rework，且当前无 active owner；成功后任务置 claimed。
 * - role=collaborator：任务须已有 active owner；不改任务状态。
 * fencing_token 取该任务历史最大值 +1，事务内计算。
 * @returns {{ task: object, claim: object }}
 */
export function claimTask(db, taskId, actorId, options = {}) {
  const workerId = actorId ?? pick(options, 'actor_id', 'actorId', 'worker_id', 'workerId');
  if (workerId === undefined || workerId === null || workerId === '') {
    throw new Error('缺少必填字段：worker_id');
  }
  const role = pick(options, 'role') ?? 'owner';
  if (!CLAIM_ROLES.includes(role)) throw new Error(`非法的认领角色：${role}`);
  const ttl = leaseSeconds(options);

  const task = getTask(db, taskId);
  if (!task) throw new Error(`任务不存在：${taskId}`);

  let claimId;
  db.exec('BEGIN');
  try {
    const existingOwner = activeOwnerClaim(db, taskId);

    if (role === 'owner') {
      if (!claimableStatus(task.status) || existingOwner) {
        throw codedError('TASK_NOT_CLAIMABLE', '任务已被认领或不可认领', 409);
      }
      const moved = db.prepare(`UPDATE tasks SET status = 'claimed', revision = revision + 1
        WHERE task_id = ? AND status IN ('open', 'rework')`).run(taskId);
      if (moved.changes === 0) {
        throw codedError('TASK_NOT_CLAIMABLE', '任务已被认领或不可认领', 409);
      }
    } else if (!existingOwner) {
      throw codedError('CLAIM_OWNER_REQUIRED', '协作者认领前需要先有 owner 认领', 409);
    }

    const now = nowIso();
    const nextToken = Number(
      db.prepare('SELECT COALESCE(MAX(fencing_token), 0) + 1 AS next FROM claims WHERE task_id = ?')
        .get(taskId).next,
    );
    const attemptNo = Number(
      db.prepare(`SELECT COUNT(*) + 1 AS n FROM claims WHERE task_id = ? AND role = 'owner'`)
        .get(taskId).n,
    );
    claimId = newId('clm');
    db.prepare(`INSERT INTO claims (
      claim_id, task_id, worker_id, actor_id, role, claimed_at, heartbeat_at,
      lease_expires_at, fencing_token, attempt_no, released_at, released_reason, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'active', ?)`).run(
      claimId, taskId, workerId, workerId, role, now, now, toIso(Date.now() + ttl * 1000),
      nextToken, role === 'owner' ? attemptNo : 1, now,
    );

    const claimedEvent = appendEvent(db, {
      project_id: task.project_id,
      object_type: 'task',
      object_id: taskId,
      event_type: 'claim.claimed',
      actor: workerId,
      occurred_at: now,
      reason: role === 'owner' ? '认领任务' : '作为协作者加入任务',
      refs: [taskId, claimId],
    });
    enqueueFromEvent(db, claimedEvent);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { task: getTask(db, taskId), claim: getClaim(db, claimId) };
}

/**
 * 心跳续租：仅本人、仅 active、未过期。
 * 已过期则先标记 expired（owner 同时释放任务），再抛 LEASE_EXPIRED。
 */
export function heartbeatClaim(db, claimId, actorId, options = {}) {
  const ttl = leaseSeconds(options);
  const claim = getClaim(db, claimId);
  if (!claim) throw codedError('CLAIM_NOT_FOUND', `认领不存在：${claimId}`, 404);
  if (claim.actor_id !== actorId && claim.worker_id !== actorId) {
    throw codedError('CLAIM_NOT_HEARTBEATABLE', '只有认领者本人可以续租', 409);
  }
  if (claim.status !== 'active') {
    throw codedError('CLAIM_NOT_HEARTBEATABLE', `认领当前状态不可续租：${claim.status}`, 409);
  }
  const nowMs = Date.now();
  if (claim.lease_expires_at && claim.lease_expires_at <= nowIso()) {
    expireClaim(db, claim, 'lease_expired');
    throw codedError('LEASE_EXPIRED', '租约已过期，需要重新认领', 409);
  }

  const now = nowIso();
  db.prepare(`UPDATE claims SET heartbeat_at = ?, lease_expires_at = ? WHERE claim_id = ?`)
    .run(now, toIso(nowMs + ttl * 1000), claimId);
  return getClaim(db, claimId);
}

/** 内部：把单个认领置为过期；owner 过期时任务回 open。 */
function expireClaim(db, claim, reason) {
  const now = nowIso();
  db.prepare(`UPDATE claims SET status = 'expired', released_at = ?, released_reason = ?
    WHERE claim_id = ? AND status = 'active'`).run(now, reason, claim.claim_id);
  if (claim.role === 'owner') {
    db.prepare(`UPDATE tasks SET status = 'open', revision = revision + 1
      WHERE task_id = ? AND status = 'claimed'`).run(claim.task_id);
  }
  const task = getTask(db, claim.task_id);
  if (task) {
    const expiredEvent = appendEvent(db, {
      project_id: task.project_id,
      object_type: 'task',
      object_id: claim.task_id,
      event_type: 'claim.expired',
      actor: claim.actor_id ?? claim.worker_id,
      occurred_at: now,
      reason,
      refs: [claim.claim_id],
    });
    enqueueFromEvent(db, expiredEvent);
  }
}

/**
 * 回收所有过期租约。幂等，可在读路径上惰性调用。
 * @returns {number} 本次回收数量
 */
export function expireLeases(db, options = {}) {
  const projectId = pick(options, 'project_id', 'projectId');
  const now = nowIso();
  const rows = projectId
    ? db.prepare(`SELECT c.* FROM claims c JOIN tasks t ON t.task_id = c.task_id
        WHERE c.status = 'active' AND c.lease_expires_at IS NOT NULL
          AND c.lease_expires_at < ? AND t.project_id = ?`).all(now, projectId)
    : db.prepare(`SELECT * FROM claims WHERE status = 'active'
        AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`).all(now);
  if (rows.length === 0) return 0;
  db.exec('BEGIN');
  try {
    for (const claim of rows) expireClaim(db, claim, 'lease_expired');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return rows.length;
}

/** 释放认领：仅本人 active；owner 释放时任务回 open。 */
export function releaseClaim(db, claimId, actorId, options = {}) {
  const claim = getClaim(db, claimId);
  if (!claim) throw codedError('CLAIM_NOT_FOUND', `认领不存在：${claimId}`, 404);
  if (claim.status !== 'active') {
    throw codedError('CLAIM_NOT_RELEASABLE', `认领当前状态不可释放：${claim.status}`, 409);
  }
  if (claim.actor_id !== actorId && claim.worker_id !== actorId) {
    throw codedError('CLAIM_NOT_RELEASABLE', '只有认领者本人可以释放该认领', 409);
  }

  const now = nowIso();
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE claims SET status = 'released', released_at = ?, released_reason = ?
      WHERE claim_id = ?`).run(now, pick(options, 'reason') ?? 'released', claimId);
    if (claim.role === 'owner') {
      db.prepare(`UPDATE tasks SET status = 'open', revision = revision + 1
        WHERE task_id = ? AND status = 'claimed'`).run(claim.task_id);
    }
    const task = getTask(db, claim.task_id);
    appendEvent(db, {
      project_id: task?.project_id,
      object_type: 'task',
      object_id: claim.task_id,
      event_type: 'claim.released',
      actor: actorId,
      occurred_at: now,
      reason: pick(options, 'reason') ?? '认领者释放',
      refs: [claimId],
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { task: getTask(db, claim.task_id), claim: getClaim(db, claimId) };
}

/** 旧接口兼容：按任务与 worker 释放当前 active 认领。 */
export function releaseTask(db, taskId, workerId) {
  if (!getTask(db, taskId)) throw new Error(`任务不存在：${taskId}`);
  const claim = db.prepare(`SELECT * FROM claims WHERE task_id = ? AND ${ACTIVE}
    ORDER BY claimed_at ASC, claim_id ASC LIMIT 1`).get(taskId);
  if (!claim) {
    throw codedError('CLAIM_NOT_RELEASABLE', '任务当前没有可释放的活跃认领', 409);
  }
  if (claim.actor_id !== workerId && claim.worker_id !== workerId) {
    throw codedError('CLAIM_NOT_RELEASABLE', '只有认领者本人可以释放该任务', 409);
  }
  return releaseClaim(db, claim.claim_id, workerId, { reason: 'claim.released' });
}

/**
 * 校验认领仍然有效：active、未过期、actor 匹配，可选 fencing_token 一致。
 * @returns {object} 有效认领
 */
export function assertClaimValid(db, claimId, options = {}) {
  const claim = getClaim(db, claimId);
  if (!claim) throw codedError('CLAIM_NOT_FOUND', `认领不存在：${claimId}`, 404);
  if (claim.status !== 'active') {
    if (claim.status === 'expired') {
      throw codedError('LEASE_EXPIRED', '租约已过期，需要重新认领', 409);
    }
    throw codedError('CLAIM_NOT_ACTIVE', `认领当前状态：${claim.status}`, 409);
  }
  if (claim.lease_expires_at && claim.lease_expires_at <= nowIso()) {
    expireClaim(db, claim, 'lease_expired');
    throw codedError('LEASE_EXPIRED', '租约已过期，需要重新认领', 409);
  }
  const actorId = pick(options, 'actor_id', 'actorId', 'worker_id', 'workerId');
  if (actorId && claim.actor_id !== actorId && claim.worker_id !== actorId) {
    throw codedError('CLAIM_NOT_OWNED', '该认领不属于当前主体', 409);
  }
  const token = pick(options, 'fencing_token', 'fencingToken');
  if (token !== undefined && Number(token) !== Number(claim.fencing_token)) {
    throw codedError('FENCING_TOKEN_MISMATCH', 'fencing token 与当前认领不一致', 409);
  }
  return claim;
}
