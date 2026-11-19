// Center 提交与评审存储（T7 归置）。

import { appendEvent } from './events.mjs';
import { enqueueFromEvent } from '../protocol/outbox.mjs';
import { notifyReviewRequested } from '../notify/notifier.mjs';
import { REVIEW_CONCLUSIONS } from './enums.mjs';
import { assertClaimValid, activeOwnerClaim } from './claims.mjs';
import { getTask } from './tasks.mjs';
import { factsByIds, summarizeFact } from './facts.mjs';
import {
  decodeJson,
  encodeJson,
  jsonField,
  newId,
  nowIso,
  pick,
  required,
} from './json.mjs';

const INSERT_SUBMISSION = `INSERT INTO submissions (
  submission_id, task_id, claim_id, commit_refs, summary, self_test,
  known_gaps, artifacts, external_fact_ids, submitted_by, submitted_at, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function parseSubmission(row) {
  if (!row) return null;
  return {
    ...row,
    commit_refs: decodeJson(row.commit_refs, []),
    known_gaps: decodeJson(row.known_gaps, []),
    artifacts: decodeJson(row.artifacts, []),
    external_fact_ids: decodeJson(row.external_fact_ids, []),
  };
}

/**
 * 校验 commit_refs：必须是非空数组；每项是非空字符串，
 * 或含 repo/branch/hash 至少一项的对象。
 */
function normalizeCommitRefs(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('缺少必填字段：commit_refs（必须是非空数组）');
  }
  value.forEach((item, index) => {
    const position = `第 ${index + 1} 项`;
    if (typeof item === 'string') {
      if (item.trim() === '') {
        throw new Error(`commit_refs ${position} 不能为空字符串`);
      }
      return;
    }
    if (item && typeof item === 'object') {
      if (!pick(item, 'repo') && !pick(item, 'branch') && !pick(item, 'hash')) {
        throw new Error(`commit_refs ${position}必须包含 repo/branch/hash`);
      }
      return;
    }
    throw new Error(`commit_refs ${position} 必须是非空字符串或对象`);
  });
  return value;
}

/**
 * 登记任务成果提交。必填 task_id、commit_refs（非空）、summary、submitted_by。
 * 必须持有该任务的 active 认领（本人），且租约未过期：
 * - 传 claim_id 时按该认领校验（可用 fencing_token 防旧权利写入）；
 * - 不传 claim_id 时按提交人查找 active 认领（兼容旧调用）。
 * 只有 owner 的提交会把任务置为 submitted；协作者的提交只记为贡献。
 * @returns {object} 已解析 JSON 字段的完整提交行（含 contribution 标记）
 */
export function createSubmission(db, input = {}) {
  const submissionId = pick(input, 'submission_id', 'submissionId') ?? newId('sub');
  const taskId = required(input, 'task_id', 'taskId');
  const summary = required(input, 'summary');
  const submittedBy = required(input, 'submitted_by', 'submittedBy');
  const commitRefs = normalizeCommitRefs(pick(input, 'commit_refs', 'commitRefs'));

  const task = getTask(db, taskId);
  if (!task) throw new Error(`任务不存在：${taskId}`);

  db.exec('BEGIN');
  try {
    const claimIdInput = pick(input, 'claim_id', 'claimId');
    let claim;
    if (claimIdInput) {
      claim = assertClaimValid(db, claimIdInput, {
        actor_id: submittedBy,
        fencing_token: pick(input, 'fencing_token', 'fencingToken'),
      });
      if (claim.task_id !== taskId) {
        throw Object.assign(new Error('认领不属于该任务'), {
          code: 'CLAIM_NOT_OWNED',
          status: 409,
        });
      }
    } else {
      claim = db.prepare(`SELECT * FROM claims WHERE task_id = ? AND status = 'active'
        AND (actor_id = ? OR worker_id = ?)
        ORDER BY claimed_at ASC, claim_id ASC LIMIT 1`).get(taskId, submittedBy, submittedBy);
      if (!claim) {
        throw Object.assign(new Error('只有当前活跃认领的认领者本人才能提交成果'), {
          code: 'SUBMISSION_NOT_ALLOWED',
          status: 409,
        });
      }
      // 旧调用没有 fencing，但仍必须租约有效。
      claim = assertClaimValid(db, claim.claim_id, { actor_id: submittedBy });
    }

    const isOwner = (claim.role ?? 'owner') === 'owner';
    const now = pick(input, 'submitted_at', 'submittedAt') ?? nowIso();

    // 外部事实只是证据：必须存在且属于同一项目，否则拒绝引用。
    const factIds = [...new Set((pick(input, 'external_fact_ids', 'externalFactIds') ?? [])
      .filter((id) => typeof id === 'string' && id.trim()))];
    if (factIds.length) {
      const facts = factsByIds(db, factIds);
      const found = new Set(facts.map((fact) => fact.fact_id));
      const missing = factIds.filter((id) => !found.has(id));
      if (missing.length) {
        throw Object.assign(new Error(`事实不存在：${missing.join(', ')}`), {
          code: 'FACT_NOT_FOUND',
          status: 400,
        });
      }
      const foreign = facts.filter((fact) => fact.project_id !== task.project_id);
      if (foreign.length) {
        throw Object.assign(
          new Error(`事实不属于任务所在项目：${foreign.map((fact) => fact.fact_id).join(', ')}`),
          { code: 'FACT_PROJECT_MISMATCH', status: 400 },
        );
      }
    }

    // 提交里的 commit hash 若已同步为项目事实，自动挂上证据：代码不说谎，自述才可能说谎。
    const commitHashes = commitRefs
      .map((ref) => (typeof ref === 'string' ? ref : ref?.hash))
      .filter((hash) => typeof hash === 'string' && hash.trim())
      .map((hash) => hash.trim());
    for (const hash of commitHashes) {
      const fact = db.prepare(`SELECT fact_id FROM external_facts
        WHERE project_id = ? AND source = 'git' AND kind = 'commit' AND external_id = ?`).get(task.project_id, hash);
      if (fact) factIds.push(fact.fact_id);
      else {
        // 只允许前缀匹配完整 sha，避免把短哈希误挂到别的提交上。
        const prefixed = db.prepare(`SELECT fact_id FROM external_facts
          WHERE project_id = ? AND source = 'git' AND kind = 'commit' AND external_id LIKE ?
          LIMIT 2`).all(task.project_id, `${hash}%`);
        if (prefixed.length === 1) factIds.push(prefixed[0].fact_id);
      }
    }

    db.prepare(INSERT_SUBMISSION).run(
      submissionId,
      taskId,
      claim.claim_id,
      encodeJson(commitRefs),
      summary,
      pick(input, 'self_test', 'selfTest'),
      jsonField(input, 'known_gaps'),
      jsonField(input, 'artifacts'),
      encodeJson([...new Set(factIds)]),
      isOwner ? submittedBy : `${submittedBy} (collaborator)`,
      now,
      pick(input, 'created_at', 'createdAt') ?? now,
    );

    if (isOwner) {
      db.prepare(`UPDATE tasks SET status = 'submitted', revision = revision + 1 WHERE task_id = ?`)
        .run(taskId);
    }

    const submissionEvent = appendEvent(db, {
      project_id: task.project_id,
      object_type: 'submission',
      object_id: submissionId,
      event_type: isOwner ? 'submission.created' : 'submission.contributed',
      actor: submittedBy,
      occurred_at: now,
      reason: summary,
      refs: [taskId, claim.claim_id],
    });
    enqueueFromEvent(db, submissionEvent);

    const submission = getSubmission(db, submissionId);
    db.exec('COMMIT');
    // 通知在事务外发送：提醒失败不应回滚已生效的提交。
    if (isOwner) {
      try {
        notifyReviewRequested(db, task, submission, submittedBy);
      } catch {
        // 忽略通知异常
      }
    }
    return { ...submission, contribution: !isOwner };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** 按 ID 查询提交；不存在返回 null。附带外部事实摘要，便于核对证据来源。 */
export function getSubmission(db, submissionId) {
  const submission = parseSubmission(
    db.prepare('SELECT * FROM submissions WHERE submission_id = ?').get(submissionId),
  );
  if (!submission) return null;
  const facts = factsByIds(db, submission.external_fact_ids).map(summarizeFact);
  return { ...submission, external_facts: facts };
}

/** 列出提交，可按 task_id 过滤，按提交时间升序。 */
export function listSubmissions(db, query = {}) {
  const taskId = pick(query, 'task_id', 'taskId');
  const where = taskId ? 'WHERE task_id = ?' : '';
  const params = taskId ? [taskId] : [];
  const rows = db
    .prepare(
      `SELECT * FROM submissions ${where}
       ORDER BY submitted_at ASC, submission_id ASC`,
    )
    .all(...params);
  return rows.map(parseSubmission);
}

// -------------------------------------------------------------------- 评审

const INSERT_REVIEW = `INSERT INTO reviews (
  review_id, submission_id, reviewer_id, conclusion, criterion_results,
  reason, self_review, reviewed_at, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function parseReview(row) {
  if (!row) return null;
  return { ...row, criterion_results: decodeJson(row.criterion_results, []) };
}

/** 校验逐项条件结果：每项至少含 criterion 与 result，evidence 可空。 */
function normalizeCriterionResults(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('criterion_results 必须是数组');
  return value.map((item, index) => {
    const position = `第 ${index + 1} 项`;
    if (!item || typeof item !== 'object') {
      throw new Error(`criterion_results ${position} 必须是对象`);
    }
    const criterion = pick(item, 'criterion');
    const result = pick(item, 'result');
    if (!criterion) throw new Error(`criterion_results ${position} 缺少 criterion`);
    if (!result) throw new Error(`criterion_results ${position} 缺少 result`);
    return { criterion, result, evidence: pick(item, 'evidence') ?? '' };
  });
}

/**
 * 记录对某次提交的评审，并在同一事务内推进任务状态：
 * - confirm：任务 accepted，写 review.confirmed；
 * - reject：任务 rework，当前 active 认领置 released（写 task.released、review.rejected）；
 * - needs_info：任务保持 submitted，写 review.needs_info。
 * self_review 由 reviewer_id 与提交人是否相同自动判定。
 * @returns {object} 已解析 JSON 字段的完整评审行
 */
export function createReview(db, input = {}) {
  const reviewId = pick(input, 'review_id', 'reviewId') ?? newId('rev');
  const submissionId = required(input, 'submission_id', 'submissionId');
  const reviewerId = required(input, 'reviewer_id', 'reviewerId');
  const conclusion = required(input, 'conclusion');

  if (!REVIEW_CONCLUSIONS.includes(conclusion)) {
    throw new Error(`非法的评审结论：${conclusion}`);
  }

  const submission = getSubmission(db, submissionId);
  if (!submission) throw new Error(`提交不存在：${submissionId}`);

  const criterionResults = normalizeCriterionResults(
    pick(input, 'criterion_results', 'criterionResults'),
  );
  if (conclusion === 'confirm' && criterionResults.length === 0) {
    throw new Error('结论为 confirm 时必须提供非空的 criterion_results');
  }

  const reason = pick(input, 'reason');
  if (conclusion === 'reject' && !reason) {
    throw new Error('结论为 reject 时必须提供 reason，说明未满足的条件或缺少的证据');
  }

  const task = getTask(db, submission.task_id);
  if (!task) throw new Error(`任务不存在：${submission.task_id}`);

  // 自审自动判定：评审者即提交者时为真，不依赖调用方传入。
  const selfReview = reviewerId === submission.submitted_by ? 1 : 0;

  db.exec('BEGIN');
  try {
    const now = pick(input, 'reviewed_at', 'reviewedAt') ?? nowIso();
    db.prepare(INSERT_REVIEW).run(
      reviewId,
      submissionId,
      reviewerId,
      conclusion,
      encodeJson(criterionResults),
      reason ?? null,
      selfReview,
      now,
      pick(input, 'created_at', 'createdAt') ?? now,
    );

    const reviewEvent = {
      project_id: task.project_id,
      object_type: 'review',
      object_id: reviewId,
      actor: reviewerId,
      occurred_at: now,
      refs: [submissionId, task.task_id],
    };

    if (conclusion === 'confirm') {
      db.prepare(`UPDATE tasks SET status = 'accepted' WHERE task_id = ?`).run(task.task_id);
      const confirmedEvent = appendEvent(db, { ...reviewEvent, event_type: 'review.confirmed', reason: reason ?? null });
      enqueueFromEvent(db, confirmedEvent);
    } else if (conclusion === 'reject') {
      db.prepare(`UPDATE tasks SET status = 'rework' WHERE task_id = ?`).run(task.task_id);

      const claim = activeOwnerClaim(db, task.task_id);
      if (claim) {
        db.prepare(
          `UPDATE claims SET status = 'released', released_at = ? WHERE claim_id = ?`,
        ).run(now, claim.claim_id);
        appendEvent(db, {
          project_id: task.project_id,
          object_type: 'task',
          object_id: task.task_id,
          event_type: 'task.released',
          actor: reviewerId,
          occurred_at: now,
          reason: reason ?? '评审打回，释放认领',
          refs: [task.task_id],
        });
      }

      const rejectedEvent = appendEvent(db, { ...reviewEvent, event_type: 'review.rejected', reason: reason ?? null });
      enqueueFromEvent(db, rejectedEvent);
    } else {
      // needs_info：任务保持 submitted，等待补充信息后重新评审。
      appendEvent(db, {
        ...reviewEvent,
        event_type: 'review.needs_info',
        reason: reason ?? null,
      });
    }

    const review = getReview(db, reviewId);
    db.exec('COMMIT');
    return review;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** 按 ID 查询评审；不存在返回 null。 */
export function getReview(db, reviewId) {
  return parseReview(
    db.prepare('SELECT * FROM reviews WHERE review_id = ?').get(reviewId),
  );
}

/** 列出某次提交的全部评审（历史保留，按评审时间升序）。 */
export function listReviews(db, submissionId) {
  if (!getSubmission(db, submissionId)) throw new Error(`提交不存在：${submissionId}`);
  const rows = db
    .prepare(
      `SELECT * FROM reviews WHERE submission_id = ?
       ORDER BY reviewed_at ASC, review_id ASC`,
    )
    .all(submissionId);
  return rows.map(parseReview);
}
