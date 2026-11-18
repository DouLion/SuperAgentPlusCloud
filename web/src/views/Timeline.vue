<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api, errorMessage } from '../api.js';
import { formatTime, STATUS_MAPS } from '../status.js';
import EmptyState from '../components/EmptyState.vue';

const route = useRoute();
const projectId = route.params.projectId;

const loading = ref(false);
const events = ref([]);
const objectType = ref('');
const keyword = ref('');

const objectTypeOptions = computed(() => {
  const present = new Set(events.value.map((event) => event.object_type));
  return [...present].sort();
});

const filteredEvents = computed(() => {
  const text = keyword.value.trim().toLowerCase();
  return events.value.filter((event) => {
    if (objectType.value && event.object_type !== objectType.value) return false;
    if (!text) return true;
    const refs = (event.refs || []).join(' ');
    const haystack = [event.event_type, event.object_id, event.actor, event.reason, refs]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(text);
  });
});

async function load() {
  loading.value = true;
  try {
    events.value = await api.listEvents({ project_id: projectId });
  } catch (err) {
    ElMessage.error(errorMessage(err, '加载时间线失败'));
  } finally {
    loading.value = false;
  }
}

function objectTypeText(value) {
  return STATUS_MAPS.objectType[value] || value;
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
        <div class="page-subtitle mono">项目：{{ projectId }}</div>
      </div>
      <el-button size="small" @click="load">
        <el-icon><Refresh /></el-icon>
        刷新
      </el-button>
    </div>

    <div class="toolbar">
      <el-select
        v-model="objectType"
        clearable
        placeholder="对象类型"
        style="width: 200px"
      >
        <el-option
          v-for="value in objectTypeOptions"
          :key="value"
          :label="objectTypeText(value)"
          :value="value"
        />
      </el-select>
      <el-input
        v-model="keyword"
        clearable
        placeholder="关键字：事件类型 / 对象 ID / 操作人 / 理由"
        style="width: 340px"
      />
      <span class="muted">共 {{ filteredEvents.length }} 条</span>
    </div>

    <EmptyState v-if="!loading && filteredEvents.length === 0" description="没有匹配的事件" />
    <el-card v-else shadow="never">
      <el-timeline>
        <el-timeline-item
          v-for="event in filteredEvents"
          :key="event.event_id"
          :timestamp="formatTime(event.occurred_at)"
          placement="top"
        >
          <div class="event-head">
            <el-tag size="small" effect="plain">{{ objectTypeText(event.object_type) }}</el-tag>
            <strong>{{ event.event_type }}</strong>
            <span v-if="event.actor" class="muted">操作人：{{ event.actor }}</span>
          </div>
          <div v-if="event.object_id" class="mono muted">对象：{{ event.object_id }}</div>
          <div v-if="event.reason" class="muted">理由：{{ event.reason }}</div>
          <div v-if="(event.refs || []).length" class="mono muted">
            引用：{{ event.refs.join('，') }}
          </div>
        </el-timeline-item>
      </el-timeline>
    </el-card>
  </div>
</template>

<style scoped>
.event-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
