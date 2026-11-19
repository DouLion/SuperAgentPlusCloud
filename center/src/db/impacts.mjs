// 影响项通用访问（B 枝）：主干变更与契约制品共用一个影响项表。
// source_type='trunk_change' 时 source_id 与 change_id 一致；'artifact' 时 change_id 为空。
// 本模块不直接依赖 artifacts / changes，避免循环引用；项目归属用轻量查询解析。

import { appendEvent } from './events.mjs';
import {
  IMPACT_ASSESSMENT_STATUSES,
  IMPACT_RESOLUTIONS,
  IMPACT_TARGET_TYPES,
} from './enums.mjs';
import { newId, nowIso, pick, required } from './json.mjs';

export const IMPACT_SOURCE_TYPES = ['trunk_change', 'artifact'];

function parseImpactItem(row) {
  return row ? { ...row } : null;
}

/** 查来源所属项目；来源不存在返回 undefined。 */
function sourceProjectId(db, sourceType, sourceId) {
  if (!sourceId) return undefined;
  if (sourceType === 'artifact') {
    const row = db.prepare('SELECT project_id FROM artifacts WHERE artifact_id = ?').get(sourceId);
    return row?.project_id;
  }
  const row = db.prepare('SELECT project_id FROM trunk_changes WHERE change_id = ?').get(sourceId);
  return row?.project_id;
}

/** 影响项所属项目：主干变更取 change.project_id，契约取 artifact.project_id。 */
export function impactProjectId(db, row) {
  if (!row) return null;
  return sourceProjectId(db, row.source_type, row.source_id) ?? null;
}

/**
 * 登记一条影响项。change_id 仅在 trunk_change 来源时必填。
 * 同来源 + 同目标类型 + 同目标对象视为已登记，直接返回既有行（幂等）。
 */
export function addImpact(db, input = {}) {
  const sourceType = pick(input, 'source_type', 'sourceType') ?? 'trunk_change';
  if (!IMPACT_SOURCE_TYPES.includes(sourceType)) throw new Error(`非法的影响来源类型：${sourceType}`);

  const sourceId = pick(input, 'source_id', 'sourceId') ?? pick(input, 'change_id', 'changeId');
  if (!sourceId) throw new Error('缺少必填字段：source_id');

  const targetType = required(input, 'target_type', 'targetType');
  if (!IMPACT_TARGET_TYPES.includes(targetType)) {
    throw new Error(`非法的影响对象类型：${targetType}`);
  }
  const targetId = required(input, 'target_id', 'targetId');
  const ownerId = pick(input, 'owner_id', 'ownerId');
  const reason = pick(input, 'reason');
  const assessmentStatus = pick(input, 'assessment_status', 'assessmentStatus') ?? 'to_check';
  if (!IMPACT_ASSESSMENT_STATUSES.includes(assessmentStatus)) {
    throw new Error(`非法的影响评估状态：${assessmentStatus}`);
  }

  const projectId = sourceProjectId(db, sourceType, sourceId);
  if (projectId === undefined) {
    const label = sourceType === 'artifact' ? '制品' : '主干变更';
    throw Object.assign(new Error(`${label}不存在：${sourceId}`), { status: 404 });
  }

  const existing = db.prepare(`SELECT impact_item_id FROM impact_items
    WHERE source_type = ? AND source_id = ? AND target_type = ? AND target_id = ?`)
    .get(sourceType, sourceId, targetType, targetId);
  if (existing) return getImpact(db, existing.impact_item_id);

  const impactId = pick(input, 'impact_item_id', 'impactItemId') ?? newId('imp');
  const changeId = sourceType === 'trunk_change' ? sourceId : null;
  const now = pick(input, 'created_at', 'createdAt') ?? nowIso();
  db.prepare(`INSERT INTO impact_items (
    impact_item_id, change_id, source_type, source_id, target_type, target_id,
    assessment_status, resolution, reason, owner_id, updated_at, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`).run(
    impactId, changeId, sourceType, sourceId, targetType, targetId,
    assessmentStatus, reason, ownerId ?? null, now, now,
  );

  appendEvent(db, {
    project_id: projectId,
    object_type: 'impact_item',
    object_id: impactId,
    event_type: 'impact_item.created',
    actor: ownerId,
    occurred_at: now,
    reason: reason ?? `登记影响对象 ${targetType}:${targetId}，待检查`,
    refs: [sourceId, targetId],
  });

  return getImpact(db, impactId);
}

