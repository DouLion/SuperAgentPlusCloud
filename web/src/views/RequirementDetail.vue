<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api, errorMessage } from '../api.js';
import {
  formatTime,
  OPTIONS,
  TRUNK_KIND_TEXT,
} from '../status.js';
import StatusTag from '../components/StatusTag.vue';
import SuggestionCard from '../components/SuggestionCard.vue';
import EmptyState from '../components/EmptyState.vue';

const route = useRoute();
const router = useRouter();
const requirementId = route.params.id;

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
      api.listTasks({ requirement_id: requirementId }),
    ]);
    requirement.value = requirementRow;
    assessments.value = assessmentRows;
    decisions.value = decisionRows;
    timeline.value = timelineRows;
    tasks.value = taskRows;
    activeItems.value = await api.listTrunkItems({
      project_id: requirementRow.project_id,
      status: 'active',
    });
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
  const uncertainties = adoptForm.uncertainties
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
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
  const uncertainties = assessForm.uncertainties
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
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
  router.push(`/tasks/${row.task_id}`);
}

watch(
  () => advice.value,
  (value) => {
    if (value) applyAdvice(value.draft);
  },
);

onMounted(() => {
  if (!requirementId) {
    router.replace('/projects');
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
      <el-button @click="router.push('/projects')">返回项目列表</el-button>
    </EmptyState>

    <template v-else-if="requirement">
      <el-card shadow="never" class="card-gap">
        <template #header>基本信息</template>
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="原文" :span="2">{{ requirement.raw_text }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            <StatusTag group="requirement" :value="requirement.status" />
          </el-descriptions-item>
          <el-descriptions-item label="自报等级">{{ requirement.claimed_level || '—' }}</el-descriptions-item>
          <el-descriptions-item label="最终等级">{{ requirement.final_level || '—' }}</el-descriptions-item>
          <el-descriptions-item label="提交人">{{ requirement.author || '—' }}</el-descriptions-item>
          <el-descriptions-item label="来源">{{ requirement.source_ref || '—' }}</el-descriptions-item>
          <el-descriptions-item label="提交时间">{{ formatTime(requirement.created_at) }}</el-descriptions-item>
          <el-descriptions-item label="关联条目">
            <span v-if="!(requirement.related_item_ids || []).length">—</span>
            <el-tag
              v-for="id in requirement.related_item_ids"
              :key="id"
              size="small"
              class="relation-tag mono"
            >{{ id }}</el-tag>
          </el-descriptions-item>
        </el-descriptions>
      </el-card>

      <el-row :gutter="16">
        <el-col :xs="24" :lg="14">
          <SuggestionCard
            class="card-gap"
            title="AI 评估建议，未生效"
            :loading="adviceLoading"
            :error="adviceError"
          >
            <template v-if="advice">
              <div class="row">
                <span>建议等级：<strong>{{ advice.draft.assessed_level }}</strong></span>
                <span>建议动作：{{ advice.draft.proposed_action }}</span>
                <span class="muted mono">依据：{{ advice.suggestion.suggestion_id }}</span>
              </div>
              <div v-if="advice.draft.related_item_ids.length" class="row">
                <span>依据条目：</span>
                <el-tag
                  v-for="id in advice.draft.related_item_ids"
                  :key="id"
                  size="small"
                  class="relation-tag mono"
                >{{ id }}</el-tag>
              </div>
              <div v-if="advice.draft.impact_summary">影响摘要：{{ advice.draft.impact_summary }}</div>
              <div v-if="(advice.draft.uncertainties || []).length">
                不确定项：{{ advice.draft.uncertainties.join('；') }}
              </div>
            </template>
            <div v-else-if="!adviceLoading" class="muted">
              尚未生成评估建议。可点击「生成 AI 评估建议」获取模型建议；建议未生效，需人工采纳。
            </div>

            <template #actions>
              <el-button size="small" type="primary" plain :loading="adviceLoading" @click="generateAdvice">
                生成 AI 评估建议
              </el-button>
            </template>
          </SuggestionCard>

          <el-card shadow="never" class="card-gap">
            <template #header>
              <div class="card-header">
                <span>采纳 AI 建议（人工确认后写入评估）</span>
                <span class="muted">可修改等级与关联条目后再采纳</span>
              </div>
            </template>
            <el-form :model="adoptForm" label-width="96px">
              <el-form-item label="评估等级">
                <el-select v-model="adoptForm.assessed_level" style="width: 200px">
                  <el-option
                    v-for="value in OPTIONS.assessmentLevels"
                    :key="value"
                    :label="value"
                    :value="value"
                  />
                </el-select>
              </el-form-item>
              <el-form-item label="建议动作">
                <el-select v-model="adoptForm.proposed_action" clearable style="width: 200px">
                  <el-option
                    v-for="value in OPTIONS.proposedActions"
                    :key="value"
                    :label="value"
                    :value="value"
                  />
                </el-select>
              </el-form-item>
              <el-form-item label="关联条目">
                <el-select
                  v-model="adoptForm.related_item_ids"
                  multiple
                  filterable
                  style="width: 100%"
                  placeholder="选择依据的主干条目"
                >
                  <el-option
                    v-for="option in relatedItemOptions"
                    :key="option.value"
                    :label="option.label"
                    :value="option.value"
                  />
                </el-select>
              </el-form-item>
              <el-form-item label="影响摘要">
                <el-input v-model="adoptForm.impact_summary" type="textarea" :rows="2" />
              </el-form-item>
              <el-form-item label="不确定项">
                <el-input v-model="adoptForm.uncertainties" type="textarea" :rows="2" placeholder="每行一条" />
              </el-form-item>
              <el-form-item label="评估人">
                <el-input v-model="adoptForm.assessor_id" placeholder="可选，具名人员" style="width: 200px" />
              </el-form-item>
              <el-form-item>
                <el-button
                  type="primary"
                  :loading="assessSubmitting"
                  :disabled="!advice"
                  @click="adoptAdvice"
                >
                  采纳并记录评估
                </el-button>
                <el-tooltip
                  v-if="!advice"
                  content="请先生成 AI 评估建议，再采纳"
                  placement="top"
                >
                  <span class="muted" style="margin-left: 8px">未生效建议不能直接采纳</span>
                </el-tooltip>
              </el-form-item>
            </el-form>
          </el-card>

          <el-card shadow="never" class="card-gap">
            <template #header>人工评估（直接填写）</template>
            <el-form :model="assessForm" label-width="96px">
              <el-form-item label="评估者类型">
                <el-radio-group v-model="assessForm.assessor_type">
                  <el-radio-button
                    v-for="value in OPTIONS.assessorTypes"
                    :key="value"
                    :value="value"
                  >{{ value }}</el-radio-button>
                </el-radio-group>
              </el-form-item>
              <el-form-item label="评估等级">
                <el-select v-model="assessForm.assessed_level" style="width: 200px">
                  <el-option
                    v-for="value in OPTIONS.assessmentLevels"
                    :key="value"
                    :label="value"
                    :value="value"
                  />
                </el-select>
              </el-form-item>
              <el-form-item label="建议动作">
                <el-select v-model="assessForm.proposed_action" clearable style="width: 200px">
                  <el-option
                    v-for="value in OPTIONS.proposedActions"
                    :key="value"
                    :label="value"
                    :value="value"
                  />
                </el-select>
              </el-form-item>
              <el-form-item label="关联条目">
                <el-select
                  v-model="assessForm.related_item_ids"
                  multiple
                  filterable
                  style="width: 100%"
                  placeholder="选择依据的主干条目"
                >
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
                <el-input v-model="assessForm.assessor_id" placeholder="可选，具名人员" style="width: 200px" />
              </el-form-item>
              <el-form-item>
                <el-button type="primary" :loading="assessSubmitting" @click="submitAssessment">
                  记录评估
                </el-button>
              </el-form-item>
            </el-form>
          </el-card>

          <el-card shadow="never" class="card-gap">
            <template #header>人工决定</template>
            <el-form :model="decisionForm" label-width="96px">
              <el-form-item label="结论">
                <el-select v-model="decisionForm.conclusion" style="width: 220px">
                  <el-option
                    v-for="value in OPTIONS.conclusions"
                    :key="value"
                    :label="value"
                    :value="value"
                  />
                </el-select>
              </el-form-item>
              <el-form-item label="最终等级">
                <el-select v-model="decisionForm.final_level" clearable style="width: 200px">
                  <el-option v-for="value in OPTIONS.levels" :key="value" :label="value" :value="value" />
                </el-select>
              </el-form-item>
              <el-form-item label="理由">
                <el-input v-model="decisionForm.reason" type="textarea" :rows="2" />
              </el-form-item>
              <el-form-item label="确认人">
                <el-input v-model="decisionForm.confirmed_by" style="width: 220px" placeholder="必填" />
              </el-form-item>
              <el-form-item>
                <el-tooltip :disabled="decisionReady" :content="decisionHint" placement="top">
                  <span>
                    <el-button
                      type="primary"
                      :loading="decisionSubmitting"
                      :disabled="!decisionReady"
                      @click="submitDecision"
                    >
                      记录决定
                    </el-button>
                  </span>
                </el-tooltip>
                <span v-if="!decisionReady" class="muted" style="margin-left: 8px">{{ decisionHint }}</span>
              </el-form-item>
            </el-form>
          </el-card>
        </el-col>

        <el-col :xs="24" :lg="10">
          <el-card shadow="never" class="card-gap">
            <template #header>
              <div class="card-header">
                <span>任务草稿（AI，未生效）</span>
                <el-button size="small" type="primary" plain :loading="planLoading" @click="generatePlan">
                  生成任务草稿
                </el-button>
              </div>
            </template>
            <el-alert
              v-if="planError"
              type="error"
              :title="planError"
              :closable="false"
              show-icon
              style="margin-bottom: 10px"
            />
            <EmptyState
              v-if="!plan && !planLoading"
              description="尚未生成任务草稿；生成后需人工确认才会创建任务"
              :height="'120px'"
            />
            <div v-if="plan && plan.draft.length > 0">
              <div v-for="(task, index) in plan.draft" :key="index" class="plan-task">
                <div><strong>{{ index + 1 }}. {{ task.purpose }}</strong></div>
                <div class="muted">完成条件：{{ (task.done_when || []).join('；') }}</div>
                <div v-if="task.scope" class="muted">范围：{{ task.scope }}</div>
                <div v-if="task.non_scope" class="muted">非范围：{{ task.non_scope }}</div>
                <div v-if="(task.serves_item_ids || []).length" class="muted mono">
                  服务条目：{{ task.serves_item_ids.join('，') }}
                </div>
                <div v-if="task.related_question" class="muted">探索问题：{{ task.related_question }}</div>
              </div>
              <el-button
                type="primary"
                :loading="planAdopting"
                @click="adoptPlan"
              >
                采纳并创建任务
              </el-button>
              <div class="muted" style="margin-top: 6px">
                采纳后任务将创建并进入可认领（open）状态。
              </div>
            </div>
            <EmptyState
              v-else-if="plan && plan.draft.length === 0 && !planLoading"
              description="模型未给出任务草稿"
              :height="'120px'"
            />
          </el-card>

          <el-card shadow="never" class="card-gap">
            <template #header>已关联任务</template>
            <EmptyState v-if="tasks.length === 0" description="该需求还没有任务" :height="'120px'" />
            <el-table v-else :data="tasks" size="small" @row-click="openTask">
              <el-table-column prop="purpose" label="目标" min-width="160" show-overflow-tooltip />
              <el-table-column label="状态" width="110">
                <template #default="{ row }"><StatusTag group="task" :value="row.status" /></template>
              </el-table-column>
            </el-table>
          </el-card>

          <el-card shadow="never" class="card-gap">
            <template #header>评估记录</template>
            <EmptyState v-if="assessments.length === 0" description="还没有评估记录" :height="'120px'" />
            <div v-for="row in assessments" :key="row.assessment_id" class="record">
              <div class="record-head">
                <StatusTag group="assessor" :value="row.assessor_type" />
                <span class="mono">{{ row.assessment_id }}</span>
                <span class="muted">{{ formatTime(row.created_at) }}</span>
              </div>
              <div>等级：{{ row.assessed_level }}　建议动作：{{ row.proposed_action || '—' }}</div>
              <div v-if="(row.related_item_ids || []).length" class="muted mono">
                关联：{{ row.related_item_ids.join('，') }}
              </div>
              <div v-if="row.impact_summary" class="muted">影响：{{ row.impact_summary }}</div>
            </div>
          </el-card>

          <el-card shadow="never" class="card-gap">
            <template #header>决定记录</template>
            <EmptyState v-if="decisions.length === 0" description="还没有决定记录" :height="'120px'" />
            <div v-for="row in decisions" :key="row.decision_id" class="record">
              <div class="record-head">
                <StatusTag group="decision" :value="row.conclusion" />
                <span class="mono">{{ row.decision_id }}</span>
                <span class="muted">{{ formatTime(row.confirmed_at) }}</span>
              </div>
              <div>最终等级：{{ row.final_level || '—' }}　确认人：{{ row.confirmed_by }}</div>
              <div v-if="row.reason" class="muted">理由：{{ row.reason }}</div>
            </div>
          </el-card>

          <el-card shadow="never" class="card-gap">
            <template #header>事件时间线</template>
            <EmptyState v-if="timeline.length === 0" description="暂无事件" :height="'120px'" />
            <el-timeline v-else>
              <el-timeline-item
                v-for="event in timeline"
                :key="event.event_id"
                :timestamp="formatTime(event.occurred_at)"
                placement="top"
              >
                <div><strong>{{ event.event_type }}</strong>
                  <span v-if="event.actor" class="muted">　操作人：{{ event.actor }}</span>
                </div>
                <div v-if="event.reason" class="muted">{{ event.reason }}</div>
              </el-timeline-item>
            </el-timeline>
          </el-card>
        </el-col>
      </el-row>
    </template>
  </div>
</template>

<style scoped>
.relation-tag {
  margin-right: 6px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.plan-task {
  border: 1px solid #e4e7ed;
  border-radius: 6px;
  padding: 8px 10px;
  margin-bottom: 8px;
  background: #fafafa;
}

.record {
  border-top: 1px solid #f0f2f5;
  padding: 8px 0;
}

.record-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
</style>
