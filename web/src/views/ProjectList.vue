<script setup>
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api, errorMessage } from '../api.js';
import { formatTime } from '../status.js';
import StatusTag from '../components/StatusTag.vue';
import EmptyState from '../components/EmptyState.vue';
import { go } from '../nav.js';

const router = useRouter();

const projects = ref([]);
const rows = ref([]); // 项目 + 汇总指标
const loading = ref(false);
const dialogVisible = ref(false);
const submitting = ref(false);
const creatingDemo = ref(false);

const form = reactive({
  name: '',
  purpose: '',
  scope_summary: '',
  policy_ref: '',
  created_by: '',
});

const rules = {
  name: [{ required: true, message: '请填写项目名称', trigger: 'blur' }],
};

const EMPTY_STATS = {
  activeTrunk: 0,
  pendingRequirements: 0,
  activeTasks: 0,
  openChanges: 0,
  toCheckImpacts: 0,
  lastActivity: '',
};

/** 汇总单个项目：并行拉取，失败的项目保留项目本身，不拖垮列表。 */
async function summarize(project) {
  const stats = { ...EMPTY_STATS };
  try {
    const [trunkRows, requirementRows, taskRows, changeRows] = await Promise.all([
      api.listTrunkItems({ project_id: project.project_id }),
      api.listRequirements({ project_id: project.project_id }),
      api.listTasks({ project_id: project.project_id }),
      api.listTrunkChanges({ project_id: project.project_id }),
    ]);

    stats.activeTrunk = trunkRows.filter((item) => item.status === 'active').length;
    stats.pendingRequirements = requirementRows.filter((item) =>
      ['submitted', 'needs_info', 'assessed'].includes(item.status)).length;
    stats.activeTasks = taskRows.filter((item) =>
      ['open', 'claimed', 'submitted', 'rework'].includes(item.status)).length;
    const openChanges = changeRows.filter((item) => item.status !== 'closed');
    stats.openChanges = openChanges.length;

    const impacts = await Promise.all(
      openChanges.slice(0, 8).map((change) => api.listImpactItems(change.change_id).catch(() => [])),
    );
    stats.toCheckImpacts = impacts.flat().filter((item) => item.assessment_status === 'to_check').length;

    try {
      const events = await api.listEvents({ project_id: project.project_id, limit: 1 });
      stats.lastActivity = events[0]?.occurred_at || '';
    } catch {
      stats.lastActivity = '';
    }
  } catch {
    // 单个项目汇总失败时仍显示卡片，指标留空。
  }
  return stats;
}

async function load() {
  loading.value = true;
  try {
    projects.value = await api.listProjects();
    rows.value = projects.value.map((project) => ({
      project,
      stats: { ...EMPTY_STATS },
      firstAction: '进入项目查看主干',
    }));
    // 并行汇总，避免串行等待。
    await Promise.all(
      rows.value.map(async (row) => {
        row.stats = await summarize(row.project);
        row.firstAction = describeFirstAction(row.stats);
      }),
    );
  } catch (err) {
    ElMessage.error(errorMessage(err, '加载项目失败'));
  } finally {
    loading.value = false;
  }
}

function describeFirstAction(stats) {
  if (stats.toCheckImpacts > 0) return `有 ${stats.toCheckImpacts} 个影响项待检查`;
  if (stats.pendingRequirements > 0) return `有 ${stats.pendingRequirements} 条需求待判断`;
  if (stats.activeTasks > 0) return `有 ${stats.activeTasks} 个任务在推进`;
  if (stats.activeTrunk === 0) return '还没有生效的主干条目';
  return '主干清晰，可提交新需求';
}

function openCreate() {
  Object.assign(form, { name: '', purpose: '', scope_summary: '', policy_ref: '', created_by: '' });
  dialogVisible.value = true;
}

async function submitCreate() {
  submitting.value = true;
  try {
    const created = await api.createProject({ ...form });
    ElMessage.success(`项目已创建：${created.project_id}`);
    dialogVisible.value = false;
    await load();
    go(router, 'dashboard', { id: created.project_id });
  } catch (err) {
    ElMessage.error(errorMessage(err, '创建项目失败'));
  } finally {
    submitting.value = false;
  }
}

const DEMO_PROJECT_NAME = 'SuperAgentPlusCloud（演示）';

