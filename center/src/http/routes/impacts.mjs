// 影响项通用 HTTP 路由（B 枝）：按来源或项目查询，统一主干变更与契约两种来源。

import { listImpacts } from '../../db/impacts.mjs';

export const ROUTES = [
  {
    method: 'GET',
    pattern: '/impacts',
    handler: ({ db, url }) => {
      const query = {};
      for (const key of ['source_type', 'source_id', 'project_id', 'assessment_status', 'target_type']) {
        const value = url.searchParams.get(key);
        if (value) query[key] = value;
      }
      return listImpacts(db, query);
    },
  },
];
