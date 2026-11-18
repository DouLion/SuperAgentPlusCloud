// sap release：释放自己认领的任务，使其回到可认领状态。

import { api } from '../api.mjs';
import { parseArgs, requireFlag } from '../args.mjs';
import { printError } from '../format.mjs';

export const meta = {
  name: 'release',
  usage: 'sap release --task <task_id> --worker <worker_id>',
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
  let taskId;
  let workerId;
  try {
    taskId = requireFlag(flags, 'task', '<task_id>');
    workerId = requireFlag(flags, 'worker', '<worker_id>');
  } catch (error) {
    printError(error, err);
    err(`用法：${meta.usage}`);
    return 1;
  }

  try {
    const result = await api.releaseTask(taskId, { worker_id: workerId });
    out(`释放成功：${result.claim.claim_id}`);
    out(`任务：${taskId}　状态：${result.task.status}　释放时间：${result.claim.released_at}`);
    return 0;
  } catch (error) {
    printError(error, err);
    return 1;
  }
}
