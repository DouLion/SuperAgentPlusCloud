<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, errorMessage } from '../api.js';
import EmptyState from '../components/EmptyState.vue';

const route = useRoute();
const projectId = route.params.id;

const KIND_TEXT = { start: '开始', step: '步骤', decision: '判断', end: '结束' };
const STATUS_TEXT = { draft: '草稿', active: '生效', archived: '归档' };

const W = 168;
const H = 64;
const CANVAS = { width: 1240, height: 760 };

const diagrams = ref([]);
const loading = ref(false);
const current = ref(null);
const selected = ref(null);
const selectedEdge = ref(null);
const mode = ref('view');
const linking = ref(null);
const dragging = reactive({ node: null, startX: 0, startY: 0, originX: 0, originY: 0, moved: false });

const nodes = computed(() => current.value?.graph?.nodes || []);
const edges = computed(() => current.value?.graph?.edges || []);

const breadcrumb = computed(() => {
  const trail = [];
  if (current.value?.parent) trail.push(current.value.parent);
  if (current.value) trail.push({ diagram_id: current.value.diagram_id, name: current.value.name });
  return trail;
});

const mainCount = computed(() => diagrams.value.filter((one) => one.kind === 'main').length);

async function loadList() {
  loading.value = true;
  try {
    diagrams.value = await api.listDiagrams(projectId);
    if (!current.value && diagrams.value.length) await openDiagram(diagrams.value[0].diagram_id);
  } catch (err) {
    ElMessage.error(errorMessage(err, '加载流程图失败'));
  } finally {
    loading.value = false;
  }
}

async function openDiagram(diagramId) {
  try {
    current.value = await api.getDiagram(diagramId);
    selected.value = null;
    selectedEdge.value = null;
    linking.value = null;
  } catch (err) {
    ElMessage.error(errorMessage(err, '打开流程图失败'));
  }
}

async function refreshCurrent() {
  if (!current.value) return;
  const keepId = selected.value?.node_id;
  await openDiagram(current.value.diagram_id);
  if (keepId) selected.value = nodes.value.find((node) => node.node_id === keepId) || null;
  diagrams.value = await api.listDiagrams(projectId);
}

async function seedSample() {
  try {
    const result = await api.seedDiagrams(projectId, { created_by: '面板' });
    await loadList();
    await openDiagram(result.diagram.diagram_id);
    ElMessage.success(result.created ? '已生成示例流程' : '已存在主流程');
  } catch (err) {
    ElMessage.error(errorMessage(err, '生成示例流程失败'));
  }
}

// ---------------------------------------------------------------- 画布
function edgePath(edge) {
  const from = nodes.value.find((node) => node.node_id === edge.from);
  const to = nodes.value.find((node) => node.node_id === edge.to);
  if (!from || !to) return '';
  const x1 = from.x + W / 2;
  const y1 = from.y + H;
  const x2 = to.x + W / 2;
  const y2 = to.y;
  const mid = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
}

function edgeLabel(edge) {
  const from = nodes.value.find((node) => node.node_id === edge.from);
  const to = nodes.value.find((node) => node.node_id === edge.to);
  if (!from || !to || !edge.label) return null;
  return {
    text: edge.label,
    x: (from.x + to.x) / 2 + W / 2,
    y: (from.y + to.y) / 2 + H / 2,
  };
}

function nodeShape(node) {
  if (node.kind === 'start' || node.kind === 'end') return 'pill';
  if (node.kind === 'decision') return 'diamond';
  return 'rect';
}

function nodeClass(node) {
  return [
    'dgm-node',
    `dgm-node--${nodeShape(node)}`,
    selected.value?.node_id === node.node_id ? 'is-selected' : '',
  ];
}

function selectNode(node) {
  selectedEdge.value = null;
  if (mode.value === 'edit' && linking.value) {
    if (!linking.value.from) {
      linking.value = { from: node.node_id };
      return;
    }
    if (linking.value.from === node.node_id) {
      linking.value = null;
      return;
    }
    createEdge(linking.value.from, node.node_id);
    return;
  }
  selected.value = node;
}

function enterSub(node) {
  if (node.sub_diagram_id) openDiagram(node.sub_diagram_id);
}

// ---------------------------------------------------------------- 拖拽
function startDrag(event, node) {
  if (mode.value !== 'edit') return;
  selected.value = node;
  dragging.node = node;
  dragging.startX = event.clientX;
  dragging.startY = event.clientY;
  dragging.originX = node.x;
  dragging.originY = node.y;
  dragging.moved = false;
  event.target.setPointerCapture?.(event.pointerId);
}

