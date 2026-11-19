// 从本地 git 同步事实的测试：真实提交、幂等、源码清单与错误处理。

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, reset } from '../src/db/store.mjs';
import { createProject } from '../src/db/projects.mjs';
import { createRepository, getRepository } from '../src/db/repositories.mjs';
import { listFacts } from '../src/db/facts.mjs';
import { listRepositoryCommits, syncRepositoryFromGit } from '../src/git/sync.mjs';
import { createServer } from '../src/http/server.mjs';

function tempDb() {
  const file = path.join(os.tmpdir(), `sap-git-sync-${process.pid}-${Date.now()}-${Math.random()}.db`);
  const db = openStore(file);
  reset(db);
  return { db, file };
}

function cleanup(db, file) {
  try { db.close(); } catch { /* 已关闭 */ }
  try { fs.rmSync(file, { force: true }); } catch { /* 清理失败不影响断言 */ }
}

/** 造一个真实 git 仓库；测试依赖本机 git，缺失时跳过。 */
function makeGitRepo(commits = 2) {
  const dir = path.join(os.tmpdir(), `sap-git-repo-${process.pid}-${Date.now()}-${Math.random()}`);
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'demo@example.com');
  git('config', 'user.name', '演示开发者');
  git('config', 'commit.gpgsign', 'false');
  for (let index = 0; index < commits; index += 1) {
    fs.writeFileSync(path.join(dir, `file-${index}.txt`), `content ${index}\n`);
    git('add', '.');
    git('commit', '-q', '-m', `第 ${index + 1} 次提交`);
  }
  return dir;
}

function hasGit() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('同步：读取真实提交与文件清单，重复同步不重复记事实', { skip: !hasGit() }, async () => {
  const { db, file } = tempDb();
  const repoDir = makeGitRepo(2);
  try {
    const project = createProject(db, { name: '代码即事实', created_by: 'owner' });
    const repository = createRepository(db, {
      project_id: project.project_id, name: '主仓', url: 'https://github.com/acme/demo.git',
    });

    const first = await syncRepositoryFromGit(db, repository.repository_id, { local_path: repoDir });
    assert.equal(first.commits_seen, 2);
    assert.equal(first.commits_added, 2);
    assert.equal(first.commits_duplicated, 0);
    assert.equal(first.tracked_files, 2);
    assert.equal(first.branch.length > 0, true);
    assert.match(first.tree_digest, /^[0-9a-f]{40}$/);

    const facts = listFacts(db, { repository_id: repository.repository_id, source: 'git', kind: 'commit' });
    assert.equal(facts.length, 2);
    assert.ok(facts.every((fact) => fact.payload.ref === first.branch));
    assert.ok(facts.some((fact) => fact.payload.summary === '第 2 次提交'));

    const stored = getRepository(db, repository.repository_id);
    assert.equal(stored.last_head, first.head);
    assert.equal(stored.local_path, path.resolve(repoDir));
    assert.equal(Number(stored.tracked_file_count), 2);
    assert.ok(stored.last_synced_at);

    // 再同步一次：不新增事实，但仍刷新 HEAD。
    const second = await syncRepositoryFromGit(db, repository.repository_id, { local_path: repoDir });
    assert.equal(second.commits_added, 0);
    assert.equal(second.commits_duplicated, 2);
    assert.equal(listFacts(db, { repository_id: repository.repository_id }).length, 2);

    const commits = listRepositoryCommits(db, repository.repository_id, { limit: 10 });
    assert.equal(commits.length, 2);
    assert.equal(commits[0].commit_sha.length, 40);
  } finally {
    cleanup(db, file);
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('同步：新提交会增量进入事实，旧提交保持', { skip: !hasGit() }, async () => {
  const { db, file } = tempDb();
  const repoDir = makeGitRepo(1);
  try {
    const project = createProject(db, { name: '增量同步', created_by: 'owner' });
    const repository = createRepository(db, {
      project_id: project.project_id, name: '主仓', url: 'https://github.com/acme/inc.git',
    });
    await syncRepositoryFromGit(db, repository.repository_id, { local_path: repoDir });

    fs.writeFileSync(path.join(repoDir, 'new.txt'), 'new\n');
    execFileSync('git', ['-C', repoDir, 'add', '.'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repoDir, 'commit', '-q', '-m', '新增文件'], { stdio: 'ignore' });

    const again = await syncRepositoryFromGit(db, repository.repository_id, { local_path: repoDir });
    assert.equal(again.commits_seen, 2);
    assert.equal(again.commits_added, 1);
    assert.equal(again.tracked_files, 2);
    const commits = listRepositoryCommits(db, repository.repository_id, { limit: 10 });
    assert.equal(commits.length, 2);
    assert.ok(commits.some((commit) => commit.summary === '新增文件'));
  } finally {
    cleanup(db, file);
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('同步：路径缺失与非 git 目录给出可读错误', { skip: !hasGit() }, async () => {
  const { db, file } = tempDb();
  const plainDir = path.join(os.tmpdir(), `sap-not-git-${process.pid}-${Date.now()}`);
  fs.mkdirSync(plainDir, { recursive: true });
  try {
    const project = createProject(db, { name: '错误路径', created_by: 'owner' });
    const repository = createRepository(db, {
      project_id: project.project_id, name: '主仓', url: 'https://github.com/acme/err.git',
    });

    await assert.rejects(
      () => syncRepositoryFromGit(db, repository.repository_id, { local_path: path.join(plainDir, 'missing') }),
      (error) => error.code === 'GIT_PATH_MISSING',
    );
    await assert.rejects(
      () => syncRepositoryFromGit(db, repository.repository_id, { local_path: plainDir }),
      (error) => error.code === 'GIT_NOT_REPOSITORY',
    );
    await assert.rejects(
      () => syncRepositoryFromGit(db, 'repo_missing', { local_path: plainDir }),
      (error) => error.code === 'REPOSITORY_NOT_FOUND',
    );
  } finally {
    cleanup(db, file);
    fs.rmSync(plainDir, { recursive: true, force: true });
  }
});

test('HTTP：同步与提交列表接口可用', { skip: !hasGit() }, async () => {
  const { db, file } = tempDb();
  const repoDir = makeGitRepo(1);
  const server = createServer(db);
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/sap-cloud/api`;
    const project = await fetch(`${base}/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'HTTP 同步', created_by: 'owner' }),
    }).then((response) => response.json());

    const repository = await fetch(`${base}/projects/${project.project_id}/repositories`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '主仓', url: 'https://github.com/acme/http.git', created_by: 'owner' }),
    }).then((response) => response.json());

    const synced = await fetch(`${base}/repositories/${repository.repository_id}/sync`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ local_path: repoDir }),
    }).then((response) => response.json());
    assert.equal(synced.commits_added, 1);

    const history = await fetch(`${base}/repositories/${repository.repository_id}/commits`).then((response) => response.json());
    assert.equal(history.commits.length, 1);
    assert.equal(history.commits[0].summary, '第 1 次提交');
    assert.equal(history.head, synced.head);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanup(db, file);
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
