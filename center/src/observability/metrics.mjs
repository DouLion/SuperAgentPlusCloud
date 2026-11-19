// 观测层（P5）：主体在线状态、卡住任务识别、流水线指标。
// 只读计算，不写任何业务状态；所有时间判断基于传入的 now，便于测试。

import { listActors } from '../db/actors.mjs';
import { getTask } from '../db/tasks.mjs';

/** 在线判定窗口：最近凭据使用在 15 分钟内视为 online。 */
export const ONLINE_WINDOW_MS = 15 * 60 * 1000;
/** 租约剩余不足 5 分钟视为即将到期。 */
export const LEASE_WARNING_MS = 5 * 60 * 1000;
/** 提交后超过 24 小时未评审视为逾期。 */
export const REVIEW_OVERDUE_MS = 24 * 60 * 60 * 1000;
/** 心跳停滞倍数：超过 2 倍租约时长没有心跳视为停滞。 */
export const HEARTBEAT_STALE_FACTOR = 2;

function ms(value) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

/**
 * 每个主体的运行状态。
 * @returns {Array<{actor_id,type,status,display_name,last_used_at,presence,active_claims,capabilities}>}
 */
export function actorStatus(db, now = Date.now()) {
  const actors = listActors(db, {});
  const rows = [];
  for (const actor of actors) {
    const credential = db.prepare(`SELECT MAX(last_used_at) AS last_used_at
      FROM actor_credentials WHERE actor_id = ?`).get(actor.actor_id);
    const lastUsed = credential?.last_used_at ?? null;
    const lastUsedMs = ms(lastUsed);
    let presence = 'never';
    if (lastUsedMs !== null) presence = (now - lastUsedMs) <= ONLINE_WINDOW_MS ? 'online' : 'idle';

    const activeClaims = Number(db.prepare(`SELECT COUNT(*) AS n FROM claims
      WHERE (actor_id = ? OR worker_id = ?) AND status = 'active'`)
      .get(actor.actor_id, actor.actor_id).n);

    const capabilities = Object.fromEntries(
      db.prepare('SELECT key, level FROM actor_capabilities WHERE actor_id = ?')
        .all(actor.actor_id)
        .map((row) => [row.key, row.level]),
    );

    rows.push({
      actor_id: actor.actor_id,
      type: actor.type,
      status: actor.status,
      display_name: actor.display_name,
      last_used_at: lastUsed,
      presence,
      active_claims: activeClaims,
      capabilities,
    });
  }
  return rows;
}

/** 某任务最近一次提交时间（用于判断租约即将到期时是否仍有产出）。 */
function lastSubmissionAt(db, taskId) {
  const row = db.prepare(`SELECT MAX(submitted_at) AS at FROM submissions WHERE task_id = ?`).get(taskId);
  return row?.at ?? null;
}

/**
 * 识别卡住的任务，返回三类问题：
 * - lease_expiring：租约 5 分钟内到期，且期间没有新提交；
 * - review_overdue：submitted 超过 24 小时仍未评审；
 * - heartbeat_stale：心跳超过 2 倍租约时长没有更新。
 */
export function stuckTasks(db, now = Date.now(), query = {}) {
  const projectId = query.project_id ?? null;
  const params = [];
  let where = "WHERE t.status IN ('claimed', 'submitted')";
  if (projectId) {
    where += ' AND t.project_id = ?';
    params.push(projectId);
  }
  const tasks = db.prepare(`SELECT t.* FROM tasks t ${where}`).all(...params);
  const stuck = [];

  for (const task of tasks) {
    if (task.status === 'submitted') {
      const submittedAt = lastSubmissionAt(db, task.task_id);
      const submittedMs = ms(submittedAt);
      if (submittedMs !== null && (now - submittedMs) >= REVIEW_OVERDUE_MS) {
        stuck.push({
          kind: 'review_overdue',
          task_id: task.task_id,
          project_id: task.project_id,
          since: submittedAt,
          detail: `提交后已 ${Math.floor((now - submittedMs) / 3600000)} 小时未评审`,
        });
      }
      continue;
    }

    const claim = db.prepare(`SELECT * FROM claims
      WHERE task_id = ? AND status = 'active' AND role = 'owner'`).get(task.task_id);
    if (!claim) continue;

    const expiresMs = ms(claim.lease_expires_at);
    const heartbeatMs = ms(claim.heartbeat_at) ?? ms(claim.claimed_at);
    const leaseMs = expiresMs !== null && heartbeatMs !== null ? expiresMs - heartbeatMs : null;
    const submittedAt = ms(lastSubmissionAt(db, task.task_id));

    if (expiresMs !== null && expiresMs - now <= LEASE_WARNING_MS && expiresMs > now) {
      const progressed = submittedAt !== null && heartbeatMs !== null && submittedAt >= heartbeatMs;
      if (!progressed) {
        stuck.push({
          kind: 'lease_expiring',
          task_id: task.task_id,
          project_id: task.project_id,
          claim_id: claim.claim_id,
          actor_id: claim.actor_id,
          lease_expires_at: claim.lease_expires_at,
          detail: '租约即将到期且没有新提交',
        });
      }
    }

    if (leaseMs !== null && heartbeatMs !== null && (now - heartbeatMs) > leaseMs * HEARTBEAT_STALE_FACTOR) {
      stuck.push({
        kind: 'heartbeat_stale',
        task_id: task.task_id,
        project_id: task.project_id,
        claim_id: claim.claim_id,
        actor_id: claim.actor_id,
        last_heartbeat_at: claim.heartbeat_at,
        detail: '心跳停滞超过 2 倍租约时长',
      });
    }
  }
  return stuck;
}

