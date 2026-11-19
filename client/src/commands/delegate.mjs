// sap delegate：Agent 委派管理（P1）。
// 委派可限项目、限动作、可撤销；撤销后 Agent 立即失去相应动作权限。

import { api } from '../api.mjs';
import { parseArgs, requireFlag, optionalFlag } from '../args.mjs';
import { printError, line } from '../format.mjs';

export const meta = {
  name: 'delegate',
  usage: 'sap delegate add|list|revoke ...',
};

function print(out, delegation) {
  out(`${delegation.delegation_id}  ${delegation.agent_actor_id} → ${delegation.on_behalf_of}`);
  line(out, '项目', delegation.project_id || '（全部项目）');
  line(out, '动作', (delegation.allowed_actions || []).join(', ') || '（全部允许动作）');
  line(out, '有效期', `${delegation.valid_from} ~ ${delegation.valid_until}`);
  if (delegation.revoked_at) line(out, '已撤销', delegation.revoked_at);
}

export async function run(argv, io = {}) {
  const out = io.stdout || console.log;
  const err = io.stderr || console.error;
  const [sub, ...rest] = argv;
  const { flags } = parseArgs(rest);

  try {
    if (sub === 'add') {
      const body = {
        agent_actor_id: requireFlag(flags, 'agent', '<actor_id>'),
        on_behalf_of: requireFlag(flags, 'owner', '<人类 actor_id>'),
        project_id: optionalFlag(flags, 'project'),
        valid_until: optionalFlag(flags, 'until'),
      };
      if (flags.actions) body.allowed_actions = flags.actions.split(',').map((item) => item.trim()).filter(Boolean);
      print(out, await api.createDelegation(body));
      return 0;
    }

    if (sub === 'list') {
      const rows = await api.listDelegations({
        agent_actor_id: optionalFlag(flags, 'agent'),
        project_id: optionalFlag(flags, 'project'),
      });
      if (rows.length === 0) out('（暂无委派）');
      rows.forEach((row) => print(out, row));
      return 0;
    }

    if (sub === 'revoke') {
      print(out, await api.revokeDelegation(requireFlag(flags, 'delegation', '<delegation_id>'), {
        reason: optionalFlag(flags, 'reason') ?? '撤销委派',
      }));
      return 0;
    }

    err(`用法：${meta.usage}`);
    return 1;
  } catch (error) {
    printError(error, err);
    return 1;
  }
}
