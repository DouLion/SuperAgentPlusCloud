<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api, errorMessage } from '../api.js';
import { formatTime, OPTIONS, TRUNK_KIND_TEXT } from '../status.js';
import StatusTag from '../components/StatusTag.vue';
import SuggestionCard from '../components/SuggestionCard.vue';
import EmptyState from '../components/EmptyState.vue';

const route = useRoute();
const projectId = route.params.projectId;

const loading = ref(false);
const changes = ref([]);
const trunkItems = ref([]);
const requirements = ref([]);
const impactsMap = ref({});
const impactLoading = ref({});

const createVisible = ref(false);
const createSubmitting = ref(false);
const createForm = reactive({
  reason: '',
  old_item_ids: [],
  proposed_items: [{ kind: 'goal', statement: '' }],
  trigger_requirement_id: '',
  impact_assessment: '',
  created_by: '',
});
const createRules = {
  reason: [{ required: true, message: '请填写变更理由', trigger: 'blur' }],
};

const actionVisible = ref(false);
const actionSubmitting = ref(false);
const actionKind = ref('');
const actionForm = reactive({ confirmed_by: '', effective_at: '' });
const actionChange = ref(null);
const actionRules = {
  confirmed_by: [{ required: true, message: '请填写操作人', trigger: 'blur' }],
};

const impactVisible = ref(false);
const impactSubmitting = ref(false);
const impactChange = ref(null);
const impactForm = reactive({ target_type: 'task', target_id: '', owner_id: '' });
const impactRules = {
  target_id: [{ required: true, message: '请填写影响对象 ID', trigger: 'blur' }],
};

const adviceMap = ref({});
const adviceLoading = ref({});
const adviceError = ref({});
const adviceAdopting = ref({});

const trunkItemOptions = computed(() => trunkItems.value.map((item) => ({
  value: item.item_id,
  label: `${item.item_id}（${TRUNK_KIND_TEXT[item.kind] || item.kind}）${item.statement}`,
})));

const requirementOptions = computed(() => requirements.value.map((item) => ({
  value: item.requirement_id,
  label: `${item.requirement_id}：${item.raw_text.slice(0, 40)}`,
})));

async function load() {
  loading.value = true;
  try {
    const [changeRows, itemRows, requirementRows] = await Promise.all([
      api.listTrunkChanges({ project_id: projectId }),
      api.listTrunkItems({ project_id: projectId }),
      api.listRequirements({ project_id: projectId }),
    ]);
    changes.value = changeRows;
    trunkItems.value = itemRows;
    requirements.value = requirementRows;
    await Promise.all(changeRows.map((change) => loadImpacts(change.change_id)));
  } catch (err) {
    ElMessage.error(errorMessage(err, '加载变更失败'));
  } finally {
    loading.value = false;
  }
}

async function loadImpacts(changeId) {
  impactLoading.value = { ...impactLoading.value, [changeId]: true };
  try {
    const rows = await api.listImpactItems(changeId);
    impactsMap.value = { ...impactsMap.value, [changeId]: rows };
  } catch (err) {
    ElMessage.error(errorMessage(err, '加载影响项失败'));
  } finally {
    impactLoading.value = { ...impactLoading.value, [changeId]: false };
  }
}

function stepIndex(status) {
  return { proposed: 0, confirmed: 1, in_effect: 2, closed: 3 }[status] ?? 0;
}

function addProposedItem() {
  createForm.proposed_items.push({ kind: 'goal', statement: '' });
}

function removeProposedItem(index) {
  createForm.proposed_items.splice(index, 1);
}

