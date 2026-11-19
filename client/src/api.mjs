// Center HTTP 客户端（T2）：客户端唯一发出请求的地方。
// 零第三方依赖，使用 Node 26 内置 fetch；非 2xx 抛错并携带服务端 error 文本。

import crypto from 'node:crypto';
import { DEFAULT_CENTER_URL } from './help.mjs';

/** 接口统一前缀（见 docs/08 §1）；CENTER_URL 只表示 origin。 */
export const API_PREFIX = '/sap-cloud/api';

/** 当前协议版本；与 Center 的 SUPPORTED_PROTOCOL_VERSIONS 对齐。 */
export const PROTOCOL_VERSION = 1;

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** 解析 Center 地址；CENTER_URL 可覆盖，默认 http://127.0.0.1:8787。 */
export function resolveCenterUrl(env = process.env) {
  const raw = env.CENTER_URL || DEFAULT_CENTER_URL;
  return raw.replace(/\/+$/, '');
}

/** 把查询对象编码为 URLSearchParams；空值忽略。 */
function queryString(query) {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

/**
 * 发起一次 JSON 请求。
 * @param {string} method
 * @param {string} path
 * @param {object} [body]
 * @param {object} [options] { url, env, fetchImpl }
 * @returns {Promise<any>} 解析后的 JSON
 */
export async function apiRequest(method, path, body, options = {}) {
  const base = options.url || resolveCenterUrl(options.env);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const env = options.env || process.env;

  const init = { method, headers: {} };
  // token 优先级：显式 options.token > 环境变量 SAP_TOKEN。缺失时不发送该头（兼容 legacy 模式）。
  const token = options.token ?? env.SAP_TOKEN ?? '';
  if (token) init.headers.authorization = `Bearer ${token}`;

  // 协议版本与幂等键：写操作默认生成 command_id，便于超时后查询而不是盲目重试。
  const methodUpper = String(method).toUpperCase();
  init.headers['x-sap-protocol-version'] = String(options.protocolVersion ?? PROTOCOL_VERSION);
  if (WRITE_METHODS.has(methodUpper)) {
    const explicit = options.commandId ?? env.SAP_COMMAND_ID
      ?? body?.command_id ?? body?.commandId;
    init.headers['x-sap-command-id'] = explicit || crypto.randomUUID();
  }

  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetchImpl(`${base}${API_PREFIX}${path}`, init);
  } catch (err) {
    throw new Error(`无法连接 Center（${base}）：${err.message}`);
  }

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const message = data && data.error ? data.error : `HTTP ${response.status}`;
    const error = new Error(`Center 返回错误（${response.status}）：${message}`);
    // 保留服务端 code（如 CHANGE_IMPACT_UNRESOLVED / INVALID_TRANSITION）供命令层识别。
    if (data && typeof data.code === 'string') error.code = data.code;
    error.status = response.status;
    throw error;
  }
  return data;
}

