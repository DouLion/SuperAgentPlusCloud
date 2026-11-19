// Center HTTP 路由：AI 建议（T8/T14）。
// 所有 AI 调用先生成建议；T14 编排须具名人工采纳后才创建 draft Artifact 与 open Tasks。

import { aiConfigured, llmConfig } from '../../config.mjs';
import { getRequirement } from '../../db/requirements.mjs';
import { getTrunkChange } from '../../db/changes.mjs';
import { listAiSuggestions } from '../../db/ai.mjs';
import {
  proposeTasks,
  suggestAssessment,
  suggestImpacts,
} from '../../ai/advisor.mjs';
import {
  adoptContractOrchestration,
  suggestContractOrchestration,
} from '../../ai/contract-orchestration.mjs';

/** 构造 404 响应。 */
function notFound(label, id) {
  return { status: 404, body: { ok: false, error: `${label}不存在：${id}` } };
}

export const ROUTES = [
  {
    method: 'GET',
    pattern: '/ai/health',
    handler: () => {
      const { base_url: baseUrl, model } = llmConfig();
      return { configured: aiConfigured(), model, base_url: baseUrl };
    },
  },
  {
    method: 'POST',
    pattern: '/requirements/:id/advice',
    handler: async ({ params, db }) => {
      if (!getRequirement(db, params.id)) return notFound('需求', params.id);
      return { status: 201, body: await suggestAssessment(db, params.id) };
    },
  },
  {
    method: 'POST',
    pattern: '/requirements/:id/plan',
    handler: async ({ params, db }) => {
      if (!getRequirement(db, params.id)) return notFound('需求', params.id);
      return { status: 201, body: await proposeTasks(db, params.id) };
    },
  },
  {
    method: 'POST',
    pattern: '/trunk-changes/:id/advice',
    handler: async ({ params, db }) => {
      if (!getTrunkChange(db, params.id)) return notFound('主干变更', params.id);
      return { status: 201, body: await suggestImpacts(db, params.id) };
    },
  },
  {
    method: 'POST',
    pattern: '/requirements/:id/orchestrate',
    handler: async ({ params, body, db }) => {
      if (!getRequirement(db, params.id)) return notFound('需求', params.id);
      return { status: 201, body: await suggestContractOrchestration(db, params.id, body) };
    },
  },
  {
    method: 'POST',
    pattern: '/ai/suggestions/:id/adopt-orchestration',
    handler: ({ params, body, db }) => ({
      status: 201,
      body: adoptContractOrchestration(db, params.id, body),
    }),
  },
  {
    method: 'GET',
    pattern: '/ai/suggestions',
    handler: ({ url, db }) => {
      const query = {};
      for (const key of ['project_id', 'requirement_id', 'change_id', 'kind']) {
        const value = url.searchParams.get(key);
        if (value) query[key] = value;
      }
      return listAiSuggestions(db, query);
    },
  },
];
