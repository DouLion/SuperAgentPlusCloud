<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api, errorMessage } from '../api.js';
import { formatTime, OPTIONS, TRUNK_KIND_TEXT } from '../status.js';
import StatusTag from '../components/StatusTag.vue';
import SuggestionCard from '../components/SuggestionCard.vue';
import EmptyState from '../components/EmptyState.vue';
import IdText from '../components/IdText.vue';
import { go } from '../nav.js';

const route = useRoute();
const router = useRouter();
const projectId = route.params.id;
const requirementId = route.params.requirementId;

const loading = ref(false);
const requirement = ref(null);
const assessments = ref([]);
const decisions = ref([]);
const timeline = ref([]);
const tasks = ref([]);
const activeItems = ref([]);

const advice = ref(null);
const adviceLoading = ref(false);
const adviceError = ref('');

const plan = ref(null);
const planLoading = ref(false);
const planError = ref('');
const planAdopting = ref(false);

const adoptForm = reactive({
  assessed_level: '',
  related_item_ids: [],
  impact_summary: '',
  uncertainties: '',
  proposed_action: '',
  assessor_id: '',
});

const assessForm = reactive({
  assessed_level: 'undecided',
  proposed_action: '',
  related_item_ids: [],
  impact_summary: '',
  uncertainties: '',
  assessor_id: '',
  assessor_type: 'human',
});
const assessSubmitting = ref(false);

const decisionForm = reactive({
  conclusion: '',
  final_level: '',
  reason: '',
  confirmed_by: '',
});
const decisionSubmitting = ref(false);

const levelMismatch = computed(() => {
  const claimed = requirement.value?.claimed_level;
  const final = requirement.value?.final_level;
  return Boolean(claimed && final && claimed !== final);
});

const relatedItemOptions = computed(() => {
  const ids = new Set(activeItems.value.map((item) => item.item_id));
  for (const id of adoptForm.related_item_ids) ids.add(id);
  for (const id of assessForm.related_item_ids) ids.add(id);
  for (const id of requirement.value?.related_item_ids || []) ids.add(id);
  return [...ids].map((id) => {
    const item = activeItems.value.find((entry) => entry.item_id === id);
    return {
      value: id,
      label: item ? `${id}（${TRUNK_KIND_TEXT[item.kind] || item.kind}）` : id,
    };
  });
});

const decisionReady = computed(() => {
  const { conclusion, final_level, reason, confirmed_by } = decisionForm;
  if (!conclusion || !confirmed_by) return false;
  if ((conclusion === 'accepted' || conclusion === 'relevelled') && !final_level) return false;
  if (conclusion === 'relevelled' && !reason.trim()) return false;
  return true;
});

const decisionHint = computed(() => {
  const { conclusion, final_level, reason, confirmed_by } = decisionForm;
  if (!conclusion) return '请选择决定结论';
  if (!confirmed_by) return '请填写确认人（决定必须由具名人员确认）';
  if ((conclusion === 'accepted' || conclusion === 'relevelled') && !final_level) {
    return '结论为接受/改级时必须给出最终等级';
  }
  if (conclusion === 'relevelled' && !reason.trim()) return '结论为改级时必须填写改级理由';
  return '';
});

async function load() {
  loading.value = true;
  try {
    const [requirementRow, assessmentRows, decisionRows, timelineRows, taskRows] = await Promise.all([
      api.getRequirement(requirementId),
      api.listAssessments(requirementId),
      api.listDecisions(requirementId),
      api.getRequirementTimeline(requirementId),
      api.listTasks({ requirement_id: requirementId }).catch(() => []),
    ]);
    requirement.value = requirementRow;
    assessments.value = assessmentRows;
    decisions.value = decisionRows;
    timeline.value = timelineRows;
    tasks.value = taskRows;
    activeItems.value = await api.listTrunkItems({
      project_id: requirementRow.project_id,
      status: 'active',
    }).catch(() => []);
  } catch (err) {
    ElMessage.error(errorMessage(err, '加载需求详情失败'));
  } finally {
    loading.value = false;
  }
  loadWorkflowOptions();
}

function applyAdvice(draft) {
  if (!draft) return;
  adoptForm.assessed_level = draft.assessed_level || 'undecided';
  adoptForm.related_item_ids = [...(draft.related_item_ids || [])];
  adoptForm.impact_summary = draft.impact_summary || '';
  adoptForm.uncertainties = (draft.uncertainties || []).join('\n');
  adoptForm.proposed_action = draft.proposed_action || '';
}

