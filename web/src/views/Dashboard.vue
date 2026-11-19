<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api, errorMessage } from '../api.js';
import { formatTime, TRUNK_KIND_TEXT } from '../status.js';
import { go } from '../nav.js';
import StatusTag from '../components/StatusTag.vue';
import EmptyState from '../components/EmptyState.vue';
import ProjectMetrics from '../components/ProjectMetrics.vue';
import ActionQueue from '../components/ActionQueue.vue';
import IdText from '../components/IdText.vue';

const route = useRoute();
const router = useRouter();
const projectId = route.params.id;

const loading = ref(false);
const trunk = ref([]);
const requirements = ref([]);
const tasks = ref([]);
const changes = ref([]);
const events = ref([]);
const impactMap = ref({});
const impactLoading = ref(false);
const onlineActors = ref([]);
const stuckItems = ref([]);

const JUDGE_REQUIREMENT_STATUSES = ['submitted', 'needs_info', 'assessed'];
const RUNNING_TASK_STATUSES = ['open', 'claimed', 'rework'];
const BLOCKED_TASK_STATUSES = ['rework'];

const KIND_ORDER = [
  'goal',
  'scope',
  'capability',
  'business_rule',
  'interface',
  'data_contract',
  'architecture_decision',
  'other',
];

const activeTrunk = computed(() => trunk.value.filter((item) => item.status === 'active'));

const trunkByKind = computed(() => {
  const grouped = {};
  for (const kind of KIND_ORDER) grouped[kind] = [];
  for (const item of activeTrunk.value) {
    const key = grouped[item.kind] ? item.kind : 'other';
    grouped[key].push(item);
  }
  return KIND_ORDER.map((kind) => ({
    kind,
    label: TRUNK_KIND_TEXT[kind] || kind,
    items: grouped[kind],
  })).filter((group) => group.items.length > 0);
});

const judgeQueue = computed(() => {
  const items = [];
  for (const requirement of requirements.value) {
    if (!JUDGE_REQUIREMENT_STATUSES.includes(requirement.status)) continue;
    items.push({
      key: requirement.requirement_id,
      title: requirement.raw_text,
      note: `自报 ${requirement.claimed_level || '—'} / 最终 ${requirement.final_level || '—'}`,
      meta: [{ group: 'requirement', value: requirement.status }],
      to: {
        name: 'requirement-detail',
        params: { id: projectId, requirementId: requirement.requirement_id },
      },
    });
  }
  for (const task of tasks.value) {
    if (task.status !== 'submitted') continue;
    items.push({
      key: task.task_id,
      title: `待评审：${task.purpose}`,
      note: `提交于 ${formatTime(task.created_at)}`,
      meta: [{ group: 'task', value: 'submitted' }],
      to: { name: 'task-detail', params: { id: projectId, taskId: task.task_id } },
    });
  }
  for (const [changeId, impacts] of Object.entries(impactMap.value)) {
    for (const impact of impacts) {
      if (impact.assessment_status !== 'to_check') continue;
      items.push({
        key: impact.impact_item_id,
        title: `待检查影响：${impact.target_type} ${impact.target_id}`,
        note: impact.source_type === 'artifact' ? `契约 ${impact.source_id}` : `变更 ${changeId}`,
        meta: [{ group: 'impactAssessment', value: 'to_check' }],
        to: impact.source_type === 'artifact'
          ? { name: 'contracts', params: { id: projectId } }
          : { name: 'changes', params: { id: projectId } },
      });
    }
  }
  return items;
});

const runningQueue = computed(() => {
  const items = [];
  for (const task of tasks.value) {
    if (!RUNNING_TASK_STATUSES.includes(task.status)) continue;
    items.push({
      key: task.task_id,
      title: task.purpose,
      note: task.serves_item_ids?.length ? `服务 ${task.serves_item_ids.length} 条主干` : '探索任务',
      meta: [{ group: 'task', value: task.status }],
      to: { name: 'task-detail', params: { id: projectId, taskId: task.task_id } },
    });
  }
  for (const change of changes.value) {
    if (change.status === 'closed') continue;
    items.push({
      key: change.change_id,
      title: change.reason,
      note: `生效 ${formatTime(change.effective_at)}`,
      meta: [{ group: 'change', value: change.status }],
      to: { name: 'changes', params: { id: projectId } },
    });
  }
  return items;
});