/** 演示项目里的约定规则，创建与展示共用一份定义。 */
const DEMO_RULES = [
  { key: 'api.methods.forbidden', category: 'api', title: '禁止 PUT/DELETE', severity: 'must', value: { methods: ['put', 'delete'] }, rationale: '网关与审计只支持查询/动作式 POST。' },
  { key: 'api.response', category: 'api', title: '统一响应包络', severity: 'must', value: { fields: ['status', 'message', 'data'] }, rationale: '前端统一按包络解析。' },
  { key: 'api.path.case', category: 'api', title: '路径 kebab-case', severity: 'must', value: { style: 'kebab-case' } },
  { key: 'api.field.case', category: 'api', title: '字段 camelCase', severity: 'should', value: { style: 'camelCase' } },
];

/** 演示契约正文：v2 额外多一个接口，用来说明「契约变了」会带来影响。 */
function demoContract(version, extraPath = false) {
  return {
    openapi: '3.1.0',
    info: { title: '演示订单 API', version },
    paths: {
      '/orders/query': {
        post: {
          operationId: 'queryOrders',
          summary: '按条件查询订单',
          responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/OrderListEnvelope' } } } } },
        },
      },
      ...(extraPath ? {
        '/orders/detail': {
          post: {
            operationId: 'orderDetail',
            summary: '查询订单详情',
            responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/OrderListEnvelope' } } } } },
          },
        },
      } : {}),
    },
    components: {
      schemas: {
        OrderListEnvelope: {
          type: 'object',
          required: ['status', 'message', 'data'],
          properties: {
            status: { type: 'integer', const: 1 },
            message: { type: 'string', example: 'ok' },
            data: { type: 'array', items: { $ref: '#/components/schemas/Order' } },
          },
        },
        Order: { type: 'object', properties: { orderId: { type: 'string', example: 'O-1' } } },
      },
    },
  };
}

const DEMO_MEETING = [
  '会议主题：订单导出与接口前缀调整',
  '一、背景',
  '运营反馈导出接口在数据量大时超时；前端点击导出按钮偶发无响应。',
  '二、结论',
  '1. 导出接口改为 POST /orders/query 的异步任务式调用，返回包络统一为 {status,message,data}。',
  '2. 页面与接口前缀统一到 /sap-cloud，旧路径保留 308 迁移提示。',
  '3. 前端与后端先对齐契约，再各自实现，最后联调；契约变更需登记影响。',
  '三、待确认',
  '1. 历史数据导出是否仍保留同步接口，需与运维确认。',
  '2. 导出任务失败的重试次数尚未确定。',
].join('\n');

/**
 * 补全一个已存在的演示项目：只创建缺失的部分，返回补了哪些内容。
 * 用于项目已经存在但缺少契约、材料或主体的场景。
 */
