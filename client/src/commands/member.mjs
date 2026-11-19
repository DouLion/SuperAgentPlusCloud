// sap member：项目成员与角色（P1）。
// 角色只决定可被指派到哪些动作，不直接等于权限。

import { api } from '../api.mjs';
import { parseArgs, requireFlag, optionalFlag } from '../args.mjs';
import { printError } from '../format.mjs';

export const meta = {
  name: 'member',
  usage: 'sap member add|list ...',
};

export async function run(argv, io = {}) {
  const out = io.stdout || console.log;
  const err = io.stderr || console.error;
  const [sub, ...rest] = argv;
  const { flags } = parseArgs(rest);

  try {
    if (sub === 'add') {
      const roles = requireFlag(flags, 'roles', '<owner|contributor|reviewer|direction|publisher|observer>')
        .split(',').map((item) => item.trim()).filter(Boolean);
      const member = await api.addMember(requireFlag(flags, 'project', '<project_id>'), {
        actor_id: requireFlag(flags, 'actor', '<actor_id>'),
        roles,
        created_by: optionalFlag(flags, 'by'),
      });
      out(`${member.project_id}  ${member.actor_id}  角色：${(member.roles || []).join(', ')}`);
      return 0;
    }

    if (sub === 'list') {
      const rows = await api.listMembers(requireFlag(flags, 'project', '<project_id>'));
      if (rows.length === 0) out('（暂无成员）');
      rows.forEach((row) => out(`${row.actor_id}  角色：${(row.roles || []).join(', ')}  加入：${row.added_at}`));
      return 0;
    }

    err(`用法：${meta.usage}`);
    return 1;
  } catch (error) {
    printError(error, err);
    return 1;
  }
}
