<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, errorMessage, getToken, setToken } from '../api.js';
import { formatTime } from '../status.js';
import EmptyState from '../components/EmptyState.vue';
import { PRESENCE_TEXT, PRESENCE_TYPE, STUCK_KIND_TEXT } from '../agents-meta.js';

const loading = ref(false);
const actors = ref([]);
const delegations = ref([]);
const stuck = ref([]);
const stuckLoading = ref(false);

const token = ref(getToken());
const tokenVisible = ref(false);

const createVisible = ref(false);
const creating = ref(false);
const createForm = reactive({
  type: 'human',
  display_name: '',
  on_behalf_of: '',
  created_by: '',
});

const credentialVisible = ref(false);
const issuing = ref(false);
const issuedToken = ref('');
const issuedActor = ref('');
const credentialForm = reactive({ actor_id: '', label: '' });

const capabilityVisible = ref(false);
const capabilitySaving = ref(false);
const capabilityForm = reactive({ actor_id: '', actor_name: '', key: '', level: 'standard' });

const humanActors = computed(() => actors.value.filter((item) => item.type === 'human'));
const canManage = computed(() => Boolean(token.value.trim()));

function saveToken() {
  setToken(token.value.trim());
  ElMessage.success(token.value.trim() ? '已保存令牌，本页操作将带入身份' : '已清除令牌，操作将以匿名方式进行');
  load();
}

function capabilityText(capabilities) {
  const entries = Object.entries(capabilities || {});
  return entries.length ? entries : [];
}

async function load() {
  loading.value = true;
  try {
    const [actorResult, delegationRows] = await Promise.all([
      api.observabilityActors(),
      api.listDelegations().catch(() => []),
    ]);
    actors.value = actorResult.actors || [];
    delegations.value = delegationRows;
  } catch (err) {
    ElMessage.error(errorMessage(err, '加载主体状态失败'));
  } finally {
    loading.value = false;
  }
}

async function loadStuck() {
  stuckLoading.value = true;
  try {
    const result = await api.observabilityStuck();
    stuck.value = result.items || [];
  } catch (err) {
    ElMessage.error(errorMessage(err, '加载卡住任务失败'));
  } finally {
    stuckLoading.value = false;
  }
}

function openCreate() {
  Object.assign(createForm, {
    type: 'human',
    display_name: '',
    on_behalf_of: '',
    created_by: token.value ? '' : '',
  });
  createVisible.value = true;
}

async function submitCreate() {
  if (!createForm.display_name.trim()) {
    ElMessage.warning('请填写显示名');
    return;
  }
  if (createForm.type === 'agent' && !createForm.on_behalf_of) {
    ElMessage.warning('Agent 必须选择人类责任人');
    return;
  }
  creating.value = true;
  try {
    const payload = {
      type: createForm.type,
      display_name: createForm.display_name.trim(),
    };
    if (createForm.created_by.trim()) payload.created_by = createForm.created_by.trim();
    if (createForm.type === 'agent') payload.on_behalf_of = createForm.on_behalf_of;
    const created = await api.createActor(payload);
    ElMessage.success(`已创建主体：${created.actor_id}`);
    createVisible.value = false;
    await load();
  } catch (err) {
    ElMessage.error(errorMessage(err, '创建主体失败'));
  } finally {
    creating.value = false;
  }
}

function openCredential(row) {
  Object.assign(credentialForm, { actor_id: row.actor_id, label: '' });
  issuedToken.value = '';
  issuedActor.value = row.display_name;
  credentialVisible.value = true;
}

async function issueCredential() {
  issuing.value = true;
  try {
    const result = await api.issueCredential(credentialForm.actor_id, {
      label: credentialForm.label || undefined,
    });
    issuedToken.value = result.token;
    ElMessage.success('凭据已签发，明文只显示这一次');
    await load();
  } catch (err) {
    ElMessage.error(errorMessage(err, '签发凭据失败'));
  } finally {
    issuing.value = false;
  }
}

