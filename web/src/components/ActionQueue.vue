<script setup>
import StatusTag from './StatusTag.vue';

// 「需要判断」/「正在推进」队列：点击直达对象详情，替代重复表格。
defineProps({
  title: { type: String, default: '' },
  count: { type: [Number, String], default: null },
  items: {
    type: Array,
    default: () => [],
    // [{ key, title, meta: [{ group, value }], to: { name, params }, note }]
  },
  emptyText: { type: String, default: '暂无待处理' },
});

const emit = defineEmits(['open']);
</script>

<template>
  <div class="panel">
    <div class="panel__head">
      <span class="panel__title">{{ title }}</span>
      <span v-if="count !== null" class="panel__count">{{ count }}</span>
    </div>

    <div v-if="items.length === 0" class="muted" style="padding: 8px 2px">{{ emptyText }}</div>

    <div
      v-for="item in items"
      :key="item.key"
      class="queue-item clickable"
      role="button"
      :title="item.hint || item.title"
      @click="emit('open', item)"
    >
      <div class="queue-item__title">{{ item.title }}</div>
      <div class="queue-item__meta">
        <StatusTag
          v-for="meta in item.meta || []"
          :key="meta.group + meta.value"
          :group="meta.group"
          :value="meta.value"
          size="small"
        />
        <span v-if="item.note" class="muted">{{ item.note }}</span>
      </div>
    </div>
  </div>
</template>
