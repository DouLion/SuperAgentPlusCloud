<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api, errorMessage } from '../api.js';
import { formatTime, TRUNK_KIND_TEXT } from '../status.js';
import EmptyState from '../components/EmptyState.vue';

const route = useRoute();
const projectId = route.params.id;

const activeTab = ref('conventions');

const PACK_STATUS = { draft: '草稿', active: '生效', superseded: '被替代', retired: '已退役' };
const ARTIFACT_STATUS = { draft: '草稿', published: '已发布', superseded: '被替代', retired: '已退役' };
const SCOPE_TEXT = { team: '团队', project: '项目' };
const SEVERITY_TAG = { must: 'danger', should: 'warning', preference: 'info' };

// ------------------------------------------------------------ 约定包
const packs = ref([]);
const packLoading = ref(false);
const selectedPack = ref(null);
const packDialog = ref(false);
const packSaving = ref(false);
const packForm = reactive({
  name: '',
  description: '',
  created_by: '',
  rules: [emptyRule()],
});

function emptyRule() {
  return { key: '', title: '', severity: 'must', category: 'api', value: '{}', rationale: '' };
}

const groupedPackRules = computed(() => {
  const rules = selectedPack.value?.rules || [];
  return ['must', 'should', 'preference'].map((severity) => ({
    severity,
    rules: rules.filter((rule) => rule.severity === severity),
  })).filter((group) => group.rules.length > 0);
});

async function loadPacks() {
  packLoading.value = true;
  try {
    packs.value = await api.listConventionPacks({ project_id: projectId });
    if (!selectedPack.value && packs.value.length) selectedPack.value = packs.value[0];
    else if (selectedPack.value) {
      selectedPack.value = packs.value.find((item) => item.pack_id === selectedPack.value.pack_id) || packs.value[0] || null;
    }
  } catch (err) {
    ElMessage.error(errorMessage(err, '加载约定包失败'));
  } finally {
    packLoading.value = false;
  }
}

function openPackDialog() {
  Object.assign(packForm, { name: '', description: '', created_by: '', rules: [emptyRule()] });
  packDialog.value = true;
}

function addRule() {
  packForm.rules.push(emptyRule());
}

function removeRule(index) {
  packForm.rules.splice(index, 1);
}

async function submitPack() {
  if (!packForm.name.trim()) {
    ElMessage.warning('请填写约定包名称');
    return;
  }
  let rules;
  try {
    rules = packForm.rules
      .filter((rule) => rule.key.trim() && rule.title.trim())
      .map((rule) => ({
        key: rule.key.trim(),
        title: rule.title.trim(),
        severity: rule.severity,
        category: rule.category || 'api',
        rationale: rule.rationale || undefined,
        value: rule.value.trim() ? JSON.parse(rule.value) : {},
      }));
  } catch {
    ElMessage.error('规则 value 必须是合法 JSON，例如 {"methods":["put"]}');
    return;
  }
  if (!rules.length) {
    ElMessage.warning('至少需要一条规则（key 与标题必填）');
    return;
  }
  packSaving.value = true;
  try {
    await api.createConventionPack({
      name: packForm.name.trim(),
      description: packForm.description || undefined,
      scope: 'project',
      project_id: projectId,
      created_by: packForm.created_by || '面板',
      rules,
    });
    ElMessage.success('约定包已创建（草稿），激活后才会参与校验');
    packDialog.value = false;
    await loadPacks();
  } catch (err) {
    ElMessage.error(errorMessage(err, '创建约定包失败'));
  } finally {
    packSaving.value = false;
  }
}

async function activatePack(pack) {
  try {
    await api.activateConventionPack(pack.pack_id, { activated_by: '面板', reason: '面板激活' });
    ElMessage.success('约定包已激活');
    await loadPacks();
  } catch (err) {
    ElMessage.error(errorMessage(err, '激活失败'));
  }
}

async function retirePack(pack) {
  try {
    await api.retireConventionPack(pack.pack_id, { retired_by: '面板', reason: '面板退役' });
    ElMessage.success('约定包已退役');
    await loadPacks();
  } catch (err) {
    ElMessage.error(errorMessage(err, '退役失败'));
  }
}

const teamPacks = computed(() => packs.value.filter((pack) => pack.scope === 'team' && pack.status === 'active'));

