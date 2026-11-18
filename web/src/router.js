import { createRouter, createWebHistory } from 'vue-router';

import ProjectList from './views/ProjectList.vue';
import Dashboard from './views/Dashboard.vue';
import Trunk from './views/Trunk.vue';
import Requirements from './views/Requirements.vue';
import RequirementDetail from './views/RequirementDetail.vue';
import Tasks from './views/Tasks.vue';
import TaskDetail from './views/TaskDetail.vue';
import Changes from './views/Changes.vue';
import Timeline from './views/Timeline.vue';
import Setup from './views/Setup.vue';
import Settings from './views/Settings.vue';

// URL 契约见 docs/08 §3：页面统一在 /sap-cloud/* 下，项目内部嵌套在 /project/:id/*。
const routes = [
  { path: '/', redirect: '/projects' },
  { path: '/setup', name: 'setup', component: Setup, meta: { title: '初始化设置' } },
  { path: '/settings', name: 'settings', component: Settings, meta: { title: '系统设置' } },
  { path: '/projects', name: 'projects', component: ProjectList, meta: { title: '项目列表' } },
  {
    path: '/project/:id',
    redirect: (to) => `/project/${to.params.id}/overview`,
  },
  {
    path: '/project/:id/overview',
    name: 'dashboard',
    component: Dashboard,
    meta: { title: '项目驾驶舱' },
  },
  {
    path: '/project/:id/trunk',
    name: 'trunk',
    component: Trunk,
    meta: { title: '主干条目' },
  },
  {
    path: '/project/:id/requirements',
    name: 'requirements',
    component: Requirements,
    meta: { title: '需求队列' },
  },
  {
    path: '/project/:id/requirements/:requirementId',
    name: 'requirement-detail',
    component: RequirementDetail,
    meta: { title: '需求详情与决定' },
  },
  {
    path: '/project/:id/tasks',
    name: 'tasks',
    component: Tasks,
    meta: { title: '任务看板' },
  },
  {
    path: '/project/:id/tasks/:taskId',
    name: 'task-detail',
    component: TaskDetail,
    meta: { title: '任务详情' },
  },
  {
    path: '/project/:id/changes',
    name: 'changes',
    component: Changes,
    meta: { title: '变更与影响' },
  },
  {
    path: '/project/:id/timeline',
    name: 'timeline',
    component: Timeline,
    meta: { title: '事件时间线' },
  },
  { path: '/:pathMatch(.*)*', redirect: '/projects' },
];

const router = createRouter({
  history: createWebHistory('/sap-cloud/'),
  routes,
});

router.afterEach((to) => {
  document.title = to.meta.title ? `${to.meta.title}｜SuperAgentPlus` : 'SuperAgentPlus 面板';
});

export default router;
