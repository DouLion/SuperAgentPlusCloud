// 仓库同步：把本地 git 的真实提交写进 external_facts。
// 只读拉取，不改变任务、提交或契约状态；重复同步按 dedupe_key 幂等。

import { appendEvent } from '../db/events.mjs';
import { createFact, listFacts } from '../db/facts.mjs';
import { getRepository, repositorySummary } from '../db/repositories.mjs';
import { codedError, nowIso, pick } from '../db/json.mjs';
import { readCommits } from './reader.mjs';

/** 同步一个仓库：读取本地提交并 upsert 为 git 事实。 */
export async function syncRepository(db, repositoryId, input = {}) {
  const repository = getRepository(db, repositoryId);
  if (!repository) throw codedError('REPOSITORY_NOT_FOUND', `仓库不存在：${repositoryId}`, 404);
  if (repository.status !== 'active') {
    throw codedError('REPOSITORY_ARCHIVED', `仓库已归档：${repositoryId}`, 409);
  }

  const localPath = pick(input, 'local_path', 'localPath') ?? repository.local_path;
  if (!localPath) throw codedError('REPOSITORY_PATH_MISSING', '仓库未配置本地路径：local_path', 400);

  const branch = pick(input, 'branch') ?? repository.default_branch ?? 'HEAD';
  const commits = await readCommits({
    path: String(localPath),
    branch,
    limit: pick(input, 'limit') ?? 200,
    since: pick(input, 'since'),
  });

  let inserted = 0;
  let skipped = 0;
  for (const commit of commits) {
    const result = createFact(db, {
      project_id: repository.project_id,
      repository_id: repository.repository_id,
      source: 'git',
      kind: 'commit',
      external_id: commit.sha,
      actor_id: pick(input, 'actor_id', 'actorId') ?? null,
      payload: {
        commit_sha: commit.sha,
        author_name: commit.author_name,
        author_email: commit.author_email,
        committed_at: commit.committed_at,
        subject: commit.subject,
        files_changed: commit.files_changed,
        branch,
      },
    });
    if (result.deduplicated) skipped += 1;
    else inserted += 1;
  }

  const latestSha = commits[0]?.sha ?? repository.last_head ?? null;
  const syncedAt = nowIso();
  db.prepare(`UPDATE project_repositories
    SET local_path = ?, default_branch = ?, last_head = ?, last_branch = ?, last_synced_at = ?
    WHERE repository_id = ?`).run(
    String(localPath), branch, latestSha, branch, syncedAt, repository.repository_id,
  );

  appendEvent(db, {
    project_id: repository.project_id,
    object_type: 'project_repository',
    object_id: repository.repository_id,
    event_type: 'repository.synced',
    actor: pick(input, 'actor_id', 'actorId') ?? 'git',
    occurred_at: syncedAt,
    reason: `${branch}: +${inserted} / 已存在 ${skipped}`,
    refs: [latestSha, repository.url].filter(Boolean),
  });

  return {
    repository_id: repository.repository_id,
    inserted,
    skipped,
    latest_sha: latestSha,
    synced_at: syncedAt,
    branch,
    summary: repositorySummary(db, repository.repository_id),
  };
}

/** 仓库提交列表：读已同步的事实，不重新访问磁盘。 */
export function listRepositoryCommits(db, repositoryId, query = {}) {
  const limit = Math.min(Math.max(Number(pick(query, 'limit')) || 50, 1), 500);
  return listFacts(db, { repository_id: repositoryId, source: 'git', kind: 'commit', limit })
    .map((fact) => ({
      fact_id: fact.fact_id,
      sha: fact.payload.commit_sha,
      author_name: fact.payload.author_name ?? fact.payload.author ?? '',
      author_email: fact.payload.author_email ?? '',
      committed_at: fact.payload.committed_at ?? '',
      subject: fact.payload.subject ?? fact.payload.summary ?? '',
      files_changed: fact.payload.files_changed ?? [],
      branch: fact.payload.branch ?? fact.payload.ref ?? '',
      received_at: fact.received_at,
    }));
}
