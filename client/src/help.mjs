// 客户端帮助文本与命令清单（T0 仅打印帮助，命令实现从 T2 起逐层补齐）。

export const DEFAULT_CENTER_URL = 'http://127.0.0.1:8787';

/** 已规划命令；T0 阶段全部未实现。 */
export const PLANNED_COMMANDS = [
  { name: 'submit', usage: 'sap submit --project <id> --text <原文> [--level L0..L4]', desc: '提交需求或问题（保留原文与来源引用）' },
  { name: 'decide', usage: 'sap decide --requirement <req_id> --conclusion <accepted|relevelled|needs_info|rejected|deferred>', desc: '对人类决定进行确认' },
  { name: 'tasks', usage: 'sap tasks --project <id> [--status open]', desc: '查看任务列表与完成条件' },
  { name: 'claim', usage: 'sap claim --task <task_id> --worker <worker_id>', desc: '认领任务（互斥、原子）' },
  { name: 'deliver', usage: 'sap deliver --task <task_id> --commit <repo@hash> [--summary ...]', desc: '提交成果：commit 引用与自测证据' },
  { name: 'review', usage: 'sap review --submission <sub_id> --conclusion <confirm|reject|needs_info>', desc: '按完成条件逐项评审' },
  { name: 'trunk', usage: 'sap trunk list|show|propose --project <id>', desc: '查看/提出主干条目' },
  { name: 'change', usage: 'sap change propose|confirm|impact --change <chg_id>', desc: '主干变更与影响对象逐项处置' },
];

export function buildHelp(centerUrl = DEFAULT_CENTER_URL) {
  const lines = PLANNED_COMMANDS.map(
    (cmd) => `  ${cmd.name.padEnd(8)} ${cmd.desc}\n          用法：${cmd.usage}`,
  );
  return [
    'SuperAgentPlus Client (sap)',
    '',
    `Center 地址：${centerUrl}（环境变量 CENTER_URL 可覆盖）`,
    '',
    '可用命令：',
    ...lines,
    '',
    '当前进度：T0 骨架 —— 仅本帮助可用，命令实现见后续层（T2+）。',
  ].join('\n');
}