async function importTeamPack(packId) {
  try {
    await api.importConventionPack(packId, { project_id: projectId, created_by: '面板' });
    ElMessage.success('已从团队成员模板导入为项目快照');
    await loadPacks();
  } catch (err) {
    ElMessage.error(errorMessage(err, '导入失败'));
  }
}

// ------------------------------------------------------------ 编排模板
const templates = ref([]);
const templateLoading = ref(false);
const selectedTemplate = ref(null);
const templateDialog = ref(false);
const templateSaving = ref(false);
const templateForm = reactive({ name: '', kind: 'api-development', created_by: '', nodes: '' });

const templateTree = computed(() => {
  const nodes = selectedTemplate.value?.nodes || [];
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const childrenOf = (key) => nodes
    .filter((node) => (node.depends_on || []).includes(key))
    .map((node) => buildNode(node, childrenOf, byKey));
  const roots = nodes.filter((node) => !(node.depends_on || []).length);
  return roots.map((node) => buildNode(node, childrenOf, byKey));
});

function buildNode(node, childrenOf, byKey) {
  return {
    key: node.key,
    data: node,
    children: childrenOf(node.key),
    missing: (node.depends_on || []).filter((key) => !byKey.has(key)),
  };
}

async function loadTemplates() {
  templateLoading.value = true;
  try {
    templates.value = await api.listWorkflowTemplates({ project_id: projectId });
    if (!selectedTemplate.value && templates.value.length) selectedTemplate.value = templates.value[0];
    else if (selectedTemplate.value) {
      selectedTemplate.value = templates.value.find((item) => item.template_id === selectedTemplate.value.template_id)
        || templates.value[0] || null;
    }
  } catch (err) {
    ElMessage.error(errorMessage(err, '加载编排模板失败'));
  } finally {
    templateLoading.value = false;
  }
}

async function seedTemplates() {
  try {
    await api.seedWorkflowTemplates({ project_id: projectId, created_by: '面板' });
    ElMessage.success('已导入内置 contract-first-api 模板');
    await loadTemplates();
  } catch (err) {
    ElMessage.error(errorMessage(err, '导入内置模板失败'));
  }
}

function openTemplateDialog() {
  Object.assign(templateForm, {
    name: '',
    kind: 'api-development',
    created_by: '',
    nodes: JSON.stringify([
      { key: 'contract', title: '接口契约设计', done_when_template: ['契约已确认'], role_hint: 'api-designer', depends_on: [], outputs: ['api_contract'] },
      { key: 'frontend', title: '前端实现', done_when_template: ['按契约完成'], role_hint: 'frontend', depends_on: ['contract'], outputs: [] },
      { key: 'backend', title: '后端实现', done_when_template: ['按契约完成'], role_hint: 'backend', depends_on: ['contract'], outputs: [] },
      { key: 'integration', title: '联调', done_when_template: ['联调通过'], role_hint: 'integration', depends_on: ['frontend', 'backend'], outputs: [] },
    ], null, 2),
  });
  templateDialog.value = true;
}

async function submitTemplate() {
  let nodes;
  try {
    nodes = JSON.parse(templateForm.nodes);
  } catch {
    ElMessage.error('nodes 必须是合法 JSON 数组');
    return;
  }
  templateSaving.value = true;
  try {
    await api.createWorkflowTemplate({
      name: templateForm.name.trim(),
      kind: templateForm.kind,
      project_id: projectId,
      created_by: templateForm.created_by || '面板',
      nodes,
    });
    ElMessage.success('编排模板已创建（草稿）');
    templateDialog.value = false;
    await loadTemplates();
  } catch (err) {
    ElMessage.error(errorMessage(err, '创建模板失败'));
  } finally {
    templateSaving.value = false;
  }
}

async function activateTemplate(template) {
  try {
    await api.activateWorkflowTemplate(template.template_id, { activated_by: '面板', reason: '面板激活' });
    ElMessage.success('模板已激活');
    await loadTemplates();
  } catch (err) {
    ElMessage.error(errorMessage(err, '激活失败'));
  }
}

async function retireTemplate(template) {
  try {
    await api.retireWorkflowTemplate(template.template_id, { retired_by: '面板', reason: '面板退役' });
    ElMessage.success('模板已退役');
    await loadTemplates();
  } catch (err) {
    ElMessage.error(errorMessage(err, '退役失败'));
  }
}

