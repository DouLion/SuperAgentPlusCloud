// 材料提取（C 枝）：把会议纪要/设计文档变成「需求 / 约定 / 决定」草稿。
// 只在 material_extractions 里写 draft；不创建正式对象，不做无出处的推断。

import { createExtraction } from '../db/materials.mjs';
import { listConventionPacks } from '../db/conventions.mjs';
import { listTrunkItems } from '../db/trunk.mjs';
import { codedError, required } from '../db/json.mjs';
import { llmConfig } from '../config.mjs';
import { chatWithRaw } from './provider.mjs';

function bad(message) {
  return codedError('AI_BAD_RESPONSE', message, 502);
}

function strings(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
    : [];
}

function buildPrompt(material, trunk, conventions) {
  return {
    system: [
      '你是 SuperAgentPlus 的材料整理助手，只把材料整理成未生效草稿。',
      '只输出 JSON：requirements[], conventions[], decisions[], uncertainties[]。',
      'requirements 项：raw_text（材料里的原话或贴近原话的需求表述）、claimed_level（L0–L4，可省略）、claimed_reason（可省略）、source_quote（材料原文片段，必填）。',
      'conventions 项：name、description（可省略）、rules[]（每项 key/title/severity(must|should|preference)/value/rationale）、source_quote（必填）。',
      'decisions 项：question、options[]（可省略）、chosen（可省略）、rationale（可省略）、source_quote（必填）。',
      '每条都必须带 source_quote，且必须是材料中真实出现的句子片段；没有出处就不要输出这一条。',
      '不要编造材料里没有的内容；不确定的放进 uncertainties。',
      '不得创建需求、约定或决定，只输出 JSON。',
    ].join('\n'),
    user: JSON.stringify({
      material: { title: material.title, kind: material.kind, content: material.content },
      active_trunk: trunk.map(({ item_id, kind, statement }) => ({ item_id, kind, statement })),
      active_conventions: conventions.flatMap((pack) => pack.rules || []),
    }, null, 2),
  };
}

/** 校验单条草稿；source_quote 必填，避免无出处推断。 */
function requireQuote(item, label, index) {
  const quote = typeof item?.source_quote === 'string' ? item.source_quote.trim() : '';
  if (!quote) throw bad(`${label} 第 ${index + 1} 条缺少 source_quote（不允许无出处的推断）`);
  return quote;
}

function normalizeRequirements(list) {
  if (!Array.isArray(list)) throw bad('requirements 必须是数组');
  return list.map((item, index) => {
    const rawText = typeof item?.raw_text === 'string' ? item.raw_text.trim() : '';
    if (!rawText) throw bad(`requirements 第 ${index + 1} 条缺少 raw_text`);
    return {
      raw_text: rawText,
      claimed_level: typeof item.claimed_level === 'string' ? item.claimed_level.trim() : null,
      claimed_reason: typeof item.claimed_reason === 'string' ? item.claimed_reason.trim() : null,
      source_quote: requireQuote(item, 'requirements', index),
    };
  });
}

function normalizeConventions(list) {
  if (!Array.isArray(list)) throw bad('conventions 必须是数组');
  return list.map((item, index) => {
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    if (!name) throw bad(`conventions 第 ${index + 1} 条缺少 name`);
    if (!Array.isArray(item.rules) || item.rules.length === 0) {
      throw bad(`conventions 第 ${index + 1} 条缺少 rules`);
    }
    const rules = item.rules.map((rule, ruleIndex) => {
      const key = typeof rule?.key === 'string' ? rule.key.trim() : '';
      const title = typeof rule?.title === 'string' ? rule.title.trim() : '';
      if (!key || !title) throw bad(`conventions 第 ${index + 1} 条的规则 ${ruleIndex + 1} 缺少 key/title`);
      const severity = ['must', 'should', 'preference'].includes(rule.severity) ? rule.severity : 'should';
      return {
        key,
        title,
        severity,
        value: rule.value ?? null,
        rationale: typeof rule.rationale === 'string' ? rule.rationale : '',
      };
    });
    return {
      name,
      description: typeof item.description === 'string' ? item.description : '',
      rules,
      source_quote: requireQuote(item, 'conventions', index),
    };
  });
}

function normalizeDecisions(list) {
  if (!Array.isArray(list)) throw bad('decisions 必须是数组');
  return list.map((item, index) => {
    const question = typeof item?.question === 'string' ? item.question.trim() : '';
    if (!question) throw bad(`decisions 第 ${index + 1} 条缺少 question`);
    return {
      question,
      options: strings(item.options),
      chosen: typeof item.chosen === 'string' ? item.chosen : null,
      rationale: typeof item.rationale === 'string' ? item.rationale : null,
      source_quote: requireQuote(item, 'decisions', index),
    };
  });
}

/**
 * 从材料提取草稿。
 * @param {object} db
 * @param {object} material 材料行
 * @param {object} [options] { kinds?: ('requirement'|'convention'|'decision')[], created_by }
 * @returns {Promise<{extractions: object[], uncertainties: string[], model: string}>}
 */
export async function extractFromMaterial(db, material, options = {}) {
  const createdBy = required(options, 'created_by', 'createdBy');
  const wanted = Array.isArray(options.kinds) && options.kinds.length
    ? options.kinds
    : ['requirement', 'convention', 'decision'];

  const trunk = listTrunkItems(db, { project_id: material.project_id, status: 'active' });
  const conventions = listConventionPacks(db, { project_id: material.project_id, status: 'active' });
  const { system, user } = buildPrompt(material, trunk, conventions);

  const { data, raw } = await chatWithRaw({ system, user });
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw bad('提取响应必须是 JSON 对象');
  }

  const buckets = {
    requirement: normalizeRequirements(data.requirements ?? []),
    convention: normalizeConventions(data.conventions ?? []),
    decision: normalizeDecisions(data.decisions ?? []),
  };

  const model = llmConfig().model;
  const extractions = [];
  for (const kind of wanted) {
    for (const payload of buckets[kind] ?? []) {
      extractions.push(createExtraction(db, {
        material_id: material.material_id,
        kind,
        payload,
        raw_response: raw,
        model,
        created_by: createdBy,
      }));
    }
  }

  return {
    extractions,
    uncertainties: strings(data.uncertainties),
    model,
  };
}
