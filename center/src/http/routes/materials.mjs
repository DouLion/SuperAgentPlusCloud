// 材料与提取 HTTP 路由（C 枝）。提取只写 draft；采纳/拒绝由人触发。

import {
  acceptExtraction,
  createMaterial,
  getExtraction,
  getMaterial,
  listExtractions,
  listMaterials,
  rejectExtraction,
} from '../../db/materials.mjs';
import { extractFromMaterial } from '../../ai/materials.mjs';

function notFound(label, id) {
  return { status: 404, body: { ok: false, error: `${label}不存在：${id}` } };
}

export const ROUTES = [
  {
    method: 'POST',
    pattern: '/materials',
    handler: ({ db, body }) => ({ status: 201, body: createMaterial(db, body) }),
  },
  {
    method: 'GET',
    pattern: '/materials',
    handler: ({ db, url }) => listMaterials(db, Object.fromEntries(url.searchParams)),
  },
  {
    method: 'GET',
    pattern: '/materials/:id',
    handler: ({ db, params }) => {
      const material = getMaterial(db, params.id);
      if (!material) return notFound('材料', params.id);
      return {
        ...material,
        extractions: listExtractions(db, { material_id: params.id }),
      };
    },
  },
  {
    method: 'POST',
    pattern: '/materials/:id/extract',
    handler: async ({ db, params, body }) => {
      const material = getMaterial(db, params.id);
      if (!material) return notFound('材料', params.id);
      const result = await extractFromMaterial(db, material, body ?? {});
      return { status: 201, body: result };
    },
  },
  {
    method: 'GET',
    pattern: '/material-extractions',
    handler: ({ db, url }) => {
      const query = {};
      for (const key of ['material_id', 'status', 'kind']) {
        const value = url.searchParams.get(key);
        if (value) query[key] = value;
      }
      return listExtractions(db, query);
    },
  },
  {
    method: 'GET',
    pattern: '/material-extractions/:id',
    handler: ({ db, params }) => {
      const extraction = getExtraction(db, params.id);
      if (!extraction) return notFound('提取结果', params.id);
      return extraction;
    },
  },
  {
    method: 'POST',
    pattern: '/material-extractions/:id/accept',
    handler: ({ db, params, body }) => ({
      status: 201,
      body: acceptExtraction(db, params.id, body ?? {}),
    }),
  },
  {
    method: 'POST',
    pattern: '/material-extractions/:id/reject',
    handler: ({ db, params, body }) => ({
      status: 200,
      body: rejectExtraction(db, params.id, body ?? {}),
    }),
  },
];
