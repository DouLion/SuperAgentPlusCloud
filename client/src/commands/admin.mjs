// sap admin：运行可靠性（E 枝）：备份、备份校验与健康检查。

import { api } from '../api.mjs';
import { parseArgs, requireFlag } from '../args.mjs';
import { printError } from '../format.mjs';

export const meta = {
  name: 'admin',
  usage: 'sap admin backup --target <file> ｜ verify --path <file> ｜ health',
};

function printHealth(out, health) {
  out(`完整性：${health.ok ? 'ok' : health.integrity.join(',')}　生成于 ${health.generated_at}`);
  out(`Outbox 待投递：${health.outbox.pending}${health.outbox.oldest_pending_at ? `（最老 ${health.outbox.oldest_pending_at}）` : ''}`);
  out(`过期未回收租约：${health.expired_leases}`);
  out('关键表行数：');
  for (const [table, count] of Object.entries(health.tables)) {
    out(`  ${table.padEnd(16)} ${count < 0 ? '（无此表）' : count}`);
  }
}

export async function run(argv, io = {}) {
  const out = io.stdout || console.log;
  const err = io.stderr || console.error;
  const [sub, ...rest] = argv;
  const { flags } = parseArgs(rest);
  const options = { url: io.url, env: io.env, fetchImpl: io.fetchImpl };

  try {
    if (sub === 'backup') {
      const result = await api.createBackup({ target: requireFlag(flags, 'target', '<file>') }, options);
      out(`备份完成：${result.target}（${result.bytes} 字节）`);
      return 0;
    }

    if (sub === 'verify') {
      const result = await api.verifyBackup({ path: requireFlag(flags, 'path', '<file>') }, options);
      out(`完整性：${result.ok ? 'ok' : result.integrity.join(',')}　大小 ${result.bytes} 字节`);
      for (const [table, count] of Object.entries(result.tables)) {
        out(`  ${table.padEnd(16)} ${count < 0 ? '（无此表）' : count}`);
      }
      return result.ok ? 0 : 1;
    }

    if (sub === 'health') {
      printHealth(out, await api.adminHealth(options));
      return 0;
    }

    err(`用法：${meta.usage}`);
    return 1;
  } catch (error) {
    printError(error, err);
    return 1;
  }
}