async function submitCreate() {
  const proposedItems = createForm.proposed_items
    .map((item) => ({ ...item, statement: item.statement.trim() }))
    .filter((item) => item.statement !== '');
  if (proposedItems.some((item) => !item.statement)) {
    ElMessage.error('新条目表述不能为空');
    return;
  }
  createSubmitting.value = true;
  try {
    const created = await api.createTrunkChange({
      project_id: projectId,
      reason: createForm.reason,
      old_item_ids: createForm.old_item_ids,
      proposed_items: proposedItems,
      trigger_requirement_id: createForm.trigger_requirement_id || undefined,
      impact_assessment: createForm.impact_assessment || undefined,
      created_by: createForm.created_by || undefined,
    });
    ElMessage.success(`变更已提出：${created.change_id}`);
    createVisible.value = false;
    Object.assign(createForm, {
      reason: '',
      old_item_ids: [],
      proposed_items: [{ kind: 'goal', statement: '' }],
      trigger_requirement_id: '',
      impact_assessment: '',
      created_by: '',
    });
    await load();
  } catch (err) {
    ElMessage.error(errorMessage(err, '发起变更失败'));
  } finally {
    createSubmitting.value = false;
  }
}

function openAction(change, kind) {
  actionChange.value = change;
  actionKind.value = kind;
  Object.assign(actionForm, { confirmed_by: '', effective_at: '' });
  actionVisible.value = true;
}

async function submitAction() {
  actionSubmitting.value = true;
  try {
    const id = actionChange.value.change_id;
    if (actionKind.value === 'confirm') {
      const updated = await api.confirmTrunkChange(id, {
        confirmed_by: actionForm.confirmed_by,
        effective_at: actionForm.effective_at || undefined,
      });
      ElMessage.success(`变更已确认：${updated.change_id}`);
    } else {
      const updated = await api.activateTrunkChange(id, { confirmed_by: actionForm.confirmed_by });
      ElMessage.success(`变更已生效：${updated.change_id}`);
    }
    actionVisible.value = false;
    await load();
  } catch (err) {
    ElMessage.error(errorMessage(err, '操作失败'));
  } finally {
    actionSubmitting.value = false;
  }
}

function closeDisabledReason(change) {
  if (change.status !== 'in_effect') return `仅 in_effect 状态可关闭；当前为 ${change.status}`;
  const impacts = impactsMap.value[change.change_id] || [];
  const pending = impacts.filter((item) => item.assessment_status === 'to_check').length;
  if (pending > 0) return `仍有 ${pending} 个影响项处于待检查（to_check），不能关闭`;
  if (impacts.length === 0 && !(change.impact_assessment || '').trim()) {
    return '未登记影响项且未提供影响声明（impact_assessment），不能关闭';
  }
  return '';
}

async function closeChange(change) {
  try {
    const updated = await api.closeTrunkChange(change.change_id);
    ElMessage.success(`变更已关闭：${updated.change_id}`);
    await load();
  } catch (err) {
    ElMessage.error(errorMessage(err, '关闭变更失败'));
  }
}

async function saveImpact(change, row) {
  try {
    await api.updateImpactItem(row.impact_item_id, {
      assessment_status: row.assessment_status,
      resolution: row.resolution,
      reason: row.reason || undefined,
    });
    ElMessage.success(`影响项已更新：${row.impact_item_id}`);
    await loadImpacts(change.change_id);
  } catch (err) {
    ElMessage.error(errorMessage(err, '更新影响项失败'));
  }
}

function openAddImpact(change) {
  impactChange.value = change;
  Object.assign(impactForm, { target_type: 'task', target_id: '', owner_id: '' });
  impactVisible.value = true;
}

async function submitAddImpact() {
  impactSubmitting.value = true;
  try {
    const created = await api.addImpactItem(impactChange.value.change_id, {
      target_type: impactForm.target_type,
      target_id: impactForm.target_id,
      owner_id: impactForm.owner_id || undefined,
    });
    ElMessage.success(`影响项已登记：${created.impact_item_id}`);
    impactVisible.value = false;
    await loadImpacts(impactChange.value.change_id);
  } catch (err) {
    ElMessage.error(errorMessage(err, '登记影响项失败'));
  } finally {
    impactSubmitting.value = false;
  }
}

async function generateAdvice(change) {
  adviceLoading.value = { ...adviceLoading.value, [change.change_id]: true };
  adviceError.value = { ...adviceError.value, [change.change_id]: '' };
  try {
    const result = await api.adviseTrunkChange(change.change_id);
    adviceMap.value = { ...adviceMap.value, [change.change_id]: result };
    ElMessage.success(`已生成影响候选：${result.suggestion.suggestion_id}（未生效）`);
  } catch (err) {
    adviceError.value = {
      ...adviceError.value,
      [change.change_id]: errorMessage(err, '生成影响候选失败'),
    };
  } finally {
    adviceLoading.value = { ...adviceLoading.value, [change.change_id]: false };
  }
}

