// sap trunk：主干条目的查看、提出、确认与退役。
// 原则：proposed 只是建议，confirm 才进入 active；退役保留历史，不删除旧条目。

import { api } from '../api.mjs';
import { parseArgs, requireFlag, optionalFlag, collectFlagValues } from '../args.mjs';
import { TRUNK_ITEM_KINDS, TRUNK_ITEM_STATUSES } from '../limits.mjs';
import { formatRelation, line, printError } from '../format.mjs';

export const meta = {
  name: 'trunk',
  usage: 'sap trunk list|show|propose|confirm|retire --project <id> | --item <item_id>',
};

const SUB_USAGE = {
  list: 'sap trunk list --project <id> [--status proposed|active|superseded|retired] [--kind <类型>]',
  show: 'sap trunk show --item <item_id>',
  propose:
    'sap trunk propose --project <id> --kind <goal|scope|capability|business_rule|interface|data_contract|architecture_decision|other> '
    + '--statement <表述> [--rationale ...] [--source ...] [--by <名字>]',
  confirm: 'sap trunk confirm --item <item_id> --by <名字> [--valid-from <ISO>]',
  retire: 'sap trunk retire --item <item_id> --by <名字>',
};

function renderItem(out, item) {
  out(`主干条目 ${item.item_id}`);
  line(out, '项目', item.project_id);
  line(out, '类型', item.kind);
  line(out, '状态', item.status);
  line(out, '表述', item.statement);
  line(out, '理由', item.rationale);
  line(out, '生效时间', item.valid_from);
  line(out, '失效时间', item.valid_until);
  line(out, '创建人', item.created_by);
  line(out, '创建时间', item.created_at);
  line(out, '确认人', item.confirmed_by);
  line(out, '确认时间', item.confirmed_at);
  if (item.superseded_by) line(out, '被替代为', item.superseded_by);

  out(`  关系（${item.relations.length}）：`);
  if (item.relations.length === 0) out('    （无）');
  for (const relation of item.relations) out(`    - ${formatRelation(relation)}`);

  out(`  来源（${item.source_refs.length}）：`);
  if (item.source_refs.length === 0) out('    （无）');
  for (const ref of item.source_refs) out(`    - ${ref}`);
}

async function runList(argv, io) {
  const { out, err } = io;
  const { flags } = parseArgs(argv);

  let projectId;
  try {
    projectId = requireFlag(flags, 'project', '<id>');
  } catch (error) {
    printError(error, err);
    err(`用法：${SUB_USAGE.list}`);
    return 1;
  }

  const status = optionalFlag(flags, 'status');
  if (status !== undefined && !TRUNK_ITEM_STATUSES.includes(status)) {
    err(`--status 只能是 ${TRUNK_ITEM_STATUSES.join(' / ')}，当前为：${status}`);
    return 1;
  }

  const kind = optionalFlag(flags, 'kind');
  if (kind !== undefined && !TRUNK_ITEM_KINDS.includes(kind)) {
    err(`--kind 只能是 ${TRUNK_ITEM_KINDS.join(' / ')}，当前为：${kind}`);
    return 1;
  }

  try {
    const query = { project_id: projectId };
    if (status !== undefined) query.status = status;
    if (kind !== undefined) query.kind = kind;

    const items = await api.listTrunkItems(query);
    if (items.length === 0) {
      out('（没有匹配的主干条目）');
      return 0;
    }

    out(`主干条目（${items.length}）：`);
    for (const item of items) {
      out('');
      renderItem(out, item);
    }
    return 0;
  } catch (error) {
    printError(error, err);
    return 1;
  }
}

