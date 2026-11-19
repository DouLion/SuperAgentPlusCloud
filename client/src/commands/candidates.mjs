// sap candidates：按任务的编排来源推荐候选主体（P4）。
// 推荐不等于授权；实际领取仍需自行 claim 并由策略校验。

import { api } from '../api.mjs';
import { parseArgs, requireFlag } from '../args.mjs';
import { printError } from '../format.mjs';

export const meta = {
  name: 'candidates',
  usage: 'sap candidates --task <task_id>',
};

export async function run(argv, io = {}) {
  const out = io.stdout || console.log;
  const err = io.stderr || console.error;
  const { flags } = parseArgs(argv);

  try {
    const result = await api.listTaskCandidates(requireFlag(flags, 'task'));
    if (!result.candidates || result.candidates.length === 0) {
      out(result.reason ? `没有候选：${result.reason}` : '没有匹配的主体');
      return 0;
    }
    out(`任务 ${result.task_id}  节点 ${result.node_key}  角色 ${result.role_hint ?? '—'}`);
    for (const item of result.candidates) {
      out(`  ${item.actor_id}  ${item.display_name}  评分 ${item.score}`);
    }
    out(`说明：${result.note}`);
    return 0;
  } catch (error) {
    printError(error, err);
    return 1;
  }
}
