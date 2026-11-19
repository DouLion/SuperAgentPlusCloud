// 项目流程图：一张图整存 JSON（节点 + 边），子图挂在主流程的某个节点上。
// 只维护结构与说明，不改变任务、需求或主干状态。

import { appendEvent } from './events.mjs';
import { assertProjectExists } from './projects.mjs';
import { decodeJson, encodeJson, codedError, newId, nowIso, pick, required } from './json.mjs';

export const DIAGRAM_KINDS = ['main', 'sub'];
export const DIAGRAM_STATUSES = ['draft', 'active', 'archived'];
export const NODE_KINDS = ['start', 'step', 'decision', 'end'];

const EMPTY_GRAPH = { nodes: [], edges: [] };
const NODE_ID_PATTERN = /^[A-Za-z0-9_]{1,8}$/;

function graphOf(row) {
  if (!row) return null;
  return { ...row, graph: decodeJson(row.graph, { ...EMPTY_GRAPH }) };
}

/** 图结构校验：节点 id 唯一，边两端存在且不指向自己。 */
export function assertGraphValid(graph) {
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
    throw codedError('DIAGRAM_GRAPH_INVALID', 'graph 必须是对象', 400);
  }
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const ids = new Set();
  for (const node of nodes) {
    const id = String(node?.node_id ?? '').trim();
    if (!NODE_ID_PATTERN.test(id)) {
      throw codedError('DIAGRAM_GRAPH_INVALID', `节点 id 非法：${id || '(空)'}`, 400);
    }
    if (ids.has(id)) throw codedError('DIAGRAM_GRAPH_INVALID', `节点 id 重复：${id}`, 400);
    ids.add(id);
    if (!String(node?.title ?? '').trim()) {
      throw codedError('DIAGRAM_GRAPH_INVALID', `节点缺少标题：${id}`, 400);
    }
    const kind = node?.kind ?? 'step';
    if (!NODE_KINDS.includes(kind)) {
      throw codedError('DIAGRAM_GRAPH_INVALID', `节点类型非法：${kind}`, 400);
    }
  }
  const edgeIds = new Set();
  for (const edge of edges) {
    const id = String(edge?.edge_id ?? '').trim();
    if (!NODE_ID_PATTERN.test(id)) {
      throw codedError('DIAGRAM_GRAPH_INVALID', `连线 id 非法：${id || '(空)'}`, 400);
    }
    if (edgeIds.has(id)) throw codedError('DIAGRAM_GRAPH_INVALID', `连线 id 重复：${id}`, 400);
    edgeIds.add(id);
    if (!ids.has(String(edge?.from ?? '')) || !ids.has(String(edge?.to ?? ''))) {
      throw codedError('DIAGRAM_GRAPH_INVALID', `连线 ${id} 指向不存在的节点`, 400);
    }
    if (String(edge.from) === String(edge.to)) {
      throw codedError('DIAGRAM_GRAPH_INVALID', `连线 ${id} 不能连接自身`, 400);
    }
  }
  return { nodes, edges };
}

/** 归一化：补齐缺省字段，去掉未声明的多余键。 */
export function normalizeGraph(graph) {
  const { nodes, edges } = assertGraphValid(graph);
  return {
    nodes: nodes.map((node) => ({
      node_id: String(node.node_id),
      title: String(node.title).trim(),
      detail: node.detail ? String(node.detail) : '',
      kind: node.kind ?? 'step',
      x: Number.isFinite(Number(node.x)) ? Number(node.x) : 0,
      y: Number.isFinite(Number(node.y)) ? Number(node.y) : 0,
      sub_diagram_id: node.sub_diagram_id ?? null,
    })),
    edges: edges.map((edge) => ({
      edge_id: String(edge.edge_id),
      from: String(edge.from),
      to: String(edge.to),
      label: edge.label ? String(edge.label) : '',
    })),
  };
}

export function getDiagram(db, diagramId) {
  return graphOf(db.prepare('SELECT * FROM diagrams WHERE diagram_id = ?').get(diagramId));
}

