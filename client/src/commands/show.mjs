// sap show：打印需求、评估、决定与时间线。

import { api } from '../api.mjs';
import { parseArgs, requireFlag } from '../args.mjs';

export const meta = {
  name: 'show',
  usage: 'sap show --requirement <id>',
};

function line(out, label, value) {
  if (value === undefined || value === null || value === '') return;
  out(`  ${label}：${value}`);
}

function renderTimeline(out, events) {
  out('时间线：');
  if (events.length === 0) {
    out('  （无）');
    return;
  }
  for (const event of events) {
    const actor = event.actor ? ` by ${event.actor}` : '';
    const reason = event.reason ? `　理由：${event.reason}` : '';
    out(`  ${event.occurred_at}　${event.event_type}${actor}${reason}`);
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
  let requirementId;
  try {
    requirementId = requireFlag(flags, 'requirement', '<id>');
  } catch (error) {
    err(error.message);
    err(`用法：${meta.usage}`);
    return 1;
  }

  try {
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

    renderTimeline(out, timeline);
    return 0;
  } catch (error) {
    err(error.message);
    return 1;
  }
}
