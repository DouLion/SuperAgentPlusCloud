<script setup>
// 系统设置（T10）：查看并修改端口、监听、数据库与模型配置。
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, errorMessage } from '../api.js';
import { refreshAiHealth } from '../appState.js';

const loading = ref(false);
const submitting = ref(false);
const formRef = ref(null);
const needsRestart = ref([]);
const status = ref(null);

// 当前主体与通知偏好（E 枝）：面板不强制登录，主体 ID 存在本地。
const actorId = ref(localStorage.getItem('sap.actorId') || '');
const prefs = ref([]);
const health = ref(null);
const healthLoading = ref(false);

const KIND_TEXT = {
  task_available: '可认领任务',
  review_requested: '待评审',
  decision_required: '待判断需求',
  impact_to_check: '待检查影响',
  lease_expiring: '租约临期',
  system: '系统消息',
};

function saveActorId(value) {
  actorId.value = value.trim();
  if (actorId.value) localStorage.setItem('sap.actorId', actorId.value);
  else localStorage.removeItem('sap.actorId');
  loadPrefs();
}

async function loadPrefs() {
  if (!actorId.value) {
    prefs.value = [];
    return;
  }
  try {
    const result = await api.listNotificationPrefs({ actor_id: actorId.value });
    prefs.value = result.prefs ?? [];
  } catch {
    prefs.value = [];
  }
}

async function togglePref(kind, enabled) {
  if (!actorId.value) return;
  try {
    const result = await api.saveNotificationPrefs({
      actor_id: actorId.value,
      prefs: [{ kind, enabled }],
    });
    prefs.value = result.prefs ?? [];
  } catch (err) {
    ElMessage.error(errorMessage(err, '保存通知偏好失败'));
  }
}

async function loadHealth() {
  healthLoading.value = true;
  try {
    health.value = await api.adminHealth();
  } catch (err) {
    ElMessage.error(errorMessage(err, '读取运行健康失败'));
  } finally {
    healthLoading.value = false;
  }
}

async function backupNow() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = `backup-sap-${stamp}.db`;
  try {
    const result = await api.createBackup({ target });
    ElMessage.success(`备份完成：${result.target}`);
    await loadHealth();
  } catch (err) {
    ElMessage.error(errorMessage(err, '备份失败'));
  }
}

const form = reactive({
  port: 8787,
  host: '127.0.0.1',
  db_type: 'sqlite',
  db_path: 'center/data/center.db',
  llm_base_url: '',
  llm_api_key: '',
  llm_model: 'deepseek-chat',
  llm_timeout_ms: 30000,
  auth_mode: 'optional',
  role_enforcement: 'off',
});

const rules = {
  port: [
    { required: true, message: '请填写监听端口', trigger: 'blur' },
    { type: 'integer', min: 1, max: 65535, message: '端口需在 1–65535 之间', trigger: 'blur' },
  ],
  host: [{ required: true, message: '请填写监听地址', trigger: 'blur' }],
  db_path: [{ required: true, message: '请填写数据库路径', trigger: 'blur' }],
  llm_timeout_ms: [
    { type: 'integer', min: 1, message: '超时时间需为正数', trigger: 'blur' },
  ],
};

async function load() {
  loading.value = true;
  try {
    const current = await api.setupStatus();
    status.value = current;
    form.port = current.port;
    form.host = current.host;
    form.db_type = current.db_type;
    form.llm_base_url = current.llm.base_url || '';
    form.llm_model = current.llm.model || 'deepseek-chat';
    form.auth_mode = current.security?.auth_mode || 'optional';
    form.role_enforcement = current.security?.role_enforcement || 'off';
    // db_path 回显为当前生效路径，便于查看。
    form.db_path = current.db_path;
  } catch (err) {
    ElMessage.error(errorMessage(err, '加载设置失败'));
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  load();
  loadPrefs();
  loadHealth();
});

async function submit() {
  try {
    await formRef.value.validate();
  } catch {
    return;
  }
  submitting.value = true;
  try {
    const payload = {
      port: form.port,
      host: form.host,
      db: { type: form.db_type, path: form.db_path },
      llm: {
        base_url: form.llm_base_url,
        model: form.llm_model,
        timeout_ms: form.llm_timeout_ms,
      },
      security: {
        auth_mode: form.auth_mode,
        role_enforcement: form.role_enforcement,
      },
    };
    // 密钥留空表示不修改，避免误清空已保存的密钥。
    if (form.llm_api_key.trim()) payload.llm.api_key = form.llm_api_key;

    const result = await api.updateSetup(payload);
    needsRestart.value = result.needs_restart || [];
    // 保存后立即刷新侧边栏 AI 徽标，不用等路由跳转。
    await refreshAiHealth();
    ElMessage.success('设置已保存');
    await load();
  } catch (err) {
    ElMessage.error(errorMessage(err, '保存设置失败'));
  } finally {
    submitting.value = false;
  }
}

const restartHint = () => {
  const labels = { port: '端口', host: '监听地址', db: '数据库' };
  return needsRestart.value.map((key) => labels[key] || key).join('、');
};
</script>

