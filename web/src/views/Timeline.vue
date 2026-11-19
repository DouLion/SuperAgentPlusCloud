<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api, errorMessage } from '../api.js';
import { formatTime, STATUS_MAPS } from '../status.js';
import EmptyState from '../components/EmptyState.vue';
import IdText from '../components/IdText.vue';
import { go } from '../nav.js';

const route = useRoute();
const router = useRouter();
const projectId = route.params.id || route.params.projectId;

const loading = ref(false);
const events = ref([]);
const category = ref('');
const actor = ref('');
const keyword = ref('');

const CATEGORIES = [
  { key: 'decision', label: '决定' },
  { key: 'execution', label: '执行' },
  { key: 'delivery', label: '交付' },
  { key: 'review', label: '评审' },
  { key: 'trunk', label: '主干' },
  { key: 'impact', label: '影响' },
];

function categorize(eventType) {
  if (eventType.startsWith('decision.') || eventType.startsWith('assessment.')) return 'decision';
  if (eventType.startsWith('requirement.')) return 'decision';
  if (eventType.startsWith('task.') || eventType.startsWith('claim')) return 'execution';
  if (eventType.startsWith('submission.')) return 'delivery';
  if (eventType.startsWith('review.')) return 'review';
  if (eventType.startsWith('trunk_')) return 'trunk';
  if (eventType.startsWith('impact_')) return 'impact';
  return 'execution';
}

const categoryOptions = computed(() => {
  const present = new Set(events.value.map((event) => categorize(event.event_type)));
  return CATEGORIES.filter((item) => present.has(item.key));
});

const actorOptions = computed(() => {
  const present = new Set(events.value.map((event) => event.actor).filter(Boolean));
  return [...present].sort();
});

const filtered = computed(() => {
  const text = keyword.value.trim().toLowerCase();
  return events.value.filter((event) => {
    if (category.value && categorize(event.event_type) !== category.value) return false;
    if (actor.value && event.actor !== actor.value) return false;
    if (!text) return true;
    const refs = (event.refs || []).join(' ');
    const haystack = [event.event_type, event.object_id, event.actor, event.reason, refs]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(text);
  });
});

const categoryText = (key) => CATEGORIES.find((item) => item.key === key)?.label || key;

async function load() {
  loading.value = true;
  try {
    events.value = await api.listEvents({ project_id: projectId, limit: 200 });
  } catch (err) {
    ElMessage.error(errorMessage(err, '加载时间线失败'));
  } finally {
    loading.value = false;
  }
}

/** 点击事件跳回对象详情。 */
function jump(event) {
  const type = event.object_type;
  if (type === 'requirement') {
    go(router, 'requirement-detail', { id: projectId, requirementId: event.object_id });
    return;
  }
  if (type === 'task') {
    go(router, 'task-detail', { id: projectId, taskId: event.object_id });
    return;
  }
  if (type === 'trunk_item' || type === 'trunk_change' || type === 'impact_item') {
    go(router, type === 'trunk_item' ? 'trunk' : 'changes', { id: projectId });
  }
}

onMounted(() => {
  if (!projectId) return;
  load();
});
</script>

<template>
  <div class="page" v-loading="loading">
    <div class="page-header">
      <div>
        <h2 class="page-title">事件时间线</h2>
      </div>
      <el-button size="small" @click="load">
        <el-icon><Refresh /></el-icon>
        刷新
      </el-button>
    </div>

    <div class="toolbar">
      <el-select v-model="category" clearable placeholder="语义分类" style="width: 160px">
        <el-option
          v-for="item in categoryOptions"
          :key="item.key"
          :label="item.label"
          :value="item.key"
        />
      </el-select>
      <el-select v-model="actor" clearable filterable placeholder="操作者" style="width: 180px">
        <el-option v-for="value in actorOptions" :key="value" :label="value" :value="value" />
      </el-select>
      <el-input
        v-model="keyword"
        clearable
        placeholder="关键字：事件 / 对象 ID / 理由"
        style="width: 320px"
      />
      <span class="muted">共 {{ filtered.length }} 条</span>
    </div>

    <EmptyState v-if="!loading && filtered.length === 0" description="没有匹配的事件" :height="'160px'" />

    <el-card v-else shadow="never">
      <el-timeline>
        <el-timeline-item
          v-for="event in filtered"
          :key="event.event_id"
          :timestamp="formatTime(event.occurred_at)"
          placement="top"
        >
          <div class="queue-item clickable" style="border: 1px solid var(--sap-border-soft)" @click="jump(event)">
            <div class="event-head">
              <el-tag size="small" effect="plain">{{ categoryText(categorize(event.event_type)) }}</el-tag>
              <el-tag size="small" type="info" effect="plain">
                {{ STATUS_MAPS.objectType[event.object_type] || event.object_type }}
              </el-tag>
              <strong>{{ event.event_type }}</strong>
            </div>
            <div class="muted">对象：<IdText :id="event.object_id" muted /></div>
            <div v-if="event.actor" class="muted">操作人：{{ event.actor }}</div>
            <div v-if="event.reason" class="muted">理由：{{ event.reason }}</div>
          </div>
        </el-timeline-item>
      </el-timeline>
    </el-card>
  </div>
</template>
