// Center AI 建议（T8）：评估建议、任务拆解草稿、影响候选。
// 三个函数都是只读业务数据 + 写 ai_suggestions，不改变需求/任务/影响项等业务状态。

import {
  ASSESSMENT_LEVELS,
  IMPACT_TARGET_TYPES,
  PROPOSED_ACTIONS,
} from '../db/enums.mjs';
import { codedError, notFound } from '../db/json.mjs';
import { getRequirement } from '../db/requirements.mjs';
import { getTrunkChange } from '../db/changes.mjs';
import { getTrunkItem, listTrunkItems } from '../db/trunk.mjs';
import { listTasks } from '../db/tasks.mjs';
import { listSubmissions } from '../db/submissions.mjs';
import { createAiSuggestion } from '../db/ai.mjs';
import { llmConfig } from '../config.mjs';
import { chatWithRaw } from './provider.mjs';
import {
  assessmentPrompt,
  impactPrompt,
  taskPlanPrompt,
} from './prompts.mjs';

/** 在途任务状态：open/claimed/submitted/rework。 */
const IN_FLIGHT_TASK_STATUSES = ['open', 'claimed', 'submitted', 'rework'];

/** 构造 AI_BAD_RESPONSE（502）。 */
function badResponse(message) {
  return codedError('AI_BAD_RESPONSE', message, 502);
}

/**
 * 调用模型；解析失败（AI_BAD_RESPONSE）时把原始响应留档到 ai_suggestions，
 * 便于人工核对，然后继续抛错。只写建议记录，不改变业务状态。
 */
async function chatForSuggestion(prompt, archiveFailure) {
  try {
    return await chatWithRaw(prompt);
  } catch (error) {
    if (error && error.code === 'AI_BAD_RESPONSE' && typeof error.raw === 'string') {
      archiveFailure(error.raw, error.message);
    }
    throw error;
  }
}

/** 过滤出非空字符串数组。 */
function stringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());
}

/** 校验并规范化评估建议。 */
function normalizeAssessment(data, activeItemIds) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw badResponse('评估建议响应必须是 JSON 对象');
  }

  const assessedLevel = data.assessed_level ?? data.assessedLevel;
  if (!ASSESSMENT_LEVELS.includes(assessedLevel)) {
    throw badResponse('评估建议缺少合法的 assessed_level（L0..L4 或 undecided）');
  }

  let proposedAction = data.proposed_action ?? data.proposedAction;
  if (proposedAction === undefined || proposedAction === null || proposedAction === '') {
    proposedAction = 'ask';
  }
  if (!PROPOSED_ACTIONS.includes(proposedAction)) {
    throw badResponse(`评估建议的 proposed_action 非法：${proposedAction}`);
  }

  const relatedRaw = data.related_item_ids ?? data.relatedItemIds ?? [];
  if (!Array.isArray(relatedRaw)) {
    throw badResponse('评估建议的 related_item_ids 必须是数组');
  }
  const relatedItemIds = relatedRaw.filter((id) => activeItemIds.includes(id));
  if (assessedLevel !== 'undecided' && relatedItemIds.length === 0) {
    throw badResponse('评估建议必须引用给出的主干条目 id，或改用 assessed_level=undecided');
  }

  const impactSummary = data.impact_summary ?? data.impactSummary;
  return {
    assessed_level: assessedLevel,
    related_item_ids: relatedItemIds,
    impact_summary: typeof impactSummary === 'string' ? impactSummary.trim() : '',
    uncertainties: stringArray(data.uncertainties),
    proposed_action: proposedAction,
  };
}

/** 校验并规范化任务草稿。 */
function normalizeTaskPlan(data, activeItemIds) {
  const tasks = Array.isArray(data) ? data : (data && Array.isArray(data.tasks) ? data.tasks : null);
  if (!tasks || tasks.length === 0) {
    throw badResponse('任务草稿响应必须是包含任务的 JSON 数组');
  }

  return tasks.map((item, index) => {
    const position = `第 ${index + 1} 条任务`;
    if (!item || typeof item !== 'object') {
      throw badResponse(`${position}必须是对象`);
    }

    const purpose = item.purpose;
    if (typeof purpose !== 'string' || purpose.trim() === '') {
      throw badResponse(`${position}缺少非空的 purpose`);
    }

    const doneWhen = item.done_when ?? item.doneWhen;
    if (
      !Array.isArray(doneWhen)
      || doneWhen.length === 0
      || doneWhen.some((entry) => typeof entry !== 'string' || entry.trim() === '')
    ) {
      throw badResponse(`${position}的 done_when 必须是非空的可检验条件数组`);
    }

    const servesRaw = item.serves_item_ids ?? item.servesItemIds ?? [];
    if (!Array.isArray(servesRaw)) {
      throw badResponse(`${position}的 serves_item_ids 必须是数组`);
    }
    const servesItemIds = servesRaw.filter((id) => activeItemIds.includes(id));

    const relatedQuestion = item.related_question ?? item.relatedQuestion;
    const isExploration = typeof relatedQuestion === 'string' && relatedQuestion.trim() !== '';
    if (servesItemIds.length === 0 && !isExploration) {
      throw badResponse(`${position}必须关联给出的主干条目，或标注为探索任务（related_question）`);
    }

    const scope = item.scope;
    const nonScope = item.non_scope ?? item.nonScope;
    return {
      purpose: purpose.trim(),
      done_when: doneWhen.map((entry) => entry.trim()),
      scope: typeof scope === 'string' ? scope.trim() : '',
      non_scope: typeof nonScope === 'string' ? nonScope.trim() : '',
      serves_item_ids: servesItemIds,
      ...(isExploration ? { related_question: relatedQuestion.trim() } : {}),
    };
  });
}

