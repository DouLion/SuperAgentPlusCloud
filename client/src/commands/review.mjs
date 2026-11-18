// sap review：按完成条件逐项评审提交（确认/打回/待补充）。

import { api } from '../api.mjs';
import { parseArgs, requireFlag, optionalFlag, collectFlagValues } from '../args.mjs';
import { REVIEW_CONCLUSIONS } from '../limits.mjs';

export const meta = {
  name: 'review',
  usage:
    'sap review --submission <sub_id> --reviewer <reviewer_id> --conclusion <confirm|reject|needs_info> [--criterion "条件=结果" ...] [--reason ...]',
};

/** 解析 "条件=结果" 形式的逐项条件结果；证据未由 CLI 提供时明确标注。 */
function parseCriterion(raw, index) {
  const eq = raw.indexOf('=');
  if (eq <= 0 || eq === raw.length - 1) {
    throw new Error(`--criterion 第 ${index + 1} 项格式应为 "条件=结果"，当前为：${raw}`);
  }
  return {
    criterion: raw.slice(0, eq),
    result: raw.slice(eq + 1),
    evidence: 'CLI 未提供独立证据',
  };
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
  const rawCriteria = collectFlagValues(argv, 'criterion');
  const reason = optionalFlag(flags, 'reason');

  let submissionId;
  let reviewerId;
  let conclusion;
  try {
    submissionId = requireFlag(flags, 'submission', '<sub_id>');
    reviewerId = requireFlag(flags, 'reviewer', '<reviewer_id>');
    conclusion = requireFlag(flags, 'conclusion', '<结论>');
  } catch (error) {
    err(error.message);
    err(`用法：${meta.usage}`);
    return 1;
  }

  if (!REVIEW_CONCLUSIONS.includes(conclusion)) {
    err(`--conclusion 只能是 ${REVIEW_CONCLUSIONS.join(' / ')}，当前为：${conclusion}`);
    return 1;
  }
  if (conclusion === 'confirm' && rawCriteria.length === 0) {
    err('结论为 confirm 时必须提供至少一个 --criterion "条件=结果"');
    err(`用法：${meta.usage}`);
    return 1;
  }
  if (conclusion === 'reject' && reason === undefined) {
    err('结论为 reject 时必须提供 --reason，说明未满足的条件或缺少的证据');
    err(`用法：${meta.usage}`);
    return 1;
  }

  let criterionResults;
  try {
    criterionResults = rawCriteria.map(parseCriterion);
  } catch (error) {
    err(error.message);
    err(`用法：${meta.usage}`);
    return 1;
  }

  try {
    const review = await api.createReview(submissionId, {
      reviewer_id: reviewerId,
      conclusion,
      criterion_results: criterionResults,
      reason,
    });

    out(`评审已记录：${review.review_id}`);
    out(
      `提交：${submissionId}　结论：${review.conclusion}　自审：${review.self_review ? '是' : '否'}`,
    );
    out(`评审时间：${review.reviewed_at}`);
    if (review.reason) out(`理由：${review.reason}`);
    return 0;
  } catch (error) {
    // 服务端错误原样透出，便于使用者判断是冲突还是校验失败。
    err(error.message);
    return 1;
  }
}
