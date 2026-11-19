// sap claim：认领任务（owner）或加入为协作者；支持指定租约时长。

import { api } from '../api.mjs';
import { parseArgs, requireFlag, optionalFlag } from '../args.mjs';
import { printError } from '../format.mjs';

export const meta = {
  name: 'claim',
  usage:
    'sap claim --task <task_id> --worker <actor_id> [--role owner|collaborator] [--ttl 1800]',
};

function formatLease(claim) {
  return `${claim.lease_expires_at || '—'}（fencing #${claim.fencing_token ?? '—'}）`;
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
  let taskId;
  let workerId;
  try {
    taskId = requireFlag(flags, 'task', '<task_id>');
    workerId = requireFlag(flags, 'worker', '<actor_id>');
  } catch (error) {
    printError(error, err);
    err(`用法：${meta.usage}`);
    return 1;
  }

  const role = optionalFlag(flags, 'role') ?? 'owner';
  if (!['owner', 'collaborator'].includes(role)) {
    err(`--role 只能是 owner / collaborator，当前为：${role}`);
    return 1;
  }
  const ttlRaw = optionalFlag(flags, 'ttl');
  const ttl = ttlRaw === undefined ? undefined : Number(ttlRaw);
  if (ttl !== undefined && (!Number.isFinite(ttl) || ttl <= 0)) {
    err(`--ttl 必须是正数秒数，当前为：${ttlRaw}`);
    return 1;
  }

  try {
    const payload = { actor_id: workerId, role, ttl_seconds: ttl };
    const result = role === 'collaborator'
      ? await api.joinTask(taskId, payload)
      : await api.claimTask(taskId, payload);
    out(`${role === 'collaborator' ? '已加入' : '认领成功'}：${result.claim.claim_id}`);
    out(`任务：${taskId}　状态：${result.task.status}　主体：${workerId}　角色：${role}`);
    out(`租约到期：${formatLease(result.claim)}`);
    return 0;
  } catch (error) {
    printError(error, err);
    return 1;
  }
}
