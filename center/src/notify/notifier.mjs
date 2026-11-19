// 通知投递规则（E 枝）：把「发生了什么事」翻译成「该提醒谁」。
// 通知是提醒，不是权限：收件人无权处理也只能看到提醒，不能因此获得动作资格。

import { listMembers } from '../db/actors.mjs';
import {
  createNotification,
  isEnabled,
  NOTIFICATION_KINDS,
} from '../db/notifications.mjs';

/** 某项目里拥有指定角色的主体 ID 列表。 */
export function membersWithRole(db, projectId, roles = []) {
  if (!projectId) return [];
  return listMembers(db, projectId)
    .filter((member) => (member.roles || []).some((role) => roles.includes(role)))
    .map((member) => member.actor_id);
}

/** 去重后的收件人列表，过滤掉停用主体与空值。 */
function uniqueActors(db, ids = []) {
  const seen = new Set();
  const result = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    const actor = db.prepare('SELECT actor_id, status FROM actors WHERE actor_id = ?').get(id);
    if (!actor || actor.status !== 'active') continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/** 按 kind 推导默认收件人；agent 同时提醒其人类责任人。 */
export function resolveRecipients(db, { kind, project_id: projectId, exclude = [], claim = null }) {
  let ids = [];
  if (kind === 'task_available') {
    ids = membersWithRole(db, projectId, ['contributor', 'owner']);
  } else if (kind === 'review_requested') {
    ids = membersWithRole(db, projectId, ['reviewer']);
  } else if (kind === 'decision_required') {
    ids = membersWithRole(db, projectId, ['direction', 'owner']);
  } else if (kind === 'impact_to_check') {
    ids = membersWithRole(db, projectId, ['owner']);
  } else if (kind === 'lease_expiring' && claim) {
    ids = [claim.actor_id ?? claim.worker_id];
  }

  // Agent 的通知同时抄送人类责任人：责任人不能因为「没看到」而免责。
  const withOwners = [];
  for (const id of ids) {
    withOwners.push(id);
    const actor = db.prepare('SELECT type FROM actors WHERE actor_id = ?').get(id);
    if (actor?.type === 'agent') {
      const delegation = db.prepare(`SELECT on_behalf_of FROM delegations
        WHERE agent_actor_id = ? AND revoked_at IS NULL
        ORDER BY created_at DESC LIMIT 1`).get(id);
      if (delegation?.on_behalf_of) withOwners.push(delegation.on_behalf_of);
    }
  }

  return uniqueActors(db, withOwners).filter((id) => !exclude.includes(id));
}

/**
 * 发送一条通知给一组收件人。
 * @returns {{created: number, skipped: number}}
 */
export function notify(db, input = {}) {
  const kind = input.kind;
  if (!NOTIFICATION_KINDS.includes(kind)) throw new Error(`非法的通知类型：${kind}`);
  const recipients = input.recipients
    ? uniqueActors(db, input.recipients)
    : resolveRecipients(db, input);

  let created = 0;
  let skipped = 0;
  for (const actorId of recipients) {
    if (!isEnabled(db, actorId, kind)) {
      skipped += 1;
      continue;
    }
    const dedupeKey = input.dedupe_key
      ? `${input.dedupe_key}:${actorId}`
      : `${kind}:${input.ref_type ?? 'none'}:${input.ref_id ?? 'none'}:${actorId}`;
    const row = createNotification(db, {
      actor_id: actorId,
      project_id: input.project_id,
      kind,
      title: input.title,
      body: input.body,
      ref_type: input.ref_type,
      ref_id: input.ref_id,
      dedupe_key: dedupeKey,
    });
    if (row) created += 1;
    else skipped += 1;
  }
  return { created, skipped };
}

/** 任务进入可认领状态。 */
export function notifyTaskAvailable(db, task) {
  if (!task) return { created: 0, skipped: 0 };
  return notify(db, {
    kind: 'task_available',
    project_id: task.project_id,
    title: `新任务可认领：${task.purpose ?? task.task_id}`,
    body: `任务 ${task.task_id} 已开放认领。`,
    ref_type: 'task',
    ref_id: task.task_id,
  });
}

/** 有人提交成果，需要评审。 */
export function notifyReviewRequested(db, task, submission, submittedBy) {
  if (!task || !submission) return { created: 0, skipped: 0 };
  return notify(db, {
    kind: 'review_requested',
    project_id: task.project_id,
    title: `待评审：${task.purpose ?? task.task_id}`,
    body: `${submittedBy ?? '提交者'} 提交了 ${submission.submission_id}，等待评审。`,
    ref_type: 'submission',
    ref_id: submission.submission_id,
    exclude: [submittedBy].filter(Boolean),
  });
}

/** 新需求进入，需要方向判断。 */
export function notifyDecisionRequired(db, requirement) {
  if (!requirement) return { created: 0, skipped: 0 };
  return notify(db, {
    kind: 'decision_required',
    project_id: requirement.project_id,
    title: `待判断需求：${String(requirement.raw_text ?? '').slice(0, 40)}`,
    body: `需求 ${requirement.requirement_id} 需要确认接受、改级或追问。`,
    ref_type: 'requirement',
    ref_id: requirement.requirement_id,
  });
}

/** 新增影响项，需要逐项处置。 */
export function notifyImpactToCheck(db, impactItem, projectId) {
  if (!impactItem) return { created: 0, skipped: 0 };
  return notify(db, {
    kind: 'impact_to_check',
    project_id: projectId,
    title: `待检查影响：${impactItem.target_type ?? '对象'} ${impactItem.target_id ?? ''}`,
    body: '主干/契约发生变化，需要判断该对象是否受影响。',
    ref_type: 'impact_item',
    ref_id: impactItem.impact_item_id,
    recipients: impactItem.owner_id ? [impactItem.owner_id] : undefined,
  });
}

/** 租约即将到期。 */
export function notifyLeaseExpiring(db, claim, task) {
  if (!claim || !task) return { created: 0, skipped: 0 };
  return notify(db, {
    kind: 'lease_expiring',
    project_id: task.project_id,
    title: `租约即将到期：${task.purpose ?? task.task_id}`,
    body: `认领 ${claim.claim_id} 将于 ${claim.lease_expires_at} 到期，请心跳续租或释放。`,
    ref_type: 'task',
    ref_id: task.task_id,
    claim,
  });
}