function onDrag(event) {
  if (!dragging.node) return;
  const dx = event.clientX - dragging.startX;
  const dy = event.clientY - dragging.startY;
  if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragging.moved = true;
  dragging.node.x = Math.max(0, Math.round(dragging.originX + dx));
  dragging.node.y = Math.max(0, Math.round(dragging.originY + dy));
}

async function endDrag() {
  if (!dragging.node) return;
  const node = dragging.node;
  dragging.node = null;
  if (!dragging.moved) return;
  try {
    await api.updateDiagramNode(current.value.diagram_id, node.node_id, { x: node.x, y: node.y });
  } catch (err) {
    ElMessage.error(errorMessage(err, '保存位置失败'));
    await refreshCurrent();
  }
}

// ---------------------------------------------------------------- 编辑
const nodeDialog = ref(false);
const nodeSaving = ref(false);
const nodeForm = reactive({ title: '', detail: '', kind: 'step' });

function openNodeDialog(node = null) {
  selected.value = node;
  Object.assign(nodeForm, node
    ? { title: node.title, detail: node.detail || '', kind: node.kind }
    : { title: '', detail: '', kind: 'step' });
  nodeDialog.value = true;
}

async function submitNode() {
  if (!nodeForm.title.trim()) {
    ElMessage.warning('请填写标题');
    return;
  }
  nodeSaving.value = true;
  try {
    if (selected.value?.node_id) {
      await api.updateDiagramNode(current.value.diagram_id, selected.value.node_id, { ...nodeForm });
    } else {
      const nextIndex = nodes.value.length + 1;
      await api.addDiagramNode(current.value.diagram_id, {
        ...nodeForm,
        x: 80 + (nextIndex % 4) * 200,
        y: 80 + Math.floor(nextIndex / 4) * 120,
      });
    }
    nodeDialog.value = false;
    await refreshCurrent();
  } catch (err) {
    ElMessage.error(errorMessage(err, '保存节点失败'));
  } finally {
    nodeSaving.value = false;
  }
}

async function removeNode(node) {
  try {
    await ElMessageBox.confirm(`删除节点「${node.title}」？`, '删除节点', {
      confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning',
    });
    await api.deleteDiagramNode(current.value.diagram_id, node.node_id);
    selected.value = null;
    await refreshCurrent();
  } catch (err) {
    if (err === 'cancel' || err === 'close') return;
    ElMessage.error(errorMessage(err, '删除节点失败'));
  }
}

async function createEdge(from, to) {
  try {
    await api.addDiagramEdge(current.value.diagram_id, { from, to });
    linking.value = null;
    await refreshCurrent();
  } catch (err) {
    linking.value = null;
    ElMessage.error(errorMessage(err, '添加连线失败'));
  }
}

function startLink() {
  mode.value = 'edit';
  linking.value = { from: null };
}

async function removeEdge(edge) {
  try {
    await api.deleteDiagramEdge(current.value.diagram_id, edge.edge_id);
    selectedEdge.value = null;
    await refreshCurrent();
  } catch (err) {
    ElMessage.error(errorMessage(err, '删除连线失败'));
  }
}

async function makeSubDiagram(node) {
  try {
    const { value } = await ElMessageBox.prompt('子流程名称', '创建子流程', {
      inputValue: `${node.title}｜子流程`,
      confirmButtonText: '创建',
      cancelButtonText: '取消',
    });
    const child = await api.createSubDiagram(current.value.diagram_id, {
      node_id: node.node_id,
      name: value,
      created_by: '面板',
    });
    await refreshCurrent();
    await openDiagram(child.diagram_id);
  } catch (err) {
    if (err === 'cancel' || err === 'close') return;
    ElMessage.error(errorMessage(err, '创建子流程失败'));
  }
}

const chartDialog = ref(false);
const chartSaving = ref(false);
const chartForm = reactive({ name: '', description: '' });

async function submitChart() {
  if (!chartForm.name.trim()) {
    ElMessage.warning('请填写名称');
    return;
  }
  chartSaving.value = true;
  try {
    const created = await api.createDiagram(projectId, { ...chartForm, kind: 'main', created_by: '面板' });
    chartDialog.value = false;
    await loadList();
    await openDiagram(created.diagram_id);
  } catch (err) {
    ElMessage.error(errorMessage(err, '创建流程图失败'));
  } finally {
    chartSaving.value = false;
  }
}