async function copyToken() {
  try {
    await navigator.clipboard.writeText(issuedToken.value);
    ElMessage.success('已复制');
  } catch {
    ElMessage.warning('浏览器拒绝剪贴板访问，请手动选中复制');
  }
}

function closeCredential() {
  issuedToken.value = '';
  credentialVisible.value = false;
}

async function disableActor(row) {
  try {
    await api.disableActor(row.actor_id, { actor: row.actor_id, reason: '面板停用' });
    ElMessage.success(`已停用：${row.actor_id}`);
    await load();
  } catch (err) {
    ElMessage.error(errorMessage(err, '停用主体失败'));
  }
}

function openCapability(row) {
  Object.assign(capabilityForm, {
    actor_id: row.actor_id,
    actor_name: row.display_name,
    key: '',
    level: 'standard',
  });
  capabilityVisible.value = true;
}

async function saveCapability() {
  if (!capabilityForm.key.trim()) {
    ElMessage.warning('请填写能力 key');
    return;
  }
  capabilitySaving.value = true;
  try {
    await api.setCapability(capabilityForm.actor_id, {
      key: capabilityForm.key.trim(),
      level: capabilityForm.level,
    });
    ElMessage.success('能力已保存（只影响推荐，不产生授权）');
    capabilityVisible.value = false;
    await load();
  } catch (err) {
    ElMessage.error(errorMessage(err, '设置能力失败'));
  } finally {
    capabilitySaving.value = false;
  }
}

async function revoke(delegation) {
  try {
    await api.revokeDelegation(delegation.delegation_id, { actor: delegation.on_behalf_of, reason: '面板撤销' });
    ElMessage.success('委派已撤销');
    await load();
  } catch (err) {
    ElMessage.error(errorMessage(err, '撤销委派失败'));
  }
}

function actorName(id) {
  return actors.value.find((item) => item.actor_id === id)?.display_name || id;
}

onMounted(() => {
  load();
  loadStuck();
});
</script>