async function completeDemo(projectId) {
  const added = [];

  // 主干
  let items = await api.listTrunkItems({ project_id: projectId });
  if (!Array.isArray(items) || items.length === 0) {
    const seed = [
      { kind: 'goal', statement: '让当前有效主干、判断依据与影响处置可见可操作。' },
      { kind: 'scope', statement: '中心服务维护权威记录，客户端只与中心交互。' },
      { kind: 'capability', statement: 'AI 只产出建议，不产生已生效状态。' },
      { kind: 'interface', statement: '页面与接口统一使用 /sap-cloud/* 前缀。' },
      { kind: 'data_contract', statement: '一期默认 SQLite，后续可接 PostgreSQL。' },
    ];
    for (const one of seed) {
      const created = await api.createTrunkItem({ project_id: projectId, ...one, created_by: '演示' });
      await api.confirmTrunkItem(created.item_id, { confirmed_by: '演示' });
    }
    items = await api.listTrunkItems({ project_id: projectId });
    added.push('主干条目');
  }

  // 约定包
  const packs = await api.listConventionPacks({ project_id: projectId });
  if (!Array.isArray(packs) || packs.length === 0) {
    const pack = await api.createConventionPack({
      name: '演示：API 约定',
      description: '团队偏好示例，可按项目改写。',
      scope: 'project',
      project_id: projectId,
      created_by: '演示',
      rules: DEMO_RULES,
    });
    await api.activateConventionPack(pack.pack_id, { activated_by: '演示', reason: '演示项目启用 API 约定' });
    added.push('约定包');
  }

  // 编排模板
  const templates = await api.listWorkflowTemplates({ project_id: projectId });
  if (!Array.isArray(templates) || templates.length === 0) {
    await api.seedWorkflowTemplates({ project_id: projectId, created_by: '演示' });
    added.push('编排模板');
  }

  // 契约：没有就建 v1 并发布；只有一版就再发 v2，用来演示变更影响。
  let artifacts = await api.listArtifacts({ project_id: projectId });
  if (!Array.isArray(artifacts)) artifacts = [];
  let firstContract = artifacts.find((one) => one.type === 'api_contract');
  if (!firstContract) {
    firstContract = await api.createArtifact({
      project_id: projectId,
      type: 'api_contract',
      name: '演示订单 API',
      created_by: '演示',
      content: demoContract('1.0.0'),
    });
    await api.publishArtifact(firstContract.artifact_id, { published_by: '演示', reason: '演示契约首版' });
    added.push('契约 v1');
  }

  // 材料
  const materials = await api.listMaterials({ project_id: projectId });
  if (!Array.isArray(materials) || materials.length === 0) {
    await api.createMaterial({
      project_id: projectId,
      title: '演示会议纪要',
      kind: 'meeting',
      source_ref: 'demo://meeting/2026-11-19',
      created_by: '演示',
      content: DEMO_MEETING,
    });
    added.push('会议材料');
  }

  // 主体与成员
  const actors = await api.listActors();
  if (Array.isArray(actors) && actors.length === 0) {
    const owner = await api.createActor({ type: 'human', display_name: '演示负责人', created_by: '演示' });
    const reviewer = await api.createActor({ type: 'human', display_name: '演示评审者', created_by: '演示' });
    const agent = await api.createActor({
      type: 'agent',
      display_name: '演示 Agent',
      on_behalf_of: owner.actor_id,
      project_id: projectId,
      allowed_actions: ['claim', 'submit', 'report'],
      created_by: '演示',
    });
    await api.setCapability(agent.actor_id, { key: 'backend', level: 'expert' });
    await api.addMember(projectId, { actor_id: owner.actor_id, roles: ['owner', 'direction'], created_by: '演示' });
    await api.addMember(projectId, { actor_id: reviewer.actor_id, roles: ['reviewer', 'contributor'], created_by: '演示' });
    await api.addMember(projectId, { actor_id: agent.actor_id, roles: ['contributor'], created_by: '演示' });
    added.push('主体与成员');
  }

  // 需求与任务链
  let requirements = await api.listRequirements({ project_id: projectId });
  if (!Array.isArray(requirements) || requirements.length === 0) {
    const requirementSeed = [
      { raw_text: '把页面与接口迁移到 /sap-cloud/*，旧路径重定向。', claimed_level: 'L2' },
      { raw_text: '面板围绕主干、判断、执行与影响重构，而不是 CRUD 表格。', claimed_level: 'L2' },
      { raw_text: '未来支持 PostgreSQL，保持 SQLite 可用。', claimed_level: 'L1' },
    ];
    const activeItem = items.find((one) => one.kind === 'interface') || items[0];
    for (const one of requirementSeed) {
      const created = await api.createRequirement({ project_id: projectId, author: '演示', ...one });
      requirements.push(created);
    }
    const first = requirements[0].requirement_id;
    await api.createAssessment(first, {
      assessed_level: 'L1',
      related_item_ids: [activeItem.item_id],
      impact_summary: '页面与接口前缀会影响所有客户端和深链刷新。',
      uncertainties: ['旧调用方是否仍依赖根路径'],
      proposed_action: 'relevel',
      assessor_type: 'human',
      assessor_id: '演示架构师',
    });
    await api.createDecision(first, {
      conclusion: 'relevelled',
      final_level: 'L1',
      reason: '统一 URL 属于公共接口约定，影响全部调用方。',
      confirmed_by: '演示负责人',
    });
    const [demoTask] = await api.createRequirementTasks(first, {
      created_by: '演示',
      tasks: [{
        purpose: '迁移路由与 API 前缀，旧路径返回迁移提示。',
        scope: 'router、api 封装与测试。',
        non_scope: '不改核心链状态机。',
        done_when: ['新前缀下深链刷新可用', '旧根路径返回 308 或迁移提示'],
        serves_item_ids: [activeItem.item_id],
        acceptance_evidence: ['构建通过', '端到端脚本通过'],
      }],
    });
    const c1 = await api.claimTask(demoTask.task_id, { worker_id: '演示开发者A' });
    const s1 = await api.createSubmission(demoTask.task_id, {
      claim_id: c1.claim.claim_id,
      submitted_by: '演示开发者A',
      commit_refs: [{ repo: 'SuperAgentPlusCloud', branch: 'master', hash: 'demo-first' }],
      summary: '完成接口前缀迁移，但遗漏页面深链回落。',
      self_test: '接口前缀测试通过，页面深链未覆盖。',
      known_gaps: ['刷新项目深链返回 404'],
      artifacts: [firstContract.artifact_id],
    });
    await api.createReview(s1.submission_id, {
      reviewer_id: '演示评审者',
      conclusion: 'reject',
      reason: '未满足「新前缀下深链刷新可用」。',
      criterion_results: [{ criterion: '新前缀下深链刷新可用', result: '未通过', evidence: '刷新返回 404' }],
    });
    const c2 = await api.claimTask(demoTask.task_id, { worker_id: '演示开发者B' });
    const s2 = await api.createSubmission(demoTask.task_id, {
      claim_id: c2.claim.claim_id,
      submitted_by: '演示开发者B',
      commit_refs: [{ repo: 'SuperAgentPlusCloud', branch: 'master', hash: 'demo-final' }],
      summary: '补齐 SPA 深链回落并完成旧路径迁移提示。',
      self_test: 'URL 契约测试全部通过。',
      known_gaps: [],
    });
    await api.createReview(s2.submission_id, {
      reviewer_id: '演示评审者',
      conclusion: 'confirm',
      reason: '两条完成条件均已满足。',
      criterion_results: [
        { criterion: '新前缀下深链刷新可用', result: '通过', evidence: 'URL 契约测试' },
        { criterion: '旧根路径返回 308 或迁移提示', result: '通过', evidence: 'URL 契约测试' },
      ],
    });
    added.push('需求与任务链');
  }

  // 主干变更与影响
  const changes = await api.listTrunkChanges({ project_id: projectId });
  if (!Array.isArray(changes) || changes.length === 0) {
    const oldItem = items[1] || items[0];
    const change = await api.createTrunkChange({
      project_id: projectId,
      reason: '从 CRUD 面板改为围绕主干与影响的工作台。',
      old_item_ids: [oldItem.item_id],
      proposed_items: [{ kind: 'capability', statement: '面板以主干、判断、执行与影响组织，而非 CRUD 表格。' }],
      impact_assessment: '影响面板全部视图与导航分组，需要逐页确认。',
      created_by: '演示',
    });
    await api.confirmTrunkChange(change.change_id, { confirmed_by: '演示' });
    await api.activateTrunkChange(change.change_id, { confirmed_by: '演示' });
    const tasks = await api.listTasks({ project_id: projectId });
    const target = (tasks || [])[0];
    if (target) {
      await api.addImpactItem(change.change_id, {
        target_type: 'task',
        target_id: target.task_id,
        owner_id: '演示',
      });
    }
    added.push('主干变更');
  }

  // 契约 v2：演示「契约变了会生成待检查影响」
  artifacts = await api.listArtifacts({ project_id: projectId });
  const contractVersions = (artifacts || []).filter((one) => one.type === 'api_contract');
  if (contractVersions.length === 1 && firstContract?.status === 'published') {
    const v2 = await api.createArtifact({
      project_id: projectId,
      type: 'api_contract',
      name: '演示订单 API',
      created_by: '演示',
      content: demoContract('1.1.0', true),
    });
    await api.publishArtifact(v2.artifact_id, { published_by: '演示', reason: '新增订单详情接口' });
    const impacts = await api.listArtifactImpacts(v2.artifact_id);
    if (!Array.isArray(impacts) || impacts.length === 0) {
      const tasks = await api.listTasks({ project_id: projectId });
      if (Array.isArray(tasks) && tasks[0]) {
        await api.addArtifactImpact(v2.artifact_id, {
          target_type: 'task',
          target_id: tasks[0].task_id,
          owner_id: '演示',
          reason: '契约新增订单详情接口，需确认该任务是否受影响。',
        });
      }
    }
    added.push('契约 v2 与变更影响');
  }

  return added;
}


