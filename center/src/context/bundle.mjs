// 任务上下文包（P4）：按主体权限投影的一份任务工作快照。
// 目的不是「把库全塞给模型」，而是给出带摘要、可追溯、可判断是否过期的快照。

import crypto from 'node:crypto';
import { HUMAN_ONLY } from '../auth/policy.mjs';
import { activeClaims, activeOwnerClaim } from '../db/claims.mjs';
import { listConventionPacks } from '../db/conventions.mjs';
import { listArtifacts } from '../db/artifacts.mjs';
import { getRequirement } from '../db/requirements.mjs';
import { listReviews, listSubmissions } from '../db/submissions.mjs';
import { getTask } from '../db/tasks.mjs';
import { listTrunkItems } from '../db/trunk.mjs';
import { nowIso } from '../db/json.mjs';

/** 稳定序列化：对象键排序，保证同样内容得到同样摘要。 */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

/** 内容摘要。 */
export function digestOf(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

/** 取该主体在任务上的有效认领；没有则退回当前 owner 认领。 */
function leaseOf(db, taskId, actor) {
  if (actor?.actor_id) {
    const own = activeClaims(db, taskId)
      .find((claim) => claim.actor_id === actor.actor_id || claim.worker_id === actor.actor_id);
    if (own) return own;
  }
  return activeOwnerClaim(db, taskId);
}

/** 该主体可执行的动作集合。 */
function allowedActions(actor, delegation) {
  if (!actor) return [];
  if (actor.type === 'human') return ['all'];
  if (actor.type === 'service') return ['claim', 'report', 'submit'];
  return delegation?.allowed_actions?.length
    ? delegation.allowed_actions
    : ['claim', 'report', 'submit'];
}

/**
 * 构建任务上下文。
 * @param {object} db
 * @param {string} taskId
 * @param {object} [options] { actor, delegation }
 * @returns {object} 上下文包；任务不存在时抛 404
 */
export function buildTaskContext(db, taskId, options = {}) {
  const task = getTask(db, taskId);
  if (!task) throw Object.assign(new Error(`任务不存在：${taskId}`), { status: 404 });

  const actor = options.actor ?? null;
  const delegation = options.delegation ?? null;
  const requirement = task.requirement_id ? getRequirement(db, task.requirement_id) : null;
  const activeTrunk = listTrunkItems(db, { project_id: task.project_id, status: 'active' });
  const activeConventions = listConventionPacks(db, { project_id: task.project_id, status: 'active' });
  const contracts = listArtifacts(db, {
    project_id: task.project_id,
    type: 'api_contract',
    status: 'published',
  }).map(({ artifact_id, name, version, digest }) => ({ artifact_id, name, version, digest }));

  const submissions = listSubmissions(db, { task_id: taskId });
  const reviewHistory = submissions.flatMap((submission) => (
    listReviews(db, submission.submission_id).map((review) => ({
      submission_id: submission.submission_id,
      review_id: review.review_id,
      conclusion: review.conclusion,
      reviewer_id: review.reviewer_id,
      reviewer_actor_type: review.reviewer_actor_type ?? null,
      reviewed_at: review.reviewed_at,
    }))
  ));

  const claim = leaseOf(db, taskId, actor);
  const lease = claim
    ? {
      claim_id: claim.claim_id,
      role: claim.role ?? 'owner',
      fencing_token: claim.fencing_token ?? null,
      lease_expires_at: claim.lease_expires_at ?? null,
      heartbeat_at: claim.heartbeat_at ?? null,
    }
    : null;

  // 过期判断：以认领时间为基准比较契约发布与约定激活时间。
  const since = claim?.claimed_at ?? task.created_at;
  const contractsChanged = listArtifacts(db, {
    project_id: task.project_id, type: 'api_contract', status: 'published',
  }).some((row) => (row.published_at ?? row.created_at) > since);
  const conventionsChanged = activeConventions.some((pack) => (pack.activated_at ?? pack.created_at) > since);

  const core = {
    task,
    requirement,
    active_trunk: activeTrunk,
    active_conventions: activeConventions,
    relevant_contracts: contracts,
    prior_submissions: submissions,
    review_history: reviewHistory,
    lease,
    policy: {
      allowed_actions: allowedActions(actor, delegation),
      human_only: [...HUMAN_ONLY],
    },
    staleness: {
      contracts_changed_since_claim: contractsChanged,
      conventions_changed_since_claim: conventionsChanged,
    },
    digests: {
      task: digestOf(task),
      requirement: requirement ? digestOf(requirement) : null,
      trunk: digestOf(activeTrunk),
      conventions: digestOf(activeConventions),
      contracts: digestOf(contracts),
    },
    generated_at: nowIso(),
  };

  // 无凭据（legacy）时降级：只给任务本身与策略提示，不投影项目级内容。
  if (!actor) {
    return {
      task,
      requirement: requirement ? { requirement_id: requirement.requirement_id, status: requirement.status } : null,
      active_trunk: [],
      active_conventions: [],
      relevant_contracts: [],
      prior_submissions: [],
      review_history: [],
      lease,
      policy: { allowed_actions: [], human_only: [...HUMAN_ONLY] },
      staleness: { contracts_changed_since_claim: false, conventions_changed_since_claim: false },
      digests: { task: core.digests.task, requirement: core.digests.requirement, trunk: null, conventions: null, contracts: null },
      degraded: true,
      degraded_reason: '缺少有效凭据：只返回任务级字段',
      generated_at: core.generated_at,
    };
  }

  return { ...core, degraded: false };
}

/** 任务上下文摘要（用于交付时判断是否基于同一份上下文）。 */
export function contextDigest(db, taskId, options = {}) {
  return contextDigestOf(buildTaskContext(db, taskId, options));
}

/** 对已构建的上下文取摘要：排除 generated_at，保证同一内容摘要稳定。 */
export function contextDigestOf(context) {
  const { generated_at: _ignored, ...rest } = context;
  return digestOf(rest);
}