<template>
  <div class="page" v-loading="loading">
    <div class="page-header">
      <div>
        <h2 class="page-title">主体与在线状态</h2>
        <div class="page-subtitle">
          人类、Agent 与服务账号在这里登记；能力只影响推荐，不产生授权。
        </div>
      </div>
      <div class="toolbar">
        <el-button size="small" @click="load(); loadStuck()">
          <el-icon><Refresh /></el-icon>
          刷新
        </el-button>
        <el-button type="primary" @click="openCreate">
          <el-icon><Plus /></el-icon>
          新建主体
        </el-button>
      </div>
    </div>

    <el-alert
      v-if="!canManage"
      type="warning"
      show-icon
      :closable="false"
      title="当前为匿名操作"
      description="身份管理、签发凭据与能力设置需要人类令牌。请在下方填入令牌后保存；读取类信息不受影响。"
      style="margin-bottom: 12px"
    />

    <el-card shadow="never" style="margin-bottom: 12px">
      <div class="token-row">
        <span class="muted">人类令牌（仅保存在本机浏览器）</span>
        <el-input
          v-model="token"
          :type="tokenVisible ? 'text' : 'password'"
          placeholder="sap_..."
          style="max-width: 360px"
          show-password
          clearable
        />
        <el-switch v-model="tokenVisible" active-text="显示" inactive-text="隐藏" />
        <el-button type="primary" plain @click="saveToken">保存令牌</el-button>
      </div>
    </el-card>

    <el-card shadow="never">
      <div class="panel__head">
        <span class="panel__title">主体</span>
        <span class="panel__count">{{ actors.length }}</span>
      </div>
      <EmptyState v-if="!loading && actors.length === 0" description="还没有主体，先创建一个人类主体" :height="'140px'" />
      <el-table v-else :data="actors" size="small" row-key="actor_id">
        <el-table-column label="类型" width="90">
          <template #default="{ row }">
            <el-tag size="small" effect="plain" :type="row.type === 'human' ? 'success' : row.type === 'agent' ? 'primary' : 'info'">
              {{ row.type === 'human' ? '人类' : row.type === 'agent' ? 'Agent' : '服务' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="display_name" label="显示名" min-width="140" show-overflow-tooltip />
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag size="small" :type="row.status === 'active' ? 'success' : 'info'" effect="plain">
              {{ row.status === 'active' ? '启用' : '停用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="在线" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="PRESENCE_TYPE[row.presence] || 'info'" effect="light">
              {{ PRESENCE_TEXT[row.presence] || row.presence }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="active_claims" label="活跃认领" width="100" />
        <el-table-column label="能力" min-width="200">
          <template #default="{ row }">
            <span v-if="capabilityText(row.capabilities).length === 0" class="muted">未声明</span>
            <el-tag
              v-for="[key, level] in capabilityText(row.capabilities)"
              :key="`${row.actor_id}-${key}`"
              size="small"
              effect="plain"
              style="margin-right: 4px"
            >
              {{ key }}·{{ level }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="最近活动" width="160">
          <template #default="{ row }">
            <span class="muted">{{ row.last_used_at ? formatTime(row.last_used_at) : '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="230" fixed="right">
          <template #default="{ row }">
            <el-button size="small" text type="primary" @click="openCredential(row)">签发凭据</el-button>
            <el-button size="small" text @click="openCapability(row)">能力</el-button>
            <el-button size="small" text type="danger" @click="disableActor(row)">停用</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" style="margin-top: 12px">
      <div class="panel__head">
        <span class="panel__title">委派</span>
        <span class="panel__count">{{ delegations.length }}</span>
      </div>
      <EmptyState v-if="delegations.length === 0" description="没有委派记录" :height="'110px'" />
      <el-table v-else :data="delegations" size="small">
        <el-table-column label="Agent" min-width="150">
          <template #default="{ row }">{{ actorName(row.agent_actor_id) }}</template>
        </el-table-column>
        <el-table-column label="人类责任人" min-width="150">
          <template #default="{ row }">{{ actorName(row.on_behalf_of) }}</template>
        </el-table-column>
        <el-table-column label="项目" min-width="140">
          <template #default="{ row }">
            <span class="mono muted">{{ row.project_id || '全部项目' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="有效期至" width="160">
          <template #default="{ row }">
            <span class="muted">{{ row.valid_until ? formatTime(row.valid_until) : '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="row.revoked_at ? 'info' : 'success'" effect="plain">
              {{ row.revoked_at ? '已撤销' : '生效中' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="100" fixed="right">
          <template #default="{ row }">
            <el-button
              size="small"
              text
              type="danger"
              :disabled="Boolean(row.revoked_at)"
              @click="revoke(row)"
            >
              撤销
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card v-loading="stuckLoading" shadow="never" style="margin-top: 12px">
      <div class="panel__head">
        <span class="panel__title">卡住的任务</span>
        <span class="panel__count">{{ stuck.length }}</span>
      </div>
      <EmptyState v-if="!stuckLoading && stuck.length === 0" description="当前没有被判定为卡住的任务" :height="'110px'" />
      <div v-else>
        <div v-for="kind in ['lease_expiring', 'heartbeat_stale', 'review_overdue']" :key="kind">
          <template v-if="stuck.some((item) => item.kind === kind)">
            <div class="panel__title" style="margin: 10px 0 6px">{{ STUCK_KIND_TEXT[kind] || kind }}</div>
            <el-table :data="stuck.filter((item) => item.kind === kind)" size="small">
              <el-table-column label="任务" min-width="220">
                <template #default="{ row }">
                  <span class="mono">{{ row.task_id }}</span>
                </template>
              </el-table-column>
              <el-table-column label="项目" min-width="160">
                <template #default="{ row }">
                  <span class="mono muted">{{ row.project_id }}</span>
                </template>
              </el-table-column>
              <el-table-column label="主体" min-width="140">
                <template #default="{ row }">
                  {{ row.actor_id ? actorName(row.actor_id) : '—' }}
                </template>
              </el-table-column>
              <el-table-column prop="detail" label="说明" min-width="220" show-overflow-tooltip />
            </el-table>
          </template>
        </div>
      </div>
    </el-card>

    <el-dialog v-model="createVisible" title="新建主体" width="520px">
      <el-form :model="createForm" label-width="110px">
        <el-form-item label="类型">
          <el-radio-group v-model="createForm.type">
            <el-radio-button label="human">人类</el-radio-button>
            <el-radio-button label="agent">Agent</el-radio-button>
            <el-radio-button label="service">服务</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="显示名" required>
          <el-input v-model="createForm.display_name" placeholder="例如：张三 / 前端 Agent" />
        </el-form-item>
        <el-form-item v-if="createForm.type === 'agent'" label="人类责任人" required>
          <el-select v-model="createForm.on_behalf_of" placeholder="选择人类责任人" style="width: 100%">
            <el-option
              v-for="human in humanActors"
              :key="human.actor_id"
              :label="`${human.display_name}（${human.actor_id}）`"
              :value="human.actor_id"
            />
          </el-select>
          <div class="muted" style="margin-top: 4px">Agent 必须绑定人类责任人，否则不能创建。</div>
        </el-form-item>
        <el-form-item label="创建人">
          <el-input v-model="createForm.created_by" placeholder="可选，记录在事件里" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="submitCreate">创建</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="credentialVisible" title="签发凭据" width="560px" @close="closeCredential">
      <el-form label-width="90px">
        <el-form-item label="主体">
          <span>{{ issuedActor }}</span>
        </el-form-item>
        <el-form-item label="标签">
          <el-input v-model="credentialForm.label" placeholder="可选，例如：本地开发" />
        </el-form-item>
      </el-form>
      <el-alert
        v-if="issuedToken"
        type="success"
        show-icon
        :closable="false"
        title="凭据已签发"
        description="明文只显示这一次，关闭后无法再查看。请立即复制并妥善保存。"
      />
      <div v-if="issuedToken" class="token-box">
        <span class="mono">{{ issuedToken }}</span>
        <el-button size="small" plain @click="copyToken">复制</el-button>
      </div>
      <template #footer>
        <el-button v-if="!issuedToken" @click="credentialVisible = false">取消</el-button>
        <el-button v-if="!issuedToken" type="primary" :loading="issuing" @click="issueCredential">签发</el-button>
        <el-button v-else type="primary" @click="closeCredential">我已保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="capabilityVisible" title="设置能力" width="480px">
      <el-form label-width="90px">
        <el-form-item label="主体">
          <span>{{ capabilityForm.actor_name }}</span>
        </el-form-item>
        <el-form-item label="能力 key" required>
          <el-input v-model="capabilityForm.key" placeholder="例如：frontend / backend / api-design" />
        </el-form-item>
        <el-form-item label="等级">
          <el-select v-model="capabilityForm.level" style="width: 100%">
            <el-option label="basic" value="basic" />
            <el-option label="standard" value="standard" />
            <el-option label="expert" value="expert" />
          </el-select>
        </el-form-item>
      </el-form>
      <el-alert
        type="info"
        show-icon
        :closable="false"
        title="能力只影响任务推荐排序"
        description="不会授予任何权限，也不会替人做验收。"
      />
      <template #footer>
        <el-button @click="capabilityVisible = false">取消</el-button>
        <el-button type="primary" :loading="capabilitySaving" @click="saveCapability">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.token-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.token-box {
  margin-top: 10px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  background: var(--sap-bg-soft);
  border: 1px solid var(--sap-border);
  border-radius: 6px;
  padding: 10px 12px;
  word-break: break-all;
}

.panel__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 8px;
}

.panel__title {
  font-size: 14px;
  font-weight: 600;
}

.panel__count {
  font-size: 12px;
  color: var(--sap-muted);
}
</style>