/** 列表：带节点数与是否有子图。 */
export function listDiagrams(db, query = {}) {
  const projectId = pick(query, 'project_id', 'projectId');
  if (!projectId) throw codedError('PROJECT_REQUIRED', '缺少 project_id', 400);
  const clauses = ['project_id = ?'];
  const params = [projectId];
  const kind = pick(query, 'kind');
  if (kind) {
    if (!DIAGRAM_KINDS.includes(kind)) throw codedError('DIAGRAM_KIND_INVALID', `非法的图类型：${kind}`, 400);
    clauses.push('kind = ?');
    params.push(kind);
  }
  const status = pick(query, 'status');
  if (status) {
    if (!DIAGRAM_STATUSES.includes(status)) throw codedError('DIAGRAM_STATUS_INVALID', `非法的图状态：${status}`, 400);
    clauses.push('status = ?');
    params.push(status);
  }
  return db.prepare(`SELECT * FROM diagrams WHERE ${clauses.join(' AND ')}
    ORDER BY CASE kind WHEN 'main' THEN 0 ELSE 1 END, created_at ASC, diagram_id ASC`)
    .all(...params)
    .map((row) => {
      const diagram = graphOf(row);
      const children = db.prepare('SELECT diagram_id FROM diagrams WHERE parent_diagram_id = ?')
        .all(row.diagram_id);
      return {
        ...diagram,
        node_count: diagram.graph.nodes.length,
        edge_count: diagram.graph.edges.length,
        has_sub_diagrams: children.length > 0,
      };
    });
}

function requireDiagram(db, diagramId) {
  const diagram = getDiagram(db, diagramId);
  if (!diagram) throw codedError('DIAGRAM_NOT_FOUND', `流程图不存在：${diagramId}`, 404);
  return diagram;
}

export function createDiagram(db, input = {}) {
  const projectId = required(input, 'project_id', 'projectId');
  const name = required(input, 'name');
  const kind = pick(input, 'kind') ?? 'main';
  if (!DIAGRAM_KINDS.includes(kind)) throw codedError('DIAGRAM_KIND_INVALID', `非法的图类型：${kind}`, 400);
  assertProjectExists(db, projectId);

  const parentDiagramId = pick(input, 'parent_diagram_id', 'parentDiagramId') ?? null;
  const parentNodeId = pick(input, 'parent_node_id', 'parentNodeId') ?? null;
  if (kind === 'sub') {
    if (!parentDiagramId || !parentNodeId) {
      throw codedError('DIAGRAM_PARENT_REQUIRED', '子图必须提供 parent_diagram_id 与 parent_node_id', 400);
    }
    const parent = requireDiagram(db, parentDiagramId);
    if (parent.project_id !== projectId) {
      throw codedError('DIAGRAM_PARENT_MISMATCH', '父图不属于该项目', 400);
    }
    if (!parent.graph.nodes.some((node) => node.node_id === parentNodeId)) {
      throw codedError('DIAGRAM_PARENT_NODE_MISSING', `父图没有节点：${parentNodeId}`, 400);
    }
    const occupied = db.prepare(`SELECT diagram_id FROM diagrams
      WHERE parent_diagram_id = ? AND parent_node_id = ? AND status <> 'archived'`)
      .get(parentDiagramId, parentNodeId);
    if (occupied) {
      throw codedError('DIAGRAM_NODE_OCCUPIED', '该节点已有子图', 409);
    }
  } else if (parentDiagramId || parentNodeId) {
    throw codedError('DIAGRAM_GRAPH_INVALID', '主图不能指定父图', 400);
  }

  const graph = normalizeGraph(pick(input, 'graph') ?? { ...EMPTY_GRAPH });
  const diagramId = pick(input, 'diagram_id', 'diagramId') ?? newId('dia');
  const at = nowIso();
  db.prepare(`INSERT INTO diagrams (
    diagram_id, project_id, name, kind, parent_diagram_id, parent_node_id,
    graph, status, created_by, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`).run(
    diagramId, projectId, name, kind, parentDiagramId, parentNodeId,
    encodeJson(graph), pick(input, 'created_by', 'createdBy') ?? null, at, at,
  );

  if (kind === 'sub') {
    linkNodeSubDiagram(db, parentDiagramId, parentNodeId, diagramId);
  }

  appendEvent(db, {
    project_id: projectId,
    object_type: 'diagram',
    object_id: diagramId,
    event_type: 'diagram.created',
    actor: pick(input, 'created_by', 'createdBy') ?? 'system',
    occurred_at: at,
    reason: `创建流程图：${name}`,
    refs: parentDiagramId ? [parentDiagramId, parentNodeId] : [],
  });
  return getDiagram(db, diagramId);
}

