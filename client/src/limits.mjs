// 客户端共享常量：与 Center 状态机保持一致。

/** 影响等级 L0..L4。 */
export const LEVELS = ['L0', 'L1', 'L2', 'L3', 'L4'];

/** 评估建议动作。 */
export const PROPOSED_ACTIONS = ['accept', 'relevel', 'ask', 'reject', 'investigate'];

/** 决定结论。 */
export const CONCLUSIONS = ['accepted', 'relevelled', 'needs_info', 'rejected', 'deferred'];

/** 需求状态。 */
export const REQUIREMENT_STATUSES = [
  'submitted',
  'needs_info',
  'assessed',
  'accepted',
  'rejected',
  'cancelled',
];

/** 任务状态：draft → open → claimed → submitted → accepted → closed。 */
export const TASK_STATUSES = [
  'draft',
  'open',
  'claimed',
  'submitted',
  'rework',
  'accepted',
  'closed',
  'cancelled',
];

/** 认领状态。 */
export const CLAIM_STATUSES = ['active', 'released', 'completed', 'expired'];

/** 评审结论。 */
export const REVIEW_CONCLUSIONS = ['confirm', 'reject', 'needs_info'];
