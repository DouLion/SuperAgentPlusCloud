<script setup>
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api, errorMessage } from '../api.js';
import { formatTime } from '../status.js';
import StatusTag from '../components/StatusTag.vue';
import EmptyState from '../components/EmptyState.vue';

const router = useRouter();
const projects = ref([]);
const loading = ref(false);
const dialogVisible = ref(false);
const submitting = ref(false);

const form = reactive({
  name: '',
  purpose: '',
  scope_summary: '',
  policy_ref: '',
  created_by: '',
});

const rules = {
  name: [{ required: true, message: '请填写项目名称', trigger: 'blur' }],
};

async function load() {
  loading.value = true;
  try {
    projects.value = await api.listProjects();
  } catch (err) {
    ElMessage.error(errorMessage(err, '加载项目失败'));
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  Object.assign(form, { name: '', purpose: '', scope_summary: '', policy_ref: '', created_by: '' });
  dialogVisible.value = true;
}

async function submitCreate() {
  submitting.value = true;
  try {
    const created = await api.createProject({ ...form });
    ElMessage.success(`项目已创建：${created.project_id}`);
    dialogVisible.value = false;
    await load();
    router.push(`/project/${created.project_id}`);
  } catch (err) {
    ElMessage.error(errorMessage(err, '创建项目失败'));
  } finally {
    submitting.value = false;
  }
}

function goto(path) {
  router.push(path);
}

onMounted(load);
</script>

<template>
  <div class="page" v-loading="loading">
    <div class="page-header">
      <div>
        <h2 class="page-title">项目列表</h2>
        <div class="page-subtitle">选择项目进入驾驶舱，或新建一个项目开始记录主干与需求。</div>
      </div>
      <el-button type="primary" @click="openCreate">
        <el-icon><Plus /></el-icon>
        新建项目
      </el-button>
    </div>

    <EmptyState v-if="!loading && projects.length === 0" description="还没有项目，点击右上角「新建项目」开始">
      <el-button type="primary" plain @click="openCreate">新建项目</el-button>
    </EmptyState>

    <el-row v-else :gutter="16">
      <el-col v-for="project in projects" :key="project.project_id" :xs="24" :sm="12" :lg="8">
        <el-card class="card-gap" shadow="hover">
          <div class="card-head">
            <div>
              <div class="project-name">{{ project.name }}</div>
              <div class="mono muted">{{ project.project_id }}</div>
            </div>
            <StatusTag group="project" :value="project.status" />
          </div>

          <div class="card-body">
            <div v-if="project.purpose" class="line">目的：{{ project.purpose }}</div>
            <div v-if="project.scope_summary" class="line">范围：{{ project.scope_summary }}</div>
            <div class="line muted">
              创建时间：{{ formatTime(project.created_at) }}
              <span v-if="project.created_by">　创建人：{{ project.created_by }}</span>
            </div>
          </div>

          <div class="card-actions">
            <el-button size="small" type="primary" plain @click="goto(`/project/${project.project_id}`)">
              驾驶舱
            </el-button>
            <el-dropdown @command="(cmd) => goto(cmd)">
              <el-button size="small">
                更多
                <el-icon><ArrowDown /></el-icon>
              </el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item :command="`/trunk/${project.project_id}`">主干条目</el-dropdown-item>
                  <el-dropdown-item :command="`/requirements?project=${project.project_id}`">需求队列</el-dropdown-item>
                  <el-dropdown-item :command="`/tasks?project=${project.project_id}`">任务看板</el-dropdown-item>
                  <el-dropdown-item :command="`/changes/${project.project_id}`">变更与影响</el-dropdown-item>
                  <el-dropdown-item :command="`/timeline/${project.project_id}`">事件时间线</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-dialog v-model="dialogVisible" title="新建项目" width="520px">
      <el-form :model="form" :rules="rules" label-width="96px">
        <el-form-item label="项目名称" prop="name">
          <el-input v-model="form.name" placeholder="例如：订单中心一期" />
        </el-form-item>
        <el-form-item label="项目目的">
          <el-input v-model="form.purpose" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item label="范围说明">
          <el-input v-model="form.scope_summary" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item label="政策引用">
          <el-input v-model="form.policy_ref" placeholder="可选，例如制度或规范链接" />
        </el-form-item>
        <el-form-item label="创建人">
          <el-input v-model="form.created_by" placeholder="可选，具名人员" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitCreate">创建</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.project-name {
  font-size: 16px;
  font-weight: 600;
}

.card-body {
  margin: 12px 0;
  min-height: 60px;
}

.line {
  margin-bottom: 4px;
  font-size: 13px;
}

.card-actions {
  display: flex;
  gap: 8px;
}
</style>
