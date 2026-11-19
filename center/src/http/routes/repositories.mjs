// 项目代码仓库路由：一个项目可登记多个 git 地址，提交事实按仓库归属。
// 仓库登记本身不改变任何业务状态。

import { assertCan } from '../../auth/policy.mjs';
import { listFacts } from '../../db/facts.mjs';
import {
  archiveRepository,
  createRepository,
  getRepository,
  listRepositories,
  repositorySummary,
  updateRepository,
} from '../../db/repositories.mjs';
import { listRepositoryCommits, syncRepository } from '../../git/sync.mjs';

function requireRepository(db, repositoryId) {
  const repository = getRepository(db, repositoryId);
  if (!repository) {
    return { status: 404, body: { ok: false, code: 'REPOSITORY_NOT_FOUND', error: `仓库不存在：${repositoryId}` } };
  }
  return repository;
}

/** 仓库登记属于项目配置：有凭据时按项目管理动作校验，无凭据走兼容模式。 */
function guardWrite(db, req, projectId) {
  return assertCan(db, req, 'repository.manage', { project_id: projectId });
}

export const ROUTES = [
  {
    method: 'GET',
    pattern: '/projects/:id/repositories',
    handler: ({ db, params, url }) => {
      const withSummary = ['1', 'true'].includes(String(url.searchParams.get('summary') ?? ''));
      const rows = listRepositories(db, { project_id: params.id, status: url.searchParams.get('status') ?? undefined });
      return withSummary ? rows.map((row) => repositorySummary(db, row.repository_id) ?? row) : rows;
    },
  },
  {
    method: 'POST',
    pattern: '/projects/:id/repositories',
    handler: ({ db, params, body, req }) => {
      guardWrite(db, req, params.id);
      return { status: 201, body: createRepository(db, { ...body, project_id: params.id }) };
    },
  },
  {
    method: 'GET',
    pattern: '/repositories/:id',
    handler: ({ db, params }) => {
      const checked = requireRepository(db, params.id);
      if (checked?.status === 404) return checked;
      return repositorySummary(db, params.id) ?? checked;
    },
  },
  {
    method: 'PATCH',
    pattern: '/repositories/:id',
    handler: ({ db, params, body, req }) => {
      const repository = getRepository(db, params.id);
      if (!repository) {
        return { status: 404, body: { ok: false, code: 'REPOSITORY_NOT_FOUND', error: `仓库不存在：${params.id}` } };
      }
      guardWrite(db, req, repository.project_id);
      return updateRepository(db, params.id, body);
    },
  },
  {
    method: 'POST',
    pattern: '/repositories/:id/archive',
    handler: ({ db, params, body, req }) => {
      const repository = getRepository(db, params.id);
      if (!repository) {
        return { status: 404, body: { ok: false, code: 'REPOSITORY_NOT_FOUND', error: `仓库不存在：${params.id}` } };
      }
      guardWrite(db, req, repository.project_id);
      return archiveRepository(db, params.id, body);
    },
  },
  {
    method: 'POST',
    pattern: '/repositories/:id/sync',
    handler: async ({ db, params, body, req }) => {
      const repository = getRepository(db, params.id);
      if (!repository) {
        return { status: 404, body: { ok: false, code: 'REPOSITORY_NOT_FOUND', error: `仓库不存在：${params.id}` } };
      }
      guardWrite(db, req, repository.project_id);
      return { status: 200, body: await syncRepository(db, params.id, body) };
    },
  },
  {
    method: 'GET',
    pattern: '/repositories/:id/commits',
    handler: ({ db, params, url }) => {
      const repository = getRepository(db, params.id);
      if (!repository) {
        return { status: 404, body: { ok: false, code: 'REPOSITORY_NOT_FOUND', error: `仓库不存在：${params.id}` } };
      }
      return {
        repository_id: repository.repository_id,
        head: repository.last_head ?? null,
        branch: repository.last_branch ?? null,
        synced_at: repository.last_synced_at ?? null,
        commits: listRepositoryCommits(db, params.id, { limit: url.searchParams.get('limit') ?? undefined }),
      };
    },
  },
  {
    method: 'GET',
    pattern: '/repositories/:id/facts',
    handler: ({ db, params, url }) => {
      const repository = getRepository(db, params.id);
      if (!repository) {
        return { status: 404, body: { ok: false, code: 'REPOSITORY_NOT_FOUND', error: `仓库不存在：${params.id}` } };
      }
      return {
        repository_id: repository.repository_id,
        facts: listFacts(db, {
          repository_id: params.id,
          source: url.searchParams.get('source') ?? undefined,
          kind: url.searchParams.get('kind') ?? undefined,
          limit: url.searchParams.get('limit') ?? undefined,
        }),
      };
    },
  },
];
