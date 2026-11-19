// Agent 接入路由（P4）：拉取为主，claim/heartbeat/deliver/release 走同一套租约与幂等。
// 所有接口要求 Bearer token，且主体必须是 agent 或 service。

import { activeDelegationFor } from '../../db/actors.mjs';
import {
  activeOwnerClaim,
  claimTask,
  DEFAULT_LEASE_SECONDS,
  expireLeases,
  getClaim,
  heartbeatClaim,
  releaseClaim,
} from '../../db/claims.mjs';
import { dependencyStatus, isReady } from '../../db/dependencies.mjs';
import { buildTaskContext, contextDigestOf } from '../../context/bundle.mjs';
import { createSubmission } from '../../db/submissions.mjs';
import { getTask, listTasks } from '../../db/tasks.mjs';
import { bearerToken, resolveRequestActor } from '../../auth/policy.mjs';
import { codedError } from '../../db/json.mjs';

/**
 * 解析并校验 Agent 主体。
 * @param {object} db
 * @param {object} req
 * @param {string|null} projectId 目标项目；agent 必须有覆盖该项目的有效委派
 * @returns {{actor: object, delegation: object|null}}
 */
export function requireAgentActor(db, req, projectId = null) {
  const token = bearerToken(req);
  if (!token) throw codedError('AUTH_REQUIRED', '此接口需要 Authorization: Bearer <token>', 401);
  const resolved = resolveRequestActor(db, req);
  if (!resolved) throw codedError('AUTH_INVALID', '凭据无效、已撤销或已过期', 401);

  const { actor } = resolved;
  if (actor.type === 'human') {
    throw codedError('AGENT_ENDPOINT_HUMAN', '人类主体请使用普通接口，agent/* 仅供 Agent 与服务账号', 400);
  }

  let delegation = null;
  if (actor.type === 'agent') {
    delegation = activeDelegationFor(db, actor.actor_id, projectId);
    if (!delegation) {
      throw codedError(
        'DELEGATION_REQUIRED',
        `Agent ${actor.actor_id} 在项目 ${projectId ?? '(全局)'} 上没有有效委派`,
        403,
      );
    }
  }
  return { actor, delegation };
}

/** 请求体里的 actor_id 必须与凭据一致，避免冒充。 */
function assertActorMatches(actor, body) {
  const claimed = body?.actor_id ?? body?.actorId;
  if (claimed && claimed !== actor.actor_id) {
    throw codedError('ACTOR_MISMATCH', '请求体中的 actor_id 与凭据不一致', 403);
  }
}

/** 取任务并校验项目级委派。 */
function taskWithActor(db, req, taskId, body) {
  const task = getTask(db, taskId);
  if (!task) throw Object.assign(new Error(`任务不存在：${taskId}`), { status: 404 });
  const { actor, delegation } = requireAgentActor(db, req, task.project_id);
  assertActorMatches(actor, body);
  return { task, actor, delegation };
}

