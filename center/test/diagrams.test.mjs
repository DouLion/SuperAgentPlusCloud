// 流程图测试：单表 JSON 图结构、子图挂载与结构校验。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/db/store.mjs';
import { createProject } from '../src/db/projects.mjs';
import {
  addEdge,
  addNode,
  attachSubDiagram,
  createDiagram,
  deleteNode,
  getDiagram,
  getDiagramDetail,
  listDiagrams,
  seedSample,
  updateDiagram,
} from '../src/db/diagrams.mjs';

function withDb(fn) {
  const file = path.join(os.tmpdir(), `sap-dia-${process.pid}-${Date.now()}-${Math.random()}.db`);
  const db = openStore(file);
  try {
    fn(db);
  } finally {
    db.close();
    try { fs.rmSync(file, { force: true }); } catch { /* 忽略清理失败 */ }
  }
}

const GRAPH = {
  nodes: [
    { node_id: 'n1', title: '提出', kind: 'start', x: 40, y: 40 },
    { node_id: 'n2', title: '评估' },
  ],
  edges: [{ edge_id: 'e1', from: 'n1', to: 'n2' }],
};

test('流程图：建主图、加节点与连线、列表带节点数', () => withDb((db) => {
  const project = createProject(db, { name: '图项目' });
  const main = createDiagram(db, { project_id: project.project_id, name: '主流程', kind: 'main' });
  assert.equal(main.kind, 'main');
  assert.deepEqual(main.graph, { nodes: [], edges: [] });

  const withNodes = addNode(db, main.diagram_id, { node_id: 'n1', title: '提出需求', kind: 'start' });
  assert.equal(withNodes.graph.nodes.length, 1);
  addNode(db, main.diagram_id, { node_id: 'n2', title: '评估影响' });
  addEdge(db, main.diagram_id, { from: 'n1', to: 'n2', label: '下一步' });

  const list = listDiagrams(db, { project_id: project.project_id });
  assert.equal(list.length, 1);
  assert.equal(list[0].node_count, 2);
  assert.equal(list[0].edge_count, 1);
}));

test('流程图：子图必须带父图与父节点，跨项目父图报错', () => withDb((db) => {
  const project = createProject(db, { name: '子图项目' });
  const other = createProject(db, { name: '另一个项目' });
  const main = createDiagram(db, { project_id: project.project_id, name: '主流程', graph: GRAPH });

  assert.throws(
    () => createDiagram(db, { project_id: project.project_id, name: '坏子图', kind: 'sub' }),
    /子图必须提供/,
  );

  assert.throws(
    () => createDiagram(db, {
      project_id: other.project_id, name: '跨项目子图', kind: 'sub',
      parent_diagram_id: main.diagram_id, parent_node_id: 'n1',
    }),
    /父图不属于该项目/,
  );

  const sub = createDiagram(db, {
    project_id: project.project_id, name: '评估子流程', kind: 'sub',
    parent_diagram_id: main.diagram_id, parent_node_id: 'n2',
  });
  const parentAfter = getDiagram(db, main.diagram_id);
  const node = parentAfter.graph.nodes.find((one) => one.node_id === 'n2');
  assert.equal(node.sub_diagram_id, sub.diagram_id, '父节点应指向子图');

  const detail = getDiagramDetail(db, sub.diagram_id);
  assert.equal(detail.parent.diagram_id, main.diagram_id);
  assert.equal(getDiagramDetail(db, main.diagram_id).children.length, 1);

  assert.throws(
    () => attachSubDiagram(db, main.diagram_id, { node_id: 'n2', name: '重复' }),
    /已有子图/,
  );
}));

test('流程图：图结构非法时拒绝写入', () => withDb((db) => {
  const project = createProject(db, { name: '校验项目' });
  assert.throws(
    () => createDiagram(db, {
      project_id: project.project_id,
      name: '重复节点',
      graph: { nodes: [{ node_id: 'n1', title: 'A' }, { node_id: 'n1', title: 'B' }], edges: [] },
    }),
    /节点 id 重复/,
  );

  assert.throws(
    () => createDiagram(db, {
      project_id: project.project_id,
      name: '坏边',
      graph: { nodes: [{ node_id: 'n1', title: 'A' }], edges: [{ edge_id: 'e1', from: 'n1', to: 'n9' }] },
    }),
    /指向不存在的节点/,
  );

  assert.throws(
    () => createDiagram(db, {
      project_id: project.project_id,
      name: '超长 id',
      graph: { nodes: [{ node_id: 'node-too-long', title: 'A' }], edges: [] },
    }),
    /节点 id 非法/,
  );
}));

test('流程图：删除节点同时清边，PATCH 整图替换后时间更新', () => withDb((db) => {
  const project = createProject(db, { name: '删除项目' });
  const main = createDiagram(db, { project_id: project.project_id, name: '主流程', graph: GRAPH });

  const afterDelete = deleteNode(db, main.diagram_id, 'n2');
  assert.equal(afterDelete.graph.nodes.length, 1);
  assert.equal(afterDelete.graph.edges.length, 0, '相关边应被一并删除');

  const replaced = updateDiagram(db, main.diagram_id, {
    graph: { nodes: [{ node_id: 'a', title: '唯一节点' }], edges: [] },
  });
  assert.equal(replaced.graph.nodes.length, 1);
  assert.equal(replaced.graph.nodes[0].node_id, 'a');
  assert.ok(getDiagram(db, main.diagram_id).updated_at >= main.created_at);
}));

test('流程图：示例包含主图与两张子图，且重复生成不叠加', () => withDb((db) => {
  const project = createProject(db, { name: '示例项目' });
  const first = seedSample(db, project.project_id);
  assert.equal(first.created, true);
  assert.equal(first.diagram.children.length, 2);

  const main = first.diagram;
  const withSub = main.graph.nodes.filter((node) => node.sub_diagram_id);
  assert.equal(withSub.length, 2, '主图应有两个可下钻节点');
  assert.ok(main.graph.edges.length >= 6);

  const again = seedSample(db, project.project_id);
  assert.equal(again.created, false);
  const all = listDiagrams(db, { project_id: project.project_id });
  assert.equal(all.length, 3, '主图 + 两张子图');
}));
