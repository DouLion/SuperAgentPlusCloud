// Center HTTP 路由：团队/项目约定包（T12）。

import {
  activateConventionPack,
  createConventionPack,
  getConventionPack,
  importConventionPack,
  listConventionPacks,
  retireConventionPack,
} from '../../db/conventions.mjs';

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
    handler: ({ db, params, body }) => ({ status: 200, body: activateConventionPack(db, params.id, body) }),
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