onMounted(loadList);
</script>

<template>
  <div class="page" v-loading="loading">
    <div class="page-header">
      <h2 class="page-title">流程图</h2>
      <div class="toolbar">
        <el-button plain @click="chartDialog = true">新建主流程</el-button>
        <el-button v-if="mainCount === 0" type="primary" plain @click="seedSample">生成示例流程</el-button>
        <el-button v-if="current" plain :type="mode === 'edit' ? 'primary' : ''" @click="mode = mode === 'edit' ? 'view' : 'edit'">
          {{ mode === 'edit' ? '退出编辑' : '编辑' }}
        </el-button>
        <el-button v-if="current && mode === 'edit'" plain @click="openNodeDialog()">新建节点</el-button>
        <el-button v-if="current && mode === 'edit'" plain @click="startLink">连线</el-button>
      </div>
    </div>

    <div v-if="diagrams.length === 0" class="panel">
      <EmptyState description="无">
        <el-button type="primary" plain @click="chartDialog = true">新建主流程</el-button>
        <el-button plain @click="seedSample">生成示例流程</el-button>
      </EmptyState>
    </div>

    <div v-else class="dgm-layout">
      <div class="panel dgm-list">
        <div class="panel__head">
          <span class="panel__title">流程</span>
          <span class="panel__count">{{ diagrams.length }}</span>
        </div>
        <div
          v-for="item in diagrams"
          :key="item.diagram_id"
          class="dgm-list__item"
          :class="{ 'is-active': current && current.diagram_id === item.diagram_id, 'is-sub': item.kind === 'sub' }"
          @click="openDiagram(item.diagram_id)"
        >
          <span class="dgm-list__name">{{ item.name }}</span>
          <el-tag size="small" effect="plain">{{ item.node_count }}</el-tag>
        </div>
      </div>

      <div class="panel dgm-main">
        <div class="panel__head">
          <div class="dgm-crumbs" v-if="current">
            <template v-for="(step, index) in breadcrumb" :key="step.diagram_id">
              <span v-if="index > 0" class="dgm-crumbs__sep">/</span>
              <el-button link :type="index === breadcrumb.length - 1 ? 'default' : 'primary'" @click="openDiagram(step.diagram_id)">
                {{ step.name }}
              </el-button>
            </template>
            <el-tag size="small" type="info">{{ STATUS_TEXT[current.status] }}</el-tag>
          </div>
          <span class="panel__count">{{ nodes.length }} 节点 / {{ edges.length }} 连线</span>
        </div>

        <div v-if="current" class="dgm-stage" :style="{ width: `${CANVAS.width}px`, height: `${CANVAS.height}px` }">
          <svg class="dgm-edges" :width="CANVAS.width" :height="CANVAS.height">
            <defs>
              <marker id="dgm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--el-border-color-darker)" />
              </marker>
            </defs>
            <g v-for="edge in edges" :key="edge.edge_id">
              <path
                :d="edgePath(edge)"
                class="dgm-edge"
                :class="{ 'is-selected': selectedEdge && selectedEdge.edge_id === edge.edge_id }"
                marker-end="url(#dgm-arrow)"
                @click.stop="selectedEdge = edge"
              />
              <text
                v-if="edgeLabel(edge)"
                :x="edgeLabel(edge).x"
                :y="edgeLabel(edge).y"
                class="dgm-edge__label"
              >
                {{ edgeLabel(edge).text }}
              </text>
            </g>
          </svg>

          <div
            v-for="node in nodes"
            :key="node.node_id"
            :class="nodeClass(node)"
            :style="{ left: `${node.x}px`, top: `${node.y}px`, width: `${W}px`, height: `${H}px` }"
            @pointerdown="startDrag($event, node)"
            @pointermove="onDrag"
            @pointerup="endDrag"
            @click.stop="selectNode(node)"
            @dblclick.stop="enterSub(node)"
          >
            <div class="dgm-node__kind">{{ KIND_TEXT[node.kind] }}</div>
            <div class="dgm-node__title">{{ node.title }}</div>
            <div v-if="node.detail" class="dgm-node__detail">{{ node.detail }}</div>
            <el-button
              v-if="node.sub_diagram_id"
              class="dgm-node__enter"
              link
              size="small"
              @click.stop="enterSub(node)"
            >
              进入
            </el-button>
          </div>

          <div v-if="nodes.length === 0" class="dgm-stage__empty">
            <el-button type="primary" plain @click="openNodeDialog()">新建节点</el-button>
          </div>
        </div>
      </div>

      <div class="panel dgm-side">
        <div class="panel__head">
          <span class="panel__title">节点</span>
          <el-tag v-if="selected" size="small" effect="plain">{{ KIND_TEXT[selected.kind] }}</el-tag>
        </div>
        <EmptyState v-if="!selected" description="未选择节点" :height="'100px'" />
        <template v-else>
          <div class="desc-grid">
            <span class="desc-label">标题</span>
            <span>{{ selected.title }}</span>
            <span class="desc-label">说明</span>
            <span>{{ selected.detail || '—' }}</span>
          </div>
          <div class="dgm-actions">
            <el-button size="small" plain @click="openNodeDialog(selected)">编辑</el-button>
            <el-button v-if="!selected.sub_diagram_id" size="small" type="primary" plain @click="makeSubDiagram(selected)">
              设为子流程
            </el-button>
            <el-button v-else size="small" type="primary" plain @click="enterSub(selected)">进入子流程</el-button>
            <el-button size="small" type="danger" plain @click="removeNode(selected)">删除</el-button>
          </div>
        </template>

        <div v-if="selectedEdge" class="dgm-actions">
          <span class="muted">{{ selectedEdge.from }} → {{ selectedEdge.to }}</span>
          <el-button size="small" type="danger" plain @click="removeEdge(selectedEdge)">删除连线</el-button>
        </div>
      </div>
    </div>

    <el-dialog v-model="nodeDialog" :title="selected ? '编辑节点' : '新建节点'" width="480px">
      <el-form label-width="72px">
        <el-form-item label="标题">
          <el-input v-model="nodeForm.title" placeholder="步骤名称" />
        </el-form-item>
        <el-form-item label="类型">
          <el-select v-model="nodeForm.kind">
            <el-option v-for="(text, value) in KIND_TEXT" :key="value" :label="text" :value="value" />
          </el-select>
        </el-form-item>
        <el-form-item label="说明">
          <el-input v-model="nodeForm.detail" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="nodeDialog = false">取消</el-button>
        <el-button type="primary" :loading="nodeSaving" @click="submitNode">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="chartDialog" title="新建主流程" width="480px">
      <el-form label-width="72px">
        <el-form-item label="名称">
          <el-input v-model="chartForm.name" placeholder="流程名称" />
        </el-form-item>
        <el-form-item label="说明">
          <el-input v-model="chartForm.description" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="chartDialog = false">取消</el-button>
        <el-button type="primary" :loading="chartSaving" @click="submitChart">创建</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.dgm-layout {
  display: grid;
  grid-template-columns: 216px minmax(0, 1fr) 280px;
  gap: 16px;
  align-items: start;
}

