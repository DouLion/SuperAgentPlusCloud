// 流程图 HTTP 路由：整图读写，节点与连线按图内 id 操作。

import {
  addEdge,
  addNode,
  archiveDiagram,
  attachSubDiagram,
  createDiagram,
  deleteEdge,
  deleteNode,
  getDiagramDetail,
  listDiagrams,
  seedSample,
  updateDiagram,
  updateNode,
} from '../../db/diagrams.mjs';

export const ROUTES = [
  {
    method: 'GET',
    pattern: '/projects/:id/diagrams',
    handler: ({ db, params, url }) => listDiagrams(db, {
      project_id: params.id,
      kind: url.searchParams.get('kind') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
    }),
  },
  {
    method: 'POST',
    pattern: '/projects/:id/diagrams',
    handler: ({ db, params, body }) => ({
      status: 201,
      body: createDiagram(db, { ...body, project_id: params.id }),
    }),
  },
  {
    method: 'POST',
    pattern: '/projects/:id/diagrams/seed',
    handler: ({ db, params, body }) => seedSample(db, params.id, body?.created_by ?? '演示'),
  },
  {
    method: 'GET',
    pattern: '/diagrams/:id',
    handler: ({ db, params }) => getDiagramDetail(db, params.id),
  },
  {
    method: 'PATCH',
    pattern: '/diagrams/:id',
    handler: ({ db, params, body }) => updateDiagram(db, params.id, body),
  },
  {
    method: 'POST',
    pattern: '/diagrams/:id/archive',
    handler: ({ db, params }) => archiveDiagram(db, params.id),
  },
  {
    method: 'POST',
    pattern: '/diagrams/:id/nodes',
    handler: ({ db, params, body }) => ({ status: 201, body: addNode(db, params.id, body) }),
  },
  {
    method: 'PATCH',
    pattern: '/diagrams/:id/nodes/:nodeId',
    handler: ({ db, params, body }) => updateNode(db, params.id, params.nodeId, body),
  },
  {
    method: 'DELETE',
    pattern: '/diagrams/:id/nodes/:nodeId',
    handler: ({ db, params }) => deleteNode(db, params.id, params.nodeId),
  },
  {
    method: 'POST',
    pattern: '/diagrams/:id/edges',
    handler: ({ db, params, body }) => ({ status: 201, body: addEdge(db, params.id, body) }),
  },
  {
    method: 'DELETE',
    pattern: '/diagrams/:id/edges/:edgeId',
    handler: ({ db, params }) => deleteEdge(db, params.id, params.edgeId),
  },
  {
    method: 'POST',
    pattern: '/diagrams/:id/sub',
    handler: ({ db, params, body }) => ({ status: 201, body: attachSubDiagram(db, params.id, body) }),
  },
];
