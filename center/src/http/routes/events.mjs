// Center HTTP 路由：事件时间线（T9 面板）。
// 只读查询，供前端时间线页面按项目与对象类型过滤。

import { listEvents } from '../../db/events.mjs';

export const ROUTES = [
  {
    method: 'GET',
    pattern: '/events',
    handler: ({ url, db }) => {
      const query = {};
      for (const key of ['project_id', 'object_type', 'object_id', 'event_type']) {
        const value = url.searchParams.get(key);
        if (value) query[key] = value;
      }
      const limit = url.searchParams.get('limit');
      if (limit) query.limit = Number(limit);
      return listEvents(db, query);
    },
  },
];
