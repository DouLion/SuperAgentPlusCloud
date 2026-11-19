// 项目制品（T13）：版本化内容、发布/退役与事件留痕。

import crypto from 'node:crypto';
import { appendEvent } from './events.mjs';
import { addImpact, hasImpact } from './impacts.mjs';
import { enqueueFromEvent } from '../protocol/outbox.mjs';
import { ARTIFACT_STATUSES, ARTIFACT_TYPES } from './enums.mjs';
import { assertProjectExists } from './projects.mjs';
import {
  codedError,
  decodeJson,
  encodeJson,
  newId,
  nowIso,
  pick,
  required,
} from './json.mjs';

const INSERT_ARTIFACT = `INSERT INTO artifacts (
  artifact_id, project_id, type, name, version, status, content, digest,
  source_task_id, source_submission_id, created_by, created_at,
  published_by, published_at, supersedes
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** 用稳定键顺序生成摘要，避免对象字段顺序不同导致内容摘要变化。 */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

export function artifactDigest(content) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(content))).digest('hex');
}

function parseArtifact(row) {
  if (!row) return null;
  return { ...row, content: decodeJson(row.content, {}) };
}

export function createArtifact(db, input = {}) {
  const artifactId = pick(input, 'artifact_id', 'artifactId') ?? newId('art');
  const projectId = required(input, 'project_id', 'projectId');
  const type = required(input, 'type');
  const name = required(input, 'name');
  const content = required(input, 'content');
  const createdBy = required(input, 'created_by', 'createdBy');
  const status = pick(input, 'status') ?? 'draft';
  if (!ARTIFACT_TYPES.includes(type)) throw new Error(`非法的制品类型：${type}`);
  if (status !== 'draft') throw new Error('新建制品只能是 draft 状态');
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw new Error('content 必须是 JSON 对象');
  }
  assertProjectExists(db, projectId);
  const sourceTaskId = pick(input, 'source_task_id', 'sourceTaskId');
  const sourceSubmissionId = pick(input, 'source_submission_id', 'sourceSubmissionId');
  const supersedes = pick(input, 'supersedes');
  const requestedVersion = pick(input, 'version');
  const version = requestedVersion === undefined
    ? Number(db.prepare(`SELECT COALESCE(MAX(version), 0) + 1 AS version FROM artifacts
        WHERE project_id = ? AND type = ? AND name = ?`).get(projectId, type, name).version)
    : Number(requestedVersion);
  if (!Number.isInteger(version) || version < 1) throw new Error('version 必须是正整数');
  if (supersedes && !getArtifact(db, supersedes)) throw new Error(`被替代制品不存在：${supersedes}`);
  const now = pick(input, 'created_at', 'createdAt') ?? nowIso();
  db.prepare(INSERT_ARTIFACT).run(
    artifactId, projectId, type, name, version, status, encodeJson(content),
    artifactDigest(content), sourceTaskId, sourceSubmissionId, createdBy, now,
    null, null, supersedes,
  );
  appendEvent(db, {
    project_id: projectId, object_type: 'artifact', object_id: artifactId,
    event_type: 'artifact.created', actor: createdBy, occurred_at: now,
    reason: `创建制品：${name} v${version}`,
    refs: [sourceTaskId, sourceSubmissionId, supersedes].filter(Boolean),
  });
  return getArtifact(db, artifactId);
}

export function getArtifact(db, artifactId) {
  return parseArtifact(db.prepare('SELECT * FROM artifacts WHERE artifact_id = ?').get(artifactId));
}

export function listArtifacts(db, query = {}) {
  const clauses = [];
  const params = [];
  for (const [key, column] of [
    ['project_id', 'project_id'], ['type', 'type'], ['status', 'status'], ['name', 'name'],
  ]) {
    const value = pick(query, key, key === 'project_id' ? 'projectId' : key);
    if (value !== undefined) {
      if (key === 'type' && !ARTIFACT_TYPES.includes(value)) throw new Error(`非法的制品类型：${value}`);
      if (key === 'status' && !ARTIFACT_STATUSES.includes(value)) throw new Error(`非法的制品状态：${value}`);
      clauses.push(`${column} = ?`);
      params.push(value);
    }
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM artifacts ${where}
      ORDER BY created_at DESC, version DESC, artifact_id DESC`).all(...params).map(parseArtifact);
}

