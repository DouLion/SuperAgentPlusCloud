// sap decide：记录被授权者对需求的人类确认（接受/改级/追问/拒绝/暂缓）。

import { api } from '../api.mjs';
import { parseArgs, requireFlag, optionalFlag } from '../args.mjs';
import { LEVELS, CONCLUSIONS } from '../limits.mjs';
import { printError } from '../format.mjs';

export const meta = {
  name: 'decide',
  usage: 'sap decide --requirement <id> --conclusion <accepted|relevelled|needs_info|rejected|deferred> [--level L0..L4] [--reason ...] [--by <名字>]',
};

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
  let conclusion;
  try {
    requirementId = requireFlag(flags, 'requirement', '<id>');
    conclusion = requireFlag(flags, 'conclusion', '<结论>');
  } catch (error) {
    printError(error, err);
    err(`用法：${meta.usage}`);
    return 1;
  }

  if (!CONCLUSIONS.includes(conclusion)) {
    err(`--conclusion 只能是 ${CONCLUSIONS.join(' / ')}，当前为：${conclusion}`);
    return 1;
  }

  const level = optionalFlag(flags, 'level');
  if (level !== undefined && !LEVELS.includes(level)) {
    err(`--level 只能是 ${LEVELS.join(' / ')}，当前为：${level}`);
    return 1;
  }
  if ((conclusion === 'accepted' || conclusion === 'relevelled') && level === undefined) {
    err(`结论为 ${conclusion} 时必须提供 --level ${LEVELS.join('/')}`);
    return 1;
  }
  if (conclusion === 'relevelled' && optionalFlag(flags, 'reason') === undefined) {
    err('结论为 relevelled 时必须提供 --reason，说明改级理由');
    return 1;
  }

  const by = optionalFlag(flags, 'by');
  if (by === undefined) {
    err('缺少 --by <名字>：决定必须由具名人员确认');
    return 1;
  }

  try {
    const decision = await api.createDecision(requirementId, {
      conclusion,
      final_level: level,
      reason: optionalFlag(flags, 'reason'),
      confirmed_by: by,
    });
    const requirement = await api.getRequirement(requirementId);

    out(`决定已记录：${decision.decision_id}`);
    out(`需求：${requirementId}　结论：${decision.conclusion}`);
    if (decision.final_level) out(`最终等级：${decision.final_level}`);
    out(`需求状态：${requirement.status}`);
    return 0;
  } catch (error) {
    printError(error, err);
    return 1;
  }
}
