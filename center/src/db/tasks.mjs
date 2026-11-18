// Center 任务与认领存储（T7 归置）。

import { appendEvent } from './events.mjs';
import { TASK_STATUSES } from './enums.mjs';
import { assertProjectExists } from './projects.mjs';
import { getRequirement } from './requirements.mjs';
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

const INSERT_TASK = `INSERT INTO tasks (
  task_id, project_id, requirement_id, serves_item_ids, related_question_id,
  purpose, scope, non_scope, done_when, acceptance_evidence, blocked_by,
  status, created_by, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function parseTask(row) {
  if (!row) return null;
  return {
    ...row,
    serves_item_ids: decodeJson(row.serves_item_ids, []),
    done_when: decodeJson(row.done_when, []),
    acceptance_evidence: decodeJson(row.acceptance_evidence, []),
    blocked_by: decodeJson(row.blocked_by, []),
  };
}

/**
 * 新建任务。必填 project_id、purpose、done_when（非空数组）；
 * requirement_id / serves_item_ids / related_question_id / scope / non_scope /
 * acceptance_evidence / blocked_by / created_by 均可空。默认 status=draft。
 * @returns {object} 已解析 JSON 字段的完整任务行
 */
export function createTask(db, input = {}) {
  const taskId = pick(input, 'task_id', 'taskId') ?? newId('task');
  const projectId = required(input, 'project_id', 'projectId');
  const purpose = required(input, 'purpose');
  const doneWhen = pick(input, 'done_when', 'doneWhen');

  if (!Array.isArray(doneWhen) || doneWhen.length === 0) {
    throw new Error('缺少必填字段：done_when（必须是非空数组）');
  }
  if (doneWhen.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new Error('done_when 的每一项都必须是非空字符串');
  }

  const status = pick(input, 'status') ?? 'draft';
  if (!TASK_STATUSES.includes(status)) {
    throw new Error(`非法的任务状态：${status}`);
  }

  // 草稿阶段允许信息不足；一旦直接创建为可认领或更后状态，必须已能指回主干，
  // 否则会绕过 openTask 的关联校验。
  if (status !== 'draft') {
    const serves = pick(input, 'serves_item_ids', 'servesItemIds');
    const question = pick(input, 'related_question_id', 'relatedQuestionId');
    const linked = (Array.isArray(serves) && serves.length > 0) || (question !== undefined && question !== null && question !== '');
    if (!linked) {
      throw codedError(
        'TASK_NOT_LINKED',
        '任务进入可认领状态前，必须关联主干条目（serves_item_ids）或明确待决问题（related_question_id）',
        400,
      );
    }
  }

  assertProjectExists(db, projectId);

  const requirementId = pick(input, 'requirement_id', 'requirementId');
  if (requirementId !== undefined && requirementId !== null && !getRequirement(db, requirementId)) {
    throw new Error(`需求不存在：${requirementId}`);
  }

  const now = pick(input, 'created_at', 'createdAt') ?? nowIso();
  const createdBy = pick(input, 'created_by', 'createdBy');

  db.prepare(INSERT_TASK).run(
    taskId,
    projectId,
    requirementId,
    jsonField(input, 'serves_item_ids'),
    pick(input, 'related_question_id', 'relatedQuestionId'),
    purpose,
    pick(input, 'scope'),
    pick(input, 'non_scope', 'nonScope'),
    encodeJson(doneWhen),
    jsonField(input, 'acceptance_evidence'),
    jsonField(input, 'blocked_by'),
    status,
    createdBy,
    now,
  );

  appendEvent(db, {
    project_id: projectId,
    object_type: 'task',
    object_id: taskId,
    event_type: 'task.created',
    actor: createdBy,
    occurred_at: now,
    reason: purpose,
    refs: requirementId ? [requirementId] : [],
  });

  return getTask(db, taskId);
}

/** 按 ID 查询任务；不存在返回 null。 */
export function getTask(db, taskId) {
  return parseTask(db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId));
}

/** 列出任务，可按 project_id / status / requirement_id 过滤，按创建时间升序。 */
export function listTasks(db, query = {}) {
  const clauses = [];
  const params = [];

  const projectId = pick(query, 'project_id', 'projectId');
  if (projectId) {
    clauses.push('project_id = ?');
    params.push(projectId);
  }
  const status = pick(query, 'status');
  if (status) {
    if (!TASK_STATUSES.includes(status)) {
      throw new Error(`非法的任务状态：${status}`);
    }
    clauses.push('status = ?');
    params.push(status);
  }
  const requirementId = pick(query, 'requirement_id', 'requirementId');
  if (requirementId) {
    clauses.push('requirement_id = ?');
    params.push(requirementId);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT * FROM tasks ${where} ORDER BY created_at ASC, task_id ASC`,
    )
    .all(...params);
  return rows.map(parseTask);
}

/**
 * 开放任务：draft → open，使其可被认领。
 * 进入可认领状态前必须能指回主干：serves_item_ids 非空，或明确 related_question_id
 * （探索任务允许以待决问题为主）；两者都缺时抛 code=TASK_NOT_LINKED（400）。
 * 创建阶段（createTask）不强制，允许草稿阶段信息不足。
 * @param {object} [patch] 可附带 actor / reason 用于事件
 * @returns {object|null} 更新后的完整任务行
 */
