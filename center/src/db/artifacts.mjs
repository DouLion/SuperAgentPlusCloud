// 项目制品（T13）：版本化内容、发布/退役与事件留痕。

import crypto from 'node:crypto';
import { appendEvent } from './events.mjs';
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
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getArtifact(db, artifactId);
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