/** 把父图某节点的 sub_diagram_id 指到子图。 */
function linkNodeSubDiagram(db, parentDiagramId, parentNodeId, subDiagramId) {
  const parent = requireDiagram(db, parentDiagramId);
  const graph = {
    ...parent.graph,
    nodes: parent.graph.nodes.map((node) => (node.node_id === parentNodeId
      ? { ...node, sub_diagram_id: subDiagramId }
      : node)),
  };
  db.prepare('UPDATE diagrams SET graph = ?, updated_at = ? WHERE diagram_id = ?')
    .run(encodeJson(graph), nowIso(), parentDiagramId);
}

export function updateDiagram(db, diagramId, patch = {}) {
  const diagram = requireDiagram(db, diagramId);
  const name = pick(patch, 'name') ?? diagram.name;
  const status = pick(patch, 'status') ?? diagram.status;
  if (!DIAGRAM_STATUSES.includes(status)) {
    throw codedError('DIAGRAM_STATUS_INVALID', `非法的图状态：${status}`, 400);
  }
  const graph = pick(patch, 'graph') === undefined
    ? diagram.graph
    : normalizeGraph(pick(patch, 'graph'));
  const at = nowIso();
  db.prepare('UPDATE diagrams SET name = ?, status = ?, graph = ?, updated_at = ? WHERE diagram_id = ?')
    .run(name, status, encodeJson(graph), at, diagramId);
  appendEvent(db, {
    project_id: diagram.project_id,
    object_type: 'diagram',
    object_id: diagramId,
    event_type: 'diagram.updated',
    actor: pick(patch, 'actor') ?? 'system',
    occurred_at: at,
    reason: pick(patch, 'reason') ?? `更新流程图：${name}`,
    refs: [],
  });
  return getDiagram(db, diagramId);
}

export function archiveDiagram(db, diagramId) {
  const diagram = requireDiagram(db, diagramId);
  const at = nowIso();
  db.prepare("UPDATE diagrams SET status = 'archived', updated_at = ? WHERE diagram_id = ?").run(at, diagramId);
  appendEvent(db, {
    project_id: diagram.project_id,
    object_type: 'diagram',
    object_id: diagramId,
    event_type: 'diagram.archived',
    actor: 'system',
    occurred_at: at,
    reason: `归档流程图：${diagram.name}`,
    refs: [],
  });
  return getDiagram(db, diagramId);
}

/** 追加节点；node_id 缺省按 n1、n2… 递增。 */
export function addNode(db, diagramId, input = {}) {
  const diagram = requireDiagram(db, diagramId);
  const graph = diagram.graph;
  let nodeId = pick(input, 'node_id', 'nodeId');
  if (!nodeId) {
    let index = graph.nodes.length + 1;
    while (graph.nodes.some((node) => node.node_id === `n${index}`)) index += 1;
    nodeId = `n${index}`;
  }
  if (graph.nodes.some((node) => node.node_id === nodeId)) {
    throw codedError('DIAGRAM_GRAPH_INVALID', `节点 id 重复：${nodeId}`, 400);
  }
  const node = {
    node_id: nodeId,
    title: required(input, 'title'),
    detail: pick(input, 'detail') ?? '',
    kind: pick(input, 'kind') ?? 'step',
    x: Number(pick(input, 'x') ?? 40),
    y: Number(pick(input, 'y') ?? 40),
    sub_diagram_id: null,
  };
  const next = normalizeGraph({ nodes: [...graph.nodes, node], edges: graph.edges });
  const at = nowIso();
  db.prepare('UPDATE diagrams SET graph = ?, updated_at = ? WHERE diagram_id = ?')
    .run(encodeJson(next), at, diagramId);
  return getDiagram(db, diagramId);
}

export function updateNode(db, diagramId, nodeId, patch = {}) {
  const diagram = requireDiagram(db, diagramId);
  const graph = diagram.graph;
  if (!graph.nodes.some((node) => node.node_id === nodeId)) {
    throw codedError('DIAGRAM_NODE_NOT_FOUND', `节点不存在：${nodeId}`, 404);
  }
  const nodes = graph.nodes.map((node) => (node.node_id === nodeId
    ? {
      ...node,
      title: pick(patch, 'title') ?? node.title,
      detail: pick(patch, 'detail') ?? node.detail,
      kind: pick(patch, 'kind') ?? node.kind,
      x: pick(patch, 'x') === undefined ? node.x : Number(pick(patch, 'x')),
      y: pick(patch, 'y') === undefined ? node.y : Number(pick(patch, 'y')),
    }
    : node));
  const next = normalizeGraph({ nodes, edges: graph.edges });
  db.prepare('UPDATE diagrams SET graph = ?, updated_at = ? WHERE diagram_id = ?')
    .run(encodeJson(next), nowIso(), diagramId);
  return getDiagram(db, diagramId);
}

