<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api, errorMessage } from '../api.js';
import { formatTime } from '../status.js';
import StatusTag from '../components/StatusTag.vue';
import EmptyState from '../components/EmptyState.vue';
import { go } from '../nav.js';

const route = useRoute();
const router = useRouter();
const taskId = route.params.taskId;

const loading = ref(false);
const task = ref(null);
const claims = ref([]);
const submissions = ref([]);
const reviewsMap = ref({});

const workerId = ref(localStorage.getItem('sap.workerId') || '');
const claimSubmitting = ref(false);
const releaseSubmitting = ref(false);

const submitVisible = ref(false);
const submitSubmitting = ref(false);
const submitForm = reactive({
  commit_refs: '',
  summary: '',
  self_test: '',
  known_gaps: '',
  submitted_by: '',
  fencing_token: '',
});
const submitRules = {
  commit_refs: [{ required: true, message: '请至少填写一个 commit 引用（repo@hash）', trigger: 'blur' }],
  summary: [{ required: true, message: '请填写提交摘要', trigger: 'blur' }],
  submitted_by: [{ required: true, message: '请填写提交人', trigger: 'blur' }],
};

const reviewVisible = ref(false);
const reviewSubmitting = ref(false);
const reviewForm = reactive({
  submission_id: '',
  reviewer_id: '',
  conclusion: '',
  reason: '',
  criteria: [{ criterion: '', result: '', evidence: '' }],
});

const activeClaim = computed(() => claims.value.find((claim) => claim.status === 'active') || null);

/** 租约倒计时：每秒刷新，组件卸载时清理。 */
const nowMs = ref(Date.now());
let ticker = null;

const activeClaimLease = computed(() => {
  const claim = activeClaim.value;
  if (!claim?.lease_expires_at) return null;
  const remainMs = Date.parse(claim.lease_expires_at) - nowMs.value;
  return {
    remainMs,
    expired: remainMs <= 0,
    text: remainMs <= 0
      ? '租约已过期'
      : `租约剩 ${Math.floor(remainMs / 60000)} 分 ${Math.floor((remainMs % 60000) / 1000)} 秒`,
  };
});

const contextBundle = ref(null);
const contextError = ref('');
const contextLoading = ref(false);

async function loadContext() {
  contextLoading.value = true;
  contextError.value = '';
  try {
    contextBundle.value = await api.getTaskContext(taskId);
  } catch (err) {
    contextBundle.value = null;
    contextError.value = errorMessage(err, '上下文暂不可用');
  } finally {
    contextLoading.value = false;
  }
}

const stepIndex = computed(() => {
  const status = task.value?.status;
  if (status === 'draft') return 0;
  if (status === 'open') return 1;
  if (status === 'claimed') return 2;
  if (status === 'submitted') return 3;
  if (status === 'rework') return 3;
  if (status === 'accepted') return 4;
  if (status === 'closed') return 5;
  return 0;
});

const canClaim = computed(() => ['open', 'rework'].includes(task.value?.status));
const canRelease = computed(() => Boolean(activeClaim.value));
const canSubmit = computed(() => task.value?.status === 'claimed' && Boolean(activeClaim.value));
const canReview = computed(() => submissions.value.length > 0);

const claimHint = computed(() => {
  if (!workerId.value.trim()) return '请先填写工作者 ID';
  if (!canClaim.value) return `当前状态 ${task.value?.status} 不可认领`;
  return '';
});

const deliveryChain = computed(() => {
  const events = [];
  for (const claim of claims.value) {
    events.push({
      key: claim.claim_id,
      time: claim.claimed_at,
      title: `认领：${claim.worker_id}`,
      detail: claim.released_at ? `释放于 ${formatTime(claim.released_at)}` : '当前持有任务',
      tag: { group: 'claim', value: claim.status },
    });
  }
  for (const submission of submissions.value) {
    events.push({
      key: submission.submission_id,
      time: submission.submitted_at,
      title: `提交：${submission.summary || submission.submission_id}`,
      detail: `提交人 ${submission.submitted_by}`,
      tag: { group: 'task', value: 'submitted' },
    });
    for (const review of reviewsMap.value[submission.submission_id] || []) {
      events.push({
        key: review.review_id,
        time: review.reviewed_at,
        title: `评审：${review.conclusion}（${review.reviewer_id}）`,
        detail: review.reason || (review.criterion_results || []).map((item) => `${item.criterion}=${item.result}`).join('；'),
        tag: { group: 'review', value: review.conclusion },
      });
    }
  }
  return events.sort((a, b) => (a.time < b.time ? 1 : -1));
});

