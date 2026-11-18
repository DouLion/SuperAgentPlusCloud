// Center HTTP 路由：任务、认领与提交（T7 归置）。

import {
  claimTask,
  createTask,
  getTask,
  listClaims,
  listTasks,
  openTask,
  releaseTask,
} from '../../db/tasks.mjs';
import { createSubmission, listSubmissions } from '../../db/submissions.mjs';

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
      body: claimTask(db, params.id, body.worker_id ?? body.workerId),
    }),
  },
  {
    method: 'POST',
    pattern: '/tasks/:id/release',
    handler: ({ params, body, db }) => ({
      status: 201,
      body: releaseTask(db, params.id, body.worker_id ?? body.workerId),
    }),
  },
  {
    method: 'GET',
    pattern: '/tasks/:id/claims',
    handler: ({ params, db }) => listClaims(db, params.id),
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
