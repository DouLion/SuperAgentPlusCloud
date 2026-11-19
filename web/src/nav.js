// 统一命名路由跳转。项目页一律带 id；详情页额外带 requirementId/taskId。
export function go(router, name, params = {}) {
  return router.push({ name, params });
}

/** 全局导航分组：项目之外的系统级页面。 */
export function globalNavGroups() {
  return [
    {
      title: '运行',
      items: [{ name: 'agents', title: '主体与在线状态', icon: 'Connection' }],
    },
  ];
}

/** 项目内导航分组：总览 / 项目认知 / 交付执行 / 治理追溯。 */
export function projectNavGroups(id) {
  return [
    { title: '总览', items: [{ name: 'dashboard', title: '项目驾驶舱', icon: 'Odometer' }] },
    {
      title: '项目认知',
      items: [
        { name: 'trunk', title: '主干地图', icon: 'Share' },
        { name: 'requirements', title: '需求工作台', icon: 'Document' },
      ],
    },
    {
      title: '交付执行',
      items: [{ name: 'tasks', title: '任务工作台', icon: 'List' }],
    },
    {
      title: '治理追溯',
      items: [
        { name: 'changes', title: '变更影响台', icon: 'RefreshRight' },
        { name: 'timeline', title: '事件时间线', icon: 'Clock' },
      ],
    },
  ].map((group) => ({ ...group, items: group.items.map((item) => ({ ...item, id })) }));
}
