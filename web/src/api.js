// 前端统一 HTTP 封装：BASE 只表示 origin（VITE_CENTER_URL），接口统一加 /sap-cloud/api 前缀。
// 非 2xx 抛出带服务端 error/code 的错误；网络失败抛「结果待核对，请重试」。

const BASE = (import.meta.env.VITE_CENTER_URL || '').replace(/\/+$/, '');
const API_PREFIX = '/sap-cloud/api';

/** 把查询对象编码为 querystring；空值忽略。 */
function queryString(query) {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

/** 发起一次 JSON 请求。 */
async function request(method, path, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(`${BASE}${API_PREFIX}${path}`, init);
  } catch (err) {
    const error = new Error(`无法连接 Center，结果待核对，请重试（${err.message}）`);
    error.code = 'NETWORK_ERROR';
    throw error;
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
    const error = new Error(message);
    error.status = response.status;
    if (data && typeof data.code === 'string') error.code = data.code;
    throw error;
  }
  return data;
}

/** Center 接口封装；与 client/src/api.mjs 保持同一语义。 */
export const api = {
  healthz: () => request('GET', '/healthz'),

  // 设置向导与配置（T10）
  setupStatus: () => request('GET', '/setup/status'),
  initSetup: (input) => request('POST', '/setup/init', input),
  updateSetup: (input) => request('POST', '/setup', input),

  listProjects: (query) => request('GET', `/projects${queryString(query)}`),
  createProject: (input) => request('POST', '/projects', input),
  getProject: (id) => request('GET', `/projects/${encodeURIComponent(id)}`),

  listTrunkItems: (query) => request('GET', `/trunk-items${queryString(query)}`),
  createTrunkItem: (input) => request('POST', '/trunk-items', input),
  getTrunkItem: (id) => request('GET', `/trunk-items/${encodeURIComponent(id)}`),
  confirmTrunkItem: (id, input) =>
    request('POST', `/trunk-items/${encodeURIComponent(id)}/confirm`, input),
  retireTrunkItem: (id, input) =>
    request('POST', `/trunk-items/${encodeURIComponent(id)}/retire`, input),

  listRequirements: (query) => request('GET', `/requirements${queryString(query)}`),
  createRequirement: (input) => request('POST', '/requirements', input),
  getRequirement: (id) => request('GET', `/requirements/${encodeURIComponent(id)}`),
  listAssessments: (id) =>
    request('GET', `/requirements/${encodeURIComponent(id)}/assessments`),
  createAssessment: (id, input) =>
    request('POST', `/requirements/${encodeURIComponent(id)}/assessments`, input),
  listDecisions: (id) =>
    request('GET', `/requirements/${encodeURIComponent(id)}/decisions`),
  createDecision: (id, input) =>
    request('POST', `/requirements/${encodeURIComponent(id)}/decision`, input),
  getRequirementTimeline: (id) =>
    request('GET', `/requirements/${encodeURIComponent(id)}/timeline`),
  createRequirementTasks: (id, input) =>
    request('POST', `/requirements/${encodeURIComponent(id)}/tasks`, input),

  listTasks: (query) => request('GET', `/tasks${queryString(query)}`),
  createTask: (input) => request('POST', '/tasks', input),
  getTask: (id) => request('GET', `/tasks/${encodeURIComponent(id)}`),
  claimTask: (id, input) => request('POST', `/tasks/${encodeURIComponent(id)}/claim`, input),
  releaseTask: (id, input) =>
    request('POST', `/tasks/${encodeURIComponent(id)}/release`, input),
  listClaims: (id) => request('GET', `/tasks/${encodeURIComponent(id)}/claims`),
  heartbeatClaim: (claimId, input) =>
    request('POST', `/claims/${encodeURIComponent(claimId)}/heartbeat`, input),
  releaseClaim: (claimId, input) =>
    request('POST', `/claims/${encodeURIComponent(claimId)}/release`, input),
  getTaskContext: (id) => request('GET', `/tasks/${encodeURIComponent(id)}/context`),
  listTaskCandidates: (id) => request('GET', `/tasks/${encodeURIComponent(id)}/candidates`),

  // 身份与能力（P1/P4）
  listActors: (query) => request('GET', `/actors${queryString(query)}`),
  createActor: (input) => request('POST', '/actors', input),
  getActor: (id) => request('GET', `/actors/${encodeURIComponent(id)}`),
  disableActor: (id, input) => request('POST', `/actors/${encodeURIComponent(id)}/disable`, input),
  issueCredential: (id, input) =>
    request('POST', `/actors/${encodeURIComponent(id)}/credentials`, input),
  revokeCredential: (id, input) =>
    request('DELETE', `/credentials/${encodeURIComponent(id)}`, input),
  listDelegations: (query) => request('GET', `/delegations${queryString(query)}`),
  createDelegation: (input) => request('POST', '/delegations', input),
  revokeDelegation: (id, input) =>
    request('POST', `/delegations/${encodeURIComponent(id)}/revoke`, input),
  listCapabilities: (id) => request('GET', `/actors/${encodeURIComponent(id)}/capabilities`),
  setCapability: (id, input) =>
    request('PUT', `/actors/${encodeURIComponent(id)}/capabilities`, input),

  // 观测（P5）
  observabilityActors: () => request('GET', '/observability/actors'),
  observabilityStuck: (query) => request('GET', `/observability/stuck${queryString(query)}`),
  observabilityStats: (query) => request('GET', `/observability/stats${queryString(query)}`),
  listSubmissions: (taskId) =>
    request('GET', `/tasks/${encodeURIComponent(taskId)}/submissions`),
  createSubmission: (taskId, input) =>
    request('POST', `/tasks/${encodeURIComponent(taskId)}/submissions`, input),
  getSubmission: (id) => request('GET', `/submissions/${encodeURIComponent(id)}`),
  listReviews: (id) => request('GET', `/submissions/${encodeURIComponent(id)}/reviews`),
  createReview: (id, input) =>
    request('POST', `/submissions/${encodeURIComponent(id)}/review`, input),

  listTrunkChanges: (query) => request('GET', `/trunk-changes${queryString(query)}`),
  createTrunkChange: (input) => request('POST', '/trunk-changes', input),
  getTrunkChange: (id) => request('GET', `/trunk-changes/${encodeURIComponent(id)}`),
  confirmTrunkChange: (id, input) =>
    request('POST', `/trunk-changes/${encodeURIComponent(id)}/confirm`, input),
  activateTrunkChange: (id, input) =>
    request('POST', `/trunk-changes/${encodeURIComponent(id)}/activate`, input),
  closeTrunkChange: (id) =>
    request('POST', `/trunk-changes/${encodeURIComponent(id)}/close`),
  addImpactItem: (changeId, input) =>
    request('POST', `/trunk-changes/${encodeURIComponent(changeId)}/impacts`, input),
  listImpactItems: (changeId) =>
    request('GET', `/trunk-changes/${encodeURIComponent(changeId)}/impacts`),
  updateImpactItem: (impactId, patch) =>
    request('PATCH', `/impact-items/${encodeURIComponent(impactId)}`, patch),

  listEvents: (query) => request('GET', `/events${queryString(query)}`),

  getAiHealth: () => request('GET', '/ai/health'),
  adviseRequirement: (id) => request('POST', `/requirements/${encodeURIComponent(id)}/advice`, {}),
  planRequirement: (id) => request('POST', `/requirements/${encodeURIComponent(id)}/plan`, {}),
  adviseTrunkChange: (id) =>
    request('POST', `/trunk-changes/${encodeURIComponent(id)}/advice`, {}),
  listAiSuggestions: (query) => request('GET', `/ai/suggestions${queryString(query)}`),

  // 约定包（T12）
  listConventionPacks: (query) => request('GET', `/convention-packs${queryString(query)}`),
  createConventionPack: (input) => request('POST', '/convention-packs', input),
  getConventionPack: (id) => request('GET', `/convention-packs/${encodeURIComponent(id)}`),
  activateConventionPack: (id, input) =>
    request('POST', `/convention-packs/${encodeURIComponent(id)}/activate`, input),
  retireConventionPack: (id, input) =>
    request('POST', `/convention-packs/${encodeURIComponent(id)}/retire`, input),
  importConventionPack: (id, input) =>
    request('POST', `/convention-packs/${encodeURIComponent(id)}/import`, input),

  // 编排模板（T12）
  listWorkflowTemplates: (query) => request('GET', `/workflow-templates${queryString(query)}`),
  createWorkflowTemplate: (input) => request('POST', '/workflow-templates', input),
  getWorkflowTemplate: (id) => request('GET', `/workflow-templates/${encodeURIComponent(id)}`),
  activateWorkflowTemplate: (id, input) =>
    request('POST', `/workflow-templates/${encodeURIComponent(id)}/activate`, input),
  retireWorkflowTemplate: (id, input) =>
    request('POST', `/workflow-templates/${encodeURIComponent(id)}/retire`, input),
  seedWorkflowTemplates: (input) => request('POST', '/workflow-templates/seed', input),

  // 制品与契约（T13）
  listArtifacts: (query) => request('GET', `/artifacts${queryString(query)}`),
  createArtifact: (input) => request('POST', '/artifacts', input),
  getArtifact: (id) => request('GET', `/artifacts/${encodeURIComponent(id)}`),
  validateArtifact: (id) => request('GET', `/artifacts/${encodeURIComponent(id)}/validate`),
  publishArtifact: (id, input) =>
    request('POST', `/artifacts/${encodeURIComponent(id)}/publish`, input),
  retireArtifact: (id, input) =>
    request('POST', `/artifacts/${encodeURIComponent(id)}/retire`, input),
  artifactDocumentUrl: (id) => `${BASE}${API_PREFIX}/artifacts/${encodeURIComponent(id)}/document`,

  // 契约优先编排（T14）
  orchestrateRequirement: (id, input = {}) =>
    request('POST', `/requirements/${encodeURIComponent(id)}/orchestrate`, input),
  adoptOrchestration: (suggestionId, input) =>
    request('POST', `/ai/suggestions/${encodeURIComponent(suggestionId)}/adopt-orchestration`, input),
};

/** 统一错误文案：网络错误与 AI 未配置给出可操作提示，其余透出服务端中文错误。 */
export function errorMessage(err, fallback = '操作失败') {
  if (!err) return fallback;
  if (err.code === 'NETWORK_ERROR') return err.message;
  if (err.code === 'AI_NOT_CONFIGURED') return 'Center 未配置模型：请设置 SAP_LLM_BASE_URL 与 SAP_LLM_API_KEY';
  return err.message || fallback;
}
