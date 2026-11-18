// Center HTTP 路由：项目（T7 归置）。

import { createProject, listProjects } from '../../db/projects.mjs';

export const ROUTES = [
  {
    method: 'GET',
    pattern: '/projects',
    handler: ({ url, db }) => {
      const status = url.searchParams.get('status');
      return listProjects(db, status ? { status } : {});
    },
  },
  {
    method: 'POST',
    pattern: '/projects',
    handler: ({ body, db }) => ({ status: 201, body: createProject(db, body) }),
  },
];