export const ROUTES = [
  {
    method: 'GET',
    pattern: '/agent/inbox',
    handler: ({ db, url, req }) => {
      const projectId = url.searchParams.get('project_id') || null;
      const rawLimit = Number(url.searchParams.get('limit') || 20);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(Math.trunc(rawLimit), 100)
        : 20;
      const { actor } = requireAgentActor(db, req, projectId);

      // 读路径惰性回收过期租约，保证列表反映生效状态。
      expireLeases(db, projectId ? { project_id: projectId } : {});

      const tasks = listTasks(db, projectId ? { project_id: projectId } : {})
        .filter((task) => task.status === 'open' || task.status === 'rework')
        .filter((task) => isReady(db, task))
        .filter((task) => !activeOwnerClaim(db, task.task_id));

      return {
        actor_id: actor.actor_id,
        count: tasks.length,
        items: tasks.slice(0, limit).map((task) => ({
          task_id: task.task_id,
          project_id: task.project_id,
          purpose: task.purpose,
          done_when: task.done_when,
          serves_item_ids: task.serves_item_ids,
          blocked_by: task.blocked_by,
          lease_seconds: DEFAULT_LEASE_SECONDS,
        })),
      };
    },
  },
  {
    method: 'POST',
    pattern: '/agent/claim',
    handler: ({ db, body, req }) => {
      const taskId = body.task_id ?? body.taskId;
      if (!taskId) throw new Error('缺少必填字段：task_id');
      const { task, actor, delegation } = taskWithActor(db, req, taskId, body);

      const role = body.role ?? 'owner';
      if (role === 'owner' && !isReady(db, task)) {
        const status = dependencyStatus(db, task);
        throw Object.assign(
          codedError('TASK_BLOCKED', '任务依赖尚未满足，暂不可认领', 409),
          { details: { pending: status.pending, missing: status.missing } },
        );
      }

      const result = claimTask(db, taskId, actor.actor_id, {
        role,
        ttl_seconds: body.ttl_seconds ?? body.ttlSeconds,
      });
      const context = buildTaskContext(db, taskId, { actor, delegation });
      return {
        status: 201,
        body: {
          task: result.task,
          claim: result.claim,
          context_digest: contextDigestOf(context),
        },
      };
    },
  },
  {
    method: 'POST',
    pattern: '/agent/heartbeat',
    handler: ({ db, body, req }) => {
      const claimId = body.claim_id ?? body.claimId;
      if (!claimId) throw new Error('缺少必填字段：claim_id');
      const claim = getClaim(db, claimId);
      if (!claim) throw Object.assign(new Error(`认领不存在：${claimId}`), { status: 404 });
      const { actor } = taskWithActor(db, req, claim.task_id, body);
      const updated = heartbeatClaim(db, claimId, actor.actor_id, {
        ttl_seconds: body.ttl_seconds ?? body.ttlSeconds,
      });
      return { status: 200, body: updated };
    },
  },
  {
    method: 'POST',
    pattern: '/agent/deliver',
    handler: ({ db, body, req }) => {
      const claimId = body.claim_id ?? body.claimId;
      if (!claimId) throw new Error('缺少必填字段：claim_id');
      const claim = getClaim(db, claimId);
      if (!claim) throw Object.assign(new Error(`认领不存在：${claimId}`), { status: 404 });
      const { actor, delegation } = taskWithActor(db, req, claim.task_id, body);

      const currentDigest = contextDigestOf(
        buildTaskContext(db, claim.task_id, { actor, delegation }),
      );
      const supplied = body.context_digest ?? body.contextDigest;
      if (supplied && supplied !== currentDigest) {
        throw Object.assign(
          codedError('CONTEXT_STALE', '上下文已变化（契约或约定更新），请重新获取上下文再交付', 409),
          { details: { current_context_digest: currentDigest } },
        );
      }

      const submission = createSubmission(db, {
        task_id: claim.task_id,
        claim_id: claimId,
        fencing_token: body.fencing_token ?? body.fencingToken,
        commit_refs: body.commit_refs ?? body.commitRefs,
        summary: body.summary,
        self_test: body.self_test ?? body.selfTest,
        known_gaps: body.known_gaps ?? body.knownGaps,
        artifacts: body.artifacts,
        submitted_by: actor.actor_id,
      });

      return { status: 201, body: { submission, context_digest: currentDigest } };
    },
  },
  {
    method: 'POST',
    pattern: '/agent/release',
    handler: ({ db, body, req }) => {
      const claimId = body.claim_id ?? body.claimId;
      if (!claimId) throw new Error('缺少必填字段：claim_id');
      const claim = getClaim(db, claimId);
      if (!claim) throw Object.assign(new Error(`认领不存在：${claimId}`), { status: 404 });
      const { actor } = taskWithActor(db, req, claim.task_id, body);
      const result = releaseClaim(db, claimId, actor.actor_id, {
        reason: body.reason ?? 'agent.released',
      });
      return { status: 200, body: result };
    },
  },
];
