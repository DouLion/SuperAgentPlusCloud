// sap heartbeat：续租自己持有的认领。

import { api } from '../api.mjs';
import { parseArgs, requireFlag, optionalFlag } from '../args.mjs';
import { printError } from '../format.mjs';

export const meta = {
  name: 'heartbeat',
  usage: 'sap heartbeat --claim <claim_id> --worker <actor_id> [--ttl 1800]',
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
  let claimId;
  let workerId;
  try {
    claimId = requireFlag(flags, 'claim', '<claim_id>');
    workerId = requireFlag(flags, 'worker', '<actor_id>');
  } catch (error) {
    printError(error, err);
    err(`用法：${meta.usage}`);
    return 1;
  }

  const ttlRaw = optionalFlag(flags, 'ttl');
  const ttl = ttlRaw === undefined ? undefined : Number(ttlRaw);
  if (ttl !== undefined && (!Number.isFinite(ttl) || ttl <= 0)) {
    err(`--ttl 必须是正数秒数，当前为：${ttlRaw}`);
    return 1;
  }

  try {
    const claim = await api.heartbeatClaim(claimId, {
      actor_id: workerId,
      ttl_seconds: ttl,
    });
    out(`续租成功：${claim.claim_id}`);
    out(`心跳：${claim.heartbeat_at}　租约到期：${claim.lease_expires_at}`);
    return 0;
  } catch (error) {
    printError(error, err);
    return 1;
  }
}