const metrics = computed(() => {
  const toCheck = Object.values(impactMap.value)
    .flat()
    .filter((item) => item.assessment_status === 'to_check').length;
  const blocked = tasks.value.filter((task) => BLOCKED_TASK_STATUSES.includes(task.status)).length;
  return [
    { label: '有效主干', value: activeTrunk.value.length, hint: '当前生效的目标/范围/能力/约定' },
    { label: '待人处理', value: judgeQueue.value.length, tone: judgeQueue.value.length ? 'warning' : 'default' },
    { label: '受阻任务', value: blocked, tone: blocked ? 'danger' : 'default' },
    { label: '未处置影响', value: toCheck, tone: toCheck ? 'danger' : 'default' },
  ];
});

async function loadImpacts(changeId) {
  try {
    const rows = await api.listImpactItems(changeId);
    impactMap.value = { ...impactMap.value, [changeId]: rows };
  } catch {
    impactMap.value = { ...impactMap.value, [changeId]: [] };
  }
}

async function load() {
  if (!projectId) {
    go(router, 'projects');
    return;
  }
  loading.value = true;
  try {
    const [trunkRows, requirementRows, taskRows, changeRows, eventRows] = await Promise.all([
      api.listTrunkItems({ project_id: projectId }),
      api.listRequirements({ project_id: projectId }),
      api.listTasks({ project_id: projectId }),
      api.listTrunkChanges({ project_id: projectId }),
      api.listEvents({ project_id: projectId, limit: 20 }).catch(() => []),
    ]);
    trunk.value = trunkRows;
    requirements.value = requirementRows;
    tasks.value = taskRows;
    changes.value = changeRows;
    events.value = eventRows;
    await Promise.all(changeRows.filter((change) => change.status !== 'closed')
      .map((change) => loadImpacts(change.change_id)));

    // 契约变更（B 枝）的影响项也计入待办与统计。
    try {
      const artifactRows = await api.listImpacts({ project_id: projectId });
      impactMap.value = {
        ...impactMap.value,
        artifacts: artifactRows.filter((item) => item.source_type === 'artifact'),
      };
    } catch {
      impactMap.value = { ...impactMap.value, artifacts: [] };
    }

    const [actorResult, stuckResult] = await Promise.all([
      api.observabilityActors().catch(() => ({ actors: [] })),
      api.observabilityStuck({ project_id: projectId }).catch(() => ({ items: [] })),
    ]);
    onlineActors.value = (actorResult.actors || [])
      .filter((actor) => actor.presence === 'online')
      .slice(0, 8);
    stuckItems.value = (stuckResult.items || []).slice(0, 5);
  } catch (err) {
    ElMessage.error(errorMessage(err, '加载驾驶舱失败'));
  } finally {
    loading.value = false;
  }
}

function openQueue(item) {
  if (item?.to) router.push(item.to);
}

onMounted(load);
</script>

