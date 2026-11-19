<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, errorMessage } from '../api.js';
import { formatTime } from '../status.js';
import EmptyState from '../components/EmptyState.vue';
import IdText from '../components/IdText.vue';
import { go } from '../nav.js';

const route = useRoute();
const router = useRouter();
const projectId = route.params.id;

const KIND_TEXT = {
  meeting: '会议纪要',
  design: '设计文档',
  chat: '聊天记录',
  doc: '正式文档',
  other: '其他',
};
const EXTRACTION_TEXT = { requirement: '需求', convention: '约定', decision: '决定' };
const STATUS_TAG = { draft: 'info', accepted: 'success', rejected: 'danger' };
const STATUS_TEXT = { draft: '草稿', accepted: '已采纳', rejected: '已拒绝' };
const SEVERITY_TAG = { must: 'danger', should: 'warning', preference: 'info' };

const materials = ref([]);
const loading = ref(false);
const selectedId = ref('');
const detail = ref(null);
const detailLoading = ref(false);
const extracting = ref(false);
const accepting = reactive({});
const aiConfigured = ref(true);

const dialogVisible = ref(false);
const saving = ref(false);
const form = reactive({
  title: '',
  kind: 'meeting',
  source_ref: '',
  content: '',
  created_by: '',
});
const rules = {
  title: [{ required: true, message: '请填写材料标题', trigger: 'blur' }],
  content: [{ required: true, message: '请粘贴材料原文', trigger: 'blur' }],
};

const extractions = computed(() => detail.value?.extractions || []);
const grouped = computed(() => ['requirement', 'convention', 'decision'].map((kind) => ({
  kind,
  label: EXTRACTION_TEXT[kind],
  rows: extractions.value.filter((item) => item.kind === kind),
})).filter((group) => group.rows.length > 0));

async function load() {
  loading.value = true;
  try {
    materials.value = await api.listMaterials({ project_id: projectId });
    if (!selectedId.value && materials.value.length) selectedId.value = materials.value[0].material_id;
    if (selectedId.value && !materials.value.some((item) => item.material_id === selectedId.value)) {
      selectedId.value = materials.value[0]?.material_id || '';
    }
  } catch (err) {
    ElMessage.error(errorMessage(err, '加载材料失败'));
  } finally {
    loading.value = false;
  }
}

async function loadDetail() {
  if (!selectedId.value) { detail.value = null; return; }
  detailLoading.value = true;
  try {
    detail.value = await api.getMaterial(selectedId.value);
  } catch (err) {
    detail.value = null;
    ElMessage.error(errorMessage(err, '加载材料详情失败'));
  } finally {
    detailLoading.value = false;
  }
}

async function onSelect(id) {
  selectedId.value = id;
  await loadDetail();
}

