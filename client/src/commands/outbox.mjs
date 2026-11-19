// sap outbox：事件投递箱管理与派发（P3）。
// 当前没有外部订阅者，dispatch 只是标记已投递。

import { api } from '../api.mjs';
import { parseArgs, optionalFlag } from '../args.mjs';
import { printError } from '../format.mjs';

export const meta = {
  name: 'outbox',
  usage: 'sap outbox list [--status pending|delivered] [--limit 50] ｜ sap outbox dispatch [--limit 50]',
};

export async function run(argv, io = {}) {
  const out = io.stdout || console.log;
  const err = io.stderr || console.error;
  const [sub, ...rest] = argv;
  const { flags } = parseArgs(rest);

  try {
    if (sub === 'list') {
      const rows = await api.listOutbox({
        status: optionalFlag(flags, 'status') ?? 'pending',
        limit: optionalFlag(flags, 'limit'),
      });
      if (rows.length === 0) out('（没有事件）');
      rows.forEach((row) => out(
        `${row.event_id}  ${row.topic}  尝试 ${row.attempts}  可投递 ${row.available_at}`
        + `${row.delivered_at ? `  已投递 ${row.delivered_at}` : ''}`
        + `${row.last_error ? `  上次错误：${row.last_error}` : ''}`,
      ));
      return 0;
    }

    if (sub === 'dispatch') {
      const limit = optionalFlag(flags, 'limit');
      const result = await api.dispatchOutbox(limit ? { limit: Number(limit) } : {});
      out(`已投递 ${result.delivered} 条，失败 ${result.failed} 条`);
      if (result.note) out(result.note);
      return 0;
    }

    err(`用法：${meta.usage}`);
    return 1;
  } catch (error) {
    printError(error, err);
    return 1;
  }
}
