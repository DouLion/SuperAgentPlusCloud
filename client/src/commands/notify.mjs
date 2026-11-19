// sap notify：站内通知（E 枝）。通知只读提醒，不改变业务状态。

import { api } from '../api.mjs';
import { parseArgs, optionalFlag, requireFlag } from '../args.mjs';
import { printError } from '../format.mjs';

export const meta = {
  name: 'notify',
  usage: 'sap notify list [--actor <id>] [--unread] [--limit N] ｜ read <id> [--actor] ｜ '
    + 'read-all --actor <id> ｜ prefs [--actor] [--set kind=on|off] ｜ scan',
};

const KIND_TEXT = {
  task_available: '可认领',
  review_requested: '待评审',
  decision_required: '待判断',
  impact_to_check: '待检查影响',
  lease_expiring: '租约临期',
  system: '系统',
};

function printList(out, items) {
  if (!items.length) {
    out('没有通知');
    return;
  }
  out(`共 ${items.length} 条`);
  for (const item of items) {
    const unread = item.read_at ? '  ' : '● ';
    out(`${unread}[${KIND_TEXT[item.kind] || item.kind}] ${item.title}`);
    out(`    ${item.notification_id}  ${item.created_at}${item.ref_id ? `  对象 ${item.ref_id}` : ''}`);
  }
}

function printPrefs(out, actorId, prefs) {
  out(`主体 ${actorId} 的通知偏好`);
  for (const pref of prefs) {
    out(`  ${KIND_TEXT[pref.kind] || pref.kind}（${pref.kind}）：${pref.enabled ? '开' : '关'}`);
  }
}

export async function run(argv, io = {}) {
  const out = io.stdout || console.log;
  const err = io.stderr || console.error;
  const [sub, ...rest] = argv;
  const { flags, positionals } = parseArgs(rest);
  const options = { url: io.url, env: io.env, fetchImpl: io.fetchImpl };
  const actor = optionalFlag(flags, 'actor') || process.env.SAP_ACTOR;

  try {
    if (sub === 'list') {
      const result = await api.listNotifications({
        actor_id: actor,
        unread: flags.unread ? '1' : undefined,
        limit: optionalFlag(flags, 'limit'),
      }, options);
      printList(out, result.items);
      return 0;
    }

    if (sub === 'read') {
      const id = positionals[0];
      if (!id) {
        err('用法：sap notify read <notification_id> [--actor <id>]');
        return 1;
      }
      const updated = await api.readNotification(id, { actor_id: actor }, options);
      out(`已读：${updated.notification_id}`);
      return 0;
    }

    if (sub === 'read-all') {
      const result = await api.readAllNotifications({ actor_id: requireFlag(flags, 'actor', '<actor_id>') }, options);
      out(`已全部标记已读：${result.updated} 条`);
      return 0;
    }

    if (sub === 'prefs') {
      const target = requireFlag(flags, 'actor', '<actor_id>');
      const set = optionalFlag(flags, 'set');
      if (set) {
        const [kind, state] = String(set).split('=');
        const prefs = await api.saveNotificationPrefs({
          actor_id: target,
          prefs: [{ kind, enabled: state !== 'off' }],
        }, options);
        printPrefs(out, target, prefs.prefs);
        return 0;
      }
      const result = await api.listNotificationPrefs({ actor_id: target }, options);
      printPrefs(out, target, result.prefs);
      return 0;
    }

    if (sub === 'scan') {
      const result = await api.scanNotifications({}, options);
      out(`扫描完成：租约提醒 ${result.lease_expiring} 条，评审积压 ${result.review_requested} 条`);
      return 0;
    }

    err(`用法：${meta.usage}`);
    return 1;
  } catch (error) {
    printError(error, err);
    return 1;
  }
}
