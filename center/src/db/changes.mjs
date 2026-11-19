// Center 主干变更与影响处置存储（T7 归置）。

import { appendEvent } from './events.mjs';
import { getArtifact } from './artifacts.mjs';
import {
  IMPACT_ASSESSMENT_STATUSES,
  IMPACT_RESOLUTIONS,
  IMPACT_TARGET_TYPES,
  TRUNK_CHANGE_STATUSES,
} from './enums.mjs';
import { assertProjectExists } from './projects.mjs';
import { getRequirement } from './requirements.mjs';
import {
  createTrunkItem,
  getTrunkItem,
  updateTrunkItemStatus,
} from './trunk.mjs';
import {
  camel,
  codedError,
  decodeJson,
  encodeJson,
  newId,
  notFound,
  nowIso,
  pick,
  required,
} from './json.mjs';

/** 影响项所属项目：主干变更取 change.project_id，契约取 artifact.project_id。 */
function resolveImpactProjectId(db, impact) {
  if (!impact) return null;
  if (impact.source_type === 'artifact') {
    return getArtifact(db, impact.source_id)?.project_id ?? null;
  }
  if (impact.change_id) return getTrunkChange(db, impact.change_id)?.project_id ?? null;
  return null;
}

function parseTrunkChange(row) {  if (!row) return null;
  return {
    ...row,
    old_item_ids: decodeJson(row.old_item_ids, []),
    proposed_item_ids: decodeJson(row.proposed_item_ids, []),
  };
}

function parseImpactItem(row) {
  if (!row) return null;
  return { ...row };
}

const INSERT_TRUNK_CHANGE = `INSERT INTO trunk_changes (
  change_id, project_id, trigger_requirement_id, old_item_ids, proposed_item_ids,
  reason, impact_assessment, confirmed_by, confirmed_at, effective_at, policy_ref,
  status, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * 提出主干变更。必填 project_id、reason；trigger_requirement_id 可空；
 * old_item_ids[]、impact_assessment 可空；proposed_items[] 可空，
 * 每项复用 createTrunkItem 校验并建成 status=proposed 的条目。
 * 默认 status=proposed，写事件 change.proposed。
 * @returns {object} 已解析 JSON 字段的完整变更行
 */
export function createTrunkChange(db, input = {}) {
  const changeId = pick(input, 'change_id', 'changeId') ?? newId('chg');
  const projectId = required(input, 'project_id', 'projectId');
  const reason = required(input, 'reason');
  const status = pick(input, 'status') ?? 'proposed';

  if (!TRUNK_CHANGE_STATUSES.includes(status)) {
    throw new Error(`非法的主干变更状态：${status}`);
  }
  assertProjectExists(db, projectId);

  const triggerRequirementId = pick(input, 'trigger_requirement_id', 'triggerRequirementId');
  if (
    triggerRequirementId !== undefined
    && triggerRequirementId !== null
    && !getRequirement(db, triggerRequirementId)
  ) {
    throw new Error(`需求不存在：${triggerRequirementId}`);
  }

  const oldItemIds = pick(input, 'old_item_ids', 'oldItemIds') ?? [];
  if (!Array.isArray(oldItemIds)) throw new Error('old_item_ids 必须是数组');
  const proposedItems = pick(input, 'proposed_items', 'proposedItems') ?? [];
  if (!Array.isArray(proposedItems)) throw new Error('proposed_items 必须是数组');

  const impactAssessment = pick(input, 'impact_assessment', 'impactAssessment');

  const now = pick(input, 'created_at', 'createdAt') ?? nowIso();

  db.exec('BEGIN');
  try {
    // 提议中的新条目先建成 proposed，变更确认/生效后再推进状态。
    const proposedItemIds = proposedItems.map((item) => {
      const created = createTrunkItem(db, {
        ...(item && typeof item === 'object' ? item : {}),
        project_id: projectId,
        status: 'proposed',
      });
      return created.item_id;
    });

    db.prepare(INSERT_TRUNK_CHANGE).run(
      changeId,
      projectId,
      triggerRequirementId ?? null,
      encodeJson(oldItemIds),
      encodeJson(proposedItemIds),
      reason,
      impactAssessment ?? null,
      null,
      null,
      null,
      null,
      status,
      now,
    );

    appendEvent(db, {
      project_id: projectId,
      object_type: 'trunk_change',
      object_id: changeId,
      event_type: 'change.proposed',
      actor: pick(input, 'created_by', 'createdBy'),
      occurred_at: now,
      reason,
      refs: [...oldItemIds, ...proposedItemIds],
    });

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return getTrunkChange(db, changeId);
}

/** 按 ID 查询主干变更；不存在返回 null。 */
export function getTrunkChange(db, changeId) {
  return parseTrunkChange(
    db.prepare('SELECT * FROM trunk_changes WHERE change_id = ?').get(changeId),
  );
}

/** 列出主干变更，可按 project_id / status 过滤，按创建时间升序。 */
export function listTrunkChanges(db, query = {}) {
  const clauses = [];
  const params = [];

  const projectId = pick(query, 'project_id', 'projectId');
  if (projectId) {
    clauses.push('project_id = ?');
    params.push(projectId);
  }
  const status = pick(query, 'status');
  if (status) {
    if (!TRUNK_CHANGE_STATUSES.includes(status)) {
      throw new Error(`非法的主干变更状态：${status}`);
    }
    clauses.push('status = ?');
    params.push(status);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT * FROM trunk_changes ${where}
       ORDER BY created_at ASC, change_id ASC`,
    )
    .all(...params);
  return rows.map(parseTrunkChange);
}

