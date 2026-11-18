<script setup>
import { computed } from 'vue';

// 主干质量：条目若没有理由或来源，说明它无法被反驳，属于质量缺口。
const props = defineProps({
  items: { type: Array, default: () => [] },
});

const gaps = computed(() =>
  props.items
    .filter((item) => !item.rationale || String(item.rationale).trim() === ''
      || !(item.source_refs || []).length)
    .map((item) => ({
      item_id: item.item_id,
      statement: item.statement,
      missingReason: !item.rationale || String(item.rationale).trim() === '',
      missingSource: !(item.source_refs || []).length,
    })),
);

const hasGap = computed(() => gaps.value.length > 0);
</script>

<template>
  <div v-if="hasGap" class="quality-gap">
    <el-alert type="warning" :closable="false" show-icon title="主干质量缺口">
      <div class="suggestion-body">
        <div v-for="gap in gaps" :key="gap.item_id" class="row" style="margin-bottom: 4px">
          <span class="mono">{{ gap.item_id }}</span>
          <span>{{ gap.statement }}</span>
          <el-tag v-if="gap.missingReason" type="warning" size="small" effect="plain">缺理由</el-tag>
          <el-tag v-if="gap.missingSource" type="warning" size="small" effect="plain">缺来源</el-tag>
        </div>
        <div class="muted">没有理由或来源的条目无法被反驳，后续变更也难以定位影响。</div>
      </div>
    </el-alert>
  </div>
</template>
