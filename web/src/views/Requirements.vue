<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api, errorMessage } from '../api.js';
import { formatTime, OPTIONS } from '../status.js';
import StatusTag from '../components/StatusTag.vue';
import EmptyState from '../components/EmptyState.vue';
import { go } from '../nav.js';

const route = useRoute();
const router = useRouter();
const projectId = route.params.id || route.params.projectId;

const requirements = ref([]);
const tasks = ref([]);
const loading = ref(false);
const activeTab = ref('needs_info');

const dialogVisible = ref(false);
const submitting = ref(false);
const form = reactive({
  raw_text: '',
  claimed_level: '',
  claimed_reason: '',
  source_ref: '',
  author: '',
});
const rules = {
  raw_text: [{ required: true, message: '请填写需求原文', trigger: 'blur' }],
};

const GROUPS = [
  { key: 'needs_info', label: '待补充信息', statuses: ['needs_info'] },
  { key: 'pending_assess', label: '待评估', statuses: ['submitted'] },
  { key: 'pending_decision', label: '待决定', statuses: ['assessed'] },
  { key: 'accepted', label: '已接受待拆解', statuses: ['accepted'] },
  { key: 'closed', label: '已结束', statuses: ['rejected', 'cancelled'] },
];

const taskCountByRequirement = computed(() => {
  const map = {};
  for (const task of tasks.value) {
    if (!task.requirement_id) continue;
    map[task.requirement_id] = (map[task.requirement_id] || 0) + 1;
  }
  return map;
});

const grouped = computed(() => GROUPS.map((group) => {
  const rows = requirements.value.filter((item) => {
    if (!group.statuses.includes(item.status)) return false;
    if (group.key === 'accepted') return (taskCountByRequirement.value[item.requirement_id] || 0) === 0;
    return true;
  });
  return { ...group, rows };
}));

const totalCount = computed(() => requirements.value.length);

async function load() {
  if (!projectId) return;
  loading.value = true;
  try {
    const [requirementRows, taskRows] = await Promise.all([
      api.listRequirements({ project_id: projectId }),
      api.listTasks({ project_id: projectId }).catch(() => []),
    ]);
    requirements.value = requirementRows;
    tasks.value = taskRows;
  } catch (err) {
    ElMessage.error(errorMessage(err, '加载需求失败'));
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  Object.assign(form, {
    raw_text: '',
    claimed_level: '',
    claimed_reason: '',
    source_ref: '',
    author: '',
  });
  dialogVisible.value = true;
}

async function submitCreate() {
  submitting.value = true;
  try {
    const created = await api.createRequirement({
      project_id: projectId,
      raw_text: form.raw_text,
      claimed_level: form.claimed_level || undefined,
      claimed_reason: form.claimed_reason || undefined,
      source_ref: form.source_ref || undefined,
      author: form.author || undefined,
    });
    ElMessage.success(`需求已提交：${created.requirement_id}`);
    dialogVisible.value = false;
    await load();
    go(router, 'requirement-detail', { id: projectId, requirementId: created.requirement_id });
  } catch (err) {
    ElMessage.error(errorMessage(err, '提交需求失败'));
  } finally {
    submitting.value = false;
  }
}

function openDetail(row) {
  go(router, 'requirement-detail', { id: projectId, requirementId: row.requirement_id });
}

onMounted(load);
</script>

<template>
  <div class="page" v-loading="loading">
    <div class="page-header">
      <div>
        <h2 class="page-title">需求工作台</h2>
      </div>
      <el-button type="primary" @click="openCreate">
        <el-icon><Plus /></el-icon>
        提交需求
      </el-button>
    </div>

    <div class="toolbar">
      <el-select v-if="!projectId" v-model="projectId" placeholder="选择项目" style="width: 240px" />
      <el-button size="small" @click="load">
        <el-icon><Refresh /></el-icon>
        刷新
      </el-button>
      <span class="muted">共 {{ totalCount }} 条需求</span>
    </div>

    <EmptyState v-if="!loading && totalCount === 0" description="该项目还没有需求">
      <el-button type="primary" plain @click="openCreate">提交第一条需求</el-button>
    </EmptyState>

    <el-tabs v-else v-model="activeTab">
      <el-tab-pane
        v-for="group in grouped"
        :key="group.key"
        :name="group.key"
        :label="`${group.label}（${group.rows.length}）`"
      >
        <EmptyState v-if="group.rows.length === 0" description="该分组暂无需求" :height="'120px'" />
        <el-card
          v-for="row in group.rows"
          :key="row.requirement_id"
          class="card-gap requirement-card clickable"
          shadow="never"
          @click="openDetail(row)"
        >
          <div class="card-head">
            <div class="card-head__main">
              <div class="requirement-text">{{ row.raw_text }}</div>
              <div class="mono muted">{{ row.requirement_id }}</div>
            </div>
            <StatusTag group="requirement" :value="row.status" />
          </div>

          <div class="requirement-meta">
            <el-tag size="small" effect="plain" :type="row.claimed_level && row.final_level && row.claimed_level !== row.final_level ? 'warning' : 'info'">
              自报 {{ row.claimed_level || '—' }}
            </el-tag>
            <el-tag size="small" effect="plain" type="info">最终 {{ row.final_level || '—' }}</el-tag>
            <span class="muted">
              {{ row.author || '—' }} · {{ formatTime(row.created_at) }}
              <template v-if="group.key === 'accepted'"> · 尚未拆解任务</template>
            </span>
          </div>

          <el-alert
            v-if="row.claimed_level && row.final_level && row.claimed_level !== row.final_level"
            type="warning"
            :closable="false"
            show-icon
            style="margin-top: 10px"
            :title="`等级被调整：提交者自报 ${row.claimed_level}，最终 ${row.final_level}`"
          />
        </el-card>
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="dialogVisible" title="提交需求" width="560px">
      <el-form :model="form" :rules="rules" label-width="96px">
        <el-form-item label="需求原文" prop="raw_text">
          <el-input v-model="form.raw_text" type="textarea" :rows="4" placeholder="需求原话" />
        </el-form-item>
        <el-form-item label="自报等级">
          <el-select v-model="form.claimed_level" clearable placeholder="等级">
            <el-option v-for="value in OPTIONS.levels" :key="value" :label="value" :value="value" />
          </el-select>
        </el-form-item>
        <el-form-item label="自报理由">
          <el-input v-model="form.claimed_reason" placeholder="理由" />
        </el-form-item>
        <el-form-item label="来源">
          <el-input v-model="form.source_ref" placeholder="会议 / 文档 / 链接" />
        </el-form-item>
        <el-form-item label="提出人">
          <el-input v-model="form.author" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitCreate">提交</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.requirement-card {
  transition: border-color 0.15s ease;
}

.requirement-card:hover {
  border-color: var(--sap-primary);
}

.card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.requirement-text {
  font-size: 14px;
  line-height: 1.6;
}

.requirement-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  flex-wrap: wrap;
}
</style>
