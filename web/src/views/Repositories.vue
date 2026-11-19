<script setup>
import { onMounted, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api, errorMessage } from '../api.js';
import { formatTime } from '../status.js';
import EmptyState from '../components/EmptyState.vue';

const route = useRoute();
const projectId = route.params.id;

const PROVIDER_TEXT = { github: 'GitHub', gitlab: 'GitLab', gitee: 'Gitee', azure: 'Azure', other: '其他' };

const loading = ref(false);
const repositories = ref([]);
const selected = ref(null);
const facts = ref([]);
const factLoading = ref(false);
const dialog = ref(false);
const saving = ref(false);
const form = reactive({ name: '', url: '', local_path: '', default_branch: '', provider: 'other' });
const syncDialog = ref(false);
const syncing = ref(false);
const syncForm = reactive({ local_path: '', limit: 50 });

async function openSync() {
  Object.assign(syncForm, { local_path: selected.value?.local_path || '', limit: 50 });
  syncDialog.value = true;
}

async function submitSync() {
  if (!syncForm.local_path.trim()) {
    ElMessage.warning('需要仓库的本地路径');
    return;
  }
  syncing.value = true;
  try {
    const result = await api.syncRepository(selected.value.repository_id, {
      local_path: syncForm.local_path.trim(),
      limit: syncForm.limit,
    });
    ElMessage.success(`新增 ${result.inserted} 条，已存在 ${result.skipped} 条，最新 ${String(result.latest_sha || '').slice(0, 10)}`);
    syncDialog.value = false;
    await loadRepositories(selected.value.repository_id);
  } catch (err) {
    ElMessage.error(errorMessage(err, '同步失败'));
  } finally {
    syncing.value = false;
  }
}

async function loadRepositories(keepId) {
  loading.value = true;
  try {
    repositories.value = await api.listRepositories(projectId, { summary: '1' });
    const target = repositories.value.find((one) => one.repository_id === (keepId ?? selected.value?.repository_id))
      || repositories.value[0]
      || null;
    selected.value = target;
    if (target) await loadFacts(target.repository_id);
    else facts.value = [];
  } catch (err) {
    ElMessage.error(errorMessage(err, '加载仓库失败'));
  } finally {
    loading.value = false;
  }
}

async function loadFacts(repositoryId) {
  factLoading.value = true;
  try {
    const result = await api.listRepositoryFacts(repositoryId, { source: 'git', limit: 50 });
    facts.value = result.facts || [];
  } catch (err) {
    facts.value = [];
    ElMessage.error(errorMessage(err, '加载提交记录失败'));
  } finally {
    factLoading.value = false;
  }
}

function selectRepository(row) {
  selected.value = row;
  loadFacts(row.repository_id);
}

function openDialog() {
  Object.assign(form, { name: '', url: '', local_path: '', default_branch: '', provider: 'other' });
  dialog.value = true;
}

async function submit() {
  if (!form.name.trim() || (!form.url.trim() && !form.local_path.trim())) {
    ElMessage.warning('名称与地址（或本地路径）必填');
    return;
  }
  saving.value = true;
  try {
    const created = await api.createRepository(projectId, {
      name: form.name.trim(),
      url: form.url.trim() || form.local_path.trim(),
      local_path: form.local_path.trim() || undefined,
      default_branch: form.default_branch.trim() || null,
      provider: form.provider === 'other' ? undefined : form.provider,
    });
    ElMessage.success('仓库已登记');
    dialog.value = false;
    await loadRepositories(created.repository_id);
  } catch (err) {
    ElMessage.error(errorMessage(err, '登记仓库失败'));
  } finally {
    saving.value = false;
  }
}

async function archive(row) {
  try {
    await api.archiveRepository(row.repository_id, { reason: '面板归档' });
    ElMessage.success('仓库已归档');
    await loadRepositories(row.repository_id);
  } catch (err) {
    ElMessage.error(errorMessage(err, '归档失败'));
  }
}

function commitOf(fact) {
  const payload = fact.payload || {};
  return {
    sha: String(payload.commit_sha || fact.external_id || '').slice(0, 10),
    ref: payload.ref || '—',
    author: payload.author || payload.committer || '—',
    message: payload.message || payload.summary || '',
  };
}

