// Center AI 提示词（T8）。
// 只负责组装提示词，不发起请求、不写库；所有提示词都要求模型输出 JSON，
// 并明确「信息不足不得猜测」「只能引用给出的条目 id」。

/** 把主干条目格式化为可读文本。 */
function formatItems(items) {
  if (items.length === 0) return '（当前项目没有 active 主干条目）';
  return items
    .map((item) => `- ${item.item_id} [${item.kind}] ${item.statement}`
      + `${item.rationale ? `\n  理由：${item.rationale}` : ''}`)
    .join('\n');
}

/** 把在途任务格式化为可读文本。 */
function formatTasks(tasks) {
  if (tasks.length === 0) return '（当前项目没有 open/claimed/submitted/rework 状态的任务）';
  return tasks
    .map((task) => `- ${task.task_id} [${task.status}] ${task.purpose}`
      + `\n  完成条件：${(task.done_when || []).join('；')}`)
    .join('\n');
}

/** 把提交格式化为可读文本。 */
function formatSubmissions(submissions) {
  if (submissions.length === 0) return '（没有在途任务相关的提交）';
  return submissions
    .map((submission) => `- ${submission.submission_id}（任务 ${submission.task_id}）`
      + `${submission.summary ? `\n  摘要：${submission.summary}` : ''}`)
    .join('\n');
}

/** 评估建议提示词。 */
export function assessmentPrompt(requirement, activeItems) {
  return {
    system: [
      '你是 SuperAgentPlus Center 的评估助手，负责对需求做初步影响评估并给出建议。',
      '严格要求：',
      '1. 只依据【需求原文】与【当前有效主干条目】判断，不得编造未给出的条目或事实。',
      '2. 信息不足时必须返回 assessed_level="undecided"、proposed_action="ask"，禁止猜测补全。',
      '3. related_item_ids 只能填写【当前有效主干条目】中给出的 item_id；确实无关时返回空数组。',
      '4. 只输出一个 JSON 对象，不要输出解释文字。',
      '输出字段：assessed_level（L0/L1/L2/L3/L4 或 undecided）、related_item_ids（数组）、'
      + 'impact_summary（字符串）、uncertainties（字符串数组）、'
      + 'proposed_action（accept/relevel/ask/reject/investigate）。',
    ].join('\n'),
    user: [
      '【需求原文】',
      requirement.raw_text,
      '',
      `提交者自报等级：${requirement.claimed_level ?? '（未填）'}`,
      '',
      '【当前有效主干条目】',
      formatItems(activeItems),
      '',
      '请按系统要求输出评估建议 JSON。',
    ].join('\n'),
  };
}

/** 任务拆解草稿提示词。 */
export function taskPlanPrompt(requirement, activeItems) {
  return {
    system: [
      '你是 SuperAgentPlus Center 的任务拆解助手，负责把需求拆成可执行、可检验的任务草稿。',
      '严格要求：',
      '1. 只依据【需求原文】与【当前有效主干条目】拆解，不得编造主干条目。',
      '2. 每条任务的 done_when 必须是非空、可检验的完成条件，避免「完成某功能」这类不可验证表述。',
      '3. serves_item_ids 只能填写【当前有效主干条目】中给出的 item_id。',
      '4. 每条任务要么关联至少一个给出的条目，要么作为探索任务并填写非空 related_question；二者都没有的任务不允许出现。',
      '5. 只输出一个 JSON 数组，不要输出解释文字。',
      '数组元素字段：purpose（非空字符串）、done_when（非空字符串数组）、scope（字符串）、'
      + 'non_scope（字符串）、serves_item_ids（数组）、related_question（探索任务时填写）。',
    ].join('\n'),
    user: [
      '【需求原文】',
      requirement.raw_text,
      '',
      `提交者自报等级：${requirement.claimed_level ?? '（未填）'}`,
      '',
      '【当前有效主干条目】',
      formatItems(activeItems),
      '',
      '请按系统要求输出任务草稿 JSON 数组。',
    ].join('\n'),
  };
}

/** 影响候选提示词。 */
export function impactPrompt(change, oldItems, tasks, submissions) {
  return {
    system: [
      '你是 SuperAgentPlus Center 的影响分析助手，负责为主干变更列出可能受影响对象的候选清单。',
      '严格要求：',
      '1. 只依据【变更旧条目】【在途任务】【在途提交】判断，不得编造对象。',
      '2. 只给出候选，不要下结论说某个对象一定受影响或一定不受影响。',
      '3. target_type 只能是 task/submission/document/test/other；target_id 必须是非空字符串。',
      '4. 只输出一个 JSON 数组，不要输出解释文字；没有候选时输出 []。',
      '数组元素字段：target_type、target_id、reason（说明为什么可能是候选）。',
    ].join('\n'),
    user: [
      '【变更理由】',
      change.reason ?? '',
      '',
      '【变更旧条目】',
      formatItems(oldItems),
      '',
      '【在途任务（open/claimed/submitted/rework）】',
      formatTasks(tasks),
      '',
      '【在途提交】',
      formatSubmissions(submissions),
      '',
      '请按系统要求输出影响候选 JSON 数组。',
    ].join('\n'),
  };
}
