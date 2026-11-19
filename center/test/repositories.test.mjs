// 项目代码仓库测试：一个项目多个 git 地址、提交归属、多仓去重与归档。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, reset } from '../src/db/store.mjs';
import { createProject } from '../src/db/projects.mjs';
import {
  archiveRepository,
  createRepository,
  getRepository,
  listRepositories,
  repositorySummary,
  resolveRepository,
  updateRepository,
} from '../src/db/repositories.mjs';
import { createFact, listFacts } from '../src/db/facts.mjs';
import { createServer } from '../src/http/server.mjs';

function tempDb() {
  const file = path.join(os.tmpdir(), `sap-repositories-${process.pid}-${Date.now()}-${Math.random()}.db`);
  const db = openStore(file);
  reset(db);
  return { db, file };
}

function cleanup(db, file) {
  try { db.close(); } catch { /* 已关闭 */ }
  try { fs.rmSync(file, { force: true }); } catch { /* 临时文件清理失败不影响断言 */ }
}

function seedProject(db, name) {
  return createProject(db, { name, created_by: 'owner' });
}

test('仓库：一个项目可登记多个地址，URL 去重且服务商可推断', () => {
  const { db, file } = tempDb();
  try {
    const project = seedProject(db, '多仓项目');
    const web = createRepository(db, {
      project_id: project.project_id, name: '前端', url: 'https://github.com/acme/web.git',
    });
    assert.equal(web.provider, 'github');
    const api = createRepository(db, {
      project_id: project.project_id, name: '后端', url: 'https://gitlab.example.com/acme/api.git',
    });
    assert.equal(api.provider, 'gitlab');

    assert.equal(listRepositories(db, { project_id: project.project_id }).length, 2);
    assert.throws(
      () => createRepository(db, { project_id: project.project_id, name: '重复', url: web.url }),
      (err) => err.code === 'REPOSITORY_EXISTS',
    );
  } finally {
    cleanup(db, file);
  }
});

test('仓库：提交事实按仓库归属，多仓同 sha 不算重复', () => {
  const { db, file } = tempDb();
  try {
    const project = seedProject(db, '提交项目');
    const web = createRepository(db, { project_id: project.project_id, name: 'web', url: 'https://github.com/acme/web' });
    const api = createRepository(db, { project_id: project.project_id, name: 'api', url: 'https://github.com/acme/api' });

    const first = createFact(db, {
      project_id: project.project_id, source: 'git', kind: 'commit', external_id: 'abc123',
      repository_id: web.repository_id,
      payload: { commit_sha: 'abc123', ref: 'refs/heads/main', message: 'feat: 登录' },
    });
    assert.equal(first.deduplicated, false);
    assert.equal(first.fact.repository_id, web.repository_id);

    const sameRepoAgain = createFact(db, {
      project_id: project.project_id, source: 'git', kind: 'commit', external_id: 'abc123',
      repository_url: web.url, payload: { commit_sha: 'abc123', ref: 'refs/heads/main' },
    });
    assert.equal(sameRepoAgain.deduplicated, true);

    const otherRepo = createFact(db, {
      project_id: project.project_id, source: 'git', kind: 'commit', external_id: 'abc123',
      repository_id: api.repository_id, payload: { commit_sha: 'abc123', ref: 'refs/heads/main' },
    });
    assert.equal(otherRepo.deduplicated, false, '不同仓库的同名提交是两条事实');

    assert.equal(listFacts(db, { repository_id: web.repository_id }).length, 1);
    assert.equal(listFacts(db, { project_id: project.project_id, kind: 'commit' }).length, 2);

    const summary = repositorySummary(db, web.repository_id);
    assert.equal(summary.commit_count, 1);
    assert.deepEqual(summary.refs, ['refs/heads/main']);
  } finally {
    cleanup(db, file);
  }
});

