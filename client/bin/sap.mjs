#!/usr/bin/env node
// SuperAgentPlus 命令行客户端入口（T0 骨架）。
// 只与 Center 交互，不调用任何编码 CLI。

import { buildHelp, PLANNED_COMMANDS, DEFAULT_CENTER_URL } from '../src/help.mjs';

const args = process.argv.slice(2);
const centerUrl = process.env.CENTER_URL || DEFAULT_CENTER_URL;

function main(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    if (argv.length === 0) {
      // 无参数：打印帮助但以非零码提示用法缺失。
      console.error(buildHelp(centerUrl));
      console.error('\n提示：请指定命令，例如 sap --help。');
      return 1;
    }
    console.log(buildHelp(centerUrl));
    return 0;
  }

  const command = argv[0];
  const known = PLANNED_COMMANDS.some((cmd) => cmd.name === command);

  if (!known) {
    console.error(`未知命令：${command}`);
    console.error(buildHelp(centerUrl));
    return 1;
  }

  // T0：命令已登记但尚未实现，明确报错而不是静默成功。
  console.error(`命令「${command}」尚未实现（当前为 T0 骨架）。`);
  console.error(`详见后续实施层：docs/05_实施计划.md`);
  return 1;
}

process.exit(main(args));
