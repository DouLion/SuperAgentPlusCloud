// Center 需求、评估与决定存储（T7 归置）。

import { listEvents, appendEvent } from './events.mjs';
import { enqueueFromEvent } from '../protocol/outbox.mjs';
import { notifyDecisionRequired } from '../notify/notifier.mjs';
import {
  ASSESSMENT_LEVELS,
  ASSESSOR_TYPES,
  DECISION_CONCLUSIONS,
  DECISION_STATUS_MAP,
  LEVELS,
  PROPOSED_ACTIONS,
  REQUIREMENT_STATUSES,
} from './enums.mjs';
import { assertProjectExists } from './projects.mjs';
import {
  camel,
  codedError,
  decodeJson,
  encodeJson,
  jsonField,
  newId,
  nowIso,
  pick,
  required,
} from './json.mjs';

const INSERT_REQUIREMENT = `INSERT INTO requirements (
  requirement_id, project_id, author, source_ref, raw_text, attachments,
  claimed_level, claimed_reason, related_item_ids, status, final_level, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function parseRequirement(row) {
  if (!row) return null;
  return {
    ...row,
    attachments: decodeJson(row.attachments, []),
    related_item_ids: decodeJson(row.related_item_ids, []),
  };
}

/**
 * 提交需求。必填 project_id、raw_text；claimed_level 可空；默认 status=submitted。
 * @returns {object} 已解析 JSON 字段的完整行
 */
export function createRequirement(db, input = {}) {
  const requirementId = pick(input, 'requirement_id', 'requirementId') ?? newId('req');
  const projectId = required(input, 'project_id', 'projectId');
  const rawText = required(input, 'raw_text', 'rawText');
  const status = pick(input, 'status') ?? 'submitted';

  if (!REQUIREMENT_STATUSES.includes(status)) {
    throw new Error(`非法的需求状态：${status}`);
  }
  assertProjectExists(db, projectId);

  const now = pick(input, 'created_at', 'createdAt') ?? nowIso();
  const relatedItemIds = pick(input, 'related_item_ids', 'relatedItemIds');

  db.prepare(INSERT_REQUIREMENT).run(
    requirementId,
    projectId,
    pick(input, 'author'),
    pick(input, 'source_ref', 'sourceRef'),
    rawText,
    jsonField(input, 'attachments'),
    pick(input, 'claimed_level', 'claimedLevel'),
    pick(input, 'claimed_reason', 'claimedReason'),
    encodeJson(relatedItemIds === undefined ? [] : relatedItemIds),
    status,
    pick(input, 'final_level', 'finalLevel'),
    now,
  );

  appendEvent(db, {
    project_id: projectId,
    object_type: 'requirement',
    object_id: requirementId,
    event_type: 'requirement.submitted',
    actor: pick(input, 'author'),
    occurred_at: now,
    reason: pick(input, 'claimed_reason', 'claimedReason'),
    refs: relatedItemIds === undefined ? [] : [...relatedItemIds],
  });

  const created = getRequirement(db, requirementId);
  try {
    notifyDecisionRequired(db, created);
  } catch {
    // 忽略通知异常
  }
  return created;
}

/** 按 ID 查询需求；不存在返回 null。 */
export function getRequirement(db, requirementId) {
  return parseRequirement(
    db.prepare('SELECT * FROM requirements WHERE requirement_id = ?').get(requirementId),
  );
}

/** 列出需求，可按 project_id / status 过滤，按创建时间升序。 */
export function listRequirements(db, query = {}) {
  const clauses = [];
  const params = [];

  const projectId = pick(query, 'project_id', 'projectId');
  if (projectId) {
    clauses.push('project_id = ?');
    params.push(projectId);
  }
  const status = pick(query, 'status');
  if (status) {
    if (!REQUIREMENT_STATUSES.includes(status)) {
      throw new Error(`非法的需求状态：${status}`);
    }
    clauses.push('status = ?');
    params.push(status);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT * FROM requirements ${where}
       ORDER BY created_at ASC, requirement_id ASC`,
    )
    .all(...params);
  return rows.map(parseRequirement);
}

const REQUIREMENT_SCALAR_PATCH = {
  claimed_level: 'claimed_level',
  claimed_reason: 'claimed_reason',
  source_ref: 'source_ref',
  author: 'author',
  final_level: 'final_level',
};

const REQUIREMENT_JSON_PATCH = {
  attachments: 'attachments',
  related_item_ids: 'related_item_ids',
};

/**
 * 更新需求状态，可附带更新自报等级、来源、关联条目、最终等级等。
 * @param {object} [patch] 允许的附加字段；actor / reason 用于事件
 * @returns {object|null} 更新后的完整行
 */