function averageOf(values) {
  const list = values.filter((value) => Number.isFinite(value) && value >= 0);
  if (!list.length) return null;
  return list.reduce((sum, value) => sum + value, 0) / list.length;
}

/**
 * 流水线指标。
 * @param {object} query { project_id }
 */
export function pipelineStats(db, query = {}, now = Date.now()) {
  const projectId = query.project_id ?? null;
  const taskFilter = projectId ? 'WHERE project_id = ?' : '';
  const taskParams = projectId ? [projectId] : [];

  const statusRows = db.prepare(`SELECT status, COUNT(*) AS n FROM tasks ${taskFilter}
    GROUP BY status`).all(...taskParams);
  const byStatus = Object.fromEntries(statusRows.map((row) => [row.status, Number(row.n)]));

  const claimFilter = projectId ? 'WHERE t.project_id = ?' : '';
  const claims = db.prepare(`SELECT c.*, t.created_at AS task_created_at
    FROM claims c JOIN tasks t ON t.task_id = c.task_id ${claimFilter}`).all(...taskParams);

  const firstClaimByTask = new Map();
  for (const claim of claims) {
    if (claim.role !== 'owner') continue;
    const current = firstClaimByTask.get(claim.task_id);
    if (!current || claim.claimed_at < current) firstClaimByTask.set(claim.task_id, claim.claimed_at);
  }
  const claimLatency = [];
  for (const [taskId, claimedAt] of firstClaimByTask) {
    const task = db.prepare('SELECT created_at FROM tasks WHERE task_id = ?').get(taskId);
    const createdMs = ms(task?.created_at);
    const claimedMs = ms(claimedAt);
    if (createdMs !== null && claimedMs !== null && claimedMs >= createdMs) {
      claimLatency.push(claimedMs - createdMs);
    }
  }

  const ownerClaims = claims.filter((claim) => claim.role === 'owner');
  const expiredOwners = ownerClaims.filter((claim) => claim.status === 'expired').length;
  const leaseExpiryRate = ownerClaims.length ? expiredOwners / ownerClaims.length : 0;

  const reviews = db.prepare(`SELECT r.reviewed_at, s.submitted_at
    FROM reviews r JOIN submissions s ON s.submission_id = r.submission_id
    ${projectId ? 'JOIN tasks t ON t.task_id = s.task_id WHERE t.project_id = ?' : ''}`)
    .all(...taskParams);
  const reviewLatency = reviews
    .map((row) => {
      const submitted = ms(row.submitted_at);
      const reviewed = ms(row.reviewed_at);
      return submitted !== null && reviewed !== null && reviewed >= submitted ? reviewed - submitted : null;
    })
    .filter((value) => value !== null);

  const idempotencyReplays = Number(
    db.prepare('SELECT COALESCE(SUM(replay_count), 0) AS n FROM command_ledger').get()?.n ?? 0,
  );
  const outboxPending = Number(
    db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE delivered_at IS NULL').get()?.n ?? 0,
  );

  return {
    project_id: projectId,
    generated_at: new Date(now).toISOString(),
    tasks_by_status: byStatus,
    tasks_total: Object.values(byStatus).reduce((sum, value) => sum + value, 0),
    avg_claim_latency_ms: averageOf(claimLatency),
    lease_expiry_rate: Number(leaseExpiryRate.toFixed(4)),
    avg_review_latency_ms: averageOf(reviewLatency),
    idempotency_replays: idempotencyReplays,
    outbox_pending: outboxPending,
  };
}
