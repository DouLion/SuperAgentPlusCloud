// sap impact：登记影响对象并逐项给出处置结论。
// 原则：待检查（to_check）与确认无影响（not_affected）必须区分。

import { api } from '../api.mjs';
import { parseArgs, requireFlag, optionalFlag } from '../args.mjs';
import {
  IMPACT_TARGET_TYPES,
  IMPACT_ASSESSMENT_STATUSES,
  IMPACT_RESOLUTIONS,
} from '../limits.mjs';
import { printError } from '../format.mjs';

export const meta = {
  name: 'impact',
  usage: 'sap impact add|update --change <change_id> | --impact <impact_id>',
};

const SUB_USAGE = {
  add: 'sap impact add --change <change_id> --type <task|submission|document|test|other> --target <id> [--owner <名字>]',
  update:
    'sap impact update --impact <impact_id> --status <to_check|affected|not_affected> '
    + '[--resolution <continue|adjust|revalidate|obsolete|pending>] [--reason ...]',
};

async function runAdd(argv, io) {
  const { out, err } = io;
  const { flags } = parseArgs(argv);

  let changeId;
  let targetType;
  let targetId;
  try {
    changeId = requireFlag(flags, 'change', '<change_id>');
    targetType = requireFlag(flags, 'type', '<类型>');
    targetId = requireFlag(flags, 'target', '<id>');
  } catch (error) {
    printError(error, err);
    err(`用法：${SUB_USAGE.add}`);
    return 1;
  }

  if (!IMPACT_TARGET_TYPES.includes(targetType)) {
    err(`--type 只能是 ${IMPACT_TARGET_TYPES.join(' / ')}，当前为：${targetType}`);
    return 1;
  }

  try {
    const item = await api.addImpactItem(changeId, {
      target_type: targetType,
      target_id: targetId,
      owner_id: optionalFlag(flags, 'owner'),
    });
    out(`影响项已登记：${item.impact_item_id}`);
    out(`变更：${item.change_id}　对象：${item.target_type}:${item.target_id}`);
    out(`评估：${item.assessment_status}　处置：${item.resolution}`);
    if (item.owner_id) out(`负责人：${item.owner_id}`);
    return 0;
  } catch (error) {
    printError(error, err);
    return 1;
  }
}

async function runUpdate(argv, io) {
  const { out, err } = io;
  const { flags } = parseArgs(argv);

  let impactId;
  let status;
  try {
    impactId = requireFlag(flags, 'impact', '<impact_id>');
    status = requireFlag(flags, 'status', '<状态>');
  } catch (error) {
    printError(error, err);
    err(`用法：${SUB_USAGE.update}`);
    return 1;
  }

  if (!IMPACT_ASSESSMENT_STATUSES.includes(status)) {
    err(`--status 只能是 ${IMPACT_ASSESSMENT_STATUSES.join(' / ')}，当前为：${status}`);
    return 1;
  }

  const resolution = optionalFlag(flags, 'resolution');
  if (resolution !== undefined && !IMPACT_RESOLUTIONS.includes(resolution)) {
    err(`--resolution 只能是 ${IMPACT_RESOLUTIONS.join(' / ')}，当前为：${resolution}`);
    return 1;
  }

  const reason = optionalFlag(flags, 'reason');
  if (status === 'not_affected' && reason === undefined) {
    err('影响评估为 not_affected 时必须提供 --reason，说明确认无影响的依据');
    return 1;
  }

  try {
    const item = await api.updateImpactItem(impactId, {
      assessment_status: status,
      resolution,
      reason,
    });
    out(`影响项已更新：${item.impact_item_id}`);
    out(`对象：${item.target_type}:${item.target_id}`);
    out(`评估：${item.assessment_status}　处置：${item.resolution}`);
    if (item.reason) out(`理由：${item.reason}`);
    return 0;
  } catch (error) {
    printError(error, err);
    return 1;
  }
}

/**
 * @param {string[]} argv
 * @param {object} [io] { stdout, stderr }
 * @returns {Promise<number>} 退出码
 */
export async function run(argv, io = {}) {
  const out = io.stdout || ((line) => console.log(line));
  const err = io.stderr || ((line) => console.error(line));

  const [sub, ...rest] = argv;
  const handlers = { add: runAdd, update: runUpdate };

  if (sub === undefined || sub === '--help' || sub === '-h') {
    err(`用法：${meta.usage}`);
    for (const [name, usage] of Object.entries(SUB_USAGE)) err(`  ${name.padEnd(8)} ${usage}`);
    return sub === undefined ? 1 : 0;
  }

  const handler = handlers[sub];
  if (!handler) {
    err(`未知子命令：${sub}`);
    err(`用法：${meta.usage}`);
    return 1;
  }

  try {
    return await handler(rest, { out, err });
  } catch (error) {
    printError(error, err);
    return 1;
  }
}