// ------------------------------------------------------------ API 契约
const artifacts = ref([]);
const artifactLoading = ref(false);
const selectedArtifact = ref(null);
const validation = ref(null);
const validating = ref(false);
const artifactDialog = ref(false);
const artifactSaving = ref(false);
const artifactForm = reactive({ name: '', created_by: '', content: '' });

const MINIMAL_CONTRACT = {
  openapi: '3.1.0',
  info: { title: '新接口契约', version: '1.0.0' },
  paths: {
    '/orders/query': {
      post: {
        operationId: 'queryOrders',
        summary: '查询订单',
        responses: {
          200: {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/OrderListEnvelope' },
              },
            },
          },
        },
      },
    },
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

const contractOperations = computed(() => {
  const paths = selectedArtifact.value?.content?.paths || {};
  const rows = [];
  for (const [pathname, pathItem] of Object.entries(paths)) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const operation = pathItem?.[method];
      if (!operation) continue;
      const status = Object.keys(operation.responses || {}).find((code) => /^2\d\d$/.test(code));
      rows.push({
        pathname,
        method: method.toUpperCase(),
        operationId: operation.operationId || '—',
        summary: operation.summary || '',
        response_status: status || null,
      });
    }
  }
  return rows;
});

const violationsBySeverity = computed(() => {
  const violations = validation.value?.violations || [];
  return ['must', 'should', 'preference'].map((severity) => ({
    severity,
    items: violations.filter((item) => item.severity === severity),
  })).filter((group) => group.items.length > 0);
});

const mustCount = computed(() => validation.value?.counts?.must || 0);

async function loadArtifacts() {
  artifactLoading.value = true;
  try {
    artifacts.value = await api.listArtifacts({ project_id: projectId, type: 'api_contract' });
    const keepId = selectedArtifact.value?.artifact_id;
    selectedArtifact.value = artifacts.value.find((item) => item.artifact_id === keepId)
      || artifacts.value[0] || null;
    validation.value = null;
    if (selectedArtifact.value) await validateSelected();
  } catch (err) {
    ElMessage.error(errorMessage(err, '加载契约失败'));
  } finally {
    artifactLoading.value = false;
  }
}

async function validateSelected() {
  if (!selectedArtifact.value) return;
  validating.value = true;
  try {
    validation.value = await api.validateArtifact(selectedArtifact.value.artifact_id);
  } catch (err) {
    validation.value = null;
    ElMessage.error(errorMessage(err, '校验失败'));
  } finally {
    validating.value = false;
  }
}

function openArtifactDialog() {
  Object.assign(artifactForm, {
    name: '',
    created_by: '',
    content: JSON.stringify(MINIMAL_CONTRACT, null, 2),
  });
  artifactDialog.value = true;
}

async function submitArtifact() {
  let content;
  try {
    content = JSON.parse(artifactForm.content);
  } catch {
    ElMessage.error('契约内容必须是合法 JSON');
    return;
  }
  if (!artifactForm.name.trim()) {
    ElMessage.warning('请填写契约名称');
    return;
  }
  artifactSaving.value = true;
  try {
    const created = await api.createArtifact({
      project_id: projectId,
      type: 'api_contract',
      name: artifactForm.name.trim(),
      content,
      created_by: artifactForm.created_by || '面板',
    });
    ElMessage.success('契约草稿已创建，请先校验再发布');
    artifactDialog.value = false;
    await loadArtifacts();
    selectedArtifact.value = artifacts.value.find((item) => item.artifact_id === created.artifact_id)
      || selectedArtifact.value;
    await validateSelected();
  } catch (err) {
    ElMessage.error(errorMessage(err, '创建契约失败'));
  } finally {
    artifactSaving.value = false;
  }
}

async function publishSelected() {
  if (!selectedArtifact.value) return;
  if (mustCount.value > 0) return;
  try {
    const result = await api.publishArtifact(selectedArtifact.value.artifact_id, {
      published_by: '面板',
      reason: '面板发布',
    });
    ElMessage.success(`契约 v${result.artifact.version} 已发布`);
    await loadArtifacts();
  } catch (err) {
    ElMessage.error(errorMessage(err, '发布失败'));
  }
}