/**
 * 确认主干变更：仅 proposed 可确认 → confirmed。
 * confirmed_by 必填；effective_at / policy_ref 可空。写事件 change.confirmed。
 * @returns {object} 更新后的完整变更行
 */
export function confirmTrunkChange(db, changeId, patch = {}) {
  const change = getTrunkChange(db, changeId);
  if (!change) throw notFound(`主干变更不存在：${changeId}`);
  if (change.status !== 'proposed') {
    throw codedError('INVALID_TRANSITION', `主干变更当前状态不可确认：${change.status}`);
  }

  const confirmedBy = required(patch, 'confirmed_by', 'confirmedBy');
  const now = pick(patch, 'confirmed_at', 'confirmedAt') ?? nowIso();
  const effectiveAt = pick(patch, 'effective_at', 'effectiveAt') ?? null;

  db.exec('BEGIN');
  try {
    db.prepare(
      `UPDATE trunk_changes
       SET status = 'confirmed', confirmed_by = ?, confirmed_at = ?,
           effective_at = ?, policy_ref = ?
       WHERE change_id = ?`,
    ).run(
      confirmedBy,
      now,
      effectiveAt,
      pick(patch, 'policy_ref', 'policyRef') ?? null,
      changeId,
    );

    appendEvent(db, {
      project_id: change.project_id,
      object_type: 'trunk_change',
      object_id: changeId,
      event_type: 'change.confirmed',
      actor: confirmedBy,
      occurred_at: now,
      reason: `变更已确认，生效时间：${effectiveAt ?? '未指定'}`,
      refs: [changeId, ...change.old_item_ids, ...change.proposed_item_ids],
    });

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return getTrunkChange(db, changeId);
}

/**
 * 计算旧条目对应的新条目：按位置配对；新条目多于旧条目时，
 * 多出的新条目视为最后一个旧条目的额外替代项，此时取第一个。
 */
function proposedCandidatesForOld(change, oldIndex) {
  const proposed = change.proposed_item_ids;
  if (oldIndex >= proposed.length) return [];
  if (oldIndex === change.old_item_ids.length - 1) return proposed.slice(oldIndex);
  return [proposed[oldIndex]];
}

/**
 * 使主干变更生效：仅 confirmed 可生效 → in_effect。同一事务内：
 * - proposed_item_ids 对应条目置 active（写 confirmed_at/confirmed_by），写 trunk_item.confirmed；
 * - old_item_ids 中仍为 active 的条目置 superseded 并写 superseded_by，写 trunk_item.superseded；
 * - 写事件 change.confirmed。
 * @returns {object} 更新后的完整变更行
 */
export function activateTrunkChange(db, changeId, patch = {}) {
  const change = getTrunkChange(db, changeId);
  if (!change) throw notFound(`主干变更不存在：${changeId}`);
  if (change.status !== 'confirmed') {
    throw codedError('INVALID_TRANSITION', `主干变更当前状态不可生效：${change.status}`);
  }

  const confirmedBy = required(patch, 'confirmed_by', 'confirmedBy');
  const now = nowIso();
  const effectiveAt = change.effective_at ?? now;

  db.exec('BEGIN');
  try {
    for (const itemId of change.proposed_item_ids) {
      const item = getTrunkItem(db, itemId);
      if (!item) throw new Error(`主干条目不存在：${itemId}`);
      updateTrunkItemStatus(db, itemId, 'active', {
        confirmed_at: effectiveAt,
        confirmed_by: confirmedBy,
      });
      appendEvent(db, {
        project_id: change.project_id,
        object_type: 'trunk_item',
        object_id: itemId,
        event_type: 'trunk_item.confirmed',
        actor: confirmedBy,
        occurred_at: effectiveAt,
        reason: `变更 ${changeId} 生效，新条目开始生效`,
        refs: [itemId, changeId],
      });
    }

    change.old_item_ids.forEach((oldId, index) => {
      const item = getTrunkItem(db, oldId);
      if (!item) throw new Error(`主干条目不存在：${oldId}`);
      if (item.status !== 'active') return;

      const candidates = proposedCandidatesForOld(change, index);
      const replacement = candidates[0] ?? null;
      const reason = replacement
        ? (candidates.length > 1
          ? `被 ${candidates.length} 个新条目替代，此处记录第一个：${replacement}`
          : `被新条目替代：${replacement}`)
        : '本次变更未提出替代条目，旧条目停止生效';

      updateTrunkItemStatus(db, oldId, 'superseded', { superseded_by: replacement });
      appendEvent(db, {
        project_id: change.project_id,
        object_type: 'trunk_item',
        object_id: oldId,
        event_type: 'trunk_item.superseded',
        actor: confirmedBy,
        occurred_at: effectiveAt,
        reason,
        refs: [oldId, replacement, changeId].filter(Boolean),
      });
    });

    db.prepare(
      `UPDATE trunk_changes SET status = 'in_effect', effective_at = ?
       WHERE change_id = ?`,
    ).run(effectiveAt, changeId);

    appendEvent(db, {
      project_id: change.project_id,
      object_type: 'trunk_change',
      object_id: changeId,
      event_type: 'change.confirmed',
      actor: confirmedBy,
      occurred_at: effectiveAt,
      reason: '变更已生效：新条目 active，旧条目 superseded',
      refs: [changeId, ...change.old_item_ids, ...change.proposed_item_ids],
    });

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return getTrunkChange(db, changeId);
}

/**
 * 关闭主干变更：仅 in_effect 可关闭 → closed。
 * 关闭前必须满足：所有影响项 assessment_status 都不是 to_check；
 * 若没有任何影响项，则 impact_assessment 必须是非空字符串（已明确声明并检查过）。
 * 不满足抛 code=CHANGE_IMPACT_UNRESOLVED。写事件 change.closed。
 * @returns {object} 更新后的完整变更行
 */
export function closeTrunkChange(db, changeId) {
  const change = getTrunkChange(db, changeId);
  if (!change) throw notFound(`主干变更不存在：${changeId}`);
  if (change.status !== 'in_effect') {
    throw codedError('INVALID_TRANSITION', `主干变更当前状态不可关闭：${change.status}`);
  }

  const impacts = listImpactItems(db, changeId);
  const pending = impacts.filter((item) => item.assessment_status === 'to_check');
  if (pending.length > 0) {
    throw codedError(
      'CHANGE_IMPACT_UNRESOLVED',
      `仍有 ${pending.length} 个影响项处于待检查（to_check），不能关闭变更`,
    );
  }
  if (impacts.length === 0) {
    const assessment = typeof change.impact_assessment === 'string'
      ? change.impact_assessment.trim()
      : '';
    if (!assessment) {
      throw codedError(
        'CHANGE_IMPACT_UNRESOLVED',
        '未登记任何影响项，且未提供影响声明（impact_assessment），不能关闭变更',
      );
    }
  }

  const now = nowIso();
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE trunk_changes SET status = 'closed' WHERE change_id = ?`).run(changeId);
    appendEvent(db, {
      project_id: change.project_id,
      object_type: 'trunk_change',
      object_id: changeId,
      event_type: 'change.closed',
      actor: change.confirmed_by,
      occurred_at: now,
      reason: '影响处置完成，变更关闭',
      refs: [changeId, ...impacts.map((item) => item.impact_item_id)],
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return getTrunkChange(db, changeId);
}

const INSERT_IMPACT_ITEM = `INSERT INTO impact_items (
  impact_item_id, change_id, source_type, source_id, target_type, target_id,
  assessment_status, resolution, reason, owner_id, updated_at, created_at
) VALUES (?, ?, 'trunk_change', ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * 登记影响项。target_type 允许 task/submission/document/test/other；
 * 默认 assessment_status=to_check、resolution=pending。写事件 impact_item.created。
 * @returns {object} 完整影响项行
 */
export function addImpactItem(db, input = {}) {
  const impactItemId = pick(input, 'impact_item_id', 'impactItemId') ?? newId('imp');
  const changeId = required(input, 'change_id', 'changeId');
  const targetType = required(input, 'target_type', 'targetType');
  const targetId = required(input, 'target_id', 'targetId');
  const ownerId = pick(input, 'owner_id', 'ownerId');

  if (!IMPACT_TARGET_TYPES.includes(targetType)) {
    throw new Error(`非法的影响对象类型：${targetType}`);
  }

  const change = getTrunkChange(db, changeId);
  if (!change) throw notFound(`主干变更不存在：${changeId}`);

  const now = pick(input, 'created_at', 'createdAt') ?? nowIso();
  db.prepare(INSERT_IMPACT_ITEM).run(
    impactItemId,
    changeId,
    changeId,
    targetType,
    targetId,
    'to_check',
    'pending',
    null,
    ownerId ?? null,
    now,
    now,
  );

  appendEvent(db, {
    project_id: change.project_id,
    object_type: 'impact_item',
    object_id: impactItemId,
    event_type: 'impact_item.created',
    actor: ownerId,
    occurred_at: now,
    reason: `登记影响对象 ${targetType}:${targetId}，待检查`,
    refs: [changeId, targetId],
  });

  return getImpactItem(db, impactItemId);
}

/**
 * 更新影响项处置。assessment_status 允许 to_check/affected/not_affected；
 * resolution 允许 continue/adjust/revalidate/obsolete/pending；
 * not_affected 时 reason 必填。写事件 impact_item.updated。
 * @returns {object} 更新后的完整影响项行
 */
export function updateImpactItem(db, impactItemId, patch = {}) {
  const existing = getImpactItem(db, impactItemId);
  if (!existing) throw notFound(`影响项不存在：${impactItemId}`);

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
  if (
    assessmentStatus === 'not_affected'
    && (reason === undefined || String(reason).trim() === '')
  ) {
    throw new Error('影响评估为 not_affected 时必须提供 reason，说明确认无影响的依据');
  }

  const ownerId = pick(patch, 'owner_id', 'ownerId') ?? existing.owner_id;
  const now = nowIso();

  db.prepare(
    `UPDATE impact_items
     SET assessment_status = ?, resolution = ?, reason = ?, owner_id = ?, updated_at = ?
     WHERE impact_item_id = ?`,
  ).run(
    assessmentStatus,
    resolution,
    reason ?? existing.reason ?? null,
    ownerId,
    now,
    impactItemId,
  );

  const projectId = resolveImpactProjectId(db, existing);
  if (projectId) {
    appendEvent(db, {
      project_id: projectId,
      object_type: 'impact_item',
      object_id: impactItemId,
      event_type: 'impact_item.updated',
      actor: ownerId,
      occurred_at: now,
      reason: reason ?? existing.reason ?? `影响评估更新为 ${assessmentStatus}`,
      refs: [existing.source_id, existing.target_id, impactItemId].filter(Boolean),
    });
  }

  return getImpactItem(db, impactItemId);
}

/** 按 ID 查询影响项；不存在返回 null。 */
export function getImpactItem(db, impactItemId) {
  return parseImpactItem(
    db.prepare('SELECT * FROM impact_items WHERE impact_item_id = ?').get(impactItemId),
  );
}

/** 列出某变更的全部影响项，按创建时间升序。 */
export function listImpactItems(db, changeId) {
  const rows = db
    .prepare(
      `SELECT * FROM impact_items WHERE change_id = ?
       ORDER BY created_at ASC, impact_item_id ASC`,
    )
    .all(changeId);
  return rows.map(parseImpactItem);
}
