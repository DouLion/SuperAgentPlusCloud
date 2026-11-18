// sap plan：生成并查看任务拆解草稿（模型建议，未生效）。

import { api } from '../api.mjs';
import { parseArgs, requireFlag } from '../args.mjs';
import { printAiError } from '../format.mjs';

export const meta = {
  name: 'plan',
  usage: 'sap plan --requirement <req_id>',
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
    const { suggestion, draft } = await api.planRequirement(requirementId);
    out(`任务草稿（建议，未生效）：${suggestion.suggestion_id}`);
    out(`模型：${suggestion.model ?? '未知'}　时间：${suggestion.created_at}`);
    if (draft.length === 0) out('  （无任务）');
    draft.forEach((task, index) => {
      out(`任务 ${index + 1}：${task.purpose}`);
      out('  完成条件：');
      for (const item of task.done_when) out(`    - ${item}`);
      if (task.scope) out(`  范围：${task.scope}`);
      if (task.non_scope) out(`  非范围：${task.non_scope}`);
      if (task.serves_item_ids.length > 0) {
        out(`  服务条目：${task.serves_item_ids.join(', ')}`);
      }
      if (task.related_question) out(`  探索问题：${task.related_question}`);
    });
    out('  提示：以上为任务草稿，未生效；需人工确认后才会创建并开放任务。');
    return 0;
  } catch (error) {
    printAiError(error, err);
    return 1;
  }
}
