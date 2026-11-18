// Center HTTP 路由：编排模板（T12）。

import {
  activateWorkflowTemplate,
  createWorkflowTemplate,
  getWorkflowTemplate,
  listWorkflowTemplates,
  retireWorkflowTemplate,
  seedBuiltInWorkflows,
} from '../../db/workflows.mjs';

function requireTemplate(db, id) {
  const template = getWorkflowTemplate(db, id);
  if (!template) return { status: 404, body: { error: `编排模板不存在：${id}` } };
  return template;
}

export const ROUTES = [
  {
    method: 'GET', pattern: '/workflow-templates',
    handler: ({ db, url }) => listWorkflowTemplates(db, Object.fromEntries(url.searchParams)),
  },
  {
    method: 'POST', pattern: '/workflow-templates',
    handler: ({ db, body }) => ({ status: 201, body: createWorkflowTemplate(db, body) }),
  },
  {
    method: 'GET', pattern: '/workflow-templates/:id',
    handler: ({ db, params }) => requireTemplate(db, params.id),
  },
  {
    method: 'POST', pattern: '/workflow-templates/:id/activate',
    handler: ({ db, params, body }) => ({ status: 200, body: activateWorkflowTemplate(db, params.id, body) }),
  },
  {
    method: 'POST', pattern: '/workflow-templates/:id/retire',
    handler: ({ db, params, body }) => ({ status: 200, body: retireWorkflowTemplate(db, params.id, body) }),
  },
  {
    method: 'POST', pattern: '/workflow-templates/seed',
    handler: ({ db, body }) => ({ status: 200, body: seedBuiltInWorkflows(db, body) }),
  },
];