<template>
  <div class="page" v-loading="loading">
    <div class="page-header">
      <div>
        <h2 class="page-title">项目驾驶舱</h2>
      </div>
      <el-button size="small" @click="load">
        <el-icon><Refresh /></el-icon>
        刷新
      </el-button>
    </div>

    <ProjectMetrics :metrics="metrics" />

    <div class="workbench">
      <div class="workbench__col">
        <div class="panel">
          <div class="panel__head">
            <span class="panel__title">当前主干</span>
            <span class="panel__count">{{ activeTrunk.length }}</span>
          </div>
          <EmptyState v-if="activeTrunk.length === 0" description="还没有生效的主干条目" :height="'120px'" />
          <div v-for="group in trunkByKind" :key="group.kind" style="margin-bottom: 12px">
            <div class="panel__title" style="margin-bottom: 6px">{{ group.label }}</div>
            <div
              v-for="item in group.items"
              :key="item.item_id"
              class="queue-item clickable"
              :title="item.rationale || item.statement"
              @click="go(router, 'trunk', { id: projectId })"
            >
              <div class="queue-item__title">{{ item.statement }}</div>
              <div class="queue-item__meta">
                <IdText :id="item.item_id" muted />
                <span v-if="item.confirmed_by" class="muted">{{ item.confirmed_by }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="workbench__col">
        <ActionQueue
          title="需要判断"
          :count="judgeQueue.length"
          :items="judgeQueue"
          empty-text="没有待判断的需求、提交或影响项"
          @open="openQueue"
        />
        <div v-if="judgeQueue.length" style="margin-top: 10px">
          <el-button
            type="primary"
            plain
            size="small"
            @click="router.push(judgeQueue[0].to)"
          >
            下一步：{{ judgeQueue[0].title.slice(0, 18) }}…
          </el-button>
        </div>
      </div>

      <div class="workbench__col">
        <ActionQueue
          title="正在推进"
          :count="runningQueue.length"
          :items="runningQueue"
          empty-text="没有在途任务或开放变更"
          @open="openQueue"
        />
      </div>
    </div>

    <div class="obs-grid">
      <div class="panel">
        <div class="panel__head">
          <span class="panel__title">在线主体</span>
          <el-button size="small" text @click="router.push({ name: 'agents' })">主体与在线状态</el-button>
        </div>
        <EmptyState v-if="onlineActors.length === 0" description="最近 15 分钟没有活跃主体" :height="'80px'" />
        <div v-for="actor in onlineActors" :key="actor.actor_id" class="queue-item">
          <div class="queue-item__title">{{ actor.display_name }}</div>
          <div class="queue-item__meta">
            <el-tag size="small" effect="plain">{{ actor.type === 'human' ? '人类' : actor.type === 'agent' ? 'Agent' : '服务' }}</el-tag>
            <span class="muted">活跃认领 {{ actor.active_claims }}</span>
            <span v-if="actor.last_used_at" class="muted">{{ formatTime(actor.last_used_at) }}</span>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel__head">
          <span class="panel__title">卡住的任务</span>
          <el-button size="small" text @click="router.push({ name: 'agents' })">查看全部</el-button>
        </div>
        <EmptyState v-if="stuckItems.length === 0" description="没有被判定为卡住的任务" :height="'80px'" />
        <div
          v-for="item in stuckItems"
          :key="`${item.kind}-${item.task_id}-${item.claim_id || ''}`"
          class="queue-item clickable"
          @click="router.push({ name: 'task-detail', params: { id: projectId, taskId: item.task_id } })"
        >
          <div class="queue-item__title">{{ item.detail }}</div>
          <div class="queue-item__meta">
            <el-tag size="small" type="danger" effect="plain">{{ item.kind }}</el-tag>
            <IdText :id="item.task_id" muted />
          </div>
        </div>
      </div>
    </div>

    <div class="panel" style="margin-top: 4px">
      <div class="panel__head">
        <span class="panel__title">最近发生了什么</span>
        <el-button size="small" text @click="go(router, 'timeline', { id: projectId })">
          完整时间线
        </el-button>
      </div>
      <EmptyState v-if="events.length === 0" description="暂无事件" :height="'80px'" />
      <el-timeline v-else>
        <el-timeline-item
          v-for="event in events"
          :key="event.event_id"
          :timestamp="formatTime(event.occurred_at)"
          placement="top"
        >
          <div class="event-head">
            <strong>{{ event.event_type }}</strong>
            <span v-if="event.actor" class="muted">{{ event.actor }}</span>
            <IdText :id="event.object_id" muted />
          </div>
          <div v-if="event.reason" class="muted">{{ event.reason }}</div>
        </el-timeline-item>
      </el-timeline>
    </div>
  </div>
</template>
