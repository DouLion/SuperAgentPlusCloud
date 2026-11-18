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

// 说明：设计文档 §4.2 中「需求队列 /requirements/:projectId」与「需求详情 /requirements/:id」
// 在 vue-router 中会争抢同一路径形状，无法同时成立。这里改为：
//   列表页 /requirements、/tasks（项目通过 ?project= 传递）
//   详情页 /requirements/:id、/tasks/:id（保留设计文档写法）
const routes = [
  { path: '/', redirect: '/projects' },
  { path: '/projects', name: 'projects', component: ProjectList, meta: { title: '项目列表' } },
  { path: '/project/:id', name: 'dashboard', component: Dashboard, meta: { title: '项目驾驶舱' } },
  { path: '/trunk/:projectId', name: 'trunk', component: Trunk, meta: { title: '主干条目' } },
  { path: '/requirements', name: 'requirements', component: Requirements, meta: { title: '需求队列' } },
  {
    path: '/requirements/:id',
    name: 'requirement-detail',
    component: RequirementDetail,
    meta: { title: '需求详情与决定' },
  },
  { path: '/tasks', name: 'tasks', component: Tasks, meta: { title: '任务看板' } },
  { path: '/tasks/:id', name: 'task-detail', component: TaskDetail, meta: { title: '任务详情' } },
  { path: '/changes/:projectId', name: 'changes', component: Changes, meta: { title: '变更与影响' } },
  { path: '/timeline/:projectId', name: 'timeline', component: Timeline, meta: { title: '事件时间线' } },
  { path: '/:pathMatch(.*)*', redirect: '/projects' },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.afterEach((to) => {
  document.title = to.meta.title ? `${to.meta.title}｜SuperAgentPlus` : 'SuperAgentPlus 面板';
});

export default router;
