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