/**
 * 契约升版时生成待检查影响项（B 枝）。
 * 目标：引用旧版本的提交、由旧版本编排建议创建的任务。
 * 幂等：同来源 + 同目标已存在则跳过。返回新建数量。
 */
export function generateArtifactImpacts(db, artifactId, oldArtifactIds = []) {
  const artifact = getArtifact(db, artifactId);
  if (!artifact || oldArtifactIds.length === 0) return 0;
  let created = 0;

  for (const oldId of oldArtifactIds) {
    const old = getArtifact(db, oldId);
    const reason = `契约「${artifact.name}」由 v${old?.version ?? '?'} 升级到 v${artifact.version}，需要复核`;

    // 1) 引用旧版本的提交
    const submissions = db.prepare(`SELECT s.submission_id, s.artifacts FROM submissions s
      JOIN tasks t ON t.task_id = s.task_id WHERE t.project_id = ?`).all(artifact.project_id);
    for (const row of submissions) {
      const refs = decodeJson(row.artifacts, []);
      const hit = refs.some((item) => item === oldId || (item && item.artifact_id === oldId));
      if (!hit) continue;
      if (hasImpact(db, 'artifact', artifactId, 'submission', row.submission_id)) continue;
      addImpact(db, {
        source_type: 'artifact', source_id: artifactId,
        target_type: 'submission', target_id: row.submission_id, reason,
      });
      created += 1;
    }

    // 2) 由旧版本编排建议创建的任务
    const suggestions = db.prepare(`SELECT payload FROM ai_suggestions
      WHERE project_id = ? AND kind = 'contract_orchestration'`).all(artifact.project_id);
    for (const row of suggestions) {
      const payload = decodeJson(row.payload, {});
      if (payload?.artifact_id !== oldId || !Array.isArray(payload.task_ids)) continue;
      for (const taskId of payload.task_ids) {
        if (hasImpact(db, 'artifact', artifactId, 'task', taskId)) continue;
        addImpact(db, {
          source_type: 'artifact', source_id: artifactId,
          target_type: 'task', target_id: taskId, reason,
        });
        created += 1;
      }
    }
  }
  return created;
}

