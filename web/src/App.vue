<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api, errorMessage } from './api.js';

const route = useRoute();
const router = useRouter();

const projects = ref([]);
const selectedProjectId = ref(localStorage.getItem('sap.projectId') || '');
const ai = ref({ configured: false, model: '', base_url: '' });
const aiLoading = ref(false);

async function loadProjects() {
  try {
    projects.value = await api.listProjects();
  } catch (err) {
    ElMessage.error(errorMessage(err, '加载项目失败'));
  }
}

async function loadAiHealth() {
  aiLoading.value = true;
  try {
    ai.value = await api.getAiHealth();
  } catch (err) {
    ai.value = { configured: false, model: '', base_url: '' };
  } finally {
    aiLoading.value = false;
  }
}

onMounted(() => {
  loadProjects();
  loadAiHealth();
});

const currentProject = computed(
  () => projects.value.find((project) => project.project_id === selectedProjectId.value) || null,
);

const projectItems = computed(() => {
  const id = selectedProjectId.value;
  if (!id) return [];
  return [
    { index: `/project/${id}`, title: '项目驾驶舱', icon: 'Odometer' },
    { index: `/trunk/${id}`, title: '主干条目', icon: 'Share' },
    { index: `/requirements?project=${id}`, title: '需求队列', icon: 'Document' },
    { index: `/tasks?project=${id}`, title: '任务看板', icon: 'List' },
    { index: `/changes/${id}`, title: '变更与影响', icon: 'RefreshRight' },
    { index: `/timeline/${id}`, title: '事件时间线', icon: 'Clock' },
  ];
});

const activeMenu = computed(() => {
  const { path } = route;
  if (path === '/projects') return '/projects';
  if (path.startsWith('/project/')) return `/project/${route.params.id}`;
  if (path.startsWith('/trunk/')) return `/trunk/${route.params.projectId}`;
  if (path.startsWith('/changes/')) return `/changes/${route.params.projectId}`;
  if (path.startsWith('/timeline/')) return `/timeline/${route.params.projectId}`;
  if (path.startsWith('/requirements')) return '/requirements';
  if (path.startsWith('/tasks')) return '/tasks';
  return '/projects';
});

function onSelect(index) {
  if (index) router.push(index);
}

function onProjectChange(id) {
  selectedProjectId.value = id;
  if (id) localStorage.setItem('sap.projectId', id);
  else localStorage.removeItem('sap.projectId');
}
</script>

<template>
  <el-container class="app-shell">
    <el-aside width="224px" class="app-aside">
      <div class="brand">
        <span class="brand-name">SuperAgentPlus</span>
        <span class="brand-sub">中心面板</span>
      </div>
      <el-menu :default-active="activeMenu" class="app-menu" @select="onSelect">
        <el-menu-item index="/projects">
          <el-icon><FolderOpened /></el-icon>
          <span>项目列表</span>
        </el-menu-item>
        <el-menu-item
          v-for="item in projectItems"
          :key="item.index"
          :index="item.index"
        >
          <el-icon><component :is="item.icon" /></el-icon>
          <span>{{ item.title }}</span>
        </el-menu-item>
      </el-menu>
    </el-aside>

    <el-container>
      <el-header class="app-header" height="56px">
        <div class="header-left">
          <span class="header-title">{{ route.meta.title || 'SuperAgentPlus' }}</span>
          <span v-if="currentProject" class="muted">
            当前项目：{{ currentProject.name }}
          </span>
        </div>
        <div class="header-right">
          <el-select
            v-model="selectedProjectId"
            filterable
            clearable
            placeholder="选择项目"
            size="small"
            style="width: 240px"
            @change="onProjectChange"
          >
            <el-option
              v-for="project in projects"
              :key="project.project_id"
              :label="`${project.name}（${project.project_id}）`"
              :value="project.project_id"
            />
          </el-select>
          <el-tag
            v-loading="aiLoading"
            :type="ai.configured ? 'success' : 'info'"
            effect="light"
            size="small"
          >
            {{ ai.configured ? `AI 已配置：${ai.model}` : 'AI 未配置' }}
          </el-tag>
          <el-button size="small" text @click="loadAiHealth">
            <el-icon><Refresh /></el-icon>
          </el-button>
        </div>
      </el-header>

      <el-main class="app-main">
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<style scoped>
.app-shell {
  height: 100vh;
}

.app-aside {
  background: #fff;
  border-right: 1px solid #e4e7ed;
  overflow-y: auto;
}

.brand {
  height: 56px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 0 16px;
  border-bottom: 1px solid #f0f2f5;
}

.brand-name {
  font-size: 15px;
  font-weight: 700;
}

.brand-sub {
  font-size: 12px;
  color: #909399;
}

.app-menu {
  border-right: none;
}

.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #fff;
  border-bottom: 1px solid #e4e7ed;
  padding: 0 16px;
}

.header-left {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.header-title {
  font-size: 16px;
  font-weight: 600;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.app-main {
  padding: 0;
  overflow-y: auto;
  background: #f5f7fa;
}
</style>
