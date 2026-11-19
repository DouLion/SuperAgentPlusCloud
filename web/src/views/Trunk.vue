<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, errorMessage } from '../api.js';
import { formatTime, OPTIONS, TRUNK_KIND_TEXT } from '../status.js';
import StatusTag from '../components/StatusTag.vue';
import EmptyState from '../components/EmptyState.vue';
import TrunkQuality from '../components/TrunkQuality.vue';
import { go } from '../nav.js';

const route = useRoute();
const router = useRouter();
const projectId = route.params.projectId || route.params.id;

const loading = ref(false);
const items = ref([]);
const tasks = ref([]);
const requirements = ref([]);
const changes = ref([]);
const statusFilter = ref('');
const kindFilter = ref('');
const selectedItem = ref(null);

const proposeVisible = ref(false);
const proposeSubmitting = ref(false);
const proposeForm = reactive({
  kind: 'goal',
  statement: '',
  rationale: '',
  source_refs: '',
  relations: '',
  created_by: '',
});
const proposeRules = {
  statement: [{ required: true, message: '请填写条目表述', trigger: 'blur' }],
};

const confirmVisible = ref(false);
const confirmSubmitting = ref(false);
const confirmForm = reactive({ confirmed_by: '', valid_from: '' });
const confirmRules = {
  confirmed_by: [{ required: true, message: '请填写确认人', trigger: 'blur' }],
};

const retireVisible = ref(false);
const retireSubmitting = ref(false);
const retireForm = reactive({ confirmed_by: '' });
const retireRules = {
  confirmed_by: [{ required: true, message: '请填写操作人', trigger: 'blur' }],
};

const changeVisible = ref(false);
const changeSubmitting = ref(false);
const changeForm = reactive({
  reason: '',
  old_item_ids: [],
  proposed_items: [{ kind: 'capability', statement: '' }],
  impact_assessment: '',
  created_by: '',
});

const treeData = computed(() => {
  const nodes = items.value.map((item) => ({
    ...item,
    label: `[${TRUNK_KIND_TEXT[item.kind] || item.kind}] ${item.statement}`,
    children: [],
  }));
  const byId = new Map(nodes.map((node) => [node.item_id, node]));
  const hasParent = new Set();
  for (const node of nodes) {
    for (const relation of node.relations || []) {
      const targetId = typeof relation === 'string' ? null : (relation.item_id ?? relation.itemId);
      if (!targetId || !byId.has(targetId) || targetId === node.item_id) continue;
      byId.get(targetId).children.push(node);
      hasParent.add(node.item_id);
    }
  }
  const roots = nodes.filter((node) => !hasParent.has(node.item_id));
  return roots.length > 0 ? roots : nodes;
});

/** 右侧：谁引用了它、谁会被它影响。 */
const references = computed(() => {
  const item = selectedItem.value;
  if (!item) return { tasks: [], requirements: [], changes: [] };
  const id = item.item_id;
  return {
    tasks: tasks.value.filter((task) => (task.serves_item_ids || []).includes(id)),
    requirements: requirements.value.filter((req) => (req.related_item_ids || []).includes(id)),
    changes: changes.value.filter(
      (change) => (change.old_item_ids || []).includes(id) || (change.proposed_item_ids || []).includes(id),
    ),
  };
});

const qualityItems = computed(() => items.value);

async function load() {
  loading.value = true;
  try {
    const query = { project_id: projectId };
    if (statusFilter.value) query.status = statusFilter.value;
    if (kindFilter.value) query.kind = kindFilter.value;
    const [itemRows, taskRows, requirementRows, changeRows] = await Promise.all([
      api.listTrunkItems(query),
      api.listTasks({ project_id: projectId }).catch(() => []),
      api.listRequirements({ project_id: projectId }).catch(() => []),
      api.listTrunkChanges({ project_id: projectId }).catch(() => []),
    ]);
    items.value = itemRows;
    tasks.value = taskRows;
    requirements.value = requirementRows;
    changes.value = changeRows;
    if (!selectedItem.value && itemRows.length) selectedItem.value = itemRows[0];
  } catch (err) {
    ElMessage.error(errorMessage(err, '加载主干地图失败'));
  } finally {
    loading.value = false;
  }
}