export function updateRequirementStatus(db, requirementId, status, patch = {}) {
  if (!REQUIREMENT_STATUSES.includes(status)) {
    throw new Error(`非法的需求状态：${status}`);
  }
  const existing = getRequirement(db, requirementId);
  if (!existing) throw new Error(`需求不存在：${requirementId}`);

  const assignments = ['status = ?'];
  const params = [status];

  for (const [key, column] of Object.entries(REQUIREMENT_SCALAR_PATCH)) {
    if (patch[key] !== undefined || patch[camel(key)] !== undefined) {
      assignments.push(`${column} = ?`);
      params.push(pick(patch, key, camel(key)));
    }
  }
  for (const [key, column] of Object.entries(REQUIREMENT_JSON_PATCH)) {
    if (patch[key] !== undefined || patch[camel(key)] !== undefined) {
      assignments.push(`${column} = ?`);
      params.push(encodeJson(pick(patch, key, camel(key))));
    }
  }

  params.push(requirementId);
  db.prepare(
    `UPDATE requirements SET ${assignments.join(', ')} WHERE requirement_id = ?`,
  ).run(...params);

  appendEvent(db, {
    project_id: existing.project_id,
    object_type: 'requirement',
    object_id: requirementId,
    event_type: 'requirement.updated',
    actor: pick(patch, 'actor', 'updated_by', 'updatedBy'),
    reason: pick(patch, 'reason'),
    refs: [requirementId],
  });

  return getRequirement(db, requirementId);
}

// -------------------------------------------------------------------- 评估