async function load() {
  loading.value = true;
  try {
    const [taskRow, claimRows, submissionRows] = await Promise.all([
      api.getTask(taskId),
      api.listClaims(taskId),
      api.listSubmissions(taskId),
    ]);
    task.value = taskRow;
    claims.value = claimRows;
    submissions.value = submissionRows;
    const reviews = await Promise.all(
      submissionRows.map((submission) => api.listReviews(submission.submission_id).catch(() => [])),
    );
    const map = {};
    submissionRows.forEach((submission, index) => {
      map[submission.submission_id] = reviews[index];
    });
    reviewsMap.value = map;
    if (activeClaim.value && !workerId.value) workerId.value = activeClaim.value.worker_id;
  } catch (err) {
    ElMessage.error(errorMessage(err, '加载任务详情失败'));
  } finally {
    loading.value = false;
  }
}

function saveWorker() {
  if (workerId.value.trim()) localStorage.setItem('sap.workerId', workerId.value.trim());
  else localStorage.removeItem('sap.workerId');
}

async function claim() {
  if (!workerId.value.trim()) {
    ElMessage.warning('请填写工作者 ID');
    return;
  }
  claimSubmitting.value = true;
  try {
    const result = await api.claimTask(taskId, { worker_id: workerId.value.trim() });
    ElMessage.success(`已认领：${result.claim.claim_id}`);
    await load();
  } catch (err) {
    ElMessage.error(errorMessage(err, '认领失败'));
  } finally {
    claimSubmitting.value = false;
  }
}

async function release() {
  if (!workerId.value.trim()) {
    ElMessage.warning('请填写工作者 ID');
    return;
  }
  releaseSubmitting.value = true;
  try {
    const result = await api.releaseTask(taskId, { worker_id: workerId.value.trim() });
    ElMessage.success(`已释放，任务回到可认领：${result.claim.claim_id}`);
    await load();
  } catch (err) {
    ElMessage.error(errorMessage(err, '释放失败'));
  } finally {
    releaseSubmitting.value = false;
  }
}

function openSubmit() {
  Object.assign(submitForm, {
    commit_refs: '',
    summary: '',
    self_test: '',
    known_gaps: '',
    submitted_by: activeClaim.value?.worker_id || workerId.value,
    fencing_token: activeClaim.value?.fencing_token ?? '',
  });
  submitVisible.value = true;
}

async function submitDelivery() {
  const refs = submitForm.commit_refs
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const at = line.indexOf('@');
      if (at <= 0 || at === line.length - 1) {
        throw new Error(`commit 第 ${index + 1} 行格式应为 repo@hash：${line}`);
      }
      return { repo: line.slice(0, at), hash: line.slice(at + 1) };
    });
  if (refs.length === 0) {
    ElMessage.error('请至少填写一个 commit 引用（repo@hash）');
    return;
  }
  submitSubmitting.value = true;
  try {
    const created = await api.createSubmission(taskId, {
      commit_refs: refs,
      summary: submitForm.summary,
      self_test: submitForm.self_test || undefined,
      known_gaps: submitForm.known_gaps.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      submitted_by: submitForm.submitted_by,
      claim_id: activeClaim.value?.claim_id,
      fencing_token: submitForm.fencing_token === '' ? undefined : Number(submitForm.fencing_token),
    });
    ElMessage.success(`提交已登记：${created.submission_id}，任务进入待评审`);
    submitVisible.value = false;
    await load();
  } catch (err) {
    ElMessage.error(errorMessage(err, '登记提交失败'));
  } finally {
    submitSubmitting.value = false;
  }
}

function openReview() {
  const last = submissions.value[submissions.value.length - 1];
  Object.assign(reviewForm, {
    submission_id: last?.submission_id || '',
    reviewer_id: workerId.value || '',
    conclusion: '',
    reason: '',
    criteria: [{ criterion: '', result: '', evidence: '' }],
  });
  reviewVisible.value = true;
}