const EXAMPLE_CONTENT = [
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

const seeding = ref(false);

async function seedMaterial() {
  seeding.value = true;
  try {
    await api.createMaterial({
      project_id: projectId,
      title: '订单导出与接口前缀调整（示例纪要）',
      kind: 'meeting',
      source_ref: 'demo://meeting/2026-11-19',
      created_by: '面板',
      content: EXAMPLE_CONTENT,
    });
    await load();
    if (materials.value.length) {
      selectedId.value = materials.value[0].material_id;
      await loadDetail();
    }
  } catch (err) {
    ElMessage.error(errorMessage(err, '创建示例材料失败'));
  } finally {
    seeding.value = false;
  }
}

function openCreate() {
  Object.assign(form, {
    title: '订单导出与接口前缀调整（示例纪要）',
    kind: 'meeting',
    source_ref: '',
    content: EXAMPLE_CONTENT,
    created_by: '',
  });
  dialogVisible.value = true;
}

async function submitCreate() {
  saving.value = true;
  try {
    const created = await api.createMaterial({
      project_id: projectId,
      title: form.title,
      kind: form.kind,
      source_ref: form.source_ref || undefined,
      content: form.content,
      created_by: form.created_by || '面板',
    });
    ElMessage.success(`材料已导入：${created.material_id}`);
    dialogVisible.value = false;
    await load();
    await onSelect(created.material_id);
  } catch (err) {
    ElMessage.error(errorMessage(err, '导入材料失败'));
  } finally {
    saving.value = false;
  }
}

async function checkAi() {
  try {
    const health = await api.getAiHealth();
    aiConfigured.value = Boolean(health.configured);
  } catch {
    aiConfigured.value = false;
  }
}

async function runExtract() {
  if (!selectedId.value) return;
  extracting.value = true;
  try {
    const result = await api.extractMaterial(selectedId.value, { created_by: '面板' });
    const count = result.extractions?.length || 0;
    ElMessage.success(count ? `已提取 ${count} 条草稿（未生效）` : '未提取到可采纳内容');
    if (result.uncertainties?.length) {
      ElMessage.warning(`有 ${result.uncertainties.length} 条未决项，见结果下方`);
    }
    await loadDetail();
    await load();
  } catch (err) {
    if (err.code === 'AI_NOT_CONFIGURED') {
      aiConfigured.value = false;
      ElMessage.warning('Center 未配置模型，无法提取。请先在设置页填写模型。');
    } else {
      ElMessage.error(errorMessage(err, 'AI 提取失败'));
    }
  } finally {
    extracting.value = false;
  }
}

async function accept(row) {
  accepting[row.extraction_id] = true;
  try {
    const result = await api.acceptExtraction(row.extraction_id, { actor: '面板' });
    const created = result.created || {};
    const ref = created.requirement_id || created.pack_id || '';
    const label = result.kind === 'convention' ? '约定草稿' : '需求';
    ElMessage.success(`已采纳，生成${label}：${ref}`);
    await loadDetail();
    await load();
    if (result.kind === 'requirement' && created.requirement_id) {
      go(router, 'requirement-detail', { id: projectId, requirementId: created.requirement_id });
    }
  } catch (err) {
    ElMessage.error(errorMessage(err, '采纳失败'));
  } finally {
    accepting[row.extraction_id] = false;
  }
}

async function reject(row) {
  let reason = '';
  try {
    const result = await ElMessageBox.prompt('请说明拒绝理由（会写入事件记录）', '拒绝提取', {
      inputPlaceholder: '例如：材料里只是讨论，并未形成结论',
      inputValidator: (value) => (value && value.trim() ? true : '理由不能为空'),
    });
    reason = result.value.trim();
  } catch {
    return;
  }
  accepting[row.extraction_id] = true;
  try {
    await api.rejectExtraction(row.extraction_id, { actor: '面板', reason });
    ElMessage.success('已拒绝');
    await loadDetail();
  } catch (err) {
    ElMessage.error(errorMessage(err, '拒绝失败'));
  } finally {
    accepting[row.extraction_id] = false;
  }
}

onMounted(async () => {
  await load();
  await loadDetail();
  await checkAi();
});
</script>

<template>
  <div class="page" v-loading="loading">
    <div class="page-header">
      <div>
        <h2 class="page-title">材料与提取</h2>
      </div>
      <div class="toolbar">
        <el-tag :type="aiConfigured ? 'success' : 'info'" effect="light">
          {{ aiConfigured ? 'AI 可用' : 'AI 未配置' }}
        </el-tag>
        <el-button type="primary" @click="openCreate">
          <el-icon><Plus /></el-icon>
          导入材料
        </el-button>
      </div>
    </div>

    <EmptyState
      v-if="!loading && materials.length === 0"
      description=""
    >
      <el-button type="primary" plain :loading="seeding" @click="seedMaterial">创建示例材料</el-button>
      <el-button plain @click="openCreate">导入材料</el-button>
    </EmptyState>

    <el-row v-else :gutter="16">
      <el-col :xs="24" :md="7">
        <el-card shadow="never" class="list-card">
          <template #header>
            <div class="card-head">
              <span>材料（{{ materials.length }}）</span>
              <el-button text size="small" @click="load">刷新</el-button>
            </div>
          </template>
          <el-scrollbar height="560px">
            <div
              v-for="item in materials"
              :key="item.material_id"
              class="material-item"
              :class="{ active: item.material_id === selectedId }"
              @click="onSelect(item.material_id)"
            >
              <div class="material-title">{{ item.title }}</div>
              <div class="material-meta">
                <el-tag size="small" effect="plain">{{ KIND_TEXT[item.kind] || item.kind }}</el-tag>
                <span class="muted">{{ formatTime(item.created_at) }}</span>
              </div>
            </div>
          </el-scrollbar>
        </el-card>
      </el-col>

      <el-col :xs="24" :md="17">
        <el-card shadow="never" v-loading="detailLoading">
          <template #header>
            <div class="card-head">
              <span>原文与提取结果</span>
              <div>
                <el-tooltip
                  :content="aiConfigured ? '把材料拆成需求/约定/决定草稿' : '未配置模型，无法提取'"
                  placement="top"
                >
                  <span>
                    <el-button
                      type="primary"
                      plain
                      size="small"
                      :disabled="!selectedId || !aiConfigured"
                      :loading="extracting"
                      @click="runExtract"
                    >
                      AI 提取
                    </el-button>
                  </span>
                </el-tooltip>
              </div>
            </div>
          </template>

          <EmptyState v-if="!detail" description="未选择材料" />

          <div v-else>
            <el-descriptions :column="2" size="small" border>
              <el-descriptions-item label="标题">{{ detail.title }}</el-descriptions-item>
              <el-descriptions-item label="类型">{{ KIND_TEXT[detail.kind] || detail.kind }}</el-descriptions-item>
              <el-descriptions-item label="来源">{{ detail.source_ref || '—' }}</el-descriptions-item>
              <el-descriptions-item label="导入人">{{ detail.created_by }}</el-descriptions-item>
            </el-descriptions>

            <el-collapse class="source-block">
              <el-collapse-item title="材料原文（不摘要替代）" name="source">
                <pre class="source-text">{{ detail.content }}</pre>
              </el-collapse-item>
            </el-collapse>

            <el-divider content-position="left">提取结果（草稿）</el-divider>

            <EmptyState
              v-if="extractions.length === 0"
              description="没有提取结果"
            />

            <div v-for="group in grouped" :key="group.kind" class="extraction-group">
              <div class="group-title">{{ group.label }}（{{ group.rows.length }}）</div>
              <el-card
                v-for="row in group.rows"
                :key="row.extraction_id"
                shadow="hover"
                class="extraction-card"
              >
                <div class="card-head">
                  <el-tag :type="STATUS_TAG[row.status]" size="small">
                    {{ STATUS_TEXT[row.status] }}
                  </el-tag>
                  <IdText :id="row.extraction_id" muted />
                </div>

                <template v-if="row.kind === 'requirement'">
                  <div class="draft-text">{{ row.payload.raw_text }}</div>
                  <div v-if="row.payload.claimed_level" class="muted">
                    自报等级：{{ row.payload.claimed_level }}
                    <span v-if="row.payload.claimed_reason">（{{ row.payload.claimed_reason }}）</span>
                  </div>
                </template>

                <template v-else-if="row.kind === 'convention'">
                  <div class="draft-text">{{ row.payload.name }}</div>
                  <div v-for="rule in row.payload.rules" :key="rule.key" class="rule-line">
                    <el-tag :type="SEVERITY_TAG[rule.severity]" size="small">{{ rule.severity }}</el-tag>
                    <span class="mono">{{ rule.key }}</span>
                    <span>{{ rule.title }}</span>
                  </div>
                </template>

                <template v-else>
                  <div class="draft-text">{{ row.payload.question }}</div>
                  <div v-if="row.payload.chosen" class="muted">倾向：{{ row.payload.chosen }}</div>
                  <el-alert
                    v-if="row.payload.pending_decision"
                    type="warning"
                    :closable="false"
                    show-icon
                    title="需正式决定"
                  />
                </template>

                <el-alert
                  v-if="row.payload.source_quote"
                  type="info"
                  :closable="false"
                  class="quote"
                  :title="`出处：${row.payload.source_quote}`"
                />

                <div class="card-actions">
                  <el-button
                    v-if="row.status === 'draft'"
                    type="primary"
                    size="small"
                    :loading="accepting[row.extraction_id]"
                    @click="accept(row)"
                  >
                    采纳
                  </el-button>
                  <el-button
                    v-if="row.status === 'draft'"
                    size="small"
                    :loading="accepting[row.extraction_id]"
                    @click="reject(row)"
                  >
                    拒绝
                  </el-button>
                  <el-button
                    v-if="row.accepted_ref && row.kind === 'requirement'"
                    size="small"
                    text
                    @click="go(router, 'requirement-detail', { id: projectId, requirementId: row.accepted_ref })"
                  >
                    查看需求
                  </el-button>
                  <span v-if="row.accepted_ref" class="muted mono">已生成：{{ row.accepted_ref }}</span>
                </div>
              </el-card>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-dialog v-model="dialogVisible" title="导入材料" width="720px">
      <el-form :model="form" :rules="rules" label-width="92px">
        <el-form-item label="标题" prop="title">
          <el-input v-model="form.title" placeholder="例如：3 月 12 日需求评审会纪要" />
        </el-form-item>
        <el-form-item label="类型">
          <el-select v-model="form.kind" style="width: 200px">
            <el-option
              v-for="(text, value) in KIND_TEXT"
              :key="value"
              :label="text"
              :value="value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="来源">
          <el-input v-model="form.source_ref" placeholder="可选：文件路径或链接" />
        </el-form-item>
        <el-form-item label="原文" prop="content">
          <el-input
            v-model="form.content"
            type="textarea"
            :rows="14"
            placeholder="粘贴会议纪要、设计文档或聊天记录原文；保留原话，不用改写。"
          />
        </el-form-item>
        <el-form-item label="导入人">
          <el-input v-model="form.created_by" placeholder="可选，具名人员" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submitCreate">导入</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.list-card :deep(.el-card__body) {
  padding: 8px;
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.material-item {
  padding: 10px 12px;
  border-radius: 6px;
  cursor: pointer;
  border: 1px solid transparent;
}

.material-item:hover {
  background: var(--el-fill-color-light);
}

.material-item.active {
  background: var(--el-color-primary-light-9);
  border-color: var(--el-color-primary-light-7);
}

.material-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 6px;
}

.material-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.source-block {
  margin-top: 12px;
}

.source-text {
  margin: 0;
  padding: 12px;
  background: var(--el-fill-color-lighter);
  border-radius: 6px;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12px;
  max-height: 320px;
  overflow: auto;
}

.extraction-group {
  margin-bottom: 12px;
}

.group-title {
  font-weight: 600;
  margin: 12px 0 8px;
}

.extraction-card {
  margin-bottom: 10px;
}

.draft-text {
  margin: 8px 0;
  font-size: 14px;
  line-height: 1.6;
}

.rule-line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  margin-bottom: 4px;
}

.quote {
  margin-top: 8px;
}

.card-actions {
  margin-top: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12px;
}

.muted {
  color: var(--el-text-color-secondary);
}
</style>
