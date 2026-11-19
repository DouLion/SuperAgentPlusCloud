<script setup>
// 首次初始化向导（T10）：欢迎 → 基础 → 模型（可跳过）→ 完成。
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api, errorMessage } from '../api.js';
import { refreshAiHealth } from '../appState.js';

const router = useRouter();
const active = ref(0);
const submitting = ref(false);
const formRef = ref(null);

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

onMounted(async () => {
  try {
    const status = await api.setupStatus();
    form.port = status.port;
    form.host = status.host;
    form.db_type = status.db_type;
    form.llm_base_url = status.llm.base_url || '';
    form.llm_model = status.llm.model || 'deepseek-chat';
  } catch {
    // 保持默认值，提交时再报错。
  }
});

function next() {
  active.value = Math.min(active.value + 1, 3);
}

function prev() {
  active.value = Math.max(active.value - 1, 0);
}

async function finish() {
  try {
    await formRef.value.validate();
  } catch {
    return;
  }
  submitting.value = true;
  try {
    await api.initSetup({
      initialized: true,
      port: form.port,
      host: form.host,
      db: { type: form.db_type, path: form.db_path },
      llm: {
        base_url: form.llm_base_url,
        api_key: form.llm_api_key,
        model: form.llm_model,
        timeout_ms: form.llm_timeout_ms,
      },
    });
    ElMessage.success('初始化完成');
    await refreshAiHealth();
    router.replace({ name: 'projects' });
  } catch (err) {
    ElMessage.error(errorMessage(err, '初始化失败'));
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="setup-page">
    <el-card class="setup-card" shadow="never">
      <h2 class="setup-title">初始化设置</h2>
      <el-steps :active="active" align-center finish-status="success" class="setup-steps">
        <el-step title="欢迎" />
        <el-step title="基础" />
        <el-step title="模型（可跳过）" />
        <el-step title="完成" />
      </el-steps>

      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-width="110px"
        class="setup-form"
      >
        <div v-show="active === 0" class="step-body"></div>

        <div v-show="active === 1" class="step-body">
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
        </div>

        <div v-show="active === 2" class="step-body">
          <el-form-item label="接口地址" prop="llm_base_url">
            <el-input v-model="form.llm_base_url" placeholder="https://api.example.com/v1" />
          </el-form-item>
          <el-form-item label="API Key" prop="llm_api_key">
            <el-input
              v-model="form.llm_api_key"
              type="password"
              show-password
              placeholder="可留空"
            />
          </el-form-item>
          <el-form-item label="模型名称" prop="llm_model">
            <el-input v-model="form.llm_model" placeholder="deepseek-chat" />
          </el-form-item>
          <el-form-item label="超时（毫秒）" prop="llm_timeout_ms">
            <el-input-number v-model="form.llm_timeout_ms" :min="1" :step="1000" />
          </el-form-item>
        </div>

        <div v-show="active === 3" class="step-body">
          <el-alert
            type="success"
            :closable="false"
            show-icon
            title="即将完成初始化"
            :description="`端口 ${form.port}，监听 ${form.host}，数据库 ${form.db_path}；模型 ${form.llm_base_url ? form.llm_model : '未配置'}。`"
          />
          <el-form-item label="监听端口" prop="port">
            <el-input-number v-model="form.port" :min="1" :max="65535" :step="1" />
          </el-form-item>
          <el-form-item label="监听地址" prop="host">
            <el-input v-model="form.host" />
          </el-form-item>
          <el-form-item label="数据库路径" prop="db_path">
            <el-input v-model="form.db_path" />
          </el-form-item>
        </div>
      </el-form>

      <div class="setup-actions">
        <el-button v-if="active > 0" @click="prev">上一步</el-button>
        <el-button v-if="active < 3" type="primary" @click="next">下一步</el-button>
        <el-button
          v-if="active === 2"
          type="info"
          plain
          @click="next"
        >
          跳过模型配置
        </el-button>
        <el-button
          v-if="active === 3"
          type="primary"
          :loading="submitting"
          @click="finish"
        >
          完成初始化
        </el-button>
      </div>
    </el-card>
  </div>
</template>

<style scoped>
.setup-page {
  max-width: 760px;
  margin: 0 auto;
  padding: 24px 16px;
}

.setup-card {
  border: 1px solid #e4e7ed;
}

.setup-title {
  margin: 0 0 16px;
  font-size: 20px;
}

.setup-steps {
  margin-bottom: 20px;
}

.step-body {
  min-height: 220px;
}

.step-alert {
  margin-bottom: 16px;
}

.setup-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid #f0f2f5;
}
</style>
