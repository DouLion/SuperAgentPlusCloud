// 状态与类型的中文文案映射。状态标签同时带文字，不只靠颜色。

export const STATUS_MAPS = {
  project: {
    active: '进行中',
    paused: '已暂停',
    archived: '已归档',
  },
  trunk: {
    proposed: '建议（未生效）',
    active: '生效中',
    superseded: '已被替代',
    retired: '已退役',
  },
  requirement: {
    submitted: '已提交',
    needs_info: '待补充信息',
    assessed: '已评估',
    accepted: '已接受',
    rejected: '已拒绝',
    cancelled: '已取消',
  },
  task: {
    draft: '草稿',
    open: '可认领',
    claimed: '已认领',
    submitted: '待评审',
    rework: '已打回',
    accepted: '已通过',
    closed: '已关闭',
    cancelled: '已取消',
  },
  change: {
    proposed: '已提出',
    confirmed: '已确认',
    in_effect: '生效中',
    closed: '已关闭',
  },
  impactAssessment: {
    to_check: '待检查',
    affected: '有影响',
    not_affected: '确认无影响',
  },
  impactResolution: {
    continue: '继续',
    adjust: '调整',
    revalidate: '重新验证',
    obsolete: '作废',
    pending: '待处置',
  },
  claim: {
    active: '生效中',
    released: '已释放',
    completed: '已完成',
    expired: '已过期',
  },
  review: {
    confirm: '通过',
    reject: '打回',
    needs_info: '待补充',
  },
  decision: {
    accepted: '已接受',
    relevelled: '已改级',
    needs_info: '待补充信息',
    rejected: '已拒绝',
    deferred: '已延后',
  },
  action: {
    accept: '接受',
    relevel: '改级',
    ask: '追问',
    reject: '拒绝',
    investigate: '调查',
  },
  assessor: {
    AI: 'AI',
    human: '人工',
    rule: '规则',
  },
  kind: {
    assessment: '评估建议',
    task_plan: '任务草稿',
    impact: '影响候选',
  },
  objectType: {
    project: '项目',
    trunk_item: '主干条目',
    requirement: '需求',
    assessment: '评估',
    decision: '决定',
    task: '任务',
    submission: '提交',
    review: '评审',
    trunk_change: '主干变更',
    impact_item: '影响项',
  },
};

/** Element Plus 标签颜色的默认映射。 */
export const STATUS_TYPES = {
  project: { active: 'success', paused: 'warning', archived: 'info' },
  trunk: { proposed: 'warning', active: 'success', superseded: 'info', retired: 'info' },
  requirement: {
    submitted: 'primary',
    needs_info: 'warning',
    assessed: 'info',
    accepted: 'success',
    rejected: 'danger',
    cancelled: 'info',
  },
  task: {
    draft: 'info',
    open: 'primary',
    claimed: 'warning',
    submitted: 'warning',
    rework: 'danger',
    accepted: 'success',
    closed: 'info',
    cancelled: 'info',
  },
  change: {
    proposed: 'warning',
    confirmed: 'primary',
    in_effect: 'success',
    closed: 'info',
  },
  impactAssessment: { to_check: 'warning', affected: 'danger', not_affected: 'success' },
  impactResolution: {
    continue: 'success',
    adjust: 'warning',
    revalidate: 'primary',
    obsolete: 'info',
    pending: 'info',
  },
  claim: { active: 'success', released: 'info', completed: 'success', expired: 'info' },
  review: { confirm: 'success', reject: 'danger', needs_info: 'warning' },
  decision: {
    accepted: 'success',
    relevelled: 'warning',
    needs_info: 'warning',
    rejected: 'danger',
    deferred: 'info',
  },
  action: { accept: 'success', relevel: 'warning', ask: 'primary', reject: 'danger', investigate: 'primary' },
  assessor: { AI: 'warning', human: 'success', rule: 'info' },
  kind: { assessment: 'warning', task_plan: 'primary', impact: 'danger' },
  objectType: {},
};

/** 取中文文案；未知值原样返回。 */
export function statusText(group, value) {
  if (value === undefined || value === null || value === '') return '—';
  const map = STATUS_MAPS[group];
  if (map && map[value]) return map[value];
  return String(value);
}

/** 取标签颜色；未知值用 info。 */
export function statusType(group, value) {
  const map = STATUS_TYPES[group];
  if (map && map[value]) return map[value];
  return 'info';
}

/** 通用枚举（表单下拉用）。 */
export const OPTIONS = {
  levels: ['L0', 'L1', 'L2', 'L3', 'L4'],
  assessmentLevels: ['L0', 'L1', 'L2', 'L3', 'L4', 'undecided'],
  proposedActions: ['accept', 'relevel', 'ask', 'reject', 'investigate'],
  conclusions: ['accepted', 'relevelled', 'needs_info', 'rejected', 'deferred'],
  assessorTypes: ['human', 'rule', 'AI'],
  requirementStatuses: ['submitted', 'needs_info', 'assessed', 'accepted', 'rejected', 'cancelled'],
  taskStatuses: ['draft', 'open', 'claimed', 'submitted', 'rework', 'accepted', 'closed', 'cancelled'],
  trunkStatuses: ['proposed', 'active', 'superseded', 'retired'],
  trunkKinds: [
    'goal',
    'scope',
    'capability',
    'business_rule',
    'interface',
    'data_contract',
    'architecture_decision',
    'other',
  ],
  changeStatuses: ['proposed', 'confirmed', 'in_effect', 'closed'],
  impactTargetTypes: ['task', 'submission', 'document', 'test', 'other'],
  impactAssessmentStatuses: ['to_check', 'affected', 'not_affected'],
  impactResolutions: ['continue', 'adjust', 'revalidate', 'obsolete', 'pending'],
  reviewConclusions: ['confirm', 'reject', 'needs_info'],
  projectStatuses: ['active', 'paused', 'archived'],
};

export const TRUNK_KIND_TEXT = {
  goal: '目标',
  scope: '范围',
  capability: '能力',
  business_rule: '业务规则',
  interface: '接口',
  data_contract: '数据契约',
  architecture_decision: '架构决策',
  other: '其他',
};

export function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function shortId(value) {
  if (!value) return '—';
  return String(value);
}

/** 把关系项格式化为可读文本（与 client/src/format.mjs 口径一致）。 */
export function formatRelation(relation) {
  if (typeof relation === 'string') return relation;
  if (relation && typeof relation === 'object') {
    const type = relation.type ? `${relation.type} ` : '';
    const itemId = relation.item_id ?? relation.itemId ?? '';
    return `${type}${itemId}`.trim();
  }
  return String(relation);
}