async function retireSelected() {
  if (!selectedArtifact.value) return;
  try {
    await api.retireArtifact(selectedArtifact.value.artifact_id, { retired_by: '面板', reason: '面板退役' });
    ElMessage.success('契约已退役');
    await loadArtifacts();
  } catch (err) {
    ElMessage.error(errorMessage(err, '退役失败'));
  }
}

async function newVersion() {
  if (!selectedArtifact.value) return;
  let content;
  try {
    content = JSON.parse(artifactForm.content || JSON.stringify(selectedArtifact.value.content, null, 2));
  } catch {
    ElMessage.error('请先打开新建弹窗并填写合法 JSON');
    return;
  }
  try {
    await api.createArtifact({
      project_id: projectId,
      type: 'api_contract',
      name: selectedArtifact.value.name,
      content,
      created_by: '面板',
    });
    ElMessage.success('已创建新版本草稿');
    await loadArtifacts();
  } catch (err) {
    ElMessage.error(errorMessage(err, '创建新版本失败'));
  }
}

// ------------------------------------------------------------ 文档与 Mock
const mockDialog = ref(false);
const mockLoading = ref(false);
const mockResult = reactive({ url: '', status: null, body: '' });

function mockUrl(row) {
  const concrete = row.pathname.replace(/\{([^}]+)\}/g, '1');
  return `/sap-cloud/api/mock/${projectId}${concrete}`;
}

async function tryMock(row) {
  const url = mockUrl(row);
  Object.assign(mockResult, { url, status: null, body: '' });
  mockDialog.value = true;
  mockLoading.value = true;
  try {
    const res = await fetch(url, { method: row.method });
    const text = await res.text();
    mockResult.status = res.status;
    try {
      mockResult.body = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      mockResult.body = text;
    }
  } catch (err) {
    mockResult.status = 0;
    mockResult.body = `请求失败：${err.message}`;
  } finally {
    mockLoading.value = false;
  }
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success('已复制');
  } catch {
    ElMessage.warning('复制失败，请手动选择');
  }
}

function openDocument() {
  if (!selectedArtifact.value) return;
  window.open(api.artifactDocumentUrl(selectedArtifact.value.artifact_id), '_blank');
}

// ------------------------------------------------------------ 引用关系
const references = ref(null);
const referenceLoading = ref(false);

async function loadReferences() {
  if (!selectedArtifact.value) return;
  referenceLoading.value = true;
  try {
    references.value = await api.artifactReferences(selectedArtifact.value.artifact_id);
  } catch (err) {
    references.value = null;
    ElMessage.error(errorMessage(err, '加载引用关系失败'));
  } finally {
    referenceLoading.value = false;
  }
}

function onTabChange(name) {
  if (name === 'references') loadReferences();
}

