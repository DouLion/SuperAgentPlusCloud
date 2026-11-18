<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api, errorMessage } from '../api.js';
import { formatTime, OPTIONS, TRUNK_KIND_TEXT } from '../status.js';
import StatusTag from '../components/StatusTag.vue';
import SuggestionCard from '../components/SuggestionCard.vue';
import EmptyState from '../components/EmptyState.vue';
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
                <span class="muted mono">依据：{{ advice.suggestion.suggestion_id }}</span>
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
