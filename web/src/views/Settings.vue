<script setup>
// 系统设置（T10）：查看并修改端口、监听、数据库与模型配置。
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, errorMessage } from '../api.js';

const loading = ref(false);
const submitting = ref(false);
const formRef = ref(null);
const needsRestart = ref([]);
const status = ref(null);

const form = reactive({
  port: 8787,
  host: '127.0.0.1',
  db_type: 'sqlite',
  db_path: 'center/data/center.db',
  llm_base_url: '',
  llm_api_key: '',
  llm_model: 'deepseek-chat',
  llm_timeout_ms: 30000,
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
    // db_path 回显为当前生效路径，便于查看。
    form.db_path = current.db_path;
  } catch (err) {
    ElMessage.error(errorMessage(err, '加载设置失败'));
  } finally {
    loading.value = false;
  }
}

onMounted(load);

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
    };
    // 密钥留空表示不修改，避免误清空已保存的密钥。
    if (form.llm_api_key.trim()) payload.llm.api_key = form.llm_api_key;

    const result = await api.updateSetup(payload);
    needsRestart.value = result.needs_restart || [];
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

        <el-form-item>
          <el-button type="primary" :loading="submitting" @click="submit">
            保存设置
          </el-button>
          <el-button @click="load">重置</el-button>
        </el-form-item>
      </el-form>
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
</style>
