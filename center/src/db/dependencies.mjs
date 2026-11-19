// 任务依赖判定（P4）：blocked_by 中的任务全部可交付后，任务才可被认领。
// 供 inbox 列表与 claim 校验复用，避免两处各写一套。

import { getTask } from './tasks.mjs';

/** 视为「已满足」的前置状态：验收通过或已关闭。 */
export const SATISFIED_STATUSES = ['accepted', 'closed'];

/**
 * 计算任务的依赖状态。
 * @param {object} db
 * @param {object} task 已解析 blocked_by 的任务行
 * @returns {{ready: boolean, pending: Array<{task_id: string, status: string}>, missing: string[]}}
 */
export function dependencyStatus(db, task) {
  const blockedBy = Array.isArray(task?.blocked_by) ? task.blocked_by : [];
  const pending = [];
  const missing = [];

  for (const dependencyId of blockedBy) {
    const dependency = getTask(db, dependencyId);
    if (!dependency) {
      // 依赖指向不存在的任务：视为未满足，交给人工修正，不静默放行。
      missing.push(dependencyId);
      continue;
    }
    if (!SATISFIED_STATUSES.includes(dependency.status)) {
      pending.push({ task_id: dependencyId, status: dependency.status });
    }
  }

  return { ready: pending.length === 0 && missing.length === 0, pending, missing };
}

/** 任务是否可立即认领（依赖角度）。 */
export function isReady(db, task) {
  return dependencyStatus(db, task).ready;
}
