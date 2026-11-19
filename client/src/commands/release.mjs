// sap release：释放自己的认领，使任务回到可认领状态（协作者释放不影响 owner）。

import { api } from '../api.mjs';
import { parseArgs, requireFlag, optionalFlag } from '../args.mjs';
import { printError } from '../format.mjs';

export const meta = {
  name: 'release',
  usage: 'sap release [--claim <claim_id>] [--task <task_id>] --worker <actor_id> [--reason ...]',
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
  let workerId;
  try {
    workerId = requireFlag(flags, 'worker', '<actor_id>');
  } catch (error) {
    printError(error, err);
    err(`用法：${meta.usage}`);
    return 1;
  }

  const claimId = optionalFlag(flags, 'claim');
  const taskId = optionalFlag(flags, 'task');
  if (!claimId && !taskId) {
    err('需要 --claim <claim_id> 或 --task <task_id>');
    err(`用法：${meta.usage}`);
    return 1;
  }

  try {
    const payload = { actor_id: workerId, reason: optionalFlag(flags, 'reason') };
    const result = claimId
      ? await api.releaseClaim(claimId, payload)
      : await api.releaseTask(taskId, payload);
    out(`释放成功：${result.claim.claim_id}`);
    out(`任务：${result.claim.task_id}　状态：${result.task.status}`);
    out(`释放时间：${result.claim.released_at}`);
    return 0;
  } catch (error) {
    printError(error, err);
    return 1;
  }
}