onMounted(async () => {
  await Promise.all([loadPacks(), loadTemplates(), loadArtifacts()]);
});
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">契约与制品</h2>
        <div class="page-subtitle">约定包决定校验规则；同一份契约驱动接口文档与 Mock。</div>
      </div>
    </div>

    <el-tabs v-model="activeTab" @tab-change="onTabChange">
      <!-- 约定包 -->
      <el-tab-pane label="约定包" name="conventions">
        <div class="toolbar">
          <el-button type="primary" @click="openPackDialog">新建约定包</el-button>
          <el-dropdown v-if="teamPacks.length" trigger="click">
            <el-button plain>
              从团队模板导入
              <el-icon><ArrowDown /></el-icon>
            </el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item
                  v-for="pack in teamPacks"
                  :key="pack.pack_id"
                  @click="importTeamPack(pack.pack_id)"
                >
                  {{ pack.name }}（v{{ pack.version }}）
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>

        <el-table
          v-loading="packLoading"
          :data="packs"
          highlight-current-row
          @current-change="(row) => { if (row) selectedPack = row; }"
        >
          <el-table-column prop="name" label="名称" min-width="200" show-overflow-tooltip />
          <el-table-column label="作用域" width="100">
            <template #default="{ row }">{{ SCOPE_TEXT[row.scope] || row.scope }}</template>
          </el-table-column>
          <el-table-column prop="version" label="版本" width="80" />
          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <el-tag :type="row.status === 'active' ? 'success' : 'info'" size="small">
                {{ PACK_STATUS[row.status] || row.status }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="规则数" width="90">
            <template #default="{ row }">{{ (row.rules || []).length }}</template>
          </el-table-column>
          <el-table-column label="激活时间" width="170">
            <template #default="{ row }">{{ row.activated_at ? formatTime(row.activated_at) : '—' }}</template>
          </el-table-column>
          <el-table-column label="操作" width="200">
            <template #default="{ row }">
              <el-button
                v-if="row.status === 'draft'"
                size="small"
                type="primary"
                plain
                @click="activatePack(row)"
              >
                激活
              </el-button>
              <el-button
                v-if="row.status === 'active'"
                size="small"
                @click="retirePack(row)"
              >
                退役
              </el-button>
            </template>
          </el-table-column>
        </el-table>

        <EmptyState v-if="!packLoading && packs.length === 0" description="还没有约定包，先新建一个或从团队模板导入" />

        <el-card v-if="selectedPack" class="detail-card" shadow="never">
          <template #header>{{ selectedPack.name }} · 规则</template>
          <el-collapse v-if="groupedPackRules.length">
            <el-collapse-item
              v-for="group in groupedPackRules"
              :key="group.severity"
              :name="group.severity"
            >
              <template #title>
                <el-tag :type="SEVERITY_TAG[group.severity]" size="small">{{ group.severity }}</el-tag>
                <span class="rule-group-title">{{ group.rules.length }} 条</span>
              </template>
              <div v-for="rule in group.rules" :key="rule.key" class="rule-row">
                <div class="rule-key">{{ rule.key }}</div>
                <div class="rule-title">{{ rule.title }}</div>
                <div class="rule-value mono">{{ JSON.stringify(rule.value) }}</div>
                <div v-if="rule.rationale" class="rule-rationale">{{ rule.rationale }}</div>
              </div>
            </el-collapse-item>
          </el-collapse>
          <EmptyState v-else description="这个约定包还没有规则" />
        </el-card>
      </el-tab-pane>

      <!-- 编排模板 -->
      <el-tab-pane label="编排模板" name="workflows">
        <div class="toolbar">
          <el-button type="primary" @click="openTemplateDialog">新建模板</el-button>
          <el-button plain @click="seedTemplates">导入内置 contract-first-api</el-button>
        </div>

        <el-row :gutter="16">
          <el-col :span="9">
            <el-table
              v-loading="templateLoading"
              :data="templates"
              highlight-current-row
              @current-change="(row) => { if (row) selectedTemplate = row; }"
            >
              <el-table-column prop="name" label="名称" min-width="160" show-overflow-tooltip />
              <el-table-column prop="kind" label="类型" width="130" />
              <el-table-column prop="version" label="版本" width="70" />
              <el-table-column label="状态" width="100">
                <template #default="{ row }">
                  <el-tag :type="row.status === 'active' ? 'success' : 'info'" size="small">
                    {{ PACK_STATUS[row.status] || row.status }}
                  </el-tag>
                </template>
              </el-table-column>
            </el-table>
            <EmptyState
              v-if="!templateLoading && templates.length === 0"
              description="还没有模板，可导入内置 contract-first-api"
            />
          </el-col>

          <el-col :span="15">
            <el-card v-if="selectedTemplate" shadow="never">
              <template #header>
                <div class="card-header-row">
                  <span>{{ selectedTemplate.name }}</span>
                  <span>
                    <el-button
                      v-if="selectedTemplate.status === 'draft'"
                      size="small"
                      type="primary"
                      plain
                      @click="activateTemplate(selectedTemplate)"
                    >
                      激活
                    </el-button>
                    <el-button
                      v-if="selectedTemplate.status === 'active'"
                      size="small"
                      @click="retireTemplate(selectedTemplate)"
                    >
                      退役
                    </el-button>
                  </span>
                </div>
              </template>
              <el-tree :data="templateTree" node-key="key" default-expand-all :expand-on-click-node="false">
                <template #default="{ data }">
                  <div class="dag-node">
                    <strong>{{ data.data.title }}</strong>
                    <el-tag v-if="data.data.role_hint" size="small" type="info">{{ data.data.role_hint }}</el-tag>
                    <span class="muted">完成条件：{{ (data.data.done_when_template || []).join('；') || '—' }}</span>
                    <span v-if="(data.data.outputs || []).length" class="muted">
                      产物：{{ data.data.outputs.join('、') }}
                    </span>
                    <el-tag v-if="data.missing.length" type="danger" size="small">
                      缺少依赖：{{ data.missing.join('、') }}
                    </el-tag>
                  </div>
                </template>
              </el-tree>
            </el-card>
            <EmptyState v-else description="左侧选择一个模板查看 DAG" />
          </el-col>
        </el-row>
      </el-tab-pane>

      <!-- API 契约 -->
      <el-tab-pane label="API 契约" name="contracts">
        <div class="toolbar">
          <el-button type="primary" @click="openArtifactDialog">新建契约</el-button>
          <el-button plain :loading="validating" :disabled="!selectedArtifact" @click="validateSelected">
            校验
          </el-button>
          <el-tooltip
            :disabled="mustCount === 0"
            :content="`存在 ${mustCount} 条 must 违规，修复后才能发布`"
          >
            <span>
              <el-button
                type="success"
                plain
                :disabled="!selectedArtifact || selectedArtifact.status !== 'draft' || mustCount > 0"
                @click="publishSelected"
              >
                发布
              </el-button>
            </span>
          </el-tooltip>
          <el-button
            plain
            :disabled="!selectedArtifact || selectedArtifact.status !== 'published'"
            @click="retireSelected"
          >
            退役
          </el-button>
        </div>

        <el-row :gutter="16">
          <el-col :span="9">
            <el-table
              v-loading="artifactLoading"
              :data="artifacts"
              highlight-current-row
              @current-change="(row) => { if (row) { selectedArtifact = row; validation = null; validateSelected(); } }"
            >
              <el-table-column prop="name" label="名称" min-width="150" show-overflow-tooltip />
              <el-table-column prop="version" label="版本" width="70" />
              <el-table-column label="状态" width="100">
                <template #default="{ row }">
                  <el-tag :type="row.status === 'published' ? 'success' : 'info'" size="small">
                    {{ ARTIFACT_STATUS[row.status] || row.status }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="摘要" width="100">
                <template #default="{ row }">
                  <span class="mono">{{ (row.digest || '').slice(0, 8) }}</span>
                </template>
              </el-table-column>
              <el-table-column label="创建时间" width="160">
                <template #default="{ row }">{{ formatTime(row.created_at) }}</template>
              </el-table-column>
            </el-table>
            <EmptyState v-if="!artifactLoading && artifacts.length === 0" description="还没有 API 契约" />
          </el-col>

          <el-col :span="15">
            <el-card v-if="selectedArtifact" shadow="never">
              <template #header>
                <div class="card-header-row">
                  <span>{{ selectedArtifact.name }} · v{{ selectedArtifact.version }}</span>
                  <el-tag size="small" type="info">{{ ARTIFACT_STATUS[selectedArtifact.status] }}</el-tag>
                </div>
              </template>

              <div v-loading="validating">
                <div v-if="validation" class="validation-summary">
                  <el-tag :type="validation.valid ? 'success' : 'danger'" size="small">
                    {{ validation.valid ? '校验通过' : '校验未通过' }}
                  </el-tag>
                  <span class="muted">
                    must {{ validation.counts.must }} / should {{ validation.counts.should }} / preference {{ validation.counts.preference }}
                  </span>
                </div>

                <div v-if="violationsBySeverity.length" class="violation-list">
                  <div v-for="group in violationsBySeverity" :key="group.severity" class="violation-group">
                    <el-tag :type="SEVERITY_TAG[group.severity]" size="small">{{ group.severity }}</el-tag>
                    <ul>
                      <li v-for="(item, index) in group.items" :key="`${group.severity}-${index}`">
                        {{ item.message }}
                        <code class="mono">{{ item.pointer }}</code>
                      </li>
                    </ul>
                  </div>
                </div>

                <el-collapse>
                  <el-collapse-item title="接口列表" name="ops">
                    <el-table :data="contractOperations" size="small">
                      <el-table-column prop="method" label="方法" width="90" />
                      <el-table-column prop="pathname" label="路径" min-width="160" />
                      <el-table-column prop="operationId" label="operationId" min-width="140" />
                      <el-table-column prop="summary" label="说明" min-width="140" show-overflow-tooltip />
                    </el-table>
                  </el-collapse-item>
                  <el-collapse-item title="原始 JSON（只读）" name="json">
                    <pre class="json-view mono">{{ JSON.stringify(selectedArtifact.content, null, 2) }}</pre>
                  </el-collapse-item>
                </el-collapse>
              </div>
            </el-card>
            <EmptyState v-else description="左侧选择一份契约" />
          </el-col>
        </el-row>
      </el-tab-pane>

      <!-- 文档与 Mock -->
      <el-tab-pane label="文档与 Mock" name="docs">
        <el-alert
          v-if="selectedArtifact && selectedArtifact.status !== 'published'"
          type="warning"
          :closable="false"
          show-icon
          title="当前契约尚未发布，Mock 只会使用已发布版本"
          class="stack-gap"
        />
        <div class="toolbar">
          <el-button type="primary" plain :disabled="!selectedArtifact" @click="openDocument">
            打开接口文档
          </el-button>
          <el-button plain :disabled="!selectedArtifact" @click="loadReferences">刷新引用</el-button>
        </div>

        <el-table :data="contractOperations" size="small">
          <el-table-column prop="method" label="方法" width="90" />
          <el-table-column prop="pathname" label="路径" min-width="160" />
          <el-table-column prop="operationId" label="operationId" min-width="140" />
          <el-table-column label="Mock URL" min-width="260">
            <template #default="{ row }">
              <span class="mono">{{ mockUrl(row) }}</span>
              <el-button size="small" text @click="copy(mockUrl(row))">复制</el-button>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="110">
            <template #default="{ row }">
              <el-button size="small" @click="tryMock(row)">试一下</el-button>
            </template>
          </el-table-column>
        </el-table>
        <EmptyState v-if="!contractOperations.length" description="选择一份契约后可查看接口与 Mock" />
      </el-tab-pane>

      <!-- 引用关系 -->
      <el-tab-pane label="引用关系" name="references">
        <div class="toolbar">
          <el-button plain :loading="referenceLoading" :disabled="!selectedArtifact" @click="loadReferences">
            刷新引用
          </el-button>
        </div>

        <el-row :gutter="16">
          <el-col :span="12">
            <el-card shadow="never">
              <template #header>引用该契约的任务</template>
              <el-table :data="references?.tasks || []" size="small">
                <el-table-column prop="task_id" label="任务" min-width="150" show-overflow-tooltip />
                <el-table-column prop="purpose" label="目标" min-width="180" show-overflow-tooltip />
                <el-table-column prop="status" label="状态" width="100" />
              </el-table>
              <EmptyState v-if="!references?.tasks?.length" description="暂无引用" />
            </el-card>
          </el-col>
          <el-col :span="12">
            <el-card shadow="never">
              <template #header>引用该契约的提交</template>
              <el-table :data="references?.submissions || []" size="small">
                <el-table-column prop="submission_id" label="提交" min-width="150" show-overflow-tooltip />
                <el-table-column prop="submitted_by" label="提交人" width="120" />
                <el-table-column label="时间" width="160">
                  <template #default="{ row }">{{ formatTime(row.submitted_at) }}</template>
                </el-table-column>
              </el-table>
              <EmptyState v-if="!references?.submissions?.length" description="暂无引用" />
            </el-card>
          </el-col>
        </el-row>

        <el-card v-if="references" shadow="never" class="detail-card">
          <template #header>访问路径</template>
          <div class="ref-row">
            <span class="muted">文档</span>
            <span class="mono">{{ references.document_path }}</span>
            <el-button size="small" text @click="copy(references.document_path)">复制</el-button>
          </div>
          <div class="ref-row">
            <span class="muted">Mock</span>
            <span class="mono">{{ references.mock_path || '契约中没有 2xx operation' }}</span>
            <el-button
              v-if="references.mock_path"
              size="small"
              text
              @click="copy(references.mock_path)"
            >
              复制
            </el-button>
          </div>
        </el-card>
      </el-tab-pane>
    </el-tabs>

    <!-- 新建约定包 -->
    <el-dialog v-model="packDialog" title="新建约定包" width="760px">
      <el-form label-width="96px">
        <el-form-item label="名称">
          <el-input v-model="packForm.name" placeholder="例如：API 约定" />
        </el-form-item>
        <el-form-item label="说明">
          <el-input v-model="packForm.description" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item label="创建人">
          <el-input v-model="packForm.created_by" placeholder="可选" />
        </el-form-item>
        <el-form-item label="规则">
          <div class="rule-editor">
            <div v-for="(rule, index) in packForm.rules" :key="index" class="rule-editor-row">
              <el-input v-model="rule.key" placeholder="key，如 api.response" style="width: 200px" />
              <el-input v-model="rule.title" placeholder="标题" style="width: 150px" />
              <el-select v-model="rule.severity" style="width: 120px">
                <el-option label="must" value="must" />
                <el-option label="should" value="should" />
                <el-option label="preference" value="preference" />
              </el-select>
              <el-input
                v-model="rule.value"
                type="textarea"
                :rows="2"
                placeholder='JSON，如 {"fields":["status","message","data"]}'
                style="width: 260px"
              />
              <el-button size="small" text type="danger" @click="removeRule(index)">删除</el-button>
            </div>
            <el-button size="small" plain @click="addRule">添加规则</el-button>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="packDialog = false">取消</el-button>
        <el-button type="primary" :loading="packSaving" @click="submitPack">创建草稿</el-button>
      </template>
    </el-dialog>

    <!-- 新建模板 -->
    <el-dialog v-model="templateDialog" title="新建编排模板" width="720px">
      <el-form label-width="96px">
        <el-form-item label="名称">
          <el-input v-model="templateForm.name" placeholder="例如：contract-first-api" />
        </el-form-item>
        <el-form-item label="类型">
          <el-input v-model="templateForm.kind" placeholder="api-development" />
        </el-form-item>
        <el-form-item label="创建人">
          <el-input v-model="templateForm.created_by" placeholder="可选" />
        </el-form-item>
        <el-form-item label="节点">
          <el-input v-model="templateForm.nodes" type="textarea" :rows="12" class="mono" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="templateDialog = false">取消</el-button>
        <el-button type="primary" :loading="templateSaving" @click="submitTemplate">创建草稿</el-button>
      </template>
    </el-dialog>

    <!-- 新建契约 -->
    <el-dialog v-model="artifactDialog" title="新建 API 契约" width="820px">
      <el-form label-width="96px">
        <el-form-item label="名称">
          <el-input v-model="artifactForm.name" placeholder="例如：订单 API" />
        </el-form-item>
        <el-form-item label="创建人">
          <el-input v-model="artifactForm.created_by" placeholder="可选" />
        </el-form-item>
        <el-form-item label="契约 JSON">
          <el-input v-model="artifactForm.content" type="textarea" :rows="16" class="mono" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="artifactDialog = false">取消</el-button>
        <el-button type="primary" :loading="artifactSaving" @click="submitArtifact">创建草稿</el-button>
      </template>
    </el-dialog>

    <!-- Mock 试一下 -->
    <el-dialog v-model="mockDialog" title="Mock 响应" width="680px">
      <div v-loading="mockLoading">
        <div class="ref-row">
          <span class="muted">URL</span>
          <span class="mono">{{ mockResult.url }}</span>
        </div>
        <div v-if="mockResult.status !== null" class="ref-row">
          <span class="muted">状态码</span>
          <el-tag :type="mockResult.status >= 200 && mockResult.status < 300 ? 'success' : 'danger'" size="small">
            {{ mockResult.status }}
          </el-tag>
        </div>
        <pre class="json-view mono">{{ mockResult.body }}</pre>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.detail-card {
  margin-top: 16px;
}
.card-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.rule-group-title {
  margin-left: 8px;
  color: #909399;
  font-size: 12px;
}
.rule-row {
  padding: 6px 0;
  border-bottom: 1px dashed #ebeef5;
}
.rule-key {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  color: #606266;
}
.rule-title {
  font-weight: 600;
  margin: 2px 0;
}
.rule-value {
  font-size: 12px;
  color: #909399;
  word-break: break-all;
}
.rule-rationale {
  font-size: 12px;
  color: #606266;
}
.dag-node {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.validation-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.violation-group {
  margin-bottom: 8px;
}
.violation-group ul {
  margin: 4px 0 0;
  padding-left: 20px;
  font-size: 13px;
}
.json-view {
  max-height: 360px;
  overflow: auto;
  background: #f5f7fa;
  padding: 10px;
  border-radius: 4px;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}
.ref-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.rule-editor {
  width: 100%;
}
.rule-editor-row {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.stack-gap {
  margin-bottom: 12px;
}
</style>