const INSERT_ASSESSMENT = `INSERT INTO assessments (
  assessment_id, requirement_id, assessed_level, related_item_ids, impact_summary,
  uncertainties, proposed_action, assessor_type, assessor_id, created_at, source_refs
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function parseAssessment(row) {
  if (!row) return null;
  return {
    ...row,
    related_item_ids: decodeJson(row.related_item_ids, []),
    uncertainties: decodeJson(row.uncertainties, []),
    source_refs: decodeJson(row.source_refs, []),
  };
}

/**
 * 新建评估。必填 requirement_id；assessed_level 允许 L0..L4 或 undecided（缺省 undecided）；
 * proposed_action 允许 accept/relevel/ask/reject/investigate；assessor_type 缺省 AI。
 * 关联规则：必须引用相关主干条目（related_item_ids 非空），或明确标记信息不足
 * （assessed_level=undecided）；两者都不满足时抛 code=ASSESSMENT_NOT_LINKED（400），
 * 不允许用空关联默认降级。
 * 若需求当前为 submitted，自动置为 assessed。
 * @returns {object} 已解析 JSON 字段的完整评估行
 */
export function createAssessment(db, input = {}) {
  const assessmentId = pick(input, 'assessment_id', 'assessmentId') ?? newId('asm');
  const requirementId = required(input, 'requirement_id', 'requirementId');

  const requirement = getRequirement(db, requirementId);
  if (!requirement) throw new Error(`需求不存在：${requirementId}`);

  const assessedLevel = pick(input, 'assessed_level', 'assessedLevel') ?? 'undecided';
  if (!ASSESSMENT_LEVELS.includes(assessedLevel)) {
    throw new Error(`非法的评估等级：${assessedLevel}`);
  }

  // 关联校验：有主干条目引用，或明确标记信息不足（undecided）。
  const relatedItemIds = pick(input, 'related_item_ids', 'relatedItemIds');
  const hasRelatedItems = Array.isArray(relatedItemIds) && relatedItemIds.length > 0;
  if (!hasRelatedItems && assessedLevel !== 'undecided') {
    throw codedError(
      'ASSESSMENT_NOT_LINKED',
      '评估必须引用相关主干条目；信息不足时请使用 assessed_level=undecided',
      400,
    );
  }

  const proposedAction = pick(input, 'proposed_action', 'proposedAction');
  if (proposedAction !== undefined && !PROPOSED_ACTIONS.includes(proposedAction)) {
    throw new Error(`非法的建议动作：${proposedAction}`);
  }

  const assessorType = pick(input, 'assessor_type', 'assessorType') ?? 'AI';
  if (!ASSESSOR_TYPES.includes(assessorType)) {
    throw new Error(`非法的评估者类型：${assessorType}`);
  }

  const assessorId = pick(input, 'assessor_id', 'assessorId');
  const now = pick(input, 'created_at', 'createdAt') ?? nowIso();

  db.prepare(INSERT_ASSESSMENT).run(
    assessmentId,
    requirementId,
    assessedLevel,
    jsonField(input, 'related_item_ids'),
    pick(input, 'impact_summary', 'impactSummary'),
    jsonField(input, 'uncertainties'),
    proposedAction,
    assessorType,
    assessorId,
    now,
    jsonField(input, 'source_refs'),
  );

  // 评估完成后，submitted → assessed（仅在尚未进入后续状态时）。
  if (requirement.status === 'submitted') {
    updateRequirementStatus(db, requirementId, 'assessed', {
      actor: assessorId ?? assessorType,
      reason: `评估完成：${proposedAction ?? 'undecided'}`,
    });
  }

  appendEvent(db, {
    project_id: requirement.project_id,
    object_type: 'assessment',
    object_id: assessmentId,
    event_type: 'assessment.created',
    actor: assessorId ?? assessorType,
    occurred_at: now,
    reason: pick(input, 'impact_summary', 'impactSummary'),
    refs: [requirementId],
  });

  return getAssessment(db, assessmentId);
}

/** 按 ID 查询评估；不存在返回 null。 */
export function getAssessment(db, assessmentId) {
  return parseAssessment(
    db.prepare('SELECT * FROM assessments WHERE assessment_id = ?').get(assessmentId),
  );
}

/** 列出某需求的全部评估（旧评估保留，按创建时间升序）。 */
export function listAssessments(db, requirementId) {
  const rows = db
    .prepare(
      `SELECT * FROM assessments WHERE requirement_id = ?
       ORDER BY created_at ASC, assessment_id ASC`,
    )
    .all(requirementId);
  return rows.map(parseAssessment);
}

// -------------------------------------------------------------------- 决定

const INSERT_DECISION = `INSERT INTO decisions (
  decision_id, requirement_id, conclusion, final_level, reason, confirmed_by,
  confirmed_at, policy_ref, assessment_ref, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * 记录人类确认的决定，并按结论同步需求状态。
 * 规则：accepted/relevelled 必须有 final_level（L0..L4）；relevelled 必须有 reason。
 * @returns {object} 完整决定行
 */
export function createDecision(db, input = {}) {
  const decisionId = pick(input, 'decision_id', 'decisionId') ?? newId('dec');
  const requirementId = required(input, 'requirement_id', 'requirementId');
  const conclusion = required(input, 'conclusion');
  const confirmedBy = required(input, 'confirmed_by', 'confirmedBy');

  if (!DECISION_CONCLUSIONS.includes(conclusion)) {
    throw new Error(`非法的决定结论：${conclusion}`);
  }

  const finalLevel = pick(input, 'final_level', 'finalLevel');
  if (conclusion === 'accepted' || conclusion === 'relevelled') {
    if (!finalLevel) {
      throw new Error(`结论为 ${conclusion} 时必须提供 final_level（L0..L4）`);
    }
    if (!LEVELS.includes(finalLevel)) {
      throw new Error(`非法的等级：${finalLevel}`);
    }
  }
  if (conclusion === 'relevelled' && !pick(input, 'reason')) {
    throw new Error('结论为 relevelled 时必须提供 reason');
  }

  const requirement = getRequirement(db, requirementId);
  if (!requirement) throw new Error(`需求不存在：${requirementId}`);

  const now = pick(input, 'confirmed_at', 'confirmedAt') ?? nowIso();

  db.prepare(INSERT_DECISION).run(
    decisionId,
    requirementId,
    conclusion,
    finalLevel,
    pick(input, 'reason'),
    confirmedBy,
    now,
    pick(input, 'policy_ref', 'policyRef'),
    pick(input, 'assessment_ref', 'assessmentRef'),
    now,
  );

  // 决定写入后同步需求状态；状态确实变化或最终等级更新时才写 requirement.updated。
  const nextStatus = DECISION_STATUS_MAP[conclusion];
  if (requirement.status !== nextStatus || (finalLevel && requirement.final_level !== finalLevel)) {
    updateRequirementStatus(db, requirementId, nextStatus, {
      final_level: finalLevel,
      actor: confirmedBy,
      reason: pick(input, 'reason'),
    });
  }

  const decidedEvent = appendEvent(db, {
    project_id: requirement.project_id,
    object_type: 'decision',
    object_id: decisionId,
    event_type: 'decision.confirmed',
    actor: confirmedBy,
    occurred_at: now,
    reason: pick(input, 'reason'),
    refs: [requirementId],
  });
  enqueueFromEvent(db, decidedEvent);

  return db.prepare('SELECT * FROM decisions WHERE decision_id = ?').get(decisionId);
}

/** 列出某需求的全部决定（历史保留，按确认时间升序）。 */
export function listDecisions(db, requirementId) {
  return db
    .prepare(
      `SELECT * FROM decisions WHERE requirement_id = ?
       ORDER BY confirmed_at ASC, decision_id ASC`,
    )
    .all(requirementId);
}

/**
 * 需求时间线：本需求自身的事件，以及评估/决定等引用了本需求的事件，按发生时间升序。
 * @returns {object[]} 事件列表
 */
export function listRequirementTimeline(db, requirementId) {
  const requirement = getRequirement(db, requirementId);
  if (!requirement) throw new Error(`需求不存在：${requirementId}`);

  const events = listEvents(db, { projectId: requirement.project_id, limit: 1000 });
  return events
    .filter(
      (event) =>
        event.object_id === requirementId ||
        (Array.isArray(event.refs) && event.refs.includes(requirementId)),
    )
    .sort((a, b) => {
      if (a.occurred_at !== b.occurred_at) {
        return a.occurred_at < b.occurred_at ? -1 : 1;
      }
      return a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0;
    });
}
