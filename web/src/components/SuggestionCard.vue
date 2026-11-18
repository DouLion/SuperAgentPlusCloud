<script setup>
defineProps({
  // 标题必须明确「未生效」，保证建议与已确认状态视觉可分。
  title: { type: String, default: 'AI 建议，未生效' },
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' },
});
</script>

<template>
  <el-alert
    class="suggestion-card"
    type="info"
    :title="title"
    :closable="false"
    show-icon
  >
    <div v-loading="loading" class="suggestion-body">
      <el-text v-if="error" type="danger" size="small">{{ error }}</el-text>
      <slot />
    </div>
    <div v-if="$slots.actions" class="suggestion-actions">
      <slot name="actions" />
    </div>
  </el-alert>
</template>

<style scoped>
.suggestion-card {
  border-left: 4px solid #909399;
  background: #f4f8ff;
}

.suggestion-body {
  min-height: 18px;
  color: #606266;
  font-size: 13px;
}
</style>