.dgm-list__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 9px 12px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
}

.dgm-list__item.is-sub {
  padding-left: 24px;
  color: var(--el-text-color-secondary);
}

.dgm-list__item:hover {
  background: var(--el-fill-color-light);
}

.dgm-list__item.is-active {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}

.dgm-list__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dgm-crumbs {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}

.dgm-crumbs__sep {
  color: var(--el-text-color-placeholder);
}

.dgm-stage {
  position: relative;
  overflow: auto;
  background:
    radial-gradient(circle, var(--el-border-color-lighter) 1px, transparent 1px) 0 0 / 20px 20px;
}

.dgm-edges {
  position: absolute;
  inset: 0;
}

.dgm-edge {
  fill: none;
  stroke: var(--el-border-color-darker);
  stroke-width: 1.5;
  cursor: pointer;
}

.dgm-edge.is-selected {
  stroke: var(--el-color-danger);
  stroke-width: 2.5;
}

.dgm-edge__label {
  font-size: 11px;
  fill: var(--el-text-color-secondary);
}

.dgm-node {
  position: absolute;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  background: var(--el-bg-color);
  cursor: pointer;
  user-select: none;
  overflow: hidden;
}

.dgm-node--pill {
  border-radius: 32px;
  background: var(--el-color-success-light-9);
}

.dgm-node--diamond {
  transform: rotate(0deg);
  border-color: var(--el-color-warning);
  background: var(--el-color-warning-light-9);
}

.dgm-node.is-selected {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 2px var(--el-color-primary-light-7);
}

.dgm-node__kind {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.dgm-node__title {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dgm-node__detail {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dgm-node__enter {
  position: absolute;
  right: 6px;
  top: 4px;
}

.dgm-stage__empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.dgm-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
</style>
