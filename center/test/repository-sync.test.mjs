// 仓库同步与提交核对测试：真实 git 仓库、幂等、归档拦截与核对结果。

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, reset } from '../src/db/store.mjs';
import { createProject } from '../src/db/projects.mjs';
import { archiveRepository, createRepository } from '../src/db/repositories.mjs';
import { listFacts } from '../src/db/facts.mjs';
import { createTask, openTask } from '../src/db/tasks.mjs';
import { confirmTrunkItem, createTrunkItem } from '../src/db/trunk.mjs';
import { claimTask } from '../src/db/claims.mjs';
import { createSubmission, getSubmission, verifySubmissionCommits } from '../src/db/submissions.mjs';
import { syncRepository } from '../src/git/sync.mjs';
import { isGitRepo, readBranches, readCommits } from '../src/git/reader.mjs';
import { createServer } from '../src/http/server.mjs';

function hasGit() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const GIT = hasGit();

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function tempDb() {
  const file = path.join(os.tmpdir(), `sap-repo-sync-${process.pid}-${Date.now()}-${Math.random()}.db`);
  const db = openStore(file);
  reset(db);
  return { db, file };
}

function cleanup(db, file) {
  try { db.close(); } catch { /* 已关闭 */ }
  try { fs.rmSync(file, { force: true }); } catch { /* 清理失败不影响断言 */ }
}

/** 用空提交造一个真实仓库，避免依赖文件系统内容。 */
function makeRepo(count = 2) {
  const dir = tempDir('sap-git-');
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'demo@example.com');
  git('config', 'user.name', '演示开发者');
  git('config', 'commit.gpgsign', 'false');
  for (let index = 0; index < count; index += 1) {
    git('commit', '-q', '--allow-empty', '-m', `第 ${index + 1} 次提交`);
  }
  return dir;
}