export function openTask(db, taskId, patch = {}) {
  const existing = getTask(db, taskId);
  if (!existing) throw new Error(`任务不存在：${taskId}`);
  if (existing.status !== 'draft') {
    throw new Error(`任务当前状态不可开放：${existing.status}`);
  }

  const servesItemIds = Array.isArray(existing.serves_item_ids) ? existing.serves_item_ids : [];
  const hasQuestion = existing.related_question_id !== null
    && existing.related_question_id !== undefined
    && String(existing.related_question_id).trim() !== '';
  if (servesItemIds.length === 0 && !hasQuestion) {
    throw codedError(
      'TASK_NOT_LINKED',
      '任务进入可认领状态前，必须关联主干条目（serves_item_ids）或明确待决问题（related_question_id）',
      400,
    );
  }

  const now = nowIso();
  db.prepare(`UPDATE tasks SET status = 'open' WHERE task_id = ?`).run(taskId);

  appendEvent(db, {
    project_id: existing.project_id,
    object_type: 'task',
    object_id: taskId,
    event_type: 'task.updated',
    actor: pick(patch, 'actor', 'created_by', 'createdBy'),
    occurred_at: now,
    reason: pick(patch, 'reason') ?? '任务进入可认领状态',
    refs: [taskId],
  });

  return getTask(db, taskId);
}

// -------------------------------------------------------------------- 认领

const INSERT_CLAIM = `INSERT INTO claims (
  claim_id, task_id, worker_id, claimed_at, released_at, status, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?)`;

/** 按 ID 查询认领；不存在返回 null。 */
export function getClaim(db, claimId) {
  return db.prepare('SELECT * FROM claims WHERE claim_id = ?').get(claimId) ?? null;
}

/**
 * 原子认领任务：任务当前为 open 或 rework 时成功（打回后可直接重新认领）。
 * 采用条件 UPDATE 判断影响行数，再插入 claim，全程单事务；
 * 已被认领或状态不符时抛 code=TASK_NOT_CLAIMABLE 的冲突错误。
 * @returns {{ task: object, claim: object }}
 */
export function claimTask(db, taskId, workerId) {
  if (workerId === undefined || workerId === null || workerId === '') {
    throw new Error('缺少必填字段：worker_id');
  }

  const task = getTask(db, taskId);
  if (!task) throw new Error(`任务不存在：${taskId}`);

  let claimId;
  db.exec('BEGIN');
  try {
    const result = db
      .prepare(
        `UPDATE tasks SET status = 'claimed'
         WHERE task_id = ? AND status IN ('open', 'rework')`,
      )
      .run(taskId);

    if (result.changes === 0) {
      throw Object.assign(new Error('任务已被认领或不可认领'), {
        code: 'TASK_NOT_CLAIMABLE',
        status: 409,
      });
    }

    const now = nowIso();
    claimId = newId('clm');
    db.prepare(INSERT_CLAIM).run(claimId, taskId, workerId, now, null, 'active', now);

    appendEvent(db, {
      project_id: task.project_id,
      object_type: 'task',
      object_id: taskId,
      event_type: 'task.claimed',
      actor: workerId,
      occurred_at: now,
      reason: '工作者认领任务',
      refs: [taskId],
    });

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { task: getTask(db, taskId), claim: getClaim(db, claimId) };
}

/**
 * 释放任务：仅 active 认领的 worker 本人可释放。
 * claim 置 released、任务回 open，写事件 task.released。
 * @returns {{ task: object, claim: object }}
 */
export function releaseTask(db, taskId, workerId) {
  if (workerId === undefined || workerId === null || workerId === '') {
    throw new Error('缺少必填字段：worker_id');
  }

  const task = getTask(db, taskId);
  if (!task) throw new Error(`任务不存在：${taskId}`);

  let claimId;
  db.exec('BEGIN');
  try {
    const claim = db
      .prepare(
        `SELECT * FROM claims WHERE task_id = ? AND status = 'active'
         ORDER BY claimed_at ASC, claim_id ASC LIMIT 1`,
      )
      .get(taskId);

    if (!claim) {
      throw Object.assign(new Error('任务当前没有可释放的活跃认领'), {
        code: 'CLAIM_NOT_RELEASABLE',
        status: 409,
      });
    }
    if (claim.worker_id !== workerId) {
      throw Object.assign(new Error('只有认领者本人可以释放该任务'), {
        code: 'CLAIM_NOT_RELEASABLE',
        status: 409,
      });
    }

    const now = nowIso();
    db.prepare(
      `UPDATE claims SET status = 'released', released_at = ? WHERE claim_id = ?`,
    ).run(now, claim.claim_id);
    db.prepare(`UPDATE tasks SET status = 'open' WHERE task_id = ?`).run(taskId);

    appendEvent(db, {
      project_id: task.project_id,
      object_type: 'task',
      object_id: taskId,
      event_type: 'task.released',
      actor: workerId,
      occurred_at: now,
      reason: '认领者释放任务',
      refs: [taskId],
    });

    claimId = claim.claim_id;
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { task: getTask(db, taskId), claim: getClaim(db, claimId) };
}

/** 列出某任务的全部认领（历史保留，按认领时间升序）。 */
export function listClaims(db, taskId) {
  if (!getTask(db, taskId)) throw new Error(`任务不存在：${taskId}`);
  return db
    .prepare(
      `SELECT * FROM claims WHERE task_id = ?
       ORDER BY claimed_at ASC, claim_id ASC`,
    )
    .all(taskId);
}
