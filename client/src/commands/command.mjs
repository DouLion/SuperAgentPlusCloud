// sap command：协议层命令结果查询（P3）。
// 请求超时后先查这里，而不是直接重试写操作。

import { api } from '../api.mjs';
import { parseArgs, requireFlag } from '../args.mjs';
import { printError } from '../format.mjs';

export const meta = {
  name: 'command',
  usage: 'sap command result --id <command_id>',
};

export async function run(argv, io = {}) {
  const out = io.stdout || console.log;
  const err = io.stderr || console.error;
  const [sub, ...rest] = argv;
  const { flags } = parseArgs(rest);

  try {
    if (sub === 'result') {
      const result = await api.getCommandResult(requireFlag(flags, 'id', '<command_id>'));
      out(`命令：${result.command_id}`);
      out(`请求：${result.method} ${result.path}`);
      out(`状态：${result.status_code}　时间：${result.created_at}`);
      out(`响应：${JSON.stringify(result.response)}`);
      return 0;
    }

    err(`用法：${meta.usage}`);
    return 1;
  } catch (error) {
    printError(error, err);
    return 1;
  }
}
