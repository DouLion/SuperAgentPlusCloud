// 项目代码仓库：一个项目可维护多个 git 地址，git 提交是既有项目的事实来源。
// 仓库本身不触发任何业务状态变化，只为外部事实提供归属。

import { appendEvent } from './events.mjs';
import { assertProjectExists } from './projects.mjs';
import { codedError, newId, nowIso, pick, required } from './json.mjs';

export const REPOSITORY_PROVIDERS = ['github', 'gitlab', 'gitee', 'azure', 'other'];
export const REPOSITORY_STATUSES = ['active', 'archived'];

/** 从 URL 猜服务商；认不出就按 other，不阻断创建。 */
function detectProvider(url) {
  const value = String(url || '').toLowerCase();
  if (value.includes('github.com')) return 'github';
  if (value.includes('gitlab')) return 'gitlab';
  if (value.includes('gitee.com')) return 'gitee';
  if (value.includes('dev.azure.com') || value.includes('visualstudio.com')) return 'azure';
  return 'other';
}

export function getRepository(db, repositoryId) {
  return db.prepare('SELECT * FROM project_repositories WHERE repository_id = ?').get(repositoryId) ?? null;
}

export function listRepositories(db, query = {}) {
  const clauses = [];
  const params = [];
  const projectId = pick(query, 'project_id', 'projectId');
  if (projectId !== undefined) {
    clauses.push('project_id = ?');
    params.push(projectId);
  }
  const status = pick(query, 'status');
  if (status !== undefined) {
    if (!REPOSITORY_STATUSES.includes(status)) {
      throw codedError('REPOSITORY_STATUS_INVALID', `非法的仓库状态：${status}`, 400);
    }
    clauses.push('status = ?');
    params.push(status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM project_repositories ${where}
    ORDER BY created_at ASC, repository_id ASC`).all(...params);
}

/** 新建仓库；同一项目内 URL 唯一。url 与 local_path 至少要有一个。 */
export function createRepository(db, input = {}) {
  const projectId = required(input, 'project_id', 'projectId');
  const name = required(input, 'name');
  const localPath = pick(input, 'local_path', 'localPath') ?? null;
  const url = pick(input, 'url') ?? (localPath ? `file://${localPath}` : null);
  if (!url) {
    throw codedError('REPOSITORY_SOURCE_REQUIRED', '仓库需要 url 或 local_path', 400);
  }
  assertProjectExists(db, projectId);

  const provider = pick(input, 'provider') ?? detectProvider(url);
  if (!REPOSITORY_PROVIDERS.includes(provider)) {
    throw codedError('REPOSITORY_PROVIDER_INVALID', `非法的服务商：${provider}`, 400);
  }

  const duplicated = db.prepare(
    'SELECT repository_id FROM project_repositories WHERE project_id = ? AND url = ?',
  ).get(projectId, url);
  if (duplicated) {
    throw codedError('REPOSITORY_EXISTS', `该地址已在项目中登记：${url}`, 409);
  }

  const repositoryId = pick(input, 'repository_id', 'repositoryId') ?? newId('repo');
  const now = nowIso();
  const createdBy = pick(input, 'created_by', 'createdBy') ?? null;
  db.prepare(`INSERT INTO project_repositories (
    repository_id, project_id, name, url, provider, default_branch, status, created_by, created_at, archived_at, local_path
  ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, ?)`).run(
    repositoryId, projectId, name, url, provider,
    pick(input, 'default_branch', 'defaultBranch') ?? null, createdBy, now,
    pick(input, 'local_path', 'localPath') ?? null,
  );

  appendEvent(db, {
    project_id: projectId,
    object_type: 'project_repository',
    object_id: repositoryId,
    event_type: 'repository.created',
    actor: createdBy ?? 'system',
    occurred_at: now,
    reason: `${name} ${url}`,
    refs: [url],
  });
  return getRepository(db, repositoryId);
}

/** 改名、换地址、改默认分支；地址变更同样受项目内唯一约束。 */
export function updateRepository(db, repositoryId, patch = {}) {
  const repository = getRepository(db, repositoryId);
  if (!repository) throw codedError('REPOSITORY_NOT_FOUND', `仓库不存在：${repositoryId}`, 404);

  const name = pick(patch, 'name') ?? repository.name;
  const url = pick(patch, 'url') ?? repository.url;
  const provider = pick(patch, 'provider') ?? repository.provider;
  if (!REPOSITORY_PROVIDERS.includes(provider)) {
    throw codedError('REPOSITORY_PROVIDER_INVALID', `非法的服务商：${provider}`, 400);
  }
  if (url !== repository.url) {
    const duplicated = db.prepare(
      'SELECT repository_id FROM project_repositories WHERE project_id = ? AND url = ? AND repository_id <> ?',
    ).get(repository.project_id, url, repositoryId);
    if (duplicated) throw codedError('REPOSITORY_EXISTS', `该地址已在项目中登记：${url}`, 409);
  }

  const defaultBranch = pick(patch, 'default_branch', 'defaultBranch') ?? repository.default_branch;
  const localPath = pick(patch, 'local_path', 'localPath') ?? repository.local_path;
  db.prepare(`UPDATE project_repositories
    SET name = ?, url = ?, provider = ?, default_branch = ?, local_path = ? WHERE repository_id = ?`)
    .run(name, url, provider, defaultBranch, localPath, repositoryId);

  appendEvent(db, {
    project_id: repository.project_id,
    object_type: 'project_repository',
    object_id: repositoryId,
    event_type: 'repository.updated',
    actor: pick(patch, 'actor') ?? 'system',
    occurred_at: nowIso(),
    reason: `${repository.name} → ${name}`,
    refs: [url],
  });
  return getRepository(db, repositoryId);
}

/** 归档仓库：保留历史事实与提交引用，只是不再作为活跃地址。 */
export function archiveRepository(db, repositoryId, input = {}) {
  const repository = getRepository(db, repositoryId);
  if (!repository) throw codedError('REPOSITORY_NOT_FOUND', `仓库不存在：${repositoryId}`, 404);
  if (repository.status === 'archived') return repository;

  const now = nowIso();
  db.prepare("UPDATE project_repositories SET status = 'archived', archived_at = ? WHERE repository_id = ?")
    .run(now, repositoryId);
  appendEvent(db, {
    project_id: repository.project_id,
    object_type: 'project_repository',
    object_id: repositoryId,
    event_type: 'repository.archived',
    actor: pick(input, 'actor') ?? 'system',
    occurred_at: now,
    reason: pick(input, 'reason') ?? '归档仓库',
    refs: [repository.url],
  });
  return getRepository(db, repositoryId);
}

/**
 * 解析事实上报时的仓库：优先 repository_id，其次 URL，都没有则返回 null。
 * 传入但不存在或不属于该项目时直接报错，避免把提交挂到错误项目。
 */
export function resolveRepository(db, projectId, input = {}) {
  const repositoryId = pick(input, 'repository_id', 'repositoryId');
  const url = pick(input, 'repository_url', 'repositoryUrl', 'url');
  if (!repositoryId && !url) return null;

  const repository = repositoryId
    ? getRepository(db, repositoryId)
    : db.prepare('SELECT * FROM project_repositories WHERE project_id = ? AND url = ?').get(projectId, url);

  if (!repository) {
    throw codedError('REPOSITORY_NOT_FOUND', `仓库未登记：${repositoryId ?? url}`, 400);
  }
  if (repository.project_id !== projectId) {
    throw codedError('REPOSITORY_PROJECT_MISMATCH', `仓库不属于项目 ${projectId}：${repository.repository_id}`, 400);
  }
  return repository;
}

/** 仓库维度的提交统计，供面板直接展示。 */
export function repositorySummary(db, repositoryId) {
  const repository = getRepository(db, repositoryId);
  if (!repository) return null;
  const facts = db.prepare(`SELECT COUNT(*) AS n, MAX(received_at) AS last_at
    FROM external_facts WHERE repository_id = ? AND source = 'git'`).get(repositoryId);
  const branches = db.prepare(`SELECT payload FROM external_facts
    WHERE repository_id = ? AND source = 'git' ORDER BY received_at DESC LIMIT 200`).all(repositoryId);
  const refs = new Set();
  for (const row of branches) {
    try {
      const payload = JSON.parse(row.payload);
      if (payload?.ref) refs.add(String(payload.ref));
    } catch {
      // 载荷异常时跳过，不影响统计。
    }
  }
  return {
    ...repository,
    commit_count: Number(facts.n || 0),
    last_commit_at: facts.last_at ?? null,
    refs: [...refs].slice(0, 20),
  };
}
