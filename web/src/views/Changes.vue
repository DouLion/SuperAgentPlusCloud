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
const projectId = route.params.id || route.params.projectId;

const loading = ref(false);
const changes = ref([]);
const trunkItems = ref([]);
const requirements = ref([]);
const impactsMap = ref({});
const impactTab = ref({});
const editingImpact = ref(null); // { id, assessment_status, resolution, reason, owner_id }

const createVisible = ref(false);
const createSubmitting = ref(false);
const createForm = reactive({
  reason: '',
  old_item_ids: [],
  proposed_items: [{ kind: 'capability', statement: '' }],
  trigger_requirement_id: '',
  impact_assessment: '',
  created_by: '',
});

const actionVisible = ref(false);
const actionSubmitting = ref(false);
const actionKind = ref('');
const actionForm = reactive({ confirmed_by: '', effective_at: '' });
const actionChange = ref(null);

const impactVisible = ref(false);
const impactSubmitting = ref(false);
const impactChange = ref(null);
const impactForm = reactive({ target_type: 'task', target_id: '', owner_id: '' });

const adviceMap = ref({});
const adviceLoading = ref({});
const adviceError = ref({});
const adviceAdopting = ref({});

const itemById = computed(() => new Map(trunkItems.value.map((item) => [item.item_id, item])));
const requirementById = computed(() => new Map(requirements.value.map((item) => [item.requirement_id, item])));

const IMPACT_TABS = [
  { key: 'to_check', label: '待检查' },
  { key: 'affected', label: '有影响' },
  { key: 'not_affected', label: '确认无影响' },
];

const impactsOf = (changeId) => impactsMap.value[changeId] || [];

const impactGroups = computed(() => {
  const result = {};
  for (const tab of IMPACT_TABS) result[tab.key] = {};
  for (const change of changes.value) {
    for (const tab of IMPACT_TABS) result[tab.key][change.change_id] = [];
  }
  for (const [changeId, rows] of Object.entries(impactsMap.value)) {
    for (const row of rows) {
      if (!result[row.assessment_status]) result[row.assessment_status] = {};
      if (!result[row.assessment_status][changeId]) result[row.assessment_status][changeId] = [];
      result[row.assessment_status][changeId].push(row);
    }
  }
  return result;
});

const totalPending = computed(() =>
  Object.values(impactsMap.value).flat().filter((item) => item.assessment_status === 'to_check').length,
);