onMounted(() => loadRepositories());
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">代码仓库</h2>
      </div>
      <div class="toolbar">
        <el-button type="primary" plain @click="openDialog">登记仓库</el-button>
        <el-button :loading="loading" @click="loadRepositories()">刷新</el-button>
      </div>
    </div>

    <el-row :gutter="16">
      <el-col :span="9">
        <el-table
          v-loading="loading"
          :data="repositories"
          highlight-current-row
          @current-change="(row) => row && selectRepository(row)"
        >
          <el-table-column prop="name" label="名称" min-width="110" show-overflow-tooltip />
          <el-table-column label="本地路径" min-width="150" show-overflow-tooltip>
            <template #default="{ row }">
              <span class="mono">{{ row.local_path || '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="服务商" width="90">
            <template #default="{ row }">{{ PROVIDER_TEXT[row.provider] || row.provider }}</template>
          </el-table-column>
          <el-table-column prop="commit_count" label="提交" width="70" />
          <el-table-column label="状态" width="90">
            <template #default="{ row }">
              <el-tag :type="row.status === 'active' ? 'success' : 'info'" size="small">
                {{ row.status === 'active' ? '在用' : '已归档' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="80">
            <template #default="{ row }">
              <el-button
                v-if="row.status === 'active'"
                size="small"
                text
                @click.stop="archive(row)"
              >
                归档
              </el-button>
            </template>
          </el-table-column>
        </el-table>

        <EmptyState v-if="!loading && repositories.length === 0" description="无">
          <el-button type="primary" plain @click="openDialog">登记示例仓库</el-button>
        </EmptyState>
      </el-col>

      <el-col :span="15">
        <el-card v-if="selected" shadow="never">
          <template #header>
            <div class="card-header-row">
              <span class="mono">{{ selected.url }}</span>
              <span class="toolbar">
                <span class="muted mono">{{ selected.last_branch || '—' }} @ {{ String(selected.last_head || '').slice(0, 10) }}</span>
                <span v-if="selected.last_synced_at" class="muted">{{ formatTime(selected.last_synced_at) }}</span>
                <span v-if="selected.tracked_file_count" class="muted">{{ selected.tracked_file_count }} 文件</span>
                <el-button size="small" type="primary" plain :disabled="selected.status !== 'active'" @click="openSync">
                  同步
                </el-button>
              </span>
            </div>
          </template>

          <el-table :data="facts" size="small" v-loading="factLoading">
            <el-table-column label="提交" width="110">
              <template #default="{ row }">
                <span class="mono">{{ commitOf(row).sha }}</span>
              </template>
            </el-table-column>
            <el-table-column label="分支" min-width="130">
              <template #default="{ row }">
                <span class="mono">{{ commitOf(row).ref }}</span>
              </template>
            </el-table-column>
            <el-table-column label="提交信息" min-width="220" show-overflow-tooltip>
              <template #default="{ row }">{{ commitOf(row).message }}</template>
            </el-table-column>
            <el-table-column label="接收于" width="170">
              <template #default="{ row }">{{ formatTime(row.received_at) }}</template>
            </el-table-column>
          </el-table>
          <EmptyState v-if="!factLoading && facts.length === 0" description="无提交记录" />
        </el-card>
        <EmptyState v-else description="未选择仓库" />
      </el-col>
    </el-row>

    <el-dialog v-model="syncDialog" title="从本地 git 同步" width="520px">
      <el-form label-width="90px">
        <el-form-item label="本地路径">
          <el-input v-model="syncForm.local_path" placeholder="D:\code\project" />
        </el-form-item>
        <el-form-item label="读取提交">
          <el-input-number v-model="syncForm.limit" :min="1" :max="200" :step="10" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="syncDialog = false">取消</el-button>
        <el-button type="primary" :loading="syncing" @click="submitSync">同步</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="dialog" title="登记仓库" width="520px">
      <el-form label-width="90px">
        <el-form-item label="名称">
          <el-input v-model="form.name" placeholder="前端" />
        </el-form-item>
        <el-form-item label="地址">
          <el-input v-model="form.url" placeholder="https://github.com/acme/web.git" />
        </el-form-item>
        <el-form-item label="本地路径">
          <el-input v-model="form.local_path" placeholder="D:\code\project" />
        </el-form-item>
        <el-form-item label="默认分支">
          <el-input v-model="form.default_branch" placeholder="main" />
        </el-form-item>
        <el-form-item label="服务商">
          <el-select v-model="form.provider" style="width: 160px">
            <el-option label="自动识别" value="other" />
            <el-option label="GitHub" value="github" />
            <el-option label="GitLab" value="gitlab" />
            <el-option label="Gitee" value="gitee" />
            <el-option label="Azure" value="azure" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>
