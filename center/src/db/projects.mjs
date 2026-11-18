// Center 项目存储（T7 归置）。

import { appendEvent } from './events.mjs';
import { PROJECT_STATUSES } from './enums.mjs';
import { newId, nowIso, pick, required } from './json.mjs';

const INSERT_PROJECT = `INSERT INTO projects (
  project_id, name, purpose, scope_summary, status, policy_ref, created_at, created_by
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * 新建项目。project_id 缺省自动生成 `prj_` 前缀 ID。
 * @returns {object} 完整行
 */
export function createProject(db, input = {}) {
  const projectId = pick(input, 'project_id', 'projectId') ?? newId('prj');
  const name = required(input, 'name');
  const status = pick(input, 'status') ?? 'active';

  if (!PROJECT_STATUSES.includes(status)) {
    throw new Error(`非法的项目状态：${status}`);
  }

  const now = pick(input, 'created_at', 'createdAt') ?? nowIso();
  const createdBy = pick(input, 'created_by', 'createdBy');

  db.prepare(INSERT_PROJECT).run(
    projectId,
    name,
    pick(input, 'purpose'),
    pick(input, 'scope_summary', 'scopeSummary'),
    status,
    pick(input, 'policy_ref', 'policyRef'),
    now,
    createdBy,
  );

  appendEvent(db, {
    project_id: projectId,
    object_type: 'project',
    object_id: projectId,
    event_type: 'project.created',
    actor: createdBy,
    occurred_at: now,
    reason: pick(input, 'purpose'),
  });

  return getProject(db, projectId);
}

/** 按 ID 查询项目；不存在返回 null。 */
export function getProject(db, projectId) {
  return db.prepare('SELECT * FROM projects WHERE project_id = ?').get(projectId) ?? null;
}

/** 列出项目，可按 status 过滤，按创建时间升序。 */
export function listProjects(db, query = {}) {
  const status = pick(query, 'status');
  const where = status ? 'WHERE status = ?' : '';
  const params = status ? [status] : [];
  return db
    .prepare(`SELECT * FROM projects ${where} ORDER BY created_at ASC, project_id ASC`)
    .all(...params);
}

/** 校验项目存在；不存在抛错。 */
export function assertProjectExists(db, projectId) {
  if (!getProject(db, projectId)) throw new Error(`项目不存在：${projectId}`);
}
