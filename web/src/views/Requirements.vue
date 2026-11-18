<script setup>
import { onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api, errorMessage } from '../api.js';
import { formatTime, OPTIONS } from '../status.js';
import StatusTag from '../components/StatusTag.vue';
import EmptyState from '../components/EmptyState.vue';

const route = useRoute();
const router = useRouter();

const projectId = ref(route.query.project || localStorage.getItem('sap.projectId') || '');
const projects = ref([]);
const requirements = ref([]);
const loading = ref(false);

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

async function loadProjects() {
  try {
    projects.value = await api.listProjects();
    if (!projectId.value && projects.value.length > 0) {
      projectId.value = projects.value[0].project_id;
    }
  } catch (err) {
    ElMessage.error(errorMessage(err, '加载项目失败'));
  }
}

async function load() {
  if (!projectId.value) {
    requirements.value = [];
    return;
  }
  loading.value = true;
  try {
    requirements.value = await api.listRequirements({ project_id: projectId.value });
  } catch (err) {
    ElMessage.error(errorMessage(err, '加载需求失败'));
  } finally {
    loading.value = false;
  }
}

function onProjectChange(id) {
  projectId.value = id;
  localStorage.setItem('sap.projectId', id);
  router.replace({ path: '/requirements', query: id ? { project: id } : {} });
  load();
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
      project_id: projectId.value,
      raw_text: form.raw_text,
      claimed_level: form.claimed_level || undefined,
      claimed_reason: form.claimed_reason || undefined,
      source_ref: form.source_ref || undefined,
      author: form.author || undefined,
    });
    ElMessage.success(`需求已提交：${created.requirement_id}`);
    dialogVisible.value = false;
    await load();
    router.push(`/requirements/${created.requirement_id}`);
  } catch (err) {
    ElMessage.error(errorMessage(err, '提交需求失败'));
  } finally {
    submitting.value = false;
  }
}

function openDetail(row) {
  router.push(`/requirements/${row.requirement_id}`);
}

onMounted(async () => {
  await loadProjects();
  await load();
});
</script>

<template>
  <div class="page" v-loading="loading">
    <div class="page-header">
      <div>
        <h2 class="page-title">需求队列</h2>
        <div class="page-subtitle">提交需求原文，由人评估并作出决定；AI 建议不会改变需求状态。</div>
      </div>
      <el-button type="primary" :disabled="!projectId" @click="openCreate">
        <el-icon><Plus /></el-icon>
        提交需求
      </el-button>
    </div>

    <div class="toolbar">
      <el-select
        v-model="projectId"
        filterable
        clearable
        placeholder="选择项目"
        style="width: 260px"
        @change="onProjectChange"
      >
        <el-option
          v-for="project in projects"
          :key="project.project_id"
          :label="`${project.name}（${project.project_id}）`"
          :value="project.project_id"
        />
      </el-select>
      <el-button size="small" @click="load">
        <el-icon><Refresh /></el-icon>
        刷新
      </el-button>
      <el-tooltip v-if="!projectId" content="先选择项目，才能提交需求" placement="top">
        <span class="muted">未选择项目</span>
      </el-tooltip>
    </div>

    <EmptyState v-if="!loading && requirements.length === 0" description="该项目还没有需求" />
    <el-table v-else :data="requirements" @row-click="openDetail">
      <el-table-column prop="raw_text" label="原文" min-width="300" show-overflow-tooltip />
      <el-table-column label="自报等级" width="110">
        <template #default="{ row }">{{ row.claimed_level || '—' }}</template>
      </el-table-column>
      <el-table-column label="最终等级" width="110">
        <template #default="{ row }">{{ row.final_level || '—' }}</template>
      </el-table-column>
      <el-table-column label="状态" width="130">
        <template #default="{ row }"><StatusTag group="requirement" :value="row.status" /></template>
      </el-table-column>
      <el-table-column prop="author" label="提交人" width="110">
        <template #default="{ row }">{{ row.author || '—' }}</template>
      </el-table-column>
      <el-table-column label="提交时间" width="150">
        <template #default="{ row }">{{ formatTime(row.created_at) }}</template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialogVisible" title="提交需求" width="560px">
      <el-form :model="form" :rules="rules" label-width="96px">
        <el-form-item label="需求原文" prop="raw_text">
          <el-input v-model="form.raw_text" type="textarea" :rows="4" />
        </el-form-item>
        <el-form-item label="自报等级">
          <el-select v-model="form.claimed_level" clearable placeholder="可选 L0..L4" style="width: 100%">
            <el-option v-for="value in OPTIONS.levels" :key="value" :label="value" :value="value" />
          </el-select>
        </el-form-item>
        <el-form-item label="自报理由">
          <el-input v-model="form.claimed_reason" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item label="来源">
          <el-input v-model="form.source_ref" placeholder="可选，例如会议纪要或文档链接" />
        </el-form-item>
        <el-form-item label="提交人">
          <el-input v-model="form.author" placeholder="可选，具名人员" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitCreate">提交</el-button>
      </template>
    </el-dialog>
  </div>
</template>