test('仓库：已登记仓库时 git 事实必须指明仓库，跨项目仓库被拒', () => {
  const { db, file } = tempDb();
  try {
    const projectA = seedProject(db, 'A 项目');
    const projectB = seedProject(db, 'B 项目');
    const repoA = createRepository(db, { project_id: projectA.project_id, name: 'a', url: 'https://github.com/acme/a' });

    assert.throws(
      () => createFact(db, {
        project_id: projectA.project_id, source: 'git', kind: 'commit', external_id: 'deadbeef',
        payload: { commit_sha: 'deadbeef', ref: 'main' },
      }),
      (err) => err.code === 'REPOSITORY_REQUIRED',
    );

    assert.throws(
      () => createFact(db, {
        project_id: projectB.project_id, source: 'git', kind: 'commit', external_id: 'deadbeef',
        repository_id: repoA.repository_id, payload: { commit_sha: 'deadbeef', ref: 'main' },
      }),
      (err) => err.code === 'REPOSITORY_PROJECT_MISMATCH',
    );

    assert.throws(
      () => resolveRepository(db, projectB.project_id, { repository_url: 'https://github.com/acme/unknown' }),
      (err) => err.code === 'REPOSITORY_NOT_FOUND',
    );
  } finally {
    cleanup(db, file);
  }
});

test('仓库：归档保留提交事实，改名与换地址受唯一约束', () => {
  const { db, file } = tempDb();
  try {
    const project = seedProject(db, '归档项目');
    const repo = createRepository(db, { project_id: project.project_id, name: 'old', url: 'https://gitee.com/acme/old' });
    createFact(db, {
      project_id: project.project_id, source: 'git', kind: 'commit', external_id: 'sha-1',
      repository_id: repo.repository_id, payload: { commit_sha: 'sha-1', ref: 'master' },
    });

    const archived = archiveRepository(db, repo.repository_id, { reason: '迁移到新仓库' });
    assert.equal(archived.status, 'archived');
    assert.ok(archived.archived_at);
    assert.equal(listFacts(db, { repository_id: repo.repository_id }).length, 1);
    assert.equal(listRepositories(db, { project_id: project.project_id, status: 'archived' }).length, 1);

    const renamed = updateRepository(db, repo.repository_id, { name: '旧仓库（归档）' });
    assert.equal(renamed.name, '旧仓库（归档）');

    const another = createRepository(db, { project_id: project.project_id, name: 'new', url: 'https://gitee.com/acme/new' });
    assert.throws(
      () => updateRepository(db, another.repository_id, { url: repo.url }),
      (err) => err.code === 'REPOSITORY_EXISTS',
    );
  } finally {
    cleanup(db, file);
  }
});

test('HTTP：仓库列表、提交查询与事实上报', async () => {
  const { db, file } = tempDb();
  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/sap-cloud/api`;
  try {
    const project = seedProject(db, 'HTTP 项目');
    const post = (url, body) => fetch(base + url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).then((res) => res.json());

    const repo = await post(`/projects/${project.project_id}/repositories`, {
      name: '主仓', url: 'https://github.com/acme/main', default_branch: 'main',
    });
    assert.equal(repo.provider, 'github');

    const listed = await fetch(`${base}/projects/${project.project_id}/repositories?summary=1`).then((r) => r.json());
    assert.equal(listed.length, 1);
    assert.equal(listed[0].commit_count, 0);

    // 人类不能直接调 integrations；用无凭据兼容模式验证仓库维度查询。
    const fact = createFact(db, {
      project_id: project.project_id, source: 'git', kind: 'commit', external_id: 'http-sha',
      repository_id: repo.repository_id, payload: { commit_sha: 'http-sha', ref: 'main', message: 'init' },
    });
    assert.equal(fact.deduplicated, false);

    const facts = await fetch(`${base}/repositories/${repo.repository_id}/facts`).then((r) => r.json());
    assert.equal(facts.facts.length, 1);
    assert.equal(facts.facts[0].external_id, 'http-sha');

    const detail = await fetch(`${base}/repositories/${repo.repository_id}`).then((r) => r.json());
    assert.equal(detail.commit_count, 1);
    assert.equal(getRepository(db, repo.repository_id).default_branch, 'main');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanup(db, file);
  }
});