async function adoptAdvice(change) {
  const draft = adviceMap.value[change.change_id]?.draft || [];
  if (draft.length === 0) {
    ElMessage.warning('影响候选为空，无可登记项');
    return;
  }
  adviceAdopting.value = { ...adviceAdopting.value, [change.change_id]: true };
  try {
    for (const item of draft) {
      await api.addImpactItem(change.change_id, {
        target_type: item.target_type,
        target_id: item.target_id,
      });
    }
    ElMessage.success(`已登记 ${draft.length} 个影响项（默认待检查）`);
    adviceMap.value = { ...adviceMap.value, [change.change_id]: null };
    await loadImpacts(change.change_id);
  } catch (err) {
    ElMessage.error(errorMessage(err, '采纳影响候选失败'));
  } finally {
    adviceAdopting.value = { ...adviceAdopting.value, [change.change_id]: false };
  }
}

onMounted(() => {
  if (!projectId) return;
  load();
});
</script>

<template>
  <div class="page" v-loading="loading">
    <div class="page-header">
      <div>
        <h2 class="page-title">变更与影响</h2>
        <div class="page-subtitle mono">项目：{{ projectId }}</div>
      </div>
      <el-button type="primary" @click="createVisible = true">
        <el-icon><Plus /></el-icon>
        发起变更
      </el-button>
    </div>

    <EmptyState v-if="!loading && changes.length === 0" description="该项目还没有主干变更" />

    <el-card
      v-for="change in changes"
      :key="change.change_id"
      shadow="never"
      class="card-gap change-card"
    >
      <div class="change-head">
        <div>
          <div class="change-title">
            <span class="mono">{{ change.change_id }}</span>
            <StatusTag group="change" :value="change.status" />
          </div>
          <div class="muted">理由：{{ change.reason }}</div>
        </div>
        <div class="table-actions">
          <el-button size="small" text type="primary" @click="loadImpacts(change.change_id)">
            <el-icon><Refresh /></el-icon>
            刷新影响项
          </el-button>
          <el-button size="small" text type="primary" @click="openAddImpact(change)">
            <el-icon><Plus /></el-icon>
            登记影响项
          </el-button>
        </div>
      </div>

      <el-steps
        class="change-steps"
        :active="stepIndex(change.status)"
        align-center
        finish-status="success"
      >
        <el-step title="proposed" description="已提出" />
        <el-step title="confirmed" description="已确认" />
        <el-step title="in_effect" description="生效中" />
        <el-step title="closed" description="已关闭" />
      </el-steps>

      <el-descriptions :column="2" border size="small" class="change-desc">
        <el-descriptions-item label="旧条目">
          <span v-if="!(change.old_item_ids || []).length">—</span>
          <el-tag
            v-for="id in change.old_item_ids"
            :key="id"
            size="small"
            class="relation-tag mono"
          >{{ id }}</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="新条目">
          <span v-if="!(change.proposed_item_ids || []).length">—</span>
          <el-tag
            v-for="id in change.proposed_item_ids"
            :key="id"
            size="small"
            class="relation-tag mono"
          >{{ id }}</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="触发需求">
          <span class="mono">{{ change.trigger_requirement_id || '—' }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="确认人">{{ change.confirmed_by || '—' }}</el-descriptions-item>
        <el-descriptions-item label="生效时间">{{ formatTime(change.effective_at) }}</el-descriptions-item>
        <el-descriptions-item label="创建时间">{{ formatTime(change.created_at) }}</el-descriptions-item>
        <el-descriptions-item label="影响声明" :span="2">
          {{ change.impact_assessment || '—' }}
        </el-descriptions-item>
      </el-descriptions>

      <SuggestionCard
        v-if="adviceMap[change.change_id]"
        class="card-gap"
        title="AI 影响候选，未生效"
        :loading="!!adviceLoading[change.change_id]"
      >
        <div v-for="(item, index) in adviceMap[change.change_id].draft" :key="index" class="row">
          <el-tag size="small" type="warning">{{ item.target_type }}</el-tag>
          <span class="mono">{{ item.target_id }}</span>
          <span v-if="item.reason" class="muted">{{ item.reason }}</span>
        </div>
        <template #actions>
          <el-button
            size="small"
            type="primary"
            :loading="!!adviceAdopting[change.change_id]"
            @click="adoptAdvice(change)"
          >
            采纳并登记影响项
          </el-button>
        </template>
      </SuggestionCard>
      <el-alert
        v-if="adviceError[change.change_id]"
        class="card-gap"
        type="error"
        :title="adviceError[change.change_id]"
        :closable="false"
        show-icon
      />

      <div class="toolbar">
        <el-button
          size="small"
          type="primary"
          plain
          :loading="!!adviceLoading[change.change_id]"
          @click="generateAdvice(change)"
        >
          生成 AI 影响候选
        </el-button>
        <el-tooltip
          :disabled="change.status === 'proposed'"
          :content="`仅 proposed 状态可确认；当前为 ${change.status}`"
          placement="top"
        >
          <span>
            <el-button
              size="small"
              type="primary"
              plain
              :disabled="change.status !== 'proposed'"
              @click="openAction(change, 'confirm')"
            >
              确认
            </el-button>
          </span>
        </el-tooltip>
        <el-tooltip
          :disabled="change.status === 'confirmed'"
          :content="`仅 confirmed 状态可生效；当前为 ${change.status}`"
          placement="top"
        >
          <span>
            <el-button
              size="small"
              type="success"
              plain
              :disabled="change.status !== 'confirmed'"
              @click="openAction(change, 'activate')"
            >
              生效
            </el-button>
          </span>
        </el-tooltip>
        <el-tooltip
          :disabled="!closeDisabledReason(change)"
          :content="closeDisabledReason(change) || '影响处置完成，可以关闭'"
          placement="top"
        >
          <span>
            <el-button
              size="small"
              type="danger"
              plain
              :disabled="!!closeDisabledReason(change)"
              @click="closeChange(change)"
            >
              关闭
            </el-button>
          </span>
        </el-tooltip>
      </div>

      <div class="impact-header">
        <strong>影响项</strong>
        <span class="muted">
          共 {{ (impactsMap[change.change_id] || []).length }} 项，
          待检查 {{ (impactsMap[change.change_id] || []).filter((item) => item.assessment_status === 'to_check').length }} 项
        </span>
      </div>
      <EmptyState
        v-if="(impactsMap[change.change_id] || []).length === 0"
        description="未登记影响项；关闭前需登记并处置，或填写影响声明"
        :height="'100px'"
      />
      <el-table
        v-else
        :data="impactsMap[change.change_id]"
        size="small"
        v-loading="!!impactLoading[change.change_id]"
      >
        <el-table-column label="对象" min-width="180">
          <template #default="{ row }">
            <el-tag size="small" type="warning">{{ row.target_type }}</el-tag>
            <span class="mono">{{ row.target_id }}</span>
          </template>
        </el-table-column>
        <el-table-column label="评估状态" width="150">
          <template #default="{ row }">
            <el-select v-model="row.assessment_status" size="small">
              <el-option
                v-for="value in OPTIONS.impactAssessmentStatuses"
                :key="value"
                :label="value"
                :value="value"
              />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="处置方式" width="150">
          <template #default="{ row }">
            <el-select v-model="row.resolution" size="small">
              <el-option
                v-for="value in OPTIONS.impactResolutions"
                :key="value"
                :label="value"
                :value="value"
              />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="理由" min-width="180">
          <template #default="{ row }">
            <el-input v-model="row.reason" size="small" placeholder="not_affected 时必填" />
          </template>
        </el-table-column>
        <el-table-column prop="owner_id" label="负责人" width="110">
          <template #default="{ row }">{{ row.owner_id || '—' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="90">
          <template #default="{ row }">
            <el-tooltip
              :disabled="row.assessment_status !== 'not_affected' || (row.reason || '').trim()"
              content="评估为 not_affected 时必须填写理由"
              placement="top"
            >
              <span>
                <el-button
                  size="small"
                  type="primary"
                  plain
                  :disabled="row.assessment_status === 'not_affected' && !(row.reason || '').trim()"
                  @click="saveImpact(change, row)"
                >
                  保存
                </el-button>
              </span>
            </el-tooltip>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="createVisible" title="发起主干变更" width="640px">
      <el-form :model="createForm" :rules="createRules" label-width="96px">
        <el-form-item label="变更理由" prop="reason">
          <el-input v-model="createForm.reason" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item label="旧条目">
          <el-select
            v-model="createForm.old_item_ids"
            multiple
            filterable
            style="width: 100%"
            placeholder="选择被替代的主干条目"
          >
            <el-option
              v-for="option in trunkItemOptions"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="新条目">
          <div class="proposed-list">
            <div
              v-for="(item, index) in createForm.proposed_items"
              :key="index"
              class="proposed-row"
            >
              <el-select v-model="item.kind" style="width: 160px">
                <el-option
                  v-for="value in OPTIONS.trunkKinds"
                  :key="value"
                  :label="TRUNK_KIND_TEXT[value] || value"
                  :value="value"
                />
              </el-select>
              <el-input v-model="item.statement" placeholder="新条目表述" />
              <el-button
                size="small"
                text
                type="danger"
                :disabled="createForm.proposed_items.length <= 1"
                @click="removeProposedItem(index)"
              >
                删除
              </el-button>
            </div>
            <el-button size="small" text type="primary" @click="addProposedItem">
              <el-icon><Plus /></el-icon>
              添加新条目
            </el-button>
          </div>
        </el-form-item>
        <el-form-item label="触发需求">
          <el-select
            v-model="createForm.trigger_requirement_id"
            clearable
            filterable
            style="width: 100%"
            placeholder="可选"
          >
            <el-option
              v-for="option in requirementOptions"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="影响声明">
          <el-input
            v-model="createForm.impact_assessment"
            type="textarea"
            :rows="2"
            placeholder="若无影响对象可留空，但关闭变更时需填写"
          />
        </el-form-item>
        <el-form-item label="操作人">
          <el-input v-model="createForm.created_by" placeholder="可选，具名人员" style="width: 220px" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="createSubmitting" @click="submitCreate">提出变更</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="actionVisible"
      :title="actionKind === 'confirm' ? '确认主干变更' : '使变更生效'"
      width="480px"
    >
      <el-form :model="actionForm" :rules="actionRules" label-width="96px">
        <el-form-item label="操作人" prop="confirmed_by">
          <el-input v-model="actionForm.confirmed_by" />
        </el-form-item>
        <el-form-item v-if="actionKind === 'confirm'" label="生效时间">
          <el-date-picker
            v-model="actionForm.effective_at"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm:ss.SSSZ"
            placeholder="可选"
            style="width: 100%"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="actionVisible = false">取消</el-button>
        <el-button type="primary" :loading="actionSubmitting" @click="submitAction">
          {{ actionKind === 'confirm' ? '确认' : '生效' }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="impactVisible" title="登记影响项" width="480px">
      <el-form :model="impactForm" :rules="impactRules" label-width="96px">
        <el-form-item label="对象类型">
          <el-select v-model="impactForm.target_type" style="width: 100%">
            <el-option
              v-for="value in OPTIONS.impactTargetTypes"
              :key="value"
              :label="value"
              :value="value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="对象 ID" prop="target_id">
          <el-input v-model="impactForm.target_id" placeholder="例如 task_xxx" />
        </el-form-item>
        <el-form-item label="负责人">
          <el-input v-model="impactForm.owner_id" placeholder="可选" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="impactVisible = false">取消</el-button>
        <el-button type="primary" :loading="impactSubmitting" @click="submitAddImpact">登记</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.change-card {
  padding-bottom: 8px;
}

.change-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}

.change-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.change-steps {
  margin: 8px 0 16px;
}

.change-desc {
  margin-bottom: 8px;
}

.relation-tag {
  margin-right: 6px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 4px;
}

.impact-header {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin: 10px 0 8px;
}

.proposed-list {
  width: 100%;
}

.proposed-row {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
  align-items: center;
}
</style>
