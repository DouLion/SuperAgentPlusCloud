// 项目制品 HTTP 路由（T13）：版本、发布、校验与同源文档。

import {
  createArtifact,
  getArtifact,
  listArtifacts,
  publishArtifact,
  retireArtifact,
} from '../../db/artifacts.mjs';
import { activeConventionRules, renderOpenApiHtml, validateOpenApi } from '../../contracts/openapi.mjs';

function requireArtifact(db, id) {
  const artifact = getArtifact(db, id);
  if (!artifact) return { status: 404, body: { error: `制品不存在：${id}` } };
  return artifact;
}

function validateContract(db, artifact) {
  if (artifact.type !== 'api_contract') {
    return { valid: true, counts: { must: 0, should: 0, preference: 0 }, violations: [], operations: [] };
  }
  return validateOpenApi(artifact.content, activeConventionRules(db, artifact.project_id));
}

export const ROUTES = [
  {
    method: 'GET', pattern: '/artifacts',
    handler: ({ db, url }) => listArtifacts(db, Object.fromEntries(url.searchParams)),
  },
  {
    method: 'POST', pattern: '/artifacts',
    handler: ({ db, body }) => ({ status: 201, body: createArtifact(db, body) }),
  },
  {
    method: 'GET', pattern: '/artifacts/:id',
    handler: ({ db, params }) => requireArtifact(db, params.id),
  },
  {
    method: 'GET', pattern: '/artifacts/:id/validate',
    handler: ({ db, params }) => {
      const artifact = getArtifact(db, params.id);
      if (!artifact) return { status: 404, body: { error: `制品不存在：${params.id}` } };
      return validateContract(db, artifact);
    },
  },
  {
    method: 'POST', pattern: '/artifacts/:id/publish',
    handler: ({ db, params, body }) => {
      const artifact = getArtifact(db, params.id);
      if (!artifact) return { status: 404, body: { error: `制品不存在：${params.id}` } };
      const validation = validateContract(db, artifact);
      if (!validation.valid) {
        return {
          status: 422,
          body: {
            error: `契约存在 ${validation.counts.must} 条 must 违规，不能发布`,
            code: 'CONTRACT_VALIDATION_FAILED',
            validation,
          },
        };
      }
      return { status: 200, body: { artifact: publishArtifact(db, params.id, body), validation } };
    },
  },
  {
    method: 'POST', pattern: '/artifacts/:id/retire',
    handler: ({ db, params, body }) => ({ status: 200, body: retireArtifact(db, params.id, body) }),
  },
  {
    method: 'GET', pattern: '/artifacts/:id/document',
    handler: ({ db, params }) => {
      const artifact = getArtifact(db, params.id);
      if (!artifact) return { status: 404, body: { error: `制品不存在：${params.id}` } };
      if (artifact.type !== 'api_contract') {
        return { status: 400, body: { error: '只有 api_contract 可渲染接口文档' } };
      }
      const validation = validateContract(db, artifact);
      return {
        status: 200,
        raw: renderOpenApiHtml(artifact.content, validation),
        content_type: 'text/html; charset=utf-8',
        headers: { 'cache-control': 'no-cache' },
      };
    },
  },
];
