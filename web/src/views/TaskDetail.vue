<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api, errorMessage } from '../api.js';
import { formatTime, OPTIONS } from '../status.js';
import StatusTag from '../components/StatusTag.vue';
import EmptyState from '../components/EmptyState.vue';

const route = useRoute();
const router = useRouter();
const taskId = route.params.id;

const loading = ref(false);
const task = ref(null);
const claims = ref([]);
const submissions = ref([]);
const reviewsMap = ref({});

const workerId = ref('');
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
const reviewRules = {
  submission_id: [{ required: true, message: '请选择提交', trigger: 'change' }],
  reviewer_id: [{ required: true, message: '请填写评审人', trigger: 'blur' }],
  conclusion: [{ required: true, message: '请选择评审结论', trigger: 'change' }],
};

const activeClaim = computed(() => claims.value.find((claim) => claim.status === 'active') || null);

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

const timelineEvents = computed(() => {
  const events = [];
  for (const claim of claims.value) {
    events.push({
      key: claim.claim_id,
      time: claim.claimed_at,
      title: `认领：${claim.worker_id}（${claim.status}）`,
      detail: claim.released_at ? `释放时间：${formatTime(claim.released_at)}` : '当前持有任务',
    });
  }
  for (const submission of submissions.value) {
    events.push({
      key: submission.submission_id,
      time: submission.submitted_at,
      title: `提交：${submission.summary || submission.submission_id}`,
      detail: `提交人：${submission.submitted_by}`,
    });
    for (const review of reviewsMap.value[submission.submission_id] || []) {
      events.push({
        key: review.review_id,
        time: review.reviewed_at,
        title: `评审：${review.conclusion}（评审人 ${review.reviewer_id}）`,
        detail: review.reason || (review.criterion_results || []).map((item) => `${item.criterion}=${item.result}`).join('；'),
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
      submissionRows.map((submission) => api.listReviews(submission.submission_id)),
    );
    const map = {};
    submissionRows.forEach((submission, index) => {
      map[submission.submission_id] = reviews[index];
    });
    reviewsMap.value = map;
    if (activeClaim.value) workerId.value = activeClaim.value.worker_id;
  } catch (err) {
    ElMessage.error(errorMessage(err, '加载任务详情失败'));
  } finally {
    loading.value = false;
  }
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
    submitted_by: activeClaim.value?.worker_id || '',
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
      known_gaps: submitForm.known_gaps
        .split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      submitted_by: submitForm.submitted_by,
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
    reviewer_id: '',
    conclusion: '',
    reason: '',
    criteria: [{ criterion: '', result: '', evidence: '' }],
  });
  reviewVisible.value = true;
}

function addCriterion() {
  reviewForm.criteria.push({ criterion: '', result: '', evidence: '' });
}

function removeCriterion(index) {
  reviewForm.criteria.splice(index, 1);
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
    router.replace('/projects');
    return;
  }
  load();
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
      <el-button @click="router.push('/projects')">返回项目列表</el-button>
    </EmptyState>

    <template v-else-if="task">
      <el-card shadow="never" class="card-gap">
        <template #header>任务信息</template>
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="状态">
            <StatusTag group="task" :value="task.status" />
          </el-descriptions-item>
          <el-descriptions-item label="需求">
            <span class="mono">{{ task.requirement_id || '—' }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="目标" :span="2">{{ task.purpose }}</el-descriptions-item>
          <el-descriptions-item label="范围" :span="2">{{ task.scope || '—' }}</el-descriptions-item>
          <el-descriptions-item label="非范围" :span="2">{{ task.non_scope || '—' }}</el-descriptions-item>
          <el-descriptions-item label="完成条件" :span="2">
            <div v-for="(item, index) in task.done_when" :key="index">· {{ item }}</div>
          </el-descriptions-item>
          <el-descriptions-item label="预期证据" :span="2">
            {{ (task.acceptance_evidence || []).join('；') || '—' }}
          </el-descriptions-item>
          <el-descriptions-item label="服务条目" :span="2">
            <span v-if="!(task.serves_item_ids || []).length">—</span>
            <el-tag
              v-for="id in task.serves_item_ids"
              :key="id"
              size="small"
              class="relation-tag mono"
            >{{ id }}</el-tag>
          </el-descriptions-item>
        </el-descriptions>
      </el-card>

      <el-card shadow="never" class="card-gap">
        <template #header>状态进度</template>
        <el-steps :active="stepIndex" align-center finish-status="success">
          <el-step title="draft" description="草稿" />
          <el-step title="open" description="可认领" />
          <el-step title="claimed" description="已认领" />
          <el-step title="submitted" description="待评审" />
          <el-step title="accepted" description="已通过" />
        </el-steps>
        <el-alert
          v-if="task.status === 'rework'"
          class="step-note"
          type="warning"
          title="任务已被打回（rework）：请修改后重新提交，认领可再次进行。"
          :closable="false"
          show-icon
        />
        <el-alert
          v-else-if="task.status === 'cancelled'"
          class="step-note"
          type="info"
          title="任务已取消。"
          :closable="false"
          show-icon
        />
      </el-card>

      <el-card shadow="never" class="card-gap">
        <template #header>操作</template>
        <div class="toolbar">
          <el-input
            v-model="workerId"
            placeholder="工作者 ID"
            style="width: 200px"
            :disabled="claimSubmitting || releaseSubmitting"
          />
          <el-tooltip
            :disabled="canClaim"
            :content="`仅 open 或 rework 状态可认领；当前为 ${task.status}`"
            placement="top"
          >
            <span>
              <el-button
                type="primary"
                :loading="claimSubmitting"
                :disabled="!canClaim"
                @click="claim"
              >
                认领
              </el-button>
            </span>
          </el-tooltip>
          <el-tooltip
            :disabled="canRelease"
            content="当前没有活跃认领可释放"
            placement="top"
          >
            <span>
              <el-button
                :loading="releaseSubmitting"
                :disabled="!canRelease"
                @click="release"
              >
                释放
              </el-button>
            </span>
          </el-tooltip>
          <el-tooltip
            :disabled="canSubmit"
            content="仅已认领（claimed）且存在活跃认领时可提交成果"
            placement="top"
          >
            <span>
              <el-button type="primary" plain :disabled="!canSubmit" @click="openSubmit">
                提交成果
              </el-button>
            </span>
          </el-tooltip>
          <el-tooltip
            :disabled="canReview"
            content="该任务还没有提交，无法评审"
            placement="top"
          >
            <span>
              <el-button type="warning" plain :disabled="!canReview" @click="openReview">
                评审提交
              </el-button>
            </span>
          </el-tooltip>
        </div>
        <div v-if="activeClaim" class="muted">
          当前活跃认领：<span class="mono">{{ activeClaim.claim_id }}</span>
          　工作者：{{ activeClaim.worker_id }}
        </div>
      </el-card>

      <el-row :gutter="16">
        <el-col :xs="24" :lg="14">
          <el-card shadow="never" class="card-gap">
            <template #header>提交与评审</template>
            <EmptyState v-if="submissions.length === 0" description="该任务还没有提交" :height="'120px'" />
            <div v-for="submission in submissions" :key="submission.submission_id" class="submission">
              <div class="record-head">
                <strong class="mono">{{ submission.submission_id }}</strong>
                <span class="muted">{{ formatTime(submission.submitted_at) }}</span>
              </div>
              <div>摘要：{{ submission.summary }}</div>
              <div class="muted">提交人：{{ submission.submitted_by }}　自测：{{ submission.self_test || '—' }}</div>
              <div class="muted">
                commit：
                <el-tag
                  v-for="(ref, index) in submission.commit_refs"
                  :key="index"
                  size="small"
                  class="relation-tag mono"
                >{{ typeof ref === 'string' ? ref : `${ref.repo}@${ref.hash}` }}</el-tag>
              </div>
              <div v-if="(submission.known_gaps || []).length" class="muted">
                已知缺口：{{ submission.known_gaps.join('；') }}
              </div>
              <div
                v-for="review in reviewsMap[submission.submission_id] || []"
                :key="review.review_id"
                class="review"
              >
                <div>
                  <StatusTag group="review" :value="review.conclusion" />
                  <span class="muted">　评审人：{{ review.reviewer_id }}
                    <span v-if="review.self_review">（自审）</span>
                    　{{ formatTime(review.reviewed_at) }}</span>
                </div>
                <div v-if="(review.criterion_results || []).length" class="muted">
                  <div v-for="(item, index) in review.criterion_results" :key="index">
                    · {{ item.criterion }} = {{ item.result }}
                    <span v-if="item.evidence">（{{ item.evidence }}）</span>
                  </div>
                </div>
                <div v-if="review.reason" class="muted">理由：{{ review.reason }}</div>
              </div>
            </div>
          </el-card>

          <el-card shadow="never" class="card-gap">
            <template #header>认领记录</template>
            <EmptyState v-if="claims.length === 0" description="还没有认领记录" :height="'120px'" />
            <el-table v-else :data="claims" size="small">
              <el-table-column prop="claim_id" label="认领" min-width="160">
                <template #default="{ row }"><span class="mono">{{ row.claim_id }}</span></template>
              </el-table-column>
              <el-table-column prop="worker_id" label="工作者" width="120" />
              <el-table-column label="状态" width="110">
                <template #default="{ row }"><StatusTag group="claim" :value="row.status" /></template>
              </el-table-column>
              <el-table-column label="认领时间" width="150">
                <template #default="{ row }">{{ formatTime(row.claimed_at) }}</template>
              </el-table-column>
              <el-table-column label="释放时间" width="150">
                <template #default="{ row }">{{ formatTime(row.released_at) }}</template>
              </el-table-column>
            </el-table>
          </el-card>
        </el-col>

        <el-col :xs="24" :lg="10">
          <el-card shadow="never" class="card-gap">
            <template #header>时间线</template>
            <EmptyState v-if="timelineEvents.length === 0" description="暂无事件" :height="'120px'" />
            <el-timeline v-else>
              <el-timeline-item
                v-for="event in timelineEvents"
                :key="event.key"
                :timestamp="formatTime(event.time)"
                placement="top"
              >
                <div><strong>{{ event.title }}</strong></div>
                <div class="muted">{{ event.detail }}</div>
              </el-timeline-item>
            </el-timeline>
          </el-card>
        </el-col>
      </el-row>
    </template>

    <el-dialog v-model="submitVisible" title="登记成果提交" width="560px">
      <el-form :model="submitForm" :rules="submitRules" label-width="96px">
        <el-form-item label="commit 引用" prop="commit_refs">
          <el-input
            v-model="submitForm.commit_refs"
            type="textarea"
            :rows="3"
            placeholder="每行一个：repo@hash"
          />
        </el-form-item>
        <el-form-item label="摘要" prop="summary">
          <el-input v-model="submitForm.summary" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item label="自测">
          <el-input v-model="submitForm.self_test" placeholder="可选，例如 npm test 通过" />
        </el-form-item>
        <el-form-item label="已知缺口">
          <el-input v-model="submitForm.known_gaps" type="textarea" :rows="2" placeholder="每行一条" />
        </el-form-item>
        <el-form-item label="提交人" prop="submitted_by">
          <el-input v-model="submitForm.submitted_by" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="submitVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitSubmitting" @click="submitDelivery">登记提交</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="reviewVisible" title="评审提交" width="640px">
      <el-form :model="reviewForm" :rules="reviewRules" label-width="96px">
        <el-form-item label="提交" prop="submission_id">
          <el-select v-model="reviewForm.submission_id" style="width: 100%">
            <el-option
              v-for="submission in submissions"
              :key="submission.submission_id"
              :label="`${submission.submission_id}（${formatTime(submission.submitted_at)}）`"
              :value="submission.submission_id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="评审人" prop="reviewer_id">
          <el-input v-model="reviewForm.reviewer_id" />
        </el-form-item>
        <el-form-item label="结论" prop="conclusion">
          <el-select v-model="reviewForm.conclusion" style="width: 220px">
            <el-option
              v-for="value in OPTIONS.reviewConclusions"
              :key="value"
              :label="value"
              :value="value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="完成条件">
          <div class="criteria">
            <div v-for="(item, index) in reviewForm.criteria" :key="index" class="criteria-row">
              <el-input v-model="item.criterion" placeholder="完成条件" style="width: 200px" />
              <el-input v-model="item.result" placeholder="结果 pass/fail" style="width: 150px" />
              <el-input v-model="item.evidence" placeholder="证据（可选）" style="width: 180px" />
              <el-button
                size="small"
                text
                type="danger"
                :disabled="reviewForm.criteria.length <= 1"
                @click="removeCriterion(index)"
              >
                删除
              </el-button>
            </div>
            <el-button size="small" text type="primary" @click="addCriterion">
              <el-icon><Plus /></el-icon>
              添加条件
            </el-button>
          </div>
        </el-form-item>
        <el-form-item label="理由">
          <el-input v-model="reviewForm.reason" type="textarea" :rows="2" placeholder="结论为 reject 时必填" />
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
.relation-tag {
  margin-right: 6px;
}

.submission {
  border-top: 1px solid #f0f2f5;
  padding: 10px 0;
}

.record-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.review {
  background: #fafafa;
  border-radius: 6px;
  padding: 8px 10px;
  margin-top: 8px;
}

.criteria {
  width: 100%;
}

.criteria-row {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
</style>
