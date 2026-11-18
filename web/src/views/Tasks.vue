<script setup>
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api, errorMessage } from '../api.js';
import { formatTime, OPTIONS } from '../status.js';
import StatusTag from '../components/StatusTag.vue';
import EmptyState from '../components/EmptyState.vue';

const route = useRoute();
const router = useRouter();

const projectId = ref(route.query.project || localStorage.getItem('sap.projectId') || '');
const projects = ref([]);
const tasks = ref([]);
const loading = ref(false);
const statusFilter = ref('');

async function loadProjects() {
  try {
    projects.value = await api.listProjects();
    if (!projectId.value && projects.value.length > 0) {
      projectId.value = projects.value[0].project_id;
    }
  } catch (err) {
    ElMessage.error(errorMessage(err, '加载项目失败'));
  }
}

async function load() {
  if (!projectId.value) {
    tasks.value = [];
    return;
  }
  loading.value = true;
  try {
    const query = { project_id: projectId.value };
    if (statusFilter.value) query.status = statusFilter.value;
    tasks.value = await api.listTasks(query);
  } catch (err) {
    ElMessage.error(errorMessage(err, '加载任务失败'));
  } finally {
    loading.value = false;
  }
}

function onProjectChange(id) {
  projectId.value = id;
  localStorage.setItem('sap.projectId', id);
  router.replace({ path: '/tasks', query: id ? { project: id } : {} });
  load();
}

function openDetail(row) {
  router.push(`/tasks/${row.task_id}`);
}

onMounted(async () => {
  await loadProjects();
  await load();
});
</script>

<template>
  <div class="page" v-loading="loading">
    <div class="page-header">
      <div>
        <h2 class="page-title">任务看板</h2>
        <div class="page-subtitle">点击行进入任务详情，执行认领、提交与评审。</div>
      </div>
    </div>

    <div class="toolbar">
      <el-select
        v-model="projectId"
        filterable
        clearable
        placeholder="选择项目"
        style="width: 260px"
        @change="onProjectChange"
      >
        <el-option
          v-for="project in projects"
          :key="project.project_id"
          :label="`${project.name}（${project.project_id}）`"
          :value="project.project_id"
        />
      </el-select>
      <el-select v-model="statusFilter" clearable placeholder="按状态筛选" style="width: 180px" @change="load">
        <el-option
          v-for="value in OPTIONS.taskStatuses"
          :key="value"
          :label="value"
          :value="value"
        />
      </el-select>
      <el-button size="small" @click="load">
        <el-icon><Refresh /></el-icon>
        刷新
      </el-button>
    </div>

    <EmptyState v-if="!loading && tasks.length === 0" description="没有匹配的任务" />
    <el-table v-else :data="tasks" @row-click="openDetail">
      <el-table-column prop="task_id" label="任务" width="180">
        <template #default="{ row }"><span class="mono">{{ row.task_id }}</span></template>
      </el-table-column>
      <el-table-column prop="purpose" label="目标" min-width="240" show-overflow-tooltip />
      <el-table-column label="状态" width="110">
        <template #default="{ row }"><StatusTag group="task" :value="row.status" /></template>
      </el-table-column>
      <el-table-column prop="requirement_id" label="需求" width="160">
        <template #default="{ row }"><span class="mono">{{ row.requirement_id || '—' }}</span></template>
      </el-table-column>
      <el-table-column label="完成条件" width="90">
        <template #default="{ row }">{{ (row.done_when || []).length }} 条</template>
      </el-table-column>
      <el-table-column label="创建时间" width="150">
        <template #default="{ row }">{{ formatTime(row.created_at) }}</template>
      </el-table-column>
    </el-table>
  </div>
</template>
