// Center HTTP 路由：主干变更与影响处置（T7 归置）。

import {
  activateTrunkChange,
  addImpactItem,
  closeTrunkChange,
  confirmTrunkChange,
  createTrunkChange,
  getImpactItem,
  getTrunkChange,
  listImpactItems,
  listTrunkChanges,
  updateImpactItem,
} from '../../db/changes.mjs';
import { assertCan, stampActorType } from '../../auth/policy.mjs';

export const ROUTES = [
  {
    method: 'GET',
    pattern: '/trunk-changes',
    handler: ({ url, db }) => {
      const query = {};
      for (const key of ['project_id', 'status']) {
        const value = url.searchParams.get(key);
        if (value) query[key] = value;
      }
      return listTrunkChanges(db, query);
    },
  },
  {
    method: 'POST',
    pattern: '/trunk-changes',
    handler: ({ body, db }) => ({ status: 201, body: createTrunkChange(db, body) }),
  },
  {
    method: 'GET',
    pattern: '/trunk-changes/:id',
    handler: ({ params, db }) => {
      const change = getTrunkChange(db, params.id);
      if (!change) {
        return { status: 404, body: { ok: false, error: `主干变更不存在：${params.id}` } };
      }
      return change;
    },
  },
  {
    method: 'POST',
    pattern: '/trunk-changes/:id/confirm',
    handler: ({ params, body, db, req }) => {
      const change = getTrunkChange(db, params.id);
      if (!change) {
        return { status: 404, body: { ok: false, error: `主干变更不存在：${params.id}` } };
      }
      const auth = assertCan(db, req, 'trunk_change.confirm', { project_id: change.project_id });
      const payload = { ...body };
      if (!payload.confirmed_by && !payload.confirmedBy && auth.actor) {
        payload.confirmed_by = auth.actor.display_name;
      }
      const updated = confirmTrunkChange(db, params.id, payload);
      stampActorType(db, 'trunk_changes', 'change_id', params.id, auth.actor_type);
      return { status: 200, body: { ...updated, confirmed_actor_type: auth.actor_type } };
    },
  },
  {
    method: 'POST',
    pattern: '/trunk-changes/:id/activate',
    handler: ({ params, body, db, req }) => {
      const change = getTrunkChange(db, params.id);
      if (!change) {
        return { status: 404, body: { ok: false, error: `主干变更不存在：${params.id}` } };
      }
      const auth = assertCan(db, req, 'trunk_change.activate', { project_id: change.project_id });
      const payload = { ...body };
      if (!payload.confirmed_by && !payload.confirmedBy && auth.actor) {
        payload.confirmed_by = auth.actor.display_name;
      }
      const updated = activateTrunkChange(db, params.id, payload);
      stampActorType(db, 'trunk_changes', 'change_id', params.id, auth.actor_type);
      return { status: 200, body: { ...updated, confirmed_actor_type: auth.actor_type } };
    },
  },
  {
    method: 'POST',
    pattern: '/trunk-changes/:id/close',
    handler: ({ params, db }) => {
      if (!getTrunkChange(db, params.id)) {
        return { status: 404, body: { ok: false, error: `主干变更不存在：${params.id}` } };
      }
      return { status: 200, body: closeTrunkChange(db, params.id) };
    },
  },
  {
    method: 'POST',
    pattern: '/trunk-changes/:id/impacts',
    handler: ({ params, body, db }) => {
      if (!getTrunkChange(db, params.id)) {
        return { status: 404, body: { ok: false, error: `主干变更不存在：${params.id}` } };
      }
      return { status: 201, body: addImpactItem(db, { ...body, change_id: params.id }) };
    },
  },
  {
    method: 'GET',
    pattern: '/trunk-changes/:id/impacts',
    handler: ({ params, db }) => {
      if (!getTrunkChange(db, params.id)) {
        return { status: 404, body: { ok: false, error: `主干变更不存在：${params.id}` } };
      }
      return listImpactItems(db, params.id);
    },
  },
  {
    method: 'PATCH',
    pattern: '/impact-items/:id',
    handler: ({ params, body, db, req }) => {
      const impact = getImpactItem(db, params.id);
      if (!impact) {
        return { status: 404, body: { ok: false, error: `影响项不存在：${params.id}` } };
      }
      const status = body?.assessment_status ?? body?.assessmentStatus;
      if (status === 'not_affected') {
        const change = getTrunkChange(db, impact.change_id);
        assertCan(db, req, 'impact_item.resolve', { project_id: change?.project_id });
      }
      return { status: 200, body: updateImpactItem(db, params.id, body) };
    },
  },
];
