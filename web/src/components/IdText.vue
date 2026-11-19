// 短标识：页面只显示前 7 位，完整值在悬浮提示里，点一下复制。
<script setup>
import { computed } from 'vue';
import { ElMessage } from 'element-plus';
import { copyText, shortId } from '../ids.js';

const props = defineProps({
  id: { type: String, default: '' },
  muted: { type: Boolean, default: false },
});

const short = computed(() => shortId(props.id));

async function copy() {
  if (!props.id) return;
  const ok = await copyText(props.id);
  if (ok) ElMessage.success('已复制完整标识');
  else ElMessage.error('复制失败');
}
</script>

<template>
  <span v-if="id" class="id-text" :class="{ 'id-text--muted': muted }">
    <span class="id-text__short" :title="id">{{ short }}</span>
    <el-button class="id-text__copy" link size="small" @click.stop="copy">复制</el-button>
  </span>
</template>

<style scoped>
.id-text {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}

.id-text--muted {
  color: var(--el-text-color-secondary);
}

.id-text__short {
  letter-spacing: 0.02em;
}

.id-text__copy {
  font-size: 12px;
  opacity: 0.55;
}

.id-text:hover .id-text__copy {
  opacity: 1;
}
</style>