/** 更新影响项处置；not_affected 必须提供 reason。 */
export function updateImpact(db, impactId, patch = {}) {
  const existing = getImpact(db, impactId);
  if (!existing) throw Object.assign(new Error(`影响项不存在：${impactId}`), { status: 404 });

  const assessmentStatus = pick(patch, 'assessment_status', 'assessmentStatus')
    ?? existing.assessment_status;
  if (!IMPACT_ASSESSMENT_STATUSES.includes(assessmentStatus)) {
    throw new Error(`非法的影响评估状态：${assessmentStatus}`);
  }
  const resolution = pick(patch, 'resolution') ?? existing.resolution;
  if (!IMPACT_RESOLUTIONS.includes(resolution)) {
    throw new Error(`非法的影响处置方式：${resolution}`);
  }
  const reason = pick(patch, 'reason');
  if (assessmentStatus === 'not_affected' && (reason === undefined || String(reason).trim() === '')) {
    throw new Error('影响评估为 not_affected 时必须提供 reason，说明确认无影响的依据');
  }

  const ownerId = pick(patch, 'owner_id', 'ownerId') ?? existing.owner_id;
  const now = nowIso();
  db.prepare(`UPDATE impact_items
    SET assessment_status = ?, resolution = ?, reason = ?, owner_id = ?, updated_at = ?
    WHERE impact_item_id = ?`).run(
    assessmentStatus, resolution, reason ?? existing.reason ?? null, ownerId, now, impactId,
  );

  const projectId = impactProjectId(db, existing);
  if (projectId) {
    appendEvent(db, {
      project_id: projectId,
      object_type: 'impact_item',
      object_id: impactId,
      event_type: 'impact_item.updated',
      actor: ownerId,
      occurred_at: now,
      reason: reason ?? existing.reason ?? `影响评估更新为 ${assessmentStatus}`,
      refs: [existing.source_id, existing.target_id, impactId].filter(Boolean),
    });
  }

  return getImpact(db, impactId);
}

export function getImpact(db, impactId) {
  return parseImpactItem(
    db.prepare('SELECT * FROM impact_items WHERE impact_item_id = ?').get(impactId),
  );
}

/**
 * 按来源或项目列出影响项。
 * @param {object} [query] {source_type, source_id, project_id, assessment_status, target_type}
 */
export function listImpacts(db, query = {}) {
  const clauses = [];
  const params = [];
  const sourceType = pick(query, 'source_type', 'sourceType');
  if (sourceType) {
    if (!IMPACT_SOURCE_TYPES.includes(sourceType)) throw new Error(`非法的影响来源类型：${sourceType}`);
    clauses.push('source_type = ?');
    params.push(sourceType);
  }
  const sourceId = pick(query, 'source_id', 'sourceId');
  if (sourceId) {
    clauses.push('source_id = ?');
    params.push(sourceId);
  }
  const targetType = pick(query, 'target_type', 'targetType');
  if (targetType) {
    clauses.push('target_type = ?');
    params.push(targetType);
  }
  const assessmentStatus = pick(query, 'assessment_status', 'assessmentStatus');
  if (assessmentStatus) {
    clauses.push('assessment_status = ?');
    params.push(assessmentStatus);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM impact_items ${where}
    ORDER BY created_at ASC, impact_item_id ASC`).all(...params).map(parseImpactItem);

  const projectId = pick(query, 'project_id', 'projectId');
  if (!projectId) return rows;
  return rows.filter((row) => impactProjectId(db, row) === projectId);
}

/** 判断同来源 + 同目标的影响项是否已登记。 */
export function hasImpact(db, sourceType, sourceId, targetType, targetId) {
  return Boolean(db.prepare(`SELECT 1 AS hit FROM impact_items
    WHERE source_type = ? AND source_id = ? AND target_type = ? AND target_id = ? LIMIT 1`)
    .get(sourceType, sourceId, targetType, targetId));
}

/** 统计某来源下尚未处置的影响项数量。 */
export function countPendingImpacts(db, sourceType, sourceId) {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM impact_items
    WHERE source_type = ? AND source_id = ? AND assessment_status = 'to_check'`)
    .get(sourceType, sourceId).n);
}
