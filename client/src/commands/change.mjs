// sap change：主干变更的提出、确认、生效、关闭与查看。
// 原则：变更关闭前必须逐项处置影响对象；未登记影响项不等于无影响。

import { api } from '../api.mjs';
import { parseArgs, requireFlag, optionalFlag, collectFlagValues } from '../args.mjs';
import { TRUNK_ITEM_KINDS } from '../limits.mjs';

export const meta = {
  name: 'change',
  usage: 'sap change propose|confirm|activate|close|show --change <change_id>',
};

const SUB_USAGE = {
  propose:
    'sap change propose --project <id> --reason <理由> --old <item_id> [...] '
    + '[--requirement <req_id>] [--proposal "<kind>:<statement>"] [...]',
  confirm: 'sap change confirm --change <change_id> --by <名字> [--effective-at <ISO>]',
  activate: 'sap change activate --change <change_id> --by <名字>',
  close: 'sap change close --change <change_id>',
  show: 'sap change show --change <change_id>',
};

/** 解析 "kind:statement" 形式的提议条目。 */
function parseProposal(raw, index) {
  const sep = raw.indexOf(':');
  if (sep <= 0 || sep === raw.length - 1) {
    throw new Error(`--proposal 第 ${index + 1} 项格式应为 "<kind>:<statement>"，当前为：${raw}`);
  }
  const kind = raw.slice(0, sep).trim();
  const statement = raw.slice(sep + 1).trim();
  if (!TRUNK_ITEM_KINDS.includes(kind)) {
    throw new Error(`--proposal 第 ${index + 1} 项类型非法：${kind}（可选 ${TRUNK_ITEM_KINDS.join(' / ')}）`);
  }
  return { kind, statement };
}

async function runPropose(argv, io) {
  const { out, err } = io;
  const { flags } = parseArgs(argv);

  let projectId;
  let reason;
  try {
    projectId = requireFlag(flags, 'project', '<id>');
    reason = requireFlag(flags, 'reason', '<理由>');
  } catch (error) {
    err(error.message);
    err(`用法：${SUB_USAGE.propose}`);
    return 1;
  }

  const oldItemIds = collectFlagValues(argv, 'old');
  const rawProposals = collectFlagValues(argv, 'proposal');

  let proposedItems;
  try {
    proposedItems = rawProposals.map(parseProposal);
  } catch (error) {
    err(error.message);
    err(`用法：${SUB_USAGE.propose}`);
    return 1;
  }

  const input = {
    project_id: projectId,
    reason,
    old_item_ids: oldItemIds,
    proposed_items: proposedItems,
  };
  const requirementId = optionalFlag(flags, 'requirement');
  if (requirementId !== undefined) input.trigger_requirement_id = requirementId;

  try {
    const change = await api.createTrunkChange(input);
    out(`变更已提出：${change.change_id}`);
    out(`项目：${change.project_id}　状态：${change.status}`);
    out(`理由：${change.reason}`);
    if (change.old_item_ids.length > 0) {
      out(`旧条目：${change.old_item_ids.join(', ')}`);
    }
    if (change.proposed_item_ids.length > 0) {
      out(`新条目（proposed）：${change.proposed_item_ids.join(', ')}`);
    }
    if (change.old_item_ids.length === 0 && change.proposed_item_ids.length === 0) {
      out('提示：本次变更未关联旧条目或新条目，请确认是否完整。');
    }
    return 0;
  } catch (error) {
    err(error.message);
    return 1;
  }
}

async function runConfirm(argv, io) {
  const { out, err } = io;
  const { flags } = parseArgs(argv);

  let changeId;
  let by;
  try {
    changeId = requireFlag(flags, 'change', '<change_id>');
    by = requireFlag(flags, 'by', '<名字>');
  } catch (error) {
    err(error.message);
    err(`用法：${SUB_USAGE.confirm}`);
    return 1;
  }

  const input = { confirmed_by: by };
  const effectiveAt = optionalFlag(flags, 'effective-at');
  if (effectiveAt !== undefined) input.effective_at = effectiveAt;

  try {
    const change = await api.confirmTrunkChange(changeId, input);
    out(`变更已确认：${change.change_id}　状态：${change.status}`);
    out(`确认人：${change.confirmed_by}　确认时间：${change.confirmed_at}`);
    out(`生效时间：${change.effective_at ?? '未指定'}`);
    return 0;
  } catch (error) {
    err(error.message);
    return 1;
  }
}