async function generateAdvice() {
  adviceLoading.value = true;
  adviceError.value = '';
  try {
    const result = await api.adviseRequirement(requirementId);
    advice.value = result;
    applyAdvice(result.draft);
    ElMessage.success(`已生成评估建议：${result.suggestion.suggestion_id}（未生效）`);
  } catch (err) {
    adviceError.value = errorMessage(err, '生成评估建议失败');
  } finally {
    adviceLoading.value = false;
  }
}

async function adoptAdvice() {
  const uncertainties = adoptForm.uncertainties.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (adoptForm.assessed_level !== 'undecided' && adoptForm.related_item_ids.length === 0) {
    ElMessage.error('评估必须引用相关主干条目；信息不足时请使用 assessed_level=undecided');
    return;
  }
  assessSubmitting.value = true;
  try {
    await api.createAssessment(requirementId, {
      assessed_level: adoptForm.assessed_level || 'undecided',
      proposed_action: adoptForm.proposed_action || undefined,
      related_item_ids: adoptForm.related_item_ids,
      impact_summary: adoptForm.impact_summary || undefined,
      uncertainties,
      assessor_type: 'human',
      assessor_id: adoptForm.assessor_id || undefined,
    });
    ElMessage.success('已按建议记录人工评估（建议被采纳并转为已确认评估）');
    await load();
  } catch (err) {
    ElMessage.error(errorMessage(err, '采纳建议失败'));
  } finally {
    assessSubmitting.value = false;
  }
}

async function submitAssessment() {
  const uncertainties = assessForm.uncertainties.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (assessForm.assessed_level !== 'undecided' && assessForm.related_item_ids.length === 0) {
    ElMessage.error('评估必须引用相关主干条目；信息不足时请使用 assessed_level=undecided');
    return;
  }
  assessSubmitting.value = true;
  try {
    await api.createAssessment(requirementId, {
      assessed_level: assessForm.assessed_level,
      proposed_action: assessForm.proposed_action || undefined,
      related_item_ids: assessForm.related_item_ids,
      impact_summary: assessForm.impact_summary || undefined,
      uncertainties,
      assessor_type: assessForm.assessor_type,
      assessor_id: assessForm.assessor_id || undefined,
    });
    ElMessage.success('人工评估已记录');
    await load();
  } catch (err) {
    ElMessage.error(errorMessage(err, '记录评估失败'));
  } finally {
    assessSubmitting.value = false;
  }
}

async function submitDecision() {
  decisionSubmitting.value = true;
  try {
    await api.createDecision(requirementId, {
      conclusion: decisionForm.conclusion,
      final_level: decisionForm.final_level || undefined,
      reason: decisionForm.reason || undefined,
      confirmed_by: decisionForm.confirmed_by,
    });
    ElMessage.success('决定已记录，需求状态已同步');
    Object.assign(decisionForm, { conclusion: '', final_level: '', reason: '', confirmed_by: '' });
    await load();
  } catch (err) {
    ElMessage.error(errorMessage(err, '记录决定失败'));
  } finally {
    decisionSubmitting.value = false;
  }
}

async function generatePlan() {
  planLoading.value = true;
  planError.value = '';
  try {
    const result = await api.planRequirement(requirementId);
    plan.value = result;
    ElMessage.success(`已生成任务草稿：${result.suggestion.suggestion_id}（未生效）`);
  } catch (err) {
    planError.value = errorMessage(err, '生成任务草稿失败');
  } finally {
    planLoading.value = false;
  }
}

async function adoptPlan() {
  if (!plan.value || plan.value.draft.length === 0) {
    ElMessage.warning('任务草稿为空，无可创建的任务');
    return;
  }
  planAdopting.value = true;
  try {
    const created = await api.createRequirementTasks(requirementId, {
      tasks: plan.value.draft.map((item) => ({ ...item })),
      created_by: adoptForm.assessor_id || undefined,
    });
    ElMessage.success(`已按草稿创建并开放 ${created.length} 个任务`);
    plan.value = null;
    await load();
  } catch (err) {
    ElMessage.error(errorMessage(err, '采纳任务草稿失败'));
  } finally {
    planAdopting.value = false;
  }
}

