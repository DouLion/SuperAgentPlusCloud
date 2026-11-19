// 从本地 git 仓库读取真实历史，作为项目事实源。
// 只执行只读命令（rev-parse / log / ls-files），不提交、不改工作区、不联网。

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { createFact, listFacts } from '../db/facts.mjs';
import { getRepository, repositorySummary } from '../db/repositories.mjs';
import { appendEvent } from '../db/events.mjs';
import { codedError, nowIso, pick } from '../db/json.mjs';

const run = promisify(execFile);

const FIELD = '\u001f';
const MAX_LIMIT = 200;

/** 只读执行 git，并把失败翻译成可读错误。 */
async function git(cwd, args) {
  try {
    const { stdout } = await run('git', ['-C', cwd, ...args], {
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    const stderr = String(error?.stderr || error?.message || '').trim();
    if (/not a git repository/i.test(stderr)) {
      throw codedError('GIT_NOT_REPOSITORY', `不是 git 仓库：${cwd}`, 400);
    }
    throw codedError('GIT_COMMAND_FAILED', `git ${args[0]} 执行失败：${stderr.slice(0, 300)}`, 502);
  }
}

/** 解析 `git log` 的定长分隔输出。 */
function parseLog(stdout) {
  return stdout
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const [sha, author, email, committedAt, parents, ...rest] = line.split(FIELD);
      return {
        sha: sha?.trim(),
        author: author?.trim(),
        email: email?.trim(),
        committed_at: committedAt?.trim(),
        parents: (parents || '').split(' ').filter(Boolean),
        subject: rest.join(FIELD).trim(),
      };
    })
    .filter((commit) => commit.sha);
}

/**
 * 同步一个仓库的提交历史与文件清单。
 * - commits：写入 git/commit 事实（按仓库 + sha 幂等）
 * - tree：记录跟踪文件数量与清单摘要，供“源码即事实”核对
 */
export async function syncRepositoryFromGit(db, repositoryId, input = {}) {
  const repository = getRepository(db, repositoryId);
  if (!repository) throw codedError('REPOSITORY_NOT_FOUND', `仓库不存在：${repositoryId}`, 404);

  const localPath = pick(input, 'local_path', 'localPath') ?? repository.local_path;
  if (!localPath) {
    throw codedError('GIT_PATH_REQUIRED', '需要提供本地仓库路径：local_path', 400);
  }
  const resolved = path.resolve(String(localPath));
  if (!fs.existsSync(resolved)) {
    throw codedError('GIT_PATH_MISSING', `路径不存在：${resolved}`, 400);
  }

  const toplevel = (await git(resolved, ['rev-parse', '--show-toplevel'])).trim();
  const head = (await git(resolved, ['rev-parse', 'HEAD'])).trim();
  const branch = (await git(resolved, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const limit = Math.min(Math.max(Number(pick(input, 'limit')) || 50, 1), MAX_LIMIT);

  const log = await git(resolved, [
    'log', '-n', String(limit),
    `--pretty=format:%H${FIELD}%an${FIELD}%ae${FIELD}%aI${FIELD}%P${FIELD}%s`,
  ]);
  const commits = parseLog(log);

  const tracked = (await git(resolved, ['ls-tree', '-r', '--name-only', 'HEAD']))
    .split('\n').filter(Boolean);
  const filesDigest = (await git(resolved, ['rev-parse', 'HEAD^{tree}'])).trim();

  let added = 0;
  let duplicated = 0;
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
        ref: branch,
        author: commit.author,
        author_email: commit.email,
        committed_at: commit.committed_at,
        parents: commit.parents,
        summary: commit.subject,
        repository_id: repository.repository_id,
        repository_url: repository.url,
      },
    });
    if (result.deduplicated) duplicated += 1;
    else added += 1;
  }

  const now = nowIso();
  db.prepare(`UPDATE project_repositories
    SET local_path = ?, last_head = ?, last_branch = ?, last_synced_at = ?,
        tracked_file_count = ?, tree_digest = ?
    WHERE repository_id = ?`).run(
    resolved, head, branch, now, tracked.length, filesDigest, repository.repository_id,
  );

  appendEvent(db, {
    project_id: repository.project_id,
    object_type: 'project_repository',
    object_id: repository.repository_id,
    event_type: 'repository.synced',
    actor: pick(input, 'actor_id', 'actorId') ?? 'git',
    occurred_at: now,
    reason: `${branch}@${head.slice(0, 8)} 新增 ${added} 条提交`,
    refs: [head, ...(repository.url ? [repository.url] : [])],
  });

  return {
    repository: repositorySummary(db, repository.repository_id),
    local_path: resolved,
    toplevel,
    head,
    branch,
    commits_seen: commits.length,
    commits_added: added,
    commits_duplicated: duplicated,
    tracked_files: tracked.length,
    tree_digest: filesDigest,
  };
}

/** 仓库提交列表：直接读已同步的事实，不重新访问磁盘。 */
export function listRepositoryCommits(db, repositoryId, query = {}) {
  const limit = Math.min(Math.max(Number(pick(query, 'limit')) || 50, 1), MAX_LIMIT);
  return listFacts(db, { repository_id: repositoryId, source: 'git', kind: 'commit', limit })
    .map((fact) => ({
      fact_id: fact.fact_id,
      commit_sha: fact.payload.commit_sha,
      ref: fact.payload.ref,
      author: fact.payload.author,
      author_email: fact.payload.author_email,
      committed_at: fact.payload.committed_at,
      summary: fact.payload.summary,
      parents: fact.payload.parents ?? [],
      received_at: fact.received_at,
    }));
}
