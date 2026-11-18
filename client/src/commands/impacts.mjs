// sap impacts：生成并查看主干变更的影响候选（模型建议，未生效）。

import { api } from '../api.mjs';
import { parseArgs, requireFlag } from '../args.mjs';
import { printAiError } from '../format.mjs';

export const meta = {
  name: 'impacts',
  usage: 'sap impacts --change <chg_id>',
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
  let changeId;
  try {
    changeId = requireFlag(flags, 'change', '<chg_id>');
  } catch (error) {
    printAiError(error, err);
    err(`用法：${meta.usage}`);
    return 1;
  }

  try {
    const { suggestion, draft } = await api.adviseTrunkChange(changeId);
    out(`影响候选（建议，未生效）：${suggestion.suggestion_id}`);
    out(`模型：${suggestion.model ?? '未知'}　时间：${suggestion.created_at}`);
    if (draft.length === 0) out('  （无候选）');
    draft.forEach((item, index) => {
      out(`候选 ${index + 1}：${item.target_type}:${item.target_id}`);
      if (item.reason) out(`  理由：${item.reason}`);
    });
    out('  提示：以上为影响候选，未登记为影响项；需人工确认后才会写入 impact_items。');
    return 0;
  } catch (error) {
    printAiError(error, err);
    return 1;
  }
}