function openTask(row) {
  go(router, 'task-detail', { id: projectId, taskId: row.task_id });
}

// ------------------------------------------------------------ 契约编排建议（T14）
const orchestration = ref(null);
const orchestrationLoading = ref(false);
const orchestrationError = ref('');
const orchestrationAdopting = ref(false);
const orchestrationForm = reactive({ contract_name: '', created_by: '' });
const workflowOptions = ref([]);

const orchestrationChecks = computed(() => {
  const checks = orchestration.value?.draft?.convention_checks
    || orchestration.value?.validation?.violations
    || [];
  const groups = { must: [], should: [], preference: [] };
  for (const check of checks) {
    const severity = check.severity || 'must';
    if (!groups[severity]) continue;
    groups[severity].push(check);
  }
  return Object.entries(groups)
    .filter(([, items]) => items.length > 0)
    .map(([severity, items]) => ({ severity, items }));
});

const orchestrationAdoptable = computed(() => orchestration.value?.draft?.adoptable !== false);

async function loadWorkflowOptions() {
  try {
    const rows = await api.listWorkflowTemplates({ project_id: projectId, status: 'active' });
    workflowOptions.value = rows;
  } catch {
    workflowOptions.value = [];
  }
}

async function generateOrchestration() {
  orchestrationLoading.value = true;
  orchestrationError.value = '';
  try {
    const result = await api.orchestrateRequirement(requirementId, {
      workflow_template_id: orchestrationForm.workflow_template_id || undefined,
    });
    orchestration.value = result;
    if (!orchestrationForm.contract_name) {
      orchestrationForm.contract_name = `${requirement.value?.raw_text?.slice(0, 20) || '需求'} 契约`;
    }
    ElMessage.success('已生成契约编排建议（未生效）');
  } catch (err) {
    orchestrationError.value = errorMessage(err, '生成契约编排建议失败');
  } finally {
    orchestrationLoading.value = false;
  }
}

async function adoptOrchestration() {
  if (!orchestration.value) return;
  if (!orchestrationAdoptable.value) {
    ElMessage.warning('存在 must 违规或未决项，暂不能采纳');
    return;
  }
  orchestrationAdopting.value = true;
  try {
    await api.adoptOrchestration(orchestration.value.suggestion.suggestion_id, {
      created_by: orchestrationForm.created_by || '面板',
      contract_name: orchestrationForm.contract_name || '接口契约',
    });
    ElMessage.success('已采纳：创建了契约草稿与任务');
    orchestration.value = null;
    await load();
  } catch (err) {
    ElMessage.error(errorMessage(err, '采纳编排建议失败'));
  } finally {
    orchestrationAdopting.value = false;
  }
}

watch(
  () => advice.value,
  (value) => {
    if (value) applyAdvice(value.draft);
  },
);

onMounted(() => {
  if (!requirementId) {
    go(router, 'projects');
    return;
  }
  load();
});
</script>

