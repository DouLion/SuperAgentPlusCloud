// 观测路由（P5）：主体在线状态、卡住任务、流水线指标。

import { actorStatus, pipelineStats, stuckTasks } from '../../observability/metrics.mjs';

export const ROUTES = [
  {
    method: 'GET',
    pattern: '/observability/actors',
    handler: ({ db }) => ({ generated_at: new Date().toISOString(), actors: actorStatus(db) }),
  },
  {
    method: 'GET',
    pattern: '/observability/stuck',
    handler: ({ db, url }) => {
      const projectId = url.searchParams.get('project_id') || null;
      const items = stuckTasks(db, Date.now(), { project_id: projectId });
      return { generated_at: new Date().toISOString(), count: items.length, items };
    },
  },
  {
    method: 'GET',
    pattern: '/observability/stats',
    handler: ({ db, url }) => pipelineStats(db, {
      project_id: url.searchParams.get('project_id') || null,
    }),
  },
];
