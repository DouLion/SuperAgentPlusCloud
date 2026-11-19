// Center HTTP 路由：任务、认领、租约与提交。

import {
  createTask,
  getTask,
  listTasks,
  openTask,
} from '../../db/tasks.mjs';
import {
  claimTask,
  expireLeases,
  heartbeatClaim,
  listClaims,
  releaseClaim,
  releaseTask,
} from '../../db/claims.mjs';
import { createSubmission, listSubmissions } from '../../db/submissions.mjs';

/** 读路径惰性回收过期租约，保证返回的是生效状态。 */
function sweep(db, projectId) {
  try {
    expireLeases(db, projectId ? { project_id: projectId } : {});
  } catch {
    // 回收失败不应阻断读取。
  }
}

export const ROUTES = [
  {
    method: 'GET',
    pattern: '/tasks',
    handler: ({ url, db }) => {
      const query = {};
      for (const key of ['project_id', 'status', 'requirement_id']) {
        const value = url.searchParams.get(key);
        if (value) query[key] = value;
      }
      sweep(db, query.project_id);
      return listTasks(db, query);
    },
  },
  {
    method: 'POST',
    pattern: '/tasks',
    handler: ({ body, db }) => {
      const task = createTask(db, body);
      return { status: 201, body: openTask(db, task.task_id, { actor: body.created_by }) };
    },
  },
  {
    method: 'GET',
    pattern: '/tasks/:id',
    handler: ({ params, db }) => {
      sweep(db);
      const task = getTask(db, params.id);
      if (!task) {
        return { status: 404, body: { ok: false, error: `任务不存在：${params.id}` } };
      }
      return task;
    },
  },
  {
    method: 'POST',
    pattern: '/tasks/:id/claim',
    handler: ({ params, body, db }) => ({
      status: 201,
      body: claimTask(db, params.id, body.actor_id ?? body.actorId ?? body.worker_id ?? body.workerId, {
        role: body.role,
        ttl_seconds: body.ttl_seconds ?? body.ttlSeconds,
        worker_id: body.worker_id ?? body.workerId,
      }),
    }),
  },
  {
    method: 'POST',
    pattern: '/tasks/:id/join',
    handler: ({ params, body, db }) => ({
      status: 201,
      body: claimTask(db, params.id, body.actor_id ?? body.actorId ?? body.worker_id ?? body.workerId, {
        role: 'collaborator',
        ttl_seconds: body.ttl_seconds ?? body.ttlSeconds,
      }),
    }),
  },
  {
    method: 'POST',
    pattern: '/tasks/:id/release',
    handler: ({ params, body, db }) => ({
      status: 201,
      body: releaseTask(db, params.id, body.actor_id ?? body.actorId ?? body.worker_id ?? body.workerId),
    }),
  },
  {
    method: 'POST',
    pattern: '/tasks/:id/heartbeat',
    handler: ({ params, body, db }) => {
      const claims = listClaims(db, params.id);
      const actor = body.actor_id ?? body.actorId ?? body.worker_id ?? body.workerId;
      const active = claims.find((row) => row.status === 'active'
        && (row.actor_id === actor || row.worker_id === actor));
      if (!active) {
        return { status: 404, body: { ok: false, code: 'CLAIM_NOT_FOUND', error: '该主体在此任务上没有活跃认领' } };
      }
      return {
        status: 200,
        body: heartbeatClaim(db, active.claim_id, actor, { ttl_seconds: body.ttl_seconds ?? body.ttlSeconds }),
      };
    },
  },
  {
    method: 'POST',
    pattern: '/claims/:id/heartbeat',
    handler: ({ params, body, db }) => ({
      status: 200,
      body: heartbeatClaim(db, params.id, body.actor_id ?? body.actorId ?? body.worker_id ?? body.workerId, {
        ttl_seconds: body.ttl_seconds ?? body.ttlSeconds,
      }),
    }),
  },
  {
    method: 'POST',
    pattern: '/claims/:id/release',
    handler: ({ params, body, db }) => ({
      status: 200,
      body: releaseClaim(db, params.id, body.actor_id ?? body.actorId ?? body.worker_id ?? body.workerId, {
        reason: body.reason,
      }),
    }),
  },
  {
    method: 'GET',
    pattern: '/tasks/:id/claims',
    handler: ({ params, db }) => {
      sweep(db);
      return listClaims(db, params.id);
    },
  },
  {
    method: 'POST',
    pattern: '/leases/sweep',
    handler: ({ body, db }) => ({
      status: 200,
      body: { expired: expireLeases(db, { project_id: body?.project_id ?? body?.projectId }) },
    }),
  },
  {
    method: 'GET',
    pattern: '/tasks/:id/submissions',
    handler: ({ params, db }) => {
      if (!getTask(db, params.id)) {
        return { status: 404, body: { ok: false, error: `任务不存在：${params.id}` } };
      }
      return listSubmissions(db, { task_id: params.id });
    },
  },
  {
    method: 'POST',
    pattern: '/tasks/:id/submissions',
    handler: ({ params, body, db }) => ({
      status: 201,
      body: createSubmission(db, { ...body, task_id: params.id }),
    }),
  },
];