async function submitReview() {
  const criteria = reviewForm.criteria
    .map((item) => ({
      criterion: item.criterion.trim(),
      result: item.result.trim(),
      evidence: item.evidence.trim(),
    }))
    .filter((item) => item.criterion && item.result);
  if (reviewForm.conclusion === 'confirm' && criteria.length === 0) {
    ElMessage.error('结论为 confirm 时必须提供至少一条完成条件结果');
    return;
  }
  if (reviewForm.conclusion === 'reject' && !reviewForm.reason.trim()) {
    ElMessage.error('结论为 reject 时必须填写理由');
    return;
  }
  reviewSubmitting.value = true;
  try {
    const created = await api.createReview(reviewForm.submission_id, {
      reviewer_id: reviewForm.reviewer_id,
      conclusion: reviewForm.conclusion,
      criterion_results: criteria,
      reason: reviewForm.reason || undefined,
    });
    ElMessage.success(`评审已记录：${created.review_id}`);
    reviewVisible.value = false;
    await load();
  } catch (err) {
    ElMessage.error(errorMessage(err, '记录评审失败'));
  } finally {
    reviewSubmitting.value = false;
  }
}

onMounted(() => {
  if (!taskId) {
    go(router, 'projects');
    return;
  }
  load();
  loadContext();
  ticker = setInterval(() => { nowMs.value = Date.now(); }, 1000);
});

onBeforeUnmount(() => {
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }
});
</script>

