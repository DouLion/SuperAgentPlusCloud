<script setup>
import { computed } from 'vue';
import { statusText, statusType } from '../status.js';

const props = defineProps({
  group: { type: String, required: true },
  value: { type: [String, Number], default: '' },
  size: { type: String, default: 'default' },
});

const text = computed(() => statusText(props.group, props.value));
const type = computed(() => statusType(props.group, props.value));
</script>

<template>
  <el-tag :type="type" :size="size" effect="light" class="status-tag">{{ text }}</el-tag>
</template>

<style scoped>
.status-tag {
  white-space: nowrap;
}
</style>