async function load() {
  loading.value = true;
  try {
    const [changeRows, itemRows, requirementRows] = await Promise.all([
      api.listTrunkChanges({ project_id: projectId }),
      api.listTrunkItems({ project_id: projectId }).catch(() => []),
      api.listRequirements({ project_id: projectId }).catch(() => []),
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
  try {
    const rows = await api.listImpactItems(changeId);
    impactsMap.value = { ...impactsMap.value, [changeId]: rows };
  } catch {
    impactsMap.value = { ...impactsMap.value, [changeId]: [] };
  }
}

function itemLabel(id) {
  const item = itemById.value.get(id);
  return item ? `${id}｜${item.statement}` : id;
}

function requirementLabel(id) {
  const requirement = requirementById.value.get(id);
  return requirement ? `${id}｜${requirement.raw_text.slice(0, 40)}` : id;
}

function addProposedItem() {
  createForm.proposed_items.push({ kind: 'capability', statement: '' });
}

async function submitCreate() {
  const proposedItems = createForm.proposed_items
    .map((item) => ({ ...item, statement: item.statement.trim() }))
    .filter((item) => item.statement !== '');
  if (!createForm.reason.trim()) {
    ElMessage.error('请填写变更理由');
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
      proposed_items: [{ kind: 'capability', statement: '' }],
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
  const impacts = impactsOf(change.change_id);
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

/** 单行编辑：进入时复制服务端值，取消则丢弃，避免本地残留。 */
function startEdit(row) {
  editingImpact.value = {
    impact_item_id: row.impact_item_id,
    assessment_status: row.assessment_status,
    resolution: row.resolution,
    reason: row.reason || '',
    owner_id: row.owner_id || '',
  };
}

function cancelEdit() {
  editingImpact.value = null;
}

async function saveEdit(change) {
  const draft = editingImpact.value;
  if (!draft) return;
  if (draft.assessment_status === 'not_affected' && !draft.reason.trim()) {
    ElMessage.error('确认无影响（not_affected）必须填写理由');
    return;
  }
  try {
    await api.updateImpactItem(draft.impact_item_id, {
      assessment_status: draft.assessment_status,
      resolution: draft.resolution,
      reason: draft.reason || undefined,
      owner_id: draft.owner_id || undefined,
    });
    ElMessage.success(`影响项已更新：${draft.impact_item_id}`);
    editingImpact.value = null;
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
        <h2 class="page-title">变更影响台</h2>
        <div class="page-subtitle" v-if="totalPending">
          <el-tag type="danger" size="small" effect="plain">
            {{ totalPending }} 个待检查
          </el-tag>
        </div>
      </div>
      <el-button type="primary" @click="createVisible = true">
        <el-icon><Plus /></el-icon>
        发起变更
      </el-button>
    </div>

    <EmptyState v-if="!loading && changes.length === 0" description="该项目还没有主干变更">
      <el-button type="primary" plain @click="createVisible = true">发起第一条变更</el-button>
    </EmptyState>

    <el-card v-for="change in changes" :key="change.change_id" shadow="never" class="card-gap">
      <div class="panel__head">
        <div>
          <div class="queue-item__meta">
            <span class="mono">{{ change.change_id }}</span>
            <StatusTag group="change" :value="change.status" size="small" />
          </div>
          <div class="muted" style="margin-top: 4px">理由：{{ change.reason }}</div>
        </div>
        <div class="table-actions">
          <el-tooltip :disabled="change.status !== 'proposed'" content="仅 proposed 可确认" placement="top">
            <span>
              <el-button size="small" text type="primary" :disabled="change.status !== 'proposed'" @click="openAction(change, 'confirm')">
                确认
              </el-button>
            </span>
          </el-tooltip>
          <el-tooltip :disabled="change.status !== 'confirmed'" content="仅 confirmed 可生效" placement="top">
            <span>
              <el-button size="small" text type="primary" :disabled="change.status !== 'confirmed'" @click="openAction(change, 'activate')">
                生效
              </el-button>
            </span>
          </el-tooltip>
          <el-tooltip
            :disabled="!closeDisabledReason(change)"
            :content="closeDisabledReason(change) || '可以关闭'"
            placement="top"
          >
            <span>
              <el-button
                size="small"
                type="success"
                plain
                :disabled="Boolean(closeDisabledReason(change))"
                @click="closeChange(change)"
              >
                关闭
                <template v-if="closeDisabledReason(change) && impactsOf(change.change_id).some((i) => i.assessment_status === 'to_check')">
                  （{{ impactsOf(change.change_id).filter((i) => i.assessment_status === 'to_check').length }} 待检查）
                </template>
              </el-button>
            </span>
          </el-tooltip>
          <el-button size="small" text type="primary" @click="openAddImpact(change)">登记影响项</el-button>
        </div>
      </div>

      <el-alert
        v-if="change.old_item_ids?.length || change.proposed_item_ids?.length"
        type="info"
        :closable="false"
        show-icon
        class="card-gap"
        title="旧决定 → 新决定"
      >
        <div class="change-diff">
          <div>
            <div class="muted">旧</div>
            <div v-for="id in change.old_item_ids || []" :key="id" class="mono">{{ itemLabel(id) }}</div>
            <div v-if="!(change.old_item_ids || []).length" class="muted">—</div>
          </div>
          <div class="diff-arrow">→</div>
          <div>
            <div class="muted">新</div>
            <div v-for="id in change.proposed_item_ids || []" :key="id" class="mono">{{ itemLabel(id) }}</div>
            <div v-if="!(change.proposed_item_ids || []).length" class="muted">—</div>
          </div>
        </div>
      </el-alert>

      <el-alert
        v-if="!(change.impact_assessment || '').trim()"
        type="warning"
        :closable="false"
        show-icon
        title="缺少影响评估声明"
        style="margin-bottom: 10px"
      />

      <SuggestionCard
        v-if="adviceMap[change.change_id]"
        title="AI 影响候选，未生效"
        :loading="adviceLoading[change.change_id]"
        :error="adviceError[change.change_id]"
        class="card-gap"
      >
        <template #actions>
          <el-button
            size="small"
            type="primary"
            plain
            :loading="adviceAdopting[change.change_id]"
            @click="adoptAdvice(change)"
          >
            采纳并登记为待检查
          </el-button>
          <el-button size="small" text @click="adviceMap[change.change_id] = null">丢弃</el-button>
        </template>
        <div v-for="(item, index) in adviceMap[change.change_id].draft || []" :key="index" class="row">
          <el-tag size="small" effect="plain">{{ item.target_type }}</el-tag>
          <span class="mono">{{ item.target_id }}</span>
          <span class="muted">{{ item.reason }}</span>
        </div>
      </SuggestionCard>

      <div class="toolbar">
        <el-button size="small" :loading="adviceLoading[change.change_id]" @click="generateAdvice(change)">
          生成影响候选
        </el-button>
        <el-select v-model="impactTab[change.change_id]" style="width: 150px">
          <el-option
            v-for="tab in IMPACT_TABS"
            :key="tab.key"
            :label="`${tab.label}（${(impactGroups[tab.key][change.change_id] || []).length}）`"
            :value="tab.key"
          />
        </el-select>
      </div>

      <div v-for="tab in IMPACT_TABS" :key="tab.key">
        <template v-if="(impactTab[change.change_id] || 'to_check') === tab.key">
          <EmptyState
            v-if="(impactGroups[tab.key][change.change_id] || []).length === 0"
            :description="`没有${tab.label}的影响项`"
            :height="'70px'"
          />
          <div
            v-for="row in impactGroups[tab.key][change.change_id] || []"
            :key="row.impact_item_id"
            class="impact-row"
          >
            <div class="impact-row__main">
              <el-tag size="small" effect="plain">{{ row.target_type }}</el-tag>
              <span class="mono">{{ row.target_id }}</span>
              <span v-if="row.owner_id" class="muted">负责：{{ row.owner_id }}</span>
            </div>

            <div v-if="editingImpact && editingImpact.impact_item_id === row.impact_item_id" class="impact-row__edit">
              <el-select v-model="editingImpact.assessment_status" style="width: 150px">
                <el-option
                  v-for="value in OPTIONS.impactAssessmentStatuses"
                  :key="value"
                  :label="value"
                  :value="value"
                />
              </el-select>
              <el-select v-model="editingImpact.resolution" style="width: 130px">
                <el-option
                  v-for="value in OPTIONS.impactResolutions"
                  :key="value"
                  :label="value"
                  :value="value"
                />
              </el-select>
              <el-input v-model="editingImpact.reason" placeholder="判断理由（not_affected 必填）" style="flex: 1" />
              <el-input v-model="editingImpact.owner_id" placeholder="负责人" style="width: 120px" />
              <el-button size="small" type="primary" @click="saveEdit(change)">保存</el-button>
              <el-button size="small" @click="cancelEdit">取消</el-button>
            </div>

            <div v-else class="impact-row__view">
              <StatusTag group="impactAssessment" :value="row.assessment_status" size="small" />
              <StatusTag group="impactResolution" :value="row.resolution" size="small" />
              <span class="muted">{{ row.reason || '（无理由）' }}</span>
              <el-button size="small" text type="primary" @click="startEdit(row)">编辑</el-button>
            </div>
          </div>
        </template>
      </div>
    </el-card>

    <el-dialog v-model="createVisible" title="发起主干变更" width="640px">
      <el-form label-width="96px">
        <el-form-item label="变更理由">
          <el-input v-model="createForm.reason" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item label="触发需求">
          <el-select v-model="createForm.trigger_requirement_id" clearable filterable style="width: 100%">
            <el-option
              v-for="req in requirements"
              :key="req.requirement_id"
              :label="`${req.requirement_id}｜${req.raw_text.slice(0, 40)}`"
              :value="req.requirement_id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="旧条目">
          <el-select v-model="createForm.old_item_ids" multiple filterable style="width: 100%">
            <el-option
              v-for="item in trunkItems"
              :key="item.item_id"
              :label="`${item.item_id}｜${item.statement}`"
              :value="item.item_id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="新条目">
          <div v-for="(proposal, index) in createForm.proposed_items" :key="index" style="display: flex; gap: 8px; margin-bottom: 8px">
            <el-select v-model="proposal.kind" style="width: 150px">
              <el-option
                v-for="value in OPTIONS.trunkKinds"
                :key="value"
                :label="TRUNK_KIND_TEXT[value] || value"
                :value="value"
              />
            </el-select>
            <el-input v-model="proposal.statement" placeholder="新条目表述" />
            <el-button text type="danger" @click="createForm.proposed_items.splice(index, 1)">删除</el-button>
          </div>
          <el-button size="small" text @click="addProposedItem">+ 增加新条目</el-button>
        </el-form-item>
        <el-form-item label="影响声明">
          <el-input
            v-model="createForm.impact_assessment"
            type="textarea"
            :rows="2"
            placeholder="若无影响项，必须在此明确声明已检查"
          />
        </el-form-item>
        <el-form-item label="操作人">
          <el-input v-model="createForm.created_by" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="createSubmitting" @click="submitCreate">提出变更</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="actionVisible" :title="actionKind === 'confirm' ? '确认变更' : '变更生效'" width="480px">
      <el-form :model="actionForm" label-width="96px">
        <el-form-item label="操作人">
          <el-input v-model="actionForm.confirmed_by" />
        </el-form-item>
        <el-form-item v-if="actionKind === 'confirm'" label="生效时间">
          <el-date-picker v-model="actionForm.effective_at" type="datetime" value-format="YYYY-MM-DDTHH:mm:ssZ" style="width: 100%" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="actionVisible = false">取消</el-button>
        <el-button type="primary" :loading="actionSubmitting" @click="submitAction">确定</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="impactVisible" title="登记影响项" width="480px">
      <el-form :model="impactForm" label-width="96px">
        <el-form-item label="对象类型">
          <el-select v-model="impactForm.target_type">
            <el-option v-for="value in OPTIONS.impactTargetTypes" :key="value" :label="value" :value="value" />
          </el-select>
        </el-form-item>
        <el-form-item label="对象 ID">
          <el-input v-model="impactForm.target_id" placeholder="task_ / sub_ / 文档引用" />
        </el-form-item>
        <el-form-item label="负责人">
          <el-input v-model="impactForm.owner_id" />
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
.change-diff {
  display: flex;
  gap: 16px;
  align-items: flex-start;
  font-size: 13px;
}

.diff-arrow {
  color: var(--sap-muted);
  padding-top: 18px;
}

.impact-row {
  border: 1px solid var(--sap-border-soft);
  border-radius: 6px;
  padding: 8px 10px;
  margin-bottom: 8px;
}

.impact-row__main {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  flex-wrap: wrap;
}

.impact-row__view {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.impact-row__edit {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