/** Center 接口封装；所有方法返回 Promise。 */
export const api = {
  healthz: (options) => apiRequest('GET', '/healthz', undefined, options),

  listProjects: (query, options) =>
    apiRequest('GET', `/projects${queryString(query)}`, undefined, options),
  createProject: (input, options) => apiRequest('POST', '/projects', input, options),

  listTrunkItems: (query, options) =>
    apiRequest('GET', `/trunk-items${queryString(query)}`, undefined, options),
  createTrunkItem: (input, options) => apiRequest('POST', '/trunk-items', input, options),
  getTrunkItem: (itemId, options) =>
    apiRequest('GET', `/trunk-items/${encodeURIComponent(itemId)}`, undefined, options),
  confirmTrunkItem: (itemId, input, options) =>
    apiRequest('POST', `/trunk-items/${encodeURIComponent(itemId)}/confirm`, input, options),
  retireTrunkItem: (itemId, input, options) =>
    apiRequest('POST', `/trunk-items/${encodeURIComponent(itemId)}/retire`, input, options),

  listRequirements: (query, options) =>
    apiRequest('GET', `/requirements${queryString(query)}`, undefined, options),
  getRequirement: (requirementId, options) =>
    apiRequest('GET', `/requirements/${encodeURIComponent(requirementId)}`, undefined, options),
  createRequirement: (input, options) => apiRequest('POST', '/requirements', input, options),

  listAssessments: (requirementId, options) =>
    apiRequest(
      'GET',
      `/requirements/${encodeURIComponent(requirementId)}/assessments`,
      undefined,
      options,
    ),
  createAssessment: (requirementId, input, options) =>
    apiRequest(
      'POST',
      `/requirements/${encodeURIComponent(requirementId)}/assessments`,
      input,
      options,
    ),

  listDecisions: (requirementId, options) =>
    apiRequest(
      'GET',
      `/requirements/${encodeURIComponent(requirementId)}/decisions`,
      undefined,
      options,
    ),
  createDecision: (requirementId, input, options) =>
    apiRequest(
      'POST',
      `/requirements/${encodeURIComponent(requirementId)}/decision`,
      input,
      options,
    ),

  getTimeline: (requirementId, options) =>
    apiRequest(
      'GET',
      `/requirements/${encodeURIComponent(requirementId)}/timeline`,
      undefined,
      options,
    ),

  listTasks: (query, options) =>
    apiRequest('GET', `/tasks${queryString(query)}`, undefined, options),
  getTask: (taskId, options) =>
    apiRequest('GET', `/tasks/${encodeURIComponent(taskId)}`, undefined, options),
  createTask: (input, options) => apiRequest('POST', '/tasks', input, options),
  createRequirementTasks: (requirementId, input, options) =>
    apiRequest(
      'POST',
      `/requirements/${encodeURIComponent(requirementId)}/tasks`,
      input,
      options,
    ),

  claimTask: (taskId, input, options) =>
    apiRequest('POST', `/tasks/${encodeURIComponent(taskId)}/claim`, input, options),
  joinTask: (taskId, input, options) =>
    apiRequest('POST', `/tasks/${encodeURIComponent(taskId)}/join`, input, options),
  releaseTask: (taskId, input, options) =>
    apiRequest('POST', `/tasks/${encodeURIComponent(taskId)}/release`, input, options),
  heartbeatClaim: (claimId, input, options) =>
    apiRequest('POST', `/claims/${encodeURIComponent(claimId)}/heartbeat`, input, options),
  releaseClaim: (claimId, input, options) =>
    apiRequest('POST', `/claims/${encodeURIComponent(claimId)}/release`, input, options),
  sweepLeases: (input, options) => apiRequest('POST', '/leases/sweep', input ?? {}, options),
  listClaims: (taskId, options) =>
    apiRequest('GET', `/tasks/${encodeURIComponent(taskId)}/claims`, undefined, options),

  listSubmissions: (taskId, options) =>
    apiRequest(
      'GET',
      `/tasks/${encodeURIComponent(taskId)}/submissions`,
      undefined,
      options,
    ),
  getSubmission: (submissionId, options) =>
    apiRequest(
      'GET',
      `/submissions/${encodeURIComponent(submissionId)}`,
      undefined,
      options,
    ),
  createSubmission: (taskId, input, options) =>
    apiRequest(
      'POST',
      `/tasks/${encodeURIComponent(taskId)}/submissions`,
      input,
      options,
    ),
  listReviews: (submissionId, options) =>
    apiRequest(
      'GET',
      `/submissions/${encodeURIComponent(submissionId)}/reviews`,
      undefined,
      options,
    ),
  createReview: (submissionId, input, options) =>
    apiRequest(
      'POST',
      `/submissions/${encodeURIComponent(submissionId)}/review`,
      input,
      options,
    ),

  listTrunkChanges: (query, options) =>
    apiRequest('GET', `/trunk-changes${queryString(query)}`, undefined, options),
  getTrunkChange: (changeId, options) =>
    apiRequest(
      'GET',
      `/trunk-changes/${encodeURIComponent(changeId)}`,
      undefined,
      options,
    ),
  createTrunkChange: (input, options) => apiRequest('POST', '/trunk-changes', input, options),
  confirmTrunkChange: (changeId, input, options) =>
    apiRequest(
      'POST',
      `/trunk-changes/${encodeURIComponent(changeId)}/confirm`,
      input,
      options,
    ),
  activateTrunkChange: (changeId, input, options) =>
    apiRequest(
      'POST',
      `/trunk-changes/${encodeURIComponent(changeId)}/activate`,
      input,
      options,
    ),
  closeTrunkChange: (changeId, options) =>
    apiRequest(
      'POST',
      `/trunk-changes/${encodeURIComponent(changeId)}/close`,
      undefined,
      options,
    ),
  addImpactItem: (changeId, input, options) =>
    apiRequest(
      'POST',
      `/trunk-changes/${encodeURIComponent(changeId)}/impacts`,
      input,
      options,
    ),
  listImpactItems: (changeId, options) =>
    apiRequest(
      'GET',
      `/trunk-changes/${encodeURIComponent(changeId)}/impacts`,
      undefined,
      options,
    ),
  updateImpactItem: (impactItemId, patch, options) =>
    apiRequest(
      'PATCH',
      `/impact-items/${encodeURIComponent(impactItemId)}`,
      patch,
      options,
    ),

  // AI 建议（T8）：只读/生成建议，不改变业务状态。
  getAiHealth: (options) => apiRequest('GET', '/ai/health', undefined, options),
  adviseRequirement: (requirementId, options) =>
    apiRequest(
      'POST',
      `/requirements/${encodeURIComponent(requirementId)}/advice`,
      {},
      options,
    ),
  planRequirement: (requirementId, options) =>
    apiRequest(
      'POST',
      `/requirements/${encodeURIComponent(requirementId)}/plan`,
      {},
      options,
    ),
  adviseTrunkChange: (changeId, options) =>
    apiRequest(
      'POST',
      `/trunk-changes/${encodeURIComponent(changeId)}/advice`,
      {},
      options,
    ),
  listAiSuggestions: (query, options) =>
    apiRequest('GET', `/ai/suggestions${queryString(query)}`, undefined, options),
  orchestrateRequirement: (requirementId, input = {}, options) =>
    apiRequest(
      'POST',
      `/requirements/${encodeURIComponent(requirementId)}/orchestrate`,
      input,
      options,
    ),
  adoptOrchestration: (suggestionId, input, options) =>
    apiRequest(
      'POST',
      `/ai/suggestions/${encodeURIComponent(suggestionId)}/adopt-orchestration`,
      input,
      options,
    ),

  // 身份与授权（P1）
  createActor: (input, options) => apiRequest('POST', '/actors', input, options),
  listActors: (query, options) =>
    apiRequest('GET', `/actors${queryString(query)}`, undefined, options),
  getActor: (id, options) => apiRequest('GET', `/actors/${encodeURIComponent(id)}`, undefined, options),
  disableActor: (id, input, options) =>
    apiRequest('POST', `/actors/${encodeURIComponent(id)}/disable`, input, options),
  issueCredential: (id, input, options) =>
    apiRequest('POST', `/actors/${encodeURIComponent(id)}/credentials`, input, options),
  revokeCredential: (id, options) =>
    apiRequest('DELETE', `/credentials/${encodeURIComponent(id)}`, undefined, options),
  createDelegation: (input, options) => apiRequest('POST', '/delegations', input, options),
  listDelegations: (query, options) =>
    apiRequest('GET', `/delegations${queryString(query)}`, undefined, options),
  revokeDelegation: (id, input, options) =>
    apiRequest('POST', `/delegations/${encodeURIComponent(id)}/revoke`, input, options),
  listMembers: (projectId, options) =>
    apiRequest('GET', `/projects/${encodeURIComponent(projectId)}/members`, undefined, options),
  addMember: (projectId, input, options) =>
    apiRequest('POST', `/projects/${encodeURIComponent(projectId)}/members`, input, options),

  listConventionPacks: (query, options) =>
    apiRequest('GET', `/convention-packs${queryString(query)}`, undefined, options),
  getConventionPack: (id, options) =>
    apiRequest('GET', `/convention-packs/${encodeURIComponent(id)}`, undefined, options),
  createConventionPack: (input, options) =>
    apiRequest('POST', '/convention-packs', input, options),
  activateConventionPack: (id, input, options) =>
    apiRequest('POST', `/convention-packs/${encodeURIComponent(id)}/activate`, input, options),
  retireConventionPack: (id, input, options) =>
    apiRequest('POST', `/convention-packs/${encodeURIComponent(id)}/retire`, input, options),
  importConventionPack: (id, input, options) =>
    apiRequest('POST', `/convention-packs/${encodeURIComponent(id)}/import`, input, options),

  listWorkflowTemplates: (query, options) =>
    apiRequest('GET', `/workflow-templates${queryString(query)}`, undefined, options),
  getWorkflowTemplate: (id, options) =>
    apiRequest('GET', `/workflow-templates/${encodeURIComponent(id)}`, undefined, options),
  createWorkflowTemplate: (input, options) =>
    apiRequest('POST', '/workflow-templates', input, options),
  activateWorkflowTemplate: (id, input, options) =>
    apiRequest('POST', `/workflow-templates/${encodeURIComponent(id)}/activate`, input, options),
  retireWorkflowTemplate: (id, input, options) =>
    apiRequest('POST', `/workflow-templates/${encodeURIComponent(id)}/retire`, input, options),
  seedWorkflowTemplates: (input = {}, options) =>
    apiRequest('POST', '/workflow-templates/seed', input, options),

  listArtifacts: (query, options) =>
    apiRequest('GET', `/artifacts${queryString(query)}`, undefined, options),
  getArtifact: (id, options) =>
    apiRequest('GET', `/artifacts/${encodeURIComponent(id)}`, undefined, options),
  createArtifact: (input, options) => apiRequest('POST', '/artifacts', input, options),
  validateArtifact: (id, options) =>
    apiRequest('GET', `/artifacts/${encodeURIComponent(id)}/validate`, undefined, options),
  publishArtifact: (id, input, options) =>
    apiRequest('POST', `/artifacts/${encodeURIComponent(id)}/publish`, input, options),
  retireArtifact: (id, input, options) =>
    apiRequest('POST', `/artifacts/${encodeURIComponent(id)}/retire`, input, options),

  // 协议层（P3）：未知结果查询与事件投递。
  getCommandResult: (id, options) =>
    apiRequest('GET', `/command-results/${encodeURIComponent(id)}`, undefined, options),
  listOutbox: (query, options) =>
    apiRequest('GET', `/outbox${queryString(query)}`, undefined, options),
  dispatchOutbox: (input = {}, options) => apiRequest('POST', '/outbox/dispatch', input, options),

  // 能力（P4）：只影响推荐，不产生授权。
  listCapabilities: (actorId, options) =>
    apiRequest('GET', `/actors/${encodeURIComponent(actorId)}/capabilities`, undefined, options),
  setCapability: (actorId, input, options) =>
    apiRequest('POST', `/actors/${encodeURIComponent(actorId)}/capabilities`, input, options),

  // 任务上下文与候选（P4）
  getTaskContext: (taskId, options) =>
    apiRequest('GET', `/tasks/${encodeURIComponent(taskId)}/context`, undefined, options),
  listTaskCandidates: (taskId, options) =>
    apiRequest('GET', `/tasks/${encodeURIComponent(taskId)}/candidates`, undefined, options),

  // 观测（P5）：只读，不改变业务状态。
  observabilityActors: (options) =>
    apiRequest('GET', '/observability/actors', undefined, options),
  observabilityStuck: (query, options) =>
    apiRequest('GET', `/observability/stuck${queryString(query)}`, undefined, options),
  observabilityStats: (query, options) =>
    apiRequest('GET', `/observability/stats${queryString(query)}`, undefined, options),

  // Agent 接入（P4）：拉取为主，claim/heartbeat/deliver/release。
  agentInbox: (query, options) =>
    apiRequest('GET', `/agent/inbox${queryString(query)}`, undefined, options),
  agentClaim: (input, options) => apiRequest('POST', '/agent/claim', input, options),
  agentHeartbeat: (input, options) => apiRequest('POST', '/agent/heartbeat', input, options),
  agentDeliver: (input, options) => apiRequest('POST', '/agent/deliver', input, options),
  agentRelease: (input, options) => apiRequest('POST', '/agent/release', input, options),
};