test('读取器：识别仓库、读取分支与提交（含文件清单字段）', { skip: !GIT }, async () => {
  const dir = makeRepo(2);
  try {
    assert.equal(await isGitRepo(dir), true);
    const branches = await readBranches({ path: dir });
    assert.ok(branches.length >= 1);
    const commits = await readCommits({ path: dir, limit: 10 });
    assert.equal(commits.length, 2);
    assert.equal(commits[0].subject, '第 2 次提交');
    assert.equal(commits[0].author_name, '演示开发者');
    assert.equal(commits[0].author_email, 'demo@example.com');
    assert.match(commits[0].sha, /^[0-9a-f]{40}$/);
    assert.ok(Array.isArray(commits[0].files_changed));

    const limited = await readCommits({ path: dir, limit: 1 });
    assert.equal(limited.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('读取器：非 git 目录与不存在路径给出稳定错误码', { skip: !GIT }, async () => {
  const plain = tempDir('sap-plain-');
  try {
    await assert.rejects(() => isGitRepo(path.join(plain, 'missing')), (error) => error.code === 'REPOSITORY_PATH_MISSING');
    await assert.rejects(() => readCommits({ path: plain }), (error) => error.code === 'REPOSITORY_NOT_GIT');
  } finally {
    fs.rmSync(plain, { recursive: true, force: true });
  }
});

test('同步：写入提交事实、重复同步幂等、latest_sha 正确', { skip: !GIT }, async () => {
  const { db, file } = tempDb();
  const dir = makeRepo(2);
  try {
    const project = createProject(db, { name: '同步项目', created_by: 'owner' });
    const repository = createRepository(db, {
      project_id: project.project_id, name: '主仓', url: 'https://github.com/acme/demo.git',
      local_path: dir, created_by: 'owner',
    });

    const first = await syncRepository(db, repository.repository_id, { limit: 10 });
    assert.equal(first.inserted, 2);
    assert.equal(first.skipped, 0);
    assert.match(first.latest_sha, /^[0-9a-f]{40}$/);
    assert.ok(first.synced_at);

    const facts = listFacts(db, { repository_id: repository.repository_id, source: 'git', kind: 'commit' });
    assert.equal(facts.length, 2);
    const latest = facts.find((fact) => fact.external_id === first.latest_sha);
    assert.equal(latest.payload.subject, '第 2 次提交');
    assert.equal(latest.payload.branch, 'HEAD');
    assert.equal(latest.payload.author_name, '演示开发者');
    assert.ok(Array.isArray(latest.payload.files_changed));

    const second = await syncRepository(db, repository.repository_id, { limit: 10 });
    assert.equal(second.inserted, 0);
    assert.equal(second.skipped, 2);
    assert.equal(listFacts(db, { repository_id: repository.repository_id }).length, 2);
  } finally {
    cleanup(db, file);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('同步：归档仓库被拒绝，缺本地路径被拒绝', { skip: !GIT }, async () => {
  const { db, file } = tempDb();
  const dir = makeRepo(1);
  try {
    const project = createProject(db, { name: '归档项目', created_by: 'owner' });
    const repository = createRepository(db, {
      project_id: project.project_id, name: '主仓', url: 'https://github.com/acme/arch.git', local_path: dir,
    });
    archiveRepository(db, repository.repository_id, { reason: '不再使用' });
    await assert.rejects(
      () => syncRepository(db, repository.repository_id, {}),
      (error) => error.code === 'REPOSITORY_ARCHIVED',
    );

    const bare = createRepository(db, {
      project_id: project.project_id, name: '无路径', url: 'https://github.com/acme/bare.git',
    });
    await assert.rejects(
      () => syncRepository(db, bare.repository_id, {}),
      (error) => error.code === 'REPOSITORY_PATH_MISSING',
    );
  } finally {
    cleanup(db, file);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('核对：已知 sha 判定为已核对，未知 sha 判定为未找到', { skip: !GIT }, async () => {
  const { db, file } = tempDb();
  const dir = makeRepo(1);
  try {
    const project = createProject(db, { name: '核对项目', created_by: 'owner' });
    const repository = createRepository(db, {
      project_id: project.project_id, name: '主仓', url: 'https://github.com/acme/verify.git', local_path: dir,
    });
    const synced = await syncRepository(db, repository.repository_id, { limit: 10 });

    const trunk = createTrunkItem(db, {
      project_id: project.project_id,
      kind: 'capability',
      statement: '提交可追溯到真实代码',
      created_by: 'owner',
    });
    confirmTrunkItem(db, trunk.item_id, { confirmed_by: 'owner' });

    const task = createTask(db, {
      project_id: project.project_id,
      purpose: '核对提交',
      done_when: ['提交可核对'],
      serves_item_ids: [trunk.item_id],
    });
    openTask(db, task.task_id, { actor: 'owner' });
    const claim = claimTask(db, task.task_id, '开发者', { role: 'owner' });
    const submission = createSubmission(db, {
      task_id: task.task_id,
      claim_id: claim.claim.claim_id,
      commit_refs: [{ repo: 'main', hash: synced.latest_sha }, 'deadbeefdeadbeef'],
      summary: '两个引用',
      submitted_by: '开发者',
    });

    const result = verifySubmissionCommits(db, submission.submission_id, { actor_id: 'owner' });
    assert.equal(result.verified.length, 1);
    assert.equal(result.unverified.length, 1);
    assert.equal(result.verified[0].hash, synced.latest_sha);
    assert.equal(result.verified[0].repository_id, repository.repository_id);
    assert.ok(result.checked_at);

    const detail = getSubmission(db, submission.submission_id);
    assert.equal(detail.commit_refs[0].verified, true);
    assert.equal(detail.commit_refs[0].repository_id, repository.repository_id);
    assert.equal(detail.commit_refs[1].verified, false);
    assert.equal(detail.commit_refs[1].repository_id, null);
  } finally {
    cleanup(db, file);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP：同步与核对接口返回预期结构', { skip: !GIT }, async () => {
  const { db, file } = tempDb();
  const dir = makeRepo(1);
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
      body: JSON.stringify({ name: '主仓', url: 'https://github.com/acme/http.git', local_path: dir }),
    }).then((response) => response.json());

    const synced = await fetch(`${base}/repositories/${repository.repository_id}/sync`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 5 }),
    }).then((response) => response.json());
    assert.equal(synced.inserted, 1);
    assert.match(synced.latest_sha, /^[0-9a-f]{40}$/);

    const history = await fetch(`${base}/repositories/${repository.repository_id}/commits`)
      .then((response) => response.json());
    assert.equal(history.commits.length, 1);
    assert.equal(history.commits[0].subject, '第 1 次提交');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanup(db, file);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
