<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api, errorMessage } from '../api.js';
import { formatTime, TRUNK_KIND_TEXT } from '../status.js';
import StatusTag from '../components/StatusTag.vue';
import EmptyState from '../components/EmptyState.vue';

const route = useRoute();
const router = useRouter();
const projectId = route.params.id;

const loading = ref(false);
const trunk = ref([]);
const requirements = ref([]);
const tasks = ref([]);
const changes = ref([]);

const TODO_REQUIREMENT_STATUSES = ['submitted', 'needs_info', 'assessed'];
const ACTIVE_TASK_STATUSES = ['open', 'claimed', 'submitted', 'rework'];

const activeTrunkCount = computed(() => trunk.value.filter((item) => item.status === 'active').length);
const todoRequirementCount = computed(
  () => requirements.value.filter((item) => TODO_REQUIREMENT_STATUSES.includes(item.status)).length,
);
const activeTaskCount = computed(
  () => tasks.value.filter((item) => ACTIVE_TASK_STATUSES.includes(item.status)).length,
);
const openChangeCount = computed(() => changes.value.filter((item) => item.status !== 'closed').length);

async function load() {
  loading.value = true;
  try {
    const [trunkRows, requirementRows, taskRows, changeRows] = await Promise.all([
      api.listTrunkItems({ project_id: projectId }),
      api.listRequirements({ project_id: projectId }),
      api.listTasks({ project_id: projectId }),
      api.listTrunkChanges({ project_id: projectId }),
    ]);
    trunk.value = trunkRows;
    requirements.value = requirementRows;
    tasks.value = taskRows;
    changes.value = changeRows;
  } catch (err) {
    ElMessage.error(errorMessage(err, '加载驾驶舱失败'));
  } finally {
    loading.value = false;
  }
}

function openRequirement(row) {
  router.push(`/requirements/${row.requirement_id}`);
}

function openTask(row) {
  router.push(`/tasks/${row.task_id}`);
}

function openChange(row) {
  router.push(`/changes/${projectId}`);
}

onMounted(() => {
  if (!projectId) {
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
        <h2 class="page-title">项目驾驶舱</h2>
        <div class="page-subtitle mono">项目：{{ projectId }}</div>
      </div>
      <el-button size="small" @click="load">
        <el-icon><Refresh /></el-icon>
        刷新
      </el-button>
    </div>

    <el-row class="stat-row" :gutter="16">
      <el-col :xs="12" :md="6">
        <div class="stat-card">
          <el-statistic title="生效中主干条目" :value="activeTrunkCount" />
        </div>
      </el-col>
      <el-col :xs="12" :md="6">
        <div class="stat-card">
          <el-statistic title="待办需求" :value="todoRequirementCount" />
        </div>
      </el-col>
      <el-col :xs="12" :md="6">
        <div class="stat-card">
          <el-statistic title="进行中任务" :value="activeTaskCount" />
        </div>
      </el-col>
      <el-col :xs="12" :md="6">
        <div class="stat-card">
          <el-statistic title="未关闭变更" :value="openChangeCount" />
        </div>
      </el-col>
    </el-row>

    <el-card shadow="never">
      <el-tabs>
        <el-tab-pane label="主干条目">
          <EmptyState v-if="trunk.length === 0" description="该项目还没有主干条目" />
          <el-table v-else :data="trunk" size="small">
            <el-table-column prop="statement" label="表述" min-width="280" show-overflow-tooltip />
            <el-table-column label="类型" width="120">
              <template #default="{ row }">{{ TRUNK_KIND_TEXT[row.kind] || row.kind }}</template>
            </el-table-column>
            <el-table-column label="状态" width="120">
              <template #default="{ row }"><StatusTag group="trunk" :value="row.status" /></template>
            </el-table-column>
            <el-table-column prop="confirmed_by" label="确认人" width="120">
              <template #default="{ row }">{{ row.confirmed_by || '—' }}</template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane label="需求">
          <EmptyState v-if="requirements.length === 0" description="该项目还没有需求" />
          <el-table v-else :data="requirements" size="small" @row-click="openRequirement">
            <el-table-column prop="raw_text" label="原文" min-width="260" show-overflow-tooltip />
            <el-table-column label="自报等级" width="100">
              <template #default="{ row }">{{ row.claimed_level || '—' }}</template>
            </el-table-column>
            <el-table-column label="最终等级" width="100">
              <template #default="{ row }">{{ row.final_level || '—' }}</template>
            </el-table-column>
            <el-table-column label="状态" width="120">
              <template #default="{ row }"><StatusTag group="requirement" :value="row.status" /></template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane label="任务">
          <EmptyState v-if="tasks.length === 0" description="该项目还没有任务" />
          <el-table v-else :data="tasks" size="small" @row-click="openTask">
            <el-table-column prop="purpose" label="目标" min-width="260" show-overflow-tooltip />
            <el-table-column label="状态" width="110">
              <template #default="{ row }"><StatusTag group="task" :value="row.status" /></template>
            </el-table-column>
            <el-table-column prop="requirement_id" label="需求" width="140">
              <template #default="{ row }">
                <span class="mono">{{ row.requirement_id || '—' }}</span>
              </template>
            </el-table-column>
            <el-table-column label="更新时间" width="150">
              <template #default="{ row }">{{ formatTime(row.created_at) }}</template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane label="变更">
          <EmptyState v-if="changes.length === 0" description="该项目还没有主干变更" />
          <el-table v-else :data="changes" size="small" @row-click="openChange">
            <el-table-column prop="reason" label="理由" min-width="260" show-overflow-tooltip />
            <el-table-column label="状态" width="110">
              <template #default="{ row }"><StatusTag group="change" :value="row.status" /></template>
            </el-table-column>
            <el-table-column label="生效时间" width="150">
              <template #default="{ row }">{{ formatTime(row.effective_at) }}</template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </el-card>
  </div>
</template>