<template>
  <div class="settings-page">
    <el-card class="settings-card" shadow="never" v-loading="loading">
      <h2 class="settings-title">系统设置</h2>

      <el-alert
        type="warning"
        :closable="false"
        show-icon
        title="端口、监听地址、数据库修改后需重启 Center 才生效"
        description="模型配置保存后立即可用，无需重启。"
        class="settings-alert"
      />

      <el-alert
        v-if="needsRestart.length > 0"
        type="error"
        :closable="false"
        show-icon
        :title="`以下修改需要重启 Center 后才生效：${restartHint()}`"
        class="settings-alert"
      />

      <el-alert
        v-if="status && !status.llm.configured"
        type="info"
        :closable="false"
        show-icon
        title="AI 未配置"
        description="未配置模型不影响主干、需求、任务、评审等核心链路；AI 仅用于生成建议。"
        class="settings-alert"
      />

      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-width="110px"
        class="settings-form"
      >
        <el-divider content-position="left">基础</el-divider>
        <el-form-item label="监听端口" prop="port">
          <el-input-number v-model="form.port" :min="1" :max="65535" :step="1" />
        </el-form-item>
        <el-form-item label="监听地址" prop="host">
          <el-input v-model="form.host" placeholder="127.0.0.1" />
        </el-form-item>
        <el-form-item label="数据库类型" prop="db_type">
          <el-radio-group v-model="form.db_type">
            <el-radio value="sqlite">SQLite</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="数据库路径" prop="db_path">
          <el-input v-model="form.db_path" placeholder="center/data/center.db" />
        </el-form-item>

        <el-divider content-position="left">模型</el-divider>
        <el-form-item label="接口地址" prop="llm_base_url">
          <el-input v-model="form.llm_base_url" placeholder="https://api.example.com/v1" />
        </el-form-item>
        <el-form-item label="API Key" prop="llm_api_key">
          <el-input
            v-model="form.llm_api_key"
            type="password"
            show-password
            placeholder="留空表示不修改已保存的密钥"
          />
        </el-form-item>
        <el-form-item label="模型名称" prop="llm_model">
          <el-input v-model="form.llm_model" placeholder="deepseek-chat" />
        </el-form-item>
        <el-form-item label="超时（毫秒）" prop="llm_timeout_ms">
          <el-input-number v-model="form.llm_timeout_ms" :min="1" :step="1000" />
        </el-form-item>

        <el-divider content-position="left">安全</el-divider>
        <el-alert
          type="warning"
          :closable="false"
          show-icon
          title="认证与角色开关会影响所有写操作"
          description="切到「必须带凭据」后，除引导期外所有写操作都需要 Authorization: Bearer <token>；切到「强制项目角色」后，决定、评审、主干、契约发布等动作还要求发起人具备对应项目角色。"
          class="settings-alert"
        />
        <el-form-item label="认证模式">
          <el-radio-group v-model="form.auth_mode">
            <el-radio value="optional">可选（保留无凭据调用）</el-radio>
            <el-radio value="required">必须带凭据</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="项目角色">
          <el-radio-group v-model="form.role_enforcement">
            <el-radio value="off">不强制</el-radio>
            <el-radio value="on">强制</el-radio>
          </el-radio-group>
        </el-form-item>

        <el-form-item>
          <el-button type="primary" :loading="submitting" @click="submit">
            保存设置
          </el-button>
          <el-button @click="load">重置</el-button>
        </el-form-item>
      </el-form>

      <el-divider content-position="left">通知</el-divider>
      <el-form label-width="110px" class="settings-form">
        <el-form-item label="当前主体">
          <el-input
            :model-value="actorId"
            placeholder="act_...，用于接收站内通知"
            @update:model-value="saveActorId"
          />
        </el-form-item>
      </el-form>
      <el-alert
        v-if="!actorId"
        type="info"
        :closable="false"
        show-icon
        title="未填写主体"
        description="填写主体 ID 后，顶栏铃铛会显示该主体的未读通知；通知只是提醒，不产生任何权限。"
        class="settings-alert"
      />
      <el-table v-else :data="prefs" size="small">
        <el-table-column label="类型" min-width="160">
          <template #default="{ row }">{{ KIND_TEXT[row.kind] || row.kind }}</template>
        </el-table-column>
        <el-table-column label="接收" width="120">
          <template #default="{ row }">
            <el-switch
              :model-value="row.enabled"
              @update:model-value="(value) => togglePref(row.kind, value)"
            />
          </template>
        </el-table-column>
      </el-table>

      <el-divider content-position="left">运行健康</el-divider>
      <div v-loading="healthLoading">
        <el-alert
          v-if="health && !health.ok"
          type="error"
          :closable="false"
          show-icon
          :title="`数据库完整性异常：${health.integrity.join(', ')}`"
          class="settings-alert"
        />
        <el-descriptions v-if="health" :column="2" border size="small">
          <el-descriptions-item label="完整性">
            {{ health.ok ? '正常' : '异常' }}
          </el-descriptions-item>
          <el-descriptions-item label="Outbox 待投递">
            {{ health.outbox.pending }}
          </el-descriptions-item>
          <el-descriptions-item label="过期未回收租约">
            {{ health.expired_leases }}
          </el-descriptions-item>
          <el-descriptions-item label="24h 错误">
            {{ health.errors_24h }}
          </el-descriptions-item>
          <el-descriptions-item label="任务数">
            {{ health.tables.tasks }}
          </el-descriptions-item>
          <el-descriptions-item label="通知数">
            {{ health.tables.notifications }}
          </el-descriptions-item>
        </el-descriptions>
        <div class="settings-actions">
          <el-button size="small" @click="loadHealth">
            <el-icon><Refresh /></el-icon>
            刷新
          </el-button>
          <el-tooltip content="需要管理员 human 凭据（SAP_TOKEN）" placement="top">
            <el-button size="small" type="primary" plain @click="backupNow">
              立即备份
            </el-button>
          </el-tooltip>
        </div>
      </div>
    </el-card>
  </div>
</template>

<style scoped>
.settings-page {
  max-width: 760px;
  margin: 0 auto;
  padding: 24px 16px;
}

.settings-card {
  border: 1px solid #e4e7ed;
}

.settings-title {
  margin: 0 0 16px;
  font-size: 20px;
}

.settings-alert {
  margin-bottom: 14px;
}

.settings-form {
  margin-top: 8px;
}

.settings-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
</style>