/** 删除节点：同时删除与它相关的边，并清掉它挂的子图（子图保留但解除挂载）。 */
export function deleteNode(db, diagramId, nodeId) {
  const diagram = requireDiagram(db, diagramId);
  const graph = diagram.graph;
  if (!graph.nodes.some((node) => node.node_id === nodeId)) {
    throw codedError('DIAGRAM_NODE_NOT_FOUND', `节点不存在：${nodeId}`, 404);
  }
  const next = normalizeGraph({
    nodes: graph.nodes.filter((node) => node.node_id !== nodeId),
    edges: graph.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId),
  });
  const at = nowIso();
  db.prepare('UPDATE diagrams SET graph = ?, updated_at = ? WHERE diagram_id = ?')
    .run(encodeJson(next), at, diagramId);
  db.prepare('UPDATE diagrams SET parent_node_id = NULL WHERE parent_diagram_id = ? AND parent_node_id = ?')
    .run(diagramId, nodeId);
  return getDiagram(db, diagramId);
}

export function addEdge(db, diagramId, input = {}) {
  const diagram = requireDiagram(db, diagramId);
  const graph = diagram.graph;
  let edgeId = pick(input, 'edge_id', 'edgeId');
  if (!edgeId) {
    let index = graph.edges.length + 1;
    while (graph.edges.some((edge) => edge.edge_id === `e${index}`)) index += 1;
    edgeId = `e${index}`;
  }
  const next = normalizeGraph({
    nodes: graph.nodes,
    edges: [...graph.edges, {
      edge_id: edgeId,
      from: required(input, 'from'),
      to: required(input, 'to'),
      label: pick(input, 'label') ?? '',
    }],
  });
  db.prepare('UPDATE diagrams SET graph = ?, updated_at = ? WHERE diagram_id = ?')
    .run(encodeJson(next), nowIso(), diagramId);
  return getDiagram(db, diagramId);
}

export function deleteEdge(db, diagramId, edgeId) {
  const diagram = requireDiagram(db, diagramId);
  const graph = diagram.graph;
  if (!graph.edges.some((edge) => edge.edge_id === edgeId)) {
    throw codedError('DIAGRAM_EDGE_NOT_FOUND', `连线不存在：${edgeId}`, 404);
  }
  const next = normalizeGraph({
    nodes: graph.nodes,
    edges: graph.edges.filter((edge) => edge.edge_id !== edgeId),
  });
  db.prepare('UPDATE diagrams SET graph = ?, updated_at = ? WHERE diagram_id = ?')
    .run(encodeJson(next), nowIso(), diagramId);
  return getDiagram(db, diagramId);
}

/** 为某节点创建子图，并把该节点指向它。 */
export function attachSubDiagram(db, diagramId, input = {}) {
  const nodeId = required(input, 'node_id', 'nodeId');
  const parent = requireDiagram(db, diagramId);
  const node = parent.graph.nodes.find((one) => one.node_id === nodeId);
  if (!node) throw codedError('DIAGRAM_NODE_NOT_FOUND', `节点不存在：${nodeId}`, 404);
  if (node.sub_diagram_id) {
    throw codedError('DIAGRAM_NODE_OCCUPIED', '该节点已有子图', 409);
  }
  return createDiagram(db, {
    project_id: parent.project_id,
    name: pick(input, 'name') ?? `${node.title}｜子流程`,
    kind: 'sub',
    parent_diagram_id: diagramId,
    parent_node_id: nodeId,
    graph: pick(input, 'graph') ?? { ...EMPTY_GRAPH },
    created_by: pick(input, 'created_by', 'createdBy') ?? null,
  });
}

