// Center HTTP 路由：设置向导与配置更新（T10）。
// GET /setup/status 不回显 api_key 明文；POST /setup/init 首次初始化；POST /setup 更新配置。

import { setupStatus, initSetup, updateSetup } from '../../setup.mjs';

export const ROUTES = [
  {
    method: 'GET',
    pattern: '/setup/status',
    handler: () => setupStatus(),
  },
  {
    method: 'POST',
    pattern: '/setup/init',
    handler: ({ body }) => initSetup(body || {}),
  },
  {
    method: 'POST',
    pattern: '/setup',
    handler: ({ body }) => updateSetup(body || {}),
  },
];
