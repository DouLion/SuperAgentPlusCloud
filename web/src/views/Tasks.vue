<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api, errorMessage } from '../api.js';
import { formatTime } from '../status.js';
import StatusTag from '../components/StatusTag.vue';
import EmptyState from '../components/EmptyState.vue';
import { go } from '../nav.js';

const route = useRoute();
const router = useRouter();
const projectId = route.params.id || route.params.projectId;

const tasks = ref([]);
const claimMap = ref({});
const loading = ref(false);
const activeTab = ref('claimable');
const workerId = ref(localStorage.getItem('sap.workerId') || '');

const TABS = [
  { key: 'claimable', label: '可认领' },
  { key: 'mine', label: '我在处理' },
  { key: 'review', label: '待评审' },
  { key: 'rework', label: '返工' },
  { key: 'done', label: '已完成' },
];

const grouped = computed(() => {
  const me = workerId.value.trim();
  return TABS.map((tab) => {
    let rows = [];
    if (tab.key === 'claimable') rows = tasks.value.filter((task) => task.status === 'open');
    if (tab.key === 'mine') {
      rows = tasks.value.filter((task) => {
        if (task.status !== 'claimed' || !me) return false;
        return (claimMap.value[task.task_id] || []).some(
          (claim) => claim.status === 'active' && claim.worker_id === me,
        );
      });
    }
    if (tab.key === 'review') rows = tasks.value.filter((task) => task.status === 'submitted');
    if (tab.key === 'rework') rows = tasks.value.filter((task) => task.status === 'rework');
    if (tab.key === 'done') {
      rows = tasks.value.filter((task) => ['accepted', 'closed', 'cancelled'].includes(task.status));
    }
    return { ...tab, rows };
  });
});

const counts = computed(() => Object.fromEntries(grouped.value.map((group) => [group.key, group.rows.length])));

async function loadClaims(taskId) {
  try {
    const rows = await api.listClaims(taskId);
    claimMap.value = { ...claimMap.value, [taskId]: rows };
  } catch {
    claimMap.value = { ...claimMap.value, [taskId]: [] };
  }
}

async function load() {
  if (!projectId) return;
  loading.value = true;
  try {
    tasks.value = await api.listTasks({ project_id: projectId });
    await Promise.all(
      tasks.value.filter((task) => task.status === 'claimed').map((task) => loadClaims(task.task_id)),
    );
  } catch (err) {
    ElMessage.error(errorMessage(err, '加载任务失败'));
  } finally {
    loading.value = false;
  }
}

function saveWorker() {
  const value = workerId.value.trim();
  if (value) localStorage.setItem('sap.workerId', value);
  else localStorage.removeItem('sap.workerId');
}

function openDetail(row) {
  go(router, 'task-detail', { id: projectId, taskId: row.task_id });
}

onMounted(load);
</script>

<template>
  <div class="page" v-loading="loading">
    <div class="page-header">
      <div>
        <h2 class="page-title">任务工作台</h2>
        <div class="page-subtitle">
          先看清完成条件再认领；认领是承诺，不是抢单。
        </div>
      </div>
      <el-button size="small" @click="load">
        <el-icon><Refresh /></el-icon>
        刷新
      </el-button>
    </div>

    <div class="toolbar">
      <el-input
        v-model="workerId"
        placeholder="当前工作者 ID（认领/提交/评审用）"
        style="width: 260px"
        clearable
        @change="saveWorker"
      />
      <span class="muted">分组表示任务此刻需要谁做什么</span>
    </div>

    <EmptyState v-if="!loading && tasks.length === 0" description="该项目还没有任务" :height="'160px'" />

    <el-tabs v-else v-model="activeTab">
      <el-tab-pane
        v-for="group in grouped"
        :key="group.key"
        :name="group.key"
        :label="`${group.label}（${group.rows.length}）`"
      >
        <EmptyState v-if="group.rows.length === 0" description="该分组暂无任务" :height="'120px'" />
        <el-card
          v-for="task in group.rows"
          :key="task.task_id"
          class="card-gap task-card clickable"
          shadow="never"
          @click="openDetail(task)"
        >
          <div class="card-head">
            <div class="card-head__main">
              <div class="task-purpose">{{ task.purpose }}</div>
              <div class="mono muted">{{ task.task_id }}</div>
            </div>
            <StatusTag group="task" :value="task.status" />
          </div>

          <div class="queue-item__meta">
            <span class="muted">服务主干：{{ (task.serves_item_ids || []).join('，') || '探索任务' }}</span>
            <span class="muted">{{ formatTime(task.created_at) }}</span>
          </div>

          <div v-if="task.blocked_by && task.blocked_by.length" class="queue-item__meta">
            <el-tag size="small" type="warning" effect="plain">依赖 {{ task.blocked_by.join('，') }}</el-tag>
          </div>

          <div class="done-block">
            <div class="done-block__title">完成条件</div>
            <ul class="done-list">
              <li v-for="(done, i) in task.done_when || []" :key="i">{{ done }}</li>
            </ul>
          </div>
        </el-card>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<style scoped>
.task-card {
  transition: border-color 0.15s ease;
}

.task-card:hover {
  border-color: var(--sap-primary);
}

.card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.task-purpose {
  font-size: 14px;
  line-height: 1.6;
}

.done-block {
  margin-top: 10px;
  background: var(--sap-bg-soft);
  border-radius: 6px;
  padding: 8px 10px;
}

.done-block__title {
  font-size: 12px;
  color: var(--sap-muted);
  margin-bottom: 4px;
}

.done-list {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--sap-text-secondary);
}

.done-list li {
  margin-bottom: 2px;
}
</style>