/** 读单张图：附带父图信息与子图列表。 */
export function getDiagramDetail(db, diagramId) {
  const diagram = requireDiagram(db, diagramId);
  const parent = diagram.parent_diagram_id
    ? db.prepare('SELECT diagram_id, name FROM diagrams WHERE diagram_id = ?').get(diagram.parent_diagram_id)
    : null;
  const children = db.prepare(`SELECT diagram_id, name, parent_node_id, status FROM diagrams
    WHERE parent_diagram_id = ? ORDER BY created_at ASC`).all(diagramId);
  return { ...diagram, parent: parent ?? null, children };
}

/**
 * 生成示例：主图「需求到交付」，两个节点各挂一张子图。
 * 幂等：项目已有主图时直接返回第一张。
 */
export function seedSample(db, projectId, createdBy = '演示') {
  assertProjectExists(db, projectId);
  const existing = listDiagrams(db, { project_id: projectId, kind: 'main' });
  if (existing.length > 0) {
    return { created: false, diagram: getDiagramDetail(db, existing[0].diagram_id) };
  }

  const main = createDiagram(db, {
    project_id: projectId,
    name: '需求到交付',
    kind: 'main',
    created_by: createdBy,
    graph: {
      nodes: [
        { node_id: 'n1', title: '提出需求', kind: 'start', x: 60, y: 40 },
        { node_id: 'n2', title: '评估影响', kind: 'step', x: 60, y: 160 },
        { node_id: 'n3', title: '确认与决定', kind: 'decision', x: 60, y: 280 },
        { node_id: 'n4', title: '拆解任务', kind: 'step', x: 300, y: 280 },
        { node_id: 'n5', title: '认领执行', kind: 'step', x: 300, y: 160 },
        { node_id: 'n6', title: '提交', kind: 'step', x: 540, y: 160 },
        { node_id: 'n7', title: '评审', kind: 'decision', x: 540, y: 280 },
        { node_id: 'n8', title: '通过', kind: 'end', x: 540, y: 400 },
      ],
      edges: [
        { edge_id: 'e1', from: 'n1', to: 'n2' },
        { edge_id: 'e2', from: 'n2', to: 'n3' },
        { edge_id: 'e3', from: 'n3', to: 'n4', label: '需要实施' },
        { edge_id: 'e4', from: 'n4', to: 'n5' },
        { edge_id: 'e5', from: 'n5', to: 'n6' },
        { edge_id: 'e6', from: 'n6', to: 'n7' },
        { edge_id: 'e7', from: 'n7', to: 'n8', label: '通过' },
        { edge_id: 'e8', from: 'n7', to: 'n5', label: '打回' },
      ],
    },
  });

  attachSubDiagram(db, main.diagram_id, {
    node_id: 'n2',
    name: '影响评估',
    created_by: createdBy,
    graph: {
      nodes: [
        { node_id: 'n1', title: '读主干', kind: 'start', x: 60, y: 40 },
        { node_id: 'n2', title: '判断等级', kind: 'step', x: 60, y: 160 },
        { node_id: 'n3', title: '是否需要变更', kind: 'decision', x: 60, y: 280 },
        { node_id: 'n4', title: '直接实施', kind: 'end', x: 300, y: 240 },
        { node_id: 'n5', title: '记录主干变更', kind: 'end', x: 300, y: 360 },
      ],
      edges: [
        { edge_id: 'e1', from: 'n1', to: 'n2' },
        { edge_id: 'e2', from: 'n2', to: 'n3' },
        { edge_id: 'e3', from: 'n3', to: 'n4', label: '不需要' },
        { edge_id: 'e4', from: 'n3', to: 'n5', label: '需要' },
      ],
    },
  });

  attachSubDiagram(db, main.diagram_id, {
    node_id: 'n7',
    name: '评审',
    created_by: createdBy,
    graph: {
      nodes: [
        { node_id: 'n1', title: '核对完成条件', kind: 'start', x: 60, y: 40 },
        { node_id: 'n2', title: '是否满足', kind: 'decision', x: 60, y: 160 },
        { node_id: 'n3', title: '通过', kind: 'end', x: 300, y: 120 },
        { node_id: 'n4', title: '打回重做', kind: 'end', x: 300, y: 240 },
      ],
      edges: [
        { edge_id: 'e1', from: 'n1', to: 'n2' },
        { edge_id: 'e2', from: 'n2', to: 'n3', label: '满足' },
        { edge_id: 'e3', from: 'n2', to: 'n4', label: '不满足' },
      ],
    },
  });

  return { created: true, diagram: getDiagramDetail(db, main.diagram_id) };
}
