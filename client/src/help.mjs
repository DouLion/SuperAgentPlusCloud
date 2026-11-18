// 客户端帮助文本与命令清单。
// 已实现：submit / decide / show（T2）；其余为后续层占位。

export const DEFAULT_CENTER_URL = 'http://127.0.0.1:8787';

/** 已实现并可执行的命令。 */
export const IMPLEMENTED_COMMANDS = ['submit', 'decide', 'show'];

/** 已规划命令清单，顺序即帮助展示顺序。 */
export const PLANNED_COMMANDS = [
  {
    name: 'submit',
    usage: 'sap submit --project <id> --text <原文> [--level L0..L4] [--reason ...] [--source ...] [--author <名字>]',
    desc: '提交需求或问题（保留原文与来源引用）',
    implemented: true,
  },
  {
    name: 'decide',
    usage: 'sap decide --requirement <req_id> --conclusion <accepted|relevelled|needs_info|rejected|deferred> [--level L0..L4] [--reason ...] [--by <名字>]',
    desc: '对人类决定进行确认（接受/改级/追问/拒绝/暂缓）',
    implemented: true,
  },
  {
    name: 'show',
    usage: 'sap show --requirement <req_id>',
    desc: '查看需求、评估、决定与时间线',
    implemented: true,
  },
  {
    name: 'tasks',
    usage: 'sap tasks --project <id> [--status open]',
    desc: '查看任务列表与完成条件',
    implemented: false,
  },
  {
    name: 'claim',
    usage: 'sap claim --task <task_id> --worker <worker_id>',
    desc: '认领任务（互斥、原子）',
    implemented: false,
  },
  {
    name: 'deliver',
    usage: 'sap deliver --task <task_id> --commit <repo@hash> [--summary ...]',
    desc: '提交成果：commit 引用与自测证据',
    implemented: false,
  },
  {
    name: 'review',
    usage: 'sap review --submission <sub_id> --conclusion <confirm|reject|needs_info>',
    desc: '按完成条件逐项评审',
    implemented: false,
  },
  {
    name: 'trunk',
    usage: 'sap trunk list|show|propose --project <id>',
    desc: '查看/提出主干条目',
    implemented: false,
  },
  {
    name: 'change',
    usage: 'sap change propose|confirm|impact --change <chg_id>',
    desc: '主干变更与影响对象逐项处置',
    implemented: false,
  },
];

export function buildHelp(centerUrl = DEFAULT_CENTER_URL) {
  const lines = PLANNED_COMMANDS.map((cmd) => {
    const mark = cmd.implemented ? '' : '（未实现）';
    return `  ${cmd.name.padEnd(8)} ${cmd.desc}${mark}\n          用法：${cmd.usage}`;
  });
  return [
    'SuperAgentPlus Client (sap)',
    '',
    `Center 地址：${centerUrl}（环境变量 CENTER_URL 可覆盖）`,
    '',
    '可用命令：',
    ...lines,
    '',
    '当前进度：T2 需求与定级 —— submit / decide / show 可用；任务与评审见后续层（T3+）。',
  ].join('\n');
}
