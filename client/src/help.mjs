// 客户端帮助文本与命令清单。
// 已实现：submit / decide / show / tasks / claim / release（T2/T3）；
// deliver / review（T4）。

export const DEFAULT_CENTER_URL = 'http://127.0.0.1:8787';

/** 已实现并可执行的命令。 */
export const IMPLEMENTED_COMMANDS = [
  'submit',
  'decide',
  'show',
  'tasks',
  'claim',
  'release',
  'deliver',
  'review',
];

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
    usage: 'sap show --requirement <req_id> | sap show --task <task_id>',
    desc: '查看需求时间线，或任务、认领、提交与评审全链',
    implemented: true,
  },
  {
    name: 'tasks',
    usage: 'sap tasks --project <id> [--status open|claimed|...] [--requirement <id>]',
    desc: '查看任务列表与完成条件',
    implemented: true,
  },
  {
    name: 'claim',
    usage: 'sap claim --task <task_id> --worker <worker_id>',
    desc: '认领任务（互斥、原子）',
    implemented: true,
  },
  {
    name: 'release',
    usage: 'sap release --task <task_id> --worker <worker_id>',
    desc: '释放自己认领的任务，使其回到可认领状态',
    implemented: true,
  },
  {
    name: 'deliver',
    usage: 'sap deliver --task <task_id> --worker <worker_id> --commit <repo@hash> [--summary ...] [--self-test ...] [--gap ...]',
    desc: '提交成果：commit 引用、自测与已知缺口',
    implemented: true,
  },
  {
    name: 'review',
    usage: 'sap review --submission <sub_id> --reviewer <reviewer_id> --conclusion <confirm|reject|needs_info> [--criterion "条件=结果" ...] [--reason ...]',
    desc: '按完成条件逐项评审（确认/打回/待补充）',
    implemented: true,
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
    '当前进度：T4 提交与评审 —— submit / decide / show / tasks / claim / release / deliver / review 可用；主干变更见后续层（T5+）。',
  ].join('\n');
}