async function createDemo() {
  creatingDemo.value = true;
  let projectId = '';
  const fail = (step, err) => {
    const detail = errorMessage(err, '未知错误');
    ElMessage.error(`演示项目在第 ${step} 步失败：${detail}。已创建的内容保留。`);
  };
  try {
    // 已存在演示项目时走补全路径，避免再造一份同名项目。
    const existingProjects = await api.listProjects();
    const existingDemo = (existingProjects || []).find((one) => one.name === DEMO_PROJECT_NAME);
    if (existingDemo) {
      const added = await completeDemo(existingDemo.project_id);
      ElMessage.success(added.length
        ? `演示项目已补全：${added.join('、')}`
        : '演示项目已完整，无需补全。');
      await load();
      go(router, 'dashboard', { id: existingDemo.project_id });
      return;
    }

    const project = await api.createProject({
      name: 'SuperAgentPlusCloud（演示）',
      purpose: '把项目当前有效的决定与影响范围保留下来，让约定变化可追踪。',
      scope_summary: '中心服务、客户端与面板；一期 SQLite。',
      created_by: '演示',
    });
    projectId = project.project_id;

    // 1) 五条主干：先 proposed，再逐条确认生效。
    const trunkSeed = [
      { kind: 'goal', statement: '让当前有效主干、判断依据与影响处置可见可操作。' },
      { kind: 'scope', statement: '中心服务维护权威记录，客户端只与中心交互。' },
      { kind: 'capability', statement: 'AI 只产出建议，不产生已生效状态。' },
      { kind: 'interface', statement: '页面与接口统一使用 /sap-cloud/* 前缀。' },
      { kind: 'data_contract', statement: '一期默认 SQLite，后续可接 PostgreSQL。' },
    ];
    const items = [];
    for (const seed of trunkSeed) {
      const created = await api.createTrunkItem({ project_id: projectId, ...seed, created_by: '演示' });
      items.push(await api.confirmTrunkItem(created.item_id, { confirmed_by: '演示' }));
    }

    // 2) 项目约定包：禁止 PUT/DELETE、统一响应包络、路径 kebab、字段 camel。
    const pack = await api.createConventionPack({
      name: '演示：API 约定',
      description: '团队偏好示例，可按项目改写。',
      scope: 'project',
      project_id: projectId,
      created_by: '演示',
      rules: [
        { key: 'api.methods.forbidden', category: 'api', title: '禁止 PUT/DELETE', severity: 'must', value: { methods: ['put', 'delete'] }, rationale: '网关与审计只支持查询/动作式 POST。' },
        { key: 'api.response', category: 'api', title: '统一响应包络', severity: 'must', value: { fields: ['status', 'message', 'data'] }, rationale: '前端统一按包络解析。' },
        { key: 'api.path.case', category: 'api', title: '路径 kebab-case', severity: 'must', value: { style: 'kebab-case' } },
        { key: 'api.field.case', category: 'api', title: '字段 camelCase', severity: 'should', value: { style: 'camelCase' } },
      ],
    });
    await api.activateConventionPack(pack.pack_id, { activated_by: '演示', reason: '演示项目启用 API 约定' });

    // 3) 编排模板：内置 contract-first-api 落到本项目。
    await api.seedWorkflowTemplates({ project_id: projectId, created_by: '演示' });

    // 4) 契约 v1：一份符合约定的 API 契约，校验通过后发布。
    const contractBody = (version, extraPath = false) => ({
      openapi: '3.1.0',
      info: { title: '演示订单 API', version },
      paths: {
        '/orders/query': {
          post: {
            operationId: 'queryOrders',
            summary: '按条件查询订单',
            responses: {
              200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/OrderListEnvelope' } } } },
            },
          },
        },
        ...(extraPath ? {
          '/orders/detail': {
            post: {
              operationId: 'orderDetail',
              summary: '查询订单详情',
              responses: {
                200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/OrderListEnvelope' } } } },
              },
            },
          },
        } : {}),
      },
      components: {
        schemas: {
          OrderListEnvelope: {
            type: 'object',
            required: ['status', 'message', 'data'],
            properties: {
              status: { type: 'integer', const: 1 },
              message: { type: 'string', example: 'ok' },
              data: { type: 'array', items: { $ref: '#/components/schemas/Order' } },
            },
          },
          Order: { type: 'object', properties: { orderId: { type: 'string', example: 'O-1' } } },
        },
      },
    });

    const contract = await api.createArtifact({
      project_id: projectId,
      type: 'api_contract',
      name: '演示订单 API',
      created_by: '演示',
      content: contractBody('1.0.0'),
    });
    await api.publishArtifact(contract.artifact_id, { published_by: '演示', reason: '演示契约首版' });

    // 5) 一条材料：真实文本，供「材料与提取」页面演示，AI 未配置时也能看到原文。
    const material = await api.createMaterial({
      project_id: projectId,
      title: '演示会议纪要',
      kind: 'meeting',
      source_ref: 'demo://meeting/2026-11-19',
      created_by: '演示',
      content: [
        '会议主题：订单导出与接口前缀调整',
        '一、背景',
        '运营反馈导出接口在数据量大时超时；前端点击导出按钮偶发无响应。',
        '二、结论',
        '1. 导出接口改为 POST /orders/query 的异步任务式调用，返回包络统一为 {status,message,data}。',
        '2. 页面与接口前缀统一到 /sap-cloud，旧路径保留 308 迁移提示。',
        '3. 前端与后端先对齐契约，再各自实现，最后联调；契约变更需登记影响。',
        '三、待确认',
        '1. 历史数据导出是否仍保留同步接口，需与运维确认。',
        '2. 导出任务失败的重试次数尚未确定。',
      ].join('\n'),
    });

    // 6) 主体与成员：仅在系统还没有任何凭据（引导期）时创建，避免与管理员锁定冲突。
    try {
      const existingActors = await api.listActors();
      if (Array.isArray(existingActors) && existingActors.length === 0) {
        const owner = await api.createActor({ type: 'human', display_name: '演示负责人', created_by: '演示' });
        const reviewer = await api.createActor({ type: 'human', display_name: '演示评审者', created_by: '演示' });
        const agent = await api.createActor({
          type: 'agent',
          display_name: '演示 Agent',
          on_behalf_of: owner.actor_id,
          project_id: projectId,
          allowed_actions: ['claim', 'submit', 'report'],
          created_by: '演示',
        });
        await api.setCapability(agent.actor_id, { key: 'backend', level: 'expert' });
        await api.addMember(projectId, { actor_id: owner.actor_id, roles: ['owner', 'direction'], created_by: '演示' });
        await api.addMember(projectId, { actor_id: reviewer.actor_id, roles: ['reviewer', 'contributor'], created_by: '演示' });
        await api.addMember(projectId, { actor_id: agent.actor_id, roles: ['contributor'], created_by: '演示' });
      }
    } catch (actorErr) {
      // 身份初始化失败不影响演示项目主体数据。
      console.warn('演示主体未创建：', actorErr);
    }

    // 7) 三条需求。
    const requirementIds = [];
    const requirementSeed = [
      { raw_text: '把页面与接口迁移到 /sap-cloud/*，旧路径重定向。', claimed_level: 'L2' },
      { raw_text: '面板围绕主干、判断、执行与影响重构，而不是 CRUD 表格。', claimed_level: 'L2' },
      { raw_text: '未来支持 PostgreSQL，保持 SQLite 可用。', claimed_level: 'L1' },
    ];
    for (const seed of requirementSeed) {
      const created = await api.createRequirement({
        project_id: projectId,
        author: '演示',
        ...seed,
      });
      requirementIds.push(created.requirement_id);
    }

    // 3) 第一条需求走一次真实评估与决定，保留 L2 → L1 的差异。
    await api.createAssessment(requirementIds[0], {
      assessed_level: 'L1',
      related_item_ids: [items[3].item_id],
      impact_summary: '页面与接口前缀会影响所有客户端和深链刷新。',
      uncertainties: ['旧调用方是否仍依赖根路径'],
      proposed_action: 'relevel',
      assessor_type: 'human',
      assessor_id: '演示架构师',
    });
    await api.createDecision(requirementIds[0], {
      conclusion: 'relevelled',
      final_level: 'L1',
      reason: '统一 URL 属于公共接口约定，影响全部调用方。',
      confirmed_by: '演示负责人',
    });

    // 4) 一个任务走完整“认领 → 提交 → 打回 → 重领 → 再提交 → 确认”链。
    const targetItem = items[3];
    const [demoTask] = await api.createRequirementTasks(requirementIds[0], {
      created_by: '演示',
      tasks: [{
        purpose: '迁移路由与 API 前缀，旧路径返回迁移提示。',
        scope: 'router、api 封装与测试。',
        non_scope: '不改核心链状态机。',
        done_when: ['新前缀下深链刷新可用', '旧根路径返回 308 或迁移提示'],
        serves_item_ids: [targetItem.item_id],
        acceptance_evidence: ['构建通过', '端到端脚本通过'],
      }],
    });

    const firstClaim = await api.claimTask(demoTask.task_id, { worker_id: '演示开发者A' });
    const firstSubmission = await api.createSubmission(demoTask.task_id, {
      claim_id: firstClaim.claim.claim_id,
      submitted_by: '演示开发者A',
      commit_refs: [{ repo: 'SuperAgentPlusCloud', branch: 'master', hash: 'demo-first' }],
      summary: '完成接口前缀迁移，但遗漏页面深链回落。',
      self_test: '接口前缀测试通过，页面深链未覆盖。',
      known_gaps: ['刷新项目深链返回 404'],
      artifacts: [contract.artifact_id],
    });
    await api.createReview(firstSubmission.submission_id, {
      reviewer_id: '演示评审者',
      conclusion: 'reject',
      reason: '未满足“新前缀下深链刷新可用”。',
      criterion_results: [{ criterion: '新前缀下深链刷新可用', result: '未通过', evidence: '刷新返回 404' }],
    });
    const secondClaim = await api.claimTask(demoTask.task_id, { worker_id: '演示开发者B' });
    const secondSubmission = await api.createSubmission(demoTask.task_id, {
      claim_id: secondClaim.claim.claim_id,
      submitted_by: '演示开发者B',
      commit_refs: [{ repo: 'SuperAgentPlusCloud', branch: 'master', hash: 'demo-final' }],
      summary: '补齐 SPA 深链回落并完成旧路径迁移提示。',
      self_test: 'URL 契约测试全部通过。',
      known_gaps: [],
    });
    await api.createReview(secondSubmission.submission_id, {
      reviewer_id: '演示评审者',
      conclusion: 'confirm',
      reason: '两条完成条件均已满足。',
      criterion_results: [
        { criterion: '新前缀下深链刷新可用', result: '通过', evidence: 'URL 契约测试' },
        { criterion: '旧根路径返回 308 或迁移提示', result: '通过', evidence: 'URL 契约测试' },
      ],
    });

    // 5) 一条变更：旧条目被新条目替代，并登记待检查影响项。
    const change = await api.createTrunkChange({
      project_id: projectId,
      reason: '从 CRUD 面板改为围绕主干与影响的工作台。',
      old_item_ids: [items[1].item_id],
      proposed_items: [{ kind: 'capability', statement: '面板以主干、判断、执行与影响组织，而非 CRUD 表格。' }],
      impact_assessment: '影响面板全部视图与导航分组，需要逐页确认。',
      created_by: '演示',
    });
    await api.confirmTrunkChange(change.change_id, { confirmed_by: '演示' });
    await api.activateTrunkChange(change.change_id, { confirmed_by: '演示' });
    await api.addImpactItem(change.change_id, {
      target_type: 'task',
      target_id: demoTask.task_id,
      owner_id: '演示',
    });

    // 11) 契约 v2：新增一个接口后发布，自动为引用 v1 的提交生成待检查影响。
    const contractV2 = await api.createArtifact({
      project_id: projectId,
      type: 'api_contract',
      name: '演示订单 API',
      created_by: '演示',
      content: contractBody('1.1.0', true),
    });
    await api.publishArtifact(contractV2.artifact_id, { published_by: '演示', reason: '新增订单详情接口' });

    ElMessage.success('演示项目已创建：主干、需求、任务链、变更影响、约定包、编排模板、契约 v1→v2、材料与主体都在其中。');
    await load();
    go(router, 'dashboard', { id: projectId });
  } catch (err) {
    fail('创建演示数据', err);
    await load();
  } finally {
    creatingDemo.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page" v-loading="loading">
    <div class="page-header">
      <div>
        <h2 class="page-title">项目列表</h2>
      </div>
      <div class="toolbar">
        <el-button type="primary" plain :loading="creatingDemo" @click="createDemo">
          <el-icon><MagicStick /></el-icon>
          创建演示项目（SuperAgentPlusCloud）
        </el-button>
        <el-button type="primary" @click="openCreate">
          <el-icon><Plus /></el-icon>
          新建项目
        </el-button>
      </div>
    </div>

    <EmptyState v-if="!loading && rows.length === 0" description="">
      <el-button type="primary" plain :loading="creatingDemo" @click="createDemo">创建演示项目</el-button>
      <el-button type="primary" plain @click="openCreate">新建项目</el-button>
    </EmptyState>

    <el-row v-else :gutter="16">
      <el-col v-for="row in rows" :key="row.project.project_id" :xs="24" :sm="12" :lg="8">
        <el-card class="card-gap" shadow="never">
          <div class="card-head">
            <div class="card-head__main">
              <div class="project-name">{{ row.project.name }}</div>
              <div class="mono muted">{{ row.project.project_id }}</div>
            </div>
            <StatusTag group="project" :value="row.project.status" />
          </div>

          <div class="card-body">
            <div v-if="row.project.purpose" class="line">目的：{{ row.project.purpose }}</div>
            <div v-if="row.project.scope_summary" class="line">范围：{{ row.project.scope_summary }}</div>

            <div class="metric-grid" style="margin: 10px 0 0; gap: 8px">
              <div class="metric-card" style="padding: 8px 10px">
                <div class="metric-card__label">生效主干</div>
                <div class="metric-card__value">{{ row.stats.activeTrunk }}</div>
              </div>
              <div class="metric-card" style="padding: 8px 10px">
                <div class="metric-card__label">待判断需求</div>
                <div class="metric-card__value" :class="{ 'is-warning': row.stats.pendingRequirements > 0 }">
                  {{ row.stats.pendingRequirements }}
                </div>
              </div>
              <div class="metric-card" style="padding: 8px 10px">
                <div class="metric-card__label">进行中任务</div>
                <div class="metric-card__value">{{ row.stats.activeTasks }}</div>
              </div>
              <div class="metric-card" style="padding: 8px 10px">
                <div class="metric-card__label">未关闭变更</div>
                <div class="metric-card__value">{{ row.stats.openChanges }}</div>
              </div>
              <div class="metric-card" style="padding: 8px 10px">
                <div class="metric-card__label">待检查影响</div>
                <div class="metric-card__value" :class="{ 'is-danger': row.stats.toCheckImpacts > 0 }">
                  {{ row.stats.toCheckImpacts }}
                </div>
              </div>
            </div>

            <div class="line" :class="{ 'muted': !row.firstAction }">
              需要处理：{{ row.firstAction }}
            </div>
            <div class="line muted">
              最后活动：{{ row.stats.lastActivity ? formatTime(row.stats.lastActivity) : '—' }}
            </div>
          </div>

          <div class="card-actions">
            <el-button size="small" type="primary" plain @click="go(router, 'dashboard', { id: row.project.project_id })">
              进入项目
            </el-button>
            <el-dropdown @command="(name) => go(router, name, { id: row.project.project_id })">
              <el-button size="small">
                更多
                <el-icon><ArrowDown /></el-icon>
              </el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="trunk">主干地图</el-dropdown-item>
                  <el-dropdown-item command="requirements">需求工作台</el-dropdown-item>
                  <el-dropdown-item command="tasks">任务工作台</el-dropdown-item>
                  <el-dropdown-item command="changes">变更影响台</el-dropdown-item>
                  <el-dropdown-item command="timeline">事件时间线</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-dialog v-model="dialogVisible" title="新建项目" width="520px">
      <el-form :model="form" :rules="rules" label-width="96px">
        <el-form-item label="项目名称" prop="name">
          <el-input v-model="form.name" placeholder="例如：订单中心一期" />
        </el-form-item>
        <el-form-item label="项目目的">
          <el-input v-model="form.purpose" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item label="范围说明">
          <el-input v-model="form.scope_summary" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item label="政策引用">
          <el-input v-model="form.policy_ref" placeholder="可选，例如制度或规范链接" />
        </el-form-item>
        <el-form-item label="创建人">
          <el-input v-model="form.created_by" placeholder="可选，具名人员" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitCreate">创建</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.project-name {
  font-size: 16px;
  font-weight: 600;
}

.card-body {
  margin: 12px 0;
}

.line {
  margin-bottom: 4px;
  font-size: 13px;
}

.card-actions {
  display: flex;
  gap: 8px;
}
</style>
