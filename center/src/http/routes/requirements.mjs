// Center HTTP 路由：需求、评估、决定与批量拆解（T7 归置）。

import {
  createAssessment,
  createDecision,
  createRequirement,
  getRequirement,
  listAssessments,
  listDecisions,
  listRequirementTimeline,
  listRequirements,
} from '../../db/requirements.mjs';
import { createTask, openTask } from '../../db/tasks.mjs';

export const ROUTES = [
  {
    method: 'GET',
    pattern: '/requirements',
    handler: ({ url, db }) => {
      const query = {};
      for (const key of ['project_id', 'status']) {
        const value = url.searchParams.get(key);
        if (value) query[key] = value;
      }
      return listRequirements(db, query);
    },
  },
  {
    method: 'POST',
    pattern: '/requirements',
    handler: ({ body, db }) => ({ status: 201, body: createRequirement(db, body) }),
  },

  {
    method: 'GET',
    pattern: '/requirements/:id',
    handler: ({ params, db }) => {
      const requirement = getRequirement(db, params.id);
      if (!requirement) {
        return { status: 404, body: { ok: false, error: `需求不存在：${params.id}` } };
      }
      return requirement;
    },
  },
  {
    method: 'GET',
    pattern: '/requirements/:id/assessments',
    handler: ({ params, db }) => listAssessments(db, params.id),
  },
  {
    method: 'GET',
    pattern: '/requirements/:id/decisions',
    handler: ({ params, db }) => listDecisions(db, params.id),
  },
  {
    method: 'GET',
    pattern: '/requirements/:id/timeline',
    handler: ({ params, db }) => listRequirementTimeline(db, params.id),
  },
  {
    method: 'POST',
    pattern: '/requirements/:id/assessments',
    handler: ({ params, body, db }) => ({
      status: 201,
      body: createAssessment(db, { ...body, requirement_id: params.id }),
    }),
  },
  {
    method: 'POST',
    pattern: '/requirements/:id/decision',
    handler: ({ params, body, db }) => ({
      status: 201,
      body: createDecision(db, { ...body, requirement_id: params.id }),
    }),
  },

  {
    method: 'POST',
    pattern: '/requirements/:id/tasks',
    handler: ({ params, body, db }) => {
      const requirement = getRequirement(db, params.id);
      if (!requirement) {
        return { status: 404, body: { ok: false, error: `需求不存在：${params.id}` } };
      }
      const tasks = body.tasks;
      if (!Array.isArray(tasks)) {
        return { status: 400, body: { ok: false, error: '缺少必填字段：tasks（必须是数组）' } };
      }
      const createdBy = body.created_by ?? body.createdBy;
      // 批量拆解整体原子：任一条不合法则全部回滚，避免“部分已开放”的中间态。
      db.exec('BEGIN');
      try {
        const created = tasks.map((item) => {
          const task = createTask(db, {
            ...item,
            // 批量拆解不要求调用方重复提供 project_id，按需求所属项目落库。
            project_id: requirement.project_id,
            requirement_id: requirement.requirement_id,
            created_by: createdBy,
          });
          // 拆解完成即进入可认领状态。
          return openTask(db, task.task_id, { actor: createdBy, reason: '任务拆解后开放' });
        });
        db.exec('COMMIT');
        return { status: 201, body: created };
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  },
];