export function publishArtifact(db, artifactId, patch = {}) {
  const artifact = getArtifact(db, artifactId);
  if (!artifact) throw Object.assign(new Error(`制品不存在：${artifactId}`), { status: 404 });
  if (artifact.status !== 'draft') {
    throw codedError('INVALID_TRANSITION', `制品当前状态不可发布：${artifact.status}`, 409);
  }
  const actor = required(patch, 'published_by', 'publishedBy');
  const reason = required(patch, 'reason');
  const now = nowIso();
  db.exec('BEGIN');
  try {
    // 同一项目、类型和名称只保留一个 published 版本；历史不删除。
    const old = db.prepare(`SELECT artifact_id FROM artifacts
      WHERE project_id = ? AND type = ? AND name = ? AND status = 'published'`)
      .all(artifact.project_id, artifact.type, artifact.name);
    // 影响分析覆盖该名称下所有既有版本：引用旧版的提交与任务都应被提示。
    const priorIds = db.prepare(`SELECT artifact_id FROM artifacts
      WHERE project_id = ? AND type = ? AND name = ? AND status IN ('published', 'superseded')`)
      .all(artifact.project_id, artifact.type, artifact.name)
      .map((row) => row.artifact_id);
    for (const row of old) {
      db.prepare("UPDATE artifacts SET status = 'superseded' WHERE artifact_id = ?").run(row.artifact_id);
    }
    const supersedes = artifact.supersedes ?? old[0]?.artifact_id ?? null;
    db.prepare(`UPDATE artifacts SET status = 'published', published_by = ?,
      published_at = ?, supersedes = ? WHERE artifact_id = ?`)
      .run(actor, now, supersedes, artifactId);
    const publishedEvent = appendEvent(db, {
      project_id: artifact.project_id, object_type: 'artifact', object_id: artifactId,
      event_type: 'artifact.published', actor, occurred_at: now, reason,
      refs: old.map((row) => row.artifact_id),
    });
    enqueueFromEvent(db, publishedEvent);
    // 契约升版：为引用任一历史版本的提交与编排任务生成待检查影响项。
    generateArtifactImpacts(db, artifactId, priorIds);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getArtifact(db, artifactId);
}

/**
 * 制品引用关系：哪些任务/提交引用了它，以及文档与 Mock 的访问路径。
 * 无引用时返回空数组，不报错。
 */
export function artifactReferences(db, artifactId) {
  const artifact = getArtifact(db, artifactId);
  if (!artifact) throw Object.assign(new Error(`制品不存在：${artifactId}`), { status: 404 });

  // 1) 已采纳的契约编排建议会记录 artifact_id 与 task_ids。
  const suggestions = db.prepare(`SELECT payload FROM ai_suggestions
    WHERE project_id = ? AND kind = 'contract_orchestration'`).all(artifact.project_id);
  const taskIds = new Set();
  for (const row of suggestions) {
    const payload = decodeJson(row.payload, {});
    if (payload?.artifact_id === artifactId && Array.isArray(payload.task_ids)) {
      payload.task_ids.forEach((id) => taskIds.add(id));
    }
  }
  const tasks = taskIds.size === 0
    ? []
    : db.prepare('SELECT task_id, purpose, status FROM tasks WHERE task_id IN ('
      + [...taskIds].map(() => '?').join(',') + ') ORDER BY created_at ASC').all(...taskIds);

  // 2) 提交里的 artifacts 可能直接写制品 ID 或对象形式。
  const candidates = db.prepare(`SELECT submission_id, task_id, submitted_by, submitted_at, artifacts
    FROM submissions WHERE task_id IN (SELECT task_id FROM tasks WHERE project_id = ?)
    ORDER BY submitted_at DESC`).all(artifact.project_id);
  const submissions = candidates
    .filter((row) => decodeJson(row.artifacts, []).some((item) => (
      item === artifactId || (item && item.artifact_id === artifactId)
    )))
    .map((row) => ({
      submission_id: row.submission_id,
      task_id: row.task_id,
      submitted_by: row.submitted_by,
      submitted_at: row.submitted_at,
    }));

  // 3) 文档与 Mock 路径；Mock 取第一个带 2xx 响应的 operation 作为示例。
  const paths = artifact.content?.paths || {};
  let mockPath = null;
  for (const [pathname, pathItem] of Object.entries(paths)) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const operation = pathItem?.[method];
      if (!operation) continue;
      if (Object.keys(operation.responses || {}).some((status) => /^2\d\d$/.test(status))) {
        mockPath = `/sap-cloud/api/mock/${artifact.project_id}${pathname}`;
        break;
      }
    }
    if (mockPath) break;
  }

  return {
    artifact_id: artifactId,
    tasks,
    submissions,
    mock_path: mockPath,
    document_path: `/sap-cloud/api/artifacts/${artifactId}/document`,
  };
}

export function retireArtifact(db, artifactId, patch = {}) {
  const artifact = getArtifact(db, artifactId);
  if (!artifact) throw Object.assign(new Error(`制品不存在：${artifactId}`), { status: 404 });
  if (artifact.status !== 'published') {
    throw codedError('INVALID_TRANSITION', `制品当前状态不可退役：${artifact.status}`, 409);
  }
  const actor = required(patch, 'retired_by', 'retiredBy');
  const reason = required(patch, 'reason');
  const now = nowIso();
  db.prepare("UPDATE artifacts SET status = 'retired' WHERE artifact_id = ?").run(artifactId);
  appendEvent(db, {
    project_id: artifact.project_id, object_type: 'artifact', object_id: artifactId,
    event_type: 'artifact.retired', actor, occurred_at: now, reason,
  });
  return getArtifact(db, artifactId);
}
