// Center HTTP 路由：主干条目（T7 归置）。

import {
  confirmTrunkItem,
  createTrunkItem,
  getTrunkItem,
  listTrunkItems,
  retireTrunkItem,
} from '../../db/trunk.mjs';
import { assertCan, stampActorType } from '../../auth/policy.mjs';

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
    handler: ({ params, body, db, req }) => {
      const item = getTrunkItem(db, params.id);
      if (!item) {
        return { status: 404, body: { ok: false, error: `主干条目不存在：${params.id}` } };
      }
      const auth = assertCan(db, req, 'trunk_item.confirm', { project_id: item.project_id });
      const payload = { ...body };
      if (!payload.confirmed_by && !payload.confirmedBy && auth.actor) {
        payload.confirmed_by = auth.actor.display_name;
      }
      const updated = confirmTrunkItem(db, params.id, payload);
      stampActorType(db, 'trunk_items', 'item_id', params.id, auth.actor_type);
      return { status: 200, body: { ...updated, confirmed_actor_type: auth.actor_type } };
    },
  },
  {
    method: 'POST',
    pattern: '/trunk-items/:id/retire',
    handler: ({ params, body, db, req }) => {
      const item = getTrunkItem(db, params.id);
      if (!item) {
        return { status: 404, body: { ok: false, error: `主干条目不存在：${params.id}` } };
      }
      const auth = assertCan(db, req, 'trunk_item.retire', { project_id: item.project_id });
      return {
        status: 200,
        body: { ...retireTrunkItem(db, params.id, body), retired_actor_type: auth.actor_type },
      };
    },
  },
];