/** 校验并规范化影响候选。 */
function normalizeImpacts(data) {
  const list = Array.isArray(data)
    ? data
    : (data && (Array.isArray(data.candidates) || Array.isArray(data.impacts))
      ? (data.candidates ?? data.impacts)
      : null);
  if (!list) {
    throw badResponse('影响候选响应必须是 JSON 数组');
  }

  const seen = new Set();
  return list.map((item, index) => {
    const position = `第 ${index + 1} 个影响候选`;
    if (!item || typeof item !== 'object') {
      throw badResponse(`${position}必须是对象`);
    }

    const targetType = item.target_type ?? item.targetType;
    if (!IMPACT_TARGET_TYPES.includes(targetType)) {
      throw badResponse(`${position}的 target_type 非法：${targetType}`);
    }

    const targetId = item.target_id ?? item.targetId;
    if (typeof targetId !== 'string' || targetId.trim() === '') {
      throw badResponse(`${position}缺少非空的 target_id`);
    }

    const key = `${targetType}:${targetId.trim()}`;
    if (seen.has(key)) return null;
    seen.add(key);

    const reason = item.reason;
    return {
      target_type: targetType,
      target_id: targetId.trim(),
      reason: typeof reason === 'string' ? reason.trim() : '',
    };
  }).filter(Boolean);
}

/**
 * 生成评估建议并落库。
 * @returns {Promise<{ suggestion: object, draft: object }>}
 */
export async function suggestAssessment(db, requirementId) {
  const requirement = getRequirement(db, requirementId);
  if (!requirement) throw notFound(`需求不存在：${requirementId}`);

  const activeItems = listTrunkItems(db, {
    project_id: requirement.project_id,
    status: 'active',
  });
  const activeItemIds = activeItems.map((item) => item.item_id);
  const prompt = assessmentPrompt(requirement, activeItems);
  const { data, raw } = await chatForSuggestion(prompt, (rawText, message) => {
    createAiSuggestion(db, {
      project_id: requirement.project_id,
      requirement_id: requirementId,
      kind: 'assessment',
      payload: { error: message },
      raw_response: rawText,
      model: llmConfig().model,
    });
  });

  const draft = normalizeAssessment(data, activeItemIds);
  const suggestion = createAiSuggestion(db, {
    project_id: requirement.project_id,
    requirement_id: requirementId,
    kind: 'assessment',
    payload: draft,
    raw_response: raw,
    model: llmConfig().model,
  });
  return { suggestion, draft };
}

/**
 * 生成任务拆解草稿并落库。
 * @returns {Promise<{ suggestion: object, draft: object[] }>}
 */
export async function proposeTasks(db, requirementId) {
  const requirement = getRequirement(db, requirementId);
  if (!requirement) throw notFound(`需求不存在：${requirementId}`);

  const activeItems = listTrunkItems(db, {
    project_id: requirement.project_id,
    status: 'active',
  });
  const activeItemIds = activeItems.map((item) => item.item_id);
  const prompt = taskPlanPrompt(requirement, activeItems);
  const { data, raw } = await chatForSuggestion(prompt, (rawText, message) => {
    createAiSuggestion(db, {
      project_id: requirement.project_id,
      requirement_id: requirementId,
      kind: 'task_plan',
      payload: { error: message },
      raw_response: rawText,
      model: llmConfig().model,
    });
  });

  const draft = normalizeTaskPlan(data, activeItemIds);
  const suggestion = createAiSuggestion(db, {
    project_id: requirement.project_id,
    requirement_id: requirementId,
    kind: 'task_plan',
    payload: draft,
    raw_response: raw,
    model: llmConfig().model,
  });
  return { suggestion, draft };
}

/**
 * 生成影响候选并落库；只给候选，不写 impact_items。
 * @returns {Promise<{ suggestion: object, draft: object[] }>}
 */
export async function suggestImpacts(db, changeId) {
  const change = getTrunkChange(db, changeId);
  if (!change) throw notFound(`主干变更不存在：${changeId}`);

  const oldItems = change.old_item_ids
    .map((itemId) => getTrunkItem(db, itemId))
    .filter(Boolean);

  const tasks = listTasks(db, { project_id: change.project_id })
    .filter((task) => IN_FLIGHT_TASK_STATUSES.includes(task.status));
  const submissions = tasks.flatMap((task) => listSubmissions(db, { task_id: task.task_id }));

  const prompt = impactPrompt(change, oldItems, tasks, submissions);
  const { data, raw } = await chatForSuggestion(prompt, (rawText, message) => {
    createAiSuggestion(db, {
      project_id: change.project_id,
      change_id: changeId,
      kind: 'impact',
      payload: { error: message },
      raw_response: rawText,
      model: llmConfig().model,
    });
  });

  const draft = normalizeImpacts(data);
  const suggestion = createAiSuggestion(db, {
    project_id: change.project_id,
    change_id: changeId,
    kind: 'impact',
    payload: draft,
    raw_response: raw,
    model: llmConfig().model,
  });
  return { suggestion, draft };
}

/** 供测试与调用方确认当前在途任务状态口径。 */
export { IN_FLIGHT_TASK_STATUSES };
