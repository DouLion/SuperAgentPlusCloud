<script setup>
defineProps({
  description: { type: String, default: '暂无数据' },
  height: { type: String, default: '220px' },
});
</script>

<template>
  <div class="empty-state" :style="{ minHeight: height }">
    <el-empty :description="description">
      <slot />
    </el-empty>
  </div>
</template>

<style scoped>
.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  background: #fff;
  border: 1px dashed #e4e7ed;
  border-radius: 6px;
  padding: 16px;
}
</style>
