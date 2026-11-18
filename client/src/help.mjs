// 客户端帮助文本与命令清单。
// 已实现：submit / decide / show / tasks / claim / release（T2/T3）；
// deliver / review（T4）；change / impact（T5）；trunk（T6）；
// advise / plan / impacts（T8，需 Center 配置模型）。

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
  'trunk',
  'change',
  'impact',
  'advise',
  'plan',
  'impacts',
  'convention',
  'workflow',
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
    usage:
      'sap trunk list --project <id> [--status proposed|active|superseded|retired] [--kind <类型>] ｜ '
      + 'show --item <item_id> ｜ '
      + 'propose --project <id> --kind <goal|scope|capability|business_rule|interface|data_contract|architecture_decision|other> '
      + '--statement <表述> [--rationale ...] [--source ...] [--by <名字>] ｜ '
      + 'confirm --item <item_id> --by <名字> [--valid-from <ISO>] ｜ '
      + 'retire --item <item_id> --by <名字>',
    desc: '主干条目：查看、提出（proposed 建议）、确认生效（active）与退役（retired）',
    implemented: true,
  },
  {
    name: 'change',
    usage: 'sap change propose --project <id> --reason <理由> --old <item_id> [...] [--requirement <req_id>] [--proposal "<kind>:<statement>"] [...] ｜ confirm/activate/close/show --change <chg_id>',
    desc: '主干变更：提出、确认、生效、关闭与查看（影响处置未完成不能关闭）',
    implemented: true,
  },
  {
    name: 'impact',
    usage: 'sap impact add --change <chg_id> --type <task|submission|document|test|other> --target <id> [--owner <名字>] ｜ update --impact <imp_id> --status <to_check|affected|not_affected> [--resolution ...] [--reason ...]',
    desc: '影响对象登记与逐项处置（区分待检查与确认无影响）',
    implemented: true,
  },
  {
    name: 'advise',
    usage: 'sap advise --requirement <req_id>',
    desc: '生成评估建议（等级、关联条目、影响摘要、不确定项、建议动作）；建议未生效',
    implemented: true,
  },
  {
    name: 'plan',
    usage: 'sap plan --requirement <req_id>',
    desc: '生成任务拆解草稿（purpose、done_when、服务条目）；草稿未生效',
    implemented: true,
  },
  {
    name: 'impacts',
    usage: 'sap impacts --change <chg_id>',
    desc: '生成主干变更的影响候选；仅候选，不登记影响项',
    implemented: true,
  },
  {
    name: 'convention',
    usage: 'sap convention list|show|create|activate|retire|import ...',
    desc: '约定包：团队模板、项目快照、激活、退役与导入',
    implemented: true,
  },
  {
    name: 'workflow',
    usage: 'sap workflow list|show|create|activate|retire|seed ...',
    desc: '编排模板：版本状态、DAG 校验与内置 contract-first-api',
    implemented: true,
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
    '当前进度：T8 模型 —— submit / decide / show / tasks / claim / release / deliver / review / trunk / change / impact / advise / plan / impacts 可用；未配置模型时 AI 命令返回中文提示。',
  ].join('\n');
}