async function runActivate(argv, io) {
  const { out, err } = io;
  const { flags } = parseArgs(argv);

  let changeId;
  let by;
  try {
    changeId = requireFlag(flags, 'change', '<change_id>');
    by = requireFlag(flags, 'by', '<名字>');
  } catch (error) {
    err(error.message);
    err(`用法：${SUB_USAGE.activate}`);
    return 1;
  }

  try {
    const change = await api.activateTrunkChange(changeId, { confirmed_by: by });
    out(`变更已生效：${change.change_id}　状态：${change.status}`);
    out(`生效时间：${change.effective_at ?? '未指定'}`);
    if (change.proposed_item_ids.length > 0) {
      out(`新条目已生效（active）：${change.proposed_item_ids.join(', ')}`);
    }
    if (change.old_item_ids.length > 0) {
      out(`旧条目已保留为历史（superseded）：${change.old_item_ids.join(', ')}`);
    }
    return 0;
  } catch (error) {
    err(error.message);
    return 1;
  }
}

async function runClose(argv, io) {
  const { out, err } = io;
  const { flags } = parseArgs(argv);

  let changeId;
  try {
    changeId = requireFlag(flags, 'change', '<change_id>');
  } catch (error) {
    err(error.message);
    err(`用法：${SUB_USAGE.close}`);
    return 1;
  }

  try {
    const change = await api.closeTrunkChange(changeId);
    out(`变更已关闭：${change.change_id}　状态：${change.status}`);
    return 0;
  } catch (error) {
    if (error.code === 'CHANGE_IMPACT_UNRESOLVED') {
      err(`无法关闭变更：影响处置未完成（${error.message}）`);
      err('请先使用 sap impact add / sap impact update 逐项处置影响对象；'
        + '若确认没有影响对象，也需要在提出变更时填写影响声明。');
      return 1;
    }
    err(error.message);
    return 1;
  }
}

function printChange(out, change) {
  out(`主干变更 ${change.change_id}`);
  out(`  项目：${change.project_id}`);
  out(`  状态：${change.status}`);
  out(`  理由：${change.reason}`);
  if (change.trigger_requirement_id) out(`  触发需求：${change.trigger_requirement_id}`);
  if (change.old_item_ids.length > 0) out(`  旧条目：${change.old_item_ids.join(', ')}`);
  if (change.proposed_item_ids.length > 0) {
    out(`  新条目：${change.proposed_item_ids.join(', ')}`);
  }
  if (change.impact_assessment) out(`  影响声明：${change.impact_assessment}`);
  if (change.confirmed_by) {
    out(`  确认人：${change.confirmed_by}　确认时间：${change.confirmed_at ?? ''}`);
  }
  if (change.effective_at) out(`  生效时间：${change.effective_at}`);
  if (change.policy_ref) out(`  政策引用：${change.policy_ref}`);
  out(`  创建时间：${change.created_at}`);
}

async function runShow(argv, io) {
  const { out, err } = io;
  const { flags } = parseArgs(argv);

  let changeId;
  try {
    changeId = requireFlag(flags, 'change', '<change_id>');
  } catch (error) {
    err(error.message);
    err(`用法：${SUB_USAGE.show}`);
    return 1;
  }

  try {
    const [change, impacts] = await Promise.all([
      api.getTrunkChange(changeId),
      api.listImpactItems(changeId),
    ]);
    printChange(out, change);

    const pending = impacts.filter((item) => item.assessment_status === 'to_check');
    out(`影响项（${impacts.length}，待检查 ${pending.length}）：`);
    if (impacts.length === 0) {
      out('  （未登记影响项）');
      if (!change.impact_assessment) {
        out('  注意：未登记影响项且未提供影响声明，不能关闭变更。');
      }
    }
    for (const item of impacts) {
      const owner = item.owner_id ? `　负责人：${item.owner_id}` : '';
      out(`  ${item.impact_item_id}　${item.target_type}:${item.target_id}`
        + `　评估：${item.assessment_status}　处置：${item.resolution}${owner}`);
      if (item.reason) out(`    理由：${item.reason}`);
      out(`    更新时间：${item.updated_at}`);
    }
    return 0;
  } catch (error) {
    err(error.message);
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
  const handlers = {
    propose: runPropose,
    confirm: runConfirm,
    activate: runActivate,
    close: runClose,
    show: runShow,
  };

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
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
