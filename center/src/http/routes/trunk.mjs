// Center HTTP 路由：主干条目（T7 归置）。

import {
  confirmTrunkItem,
  createTrunkItem,
  getTrunkItem,
  listTrunkItems,
  retireTrunkItem,
} from '../../db/trunk.mjs';

export const ROUTES = [
  {
    method: 'GET',
    pattern: '/trunk-items',
    handler: ({ url, db }) => {
      const query = {};
      for (const key of ['project_id', 'status', 'kind']) {
        const value = url.searchParams.get(key);
        if (value) query[key] = value;
      }
      return listTrunkItems(db, query);
    },
  },
  {
    method: 'POST',
    pattern: '/trunk-items',
    handler: ({ body, db }) => ({ status: 201, body: createTrunkItem(db, body) }),
  },
  {
    method: 'GET',
    pattern: '/trunk-items/:id',
    handler: ({ params, db }) => {
      const item = getTrunkItem(db, params.id);
      if (!item) {
        return { status: 404, body: { ok: false, error: `主干条目不存在：${params.id}` } };
      }
      return item;
    },
  },
  {
    method: 'POST',
    pattern: '/trunk-items/:id/confirm',
    handler: ({ params, body, db }) => {
      if (!getTrunkItem(db, params.id)) {
        return { status: 404, body: { ok: false, error: `主干条目不存在：${params.id}` } };
      }
      return { status: 200, body: confirmTrunkItem(db, params.id, body) };
    },
  },
  {
    method: 'POST',
    pattern: '/trunk-items/:id/retire',
    handler: ({ params, body, db }) => {
      if (!getTrunkItem(db, params.id)) {
        return { status: 404, body: { ok: false, error: `主干条目不存在：${params.id}` } };
      }
      return { status: 200, body: retireTrunkItem(db, params.id, body) };
    },
  },
];
