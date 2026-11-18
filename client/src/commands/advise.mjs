// sap advise：生成并查看需求评估建议（模型建议，未生效）。

import { api } from '../api.mjs';
import { parseArgs, requireFlag } from '../args.mjs';
import { printAiError } from '../format.mjs';

export const meta = {
  name: 'advise',
  usage: 'sap advise --requirement <req_id>',
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
  try {
    requirementId = requireFlag(flags, 'requirement', '<req_id>');
  } catch (error) {
    printAiError(error, err);
    err(`用法：${meta.usage}`);
    return 1;
  }

  try {
    const { suggestion, draft } = await api.adviseRequirement(requirementId);
    out(`评估建议（建议，未生效）：${suggestion.suggestion_id}`);
    out(`模型：${suggestion.model ?? '未知'}　时间：${suggestion.created_at}`);
    out(`  等级：${draft.assessed_level}`);
    out(`  建议动作：${draft.proposed_action}`);
    if (draft.related_item_ids.length > 0) {
      out(`  关联条目：${draft.related_item_ids.join(', ')}`);
    }
    if (draft.impact_summary) out(`  影响摘要：${draft.impact_summary}`);
    if (draft.uncertainties.length > 0) {
      out(`  不确定项：${draft.uncertainties.join('；')}`);
    }
    out('  提示：以上为模型建议，未生效；需求状态不因建议改变，需人工评估与决定。');
    return 0;
  } catch (error) {
    printAiError(error, err);
    return 1;
  }
}
