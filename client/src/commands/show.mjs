// sap show：打印需求时间线，或任务、认领、提交与评审全链。

import { api } from '../api.mjs';
import { parseArgs, optionalFlag } from '../args.mjs';
import { formatCommitRef, line, printError, printTimeline } from '../format.mjs';

export const meta = {
  name: 'show',
  usage: 'sap show --requirement <req_id> | sap show --task <task_id>',
};

async function renderRequirement(out, requirementId) {
  const requirement = await api.getRequirement(requirementId);
  const [assessments, decisions, timeline] = await Promise.all([
    api.listAssessments(requirementId),
    api.listDecisions(requirementId),
    api.getTimeline(requirementId),
  ]);

  out(`需求 ${requirement.requirement_id}`);
  line(out, '项目', requirement.project_id);
  line(out, '状态', requirement.status);
  line(out, '提交人', requirement.author);
  line(out, '来源', requirement.source_ref);
  line(out, '自报等级', requirement.claimed_level);
  line(out, '最终等级', requirement.final_level);
  line(out, '创建时间', requirement.created_at);
  line(out, '原文', requirement.raw_text);
  if (requirement.claimed_reason) line(out, '自报理由', requirement.claimed_reason);
  if (requirement.related_item_ids.length > 0) {
    line(out, '关联条目', requirement.related_item_ids.join(', '));
  }

  out(`评估（${assessments.length}）：`);
  for (const assessment of assessments) {
    line(out, '编号', assessment.assessment_id);
    line(out, '等级', assessment.assessed_level);
    line(out, '建议', assessment.proposed_action);
    line(out, '评估者', `${assessment.assessor_type}${assessment.assessor_id ? `/${assessment.assessor_id}` : ''}`);
    line(out, '影响摘要', assessment.impact_summary);
    if (assessment.uncertainties.length > 0) {
      line(out, '不确定项', assessment.uncertainties.join('；'));
    }
  }

  out(`决定（${decisions.length}）：`);
  for (const decision of decisions) {
    line(out, '编号', decision.decision_id);
    line(out, '结论', decision.conclusion);
    line(out, '最终等级', decision.final_level);
    line(out, '确认人', decision.confirmed_by);
    line(out, '确认时间', decision.confirmed_at);
    line(out, '理由', decision.reason);
  }

  printTimeline(out, timeline);
}

async function renderTask(out, taskId) {
  const task = await api.getTask(taskId);
  const [claims, submissions] = await Promise.all([
    api.listClaims(taskId),
    api.listSubmissions(taskId),
  ]);

  out(`任务 ${task.task_id}`);
  line(out, '项目', task.project_id);
  line(out, '需求', task.requirement_id);
  line(out, '状态', task.status);
  line(out, '目标', task.purpose);
  line(out, '范围', task.scope);
  if (task.non_scope) line(out, '非范围', task.non_scope);
  if (task.done_when.length > 0) {
    out('  完成条件：');
    for (const item of task.done_when) out(`    - ${item}`);
  }
  if (task.acceptance_evidence.length > 0) {
    line(out, '预期证据', task.acceptance_evidence.join('；'));
  }

  out(`认领（${claims.length}）：`);
  for (const claim of claims) {
    line(out, '编号', claim.claim_id);
    line(out, '工作者', claim.worker_id);
    line(out, '状态', claim.status);
    line(out, '认领时间', claim.claimed_at);
    line(out, '释放时间', claim.released_at);
  }

  out(`提交（${submissions.length}）：`);
  for (const submission of submissions) {
    out(`提交 ${submission.submission_id}`);
    line(out, '提交人', submission.submitted_by);
    line(out, '提交时间', submission.submitted_at);
    line(out, '摘要', submission.summary);
    line(out, '自测', submission.self_test);
    if (submission.commit_refs.length > 0) {
      out('  commit 引用：');
      for (const ref of submission.commit_refs) out(`    - ${formatCommitRef(ref)}`);
    }
    if (submission.known_gaps.length > 0) {
      line(out, '已知缺口', submission.known_gaps.join('；'));
    }
    if (submission.artifacts.length > 0) {
      line(out, '产物', submission.artifacts.join('；'));
    }

    const reviews = await api.listReviews(submission.submission_id);
    out(`  评审（${reviews.length}）：`);
    for (const review of reviews) {
      line(out, '编号', review.review_id);
      line(out, '结论', review.conclusion);
      line(out, '评审者', review.reviewer_id);
      line(out, '自审', review.self_review ? '是' : '否');
      line(out, '评审时间', review.reviewed_at);
      line(out, '理由', review.reason);
      if (review.criterion_results.length > 0) {
        out('    完成条件：');
        for (const item of review.criterion_results) {
          const evidence = item.evidence ? `（${item.evidence}）` : '';
          out(`      - ${item.criterion}=${item.result}${evidence}`);
        }
      }
    }
  }
}

/**
 * @param {string[]} argv
 * @param {object} [io] { stdout, stderr }
 * @returns {Promise<number>} 退出码
 */
export async function run(argv, io = {}) {
  const out = io.stdout || ((line) => console.log(line));
  const err = io.stderr || ((line) => console.error(line));

  const { flags } = parseArgs(argv);
  const taskId = optionalFlag(flags, 'task');
  const requirementId = optionalFlag(flags, 'requirement');

  if (taskId && requirementId) {
    err('一次只能查看一个对象：--requirement 与 --task 不能同时使用');
    err(`用法：${meta.usage}`);
    return 1;
  }
  if (!taskId && !requirementId) {
    err('缺少 --requirement <id> 或 --task <task_id>');
    err(`用法：${meta.usage}`);
    return 1;
  }

  try {
    if (taskId) {
      await renderTask(out, taskId);
    } else {
      await renderRequirement(out, requirementId);
    }
    return 0;
  } catch (error) {
    printError(error, err);
    return 1;
  }
}
