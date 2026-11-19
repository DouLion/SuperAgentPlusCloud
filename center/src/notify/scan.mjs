// 通知扫描（E 枝）：把「需要人注意但没人主动推送」的状态补成通知。
// 扫描是幂等的：同一 claim / 同一提交重复扫描不会重复通知。

import { notifyLeaseExpiring, notifyReviewRequested, notify } from './notifier.mjs';

/** 租约即将到期的判定窗口：5 分钟。 */
export const LEASE_SCAN_WINDOW_MS = 5 * 60 * 1000;
/** 提交后 24 小时未评审视为积压。 */
export const REVIEW_SCAN_WINDOW_MS = 24 * 60 * 60 * 1000;

function ms(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * 扫描并生成两类通知：租约临期、评审积压。
 * @returns {{lease_expiring: number, review_requested: number}}
 */
export function scanNotifications(db, now = Date.now()) {
  const isoTimestamp = new Date(now).toISOString();
  let leaseCount = 0;
  let reviewCount = 0;

  const claims = db.prepare(`SELECT c.*, t.project_id, t.task_id, t.purpose
    FROM claims c JOIN tasks t ON t.task_id = c.task_id
    WHERE c.status = 'active' AND c.lease_expires_at IS NOT NULL`).all();
  for (const claim of claims) {
    const expires = ms(claim.lease_expires_at);
    if (expires === null || expires - now > LEASE_SCAN_WINDOW_MS || expires < now) continue;
    const result = notifyLeaseExpiring(
      db,
      claim,
      { project_id: claim.project_id, task_id: claim.task_id, purpose: claim.purpose },
    );
    leaseCount += result.created;
  }

  const submitted = db.prepare(`SELECT t.* FROM tasks t WHERE t.status = 'submitted'`).all();
  for (const task of submitted) {
    const last = db.prepare(`SELECT * FROM submissions WHERE task_id = ?
      ORDER BY submitted_at DESC LIMIT 1`).get(task.task_id);
    if (!last) continue;
    const submittedMs = ms(last.submitted_at);
    if (submittedMs === null || now - submittedMs < REVIEW_SCAN_WINDOW_MS) continue;
    const result = notifyReviewRequested(db, task, last, last.submitted_by);
    reviewCount += result.created;
  }

  // 系统级提示量：仅在确实产生了新通知时记录，避免噪音。
  if (leaseCount + reviewCount > 0) {
    notify(db, {
      kind: 'system',
      title: '通知扫描完成',
      body: `新增租约提醒 ${leaseCount} 条、评审积压提醒 ${reviewCount} 条。`,
      ref_type: 'scan',
      ref_id: isoTimestamp,
      recipients: [],
      dedupe_key: `scan:${isoTimestamp}`,
    });
  }

  return { lease_expiring: leaseCount, review_requested: reviewCount };
}