async function runShow(argv, io) {
  const { out, err } = io;
  const { flags } = parseArgs(argv);

  let itemId;
  try {
    itemId = requireFlag(flags, 'item', '<item_id>');
  } catch (error) {
    printError(error, err);
    err(`用法：${SUB_USAGE.show}`);
    return 1;
  }

  try {
    const item = await api.getTrunkItem(itemId);
    renderItem(out, item);

    // 替代信息：被哪个条目替代，以及哪些主干变更引用了本条目。
    if (item.superseded_by) {
      const replacement = await api.getTrunkItem(item.superseded_by);
      out('替代信息：');
      if (!replacement) {
        out(`  替代条目 ${item.superseded_by} 不存在或已不可查`);
      } else {
        out(`  ${replacement.item_id}　${replacement.kind}　状态：${replacement.status}`);
        out(`  表述：${replacement.statement}`);
      }
    }

    const changes = await api.listTrunkChanges({ project_id: item.project_id });
    const related = changes.filter(
      (change) => change.old_item_ids.includes(item.item_id)
        || change.proposed_item_ids.includes(item.item_id),
    );
    out(`相关主干变更（${related.length}）：`);
    if (related.length === 0) out('  （无）');
    for (const change of related) {
      const role = change.old_item_ids.includes(item.item_id) ? '旧条目' : '新条目';
      out(`  ${change.change_id}　状态：${change.status}　本条目角色：${role}`);
    }
    return 0;
  } catch (error) {
    printError(error, err);
    return 1;
  }
}

async function runPropose(argv, io) {
  const { out, err } = io;
  const { flags } = parseArgs(argv);

  let projectId;
  let kind;
  let statement;
  try {
    projectId = requireFlag(flags, 'project', '<id>');
    kind = requireFlag(flags, 'kind', '<类型>');
    statement = requireFlag(flags, 'statement', '<表述>');
  } catch (error) {
    printError(error, err);
    err(`用法：${SUB_USAGE.propose}`);
    return 1;
  }

  if (!TRUNK_ITEM_KINDS.includes(kind)) {
    err(`--kind 只能是 ${TRUNK_ITEM_KINDS.join(' / ')}，当前为：${kind}`);
    return 1;
  }

  const rationales = collectFlagValues(argv, 'rationale');
  const sources = collectFlagValues(argv, 'source');

  try {
    const item = await api.createTrunkItem({
      project_id: projectId,
      kind,
      statement,
      rationale: rationales.length > 0 ? rationales.join('；') : undefined,
      source_refs: sources,
      created_by: optionalFlag(flags, 'by'),
    });

    out(`主干条目已提出：${item.item_id}`);
    out(`项目：${item.project_id}　类型：${item.kind}　状态：${item.status}`);
    out(`表述：${item.statement}`);
    if (item.rationale) out(`理由：${item.rationale}`);
    if (item.source_refs.length > 0) out(`来源：${item.source_refs.join('；')}`);
    out('提示：proposed 仅为建议，需 confirm 后才作为已确认前提生效。');
    return 0;
  } catch (error) {
    printError(error, err);
    return 1;
  }
}

async function runConfirm(argv, io) {
  const { out, err } = io;
  const { flags } = parseArgs(argv);

  let itemId;
  let by;
  try {
    itemId = requireFlag(flags, 'item', '<item_id>');
    by = requireFlag(flags, 'by', '<名字>');
  } catch (error) {
    printError(error, err);
    err(`用法：${SUB_USAGE.confirm}`);
    return 1;
  }

  const input = { confirmed_by: by };
  const validFrom = optionalFlag(flags, 'valid-from');
  if (validFrom !== undefined) input.valid_from = validFrom;

  try {
    const item = await api.confirmTrunkItem(itemId, input);
    out(`主干条目已确认：${item.item_id}　状态：${item.status}`);
    out(`确认人：${item.confirmed_by}　确认时间：${item.confirmed_at}`);
    out(`生效时间：${item.valid_from ?? '未指定'}`);
    return 0;
  } catch (error) {
    // 非法流转（如对 active 再 confirm）由服务端 409 INVALID_TRANSITION 透出。
    printError(error, err);
    return 1;
  }
}

async function runRetire(argv, io) {
  const { out, err } = io;
  const { flags } = parseArgs(argv);

  let itemId;
  let by;
  try {
    itemId = requireFlag(flags, 'item', '<item_id>');
    by = requireFlag(flags, 'by', '<名字>');
  } catch (error) {
    printError(error, err);
    err(`用法：${SUB_USAGE.retire}`);
    return 1;
  }

  try {
    const item = await api.retireTrunkItem(itemId, { confirmed_by: by });
    out(`主干条目已退役：${item.item_id}　状态：${item.status}`);
    out(`操作人：${by}`);
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
  const handlers = {
    list: runList,
    show: runShow,
    propose: runPropose,
    confirm: runConfirm,
    retire: runRetire,
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
    printError(error, err);
    return 1;
  }
}
