// Center 状态与类型枚举（T7 归置）。
// 全部枚举集中于此，供数据访问层与 HTTP 层共用。

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

export const TRUNK_ITEM_STATUSES = ['proposed', 'active', 'superseded', 'retired'];

export const PROJECT_STATUSES = ['active', 'paused', 'archived'];

export const REQUIREMENT_STATUSES = [
  'submitted',
  'needs_info',
  'assessed',
  'accepted',
  'rejected',
  'cancelled',
];

/** 影响等级；undecided 表示评估未完成定级。 */
export const LEVELS = ['L0', 'L1', 'L2', 'L3', 'L4'];
export const ASSESSMENT_LEVELS = [...LEVELS, 'undecided'];

export const PROPOSED_ACTIONS = ['accept', 'relevel', 'ask', 'reject', 'investigate'];

export const ASSESSOR_TYPES = ['AI', 'human', 'rule'];

export const DECISION_CONCLUSIONS = [
  'accepted',
  'relevelled',
  'needs_info',
  'rejected',
  'deferred',
];

/** 任务状态机：draft → open → claimed → submitted → accepted → closed；rework 为打回分支。 */
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

/** 认领状态：active 为当前持有；released/completed/expired 保留历史。 */
export const CLAIM_STATUSES = ['active', 'released', 'completed', 'expired'];

/** 评审结论：confirm 通过、reject 打回、needs_info 待补充信息。 */
export const REVIEW_CONCLUSIONS = ['confirm', 'reject', 'needs_info'];

/** 决定结论 → 需求状态。 */
export const DECISION_STATUS_MAP = {
  accepted: 'accepted',
  relevelled: 'accepted',
  needs_info: 'needs_info',
  rejected: 'rejected',
  deferred: 'needs_info',
};

/** 主干变更状态机：proposed → confirmed → in_effect → closed。 */
export const TRUNK_CHANGE_STATUSES = ['proposed', 'confirmed', 'in_effect', 'closed'];

/** 影响对象类型。 */
export const IMPACT_TARGET_TYPES = ['task', 'submission', 'document', 'test', 'other'];

/** 影响评估状态；to_check（待检查）与 not_affected（确认无影响）必须区分。 */
export const IMPACT_ASSESSMENT_STATUSES = ['to_check', 'affected', 'not_affected'];

/** 影响处置方式；pending 表示尚未处置。 */
export const IMPACT_RESOLUTIONS = ['continue', 'adjust', 'revalidate', 'obsolete', 'pending'];

/** AI 建议类型：评估建议 / 任务拆解草稿 / 影响候选。 */
export const AI_SUGGESTION_KINDS = ['assessment', 'task_plan', 'impact', 'contract_orchestration'];

/** 约定包 / 编排模板共用版本状态。 */
export const VERSIONED_DEFINITION_STATUSES = ['draft', 'active', 'superseded', 'retired'];
export const CONVENTION_PACK_SCOPES = ['team', 'project'];
export const CONVENTION_RULE_SEVERITIES = ['must', 'should', 'preference'];

/** 项目制品（T13）：API 契约是文档与 Mock 的唯一事实源。 */
export const ARTIFACT_TYPES = [
  'api_contract',
  'api_document',
  'mock_definition',
  'document',
  'schema',
  'test_report',
];
export const ARTIFACT_STATUSES = ['draft', 'published', 'superseded', 'retired'];
