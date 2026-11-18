<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, errorMessage } from '../api.js';
import {
  formatRelation,
  formatTime,
  OPTIONS,
  TRUNK_KIND_TEXT,
} from '../status.js';
import StatusTag from '../components/StatusTag.vue';
import EmptyState from '../components/EmptyState.vue';

const route = useRoute();
const projectId = route.params.projectId;

const loading = ref(false);
const items = ref([]);
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

async function load() {
  loading.value = true;
  try {
    const query = { project_id: projectId };
    if (statusFilter.value) query.status = statusFilter.value;
    if (kindFilter.value) query.kind = kindFilter.value;
    items.value = await api.listTrunkItems(query);
  } catch (err) {
    ElMessage.error(errorMessage(err, '加载主干条目失败'));
  } finally {
    loading.value = false;
  }
}

// 按 relations 组织树：关系目标视为父节点，引用该目标的条目作为子节点。
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
  // 防环：仍在环里的节点直接作为根，避免无限递归。
  return roots.length > 0 ? roots : nodes;
});

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

function parseList(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
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
    ElMessage.success(`主干条目已提出：${created.item_id}（proposed 仅为建议，需确认后生效）`);
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
        <h2 class="page-title">主干条目</h2>
        <div class="page-subtitle mono">项目：{{ projectId }}</div>
      </div>
      <el-button type="primary" @click="openPropose">
        <el-icon><Plus /></el-icon>
        提出条目
      </el-button>
    </div>

    <div class="toolbar">
      <el-select v-model="statusFilter" clearable placeholder="状态" style="width: 160px" @change="load">
        <el-option
          v-for="value in OPTIONS.trunkStatuses"
          :key="value"
          :label="value"
          :value="value"
        />
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
      <span class="muted">proposed 仅为建议，confirm 后才作为已确认前提生效。</span>
    </div>

    <el-row :gutter="16">
      <el-col :xs="24" :md="10">
        <el-card shadow="never" class="card-gap">
          <template #header>按关系组织</template>
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
        </el-card>
      </el-col>

      <el-col :xs="24" :md="14">
        <el-card shadow="never" class="card-gap">
          <template #header>条目列表</template>
          <EmptyState v-if="items.length === 0" description="暂无主干条目" :height="'160px'" />
          <el-table v-else :data="items" size="small" @row-click="onTreeClick">
            <el-table-column prop="statement" label="表述" min-width="200" show-overflow-tooltip />
            <el-table-column label="类型" width="100">
              <template #default="{ row }">{{ TRUNK_KIND_TEXT[row.kind] || row.kind }}</template>
            </el-table-column>
            <el-table-column label="状态" width="120">
              <template #default="{ row }"><StatusTag group="trunk" :value="row.status" /></template>
            </el-table-column>
            <el-table-column prop="confirmed_by" label="确认人" width="100">
              <template #default="{ row }">{{ row.confirmed_by || '—' }}</template>
            </el-table-column>
            <el-table-column label="操作" width="140" fixed="right">
              <template #default="{ row }">
                <div class="table-actions">
                  <el-tooltip
                    :disabled="row.status === 'proposed'"
                    :content="`仅 proposed 状态可确认；当前为 ${row.status}`"
                    placement="top"
                  >
                    <span>
                      <el-button
                        size="small"
                        type="primary"
                        plain
                        :disabled="row.status !== 'proposed'"
                        @click.stop="openConfirm(row)"
                      >
                        确认
                      </el-button>
                    </span>
                  </el-tooltip>
                  <el-tooltip
                    :disabled="row.status === 'active'"
                    :content="`仅 active 状态可退役；当前为 ${row.status}`"
                    placement="top"
                  >
                    <span>
                      <el-button
                        size="small"
                        type="danger"
                        plain
                        :disabled="row.status !== 'active'"
                        @click.stop="confirmRetire(row)"
                      >
                        退役
                      </el-button>
                    </span>
                  </el-tooltip>
                </div>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>

    <el-descriptions
      v-if="selectedItem"
      class="card-gap"
      :column="2"
      border
      size="small"
      title="选中条目详情"
    >
      <el-descriptions-item label="表述">{{ selectedItem.statement }}</el-descriptions-item>
      <el-descriptions-item label="类型">
        {{ TRUNK_KIND_TEXT[selectedItem.kind] || selectedItem.kind }}
      </el-descriptions-item>
      <el-descriptions-item label="状态">
        <StatusTag group="trunk" :value="selectedItem.status" />
      </el-descriptions-item>
      <el-descriptions-item label="确认人">{{ selectedItem.confirmed_by || '—' }}</el-descriptions-item>
      <el-descriptions-item label="理由" :span="2">{{ selectedItem.rationale || '—' }}</el-descriptions-item>
      <el-descriptions-item label="生效时间">{{ formatTime(selectedItem.valid_from) }}</el-descriptions-item>
      <el-descriptions-item label="失效时间">{{ formatTime(selectedItem.valid_until) }}</el-descriptions-item>
      <el-descriptions-item label="关系" :span="2">
        <span v-if="!(selectedItem.relations || []).length">（无）</span>
        <el-tag
          v-for="(relation, index) in selectedItem.relations"
          :key="index"
          size="small"
          class="relation-tag"
        >{{ formatRelation(relation) }}</el-tag>
      </el-descriptions-item>
    </el-descriptions>

    <el-dialog v-model="proposeVisible" title="提出主干条目" width="560px">
      <el-form :model="proposeForm" :rules="proposeRules" label-width="96px">
        <el-form-item label="类型" prop="kind">
          <el-select v-model="proposeForm.kind" style="width: 100%">
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
          <el-input v-model="proposeForm.rationale" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item label="来源">
          <el-input v-model="proposeForm.source_refs" type="textarea" :rows="2" placeholder="每行一个来源引用" />
        </el-form-item>
        <el-form-item label="关系">
          <el-input
            v-model="proposeForm.relations"
            type="textarea"
            :rows="2"
            placeholder="每行一条：type:item_id，例如 supports:item_xxx"
          />
        </el-form-item>
        <el-form-item label="提出人">
          <el-input v-model="proposeForm.created_by" placeholder="可选，具名人员" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="proposeVisible = false">取消</el-button>
        <el-button type="primary" :loading="proposeSubmitting" @click="submitPropose">提出</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="confirmVisible" title="确认主干条目" width="480px">
      <el-form :model="confirmForm" :rules="confirmRules" label-width="96px">
        <el-form-item label="确认人" prop="confirmed_by">
          <el-input v-model="confirmForm.confirmed_by" />
        </el-form-item>
        <el-form-item label="生效时间">
          <el-date-picker
            v-model="confirmForm.valid_from"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm:ss.SSSZ"
            placeholder="可选，留空表示立即生效"
            style="width: 100%"
          />
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
        <el-button type="danger" :loading="retireSubmitting" @click="submitRetire">退役</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.relation-tag {
  margin-right: 6px;
}
</style>
