// sap claim：认领任务（互斥、原子）。冲突时透出服务端错误。

import { api } from '../api.mjs';
import { parseArgs, requireFlag } from '../args.mjs';
import { printError } from '../format.mjs';

export const meta = {
  name: 'claim',
  usage: 'sap claim --task <task_id> --worker <worker_id>',
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
    const result = await api.claimTask(taskId, { worker_id: workerId });
    out(`认领成功：${result.claim.claim_id}`);
    out(`任务：${taskId}　状态：${result.task.status}　工作者：${result.claim.worker_id}`);
    return 0;
  } catch (error) {
    // 服务端冲突（如任务已被认领）原样透出，便于使用者判断。
    printError(error, err);
    return 1;
  }
}
