// Center HTTP 路由：团队/项目约定包（T12）。

import {
  activateConventionPack,
  createConventionPack,
  getConventionPack,
  importConventionPack,
  listConventionPacks,
  retireConventionPack,
} from '../../db/conventions.mjs';
import { assertCan, assertProjectRole, stampActorType } from '../../auth/policy.mjs';

function requirePack(db, id) {
  const pack = getConventionPack(db, id);
  if (!pack) return { status: 404, body: { error: `约定包不存在：${id}` } };
  return pack;
}

export const ROUTES = [
  {
    method: 'GET', pattern: '/convention-packs',
    handler: ({ db, url }) => listConventionPacks(db, Object.fromEntries(url.searchParams)),
  },
  {
    method: 'POST', pattern: '/convention-packs',
    handler: ({ db, body }) => ({ status: 201, body: createConventionPack(db, body) }),
  },
  {
    method: 'GET', pattern: '/convention-packs/:id',
    handler: ({ db, params }) => requirePack(db, params.id),
  },
  {
    method: 'POST', pattern: '/convention-packs/:id/activate',
    handler: ({ db, params, body, req }) => {
      const pack = getConventionPack(db, params.id);
      if (!pack) return { status: 404, body: { error: `约定包不存在：${params.id}` } };
      const auth = assertCan(db, req, 'convention_pack.activate', { project_id: pack.project_id });
      assertProjectRole(db, auth, 'convention_pack.activate', { project_id: pack.project_id });
      const payload = { ...body };
      if (!payload.activated_by && !payload.activatedBy && auth.actor) {
        payload.activated_by = auth.actor.display_name;
      }
      if (!payload.reason) payload.reason = '启用约定包';
      const updated = activateConventionPack(db, params.id, payload);
      stampActorType(db, 'convention_packs', 'pack_id', params.id, auth.actor_type);
      return { status: 200, body: updated };
    },
  },
  {
    method: 'POST', pattern: '/convention-packs/:id/retire',
    handler: ({ db, params, body }) => ({ status: 200, body: retireConventionPack(db, params.id, body) }),
  },
  {
    method: 'POST', pattern: '/convention-packs/:id/import',
    handler: ({ db, params, body }) => ({ status: 201, body: importConventionPack(db, params.id, body) }),
  },
];