<template>
  <div class="page" v-loading="loading">
    <div class="page-header">
      <div>
        <h2 class="page-title">需求详情与决定</h2>
        <div class="page-subtitle mono">{{ requirementId }}</div>
      </div>
      <el-button size="small" @click="load">
        <el-icon><Refresh /></el-icon>
        刷新
      </el-button>
    </div>

    <EmptyState v-if="!loading && !requirement" description="需求不存在或加载失败" :height="'200px'">
      <el-button @click="go(router, 'projects')">返回项目列表</el-button>
    </EmptyState>

    <template v-else-if="requirement">
      <!-- 原文置顶，不被摘要替代 -->
      <div class="panel original-panel">
        <div class="panel__head">
          <span class="panel__title">原始表达</span>
          <StatusTag group="requirement" :value="requirement.status" size="small" />
        </div>
        <div class="original-text">{{ requirement.raw_text }}</div>
        <div class="queue-item__meta" style="margin-top: 10px">
          <span class="muted">{{ requirement.author || '—' }}</span>
          <span class="muted">{{ formatTime(requirement.created_at) }}</span>
          <span class="muted">来源：{{ requirement.source_ref || '—' }}</span>
        </div>
        <div class="queue-item__meta" style="margin-top: 6px">
          <el-tag size="small" effect="plain" type="info">自报 {{ requirement.claimed_level || '—' }}</el-tag>
          <el-tag size="small" effect="plain" type="info">最终 {{ requirement.final_level || '—' }}</el-tag>
        </div>
        <el-alert
          v-if="levelMismatch"
          type="warning"
          :closable="false"
          show-icon
          style="margin-top: 10px"
          :title="`等级被调整：提交者自报 ${requirement.claimed_level}，最终 ${requirement.final_level}`"
        />
      </div>

      <el-row :gutter="16">
        <el-col :xs="24" :lg="14">
          <SuggestionCard
            class="card-gap"
            title="AI 评估建议，未生效"
            :loading="adviceLoading"
            :error="adviceError"
          >
            <template #actions>
              <el-button size="small" :loading="adviceLoading" @click="generateAdvice">
                生成评估建议
              </el-button>
              <el-button
                size="small"
                type="primary"
                plain
                :disabled="!advice"
                :loading="assessSubmitting"
                @click="adoptAdvice"
              >
                采纳为人工评估
              </el-button>
            </template>
            <template v-if="advice">
              <div class="row">
                <span>建议等级：<strong>{{ advice.draft.assessed_level }}</strong></span>
                <span>建议动作：{{ advice.draft.proposed_action }}</span>
                <span class="muted mono">依据：</span><IdText :id="advice.suggestion.suggestion_id" muted />
              </div>
              <div v-if="advice.draft.related_item_ids.length" class="row">
                <span>依据条目：</span>
                <el-tag v-for="id in advice.draft.related_item_ids" :key="id" size="small" class="mono">
                  {{ id }}
                </el-tag>
              </div>
              <div v-if="advice.draft.impact_summary">影响摘要：{{ advice.draft.impact_summary }}</div>
              <div v-if="(advice.draft.uncertainties || []).length">
                不确定项：{{ advice.draft.uncertainties.join('；') }}
              </div>
            </template>
            <div v-else class="muted">尚未生成建议。建议只是参考，采纳后会转成人工评估。</div>
          </SuggestionCard>

          <div class="panel">
            <div class="panel__head">
              <span class="panel__title">人工评估（已确认，生效）</span>
              <el-button size="small" type="primary" plain :loading="assessSubmitting" @click="submitAssessment">
                保存评估
              </el-button>
            </div>
            <el-form :model="assessForm" label-width="96px">
              <el-form-item label="评估等级">
                <el-select v-model="assessForm.assessed_level">
                  <el-option
                    v-for="value in OPTIONS.assessmentLevels"
                    :key="value"
                    :label="value"
                    :value="value"
                  />
                </el-select>
              </el-form-item>
              <el-form-item label="关联主干">
                <el-select v-model="assessForm.related_item_ids" multiple filterable style="width: 100%">
                  <el-option
                    v-for="option in relatedItemOptions"
                    :key="option.value"
                    :label="option.label"
                    :value="option.value"
                  />
                </el-select>
              </el-form-item>
              <el-form-item label="影响摘要">
                <el-input v-model="assessForm.impact_summary" type="textarea" :rows="2" />
              </el-form-item>
              <el-form-item label="不确定项">
                <el-input v-model="assessForm.uncertainties" type="textarea" :rows="2" placeholder="每行一条" />
              </el-form-item>
              <el-form-item label="评估人">
                <el-input v-model="assessForm.assessor_id" />
              </el-form-item>
            </el-form>
          </div>

          <div class="panel">
            <div class="panel__head">
              <span class="panel__title">决定（人确认后才生效）</span>
            </div>
            <el-form :model="decisionForm" label-width="96px">
              <el-form-item label="结论">
                <el-select v-model="decisionForm.conclusion">
                  <el-option v-for="value in OPTIONS.conclusions" :key="value" :label="value" :value="value" />
                </el-select>
              </el-form-item>
              <el-form-item v-if="['accepted', 'relevelled'].includes(decisionForm.conclusion)" label="最终等级">
                <el-select v-model="decisionForm.final_level">
                  <el-option v-for="value in OPTIONS.levels" :key="value" :label="value" :value="value" />
                </el-select>
              </el-form-item>
              <el-form-item label="确认人">
                <el-input v-model="decisionForm.confirmed_by" />
              </el-form-item>
              <el-form-item label="理由">
                <el-input v-model="decisionForm.reason" type="textarea" :rows="2" />
              </el-form-item>
            </el-form>
            <el-tooltip :disabled="decisionReady" :content="decisionHint" placement="top">
              <span>
                <el-button type="primary" :disabled="!decisionReady" :loading="decisionSubmitting" @click="submitDecision">
                  记录决定
                </el-button>
              </span>
            </el-tooltip>
            <span v-if="decisionHint" class="muted" style="margin-left: 8px">{{ decisionHint }}</span>
          </div>

          <div class="panel">
            <div class="panel__head">
              <span class="panel__title">任务草稿（未生效，采纳后才创建并开放）</span>
              <el-button size="small" :loading="planLoading" @click="generatePlan">生成任务草稿</el-button>
            </div>
            <el-alert
              v-if="planError"
              type="error"
              :closable="false"
              show-icon
              :title="planError"
              style="margin-bottom: 10px"
            />
            <EmptyState v-if="!plan" description="尚未生成任务草稿" :height="'80px'" />
            <div v-else>
              <div v-for="(item, index) in plan.draft" :key="index" class="plan-item">
                <div class="plan-item__head">
                  <strong>{{ item.purpose }}</strong>
                  <el-tag size="small" effect="plain" type="info">服务 {{ (item.serves_item_ids || []).join('，') || '探索任务' }}</el-tag>
                </div>
                <div class="muted">范围：{{ item.scope || '—' }}　非目标：{{ item.non_scope || '—' }}</div>
                <ul class="done-list">
                  <li v-for="(done, i) in item.done_when || []" :key="i">{{ done }}</li>
                </ul>
              </div>
              <el-button type="primary" plain :loading="planAdopting" @click="adoptPlan">
                采纳并创建任务
              </el-button>
            </div>
          </div>

          <div class="panel">
            <div class="panel__head">
              <span class="panel__title">契约编排建议（未生效）</span>
              <span>
                <el-select
                  v-model="orchestrationForm.workflow_template_id"
                  placeholder="编排模板（默认 contract-first-api）"
                  clearable
                  size="small"
                  style="width: 220px; margin-right: 8px"
                >
                  <el-option
                    v-for="item in workflowOptions"
                    :key="item.template_id"
                    :label="item.name"
                    :value="item.template_id"
                  />
                </el-select>
                <el-button size="small" :loading="orchestrationLoading" @click="generateOrchestration">
                  生成编排建议
                </el-button>
              </span>
            </div>
            <el-alert
              v-if="orchestrationError"
              type="error"
              :closable="false"
              show-icon
              :title="orchestrationError"
              style="margin-bottom: 10px"
            />
            <EmptyState v-if="!orchestration" description="尚未生成契约编排建议" :height="'80px'" />
            <div v-else>
              <div class="row">
                <el-tag size="small" type="info">
                  模板：{{ orchestration.draft.workflow_template_id || orchestration.draft.workflow_template?.name || '—' }}
                </el-tag>
                <el-tag v-if="!orchestrationAdoptable" size="small" type="danger">存在 must 违规，不可采纳</el-tag>
                <el-tag v-else size="small" type="success">可采纳</el-tag>
                <IdText :id="orchestration.suggestion.suggestion_id" muted />
              </div>

              <div v-if="orchestrationChecks.length" class="orchestration-checks">
                <div v-for="group in orchestrationChecks" :key="group.severity" class="check-group">
                  <el-tag
                    size="small"
                    :type="group.severity === 'must' ? 'danger' : (group.severity === 'should' ? 'warning' : 'info')"
                  >
                    {{ group.severity }}
                  </el-tag>
                  <ul>
                    <li v-for="(check, index) in group.items" :key="index">
                      {{ check.rule_key || check.key || '规则' }}：{{ check.reason || check.message }}
                      <span v-if="check.result" class="muted">（{{ check.result }}）</span>
                    </li>
                  </ul>
                </div>
              </div>

              <div class="muted">
                契约接口：
                <span class="mono">
                  {{ Object.keys(orchestration.draft.api_contract_draft?.paths || {}).join('，') || '—' }}
                </span>
              </div>

              <div v-for="(task, index) in orchestration.draft.tasks || []" :key="index" class="plan-item">
                <div class="plan-item__head">
                  <strong>{{ task.node_key }} · {{ task.purpose }}</strong>
                  <el-tag size="small" effect="plain" type="info">
                    依赖 {{ (task.depends_on_node_keys || []).join('，') || '无' }}
                  </el-tag>
                </div>
                <div class="muted">
                  服务 {{ (task.serves_item_ids || []).join('，') || '—' }}
                  　产物 {{ (task.expected_outputs || []).join('，') || '—' }}
                </div>
                <ul class="done-list">
                  <li v-for="(done, i) in task.done_when || []" :key="i">{{ done }}</li>
                </ul>
              </div>

              <div v-if="(orchestration.draft.uncertainties || []).length" class="muted">
                未决项：{{ orchestration.draft.uncertainties.join('；') }}
              </div>

              <el-form inline size="small" style="margin-top: 8px">
                <el-form-item label="契约名称">
                  <el-input v-model="orchestrationForm.contract_name" style="width: 220px" />
                </el-form-item>
                <el-form-item label="采纳人">
                  <el-input v-model="orchestrationForm.created_by" placeholder="可选" style="width: 140px" />
                </el-form-item>
              </el-form>
              <el-tooltip
                :disabled="orchestrationAdoptable"
                content="存在 must 违规或未决项，需先修复或补充信息"
              >
                <span>
                  <el-button
                    type="primary"
                    plain
                    :disabled="!orchestrationAdoptable"
                    :loading="orchestrationAdopting"
                    @click="adoptOrchestration"
                  >
                    采纳（创建契约草稿与任务）
                  </el-button>
                </span>
              </el-tooltip>
            </div>
          </div>
        </el-col>

        <el-col :xs="24" :lg="10">
          <div class="panel">
            <div class="panel__head">
              <span class="panel__title">已拆解任务（{{ tasks.length }}）</span>
            </div>
            <EmptyState v-if="tasks.length === 0" description="尚未拆解任务" :height="'100px'" />
            <div
              v-for="task in tasks"
              :key="task.task_id"
              class="queue-item clickable"
              @click="openTask(task)"
            >
              <div class="queue-item__title">{{ task.purpose }}</div>
              <div class="queue-item__meta">
                <StatusTag group="task" :value="task.status" size="small" />
                <span class="muted">服务 {{ (task.serves_item_ids || []).length }} 条主干</span>
              </div>
              <ul class="done-list">
                <li v-for="(done, i) in task.done_when || []" :key="i">{{ done }}</li>
              </ul>
            </div>
          </div>

          <div class="panel">
            <div class="panel__head">
              <span class="panel__title">评估与决定记录</span>
            </div>
            <el-timeline>
              <el-timeline-item
                v-for="item in assessments"
                :key="item.assessment_id"
                :timestamp="formatTime(item.created_at)"
                placement="top"
              >
                <div class="event-head">
                  <el-tag size="small" effect="plain" type="warning">{{ item.assessor_type }}</el-tag>
                  <strong>{{ item.assessed_level }}</strong>
                  <span class="muted">建议 {{ item.proposed_action || '—' }}</span>
                </div>
                <div v-if="item.impact_summary" class="muted">{{ item.impact_summary }}</div>
              </el-timeline-item>
              <el-timeline-item
                v-for="item in decisions"
                :key="item.decision_id"
                :timestamp="formatTime(item.confirmed_at)"
                placement="top"
              >
                <div class="event-head">
                  <strong>{{ item.conclusion }}</strong>
                  <span v-if="item.final_level" class="muted">最终 {{ item.final_level }}</span>
                  <span class="muted">{{ item.confirmed_by }}</span>
                </div>
                <div v-if="item.reason" class="muted">{{ item.reason }}</div>
              </el-timeline-item>
            </el-timeline>
            <el-empty v-if="!assessments.length && !decisions.length" description="暂无记录" :image-size="60" />
          </div>
        </el-col>
      </el-row>
    </template>
  </div>
</template>

<style scoped>
.original-text {
  font-size: 15px;
  line-height: 1.8;
  color: var(--sap-text);
}

.plan-item {
  border: 1px solid var(--sap-border-soft);
  border-radius: 6px;
  padding: 10px;
  margin-bottom: 10px;
}

.plan-item__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.done-list {
  margin: 6px 0 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--sap-text-secondary);
}

.done-list li {
  margin-bottom: 2px;
}
</style>
