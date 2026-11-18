<script setup>
// 顶部指标：只展示真正有用的数字，避免看板化。
defineProps({
  metrics: {
    type: Array,
    default: () => [],
    // [{ label, value, tone: 'default'|'warning'|'danger', hint }]
  },
});
</script>

<template>
  <div class="metric-grid">
    <div v-for="metric in metrics" :key="metric.label" class="metric-card">
      <div class="metric-card__label">{{ metric.label }}</div>
      <div
        class="metric-card__value"
        :class="{ 'is-danger': metric.tone === 'danger', 'is-warning': metric.tone === 'warning' }"
      >
        {{ metric.value }}
      </div>
      <div v-if="metric.hint" class="muted" style="margin-top: 4px">{{ metric.hint }}</div>
    </div>
  </div>
</template>
