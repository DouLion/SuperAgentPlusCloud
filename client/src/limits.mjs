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

/** 主干条目类型。 */
export const TRUNK_ITEM_KINDS = [
  'goal',
  'scope',
  'capability',
  'business_rule',
  'interface',
  'data_contract',
  'architecture_decision',
  'other',
];

/** 主干条目状态：proposed / active / superseded / retired。 */
export const TRUNK_ITEM_STATUSES = ['proposed', 'active', 'superseded', 'retired'];

/** 主干变更状态：proposed → confirmed → in_effect → closed。 */
export const CHANGE_STATUSES = ['proposed', 'confirmed', 'in_effect', 'closed'];

/** 影响对象类型。 */
export const IMPACT_TARGET_TYPES = ['task', 'submission', 'document', 'test', 'other'];

/** 影响评估状态：to_check（待检查）与 not_affected（确认无影响）必须区分。 */
export const IMPACT_ASSESSMENT_STATUSES = ['to_check', 'affected', 'not_affected'];

/** 影响处置方式。 */
export const IMPACT_RESOLUTIONS = ['continue', 'adjust', 'revalidate', 'obsolete', 'pending'];