<template>
  <div class="page" v-loading="loading">
    <div class="page-header">
      <div>
        <h2 class="page-title">任务详情</h2>
        <div class="page-subtitle mono">{{ taskId }}</div>
      </div>
      <el-button size="small" @click="load">
        <el-icon><Refresh /></el-icon>
        刷新
      </el-button>
    </div>

    <EmptyState v-if="!loading && !task" description="任务不存在或加载失败" :height="'200px'">
      <el-button @click="go(router, 'projects')">返回项目列表</el-button>
    </EmptyState>

    <template v-else-if="task">
      <el-steps :active="stepIndex" align-center class="step-note" finish-status="success">
        <el-step title="草稿" description="未开放" />
        <el-step title="可认领" description="等待认领" />
        <el-step title="已认领" description="执行中" />
        <el-step title="待评审" description="提交后" />
        <el-step title="已通过" description="任务完成" />
        <el-step title="已关闭" description="流程结束" />
      </el-steps>

      <el-row :gutter="16" style="margin-top: 8px">
        <el-col :xs="24" :lg="14">
          <div class="panel">
            <div class="panel__head">
              <span class="panel__title">任务说明</span>
              <StatusTag group="task" :value="task.status" size="small" />
            </div>
            <div class="desc-grid">
              <span class="desc-label">目标</span>
              <span>{{ task.purpose }}</span>
              <span class="desc-label">范围</span>
              <span>{{ task.scope || '—' }}</span>
              <span class="desc-label">非目标</span>
              <span>{{ task.non_scope || '—' }}</span>
              <span class="desc-label">服务主干</span>
              <span v-if="(task.serves_item_ids || []).length">
                <el-tag v-for="id in task.serves_item_ids" :key="id" size="small" class="mono">
                  {{ id }}
                </el-tag>
              </span>
              <span v-else>探索任务（无主干关联）</span>
            </div>
            <div class="done-block">
              <div class="done-block__title">完成条件（评审逐条对照）</div>
              <ul class="done-list">
                <li v-for="(done, i) in task.done_when || []" :key="i">{{ done }}</li>
              </ul>
            </div>
          </div>

          <div class="panel">
            <div class="panel__head">
              <span class="panel__title">交付链</span>
              <span class="panel__count">{{ deliveryChain.length }}</span>
            </div>
            <EmptyState v-if="deliveryChain.length === 0" description="还没有认领或提交" :height="'80px'" />
            <el-timeline v-else>
              <el-timeline-item
                v-for="event in deliveryChain"
                :key="event.key"
                :timestamp="formatTime(event.time)"
                placement="top"
              >
                <div class="event-head">
                  <StatusTag :group="event.tag.group" :value="event.tag.value" size="small" />
                  <strong>{{ event.title }}</strong>
                </div>
                <div class="muted">{{ event.detail }}</div>
              </el-timeline-item>
            </el-timeline>
          </div>

          <div
            v-for="submission in submissions"
            :key="submission.submission_id"
            class="panel"
          >
            <div class="panel__head">
              <span class="panel__title">提交版本</span>
              <span class="mono muted">{{ submission.submission_id }}</span>
            </div>
            <div class="desc-grid">
              <span class="desc-label">摘要</span>
              <span>{{ submission.summary }}</span>
              <span class="desc-label">提交人</span>
              <span>{{ submission.submitted_by }}</span>
              <span class="desc-label">自测</span>
              <span>{{ submission.self_test || '—' }}</span>
              <span class="desc-label">已知缺口</span>
              <span v-if="(submission.known_gaps || []).length">{{ submission.known_gaps.join('；') }}</span>
              <span v-else>—</span>
              <span class="desc-label">commit</span>
              <span>
                <el-tag
                  v-for="(ref, i) in submission.commit_refs || []"
                  :key="i"
                  size="small"
                  class="mono"
                  style="margin-right: 6px"
                >
                  {{ ref.repo }}@{{ ref.hash }}
                </el-tag>
              </span>
            </div>

            <div v-if="(reviewsMap[submission.submission_id] || []).length" class="review-block">
              <div class="done-block__title">评审结果</div>
              <div
                v-for="review in reviewsMap[submission.submission_id]"
                :key="review.review_id"
                class="queue-item"
              >
                <div class="queue-item__meta">
                  <StatusTag group="review" :value="review.conclusion" size="small" />
                  <span class="muted">{{ review.reviewer_id }}</span>
                  <span v-if="review.self_review" class="muted">自审</span>
                </div>
                <ul class="done-list">
                  <li v-for="(item, i) in review.criterion_results || []" :key="i">
                    {{ item.criterion }} → {{ item.result }}
                    <span v-if="item.evidence" class="muted">（{{ item.evidence }}）</span>
                  </li>
                </ul>
                <div v-if="review.reason" class="muted">理由：{{ review.reason }}</div>
              </div>
            </div>
          </div>
        </el-col>

        <el-col :xs="24" :lg="10">
          <div class="panel">
            <div class="panel__head">
              <span class="panel__title">操作区</span>
              <span v-if="activeClaim" class="muted">
                当前认领：{{ activeClaim.actor_id || activeClaim.worker_id }}
              </span>
            </div>

            <div v-if="activeClaim" class="claim-brief">
              <el-tag size="small" effect="plain">
                {{ activeClaim.role === 'collaborator' ? '协作者' : '负责人' }}
              </el-tag>
              <el-tag size="small" effect="plain" type="info" class="mono">
                fencing {{ activeClaim.fencing_token ?? '—' }}
              </el-tag>
              <el-tag
                v-if="activeClaimLease"
                size="small"
                :type="activeClaimLease.expired ? 'danger' : (activeClaimLease.remainMs < 300000 ? 'danger' : 'success')"
                effect="plain"
              >
                {{ activeClaimLease.text }}
              </el-tag>
            </div>
            <el-input
              v-model="workerId"
              placeholder="工作者 ID"
              style="margin-bottom: 10px"
              @change="saveWorker"
            />
            <div class="suggestion-actions">
              <el-tooltip :disabled="!claimHint" :content="claimHint" placement="top">
                <span>
                  <el-button type="primary" :disabled="!canClaim || !workerId.trim()" :loading="claimSubmitting" @click="claim">
                    认领
                  </el-button>
                </span>
              </el-tooltip>
              <el-tooltip :disabled="canRelease" content="没有生效中的认领" placement="top">
                <span>
                  <el-button :disabled="!canRelease" :loading="releaseSubmitting" @click="release">
                    释放
                  </el-button>
                </span>
              </el-tooltip>
              <el-tooltip
                :disabled="canSubmit"
                :content="canSubmit ? '' : '任务需处于已认领且存在生效认领才能提交'"
                placement="top"
              >
                <span>
                  <el-button type="primary" plain :disabled="!canSubmit" @click="openSubmit">
                    提交成果
                  </el-button>
                </span>
              </el-tooltip>
              <el-tooltip :disabled="canReview" content="还没有可评审的提交" placement="top">
                <span>
                  <el-button :disabled="!canReview" @click="openReview">评审</el-button>
                </span>
              </el-tooltip>
            </div>
          </div>

          <div class="panel">
            <el-collapse>
              <el-collapse-item title="上下文摘要" name="context">
                <div v-if="contextLoading" class="muted">正在读取上下文…</div>
                <el-alert
                  v-else-if="contextError"
                  type="info"
                  show-icon
                  :closable="false"
                  :title="contextError"
                />
                <div v-else-if="contextBundle" class="context-block">
                  <div class="muted">
                    生成时间：{{ formatTime(contextBundle.generated_at) }}
                    <span v-if="contextBundle.staleness">　状态：{{ contextBundle.staleness }}</span>
                  </div>
                  <div class="digest-grid">
                    <template v-for="(value, key) in contextBundle.digests || {}" :key="key">
                      <span class="desc-label">{{ key }}</span>
                      <span class="mono muted">{{ value || '—' }}</span>
                    </template>
                  </div>
                  <div class="muted" style="margin-top: 6px">
                    认领与提交时引用这些摘要，可以说明当时基于哪一版约定与契约。
                  </div>
                </div>
                <div v-else class="muted">暂无上下文</div>
              </el-collapse-item>
            </el-collapse>
          </div>

          <div class="panel">
            <div class="panel__head">
              <span class="panel__title">认领历史</span>
            </div>
            <EmptyState v-if="claims.length === 0" description="还没有认领记录" :height="'60px'" />
            <div v-for="claim in claims" :key="claim.claim_id" class="queue-item">
              <div class="queue-item__meta">
                <StatusTag group="claim" :value="claim.status" size="small" />
                <span>{{ claim.worker_id }}</span>
                <span class="muted">{{ formatTime(claim.claimed_at) }}</span>
              </div>
            </div>
          </div>
        </el-col>
      </el-row>
    </template>

    <el-dialog v-model="submitVisible" title="提交成果" width="600px">
      <el-form :model="submitForm" :rules="submitRules" label-width="96px">
        <el-form-item label="commit 引用" prop="commit_refs">
          <el-input
            v-model="submitForm.commit_refs"
            type="textarea"
            :rows="3"
            placeholder="每行 repo@hash，例如 sap-center@a1b2c3d"
          />
        </el-form-item>
        <el-form-item label="摘要" prop="summary">
          <el-input v-model="submitForm.summary" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item label="自测">
          <el-input v-model="submitForm.self_test" type="textarea" :rows="2" placeholder="命令与结果" />
        </el-form-item>
        <el-form-item label="已知缺口">
          <el-input v-model="submitForm.known_gaps" type="textarea" :rows="2" placeholder="每行一条" />
        </el-form-item>
        <el-form-item label="提交人" prop="submitted_by">
          <el-input v-model="submitForm.submitted_by" />
        </el-form-item>
        <el-form-item label="fencing token">
          <el-input v-model="submitForm.fencing_token" placeholder="默认带入当前认领令牌" />
          <div class="muted" style="margin-top: 4px">令牌小于当前最大值会被拒绝：租约过期后不能用旧权利提交。</div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="submitVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitSubmitting" @click="submitDelivery">登记提交</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="reviewVisible" title="评审提交" width="640px">
      <el-form label-width="96px">
        <el-form-item label="评审提交">
          <el-select v-model="reviewForm.submission_id" style="width: 100%">
            <el-option
              v-for="submission in submissions"
              :key="submission.submission_id"
              :label="`${submission.submission_id}｜${submission.summary}`"
              :value="submission.submission_id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="评审人">
          <el-input v-model="reviewForm.reviewer_id" />
        </el-form-item>
        <el-form-item label="结论">
          <el-select v-model="reviewForm.conclusion">
            <el-option value="confirm" label="confirm（通过）" />
            <el-option value="reject" label="reject（打回，需理由）" />
            <el-option value="needs_info" label="needs_info（待补充）" />
          </el-select>
        </el-form-item>
        <el-form-item label="完成条件结果">
          <div v-for="(item, index) in reviewForm.criteria" :key="index" style="display: flex; gap: 6px; margin-bottom: 6px">
            <el-input v-model="item.criterion" placeholder="条件" />
            <el-input v-model="item.result" placeholder="结果" />
            <el-input v-model="item.evidence" placeholder="证据" style="width: 160px" />
            <el-button text type="danger" @click="reviewForm.criteria.splice(index, 1)">删除</el-button>
          </div>
          <el-button size="small" text @click="reviewForm.criteria.push({ criterion: '', result: '', evidence: '' })">
            + 增加条件
          </el-button>
        </el-form-item>
        <el-form-item label="理由">
          <el-input v-model="reviewForm.reason" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="reviewVisible = false">取消</el-button>
        <el-button type="primary" :loading="reviewSubmitting" @click="submitReview">记录评审</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.claim-brief {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.context-block {
  font-size: 13px;
}

.digest-grid {
  display: grid;
  grid-template-columns: 120px 1fr;
  gap: 4px 10px;
  margin-top: 8px;
  word-break: break-all;
}

.done-block {
  margin-top: 10px;
  background: var(--sap-bg-soft);
  border-radius: 6px;
  padding: 8px 10px;
}

.done-block__title {
  font-size: 12px;
  color: var(--sap-muted);
  margin-bottom: 4px;
}

.done-list {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--sap-text-secondary);
}

.review-block {
  margin-top: 10px;
  border-top: 1px dashed var(--sap-border-soft);
  padding-top: 10px;
}
</style>