function parseList(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function openPropose() {
  Object.assign(proposeForm, {
    kind: 'goal',
    statement: '',
    rationale: '',
    source_refs: '',
    relations: '',
    created_by: '',
  });
  proposeVisible.value = true;
}

async function submitPropose() {
  proposeSubmitting.value = true;
  try {
    const relations = parseList(proposeForm.relations).map((line, index) => {
      const sep = line.indexOf(':');
      if (sep <= 0 || sep === line.length - 1) {
        throw new Error(`关系第 ${index + 1} 行格式应为 "type:item_id"：${line}`);
      }
      return { type: line.slice(0, sep).trim(), item_id: line.slice(sep + 1).trim() };
    });
    const created = await api.createTrunkItem({
      project_id: projectId,
      kind: proposeForm.kind,
      statement: proposeForm.statement,
      rationale: proposeForm.rationale || undefined,
      source_refs: parseList(proposeForm.source_refs),
      relations,
      created_by: proposeForm.created_by || undefined,
    });
    ElMessage.success(`主干条目已提出：${created.item_id}（proposed 仅为建议，确认后才生效）`);
    proposeVisible.value = false;
    await load();
  } catch (err) {
    ElMessage.error(errorMessage(err, '提出主干条目失败'));
  } finally {
    proposeSubmitting.value = false;
  }
}

function openConfirm(row) {
  selectedItem.value = row;
  Object.assign(confirmForm, { confirmed_by: '', valid_from: '' });
  confirmVisible.value = true;
}

async function submitConfirm() {
  confirmSubmitting.value = true;
  try {
    const updated = await api.confirmTrunkItem(selectedItem.value.item_id, {
      confirmed_by: confirmForm.confirmed_by,
      valid_from: confirmForm.valid_from || undefined,
    });
    ElMessage.success(`主干条目已确认：${updated.item_id}`);
    confirmVisible.value = false;
    await load();
  } catch (err) {
    ElMessage.error(errorMessage(err, '确认失败'));
  } finally {
    confirmSubmitting.value = false;
  }
}

function openRetire(row) {
  selectedItem.value = row;
  Object.assign(retireForm, { confirmed_by: '' });
  retireVisible.value = true;
}

async function submitRetire() {
  retireSubmitting.value = true;
  try {
    const updated = await api.retireTrunkItem(selectedItem.value.item_id, {
      confirmed_by: retireForm.confirmed_by,
    });
    ElMessage.success(`主干条目已退役：${updated.item_id}`);
    retireVisible.value = false;
    await load();
  } catch (err) {
    ElMessage.error(errorMessage(err, '退役失败'));
  } finally {
    retireSubmitting.value = false;
  }
}

function confirmRetire(row) {
  ElMessageBox.confirm(
    `确认退役主干条目 ${row.item_id}？退役后停止生效并保留历史。`,
    '退役确认',
    { type: 'warning', confirmButtonText: '退役', cancelButtonText: '取消' },
  ).then(() => openRetire(row)).catch(() => {});
}

/** 从当前条目一键发起变更，自动带入旧条目。 */
function startChange(row) {
  selectedItem.value = row;
  Object.assign(changeForm, {
    reason: '',
    old_item_ids: [row.item_id],
    proposed_items: [{ kind: row.kind, statement: '' }],
    impact_assessment: '',
    created_by: '',
  });
  changeVisible.value = true;
}

async function submitChange() {
  const proposed = changeForm.proposed_items
    .map((item) => ({ ...item, statement: item.statement.trim() }))
    .filter((item) => item.statement !== '');
  if (proposed.length === 0) {
    ElMessage.error('新条目表述不能为空');
    return;
  }
  if (!changeForm.reason.trim()) {
    ElMessage.error('请填写变更理由');
    return;
  }
  changeSubmitting.value = true;
  try {
    const created = await api.createTrunkChange({
      project_id: projectId,
      reason: changeForm.reason,
      old_item_ids: changeForm.old_item_ids,
      proposed_items: proposed,
      impact_assessment: changeForm.impact_assessment || undefined,
      created_by: changeForm.created_by || undefined,
    });
    ElMessage.success(`变更已提出：${created.change_id}（需确认并生效后才替代旧条目）`);
    changeVisible.value = false;
    go(router, 'changes', { id: projectId });
  } catch (err) {
    ElMessage.error(errorMessage(err, '发起变更失败'));
  } finally {
    changeSubmitting.value = false;
  }
}

function onTreeClick(node) {
  selectedItem.value = node;
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
        <h2 class="page-title">主干地图</h2>
      </div>
      <el-button type="primary" @click="openPropose">
        <el-icon><Plus /></el-icon>
        提出条目
      </el-button>
    </div>

    <div class="toolbar">
      <el-select v-model="statusFilter" clearable placeholder="状态（默认建议看 active）" style="width: 220px" @change="load">
        <el-option v-for="value in OPTIONS.trunkStatuses" :key="value" :label="value" :value="value" />
      </el-select>
      <el-select v-model="kindFilter" clearable placeholder="类型" style="width: 160px" @change="load">
        <el-option
          v-for="value in OPTIONS.trunkKinds"
          :key="value"
          :label="TRUNK_KIND_TEXT[value] || value"
          :value="value"
        />
      </el-select>
      <el-button size="small" @click="load">
        <el-icon><Refresh /></el-icon>
        刷新
      </el-button>
    </div>

    <TrunkQuality :items="qualityItems" />

    <div class="workbench">
      <div class="workbench__col">
        <div class="panel">
          <div class="panel__head">
            <span class="panel__title">层级</span>
            <span class="panel__count">{{ items.length }}</span>
          </div>
          <EmptyState v-if="items.length === 0" description="暂无主干条目" :height="'160px'" />
          <el-tree
            v-else
            :data="treeData"
            :props="{ label: 'label', children: 'children' }"
            default-expand-all
            node-key="item_id"
            highlight-current
            @node-click="onTreeClick"
          />
        </div>
      </div>

      <div class="workbench__col">
        <div class="panel">
          <div class="panel__head">
            <span class="panel__title">条目详情</span>
            <StatusTag v-if="selectedItem" group="trunk" :value="selectedItem.status" size="small" />
          </div>
          <EmptyState v-if="!selectedItem" description="未选择条目" :height="'160px'" />
          <div v-else>
            <div class="desc-grid">
              <span class="desc-label">表述</span>
              <span>{{ selectedItem.statement }}</span>
              <span class="desc-label">类型</span>
              <span>{{ TRUNK_KIND_TEXT[selectedItem.kind] || selectedItem.kind }}</span>
              <span class="desc-label">理由</span>
              <span>{{ selectedItem.rationale || '（缺失：无法被反驳）' }}</span>
              <span class="desc-label">来源</span>
              <span v-if="(selectedItem.source_refs || []).length">
                {{ (selectedItem.source_refs || []).join('，') }}
              </span>
              <span v-else>（缺失）</span>
              <span class="desc-label">确认人</span>
              <span>{{ selectedItem.confirmed_by || '—' }}</span>
              <span class="desc-label">生效时间</span>
              <span>{{ formatTime(selectedItem.valid_from) }}</span>
              <span class="desc-label">被替代为</span>
              <span v-if="selectedItem.superseded_by">
                <span class="mono">{{ selectedItem.superseded_by }}</span>
              </span>
              <span v-else>—</span>
            </div>

            <div class="suggestion-actions">
              <el-button
                v-if="selectedItem.status === 'proposed'"
                size="small"
                type="primary"
                plain
                @click="openConfirm(selectedItem)"
              >
                确认生效
              </el-button>
              <el-button
                v-if="selectedItem.status === 'active'"
                size="small"
                type="primary"
                @click="startChange(selectedItem)"
              >
                变更此约定
              </el-button>
              <el-button
                v-if="selectedItem.status === 'active'"
                size="small"
                plain
                @click="confirmRetire(selectedItem)"
              >
                退役
              </el-button>
            </div>
          </div>
        </div>
      </div>

      <div class="workbench__col">
        <div class="panel">
          <div class="panel__head">
            <span class="panel__title">引用与影响</span>
          </div>
          <EmptyState v-if="!selectedItem" description="未选择条目" :height="'120px'" />
          <div v-else>
            <div class="panel__title" style="margin: 6px 0">服务它的任务（{{ references.tasks.length }}）</div>
            <div
              v-for="task in references.tasks"
              :key="task.task_id"
              class="queue-item clickable"
              @click="go(router, 'task-detail', { id: projectId, taskId: task.task_id })"
            >
              <div class="queue-item__title">{{ task.purpose }}</div>
              <div class="queue-item__meta"><StatusTag group="task" :value="task.status" size="small" /></div>
            </div>
            <div v-if="references.tasks.length === 0" class="muted">无</div>

            <div class="panel__title" style="margin: 12px 0 6px">关联需求（{{ references.requirements.length }}）</div>
            <div
              v-for="req in references.requirements"
              :key="req.requirement_id"
              class="queue-item clickable"
              @click="go(router, 'requirement-detail', { id: projectId, requirementId: req.requirement_id })"
            >
              <div class="queue-item__title">{{ req.raw_text }}</div>
              <div class="queue-item__meta"><StatusTag group="requirement" :value="req.status" size="small" /></div>
            </div>
            <div v-if="references.requirements.length === 0" class="muted">无</div>

            <div class="panel__title" style="margin: 12px 0 6px">相关变更（{{ references.changes.length }}）</div>
            <div
              v-for="change in references.changes"
              :key="change.change_id"
              class="queue-item clickable"
              @click="go(router, 'changes', { id: projectId })"
            >
              <div class="queue-item__title">{{ change.reason }}</div>
              <div class="queue-item__meta"><StatusTag group="change" :value="change.status" size="small" /></div>
            </div>
            <div v-if="references.changes.length === 0" class="muted">无</div>
          </div>
        </div>
      </div>
    </div>

    <el-dialog v-model="proposeVisible" title="提出主干条目（proposed，需确认后生效）" width="560px">
      <el-form :model="proposeForm" :rules="proposeRules" label-width="96px">
        <el-form-item label="类型">
          <el-select v-model="proposeForm.kind">
            <el-option
              v-for="value in OPTIONS.trunkKinds"
              :key="value"
              :label="TRUNK_KIND_TEXT[value] || value"
              :value="value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="表述" prop="statement">
          <el-input v-model="proposeForm.statement" type="textarea" :rows="3" />
        </el-form-item>
        <el-form-item label="理由">
          <el-input v-model="proposeForm.rationale" type="textarea" :rows="2" placeholder="为什么这样定；缺失则该条目无法被反驳" />
        </el-form-item>
        <el-form-item label="来源">
          <el-input v-model="proposeForm.source_refs" type="textarea" :rows="2" placeholder="每行一条：会议纪要 / 文档 / 需求 ID" />
        </el-form-item>
        <el-form-item label="关系">
          <el-input v-model="proposeForm.relations" type="textarea" :rows="2" placeholder='每行 "type:item_id"，例如 child:item_xxx' />
        </el-form-item>
        <el-form-item label="提出人">
          <el-input v-model="proposeForm.created_by" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="proposeVisible = false">取消</el-button>
        <el-button type="primary" :loading="proposeSubmitting" @click="submitPropose">提出</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="confirmVisible" title="确认主干条目生效" width="480px">
      <el-form :model="confirmForm" :rules="confirmRules" label-width="96px">
        <el-form-item label="确认人" prop="confirmed_by">
          <el-input v-model="confirmForm.confirmed_by" />
        </el-form-item>
        <el-form-item label="生效时间">
          <el-date-picker v-model="confirmForm.valid_from" type="datetime" value-format="YYYY-MM-DDTHH:mm:ssZ" style="width: 100%" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="confirmVisible = false">取消</el-button>
        <el-button type="primary" :loading="confirmSubmitting" @click="submitConfirm">确认生效</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="retireVisible" title="退役主干条目" width="480px">
      <el-form :model="retireForm" :rules="retireRules" label-width="96px">
        <el-form-item label="操作人" prop="confirmed_by">
          <el-input v-model="retireForm.confirmed_by" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="retireVisible = false">取消</el-button>
        <el-button type="warning" :loading="retireSubmitting" @click="submitRetire">退役</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="changeVisible" title="变更此约定" width="640px">
      <el-form label-width="96px">
        <el-form-item label="变更理由">
          <el-input v-model="changeForm.reason" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item label="旧条目">
          <el-select v-model="changeForm.old_item_ids" multiple style="width: 100%">
            <el-option v-for="item in items" :key="item.item_id" :label="`${item.item_id}｜${item.statement}`" :value="item.item_id" />
          </el-select>
        </el-form-item>
        <el-form-item label="新条目">
          <div v-for="(proposal, index) in changeForm.proposed_items" :key="index" style="display: flex; gap: 8px; margin-bottom: 8px">
            <el-select v-model="proposal.kind" style="width: 150px">
              <el-option
                v-for="value in OPTIONS.trunkKinds"
                :key="value"
                :label="TRUNK_KIND_TEXT[value] || value"
                :value="value"
              />
            </el-select>
            <el-input v-model="proposal.statement" placeholder="新条目的表述" />
            <el-button text type="danger" @click="changeForm.proposed_items.splice(index, 1)">删除</el-button>
          </div>
          <el-button size="small" text @click="changeForm.proposed_items.push({ kind: 'capability', statement: '' })">
            + 增加新条目
          </el-button>
        </el-form-item>
        <el-form-item label="影响评估">
          <el-input v-model="changeForm.impact_assessment" type="textarea" :rows="2" placeholder="留空会在关闭变更时被拒绝" />
        </el-form-item>
        <el-form-item label="操作人">
          <el-input v-model="changeForm.created_by" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="changeVisible = false">取消</el-button>
        <el-button type="primary" :loading="changeSubmitting" @click="submitChange">提出变更</el-button>
      </template>
    </el-dialog>
  </div>
</template>
