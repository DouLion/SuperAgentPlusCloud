<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api, errorMessage } from './api.js';
import { appState, refreshAiHealth } from './appState.js';
import { projectNavGroups, globalNavGroups, go } from './nav.js';

const route = useRoute();
const router = useRouter();

const projects = ref([]);
const selectedProjectId = ref(localStorage.getItem('sap.projectId') || '');
const ai = appState.ai;
const aiLoading = ref(false);
const collapsed = ref(false);

const pageTitle = computed(() => route.meta.title || 'SuperAgentPlus');
const currentProject = computed(
  () => projects.value.find((project) => project.project_id === selectedProjectId.value) || null,
);
const aiText = computed(() => (ai.configured ? `AI 已配置：${ai.model}` : 'AI 未配置'));

const navGroups = computed(() => {
  const id = selectedProjectId.value;
  if (!id) return [];
  return projectNavGroups(id);
});

const runGroups = computed(() => globalNavGroups());

/** 当前项目下哪个分组被点亮。 */
const activeMenu = computed(() => {
  const { path } = route;
  if (path === '/projects') return 'projects';
  if (path === '/agents') return 'agents';
  if (path === '/settings') return 'settings';
  if (path === '/setup') return 'setup';
  if (path.startsWith('/project/')) {
    // /project/:id/<section>；overview 对应命名路由 dashboard。
    const section = path.split('/')[3] || 'overview';
    const name = section === 'overview' ? 'dashboard' : section;
    return `${name}:${route.params.id}`;
  }
  return '';
});

function onMenuSelect(index) {
  if (index === 'projects' || index === 'settings' || index === 'agents') {
    router.push({ name: index });
    return;
  }
  const [name, id] = String(index).split(':');
  if (name && id) go(router, name, { id });
}

async function loadProjects() {
  try {
    projects.value = await api.listProjects();
  } catch (err) {
    ElMessage.error(errorMessage(err, '加载项目失败'));
  }
}

async function reloadAiHealth() {
  aiLoading.value = true;
  try {
    await refreshAiHealth();
  } finally {
    aiLoading.value = false;
  }
}

async function loadSetupStatus() {
  try {
    const status = await api.setupStatus();
    if (!status.initialized && route.name !== 'setup') {
      router.replace({ name: 'setup' });
    }
  } catch {
    // 状态接口不可用时不打断面板。
  }
}

onMounted(() => {
  loadProjects();
  reloadAiHealth();
  loadSetupStatus();
});

router.afterEach(() => {
  reloadAiHealth();
});

watch(
  () => route.params.id,
  (id) => {
    if (!id) return;
    selectedProjectId.value = String(id);
    localStorage.setItem('sap.projectId', String(id));
  },
  { immediate: true },
);

function onProjectChange(id) {
  selectedProjectId.value = id || '';
  if (id) localStorage.setItem('sap.projectId', id);
  else localStorage.removeItem('sap.projectId');
}

function enterProject(id) {
  go(router, 'dashboard', { id });
}
</script>

<template>
  <el-container class="app-shell">
    <el-aside :width="collapsed ? '64px' : '232px'" class="app-aside">
      <div class="brand">
        <span class="brand-name">SuperAgentPlus</span>
        <span v-if="!collapsed" class="brand-sub">项目工作台</span>
      </div>

      <el-menu
        :default-active="activeMenu"
        :collapse="collapsed"
        :collapse-transition="false"
        class="app-menu"
        @select="onMenuSelect"
      >
        <el-menu-item index="projects">
          <el-icon><FolderOpened /></el-icon>
          <template #title>项目列表</template>
        </el-menu-item>

        <template v-for="group in navGroups" :key="group.title">
          <el-menu-item-group :title="collapsed ? '' : group.title">
            <el-menu-item
              v-for="item in group.items"
              :key="item.name"
              :index="`${item.name}:${item.id}`"
            >
              <el-icon><component :is="item.icon" /></el-icon>
              <template #title>{{ item.title }}</template>
            </el-menu-item>
          </el-menu-item-group>
        </template>

        <template v-for="group in runGroups" :key="group.title">
          <el-menu-item-group :title="collapsed ? '' : group.title">
            <el-menu-item
              v-for="item in group.items"
              :key="item.name"
              :index="item.name"
            >
              <el-icon><component :is="item.icon" /></el-icon>
              <template #title>{{ item.title }}</template>
            </el-menu-item>
          </el-menu-item-group>
        </template>

        <el-menu-item index="settings">
          <el-icon><Setting /></el-icon>
          <template #title>设置</template>
        </el-menu-item>
      </el-menu>

      <div class="aside-foot">
        <el-button text size="small" @click="collapsed = !collapsed">
          <el-icon><component :is="collapsed ? 'Expand' : 'Fold'" /></el-icon>
          <span v-if="!collapsed">收起</span>
        </el-button>
      </div>
    </el-aside>

    <el-container>
      <el-header class="app-header" height="56px">
        <div class="header-left">
          <el-breadcrumb separator="/">
            <el-breadcrumb-item v-if="currentProject" :to="{ name: 'projects' }">
              {{ currentProject.name }}
            </el-breadcrumb-item>
            <el-breadcrumb-item>{{ pageTitle }}</el-breadcrumb-item>
          </el-breadcrumb>
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

          <el-button size="small" @click="enterProject(selectedProjectId)">进入项目</el-button>

          <el-tag
            v-loading="aiLoading"
            :type="ai.configured ? 'success' : 'info'"
            effect="light"
            size="small"
          >
            {{ aiText }}
          </el-tag>
          <el-button size="small" text @click="reloadAiHealth">
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
  border-right: 1px solid var(--sap-border);
  overflow-y: auto;
  transition: width 0.2s ease;
  display: flex;
  flex-direction: column;
}

.brand {
  height: 56px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 0 16px;
  border-bottom: 1px solid var(--sap-border-soft);
  flex-shrink: 0;
}

.brand-name {
  font-size: 15px;
  font-weight: 700;
}

.brand-sub {
  font-size: 12px;
  color: var(--sap-muted);
}

.app-menu {
  border-right: none;
  flex: 1;
}

.app-menu :deep(.el-menu-item-group__title) {
  font-size: 12px;
  color: var(--sap-muted);
  padding-left: 20px;
}

.aside-foot {
  border-top: 1px solid var(--sap-border-soft);
  padding: 6px 8px;
  flex-shrink: 0;
}

.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #fff;
  border-bottom: 1px solid var(--sap-border);
  padding: 0 16px;
  gap: 12px;
  flex-wrap: wrap;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.app-main {
  padding: 0;
  overflow-y: auto;
  background: var(--sap-bg);
}
</style>
